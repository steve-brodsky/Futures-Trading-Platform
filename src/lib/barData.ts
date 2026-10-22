import type { Bar } from "../types";

/** Merge historical snapshots and live updates without dropping last-known-good bars. */
export function mergeBars(current: Bar[], incoming: Bar[]): Bar[] {
  const byTime = new Map(current.map((bar) => [bar.time, bar]));
  incoming.forEach((bar) => byTime.set(bar.time, bar));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Updating only the newest candle is safe only when every preceding value is unchanged. */
export function canUpdateLastBar(previous: Bar[], next: Bar[]): boolean {
  if (!previous.length || next.length < previous.length || next.length > previous.length + 1) return false;
  const previousLast = previous[previous.length - 1];
  const nextLast = next[next.length - 1];
  if (next.length === previous.length ? nextLast.time !== previousLast.time : nextLast.time <= previousLast.time) return false;
  return next.slice(0, -1).every((bar, index) => {
    const prior = previous[index];
    return bar === prior || bar.time === prior.time && bar.open === prior.open && bar.high === prior.high
      && bar.low === prior.low && bar.close === prior.close && bar.volume === prior.volume;
  });
}
