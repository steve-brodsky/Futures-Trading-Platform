import { describe, expect, it } from "vitest";
import { nearestChartTime } from "./horizontalRay";

describe("horizontal ray timeframe mapping", () => {
  it("maps an anchor to the nearest available bar time", () => {
    expect(nearestChartTime(180, [100, 200, 300])).toBe(200);
    expect(nearestChartTime(140, [100, 200, 300])).toBe(100);
  });

  it("clamps anchors outside the loaded chart range", () => {
    expect(nearestChartTime(10, [100, 200])).toBe(100);
    expect(nearestChartTime(300, [100, 200])).toBe(200);
  });
});
