import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "../types";
import { defaultEntryRules } from "./entryRules";
import { defaultEntryRuleAlerts } from "./entryRuleAlerts";
import { defaultEma200Alert } from "./emaAlerts";
import { defaultPointAndFigureSettings, defaultRenkoSettings } from "./priceBasedCharts";
import { chartLayoutCapacity, claimDetachedWindowCreation, clampWindowGeometry, cloneChartTab, closeDetachedWindow, defaultChartSplitRatios, detachedSourceWindowToClose, focusChartTab, MAX_CHART_TABS, moveTab, normalizeChartSplitRatio, normalizeChartWorkspace, reconcileChartWindow, rememberWindowGeometry, savedPhysicalWindowGeometry, setChartWindowLayout, setChartWindowSplitRatio, stabilizeChartWorkspace, staleDetachedWindowIds, tabInsertionIndex } from "./chartWorkspace";

const fallback: WorkspaceState = {
  revision: 0,
  environment: "sim",
  tabs: [{ id: "chart-1", symbol: { symbol: "MES", description: "Micro E-mini S&P", exchange: "CME", assetType: "Future", minMove: .25, pointValue: 5 }, timeframe: "1m", chartKind: "candles", renkoSettings: defaultRenkoSettings(), pointAndFigureSettings: defaultPointAndFigureSettings(), indicators: [], ema200Alert: defaultEma200Alert(), chartTimezone: "exchange", magnetEnabled: false }],
  windows: [{ id: "main", tabIds: ["chart-1"], activeTabId: "chart-1", detached: false }],
  drawings: {},
  watchlist: [], rightPanelOpen: false, bottomTab: "positions", bottomPanelOpen: false, confirmOrders: true, entryRules: defaultEntryRules(), entryRuleAlerts: defaultEntryRuleAlerts(),
  settings: { chartLabels: { showEma200TabDots: true, showDollarAmount: true, showRMultiple: true, fontSize: 11 }, orderTicket: { swingStopPivotBars: 2, swingStopOffsetTicks: 1, sizingMode: "contracts", riskSizingPolicy: "strict" }, journal: { commissionPerContractSide: 0.4 } },
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
    expect(legacy.settings.chartLabels).toEqual({ showEma200TabDots: true, showDollarAmount: true, showRMultiple: true, fontSize: 11 });

    const saved = normalizeChartWorkspace({
      ...fallback,
      settings: { chartLabels: { showEma200TabDots: false, showDollarAmount: false, showRMultiple: true, fontSize: 14 } },
    }, fallback);
    expect(saved.settings.chartLabels).toEqual({ showEma200TabDots: false, showDollarAmount: false, showRMultiple: true, fontSize: 14 });

    const clamped = normalizeChartWorkspace({
      ...fallback,
      settings: { chartLabels: { showEma200TabDots: true, showDollarAmount: true, showRMultiple: true, fontSize: 50 } },
    }, fallback);
    expect(clamped.settings.chartLabels.fontSize).toBe(16);
  });

  it("normalizes saved watchlist symbols without changing their order", () => {
    const result = normalizeChartWorkspace({ ...fallback, watchlist: [" mnqu26 ", "MESU26", "MNQU26", "", 42] }, fallback);
    expect(result.watchlist).toEqual(["MNQU26", "MESU26"]);
  });

  it("defaults, preserves, and clamps swing-stop settings", () => {
    const legacy = normalizeChartWorkspace({ ...fallback, settings: { chartLabels: fallback.settings.chartLabels } }, fallback);
    expect(legacy.settings.orderTicket).toEqual({ swingStopPivotBars: 2, swingStopOffsetTicks: 1, sizingMode: "contracts", riskSizingPolicy: "strict", riskAmount: undefined });

    const saved = normalizeChartWorkspace({
      ...fallback,
      settings: { ...fallback.settings, orderTicket: { swingStopPivotBars: 3, swingStopOffsetTicks: 12.6 } },
    }, fallback);
    expect(saved.settings.orderTicket).toEqual({ swingStopPivotBars: 3, swingStopOffsetTicks: 13, sizingMode: "contracts", riskSizingPolicy: "strict", riskAmount: undefined });

    const clamped = normalizeChartWorkspace({
      ...fallback,
      settings: { ...fallback.settings, orderTicket: { swingStopPivotBars: 4, swingStopOffsetTicks: 500 } },
    }, fallback);
    expect(clamped.settings.orderTicket).toEqual({ swingStopPivotBars: 2, swingStopOffsetTicks: 100, sizingMode: "contracts", riskSizingPolicy: "strict", riskAmount: undefined });
  });

  it("defaults legacy journal commission and preserves a configured rate", () => {
    const legacy = normalizeChartWorkspace({ ...fallback, settings: { ...fallback.settings, journal: undefined } }, fallback);
    expect(legacy.settings.journal.commissionPerContractSide).toBe(0.4);

    const saved = normalizeChartWorkspace({
      ...fallback,
      settings: { ...fallback.settings, journal: { commissionPerContractSide: 1.25 } },
    }, fallback);
    expect(saved.settings.journal.commissionPerContractSide).toBe(1.25);
  });

  it("defaults, preserves, and validates risk-sizing preferences", () => {
    const legacy = normalizeChartWorkspace({ ...fallback, settings: { ...fallback.settings, orderTicket: { swingStopPivotBars: 2, swingStopOffsetTicks: 1 } } }, fallback);
    expect(legacy.settings.orderTicket).toMatchObject({ sizingMode: "contracts", riskSizingPolicy: "strict", riskAmount: undefined });

    const saved = normalizeChartWorkspace({
      ...fallback,
      settings: { ...fallback.settings, orderTicket: { ...fallback.settings.orderTicket, sizingMode: "risk", riskSizingPolicy: "minimum-one", riskAmount: 275.5 } },
    }, fallback);
    expect(saved.settings.orderTicket).toMatchObject({ sizingMode: "risk", riskSizingPolicy: "minimum-one", riskAmount: 275.5 });

    const invalid = normalizeChartWorkspace({
      ...fallback,
      settings: { ...fallback.settings, orderTicket: { ...fallback.settings.orderTicket, sizingMode: "other", riskSizingPolicy: "other", riskAmount: -5 } },
    }, fallback);
    expect(invalid.settings.orderTicket).toMatchObject({ sizingMode: "contracts", riskSizingPolicy: "strict", riskAmount: undefined });
  });

  it("accepts changed global settings from a workspace broadcast", () => {
    const current = normalizeChartWorkspace(fallback, fallback);
    const broadcast = normalizeChartWorkspace({
      ...current,
      revision: 2,
      settings: { chartLabels: { showEma200TabDots: false, showDollarAmount: true, showRMultiple: false, fontSize: 13 } },
    }, fallback);
    const result = stabilizeChartWorkspace(current, broadcast);
    expect(result.settings.chartLabels).toEqual({ showEma200TabDots: false, showDollarAmount: true, showRMultiple: false, fontSize: 13 });
    expect(result.settings).not.toBe(current.settings);
  });

  it("accepts changed swing-stop settings from a workspace broadcast", () => {
    const current = normalizeChartWorkspace(fallback, fallback);
    const broadcast = normalizeChartWorkspace({
      ...current,
      revision: 2,
      settings: { ...current.settings, orderTicket: { ...current.settings.orderTicket, swingStopPivotBars: 3, swingStopOffsetTicks: 4, sizingMode: "risk", riskSizingPolicy: "minimum-one", riskAmount: 150 } },
    }, fallback);
    const result = stabilizeChartWorkspace(current, broadcast);
    expect(result.settings.orderTicket).toEqual({ swingStopPivotBars: 3, swingStopOffsetTicks: 4, sizingMode: "risk", riskSizingPolicy: "minimum-one", riskAmount: 150 });
    expect(result.settings).not.toBe(current.settings);
  });

  it("limits tabs, repairs assignments, and selects a valid active tab", () => {
    const tabs = Array.from({ length: 14 }, (_, index) => cloneChartTab(fallback.tabs[0], `tab-${index}`));
    const result = normalizeChartWorkspace({ ...fallback, tabs, windows: [{ id: "main", detached: false, tabIds: tabs.map((tab) => tab.id), activeTabId: "missing" }] }, fallback);
    expect(result.tabs).toHaveLength(MAX_CHART_TABS);
    expect(result.windows[0].activeTabId).toBe("tab-0");
  });

  it("migrates legacy windows to a normalized single-chart layout", () => {
    const result = normalizeChartWorkspace(fallback, fallback);
    expect(result.windows[0]).toMatchObject({ chartLayout: "single", visibleTabIds: ["chart-1"], splitRatios: {} });
  });

  it("normalizes divider ratios and enforces a fifteen-percent pane minimum", () => {
    expect(chartLayoutCapacity("four-grid")).toBe(4);
    expect(defaultChartSplitRatios("three-columns")).toEqual([1 / 3, 2 / 3]);
    expect(normalizeChartSplitRatio("two-columns", [-5])).toEqual([0.15]);
    expect(normalizeChartSplitRatio("three-rows", [0.9, 0.1])).toEqual([0.7, 0.85]);
    expect(normalizeChartSplitRatio("four-grid", [0.99, 0.01])).toEqual([0.85, 0.15]);
  });

  it("auto-fills larger layouts from window tabs before cloning the focused tab", () => {
    const second = cloneChartTab(fallback.tabs[0], "chart-2");
    const workspace = { ...fallback, tabs: [fallback.tabs[0], second], windows: [{ ...fallback.windows[0], tabIds: ["chart-1", "chart-2"], chartLayout: "single" as const, visibleTabIds: ["chart-1"] }] };
    let suffix = 2;
    const result = setChartWindowLayout(workspace, "main", "four-grid", () => `chart-${++suffix}`);
    expect(result.tabs).toHaveLength(4);
    expect(result.windows[0]).toMatchObject({ chartLayout: "four-grid", visibleTabIds: ["chart-1", "chart-2", "chart-3", "chart-4"] });
    expect(result.tabs[2].symbol).toEqual(fallback.tabs[0].symbol);
  });

  it("keeps the focused chart visible when shrinking and replaces its pane for a hidden tab", () => {
    const tabs = [fallback.tabs[0], ...[2, 3, 4].map((index) => cloneChartTab(fallback.tabs[0], `chart-${index}`))];
    const expanded = { ...fallback, tabs, windows: [{ ...fallback.windows[0], tabIds: tabs.map((tab) => tab.id), activeTabId: "chart-4", chartLayout: "four-grid" as const, visibleTabIds: tabs.map((tab) => tab.id) }] };
    const shrunk = setChartWindowLayout(expanded, "main", "two-columns");
    expect(shrunk.windows[0].visibleTabIds).toContain("chart-4");
    const focused = focusChartTab(shrunk, "main", "chart-2");
    expect(focused.windows[0].activeTabId).toBe("chart-2");
    expect(focused.windows[0].visibleTabIds).toContain("chart-2");
    expect(focused.windows[0].visibleTabIds).not.toContain("chart-4");
  });

  it("persists normalized ratios and downgrades layouts after tabs disappear", () => {
    const tabs = [fallback.tabs[0], cloneChartTab(fallback.tabs[0], "chart-2"), cloneChartTab(fallback.tabs[0], "chart-3")];
    const split = setChartWindowSplitRatio({ ...fallback, tabs, windows: [{ ...fallback.windows[0], tabIds: tabs.map((tab) => tab.id), chartLayout: "three-columns", visibleTabIds: tabs.map((tab) => tab.id) }] }, "main", "three-columns", [0.05, 0.95]);
    expect(split.windows[0].splitRatios?.["three-columns"]).toEqual([0.15, 0.85]);
    const reconciled = reconcileChartWindow({ ...split.windows[0], tabIds: ["chart-1", "chart-2"] }, tabs.map((tab) => tab.id));
    expect(reconciled.chartLayout).toBe("two-columns");
    expect(reconciled.visibleTabIds).toHaveLength(2);
  });

  it("deep clones mutable chart settings", () => {
    const source = { ...fallback.tabs[0], indicators: [{ id: "ema", kind: "EMA" as const, period: 20, color: "#fff", visible: true }] };
    const clone = cloneChartTab(source, "copy");
    clone.indicators[0].color = "#000";
    clone.ema200Alert["1m"].enabled = true;
    clone.renkoSettings.brickSizeTicks = 20;
    expect(source.indicators[0].color).toBe("#fff");
    expect(source.ema200Alert["1m"].enabled).toBe(false);
    expect(source.renkoSettings.brickSizeTicks).toBe(4);
  });

  it("defaults and clamps synthetic chart settings", () => {
    const legacy = normalizeChartWorkspace({ ...fallback, tabs: [{ ...fallback.tabs[0], renkoSettings: undefined, pointAndFigureSettings: undefined }] }, fallback);
    expect(legacy.tabs[0].renkoSettings).toEqual({ brickSizeTicks: 4, priceSource: "close", reversalBricks: 2 });
    expect(legacy.tabs[0].pointAndFigureSettings).toEqual({ boxSizeTicks: 4, priceSource: "close", reversalBoxes: 3 });

    const saved = normalizeChartWorkspace({ ...fallback, tabs: [{ ...fallback.tabs[0], chartKind: "point-and-figure", renkoSettings: { brickSizeTicks: 50_000, priceSource: "high-low", reversalBricks: 1 }, pointAndFigureSettings: { boxSizeTicks: 0, priceSource: "high-low", reversalBoxes: 99 } }] }, fallback);
    expect(saved.tabs[0].chartKind).toBe("point-and-figure");
    expect(saved.tabs[0].renkoSettings).toEqual({ brickSizeTicks: 10_000, priceSource: "high-low", reversalBricks: 1 });
    expect(saved.tabs[0].pointAndFigureSettings).toEqual({ boxSizeTicks: 1, priceSource: "high-low", reversalBoxes: 10 });
  });

  it("moves tabs between windows and removes an empty detached window", () => {
    const workspace = { ...fallback, tabs: [fallback.tabs[0], cloneChartTab(fallback.tabs[0], "copy")], windows: [{ ...fallback.windows[0] }, { id: "detached", detached: true, tabIds: ["copy"], activeTabId: "copy" }] };
    const result = moveTab(workspace, "copy", "main", 0);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].tabIds).toEqual(["copy", "chart-1"]);
  });

  it("identifies the detached source window before moving its final tab", () => {
    const workspace = { ...fallback, tabs: [fallback.tabs[0], cloneChartTab(fallback.tabs[0], "copy")], windows: [{ ...fallback.windows[0] }, { id: "chart-window-detached", detached: true, tabIds: ["copy"], activeTabId: "copy" }] };
    expect(detachedSourceWindowToClose(workspace, "copy", "main")).toBe("chart-window-detached");
    expect(detachedSourceWindowToClose(workspace, "copy", "chart-window-detached")).toBeUndefined();
  });

  it("claims each detached window creation once until the claim is released", () => {
    const pending = new Set<string>();
    expect(claimDetachedWindowCreation(pending, "chart-window-a")).toBe(true);
    expect(claimDetachedWindowCreation(pending, "chart-window-a")).toBe(false);
    pending.delete("chart-window-a");
    expect(claimDetachedWindowCreation(pending, "chart-window-a")).toBe(true);
  });

  it("finds only native detached windows missing from the workspace", () => {
    const windows = [{ ...fallback.windows[0] }, { id: "chart-window-live", detached: true, tabIds: ["chart-1"], activeTabId: "chart-1" }];
    expect(staleDetachedWindowIds(["main", "chart-window-live", "chart-window-stale", "settings"], windows)).toEqual(["chart-window-stale"]);
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
    const workspace = { ...fallback, tabs, windows: [{ id: "main", detached: false, tabIds: ["chart-1", "b", "c"], activeTabId: "b", chartLayout: "three-columns" as const, visibleTabIds: ["chart-1", "b", "c"] }] };
    expect(moveTab(workspace, "b", "main", 2).windows[0].tabIds).toEqual(["chart-1", "b", "c"]);
    const moved = moveTab(workspace, "b", "main", 3);
    expect(moved.windows[0].tabIds).toEqual(["chart-1", "c", "b"]);
    expect(moved.windows[0].visibleTabIds).toEqual(["chart-1", "b", "c"]);
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

  it("defaults legacy workspaces to unrestricted entry rules and disabled alerts", () => {
    const result = normalizeChartWorkspace({ ...fallback, entryRules: undefined, entryRuleAlerts: undefined }, fallback);
    expect(result.entryRules.long.children).toEqual([]);
    expect(result.entryRules.short.children).toEqual([]);
    expect(result.entryRuleAlerts).toEqual(defaultEntryRuleAlerts());
    const inconsistent = normalizeChartWorkspace({
      ...fallback,
      entryRuleAlerts: { ...defaultEntryRuleAlerts(), long: { enabled: true, sound: "bell", durationSeconds: 5 } },
    }, fallback);
    expect(inconsistent.entryRuleAlerts.long).toEqual({ enabled: false, sound: "bell", durationSeconds: 5 });
  });

  it("stabilizes unchanged EMA cross rules and detects changes to their settings", () => {
    const entryRules = {
      long: {
        id: "long-root", kind: "group" as const, combinator: "and" as const, children: [
          { id: "cross", kind: "emaCross" as const, direction: "above" as const, period: 20, lookback: 5 },
        ],
      },
      short: { id: "short-root", kind: "group" as const, combinator: "and" as const, children: [] },
    };
    const current = normalizeChartWorkspace({ ...fallback, entryRules }, fallback);
    const unchanged = stabilizeChartWorkspace(current, normalizeChartWorkspace({ ...current }, fallback));
    expect(unchanged.entryRules).toBe(current.entryRules);
    expect(unchanged.entryRuleAlerts).toBe(current.entryRuleAlerts);

    const changed = normalizeChartWorkspace({
      ...current,
      entryRules: {
        ...entryRules,
        long: { ...entryRules.long, children: [{ ...entryRules.long.children[0], lookback: 6 }] },
      },
    }, fallback);
    const stabilized = stabilizeChartWorkspace(current, changed);
    expect(stabilized.entryRules).not.toBe(current.entryRules);
    expect(stabilized.entryRules.long.children[0]).toMatchObject({ kind: "emaCross", lookback: 6 });
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
      { id: "long", kind: "position", side: "long", startTime: 10, endTime: 20, entryPrice: 5000, stopPrice: 4997.5, targetPrice: 5005, quantity: 2 },
      { id: "bad-position", kind: "position", side: "short", startTime: 10, endTime: 20, entryPrice: 5000, stopPrice: 4999, targetPrice: 5001, quantity: 1 },
      { id: "bad", kind: "horizontal", points: [], color: "#fff" },
    ] } }, fallback);
    expect(result.drawings.MES).toEqual([
      { id: "line", kind: "horizontal", points: [{ time: 10, price: 5000 }], color: "#fff", locked: false, lineWidth: 1 },
      { id: "long", kind: "position", side: "long", startTime: 10, endTime: 20, entryPrice: 5000, stopPrice: 4997.5, targetPrice: 5005, quantity: 2, locked: false },
    ]);
  });
});
