import type { Bar } from "../types";

export function sma(values: number[], period: number): Array<number | null> {
  let total = 0;
  return values.map((value, index) => {
    total += value;
    if (index >= period) total -= values[index - period];
    return index >= period - 1 ? total / period : null;
  });
}

export function ema(values: number[], period: number): Array<number | null> {
  if (!values.length) return [];
  const factor = 2 / (period + 1);
  let current = values[0];
  return values.map((value, index) => {
    current = index === 0 ? value : value * factor + current * (1 - factor);
    return index >= period - 1 ? current : null;
  });
}

export function vwap(bars: Bar[]): number[] {
  let pv = 0;
  let volume = 0;
  return bars.map((bar) => {
    const typical = (bar.high + bar.low + bar.close) / 3;
    pv += typical * bar.volume;
    volume += bar.volume;
    return volume ? pv / volume : typical;
  });
}

export function rsi(values: number[], period = 14): Array<number | null> {
  let gains = 0;
  let losses = 0;
  return values.map((value, index) => {
    if (index === 0) return null;
    const change = value - values[index - 1];
    gains = index <= period ? gains + Math.max(change, 0) : (gains * (period - 1) + Math.max(change, 0)) / period;
    losses = index <= period ? losses + Math.max(-change, 0) : (losses * (period - 1) + Math.max(-change, 0)) / period;
    if (index < period) return null;
    if (index === period) { gains /= period; losses /= period; }
    return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  });
}

export function validateTick(price: number, minMove: number): boolean {
  if (!Number.isFinite(price) || minMove <= 0) return false;
  return Math.abs(price / minMove - Math.round(price / minMove)) < 1e-8;
}

export function roundToTick(price: number, minMove: number): number {
  return Number((Math.round(price / minMove) * minMove).toFixed(10));
}
