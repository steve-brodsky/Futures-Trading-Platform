import type { Bar, MarketDataProvider, RapidMarketMove, TruthSocialPost } from "../types";

export const RAPID_MOVE_WINDOW_MS = 30_000;
export const RAPID_MOVE_COOLDOWN_MS = 5 * 60_000;
export const RAPID_MOVE_VOLATILITY_MULTIPLE = 3;
export const RAPID_MOVE_MINIMUM_TICKS = 4;
export const TRUTH_SOCIAL_MATCH_WINDOW_MS = 2 * 60_000;
export const TRUTH_SOCIAL_POLL_INTERVAL_MS = 15_000;
export const TRUTH_SOCIAL_POLL_DURATION_MS = 3 * 60_000;
export const ALERTED_POST_LIMIT = 100;
export const ALERTED_POST_STORAGE_KEY = "northstar-truth-social-alerted-posts";

interface PriceSample {
  at: number;
  price: number;
}

export interface RapidMoveTrackerState {
  marketKey: string;
  samples: PriceSample[];
  cooldownUntil: number;
}

export interface RapidMoveInput {
  provider: MarketDataProvider;
  symbol: string;
  price: number;
  occurredAt: number;
  receivedAt: number;
  minMove: number;
  oneMinuteBars: Bar[];
}

function standardDeviation(values: number[]): number | undefined {
  if (values.length < 30) return undefined;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
  const result = Math.sqrt(variance);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

export function recentOneMinuteVolatility(bars: Bar[], at: number): number | undefined {
  const completed = bars
    .filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.close) && bar.close > 0 && bar.time * 1000 + 60_000 <= at)
    .sort((left, right) => left.time - right.time)
    .slice(-61);
  const returns: number[] = [];
  for (let index = 1; index < completed.length; index += 1) {
    const value = Math.log(completed[index].close / completed[index - 1].close);
    if (Number.isFinite(value)) returns.push(value);
  }
  return standardDeviation(returns);
}

export function trackRapidMarketMove(
  previous: RapidMoveTrackerState | undefined,
  input: RapidMoveInput,
): { state: RapidMoveTrackerState; move?: RapidMarketMove } {
  const marketKey = `${input.provider}:${input.symbol.trim().toUpperCase()}`;
  const state = previous?.marketKey === marketKey
    ? previous
    : { marketKey, samples: [], cooldownUntil: 0 };
  if (!Number.isFinite(input.price) || input.price <= 0 || !Number.isFinite(input.occurredAt)
    || !Number.isFinite(input.receivedAt) || input.receivedAt - input.occurredAt > 10_000
    || input.occurredAt - input.receivedAt > 5_000 || !Number.isFinite(input.minMove) || input.minMove <= 0) {
    return { state };
  }

  const samples = [...state.samples, { at: input.occurredAt, price: input.price }]
    .filter((sample) => sample.at >= input.occurredAt - RAPID_MOVE_WINDOW_MS - 5_000 && sample.at <= input.occurredAt)
    .sort((left, right) => left.at - right.at);
  const nextState = { ...state, samples };
  const reference = [...samples].reverse().find((sample) => sample.at <= input.occurredAt - RAPID_MOVE_WINDOW_MS);
  if (!reference || input.occurredAt < state.cooldownUntil) return { state: nextState };

  const volatility = recentOneMinuteVolatility(input.oneMinuteBars, input.occurredAt);
  if (volatility == null) return { state: nextState };
  const logReturn = Math.log(input.price / reference.price);
  const volatilityMultiple = Math.abs(logReturn) / volatility;
  const priceChange = Math.abs(input.price - reference.price);
  if (volatilityMultiple < RAPID_MOVE_VOLATILITY_MULTIPLE
    || priceChange + Number.EPSILON < RAPID_MOVE_MINIMUM_TICKS * input.minMove) {
    return { state: nextState };
  }

  const changePct = (input.price / reference.price - 1) * 100;
  return {
    state: { ...nextState, cooldownUntil: input.occurredAt + RAPID_MOVE_COOLDOWN_MS },
    move: {
      provider: input.provider,
      symbol: input.symbol,
      direction: changePct >= 0 ? "up" : "down",
      startedAt: reference.at,
      occurredAt: input.occurredAt,
      startPrice: reference.price,
      endPrice: input.price,
      changePct,
      volatilityMultiple,
    },
  };
}

export function closestMatchingTruthSocialPost(
  posts: TruthSocialPost[],
  moveAt: number,
  alertedIds: ReadonlySet<string> = new Set(),
): TruthSocialPost | undefined {
  return posts
    .flatMap((post) => {
      const publishedAt = Date.parse(post.publishedAt);
      const eligible = post.platform === "Truth Social"
        && post.handle.toLowerCase() === "realdonaldtrump"
        && !post.deleted
        && !post.isRepost
        && !alertedIds.has(post.id)
        && Number.isFinite(publishedAt)
        && Math.abs(publishedAt - moveAt) <= TRUTH_SOCIAL_MATCH_WINDOW_MS;
      return eligible ? [{ post, publishedAt, distance: Math.abs(publishedAt - moveAt) }] : [];
    })
    .sort((left, right) => left.distance - right.distance || right.publishedAt - left.publishedAt)[0]?.post;
}

export function normalizeAlertedPostIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
    .slice(-ALERTED_POST_LIMIT);
}

export function rememberAlertedPostId(ids: string[], id: string): string[] {
  return [...ids.filter((item) => item !== id), id].slice(-ALERTED_POST_LIMIT);
}
