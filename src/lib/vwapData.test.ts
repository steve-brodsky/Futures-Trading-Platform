import { describe, expect, it } from "vitest";
import type { ChartTabState } from "../types";
import { defaultEma200Alert } from "./emaAlerts";
import { chunkVwapRange, expandedVwapRange, mergeEpochRanges, missingEpochRanges, nySessionVwapSymbols } from "./vwapData";

const tab = (id: string, symbol: string, timeframe: ChartTabState["timeframe"], visible = true): ChartTabState => ({
  id,
  symbol: { symbol, description: symbol, exchange: "CME", assetType: "Future", minMove: 0.25, pointValue: 5 },
  timeframe,
  chartKind: "candles",
  indicators: [{ id: "vwap", kind: "VWAP", period: 1, color: "#a879ff", visible }],
  ema200Alert: defaultEma200Alert(),
  chartTimezone: "exchange",
  magnetEnabled: false,
});

describe("VWAP data orchestration", () => {
  it("deduplicates enabled intraday symbols and ignores calendar charts", () => {
    expect(nySessionVwapSymbols([
      tab("one", "@MES", "1m"), tab("two", "@MES", "4h"), tab("three", "@NQ", "D"), tab("four", "@CL", "30m", false),
    ])).toEqual(["@MES"]);
  });

  it("merges coverage and returns only uncovered intervals", () => {
    expect(mergeEpochRanges([{ first: 20, last: 30 }, { first: 10, last: 20 }, { first: 40, last: 50 }])).toEqual([
      { first: 10, last: 30 }, { first: 40, last: 50 },
    ]);
    expect(missingEpochRanges(0, 60, [{ first: 10, last: 30 }, { first: 40, last: 50 }])).toEqual([
      { first: 0, last: 10 }, { first: 30, last: 40 }, { first: 50, last: 60 },
    ]);
  });

  it("expands viewport requests and keeps chunks below the minute-bar limit", () => {
    const range = expandedVwapRange(10 * 86_400 + 100, 50 * 86_400 + 100);
    const chunks = chunkVwapRange(range);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.last - chunk.first <= 30 * 86_400)).toBe(true);
    expect(chunks[0].first).toBeLessThan(10 * 86_400 + 100);
    expect(chunks.at(-1)!.last).toBeGreaterThan(50 * 86_400 + 100);
  });
});
