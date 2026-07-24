import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { interpolateLogicalCoordinate, nySessionVwapPoints, startsNewVwapPath, visibleVwapPointRange, vwapLogicalPosition } from "./nySessionVwapPrimitive";

const epoch = (iso: string) => Date.parse(iso) / 1000;
const bar = (iso: string, close = 100): Bar => ({ time: epoch(iso), open: close, high: close, low: close, close, volume: 10 });

describe("NY Session VWAP primitive helpers", () => {
  it("maps minute values fractionally into 1m through 4h candle timelines", () => {
    const target = epoch("2026-07-13T14:30:00Z");
    [60, 300, 1_800, 3_600, 14_400].forEach((seconds) => {
      const start = target - seconds / 2;
      expect(vwapLogicalPosition([start, start + seconds], target)).toBeCloseTo(0.5);
    });
  });

  it("interpolates fractional logical positions between integer chart coordinates", () => {
    const coordinate = (index: number) => index * 12;
    expect(interpolateLogicalCoordinate(4, coordinate)).toBe(48);
    expect(interpolateLogicalCoordinate(4.25, coordinate)).toBe(51);
    expect(interpolateLogicalCoordinate(4.5, coordinate)).toBe(54);
    expect(interpolateLogicalCoordinate(4.75, coordinate)).toBe(57);
    expect(interpolateLogicalCoordinate(5, coordinate)).toBe(60);
  });

  it("does not extend outside the chart timeline", () => {
    expect(vwapLogicalPosition([100, 200], 99)).toBeNull();
    expect(vwapLogicalPosition([100, 200], 201)).toBeNull();
    expect(vwapLogicalPosition([100, 200], 230, 60)).toBe(1.5);
  });

  it("starts a new path after missing data and at each session", () => {
    const points = nySessionVwapPoints([
      bar("2026-07-13T13:30:00Z"),
      bar("2026-07-13T13:31:00Z", 101),
      bar("2026-07-13T13:33:00Z", 102),
      bar("2026-07-14T13:30:00Z", 103),
    ]);
    expect(startsNewVwapPath(points[0], points[1])).toBe(false);
    expect(startsNewVwapPath(points[1], points[2])).toBe(true);
    expect(startsNewVwapPath(points[2], points[3])).toBe(true);
  });

  it("selects only visible VWAP points with one neighbor on each side", () => {
    const points = [0, 1, 2, 3, 4, 5].map((logical) => ({
      time: 100 + logical * 60,
      value: 100,
      sessionKey: "2026-07-13",
      logical,
    }));
    expect(visibleVwapPointRange(points, 2, 3)).toEqual({ first: 1, last: 5 });
    expect(visibleVwapPointRange(points, -5, 0)).toEqual({ first: 0, last: 2 });
    expect(visibleVwapPointRange(points, 5, 10)).toEqual({ first: 4, last: 6 });
  });

  it("returns an empty range for missing points or an invalid viewport", () => {
    expect(visibleVwapPointRange([], 0, 10)).toEqual({ first: 0, last: 0 });
    expect(visibleVwapPointRange([{
      time: 100, value: 100, sessionKey: "2026-07-13", logical: 0,
    }], 10, 0)).toEqual({ first: 0, last: 0 });
  });
});
