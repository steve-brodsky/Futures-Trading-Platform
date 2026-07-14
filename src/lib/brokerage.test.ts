import { describe, expect, it } from "vitest";
import type { OrderUpdate, Position } from "../types";
import { brokerageDisplayState, brokeragePollInterval, isCompletedCloseFill, isManagedThrottle, isNewOpenPosition, orderFillNeedsPositionReconciliation, reconcileOrderSnapshot, reconcilePositionSnapshot, upsertStreamOrder, upsertStreamPosition } from "./brokerage";

const position = (id: string, quantity = 1): Position => ({
  id, symbol: "MESU26", side: "Long", quantity, averagePrice: 6200, last: 6201, unrealizedPnl: 5,
});

const order = (id: string, status: OrderUpdate["status"] = "Working"): OrderUpdate => ({
  id, symbol: "MESU26", side: "Buy", type: "Limit", quantity: 1, status, timestamp: "2026-07-14T12:00:00Z", relatedOrders: [],
});

describe("brokerage stream coordination", () => {
  it("upserts typed stream records without requesting snapshots", () => {
    expect(upsertStreamPosition([position("1")], position("1", 2))[0].quantity).toBe(2);
    expect(upsertStreamPosition([position("1")], position("1", 0))).toEqual([]);
    expect(upsertStreamOrder([order("1")], order("1", "Filled"))[0].status).toBe("Filled");
  });

  it("protects only newly opened positions, not recurring P&L ticks or closures", () => {
    expect(isNewOpenPosition([], position("1"))).toBe(true);
    expect(isNewOpenPosition([position("1")], { ...position("1"), last: 6202 })).toBe(false);
    expect(isNewOpenPosition([], position("1", 0))).toBe(false);
  });

  it("requests one position reconciliation when an order fill arrives", () => {
    expect(orderFillNeedsPositionReconciliation(order("1", "Filled"))).toBe(true);
    expect(orderFillNeedsPositionReconciliation(order("1", "Working"))).toBe(false);
    expect(orderFillNeedsPositionReconciliation(order("1", "Cancelled"))).toBe(false);
  });

  it("recognizes only a completed closing fill as immediately position-authoritative", () => {
    const closeFill = { ...order("1", "Filled"), side: "Sell" as const, openOrClose: "Close" as const, filledQuantity: 1, remainingQuantity: 0, rawStatus: "FLL" };
    expect(isCompletedCloseFill(closeFill)).toBe(true);
    expect(isCompletedCloseFill({ ...closeFill, openOrClose: "Open" })).toBe(false);
    expect(isCompletedCloseFill({ ...closeFill, rawStatus: "FLP", filledQuantity: .5, remainingQuantity: .5 })).toBe(false);
  });

  it("preserves placement bracket metadata when the parent stream update omits it", () => {
    const placed = { ...order("1", "Pending"), takeProfit: 6210, stopLoss: 6190 };
    expect(upsertStreamOrder([placed], order("1", "Filled"))[0]).toMatchObject({
      status: "Filled", takeProfit: 6210, stopLoss: 6190,
    });
  });

  it("does not downgrade a stream fill when the placement response arrives second", () => {
    const streamed = order("1", "Filled");
    const placementResponse = { ...order("1", "Pending"), takeProfit: 6210, stopLoss: 6190 };
    expect(upsertStreamOrder([streamed], placementResponse)[0]).toMatchObject({
      status: "Filled", takeProfit: 6210, stopLoss: 6190,
    });
  });

  it("applies an acknowledged protective-order market conversion immediately", () => {
    const protective = { ...order("1"), side: "Sell" as const, price: 6210, openOrClose: "Close" as const };
    const conversion = {
      ...protective, type: "Market" as const, status: "Pending" as const,
      price: undefined, rawStatus: "ReplacePending",
    };
    expect(upsertStreamOrder([protective], conversion)[0]).toMatchObject({
      type: "Market", status: "Pending", rawStatus: "ReplacePending",
    });
  });

  it("does not let a stale snapshot erase recently updated trade records", () => {
    expect(reconcileOrderSnapshot([order("new", "Pending")], [], new Set(["new"]))).toEqual([order("new", "Pending")]);
    expect(reconcilePositionSnapshot([position("new")], [], new Set(["new"]))).toEqual([position("new")]);
    expect(reconcileOrderSnapshot([order("old")], [])).toEqual([]);
    expect(reconcilePositionSnapshot([position("old")], [])).toEqual([]);
  });

  it("uses slow reconciliation only while both streams are healthy", () => {
    expect(brokeragePollInterval({ positions: "streaming", orders: "streaming" })).toBe(30_000);
    expect(brokeragePollInterval({ positions: "streaming", orders: "reconnecting" })).toBe(5_000);
    expect(brokerageDisplayState({ positions: "streaming", orders: "rate-limited" })).toBe("rate-limited");
  });

  it("recognizes managed quota waits as neutral recovery", () => {
    expect(isManagedThrottle("TradeStation temporarily paused positions requests")).toBe(true);
    expect(isManagedThrottle("Authentication required")).toBe(false);
  });
});
