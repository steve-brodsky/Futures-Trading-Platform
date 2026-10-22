import { describe, expect, it } from "vitest";
import type { Bar } from "../types";
import { HistoryBackfillRequests, olderHistoryPage, type HistoryMarket } from "./historyBackfill";
import { mergeBars } from "./barData";

const market: HistoryMarket = { provider: "schwab", symbol: "SPY", timeframe: "1h", generation: 1 };
const bar = (time: number, close = time): Bar => ({ time, open: close, high: close, low: close, close, volume: 1, realtime: false });

describe("history backfill requests", () => {
  it("locks synchronously before a second chart callback can start a request", () => {
    const requests = new HistoryBackfillRequests();
    const token = requests.begin("tab", market)!;
    expect(requests.begin("tab", market)).toBeUndefined();
    requests.finish("tab", token);
    expect(requests.begin("tab", market)).toBeDefined();
  });

  it("blocks automatic retries after failure but allows a deliberate retry", () => {
    const requests = new HistoryBackfillRequests();
    const token = requests.begin("tab", market)!;
    requests.finish("tab", token, true);
    expect(requests.begin("tab", market)).toBeUndefined();
    const retry = requests.begin("tab", market, true)!;
    expect(retry).toBeDefined();
    expect(requests.begin("tab", market, true)).toBeUndefined();
    requests.finish("tab", token, true);
    expect(requests.current("tab", market, retry)).toBe(true);
  });

  it.each([
    { ...market, provider: "tradestation" as const },
    { ...market, symbol: "QQQ" },
    { ...market, timeframe: "30m" as const },
    { ...market, generation: 2 },
  ])("rejects stale results and cleanup after a market/session change: %j", (next) => {
    const requests = new HistoryBackfillRequests();
    const old = requests.begin("tab", market)!;
    expect(requests.current("tab", next, old)).toBe(false);
    const fresh = requests.begin("tab", next)!;
    requests.finish("tab", old, true);
    expect(requests.current("tab", market, old)).toBe(false);
    expect(requests.current("tab", next, fresh)).toBe(true);
    expect(requests.begin("tab", next)).toBeUndefined();
  });

  it("clears locks and failures for closed tabs", () => {
    const requests = new HistoryBackfillRequests();
    const token = requests.begin("tab", market)!;
    requests.retainTabs(new Set());
    expect(requests.current("tab", market, token)).toBe(false);
    expect(requests.begin("tab", market)).toBeDefined();
  });
});

describe("older history pages", () => {
  it("sorts and deduplicates strictly older candles, detecting repeated responses", () => {
    expect(olderHistoryPage([bar(20), bar(10), bar(10, 11), bar(30)], 20)).toEqual([bar(10, 11)]);
    expect(olderHistoryPage([bar(20), bar(30)], 20)).toEqual([]);
  });

  it("preserves live updates that arrive while a backfill request is pending", () => {
    const page = olderHistoryPage([bar(10), bar(20, 999)], 20);
    const current = [bar(20, 21), { ...bar(30, 31), realtime: true }];
    expect(mergeBars(page, current)).toEqual([bar(10), ...current]);
  });
});
