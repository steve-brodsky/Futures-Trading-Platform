import type { Bar } from "../types";

/** Merge historical snapshots and live updates without dropping last-known-good bars. */
export function mergeBars(current: Bar[], incoming: Bar[]): Bar[] {
  const byTime = new Map(current.map((bar) => [bar.time, bar]));
  incoming.forEach((bar) => byTime.set(bar.time, bar));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
