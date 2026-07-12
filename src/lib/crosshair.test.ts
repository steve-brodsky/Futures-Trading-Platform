import { describe, expect, it } from "vitest";
import { nearestCandleExtreme } from "./crosshair";

describe("nearestCandleExtreme", () => {
  it("selects the high when the pointer is nearer the high", () => {
    expect(nearestCandleExtreme(12, 10, 30, 105, 95)).toBe(105);
  });

  it("selects the low when the pointer is nearer the low", () => {
    expect(nearestCandleExtreme(27, 10, 30, 105, 95)).toBe(95);
  });

  it("selects the high when the pointer is exactly midway", () => {
    expect(nearestCandleExtreme(20, 10, 30, 105, 95)).toBe(105);
  });
});
