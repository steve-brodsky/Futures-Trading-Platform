import type { Bar, Timeframe } from "../types";
import { candleEndTime } from "./candleCountdown";

export interface BarRolloverRefreshState {
  barTime: number;
  attempts: number;
  lastAttemptMilliseconds: number;
}

interface BarRolloverRefreshInput {
  bar: Bar | undefined;
  timeframe: Timeframe;
  nowMilliseconds: number;
  state?: BarRolloverRefreshState;
}

const retryDelaysMilliseconds = [0, 5_000, 12_000, 25_000];

export function didBarCloseOnStreamUpdate(previousTime: number | undefined, latestTime: number | undefined, streamSeeded: boolean): boolean {
  return streamSeeded && previousTime != null && latestTime != null && latestTime > previousTime;
}

/**
 * Schedule a small number of authoritative refreshes when a live intraday bar
 * remains on screen after its closing boundary.
 */
export function nextBarRolloverRefresh({
  bar,
  timeframe,
  nowMilliseconds,
  state,
}: BarRolloverRefreshInput): BarRolloverRefreshState | undefined {
  if (!bar || timeframe === "D" || timeframe === "W" || timeframe === "M") return undefined;
  const candleEnd = candleEndTime(bar.time, timeframe);
  if (candleEnd == null) return undefined;

  const intervalMilliseconds = (candleEnd - bar.time) * 1000;
  const overdueMilliseconds = nowMilliseconds - candleEnd * 1000;
  // Prior-session bars are intentionally old. Limit repair to a candle that
  // was recent enough to have just missed its rollover.
  if (overdueMilliseconds < 2_000 || overdueMilliseconds > Math.max(60_000, intervalMilliseconds)) return undefined;

  const current = state?.barTime === bar.time
    ? state
    : { barTime: bar.time, attempts: 0, lastAttemptMilliseconds: 0 };
  const retryDelay = retryDelaysMilliseconds[current.attempts];
  if (retryDelay == null || current.lastAttemptMilliseconds && nowMilliseconds - current.lastAttemptMilliseconds < retryDelay) {
    return undefined;
  }
  return {
    barTime: bar.time,
    attempts: current.attempts + 1,
    lastAttemptMilliseconds: nowMilliseconds,
  };
}
