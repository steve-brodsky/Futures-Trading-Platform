import { describe, expect, it } from "vitest";
import type { AutoBreakEvenRule, JournalRiskBaseline, OrderUpdate, Position } from "../types";
import { autoBreakEvenRuleKey, breakEvenPrice, currentRMultiple, evaluateAutoBreakEven, findManagedPosition, managedProtectiveOrders, normalizeAutoBreakEvenRules, originalRiskBaseline, removeClosedAutoBreakEvenRules, stopIsAtBreakEven, stopProtectsBreakEven, takeProfitAtOriginalR } from "./tradeManagement";

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

  it("normalizes persisted automatic break-even rules by their full identity", () => {
    const key = autoBreakEvenRuleKey("sim", "account-1", "p1");
    const rule: AutoBreakEvenRule = {
      environment: "sim", accountId: "account-1", positionId: "p1", symbol: "mesu26",
      thresholdR: 1.25, status: "armed", clientMutationId: "mutation-1",
    };
    expect(normalizeAutoBreakEvenRules({ [key]: rule })).toEqual({ [key]: { ...rule, symbol: "MESU26" } });
    expect(normalizeAutoBreakEvenRules({ wrong: rule })).toEqual({});
    expect(normalizeAutoBreakEvenRules({ [key]: { ...rule, thresholdR: 0 } })).toEqual({});
    expect(normalizeAutoBreakEvenRules([])).toEqual({});
  });

  it("never weakens a stop that already protects break-even", () => {
    expect(stopProtectsBreakEven(position, { ...stop, stopPrice: 6253.25 }, 6253.25, .25)).toBe(true);
    expect(stopProtectsBreakEven(position, { ...stop, stopPrice: 6254 }, 6253.25, .25)).toBe(true);
    expect(stopProtectsBreakEven(position, { ...stop, stopPrice: 6253 }, 6253.25, .25)).toBe(false);
    const shortPosition = { ...position, side: "Short" as const };
    expect(stopProtectsBreakEven(shortPosition, { ...stop, side: "Buy", stopPrice: 6253 }, 6253.25, .25)).toBe(true);
    expect(stopProtectsBreakEven(shortPosition, { ...stop, side: "Buy", stopPrice: 6253.5 }, 6253.25, .25)).toBe(false);
  });

  it("evaluates waiting, immediate trigger, and latched completion states", () => {
    expect(evaluateAutoBreakEven({ position: { ...position, unrealizedPnl: 74 }, accountId: "account-1", orders: [stop], baseline, minMove: .25, thresholdR: 1, brokerageReady: true }).state).toBe("waiting");
    const triggered = evaluateAutoBreakEven({ position, accountId: "account-1", orders: [stop], baseline, minMove: .25, thresholdR: 1, brokerageReady: true });
    expect(triggered.state).toBe("trigger");
    expect(triggered.stop).toEqual(stop);
    expect(triggered.breakEven).toBe(6253.25);
    expect(evaluateAutoBreakEven({ position, accountId: "account-1", orders: [{ ...stop, stopPrice: 6254 }], baseline, minMove: .25, thresholdR: 1, brokerageReady: true }).state).toBe("complete");
  });

  it("pauses automation until brokerage, risk, contract, and stop data are unambiguous", () => {
    expect(evaluateAutoBreakEven({ position, accountId: "account-1", orders: [stop], baseline, minMove: .25, thresholdR: 1, brokerageReady: false }).reason).toMatch(/brokerage/i);
    expect(evaluateAutoBreakEven({ position, accountId: "account-1", orders: [stop], minMove: .25, thresholdR: 1, brokerageReady: true }).reason).toMatch(/risk/i);
    expect(evaluateAutoBreakEven({ position, accountId: "account-1", orders: [stop], baseline, thresholdR: 1, brokerageReady: true }).reason).toMatch(/contract/i);
    expect(evaluateAutoBreakEven({ position, accountId: "account-1", orders: [], baseline, minMove: .25, thresholdR: 1, brokerageReady: true }).reason).toMatch(/no working/i);
    expect(evaluateAutoBreakEven({ position, accountId: "account-1", orders: [stop, { ...stop, id: "stop-2" }], baseline, minMove: .25, thresholdR: 1, brokerageReady: true }).reason).toMatch(/multiple/i);
  });

  it("removes rules only after a ready account snapshot confirms their position closed", () => {
    const simKey = autoBreakEvenRuleKey("sim", "account-1", "p1");
    const otherKey = autoBreakEvenRuleKey("live", "account-1", "p2");
    const rules: Record<string, AutoBreakEvenRule> = {
      [simKey]: { environment: "sim", accountId: "account-1", positionId: "p1", symbol: "MESU26", thresholdR: 1, status: "armed", clientMutationId: "m1" },
      [otherKey]: { environment: "live", accountId: "account-1", positionId: "p2", symbol: "MNQU26", thresholdR: 1, status: "armed", clientMutationId: "m2" },
    };
    expect(removeClosedAutoBreakEvenRules(rules, "sim", "account-1", [position])).toBe(rules);
    expect(removeClosedAutoBreakEvenRules(rules, "sim", "account-1", [])).toEqual({ [otherKey]: rules[otherKey] });
  });
});
