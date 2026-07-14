import type { ChartTabState, ChartWindowState, Drawing, EntryRuleNode, WorkspaceState } from "../types";
import { normalizeEntryRules } from "./entryRules";
import { cloneEma200Alert, normalizeEma200Alert, sameEma200Alert } from "./emaAlerts";
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
  return { ...tab, id, symbol: { ...tab.symbol }, indicators: tab.indicators.map((indicator) => ({ ...indicator })), ema200Alert: cloneEma200Alert(tab.ema200Alert) };
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
      ema200Alert: normalizeEma200Alert(value.ema200Alert),
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
      ema200Alert: normalizeEma200Alert(tab.ema200Alert),
      chartTimezone: tab.chartTimezone ?? "exchange",
      magnetEnabled: normalizeMagnetEnabled(tab.magnetEnabled),
      tradeContract: typeof tab.tradeContract === "string" && tab.tradeContract.trim() && !tab.tradeContract.trim().startsWith("@")
        ? tab.tradeContract.trim().toUpperCase()
        : undefined,
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
  const drawings = Object.fromEntries(Object.entries(value.drawings ?? {}).flatMap(([symbol, items]) => {
    if (!Array.isArray(items)) return [];
    const valid = items.filter((item): item is Drawing => {
      if (!item || typeof item !== "object") return false;
      const drawing = item as Drawing;
      return ["horizontal", "horizontal-ray"].includes(drawing.kind) && typeof drawing.id === "string" && typeof drawing.color === "string"
        && Array.isArray(drawing.points) && drawing.points.length > 0 && drawing.points.every((point) => Number.isFinite(point?.time) && Number.isFinite(point?.price));
    }).map((item) => ({ ...item, locked: item.locked === true, lineWidth: [1, 2, 3, 4].includes(item.lineWidth ?? 1) ? item.lineWidth ?? 1 : 1, points: item.points.map((point) => ({ ...point })) }));
    return valid.length ? [[symbol, valid]] : [];
  }));
  return {
    revision: typeof value.revision === "number" ? value.revision : 0,
    tabs,
    windows,
    watchlist: Array.isArray(value.watchlist) ? value.watchlist : fallback.watchlist,
    drawings,
    rightTab: value.rightTab ?? fallback.rightTab,
    rightPanelOpen: value.rightPanelOpen ?? fallback.rightPanelOpen,
    bottomTab: (legacyBottomTab ?? fallback.bottomTab) as WorkspaceState["bottomTab"],
    bottomPanelOpen: value.bottomPanelOpen ?? fallback.bottomPanelOpen,
    bottomPanelHeight: value.bottomPanelHeight ?? fallback.bottomPanelHeight,
    selectedAccountId: value.selectedAccountId ?? fallback.selectedAccountId,
    confirmOrders: value.confirmOrders ?? true,
    entryRules: normalizeEntryRules(value.entryRules),
  };
}

function sameArray<T>(left: T[], right: T[], equal: (a: T, b: T) => boolean): boolean {
  return left.length === right.length && left.every((item, index) => equal(item, right[index]));
}

function sameEntryRuleNode(left: EntryRuleNode, right: EntryRuleNode): boolean {
  if (left.id !== right.id || left.kind !== right.kind) return false;
  if (left.kind === "group" && right.kind === "group") {
    return left.combinator === right.combinator && sameArray(left.children, right.children, sameEntryRuleNode);
  }
  if (left.kind !== "condition" || right.kind !== "condition" || left.operator !== right.operator) return false;
  const sameOperand = (a: typeof left.left, b: typeof right.left) => a.kind === b.kind
    && (a.kind === "marketPrice" || (b.kind === "movingAverage" && a.average === b.average && a.period === b.period));
  return sameOperand(left.left, right.left) && sameOperand(left.right, right.right);
}

/** Reuse unchanged nested state after a whole-workspace cross-window broadcast. */
export function stabilizeChartWorkspace(current: WorkspaceState, incoming: WorkspaceState): WorkspaceState {
  const currentTabs = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const tabs = incoming.tabs.map((tab) => {
    const prior = currentTabs.get(tab.id);
    if (!prior) return tab;
    const symbol = prior.symbol.symbol === tab.symbol.symbol
      && prior.symbol.description === tab.symbol.description
      && prior.symbol.exchange === tab.symbol.exchange
      && prior.symbol.assetType === tab.symbol.assetType
      && prior.symbol.minMove === tab.symbol.minMove
      && prior.symbol.pointValue === tab.symbol.pointValue
      && prior.symbol.expiration === tab.symbol.expiration
      && prior.symbol.root === tab.symbol.root
      && prior.symbol.underlying === tab.symbol.underlying
      ? prior.symbol
      : tab.symbol;
    const indicators = sameArray(prior.indicators, tab.indicators, (a, b) => (
      a.id === b.id && a.kind === b.kind && a.period === b.period && a.color === b.color && a.visible === b.visible
    )) ? prior.indicators : tab.indicators;
    const ema200Alert = sameEma200Alert(prior.ema200Alert, tab.ema200Alert) ? prior.ema200Alert : tab.ema200Alert;
    return symbol === prior.symbol && indicators === prior.indicators && ema200Alert === prior.ema200Alert
      && prior.timeframe === tab.timeframe && prior.chartKind === tab.chartKind
      && prior.chartTimezone === tab.chartTimezone && prior.magnetEnabled === tab.magnetEnabled
      && prior.tradeContract === tab.tradeContract
      ? prior
      : { ...tab, symbol, indicators, ema200Alert };
  });

  const currentWindows = new Map(current.windows.map((window) => [window.id, window]));
  const windows = incoming.windows.map((window) => {
    const prior = currentWindows.get(window.id);
    return prior && prior.activeTabId === window.activeTabId && prior.detached === window.detached
      && prior.x === window.x && prior.y === window.y && prior.width === window.width && prior.height === window.height
      && sameArray(prior.tabIds, window.tabIds, (a, b) => a === b)
      ? prior
      : window;
  });

  const drawings = Object.fromEntries(Object.entries(incoming.drawings).map(([symbol, items]) => {
    const prior = current.drawings[symbol];
    const stable = prior && sameArray(prior, items, (a, b) => (
      a.id === b.id && a.kind === b.kind && a.text === b.text && a.color === b.color
      && a.locked === b.locked && a.lineWidth === b.lineWidth
      && sameArray(a.points, b.points, (left, right) => left.time === right.time && left.price === right.price)
    ));
    return [symbol, stable ? prior : items];
  }));
  const entryRules = sameEntryRuleNode(current.entryRules.long, incoming.entryRules.long)
    && sameEntryRuleNode(current.entryRules.short, incoming.entryRules.short)
    ? current.entryRules
    : incoming.entryRules;

  return {
    ...incoming,
    tabs: sameArray(current.tabs, tabs, (a, b) => a === b) ? current.tabs : tabs,
    windows: sameArray(current.windows, windows, (a, b) => a === b) ? current.windows : windows,
    watchlist: sameArray(current.watchlist, incoming.watchlist, (a, b) => a === b) ? current.watchlist : incoming.watchlist,
    drawings: Object.keys(current.drawings).length === Object.keys(drawings).length
      && Object.entries(drawings).every(([symbol, items]) => current.drawings[symbol] === items)
      ? current.drawings
      : drawings,
    entryRules,
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
  const closedTabIds = new Set(detached.tabIds);
  next.tabs = next.tabs.filter((tab) => !closedTabIds.has(tab.id));
  next.windows = next.windows.filter((window) => window.id !== windowId);
  return next;
}
