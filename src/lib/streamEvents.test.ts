import { describe, expect, it } from "vitest";
import { acceptsBarEvent, acceptsDetachedBarGeneration, isBarStateEvent, isSameBarMarket } from "./streamEvents";
import type { ChartTabState, StreamStateEvent } from "../types";

const tab = {
  id: "chart-1",
  symbol: { symbol: "MESU26" },
  timeframe: "5m",
} as ChartTabState;

const event = {
  subscriptionId: "chart-1",
  environment: "sim",
  symbol: "MESU26",
  timeframe: "5m",
  generation: 42,
} as const;

describe("bar stream event acceptance", () => {
  it("accepts only the current environment, market, and generation", () => {
    expect(acceptsBarEvent(tab, "sim", event, 42)).toBe(true);
    expect(acceptsBarEvent(tab, "live", event, 42)).toBe(false);
    expect(acceptsBarEvent(tab, "sim", { ...event, symbol: "MNQU26" }, 42)).toBe(false);
    expect(acceptsBarEvent(tab, "sim", { ...event, timeframe: "15m" }, 42)).toBe(false);
    expect(acceptsBarEvent(tab, "sim", event, 43)).toBe(false);
  });

  it("allows detached consumers to filter by exact market without owning the generation", () => {
    expect(acceptsBarEvent(tab, "sim", event)).toBe(true);
  });

  it("identifies when a tab market buffer belongs to another symbol or timeframe", () => {
    expect(isSameBarMarket({ symbol: "MESU26", timeframe: "5m" }, "MESU26", "5m")).toBe(true);
    expect(isSameBarMarket({ symbol: "MESU26", timeframe: "5m" }, "MESU26", "15m")).toBe(false);
    expect(isSameBarMarket(undefined, "MESU26", "5m")).toBe(false);
  });

  it("requires a newer generation while a detached market replacement is pending", () => {
    expect(acceptsDetachedBarGeneration(42, 42, true)).toBe(false);
    expect(acceptsDetachedBarGeneration(41, 42, false)).toBe(false);
    expect(acceptsDetachedBarGeneration(43, 42, true)).toBe(true);
    expect(acceptsDetachedBarGeneration(43, 43, false)).toBe(true);
    expect(acceptsDetachedBarGeneration(1, undefined, true)).toBe(true);
  });

  it("distinguishes complete bar state payloads from quote states", () => {
    expect(isBarStateEvent({ ...event, channel: "bars", state: "streaming" })).toBe(true);
    expect(isBarStateEvent({ subscriptionId: "quotes", environment: "sim", channel: "quotes", state: "streaming" } as StreamStateEvent)).toBe(false);
  });
});
