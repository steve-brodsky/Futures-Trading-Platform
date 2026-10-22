import type { Bar, MarketDataProvider, Timeframe } from "../types";

export interface HistoryMarket {
  provider: MarketDataProvider;
  symbol: string;
  timeframe: Timeframe;
  generation?: number;
}

export function historyMarketKey(market: HistoryMarket): string {
  return JSON.stringify([market.provider, market.symbol, market.timeframe, market.generation]);
}

/** A synchronous lock also blocks chart callbacks before React commits loading state. */
export class HistoryBackfillRequests {
  private requests = new Map<string, { key: string; token: object; pending: boolean; failed: boolean }>();

  begin(tabId: string, market: HistoryMarket, retry = false): object | undefined {
    const key = historyMarketKey(market);
    const previous = this.requests.get(tabId);
    if (previous?.key === key && (previous.pending || previous.failed && !retry)) return;
    const token = {};
    this.requests.set(tabId, { key, token, pending: true, failed: false });
    return token;
  }

  current(tabId: string, market: HistoryMarket, token: object): boolean {
    const request = this.requests.get(tabId);
    return request?.token === token && request.key === historyMarketKey(market);
  }

  finish(tabId: string, token: object, failed = false): void {
    const request = this.requests.get(tabId);
    if (request?.token === token) {
      request.pending = false;
      request.failed = failed;
    }
  }

  retainTabs(tabIds: Set<string>): void {
    this.requests.forEach((_, tabId) => { if (!tabIds.has(tabId)) this.requests.delete(tabId); });
  }
}

/** Ignore repeated/newer provider rows; existing live bars win overlapping timestamps. */
export function olderHistoryPage(bars: Bar[], before: number): Bar[] {
  const byTime = new Map(bars.filter((bar) => bar.time < before).map((bar) => [bar.time, bar]));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
