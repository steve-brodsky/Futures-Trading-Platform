import { describe, expect, it } from "vitest";
import type { Bar, EntryRules, Quote } from "../types";
import {
  defaultEntryRules, evaluateEntryRules, MAX_ENTRY_RULE_DEPTH, normalizeEntryRules,
} from "./entryRules";

const bars: Bar[] = Array.from({ length: 220 }, (_, index) => ({
  time: index,
  open: 100 + index,
  high: 102 + index,
  low: 99 + index,
  close: 101 + index,
  volume: 1000,
}));
const quote: Quote = { provider: "tradestation", symbol: "MES", last: 321, bid: 320, ask: 322, change: 0, changePct: 0, delayed: false, halted: false, timestamp: "" };

function exampleRules(): EntryRules {
  return {
    long: {
      id: "long-root", kind: "group", combinator: "and", children: [
        { id: "price-ema20", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "EMA", period: 20 } },
        { id: "ema20-ema200", kind: "condition", left: { kind: "movingAverage", average: "EMA", period: 20 }, operator: "above", right: { kind: "movingAverage", average: "EMA", period: 200 } },
      ],
    },
    short: { id: "short-root", kind: "group", combinator: "and", children: [] },
  };
}

function barsFromCloses(closes: number[], realtimeIndex = -1): Bar[] {
  return closes.map((close, index) => ({
    time: index * 60,
    open: index ? closes[index - 1] : close,
    high: Math.max(index ? closes[index - 1] : close, close),
    low: Math.min(index ? closes[index - 1] : close, close),
    close,
    volume: 100,
    realtime: index === realtimeIndex,
  }));
}

function emaCrossRules(direction: "above" | "below" | "either", lookback: number, period = 2): EntryRules {
  return {
    long: {
      id: "long-root", kind: "group", combinator: "and", children: [
        { id: "ema-cross", kind: "emaCross", direction, period, lookback },
      ],
    },
    short: { id: "short-root", kind: "group", combinator: "and", children: [] },
  };
}

describe("entry rules", () => {
  it("allows empty Long and Short roots", () => {
    const result = evaluateEntryRules(defaultEntryRules(), [], quote);
    expect(result.long.allowed).toBe(true);
    expect(result.short.allowed).toBe(true);
  });

  it("uses ask for Long and bid for Short", () => {
    const rules: EntryRules = {
      long: { id: "long-root", kind: "group", combinator: "and", children: [{ id: "long", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "SMA", period: 2 } }] },
      short: { id: "short-root", kind: "group", combinator: "and", children: [{ id: "short", kind: "condition", left: { kind: "marketPrice" }, operator: "below", right: { kind: "movingAverage", average: "SMA", period: 2 } }] },
    };
    const sideQuote = { ...quote, ask: 321, bid: 319 };
    expect(evaluateEntryRules(rules, bars, sideQuote).long.allowed).toBe(true);
    expect(evaluateEntryRules(rules, bars, sideQuote).short.allowed).toBe(true);
  });

  it("evaluates nested AND and OR groups", () => {
    const rules = exampleRules();
    rules.long.children = [{ id: "choice", kind: "group", combinator: "or", children: rules.long.children }];
    const result = evaluateEntryRules(rules, bars, quote);
    expect(result.long.allowed).toBe(true);
    expect(result.long.nodeResults.choice).toBe(true);
  });

  it("waits when an average has insufficient history", () => {
    const result = evaluateEntryRules(exampleRules(), bars.slice(0, 50), quote).long;
    expect(result.allowed).toBe(false);
    expect(result.status).toBe("waiting");
    expect(result.reason).toContain("EMA 200");
  });

  it("uses strict comparisons", () => {
    const rules: EntryRules = {
      long: { id: "long-root", kind: "group", combinator: "and", children: [{ id: "equal", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "SMA", period: 1 } }] },
      short: { id: "short-root", kind: "group", combinator: "and", children: [] },
    };
    expect(evaluateEntryRules(rules, bars, { ...quote, ask: bars.at(-1)!.close }).long.allowed).toBe(false);
  });

  it("finds EMA crosses above and below on the most recent closed candle", () => {
    const above = evaluateEntryRules(emaCrossRules("above", 1), barsFromCloses([100, 100, 99, 101]), quote).long;
    const below = evaluateEntryRules(emaCrossRules("below", 1), barsFromCloses([100, 100, 101, 99]), quote).long;
    expect(above.status).toBe("allowed");
    expect(above.reason).toContain("crossed above");
    expect(below.status).toBe("allowed");
    expect(below.reason).toContain("crossed below");
  });

  it("supports either direction and includes the oldest candle in the lookback", () => {
    const result = evaluateEntryRules(emaCrossRules("either", 3), barsFromCloses([100, 100, 99, 101, 102, 103]), quote).long;
    expect(result.status).toBe("allowed");
    expect(result.reason).toContain("2 closed candles ago");
  });

  it("ignores a crossover made only by the forming realtime candle", () => {
    const result = evaluateEntryRules(emaCrossRules("above", 1), barsFromCloses([100, 100, 99, 101], 3), quote).long;
    expect(result.status).toBe("blocked");
    expect(result.nodeResults["ema-cross"]).toBe(false);
  });

  it("treats earlier realtime-delivered bars as closed after a newer candle starts", () => {
    const streamed = barsFromCloses([100, 100, 101, 99, 98]).map((bar, index) => (
      index >= 2 ? { ...bar, realtime: true } : bar
    ));
    const result = evaluateEntryRules(emaCrossRules("below", 5), streamed, quote).long;
    expect(result.status).toBe("allowed");
    expect(result.reason).toContain("crossed below on the most recent closed candle");
  });

  it("counts departure from equality only after the close finishes strictly across the EMA", () => {
    const equality = evaluateEntryRules(emaCrossRules("above", 1), barsFromCloses([100, 100, 100]), quote).long;
    const departure = evaluateEntryRules(emaCrossRules("above", 1), barsFromCloses([100, 100, 100, 101]), quote).long;
    expect(equality.status).toBe("blocked");
    expect(departure.status).toBe("allowed");
  });

  it("distinguishes complete no-cross windows from incomplete history", () => {
    const blocked = evaluateEntryRules(emaCrossRules("either", 2), barsFromCloses([100, 100, 100, 100]), quote).long;
    const waiting = evaluateEntryRules(emaCrossRules("either", 3), barsFromCloses([100, 100, 100, 100]), quote).long;
    expect(blocked.status).toBe("blocked");
    expect(waiting.status).toBe("waiting");
    expect(waiting.nodeResults["ema-cross"]).toBeNull();
  });

  it("allows a known recent cross even when the full lookback history is incomplete", () => {
    const result = evaluateEntryRules(emaCrossRules("above", 3), barsFromCloses([100, 100, 99, 101]), quote).long;
    expect(result.status).toBe("allowed");
  });

  it("normalizes malformed, duplicate, and over-depth trees to unrestricted roots", () => {
    const duplicate = exampleRules();
    duplicate.long.children[1].id = duplicate.long.children[0].id;
    expect(normalizeEntryRules(duplicate).long.children).toEqual([]);

    let nested: any = { id: "condition", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "EMA", period: 20 } };
    for (let depth = 0; depth <= MAX_ENTRY_RULE_DEPTH; depth += 1) nested = { id: `group-${depth}`, kind: "group", combinator: "and", children: [nested] };
    expect(normalizeEntryRules({ long: nested }).long.children).toEqual([]);
  });

  it("normalizes persisted EMA cross conditions and rejects invalid values", () => {
    const valid = emaCrossRules("either", 5, 20);
    expect(normalizeEntryRules(valid)).toEqual(valid);

    for (const invalid of [
      { ...valid.long.children[0], direction: "sideways" },
      { ...valid.long.children[0], period: 1 },
      { ...valid.long.children[0], lookback: 1001 },
    ]) {
      expect(normalizeEntryRules({ ...valid, long: { ...valid.long, children: [invalid] } }).long.children).toEqual([]);
    }
  });
});
