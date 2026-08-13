import type {
  ChartTabState,
  ChartWindowState,
  CloudPreferenceCategory,
  CloudPreferenceProfile,
  CloudPreferenceRecord,
  WorkspaceState,
} from "../types";
import { normalizeChartWorkspace } from "./chartWorkspace";
import { normalizeEma200Alert } from "./emaAlerts";
import { normalizeEntryRuleAlerts } from "./entryRuleAlerts";
import { normalizeContractRollAlertSettings } from "./contractRoll";
import { parseMinuteTimeframe } from "./timeframes";

export const CLOUD_PREFERENCE_CATEGORIES: CloudPreferenceCategory[] = [
  "chart_workspace",
  "alerts",
  "drawings",
  "watchlist",
  "chart_display",
  "order_entry",
  "journal_fees",
];

export function preferenceRetryDelay(attempt: number): number {
  return Math.min(60_000, 2 ** Math.min(Math.max(0, attempt), 6) * 1000);
}

export function preferencePollInterval(realtimeState: "disabled" | "connecting" | "connected" | "reconnecting"): number {
  return realtimeState === "connected" ? 5 * 60_000 : 30_000;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function cloudTab(tab: ChartTabState): JsonObject {
  const { ema200Alert: _alerts, ...saved } = tab;
  return saved as unknown as JsonObject;
}

function cloudWindow(window: ChartWindowState): JsonObject {
  return {
    id: window.id,
    tabIds: [...window.tabIds],
    activeTabId: window.activeTabId,
    detached: window.detached,
    chartLayout: window.chartLayout,
    visibleTabIds: [...(window.visibleTabIds ?? [])],
  };
}

export function cloudPreferenceProfile(workspace: WorkspaceState): CloudPreferenceProfile {
  return {
    schemaVersion: 1,
    categories: {
      chart_workspace: {
        tabs: workspace.tabs.map(cloudTab),
        windows: workspace.windows.map(cloudWindow),
        customMinuteTimeframes: [...workspace.customMinuteTimeframes],
        recentSymbols: workspace.recentSymbols.map((instrument) => ({ ...instrument })),
        gexSelections: workspace.gexSelections,
        activeWorkspace: workspace.activeWorkspace,
        optionChain: workspace.optionChain,
      },
      alerts: {
        byTabId: Object.fromEntries(workspace.tabs.map((tab) => [tab.id, tab.ema200Alert])),
        truthSocial: { ...workspace.settings.truthSocialAlerts },
      },
      drawings: { bySymbol: workspace.drawings },
      watchlist: {
        instruments: workspace.watchlist.map((instrument) => ({ ...instrument })),
        symbols: workspace.watchlist.map((instrument) => instrument.symbol),
      },
      chart_display: {
        crosshairSyncEnabled: workspace.settings.crosshairSyncEnabled,
        ...workspace.settings.chartLabels,
        sessionShading: { ...workspace.settings.chartSessions },
        economicEvents: {
          ...workspace.settings.chartEconomicEvents,
          impactVisibility: { ...workspace.settings.chartEconomicEvents.impactVisibility },
        },
      },
      order_entry: {
        orderTicket: { ...workspace.settings.orderTicket },
        trailStop: { ...workspace.settings.trailStop },
        contractRollAlerts: { ...workspace.settings.contractRollAlerts },
        entryRules: workspace.entryRules,
        entryRuleAlerts: workspace.entryRuleAlerts,
        entryRuleLock: workspace.entryRuleLock,
      },
      journal_fees: {
        commissionPerContractSide: workspace.settings.journal.commissionPerContractSide,
        schwabOptionFeePerContractSide: workspace.settings.journal.schwabOptionFeePerContractSide,
      },
    },
  };
}

function localWindowGeometry(remote: JsonObject, current?: ChartWindowState): JsonObject {
  if (!current) return remote;
  return {
    ...remote,
    maximized: current.maximized,
    x: current.x,
    y: current.y,
    width: current.width,
    height: current.height,
    physicalX: current.physicalX,
    physicalY: current.physicalY,
    physicalWidth: current.physicalWidth,
    physicalHeight: current.physicalHeight,
    splitRatios: current.splitRatios,
  };
}

export function profileFromRecords(records: CloudPreferenceRecord[]): CloudPreferenceProfile {
  const categories = Object.fromEntries(CLOUD_PREFERENCE_CATEGORIES.map((category) => [category, {}])) as CloudPreferenceProfile["categories"];
  for (const record of records) {
    if (record.schemaVersion === 1 && CLOUD_PREFERENCE_CATEGORIES.includes(record.category) && object(record.payload)) {
      categories[record.category] = record.payload;
    }
  }
  return { schemaVersion: 1, categories };
}

export function applyCloudPreferenceProfile(current: WorkspaceState, profile: CloudPreferenceProfile, sessionCustomMinuteTimeframes: number[] = []): WorkspaceState {
  const categories = profile.categories;
  const chartWorkspace = object(categories.chart_workspace);
  const currentTabs = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const currentWindows = new Map(current.windows.map((window) => [window.id, window]));
  const remoteTabs = Array.isArray(chartWorkspace?.tabs)
    ? chartWorkspace.tabs.flatMap((value) => {
      const tab = object(value);
      if (!tab) return [];
      const id = typeof tab.id === "string" ? tab.id : "";
      return [{ ...tab, ema200Alert: currentTabs.get(id)?.ema200Alert }];
    })
    : current.tabs;
  const remoteWindows = Array.isArray(chartWorkspace?.windows)
    ? chartWorkspace.windows.flatMap((value) => {
      const window = object(value);
      if (!window) return [];
      const id = typeof window.id === "string" ? window.id : "";
      return [localWindowGeometry(window, currentWindows.get(id))];
    })
    : current.windows;
  const remoteGexSelections = object(chartWorkspace?.gexSelections) ?? current.gexSelections;

  const alerts = object(categories.alerts);
  const alertsByTab = object(alerts?.byTabId) ?? {};
  const tabs = remoteTabs.map((value) => {
    const tab = object(value) ?? {};
    const id = typeof tab.id === "string" ? tab.id : "";
    const savedAlert = alertsByTab[id] ?? tab.ema200Alert;
    return { ...tab, ema200Alert: normalizeEma200Alert(savedAlert) };
  });

  const drawings = object(categories.drawings);
  const watchlist = object(categories.watchlist);
  const chartDisplay = object(categories.chart_display);
  const sessionShading = object(chartDisplay?.sessionShading);
  const economicEvents = object(chartDisplay?.economicEvents);
  const orderEntry = object(categories.order_entry);
  const journalFees = object(categories.journal_fees);
  const candidate: WorkspaceState = {
    ...current,
    customMinuteTimeframes: Array.isArray(chartWorkspace?.customMinuteTimeframes)
      ? chartWorkspace.customMinuteTimeframes as number[]
      : current.customMinuteTimeframes,
    tabs: tabs as unknown as ChartTabState[],
    windows: remoteWindows as unknown as ChartWindowState[],
    gexSelections: remoteGexSelections as WorkspaceState["gexSelections"],
    activeWorkspace: chartWorkspace?.activeWorkspace === "options" ? "options" : current.activeWorkspace,
    optionChain: object(chartWorkspace?.optionChain) as unknown as WorkspaceState["optionChain"] ?? current.optionChain,
    recentSymbols: Array.isArray(chartWorkspace?.recentSymbols)
      ? chartWorkspace.recentSymbols as unknown as WorkspaceState["recentSymbols"]
      : current.recentSymbols,
    drawings: object(drawings?.bySymbol) as unknown as WorkspaceState["drawings"] ?? current.drawings,
    watchlist: Array.isArray(watchlist?.instruments)
      ? watchlist.instruments as unknown as WorkspaceState["watchlist"]
      : Array.isArray(watchlist?.symbols)
        ? watchlist.symbols.filter((item): item is string => typeof item === "string") as unknown as WorkspaceState["watchlist"]
        : current.watchlist,
    entryRules: object(orderEntry?.entryRules) as unknown as WorkspaceState["entryRules"] ?? current.entryRules,
    // Rule alert settings travel atomically with their rule definitions. The
    // alerts.entryRules fallback preserves profiles written by older clients.
    entryRuleAlerts: normalizeEntryRuleAlerts(orderEntry?.entryRuleAlerts ?? alerts?.entryRules ?? current.entryRuleAlerts),
    entryRuleLock: object(orderEntry?.entryRuleLock) as unknown as WorkspaceState["entryRuleLock"] ?? current.entryRuleLock,
    settings: {
      crosshairSyncEnabled: typeof chartDisplay?.crosshairSyncEnabled === "boolean"
        ? chartDisplay.crosshairSyncEnabled
        : current.settings.crosshairSyncEnabled,
      chartLabels: { ...current.settings.chartLabels, ...chartDisplay },
      chartSessions: { ...current.settings.chartSessions, ...sessionShading },
      chartEconomicEvents: {
        ...current.settings.chartEconomicEvents,
        ...economicEvents,
        impactVisibility: {
          ...current.settings.chartEconomicEvents.impactVisibility,
          ...object(economicEvents?.impactVisibility),
        },
      },
      orderTicket: { ...current.settings.orderTicket, ...object(orderEntry?.orderTicket) },
      trailStop: { ...current.settings.trailStop, ...object(orderEntry?.trailStop) },
      contractRollAlerts: normalizeContractRollAlertSettings(orderEntry?.contractRollAlerts ?? current.settings.contractRollAlerts),
      truthSocialAlerts: {
        enabled: typeof object(alerts?.truthSocial)?.enabled === "boolean"
          ? object(alerts?.truthSocial)!.enabled as boolean
          : current.settings.truthSocialAlerts.enabled,
      },
      journal: {
        commissionPerContractSide: typeof journalFees?.commissionPerContractSide === "number"
          ? journalFees.commissionPerContractSide
          : current.settings.journal.commissionPerContractSide,
        schwabOptionFeePerContractSide: typeof journalFees?.schwabOptionFeePerContractSide === "number"
          ? journalFees.schwabOptionFeePerContractSide
          : current.settings.journal.schwabOptionFeePerContractSide,
      },
    },
  };
  const normalized = normalizeChartWorkspace(candidate, current, sessionCustomMinuteTimeframes);
  const savedCustomMinutes = new Set(normalized.customMinuteTimeframes);
  const sessionCustomMinutes = new Set(sessionCustomMinuteTimeframes);
  const tabsWithTransientTimeframes = normalized.tabs.map((tab) => {
    const local = currentTabs.get(tab.id);
    const minutes = local && parseMinuteTimeframe(local.timeframe);
    return minutes != null && sessionCustomMinutes.has(minutes) && !savedCustomMinutes.has(minutes)
      ? { ...tab, timeframe: local!.timeframe }
      : tab;
  });
  return {
    ...normalized,
    tabs: tabsWithTransientTimeframes,
    environment: current.environment,
    rightPanelOpen: current.rightPanelOpen,
    rightPanelMode: current.rightPanelMode,
    autoBreakEvenRules: current.autoBreakEvenRules,
    autoTrailStopRules: current.autoTrailStopRules,
    bottomTab: current.bottomTab,
    bottomBrokerPanel: current.bottomBrokerPanel,
    bottomPanelOpen: current.bottomPanelOpen,
    bottomPanelHeight: current.bottomPanelHeight,
    selectedAccountId: current.selectedAccountId,
    selectedSchwabAccountId: current.selectedSchwabAccountId,
    confirmOrders: current.confirmOrders,
    revision: Math.max(current.revision + 1, Date.now()),
  };
}
