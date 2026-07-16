import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "../types";
import { defaultEma200Alert } from "./emaAlerts";
import { defaultEntryRules } from "./entryRules";
import { defaultEntryRuleAlerts } from "./entryRuleAlerts";
import { applyCloudPreferenceProfile, cloudPreferenceProfile, preferencePollInterval, preferenceRetryDelay } from "./cloudPreferences";
import { defaultIndicators } from "./workspace";

function workspace(): WorkspaceState {
  return {
    revision: 4,
    environment: "live",
    tabs: [{
      id: "chart-1",
      symbol: { symbol: "@MES", description: "Micro E-mini S&P", exchange: "CME", assetType: "Future", minMove: 0.25, pointValue: 5 },
      timeframe: "5m",
      chartKind: "candles",
      renkoSettings: { brickSizeTicks: 4, priceSource: "close", reversalBricks: 1 },
      pointAndFigureSettings: { boxSizeTicks: 4, priceSource: "close", reversalBoxes: 3 },
      indicators: defaultIndicators,
      ema200Alert: defaultEma200Alert(),
      chartTimezone: "exchange",
      magnetEnabled: true,
      tradeContract: "MESU26",
    }],
    windows: [{ id: "main", tabIds: ["chart-1"], activeTabId: "chart-1", visibleTabIds: ["chart-1"], chartLayout: "single", splitRatios: { "two-columns": [0.42] }, detached: false, x: 120, y: 90, width: 1400, height: 900, maximized: true }],
    watchlist: ["MESU26"],
    drawings: { "@MES": [{ id: "line-1", kind: "horizontal", points: [{ time: 1, price: 6200 }], color: "#fff" }] },
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
    expect(serialized).toContain("commissionPerContractSide");
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
      watchlist: ["MNQU26"],
      entryRules: {
        ...local.entryRules,
        long: { ...local.entryRules.long, children: [{ id: "price", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "EMA", period: 20 } }] },
      },
      entryRuleAlerts: { ...local.entryRuleAlerts, long: { enabled: true, sound: "bell", durationSeconds: 5 } },
      windows: [{ id: "main", tabIds: ["chart-1"], activeTabId: "chart-1", visibleTabIds: ["chart-1"], chartLayout: "single", splitRatios: { "two-columns": [0.7] }, detached: false, x: 999, y: 999 }],
      settings: { ...local.settings, journal: { commissionPerContractSide: 1.25 } },
    });
    const merged = applyCloudPreferenceProfile(local, profile);
    expect(merged.watchlist).toEqual(["MNQU26"]);
    expect(merged.settings.journal.commissionPerContractSide).toBe(1.25);
    expect(merged.entryRuleAlerts.long).toEqual({ enabled: true, sound: "bell", durationSeconds: 5 });
    expect(merged.environment).toBe("live");
    expect(merged.selectedAccountId).toBe("secret-account-id");
    expect(merged.confirmOrders).toBe(false);
    expect(merged.windows[0]).toMatchObject({ x: 120, y: 90, width: 1400, height: 900, maximized: true });
    expect(merged.windows[0].splitRatios?.["two-columns"]).toEqual([0.42]);
  });

  it("normalizes malformed downloaded values", () => {
    const local = workspace();
    const profile = cloudPreferenceProfile(local);
    profile.categories.chart_display.fontSize = 900;
    profile.categories.journal_fees.commissionPerContractSide = -20;
    profile.categories.watchlist.symbols = ["mesu26", 123, "mesu26"];
    profile.categories.order_entry.entryRules = {
      ...local.entryRules,
      long: { ...local.entryRules.long, children: [{ id: "price", kind: "condition", left: { kind: "marketPrice" }, operator: "above", right: { kind: "movingAverage", average: "EMA", period: 20 } }] },
    };
    profile.categories.order_entry.entryRuleAlerts = { long: { enabled: true, sound: "invalid", durationSeconds: 99 } };
    const merged = applyCloudPreferenceProfile(local, profile);
    expect(merged.settings.chartLabels.fontSize).toBe(16);
    expect(merged.settings.journal.commissionPerContractSide).toBe(0);
    expect(merged.watchlist).toEqual(["MESU26"]);
    expect(merged.entryRuleAlerts.long).toEqual({ enabled: true, sound: "chime", durationSeconds: 3 });
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
