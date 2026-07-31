import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "../types";
import {
  normalizeCustomMinuteTimeframes,
  normalizeTimeframe,
  orderedToolbarTimeframes,
  parseMinuteTimeframe,
  removeCustomMinuteTimeframe,
  timeframeMinutes,
  validateCustomMinuteInput,
  workspaceForPersistence,
} from "./timeframes";

describe("custom minute timeframes", () => {
  it("parses only canonical whole-minute values in the provider range", () => {
    expect(parseMinuteTimeframe("7m")).toBe(7);
    expect(parseMinuteTimeframe("1440m")).toBe(1440);
    ["0m", "01m", "1441m", "7.5m", "7h", " 7m"].forEach((value) => expect(parseMinuteTimeframe(value)).toBeUndefined());
    expect(timeframeMinutes("1h")).toBe(60);
    expect(timeframeMinutes("4h")).toBe(240);
  });

  it("normalizes, deduplicates, sorts, and excludes built-in equivalents", () => {
    expect(normalizeCustomMinuteTimeframes([45, 7, 45, 1, 60, 240, 1_440, 0, 7.5, "90"])).toEqual([7, 45, 1_440]);
    expect(normalizeTimeframe("45m", [45])).toBe("45m");
    expect(normalizeTimeframe("45m", [])).toBe("1m");
  });

  it("orders custom minutes among intraday buttons before calendar buttons", () => {
    expect(orderedToolbarTimeframes([90, 7, 45])).toEqual(["1m", "5m", "7m", "15m", "30m", "45m", "1h", "90m", "4h", "D", "W", "M"]);
  });

  it("validates input and rejects existing toolbar equivalents", () => {
    expect(validateCustomMinuteInput("45", [])).toEqual({ minutes: 45 });
    expect(validateCustomMinuteInput("7.5", []).error).toMatch(/whole number/i);
    expect(validateCustomMinuteInput("1441", []).error).toMatch(/1,440/);
    expect(validateCustomMinuteInput("60", []).error).toMatch(/already/);
    expect(validateCustomMinuteInput("45", [45]).error).toMatch(/already/);
  });

  it("replaces transient tab intervals with their persistent fallback before saving", () => {
    const workspace = {
      customMinuteTimeframes: [45],
      tabs: [
        { id: "temporary", timeframe: "7m" },
        { id: "saved", timeframe: "45m" },
      ],
    } as unknown as WorkspaceState;
    const persisted = workspaceForPersistence(workspace, [7], new Map([["temporary", "15m"]]));
    expect(persisted.tabs.map((tab) => tab.timeframe)).toEqual(["15m", "45m"]);
    expect(workspace.tabs[0].timeframe).toBe("7m");
  });

  it("removes a custom value and resets every affected tab to 1m", () => {
    const workspace = {
      customMinuteTimeframes: [45, 90],
      tabs: [{ id: "one", timeframe: "45m" }, { id: "two", timeframe: "90m" }, { id: "three", timeframe: "45m" }],
    } as unknown as WorkspaceState;
    const next = removeCustomMinuteTimeframe(workspace, 45);
    expect(next.customMinuteTimeframes).toEqual([90]);
    expect(next.tabs.map((tab) => tab.timeframe)).toEqual(["1m", "90m", "1m"]);
  });
});
