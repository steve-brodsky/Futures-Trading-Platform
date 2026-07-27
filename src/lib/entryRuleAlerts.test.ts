import { describe, expect, it } from "vitest";
import type { Bar, EntryRuleAlertConfig, EntryRules, Quote } from "../types";
import {
  defaultEntryRuleAlerts, entryRuleAlertEpoch, normalizeEntryRuleAlerts, trackEntryRuleAlertTransitions,
  type EntryRuleAlertMarketInput, type EntryRuleAlertTrackerState,
} from "./entryRuleAlerts";
import { defaultEntryRules } from "./entryRules";

const bars: Bar[] = [{ time: 1, open: 100, high: 101, low: 99, close: 100, volume: 10 }];
const quote = (ask: number, bid = ask - 1): Quote => ({
  provider: "tradestation", symbol: "MES", last: ask, bid, ask, change: 0, changePct: 0, delayed: false, halted: false, timestamp: "",
});
const rules = (): EntryRules => ({
  long: { id: "long-root", kind: "group", combinator: "and", children: [{
    id: "long-price", kind: "condition", left: { kind: "marketPrice" }, operator: "above",
    right: { kind: "movingAverage", average: "SMA", period: 1 },
  }] },
  short: { id: "short-root", kind: "group", combinator: "and", children: [] },
});
const enabled = (): EntryRuleAlertConfig => ({
  ...defaultEntryRuleAlerts(),
  long: { enabled: true, sound: "chime", durationSeconds: 3 },
});
const input = (price: number, tabId = "chart-1"): EntryRuleAlertMarketInput => ({
  tabId, symbol: "MES", timeframe: "1m", bars, quote: quote(price), hasOpenPosition: false,
});

describe("entry rule alerts", () => {
  it("defaults disabled and normalizes malformed settings", () => {
    expect(defaultEntryRuleAlerts().long).toEqual({ enabled: false, sound: "chime", durationSeconds: 3 });
    expect(normalizeEntryRuleAlerts({ long: { enabled: true, sound: "bad", durationSeconds: 99 } }).long)
      .toEqual({ enabled: true, sound: "chime", durationSeconds: 3 });
  });

  it("primes silently, fires once on transition, and rearms after leaving allowed", () => {
    const config = enabled();
    const epoch = entryRuleAlertEpoch("sim", rules(), config);
    let tracked = trackEntryRuleAlertTransitions(undefined, epoch, rules(), config, [input(99)]);
    expect(tracked.transitions).toEqual([]);

    tracked = trackEntryRuleAlertTransitions(tracked.state, epoch, rules(), config, [input(101)]);
    expect(tracked.transitions).toHaveLength(1);
    tracked = trackEntryRuleAlertTransitions(tracked.state, epoch, rules(), config, [input(102)]);
    expect(tracked.transitions).toEqual([]);
    tracked = trackEntryRuleAlertTransitions(tracked.state, epoch, rules(), config, [input(99)]);
    tracked = trackEntryRuleAlertTransitions(tracked.state, epoch, rules(), config, [input(101)]);
    expect(tracked.transitions).toHaveLength(1);
  });

  it("fires when a waiting rule becomes allowed", () => {
    const config = enabled();
    const epoch = entryRuleAlertEpoch("sim", rules(), config);
    const waiting = trackEntryRuleAlertTransitions(undefined, epoch, rules(), config, [{ ...input(101), bars: [] }]);
    expect(waiting.state.statuses["MES\u00001m\u0000long"]).toBe("waiting");
    expect(trackEntryRuleAlertTransitions(waiting.state, epoch, rules(), config, [input(101)]).transitions).toHaveLength(1);
  });

  it("returns separate Long and Short transitions from the same market", () => {
    const bothRules = rules();
    bothRules.short.children = [{
      id: "short-price", kind: "condition", left: { kind: "marketPrice" }, operator: "below",
      right: { kind: "movingAverage", average: "SMA", period: 1 },
    }];
    const bothAlerts: EntryRuleAlertConfig = {
      long: { enabled: true, sound: "chime", durationSeconds: 3 },
      short: { enabled: true, sound: "bell", durationSeconds: 1 },
    };
    const epoch = entryRuleAlertEpoch("sim", bothRules, bothAlerts);
    const primed = trackEntryRuleAlertTransitions(undefined, epoch, bothRules, bothAlerts, [{ ...input(99), quote: quote(99, 101) }]);
    const triggered = trackEntryRuleAlertTransitions(primed.state, epoch, bothRules, bothAlerts, [{ ...input(101), quote: quote(101, 99) }]);
    expect(triggered.transitions.map((item) => item.side)).toEqual(["long", "short"]);
  });

  it("blocks both sides for an open position and alerts once after it closes", () => {
    const bothRules = rules();
    bothRules.short.children = [{
      id: "short-price", kind: "condition", left: { kind: "marketPrice" }, operator: "below",
      right: { kind: "movingAverage", average: "SMA", period: 1 },
    }];
    const bothAlerts: EntryRuleAlertConfig = {
      long: { enabled: true, sound: "chime", durationSeconds: 3 },
      short: { enabled: true, sound: "bell", durationSeconds: 1 },
    };
    const epoch = entryRuleAlertEpoch("sim\u0000account-1", bothRules, bothAlerts);
    const open = trackEntryRuleAlertTransitions(undefined, epoch, bothRules, bothAlerts, [{
      ...input(101), quote: quote(101, 99), hasOpenPosition: true,
    }]);
    expect(open.transitions).toEqual([]);
    expect(open.state.statuses).toEqual({
      "MES\u00001m\u0000long": "blocked",
      "MES\u00001m\u0000short": "blocked",
    });

    const closed = trackEntryRuleAlertTransitions(open.state, epoch, bothRules, bothAlerts, [{
      ...input(101), quote: quote(101, 99), hasOpenPosition: false,
    }]);
    expect(closed.transitions.map((item) => item.side)).toEqual(["long", "short"]);
    expect(trackEntryRuleAlertTransitions(closed.state, epoch, bothRules, bothAlerts, [{
      ...input(101), quote: quote(101, 99), hasOpenPosition: false,
    }]).transitions).toEqual([]);
  });

  it("suppresses disabled and empty sides", () => {
    const noRules = defaultEntryRules();
    const config = enabled();
    const state: EntryRuleAlertTrackerState = { epoch: "same", statuses: { "MES\u00001m\u0000long": "blocked" } };
    expect(trackEntryRuleAlertTransitions(state, "same", noRules, config, [input(101)]).transitions).toEqual([]);
    expect(trackEntryRuleAlertTransitions(state, "same", rules(), defaultEntryRuleAlerts(), [input(101)]).transitions).toEqual([]);
  });

  it("silently reprimes when the rule/config epoch changes", () => {
    const config = enabled();
    const prior: EntryRuleAlertTrackerState = { epoch: "old", statuses: { "MES\u00001m\u0000long": "blocked" } };
    expect(trackEntryRuleAlertTransitions(prior, "new", rules(), config, [input(101)]).transitions).toEqual([]);
  });

  it("deduplicates matching markets and returns every matching tab", () => {
    const config = enabled();
    const epoch = entryRuleAlertEpoch("sim", rules(), config);
    const primed = trackEntryRuleAlertTransitions(undefined, epoch, rules(), config, [input(99), input(99, "chart-2")]);
    const triggered = trackEntryRuleAlertTransitions(primed.state, epoch, rules(), config, [input(101), input(101, "chart-2")]);
    expect(triggered.transitions).toHaveLength(1);
    expect(triggered.transitions[0].tabIds).toEqual(["chart-1", "chart-2"]);
  });

  it("fires when the clock enters a configured time window", () => {
    const timeRules: EntryRules = {
      long: {
        id: "long-root", kind: "group", combinator: "and", children: [{
          id: "time", kind: "timeWindow", startTime: "09:30", endTime: "16:00",
          weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC",
        }],
      },
      short: { id: "short-root", kind: "group", combinator: "and", children: [] },
    };
    const config = enabled();
    const epoch = entryRuleAlertEpoch("sim", timeRules, config);
    const primed = trackEntryRuleAlertTransitions(
      undefined, epoch, timeRules, config, [input(101)], Date.parse("2026-07-27T09:29:00Z"),
    );
    expect(primed.state.statuses["MES\u00001m\u0000long"]).toBe("blocked");

    const triggered = trackEntryRuleAlertTransitions(
      primed.state, epoch, timeRules, config, [input(101)], Date.parse("2026-07-27T09:30:00Z"),
    );
    expect(triggered.transitions).toHaveLength(1);
    expect(triggered.transitions[0].reason).toContain("09:30–16:00 UTC passes");
    expect(trackEntryRuleAlertTransitions(
      triggered.state, epoch, timeRules, config, [input(101)], Date.parse("2026-07-27T09:31:00Z"),
    ).transitions).toEqual([]);
  });
});
