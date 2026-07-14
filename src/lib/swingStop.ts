import type { Bar } from "../types";

export interface SwingStopInput {
  bars: Bar[];
  side: "Buy" | "Sell";
  entryPrice: number;
  minMove: number;
  pivotBars: 2 | 3;
  offsetTicks: number;
}

const normalizePrice = (price: number) => Number(price.toFixed(10));

export function offsetBeyondSwing(swingPrice: number, side: "Buy" | "Sell", minMove: number, offsetTicks: number): number | null {
  if (!Number.isFinite(swingPrice) || swingPrice <= 0 || !Number.isFinite(minMove) || minMove <= 0
    || !Number.isInteger(offsetTicks) || offsetTicks < 1) return null;
  const tickPosition = swingPrice / minMove;
  const boundaryTick = side === "Buy"
    ? Math.floor(tickPosition + 1e-9)
    : Math.ceil(tickPosition - 1e-9);
  const stopTick = boundaryTick + (side === "Buy" ? -offsetTicks : offsetTicks);
  const stop = normalizePrice(stopTick * minMove);
  return stop > 0 ? stop : null;
}

export function calculateSwingStop({ bars, side, entryPrice, minMove, pivotBars, offsetTicks }: SwingStopInput): number | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(minMove) || minMove <= 0
    || !Number.isInteger(offsetTicks) || offsetTicks < 1 || ![2, 3].includes(pivotBars)) return null;

  const completed = bars.slice(0, -1);
  if (completed.length < pivotBars * 2 + 1) return null;

  for (let index = completed.length - pivotBars - 1; index >= pivotBars; index -= 1) {
    const pivot = completed[index];
    const neighbors = completed.slice(index - pivotBars, index).concat(completed.slice(index + 1, index + pivotBars + 1));
    if (side === "Buy") {
      if (!Number.isFinite(pivot.low) || !neighbors.every((bar) => Number.isFinite(bar.low) && pivot.low < bar.low)) continue;
      if (pivot.low >= entryPrice) continue;
      const stop = offsetBeyondSwing(pivot.low, side, minMove, offsetTicks);
      if (stop != null && stop < pivot.low && stop < entryPrice) return stop;
    } else {
      if (!Number.isFinite(pivot.high) || !neighbors.every((bar) => Number.isFinite(bar.high) && pivot.high > bar.high)) continue;
      if (pivot.high <= entryPrice) continue;
      const stop = offsetBeyondSwing(pivot.high, side, minMove, offsetTicks);
      if (stop != null && stop > pivot.high && stop > entryPrice) return stop;
    }
  }
  return null;
}
