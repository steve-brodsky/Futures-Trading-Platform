import { describe, expect, it } from "vitest";
import type { OrderUpdate, Position } from "../types";
import { buildProjectedTradeLines, buildTradeLineMetrics, buildTradeLines, flattenOrderDraft, formatTradeLineMetrics, isPositionExit, snapTradeLinePrice, tradeLinePriceChanged, withOrderPrice } from "./tradeLines";

const position: Position = { id: "p1", symbol: "MES", side: "Long", quantity: 2, averagePrice: 6250, last: 6251, unrealizedPnl: 10 };
const baseOrder: OrderUpdate = { id: "o1", symbol: "MES", side: "Sell", type: "Limit", quantity: 2, price: 6260, status: "Working", timestamp: "", openOrClose: "Close", groupName: "OCO 1" };

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
    const longMetrics = buildTradeLineMetrics(longLines, 5);
    expect(longMetrics.get("position:p1")).toEqual({ dollarAmount: 60, rMultiple: 1.2 });
    expect(longMetrics.get("order:o1")).toEqual({ dollarAmount: 100, rMultiple: 2 });
    expect(longMetrics.get("order:o2")).toEqual({ dollarAmount: -50, rMultiple: -1 });

    const shortPosition = { ...longPosition, side: "Short" as const };
    const shortLines = buildTradeLines("MES", [shortPosition], [
      { ...baseOrder, side: "Buy", price: 90 },
      { ...baseOrder, id: "o2", side: "Buy", type: "StopMarket", price: undefined, stopPrice: 105 },
    ]);
    const shortMetrics = buildTradeLineMetrics(shortLines, 5);
    expect(shortMetrics.get("order:o1")).toEqual({ dollarAmount: 100, rMultiple: 2 });
    expect(shortMetrics.get("order:o2")).toEqual({ dollarAmount: -50, rMultiple: -1 });
  });

  it("uses the live quote for position metrics while leaving exit projections unchanged", () => {
    const tradePosition = { ...position, averagePrice: 100, unrealizedPnl: 5 };
    const lines = buildTradeLines("MES", [tradePosition], [
      { ...baseOrder, price: 110 },
      { ...baseOrder, id: "o2", type: "StopMarket", price: undefined, stopPrice: 95 },
    ]);
    const metrics = buildTradeLineMetrics(lines, 5, 102.5);
    expect(metrics.get("position:p1")).toEqual({ dollarAmount: 25, rMultiple: .5 });
    expect(metrics.get("order:o1")).toEqual({ dollarAmount: 100, rMultiple: 2 });
    expect(metrics.get("order:o2")).toEqual({ dollarAmount: -50, rMultiple: -1 });
  });

  it("uses the nearest valid stop as the risk baseline", () => {
    const tradePosition = { ...position, averagePrice: 100 };
    const lines = buildTradeLines("MES", [tradePosition], [
      { ...baseOrder, id: "near", type: "StopMarket", price: undefined, stopPrice: 95 },
      { ...baseOrder, id: "far", type: "StopMarket", price: undefined, stopPrice: 90 },
    ]);
    const metrics = buildTradeLineMetrics(lines, 5);
    expect(metrics.get("order:near")?.rMultiple).toBe(-1);
    expect(metrics.get("order:far")?.rMultiple).toBe(-2);
  });

  it("keeps dollars without an R baseline and ignores projected lines", () => {
    const tradePosition = { ...position, averagePrice: 100, unrealizedPnl: 25 };
    const lines = [
      ...buildTradeLines("MES", [tradePosition], [{ ...baseOrder, price: 110 }]),
      ...buildProjectedTradeLines({ takeProfit: 112, stopLoss: 94 }),
    ];
    const metrics = buildTradeLineMetrics(lines, 5);
    expect(metrics.get("position:p1")).toEqual({ dollarAmount: 25, rMultiple: null });
    expect(metrics.get("order:o1")).toEqual({ dollarAmount: 100, rMultiple: null });
    expect(metrics.has("projection:take-profit")).toBe(false);
    expect(metrics.has("projection:stop-loss")).toBe(false);
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
