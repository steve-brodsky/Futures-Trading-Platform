import { describe, expect, it } from "vitest";
import type { Bar, TruthSocialPost } from "../types";
import {
  closestMatchingTruthSocialPost,
  normalizeAlertedPostIds,
  recentOneMinuteVolatility,
  rememberAlertedPostId,
  trackRapidMarketMove,
} from "./truthSocialAlerts";

const at = Date.parse("2026-08-10T17:00:00Z");

function bars(step = 0.001): Bar[] {
  return Array.from({ length: 70 }, (_, index) => ({
    time: Math.floor((at - (70 - index) * 60_000) / 1000),
    open: 100,
    high: 101,
    low: 99,
    close: 100 * Math.exp((index % 2 ? 1 : -1) * step),
    volume: 100,
    realtime: false,
  }));
}

function post(id: string, publishedAt: string, patch: Partial<TruthSocialPost> = {}): TruthSocialPost {
  return {
    id,
    publishedAt,
    text: `Post ${id}`,
    postUrl: `https://truthsocial.com/@realDonaldTrump/posts/${id}`,
    handle: "realDonaldTrump",
    platform: "Truth Social",
    deleted: false,
    isRepost: false,
    ...patch,
  };
}

describe("rapid Truth Social catalyst detection", () => {
  it("requires enough completed one-minute history", () => {
    expect(recentOneMinuteVolatility(bars().slice(0, 20), at)).toBeUndefined();
    expect(recentOneMinuteVolatility(bars(), at)).toBeGreaterThan(0);
  });

  it.each([[104, "up"], [96, "down"]] as const)("detects a balanced rapid move to %s", (price, direction) => {
    const primed = trackRapidMarketMove(undefined, { provider: "tradestation", symbol: "@MES", price: 100, occurredAt: at - 30_000, receivedAt: at - 30_000, minMove: .25, oneMinuteBars: bars() });
    const detected = trackRapidMarketMove(primed.state, { provider: "tradestation", symbol: "@MES", price, occurredAt: at, receivedAt: at, minMove: .25, oneMinuteBars: bars() });
    expect(detected.move?.direction).toBe(direction);
    expect(detected.move?.volatilityMultiple).toBeGreaterThanOrEqual(3);
  });

  it("enforces the four-tick floor, rejects stale quotes, and applies cooldown", () => {
    const smallMoveBars = bars(.00001);
    const primed = trackRapidMarketMove(undefined, { provider: "tradestation", symbol: "@MES", price: 100, occurredAt: at - 30_000, receivedAt: at - 30_000, minMove: .25, oneMinuteBars: smallMoveBars });
    const belowTicks = trackRapidMarketMove(primed.state, { provider: "tradestation", symbol: "@MES", price: 100.75, occurredAt: at, receivedAt: at, minMove: .25, oneMinuteBars: smallMoveBars });
    expect(belowTicks.move).toBeUndefined();
    const stale = trackRapidMarketMove(primed.state, { provider: "tradestation", symbol: "@MES", price: 110, occurredAt: at, receivedAt: at + 11_000, minMove: .25, oneMinuteBars: smallMoveBars });
    expect(stale.move).toBeUndefined();
    const triggered = trackRapidMarketMove(primed.state, { provider: "tradestation", symbol: "@MES", price: 102, occurredAt: at, receivedAt: at, minMove: .25, oneMinuteBars: smallMoveBars });
    const repeated = trackRapidMarketMove(triggered.state, { provider: "tradestation", symbol: "@MES", price: 106, occurredAt: at + 30_000, receivedAt: at + 30_000, minMove: .25, oneMinuteBars: smallMoveBars });
    expect(triggered.move).toBeDefined();
    expect(repeated.move).toBeUndefined();
  });

  it("resets samples when the active market changes", () => {
    const first = trackRapidMarketMove(undefined, { provider: "tradestation", symbol: "@MES", price: 100, occurredAt: at - 30_000, receivedAt: at - 30_000, minMove: .25, oneMinuteBars: bars() });
    const switched = trackRapidMarketMove(first.state, { provider: "schwab", symbol: "SPY", price: 500, occurredAt: at, receivedAt: at, minMove: .01, oneMinuteBars: bars() });
    expect(switched.state.marketKey).toBe("schwab:SPY");
    expect(switched.state.samples).toHaveLength(1);
    expect(switched.move).toBeUndefined();
  });

  it("matches the closest original across explicit timezone offsets and inclusive boundaries", () => {
    const moveAt = Date.parse("2026-08-10T09:30:00-07:00");
    const candidates = [
      post("boundary", "2026-08-10T12:28:00-04:00"),
      post("closest", "2026-08-10T12:30:15-04:00"),
      post("repost", "2026-08-10T12:30:05-04:00", { isRepost: true }),
      post("deleted", "2026-08-10T12:30:01-04:00", { deleted: true }),
      post("outside", "2026-08-10T12:32:01-04:00"),
    ];
    expect(closestMatchingTruthSocialPost(candidates, moveAt)?.id).toBe("closest");
    expect(closestMatchingTruthSocialPost([candidates[0]], moveAt)?.id).toBe("boundary");
    expect(closestMatchingTruthSocialPost(candidates, moveAt, new Set(["closest"]))?.id).toBe("boundary");
  });

  it("bounds and deduplicates locally remembered post IDs", () => {
    expect(normalizeAlertedPostIds(["a", "a", 3, "b"])).toEqual(["a", "b"]);
    const remembered = Array.from({ length: 105 }, (_, index) => String(index)).reduce(rememberAlertedPostId, [] as string[]);
    expect(remembered).toHaveLength(100);
    expect(remembered[0]).toBe("5");
  });
});
