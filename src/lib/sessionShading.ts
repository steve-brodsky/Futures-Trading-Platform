import type {
  IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time,
} from "lightweight-charts";
import { isNyRegularMarketHours } from "./nySession";
import type { ChartSessionSettings } from "../types";
import { chartMarketSession, chartSessionColor, normalizeChartSessionSettings } from "./chartSessions";

export const isUsRegularMarketHours = isNyRegularMarketHours;

export class SessionShading implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  private times: number[] = [];
  private settings: ChartSessionSettings;

  constructor(settings: ChartSessionSettings) {
    this.settings = normalizeChartSessionSettings(settings);
  }

  private readonly renderer: IPrimitivePaneRenderer = {
    draw: () => undefined,
    drawBackground: (target) => {
      if (!this.chart || this.times.length === 0) return;
      const scale = this.chart.timeScale();
      const coordinates = this.times.map((time) => scale.timeToCoordinate(time as Time));
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.save();
        context.globalAlpha = 0.12;
        for (let index = 0; index < this.times.length; index += 1) {
          const session = chartMarketSession(this.times[index]);
          if (session === "regular") continue;
          const x = coordinates[index];
          if (x == null) continue;
          const previous = coordinates[index - 1];
          const next = coordinates[index + 1];
          const left = previous == null ? x - ((next ?? x + 8) - x) / 2 : (previous + x) / 2;
          const right = next == null ? x + (x - (previous ?? x - 8)) / 2 : (x + next) / 2;
          context.fillStyle = chartSessionColor(session, this.settings);
          if (right >= 0 && left <= mediaSize.width) context.fillRect(left, 0, right - left, mediaSize.height);
        }
        context.restore();
      });
    },
  };

  private readonly view: IPrimitivePaneView = {
    zOrder: () => "bottom",
    renderer: () => this.renderer,
  };

  attached({ chart, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart as IChartApi;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return [this.view];
  }

  setTimes(times: number[]) {
    this.times = times;
    this.requestUpdate?.();
  }

  setSettings(settings: ChartSessionSettings) {
    this.settings = normalizeChartSessionSettings(settings);
    this.requestUpdate?.();
  }
}
