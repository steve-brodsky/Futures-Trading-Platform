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
const quote: Quote = { symbol: "MES", last: 321, bid: 320, ask: 322, change: 0, changePct: 0, delayed: false, halted: false, timestamp: "" };

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

  it("normalizes malformed, duplicate, and over-depth trees to unrestricted roots", () => {
    const duplicate = exampleRules();
    duplicate.long.children[1].id = duplicate.long.children[0].id;
    expect(normalizeEntryRules(duplicate).long.children).toEqual([]);

    let nested: any = { id: "condition", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "EMA", period: 20 } };
    for (let depth = 0; depth <= MAX_ENTRY_RULE_DEPTH; depth += 1) nested = { id: `group-${depth}`, kind: "group", combinator: "and", children: [nested] };
    expect(normalizeEntryRules({ long: nested }).long.children).toEqual([]);
  });
});
