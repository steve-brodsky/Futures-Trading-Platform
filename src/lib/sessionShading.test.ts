import { describe, expect, it } from "vitest";
import { isUsRegularMarketHours } from "./sessionShading";

const epoch = (iso: string) => Date.parse(iso) / 1000;

describe("US regular market hours", () => {
  it("uses 9:30 through 16:00 Eastern", () => {
    expect(isUsRegularMarketHours(epoch("2026-07-13T13:29:00Z"))).toBe(false);
    expect(isUsRegularMarketHours(epoch("2026-07-13T13:30:00Z"))).toBe(true);
    expect(isUsRegularMarketHours(epoch("2026-07-13T19:59:00Z"))).toBe(true);
    expect(isUsRegularMarketHours(epoch("2026-07-13T20:00:00Z"))).toBe(false);
  });

  it("accounts for Eastern daylight saving time and weekends", () => {
    expect(isUsRegularMarketHours(epoch("2026-01-12T14:30:00Z"))).toBe(true);
    expect(isUsRegularMarketHours(epoch("2026-07-11T15:00:00Z"))).toBe(false);
  });
});
