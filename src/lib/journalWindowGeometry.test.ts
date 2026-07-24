import { describe, expect, it } from "vitest";
import {
  defaultJournalWindowGeometry,
  fitJournalWindowGeometry,
  journalWindowOuterRect,
  parseJournalWindowGeometry,
  selectJournalWindowMonitor,
  type JournalMonitorGeometry,
  type JournalWindowGeometryV2,
} from "./journalWindowGeometry";

function monitor(
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  scaleFactor = 1,
): JournalMonitorGeometry {
  return {
    name,
    scaleFactor,
    workArea: {
      position: { x, y },
      size: { width, height },
    },
  };
}

const primary = monitor("primary", 0, 0, 1920, 1032);
const frame = { width: 16, height: 39 };

describe("journal window geometry", () => {
  it("accepts only complete v2 physical-pixel records", () => {
    const valid = { version: 2, x: -1200, y: 24, innerWidth: 1280, innerHeight: 800 };
    expect(parseJournalWindowGeometry(valid)).toEqual(valid);
    expect(parseJournalWindowGeometry(JSON.stringify(valid))).toEqual(valid);

    expect(parseJournalWindowGeometry({ x: 20, y: 20, width: 1296, height: 839 })).toBeUndefined();
    expect(parseJournalWindowGeometry({ ...valid, version: 1 })).toBeUndefined();
    expect(parseJournalWindowGeometry({ ...valid, x: Number.NaN })).toBeUndefined();
    expect(parseJournalWindowGeometry({ ...valid, innerWidth: 959 })).toBeUndefined();
    expect(parseJournalWindowGeometry({ ...valid, innerHeight: 639 })).toBeUndefined();
    expect(parseJournalWindowGeometry("{not-json")).toBeUndefined();
    expect(parseJournalWindowGeometry(null)).toBeUndefined();
  });

  it("selects the monitor with the greatest decorated-window overlap", () => {
    const left = monitor("left", -1920, 0, 1920, 1040);
    const window = { x: -300, y: 100, width: 900, height: 700 };
    expect(selectJournalWindowMonitor(window, [left, primary], primary)?.name).toBe("primary");

    const mostlyLeft = { x: -1400, y: 100, width: 1600, height: 700 };
    expect(selectJournalWindowMonitor(mostlyLeft, [primary, left], primary)?.name).toBe("left");
  });

  it("falls back to the primary monitor for a disconnected display", () => {
    const secondary = monitor("secondary", -2560, 0, 2560, 1400);
    const disconnected = { x: 5000, y: 100, width: 1200, height: 800 };
    expect(selectJournalWindowMonitor(disconnected, [secondary, primary], primary)?.name).toBe("primary");
    expect(selectJournalWindowMonitor(disconnected, [secondary], null)?.name).toBe("secondary");
  });

  it("fits the known inflated height inside the complete 1920x1032 work area", () => {
    const fitted = fitJournalWindowGeometry(
      { version: 2, x: 208, y: 0, innerWidth: 1504, innerHeight: 1370 },
      frame,
      [primary],
      primary,
    );
    expect(fitted).toEqual({ version: 2, x: 208, y: 0, innerWidth: 1504, innerHeight: 993 });
    expect(journalWindowOuterRect(fitted, frame)).toEqual({ x: 208, y: 0, width: 1520, height: 1032 });
  });

  it("clamps partially off-screen geometry without changing a fitting inner size", () => {
    expect(fitJournalWindowGeometry(
      { version: 2, x: 1700, y: 900, innerWidth: 960, innerHeight: 640 },
      frame,
      [primary],
      primary,
    )).toEqual({
      version: 2,
      x: 944,
      y: 353,
      innerWidth: 960,
      innerHeight: 640,
    });
  });

  it("retains windows on an overlapping negative-coordinate monitor", () => {
    const left = monitor("left", -2560, -180, 2560, 1400, 1.25);
    const geometry: JournalWindowGeometryV2 = {
      version: 2,
      x: -2300,
      y: -100,
      innerWidth: 1280,
      innerHeight: 800,
    };
    expect(fitJournalWindowGeometry(geometry, frame, [primary, left], primary)).toEqual(geometry);
  });

  it("moves disconnected geometry to the primary work area", () => {
    expect(fitJournalWindowGeometry(
      { version: 2, x: -4200, y: 300, innerWidth: 1280, innerHeight: 800 },
      frame,
      [primary],
      primary,
    )).toEqual({
      version: 2,
      x: 0,
      y: 193,
      innerWidth: 1280,
      innerHeight: 800,
    });
  });

  it("uses physical work-area values unchanged on mixed-DPI monitors", () => {
    const highDpi = monitor("high-dpi", 1920, -120, 2560, 1400, 1.5);
    const geometry: JournalWindowGeometryV2 = {
      version: 2,
      x: 2600,
      y: 0,
      innerWidth: 1650,
      innerHeight: 1140,
    };
    expect(fitJournalWindowGeometry(geometry, frame, [primary, highDpi], primary)).toEqual(geometry);
  });

  it("centers a safe 1280x800 default on the primary monitor", () => {
    expect(defaultJournalWindowGeometry([primary], primary, frame)).toEqual({
      version: 2,
      x: 312,
      y: 97,
      innerWidth: 1280,
      innerHeight: 800,
    });
  });

  it("fits the safe default when the primary work area is smaller", () => {
    const compact = monitor("compact", 100, 50, 1100, 700, 1.25);
    expect(defaultJournalWindowGeometry([compact], compact, frame)).toEqual({
      version: 2,
      x: 100,
      y: 50,
      innerWidth: 1084,
      innerHeight: 661,
    });
  });

  it("preserves inner geometry through ten save and restore cycles", () => {
    let geometry: JournalWindowGeometryV2 = {
      version: 2,
      x: 312,
      y: 97,
      innerWidth: 1280,
      innerHeight: 800,
    };
    for (let cycle = 0; cycle < 10; cycle += 1) {
      geometry = fitJournalWindowGeometry(
        parseJournalWindowGeometry(JSON.stringify(geometry))!,
        frame,
        [primary],
        primary,
      );
    }
    expect(geometry).toEqual({
      version: 2,
      x: 312,
      y: 97,
      innerWidth: 1280,
      innerHeight: 800,
    });
    expect(journalWindowOuterRect(geometry, frame)).toEqual({
      x: 312,
      y: 97,
      width: 1296,
      height: 839,
    });
  });
});
