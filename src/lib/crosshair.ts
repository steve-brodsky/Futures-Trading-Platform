export function nearestCandleExtreme(
  pointerY: number,
  highY: number,
  lowY: number,
  high: number,
  low: number,
): number {
  return Math.abs(pointerY - highY) <= Math.abs(pointerY - lowY) ? high : low;
}
