import { describe, expect, it } from "vitest";
import type { Bar, SymbolMeta, Timeframe } from "../types";
import { nearestCandleExtreme } from "./crosshair";
import { buildPointAndFigure, buildRenko } from "./priceBasedCharts";
import { DEFAULT_SCHWAB_WICK_FILTER, filterSchwabWicks, normalizeSchwabWickFilter } from "./schwabWickFilter";

const spy = { provider: "schwab", assetType: "ETF" } as const;
const enabled = { enabled: true, maxWickPercent: 0.1 };
const candle = (at = "2026-10-21T17:00:00-04:00", extra: Partial<Bar> = {}): Bar => ({
  time: Date.parse(at) / 1000, open: 770, high: 775, low: 765, close: 770.2, volume: 1234, realtime: false, ...extra,
});

describe("Schwab extended-hours wick filter", () => {
  it("caps both wicks at a percentage beyond the body without changing source data", () => {
    const source = [Object.freeze(candle())];
    Object.freeze(source);
    const result = filterSchwabWicks(source, spy, "5m", enabled);
    expect(result[0].high).toBeCloseTo(770.2 * 1.001, 10);
    expect(result[0].low).toBeCloseTo(770 * 0.999, 10);
    expect(result[0]).toMatchObject({ open: 770, close: 770.2, volume: 1234, time: source[0].time, realtime: false });
    expect(source[0]).toMatchObject({ high: 775, low: 765 });
    expect(filterSchwabWicks(source, spy, "5m", DEFAULT_SCHWAB_WICK_FILTER)).toBe(source);
  });

  it.each([
    { open: 770.2, close: 770 },
    { open: 770, close: 770 },
  ])("preserves bearish and doji bodies: %j", (body) => {
    const result = filterSchwabWicks([candle(undefined, body)], spy, "5m", enabled)[0];
    expect(result.high).toBeCloseTo(Math.max(body.open, body.close) * 1.001, 10);
    expect(result.low).toBeCloseTo(Math.min(body.open, body.close) * 0.999, 10);
  });

  it("preserves candles at or inside the threshold and trims either side independently", () => {
    const boundary = candle(undefined, { high: 770.2 * 1.001, low: 770 * 0.999 });
    expect(filterSchwabWicks([boundary], spy, "5m", enabled)[0]).toBe(boundary);
    const upperOnly = candle(undefined, { low: 769.9 });
    expect(filterSchwabWicks([upperOnly], spy, "5m", enabled)[0].low).toBe(769.9);
    const lowerOnly = candle(undefined, { high: 770.3 });
    expect(filterSchwabWicks([lowerOnly], spy, "5m", enabled)[0].high).toBe(770.3);
  });

  it("keeps large bodies and provides adjustable sensitivity", () => {
    const source = candle(undefined, { open: 760, close: 780, high: 785, low: 755 });
    const strict = filterSchwabWicks([source], spy, "5m", { enabled: true, maxWickPercent: 0.01 })[0];
    const loose = filterSchwabWicks([source], spy, "5m", { enabled: true, maxWickPercent: 1 })[0];
    expect(strict).toMatchObject({ open: 760, close: 780 });
    expect(strict.high).toBeLessThan(loose.high);
    expect(strict.low).toBeGreaterThan(loose.low);
    expect(loose).toBe(source);
  });

  it.each([
    ["2026-10-21T09:25:00-04:00", "5m", true],
    ["2026-10-21T09:30:00-04:00", "5m", false],
    ["2026-10-21T15:55:00-04:00", "5m", false],
    ["2026-10-21T16:00:00-04:00", "5m", true],
    ["2026-10-21T09:00:00-04:00", "1h", false],
    ["2026-10-21T08:00:00-04:00", "4h", false],
    ["2026-10-21T09:28:00-04:00", "7m", false],
    ["2026-10-21T04:00:00-04:00", "4h", true],
    ["2026-10-21T20:00:00-04:00", "4h", true],
    ["2026-10-21T23:00:00-04:00", "1440m", false],
    ["2026-10-23T23:00:00-04:00", "1440m", true],
    ["2026-10-24T10:00:00-04:00", "5m", true],
    ["2026-01-21T14:25:00Z", "5m", true],
    ["2026-01-21T14:30:00Z", "5m", false],
    ["2026-03-09T13:30:00Z", "5m", false],
    ["2026-11-02T14:30:00Z", "5m", false],
    ["2026-03-08T04:30:00Z", "1440m", true],
    ["2026-11-01T03:30:00Z", "1440m", true],
  ] as const)("applies session/DST boundaries at %s (%s)", (at, timeframe, shouldTrim) => {
    const bar = candle(at);
    expect(filterSchwabWicks([bar], spy, timeframe, enabled)[0] !== bar).toBe(shouldTrim);
  });

  it.each(["D", "W", "M"] as Timeframe[])("preserves %s calendar candles", (timeframe) => {
    const source = [candle()];
    expect(filterSchwabWicks(source, spy, timeframe, enabled)).toBe(source);
  });

  it.each([
    { provider: "tradestation", assetType: "FUTURE" },
    { provider: "schwab", assetType: "INDEX" },
    { provider: "schwab", assetType: "OPTION" },
  ] as Pick<SymbolMeta, "provider" | "assetType">[])("preserves excluded instruments: %j", (instrument) => {
    const source = [candle()];
    expect(filterSchwabWicks(source, instrument, "5m", enabled)).toBe(source);
  });

  it("also filters equities and gives historical and live candles identical prices", () => {
    const historical = filterSchwabWicks([candle()], { ...spy, assetType: "EQUITY" }, "5m", enabled)[0];
    const live = filterSchwabWicks([candle(undefined, { realtime: true })], spy, "5m", enabled)[0];
    expect(live).toEqual({ ...historical, realtime: true });
    expect(filterSchwabWicks([], spy, "5m", enabled)).toEqual([]);
    const invalid = candle(undefined, { time: Number.NaN });
    expect(filterSchwabWicks([invalid], spy, "5m", enabled)[0]).toBe(invalid);
  });

  it("supplies consistent extremes to high/low synthetic charts and magnet snapping", () => {
    const start = candle(undefined, { open: 770, high: 770, low: 770, close: 770 });
    const source = [start, candle(undefined, { time: start.time + 300, open: 770, high: 775, low: 765, close: 770 })];
    const filtered = filterSchwabWicks(source, spy, "5m", enabled);
    expect(nearestCandleExtreme(0, 0, 10, filtered[1].high, filtered[1].low)).toBe(filtered[1].high);
    const renko = { brickSizeTicks: 100, reversalBricks: 1, priceSource: "high-low" } as const;
    const pointAndFigure = { boxSizeTicks: 100, reversalBoxes: 1, priceSource: "high-low" } as const;
    expect(buildRenko(source, 0.01, renko).length).toBeGreaterThan(buildRenko(filtered, 0.01, renko).length);
    expect(buildPointAndFigure(source, 0.01, pointAndFigure).length).toBeGreaterThan(buildPointAndFigure(filtered, 0.01, pointAndFigure).length);
  });
});

describe("wick filter settings", () => {
  it("defaults missing/malformed settings, preserves choices, and bounds percentage precision", () => {
    expect(normalizeSchwabWickFilter(undefined)).toEqual(DEFAULT_SCHWAB_WICK_FILTER);
    expect(normalizeSchwabWickFilter({ enabled: "yes", maxWickPercent: Number.NaN })).toEqual(DEFAULT_SCHWAB_WICK_FILTER);
    expect(normalizeSchwabWickFilter(enabled)).toEqual(enabled);
    expect(normalizeSchwabWickFilter({ maxWickPercent: -1 }).maxWickPercent).toBe(0.01);
    expect(normalizeSchwabWickFilter({ maxWickPercent: 99 }).maxWickPercent).toBe(5);
    expect(normalizeSchwabWickFilter({ maxWickPercent: 0.234 }).maxWickPercent).toBe(0.23);
  });
});
