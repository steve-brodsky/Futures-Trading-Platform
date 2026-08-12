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

  it("adds Failed Breakout disabled defaults to legacy workspaces", () => {
    expect(normalizeIndicators(savedIndicators)).toContainEqual({
      id: "failed-breakout",
      kind: "FAILED_BREAKOUT",
      visible: false,
      pivotBars: 2,
      toleranceTicks: 4,
      reclaimBars: 3,
      pairMode: "consecutive",
    });
  });

  it("normalizes and clamps saved Failed Breakout settings", () => {
    const normalized = normalizeIndicators([...savedIndicators, {
      id: "renamed-by-save",
      kind: "FAILED_BREAKOUT",
      visible: true,
      pivotBars: 9.8,
      toleranceTicks: -2.4,
      reclaimBars: 1000,
      pairMode: "latest-matching",
    }]).find((indicator) => indicator.kind === "FAILED_BREAKOUT");

    expect(normalized).toEqual({
      id: "failed-breakout",
      kind: "FAILED_BREAKOUT",
      visible: true,
      pivotBars: 3,
      toleranceTicks: 0,
      reclaimBars: 100,
      pairMode: "latest-matching",
    });
  });

  it("uses Failed Breakout defaults for malformed settings", () => {
    const normalized = normalizeIndicators([{
      id: "failed-breakout",
      kind: "FAILED_BREAKOUT",
      visible: "yes",
      pivotBars: Number.NaN,
      toleranceTicks: "4",
      reclaimBars: null,
      pairMode: "unknown",
    }]).find((indicator) => indicator.kind === "FAILED_BREAKOUT");

    expect(normalized).toMatchObject({ visible: false, pivotBars: 2, toleranceTicks: 4, reclaimBars: 3, pairMode: "consecutive" });
  });

  it("does not let an incompatible saved kind replace Failed Breakout", () => {
    const normalized = normalizeIndicators([{
      id: "failed-breakout",
      kind: "EMA",
      period: 10,
      color: "#ffffff",
      visible: true,
    }]);

    expect(normalized.find((indicator) => indicator.id === "failed-breakout")?.kind).toBe("FAILED_BREAKOUT");
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
