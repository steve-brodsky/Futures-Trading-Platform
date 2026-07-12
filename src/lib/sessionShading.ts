import type {
  IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time,
} from "lightweight-charts";

const easternClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function isUsRegularMarketHours(epochSeconds: number) {
  const parts = Object.fromEntries(easternClock.formatToParts(new Date(epochSeconds * 1000)).map((part) => [part.type, part.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export class SessionShading implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private times: number[] = [];
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: () => undefined,
    drawBackground: (target) => {
      if (!this.chart || this.times.length === 0) return;
      const scale = this.chart.timeScale();
      const coordinates = this.times.map((time) => scale.timeToCoordinate(time as Time));
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        context.fillStyle = "rgba(71, 85, 105, 0.12)";
        for (let index = 0; index < this.times.length; index += 1) {
          if (isUsRegularMarketHours(this.times[index])) continue;
          const x = coordinates[index];
          if (x == null) continue;
          const previous = coordinates[index - 1];
          const next = coordinates[index + 1];
          const left = previous == null ? x - ((next ?? x + 8) - x) / 2 : (previous + x) / 2;
          const right = next == null ? x + (x - (previous ?? x - 8)) / 2 : (x + next) / 2;
          if (right >= 0 && left <= mediaSize.width) context.fillRect(left, 0, right - left, mediaSize.height);
        }
      });
    },
  };

  private readonly view: IPrimitivePaneView = {
    zOrder: () => "bottom",
    renderer: () => this.renderer,
  };

  attached({ chart }: SeriesAttachedParameter<Time>) {
    this.chart = chart as IChartApi;
  }

  detached() {
    this.chart = null;
  }

  paneViews() {
    return [this.view];
  }

  setTimes(times: number[]) {
    this.times = times;
  }
}
