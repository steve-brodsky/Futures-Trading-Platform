import { describe, expect, it } from "vitest";
import type { IndicatorConfig } from "../types";
import { normalizeIndicators } from "./workspace";

const savedIndicators: IndicatorConfig[] = [
  { id: "ema20", kind: "EMA", period: 20, color: "#123456", visible: false },
  { id: "custom", kind: "SMA", period: 100, color: "#abcdef", visible: true },
];

describe("indicator workspace normalization", () => {
  it("adds EMA 200 as a visible red indicator when it is missing", () => {
    expect(normalizeIndicators(savedIndicators)).toContainEqual({
      id: "ema200",
      kind: "EMA",
      period: 200,
      color: "#ef466f",
      visible: true,
    });
  });

  it("preserves saved visibility and color", () => {
    expect(normalizeIndicators(savedIndicators).find((indicator) => indicator.id === "ema20"))
      .toEqual(savedIndicators[0]);
  });

  it("preserves unknown saved indicators", () => {
    expect(normalizeIndicators(savedIndicators)).toContainEqual(savedIndicators[1]);
  });
});
