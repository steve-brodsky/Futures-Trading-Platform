import type { Bar, PointAndFigureSettings, RenkoSettings, SyntheticPriceSource } from "../types";

export interface RenkoBrick {
  plotTime: number;
  sourceTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  direction: "up" | "down";
  provisional: boolean;
}

export interface PointAndFigureColumn {
  plotTime: number;
  sourceTime: number;
  direction: "x" | "o";
  boxes: number[];
  high: number;
  low: number;
  close: number;
  provisional: boolean;
}

interface PricePoint {
  time: number;
  ticks: number;
  provisional: boolean;
}

const clampInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
};

export const defaultRenkoSettings = (): RenkoSettings => ({ brickSizeTicks: 4, priceSource: "close", reversalBricks: 2 });
export const defaultPointAndFigureSettings = (): PointAndFigureSettings => ({ boxSizeTicks: 4, priceSource: "close", reversalBoxes: 3 });

export function normalizeRenkoSettings(value?: Partial<RenkoSettings>): RenkoSettings {
  return {
    brickSizeTicks: clampInteger(value?.brickSizeTicks, 4, 1, 10_000),
    priceSource: value?.priceSource === "high-low" ? "high-low" : "close",
    reversalBricks: value?.reversalBricks === 1 ? 1 : 2,
  };
}

export function normalizePointAndFigureSettings(value?: Partial<PointAndFigureSettings>): PointAndFigureSettings {
  return {
    boxSizeTicks: clampInteger(value?.boxSizeTicks, 4, 1, 10_000),
    priceSource: value?.priceSource === "high-low" ? "high-low" : "close",
    reversalBoxes: clampInteger(value?.reversalBoxes, 3, 1, 10),
  };
}

const priceToTicks = (price: number, minMove: number) => Math.round(price / minMove);
const ticksToPrice = (ticks: number, minMove: number) => Number((ticks * minMove).toFixed(10));
const plotTime = (sourceTime: number, ordinal: number) => sourceTime + ordinal / 1_000_000;

function barPrices(bar: Bar, source: SyntheticPriceSource): number[] {
  if (source === "close") return [bar.close];
  return bar.close >= bar.open
    ? [bar.open, bar.low, bar.high, bar.close]
    : [bar.open, bar.high, bar.low, bar.close];
}

function pricePoints(bars: Bar[], source: SyntheticPriceSource, minMove: number): PricePoint[] {
  return bars.flatMap((bar) => barPrices(bar, source).map((price) => ({
    time: bar.time,
    ticks: priceToTicks(price, minMove),
    provisional: bar.realtime === true,
  })));
}

export function buildRenko(bars: Bar[], minMove: number, rawSettings: Partial<RenkoSettings> = {}): RenkoBrick[] {
  if (!Number.isFinite(minMove) || minMove <= 0) return [];
  const settings = normalizeRenkoSettings(rawSettings);
  const points = pricePoints(bars, settings.priceSource, minMove);
  if (!points.length) return [];

  const bricks: RenkoBrick[] = [];
  const ordinals = new Map<number, number>();
  const nextPlotTime = (time: number) => {
    const ordinal = ordinals.get(time) ?? 0;
    ordinals.set(time, ordinal + 1);
    return plotTime(time, ordinal);
  };
  const size = settings.brickSizeTicks;
  let lastClose = points[0].ticks;
  let direction: RenkoBrick["direction"] | null = null;

  const add = (open: number, close: number, point: PricePoint) => {
    const next: RenkoBrick = {
      plotTime: nextPlotTime(point.time),
      sourceTime: point.time,
      open: ticksToPrice(open, minMove),
      high: ticksToPrice(Math.max(open, close), minMove),
      low: ticksToPrice(Math.min(open, close), minMove),
      close: ticksToPrice(close, minMove),
      direction: close > open ? "up" : "down",
      provisional: point.provisional,
    };
    bricks.push(next);
    lastClose = close;
    direction = next.direction;
  };

  for (const point of points.slice(1)) {
    if (direction == null) {
      while (point.ticks >= lastClose + size) add(lastClose, lastClose + size, point);
      while (point.ticks <= lastClose - size) add(lastClose, lastClose - size, point);
      continue;
    }
    if (direction === "up") {
      while (point.ticks >= lastClose + size) add(lastClose, lastClose + size, point);
      if (point.ticks <= lastClose - settings.reversalBricks * size) {
        const close = lastClose - settings.reversalBricks * size;
        add(settings.reversalBricks === 2 ? lastClose - size : lastClose, close, point);
        while (point.ticks <= lastClose - size) add(lastClose, lastClose - size, point);
      }
    } else {
      while (point.ticks <= lastClose - size) add(lastClose, lastClose - size, point);
      if (point.ticks >= lastClose + settings.reversalBricks * size) {
        const close = lastClose + settings.reversalBricks * size;
        add(settings.reversalBricks === 2 ? lastClose + size : lastClose, close, point);
        while (point.ticks >= lastClose + size) add(lastClose, lastClose + size, point);
      }
    }
  }
  return bricks;
}

export function buildPointAndFigure(bars: Bar[], minMove: number, rawSettings: Partial<PointAndFigureSettings> = {}): PointAndFigureColumn[] {
  if (!Number.isFinite(minMove) || minMove <= 0) return [];
  const settings = normalizePointAndFigureSettings(rawSettings);
  const points = pricePoints(bars, settings.priceSource, minMove);
  if (!points.length) return [];

  const columns: PointAndFigureColumn[] = [];
  const ordinals = new Map<number, number>();
  const nextPlotTime = (time: number) => {
    const ordinal = ordinals.get(time) ?? 0;
    ordinals.set(time, ordinal + 1);
    return plotTime(time, ordinal);
  };
  const size = settings.boxSizeTicks;
  let anchor = points[0].ticks;
  let direction: PointAndFigureColumn["direction"] | null = null;
  let low = anchor;
  let high = anchor;

  const syncColumn = (column: PointAndFigureColumn, boxTicks: number[], point: PricePoint) => {
    column.boxes = boxTicks.map((ticks) => ticksToPrice(ticks, minMove));
    column.low = ticksToPrice(Math.min(...boxTicks), minMove);
    column.high = ticksToPrice(Math.max(...boxTicks), minMove);
    column.close = column.direction === "x" ? column.high : column.low;
    column.sourceTime = point.time;
    column.provisional = column.provisional || point.provisional;
  };

  const createColumn = (columnDirection: PointAndFigureColumn["direction"], boxTicks: number[], point: PricePoint) => {
    const column: PointAndFigureColumn = {
      plotTime: nextPlotTime(point.time), sourceTime: point.time, direction: columnDirection,
      boxes: [], high: 0, low: 0, close: 0, provisional: point.provisional,
    };
    syncColumn(column, boxTicks, point);
    columns.push(column);
    direction = columnDirection;
    low = Math.min(...boxTicks);
    high = Math.max(...boxTicks);
  };

  for (const point of points.slice(1)) {
    if (direction == null) {
      if (point.ticks >= anchor + size) {
        const boxes: number[] = [];
        for (let level = anchor + size; level <= point.ticks; level += size) boxes.push(level);
        createColumn("x", boxes, point);
      } else if (point.ticks <= anchor - size) {
        const boxes: number[] = [];
        for (let level = anchor - size; level >= point.ticks; level -= size) boxes.push(level);
        createColumn("o", boxes, point);
      }
      continue;
    }

    const current = columns[columns.length - 1];
    const currentTicks = current.boxes.map((price) => priceToTicks(price, minMove));
    if (direction === "x") {
      if (point.ticks >= high + size) {
        for (let level = high + size; level <= point.ticks; level += size) currentTicks.push(level);
        high = Math.max(...currentTicks);
        syncColumn(current, currentTicks, point);
      } else if (point.ticks <= high - settings.reversalBoxes * size) {
        const boxes: number[] = [];
        for (let level = high - size; level >= point.ticks; level -= size) boxes.push(level);
        createColumn("o", boxes, point);
      }
    } else if (point.ticks <= low - size) {
      for (let level = low - size; level >= point.ticks; level -= size) currentTicks.push(level);
      low = Math.min(...currentTicks);
      syncColumn(current, currentTicks, point);
    } else if (point.ticks >= low + settings.reversalBoxes * size) {
      const boxes: number[] = [];
      for (let level = low + size; level <= point.ticks; level += size) boxes.push(level);
      createColumn("x", boxes, point);
    }
  }
  return columns;
}
