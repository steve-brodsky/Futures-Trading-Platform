import { describe, expect, it } from "vitest";
import type { OptionContract, OptionExpiration } from "../types";
import { allocateGexStreamBudgets, calculateGexLevels, gexMagnitudeScale, normalizeGexSelection, normalizeGexTabSettings, prioritizeOptionContracts, resolveGexExpirations } from "./gex";

const contract = (symbol: string, putCall: "CALL" | "PUT", strikePrice: number, patch: Partial<OptionContract> = {}): OptionContract => ({
  symbol, underlying: "SPY", putCall, expirationDate: "2026-07-24", strikePrice,
  multiplier: 100, gamma: 0.02, openInterest: 1_000, bidPrice: 1, askPrice: 1.1,
  markPrice: 1.05, totalVolume: 10, volatility: 0.2, delta: putCall === "CALL" ? 0.5 : -0.5,
  underlyingPrice: 500, quoteTime: 1, delayed: false, isMini: false, isNonStandard: false,
  ...patch,
});

describe("GEX calculations", () => {
  it("nets calls positively and puts negatively by strike and expiration", () => {
    const result = calculateGexLevels([
      contract("C500", "CALL", 500),
      contract("P500", "PUT", 500, { openInterest: 400 }),
      contract("C510", "CALL", 510, { expirationDate: "2026-08-21" }),
    ], 500, ["2026-07-24"], "2026-07-22");
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0].callGex).toBe(5_000_000);
    expect(result.levels[0].putGex).toBe(2_000_000);
    expect(result.levels[0].netGex).toBe(3_000_000);
  });

  it("recalculates with spot squared and excludes adjusted or incomplete contracts", () => {
    const base = calculateGexLevels([contract("C", "CALL", 500)], 500, undefined, "2026-07-22");
    const moved = calculateGexLevels([contract("C", "CALL", 500)], 510, undefined, "2026-07-22");
    expect(moved.netGex / base.netGex).toBeCloseTo((510 / 500) ** 2);
    expect(calculateGexLevels([contract("X", "CALL", 500, { isNonStandard: true })], 500, undefined, "2026-07-22").excludedCount).toBe(1);
    expect(calculateGexLevels([
      contract("MINI", "CALL", 500, { isMini: true }),
      contract("EXPIRED", "PUT", 500, { expirationDate: "2026-07-21" }),
      contract("INCOMPLETE", "CALL", 500, { gamma: Number.NaN }),
    ], 500, undefined, "2026-07-22").excludedCount).toBe(3);
  });

  it("balances the live budget across calls and puts before filling spare capacity", () => {
    const contracts = Array.from({ length: 8 }, (_, index) => contract(`C${index}`, "CALL", 490 + index, { openInterest: 2_000 - index }))
      .concat(Array.from({ length: 3 }, (_, index) => contract(`P${index}`, "PUT", 490 + index, { openInterest: 1_000 - index })));
    const selected = prioritizeOptionContracts(contracts, 6);
    expect(selected.filter((symbol) => symbol.startsWith("C"))).toHaveLength(3);
    expect(selected.filter((symbol) => symbol.startsWith("P"))).toHaveLength(3);
  });

  it("splits the global option budget across visible symbols with the remainder on the active chart", () => {
    expect(allocateGexStreamBudgets(["AAPL", "SPY", "QQQ"], "SPY", 100)).toEqual({ SPY: 34, AAPL: 33, QQQ: 33 });
  });

  it("resolves rolling presets and prunes stale custom dates", () => {
    const expirations: OptionExpiration[] = ["2026-07-24", "2026-07-31", "2026-08-07", "2026-08-21", "2026-09-18"].map((expirationDate, index) => ({ expirationDate, daysToExpiration: index, expirationType: "W", standard: true }));
    expect(resolveGexExpirations(expirations, { mode: "front", expirationDates: [] })).toEqual(["2026-07-24"]);
    expect(resolveGexExpirations(expirations, { mode: "next-four", expirationDates: [] })).toHaveLength(4);
    expect(resolveGexExpirations(expirations, { mode: "custom", expirationDates: ["2020-01-01"] })).toEqual(["2026-07-24"]);
    expect(normalizeGexSelection({ mode: "custom", expirationDates: ["bad", "2026-08-21", "2026-08-21"] })).toEqual({ mode: "custom", expirationDates: ["2026-08-21"] });
  });

  it("normalizes per-tab visibility and display mode preferences", () => {
    expect(normalizeGexTabSettings(undefined)).toEqual({ enabled: false, view: "net" });
    expect(normalizeGexTabSettings({ enabled: true, view: "calls-puts" })).toEqual({ enabled: true, view: "calls-puts" });
    expect(normalizeGexTabSettings({ enabled: "yes", view: "other" })).toEqual({ enabled: false, view: "net" });
  });

  it("uses a capped logarithmic magnitude scale", () => {
    const values = [1, 10, 100, 1_000, 1_000_000];
    expect(gexMagnitudeScale(0, values)).toBe(0);
    expect(gexMagnitudeScale(100, values)).toBeGreaterThan(gexMagnitudeScale(10, values));
    expect(gexMagnitudeScale(1_000_000, values)).toBe(1);
  });
});
