import { describe, expect, it } from "vitest";
import { formatChartTime, resolveTimezone } from "./timezone";

describe("chart timezone", () => {
  it("maps US futures exchanges to Chicago", () => expect(resolveTimezone("exchange", "CME")).toBe("America/Chicago"));
  it("formats the same epoch differently by zone", () => {
    const epoch = Date.parse("2026-07-11T20:00:00Z") / 1000;
    expect(formatChartTime(epoch, "UTC")).toContain("20:00");
    expect(formatChartTime(epoch, "America/Los_Angeles")).toContain("13:00");
  });
});
