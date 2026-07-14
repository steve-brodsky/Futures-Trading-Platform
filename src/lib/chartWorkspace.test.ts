import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "../types";
import { defaultEntryRules } from "./entryRules";
import { defaultEma200Alert } from "./emaAlerts";
import { clampWindowGeometry, cloneChartTab, closeDetachedWindow, MAX_CHART_TABS, moveTab, normalizeChartWorkspace, rememberWindowGeometry, savedPhysicalWindowGeometry, stabilizeChartWorkspace, tabInsertionIndex } from "./chartWorkspace";

const fallback: WorkspaceState = {
  revision: 0,
  environment: "sim",
  tabs: [{ id: "chart-1", symbol: { symbol: "MES", description: "Micro E-mini S&P", exchange: "CME", assetType: "Future", minMove: .25, pointValue: 5 }, timeframe: "1m", chartKind: "candles", indicators: [], ema200Alert: defaultEma200Alert(), chartTimezone: "exchange", magnetEnabled: false }],
  windows: [{ id: "main", tabIds: ["chart-1"], activeTabId: "chart-1", detached: false }],
  drawings: {},
  watchlist: [], rightTab: "order", rightPanelOpen: false, bottomTab: "positions", bottomPanelOpen: false, confirmOrders: true, entryRules: defaultEntryRules(),
  settings: { chartLabels: { showDollarAmount: true, showRMultiple: true, fontSize: 11 }, orderTicket: { swingStopPivotBars: 2, swingStopOffsetTicks: 1 } },
};

describe("chart workspace", () => {
  it("keeps unchanged chart references stable across full workspace broadcasts", () => {
    const current = normalizeChartWorkspace(fallback, fallback);
    const broadcast = normalizeChartWorkspace({ ...current, revision: 2, rightPanelOpen: true }, fallback);
    const result = stabilizeChartWorkspace(current, broadcast);

    expect(result.rightPanelOpen).toBe(true);
    expect(result.tabs).toBe(current.tabs);
    expect(result.tabs[0].indicators).toBe(current.tabs[0].indicators);
    expect(result.windows).toBe(current.windows);
    expect(result.drawings).toBe(current.drawings);
    expect(result.entryRules).toBe(current.entryRules);
    expect(result.settings).toBe(current.settings);
  });

  it("only replaces the tab whose chart configuration changed", () => {
    const second = cloneChartTab(fallback.tabs[0], "chart-2");
    const current = normalizeChartWorkspace({
      ...fallback,
      tabs: [...fallback.tabs, second],
      windows: [{ ...fallback.windows[0], tabIds: ["chart-1", "chart-2"] }],
    }, fallback);
    const broadcast = normalizeChartWorkspace({
      ...current,
      revision: 3,
      tabs: current.tabs.map((tab) => tab.id === "chart-2" ? { ...tab, timeframe: "15m" } : tab),
    }, fallback);
    const result = stabilizeChartWorkspace(current, broadcast);

    expect(result.tabs[0]).toBe(current.tabs[0]);
    expect(result.tabs[1]).not.toBe(current.tabs[1]);
    expect(result.tabs[1].timeframe).toBe("15m");
  });

  it("migrates a legacy flat chart workspace", () => {
    const result = normalizeChartWorkspace({ ...fallback, tabs: undefined, windows: undefined, timeframe: "15m", symbol: fallback.tabs[0].symbol }, fallback);
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0].timeframe).toBe("15m");
    expect(result.windows[0].tabIds).toEqual([result.tabs[0].id]);
  });

  it("defaults legacy environments to SIM and preserves a saved LIVE environment", () => {
    expect(normalizeChartWorkspace({ ...fallback, environment: undefined }, fallback).environment).toBe("sim");
    expect(normalizeChartWorkspace({ ...fallback, environment: "live" }, fallback).environment).toBe("live");
    expect(normalizeChartWorkspace({ ...fallback, environment: "invalid" }, fallback).environment).toBe("sim");
  });

  it("defaults legacy chart-label settings and preserves explicit preferences", () => {
    const legacy = normalizeChartWorkspace({ ...fallback, settings: undefined }, fallback);
    expect(legacy.settings.chartLabels).toEqual({ showDollarAmount: true, showRMultiple: true, fontSize: 11 });

    const saved = normalizeChartWorkspace({
      ...fallback,
      settings: { chartLabels: { showDollarAmount: false, showRMultiple: true, fontSize: 14 } },
    }, fallback);
    expect(saved.settings.chartLabels).toEqual({ showDollarAmount: false, showRMultiple: true, fontSize: 14 });

    const clamped = normalizeChartWorkspace({
      ...fallback,
      settings: { chartLabels: { showDollarAmount: true, showRMultiple: true, fontSize: 50 } },
    }, fallback);
    expect(clamped.settings.chartLabels.fontSize).toBe(16);
  });

  it("defaults, preserves, and clamps swing-stop settings", () => {
    const legacy = normalizeChartWorkspace({ ...fallback, settings: { chartLabels: fallback.settings.chartLabels } }, fallback);
    expect(legacy.settings.orderTicket).toEqual({ swingStopPivotBars: 2, swingStopOffsetTicks: 1 });

    const saved = normalizeChartWorkspace({
      ...fallback,
      settings: { ...fallback.settings, orderTicket: { swingStopPivotBars: 3, swingStopOffsetTicks: 12.6 } },
    }, fallback);
    expect(saved.settings.orderTicket).toEqual({ swingStopPivotBars: 3, swingStopOffsetTicks: 13 });

    const clamped = normalizeChartWorkspace({
      ...fallback,
      settings: { ...fallback.settings, orderTicket: { swingStopPivotBars: 4, swingStopOffsetTicks: 500 } },
    }, fallback);
    expect(clamped.settings.orderTicket).toEqual({ swingStopPivotBars: 2, swingStopOffsetTicks: 100 });
  });

  it("accepts changed global settings from a workspace broadcast", () => {
    const current = normalizeChartWorkspace(fallback, fallback);
    const broadcast = normalizeChartWorkspace({
      ...current,
      revision: 2,
      settings: { chartLabels: { showDollarAmount: true, showRMultiple: false, fontSize: 13 } },
    }, fallback);
    const result = stabilizeChartWorkspace(current, broadcast);
    expect(result.settings.chartLabels).toEqual({ showDollarAmount: true, showRMultiple: false, fontSize: 13 });
    expect(result.settings).not.toBe(current.settings);
  });

  it("accepts changed swing-stop settings from a workspace broadcast", () => {
    const current = normalizeChartWorkspace(fallback, fallback);
    const broadcast = normalizeChartWorkspace({
      ...current,
      revision: 2,
      settings: { ...current.settings, orderTicket: { swingStopPivotBars: 3, swingStopOffsetTicks: 4 } },
    }, fallback);
    const result = stabilizeChartWorkspace(current, broadcast);
    expect(result.settings.orderTicket).toEqual({ swingStopPivotBars: 3, swingStopOffsetTicks: 4 });
    expect(result.settings).not.toBe(current.settings);
  });

  it("limits tabs, repairs assignments, and selects a valid active tab", () => {
    const tabs = Array.from({ length: 8 }, (_, index) => cloneChartTab(fallback.tabs[0], `tab-${index}`));
    const result = normalizeChartWorkspace({ ...fallback, tabs, windows: [{ id: "main", detached: false, tabIds: tabs.map((tab) => tab.id), activeTabId: "missing" }] }, fallback);
    expect(result.tabs).toHaveLength(MAX_CHART_TABS);
    expect(result.windows[0].activeTabId).toBe("tab-0");
  });

  it("deep clones mutable chart settings", () => {
    const source = { ...fallback.tabs[0], indicators: [{ id: "ema", kind: "EMA" as const, period: 20, color: "#fff", visible: true }] };
    const clone = cloneChartTab(source, "copy");
    clone.indicators[0].color = "#000";
    clone.ema200Alert["1m"].enabled = true;
    expect(source.indicators[0].color).toBe("#fff");
    expect(source.ema200Alert["1m"].enabled).toBe(false);
  });

  it("moves tabs between windows and removes an empty detached window", () => {
    const workspace = { ...fallback, tabs: [fallback.tabs[0], cloneChartTab(fallback.tabs[0], "copy")], windows: [{ ...fallback.windows[0] }, { id: "detached", detached: true, tabIds: ["copy"], activeTabId: "copy" }] };
    const result = moveTab(workspace, "copy", "main", 0);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].tabIds).toEqual(["copy", "chart-1"]);
  });

  it("removes a detached tab from the main strip instead of duplicating it", () => {
    const workspace = { ...fallback, windows: [{ ...fallback.windows[0] }, { id: "detached", detached: true, tabIds: [], activeTabId: "chart-1" }] };
    const moved = moveTab(workspace, "chart-1", "detached", 0);
    expect(moved.windows.find((window) => window.id === "main")?.tabIds).toEqual([]);
    expect(moved.windows.find((window) => window.id === "detached")?.tabIds).toEqual(["chart-1"]);
    const restored = normalizeChartWorkspace(moved, fallback);
    expect(restored.windows.find((window) => window.id === "main")?.tabIds).toEqual([]);
  });

  it("accounts for the removed source slot when reordering in one strip", () => {
    const tabs = [fallback.tabs[0], cloneChartTab(fallback.tabs[0], "b"), cloneChartTab(fallback.tabs[0], "c")];
    const workspace = { ...fallback, tabs, windows: [{ id: "main", detached: false, tabIds: ["chart-1", "b", "c"], activeTabId: "b" }] };
    expect(moveTab(workspace, "b", "main", 2).windows[0].tabIds).toEqual(["chart-1", "b", "c"]);
    expect(moveTab(workspace, "b", "main", 3).windows[0].tabIds).toEqual(["chart-1", "c", "b"]);
  });

  it("deletes detached tabs when their window closes", () => {
    const workspace = { ...fallback, tabs: [fallback.tabs[0], cloneChartTab(fallback.tabs[0], "copy")], windows: [{ ...fallback.windows[0] }, { id: "detached", detached: true, tabIds: ["copy"], activeTabId: "copy" }] };
    const result = closeDetachedWindow(workspace, "detached");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].tabIds).toEqual(["chart-1"]);
    expect(result.tabs.map((tab) => tab.id)).toEqual(["chart-1"]);
  });

  it("defaults legacy workspaces to order confirmation", () => {
    const result = normalizeChartWorkspace({ ...fallback, confirmOrders: undefined }, fallback);
    expect(result.confirmOrders).toBe(true);
  });

  it("defaults legacy alert settings and preserves per-timeframe choices", () => {
    const legacy = normalizeChartWorkspace({ ...fallback, tabs: [{ ...fallback.tabs[0], ema200Alert: undefined }] }, fallback);
    expect(legacy.tabs[0].ema200Alert["1m"]).toEqual({ enabled: false, sound: "chime", durationSeconds: 3 });
    const saved = structuredClone(fallback);
    saved.tabs[0].ema200Alert["5m"] = { enabled: true, sound: "siren", durationSeconds: 10 };
    expect(normalizeChartWorkspace(saved, fallback).tabs[0].ema200Alert["5m"]).toEqual({ enabled: true, sound: "siren", durationSeconds: 10 });
  });

  it("preserves an explicit disabled confirmation preference", () => {
    const result = normalizeChartWorkspace({ ...fallback, confirmOrders: false }, fallback);
    expect(result.confirmOrders).toBe(false);
  });

  it("keeps legacy tabs automatic and persists a concrete manual contract", () => {
    const automatic = normalizeChartWorkspace(fallback, fallback);
    expect(automatic.tabs[0].tradeContract).toBeUndefined();
    const manual = normalizeChartWorkspace({ ...fallback, tabs: [{ ...fallback.tabs[0], tradeContract: "mesz26" }] }, fallback);
    expect(manual.tabs[0].tradeContract).toBe("MESZ26");
  });

  it("defaults legacy workspaces to unrestricted entry rules", () => {
    const result = normalizeChartWorkspace({ ...fallback, entryRules: undefined }, fallback);
    expect(result.entryRules.long.children).toEqual([]);
    expect(result.entryRules.short.children).toEqual([]);
  });

  it("moves an off-screen detached window onto an available monitor", () => {
    expect(clampWindowGeometry({ x: 3000, y: 200, width: 1000, height: 700 }, [{ x: 0, y: 0, width: 1920, height: 1080 }]))
      .toEqual({ x: 920, y: 200, width: 1000, height: 700 });
  });

  it("retains exact physical detached-window geometry across mixed-DPI monitors", () => {
    const detached = { id: "detached", detached: true, tabIds: ["chart-1"], activeTabId: "chart-1" };
    const saved = rememberWindowGeometry(detached, { x: 2880, y: 180, width: 1650, height: 1140 }, 1.5, true);
    expect(saved).toMatchObject({
      maximized: true,
      x: 1920,
      y: 120,
      width: 1100,
      height: 760,
      physicalX: 2880,
      physicalY: 180,
      physicalWidth: 1650,
      physicalHeight: 1140,
    });
    expect(savedPhysicalWindowGeometry(saved)).toEqual({ x: 2880, y: 180, width: 1650, height: 1140 });
  });

  it("accepts a changed main-window maximized state from a workspace broadcast", () => {
    const current = normalizeChartWorkspace(fallback, fallback);
    const incoming = normalizeChartWorkspace({
      ...current,
      revision: current.revision + 1,
      windows: current.windows.map((window) => window.id === "main" ? { ...window, maximized: true } : window),
    }, fallback);
    expect(stabilizeChartWorkspace(current, incoming).windows[0].maximized).toBe(true);
  });

  it("ignores incomplete or invalid physical window geometry", () => {
    const detached = { id: "detached", detached: true, tabIds: ["chart-1"], activeTabId: "chart-1", physicalX: 200, physicalY: 100, physicalWidth: 0, physicalHeight: 700 };
    expect(savedPhysicalWindowGeometry(detached)).toBeUndefined();
  });

  it("calculates and clamps cross-window insertion positions", () => {
    expect(tabInsertionIndex(150, 100, 300, 4)).toBe(1);
    expect(tabInsertionIndex(500, 100, 300, 4)).toBe(4);
  });

  it("normalizes persistent symbol drawings and rejects malformed entries", () => {
    const result = normalizeChartWorkspace({ ...fallback, drawings: { MES: [
      { id: "line", kind: "horizontal", points: [{ time: 10, price: 5000 }], color: "#fff" },
      { id: "bad", kind: "horizontal", points: [], color: "#fff" },
    ] } }, fallback);
    expect(result.drawings.MES).toEqual([{ id: "line", kind: "horizontal", points: [{ time: 10, price: 5000 }], color: "#fff", locked: false, lineWidth: 1 }]);
  });
});
