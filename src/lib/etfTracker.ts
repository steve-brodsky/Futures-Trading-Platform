import type { EtfTrackerRow, EtfTrackerSnapshot } from "../types";
import { newYorkDateKey } from "./tradingToday";

export const ETF_TRACKER_SYMBOLS = ["SPXL", "UPRO", "SSO", "SPUU", "TQQQ"] as const;
const DAY_MS = 86_400_000;

function dateNumber(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date ? parsed : NaN;
}

export function addCalendarDays(date: string, days: number): string {
  const value = dateNumber(date) + days * DAY_MS;
  return Number.isFinite(value) ? new Date(value).toISOString().slice(0, 10) : "";
}

export function etfTrackerView(row: EtfTrackerRow | undefined, today: string, stale = false) {
  const elapsed = row?.lastClosedDate ? (dateNumber(today) - dateNumber(row.lastClosedDate)) / DAY_MS : NaN;
  const daysElapsed = Number.isInteger(elapsed) && elapsed >= 0 ? elapsed : null;
  const day31Date = daysElapsed !== null && row?.lastClosedDate ? addCalendarDays(row.lastClosedDate, 31) : null;
  const daysRemaining = daysElapsed === null ? null : Math.max(0, 31 - daysElapsed);
  const status = stale ? "stale"
    : row && Math.abs(row.quantity) > 0.00000001 ? "open"
      : !row || row.availabilityReason || daysElapsed === null ? "unavailable"
        : daysElapsed >= 31 ? "complete" : "waiting";
  const label = status === "stale" ? "Stale · refresh required"
    : status === "open" ? "Open"
      : status === "complete" ? "31-day wait complete"
        : status === "waiting" ? `Waiting · ${daysRemaining} ${daysRemaining === 1 ? "day" : "days"} left`
          : "History unavailable";
  return { daysElapsed, day31Date, daysRemaining, status, label };
}

export function demoEtfTrackerSnapshot(accountId: string, now = new Date()): EtfTrackerSnapshot {
  const today = newYorkDateKey(now);
  const ages = [40, 12, 31, 5, null];
  return {
    accountId, fetchedAt: now.toISOString(), coverageStart: addCalendarDays(today, -365), coverageEnd: today, status: "demo",
    rows: ETF_TRACKER_SYMBOLS.map((symbol, index) => ({
      symbol, quantity: symbol === "SPUU" ? 25 : 0,
      lastClosedDate: ages[index] === null ? null : addCalendarDays(today, -ages[index]!),
      availabilityReason: null,
    })),
  };
}
