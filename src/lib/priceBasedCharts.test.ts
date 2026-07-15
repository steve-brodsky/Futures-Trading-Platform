import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { buildPointAndFigure, buildRenko, normalizePointAndFigureSettings, normalizeRenkoSettings } from "./priceBasedCharts";

const bars = (...closes: number[]): Bar[] => closes.map((close, index) => ({
  time: 1_000 + index * 60,
  open: index ? closes[index - 1] : close,
  high: Math.max(index ? closes[index - 1] : close, close),
  low: Math.min(index ? closes[index - 1] : close, close),
  close,
  volume: 1,
  realtime: false,
}));

describe("price-based charts", () => {
  it("normalizes settings and clamps persisted values", () => {
    expect(normalizeRenkoSettings({ brickSizeTicks: 0, priceSource: "high-low", reversalBricks: 1 })).toEqual({ brickSizeTicks: 1, priceSource: "high-low", reversalBricks: 1 });
    expect(normalizePointAndFigureSettings({ boxSizeTicks: 99_999, reversalBoxes: 20 })).toEqual({ boxSizeTicks: 10_000, priceSource: "close", reversalBoxes: 10 });
  });

  it("creates multiple renko bricks at exact tick thresholds", () => {
    const result = buildRenko(bars(100, 103), 1, { brickSizeTicks: 1, reversalBricks: 2 });
    expect(result.map(({ open, close }) => [open, close])).toEqual([[100, 101], [101, 102], [102, 103]]);
  });

  it("uses a non-overlapping two-brick renko reversal", () => {
    const result = buildRenko(bars(100, 102, 99), 1, { brickSizeTicks: 1, reversalBricks: 2 });
    expect(result.map(({ open, close }) => [open, close])).toEqual([[100, 101], [101, 102], [101, 100], [100, 99]]);
  });

  it("supports an immediate one-brick renko reversal", () => {
    const result = buildRenko(bars(100, 102, 101), 1, { brickSizeTicks: 1, reversalBricks: 1 });
    expect(result.at(-1)).toMatchObject({ open: 102, close: 101, direction: "down" });
  });

  it("uses the configured high-low traversal", () => {
    const source: Bar[] = [{ time: 1_000, open: 100, high: 100, low: 100, close: 100, volume: 1 }, { time: 1_060, open: 100, high: 104, low: 98, close: 103, volume: 1 }];
    expect(buildRenko(source, 1, { brickSizeTicks: 2, priceSource: "close" })).toHaveLength(1);
    expect(buildRenko(source, 1, { brickSizeTicks: 2, priceSource: "high-low" }).map((item) => item.direction)).toEqual(["down", "up", "up"]);
  });

  it("extends and reverses point-and-figure columns", () => {
    const result = buildPointAndFigure(bars(100, 104, 101, 99, 103), 1, { boxSizeTicks: 1, reversalBoxes: 3 });
    expect(result.map((column) => ({ direction: column.direction, low: column.low, high: column.high }))).toEqual([
      { direction: "x", low: 101, high: 104 },
      { direction: "o", low: 99, high: 103 },
      { direction: "x", low: 100, high: 103 },
    ]);
  });

  it("marks only live-bar output provisional and assigns unique plot times", () => {
    const source = bars(100, 102, 105);
    source[2].realtime = true;
    const result = buildRenko(source, .25, { brickSizeTicks: 4, reversalBricks: 2 });
    expect(result.slice(0, 2).every((item) => !item.provisional)).toBe(true);
    expect(result.slice(2).every((item) => item.provisional)).toBe(true);
    expect(new Set(result.map((item) => item.plotTime)).size).toBe(result.length);
    expect(buildRenko(source, .25, { brickSizeTicks: 4, reversalBricks: 2 })).toEqual(result);
  });

  it("marks a point-and-figure column provisional when a live bar extends it", () => {
    const source = bars(100, 104, 106);
    source[2].realtime = true;
    const result = buildPointAndFigure(source, 1, { boxSizeTicks: 1, reversalBoxes: 3 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ direction: "x", high: 106, sourceTime: source[2].time, provisional: true });
  });

  it("rounds generated prices to the symbol tick grid", () => {
    const result = buildRenko(bars(1.1, 1.4), .1, { brickSizeTicks: 1, reversalBricks: 2 });
    expect(result.map((item) => item.close)).toEqual([1.2, 1.3, 1.4]);
  });

  it("returns no shapes when movement is smaller than a box", () => {
    expect(buildRenko(bars(100, 100.25), .25, { brickSizeTicks: 4 })).toEqual([]);
    expect(buildPointAndFigure(bars(100, 100.25), .25, { boxSizeTicks: 4 })).toEqual([]);
  });
});
