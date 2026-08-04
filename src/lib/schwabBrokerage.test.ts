import { describe, expect, it } from "vitest";
import type { Position } from "../types";
import { applySchwabOptionQuote, combinedCurrencyTotal, heldOptionsForUnderlying, positionMatchesSchwabChart, positionPnlTotal, readableBrokerOrderSymbol } from "./schwabBrokerage";

const equity: Position = { provider: "schwab", id: "e", symbol: "AAPL", assetType: "EQUITY", side: "Long", quantity: 2, averagePrice: 200, last: 210, unrealizedPnl: 20, currentDayPnl: 4 };
const option: Position = { provider: "schwab", id: "o", symbol: "SPY   260807P00630000", assetType: "OPTION", side: "Short", quantity: 1, averagePrice: 5, last: 4, unrealizedPnl: 100, underlying: "SPY", expirationDate: "2026-08-07", strikePrice: 630, putCall: "PUT" };

describe("Schwab brokerage helpers", () => {
  it("keeps missing broker day PnL unavailable", () => {
    expect(positionPnlTotal([option], "currentDayPnl")).toBeUndefined();
    expect(positionPnlTotal([equity, option], "currentDayPnl")).toBe(4);
    expect(positionPnlTotal([equity, option], "unrealizedPnl")).toBe(120);
  });

  it("combines totals only for the same currency", () => {
    expect(combinedCurrencyTotal("USD", 10, "USD", -3)).toBe(7);
    expect(combinedCurrencyTotal("USD", 10, "CAD", 4)).toBeUndefined();
  });

  it("matches equity symbols and option underlyings without crossing providers", () => {
    expect(positionMatchesSchwabChart(equity, "AAPL")).toBe(true);
    expect(positionMatchesSchwabChart(option, "SPY")).toBe(true);
    expect(positionMatchesSchwabChart(option, "AAPL")).toBe(false);
    expect(heldOptionsForUnderlying([equity, option], "spy")).toEqual([option]);
  });

  it("totals every option leg for the requested underlying only", () => {
    const call: Position = { ...option, id: "call", side: "Long", putCall: "CALL", expirationDate: "2026-08-07", strikePrice: 632, unrealizedPnl: 125 };
    const laterPut: Position = { ...option, id: "later-put", assetType: "INDEX_OPTION", expirationDate: "2026-08-21", strikePrice: 625, unrealizedPnl: -40 };
    const otherUnderlying: Position = { ...option, id: "qqq-put", symbol: "QQQ   260807P00500000", underlying: "QQQ", unrealizedPnl: 60 };
    const otherProvider: Position = { ...call, provider: "tradestation", id: "ts-call", unrealizedPnl: 90 };
    const matching = heldOptionsForUnderlying([equity, call, laterPut, otherUnderlying, otherProvider], " spy ");

    expect(matching).toEqual([call, laterPut]);
    expect(positionPnlTotal(matching, "unrealizedPnl")).toBe(85);
    expect(positionPnlTotal([{ ...call, unrealizedPnl: -25 }, laterPut], "unrealizedPnl")).toBe(-65);
    expect(positionPnlTotal([{ ...call, unrealizedPnl: 40 }, laterPut], "unrealizedPnl")).toBe(0);
    expect(heldOptionsForUnderlying([equity, otherUnderlying, otherProvider], "SPY")).toEqual([]);
    expect(positionPnlTotal([], "unrealizedPnl")).toBe(0);
  });

  it("updates the underlying total when a live option quote reprices one leg", () => {
    const call: Position = { ...option, id: "call", side: "Long", putCall: "CALL", unrealizedPnl: 125 };
    const otherLeg: Position = { ...option, id: "other-leg", symbol: "SPY   260821P00625000", expirationDate: "2026-08-21", strikePrice: 625, unrealizedPnl: -40 };
    const before = heldOptionsForUnderlying([call, otherLeg], "SPY");
    const after = applySchwabOptionQuote(before, { symbol: call.symbol, markPrice: 7, bidPrice: 6.9, askPrice: 7.1, multiplier: 100 });

    expect(positionPnlTotal(before, "unrealizedPnl")).toBe(85);
    expect(positionPnlTotal(after, "unrealizedPnl")).toBe(160);
    expect(after[0]).toMatchObject({ last: 7, bid: 6.9, ask: 7.1, unrealizedPnl: 200 });
    expect(after[1]).toBe(otherLeg);
  });

  it("renders OCC option order symbols as readable contracts", () => {
    expect(readableBrokerOrderSymbol({ symbol: "SPY   260803C00752000", assetType: "OPTION" })).toBe("SPY 08/03/26 752 C");
    expect(readableBrokerOrderSymbol({ symbol: "AAPL", assetType: "EQUITY" })).toBe("AAPL");
  });
});
