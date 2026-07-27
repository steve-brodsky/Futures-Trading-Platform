import { describe, expect, it } from "vitest";
import { eventState, formatEventTime, isSameDaySnapshot, newYorkDateHeading, newYorkDateKey, tradingTodayView } from "./tradingToday";
import type { EconomicEvent, TradingTodaySnapshot } from "../types";

describe("Trading Today date handling", () => {
  it("uses the New York date even when the local/UTC day differs", () => {
    expect(newYorkDateKey(new Date("2026-07-25T01:30:00Z"))).toBe("2026-07-24");
    expect(newYorkDateHeading(new Date("2026-07-25T01:30:00Z"))).toBe("Friday, July 24, 2026");
  });

  it("uses the following Monday for a Sunday preview", () => {
    expect(tradingTodayView("2026-07-26")).toEqual({
      mode: "sunday-preview",
      displayDate: "2026-07-26",
      economicDate: "2026-07-27",
    });
    expect(tradingTodayView("2028-12-31").economicDate).toBe("2029-01-01");
  });

  it("keeps the same economic date across the Sunday-to-Monday rollover", () => {
    expect(tradingTodayView("2026-07-26").economicDate).toBe(tradingTodayView("2026-07-27").economicDate);
    expect(tradingTodayView("2026-07-27").mode).toBe("today");
    expect(tradingTodayView("2026-07-25")).toEqual({
      mode: "today",
      displayDate: "2026-07-25",
      economicDate: "2026-07-25",
    });
  });

  it("formats release times in New York", () => {
    expect(formatEventTime("2026-07-24T13:45:00Z")).toBe("9:45 AM");
  });

  it("formats release times in the selected timezone", () => {
    expect(formatEventTime("2026-07-24T13:45:00Z", "America/Chicago")).toBe("8:45 AM");
    expect(formatEventTime("2026-07-24T13:45:00Z", "America/Los_Angeles")).toBe("6:45 AM");
    expect(formatEventTime("2026-07-24T13:45:00Z", "UTC")).toBe("1:45 PM");
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
