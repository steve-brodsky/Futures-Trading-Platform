import type { PositionDrawing } from "../types";

export interface PositionPlotPoint {
  plotTime: number;
  sourceTime: number;
}

export interface PositionMetrics {
  riskDistance: number;
  targetDistance: number;
  riskTicks: number;
  targetTicks: number;
  riskPercent: number;
  targetPercent: number;
  riskAmount: number;
  targetAmount: number;
  riskReward: number;
  openPnl: number;
}

const tick = (value: number) => Number.isFinite(value) && value > 0 ? value : 1;

export function snapPositionPrice(price: number, minMove: number): number {
  const size = tick(minMove);
  return Math.round(price / size) * size;
}

export function normalizePositionQuantity(value: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
}

export function isValidPositionDrawing(value: unknown): value is PositionDrawing {
  if (!value || typeof value !== "object") return false;
  const drawing = value as PositionDrawing;
  const finite = [drawing.startTime, drawing.endTime, drawing.entryPrice, drawing.stopPrice, drawing.targetPrice, drawing.quantity].every(Number.isFinite);
  if (drawing.kind !== "position" || !["long", "short"].includes(drawing.side) || typeof drawing.id !== "string" || !finite) return false;
  if (drawing.endTime <= drawing.startTime || drawing.quantity < 1 || !Number.isInteger(drawing.quantity)) return false;
  return drawing.side === "long"
    ? drawing.targetPrice > drawing.entryPrice && drawing.entryPrice > drawing.stopPrice
    : drawing.stopPrice > drawing.entryPrice && drawing.entryPrice > drawing.targetPrice;
}

function interval(points: PositionPlotPoint[], atEnd: boolean): number {
  if (points.length < 2) return 60;
  if (atEnd) {
    for (let index = points.length - 1; index > 0; index -= 1) {
      const difference = points[index].sourceTime - points[index - 1].sourceTime;
      if (difference > 0) return difference;
    }
  } else {
    for (let index = 1; index < points.length; index += 1) {
      const difference = points[index].sourceTime - points[index - 1].sourceTime;
      if (difference > 0) return difference;
    }
  }
  return 60;
}

export function logicalToSourceTime(logical: number, points: PositionPlotPoint[]): number {
  if (!points.length) return logical;
  if (points.length === 1) return points[0].sourceTime + logical * 60;
  if (logical <= 0) return points[0].sourceTime + logical * interval(points, false);
  const lastIndex = points.length - 1;
  if (logical >= lastIndex) return points[lastIndex].sourceTime + (logical - lastIndex) * interval(points, true);
  const left = Math.floor(logical);
  const fraction = logical - left;
  return points[left].sourceTime + (points[left + 1].sourceTime - points[left].sourceTime) * fraction;
}

export function sourceTimeToLogical(sourceTime: number, points: PositionPlotPoint[]): number {
  if (!points.length) return sourceTime;
  if (points.length === 1) return (sourceTime - points[0].sourceTime) / 60;
  if (sourceTime <= points[0].sourceTime) return (sourceTime - points[0].sourceTime) / interval(points, false);
  const lastIndex = points.length - 1;
  if (sourceTime >= points[lastIndex].sourceTime) return lastIndex + (sourceTime - points[lastIndex].sourceTime) / interval(points, true);
  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].sourceTime <= sourceTime) low = middle;
    else high = middle;
  }
  const duration = points[high].sourceTime - points[low].sourceTime;
  return low + (duration > 0 ? (sourceTime - points[low].sourceTime) / duration : 0);
}

export function createPositionDrawing(args: {
  id: string;
  side: PositionDrawing["side"];
  entryPrice: number;
  startTime: number;
  endTime: number;
  minMove: number;
}): PositionDrawing {
  const size = tick(args.minMove);
  const entryPrice = snapPositionPrice(args.entryPrice, size);
  const direction = args.side === "long" ? 1 : -1;
  return {
    id: args.id,
    kind: "position",
    side: args.side,
    startTime: args.startTime,
    endTime: Math.max(args.startTime + 1, args.endTime),
    entryPrice,
    stopPrice: snapPositionPrice(entryPrice - direction * size * 10, size),
    targetPrice: snapPositionPrice(entryPrice + direction * size * 20, size),
    quantity: 1,
    locked: false,
  };
}

export function updatePositionPrice(drawing: PositionDrawing, field: "entryPrice" | "stopPrice" | "targetPrice", value: number, minMove: number): PositionDrawing {
  const size = tick(minMove);
  let price = snapPositionPrice(value, size);
  if (drawing.side === "long") {
    if (field === "entryPrice") price = Math.max(drawing.stopPrice + size, Math.min(drawing.targetPrice - size, price));
    if (field === "stopPrice") price = Math.min(drawing.entryPrice - size, price);
    if (field === "targetPrice") price = Math.max(drawing.entryPrice + size, price);
  } else {
    if (field === "entryPrice") price = Math.max(drawing.targetPrice + size, Math.min(drawing.stopPrice - size, price));
    if (field === "stopPrice") price = Math.max(drawing.entryPrice + size, price);
    if (field === "targetPrice") price = Math.min(drawing.entryPrice - size, price);
  }
  return { ...drawing, [field]: price };
}

export function movePositionDrawing(drawing: PositionDrawing, timeDelta: number, priceDelta: number, minMove: number): PositionDrawing {
  const snappedDelta = snapPositionPrice(priceDelta, minMove);
  return {
    ...drawing,
    startTime: drawing.startTime + timeDelta,
    endTime: drawing.endTime + timeDelta,
    entryPrice: snapPositionPrice(drawing.entryPrice + snappedDelta, minMove),
    stopPrice: snapPositionPrice(drawing.stopPrice + snappedDelta, minMove),
    targetPrice: snapPositionPrice(drawing.targetPrice + snappedDelta, minMove),
  };
}

export function positionMetrics(drawing: PositionDrawing, minMove: number, pointValue: number, currentPrice: number): PositionMetrics {
  const riskDistance = Math.abs(drawing.entryPrice - drawing.stopPrice);
  const targetDistance = Math.abs(drawing.targetPrice - drawing.entryPrice);
  const direction = drawing.side === "long" ? 1 : -1;
  const multiplier = Math.max(0, pointValue) * drawing.quantity;
  return {
    riskDistance,
    targetDistance,
    riskTicks: Math.round(riskDistance / tick(minMove)),
    targetTicks: Math.round(targetDistance / tick(minMove)),
    riskPercent: drawing.entryPrice === 0 ? 0 : riskDistance / Math.abs(drawing.entryPrice) * 100,
    targetPercent: drawing.entryPrice === 0 ? 0 : targetDistance / Math.abs(drawing.entryPrice) * 100,
    riskAmount: riskDistance * multiplier,
    targetAmount: targetDistance * multiplier,
    riskReward: riskDistance === 0 ? 0 : targetDistance / riskDistance,
    openPnl: (currentPrice - drawing.entryPrice) * direction * multiplier,
  };
}
