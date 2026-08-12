import { describe, expect, it } from "vitest";
import type { Bar, FailedBreakoutIndicatorConfig } from "../types";
import { findFailedBreakouts } from "./failedBreakout";

const defaults: FailedBreakoutIndicatorConfig = {
  id: "failed-breakout",
  kind: "FAILED_BREAKOUT",
  visible: true,
  pivotBars: 1,
  toleranceTicks: 4,
  reclaimBars: 3,
  pairMode: "consecutive",
};

function bar(time: number, low: number, high: number, close = (low + high) / 2, realtime = false): Bar {
  return { time, open: close, high, low, close, volume: 1, realtime };
}

function longSetup(secondLow = 100): Bar[] {
  return [
    bar(1, 103, 109),
    bar(2, 100, 106),
    bar(3, 103, 109),
    bar(4, 104, 110),
    bar(5, secondLow, 106),
    bar(6, 103, 109),
  ];
}

function shortSetup(secondHigh = 110): Bar[] {
  return [
    bar(1, 101, 107),
    bar(2, 104, 110),
    bar(3, 101, 107),
    bar(4, 100, 106),
    bar(5, 104, secondHigh),
    bar(6, 101, 107),
  ];
}

describe("findFailedBreakouts", () => {
  it("finds mirrored same-candle long and short entries and returns their source swings", () => {
    const long = findFailedBreakouts([...longSetup(), bar(7, 99, 108, 101)], 0.25, defaults);
    expect(long).toHaveLength(1);
    expect(long[0]).toMatchObject({ side: "long", time: 7, entryTime: 7, breakTime: 7 });
    expect(long[0].swings).toEqual([{ time: 2, price: 100 }, { time: 5, price: 100 }]);
    expect(long[0].id).toBe("failed-breakout:long:2:5:7:7");

    const short = findFailedBreakouts([...shortSetup(), bar(7, 102, 111, 109)], 0.25, defaults);
    expect(short).toHaveLength(1);
    expect(short[0]).toMatchObject({ side: "short", time: 7, entryTime: 7, breakTime: 7 });
    expect(short[0].swings).toEqual([{ time: 2, price: 110 }, { time: 5, price: 110 }]);
  });

  it("accepts swings exactly at tolerance and rejects swings just outside it", () => {
    expect(findFailedBreakouts([...longSetup(101), bar(7, 99, 108, 102)], 0.25, defaults)).toHaveLength(1);
    expect(findFailedBreakouts([...longSetup(101.25), bar(7, 99, 108, 102)], 0.25, defaults)).toHaveLength(0);
  });

  it("allows zero-tick exact matches only", () => {
    const exact = { ...defaults, toleranceTicks: 0 };
    expect(findFailedBreakouts([...longSetup(), bar(7, 99, 108, 101)], 0.25, exact)).toHaveLength(1);
    expect(findFailedBreakouts([...longSetup(100.25), bar(7, 99, 108, 101)], 0.25, exact)).toHaveLength(0);
  });

  it("requires strict clearance of both levels for the break and reclaim", () => {
    const setup = longSetup(101);
    expect(findFailedBreakouts([...setup, bar(7, 100, 108, 102)], 0.25, defaults)).toHaveLength(0);
    expect(findFailedBreakouts([...setup, bar(7, 99.75, 108, 101)], 0.25, defaults)).toHaveLength(0);
    expect(findFailedBreakouts([...setup, bar(7, 99.75, 108, 101.25)], 0.25, defaults)).toHaveLength(1);
  });

  it("supports a delayed reclaim and expires after the configured inclusive window", () => {
    const setup = longSetup();
    const delayed = [...setup, bar(7, 99, 106, 99.5), bar(8, 99.25, 106, 100), bar(9, 100, 108, 101)];
    expect(findFailedBreakouts(delayed, 0.25, defaults)[0]).toMatchObject({ side: "long", breakTime: 7, entryTime: 9 });

    const expired = [...setup, bar(7, 99, 106, 99.5), bar(8, 98.5, 106, 99.75), bar(9, 98, 106, 99.75), bar(10, 100, 108, 101)];
    expect(findFailedBreakouts(expired, 0.25, defaults)).toHaveLength(0);
  });

  it("does not restart an active reclaim window when price makes a newer extreme", () => {
    const setup = longSetup();
    const bars = [...setup, bar(7, 99, 106, 99.5), bar(8, 98, 106, 99), bar(9, 97, 106, 99), bar(10, 100, 108, 101)];
    expect(findFailedBreakouts(bars, 0.25, defaults)).toHaveLength(0);
  });

  it("rejects equal-price pivot plateaus and honors all three pivot strengths", () => {
    const plateau = [bar(1, 103, 109), bar(2, 100, 106), bar(3, 100, 109), bar(4, 104, 110), bar(5, 100, 106), bar(6, 103, 109), bar(7, 99, 108, 101)];
    expect(findFailedBreakouts(plateau, 0.25, defaults)).toHaveLength(0);

    for (const pivotBars of [1, 2, 3] as const) {
      const bars: Bar[] = [];
      const firstIndex = pivotBars;
      const secondIndex = firstIndex + pivotBars * 2 + 1;
      const triggerIndex = secondIndex + pivotBars + 1;
      for (let index = 0; index <= triggerIndex; index += 1) bars.push(bar(index + 1, 104, 110));
      bars[firstIndex] = bar(firstIndex + 1, 100, 106);
      bars[secondIndex] = bar(secondIndex + 1, 100, 106);
      bars[triggerIndex] = bar(triggerIndex + 1, 99, 108, 101);
      expect(findFailedBreakouts(bars, 0.25, { ...defaults, pivotBars }).map((signal) => signal.side)).toContain("long");
    }
  });

  it("does not let the candle that confirms a pivot break that newly confirmed pair", () => {
    const bars = longSetup();
    bars[5] = bar(6, 99, 109, 101);
    expect(findFailedBreakouts(bars, 0.25, defaults)).toHaveLength(0);
  });

  it("uses only consecutive pivots in consecutive mode", () => {
    const bars = [
      bar(1, 104, 110), bar(2, 100, 106), bar(3, 104, 110),
      bar(4, 104, 110), bar(5, 95, 101), bar(6, 104, 110),
      bar(7, 104, 110), bar(8, 100.5, 106), bar(9, 104, 110),
      bar(10, 99, 108, 101),
    ];
    expect(findFailedBreakouts(bars, 0.25, defaults)).toHaveLength(0);
    expect(findFailedBreakouts(bars, 0.25, { ...defaults, pairMode: "latest-matching" })).toHaveLength(1);
  });

  it("retains the current pair after an unmatched pivot in latest-matching mode", () => {
    const bars = [
      ...longSetup(),
      bar(7, 104, 110), bar(8, 95, 101), bar(9, 104, 110),
      bar(10, 99, 108, 101),
    ];
    expect(findFailedBreakouts(bars, 0.25, { ...defaults, pairMode: "latest-matching" })).toHaveLength(1);
  });

  it("consumes a pair after one signal", () => {
    const bars = [...longSetup(), bar(7, 99, 108, 101), bar(8, 104, 110), bar(9, 99, 108, 101)];
    expect(findFailedBreakouts(bars, 0.25, defaults).filter((signal) => signal.side === "long")).toHaveLength(1);
  });

  it("locks an active attempt while retaining a newer eligible pair for future candles", () => {
    const bars = [
      ...longSetup(),
      bar(7, 98, 106, 99),
      bar(8, 99.5, 106, 99.75), bar(9, 99, 106, 99.25), bar(10, 99.5, 106, 99.75),
      bar(11, 97.5, 108, 99.5),
    ];
    const signals = findFailedBreakouts(bars, 0.25, { ...defaults, reclaimBars: 3 });
    expect(signals.filter((signal) => signal.side === "long")).toHaveLength(1);
    expect(signals[0].swings[1].time).toBe(9);
    expect(signals[0].entryTime).toBe(11);
  });

  it("can report independent long and short entries on the same candle", () => {
    const bars = [
      bar(1, 103, 107), bar(2, 100, 110), bar(3, 103, 107),
      bar(4, 104, 106), bar(5, 100, 110), bar(6, 103, 107),
      bar(7, 99, 111, 105),
    ];
    expect(findFailedBreakouts(bars, 0.25, defaults).map((signal) => signal.side)).toEqual(["long", "short"]);
  });

  it("excludes only a forming newest bar and admits the prior streamed bar after rollover", () => {
    const forming = [...longSetup(), bar(7, 99, 108, 101, true)];
    expect(findFailedBreakouts(forming, 0.25, defaults)).toHaveLength(0);
    const rolled = [...forming, bar(8, 103, 109, 104, true)];
    expect(findFailedBreakouts(rolled, 0.25, defaults)).toHaveLength(1);
  });

  it("recalculates deterministically when older history is prepended", () => {
    const full = [...longSetup(), bar(7, 99, 108, 101)];
    expect(findFailedBreakouts(full.slice(3), 0.25, defaults)).toEqual([]);
    expect(findFailedBreakouts(full, 0.25, defaults)).toEqual(findFailedBreakouts([...full], 0.25, defaults));
  });

  it("sanitizes settings and rejects an invalid tick size", () => {
    const bars = [...longSetup(), bar(7, 99, 108, 101)];
    expect(findFailedBreakouts(bars, 0, defaults)).toEqual([]);
    expect(findFailedBreakouts(bars, 0.25, { ...defaults, pivotBars: 99 as 1, toleranceTicks: -10, reclaimBars: 0 })).toEqual([]);
  });
});
