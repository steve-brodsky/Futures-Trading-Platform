import type { Bar, Quote, Timeframe } from "../types";
import { timeframeSeconds } from "./timeframes";

/** Locate the completed session close immediately before the current futures session. */
export function previousSessionClose(bars: Bar[], timeframe: Timeframe): number | undefined {
  const valid = bars.filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.close) && bar.close > 0);
  if (!valid.length) return undefined;
  if (timeframe === "D") {
    const latest = valid.at(-1)!;
    return latest.realtime && valid.length > 1 ? valid.at(-2)!.close : latest.close;
  }
  const interval = timeframeSeconds(timeframe);
  if (!interval) return undefined;
  const sessionBreak = Math.max(30 * 60, interval * 1.5);
  for (let index = valid.length - 1; index > 0; index -= 1) {
    if (valid[index].time - valid[index - 1].time > sessionBreak) return valid[index - 1].close;
  }
  return undefined;
}

/** Derive the percentage from prices first; TradeStation's percentage is only a final fallback. */
export function quoteDayChangePercent(quote: Pick<Quote, "last" | "change" | "changePct">, referenceClose?: number): number {
  if (!Number.isFinite(quote.last)) return 0;
  const previousClose = Number.isFinite(quote.change) && quote.change !== 0
    ? quote.last - quote.change
    : referenceClose;
  if (previousClose != null && Number.isFinite(previousClose) && previousClose !== 0) {
    const resolved = (quote.last - previousClose) / previousClose * 100;
    return Object.is(resolved, -0) ? 0 : resolved;
  }
  return Number.isFinite(quote.changePct) && !Object.is(quote.changePct, -0) ? quote.changePct : 0;
}
