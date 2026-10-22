import { describe, expect, it } from "vitest";
import type { EtfTrackerRow } from "../types";
import { addCalendarDays, demoEtfTrackerSnapshot, ETF_TRACKER_SYMBOLS, etfTrackerView } from "./etfTracker";
import { newYorkDateKey, tradingTodayView } from "./tradingToday";

const row = (lastClosedDate: string | null, quantity = 0): EtfTrackerRow => ({ symbol: "SPXL", quantity, lastClosedDate, availabilityReason: null });

describe("ETF calendar countdown", () => {
  it.each([
    ["2026-09-01", 0, "Waiting · 31 days left"],
    ["2026-10-01", 30, "Waiting · 1 day left"],
    ["2026-10-02", 31, "31-day wait complete"],
    ["2026-10-03", 32, "31-day wait complete"],
  ])("counts %s from day zero", (today, days, label) => {
    expect(etfTrackerView(row("2026-09-01"), today)).toMatchObject({ daysElapsed: days, day31Date: "2026-10-02", label });
  });

  it("counts calendar days across DST, weekends, leap days, and year boundaries", () => {
    expect(etfTrackerView(row("2026-03-01"), newYorkDateKey(new Date("2026-04-01T04:00:00Z"))).daysElapsed).toBe(31);
    expect(etfTrackerView(row("2026-10-10"), "2026-11-10").daysElapsed).toBe(31);
    expect(addCalendarDays("2026-12-20", 31)).toBe("2027-01-20");
    expect(addCalendarDays("2028-02-01", 31)).toBe("2028-03-03");
    expect(etfTrackerView(row("2026-09-04"), "2026-09-07").daysElapsed).toBe(3);
  });

  it("uses Sunday rather than the Monday economic preview", () => {
    const view = tradingTodayView("2026-07-26");
    expect(view.economicDate).toBe("2026-07-27");
    expect(etfTrackerView(row("2026-06-26"), view.displayDate)).toMatchObject({ daysElapsed: 30, status: "waiting" });
  });

  it("shows open holdings while preserving the previous close and elapsed days", () => {
    expect(etfTrackerView(row("2026-09-01", 0.25), "2026-10-02")).toMatchObject({ daysElapsed: 31, status: "open", day31Date: "2026-10-02" });
  });

  it("does not infer eligibility from missing, inconsistent, future, or stale history", () => {
    expect(etfTrackerView(row(null), "2026-10-02").status).toBe("unavailable");
    expect(etfTrackerView(undefined, "2026-10-02").status).toBe("unavailable");
    expect(etfTrackerView({ ...row("2026-09-01"), availabilityReason: "Correction" }, "2026-10-02").status).toBe("unavailable");
    expect(etfTrackerView(row("2026-10-03"), "2026-10-02").daysElapsed).toBeNull();
    expect(etfTrackerView(row("2026-02-30"), "2026-10-02").daysElapsed).toBeNull();
    expect(etfTrackerView(row("2026-09-01"), "2026-10-02", true).status).toBe("stale");
  });

  it("provides account-scoped demo examples in the requested order", () => {
    const demo = demoEtfTrackerSnapshot("selected", new Date("2026-10-21T20:00:00Z"));
    expect(demo.accountId).toBe("selected");
    expect(demo.status).toBe("demo");
    expect(demo.rows.map((item) => item.symbol)).toEqual(ETF_TRACKER_SYMBOLS);
    expect(demo.rows.map((item) => etfTrackerView(item, "2026-10-21").status)).toEqual(["complete", "waiting", "complete", "open", "unavailable"]);
  });
});
