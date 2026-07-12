import type { ChartTabState, ChartWindowState, WorkspaceState } from "../types";
import { normalizeIndicators, normalizeMagnetEnabled } from "./workspace";

export const MAX_CHART_TABS = 6;
export const MAIN_WINDOW_ID = "main";

export interface ScreenRect { x: number; y: number; width: number; height: number; }

export function clampWindowGeometry(window: ScreenRect, screens: ScreenRect[]): ScreenRect {
  if (!screens.length) return window;
  const visible = screens.some((screen) => window.x < screen.x + screen.width && window.x + window.width > screen.x && window.y < screen.y + screen.height && window.y + 40 > screen.y);
  if (visible) return window;
  const screen = screens[0];
  const width = Math.min(window.width, screen.width);
  const height = Math.min(window.height, screen.height);
  return { x: Math.max(screen.x, Math.min(window.x, screen.x + screen.width - width)), y: Math.max(screen.y, Math.min(window.y, screen.y + screen.height - height)), width, height };
}

export function tabInsertionIndex(pointerX: number, stripLeft: number, stripRight: number, tabCount: number): number {
  const ratio = (pointerX - stripLeft) / Math.max(1, stripRight - stripLeft);
  return Math.max(0, Math.min(tabCount, Math.round(ratio * tabCount)));
}

type LegacyWorkspace = Partial<WorkspaceState> & Partial<Omit<ChartTabState, "id">> & { bottomTab?: string };

export function cloneChartTab(tab: ChartTabState, id: string): ChartTabState {
  return { ...tab, id, symbol: { ...tab.symbol }, indicators: tab.indicators.map((indicator) => ({ ...indicator })) };
}

export function normalizeChartWorkspace(saved: unknown, fallback: WorkspaceState): WorkspaceState {
  const value = (saved && typeof saved === "object" ? saved : {}) as LegacyWorkspace;
  const fallbackTab = fallback.tabs[0];
  const sourceTabs = Array.isArray(value.tabs) && value.tabs.length
    ? value.tabs.slice(0, MAX_CHART_TABS)
    : [{
      id: "chart-1",
      symbol: value.symbol ?? fallbackTab.symbol,
      timeframe: value.timeframe ?? fallbackTab.timeframe,
      chartKind: value.chartKind ?? fallbackTab.chartKind,
      indicators: value.indicators ?? fallbackTab.indicators,
      chartTimezone: value.chartTimezone ?? fallbackTab.chartTimezone,
      magnetEnabled: normalizeMagnetEnabled(value.magnetEnabled),
    }];
  const seen = new Set<string>();
  const tabs = sourceTabs.map((tab, index) => {
    let id = tab.id && !seen.has(tab.id) ? tab.id : `chart-${index + 1}`;
    let suffix = index + 1;
    while (seen.has(id)) id = `chart-${++suffix}`;
    seen.add(id);
    return {
      ...fallbackTab,
      ...tab,
      id,
      symbol: { ...(tab.symbol ?? fallbackTab.symbol) },
      indicators: normalizeIndicators(tab.indicators).map((indicator) => ({ ...indicator })),
      chartTimezone: tab.chartTimezone ?? "exchange",
      magnetEnabled: normalizeMagnetEnabled(tab.magnetEnabled),
    };
  });
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const assigned = new Set<string>();
  const rawWindows = Array.isArray(value.windows) ? value.windows : [];
  const windows: ChartWindowState[] = rawWindows.flatMap((item, index) => {
    const ids = (item.tabIds ?? []).filter((id) => tabIds.has(id) && !assigned.has(id));
    ids.forEach((id) => assigned.add(id));
    if (!ids.length) return [];
    const id = item.id === MAIN_WINDOW_ID ? MAIN_WINDOW_ID : item.id || `chart-window-${index}`;
    return [{ ...item, id, detached: id !== MAIN_WINDOW_ID, tabIds: ids, activeTabId: ids.includes(item.activeTabId) ? item.activeTabId : ids[0] }];
  });
  let main = windows.find((item) => item.id === MAIN_WINDOW_ID);
  if (!main) {
    main = { id: MAIN_WINDOW_ID, detached: false, tabIds: [], activeTabId: "" };
    windows.unshift(main);
  }
  const unassigned = tabs.map((tab) => tab.id).filter((id) => !assigned.has(id));
  main.tabIds.push(...unassigned);
  if (!main.tabIds.length && windows.every((window) => window.id === MAIN_WINDOW_ID)) {
    const fallbackId = tabs[0].id;
    windows.forEach((window) => { if (window.id !== MAIN_WINDOW_ID) window.tabIds = window.tabIds.filter((id) => id !== fallbackId); });
    main.tabIds.push(fallbackId);
  }
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    if (windows[index].id !== MAIN_WINDOW_ID && !windows[index].tabIds.length) windows.splice(index, 1);
  }
  if (!main.tabIds.includes(main.activeTabId)) main.activeTabId = main.tabIds[0] ?? "";
  const savedBottomTab = value.bottomTab as string | undefined;
  const legacyBottomTab = savedBottomTab === "fills" ? "history" : savedBottomTab === "balances" ? "summary" : savedBottomTab;
  return {
    revision: typeof value.revision === "number" ? value.revision : 0,
    tabs,
    windows,
    watchlist: Array.isArray(value.watchlist) ? value.watchlist : fallback.watchlist,
    rightTab: value.rightTab ?? fallback.rightTab,
    rightPanelOpen: value.rightPanelOpen ?? fallback.rightPanelOpen,
    bottomTab: (legacyBottomTab ?? fallback.bottomTab) as WorkspaceState["bottomTab"],
    bottomPanelOpen: value.bottomPanelOpen ?? fallback.bottomPanelOpen,
    bottomPanelHeight: value.bottomPanelHeight ?? fallback.bottomPanelHeight,
    selectedAccountId: value.selectedAccountId ?? fallback.selectedAccountId,
  };
}

export function moveTab(workspace: WorkspaceState, tabId: string, targetWindowId: string, targetIndex: number): WorkspaceState {
  const next = structuredClone(workspace);
  let source: ChartWindowState | undefined;
  let sourceIndex = -1;
  next.windows.forEach((window) => {
    if (window.tabIds.includes(tabId)) {
      source = window;
      sourceIndex = window.tabIds.indexOf(tabId);
    }
    window.tabIds = window.tabIds.filter((id) => id !== tabId);
  });
  const target = next.windows.find((window) => window.id === targetWindowId);
  if (!target) return workspace;
  if (source?.id === targetWindowId && sourceIndex < targetIndex) targetIndex -= 1;
  target.tabIds.splice(Math.max(0, Math.min(targetIndex, target.tabIds.length)), 0, tabId);
  target.activeTabId = tabId;
  if (source && !source.tabIds.length && source.id !== MAIN_WINDOW_ID) next.windows = next.windows.filter((window) => window.id !== source!.id);
  return next;
}

export function closeDetachedWindow(workspace: WorkspaceState, windowId: string): WorkspaceState {
  const detached = workspace.windows.find((window) => window.id === windowId && window.detached);
  if (!detached) return workspace;
  const next = structuredClone(workspace);
  const main = next.windows.find((window) => window.id === MAIN_WINDOW_ID)!;
  main.tabIds.push(...detached.tabIds);
  if (!main.activeTabId) main.activeTabId = detached.activeTabId;
  next.windows = next.windows.filter((window) => window.id !== windowId);
  return next;
}
