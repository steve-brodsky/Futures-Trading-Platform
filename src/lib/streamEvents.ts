import type { ChartTabState, MarketDataProvider, StreamStateEvent, Timeframe, TradingEnvironment } from "../types";

export interface BarEventIdentity {
  subscriptionId: string;
  provider: MarketDataProvider;
  environment: TradingEnvironment;
  symbol: string;
  timeframe: Timeframe;
  generation: number;
}

export interface BarMarketIdentity {
  provider: MarketDataProvider;
  symbol: string;
  timeframe: Timeframe;
}

export function isSameBarMarket(
  market: BarMarketIdentity | undefined,
  provider: MarketDataProvider,
  symbol: string,
  timeframe: Timeframe,
): boolean {
  return market?.provider === provider && market.symbol === symbol && market.timeframe === timeframe;
}

/**
 * Detached windows do not own the native subscription, so they use a
 * generation high-water mark. While a market replacement is pending, the
 * next accepted event must advance that generation; afterwards events from
 * the current generation continue to be accepted.
 */
export function acceptsDetachedBarGeneration(
  generation: number,
  latestGeneration: number | undefined,
  awaitingReplacement: boolean,
): boolean {
  if (latestGeneration == null) return true;
  return awaitingReplacement ? generation > latestGeneration : generation >= latestGeneration;
}

export function acceptsBarEvent(
  tab: Pick<ChartTabState, "id" | "symbol" | "timeframe"> | undefined,
  environment: TradingEnvironment,
  event: BarEventIdentity,
  expectedGeneration?: number,
): boolean {
  return Boolean(tab)
    && event.subscriptionId === tab!.id
    && event.provider === tab!.symbol.provider
    && (event.provider === "schwab" || event.environment === environment)
    && event.symbol === tab!.symbol.symbol
    && event.timeframe === tab!.timeframe
    && (expectedGeneration == null || event.generation === expectedGeneration);
}

export function isBarStateEvent(event: StreamStateEvent): event is StreamStateEvent & BarEventIdentity {
  return event.channel === "bars"
    && typeof event.symbol === "string"
    && typeof event.timeframe === "string"
    && typeof event.generation === "number";
}
