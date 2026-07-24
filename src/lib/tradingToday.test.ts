import { describe, expect, it } from "vitest";
import { eventState, formatEventTime, isSameDaySnapshot, newYorkDateHeading, newYorkDateKey } from "./tradingToday";
import type { EconomicEvent, TradingTodaySnapshot } from "../types";

describe("Trading Today date handling", () => {
  it("uses the New York date even when the local/UTC day differs", () => {
    expect(newYorkDateKey(new Date("2026-07-25T01:30:00Z"))).toBe("2026-07-24");
    expect(newYorkDateHeading(new Date("2026-07-25T01:30:00Z"))).toBe("Friday, July 24, 2026");
  });

  it("formats release times in New York", () => {
    expect(formatEventTime("2026-07-24T13:45:00Z")).toBe("9:45 AM");
  });

  it("marks only the first non-past event as next", () => {
    const events: EconomicEvent[] = [
      { id: "past", occursAt: "2026-07-24T12:00:00Z", title: "Past", importance: 1 },
      { id: "next", occursAt: "2026-07-24T14:00:00Z", title: "Next", importance: 2 },
      { id: "later", occursAt: "2026-07-24T15:00:00Z", title: "Later", importance: 3 },
    ];
    expect(eventState(events, Date.parse("2026-07-24T13:00:00Z"))).toEqual({ past: "past", next: "next", later: "upcoming" });
  });

  it("rejects a previous-day cache", () => {
    const snapshot = { date: "2026-07-23" } as TradingTodaySnapshot;
    expect(isSameDaySnapshot(snapshot, "2026-07-24")).toBe(false);
    expect(isSameDaySnapshot({ ...snapshot, date: "2026-07-24" }, "2026-07-24")).toBe(true);
  });
});
