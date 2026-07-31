import type { AlertDurationSeconds, AlertSound, AlertTimeframe, Bar, ChartTabState, Ema200AlertConfig, MarketDataProvider, Timeframe, TimeframeAlertConfig } from "../types";
import { ema } from "./indicators";

export const ALERT_TIMEFRAMES: AlertTimeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "D", "W", "M"];
export const ALERT_SOUNDS: Array<{ value: AlertSound; label: string }> = [
  { value: "chime", label: "Chime" },
  { value: "bell", label: "Bell" },
  { value: "pulse", label: "Pulse" },
  { value: "siren", label: "Siren" },
];
export const ALERT_DURATIONS: AlertDurationSeconds[] = [1, 3, 5, 10];

const sounds = new Set<AlertSound>(ALERT_SOUNDS.map((item) => item.value));
const durations = new Set<AlertDurationSeconds>(ALERT_DURATIONS);

export function defaultTimeframeAlert(): TimeframeAlertConfig {
  return { enabled: false, sound: "chime", durationSeconds: 3 };
}

export function defaultEma200Alert(): Ema200AlertConfig {
  return Object.fromEntries(ALERT_TIMEFRAMES.map((timeframe) => [timeframe, defaultTimeframeAlert()])) as Ema200AlertConfig;
}

export function normalizeEma200Alert(value: unknown): Ema200AlertConfig {
  const source = value && typeof value === "object" ? value as Partial<Record<AlertTimeframe, Partial<TimeframeAlertConfig>>> : {};
  return Object.fromEntries(ALERT_TIMEFRAMES.map((timeframe) => {
    const saved = source[timeframe];
    const sound = sounds.has(saved?.sound as AlertSound) ? saved!.sound as AlertSound : "chime";
    const durationSeconds = durations.has(saved?.durationSeconds as AlertDurationSeconds) ? saved!.durationSeconds as AlertDurationSeconds : 3;
    return [timeframe, { enabled: saved?.enabled === true, sound, durationSeconds }];
  })) as Ema200AlertConfig;
}

export function cloneEma200Alert(config: Ema200AlertConfig): Ema200AlertConfig {
  return Object.fromEntries(ALERT_TIMEFRAMES.map((timeframe) => [timeframe, { ...config[timeframe] }])) as Ema200AlertConfig;
}

export function sameEma200Alert(left: Ema200AlertConfig, right: Ema200AlertConfig): boolean {
  return ALERT_TIMEFRAMES.every((timeframe) => left[timeframe].enabled === right[timeframe].enabled
    && left[timeframe].sound === right[timeframe].sound
    && left[timeframe].durationSeconds === right[timeframe].durationSeconds);
}

export function alertMarketKey(symbol: string, timeframe: Timeframe): string {
  return `${symbol}\u0000${timeframe}`;
}

export interface AlertMarketRequirement {
  key: string;
  provider: MarketDataProvider;
  symbol: string;
  timeframe: Timeframe;
}

export function desiredAlertMarkets(tabs: ChartTabState[]): AlertMarketRequirement[] {
  const requirements = new Map<string, AlertMarketRequirement>();
  tabs.forEach((tab) => ALERT_TIMEFRAMES.forEach((timeframe) => {
    if (!tab.ema200Alert[timeframe].enabled) return;
    const key = alertMarketKey(tab.symbol.symbol, timeframe);
    requirements.set(key, { key, provider: tab.symbol.provider, symbol: tab.symbol.symbol, timeframe });
  }));
  return [...requirements.values()];
}

export function uncoveredAlertMarkets(tabs: ChartTabState[]): AlertMarketRequirement[] {
  const chartMarkets = new Set(tabs.map((tab) => alertMarketKey(tab.symbol.symbol, tab.timeframe)));
  return desiredAlertMarkets(tabs).filter((market) => !chartMarkets.has(market.key));
}

export type EmaCrossSide = "above" | "below";
export type EmaCrossDirection = "above" | "below";

export interface Ema200TabMarket {
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
}

export interface Ema200TabPositionCacheEntry extends Ema200TabMarket {
  position?: EmaCrossSide;
}

export interface EmaCrossEvaluation {
  side?: EmaCrossSide;
  direction?: EmaCrossDirection;
  price?: number;
  ema?: number;
}

export function ema200Position(bars: Bar[]): EmaCrossSide | undefined {
  return evaluateEma200Cross(bars).side;
}

export function deriveEma200TabPositions(
  tabs: Array<Pick<ChartTabState, "id" | "symbol" | "timeframe">>,
  markets: Record<string, Ema200TabMarket | undefined>,
  enabled: boolean,
  cache: Map<string, Ema200TabPositionCacheEntry>,
): Partial<Record<string, EmaCrossSide>> {
  if (!enabled) {
    cache.clear();
    return {};
  }
  const activeIds = new Set(tabs.map((tab) => tab.id));
  const positions: Partial<Record<string, EmaCrossSide>> = {};
  tabs.forEach((tab) => {
    const market = markets[tab.id];
    if (market?.symbol !== tab.symbol.symbol || market.timeframe !== tab.timeframe) {
      cache.delete(tab.id);
      return;
    }
    const cached = cache.get(tab.id);
    const position = cached?.symbol === market.symbol
      && cached.timeframe === market.timeframe
      && cached.bars === market.bars
      ? cached.position
      : ema200Position(market.bars);
    cache.set(tab.id, { symbol: market.symbol, timeframe: market.timeframe, bars: market.bars, position });
    if (position) positions[tab.id] = position;
  });
  cache.forEach((_, tabId) => { if (!activeIds.has(tabId)) cache.delete(tabId); });
  return positions;
}

export function evaluateEma200Cross(bars: Bar[], previousSide?: EmaCrossSide): EmaCrossEvaluation {
  if (bars.length < 200) return { side: previousSide };
  const values = ema(bars.map((bar) => bar.close), 200);
  const average = values[values.length - 1];
  const price = bars[bars.length - 1]?.close;
  if (average == null || !Number.isFinite(average) || !Number.isFinite(price)) return { side: previousSide };
  const difference = price - average;
  const tolerance = Math.max(1, Math.abs(price), Math.abs(average)) * 1e-10;
  const side = difference > tolerance ? "above" : difference < -tolerance ? "below" : previousSide;
  return {
    side,
    direction: previousSide && side && previousSide !== side ? side : undefined,
    price,
    ema: average,
  };
}
