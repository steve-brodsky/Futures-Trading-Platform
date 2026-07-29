import { invoke } from "@tauri-apps/api/core";
import type { Account, AccountBalance, AuditFilters, AuditHealth, AuditPage, Bar, BarStreamConsumer, BrokerMutationIntent, BrokerMutationResult, CloudPreferenceProfile, HistoricalOrderPage, JournalAuthStatus, JournalDaySummary, JournalMonthSummary, JournalScope, JournalScreenshotImage, JournalScreenshotMetadata, JournalStatsRange, JournalSyncStatus, JournalTrade, KillSwitchResult, MarketDataProvider, OptionChainSnapshot, OptionExpiration, OrderDraft, OrderPreview, OrderUpdate, Position, PreferenceSyncResult, Quote, RiskPolicy, RiskPolicyStatus, SymbolMeta, Timeframe, TradingEnvironment, TradingTodaySnapshot, WorkspaceState } from "../types";
import { demoAuditExport, demoAuditPage, instrumentDemoApi } from "./audit";
import { cloudPreferenceProfile } from "./cloudPreferences";
import { daySummary, demoJournalTrades, journalStatsRange, monthSummary } from "./journal";
import { demoAccounts, demoBalance, demoBodBalance, demoOptionChain, demoOptionExpirations, demoOrders, demoPositions, demoSymbols, futures, makeDemoBars, quoteFor } from "./demo";
import { CME_HOURS_URL, demoTradingTodaySnapshot, NYSE_HOURS_URL, TRADING_ECONOMICS_CALENDAR_URL } from "./tradingToday";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const nativeAuditExcluded = new Set(["get_audit_events", "get_audit_health", "export_audit_events", "record_client_audit"]);
const nativeRecordCommands = new Set([
  "save_credentials", "save_schwab_credentials", "set_environment", "save_workspace",
  "configure_journal", "disconnect_journal", "set_journal_backfill_start", "reset_journal_now",
  "set_journal_commission", "save_journal_entry_screenshot", "update_journal_annotation",
  "ingest_journal_orders", "place_order", "replace_order", "close_position", "cancel_order",
  "save_risk_policy", "set_live_trading_armed", "reconcile_broker_mutation", "kill_switch",
]);

async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const started = performance.now();
  try {
    const result = await invoke<T>(command, args);
    if (!nativeAuditExcluded.has(command)) {
      void invoke("record_client_audit", { event: {
        operation: command,
        category: nativeRecordCommands.has(command) ? "record" : command.includes("stream") ? "stream" : "api",
        status: "success",
        durationMs: Math.round(performance.now() - started),
        request: args,
        response: result,
      } }).catch(() => undefined);
    }
    return result;
  } catch (reason) {
    if (!nativeAuditExcluded.has(command)) {
      void invoke("record_client_audit", { event: {
        operation: command,
        category: nativeRecordCommands.has(command) ? "record" : command.includes("stream") ? "stream" : "api",
        status: "error",
        durationMs: Math.round(performance.now() - started),
        request: args,
        error: String(reason),
      } }).catch(() => undefined);
    }
    throw reason;
  }
}

const rawApi = {
  isNative: isTauri,
  async authStatus(): Promise<{ configured: boolean; authenticated: boolean }> {
    return isTauri ? native("auth_status") : { configured: false, authenticated: false };
  },
  async saveCredentials(clientId: string, clientSecret: string): Promise<void> {
    if (!isTauri) return;
    await native("save_credentials", { clientId, clientSecret });
  },
  async beginLogin(): Promise<void> {
    if (!isTauri) return;
    await native("begin_login");
  },
  async logout(): Promise<void> {
    if (!isTauri) return;
    await native("logout");
  },
  async schwabAuthStatus(): Promise<{ configured: boolean; authenticated: boolean }> {
    return isTauri ? native("schwab_auth_status") : { configured: true, authenticated: true };
  },
  async saveSchwabCredentials(clientId: string, clientSecret: string): Promise<void> {
    if (isTauri) await native("save_schwab_credentials", { clientId, clientSecret });
  },
  async beginSchwabLogin(): Promise<void> {
    if (isTauri) await native("begin_schwab_login");
  },
  async logoutSchwab(): Promise<void> {
    if (isTauri) await native("logout_schwab");
  },
  async setEnvironment(environment: TradingEnvironment): Promise<void> {
    if (isTauri) await native("set_environment", { environment });
  },
  async accounts(): Promise<Account[]> {
    return isTauri ? native("get_accounts") : demoAccounts;
  },
  async symbolSearch(query: string): Promise<SymbolMeta[]> {
    if (isTauri) return native("search_symbols", { query });
    const q = query.toLowerCase();
    return demoSymbols.filter((item) => `${item.symbol} ${item.description}`.toLowerCase().includes(q));
  },
  async symbolDetails(provider: MarketDataProvider, symbol: string): Promise<SymbolMeta> {
    if (isTauri) return native("get_symbol_details", { provider, symbol });
    const match = demoSymbols.find((item) => item.provider === provider && item.symbol === symbol);
    if (!match) throw new Error(`Symbol details unavailable for ${symbol}`);
    return match;
  },
  async futureContracts(root: string): Promise<SymbolMeta[]> {
    if (isTauri) return native("get_future_contracts", { root });
    return futures
      .filter((item) => item.root === root.toUpperCase() && !item.symbol.startsWith("@") && item.expiration)
      .sort((left, right) => (left.expiration ?? "").localeCompare(right.expiration ?? ""));
  },
  async bars(provider: MarketDataProvider, symbol: string, timeframe: Timeframe): Promise<Bar[]> {
    if (isTauri) return native("get_bars", { provider, symbol, timeframe });
    const base = provider === "schwab" ? (symbol === "SPY" ? 632 : 215) : symbol.startsWith("MNQ") ? 23010 : symbol.startsWith("MCL") ? 67 : symbol.startsWith("MGC") ? 3450 : symbol.startsWith("MYM") ? 44920 : 6218;
    return makeDemoBars(360, base, provider === "schwab" ? 0.12 : symbol.startsWith("MCL") ? 0.04 : symbol.startsWith("MGC") ? 0.7 : 1);
  },
  async cachedBars(provider: MarketDataProvider, symbol: string, timeframe: Timeframe): Promise<Bar[]> {
    return isTauri ? native("load_cached_bars", { provider, symbol, timeframe }) : this.bars(provider, symbol, timeframe);
  },
  async olderBars(provider: MarketDataProvider, symbol: string, timeframe: Timeframe, before: number): Promise<Bar[]> {
    if (isTauri) return native("get_older_bars", { provider, symbol, timeframe, before });
    return [];
  },
  async cachedBarRange(provider: MarketDataProvider, symbol: string, timeframe: Timeframe, first: number, last: number): Promise<Bar[]> {
    if (isTauri) return native("load_cached_bar_range", { provider, symbol, timeframe, first, last });
    return (await this.bars(provider, symbol, timeframe)).filter((bar) => bar.time >= first && bar.time < last);
  },
  async barRange(provider: MarketDataProvider, symbol: string, timeframe: Timeframe, first: number, last: number): Promise<Bar[]> {
    if (isTauri) return native("get_bar_range", { provider, symbol, timeframe, first, last });
    return (await this.bars(provider, symbol, timeframe)).filter((bar) => bar.time >= first && bar.time < last);
  },
  async startBarStream(subscriptionId: string, provider: MarketDataProvider, symbol: string, timeframe: Timeframe, consumer: BarStreamConsumer, generation: number): Promise<void> {
    if (isTauri) await native("start_bar_stream", { subscriptionId, provider, symbol, timeframe, consumer, generation });
  },
  async refreshBarStream(provider: MarketDataProvider, symbol: string, timeframe: Timeframe): Promise<Bar[]> {
    return isTauri ? native("refresh_bar_stream", { provider, symbol, timeframe }) : this.bars(provider, symbol, timeframe);
  },
  async stopBarStream(subscriptionId: string, generation: number): Promise<void> {
    if (isTauri) await native("stop_bar_stream", { subscriptionId, generation });
  },
  async startQuoteStream(subscriptionId: string, provider: MarketDataProvider, symbols: string[]): Promise<void> {
    if (isTauri) await native("start_quote_stream", { subscriptionId, provider, symbols });
  },
  async stopQuoteStream(subscriptionId: string): Promise<void> {
    if (isTauri) await native("stop_quote_stream", { subscriptionId });
  },
  async startBrokerageStream(accountId: string): Promise<void> {
    if (isTauri) await native("start_brokerage_stream", { accountId });
  },
  async stopBrokerageStream(): Promise<void> {
    if (isTauri) await native("stop_brokerage_stream");
  },
  async quotes(provider: MarketDataProvider, symbols: string[]): Promise<Quote[]> {
    if (isTauri) return native("get_quotes", { provider, symbols });
    return symbols.map((symbol, index) => quoteFor(symbol, index * 0.25, provider));
  },
  async positions(accountId: string): Promise<Position[]> {
    return isTauri ? native("get_positions", { accountId }) : demoPositions;
  },
  async orders(accountId: string): Promise<OrderUpdate[]> {
    return isTauri ? native("get_orders", { accountId }) : demoOrders;
  },
  async balances(accountId: string): Promise<AccountBalance[]> {
    return isTauri ? native("get_balances", { accountId }) : [demoBalance];
  },
  async bodBalances(accountId: string): Promise<AccountBalance[]> {
    return isTauri ? native("get_bod_balances", { accountId }) : [demoBodBalance];
  },
  async historicalOrders(accountId: string, since: string, nextToken?: string): Promise<HistoricalOrderPage> {
    return isTauri ? native("get_historical_orders", { accountId, since, nextToken }) : { orders: demoOrders.filter((order) => order.status !== "Working") };
  },
  async confirmOrder(order: OrderDraft): Promise<OrderPreview> {
    if (isTauri) return native("confirm_order", { order });
    return { valid: true, summary: `${order.side} ${order.quantity} ${order.symbol} ${order.type}`, estimatedCommission: "$1.24", initialMargin: "$2,460.00", errors: [] };
  },
  async placeOrder(order: OrderDraft, clientMutationId = crypto.randomUUID()): Promise<BrokerMutationResult> {
    if (isTauri) return native("place_order", { order, clientMutationId });
    throw new Error("Order placement is disabled in browser demo mode.");
  },
  async replaceOrder(accountId: string, orderId: string, newPrice: number, clientMutationId = crypto.randomUUID()): Promise<BrokerMutationResult> {
    if (isTauri) return native("replace_order", { accountId, orderId, newPrice, clientMutationId });
    throw new Error("Order replacement is disabled in browser demo mode.");
  },
  async closePosition(accountId: string, positionId: string, clientMutationId = crypto.randomUUID()): Promise<BrokerMutationResult> {
    if (isTauri) return native("close_position", { accountId, positionId, clientMutationId });
    throw new Error("Position closing is disabled in browser demo mode.");
  },
  async cancelOrder(accountId: string, orderId: string, clientMutationId = crypto.randomUUID()): Promise<BrokerMutationResult> {
    if (isTauri) return native("cancel_order", { accountId, orderId, clientMutationId });
    throw new Error("Order cancellation is disabled in browser demo mode.");
  },
  async riskPolicy(accountId: string): Promise<RiskPolicyStatus> {
    if (isTauri) return native("get_risk_policy", { accountId });
    return {
      environment: "sim", accountId, liveArmed: false, sessionId: "browser-demo",
      policy: {
        maxQuantityPerOrder: { enabled: false, value: 1 },
        maxTotalOpenContracts: { enabled: false, value: 1 },
        maxRiskPerTrade: { enabled: false, value: 100 },
        maxAggregateOpenRisk: { enabled: false, value: 500 },
        maxRealizedDailyLoss: { enabled: false, value: 500 },
        requiredProtectiveStop: false,
        allowedSession: { enabled: false, timezone: "America/Chicago", start: "08:30", end: "15:00", weekdays: [1, 2, 3, 4, 5] },
        consecutiveLossCooldown: { enabled: false, threshold: 3, cooldownMinutes: 30 },
        orderRate: { enabled: false, maxOrders: 5, windowSeconds: 60, cooldownSeconds: 60 },
      },
    };
  },
  async saveRiskPolicy(accountId: string, policy: RiskPolicy): Promise<RiskPolicyStatus> {
    if (isTauri) return native("save_risk_policy", { accountId, policy });
    return { ...(await this.riskPolicy(accountId)), policy };
  },
  async setLiveTradingArmed(accountId: string, armed: boolean, confirmation: string): Promise<RiskPolicyStatus> {
    if (isTauri) return native("set_live_trading_armed", { accountId, armed, confirmation });
    return { ...(await this.riskPolicy(accountId)), liveArmed: armed };
  },
  async brokerMutations(environment: TradingEnvironment, accountId: string): Promise<BrokerMutationIntent[]> {
    return isTauri ? native("list_broker_mutations", { environment, accountId }) : [];
  },
  async reconcileBrokerMutation(mutationId: string, brokerOrderId?: string, confirmation = ""): Promise<BrokerMutationResult> {
    if (isTauri) return native("reconcile_broker_mutation", { mutationId, brokerOrderId, confirmation });
    throw new Error("Broker reconciliation is available in the desktop app.");
  },
  async killSwitch(accountId: string, confirmation: string): Promise<KillSwitchResult> {
    if (isTauri) return native("kill_switch", { accountId, confirmation });
    throw new Error("The kill switch is available in the desktop app.");
  },
  async loadWorkspace(): Promise<WorkspaceState | null> {
    if (isTauri) return native("load_workspace");
    const raw = localStorage.getItem("northstar-workspace");
    return raw ? JSON.parse(raw) : null;
  },
  async saveWorkspace(workspace: WorkspaceState): Promise<void> {
    if (isTauri) await native("save_workspace", { workspace, cloudProfile: cloudPreferenceProfile(workspace) });
    else localStorage.setItem("northstar-workspace", JSON.stringify(workspace));
  },
  async getTradingTodayCache(date: string): Promise<TradingTodaySnapshot | null> {
    if (isTauri) return native("get_trading_today_cache", { date });
    const raw = localStorage.getItem("northstar-trading-today");
    if (!raw) return null;
    try {
      const snapshot = JSON.parse(raw) as TradingTodaySnapshot;
      return snapshot.date === date ? snapshot : null;
    } catch {
      return null;
    }
  },
  async refreshTradingToday(date: string): Promise<TradingTodaySnapshot> {
    if (isTauri) return native("refresh_trading_today", { date });
    const snapshot = demoTradingTodaySnapshot(date);
    localStorage.setItem("northstar-trading-today", JSON.stringify(snapshot));
    return snapshot;
  },
  async openTradingTodaySource(source: "calendar" | "nyse" | "cme"): Promise<void> {
    if (isTauri) {
      await native("open_trading_today_source", { source });
      return;
    }
    const url = source === "nyse" ? NYSE_HOURS_URL : source === "cme" ? CME_HOURS_URL : TRADING_ECONOMICS_CALENDAR_URL;
    window.open(url, "_blank", "noopener,noreferrer");
  },
  async syncPreferences(cloudProfile: CloudPreferenceProfile): Promise<PreferenceSyncResult> {
    if (!isTauri) return { state: "synced", records: [], replacedCategories: [], conflictedCategories: [], lastSyncedAt: new Date().toISOString(), message: "Browser preferences are local only" };
    return native("sync_app_preferences", { cloudProfile });
  },
  async optionExpirations(symbol: string): Promise<OptionExpiration[]> {
    return isTauri ? native("get_option_expirations", { symbol }) : demoOptionExpirations(symbol);
  },
  async optionChain(symbol: string, expirationDates: string[]): Promise<OptionChainSnapshot> {
    return isTauri ? native("get_option_chain", { symbol, expirationDates }) : demoOptionChain(symbol, expirationDates);
  },
  async startOptionStream(subscriptionId: string, symbol: string, contractSymbols: string[]): Promise<void> {
    if (isTauri) await native("start_option_stream", { subscriptionId, symbol, contractSymbols });
  },
  async stopOptionStream(subscriptionId: string): Promise<void> {
    if (isTauri) await native("stop_option_stream", { subscriptionId });
  },
  async startPreferenceRealtime(): Promise<void> {
    if (isTauri) await native("start_preference_realtime");
  },
  async stopPreferenceRealtime(): Promise<void> {
    if (isTauri) await native("stop_preference_realtime");
  },
  async journalAuthStatus(): Promise<JournalAuthStatus> {
    return isTauri ? native("journal_auth_status") : { configured: false, authenticated: false };
  },
  async configureJournal(projectUrl: string, publishableKey: string, email: string, password: string, backfillStart: string): Promise<JournalAuthStatus> {
    if (!isTauri) return { configured: false, authenticated: false, error: "Journal cloud setup is available in the desktop app." };
    return native("configure_journal", { input: { projectUrl, publishableKey, email, password, backfillStart } });
  },
  async disconnectJournal(): Promise<void> {
    if (isTauri) await native("disconnect_journal");
  },
  async setJournalBackfillStart(backfillStart: string): Promise<void> {
    if (isTauri) await native("set_journal_backfill_start", { backfillStart });
  },
  async resetJournalNow(): Promise<JournalAuthStatus> {
    if (!isTauri) return { configured: false, authenticated: false, error: "Journal reset is available in the desktop app." };
    return native("reset_journal_now");
  },
  async setJournalCommission(commissionPerContractSide: number): Promise<void> {
    if (isTauri) await native("set_journal_commission", { commissionPerContractSide });
  },
  async syncJournal(scope?: JournalScope): Promise<JournalSyncStatus> {
    return isTauri ? native("sync_journal", { scope }) : { state: "synced", pendingEvents: 0, lastSyncedAt: new Date().toISOString(), message: "Browser demo data" };
  },
  async journalScopes(): Promise<JournalScope[]> {
    return isTauri ? native("get_journal_scopes") : [{ environment: "sim", accountId: "SIM-DEMO-4821", accountLabel: "SIM ··4821" }];
  },
  async journalMonth(scope: JournalScope, year: number, month: number): Promise<JournalMonthSummary> {
    return isTauri ? native("get_journal_month", { scope, year, month }) : monthSummary(scope, year, month, demoJournalTrades());
  },
  async journalDay(scope: JournalScope, date: string): Promise<JournalDaySummary> {
    return isTauri ? native("get_journal_day", { scope, date }) : daySummary(scope, date, demoJournalTrades());
  },
  async journalStatsTrades(scope: JournalScope, startDate?: string, endDate?: string): Promise<JournalStatsRange> {
    return isTauri
      ? native("get_journal_stats_trades", { scope, startDate, endDate })
      : journalStatsRange(scope, demoJournalTrades(), startDate, endDate);
  },
  async journalTrade(tradeId: string): Promise<JournalTrade> {
    if (isTauri) return native("get_journal_trade", { tradeId });
    const trade = demoJournalTrades().find((item) => item.id === tradeId);
    if (!trade) throw new Error("Trade not found");
    return trade;
  },
  async saveJournalEntryScreenshot(input: { brokerOrderId: string; environment: TradingEnvironment; accountId: string; symbol: string; capturedAt: string; width: number; height: number; dataUrl: string }): Promise<JournalScreenshotMetadata> {
    if (!isTauri) throw new Error("Entry chart screenshots are available in the desktop app.");
    return native("save_journal_entry_screenshot", { input });
  },
  async journalEntryScreenshot(tradeId: string): Promise<JournalScreenshotImage> {
    if (!isTauri) throw new Error("Entry chart screenshots are available in the desktop app.");
    return native("get_journal_entry_screenshot", { tradeId });
  },
  async updateJournalAnnotation(tradeId: string, notes: string, tags: string[]): Promise<void> {
    if (isTauri) await native("update_journal_annotation", { tradeId, notes, tags });
  },
  async ingestJournalOrders(environment: TradingEnvironment, orders: OrderUpdate[], source: "broker-stream" | "broker-history" = "broker-stream"): Promise<void> {
    if (isTauri && orders.length) await native("ingest_journal_orders", { environment, orders, source });
  },
  async auditEvents(filters: AuditFilters, cursor?: string, limit = 100): Promise<AuditPage> {
    return isTauri
      ? native("get_audit_events", { filters, cursor, limit })
      : demoAuditPage(filters, cursor, limit);
  },
  async auditHealth(): Promise<AuditHealth> {
    return isTauri
      ? native("get_audit_health")
      : { healthy: true, droppedEvents: 0, sessionOnly: true };
  },
  async exportAuditEvents(filters: AuditFilters): Promise<string> {
    return isTauri
      ? native("export_audit_events", { filters })
      : demoAuditExport(filters);
  },
};

const auditMethods = new Set(["auditEvents", "auditHealth", "exportAuditEvents"]);
export const api = isTauri ? rawApi : instrumentDemoApi(rawApi, auditMethods);
