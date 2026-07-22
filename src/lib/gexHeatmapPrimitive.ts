import type {
  IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, Time,
} from "lightweight-charts";
import type { GexView } from "../types";
import { gexMagnitudeScale, type GexLevel } from "./gex";

export class GexHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<any> | null = null;
  private requestUpdate?: () => void;
  private levels: GexLevel[] = [];
  private view: GexView = "net";

  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      if (!this.series || !this.levels.length) return;
      const coordinates = this.levels.map((level) => ({ level, y: this.series!.priceToCoordinate(level.strike) }));
      const magnitudes = this.view === "net"
        ? this.levels.map((level) => Math.abs(level.netGex))
        : this.levels.flatMap((level) => [level.callGex, level.putGex]);
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        const maxWidth = Math.min(180, mediaSize.width * 0.22);
        const right = mediaSize.width;
        coordinates.forEach(({ level, y }, index) => {
          if (y == null || y < -12 || y > mediaSize.height + 12) return;
          const previousY = coordinates[index - 1]?.y;
          const nextY = coordinates[index + 1]?.y;
          const spacing = Math.min(
            previousY == null ? Number.POSITIVE_INFINITY : Math.abs(y - previousY),
            nextY == null ? Number.POSITIVE_INFINITY : Math.abs(nextY - y),
          );
          const bandHeight = Math.max(3, Math.min(18, Number.isFinite(spacing) ? spacing * 0.72 : 8));
          if (this.view === "net") {
            const scale = gexMagnitudeScale(level.netGex, magnitudes);
            if (!scale) return;
            const width = Math.max(2, maxWidth * scale);
            context.fillStyle = level.netGex >= 0
              ? `rgba(22, 199, 154, ${0.16 + scale * 0.62})`
              : `rgba(239, 70, 111, ${0.16 + scale * 0.62})`;
            context.fillRect(right - width, y - bandHeight / 2, width, bandHeight);
            return;
          }
          const callScale = gexMagnitudeScale(level.callGex, magnitudes);
          const putScale = gexMagnitudeScale(level.putGex, magnitudes);
          if (callScale) {
            const width = Math.max(2, maxWidth * callScale);
            context.fillStyle = `rgba(22, 199, 154, ${0.16 + callScale * 0.62})`;
            context.fillRect(right - width, y - bandHeight / 2, width, Math.max(1.5, bandHeight / 2 - 0.5));
          }
          if (putScale) {
            const width = Math.max(2, maxWidth * putScale);
            context.fillStyle = `rgba(239, 70, 111, ${0.16 + putScale * 0.62})`;
            context.fillRect(right - width, y + 0.5, width, Math.max(1.5, bandHeight / 2 - 0.5));
          }
        });
      });
    },
  };

  private readonly paneView: IPrimitivePaneView = {
    zOrder: () => "top",
    renderer: () => this.renderer,
  };

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.series = series as ISeriesApi<any>;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.series = null;
    this.requestUpdate = undefined;
  }

  paneViews() {
    return [this.paneView];
  }

  setData(levels: GexLevel[], view: GexView) {
    this.levels = levels;
    this.view = view;
    this.requestUpdate?.();
  }
}
