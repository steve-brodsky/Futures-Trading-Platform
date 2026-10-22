import { describe, expect, it } from "vitest";
import type { OrderUpdate, Position, Quote } from "../types";
import { equityQuoteAvailable, hasEquityExposure, sharesForRisk } from "./equityTrading";
import { applyProjectedExitEdit, buildProjectedTradeLines, buildTradeLineMetrics, buildTradeLines, orderProjectionScope, recalculateOrderProjectionAtR } from "./tradeLines";

const now = Date.parse("2026-10-21T15:00:00Z");
const quote: Quote = { provider: "schwab", symbol: "SPY", bid: 99.98, ask: 100.02, last: 100, change: 0, changePct: 0, delayed: false, halted: false, timestamp: new Date(now).toISOString(), receivedAt: now };
const position: Position = { provider: "schwab", accountId: "account", id: "position", symbol: "SPY", side: "Long", quantity: 50, averagePrice: 100, last: 101, unrealizedPnl: 50, assetType: "EQUITY" };
const stop: OrderUpdate = { provider: "schwab", accountId: "account", id: "stop", symbol: "SPY", side: "Sell", type: "StopMarket", quantity: 50, stopPrice: 98, status: "Working", timestamp: "", assetType: "EQUITY", openOrClose: "Close", groupName: "OCO", schwab: { rootOrderId: "1", parentOrderId: "2", ocoOrderId: "2", instruction: "SELL", contingent: false, editable: true, cancelable: true } };

describe("Schwab equity sizing", () => {
  it("sizes longs at ask and shorts at bid with no futures point-value multiplier", () => {
    expect(sharesForRisk(100, quote.ask, 98.02, "Buy")).toBe(50);
    expect(sharesForRisk(100, quote.bid, 101.98, "Sell")).toBe(50);
    expect(sharesForRisk(1, 100, 98, "Buy")).toBe(0);
  });
  it("corrects binary whole-share boundaries without rounding up fractional shares", () => {
    expect(sharesForRisk(1, 100.1, 100, "Buy")).toBe(10);
    expect(sharesForRisk(1, 100.1000001, 100, "Buy")).toBe(9);
    expect(sharesForRisk(100, 100, 98.99, "Buy")).toBe(99);
  });
  it("rejects missing budgets, invalid distances and unsupported zero sizing", () => {
    for (const budget of [undefined, 0, -1, NaN, Infinity]) expect(sharesForRisk(budget, 100, 98, "Buy")).toBe(0);
    expect(sharesForRisk(100, 100, 100, "Buy")).toBe(0);
    expect(sharesForRisk(100, 100, 102, "Buy")).toBe(0);
    expect(sharesForRisk(100, 100, 98, "Sell")).toBe(0);
    expect(sharesForRisk(100, 0, 1, "Sell")).toBe(0);
  });
});

describe("equity trading eligibility", () => {
  it("requires genuine recent executable quotes, including the source timestamp", () => {
    expect(equityQuoteAvailable(quote, now)).toBe(true);
    for (const patch of [{ bid: 0 }, { ask: 0 }, { ask: 99 }, { bid: NaN }, { delayed: true }, { halted: true }, { receivedAt: now - 5_001 }, { timestamp: "" }, { timestamp: new Date(now - 5_001).toISOString() }]) {
      expect(equityQuoteAvailable({ ...quote, ...patch }, now)).toBe(false);
    }
  });
  it("scopes existing exposure to the equity symbol, account and provider", () => {
    expect(hasEquityExposure("account", "spy", [position], [])).toBe(true);
    expect(hasEquityExposure("different", "SPY", [position], [])).toBe(false);
    expect(hasEquityExposure("account", "SPY", [{ ...position, provider: "tradestation" }], [])).toBe(false);
    expect(hasEquityExposure("account", "SPY", [{ ...position, assetType: "OPTION", underlying: "SPY" }], [])).toBe(false);
    expect(hasEquityExposure("account", "SPY", [], [stop])).toBe(true);
    expect(hasEquityExposure("account", "SPY", [], [{ ...stop, status: "Cancelled" }])).toBe(false);
  });
});

describe("equity chart lines", () => {
  it("isolates drafts across symbols, accounts, and brokers while sharing same-symbol panes", () => {
    const scope = orderProjectionScope("schwab", "account", "SPY");
    expect(orderProjectionScope("schwab", "account", "spy")).toBe(scope);
    expect(orderProjectionScope("schwab", "account", "AAPL")).not.toBe(scope);
    expect(orderProjectionScope("schwab", "other-account", "SPY")).not.toBe(scope);
    expect(orderProjectionScope("tradestation", "account", "SPY")).not.toBe(scope);
  });
  it("updates R targets on price changes even when whole-share quantity is unchanged", () => {
    const initial = { entryPrice: 100, side: "Buy" as const, quantity: 50, stopLoss: 98, takeProfit: 103, rMultiple: 1.5 as const };
    const moved = recalculateOrderProjectionAtR({ ...initial, entryPrice: 100.01 }, 100.01, .01);
    expect(moved.quantity).toBe(50);
    expect(moved.takeProfit).toBe(103.03);
    expect(buildProjectedTradeLines(moved).map((l) => l.kind)).toEqual(["projected-entry", "projected-take-profit", "projected-stop-loss"]);
  });
  it("preserves a selected R on stop drag and clears it on manual target edits", () => {
    const initial = { side: "Sell" as const, quantity: 20, stopLoss: 102, takeProfit: 97, rMultiple: 1.5 as const };
    expect(applyProjectedExitEdit(initial, "stopLoss", 104, 100, .01)).toMatchObject({ takeProfit: 94, rMultiple: 1.5 });
    expect(applyProjectedExitEdit(initial, "takeProfit", 96, 100, .01).rMultiple).toBeUndefined();
  });
  it("distinguishes contingent orders from active draggable protection", () => {
    const contingent = { ...stop, schwab: { ...stop.schwab!, contingent: true }, rawStatus: "AWAITING_PARENT_ORDER" };
    expect(buildTradeLines("SPY", [position], [contingent])[1]).toMatchObject({ kind: "stop-loss", draggable: false, label: "CONTINGENT SL 50" });
    expect(buildTradeLines("SPY", [position], [stop])[1]).toMatchObject({ kind: "stop-loss", draggable: true });
    expect(buildTradeLines("SPY", [position], [stop])[0].actionable).toBe(true);
  });
  it("shows actual entry risk and live P&L using one dollar per share", () => {
    const lines = buildTradeLines("SPY", [position], [stop]);
    const metrics = buildTradeLineMetrics(lines, 1, 101, undefined, [{ tradeId: "trade", symbol: "SPY", direction: "Long", originalStop: 98, deployedRisk: 100, riskProvenance: "exact" }]);
    expect(metrics.get("position:position")).toEqual({ dollarAmount: 50, rMultiple: .5 });
    expect(metrics.get("order:stop")).toEqual({ dollarAmount: -100, rMultiple: -1 });
  });
});
