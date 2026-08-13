import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { didBarCloseOnStreamUpdate, nextBarRolloverRefresh } from "./barRollover";

const bar = (time: number): Bar => ({
  time,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10,
  realtime: true,
});

describe("bar rollover refresh", () => {
  it("does not treat initial history or same-candle updates as a close", () => {
    expect(didBarCloseOnStreamUpdate(undefined, 100, false)).toBe(false);
    expect(didBarCloseOnStreamUpdate(100, 100, true)).toBe(false);
    expect(didBarCloseOnStreamUpdate(100, 101, true)).toBe(true);
  });
  it("refreshes shortly after an intraday candle failed to advance", () => {
    expect(nextBarRolloverRefresh({
      bar: bar(1_000),
      timeframe: "1m",
      nowMilliseconds: 1_062_000,
    })).toEqual({
      barTime: 1_000,
      attempts: 1,
      lastAttemptMilliseconds: 1_062_000,
    });
  });

  it("waits through the boundary and spaces retry attempts", () => {
    expect(nextBarRolloverRefresh({
      bar: bar(1_000),
      timeframe: "1m",
      nowMilliseconds: 1_061_000,
    })).toBeUndefined();
    const state = { barTime: 1_000, attempts: 1, lastAttemptMilliseconds: 1_062_000 };
    expect(nextBarRolloverRefresh({
      bar: bar(1_000),
      timeframe: "1m",
      nowMilliseconds: 1_066_000,
      state,
    })).toBeUndefined();
    expect(nextBarRolloverRefresh({
      bar: bar(1_000),
      timeframe: "1m",
      nowMilliseconds: 1_067_000,
      state,
    })?.attempts).toBe(2);
  });

  it("stops after four attempts", () => {
    expect(nextBarRolloverRefresh({
      bar: bar(1_000),
      timeframe: "1m",
      nowMilliseconds: 1_100_000,
      state: { barTime: 1_000, attempts: 4, lastAttemptMilliseconds: 1_070_000 },
    })).toBeUndefined();
  });

  it("does not poll old session or calendar candles", () => {
    expect(nextBarRolloverRefresh({
      bar: bar(1_000),
      timeframe: "1m",
      nowMilliseconds: 2_000_000,
    })).toBeUndefined();
    expect(nextBarRolloverRefresh({
      bar: bar(86_400),
      timeframe: "D",
      nowMilliseconds: 200_000_000,
    })).toBeUndefined();
  });
});
