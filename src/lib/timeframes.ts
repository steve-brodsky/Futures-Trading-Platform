import type { Timeframe, WorkspaceState } from "../types";

export const MIN_CUSTOM_MINUTES = 1;
export const MAX_CUSTOM_MINUTES = 1_440;

export const BUILT_IN_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "D", "W", "M"] as const satisfies readonly Timeframe[];
export const BUILT_IN_INTRADAY_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h"] as const satisfies readonly Timeframe[];

const builtInTimeframes = new Set<Timeframe>(BUILT_IN_TIMEFRAMES);
const reservedMinuteValues = new Set([1, 5, 15, 30, 60, 240]);

export function parseMinuteTimeframe(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([1-9]\d*)m$/.exec(value);
  if (!match) return undefined;
  const minutes = Number(match[1]);
  return Number.isSafeInteger(minutes) && minutes >= MIN_CUSTOM_MINUTES && minutes <= MAX_CUSTOM_MINUTES
    ? minutes
    : undefined;
}

export function minuteTimeframe(minutes: number): Timeframe {
  return `${minutes}m` as Timeframe;
}

export function timeframeMinutes(timeframe: Timeframe): number | undefined {
  if (timeframe === "1h") return 60;
  if (timeframe === "4h") return 240;
  return parseMinuteTimeframe(timeframe);
}

export function timeframeSeconds(timeframe: Timeframe): number | undefined {
  const minutes = timeframeMinutes(timeframe);
  if (minutes != null) return minutes * 60;
  if (timeframe === "D") return 86_400;
  if (timeframe === "W") return 7 * 86_400;
  return undefined;
}

export function isBuiltInTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && builtInTimeframes.has(value as Timeframe);
}

export function isReservedMinuteValue(minutes: number): boolean {
  return reservedMinuteValues.has(minutes);
}

export function normalizeCustomMinuteTimeframes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is number => (
    typeof item === "number"
    && Number.isSafeInteger(item)
    && item >= MIN_CUSTOM_MINUTES
    && item <= MAX_CUSTOM_MINUTES
    && !isReservedMinuteValue(item)
  )))].sort((left, right) => left - right);
}

export function normalizeTimeframe(value: unknown, customMinutes: number[], fallback: Timeframe = "1m"): Timeframe {
  if (isBuiltInTimeframe(value)) return value;
  const minutes = parseMinuteTimeframe(value);
  if (minutes != null && customMinutes.includes(minutes) && !isReservedMinuteValue(minutes)) return minuteTimeframe(minutes);
  if (isBuiltInTimeframe(fallback)) return fallback;
  const fallbackMinutes = parseMinuteTimeframe(fallback);
  return fallbackMinutes != null && customMinutes.includes(fallbackMinutes) ? fallback : "1m";
}

export function orderedToolbarTimeframes(customMinutes: number[]): Timeframe[] {
  return [
    ...BUILT_IN_INTRADAY_TIMEFRAMES,
    ...normalizeCustomMinuteTimeframes(customMinutes).map(minuteTimeframe),
  ].sort((left, right) => timeframeMinutes(left)! - timeframeMinutes(right)!)
    .concat(["D", "W", "M"]);
}

export type CustomTimeframeValidation =
  | { minutes: number; error?: undefined }
  | { minutes?: undefined; error: string };

export function validateCustomMinuteInput(value: string, existingMinutes: number[]): CustomTimeframeValidation {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { error: "Enter a whole number of minutes." };
  const minutes = Number(trimmed);
  if (!Number.isSafeInteger(minutes) || minutes < MIN_CUSTOM_MINUTES || minutes > MAX_CUSTOM_MINUTES) {
    return { error: `Use a value from ${MIN_CUSTOM_MINUTES} to ${MAX_CUSTOM_MINUTES.toLocaleString()}.` };
  }
  if (isReservedMinuteValue(minutes) || existingMinutes.includes(minutes)) return { error: "That timeframe is already on the toolbar." };
  return { minutes };
}

export function workspaceForPersistence(
  workspace: WorkspaceState,
  sessionCustomMinutes: number[],
  persistentTimeframes: ReadonlyMap<string, Timeframe>,
): WorkspaceState {
  const transient = new Set(normalizeCustomMinuteTimeframes(sessionCustomMinutes));
  return {
    ...workspace,
    customMinuteTimeframes: normalizeCustomMinuteTimeframes(workspace.customMinuteTimeframes),
    tabs: workspace.tabs.map((tab) => {
      const minutes = parseMinuteTimeframe(tab.timeframe);
      if (minutes == null || !transient.has(minutes) || workspace.customMinuteTimeframes.includes(minutes)) return tab;
      return { ...tab, timeframe: persistentTimeframes.get(tab.id) ?? "1m" };
    }),
  };
}

export function saveCustomMinuteTimeframe(workspace: WorkspaceState, minutes: number): WorkspaceState {
  return {
    ...workspace,
    customMinuteTimeframes: normalizeCustomMinuteTimeframes([...workspace.customMinuteTimeframes, minutes]),
  };
}

export function removeCustomMinuteTimeframe(workspace: WorkspaceState, minutes: number): WorkspaceState {
  const timeframe = minuteTimeframe(minutes);
  return {
    ...workspace,
    customMinuteTimeframes: workspace.customMinuteTimeframes.filter((item) => item !== minutes),
    tabs: workspace.tabs.map((tab) => tab.timeframe === timeframe ? { ...tab, timeframe: "1m" } : tab),
  };
}
