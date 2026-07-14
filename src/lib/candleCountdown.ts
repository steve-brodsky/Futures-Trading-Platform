import type { Timeframe } from "../types";

const fixedTimeframeSeconds: Partial<Record<Timeframe, number>> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  D: 24 * 60 * 60,
  W: 7 * 24 * 60 * 60,
};

export function candleEndTime(openTime: number, timeframe: Timeframe): number | null {
  if (!Number.isFinite(openTime) || openTime <= 0) return null;
  const duration = fixedTimeframeSeconds[timeframe];
  if (duration) return openTime + duration;

  const open = new Date(openTime * 1000);
  if (!Number.isFinite(open.getTime())) return null;
  return Date.UTC(open.getUTCFullYear(), open.getUTCMonth() + 1, 1) / 1000;
}

export function formatCandleCountdown(openTime: number, timeframe: Timeframe, nowMilliseconds = Date.now()): string {
  const endTime = candleEndTime(openTime, timeframe);
  if (endTime == null || !Number.isFinite(nowMilliseconds)) return "";
  let remaining = Math.max(0, Math.ceil(endTime - nowMilliseconds / 1000));
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
