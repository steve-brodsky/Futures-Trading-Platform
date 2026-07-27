import type { EconomicEvent, MarketHoliday, TradingTodaySnapshot } from "../types";

export const TRADING_TODAY_TIMEZONE = "America/New_York";
export const TRADING_ECONOMICS_CALENDAR_URL = "https://tradingeconomics.com/united-states/calendar";
export const NYSE_HOURS_URL = "https://www.nyse.com/markets/hours-calendars";
export const CME_HOURS_URL = "https://www.cmegroup.com/trading-hours.html";

export interface TradingTodayView {
  mode: "today" | "sunday-preview";
  displayDate: string;
  economicDate: string;
}

const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TRADING_TODAY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const headingFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TRADING_TODAY_TIMEZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

export function newYorkDateKey(value: Date | number = new Date()): string {
  const parts = dateKeyFormatter.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function newYorkDateHeading(value: Date | number = new Date()): string {
  return headingFormatter.format(value);
}

function utcDateKey(value: Date): string {
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function tradingTodayView(displayDate: string): TradingTodayView {
  const [year, month, day] = displayDate.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, 12));
  if (value.getUTCDay() !== 0) {
    return { mode: "today", displayDate, economicDate: displayDate };
  }
  value.setUTCDate(value.getUTCDate() + 1);
  return { mode: "sunday-preview", displayDate, economicDate: utcDateKey(value) };
}

export function eventState(events: EconomicEvent[], now = Date.now()): Record<string, "past" | "next" | "upcoming"> {
  const sorted = [...events].sort((left, right) => Date.parse(left.occursAt) - Date.parse(right.occursAt));
  const next = sorted.find((event) => Date.parse(event.occursAt) >= now)?.id;
  return Object.fromEntries(sorted.map((event) => [
    event.id,
    Date.parse(event.occursAt) < now ? "past" : event.id === next ? "next" : "upcoming",
  ]));
}

export function formatEventTime(occursAt: string, timeZone = TRADING_TODAY_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(occursAt));
}

export function formatHolidayDate(date: string): { month: string; day: string; weekday: string } {
  const value = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return { month: part("month").toUpperCase(), day: part("day"), weekday: part("weekday") };
}

export function isSameDaySnapshot(snapshot: TradingTodaySnapshot | null, date: string): snapshot is TradingTodaySnapshot {
  return snapshot?.date === date;
}

export function demoTradingTodaySnapshot(date: string, now = new Date()): TradingTodaySnapshot {
  const at = (hours: number, minutes: number) => {
    const [year, month, day] = date.split("-").map(Number);
    // Demo fixtures are anchored in Eastern Daylight Time, which covers the app's current demo season.
    return new Date(Date.UTC(year, month - 1, day, hours + 4, minutes)).toISOString();
  };
  const events: EconomicEvent[] = [
    { id: "demo-building-permits", occursAt: at(8, 0), title: "Building Permits Final", reference: "JUN", importance: 2, actual: "1.374M", consensus: "1.367M", previous: "1.41M", forecast: "1.367M", url: "https://tradingeconomics.com/united-states/building-permits" },
    { id: "demo-pmi", occursAt: at(9, 45), title: "S&P Global Manufacturing PMI Flash", reference: "JUL", importance: 3, actual: "53.8", consensus: "54.3", previous: "53.9", forecast: "54.2", url: "https://tradingeconomics.com/united-states/manufacturing-pmi" },
    { id: "demo-home-sales", occursAt: at(10, 0), title: "New Home Sales", reference: "JUN", importance: 3, actual: "0.628M", consensus: "0.61M", previous: "0.618M", forecast: "0.6M", url: "https://tradingeconomics.com/united-states/new-home-sales" },
    { id: "demo-rigs", occursAt: at(13, 0), title: "Baker Hughes Total Rigs Count", reference: "JUL/24", importance: 1, actual: "587", previous: "588", url: "https://tradingeconomics.com/united-states/crude-oil-rigs" },
  ];
  const holidays = ([
    {
      date: "2026-09-07", name: "Labor Day", venues: [
        { venue: "NYSE", status: "closed", detail: "Market closed", sourceUrl: NYSE_HOURS_URL },
        { venue: "CME", status: "modified-hours", detail: "Modified schedule · check product hours", sourceUrl: CME_HOURS_URL },
      ],
    },
    {
      date: "2026-11-26", name: "Thanksgiving Day", venues: [
        { venue: "NYSE", status: "closed", detail: "Market closed", sourceUrl: NYSE_HOURS_URL },
        { venue: "CME", status: "modified-hours", detail: "Modified schedule · check product hours", sourceUrl: CME_HOURS_URL },
      ],
    },
    {
      date: "2026-11-27", name: "Day after Thanksgiving", venues: [
        { venue: "NYSE", status: "early-close", detail: "Closes 1:00 PM ET", sourceUrl: NYSE_HOURS_URL },
        { venue: "CME", status: "modified-hours", detail: "Modified schedule · check product hours", sourceUrl: CME_HOURS_URL },
      ],
    },
    {
      date: "2026-12-24", name: "Christmas Eve", venues: [
        { venue: "NYSE", status: "early-close", detail: "Closes 1:00 PM ET", sourceUrl: NYSE_HOURS_URL },
        { venue: "CME", status: "modified-hours", detail: "Modified schedule · check product hours", sourceUrl: CME_HOURS_URL },
      ],
    },
  ] satisfies MarketHoliday[]).filter((holiday) => holiday.date >= date).slice(0, 4);

  return {
    date,
    timezone: TRADING_TODAY_TIMEZONE,
    fetchedAt: now.toISOString(),
    status: "demo",
    events,
    holidays,
    sourceUrl: TRADING_ECONOMICS_CALENDAR_URL,
    holidayVerifiedThrough: "2026-12-31",
  };
}
