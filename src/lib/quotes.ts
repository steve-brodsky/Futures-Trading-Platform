import type { Quote } from "../types";

/** Use TradeStation's percentage when present, with NetChange as a reliable fallback. */
export function quoteDayChangePercent(quote: Pick<Quote, "last" | "change" | "changePct">): number {
  if (Number.isFinite(quote.changePct) && quote.changePct !== 0) return quote.changePct;
  if (!Number.isFinite(quote.last) || !Number.isFinite(quote.change) || quote.change === 0) return 0;
  const previousClose = quote.last - quote.change;
  if (!Number.isFinite(previousClose) || previousClose === 0) return 0;
  const percentage = quote.change / previousClose * 100;
  return Object.is(percentage, -0) ? 0 : percentage;
}
