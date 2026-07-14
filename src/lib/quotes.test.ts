import { describe, expect, it } from "vitest";
import { quoteDayChangePercent } from "./quotes";

describe("quote day change percentage", () => {
  it("preserves a non-zero provider percentage", () => {
    expect(quoteDayChangePercent({ last: 105, change: 5, changePct: 4.95 })).toBe(4.95);
  });

  it("calculates from last and net change when the provider percentage is missing", () => {
    expect(quoteDayChangePercent({ last: 105, change: 5, changePct: 0 })).toBeCloseTo(5);
    expect(quoteDayChangePercent({ last: 95, change: -5, changePct: 0 })).toBeCloseTo(-5);
  });

  it("normalizes unchanged and invalid reference prices to zero", () => {
    expect(quoteDayChangePercent({ last: 100, change: 0, changePct: 0 })).toBe(0);
    expect(quoteDayChangePercent({ last: 5, change: 5, changePct: 0 })).toBe(0);
  });
});
