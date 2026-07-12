import { describe, expect, it } from "vitest";
import { ema, estimateOrderRisk, roundToTick, sma, validateTick } from "./indicators";

describe("indicator math", () => {
  it("computes rolling SMA", () => expect(sma([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]));
  it("warms up EMA", () => expect(ema([1, 2, 3], 2)[0]).toBeNull());
  it("aligns futures prices to ticks", () => {
    expect(validateTick(6260.25, 0.25)).toBe(true);
    expect(validateTick(6260.1, 0.25)).toBe(false);
    expect(roundToTick(6260.13, 0.25)).toBe(6260.25);
  });
  it("estimates long and short risk from tick distance", () => {
    expect(estimateOrderRisk(6250, 6247, "Buy", 2, 0.25, 1.25)).toBe(30);
    expect(estimateOrderRisk(6250, 6253, "Sell", 2, 0.25, 1.25)).toBe(30);
    expect(estimateOrderRisk(6250, 6251, "Buy", 1, 0.25, 1.25)).toBeNull();
  });
});
