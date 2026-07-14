import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { mergeBars } from "./barData";

const bar = (time: number, close = time): Bar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  realtime: false,
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
