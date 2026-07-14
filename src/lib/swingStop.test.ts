import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { calculateSwingStop, offsetBeyondSwing } from "./swingStop";

const bar = (low: number, high: number): Bar => ({ time: 0, open: low, high, low, close: high, volume: 1 });
const calculate = (bars: Bar[], patch: Partial<Parameters<typeof calculateSwingStop>[0]> = {}) => calculateSwingStop({
  bars,
  side: "Buy",
  entryPrice: 100,
  minMove: .25,
  pivotBars: 2,
  offsetTicks: 1,
  ...patch,
});

describe("swing stop", () => {
  it("places a long stop below the latest confirmed two-bar swing low", () => {
    expect(calculate([
      bar(96, 101), bar(95, 102), bar(90, 100), bar(94, 103), bar(95, 104), bar(97, 105),
    ])).toBe(89.75);
  });

  it("places a short stop above the latest confirmed swing high", () => {
    expect(calculate([
      bar(95, 101), bar(94, 102), bar(93, 110), bar(94, 104), bar(95, 103), bar(96, 102),
    ], { side: "Sell", entryPrice: 100, offsetTicks: 2 })).toBe(110.5);
  });

  it("supports three-bar pivots", () => {
    expect(calculate([
      bar(98, 101), bar(97, 102), bar(96, 103), bar(90, 104), bar(95, 105), bar(96, 106), bar(97, 107), bar(99, 108),
    ], { pivotBars: 3 })).toBe(89.75);
  });

  it("excludes the unfinished final candle", () => {
    expect(calculate([
      bar(96, 101), bar(95, 102), bar(90, 100), bar(94, 103), bar(95, 104), bar(80, 105),
    ])).toBe(89.75);
  });

  it("rejects equal-price pivot plateaus", () => {
    expect(calculate([
      bar(96, 101), bar(95, 102), bar(90, 100), bar(90, 103), bar(95, 104), bar(96, 105),
    ])).toBeNull();
  });

  it("walks backward when the newest pivot would not create a protective stop", () => {
    expect(calculate([
      bar(90, 101), bar(92, 102), bar(80, 100), bar(93, 103), bar(94, 104),
      bar(101, 105), bar(102, 106), bar(100.5, 104), bar(102, 107), bar(103, 108), bar(104, 109),
    ])).toBe(79.75);
  });

  it("applies configurable offsets and snaps to the minimum tick", () => {
    expect(calculate([
      bar(96, 101), bar(95, 102), bar(90.1, 100), bar(94, 103), bar(95, 104), bar(97, 105),
    ], { minMove: .25, offsetTicks: 3 })).toBe(89.25);
  });

  it("directionally snaps offsets outside off-tick swing prices", () => {
    expect(offsetBeyondSwing(90.1, "Buy", .25, 1)).toBe(89.75);
    expect(offsetBeyondSwing(110.1, "Sell", .25, 1)).toBe(110.5);
  });

  it("moves short stops upward as the offset increases", () => {
    const bars = [
      bar(95, 101), bar(94, 102), bar(93, 110), bar(94, 104), bar(95, 103), bar(96, 102),
    ];
    const oneTick = calculate(bars, { side: "Sell", entryPrice: 100, offsetTicks: 1 });
    const fourTicks = calculate(bars, { side: "Sell", entryPrice: 100, offsetTicks: 4 });
    expect(oneTick).toBe(110.25);
    expect(fourTicks).toBe(111);
    expect(fourTicks!).toBeGreaterThan(oneTick!);
  });

  it("skips a short swing high that is below the entry even if its offset would cross the entry", () => {
    expect(calculate([
      bar(90, 105), bar(91, 106), bar(92, 110), bar(93, 107), bar(94, 106),
      bar(95, 98), bar(94, 99), bar(93, 99.75), bar(94, 99), bar(95, 98), bar(96, 97),
    ], { side: "Sell", entryPrice: 100, offsetTicks: 4 })).toBe(111);
  });

  it("returns null for insufficient history or invalid inputs", () => {
    expect(calculate([bar(90, 100), bar(91, 101), bar(92, 102)])).toBeNull();
    expect(calculate([bar(90, 100), bar(91, 101), bar(89, 99), bar(91, 101), bar(92, 102), bar(93, 103)], { offsetTicks: 0 })).toBeNull();
  });
});
