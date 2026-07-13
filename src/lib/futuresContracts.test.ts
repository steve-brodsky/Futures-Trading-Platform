import { describe, expect, it } from "vitest";
import type { ChartTabState, SymbolMeta } from "../types";
import { formatContractExpiration, isContinuousFuture, quoteSubscriptionSymbols, resolveTradeSymbol } from "./futuresContracts";

const continuous: SymbolMeta = { symbol: "@MES", root: "MES", underlying: "MESU26", description: "Continuous MES", exchange: "CME", assetType: "FUTURE", minMove: .25, pointValue: 5 };
const tab = (symbol: SymbolMeta, tradeContract?: string): ChartTabState => ({ id: symbol.symbol, symbol, tradeContract, timeframe: "1m", chartKind: "candles", indicators: [], chartTimezone: "exchange", magnetEnabled: false });

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

  it("deduplicates chart, watchlist, and resolved trade quote subscriptions", () => {
    expect(quoteSubscriptionSymbols({
      watchlist: ["MESU26", "MNQU26"],
      tabs: [tab(continuous), tab({ ...continuous, symbol: "MNQU26", root: "MNQ", underlying: undefined })],
    })).toEqual(["@MES", "MESU26", "MNQU26"]);
  });

  it("formats TradeStation Microsoft JSON and ISO expiration dates", () => {
    expect(formatContractExpiration("/Date(1789704000000)/")).toBe("Sep 2026");
    expect(formatContractExpiration("/Date(1789704000000-0700)/")).toBe("Sep 2026");
    expect(formatContractExpiration("2027-03-19")).toBe("Mar 2027");
    expect(formatContractExpiration("not-a-date")).toBe("not-a-date");
    expect(formatContractExpiration()).toBe("Expiration unavailable");
  });
});
