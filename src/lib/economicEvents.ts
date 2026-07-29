import type {
  ChartEconomicEventSettings,
  ChartKind,
  EconomicEvent,
  EconomicEventImpact,
  EconomicEventImportance,
  Timeframe,
} from "../types";
import { sourceTimeToLogical, type PositionPlotPoint } from "./positionDrawing";

export const DEFAULT_CHART_ECONOMIC_EVENT_SETTINGS: ChartEconomicEventSettings = {
  enabled: false,
  impactVisibility: {
    high: true,
    medium: true,
    low: true,
    unrated: true,
  },
};

export function economicEventImpact(importance: EconomicEventImportance): EconomicEventImpact {
  if (importance === 3) return "high";
  if (importance === 2) return "medium";
  if (importance === 1) return "low";
  return "unrated";
}

export function economicEventImpactLabel(importance: EconomicEventImportance): string {
  const impact = economicEventImpact(importance);
  return impact === "unrated" ? "Unrated impact" : `${impact[0].toUpperCase()}${impact.slice(1)} impact`;
}

export function normalizeChartEconomicEventSettings(
  value: unknown,
  fallback: ChartEconomicEventSettings = DEFAULT_CHART_ECONOMIC_EVENT_SETTINGS,
): ChartEconomicEventSettings {
  const saved = value && typeof value === "object" ? value as Partial<ChartEconomicEventSettings> : {};
  const visibility = saved.impactVisibility && typeof saved.impactVisibility === "object"
    ? saved.impactVisibility as Partial<Record<EconomicEventImpact, unknown>>
    : {};
  return {
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : fallback.enabled,
    impactVisibility: {
      high: typeof visibility.high === "boolean" ? visibility.high : fallback.impactVisibility.high,
      medium: typeof visibility.medium === "boolean" ? visibility.medium : fallback.impactVisibility.medium,
      low: typeof visibility.low === "boolean" ? visibility.low : fallback.impactVisibility.low,
      unrated: typeof visibility.unrated === "boolean" ? visibility.unrated : fallback.impactVisibility.unrated,
    },
  };
}

export function economicEventsEligible(kind: ChartKind, timeframe: Timeframe): boolean {
  return ["candles", "line", "area"].includes(kind) && !["D", "W", "M"].includes(timeframe);
}

export function visibleEconomicEvents(
  events: EconomicEvent[],
  settings: ChartEconomicEventSettings,
): EconomicEvent[] {
  if (!settings.enabled) return [];
  return [...events]
    .filter((event) => settings.impactVisibility[economicEventImpact(event.importance)])
    .filter((event) => Number.isFinite(Date.parse(event.occursAt)))
    .sort((left, right) => Date.parse(left.occursAt) - Date.parse(right.occursAt) || left.id.localeCompare(right.id));
}

export function economicEventLogicalPosition(event: EconomicEvent, points: PositionPlotPoint[]): number | null {
  const milliseconds = Date.parse(event.occursAt);
  if (!Number.isFinite(milliseconds) || !points.length) return null;
  return sourceTimeToLogical(milliseconds / 1000, points);
}

export interface EconomicEventCoordinate {
  event: EconomicEvent;
  x: number;
}

export interface EconomicEventCluster {
  id: string;
  x: number;
  impact: EconomicEventImpact;
  events: EconomicEvent[];
}

const impactRank: Record<EconomicEventImpact, number> = {
  unrated: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export function clusterEconomicEventCoordinates(
  coordinates: EconomicEventCoordinate[],
  minimumDistance = 18,
): EconomicEventCluster[] {
  const sorted = [...coordinates]
    .filter((item) => Number.isFinite(item.x))
    .sort((left, right) => left.x - right.x || Date.parse(left.event.occursAt) - Date.parse(right.event.occursAt));
  const groups: EconomicEventCoordinate[][] = [];
  for (const item of sorted) {
    const group = groups.at(-1);
    if (!group || item.x - group.at(-1)!.x >= minimumDistance) groups.push([item]);
    else group.push(item);
  }
  return groups.map((group) => {
    const events = group.map((item) => item.event)
      .sort((left, right) => Date.parse(left.occursAt) - Date.parse(right.occursAt) || left.id.localeCompare(right.id));
    const impact = events.reduce<EconomicEventImpact>((highest, event) => {
      const candidate = economicEventImpact(event.importance);
      return impactRank[candidate] > impactRank[highest] ? candidate : highest;
    }, "unrated");
    return {
      id: events.map((event) => event.id).join("|"),
      x: group.reduce((sum, item) => sum + item.x, 0) / group.length,
      impact,
      events,
    };
  });
}
