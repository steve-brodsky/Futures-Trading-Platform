import { describe, expect, it } from "vitest";
import { acceptsBarEvent, acceptsDetachedBarGeneration, isBarStateEvent, isSameBarMarket } from "./streamEvents";
import type { ChartTabState, StreamStateEvent } from "../types";

const tab = {
  id: "chart-1",
  symbol: { provider: "tradestation", symbol: "MESU26" },
  timeframe: "5m",
} as unknown as ChartTabState;

const event = {
  subscriptionId: "chart-1",
  provider: "tradestation",
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

  it("isolates providers while Schwab remains independent of the TradeStation environment", () => {
    const equityTab = { ...tab, symbol: { ...tab.symbol, provider: "schwab" as const, symbol: "AAPL" } };
    const schwabEvent = { ...event, provider: "schwab" as const, symbol: "AAPL" };
    expect(acceptsBarEvent(equityTab, "sim", schwabEvent, 42)).toBe(true);
    expect(acceptsBarEvent(equityTab, "live", schwabEvent, 42)).toBe(true);
    expect(acceptsBarEvent(equityTab, "sim", { ...schwabEvent, provider: "tradestation" }, 42)).toBe(false);
  });

  it("rejects late futures events after the same tab switches to a Schwab equity", () => {
    const equityTab = { ...tab, symbol: { ...tab.symbol, provider: "schwab" as const, symbol: "AAPL" } };
    const schwabEvent = { ...event, provider: "schwab" as const, symbol: "AAPL", generation: 44 };
    expect(acceptsBarEvent(equityTab, "sim", event, 44)).toBe(false);
    expect(acceptsBarEvent(equityTab, "sim", { ...schwabEvent, generation: 43 }, 44)).toBe(false);
    expect(acceptsBarEvent(equityTab, "sim", schwabEvent, 44)).toBe(true);
  });

  it("identifies when a tab market buffer belongs to another symbol or timeframe", () => {
    expect(isSameBarMarket({ provider: "tradestation", symbol: "MESU26", timeframe: "5m" }, "tradestation", "MESU26", "5m")).toBe(true);
    expect(isSameBarMarket({ provider: "tradestation", symbol: "MESU26", timeframe: "5m" }, "tradestation", "MESU26", "15m")).toBe(false);
    expect(isSameBarMarket(undefined, "tradestation", "MESU26", "5m")).toBe(false);
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
    expect(isBarStateEvent({ subscriptionId: "quotes", provider: "tradestation", environment: "sim", channel: "quotes", state: "streaming" } as StreamStateEvent)).toBe(false);
  });
});
