import { describe, expect, it } from "vitest";
import { candleEndTime, formatCandleCountdown } from "./candleCountdown";

describe("candle countdown", () => {
  it("counts down intraday candles from their opening timestamp", () => {
    expect(candleEndTime(1_000, "5m")).toBe(1_300);
    expect(candleEndTime(1_000, "45m")).toBe(3_700);
    expect(formatCandleCountdown(1_000, "5m", 1_001_000)).toBe("04:59");
    expect(formatCandleCountdown(1_000, "4h", 1_593_000)).toBe("03:50:07");
  });

  it("stops at zero when the latest candle has elapsed", () => {
    expect(formatCandleCountdown(1_000, "1m", 1_061_000)).toBe("00:00");
  });

  it("formats longer calendar candles with days", () => {
    expect(formatCandleCountdown(1_000, "W", 1_000_000)).toBe("7d 00:00:00");
    const july = Date.UTC(2026, 6, 1) / 1000;
    expect(candleEndTime(july, "M")).toBe(Date.UTC(2026, 7, 1) / 1000);
  });
});
