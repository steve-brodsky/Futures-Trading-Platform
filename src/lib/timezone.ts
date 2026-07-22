import type { ChartTimezone } from "../types";

const exchangeZones: Record<string, string> = {
  CME: "America/Chicago",
  CBOT: "America/Chicago",
  NYMEX: "America/Chicago",
  COMEX: "America/Chicago",
  NYSE: "America/New_York",
  NASDAQ: "America/New_York",
  AMEX: "America/New_York",
  ARCA: "America/New_York",
  "NYSE ARCA": "America/New_York",
  BATS: "America/New_York",
};

export function resolveTimezone(mode: ChartTimezone, exchange: string): string {
  if (mode === "exchange") return exchangeZones[exchange.toUpperCase()] ?? "UTC";
  if (mode === "local") return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return mode;
}

export function timezoneLabel(mode: ChartTimezone, exchange: string): string {
  const zone = resolveTimezone(mode, exchange);
  const abbreviation = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
    .formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? zone;
  if (mode === "exchange") return `EXCH · ${abbreviation}`;
  if (mode === "local") return `LOCAL · ${abbreviation}`;
  return abbreviation;
}

export function formatChartTime(epochSeconds: number, timezone: string, detailed = false): string {
  const date = new Date(epochSeconds * 1000);
  return new Intl.DateTimeFormat("en-US", detailed ? {
    timeZone: timezone, month: "short", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short",
  } : { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export const timezoneOptions: Array<{ value: ChartTimezone; label: string }> = [
  { value: "exchange", label: "Exchange time" },
  { value: "local", label: "Computer local" },
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "New York" },
  { value: "America/Chicago", label: "Chicago" },
  { value: "America/Denver", label: "Denver" },
  { value: "America/Los_Angeles", label: "Los Angeles" },
  { value: "Europe/London", label: "London" },
  { value: "Asia/Tokyo", label: "Tokyo" },
];
