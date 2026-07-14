import type { IndicatorConfig } from "../types";

export const defaultIndicators: IndicatorConfig[] = [
  { id: "ema20", kind: "EMA", period: 20, color: "#f0b84b", visible: true },
  { id: "ema200", kind: "EMA", period: 200, color: "#ef466f", visible: true },
  { id: "vwap", kind: "VWAP", period: 1, color: "#a879ff", visible: true },
  { id: "sma50", kind: "SMA", period: 50, color: "#37d5e8", visible: false },
];

const retiredIndicatorKinds = new Set<string>(["RSI", "MACD"]);

export function normalizeMagnetEnabled(saved: boolean | undefined): boolean {
  return saved ?? false;
}

export function normalizeIndicators(saved: IndicatorConfig[] | undefined): IndicatorConfig[] {
  if (!saved) return defaultIndicators.map((indicator) => ({ ...indicator }));

  const supportedSaved = saved.filter((indicator) => !retiredIndicatorKinds.has(indicator.kind));
  const savedById = new Map(supportedSaved.map((indicator) => [indicator.id, indicator]));
  const known = defaultIndicators.map((indicator) => ({
    ...indicator,
    ...savedById.get(indicator.id),
  }));
  const defaultIds = new Set(defaultIndicators.map((indicator) => indicator.id));
  return [...known, ...supportedSaved.filter((indicator) => !defaultIds.has(indicator.id))];
}
