import type { ChartKind, MarketDataProvider, Timeframe } from "../types";
import { candleEndTime } from "./candleCountdown";

export interface CrosshairPlotPoint {
  plotTime: number;
  sourceTime: number;
}

export type ChartCrosshairUpdate =
  | { visible: true; sourceTime: number; price: number }
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

/**
 * Translate a canonical market timestamp to a chart-specific plot timestamp.
 * Time charts require the timestamp to fall inside a loaded bar. Synthetic
 * charts retain the latest brick/column while their source bars still cover it.
 */
export function syncedCrosshairPlotTime(
  sourceTime: number,
  points: CrosshairPlotPoint[],
  kind: ChartKind,
  timeframe: Timeframe,
  latestSourceBarTime?: number,
): number | undefined {
  if (!Number.isFinite(sourceTime) || !points.length) return undefined;
  const point = latestPointAtOrBefore(sourceTime, points);
  if (!point) return undefined;

  const synthetic = kind === "renko" || kind === "point-and-figure";
  const coverageStart = synthetic ? latestSourceBarTime : point.sourceTime;
  if (coverageStart == null) return undefined;
  const coverageEnd = candleEndTime(coverageStart, timeframe);
  if (coverageEnd == null || sourceTime >= coverageEnd) return undefined;
  return point.plotTime;
}
