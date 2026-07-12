import type { IndicatorConfig } from "../types";

export const defaultIndicators: IndicatorConfig[] = [
  { id: "ema20", kind: "EMA", period: 20, color: "#f0b84b", visible: true },
  { id: "ema200", kind: "EMA", period: 200, color: "#ef466f", visible: true },
  { id: "vwap", kind: "VWAP", period: 1, color: "#a879ff", visible: true },
  { id: "sma50", kind: "SMA", period: 50, color: "#37d5e8", visible: false },
  { id: "rsi14", kind: "RSI", period: 14, color: "#ff7ac6", visible: false },
  { id: "macd", kind: "MACD", period: 12, color: "#47b6ff", visible: false },
];

export function normalizeIndicators(saved: IndicatorConfig[] | undefined): IndicatorConfig[] {
  if (!saved) return defaultIndicators.map((indicator) => ({ ...indicator }));

  const savedById = new Map(saved.map((indicator) => [indicator.id, indicator]));
  const known = defaultIndicators.map((indicator) => ({
    ...indicator,
    ...savedById.get(indicator.id),
  }));
  const defaultIds = new Set(defaultIndicators.map((indicator) => indicator.id));
  return [...known, ...saved.filter((indicator) => !defaultIds.has(indicator.id))];
}
