import { describe, expect, it } from "vitest";
import { MAX_STREAMED_QUOTE_SYMBOLS, normalizeWatchlist, reorderWatchlist } from "./watchlist";

describe("watchlist helpers", () => {
  it("normalizes symbols while preserving the user's first-seen order", () => {
    expect(normalizeWatchlist([" mesu26 ", "MNQu26", "MESU26", "", null, 42])).toEqual(["MESU26", "MNQU26"]);
  });

  it("keeps subscribed duplicates without spending capacity and prunes excess symbols", () => {
    const subscribed = Array.from({ length: MAX_STREAMED_QUOTE_SYMBOLS - 1 }, (_, index) => `BASE${index}`);
    expect(normalizeWatchlist(["base0", "EXTRA1", "EXTRA2"], subscribed)).toEqual(["BASE0", "EXTRA1"]);
  });

  it("reorders stably and ignores invalid moves", () => {
    const symbols = ["MESU26", "MNQU26", "MCLU26"];
    expect(reorderWatchlist(symbols, 0, 2)).toEqual(["MNQU26", "MCLU26", "MESU26"]);
    expect(reorderWatchlist(symbols, 1, 1)).toBe(symbols);
    expect(reorderWatchlist(symbols, -1, 1)).toBe(symbols);
  });
});
