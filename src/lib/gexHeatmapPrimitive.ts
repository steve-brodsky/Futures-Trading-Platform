import type {
  IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, Time,
} from "lightweight-charts";
import type { GexExpirationDisplay, GexView } from "../types";
import {
  gexExpirationDisplayGroups,
  gexMagnitudeScale,
  type GexExpirationDisplayGroup,
  type GexLevel,
} from "./gex";

type ContributionMetric = "callGex" | "putGex" | "netGex" | "callOpenInterest" | "putOpenInterest";

function groupContributions(
  level: GexLevel,
  groups: GexExpirationDisplayGroup[],
  metric: ContributionMetric,
  sign?: "positive" | "negative",
) {
  const contributions = new Map(level.expirations.map((item) => [item.expirationDate, item]));
  return groups.map((group) => {
    const rawValue = group.dates.reduce((total, date) => total + (contributions.get(date)?.[metric] ?? 0), 0);
    const value = sign === "positive" ? Math.max(0, rawValue) : sign === "negative" ? Math.max(0, -rawValue) : Math.max(0, rawValue);
    return { color: group.color, value };
  }).filter((item) => item.value > 0);
}

function drawContributionStrip(
  context: CanvasRenderingContext2D,
  right: number,
  y: number,
  height: number,
  width: number,
  parts: Array<{ color: string; value: number }>,
) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!(total > 0) || !(width > 0) || !(height > 0)) return;
  let cursor = right;
  parts.forEach((part, index) => {
    const segmentWidth = index === parts.length - 1 ? cursor - (right - width) : width * part.value / total;
    cursor -= segmentWidth;
    context.fillStyle = part.color;
    context.fillRect(cursor, y, Math.max(0.5, segmentWidth - 0.5), height);
  });
}

function netContributionMagnitude(level: GexLevel, sign: "positive" | "negative") {
  return level.expirations.reduce((total, expiration) => total + (sign === "positive"
    ? Math.max(0, expiration.netGex)
    : Math.max(0, -expiration.netGex)), 0);
}

export class GexHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<any> | null = null;
  private requestUpdate?: () => void;
  private levels: GexLevel[] = [];
  private view: GexView = "net";
  private expirationDisplay: GexExpirationDisplay = "aggregate";
  private expirationDates: string[] = [];

  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      if (!this.series || !this.levels.length) return;
      const coordinates = this.levels.map((level) => ({ level, y: this.series!.priceToCoordinate(level.strike) }));
      const magnitudes = this.view === "net"
        ? this.levels.map((level) => Math.abs(level.netGex))
        : this.view === "open-interest"
          ? this.levels.flatMap((level) => [level.callOpenInterest, level.putOpenInterest])
          : this.levels.flatMap((level) => [level.callGex, level.putGex]);
      const expirationDates = this.expirationDates.length
        ? this.expirationDates
        : this.levels.flatMap((level) => level.expirations.map((item) => item.expirationDate));
      const expirationGroups = this.expirationDisplay === "aggregate-strip"
        ? gexExpirationDisplayGroups(expirationDates)
        : [];
      const showExpirationStrips = expirationGroups.length > 1;
      const netStripMagnitudes = showExpirationStrips && this.view === "net"
        ? this.levels.flatMap((level) => [netContributionMagnitude(level, "positive"), netContributionMagnitude(level, "negative")])
        : [];

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
          const stripHeight = Math.min(2, Math.max(1, bandHeight / 4));

          if (this.view === "net") {
            const scale = gexMagnitudeScale(level.netGex, magnitudes);
            if (scale) {
              const width = Math.max(2, maxWidth * scale);
              context.fillStyle = level.netGex >= 0
                ? `rgba(22, 199, 154, ${0.16 + scale * 0.62})`
                : `rgba(239, 70, 111, ${0.16 + scale * 0.62})`;
              context.fillRect(right - width, y - bandHeight / 2, width, bandHeight);
            }
            if (showExpirationStrips) {
              const positive = netContributionMagnitude(level, "positive");
              const negative = netContributionMagnitude(level, "negative");
              drawContributionStrip(
                context, right, y - bandHeight / 2, stripHeight,
                maxWidth * gexMagnitudeScale(positive, netStripMagnitudes),
                groupContributions(level, expirationGroups, "netGex", "positive"),
              );
              drawContributionStrip(
                context, right, y + bandHeight / 2 - stripHeight, stripHeight,
                maxWidth * gexMagnitudeScale(negative, netStripMagnitudes),
                groupContributions(level, expirationGroups, "netGex", "negative"),
              );
            }
            return;
          }

          const callValue = this.view === "open-interest" ? level.callOpenInterest : level.callGex;
          const putValue = this.view === "open-interest" ? level.putOpenInterest : level.putGex;
          const callMetric: ContributionMetric = this.view === "open-interest" ? "callOpenInterest" : "callGex";
          const putMetric: ContributionMetric = this.view === "open-interest" ? "putOpenInterest" : "putGex";
          const callScale = gexMagnitudeScale(callValue, magnitudes);
          const putScale = gexMagnitudeScale(putValue, magnitudes);
          const laneHeight = Math.max(1.5, bandHeight / 2 - 0.5);
          if (callScale) {
            const width = Math.max(2, maxWidth * callScale);
            context.fillStyle = `rgba(22, 199, 154, ${0.16 + callScale * 0.62})`;
            context.fillRect(right - width, y - bandHeight / 2, width, laneHeight);
            if (showExpirationStrips) drawContributionStrip(
              context, right, y - bandHeight / 2, Math.min(stripHeight, laneHeight), width,
              groupContributions(level, expirationGroups, callMetric),
            );
          }
          if (putScale) {
            const width = Math.max(2, maxWidth * putScale);
            context.fillStyle = `rgba(239, 70, 111, ${0.16 + putScale * 0.62})`;
            context.fillRect(right - width, y + 0.5, width, laneHeight);
            if (showExpirationStrips) drawContributionStrip(
              context, right, y + 0.5 + laneHeight - Math.min(stripHeight, laneHeight), Math.min(stripHeight, laneHeight), width,
              groupContributions(level, expirationGroups, putMetric),
            );
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

  setData(levels: GexLevel[], view: GexView, expirationDisplay: GexExpirationDisplay, expirationDates: string[]) {
    this.levels = levels;
    this.view = view;
    this.expirationDisplay = expirationDisplay;
    this.expirationDates = expirationDates;
    this.requestUpdate?.();
  }
}
