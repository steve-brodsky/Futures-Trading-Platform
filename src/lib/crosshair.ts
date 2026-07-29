import type { ChartKind, MarketDataProvider, Timeframe } from "../types";
import { candleEndTime } from "./candleCountdown";

export interface CrosshairPlotPoint {
  plotTime: number;
  sourceTime: number;
}

export type ChartCrosshairUpdate =
  | { visible: true; sourceTime: number; sourceTimeframe?: Timeframe; price: number }
  | { visible: false };

export type CrosshairSyncEvent = {
  sourceWindowId: string;
  sourceTabId: string;
  provider: MarketDataProvider;
  symbol: string;
  order: number;
} & ChartCrosshairUpdate;

export function crosshairEventsForTarget(
  events: CrosshairSyncEvent[],
  targetWindowId: string,
): CrosshairSyncEvent[] {
  return events.filter((event) => event.sourceWindowId !== targetWindowId);
}

export function nearestCandleExtreme(
  pointerY: number,
  highY: number,
  lowY: number,
  high: number,
  low: number,
): number {
  return Math.abs(pointerY - highY) <= Math.abs(pointerY - lowY) ? high : low;
}

function latestPointAtOrBefore(sourceTime: number, points: CrosshairPlotPoint[]): CrosshairPlotPoint | undefined {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].sourceTime <= sourceTime) low = middle + 1;
    else high = middle;
  }
  return low > 0 ? points[low - 1] : undefined;
}

function earliestPointAtOrAfter(sourceTime: number, points: CrosshairPlotPoint[]): { point: CrosshairPlotPoint; index: number } | undefined {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].sourceTime < sourceTime) low = middle + 1;
    else high = middle;
  }
  return low < points.length ? { point: points[low], index: low } : undefined;
}

function fallbackCalendarCoverageStart(endTime: number, timeframe: Timeframe): number | undefined {
  if (timeframe === "D") return endTime - 24 * 60 * 60;
  if (timeframe === "W") return endTime - 7 * 24 * 60 * 60;
  if (timeframe !== "M") return undefined;
  const end = new Date(endTime * 1000);
  if (!Number.isFinite(end.getTime())) return undefined;
  return Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth() - 1,
    end.getUTCDate(),
    end.getUTCHours(),
    end.getUTCMinutes(),
    end.getUTCSeconds(),
  ) / 1000;
}

/**
 * Translate a canonical market timestamp to a chart-specific plot timestamp.
 * Time charts require the timestamp to fall inside a loaded bar. Synthetic
 * charts retain the latest brick/column while their source bars still cover it.
 * TradeStation calendar bars are stamped at the end of their trading period,
 * unlike its intraday bars and Schwab's normalized calendar bars.
 */
export function syncedCrosshairPlotTime(
  sourceTime: number,
  points: CrosshairPlotPoint[],
  kind: ChartKind,
  timeframe: Timeframe,
  latestSourceBarTime?: number,
  targetProvider?: MarketDataProvider,
  sourceTimeframe?: Timeframe,
): number | undefined {
  if (!Number.isFinite(sourceTime) || !points.length) return undefined;

  const synthetic = kind === "renko" || kind === "point-and-figure";
  if (!synthetic && targetProvider === "tradestation" && ["D", "W", "M"].includes(timeframe)) {
    const match = earliestPointAtOrAfter(sourceTime, points);
    if (!match) return undefined;
    const coverageStart = match.index > 0
      ? points[match.index - 1].sourceTime
      : fallbackCalendarCoverageStart(match.point.sourceTime, timeframe);
    if (coverageStart == null || sourceTime < coverageStart) return undefined;
    return match.point.plotTime;
  }

  // TradeStation calendar timestamps identify the end of the period. Move
  // inside that boundary when projecting one onto an intraday target so the
  // final target candle is selected instead of being treated as out of range.
  const lookupTime = targetProvider === "tradestation"
    && sourceTimeframe != null
    && ["D", "W", "M"].includes(sourceTimeframe)
    && !["D", "W", "M"].includes(timeframe)
    ? sourceTime - 1
    : sourceTime;
  const point = latestPointAtOrBefore(lookupTime, points);
  if (!point) return undefined;

  const coverageStart = synthetic ? latestSourceBarTime : point.sourceTime;
  if (coverageStart == null) return undefined;
  const coverageEnd = candleEndTime(coverageStart, timeframe);
  if (coverageEnd == null || lookupTime >= coverageEnd) return undefined;
  return point.plotTime;
}
