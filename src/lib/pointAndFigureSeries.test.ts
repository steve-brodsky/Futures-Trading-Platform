import { describe, expect, it } from "vitest";
import type { Time } from "lightweight-charts";
import { PointAndFigureSeries, type PointAndFigureSeriesData } from "./pointAndFigureSeries";

describe("PointAndFigureSeries", () => {
  it("reports its full price range and current column extreme", () => {
    const series = new PointAndFigureSeries();
    const data: PointAndFigureSeriesData = { time: 1 as Time, sourceTime: 1, direction: "o", boxes: [103, 102, 101], high: 103, low: 101, close: 101, boxSize: 1, provisional: false };
    expect(series.priceValueBuilder(data)).toEqual([103, 101, 101]);
    expect(series.isWhitespace(data)).toBe(false);
    expect(series.isWhitespace({ time: 1 as Time })).toBe(true);
  });
});
