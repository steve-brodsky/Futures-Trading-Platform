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
  };
}

export function cloudPreferenceProfile(workspace: WorkspaceState): CloudPreferenceProfile {
  return {
    schemaVersion: 1,
    categories: {
      chart_workspace: {
        tabs: workspace.tabs.map(cloudTab),
        windows: workspace.windows.map(cloudWindow),
      },
      alerts: {
        byTabId: Object.fromEntries(workspace.tabs.map((tab) => [tab.id, tab.ema200Alert])),
      },
      drawings: { bySymbol: workspace.drawings },
      watchlist: { symbols: [...workspace.watchlist] },
      chart_display: { ...workspace.settings.chartLabels },
      order_entry: {
        orderTicket: { ...workspace.settings.orderTicket },
        entryRules: workspace.entryRules,
      },
      journal_fees: {
        commissionPerContractSide: workspace.settings.journal.commissionPerContractSide,
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

export function applyCloudPreferenceProfile(current: WorkspaceState, profile: CloudPreferenceProfile): WorkspaceState {
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
  const orderEntry = object(categories.order_entry);
  const journalFees = object(categories.journal_fees);
  const candidate: WorkspaceState = {
    ...current,
    tabs: tabs as unknown as ChartTabState[],
    windows: remoteWindows as unknown as ChartWindowState[],
    drawings: object(drawings?.bySymbol) as unknown as WorkspaceState["drawings"] ?? current.drawings,
    watchlist: Array.isArray(watchlist?.symbols) ? watchlist.symbols.filter((item): item is string => typeof item === "string") : current.watchlist,
    entryRules: object(orderEntry?.entryRules) as unknown as WorkspaceState["entryRules"] ?? current.entryRules,
    settings: {
      chartLabels: { ...current.settings.chartLabels, ...chartDisplay },
      orderTicket: { ...current.settings.orderTicket, ...object(orderEntry?.orderTicket) },
      journal: {
        commissionPerContractSide: typeof journalFees?.commissionPerContractSide === "number"
          ? journalFees.commissionPerContractSide
          : current.settings.journal.commissionPerContractSide,
      },
    },
  };
  const normalized = normalizeChartWorkspace(candidate, current);
  return {
    ...normalized,
    environment: current.environment,
    rightPanelOpen: current.rightPanelOpen,
    bottomTab: current.bottomTab,
    bottomPanelOpen: current.bottomPanelOpen,
    bottomPanelHeight: current.bottomPanelHeight,
    selectedAccountId: current.selectedAccountId,
    confirmOrders: current.confirmOrders,
    revision: Math.max(current.revision + 1, Date.now()),
  };
}
