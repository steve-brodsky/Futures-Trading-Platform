import { describe, expect, it } from "vitest";
import type { IndicatorConfig } from "../types";
import { normalizeIndicators, normalizeMagnetEnabled } from "./workspace";

const savedIndicators: IndicatorConfig[] = [
  { id: "ema20", kind: "EMA", period: 20, color: "#123456", visible: false },
  { id: "vwap", kind: "VWAP", period: 1, color: "#654321", visible: false },
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
    expect(normalizeIndicators(savedIndicators).find((indicator) => indicator.id === "vwap"))
      .toEqual(savedIndicators[1]);
  });

  it("preserves unknown saved indicators", () => {
    expect(normalizeIndicators(savedIndicators)).toContainEqual(savedIndicators[2]);
  });

  it("removes retired RSI and MACD indicators from legacy workspaces", () => {
    const legacyIndicators = [
      ...savedIndicators,
      { id: "rsi14", kind: "RSI", period: 14, color: "#ff7ac6", visible: true },
      { id: "macd", kind: "MACD", period: 12, color: "#47b6ff", visible: true },
    ] as unknown as IndicatorConfig[];

    expect(normalizeIndicators(legacyIndicators).map((indicator) => indicator.kind)).not.toContain("RSI");
    expect(normalizeIndicators(legacyIndicators).map((indicator) => indicator.kind)).not.toContain("MACD");
  });
});

describe("magnet workspace compatibility", () => {
  it("defaults an older saved workspace to magnet off", () => {
    expect(normalizeMagnetEnabled(undefined)).toBe(false);
  });

  it("preserves an enabled saved value", () => {
    expect(normalizeMagnetEnabled(true)).toBe(true);
  });
});
