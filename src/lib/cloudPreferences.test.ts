import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "../types";
import { defaultEma200Alert } from "./emaAlerts";
import { defaultEntryRules } from "./entryRules";
import { defaultEntryRuleAlerts } from "./entryRuleAlerts";
import { applyCloudPreferenceProfile, cloudPreferenceProfile, preferencePollInterval, preferenceRetryDelay } from "./cloudPreferences";
import { defaultIndicators } from "./workspace";
import { DEFAULT_CHART_SESSION_SETTINGS } from "./chartSessions";
import { DEFAULT_CHART_ECONOMIC_EVENT_SETTINGS } from "./economicEvents";

function workspace(): WorkspaceState {
  return {
    revision: 4,
    environment: "live",
    tabs: [{
      id: "chart-1",
      symbol: { provider: "tradestation", symbol: "@MES", description: "Micro E-mini S&P", exchange: "CME", assetType: "Future", minMove: 0.25, pointValue: 5 },
      timeframe: "5m",
      chartKind: "candles",
      renkoSettings: { brickSizeTicks: 4, priceSource: "close", reversalBricks: 1 },
      pointAndFigureSettings: { boxSizeTicks: 4, priceSource: "close", reversalBoxes: 3 },
      indicators: defaultIndicators,
      ema200Alert: defaultEma200Alert(),
      chartTimezone: "exchange",
      magnetEnabled: true,
      gex: { enabled: false, view: "net", expirationDisplay: "aggregate" },
      tradeContract: "MESU26",
    }],
    windows: [{ id: "main", tabIds: ["chart-1"], activeTabId: "chart-1", visibleTabIds: ["chart-1"], chartLayout: "single", splitRatios: { "two-columns": [0.42] }, detached: false, x: 120, y: 90, width: 1400, height: 900, maximized: true }],
    watchlist: [{ provider: "tradestation", symbol: "MESU26", description: "MESU26", exchange: "CME", assetType: "FUTURE", minMove: 0.25, pointValue: 5 }],
    recentSymbols: [{ provider: "schwab", symbol: "SPY", description: "SPDR S&P 500 ETF", exchange: "NYSE ARCA", assetType: "ETF", minMove: 0.01, pointValue: 1 }],
    drawings: { "@MES": [{ id: "line-1", kind: "horizontal", points: [{ time: 1, price: 6200 }], color: "#fff" }] },
    gexSelections: {},
    rightPanelOpen: true,
    bottomTab: "orders",
    bottomPanelOpen: true,
    bottomPanelHeight: 420,
    selectedAccountId: "secret-account-id",
    confirmOrders: false,
    entryRules: defaultEntryRules(),
    entryRuleAlerts: defaultEntryRuleAlerts(),
    settings: {
      chartLabels: { showEma200TabDots: true, showDollarAmount: true, showRMultiple: true, fontSize: 12 },
      chartSessions: DEFAULT_CHART_SESSION_SETTINGS,
      chartEconomicEvents: DEFAULT_CHART_ECONOMIC_EVENT_SETTINGS,
      orderTicket: { swingStopPivotBars: 3, swingStopOffsetTicks: 2, sizingMode: "risk", riskSizingPolicy: "strict", riskAmount: 150 },
      journal: { commissionPerContractSide: 0.75 },
    },
  };
}

describe("cloud preferences", () => {
  it("serializes only explicitly synchronized fields", () => {
    const original = workspace();
    const profile = cloudPreferenceProfile(original);
    const serialized = JSON.stringify(profile);
    expect(serialized).toContain("MESU26");
    expect(profile.categories.chart_workspace.recentSymbols).toEqual(original.recentSymbols);
    expect(serialized).toContain("commissionPerContractSide");
    expect(profile.categories.chart_display.sessionShading).toEqual(original.settings.chartSessions);
    expect(profile.categories.chart_display.economicEvents).toEqual(original.settings.chartEconomicEvents);
    expect(profile.categories.order_entry.entryRuleAlerts).toEqual(original.entryRuleAlerts);
    expect(profile.categories.alerts.entryRules).toBeUndefined();
    expect(serialized).not.toContain("secret-account-id");
    expect(serialized).not.toContain("confirmOrders");
    expect(serialized).not.toContain('"environment"');
    expect(serialized).not.toContain('"x":120');
    expect(serialized).not.toContain("splitRatios");
    expect(serialized).toContain("chartLayout");
    expect(serialized).not.toMatch(/password|refreshToken|clientSecret|publishableKey|projectUrl/i);

    const deviceLocalChange = {
      ...original,
      environment: "sim" as const,
      selectedAccountId: "another-local-account",
      confirmOrders: true,
      windows: original.windows.map((window) => ({ ...window, x: 999, y: 777, width: 800, height: 600, splitRatios: { "two-columns": [0.7] } })),
    };
    expect(cloudPreferenceProfile(deviceLocalChange)).toEqual(profile);
  });

  it("applies cloud preferences without replacing device-local safety and geometry", () => {
    const local = workspace();
    const profile = cloudPreferenceProfile({
      ...local,
      environment: "sim",
      selectedAccountId: "other-account",
      confirmOrders: true,
      watchlist: [{ provider: "tradestation", symbol: "MNQU26", description: "MNQU26", exchange: "CME", assetType: "FUTURE", minMove: 0.25, pointValue: 2 }],
      recentSymbols: [{ provider: "schwab", symbol: "AAPL", description: "Apple Inc", exchange: "NASDAQ", assetType: "EQUITY", minMove: 0.01, pointValue: 1 }],
      entryRules: {
        ...local.entryRules,
        long: { ...local.entryRules.long, children: [{ id: "price", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "EMA", period: 20 } }] },
      },
      entryRuleAlerts: { ...local.entryRuleAlerts, long: { enabled: true, sound: "bell", durationSeconds: 5 } },
      windows: [{ id: "main", tabIds: ["chart-1"], activeTabId: "chart-1", visibleTabIds: ["chart-1"], chartLayout: "single", splitRatios: { "two-columns": [0.7] }, detached: false, x: 999, y: 999 }],
      settings: {
        ...local.settings,
        chartSessions: { ...local.settings.chartSessions, colorMode: "by-session", asiaColor: "#112233" },
        chartEconomicEvents: { ...local.settings.chartEconomicEvents, enabled: true, impactVisibility: { ...local.settings.chartEconomicEvents.impactVisibility, low: false } },
        journal: { commissionPerContractSide: 1.25 },
      },
    });
    const merged = applyCloudPreferenceProfile(local, profile);
    expect(merged.watchlist.map((item) => item.symbol)).toEqual(["MNQU26"]);
    expect(merged.recentSymbols.map((item) => item.symbol)).toEqual(["AAPL"]);
    expect(merged.settings.journal.commissionPerContractSide).toBe(1.25);
    expect(merged.settings.chartSessions).toMatchObject({ colorMode: "by-session", asiaColor: "#112233" });
    expect(merged.settings.chartEconomicEvents).toEqual({ enabled: true, impactVisibility: { high: true, medium: true, low: false, unrated: true } });
    expect(merged.entryRuleAlerts.long).toEqual({ enabled: true, sound: "bell", durationSeconds: 5 });
    expect(merged.environment).toBe("live");
    expect(merged.selectedAccountId).toBe("secret-account-id");
    expect(merged.confirmOrders).toBe(false);
    expect(merged.windows[0]).toMatchObject({ x: 120, y: 90, width: 1400, height: 900, maximized: true });
    expect(merged.windows[0].splitRatios?.["two-columns"]).toEqual([0.42]);
  });

  it("round-trips Schwab index metadata through cloud preferences", () => {
    const local = workspace();
    const vix = { provider: "schwab" as const, symbol: "$VIX", description: "CBOE Volatility Index", exchange: "CBOE", assetType: "INDEX", minMove: 0.01, pointValue: 1 };
    const profile = cloudPreferenceProfile({ ...local, watchlist: [vix], recentSymbols: [vix] });
    const merged = applyCloudPreferenceProfile({ ...local, watchlist: [], recentSymbols: [] }, profile);
    expect(merged.watchlist).toEqual([vix]);
    expect(merged.recentSymbols).toEqual([vix]);
  });

  it("normalizes malformed downloaded values", () => {
    const local = workspace();
    const profile = cloudPreferenceProfile(local);
    profile.categories.chart_display.fontSize = 900;
    profile.categories.chart_display.sessionShading = { colorMode: "invalid", asiaColor: "red" };
    profile.categories.chart_display.economicEvents = { enabled: "yes", impactVisibility: { high: false, medium: "yes" } };
    profile.categories.journal_fees.commissionPerContractSide = -20;
    profile.categories.watchlist.symbols = ["mesu26", 123, "mesu26"];
    profile.categories.order_entry.entryRules = {
      ...local.entryRules,
      long: { ...local.entryRules.long, children: [{ id: "price", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "EMA", period: 20 } }] },
    };
    profile.categories.order_entry.entryRuleAlerts = { long: { enabled: true, sound: "invalid", durationSeconds: 99 } };
    const merged = applyCloudPreferenceProfile(local, profile);
    expect(merged.settings.chartLabels.fontSize).toBe(16);
    expect(merged.settings.chartSessions).toEqual(DEFAULT_CHART_SESSION_SETTINGS);
    expect(merged.settings.chartEconomicEvents).toEqual({ enabled: false, impactVisibility: { high: false, medium: true, low: true, unrated: true } });
    expect(merged.settings.journal.commissionPerContractSide).toBe(0);
    expect(merged.watchlist.map((item) => [item.provider, item.symbol])).toEqual([["tradestation", "MESU26"]]);
    expect(merged.entryRuleAlerts.long).toEqual({ enabled: true, sound: "chime", durationSeconds: 3 });
  });

  it("round-trips position drawings through cloud preferences", () => {
    const local = workspace();
    const position = {
      id: "position-1", kind: "position" as const, side: "long" as const, startTime: 100, endTime: 200,
      entryPrice: 6200, stopPrice: 6197.5, targetPrice: 6205, quantity: 2, locked: false,
    };
    const profile = cloudPreferenceProfile({ ...local, drawings: { "@MES": [...local.drawings["@MES"], position] } });
    const merged = applyCloudPreferenceProfile({ ...local, drawings: {} }, profile);
    expect(merged.drawings["@MES"]).toContainEqual(position);
  });

  it("round-trips drawing alerts through the drawings preference category", () => {
    const local = workspace();
    const alert = { enabled: true, direction: "above" as const, frequency: "recurring" as const, sound: "pulse" as const, durationSeconds: 10 as const, provider: "tradestation" as const, symbol: "@MES" };
    const drawings = { "@MES": local.drawings["@MES"].map((drawing) => ({ ...drawing, alert })) };
    const profile = cloudPreferenceProfile({ ...local, drawings });
    const merged = applyCloudPreferenceProfile({ ...local, drawings: {} }, profile);
    expect(merged.drawings["@MES"][0]).toMatchObject({ alert });
  });

  it("reads rule alerts from the legacy alerts category", () => {
    const local = workspace();
    const profile = cloudPreferenceProfile(local);
    delete profile.categories.order_entry.entryRuleAlerts;
    profile.categories.order_entry.entryRules = {
      ...local.entryRules,
      long: { ...local.entryRules.long, children: [{ id: "price", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "EMA", period: 20 } }] },
    };
    profile.categories.alerts.entryRules = { long: { enabled: true, sound: "pulse", durationSeconds: 10 } };
    expect(applyCloudPreferenceProfile(local, profile).entryRuleAlerts.long)
      .toEqual({ enabled: true, sound: "pulse", durationSeconds: 10 });
  });

  it("caps automatic retry backoff at one minute", () => {
    expect(preferenceRetryDelay(0)).toBe(1000);
    expect(preferenceRetryDelay(3)).toBe(8000);
    expect(preferenceRetryDelay(20)).toBe(60_000);
  });

  it("polls frequently while Realtime is degraded and sparsely while connected", () => {
    expect(preferencePollInterval("connected")).toBe(5 * 60_000);
    expect(preferencePollInterval("reconnecting")).toBe(30_000);
    expect(preferencePollInterval("disabled")).toBe(30_000);
  });
});
