import type { Timeframe } from "../types";
import { timeframeSeconds } from "./timeframes";

export function candleEndTime(openTime: number, timeframe: Timeframe): number | null {
  if (!Number.isFinite(openTime) || openTime <= 0) return null;
  const duration = timeframeSeconds(timeframe);
  if (duration) return openTime + duration;

  const open = new Date(openTime * 1000);
  if (!Number.isFinite(open.getTime())) return null;
  return Date.UTC(open.getUTCFullYear(), open.getUTCMonth() + 1, 1) / 1000;
}

export function formatCandleCountdown(openTime: number, timeframe: Timeframe, nowMilliseconds = Date.now()): string {
  const endTime = candleEndTime(openTime, timeframe);
  if (endTime == null || !Number.isFinite(nowMilliseconds)) return "";
  return formatRemainingSeconds(Math.max(0, Math.ceil(endTime - nowMilliseconds / 1000)));
}

/** Countdown for a New York-midnight keyed Schwab daily bar's regular session. */
export function formatSchwabDailyCountdown(openTime: number, nowMilliseconds = Date.now()): string {
  if (!Number.isFinite(openTime) || openTime <= 0 || !Number.isFinite(nowMilliseconds)) return "";
  const sessionOpen = openTime + 9.5 * 60 * 60;
  const sessionClose = openTime + 16 * 60 * 60;
  const now = nowMilliseconds / 1000;
  if (now < sessionOpen || now >= sessionClose) return "";
  return formatRemainingSeconds(Math.ceil(sessionClose - now));
}

function formatRemainingSeconds(value: number): string {
  let remaining = value;
  const days = Math.floor(remaining / 86_400);
  remaining -= days * 86_400;
  const hours = Math.floor(remaining / 3_600);
  remaining -= hours * 3_600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining - minutes * 60;
  const clock = [hours, minutes, seconds]
    .slice(days > 0 || hours > 0 ? 0 : 1)
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return days > 0 ? `${days}d ${clock}` : clock;
}
