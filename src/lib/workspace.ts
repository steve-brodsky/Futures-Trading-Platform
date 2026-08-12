import type { FailedBreakoutIndicatorConfig, IndicatorConfig, PriceOverlayIndicatorConfig } from "../types";

export const defaultIndicators: IndicatorConfig[] = [
  { id: "ema20", kind: "EMA", period: 20, color: "#f0b84b", visible: true },
  { id: "ema200", kind: "EMA", period: 200, color: "#ef466f", visible: true },
  { id: "vwap", kind: "VWAP", period: 1, color: "#a879ff", visible: true },
  { id: "sma50", kind: "SMA", period: 50, color: "#37d5e8", visible: false },
  { id: "failed-breakout", kind: "FAILED_BREAKOUT", visible: false, pivotBars: 2, toleranceTicks: 4, reclaimBars: 3, pairMode: "consecutive" },
];

const retiredIndicatorKinds = new Set<string>(["RSI", "MACD"]);
const priceOverlayKinds = new Set<string>(["SMA", "EMA", "VWAP"]);

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeFailedBreakoutIndicator(value: Record<string, unknown>): FailedBreakoutIndicatorConfig {
  return {
    id: "failed-breakout",
    kind: "FAILED_BREAKOUT",
    visible: typeof value.visible === "boolean" ? value.visible : false,
    pivotBars: clampInteger(value.pivotBars, 2, 1, 3) as 1 | 2 | 3,
    toleranceTicks: clampInteger(value.toleranceTicks, 4, 0, 100),
    reclaimBars: clampInteger(value.reclaimBars, 3, 1, 100),
    pairMode: value.pairMode === "latest-matching" ? "latest-matching" : "consecutive",
  };
}

function normalizeSavedIndicator(value: unknown): IndicatorConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const indicator = value as Record<string, unknown>;
  if (retiredIndicatorKinds.has(String(indicator.kind))) return undefined;
  if (indicator.kind === "FAILED_BREAKOUT") return normalizeFailedBreakoutIndicator(indicator);
  if (!priceOverlayKinds.has(String(indicator.kind)) || typeof indicator.id !== "string") return undefined;
  if (typeof indicator.period !== "number" || !Number.isFinite(indicator.period)
    || typeof indicator.color !== "string" || typeof indicator.visible !== "boolean") return undefined;
  return {
    id: indicator.id,
    kind: indicator.kind as PriceOverlayIndicatorConfig["kind"],
    period: indicator.period,
    color: indicator.color,
    visible: indicator.visible,
  };
}

export function normalizeMagnetEnabled(saved: boolean | undefined): boolean {
  return saved ?? false;
}

export function normalizeIndicators(saved: unknown): IndicatorConfig[] {
  if (!Array.isArray(saved)) return defaultIndicators.map((indicator) => ({ ...indicator }));

  const supportedSaved = saved.flatMap((indicator) => {
    const normalized = normalizeSavedIndicator(indicator);
    return normalized ? [normalized] : [];
  });
  const savedById = new Map(supportedSaved.map((indicator) => [indicator.id, indicator]));
  const known = defaultIndicators.map((indicator) => {
    const savedIndicator = savedById.get(indicator.id);
    if (indicator.kind === "FAILED_BREAKOUT") {
      return savedIndicator?.kind === "FAILED_BREAKOUT" ? savedIndicator : { ...indicator };
    }
    return savedIndicator?.kind !== "FAILED_BREAKOUT" ? savedIndicator ?? { ...indicator } : { ...indicator };
  });
  const defaultIds = new Set(defaultIndicators.map((indicator) => indicator.id));
  return [...known, ...supportedSaved.filter((indicator) => !defaultIds.has(indicator.id))];
}
