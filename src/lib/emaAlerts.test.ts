import { describe, expect, it } from "vitest";
import type { Bar, ChartTabState, Timeframe } from "../types";
import {
  defaultEma200Alert,
  desiredAlertMarkets,
  evaluateEma200Cross,
  normalizeEma200Alert,
  uncoveredAlertMarkets,
} from "./emaAlerts";

function bars(last = 101): Bar[] {
  return Array.from({ length: 200 }, (_, index) => ({
    time: index * 60,
    open: 100,
    high: Math.max(100, index === 199 ? last : 100),
    low: Math.min(100, index === 199 ? last : 100),
    close: index === 199 ? last : 100,
    volume: 100,
  }));
}

function tab(id: string, symbol: string, timeframe: Timeframe, enabled: Timeframe[]): ChartTabState {
  const ema200Alert = defaultEma200Alert();
  enabled.forEach((item) => { ema200Alert[item].enabled = true; });
  return {
    id,
    symbol: { symbol, description: symbol, exchange: "CME", assetType: "Future", minMove: .25, pointValue: 5 },
    timeframe,
    chartKind: "candles",
    indicators: [],
    ema200Alert,
    chartTimezone: "exchange",
    magnetEnabled: false,
  };
}

describe("EMA 200 alert configuration", () => {
  it("creates independent disabled defaults for every timeframe", () => {
    const config = defaultEma200Alert();
    expect(Object.keys(config)).toEqual(["1m", "5m", "15m", "30m", "1h", "4h", "D", "W", "M"]);
    expect(config["1m"]).toEqual({ enabled: false, sound: "chime", durationSeconds: 3 });
    config["1m"].sound = "siren";
    expect(config["5m"].sound).toBe("chime");
  });

  it("normalizes incomplete and invalid saved values", () => {
    const config = normalizeEma200Alert({
      "1m": { enabled: true, sound: "bell", durationSeconds: 10 },
      "5m": { enabled: true, sound: "invalid", durationSeconds: 4 },
    });
    expect(config["1m"]).toEqual({ enabled: true, sound: "bell", durationSeconds: 10 });
    expect(config["5m"]).toEqual({ enabled: true, sound: "chime", durationSeconds: 3 });
    expect(config.M).toEqual({ enabled: false, sound: "chime", durationSeconds: 3 });
  });
});

describe("EMA 200 crossing evaluation", () => {
  it("waits for enough history and arms silently on its first valid value", () => {
    expect(evaluateEma200Cross(bars().slice(0, 199))).toEqual({ side: undefined });
    const armed = evaluateEma200Cross(bars());
    expect(armed.side).toBe("above");
    expect(armed.direction).toBeUndefined();
  });

  it("fires in both directions only after a true recross", () => {
    const downward = evaluateEma200Cross(bars(99), "above");
    expect(downward.direction).toBe("below");
    expect(evaluateEma200Cross(bars(98), downward.side).direction).toBeUndefined();
    expect(evaluateEma200Cross(bars(101), downward.side).direction).toBe("above");
  });

  it("treats equality as a touch and retains the prior side", () => {
    const touched = evaluateEma200Cross(bars(100), "above");
    expect(touched).toMatchObject({ side: "above", direction: undefined, price: 100 });
    expect(touched.ema).toBeCloseTo(100);
  });
});

describe("EMA alert stream planning", () => {
  it("deduplicates desired markets across tabs and includes detached-tab data", () => {
    const tabs = [tab("one", "@MES", "1m", ["1m", "5m"]), tab("two", "@MES", "15m", ["5m"]), tab("three", "MNQ", "1m", ["D"])];
    expect(desiredAlertMarkets(tabs).map((item) => [item.symbol, item.timeframe])).toEqual([["@MES", "1m"], ["@MES", "5m"], ["MNQ", "D"]]);
  });

  it("reuses chart markets and requests only uncovered pairs", () => {
    const tabs = [tab("one", "@MES", "1m", ["1m", "5m"]), tab("two", "@MES", "5m", [])];
    expect(uncoveredAlertMarkets(tabs)).toEqual([]);
    tabs[1].timeframe = "15m";
    expect(uncoveredAlertMarkets(tabs).map((item) => item.timeframe)).toEqual(["5m"]);
  });
});
