import { describe, expect, it } from "vitest";
import type { EconomicEvent } from "../types";
import {
  DEFAULT_CHART_ECONOMIC_EVENT_SETTINGS,
  clusterEconomicEventCoordinates,
  economicEventImpact,
  economicEventLogicalPosition,
  economicEventsEligible,
  normalizeChartEconomicEventSettings,
  visibleEconomicEvents,
} from "./economicEvents";

const event = (id: string, occursAt: string, importance: 1 | 2 | 3 | null): EconomicEvent => ({
  id,
  occursAt,
  title: id,
  importance,
});

describe("chart economic events", () => {
  it("normalizes legacy and malformed settings", () => {
    expect(normalizeChartEconomicEventSettings(undefined)).toEqual(DEFAULT_CHART_ECONOMIC_EVENT_SETTINGS);
    expect(normalizeChartEconomicEventSettings({
      enabled: true,
      impactVisibility: { high: false, medium: "yes", low: true, unrated: false },
    })).toEqual({
      enabled: true,
      impactVisibility: { high: false, medium: true, low: true, unrated: false },
    });
  });

  it("maps impact, filters visibility, and sorts valid timestamps", () => {
    const events = [
      event("low", "2026-07-24T14:00:00Z", 1),
      event("high", "2026-07-24T12:30:00Z", 3),
      event("unrated", "2026-07-24T13:00:00Z", null),
      event("bad", "not-a-date", 2),
    ];
    expect(([3, 2, 1, null] as const).map(economicEventImpact)).toEqual(["high", "medium", "low", "unrated"]);
    expect(visibleEconomicEvents(events, {
      enabled: true,
      impactVisibility: { high: true, medium: true, low: false, unrated: true },
    }).map((item) => item.id)).toEqual(["high", "unrated"]);
    expect(visibleEconomicEvents(events, DEFAULT_CHART_ECONOMIC_EVENT_SETTINGS)).toEqual([]);
  });

  it("limits markers to time-based intraday charts", () => {
    expect(economicEventsEligible("candles", "1m")).toBe(true);
    expect(economicEventsEligible("line", "4h")).toBe(true);
    expect(economicEventsEligible("renko", "5m")).toBe(false);
    expect(economicEventsEligible("area", "D")).toBe(false);
  });

  it("interpolates exact event time between source bars", () => {
    const points = [{ plotTime: 10, sourceTime: 100 }, { plotTime: 20, sourceTime: 160 }];
    expect(economicEventLogicalPosition(event("release", "1970-01-01T00:02:10Z", 3), points)).toBe(0.5);
    expect(economicEventLogicalPosition(event("invalid", "bad", 3), points)).toBeNull();
  });

  it("clusters overlapping markers and uses the highest impact", () => {
    const clusters = clusterEconomicEventCoordinates([
      { event: event("low", "2026-07-24T12:30:00Z", 1), x: 100 },
      { event: event("high", "2026-07-24T12:30:00Z", 3), x: 108 },
      { event: event("medium", "2026-07-24T14:00:00Z", 2), x: 140 },
    ], 18);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ x: 104, impact: "high" });
    expect(clusters[0].events.map((item) => item.id)).toEqual(["high", "low"]);
    expect(clusters[1]).toMatchObject({ x: 140, impact: "medium" });
  });
});
