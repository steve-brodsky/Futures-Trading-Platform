import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, Time } from "lightweight-charts";
import type { Drawing } from "../types";

export function nearestChartTime(anchor: number, times: number[]): number {
  if (!times.length) return anchor;
  let low = 0; let high = times.length;
  while (low < high) { const middle = (low + high) >>> 1; if (times[middle] < anchor) low = middle + 1; else high = middle; }
  if (low === 0) return times[0];
  if (low === times.length) return times[times.length - 1];
  return Math.abs(times[low] - anchor) < Math.abs(anchor - times[low - 1]) ? times[low] : times[low - 1];
}

export class HorizontalRayPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<any> | null = null;
  private requestUpdate?: () => void;
  private drawings: Drawing[] = [];
  private times: number[] = [];
  private readonly renderer: IPrimitivePaneRenderer = { draw: (target) => {
    if (!this.chart || !this.series) return;
    const scale = this.chart.timeScale();
    const coordinates = this.drawings.map((drawing) => ({ drawing, x: scale.timeToCoordinate(nearestChartTime(drawing.points[0].time, this.times) as Time), y: this.series!.priceToCoordinate(drawing.points[0].price) }));
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      coordinates.forEach(({ drawing, x, y }) => {
        if (x == null || y == null || y < 0 || y > mediaSize.height) return;
        context.lineWidth = drawing.lineWidth ?? 1;
        context.beginPath(); context.strokeStyle = drawing.color; context.moveTo(Math.max(0, x), y + .5); context.lineTo(mediaSize.width, y + .5); context.stroke();
      });
    });
  } };
  private readonly view: IPrimitivePaneView = { zOrder: () => "normal", renderer: () => this.renderer };
  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>) { this.chart = chart as IChartApi; this.series = series as ISeriesApi<any>; this.requestUpdate = requestUpdate; }
  detached() { this.chart = null; this.series = null; this.requestUpdate = undefined; }
  paneViews() { return [this.view]; }
  setDrawings(drawings: Drawing[]) { this.drawings = drawings; this.requestUpdate?.(); }
  setTimes(times: number[]) { this.times = times; this.requestUpdate?.(); }
}
