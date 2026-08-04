import { describe, expect, it } from "vitest";
import { formatChartTime, resolveTimezone } from "./timezone";

describe("chart timezone", () => {
  it("maps US futures exchanges to Chicago", () => expect(resolveTimezone("exchange", "CME")).toBe("America/Chicago"));
  it("maps US equity exchanges to New York", () => expect(resolveTimezone("exchange", "NASDAQ")).toBe("America/New_York"));
  it("formats the same epoch differently by zone", () => {
    const epoch = Date.parse("2026-07-11T20:00:00Z") / 1000;
    expect(formatChartTime(epoch, "UTC")).toContain("20:00");
    expect(formatChartTime(epoch, "America/Los_Angeles")).toContain("13:00");
  });
  it("keeps a New York-midnight daily key on August 3", () => {
    const august3MidnightNewYork = Date.parse("2026-08-03T04:00:00Z") / 1000;
    expect(formatChartTime(august3MidnightNewYork, "America/New_York", true)).toContain("Aug 03, 2026");
  });
});
