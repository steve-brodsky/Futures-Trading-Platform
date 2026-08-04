import { describe, expect, it } from "vitest";
import type { Position } from "../types";
import { combinedCurrencyTotal, heldOptionsForUnderlying, positionMatchesSchwabChart, positionPnlTotal, readableBrokerOrderSymbol } from "./schwabBrokerage";

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

  it("renders OCC option order symbols as readable contracts", () => {
    expect(readableBrokerOrderSymbol({ symbol: "SPY   260803C00752000", assetType: "OPTION" })).toBe("SPY 08/03/26 752 C");
    expect(readableBrokerOrderSymbol({ symbol: "AAPL", assetType: "EQUITY" })).toBe("AAPL");
  });
});
