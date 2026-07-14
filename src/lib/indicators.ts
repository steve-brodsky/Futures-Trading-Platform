import type { Bar } from "../types";
import { isNyRegularMarketHours, newYorkSessionTime } from "./nySession";

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

export interface SessionVwapValue {
  value: number | null;
  sessionKey?: string;
}

export function nySessionVwap(bars: Bar[]): SessionVwapValue[] {
  let pv = 0;
  let volume = 0;
  let sessionKey: string | undefined;
  return bars.map((bar) => {
    if (!isNyRegularMarketHours(bar.time)) return { value: null };
    const nextSessionKey = newYorkSessionTime(bar.time).sessionKey;
    if (nextSessionKey !== sessionKey) {
      sessionKey = nextSessionKey;
      pv = 0;
      volume = 0;
    }
    if (!Number.isFinite(bar.volume) || bar.volume <= 0) {
      return { value: volume > 0 ? pv / volume : null, sessionKey };
    }
    const typical = (bar.high + bar.low + bar.close) / 3;
    pv += typical * bar.volume;
    volume += bar.volume;
    return { value: pv / volume, sessionKey };
  });
}

export function validateTick(price: number, minMove: number): boolean {
  if (!Number.isFinite(price) || minMove <= 0) return false;
  return Math.abs(price / minMove - Math.round(price / minMove)) < 1e-8;
}

export function roundToTick(price: number, minMove: number): number {
  return Number((Math.round(price / minMove) * minMove).toFixed(10));
}

export function estimateOrderRisk(entryPrice: number, stopPrice: number, side: "Buy" | "Sell", quantity: number, minMove: number, tickValue: number): number | null {
  if (![entryPrice, stopPrice, quantity, minMove, tickValue].every(Number.isFinite) || entryPrice <= 0 || stopPrice <= 0 || quantity < 1 || minMove <= 0 || tickValue <= 0) return null;
  const priceRisk = side === "Buy" ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (priceRisk <= 0) return null;
  return Number(((priceRisk / minMove) * tickValue * quantity).toFixed(2));
}
