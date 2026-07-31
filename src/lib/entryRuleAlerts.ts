import type {
  AlertDurationSeconds, AlertSound, Bar, EntryRuleAlertConfig, EntryRuleResult, EntryRules,
  EntryRuleSide, Quote, Timeframe,
} from "../types";
import { ALERT_DURATIONS, ALERT_SOUNDS, alertMarketKey } from "./emaAlerts";
import { evaluateEntryRules } from "./entryRules";

const alertSounds = new Set<AlertSound>(ALERT_SOUNDS.map((item) => item.value));
const alertDurations = new Set<AlertDurationSeconds>(ALERT_DURATIONS);

export function defaultEntryRuleAlerts(): EntryRuleAlertConfig {
  return {
    long: { enabled: false, sound: "chime", durationSeconds: 3 },
    short: { enabled: false, sound: "chime", durationSeconds: 3 },
  };
}

export function normalizeEntryRuleAlerts(value: unknown): EntryRuleAlertConfig {
  const source = value && typeof value === "object"
    ? value as Partial<Record<EntryRuleSide, { enabled?: unknown; sound?: unknown; durationSeconds?: unknown }>>
    : {};
  const fallback = defaultEntryRuleAlerts();
  return Object.fromEntries((["long", "short"] as const).map((side) => {
    const saved = source[side];
    return [side, {
      enabled: saved?.enabled === true,
      sound: alertSounds.has(saved?.sound as AlertSound) ? saved!.sound as AlertSound : fallback[side].sound,
      durationSeconds: alertDurations.has(saved?.durationSeconds as AlertDurationSeconds)
        ? saved!.durationSeconds as AlertDurationSeconds
        : fallback[side].durationSeconds,
    }];
  })) as EntryRuleAlertConfig;
}

export function sameEntryRuleAlerts(left: EntryRuleAlertConfig, right: EntryRuleAlertConfig): boolean {
  return (["long", "short"] as const).every((side) => left[side].enabled === right[side].enabled
    && left[side].sound === right[side].sound
    && left[side].durationSeconds === right[side].durationSeconds);
}

export function entryRuleAlertEpoch(scope: string, rules: EntryRules, alerts: EntryRuleAlertConfig): string {
  return `${scope}\u0000${alerts.long.enabled}\u0000${alerts.short.enabled}\u0000${JSON.stringify(rules)}`;
}

export interface EntryRuleAlertMarketInput {
  tabId: string;
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
  quote: Quote;
  hasOpenPosition: boolean;
}

export interface EntryRuleAlertTrackerState {
  epoch: string;
  statuses: Record<string, EntryRuleResult["status"]>;
}

export interface EntryRuleAlertTransition {
  key: string;
  symbol: string;
  timeframe: Timeframe;
  side: EntryRuleSide;
  reason: string;
  tabIds: string[];
}

export function trackEntryRuleAlertTransitions(
  previous: EntryRuleAlertTrackerState | undefined,
  epoch: string,
  rules: EntryRules,
  alerts: EntryRuleAlertConfig,
  inputs: EntryRuleAlertMarketInput[],
  evaluatedAt: number | Date = Date.now(),
): { state: EntryRuleAlertTrackerState; transitions: EntryRuleAlertTransition[] } {
  const markets = new Map<string, EntryRuleAlertMarketInput & { tabIds: string[] }>();
  inputs.forEach((input) => {
    const key = alertMarketKey(input.symbol, input.timeframe);
    const existing = markets.get(key);
    if (existing) {
      if (!existing.tabIds.includes(input.tabId)) existing.tabIds.push(input.tabId);
      existing.hasOpenPosition ||= input.hasOpenPosition;
      return;
    }
    markets.set(key, { ...input, tabIds: [input.tabId] });
  });

  const statuses: Record<string, EntryRuleResult["status"]> = {};
  const transitions: EntryRuleAlertTransition[] = [];
  const canTrigger = previous?.epoch === epoch;
  markets.forEach((market, marketKey) => {
    const evaluation = evaluateEntryRules(rules, market.bars, market.quote, evaluatedAt);
    (["long", "short"] as const).forEach((side) => {
      if (!rules.allowEntries[side] || !alerts[side].enabled || rules[side].children.length === 0) return;
      const key = `${marketKey}\u0000${side}`;
      const result = evaluation[side];
      const status = market.hasOpenPosition ? "blocked" : result.status;
      statuses[key] = status;
      if (canTrigger && previous?.statuses[key] != null
        && previous.statuses[key] !== "allowed" && status === "allowed") {
        transitions.push({ key, symbol: market.symbol, timeframe: market.timeframe, side, reason: result.reason, tabIds: market.tabIds });
      }
    });
  });
  return { state: { epoch, statuses }, transitions };
}
