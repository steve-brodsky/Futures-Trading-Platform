import { describe, expect, it } from "vitest";
import { crosshairEventsForTarget, nearestCandleExtreme, syncedCrosshairPlotTime, type CrosshairSyncEvent } from "./crosshair";

describe("crosshairEventsForTarget", () => {
  const events: CrosshairSyncEvent[] = [
    { sourceWindowId: "main", sourceTabId: "main-chart", provider: "tradestation", symbol: "@MES", order: 1, visible: true, sourceTime: 60, price: 5000 },
    { sourceWindowId: "detached-1", sourceTabId: "detached-chart", provider: "tradestation", symbol: "@MNQ", order: 2, visible: false },
  ];

  it("prevents a relayed event from returning to its source window", () => {
    expect(crosshairEventsForTarget(events, "detached-1")).toEqual([events[0]]);
    expect(crosshairEventsForTarget(events, "main")).toEqual([events[1]]);
  });
});

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

describe("syncedCrosshairPlotTime", () => {
  const minutePoints = [
    { plotTime: 60, sourceTime: 60 },
    { plotTime: 120, sourceTime: 120 },
    { plotTime: 180, sourceTime: 180 },
  ];

  it("uses the target bar containing a timestamp from a smaller timeframe", () => {
    expect(syncedCrosshairPlotTime(135, minutePoints, "candles", "1m", 180)).toBe(120);
  });

  it("aligns a larger-timeframe timestamp to the matching smaller bar open", () => {
    expect(syncedCrosshairPlotTime(120, minutePoints, "line", "1m", 180)).toBe(120);
  });

  it("maps an end-stamped TradeStation daily crosshair to the final intraday candle", () => {
    expect(syncedCrosshairPlotTime(240, minutePoints, "candles", "1m", 180, "tradestation", "D")).toBe(180);
  });

  it("returns no target outside loaded time-chart coverage", () => {
    expect(syncedCrosshairPlotTime(30, minutePoints, "candles", "1m", 180)).toBeUndefined();
    expect(syncedCrosshairPlotTime(240, minutePoints, "candles", "1m", 180)).toBeUndefined();
  });

  it("uses the containing end-stamped TradeStation daily bar for an intraday timestamp", () => {
    const epoch = (iso: string) => Date.parse(iso) / 1000;
    const dailyPoints = [
      epoch("2026-07-14T20:00:00Z"),
      epoch("2026-07-15T20:00:00Z"),
      epoch("2026-07-16T20:00:00Z"),
    ].map((time) => ({ plotTime: time, sourceTime: time }));
    const intradayTime = epoch("2026-07-15T14:20:00Z");

    expect(syncedCrosshairPlotTime(intradayTime, dailyPoints, "candles", "D", dailyPoints.at(-1)?.sourceTime, "tradestation"))
      .toBe(dailyPoints[1].plotTime);
  });

  it("does not map a timestamp beyond loaded end-stamped daily coverage", () => {
    const epoch = (iso: string) => Date.parse(iso) / 1000;
    const dailyPoints = [
      epoch("2026-07-14T20:00:00Z"),
      epoch("2026-07-15T20:00:00Z"),
    ].map((time) => ({ plotTime: time, sourceTime: time }));

    expect(syncedCrosshairPlotTime(epoch("2026-07-15T20:00:01Z"), dailyPoints, "candles", "D", dailyPoints.at(-1)?.sourceTime, "tradestation"))
      .toBeUndefined();
  });

  it("prefers the last synthetic item when source timestamps are duplicated", () => {
    const syntheticPoints = [
      { plotTime: 1, sourceTime: 60 },
      { plotTime: 2, sourceTime: 120 },
      { plotTime: 3, sourceTime: 120 },
    ];
    expect(syncedCrosshairPlotTime(150, syntheticPoints, "renko", "1m", 120)).toBe(3);
    expect(syncedCrosshairPlotTime(150, syntheticPoints, "point-and-figure", "1m", 120)).toBe(3);
  });

  it("clears synthetic targets beyond their underlying source-bar coverage", () => {
    expect(syncedCrosshairPlotTime(180, [{ plotTime: 1, sourceTime: 120 }], "renko", "1m", 120)).toBeUndefined();
  });
});
