import { describe, expect, it } from "vitest";
import type { OptionContract, OptionExpiration } from "../types";
import { allocateGexStreamBudgets, calculateGexLevels, gexExpirationDisplayGroups, gexMagnitudeScale, normalizeGexSelection, normalizeGexTabSettings, prioritizeOptionContracts, resolveGexExpirations } from "./gex";

const contract = (symbol: string, putCall: "CALL" | "PUT", strikePrice: number, patch: Partial<OptionContract> = {}): OptionContract => ({
  symbol, underlying: "SPY", putCall, expirationDate: "2026-07-24", strikePrice,
  multiplier: 100, gamma: 0.02, openInterest: 1_000, bidPrice: 1, askPrice: 1.1, bidSize: 10, askSize: 12,
  markPrice: 1.05, totalVolume: 10, volatility: 0.2, delta: putCall === "CALL" ? 0.5 : -0.5,
  theta: -0.1, vega: 0.2, underlyingPrice: 500, quoteTime: 1, delayed: false, isMini: false, isNonStandard: false,
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
    expect(result.levels[0].callOpenInterest).toBe(1_000);
    expect(result.levels[0].putOpenInterest).toBe(400);
    expect(result.levels[0].expirations).toEqual([{
      expirationDate: "2026-07-24",
      callGex: 5_000_000,
      putGex: 2_000_000,
      netGex: 3_000_000,
      callOpenInterest: 1_000,
      putOpenInterest: 400,
    }]);
  });

  it("aggregates open interest independently from gamma across expirations", () => {
    const result = calculateGexLevels([
      contract("C1", "CALL", 500, { gamma: Number.NaN, openInterest: 1_200 }),
      contract("P1", "PUT", 500, { openInterest: 800 }),
      contract("C2", "CALL", 500, { expirationDate: "2026-07-31", openInterest: 500 }),
      contract("ADJUSTED", "PUT", 500, { expirationDate: "2026-07-31", openInterest: 99_999, isNonStandard: true }),
    ], 500, ["2026-07-24", "2026-07-31"], "2026-07-22");
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0].callOpenInterest).toBe(1_700);
    expect(result.levels[0].putOpenInterest).toBe(800);
    expect(result.levels[0].callGex).toBe(2_500_000);
    expect(result.levels[0].expirations.map((item) => item.expirationDate)).toEqual(["2026-07-24", "2026-07-31"]);
    expect(result.excludedCount).toBe(2);
  });

  it("preserves opposing expiration contributions when aggregate net GEX cancels", () => {
    const result = calculateGexLevels([
      contract("FRONT-C", "CALL", 500, { expirationDate: "2026-07-24", openInterest: 1_000 }),
      contract("NEXT-P", "PUT", 500, { expirationDate: "2026-07-31", openInterest: 1_000 }),
    ], 500, ["2026-07-24", "2026-07-31"], "2026-07-22");
    expect(result.levels[0].netGex).toBe(0);
    expect(result.levels[0].expirations).toMatchObject([
      { expirationDate: "2026-07-24", netGex: 5_000_000 },
      { expirationDate: "2026-07-31", netGex: -5_000_000 },
    ]);
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
    expect(normalizeGexTabSettings(undefined)).toEqual({ enabled: false, view: "net", expirationDisplay: "aggregate" });
    expect(normalizeGexTabSettings({ enabled: true, view: "calls-puts", expirationDisplay: "aggregate-strip" })).toEqual({ enabled: true, view: "calls-puts", expirationDisplay: "aggregate-strip" });
    expect(normalizeGexTabSettings({ enabled: true, view: "open-interest" })).toEqual({ enabled: true, view: "open-interest", expirationDisplay: "aggregate" });
    expect(normalizeGexTabSettings({ enabled: "yes", view: "other", expirationDisplay: "other" })).toEqual({ enabled: false, view: "net", expirationDisplay: "aggregate" });
  });

  it("uses adaptive square-root scaling capped at the 95th percentile", () => {
    const values = [1, 10, 100, 1_000, 1_000_000];
    expect(gexMagnitudeScale(0, values)).toBe(0);
    expect(gexMagnitudeScale(10, values)).toBeCloseTo(0.1);
    expect(gexMagnitudeScale(100, values)).toBeCloseTo(Math.sqrt(0.1));
    expect(gexMagnitudeScale(1_000_000, values)).toBe(1);
  });

  it("keeps the nearest seven expiration colors and groups later dates", () => {
    const dates = Array.from({ length: 10 }, (_, index) => `2026-${String(index + 1).padStart(2, "0")}-16`);
    const groups = gexExpirationDisplayGroups(dates);
    expect(groups).toHaveLength(8);
    expect(groups.slice(0, 7).flatMap((group) => group.dates)).toEqual(dates.slice(0, 7));
    expect(groups[7]).toMatchObject({ key: "later", label: "Later (3)", dates: dates.slice(7) });
    expect(new Set(groups.map((group) => group.color)).size).toBe(8);
  });
});
