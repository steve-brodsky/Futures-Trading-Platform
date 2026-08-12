import type { ChartLayout, ChartSplitRatios, ChartTabState, ChartWindowState, Drawing, EntryRuleNode, WorkspaceState } from "../types";
import { normalizeEntryRules } from "./entryRules";
import { normalizeEntryRuleAlerts, sameEntryRuleAlerts } from "./entryRuleAlerts";
import { cloneEma200Alert, normalizeEma200Alert, sameEma200Alert } from "./emaAlerts";
import { quoteSubscriptionInstruments } from "./futuresContracts";
import { normalizeRecentSymbols, normalizeSymbolMeta, normalizeWatchlist } from "./watchlist";
import { normalizeIndicators, normalizeMagnetEnabled } from "./workspace";
import { normalizeGexSelection, normalizeGexTabSettings } from "./gex";
import { normalizeOptionChainPreferences } from "./optionChain";
import { normalizePointAndFigureSettings, normalizeRenkoSettings } from "./priceBasedCharts";
import { isValidPositionDrawing } from "./positionDrawing";
import { normalizeDrawingAlert, sameDrawingAlert } from "./drawingAlerts";
import { normalizeChartSessionSettings } from "./chartSessions";
import { normalizeChartEconomicEventSettings } from "./economicEvents";
import { normalizeContractRollAlertSettings } from "./contractRoll";
import { normalizeCustomMinuteTimeframes, normalizeTimeframe } from "./timeframes";

export const MAX_CHART_TABS = 12;
export const MAIN_WINDOW_ID = "main";
export const CHART_LAYOUTS: ChartLayout[] = ["single", "two-columns", "two-rows", "three-columns", "three-rows", "four-grid"];
export const MIN_CHART_PANE_RATIO = 0.15;

export function chartLayoutCapacity(layout: ChartLayout): number {
  if (layout === "single") return 1;
  if (layout === "two-columns" || layout === "two-rows") return 2;
  if (layout === "three-columns" || layout === "three-rows") return 3;
  return 4;
}

export function defaultChartSplitRatios(layout: ChartLayout): number[] {
  if (layout === "two-columns" || layout === "two-rows") return [0.5];
  if (layout === "three-columns" || layout === "three-rows") return [1 / 3, 2 / 3];
  if (layout === "four-grid") return [0.5, 0.5];
  return [];
}

function finiteRatios(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
}

export function normalizeChartSplitRatio(layout: ChartLayout, value: unknown): number[] {
  const ratios = finiteRatios(value);
  if (layout === "single") return [];
  if (layout === "two-columns" || layout === "two-rows") {
    return [Math.max(MIN_CHART_PANE_RATIO, Math.min(1 - MIN_CHART_PANE_RATIO, ratios[0] ?? 0.5))];
  }
  if (layout === "three-columns" || layout === "three-rows") {
    let first = Math.max(MIN_CHART_PANE_RATIO, Math.min(1 - MIN_CHART_PANE_RATIO * 2, ratios[0] ?? 1 / 3));
    let second = Math.max(first + MIN_CHART_PANE_RATIO, Math.min(1 - MIN_CHART_PANE_RATIO, ratios[1] ?? 2 / 3));
    if (second > 1 - MIN_CHART_PANE_RATIO) {
      second = 1 - MIN_CHART_PANE_RATIO;
      first = Math.min(first, second - MIN_CHART_PANE_RATIO);
    }
    return [first, second];
  }
  return [
    Math.max(MIN_CHART_PANE_RATIO, Math.min(1 - MIN_CHART_PANE_RATIO, ratios[0] ?? 0.5)),
    Math.max(MIN_CHART_PANE_RATIO, Math.min(1 - MIN_CHART_PANE_RATIO, ratios[1] ?? 0.5)),
  ];
}

export function normalizeChartSplitRatios(value: unknown): ChartSplitRatios {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(CHART_LAYOUTS.filter((layout) => layout !== "single" && source[layout] != null)
    .map((layout) => [layout, normalizeChartSplitRatio(layout, source[layout])])) as ChartSplitRatios;
}

export function normalizedChartLayout(value: unknown): ChartLayout {
  return CHART_LAYOUTS.includes(value as ChartLayout) ? value as ChartLayout : "single";
}

function preferredLayoutForCount(count: number, preferred: ChartLayout): ChartLayout {
  if (count <= 1) return "single";
  if (count === 2) return preferred.endsWith("rows") ? "two-rows" : "two-columns";
  if (count === 3) return preferred.endsWith("rows") ? "three-rows" : "three-columns";
  return "four-grid";
}

export function reconcileChartWindow(window: ChartWindowState, validTabIds: Iterable<string>): ChartWindowState {
  const valid = new Set(validTabIds);
  const tabIds = window.tabIds.filter((id, index, items) => valid.has(id) && items.indexOf(id) === index);
  let activeTabId = tabIds.includes(window.activeTabId) ? window.activeTabId : tabIds[0] ?? "";
  const requestedLayout = normalizedChartLayout(window.chartLayout);
  const layout = preferredLayoutForCount(Math.min(chartLayoutCapacity(requestedLayout), Math.max(1, tabIds.length)), requestedLayout);
  const capacity = Math.min(chartLayoutCapacity(layout), tabIds.length);
  const requestedVisible = Array.isArray(window.visibleTabIds) ? window.visibleTabIds : [activeTabId];
  const visibleTabIds = requestedVisible.filter((id, index, items) => tabIds.includes(id) && items.indexOf(id) === index).slice(0, capacity);
  if (activeTabId && !visibleTabIds.includes(activeTabId)) {
    if (visibleTabIds.length >= capacity) visibleTabIds[Math.max(0, capacity - 1)] = activeTabId;
    else visibleTabIds.push(activeTabId);
  }
  for (const id of tabIds) {
    if (visibleTabIds.length >= capacity) break;
    if (!visibleTabIds.includes(id)) visibleTabIds.push(id);
  }
  if (!activeTabId && visibleTabIds.length) activeTabId = visibleTabIds[0];
  return {
    ...window,
    tabIds,
    activeTabId,
    chartLayout: layout,
    visibleTabIds,
    splitRatios: normalizeChartSplitRatios(window.splitRatios),
  };
}

export function focusChartTab(workspace: WorkspaceState, windowId: string, tabId: string): WorkspaceState {
  const next = structuredClone(workspace);
  const window = next.windows.find((item) => item.id === windowId);
  if (!window || !window.tabIds.includes(tabId)) return workspace;
  const normalized = reconcileChartWindow(window, next.tabs.map((tab) => tab.id));
  const visible = [...(normalized.visibleTabIds ?? [])];
  if (!visible.includes(tabId)) {
    const focusedIndex = Math.max(0, visible.indexOf(normalized.activeTabId));
    visible[focusedIndex] = tabId;
  }
  Object.assign(window, normalized, { activeTabId: tabId, visibleTabIds: visible });
  return next;
}

export function setChartWindowLayout(workspace: WorkspaceState, windowId: string, layout: ChartLayout, createId: () => string = () => `chart-${crypto.randomUUID()}`): WorkspaceState {
  const desiredCapacity = chartLayoutCapacity(layout);
  const window = workspace.windows.find((item) => item.id === windowId);
  if (!window) return workspace;
  const normalized = reconcileChartWindow(window, workspace.tabs.map((tab) => tab.id));
  const missing = Math.max(0, desiredCapacity - normalized.tabIds.length);
  if (workspace.tabs.length + missing > MAX_CHART_TABS) return workspace;
  const source = workspace.tabs.find((tab) => tab.id === normalized.activeTabId) ?? workspace.tabs[0];
  if (!source) return workspace;
  const next = structuredClone(workspace);
  const target = next.windows.find((item) => item.id === windowId)!;
  for (let index = 0; index < missing; index += 1) {
    let id = createId();
    while (next.tabs.some((tab) => tab.id === id)) id = createId();
    next.tabs.push(cloneChartTab(source, id));
    target.tabIds.push(id);
  }
  const currentVisible = (normalized.visibleTabIds ?? []).filter((id) => target.tabIds.includes(id));
  const visibleTabIds = currentVisible.slice(0, desiredCapacity);
  if (!visibleTabIds.includes(normalized.activeTabId)) {
    if (visibleTabIds.length >= desiredCapacity) visibleTabIds[desiredCapacity - 1] = normalized.activeTabId;
    else visibleTabIds.push(normalized.activeTabId);
  }
  for (const id of target.tabIds) {
    if (visibleTabIds.length >= desiredCapacity) break;
    if (!visibleTabIds.includes(id)) visibleTabIds.push(id);
  }
  target.chartLayout = layout;
  target.visibleTabIds = visibleTabIds;
  target.splitRatios = normalizeChartSplitRatios(target.splitRatios);
  return next;
}

export function setChartWindowSplitRatio(workspace: WorkspaceState, windowId: string, layout: ChartLayout, ratios: number[]): WorkspaceState {
  const next = structuredClone(workspace);
  const window = next.windows.find((item) => item.id === windowId);
  if (!window) return workspace;
  window.splitRatios = { ...normalizeChartSplitRatios(window.splitRatios), [layout]: normalizeChartSplitRatio(layout, ratios) };
  return next;
}

export function chartPaneMountPlan(current: string[], target: string[]): { immediate: string[]; deferred?: string[] } {
  if (target.length === current.length && target.every((id, index) => id === current[index])) {
    return { immediate: current };
  }
  if (!target.some((id) => !current.includes(id))) return { immediate: target };
  const retained = current.filter((id) => target.includes(id));
  return {
    immediate: retained.length ? retained : target.slice(0, 1),
    deferred: target,
  };
}

export interface ScreenRect { x: number; y: number; width: number; height: number; }

export function claimDetachedWindowCreation(pending: Set<string>, windowId: string): boolean {
  if (pending.has(windowId)) return false;
  pending.add(windowId);
  return true;
}

export function staleDetachedWindowIds(nativeWindowIds: Iterable<string>, windows: ChartWindowState[]): string[] {
  const desired = new Set(windows.filter((window) => window.detached).map((window) => window.id));
  return [...nativeWindowIds].filter((windowId) => windowId.startsWith("chart-window-") && !desired.has(windowId));
}

export function detachedSourceWindowToClose(workspace: WorkspaceState, tabId: string, targetWindowId: string): string | undefined {
  const source = workspace.windows.find((window) => window.tabIds.includes(tabId));
  return source && source.detached && source.id !== targetWindowId && source.tabIds.length === 1 ? source.id : undefined;
}

export function savedPhysicalWindowGeometry(window: ChartWindowState): ScreenRect | undefined {
  const values = [window.physicalX, window.physicalY, window.physicalWidth, window.physicalHeight];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
  if (window.physicalWidth! <= 0 || window.physicalHeight! <= 0) return undefined;
  return { x: window.physicalX!, y: window.physicalY!, width: window.physicalWidth!, height: window.physicalHeight! };
}

export function rememberWindowGeometry(window: ChartWindowState, geometry: ScreenRect, scaleFactor: number, maximized = window.maximized === true): ChartWindowState {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return {
    ...window,
    maximized,
    x: Math.round(geometry.x / scale),
    y: Math.round(geometry.y / scale),
    width: Math.round(geometry.width / scale),
    height: Math.round(geometry.height / scale),
    physicalX: Math.round(geometry.x),
    physicalY: Math.round(geometry.y),
    physicalWidth: Math.round(geometry.width),
    physicalHeight: Math.round(geometry.height),
  };
}

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
  return {
    ...tab,
    id,
    symbol: { ...tab.symbol },
    indicators: tab.indicators.map((indicator) => ({ ...indicator })),
    ema200Alert: cloneEma200Alert(tab.ema200Alert),
    renkoSettings: { ...tab.renkoSettings },
    pointAndFigureSettings: { ...tab.pointAndFigureSettings },
    gex: { ...tab.gex },
  };
}

export function normalizeChartWorkspace(saved: unknown, fallback: WorkspaceState, sessionCustomMinuteTimeframes: number[] = []): WorkspaceState {
  const value = (saved && typeof saved === "object" ? saved : {}) as LegacyWorkspace;
  const fallbackTab = fallback.tabs[0];
  const customMinuteTimeframes = normalizeCustomMinuteTimeframes(value.customMinuteTimeframes);
  const allowedMinuteTimeframes = normalizeCustomMinuteTimeframes([...customMinuteTimeframes, ...sessionCustomMinuteTimeframes]);
  const sourceTabs = Array.isArray(value.tabs) && value.tabs.length
    ? value.tabs.slice(0, MAX_CHART_TABS)
    : [{
      id: "chart-1",
      symbol: value.symbol ?? fallbackTab.symbol,
      timeframe: value.timeframe ?? fallbackTab.timeframe,
      chartKind: value.chartKind ?? fallbackTab.chartKind,
      renkoSettings: value.renkoSettings ?? fallbackTab.renkoSettings,
      pointAndFigureSettings: value.pointAndFigureSettings ?? fallbackTab.pointAndFigureSettings,
      indicators: value.indicators ?? fallbackTab.indicators,
      ema200Alert: normalizeEma200Alert(value.ema200Alert),
      chartTimezone: value.chartTimezone ?? fallbackTab.chartTimezone,
      magnetEnabled: normalizeMagnetEnabled(value.magnetEnabled),
      gex: normalizeGexTabSettings(value.gex),
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
      timeframe: normalizeTimeframe(tab.timeframe, allowedMinuteTimeframes, fallbackTab.timeframe),
      symbol: normalizeSymbolMeta(tab.symbol) ?? { ...fallbackTab.symbol },
      indicators: normalizeIndicators(tab.indicators).map((indicator) => ({ ...indicator })),
      ema200Alert: normalizeEma200Alert(tab.ema200Alert),
      chartKind: ["candles", "line", "area", "renko", "point-and-figure"].includes(tab.chartKind) ? tab.chartKind : fallbackTab.chartKind,
      renkoSettings: normalizeRenkoSettings(tab.renkoSettings),
      pointAndFigureSettings: normalizePointAndFigureSettings(tab.pointAndFigureSettings),
      chartTimezone: tab.chartTimezone ?? "exchange",
      magnetEnabled: normalizeMagnetEnabled(tab.magnetEnabled),
      gex: normalizeGexTabSettings(tab.gex),
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
  const normalizedWindows = windows.map((window) => reconcileChartWindow(window, tabIds));
  const savedBottomTab = value.bottomTab as string | undefined;
  const legacyBottomTab = savedBottomTab === "fills" ? "history" : savedBottomTab === "balances" ? "summary" : savedBottomTab;
  const drawings = Object.fromEntries(Object.entries(value.drawings ?? {}).flatMap(([symbol, items]) => {
    if (!Array.isArray(items)) return [];
    const valid = items.filter((item): item is Drawing => {
      if (!item || typeof item !== "object") return false;
      const drawing = item as Drawing;
      if (drawing.kind === "position") return isValidPositionDrawing(drawing);
      return ["horizontal", "horizontal-ray"].includes(drawing.kind) && typeof drawing.id === "string" && typeof drawing.color === "string"
        && Array.isArray(drawing.points) && drawing.points.length > 0 && drawing.points.every((point) => Number.isFinite(point?.time) && Number.isFinite(point?.price));
    }).map((item) => {
      if (item.kind === "position") return { ...item, locked: item.locked === true };
      const normalized = {
        ...item,
        locked: item.locked === true,
        lineWidth: [1, 2, 3, 4].includes(item.lineWidth ?? 1) ? item.lineWidth ?? 1 : 1,
        points: item.points.map((point) => ({ ...point })),
      };
      const alert = normalizeDrawingAlert(item.alert);
      if (alert) normalized.alert = alert;
      else delete normalized.alert;
      return normalized;
    });
    return valid.length ? [[symbol, valid]] : [];
  }));
  const gexSelections = Object.fromEntries(Object.entries(value.gexSelections ?? fallback.gexSelections ?? {}).flatMap(([symbol, selection]) => {
    const normalizedSymbol = symbol.trim().toUpperCase();
    return normalizedSymbol ? [[normalizedSymbol, normalizeGexSelection(selection)]] : [];
  }));
  const savedChartLabels = value.settings?.chartLabels;
  const savedChartSessions = value.settings?.chartSessions;
  const savedChartEconomicEvents = value.settings?.chartEconomicEvents;
  const savedOrderTicket = value.settings?.orderTicket;
  const savedContractRollAlerts = value.settings?.contractRollAlerts;
  const savedTruthSocialAlerts = value.settings?.truthSocialAlerts;
  const savedJournal = value.settings?.journal;
  const entryRules = normalizeEntryRules(value.entryRules);
  const entryRuleAlerts = normalizeEntryRuleAlerts(value.entryRuleAlerts);
  const rawEntryRuleLock = value.entryRuleLock && typeof value.entryRuleLock === "object" ? value.entryRuleLock : undefined;
  const entryRuleLock = {
    enabled: rawEntryRuleLock?.enabled === true,
    ...(rawEntryRuleLock?.enabled === true && typeof rawEntryRuleLock.lockedAt === "string" && rawEntryRuleLock.lockedAt.trim()
      ? { lockedAt: rawEntryRuleLock.lockedAt }
      : {}),
  };
  (["long", "short"] as const).forEach((side) => {
    if (!entryRules[side].children.length) entryRuleAlerts[side].enabled = false;
  });
  const watchlist = normalizeWatchlist(
    Array.isArray(value.watchlist) ? value.watchlist : fallback.watchlist,
    quoteSubscriptionInstruments({ tabs, watchlist: [] }),
  );
  const activeTabSymbols = normalizedWindows.flatMap((window) => {
    const active = tabs.find((tab) => tab.id === window.activeTabId);
    return active ? [active.symbol] : [];
  });
  const recentSymbols = normalizeRecentSymbols(value.recentSymbols, [
    ...activeTabSymbols,
    ...tabs.map((tab) => tab.symbol),
    ...watchlist,
    ...fallback.recentSymbols,
  ]);
  return {
    revision: typeof value.revision === "number" ? value.revision : 0,
    environment: value.environment === "live" || value.environment === "sim" ? value.environment : fallback.environment,
    customMinuteTimeframes,
    tabs,
    windows: normalizedWindows,
    watchlist,
    recentSymbols,
    drawings,
    gexSelections,
    activeWorkspace: value.activeWorkspace === "options" ? "options" : "charts",
    optionChain: normalizeOptionChainPreferences(value.optionChain ?? fallback.optionChain),
    rightPanelOpen: value.rightPanelOpen ?? fallback.rightPanelOpen,
    bottomTab: (legacyBottomTab ?? fallback.bottomTab) as WorkspaceState["bottomTab"],
    bottomBrokerPanel: ["combined", "tradestation", "schwab"].includes(value.bottomBrokerPanel as string)
      ? value.bottomBrokerPanel as WorkspaceState["bottomBrokerPanel"]
      : "combined",
    bottomPanelOpen: value.bottomPanelOpen ?? fallback.bottomPanelOpen,
    bottomPanelHeight: value.bottomPanelHeight ?? fallback.bottomPanelHeight,
    selectedAccountId: value.selectedAccountId ?? fallback.selectedAccountId,
    selectedSchwabAccountId: value.selectedSchwabAccountId ?? fallback.selectedSchwabAccountId,
    confirmOrders: value.confirmOrders ?? true,
    entryRules,
    entryRuleAlerts,
    entryRuleLock,
    settings: {
      crosshairSyncEnabled: typeof value.settings?.crosshairSyncEnabled === "boolean"
        ? value.settings.crosshairSyncEnabled
        : fallback.settings.crosshairSyncEnabled,
      chartLabels: {
        showEma200TabDots: typeof savedChartLabels?.showEma200TabDots === "boolean"
          ? savedChartLabels.showEma200TabDots
          : fallback.settings.chartLabels.showEma200TabDots,
        showDollarAmount: typeof savedChartLabels?.showDollarAmount === "boolean"
          ? savedChartLabels.showDollarAmount
          : fallback.settings.chartLabels.showDollarAmount,
        showRMultiple: typeof savedChartLabels?.showRMultiple === "boolean"
          ? savedChartLabels.showRMultiple
          : fallback.settings.chartLabels.showRMultiple,
        fontSize: typeof savedChartLabels?.fontSize === "number" && Number.isFinite(savedChartLabels.fontSize)
          ? Math.max(8, Math.min(16, Math.round(savedChartLabels.fontSize)))
          : fallback.settings.chartLabels.fontSize,
      },
      chartSessions: normalizeChartSessionSettings(savedChartSessions, fallback.settings.chartSessions),
      chartEconomicEvents: normalizeChartEconomicEventSettings(savedChartEconomicEvents, fallback.settings.chartEconomicEvents),
      orderTicket: {
        swingStopPivotBars: savedOrderTicket?.swingStopPivotBars === 2 || savedOrderTicket?.swingStopPivotBars === 3
          ? savedOrderTicket.swingStopPivotBars
          : fallback.settings.orderTicket.swingStopPivotBars,
        swingStopOffsetTicks: typeof savedOrderTicket?.swingStopOffsetTicks === "number" && Number.isFinite(savedOrderTicket.swingStopOffsetTicks)
          ? Math.max(1, Math.min(100, Math.round(savedOrderTicket.swingStopOffsetTicks)))
          : fallback.settings.orderTicket.swingStopOffsetTicks,
        sizingMode: savedOrderTicket?.sizingMode === "risk" || savedOrderTicket?.sizingMode === "contracts"
          ? savedOrderTicket.sizingMode
          : fallback.settings.orderTicket.sizingMode,
        riskSizingPolicy: savedOrderTicket?.riskSizingPolicy === "minimum-one" || savedOrderTicket?.riskSizingPolicy === "strict"
          ? savedOrderTicket.riskSizingPolicy
          : fallback.settings.orderTicket.riskSizingPolicy,
        riskAmount: typeof savedOrderTicket?.riskAmount === "number" && Number.isFinite(savedOrderTicket.riskAmount) && savedOrderTicket.riskAmount > 0
          ? savedOrderTicket.riskAmount
          : undefined,
      },
      contractRollAlerts: normalizeContractRollAlertSettings(savedContractRollAlerts ?? fallback.settings.contractRollAlerts),
      truthSocialAlerts: {
        enabled: typeof savedTruthSocialAlerts?.enabled === "boolean"
          ? savedTruthSocialAlerts.enabled
          : fallback.settings.truthSocialAlerts.enabled,
      },
      journal: {
        commissionPerContractSide: typeof savedJournal?.commissionPerContractSide === "number" && Number.isFinite(savedJournal.commissionPerContractSide)
          ? Math.max(0, Math.min(100, savedJournal.commissionPerContractSide))
          : fallback.settings.journal.commissionPerContractSide,
        schwabOptionFeePerContractSide: typeof savedJournal?.schwabOptionFeePerContractSide === "number" && Number.isFinite(savedJournal.schwabOptionFeePerContractSide)
          ? Math.max(0, Math.min(100, savedJournal.schwabOptionFeePerContractSide))
          : fallback.settings.journal.schwabOptionFeePerContractSide,
      },
    },
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
  if (left.kind === "emaCross" && right.kind === "emaCross") {
    return left.direction === right.direction && left.period === right.period && left.lookback === right.lookback;
  }
  if (left.kind === "candleCloseWindow" && right.kind === "candleCloseWindow") {
    return left.windowSeconds === right.windowSeconds;
  }
  if (left.kind === "timeWindow" && right.kind === "timeWindow") {
    return left.startTime === right.startTime && left.endTime === right.endTime
      && left.timezone === right.timezone && sameArray(left.weekdays, right.weekdays, (a, b) => a === b);
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
    const symbol = prior.symbol.provider === tab.symbol.provider
      && prior.symbol.symbol === tab.symbol.symbol
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
    const indicators = sameArray(prior.indicators, tab.indicators, (a, b) => {
      if (a.id !== b.id || a.kind !== b.kind || a.visible !== b.visible) return false;
      if (a.kind === "FAILED_BREAKOUT" && b.kind === "FAILED_BREAKOUT") {
        return a.pivotBars === b.pivotBars && a.toleranceTicks === b.toleranceTicks
          && a.reclaimBars === b.reclaimBars && a.pairMode === b.pairMode;
      }
      if (a.kind === "FAILED_BREAKOUT" || b.kind === "FAILED_BREAKOUT") return false;
      return a.period === b.period && a.color === b.color;
    }) ? prior.indicators : tab.indicators;
    const ema200Alert = sameEma200Alert(prior.ema200Alert, tab.ema200Alert) ? prior.ema200Alert : tab.ema200Alert;
    return symbol === prior.symbol && indicators === prior.indicators && ema200Alert === prior.ema200Alert
      && prior.timeframe === tab.timeframe && prior.chartKind === tab.chartKind
      && prior.renkoSettings.brickSizeTicks === tab.renkoSettings.brickSizeTicks
      && prior.renkoSettings.priceSource === tab.renkoSettings.priceSource
      && prior.renkoSettings.reversalBricks === tab.renkoSettings.reversalBricks
      && prior.pointAndFigureSettings.boxSizeTicks === tab.pointAndFigureSettings.boxSizeTicks
      && prior.pointAndFigureSettings.priceSource === tab.pointAndFigureSettings.priceSource
      && prior.pointAndFigureSettings.reversalBoxes === tab.pointAndFigureSettings.reversalBoxes
      && prior.chartTimezone === tab.chartTimezone && prior.magnetEnabled === tab.magnetEnabled
      && prior.tradeContract === tab.tradeContract
      ? prior
      : { ...tab, symbol, indicators, ema200Alert };
  });

  const currentWindows = new Map(current.windows.map((window) => [window.id, window]));
  const windows = incoming.windows.map((window) => {
    const prior = currentWindows.get(window.id);
    return prior && prior.activeTabId === window.activeTabId && prior.detached === window.detached && prior.maximized === window.maximized
      && prior.x === window.x && prior.y === window.y && prior.width === window.width && prior.height === window.height
      && prior.physicalX === window.physicalX && prior.physicalY === window.physicalY
      && prior.physicalWidth === window.physicalWidth && prior.physicalHeight === window.physicalHeight
      && sameArray(prior.tabIds, window.tabIds, (a, b) => a === b)
      && prior.chartLayout === window.chartLayout
      && sameArray(prior.visibleTabIds ?? [], window.visibleTabIds ?? [], (a, b) => a === b)
      && JSON.stringify(prior.splitRatios ?? {}) === JSON.stringify(window.splitRatios ?? {})
      ? prior
      : window;
  });

  const drawings = Object.fromEntries(Object.entries(incoming.drawings).map(([symbol, items]) => {
    const prior = current.drawings[symbol];
    const stable = prior && sameArray(prior, items, (a, b) => {
      if (a.id !== b.id || a.kind !== b.kind || a.locked !== b.locked) return false;
      if (a.kind === "position" && b.kind === "position") {
        return a.side === b.side && a.startTime === b.startTime && a.endTime === b.endTime
          && a.entryPrice === b.entryPrice && a.stopPrice === b.stopPrice && a.targetPrice === b.targetPrice && a.quantity === b.quantity;
      }
      if (a.kind === "position" || b.kind === "position") return false;
      return a.text === b.text && a.color === b.color && a.lineWidth === b.lineWidth && sameDrawingAlert(a.alert, b.alert)
        && sameArray(a.points, b.points, (left, right) => left.time === right.time && left.price === right.price);
    });
    return [symbol, stable ? prior : items];
  }));
  const entryRules = sameEntryRuleNode(current.entryRules.long, incoming.entryRules.long)
    && sameEntryRuleNode(current.entryRules.short, incoming.entryRules.short)
    && current.entryRules.allowEntries.long === incoming.entryRules.allowEntries.long
    && current.entryRules.allowEntries.short === incoming.entryRules.allowEntries.short
    ? current.entryRules
    : incoming.entryRules;
  const entryRuleAlerts = sameEntryRuleAlerts(current.entryRuleAlerts, incoming.entryRuleAlerts)
    ? current.entryRuleAlerts
    : incoming.entryRuleAlerts;
  const entryRuleLock = current.entryRuleLock.enabled === incoming.entryRuleLock.enabled
    && current.entryRuleLock.lockedAt === incoming.entryRuleLock.lockedAt
    ? current.entryRuleLock
    : incoming.entryRuleLock;
  const settings = current.settings.crosshairSyncEnabled === incoming.settings.crosshairSyncEnabled
    && current.settings.chartLabels.showEma200TabDots === incoming.settings.chartLabels.showEma200TabDots
    && current.settings.chartLabels.showDollarAmount === incoming.settings.chartLabels.showDollarAmount
    && current.settings.chartLabels.showRMultiple === incoming.settings.chartLabels.showRMultiple
    && current.settings.chartLabels.fontSize === incoming.settings.chartLabels.fontSize
    && current.settings.chartSessions.colorMode === incoming.settings.chartSessions.colorMode
    && current.settings.chartSessions.overnightColor === incoming.settings.chartSessions.overnightColor
    && current.settings.chartSessions.asiaColor === incoming.settings.chartSessions.asiaColor
    && current.settings.chartSessions.londonColor === incoming.settings.chartSessions.londonColor
    && current.settings.chartEconomicEvents.enabled === incoming.settings.chartEconomicEvents.enabled
    && current.settings.chartEconomicEvents.impactVisibility.high === incoming.settings.chartEconomicEvents.impactVisibility.high
    && current.settings.chartEconomicEvents.impactVisibility.medium === incoming.settings.chartEconomicEvents.impactVisibility.medium
    && current.settings.chartEconomicEvents.impactVisibility.low === incoming.settings.chartEconomicEvents.impactVisibility.low
    && current.settings.chartEconomicEvents.impactVisibility.unrated === incoming.settings.chartEconomicEvents.impactVisibility.unrated
    && current.settings.orderTicket.swingStopPivotBars === incoming.settings.orderTicket.swingStopPivotBars
    && current.settings.orderTicket.swingStopOffsetTicks === incoming.settings.orderTicket.swingStopOffsetTicks
    && current.settings.orderTicket.sizingMode === incoming.settings.orderTicket.sizingMode
    && current.settings.orderTicket.riskSizingPolicy === incoming.settings.orderTicket.riskSizingPolicy
    && current.settings.orderTicket.riskAmount === incoming.settings.orderTicket.riskAmount
    && current.settings.journal.commissionPerContractSide === incoming.settings.journal.commissionPerContractSide
    ? current.settings
    : incoming.settings;

  return {
    ...incoming,
    tabs: sameArray(current.tabs, tabs, (a, b) => a === b) ? current.tabs : tabs,
    windows: sameArray(current.windows, windows, (a, b) => a === b) ? current.windows : windows,
    watchlist: sameArray(current.watchlist, incoming.watchlist, (a, b) => a === b) ? current.watchlist : incoming.watchlist,
    recentSymbols: sameArray(current.recentSymbols, incoming.recentSymbols, (a, b) => a === b) ? current.recentSymbols : incoming.recentSymbols,
    drawings: Object.keys(current.drawings).length === Object.keys(drawings).length
      && Object.entries(drawings).every(([symbol, items]) => current.drawings[symbol] === items)
      ? current.drawings
      : drawings,
    entryRules,
    entryRuleAlerts,
    entryRuleLock,
    settings,
  };
}

export function moveTab(workspace: WorkspaceState, tabId: string, targetWindowId: string, targetIndex: number): WorkspaceState {
  const next = structuredClone(workspace);
  let source: ChartWindowState | undefined;
  let sourceIndex = -1;
  const originalTarget = next.windows.find((window) => window.id === targetWindowId);
  const originalTargetVisible = [...(originalTarget?.visibleTabIds ?? (originalTarget?.activeTabId ? [originalTarget.activeTabId] : []))];
  const originalTargetActive = originalTarget?.activeTabId ?? "";
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
  const targetVisible = originalTargetVisible.filter((id) => id !== tabId);
  if (originalTargetVisible.includes(tabId)) targetVisible.splice(originalTargetVisible.indexOf(tabId), 0, tabId);
  else {
    const focusedIndex = Math.max(0, targetVisible.indexOf(originalTargetActive));
    if (targetVisible.length < chartLayoutCapacity(normalizedChartLayout(target.chartLayout))) targetVisible.push(tabId);
    else targetVisible[focusedIndex] = tabId;
  }
  target.activeTabId = tabId;
  target.visibleTabIds = targetVisible;
  if (source && !source.tabIds.length && source.id !== MAIN_WINDOW_ID) next.windows = next.windows.filter((window) => window.id !== source!.id);
  const validTabIds = next.tabs.map((tab) => tab.id);
  next.windows = next.windows.map((window) => reconcileChartWindow(window, validTabIds));
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
