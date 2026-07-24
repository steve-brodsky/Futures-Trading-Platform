import type {
  IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesAttachedParameter, Time,
} from "lightweight-charts";
import type { Bar } from "../types";
import type { Timeframe } from "../types";
import { nySessionVwap } from "./indicators";

export interface NySessionVwapPoint {
  time: number;
  value: number;
  sessionKey: string;
}

export interface PositionedNySessionVwapPoint extends NySessionVwapPoint {
  logical: number;
}

export function nySessionVwapPoints(bars: Bar[]): NySessionVwapPoint[] {
  const values = nySessionVwap(bars);
  return values.flatMap((point, index) => point.value == null || !point.sessionKey
    ? []
    : [{ time: bars[index].time, value: point.value, sessionKey: point.sessionKey }]);
}

export function vwapLogicalPosition(chartTimes: number[], targetTime: number, finalBarSeconds = 0): number | null {
  if (!chartTimes.length || targetTime < chartTimes[0] || targetTime > chartTimes[chartTimes.length - 1] + finalBarSeconds) return null;
  if (targetTime > chartTimes[chartTimes.length - 1]) {
    return finalBarSeconds > 0 ? chartTimes.length - 1 + (targetTime - chartTimes[chartTimes.length - 1]) / finalBarSeconds : null;
  }
  let low = 0;
  let high = chartTimes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (chartTimes[middle] < targetTime) low = middle + 1;
    else high = middle;
  }
  if (chartTimes[low] === targetTime) return low;
  if (low === 0 || low >= chartTimes.length) return null;
  const previous = chartTimes[low - 1];
  const next = chartTimes[low];
  return low - 1 + (targetTime - previous) / (next - previous);
}

export function interpolateLogicalCoordinate(
  logical: number,
  coordinateForIndex: (index: number) => number | null,
): number | null {
  // Lightweight Charts only converts integer logical indexes. Interpolate the
  // two valid coordinates so minute data can sit inside a larger chart candle.
  const lower = Math.floor(logical);
  const upper = Math.ceil(logical);
  const lowerCoordinate = coordinateForIndex(lower);
  if (lowerCoordinate == null || lower === upper) return lowerCoordinate;
  const upperCoordinate = coordinateForIndex(upper);
  if (upperCoordinate == null) return null;
  return lowerCoordinate + (upperCoordinate - lowerCoordinate) * (logical - lower);
}

export function startsNewVwapPath(previous: NySessionVwapPoint | undefined, current: NySessionVwapPoint): boolean {
  return !previous || previous.sessionKey !== current.sessionKey || current.time - previous.time > 90;
}

export function visibleVwapPointRange(
  points: PositionedNySessionVwapPoint[],
  from: number,
  to: number,
): { first: number; last: number } {
  if (!points.length || !Number.isFinite(from) || !Number.isFinite(to) || from > to) return { first: 0, last: 0 };
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].logical < from) low = middle + 1;
    else high = middle;
  }
  const firstVisible = low;
  low = firstVisible;
  high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].logical <= to) low = middle + 1;
    else high = middle;
  }
  return {
    first: Math.max(0, firstVisible - 1),
    last: Math.min(points.length, low + 1),
  };
}

export class NySessionVwapPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<any> | null = null;
  private requestUpdate?: () => void;
  private chartTimes: number[] = [];
  private points: PositionedNySessionVwapPoint[] = [];
  private color = "#a879ff";
  private finalBarSeconds = 60;
  private sourceBars: Bar[] | null = null;
  private sourceChartTimes: number[] | null = null;

  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      if (!this.chart || !this.series || !this.points.length || !this.chartTimes.length) return;
      const scale = this.chart.timeScale();
      const visible = scale.getVisibleLogicalRange();
      if (!visible) return;
      const range = visibleVwapPointRange(this.points, Number(visible.from), Number(visible.to));
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.strokeStyle = this.color;
        context.lineWidth = 1.5;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.beginPath();
        let previous: NySessionVwapPoint | undefined;
        let pathOpen = false;
        for (let index = range.first; index < range.last; index += 1) {
          const point = this.points[index];
          const x = interpolateLogicalCoordinate(point.logical, (logicalIndex) => scale.logicalToCoordinate(logicalIndex as Logical));
          const y = this.series!.priceToCoordinate(point.value);
          if (x == null || y == null || x < -2 || x > mediaSize.width + 2 || y < -2 || y > mediaSize.height + 2) {
            previous = point;
            pathOpen = false;
            continue;
          }
          if (!pathOpen || startsNewVwapPath(previous, point)) context.moveTo(x, y);
          else context.lineTo(x, y);
          pathOpen = true;
          previous = point;
        }
        context.stroke();
      });
    },
  };

  private readonly view: IPrimitivePaneView = { zOrder: () => "normal", renderer: () => this.renderer };

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart as IChartApi;
    this.series = series as ISeriesApi<any>;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = undefined;
  }

  paneViews() {
    return [this.view];
  }

  setData(sourceBars: Bar[], chartTimes: number[], color: string, timeframe: Timeframe) {
    const finalBarSeconds = ({ "1m": 60, "5m": 300, "15m": 900, "30m": 1_800, "1h": 3_600, "4h": 14_400 } as Partial<Record<Timeframe, number>>)[timeframe] ?? 0;
    if (this.sourceBars === sourceBars
      && this.sourceChartTimes === chartTimes
      && this.color === color
      && this.finalBarSeconds === finalBarSeconds) return;
    if (!sourceBars.length && !this.points.length && this.color === color) {
      this.sourceBars = sourceBars;
      this.sourceChartTimes = chartTimes;
      this.chartTimes = chartTimes;
      this.finalBarSeconds = finalBarSeconds;
      return;
    }
    this.sourceBars = sourceBars;
    this.sourceChartTimes = chartTimes;
    this.chartTimes = chartTimes;
    this.color = color;
    this.finalBarSeconds = finalBarSeconds;
    this.points = nySessionVwapPoints(sourceBars).flatMap((point) => {
      const logical = vwapLogicalPosition(chartTimes, point.time, this.finalBarSeconds);
      return logical == null ? [] : [{ ...point, logical }];
    });
    this.requestUpdate?.();
  }
}
