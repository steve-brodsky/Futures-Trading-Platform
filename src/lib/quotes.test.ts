import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { previousSessionClose, quoteDayChangePercent } from "./quotes";

describe("quote day change percentage", () => {
  it("prefers the price-derived percentage over a supplied provider percentage", () => {
    expect(quoteDayChangePercent({ last: 105, change: 5, changePct: 4.95 })).toBeCloseTo(5);
    expect(quoteDayChangePercent({ last: 105, change: 0, changePct: 0.0005 }, 100)).toBeCloseTo(5);
  });

  it("uses the provider percentage only when no price reference is available", () => {
    expect(quoteDayChangePercent({ last: 105, change: 0, changePct: 4.95 })).toBe(4.95);
  });

  it("calculates from last and net change when the provider percentage is missing", () => {
    expect(quoteDayChangePercent({ last: 105, change: 5, changePct: 0 })).toBeCloseTo(5);
    expect(quoteDayChangePercent({ last: 95, change: -5, changePct: 0 })).toBeCloseTo(-5);
  });

  it("calculates from a session reference when TradeStation zeros both change fields", () => {
    expect(quoteDayChangePercent({ last: 105, change: 0, changePct: 0 }, 100)).toBeCloseTo(5);
    expect(quoteDayChangePercent({ last: 95, change: 0, changePct: 0 }, 100)).toBeCloseTo(-5);
  });

  it("normalizes unchanged and invalid reference prices to zero", () => {
    expect(quoteDayChangePercent({ last: 100, change: 0, changePct: 0 })).toBe(0);
    expect(quoteDayChangePercent({ last: 5, change: 5, changePct: 0 })).toBe(0);
  });
});

describe("previous session close", () => {
  const bar = (time: number, close: number, realtime = false): Bar => ({ time, open: close, high: close, low: close, close, volume: 1, realtime });

  it("uses the close before the latest intraday session break", () => {
    const bars = [bar(0, 100), bar(300, 101), bar(7_500, 102), bar(7_800, 103)];
    expect(previousSessionClose(bars, "5m")).toBe(101);
  });

  it("uses the prior daily bar while the latest daily bar is realtime", () => {
    expect(previousSessionClose([bar(0, 100), bar(86_400, 104, true)], "D")).toBe(100);
    expect(previousSessionClose([bar(0, 100)], "D")).toBe(100);
  });

  it("does not mistake ordinary intraday spacing for a session break", () => {
    expect(previousSessionClose([bar(0, 100), bar(300, 101), bar(600, 102)], "5m")).toBeUndefined();
  });
});
