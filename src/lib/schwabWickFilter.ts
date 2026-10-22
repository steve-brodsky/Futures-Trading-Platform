import type { Bar, SchwabWickFilterSettings, SymbolMeta, Timeframe } from "../types";
import { newYorkSessionTime } from "./nySession";
import { timeframeMinutes } from "./timeframes";

export const DEFAULT_SCHWAB_WICK_FILTER: SchwabWickFilterSettings = {
  enabled: false,
  maxWickPercent: 0.10,
};

export function normalizeSchwabWickFilter(
  value: unknown,
  fallback = DEFAULT_SCHWAB_WICK_FILTER,
): SchwabWickFilterSettings {
  const saved = value && typeof value === "object" ? value as Partial<SchwabWickFilterSettings> : {};
  return {
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : fallback.enabled,
    maxWickPercent: typeof saved.maxWickPercent === "number" && Number.isFinite(saved.maxWickPercent)
      ? Math.round(Math.max(0.01, Math.min(5, saved.maxWickPercent)) * 100) / 100
      : fallback.maxWickPercent,
  };
}

/** Derive chart values without changing the broker history, quotes, or alert inputs. */
export function filterSchwabWicks(
  bars: Bar[],
  instrument: Pick<SymbolMeta, "provider" | "assetType">,
  timeframe: Timeframe,
  settings: SchwabWickFilterSettings,
): Bar[] {
  const minutes = timeframeMinutes(timeframe);
  if (!settings.enabled || instrument.provider !== "schwab"
    || !["EQUITY", "ETF"].includes(instrument.assetType.toUpperCase()) || minutes == null) return bars;

  const fraction = normalizeSchwabWickFilter(settings).maxWickPercent / 100;
  // Every New York regular session falls on the same UTC calendar date.
  // Cache each day's bounds so a long history needs only one timezone lookup per day.
  const sessions = new Map<number, [number, number] | null>();
  const overlapsRegularSession = (start: number): boolean => {
    const end = start + minutes * 60;
    for (let day = Math.floor(start / 86_400) * 86_400; day < end; day += 86_400) {
      if (!sessions.has(day)) {
        // At UTC noon, New York is already past its DST transition hour.
        const local = newYorkSessionTime(day + 12 * 3_600);
        const offsetMinutes = local.minuteOfDay - 12 * 60;
        sessions.set(day, local.weekday === "Sat" || local.weekday === "Sun" ? null : [
          day + (9 * 60 + 30 - offsetMinutes) * 60,
          day + (16 * 60 - offsetMinutes) * 60,
        ]);
      }
      const session = sessions.get(day);
      if (session && start < session[1] && end > session[0]) return true;
    }
    return false;
  };

  let changed = false;
  const filtered = bars.map((bar) => {
    if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
      || bar.time <= 0 || Math.min(bar.open, bar.close) <= 0
      || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)
      || overlapsRegularSession(bar.time)) return bar;
    const high = Math.min(bar.high, Math.max(bar.open, bar.close) * (1 + fraction));
    const low = Math.max(bar.low, Math.min(bar.open, bar.close) * (1 - fraction));
    if (high === bar.high && low === bar.low) return bar;
    changed = true;
    return { ...bar, high, low };
  });
  return changed ? filtered : bars;
}
