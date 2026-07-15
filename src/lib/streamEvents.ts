import type { ChartTabState, StreamStateEvent, Timeframe, TradingEnvironment } from "../types";

export interface BarEventIdentity {
  subscriptionId: string;
  environment: TradingEnvironment;
  symbol: string;
  timeframe: Timeframe;
  generation: number;
}

export function acceptsBarEvent(
  tab: Pick<ChartTabState, "id" | "symbol" | "timeframe"> | undefined,
  environment: TradingEnvironment,
  event: BarEventIdentity,
  expectedGeneration?: number,
): boolean {
  return Boolean(tab)
    && event.subscriptionId === tab!.id
    && event.environment === environment
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
