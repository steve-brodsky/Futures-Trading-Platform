import type { Bar, ChartTabState, Timeframe } from "../types";

export interface EpochRange {
  first: number;
  last: number;
}

export const isIntradayTimeframe = (timeframe: Timeframe): boolean => !["D", "W", "M"].includes(timeframe);

export function nySessionVwapSymbols(tabs: ChartTabState[]): string[] {
  return [...new Set(tabs
    .filter((tab) => isIntradayTimeframe(tab.timeframe) && tab.indicators.some((indicator) => indicator.kind === "VWAP" && indicator.visible))
    .map((tab) => tab.symbol.symbol))].sort();
}

export function mergeEpochRanges(ranges: EpochRange[]): EpochRange[] {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.first) && Number.isFinite(range.last) && range.first < range.last)
    .sort((a, b) => a.first - b.first);
  const merged: EpochRange[] = [];
  sorted.forEach((range) => {
    const previous = merged.at(-1);
    if (!previous || range.first > previous.last) merged.push({ ...range });
    else previous.last = Math.max(previous.last, range.last);
  });
  return merged;
}

export function missingEpochRanges(first: number, last: number, covered: EpochRange[]): EpochRange[] {
  if (first >= last) return [];
  const missing: EpochRange[] = [];
  let cursor = first;
  mergeEpochRanges(covered).forEach((range) => {
    if (range.last <= cursor || range.first >= last) return;
    if (range.first > cursor) missing.push({ first: cursor, last: Math.min(range.first, last) });
    cursor = Math.max(cursor, Math.min(range.last, last));
  });
  if (cursor < last) missing.push({ first: cursor, last });
  return missing;
}

export function mergeVwapBars(current: Bar[], incoming: Bar[]): Bar[] {
  const byTime = new Map(current.map((bar) => [bar.time, bar]));
  incoming.forEach((bar) => byTime.set(bar.time, bar));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

const DAY_SECONDS = 86_400;
const REQUEST_CHUNK_SECONDS = 30 * DAY_SECONDS;

export function expandedVwapRange(first: number, last: number): EpochRange {
  return {
    first: Math.floor((first - DAY_SECONDS) / DAY_SECONDS) * DAY_SECONDS,
    last: Math.ceil((last + DAY_SECONDS) / DAY_SECONDS) * DAY_SECONDS,
  };
}

export function chunkVwapRange(range: EpochRange): EpochRange[] {
  const chunks: EpochRange[] = [];
  for (let first = range.first; first < range.last; first += REQUEST_CHUNK_SECONDS) {
    chunks.push({ first, last: Math.min(first + REQUEST_CHUNK_SECONDS, range.last) });
  }
  return chunks;
}
