import { describe, expect, it } from "vitest";
import { MAX_RECENT_SYMBOLS, MAX_STREAMED_QUOTE_SYMBOLS, normalizeRecentSymbols, normalizeWatchlist, rememberRecentSymbol, reorderWatchlist } from "./watchlist";

const instrument = (symbol: string) => ({ provider: "tradestation" as const, symbol, description: symbol, exchange: "CME", assetType: "FUTURE", minMove: 0.25, pointValue: 5 });

describe("watchlist helpers", () => {
  it("normalizes symbols while preserving the user's first-seen order", () => {
    expect(normalizeWatchlist([" mesu26 ", "MNQu26", "MESU26", "", null, 42]).map((item) => item.symbol)).toEqual(["MESU26", "MNQU26"]);
  });

  it("keeps subscribed duplicates without spending capacity and prunes excess symbols", () => {
    const subscribed = Array.from({ length: MAX_STREAMED_QUOTE_SYMBOLS - 1 }, (_, index) => instrument(`BASE${index}`));
    expect(normalizeWatchlist(["base0", "EXTRA1", "EXTRA2"], subscribed).map((item) => item.symbol)).toEqual(["BASE0", "EXTRA1"]);
  });

  it("reorders stably and ignores invalid moves", () => {
    const symbols = [instrument("MESU26"), instrument("MNQU26"), instrument("MCLU26")];
    expect(reorderWatchlist(symbols, 0, 2).map((item) => item.symbol)).toEqual(["MNQU26", "MCLU26", "MESU26"]);
    expect(reorderWatchlist(symbols, 1, 1)).toBe(symbols);
    expect(reorderWatchlist(symbols, -1, 1)).toBe(symbols);
  });

  it("keeps recent instruments newest-first, provider-aware, deduplicated, and capped", () => {
    const spy = { ...instrument("SPY"), provider: "schwab" as const, assetType: "ETF", exchange: "NYSE ARCA" };
    const recent = Array.from({ length: MAX_RECENT_SYMBOLS }, (_, index) => instrument(`OLD${index}`));
    const updated = rememberRecentSymbol([instrument("MESU26"), spy, ...recent], spy);
    expect(updated[0]).toEqual(spy);
    expect(updated.filter((item) => item.provider === "schwab" && item.symbol === "SPY")).toHaveLength(1);
    expect(updated).toHaveLength(MAX_RECENT_SYMBOLS);
  });

  it("migrates provider-less ETF recent entries to Schwab", () => {
    expect(normalizeRecentSymbols([{ symbol: "spy", assetType: "ETF" }])[0]).toMatchObject({ provider: "schwab", symbol: "SPY" });
  });
});
