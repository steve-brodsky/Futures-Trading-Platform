import { describe, expect, it } from "vitest";
import type { ChartTabState, Position, SymbolMeta } from "../types";
import { defaultEma200Alert } from "./emaAlerts";
import { defaultPointAndFigureSettings, defaultRenkoSettings } from "./priceBasedCharts";
import { canAddWatchlistSymbol, formatContractExpiration, hasOpenFuturesPosition, isContinuousFuture, quoteSubscriptionInstruments, resolveTradeSymbol } from "./futuresContracts";

const continuous: SymbolMeta = { provider: "tradestation", symbol: "@MES", root: "MES", underlying: "MESU26", description: "Continuous MES", exchange: "CME", assetType: "FUTURE", minMove: .25, pointValue: 5 };
const instrument = (symbol: string): SymbolMeta => ({ ...continuous, symbol, root: undefined, underlying: undefined });
const tab = (symbol: SymbolMeta, tradeContract?: string): ChartTabState => ({ id: symbol.symbol, symbol, tradeContract, timeframe: "1m", chartKind: "candles", renkoSettings: defaultRenkoSettings(), pointAndFigureSettings: defaultPointAndFigureSettings(), indicators: [], ema200Alert: defaultEma200Alert(), chartTimezone: "exchange", magnetEnabled: false, gex: { enabled: false, view: "net" } });
const position = (symbol: string, quantity = 1): Position => ({ id: symbol, symbol, side: "Long", quantity, averagePrice: 100, last: 101, unrealizedPnl: 1 });

describe("futures trade-contract resolution", () => {
  it("uses concrete chart symbols directly", () => {
    const concrete = { ...continuous, symbol: "MESU26", underlying: undefined };
    expect(isContinuousFuture(concrete)).toBe(false);
    expect(resolveTradeSymbol(tab(concrete))).toBe("MESU26");
  });

  it("uses Underlying for Auto and preserves a manual override", () => {
    expect(resolveTradeSymbol(tab(continuous))).toBe("MESU26");
    expect(resolveTradeSymbol(tab({ ...continuous, underlying: "MESH27" }))).toBe("MESH27");
    expect(resolveTradeSymbol(tab(continuous, "MESZ26"))).toBe("MESZ26");
    expect(resolveTradeSymbol(tab({ ...continuous, underlying: "MESH27" }, "MESZ26"))).toBe("MESZ26");
  });

  it("does not guess when TradeStation omits the underlying", () => {
    expect(resolveTradeSymbol(tab({ ...continuous, underlying: undefined }))).toBeUndefined();
  });

  it("never exposes Schwab equities to the TradeStation order path", () => {
    const equity: SymbolMeta = { provider: "schwab", symbol: "AAPL", description: "Apple", exchange: "NASDAQ", assetType: "EQUITY", minMove: 0.01, pointValue: 1 };
    expect(resolveTradeSymbol(tab(equity))).toBeUndefined();
    expect(hasOpenFuturesPosition(equity, [position("AAPL")])).toBe(false);
  });

  it("matches open positions across every contract in a continuous futures family", () => {
    expect(hasOpenFuturesPosition(continuous, [position(" mesz26 ")])).toBe(true);
    expect(hasOpenFuturesPosition(continuous, [position("MESU26")])).toBe(true);
  });

  it("derives concrete roots and ignores other families and flat positions", () => {
    const concrete = { ...continuous, symbol: "MESU26", root: undefined, underlying: undefined };
    expect(hasOpenFuturesPosition(concrete, [position("MESZ26")])).toBe(true);
    expect(hasOpenFuturesPosition(concrete, [position("MNQU26")])).toBe(false);
    expect(hasOpenFuturesPosition(concrete, [position("MESZ26", 0)])).toBe(false);
  });

  it("deduplicates chart, watchlist, and resolved trade quote subscriptions", () => {
    expect(quoteSubscriptionInstruments({
      watchlist: [instrument("MESU26"), instrument("MNQU26")],
      tabs: [tab(continuous), tab({ ...continuous, symbol: "MNQU26", root: "MNQ", underlying: undefined })],
    }).map((item) => item.symbol)).toEqual(["@MES", "MESU26", "MNQU26"]);
  });

  it("allows watchlist additions only while the shared quote stream has capacity", () => {
    const fullWatchlist = Array.from({ length: 98 }, (_, index) => instrument(`Q${index}`));
    const workspace = { watchlist: fullWatchlist, tabs: [tab(continuous)] };
    expect(quoteSubscriptionInstruments(workspace)).toHaveLength(100);
    expect(canAddWatchlistSymbol(workspace, instrument("NEW"))).toBe(false);
    expect(canAddWatchlistSymbol(workspace, instrument("Q0"))).toBe(true);
    expect(canAddWatchlistSymbol({ ...workspace, watchlist: fullWatchlist.slice(0, -1) }, instrument("NEW"))).toBe(true);
  });

  it("formats TradeStation Microsoft JSON and ISO expiration dates", () => {
    expect(formatContractExpiration("/Date(1789704000000)/")).toBe("Sep 2026");
    expect(formatContractExpiration("/Date(1789704000000-0700)/")).toBe("Sep 2026");
    expect(formatContractExpiration("2027-03-19")).toBe("Mar 2027");
    expect(formatContractExpiration("not-a-date")).toBe("not-a-date");
    expect(formatContractExpiration()).toBe("Expiration unavailable");
  });
});
