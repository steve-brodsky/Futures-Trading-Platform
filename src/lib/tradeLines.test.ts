import { describe, expect, it } from "vitest";
import type { OrderUpdate, Position } from "../types";
import { buildTradeLines, flattenOrderDraft, isPositionExit, snapTradeLinePrice, tradeLinePriceChanged, withOrderPrice } from "./tradeLines";

const position: Position = { id: "p1", symbol: "MES", side: "Long", quantity: 2, averagePrice: 6250, last: 6251, unrealizedPnl: 10 };
const baseOrder: OrderUpdate = { id: "o1", symbol: "MES", side: "Sell", type: "Limit", quantity: 2, price: 6260, status: "Working", timestamp: "", openOrClose: "Close", groupName: "OCO 1" };

describe("chart trade lines", () => {
  it("classifies positions and bracket exits", () => {
    const lines = buildTradeLines("MES", [position], [baseOrder, { ...baseOrder, id: "o2", type: "StopMarket", price: undefined, stopPrice: 6240 }]);
    expect(lines.map((line) => [line.kind, line.draggable, line.color])).toEqual([
      ["position", false, "#37d5e8"],
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
    expect(line).toMatchObject({ kind: "position", side: "Short", quantity: 2 });
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
});
