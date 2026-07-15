import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { calculateContractsForRisk, calculateTakeProfitAtR, ema, estimateOrderRisk, nySessionVwap, roundToTick, sma, validateTick } from "./indicators";

const sessionBar = (iso: string, high: number, low: number, close: number, volume: number): Bar => ({
  time: Date.parse(iso) / 1000, open: close, high, low, close, volume,
});

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

  it("sizes whole contracts without exceeding a risk budget", () => {
    expect(calculateContractsForRisk(30, 6250, 6247, "Buy", 0.25, 1.25)).toBe(2);
    expect(calculateContractsForRisk(29.99, 6250, 6247, "Buy", 0.25, 1.25)).toBe(1);
    expect(calculateContractsForRisk(47, 6250, 6253, "Sell", 0.25, 1.25)).toBe(3);
    expect(calculateContractsForRisk(14.99, 6250, 6253, "Sell", 0.25, 1.25)).toBe(0);
    expect(calculateContractsForRisk(100, 100, 99.99, "Buy", 0.01, 1.004)).toBe(99);
  });

  it("rejects invalid risk-sizing inputs and stop direction", () => {
    expect(calculateContractsForRisk(undefined, 6250, 6247, "Buy", 0.25, 1.25)).toBeNull();
    expect(calculateContractsForRisk(0, 6250, 6247, "Buy", 0.25, 1.25)).toBeNull();
    expect(calculateContractsForRisk(Number.NaN, 6250, 6247, "Buy", 0.25, 1.25)).toBeNull();
    expect(calculateContractsForRisk(100, 6250, 6251, "Buy", 0.25, 1.25)).toBeNull();
    expect(calculateContractsForRisk(100, 6250, 6247, "Buy", 0, 1.25)).toBeNull();
    expect(calculateContractsForRisk(100, 6250, 6247, "Buy", 0.25, 0)).toBeNull();
  });

  it.each([
    ["Buy", 1, 104],
    ["Buy", 1.5, 106],
    ["Buy", 2, 108],
    ["Sell", 1, 96],
    ["Sell", 1.5, 94],
    ["Sell", 2, 92],
  ] as const)("calculates %s take profit at %sR", (side, rMultiple, expected) => {
    const stop = side === "Buy" ? 96 : 104;
    expect(calculateTakeProfitAtR(100, stop, side, rMultiple, 0.25)).toBe(expected);
  });

  it("rounds R targets to the nearest valid tick", () => {
    expect(calculateTakeProfitAtR(100, 99.25, "Buy", 1.5, 0.25)).toBe(101.25);
    expect(calculateTakeProfitAtR(100, 100.75, "Sell", 1.5, 0.25)).toBe(99);
  });

  it("rejects invalid R target inputs and stops on the wrong side", () => {
    expect(calculateTakeProfitAtR(100, 101, "Buy", 1, 0.25)).toBeNull();
    expect(calculateTakeProfitAtR(100, 99, "Sell", 1, 0.25)).toBeNull();
    expect(calculateTakeProfitAtR(100, 99.1, "Buy", 1, 0.25)).toBeNull();
    expect(calculateTakeProfitAtR(Number.NaN, 99, "Buy", 1, 0.25)).toBeNull();
    expect(calculateTakeProfitAtR(100, 99, "Buy", 0, 0.25)).toBeNull();
    expect(calculateTakeProfitAtR(100, 99, "Buy", 1, 0)).toBeNull();
  });

  it("calculates HLC3 VWAP only during the New York regular session", () => {
    const values = nySessionVwap([
      sessionBar("2026-07-13T13:29:00Z", 10, 10, 10, 100),
      sessionBar("2026-07-13T13:30:00Z", 12, 10, 11, 100),
      sessionBar("2026-07-13T13:31:00Z", 15, 12, 15, 300),
      sessionBar("2026-07-13T20:00:00Z", 20, 20, 20, 100),
    ]);
    expect(values.map((item) => item.value)).toEqual([null, 11, 13.25, null]);
    expect(values[1].sessionKey).toBe("2026-07-13");
  });

  it("resets each session and waits for positive volume", () => {
    const values = nySessionVwap([
      sessionBar("2026-01-12T14:30:00Z", 100, 100, 100, 0),
      sessionBar("2026-01-12T14:31:00Z", 101, 101, 101, 10),
      sessionBar("2026-01-13T14:30:00Z", 200, 200, 200, 10),
    ]);
    expect(values.map((item) => item.value)).toEqual([null, 101, 200]);
    expect(values[2].sessionKey).toBe("2026-01-13");
  });
});
