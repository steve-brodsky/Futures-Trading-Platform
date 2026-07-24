import type { ChartSessionSettings } from "../types";
import { isNyRegularMarketHours, newYorkSessionTime } from "./nySession";

export type ChartMarketSession = "regular" | "asia" | "london" | "overnight";

export const DEFAULT_CHART_SESSION_SETTINGS: ChartSessionSettings = {
  colorMode: "uniform",
  overnightColor: "#475569",
  asiaColor: "#2563eb",
  londonColor: "#7c3aed",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function normalizedColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

export function normalizeChartSessionSettings(
  value: unknown,
  fallback: ChartSessionSettings = DEFAULT_CHART_SESSION_SETTINGS,
): ChartSessionSettings {
  const saved = value && typeof value === "object" ? value as Partial<ChartSessionSettings> : {};
  return {
    colorMode: saved.colorMode === "uniform" || saved.colorMode === "by-session"
      ? saved.colorMode
      : fallback.colorMode,
    overnightColor: normalizedColor(saved.overnightColor, fallback.overnightColor),
    asiaColor: normalizedColor(saved.asiaColor, fallback.asiaColor),
    londonColor: normalizedColor(saved.londonColor, fallback.londonColor),
  };
}

/** Session windows are fixed in New York time so they remain stable on the chart through DST. */
export function chartMarketSession(epochSeconds: number): ChartMarketSession {
  if (isNyRegularMarketHours(epochSeconds)) return "regular";
  const { minuteOfDay } = newYorkSessionTime(epochSeconds);
  if (minuteOfDay >= 18 * 60 || minuteOfDay < 2 * 60) return "asia";
  if (minuteOfDay < 9 * 60 + 30) return "london";
  return "overnight";
}

export function chartSessionColor(session: Exclude<ChartMarketSession, "regular">, settings: ChartSessionSettings): string {
  if (settings.colorMode === "uniform") return settings.overnightColor;
  if (session === "asia") return settings.asiaColor;
  if (session === "london") return settings.londonColor;
  return settings.overnightColor;
}
