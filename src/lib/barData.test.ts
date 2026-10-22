import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { canUpdateLastBar, mergeBars } from "./barData";

const bar = (time: number, close = time): Bar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  realtime: false,
});

describe("incremental chart updates", () => {
  it("allows a last-candle update or a new candle when earlier candles are unchanged", () => {
    expect(canUpdateLastBar([bar(1), bar(2)], [bar(1), bar(2, 20)])).toBe(true);
    expect(canUpdateLastBar([bar(1), bar(2)], [bar(1), bar(2), bar(3)])).toBe(true);
  });

  it("requires a full redraw for historical corrections and filter changes", () => {
    const previous = [bar(1), bar(2), bar(3)];
    expect(canUpdateLastBar(previous, [{ ...bar(1), high: 20 }, bar(2), bar(3)])).toBe(false);
    expect(canUpdateLastBar(previous, [bar(1), { ...bar(2), low: 0 }, bar(3)])).toBe(false);
    expect(canUpdateLastBar(previous, [bar(1), bar(2), { ...bar(3), volume: 100 }, bar(4)])).toBe(false);
  });

  it("requires a full redraw for initial data, backfill, removals, and replaced timestamps", () => {
    expect(canUpdateLastBar([], [bar(1)])).toBe(false);
    expect(canUpdateLastBar([bar(2)], [bar(1), bar(2)])).toBe(false);
    expect(canUpdateLastBar([bar(1), bar(2)], [bar(1)])).toBe(false);
    expect(canUpdateLastBar([bar(1), bar(2)], [bar(1), bar(3)])).toBe(false);
  });
});

describe("mergeBars", () => {
  it("preserves historical candles when a reconnect snapshot contains only the gap", () => {
    expect(mergeBars([bar(1), bar(2), bar(3)], [bar(3, 30), bar(4)]))
      .toEqual([bar(1), bar(2), bar(3, 30), bar(4)]);
  });

  it("sorts out-of-order snapshots and replaces matching timestamps", () => {
    expect(mergeBars([bar(2), bar(1)], [bar(2, 20)]))
      .toEqual([bar(1), bar(2, 20)]);
  });
});
