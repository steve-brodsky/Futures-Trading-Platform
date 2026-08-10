import { describe, expect, it } from "vitest";
import type { JournalRiskBaseline, OrderUpdate, Position } from "../types";
import { applyProjectedExitEdit, buildProjectedTradeLines, buildTradeLineMetrics, buildTradeLines, flattenOrderDraft, formatTradeLineMetrics, isPositionExit, recalculateOrderProjectionAtR, snapTradeLinePrice, snapshotOrderProjection, tradeLinePriceChanged, withOrderPrice, type OrderProjection } from "./tradeLines";

const position: Position = { id: "p1", symbol: "MES", side: "Long", quantity: 2, averagePrice: 6250, last: 6251, unrealizedPnl: 10 };
const baseOrder: OrderUpdate = { id: "o1", symbol: "MES", side: "Sell", type: "Limit", quantity: 2, price: 6260, status: "Working", timestamp: "", openOrClose: "Close", groupName: "OCO 1" };
const riskBaseline = (direction: "Long" | "Short", originalStop: number, deployedRisk = 50, riskProvenance: JournalRiskBaseline["riskProvenance"] = "exact"): JournalRiskBaseline => ({
  tradeId: `trade-${direction.toLowerCase()}`,
  symbol: "MES",
  direction,
  originalStop,
  deployedRisk,
  riskProvenance,
});

describe("chart trade lines", () => {
  it("classifies positions and bracket exits", () => {
    const lines = buildTradeLines("MES", [position], [baseOrder, { ...baseOrder, id: "o2", type: "StopMarket", price: undefined, stopPrice: 6240 }]);
    expect(lines.map((line) => [line.kind, line.draggable, line.color])).toEqual([
      ["position", false, "#16c79a"],
      ["take-profit", true, "#16c79a"],
      ["stop-loss", true, "#ef466f"],
    ]);
  });

  it("keeps unrelated working orders visible but static", () => {
    const [line] = buildTradeLines("MES", [], [{ ...baseOrder, openOrClose: "Open", groupName: undefined }]);
    expect(line.kind).toBe("order");
    expect(line.draggable).toBe(false);
  });

  it("recognizes TradeStation BRK groups and case-insensitive close metadata", () => {
    const [line] = buildTradeLines("MES", [], [{ ...baseOrder, openOrClose: "Close", groupName: "BRK 123" }]);
    expect(line).toMatchObject({ kind: "take-profit", draggable: true });
  });

  it("infers unlabeled protective exits from the live position side", () => {
    const shortPosition = { ...position, side: "Short" as const, quantity: 1 };
    const takeProfit = { ...baseOrder, side: "Buy" as const, openOrClose: undefined, groupName: undefined };
    const stopLoss = { ...takeProfit, id: "o2", type: "StopMarket" as const, price: undefined, stopPrice: 6270 };
    expect(isPositionExit(takeProfit, [shortPosition])).toBe(true);
    expect(buildTradeLines("MES", [shortPosition], [takeProfit, stopLoss]).map((line) => [line.kind, line.draggable])).toEqual([
      ["position", false],
      ["take-profit", true],
      ["stop-loss", true],
    ]);
  });

  it("shows only the selected concrete contract on a continuous chart", () => {
    const selected = { ...position, symbol: "MESU26" };
    const other = { ...position, id: "p2", symbol: "MESZ26" };
    const lines = buildTradeLines("MESU26", [selected, other], [{ ...baseOrder, symbol: "MESZ26" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0].position?.symbol).toBe("MESU26");
  });

  it("draws Schwab option holdings on the underlying strike without a close action", () => {
    const option: Position = {
      id: "schwab-option", provider: "schwab", accountId: "hash-1", assetType: "OPTION",
      symbol: "SPY   260821C00600000", underlying: "SPY", expirationDate: "2026-08-21",
      strikePrice: 600, putCall: "CALL", side: "Long", quantity: 2, averagePrice: 4.2,
      last: 5.1, unrealizedPnl: 180, multiplier: 100,
    };
    const [line] = buildTradeLines("SPY", [option], []);
    expect(line).toMatchObject({ price: 600, color: "#37d5e8", actionable: false, suppressMetrics: true });
    expect(line.label).toBe("SCHWAB LONG 2 · 08/21 600C · +$180.00");
    expect(buildTradeLines("SPY", [{ ...option, unrealizedPnl: -180 }], [])[0].label).toBe("SCHWAB LONG 2 · 08/21 600C · -$180.00");
    expect(buildTradeLines("QQQ", [option], [])).toEqual([]);
  });

  it("builds the opposite-side flatten market draft", () => {
    expect(flattenOrderDraft("account", position)).toMatchObject({ side: "Sell", quantity: 2, type: "Market" });
    expect(flattenOrderDraft("account", { ...position, side: "Short" })).toMatchObject({ side: "Buy" });
    expect(flattenOrderDraft("account", { ...position, side: "Short", quantity: -2 })).toMatchObject({ side: "Buy", quantity: 2 });
  });

  it("draws signed broker quantities as absolute contract counts", () => {
    const [line] = buildTradeLines("MES", [{ ...position, side: "Short", quantity: -2 }], []);
    expect(line).toMatchObject({ kind: "position", side: "Short", quantity: 2, color: "#ef466f" });
  });

  it("builds green and red projected exit lines from non-empty ticket prices", () => {
    expect(buildProjectedTradeLines({ takeProfit: 6260, stopLoss: 6240 }).map((line) => [line.kind, line.price, line.color, line.draggable])).toEqual([
      ["projected-take-profit", 6260, "#16c79a", true],
      ["projected-stop-loss", 6240, "#ef466f", true],
    ]);
    expect(buildProjectedTradeLines({ takeProfit: undefined, stopLoss: Number.NaN })).toEqual([]);
  });

  it("snaps drag previews and ignores unchanged drops", () => {
    expect(snapTradeLinePrice(6250.37, .25)).toBe(6250.25);
    expect(snapTradeLinePrice(-1, .25)).toBeNull();
    expect(tradeLinePriceChanged(6250.25, 6250.25, .25)).toBe(false);
    expect(tradeLinePriceChanged(6250.25, 6250.5, .25)).toBe(true);
  });

  it.each([
    ["Buy", 96, 108],
    ["Sell", 104, 92],
  ] as const)("keeps 2R coupled during rapid %s stop edits", (side, firstStop, expectedFirstTarget) => {
    const initial: OrderProjection = { takeProfit: side === "Buy" ? 104 : 96, stopLoss: side === "Buy" ? 98 : 102, side, quantity: 1, rMultiple: 2 };
    const first = applyProjectedExitEdit(initial, "stopLoss", firstStop, 100, .25);
    const secondStop = side === "Buy" ? 95 : 105;
    const second = applyProjectedExitEdit(first, "stopLoss", secondStop, 100, .25);

    expect(first).toMatchObject({ stopLoss: firstStop, takeProfit: expectedFirstTarget, rMultiple: 2 });
    expect(second).toMatchObject({ stopLoss: secondStop, takeProfit: side === "Buy" ? 110 : 90, rMultiple: 2 });
  });

  it("clears R for a manual take-profit edit without changing the stop", () => {
    expect(applyProjectedExitEdit({ takeProfit: 108, stopLoss: 96, side: "Buy", rMultiple: 2 }, "takeProfit", 109, 100, .25)).toEqual({
      takeProfit: 109,
      stopLoss: 96,
      side: "Buy",
      rMultiple: undefined,
    });
  });

  it("keeps dormant R and the prior target while a stop is on the wrong side", () => {
    expect(applyProjectedExitEdit({ takeProfit: 108, stopLoss: 96, side: "Buy", rMultiple: 2 }, "stopLoss", 101, 100, .25)).toEqual({
      takeProfit: 108,
      stopLoss: 101,
      side: "Buy",
      rMultiple: 2,
    });
  });

  it("recalculates R targets on quote changes and snapshots cancellation state", () => {
    const projection: OrderProjection = { takeProfit: 108, stopLoss: 96, side: "Buy", quantity: 2, rMultiple: 2 };
    expect(recalculateOrderProjectionAtR(projection, 101, .25)).toMatchObject({ takeProfit: 111, stopLoss: 96, rMultiple: 2 });
    const snapshot = snapshotOrderProjection(projection);
    projection.takeProfit = 110;
    expect(snapshot).toEqual({ takeProfit: 108, stopLoss: 96, side: "Buy", quantity: 2, rMultiple: 2 });
  });

  it("can apply and roll back either protective price field", () => {
    const optimistic = withOrderPrice(baseOrder, 6261);
    expect(optimistic.price).toBe(6261);
    expect(withOrderPrice(optimistic, baseOrder.price).price).toBe(6260);
    const stop = { ...baseOrder, type: "StopMarket" as const, price: undefined, stopPrice: 6240 };
    expect(withOrderPrice(stop, 6239.75)).toMatchObject({ stopPrice: 6239.75, price: undefined });
  });

  it("calculates full-position dollar and R values for long and short trades", () => {
    const longPosition = { ...position, averagePrice: 100, unrealizedPnl: 60 };
    const longLines = buildTradeLines("MES", [longPosition], [
      { ...baseOrder, price: 110 },
      { ...baseOrder, id: "o2", type: "StopMarket", price: undefined, stopPrice: 95 },
    ]);
    const longMetrics = buildTradeLineMetrics(longLines, 5, undefined, undefined, [riskBaseline("Long", 95)]);
    expect(longMetrics.get("position:p1")).toEqual({ dollarAmount: 60, rMultiple: 1.2 });
    expect(longMetrics.get("order:o1")).toEqual({ dollarAmount: 100, rMultiple: 2 });
    expect(longMetrics.get("order:o2")).toEqual({ dollarAmount: -50, rMultiple: -1 });

    const shortPosition = { ...longPosition, side: "Short" as const };
    const shortLines = buildTradeLines("MES", [shortPosition], [
      { ...baseOrder, side: "Buy", price: 90 },
      { ...baseOrder, id: "o2", side: "Buy", type: "StopMarket", price: undefined, stopPrice: 105 },
    ]);
    const shortMetrics = buildTradeLineMetrics(shortLines, 5, undefined, undefined, [riskBaseline("Short", 105)]);
    expect(shortMetrics.get("order:o1")).toEqual({ dollarAmount: 100, rMultiple: 2 });
    expect(shortMetrics.get("order:o2")).toEqual({ dollarAmount: -50, rMultiple: -1 });
  });

  it("uses the live quote for position metrics while leaving exit projections unchanged", () => {
    const tradePosition = { ...position, averagePrice: 100, unrealizedPnl: 5 };
    const lines = buildTradeLines("MES", [tradePosition], [
      { ...baseOrder, price: 110 },
      { ...baseOrder, id: "o2", type: "StopMarket", price: undefined, stopPrice: 95 },
    ]);
    const metrics = buildTradeLineMetrics(lines, 5, 102.5, undefined, [riskBaseline("Long", 95)]);
    expect(metrics.get("position:p1")).toEqual({ dollarAmount: 25, rMultiple: .5 });
    expect(metrics.get("order:o1")).toEqual({ dollarAmount: 100, rMultiple: 2 });
    expect(metrics.get("order:o2")).toEqual({ dollarAmount: -50, rMultiple: -1 });
  });

  it("uses persisted initial risk instead of the current working stop", () => {
    const tradePosition = { ...position, averagePrice: 100 };
    const baseline = [riskBaseline("Long", 95)];
    const metricsAt = (stopPrice: number) => {
      const lines = buildTradeLines("MES", [tradePosition], [
        { ...baseOrder, price: 110 },
        { ...baseOrder, id: "stop", type: "StopMarket", price: undefined, stopPrice },
      ]);
      return buildTradeLineMetrics(lines, 5, 102.5, undefined, baseline);
    };

    expect(metricsAt(95).get("position:p1")?.rMultiple).toBe(.5);
    expect(metricsAt(100).get("position:p1")?.rMultiple).toBe(.5);
    expect(metricsAt(103).get("position:p1")?.rMultiple).toBe(.5);
    expect(metricsAt(90).get("position:p1")?.rMultiple).toBe(.5);
    expect(metricsAt(100).get("order:stop")?.rMultiple).toBe(0);
    expect(metricsAt(103).get("order:stop")?.rMultiple).toBe(.6);
    expect(metricsAt(90).get("order:stop")?.rMultiple).toBe(-2);
    expect(metricsAt(103).get("order:o1")?.rMultiple).toBe(2);
  });

  it("keeps the persisted initial-risk denominator for a short trade", () => {
    const tradePosition = { ...position, averagePrice: 100, side: "Short" as const };
    const metricsAt = (stopPrice: number) => {
      const lines = buildTradeLines("MES", [tradePosition], [
        { ...baseOrder, side: "Buy", price: 90 },
        { ...baseOrder, id: "stop", side: "Buy", type: "StopMarket", price: undefined, stopPrice },
      ]);
      return buildTradeLineMetrics(lines, 5, 97.5, undefined, [riskBaseline("Short", 105)]);
    };

    expect(metricsAt(105).get("position:p1")?.rMultiple).toBe(.5);
    expect(metricsAt(100).get("position:p1")?.rMultiple).toBe(.5);
    expect(metricsAt(97).get("position:p1")?.rMultiple).toBe(.5);
    expect(metricsAt(100).get("order:stop")?.rMultiple).toBe(0);
    expect(metricsAt(97).get("order:stop")?.rMultiple).toBe(.6);
  });

  it("keeps position dollars without an R baseline and calculates projected exits from the current price", () => {
    const tradePosition = { ...position, averagePrice: 100, unrealizedPnl: 25 };
    const lines = [
      ...buildTradeLines("MES", [tradePosition], [{ ...baseOrder, price: 110 }]),
      ...buildProjectedTradeLines({ takeProfit: 112, stopLoss: 94, side: "Buy", quantity: 3 }),
    ];
    const metrics = buildTradeLineMetrics(lines, 5, 100);
    expect(metrics.get("position:p1")).toEqual({ dollarAmount: 0, rMultiple: null });
    expect(metrics.get("order:o1")).toEqual({ dollarAmount: 100, rMultiple: null });
    expect(metrics.get("projection:take-profit")).toEqual({ dollarAmount: 180, rMultiple: 2 });
    expect(metrics.get("projection:stop-loss")).toEqual({ dollarAmount: -90, rMultiple: -1 });
  });

  it.each([
    ["unknown provenance", riskBaseline("Long", 95, 50, "unknown")],
    ["missing original stop", { ...riskBaseline("Long", 95), originalStop: undefined }],
    ["invalid original stop", riskBaseline("Long", Number.NaN)],
    ["zero deployed risk", riskBaseline("Long", 95, 0)],
    ["invalid deployed risk", riskBaseline("Long", 95, Number.NaN)],
  ])("shows no live R for %s", (_label, baseline) => {
    const tradePosition = { ...position, averagePrice: 100, unrealizedPnl: 25 };
    const lines = buildTradeLines("MES", [tradePosition], [
      { ...baseOrder, id: "stop", type: "StopMarket", price: undefined, stopPrice: 95 },
    ]);
    expect(buildTradeLineMetrics(lines, 5, undefined, undefined, [baseline]).get("position:p1")).toEqual({
      dollarAmount: 25,
      rMultiple: null,
    });
  });

  it("calculates short projected exits and updates them with the current price", () => {
    const lines = buildProjectedTradeLines({ takeProfit: 90, stopLoss: 105, side: "Sell", quantity: 2 });
    const initial = buildTradeLineMetrics(lines, 5, 100);
    expect(initial.get("projection:take-profit")).toEqual({ dollarAmount: 100, rMultiple: 2 });
    expect(initial.get("projection:stop-loss")).toEqual({ dollarAmount: -50, rMultiple: -1 });

    const nextTick = buildTradeLineMetrics(lines, 5, 101);
    expect(nextTick.get("projection:take-profit")).toEqual({ dollarAmount: 110, rMultiple: 2.75 });
    expect(nextTick.get("projection:stop-loss")).toEqual({ dollarAmount: -40, rMultiple: -1 });
  });

  it("uses the executable entry price for projections without changing live position PnL", () => {
    const tradePosition = { ...position, averagePrice: 100, unrealizedPnl: 25 };
    const lines = [
      ...buildTradeLines("MES", [tradePosition], []),
      ...buildProjectedTradeLines({ takeProfit: 110, stopLoss: 95, side: "Buy", quantity: 2 }),
    ];
    const metrics = buildTradeLineMetrics(lines, 5, 100, 101);
    expect(metrics.get("position:p1")).toEqual({ dollarAmount: 0, rMultiple: null });
    expect(metrics.get("projection:take-profit")).toEqual({ dollarAmount: 90, rMultiple: 1.5 });
    expect(metrics.get("projection:stop-loss")).toEqual({ dollarAmount: -60, rMultiple: -1 });
  });

  it("shows projected dollars with a missing R baseline until a valid stop exists", () => {
    const lines = buildProjectedTradeLines({ takeProfit: 110, side: "Buy", quantity: 2 });
    expect(buildTradeLineMetrics(lines, 5, 100).get("projection:take-profit")).toEqual({
      dollarAmount: 100,
      rMultiple: null,
    });
  });

  it("keeps an unavailable risk-sized quantity at zero on projected exits", () => {
    const lines = buildProjectedTradeLines({ takeProfit: 110, stopLoss: 95, side: "Buy", quantity: 0 });
    expect(lines.map((line) => line.quantity)).toEqual([0, 0]);
    expect(buildTradeLineMetrics(lines, 5, 100)).toEqual(new Map());
  });

  it("formats every visibility mode and missing risk without negative zero", () => {
    const profit = { dollarAmount: 100, rMultiple: 2 };
    expect(formatTradeLineMetrics(profit, { showDollarAmount: true, showRMultiple: true })).toBe("+$100.00 · +2R");
    expect(formatTradeLineMetrics(profit, { showDollarAmount: true, showRMultiple: false })).toBe("+$100.00");
    expect(formatTradeLineMetrics(profit, { showDollarAmount: false, showRMultiple: true })).toBe("+2R");
    expect(formatTradeLineMetrics(profit, { showDollarAmount: false, showRMultiple: false })).toBeNull();
    expect(formatTradeLineMetrics({ dollarAmount: 60, rMultiple: 1.24 }, { showDollarAmount: true, showRMultiple: true })).toBe("+$60.00 · +1.2R");
    expect(formatTradeLineMetrics({ dollarAmount: -0.001, rMultiple: -0.01 }, { showDollarAmount: true, showRMultiple: true })).toBe("$0.00 · 0R");
    expect(formatTradeLineMetrics({ dollarAmount: -50, rMultiple: null }, { showDollarAmount: true, showRMultiple: true })).toBe("-$50.00 · —");
  });
});
