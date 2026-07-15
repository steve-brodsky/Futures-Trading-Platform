import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesWhitespaceData,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
} from "lightweight-charts";

export interface PointAndFigureSeriesData extends CustomData<Time> {
  time: Time;
  sourceTime: number;
  direction: "x" | "o";
  boxes: number[];
  high: number;
  low: number;
  close: number;
  boxSize: number;
  provisional: boolean;
}

export interface PointAndFigureSeriesOptions extends CustomSeriesOptions {
  upColor: string;
  downColor: string;
}

class PointAndFigureRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, PointAndFigureSeriesData> | null = null;
  private options: PointAndFigureSeriesOptions | null = null;

  update(data: PaneRendererCustomData<Time, PointAndFigureSeriesData>, options: PointAndFigureSeriesOptions) {
    this.data = data;
    this.options = options;
  }

  draw(target: Parameters<ICustomSeriesPaneRenderer["draw"]>[0], priceConverter: PriceToCoordinateConverter) {
    if (!this.data || !this.options || !this.data.visibleRange) return;
    const { bars, barSpacing, visibleRange } = this.data;
    const from = Math.max(0, visibleRange.from);
    const to = Math.min(bars.length, visibleRange.to);
    const options = this.options;

    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";
      for (let index = from; index < to; index += 1) {
        const item = bars[index];
        const column = item.originalData;
        const highY = priceConverter(column.high);
        const lowY = priceConverter(column.low);
        if (highY == null || lowY == null) continue;
        const boxHeight = Math.abs((priceConverter(column.close + column.boxSize) ?? highY) - (priceConverter(column.close) ?? lowY));
        const width = Math.max(2, Math.min(18, barSpacing * .72));
        context.strokeStyle = column.direction === "x" ? options.upColor : options.downColor;
        context.lineWidth = Math.max(1, Math.min(2, width * .16));
        context.globalAlpha = column.provisional ? .48 : 1;

        if (width < 5 || boxHeight < 5) {
          context.beginPath();
          context.moveTo(item.x, highY);
          context.lineTo(item.x, lowY);
          context.stroke();
          continue;
        }

        const glyphSize = Math.max(3, Math.min(width * .72, boxHeight * .72));
        for (const price of column.boxes) {
          const y = priceConverter(price);
          if (y == null) continue;
          const half = glyphSize / 2;
          context.beginPath();
          if (column.direction === "x") {
            context.moveTo(item.x - half, y - half);
            context.lineTo(item.x + half, y + half);
            context.moveTo(item.x + half, y - half);
            context.lineTo(item.x - half, y + half);
          } else {
            context.ellipse(item.x, y, half, half, 0, 0, Math.PI * 2);
          }
          context.stroke();
        }
      }
      context.restore();
    });
  }
}

export class PointAndFigureSeries implements ICustomSeriesPaneView<Time, PointAndFigureSeriesData, PointAndFigureSeriesOptions> {
  private readonly paneRenderer = new PointAndFigureRenderer();

  renderer() { return this.paneRenderer; }
  update(data: PaneRendererCustomData<Time, PointAndFigureSeriesData>, options: PointAndFigureSeriesOptions) { this.paneRenderer.update(data, options); }
  priceValueBuilder(row: PointAndFigureSeriesData) { return [row.high, row.low, row.close]; }
  isWhitespace(data: PointAndFigureSeriesData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> { return !("boxes" in data); }
  defaultOptions(): PointAndFigureSeriesOptions {
    return { ...customSeriesDefaultOptions, upColor: "#16c79a", downColor: "#ef466f" };
  }
}
