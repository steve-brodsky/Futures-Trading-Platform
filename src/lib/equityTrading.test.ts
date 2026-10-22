import { describe, expect, it } from "vitest";
import type { OrderUpdate, Position, Quote, SchwabEquityOrderDraft } from "../types";
import { equityQuoteAvailable, hasEquityExposure, isEquity, isEquityRiskBudgetRejection, reducedEquityRiskDraft, sharesForRisk } from "./equityTrading";
import { applyProjectedExitEdit, buildProjectedTradeLines, buildTradeLineMetrics, buildTradeLines, orderProjectionScope, recalculateOrderProjectionAtR } from "./tradeLines";

const now = Date.parse("2026-10-21T15:00:00Z");
const quote: Quote = { provider: "schwab", symbol: "SPY", bid: 99.98, ask: 100.02, last: 100, change: 0, changePct: 0, delayed: false, halted: false, timestamp: new Date(now).toISOString(), receivedAt: now };
const position: Position = { provider: "schwab", accountId: "account", id: "position", symbol: "SPY", side: "Long", quantity: 50, averagePrice: 100, last: 101, unrealizedPnl: 50, assetType: "EQUITY" };
const stop: OrderUpdate = { provider: "schwab", accountId: "account", id: "stop", symbol: "SPY", side: "Sell", type: "StopMarket", quantity: 50, stopPrice: 98, status: "Working", timestamp: "", assetType: "EQUITY", openOrClose: "Close", groupName: "OCO", schwab: { rootOrderId: "1", parentOrderId: "2", ocoOrderId: "2", instruction: "SELL", contingent: false, editable: true, cancelable: true } };

describe("risk-budget share reduction", () => {
  const draft: SchwabEquityOrderDraft = { accountId: "account", symbol: "SPY", direction: "Long", sizingMode: "risk", riskBudget: 100, quantity: 50, referenceEntry: 100, stopLoss: 98, takeProfit: 103, rMultiple: 1.5, exitDuration: "GTC" };
  it("proposes fewer whole shares at ask while preserving the reviewed exits and budget", () => {
    const proposal = reducedEquityRiskDraft(draft, { ...quote, bid: 100.08, ask: 100.10 }, now);
    expect(proposal).toEqual({ ...draft, quantity: 47, referenceEntry: 100.10 });
    expect((proposal.referenceEntry - proposal.stopLoss) * proposal.quantity).toBeLessThanOrEqual(100);
    expect(draft.quantity).toBe(50);
  });
  it("sizes short reductions from bid", () => {
    const short = { ...draft, direction: "Short" as const, referenceEntry: 100, stopLoss: 102, takeProfit: 97 };
    expect(reducedEquityRiskDraft(short, { ...quote, bid: 99.9, ask: 99.92 }, now)).toEqual({ ...short, quantity: 47, referenceEntry: 99.9 });
  });
  it("blocks proposals with stale, missing, delayed or mismatched quotes", () => {
    for (const patch of [{ receivedAt: now - 5_001 }, { timestamp: "" }, { delayed: true }, { halted: true }, { ask: 0 }, { symbol: "AAPL" }]) {
      expect(() => reducedEquityRiskDraft(draft, { ...quote, ...patch }, now)).toThrow(/quotes|quote/i);
    }
  });
  it("blocks zero shares and manual-share orders", () => {
    expect(() => reducedEquityRiskDraft({ ...draft, riskBudget: 1 }, quote, now)).toThrow("cannot cover one share");
    expect(() => reducedEquityRiskDraft({ ...draft, sizingMode: "shares" }, quote, now)).toThrow("risk budget");
  });
  it("does not increase shares or submit an unnecessary reduction after the price recovers", () => {
    expect(() => reducedEquityRiskDraft(draft, { ...quote, bid: 99.97, ask: 99.99 }, now)).toThrow("no share reduction is needed");
  });
  it("requires the existing stop and target to remain valid at the latest price", () => {
    expect(() => reducedEquityRiskDraft(draft, { ...quote, bid: 103.08, ask: 103.1 }, now)).toThrow("outside the stop/target range");
  });
  it("recognizes the specific preflight budget rejection without treating other errors as safe retries", () => {
    expect(isEquityRiskBudgetRejection("Price moved: the reviewed quantity exceeds your risk budget. Refresh the ticket")).toBe(true);
    for (const message of ["Schwab outcome unknown", "Insufficient buying power", "Short sale unavailable", "Request interrupted"]) {
      expect(isEquityRiskBudgetRejection(message)).toBe(false);
    }
  });
});

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
  it("recognizes Schwab ETF order classifications without enabling other assets", () => {
    for (const asset of ["EQUITY", "ETF", "COLLECTIVE_INVESTMENT"]) {
      expect(isEquity(asset)).toBe(true);
      expect(hasEquityExposure("account", "SPY", [], [{ ...stop, assetType: asset }])).toBe(true);
    }
    for (const asset of [undefined, "INDEX", "OPTION", "MUTUAL_FUND", "FIXED_INCOME"]) expect(isEquity(asset)).toBe(false);
  });
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
  it("renders both working SPY exits when Schwab reports COLLECTIVE_INVESTMENT", () => {
    const etfPosition = { ...position, assetType: "COLLECTIVE_INVESTMENT" };
    const etfStop = { ...stop, assetType: "COLLECTIVE_INVESTMENT" };
    const target: OrderUpdate = { ...etfStop, id: "target", type: "Limit", price: 103, stopPrice: undefined };
    const lines = buildTradeLines("SPY", [etfPosition], [etfStop, target]);
    expect(lines.map(line => line.kind)).toEqual(["position", "stop-loss", "take-profit"]);
    expect(lines[0].actionable).toBe(true);
    expect(lines.slice(1).every(line => line.draggable)).toBe(true);
    expect(buildTradeLines("SPY", [etfPosition], [etfStop, target].map(order => ({ ...order, status: "Cancelled" }))).map(line => line.kind)).toEqual(["position"]);
  });
  it("clears empty projections after acceptance while retaining zero-share sizing previews with exits", () => {
    expect(buildProjectedTradeLines({})).toEqual([]);
    expect(buildProjectedTradeLines({ entryPrice: 765, quantity: 0, side: "Buy" })).toEqual([]);
    expect(buildProjectedTradeLines({ entryPrice: 765, quantity: 0, stopLoss: 763 }).map(line => line.kind)).toEqual(["projected-entry", "projected-stop-loss"]);
  });
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
