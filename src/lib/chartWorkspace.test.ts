import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "../types";
import { clampWindowGeometry, cloneChartTab, closeDetachedWindow, MAX_CHART_TABS, moveTab, normalizeChartWorkspace, stabilizeChartWorkspace, tabInsertionIndex } from "./chartWorkspace";

const fallback: WorkspaceState = {
  revision: 0,
  tabs: [{ id: "chart-1", symbol: { symbol: "MES", description: "Micro E-mini S&P", exchange: "CME", assetType: "Future", minMove: .25, pointValue: 5 }, timeframe: "1m", chartKind: "candles", indicators: [], chartTimezone: "exchange", magnetEnabled: false }],
  windows: [{ id: "main", tabIds: ["chart-1"], activeTabId: "chart-1", detached: false }],
  drawings: {},
  watchlist: [], rightTab: "order", rightPanelOpen: false, bottomTab: "positions", bottomPanelOpen: false,
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
    expect(source.indicators[0].color).toBe("#fff");
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

  it("moves an off-screen detached window onto an available monitor", () => {
    expect(clampWindowGeometry({ x: 3000, y: 200, width: 1000, height: 700 }, [{ x: 0, y: 0, width: 1920, height: 1080 }]))
      .toEqual({ x: 920, y: 200, width: 1000, height: 700 });
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
