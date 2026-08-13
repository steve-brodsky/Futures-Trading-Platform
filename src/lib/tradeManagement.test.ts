import { describe, expect, it } from "vitest";
import type { JournalRiskBaseline, OrderUpdate, Position } from "../types";
import { breakEvenPrice, currentRMultiple, findManagedPosition, managedProtectiveOrders, originalRiskBaseline, stopIsAtBreakEven, takeProfitAtOriginalR } from "./tradeManagement";

const position: Position = {
  provider: "tradestation", accountId: "account-1", id: "p1", symbol: "MESU26", side: "Long",
  quantity: 2, averagePrice: 6253.25, last: 6260, unrealizedPnl: 75,
};
const stop: OrderUpdate = {
  id: "stop", accountId: "account-1", symbol: "MESU26", side: "Sell", type: "StopMarket", quantity: 2,
  stopPrice: 6249.5, status: "Working", timestamp: "2026-08-12T00:00:00Z", openOrClose: "Close", groupName: "OCO 1",
};
const target: OrderUpdate = {
  ...stop, id: "target", type: "Limit", price: 6267.5, stopPrice: undefined,
};
const baseline: JournalRiskBaseline = {
  tradeId: "trade-1", symbol: "MESU26", direction: "Long", originalStop: 6249.5, deployedRisk: 75, riskProvenance: "exact",
};

describe("trade management", () => {
  it("selects only the active resolved TradeStation contract in the selected account", () => {
    const schwab = { ...position, id: "schwab", provider: "schwab" as const };
    const otherAccount = { ...position, id: "other", accountId: "account-2" };
    expect(findManagedPosition("MESU26", "account-1", [schwab, otherAccount, position])).toEqual(position);
    expect(findManagedPosition("MESZ26", "account-1", [position])).toBeUndefined();
    expect(findManagedPosition("MESU26", undefined, [position])).toBeUndefined();
  });

  it("finds working protective stops and targets while excluding unrelated orders", () => {
    const unrelated = { ...target, id: "other-symbol", symbol: "MNQU26" };
    const cancelled = { ...stop, id: "cancelled", status: "Cancelled" as const };
    expect(managedProtectiveOrders(position, "account-1", [target, unrelated, cancelled, stop])).toEqual({
      stops: [stop],
      targets: [target],
    });
    expect(managedProtectiveOrders(position, "account-2", [stop, target])).toEqual({ stops: [], targets: [] });
  });

  it("preserves multiple matching exits so the UI can reject ambiguous one-click changes", () => {
    const secondStop = { ...stop, id: "stop-2" };
    expect(managedProtectiveOrders(position, "account-1", [stop, secondStop]).stops).toHaveLength(2);
  });

  it("accepts exact and inferred original risk but rejects unknown or invalid baselines", () => {
    expect(originalRiskBaseline(position, [baseline])).toEqual(baseline);
    expect(originalRiskBaseline(position, [{ ...baseline, riskProvenance: "inferred" }])?.riskProvenance).toBe("inferred");
    expect(originalRiskBaseline(position, [{ ...baseline, riskProvenance: "unknown" }])).toBeUndefined();
    expect(originalRiskBaseline(position, [{ ...baseline, originalStop: undefined }])).toBeUndefined();
  });

  it("calculates tick-aligned custom-R targets for long and short trades", () => {
    expect(takeProfitAtOriginalR(position, baseline, 2, .25)).toBe(6260.75);
    const shortPosition = { ...position, side: "Short" as const, averagePrice: 100.1 };
    const shortBaseline = { ...baseline, direction: "Short" as const, originalStop: 102.25 };
    expect(takeProfitAtOriginalR(shortPosition, shortBaseline, 1.5, .25)).toBe(96.75);
    expect(takeProfitAtOriginalR(position, baseline, 0, .25)).toBeNull();
  });

  it("calculates break-even and current R states", () => {
    expect(breakEvenPrice({ ...position, averagePrice: 6253.37 }, .25)).toBe(6253.25);
    expect(stopIsAtBreakEven({ ...stop, stopPrice: 6253.25 }, 6253.25, .25)).toBe(true);
    expect(stopIsAtBreakEven(stop, 6253.25, .25)).toBe(false);
    expect(currentRMultiple(position, baseline)).toBe(1);
    expect(currentRMultiple(position, { ...baseline, deployedRisk: undefined })).toBeNull();
  });
});
