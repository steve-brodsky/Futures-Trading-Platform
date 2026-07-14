import { useEffect, useMemo, useRef, useState } from "react";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, cursorPosition, getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity, BarChart3, Bell, BookOpen, ChevronDown, Download,
  LineChart, ListChecks, LockKeyhole, Maximize2, Minimize2, Minus,
  Magnet, MousePointer2, PanelBottom, PanelRight, Plus,
  Search, Settings2, SlidersHorizontal, SquareStack, TrendingUp,
  Wifi, X, Zap,
} from "lucide-react";
import { TradingChart } from "./components/TradingChart";
import { EntryRulesBuilder } from "./components/EntryRulesBuilder";
import { api } from "./lib/bridge";
import { playAlertSound, prepareAlertAudio } from "./lib/alertAudio";
import { demoOrders, demoPositions, futures, quoteFor } from "./lib/demo";
import { ALERT_DURATIONS, ALERT_SOUNDS, ALERT_TIMEFRAMES, alertMarketKey, defaultEma200Alert, desiredAlertMarkets, evaluateEma200Cross, uncoveredAlertMarkets, type EmaCrossSide } from "./lib/emaAlerts";
import { estimateOrderRisk, validateTick } from "./lib/indicators";
import { defaultEntryRules, evaluateEntryRules, hasConfiguredEntryRules } from "./lib/entryRules";
import { formatContractExpiration, isContinuousFuture, quoteSubscriptionSymbols, resolveTradeSymbol, sameSymbolMeta } from "./lib/futuresContracts";
import { previousSessionClose, quoteDayChangePercent } from "./lib/quotes";
import { flattenOrderDraft, withOrderPrice, type OrderProjection } from "./lib/tradeLines";
import { defaultIndicators } from "./lib/workspace";
import { clampWindowGeometry, cloneChartTab, closeDetachedWindow, MAIN_WINDOW_ID, MAX_CHART_TABS, moveTab, normalizeChartWorkspace, stabilizeChartWorkspace, tabInsertionIndex } from "./lib/chartWorkspace";
import { chunkVwapRange, expandedVwapRange, isIntradayTimeframe, mergeEpochRanges, mergeVwapBars, missingEpochRanges, nySessionVwapSymbols, type EpochRange } from "./lib/vwapData";
import type { Account, AccountBalance, ActivityNotification, AlertDurationSeconds, AlertSound, Bar, BarSnapshotEvent, BarUpdateEvent, ChartLabelSettings, ChartTabState, ChartWindowState, Drawing, EntryRuleResult, EntryRuleSide, HistoricalOrderPage, IndicatorConfig, OrderDraft, OrderPreview, OrderUpdate, Position, Quote, QuoteUpdateEvent, StreamConnectionState, StreamStateEvent, SymbolMeta, Timeframe, TimeframeAlertConfig, TradingEnvironment, WorkspaceState } from "./types";

const timeframes: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "D", "W", "M"];
const newYorkClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

const defaultWorkspace: WorkspaceState = {
  revision: 0,
  environment: "sim",
  tabs: [{ id: "chart-1", symbol: futures[0], timeframe: "1m", chartKind: "candles", indicators: defaultIndicators, ema200Alert: defaultEma200Alert(), chartTimezone: "exchange", magnetEnabled: false }],
  windows: [{ id: MAIN_WINDOW_ID, tabIds: ["chart-1"], activeTabId: "chart-1", detached: false }],
  drawings: {},
  watchlist: ["MESU26", "MNQU26", "MCLU26", "MGCQ26", "MYMU26"], rightTab: "order", rightPanelOpen: false, bottomTab: "positions", bottomPanelOpen: false, bottomPanelHeight: 360, confirmOrders: true, entryRules: defaultEntryRules(),
  settings: { chartLabels: { showDollarAmount: true, showRMultiple: true, fontSize: 11 } },
};

const currentWindowId = api.isNative ? getCurrentWindow().label : MAIN_WINDOW_ID;

interface TabMarketState {
  bars: Bar[];
  hasOlder: boolean;
  loadingOlder: boolean;
  streamState: StreamConnectionState;
}

interface StripBounds { windowId: string; left: number; top: number; right: number; bottom: number; }

type ReviewState =
  | { kind: "entry"; draft: OrderDraft; preview: OrderPreview; sourceTabId: string; chartSymbol: string }
  | { kind: "close-position"; draft: OrderDraft; preview: OrderPreview; positionId: string };

function mergeBars(current: Bar[], incoming: Bar[]): Bar[] {
  const byTime = new Map(current.map((bar) => [bar.time, bar]));
  incoming.forEach((bar) => byTime.set(bar.time, bar));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function formatPrice(value?: number): string {
  return value == null ? "—" : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

async function syncWorkspaceToOpenWindows(workspace: WorkspaceState): Promise<void> {
  await Promise.all(workspace.windows.map((window) => emitTo(window.id, "workspace-sync", workspace).catch(() => undefined)));
}

interface VwapMarketState {
  bars: Bar[];
  loadedRanges: EpochRange[];
  pendingRanges: EpochRange[];
  error?: string;
}

function blockedEntryResult(reason: string): EntryRuleResult {
  return { allowed: false, status: "waiting", reason, nodeResults: {} };
}

function IconButton({ label, active, children, onClick }: { label: string; active?: boolean; children: React.ReactNode; onClick?: () => void }) {
  return <button className={`icon-button ${active ? "active" : ""}`} aria-label={label} aria-pressed={active == null ? undefined : active} title={label} onClick={onClick}>{children}</button>;
}

function Modal({ title, children, onClose, width = 440 }: { title: string; children: React.ReactNode; onClose: () => void; width?: number }) {
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}><header><h2>{title}</h2><IconButton label="Close" onClick={onClose}><X size={17} /></IconButton></header>{children}</section></div>;
}

function TradeStationCredentials({ clientId, secret, busy, configured, native, showIntro = true, onClientIdChange, onSecretChange, onSave, onConnect }: {
  clientId: string;
  secret: string;
  busy: boolean;
  configured: boolean;
  native: boolean;
  showIntro?: boolean;
  onClientIdChange: (value: string) => void;
  onSecretChange: (value: string) => void;
  onSave: () => void;
  onConnect: () => void;
}) {
  return <>
    {showIntro && <div className="setup-intro"><LockKeyhole size={20} /><div><strong>Credentials stay on this device</strong><p>Your secret and refresh token are handled by the native process and stored in the operating system credential vault.</p></div></div>}
    {!native && <div className="demo-warning">You are viewing the browser-safe demo. Launch with <code>npm run tauri dev</code> to connect.</div>}
    <label className="field"><span>Auth0 API key / client ID</span><input value={clientId} onChange={(event) => onClientIdChange(event.target.value)} placeholder="Enter client ID" autoComplete="off" /></label>
    <label className="field"><span>Client secret</span><input value={secret} onChange={(event) => onSecretChange(event.target.value)} type="password" placeholder="Enter client secret" autoComplete="new-password" /></label>
    <div className="callback-note"><span>Callback URL</span><code>http://localhost:8080</code></div>
    <div className="connection-actions"><button className="secondary-button" disabled={busy || !native || !clientId.trim() || !secret.trim()} onClick={onSave}>Save credentials</button><button className="primary-button" disabled={busy || !native || !configured} onClick={onConnect}>Connect to TradeStation</button></div>
  </>;
}

export default function App() {
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const workspaceRef = useRef(workspace);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const environment = workspace.environment;
  const [tabMarkets, setTabMarkets] = useState<Record<string, TabMarketState>>({});
  const [vwapMarkets, setVwapMarkets] = useState<Record<string, VwapMarketState>>({});
  const vwapMarketsRef = useRef(vwapMarkets);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [positions, setPositions] = useState<Position[]>(api.isNative ? [] : demoPositions);
  const [orders, setOrders] = useState<OrderUpdate[]>(api.isNative ? [] : demoOrders);
  const [balances, setBalances] = useState<AccountBalance[]>([]);
  const [bodBalances, setBodBalances] = useState<AccountBalance[]>([]);
  const [history, setHistory] = useState<HistoricalOrderPage>({ orders: [] });
  const [brokerageLoading, setBrokerageLoading] = useState(false);
  const [brokerageError, setBrokerageError] = useState<string>();
  const [notifications, setNotifications] = useState<ActivityNotification[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [orderProjection, setOrderProjection] = useState<(OrderProjection & { tradeSymbol?: string }) | null>(null);
  const [orderTicketResetEpochs, setOrderTicketResetEpochs] = useState<Record<string, number>>({});
  const [tradeDetails, setTradeDetails] = useState<Record<string, SymbolMeta>>({});
  const [tradeDetailErrors, setTradeDetailErrors] = useState<Record<string, string>>({});
  const [contractChoices, setContractChoices] = useState<Record<string, SymbolMeta[]>>({});
  const [contractLookupErrors, setContractLookupErrors] = useState<Record<string, string>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SymbolMeta[]>(futures);
  const [indicatorOpen, setIndicatorOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [entryRulesOpen, setEntryRulesOpen] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [envConfirm, setEnvConfirm] = useState<TradingEnvironment | null>(null);
  const [activeTool, setActiveTool] = useState("cursor");
  const [horizontalToolsOpen, setHorizontalToolsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [credentialsConfigured, setCredentialsConfigured] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authEpoch, setAuthEpoch] = useState(0);
  const brokerageRefreshRef = useRef<(settle?: boolean) => void>(() => undefined);
  const [busy, setBusy] = useState(false);
  const [closingPositionIds, setClosingPositionIds] = useState<Set<string>>(() => new Set());
  const [replacingOrderIds, setReplacingOrderIds] = useState<Set<string>>(() => new Set());
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const subscriptionsRef = useRef(new Map<string, { subscriptionId: string; symbol: string; timeframe: Timeframe; epoch: string }>());
  const alertSubscriptionsRef = useRef(new Map<string, { subscriptionId: string; symbol: string; timeframe: Timeframe; epoch: string }>());
  const alertBarsRef = useRef(new Map<string, Bar[]>());
  const alertSidesRef = useRef(new Map<string, EmaCrossSide>());
  const alertLoadedEpochRef = useRef(new Map<string, string>());
  const alertDesiredRef = useRef(new Set<string>());
  const alertDataEpochRef = useRef("");
  const vwapSubscriptionsRef = useRef(new Map<string, { subscriptionId: string; symbol: string; epoch: string }>());
  const vwapSymbolsRef = useRef(new Set<string>());
  const vwapRangeTimersRef = useRef(new Map<string, number>());
  const vwapDataEpochRef = useRef("");
  const environmentRef = useRef(environment);
  const stripBoundsRef = useRef(new Map<string, StripBounds>());
  const viewRangesRef = useRef(new Map<string, { from: number; to: number }>());
  const windowState = workspace.windows.find((item) => item.id === currentWindowId) ?? workspace.windows[0];
  const isDetached = currentWindowId !== MAIN_WINDOW_ID;
  const hasWindowTabs = windowState.tabIds.length > 0;
  const activeTab = workspace.tabs.find((item) => item.id === windowState?.activeTabId) ?? workspace.tabs[0];
  const market = tabMarkets[activeTab.id] ?? { bars: [], hasOlder: true, loadingOlder: false, streamState: api.isNative ? "disconnected" : "streaming" };
  const bars = market.bars;
  const activeContinuous = isContinuousFuture(activeTab.symbol);
  const activeTradeSymbol = resolveTradeSymbol(activeTab);
  const activeTradeMeta = activeContinuous
    ? activeTradeSymbol ? tradeDetails[activeTradeSymbol] : undefined
    : activeTab.symbol;

  workspaceRef.current = workspace;
  vwapMarketsRef.current = vwapMarkets;

  const activeQuote = quotes[activeTab.symbol.symbol] ?? (api.isNative
    ? { symbol: activeTab.symbol.symbol, last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" }
    : quoteFor(activeTab.symbol.symbol));
  const activeChangePct = quoteDayChangePercent(activeQuote, previousSessionClose(bars, activeTab.timeframe));
  const activeEntryEligibility = useMemo(
    () => evaluateEntryRules(workspace.entryRules, bars, activeQuote),
    [workspace.entryRules, bars, activeQuote],
  );
  const tabStreamKey = workspace.tabs.map((tab) => `${tab.id}:${tab.symbol.symbol}:${tab.timeframe}`).join("|");
  const alertOwnershipKey = workspace.tabs.flatMap((tab) => ALERT_TIMEFRAMES.filter((timeframe) => tab.ema200Alert[timeframe].enabled).map((timeframe) => `${tab.id}:${tab.symbol.symbol}:${timeframe}`)).join("|");
  const alertMarkets = desiredAlertMarkets(workspace.tabs);
  const alertMarketsKey = alertMarkets.map((market) => market.key).sort().join("|");
  const activeAlertCount = ALERT_TIMEFRAMES.filter((timeframe) => activeTab.ema200Alert[timeframe].enabled).length;
  const chartSymbolsKey = [...new Set(workspace.tabs.map((tab) => tab.symbol.symbol))].sort().join("|");
  const tradeDetailSymbolsKey = [...new Set(workspace.tabs.filter((tab) => isContinuousFuture(tab.symbol)).map(resolveTradeSymbol).filter((symbol): symbol is string => Boolean(symbol)))].sort().join("|");
  const quoteSymbolsKey = quoteSubscriptionSymbols(workspace).join("|");
  const vwapSymbolsKey = nySessionVwapSymbols(workspace.tabs).join("|");
  alertDesiredRef.current = new Set(alertMarkets.map((market) => market.key));
  vwapSymbolsRef.current = new Set(vwapSymbolsKey.split("|").filter(Boolean));
  vwapDataEpochRef.current = `${environment}:${authEpoch}`;
  environmentRef.current = environment;
  const activeTradeQuote = activeTradeSymbol
    ? quotes[activeTradeSymbol] ?? (api.isNative
      ? { symbol: activeTradeSymbol, last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" }
      : quoteFor(activeTradeSymbol))
    : { symbol: "", last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" };

  function alertOwnerKey(tab: ChartTabState, timeframe: Timeframe): string {
    return `${tab.id}\u0000${tab.symbol.symbol}\u0000${timeframe}`;
  }

  function matchingAlertTabs(symbol: string, timeframe: Timeframe): ChartTabState[] {
    return workspaceRef.current.tabs.filter((tab) => tab.symbol.symbol === symbol && tab.ema200Alert[timeframe].enabled);
  }

  function primeAlertMarket(symbol: string, timeframe: Timeframe, incoming: Bar[], reset = true) {
    if (currentWindowId !== MAIN_WINDOW_ID) return;
    const key = alertMarketKey(symbol, timeframe);
    if (!alertDesiredRef.current.has(key)) return;
    const nextBars = reset ? mergeBars([], incoming) : mergeBars(alertBarsRef.current.get(key) ?? [], incoming);
    alertBarsRef.current.set(key, nextBars);
    matchingAlertTabs(symbol, timeframe).forEach((tab) => {
      const ownerKey = alertOwnerKey(tab, timeframe);
      if (!reset && alertSidesRef.current.has(ownerKey)) return;
      const evaluation = evaluateEma200Cross(nextBars);
      if (evaluation.side) alertSidesRef.current.set(ownerKey, evaluation.side);
      else alertSidesRef.current.delete(ownerKey);
    });
  }

  function handleAlertBarUpdate(payload: BarUpdateEvent) {
    if (currentWindowId !== MAIN_WINDOW_ID || payload.environment !== environmentRef.current) return;
    const key = alertMarketKey(payload.symbol, payload.timeframe);
    if (!alertDesiredRef.current.has(key)) return;
    const nextBars = mergeBars(alertBarsRef.current.get(key) ?? [], [payload.bar]);
    alertBarsRef.current.set(key, nextBars);
    matchingAlertTabs(payload.symbol, payload.timeframe).forEach((tab) => {
      const ownerKey = alertOwnerKey(tab, payload.timeframe);
      const previousSide = alertSidesRef.current.get(ownerKey);
      const evaluation = evaluateEma200Cross(nextBars, previousSide);
      if (evaluation.side) alertSidesRef.current.set(ownerKey, evaluation.side);
      if (!previousSide || !evaluation.direction || evaluation.price == null || evaluation.ema == null) return;
      const config = tab.ema200Alert[payload.timeframe];
      playAlertSound(config.sound, config.durationSeconds);
      const direction = evaluation.direction === "above" ? "above" : "below";
      const message = `${payload.symbol} ${payload.timeframe} crossed ${direction} EMA 200 at ${formatPrice(evaluation.price)} (EMA ${formatPrice(evaluation.ema)}).`;
      showToast(message);
      setNotifications((current) => [{
        id: crypto.randomUUID(),
        symbol: payload.symbol,
        time: new Date().toISOString(),
        title: `EMA 200 cross · ${payload.timeframe}`,
        text: `Price crossed ${direction} at ${formatPrice(evaluation.price)}; EMA 200 was ${formatPrice(evaluation.ema)}.`,
        level: "warning" as const,
      }, ...current].slice(0, 250));
    });
  }

  useEffect(() => {
    Promise.all([api.loadWorkspace(), api.authStatus()]).then(async ([saved, auth]) => {
      const normalized = normalizeChartWorkspace(saved, defaultWorkspace);
      await api.setEnvironment(normalized.environment);
      setWorkspace(normalized);
      setCredentialsConfigured(auth.configured);
      setAuthenticated(auth.authenticated);
      setAccounts(currentWindowId === MAIN_WINDOW_ID && auth.authenticated ? await api.accounts().catch(() => []) : []);
      if (currentWindowId === MAIN_WINDOW_ID && api.isNative && !auth.configured) setSetupOpen(true);
    }).finally(() => setWorkspaceLoaded(true));
    const cleanups: Array<() => void> = [];
    if (api.isNative) {
      listen<{ authenticated: boolean }>("auth-changed", async ({ payload }) => {
        if (!payload.authenticated) return;
        setAuthenticated(true);
        setSetupOpen(false);
        if (currentWindowId === MAIN_WINDOW_ID) setAccounts(await api.accounts().catch(() => []));
        setAuthEpoch((value) => value + 1);
        showToast("TradeStation connected.");
      }).then((unlisten) => cleanups.push(unlisten));
      listen<string>("auth-error", ({ payload }) => showToast(payload)).then((unlisten) => cleanups.push(unlisten));
      listen<BarSnapshotEvent>("bar-snapshot", ({ payload }) => {
        if (workspaceRef.current.tabs.some((tab) => tab.id === payload.subscriptionId)) {
          setTabMarkets((current) => ({ ...current, [payload.subscriptionId]: { ...(current[payload.subscriptionId] ?? { hasOlder: true, loadingOlder: false, streamState: "connecting" }), bars: payload.bars } }));
        }
        if (payload.environment === environmentRef.current && payload.timeframe === "1m" && vwapSymbolsRef.current.has(payload.symbol)) {
          setVwapMarkets((current) => ({ ...current, [payload.symbol]: { ...(current[payload.symbol] ?? { loadedRanges: [], pendingRanges: [] }), bars: mergeVwapBars(current[payload.symbol]?.bars ?? [], payload.bars) } }));
        }
        if (payload.environment === environmentRef.current) primeAlertMarket(payload.symbol, payload.timeframe, payload.bars);
      }).then((unlisten) => cleanups.push(unlisten));
      listen<BarUpdateEvent>("bar-update", ({ payload }) => {
        if (workspaceRef.current.tabs.some((tab) => tab.id === payload.subscriptionId)) {
          setTabMarkets((current) => ({ ...current, [payload.subscriptionId]: { ...(current[payload.subscriptionId] ?? { hasOlder: true, loadingOlder: false, streamState: "connecting", bars: [] }), bars: mergeBars(current[payload.subscriptionId]?.bars ?? [], [payload.bar]) } }));
        }
        if (payload.environment === environmentRef.current && payload.timeframe === "1m" && vwapSymbolsRef.current.has(payload.symbol)) {
          setVwapMarkets((current) => ({ ...current, [payload.symbol]: { ...(current[payload.symbol] ?? { loadedRanges: [], pendingRanges: [] }), bars: mergeVwapBars(current[payload.symbol]?.bars ?? [], [payload.bar]) } }));
        }
        handleAlertBarUpdate(payload);
      }).then((unlisten) => cleanups.push(unlisten));
      listen<QuoteUpdateEvent>("quote-update", ({ payload }) => {
        if (payload.environment !== environmentRef.current) return;
        setQuotes((current) => ({ ...current, [payload.quote.symbol]: { ...payload.quote, receivedAt: Date.now() } }));
      }).then((unlisten) => cleanups.push(unlisten));
      listen<StreamStateEvent>("stream-state", ({ payload }) => {
        if (!workspaceRef.current.tabs.some((tab) => tab.id === payload.subscriptionId) || payload.channel !== "bars") return;
        setTabMarkets((current) => ({ ...current, [payload.subscriptionId]: { ...(current[payload.subscriptionId] ?? { bars: [], hasOlder: true, loadingOlder: false }), streamState: payload.state } }));
      }).then((unlisten) => cleanups.push(unlisten));
      listen<{ accountId: string }>("brokerage-update", () => brokerageRefreshRef.current()).then((unlisten) => cleanups.push(unlisten));
      listen<string>("brokerage-stream-error", ({ payload }) => setNotifications((current) => [{ id: crypto.randomUUID(), time: new Date().toISOString(), title: "Brokerage stream reconnecting", text: payload, level: "warning" as const }, ...current].slice(0, 250))).then((unlisten) => cleanups.push(unlisten));
    }
    listen<WorkspaceState>("workspace-sync", ({ payload }) => {
      if (payload.revision <= workspaceRef.current.revision) return;
      const next = stabilizeChartWorkspace(workspaceRef.current, normalizeChartWorkspace(payload, defaultWorkspace));
      workspaceRef.current = next;
      setWorkspace(next);
    }).then((unlisten) => cleanups.push(unlisten));
    listen<WorkspaceState>("workspace-proposal", ({ payload }) => {
      if (currentWindowId !== MAIN_WINDOW_ID) return;
      const normalized = { ...normalizeChartWorkspace(payload, defaultWorkspace), revision: Math.max(workspaceRef.current.revision + 1, Date.now()) };
      const next = stabilizeChartWorkspace(workspaceRef.current, normalized);
      workspaceRef.current = next;
      setWorkspace(next);
      syncWorkspaceToOpenWindows(next);
    }).then((unlisten) => cleanups.push(unlisten));
    listen<{ windowId: string }>("workspace-window-ready", ({ payload }) => {
      if (currentWindowId === MAIN_WINDOW_ID) emitTo(payload.windowId, "workspace-sync", workspaceRef.current).catch(() => undefined);
    }).then((unlisten) => cleanups.push(unlisten));
    listen<StripBounds>("chart-strip-bounds", ({ payload }) => stripBoundsRef.current.set(payload.windowId, payload)).then((unlisten) => cleanups.push(unlisten));
    listen<{ tabId: string; range: { from: number; to: number } }>("chart-viewport", ({ payload }) => viewRangesRef.current.set(payload.tabId, payload.range)).then((unlisten) => cleanups.push(unlisten));
    return () => cleanups.forEach((unlisten) => unlisten());
  }, []);

  useEffect(() => {
    if (workspaceLoaded && currentWindowId !== MAIN_WINDOW_ID) emitTo(MAIN_WINDOW_ID, "workspace-window-ready", { windowId: currentWindowId }).catch(() => undefined);
  }, [workspaceLoaded]);

  const selectedAccount = accounts.find((account) => account.id === workspace.selectedAccountId) ?? accounts[0];

  useEffect(() => {
    if (currentWindowId !== MAIN_WINDOW_ID || !selectedAccount) return;
    if (workspace.selectedAccountId !== selectedAccount.id) updateWorkspace({ selectedAccountId: selectedAccount.id });
    let active = true;
    let balanceRefreshTimer: number | undefined;
    let balanceRefreshInFlight = false;
    let balanceRefreshQueued = false;
    let tradingRefreshInFlight = false;
    let tradingRefreshQueued = false;
    const settlementTimers = new Set<number>();
    const refreshTradingState = async () => {
      if (!active) return;
      if (tradingRefreshInFlight) {
        tradingRefreshQueued = true;
        return;
      }
      tradingRefreshInFlight = true;
      try {
        do {
          tradingRefreshQueued = false;
          try {
            const [nextPositions, nextOrders] = await Promise.all([
              api.positions(selectedAccount.id), api.orders(selectedAccount.id),
            ]);
            if (active) {
              setPositions(nextPositions);
              setOrders(nextOrders);
              setBrokerageError(undefined);
            }
          } catch (error) {
            if (active) setBrokerageError(String(error));
          }
        } while (active && tradingRefreshQueued);
      } finally {
        tradingRefreshInFlight = false;
      }
    };
    const refreshBalances = async () => {
      if (balanceRefreshInFlight) {
        balanceRefreshQueued = true;
        return;
      }
      balanceRefreshInFlight = true;
      do {
        balanceRefreshQueued = false;
        try {
          const nextBalances = await api.balances(selectedAccount.id);
          if (active) setBalances(nextBalances);
        } catch (error) {
          if (active) setBrokerageError(String(error));
        }
      } while (active && balanceRefreshQueued);
      balanceRefreshInFlight = false;
    };
    const requestBalanceRefresh = () => {
      if (!active || balanceRefreshTimer != null) return;
      balanceRefreshTimer = window.setTimeout(() => {
        balanceRefreshTimer = undefined;
        void refreshBalances();
      }, 2_000);
    };
    const refreshBodBalances = async () => {
      try {
        const nextBod = await api.bodBalances(selectedAccount.id);
        if (active) setBodBalances(nextBod);
      } catch (error) {
        if (active) setBrokerageError(String(error));
      }
    };
    const scheduleSettlementRefreshes = () => {
      settlementTimers.forEach((timer) => window.clearTimeout(timer));
      settlementTimers.clear();
      [350, 1_000, 2_500].forEach((delay) => {
        const timer = window.setTimeout(() => {
          settlementTimers.delete(timer);
          void refreshTradingState();
        }, delay);
        settlementTimers.add(timer);
      });
    };
    const requestBrokerageRefresh = (settle = false) => {
      if (!active) return;
      void refreshTradingState();
      requestBalanceRefresh();
      if (settle) scheduleSettlementRefreshes();
    };
    brokerageRefreshRef.current = requestBrokerageRefresh;
    const refreshAll = async () => {
      setBrokerageLoading(true); setBrokerageError(undefined);
      await Promise.all([refreshTradingState(), refreshBalances(), refreshBodBalances()]);
      if (active) setBrokerageLoading(false);
    };
    void refreshAll();
    const tradingTimer = window.setInterval(() => void refreshTradingState(), 5_000);
    const accountTimer = window.setInterval(() => {
      void refreshBalances();
      void refreshBodBalances();
    }, 30_000);
    return () => {
      active = false;
      clearInterval(tradingTimer);
      clearInterval(accountTimer);
      if (balanceRefreshTimer != null) clearTimeout(balanceRefreshTimer);
      settlementTimers.forEach((timer) => window.clearTimeout(timer));
      if (brokerageRefreshRef.current === requestBrokerageRefresh) brokerageRefreshRef.current = () => undefined;
    };
  }, [selectedAccount?.id, authEpoch, environment]);

  useEffect(() => {
    if (currentWindowId !== MAIN_WINDOW_ID || !selectedAccount || !api.isNative || !authenticated) return;
    api.startBrokerageStream(selectedAccount.id).catch((error) => setBrokerageError(String(error)));
    return () => { api.stopBrokerageStream(); };
  }, [selectedAccount?.id, authenticated, environment]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID) return;
    const epoch = `${authEpoch}:${environment}:${authenticated}`;
    const activeIds = new Set(workspace.tabs.map((tab) => tab.id));
    subscriptionsRef.current.forEach((subscription, tabId) => {
      const tab = workspace.tabs.find((item) => item.id === tabId);
      if (!activeIds.has(tabId) || !tab || subscription.symbol !== tab.symbol.symbol || subscription.timeframe !== tab.timeframe || subscription.epoch !== epoch) {
        if (api.isNative) api.stopBarStream(subscription.subscriptionId);
        subscriptionsRef.current.delete(tabId);
      }
    });
    workspace.tabs.forEach((tab) => {
      if (subscriptionsRef.current.has(tab.id)) return;
      const subscriptionId = tab.id;
      subscriptionsRef.current.set(tab.id, { subscriptionId, symbol: tab.symbol.symbol, timeframe: tab.timeframe, epoch });
      setTabMarkets((current) => ({ ...current, [tab.id]: { bars: [], hasOlder: true, loadingOlder: false, streamState: api.isNative ? "connecting" : "streaming" } }));
      if (!api.isNative) {
        api.bars(tab.symbol.symbol, tab.timeframe).then((nextBars) => setTabMarkets((current) => ({ ...current, [tab.id]: { ...(current[tab.id] ?? { hasOlder: true, loadingOlder: false, streamState: "streaming" }), bars: nextBars } }))).catch((error) => showToast(String(error)));
      } else if (authenticated) {
        api.cachedBars(tab.symbol.symbol, tab.timeframe).then((cached) => setTabMarkets((current) => ({ ...current, [tab.id]: { ...(current[tab.id] ?? { hasOlder: true, loadingOlder: false, streamState: "connecting" }), bars: mergeBars(cached, current[tab.id]?.bars ?? []) } }))).catch(() => undefined);
        api.startBarStream(subscriptionId, tab.symbol.symbol, tab.timeframe).catch((error) => {
          setTabMarkets((current) => ({ ...current, [tab.id]: { ...(current[tab.id] ?? { bars: [], hasOlder: true, loadingOlder: false }), streamState: "disconnected" } }));
          showToast(String(error));
        });
      }
    });
  }, [tabStreamKey, authEpoch, authenticated, environment, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID) return;
    const epoch = `${authEpoch}:${environment}:${authenticated}`;
    if (alertDataEpochRef.current !== epoch) {
      alertDataEpochRef.current = epoch;
      alertBarsRef.current.clear();
      alertSidesRef.current.clear();
      alertLoadedEpochRef.current.clear();
    }

    const desired = desiredAlertMarkets(workspace.tabs);
    const desiredKeys = new Set(desired.map((market) => market.key));
    const uncovered = uncoveredAlertMarkets(workspace.tabs);
    const uncoveredKeys = new Set(uncovered.map((market) => market.key));
    const ownerKeys = new Set(workspace.tabs.flatMap((tab) => ALERT_TIMEFRAMES
      .filter((timeframe) => tab.ema200Alert[timeframe].enabled)
      .map((timeframe) => alertOwnerKey(tab, timeframe))));

    alertSubscriptionsRef.current.forEach((subscription, key) => {
      if (uncoveredKeys.has(key) && subscription.epoch === epoch) return;
      if (api.isNative) void api.stopBarStream(subscription.subscriptionId);
      alertSubscriptionsRef.current.delete(key);
    });
    alertBarsRef.current.forEach((_, key) => {
      if (!desiredKeys.has(key)) alertBarsRef.current.delete(key);
    });
    alertLoadedEpochRef.current.forEach((_, key) => {
      if (!desiredKeys.has(key)) alertLoadedEpochRef.current.delete(key);
    });
    alertSidesRef.current.forEach((_, key) => {
      if (!ownerKeys.has(key)) alertSidesRef.current.delete(key);
    });

    desired.forEach((market) => {
      const existing = alertBarsRef.current.get(market.key);
      if (existing?.length) primeAlertMarket(market.symbol, market.timeframe, existing, false);
      if (alertLoadedEpochRef.current.get(market.key) === epoch) return;
      alertLoadedEpochRef.current.set(market.key, epoch);
      const load = api.isNative ? api.cachedBars(market.symbol, market.timeframe) : api.bars(market.symbol, market.timeframe);
      load.then((loaded) => {
        if (alertDataEpochRef.current === epoch && alertDesiredRef.current.has(market.key)) primeAlertMarket(market.symbol, market.timeframe, loaded, false);
      }).catch(() => undefined);
    });

    uncovered.forEach((market) => {
      if (alertSubscriptionsRef.current.has(market.key) || !api.isNative || !authenticated) return;
      const subscriptionId = `ema-alert:${encodeURIComponent(market.symbol)}:${market.timeframe}`;
      alertSubscriptionsRef.current.set(market.key, { subscriptionId, symbol: market.symbol, timeframe: market.timeframe, epoch });
      api.startBarStream(subscriptionId, market.symbol, market.timeframe).catch((error) => {
        if (alertSubscriptionsRef.current.get(market.key)?.epoch !== epoch) return;
        alertSubscriptionsRef.current.delete(market.key);
        const message = `EMA alert data unavailable for ${market.symbol} ${market.timeframe}: ${String(error)}`;
        showToast(message);
        setNotifications((current) => [{ id: crypto.randomUUID(), symbol: market.symbol, time: new Date().toISOString(), title: "EMA alert stream unavailable", text: message, level: "error" as const }, ...current].slice(0, 250));
      });
    });
  }, [alertMarketsKey, alertOwnershipKey, tabStreamKey, authEpoch, authenticated, environment, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID) return;
    const epoch = `${authEpoch}:${environment}:${authenticated}`;
    const desired = new Set(vwapSymbolsKey.split("|").filter(Boolean));
    const sharedOneMinute = new Set(workspace.tabs.filter((tab) => tab.timeframe === "1m").map((tab) => tab.symbol.symbol));

    vwapRangeTimersRef.current.forEach((timer, symbol) => {
      if (desired.has(symbol)) return;
      window.clearTimeout(timer);
      vwapRangeTimersRef.current.delete(symbol);
    });

    vwapSubscriptionsRef.current.forEach((subscription, symbol) => {
      if (!desired.has(symbol) || sharedOneMinute.has(symbol) || subscription.epoch !== epoch) {
        if (api.isNative) void api.stopBarStream(subscription.subscriptionId);
        vwapSubscriptionsRef.current.delete(symbol);
      }
    });

    desired.forEach((symbol) => {
      if (sharedOneMinute.has(symbol) || vwapSubscriptionsRef.current.has(symbol)) return;
      const subscriptionId = `ny-session-vwap:${symbol}`;
      vwapSubscriptionsRef.current.set(symbol, { subscriptionId, symbol, epoch });
      const mergeSource = (incoming: Bar[]) => {
        if (vwapSubscriptionsRef.current.get(symbol)?.epoch !== epoch) return;
        setVwapMarkets((current) => ({
          ...current,
          [symbol]: { ...(current[symbol] ?? { loadedRanges: [], pendingRanges: [] }), bars: mergeVwapBars(current[symbol]?.bars ?? [], incoming) },
        }));
      };
      if (!api.isNative) {
        api.bars(symbol, "1m").then(mergeSource).catch(() => undefined);
      } else if (authenticated) {
        api.cachedBars(symbol, "1m").then(mergeSource).catch(() => undefined);
        api.startBarStream(subscriptionId, symbol, "1m").catch((error) => {
          if (vwapSubscriptionsRef.current.get(symbol)?.epoch !== epoch) return;
          vwapSubscriptionsRef.current.delete(symbol);
          setVwapMarkets((current) => ({
            ...current,
            [symbol]: { ...(current[symbol] ?? { bars: [], loadedRanges: [], pendingRanges: [] }), error: String(error) },
          }));
        });
      }
    });
  }, [vwapSymbolsKey, tabStreamKey, authEpoch, authenticated, environment, workspaceLoaded]);

  useEffect(() => {
    setVwapMarkets((current) => {
      let changed = false;
      const next = { ...current };
      Object.entries(next).forEach(([symbol, state]) => {
        if (vwapSymbolsRef.current.has(symbol) || !state.pendingRanges.length) return;
        next[symbol] = { ...state, pendingRanges: [] };
        changed = true;
      });
      return changed ? next : current;
    });
  }, [vwapSymbolsKey]);

  useEffect(() => {
    if (!workspaceLoaded || tabMarkets[activeTab.id]?.bars.length) return;
    const load = api.isNative ? api.cachedBars(activeTab.symbol.symbol, activeTab.timeframe) : api.bars(activeTab.symbol.symbol, activeTab.timeframe);
    load.then((loadedBars) => setTabMarkets((current) => ({ ...current, [activeTab.id]: { ...(current[activeTab.id] ?? { hasOlder: true, loadingOlder: false, streamState: api.isNative ? "connecting" : "streaming" }), bars: mergeBars(loadedBars, current[activeTab.id]?.bars ?? []) } }))).catch(() => undefined);
  }, [workspaceLoaded, activeTab.id, activeTab.symbol.symbol, activeTab.timeframe]);

  useEffect(() => () => {
    vwapRangeTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    if (currentWindowId === MAIN_WINDOW_ID) {
      subscriptionsRef.current.forEach((subscription) => api.stopBarStream(subscription.subscriptionId));
      alertSubscriptionsRef.current.forEach((subscription) => api.stopBarStream(subscription.subscriptionId));
      vwapSubscriptionsRef.current.forEach((subscription) => api.stopBarStream(subscription.subscriptionId));
    }
  }, []);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || !api.isNative || !authenticated) return;
    const symbols = quoteSymbolsKey.split("|").filter(Boolean);
    api.startQuoteStream("shared-quotes", symbols).catch((error) => showToast(String(error)));
    return () => { api.stopQuoteStream("shared-quotes"); };
  }, [quoteSymbolsKey, authEpoch, authenticated, environment, workspaceLoaded]);

  useEffect(() => {
    if (api.isNative) return;
    const refresh = () => api.quotes(quoteSymbolsKey.split("|").filter(Boolean)).then((items) => setQuotes(Object.fromEntries(items.map((quote) => [quote.symbol, { ...quote, receivedAt: Date.now() }])))).catch(() => setQuotes({}));
    refresh();
    const timer = window.setInterval(refresh, api.isNative ? 3000 : 1800);
    return () => clearInterval(timer);
  }, [quoteSymbolsKey, authEpoch]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function loadVwapRange(symbol: string, range: EpochRange) {
    const epoch = vwapDataEpochRef.current;
    setVwapMarkets((current) => ({
      ...current,
      [symbol]: {
        ...(current[symbol] ?? { bars: [], loadedRanges: [] }),
        pendingRanges: [...(current[symbol]?.pendingRanges ?? []), range],
        error: undefined,
      },
    }));
    try {
      const cached = await api.cachedBarRange(symbol, "1m", range.first, range.last).catch(() => []);
      if (epoch !== vwapDataEpochRef.current) return;
      if (!vwapSymbolsRef.current.has(symbol)) {
        setVwapMarkets((current) => current[symbol] ? ({
          ...current,
          [symbol]: { ...current[symbol], pendingRanges: current[symbol].pendingRanges.filter((item) => item.first !== range.first || item.last !== range.last) },
        }) : current);
        return;
      }
      if (cached.length) {
        setVwapMarkets((current) => ({
          ...current,
          [symbol]: { ...(current[symbol] ?? { loadedRanges: [], pendingRanges: [] }), bars: mergeVwapBars(current[symbol]?.bars ?? [], cached) },
        }));
      }
      const loaded = await api.barRange(symbol, "1m", range.first, range.last);
      if (epoch !== vwapDataEpochRef.current) return;
      if (!vwapSymbolsRef.current.has(symbol)) {
        setVwapMarkets((current) => current[symbol] ? ({
          ...current,
          [symbol]: { ...current[symbol], pendingRanges: current[symbol].pendingRanges.filter((item) => item.first !== range.first || item.last !== range.last) },
        }) : current);
        return;
      }
      setVwapMarkets((current) => ({
        ...current,
        [symbol]: {
          ...(current[symbol] ?? { bars: [], pendingRanges: [] }),
          bars: mergeVwapBars(current[symbol]?.bars ?? [], loaded),
          loadedRanges: mergeEpochRanges([...(current[symbol]?.loadedRanges ?? []), range]),
          pendingRanges: (current[symbol]?.pendingRanges ?? []).filter((item) => item.first !== range.first || item.last !== range.last),
          error: undefined,
        },
      }));
    } catch (error) {
      if (epoch !== vwapDataEpochRef.current) return;
      setVwapMarkets((current) => ({
        ...current,
        [symbol]: {
          ...(current[symbol] ?? { bars: [], loadedRanges: [] }),
          pendingRanges: (current[symbol]?.pendingRanges ?? []).filter((item) => item.first !== range.first || item.last !== range.last),
          error: String(error),
        },
      }));
    }
  }

  function queueVwapRange(symbol: string, first: number, last: number) {
    if (!vwapSymbolsRef.current.has(symbol) || !Number.isFinite(first) || !Number.isFinite(last) || first >= last) return;
    const prior = vwapRangeTimersRef.current.get(symbol);
    if (prior != null) window.clearTimeout(prior);
    const timer = window.setTimeout(() => {
      vwapRangeTimersRef.current.delete(symbol);
      if (!vwapSymbolsRef.current.has(symbol)) return;
      const state = vwapMarketsRef.current[symbol];
      const expanded = expandedVwapRange(first, last);
      const missing = missingEpochRanges(expanded.first, expanded.last, [
        ...(state?.loadedRanges ?? []),
        ...(state?.pendingRanges ?? []),
      ]);
      missing.flatMap(chunkVwapRange).forEach((range) => void loadVwapRange(symbol, range));
    }, 220);
    vwapRangeTimersRef.current.set(symbol, timer);
  }

  function requestVisibleVwap(range: { from: number; to: number }) {
    viewRangesRef.current.set(activeTab.id, range);
    emit("chart-viewport", { tabId: activeTab.id, range });
    if (!isIntradayTimeframe(activeTab.timeframe) || !activeTab.indicators.some((indicator) => indicator.kind === "VWAP" && indicator.visible) || !bars.length) return;
    const firstIndex = Math.max(0, Math.min(bars.length - 1, Math.floor(range.from)));
    const lastIndex = Math.max(firstIndex, Math.min(bars.length - 1, Math.ceil(range.to)));
    queueVwapRange(activeTab.symbol.symbol, bars[firstIndex].time, bars[lastIndex].time + 60);
  }

  useEffect(() => {
    if (!workspaceLoaded || !bars.length || !isIntradayTimeframe(activeTab.timeframe) || !activeTab.indicators.some((indicator) => indicator.kind === "VWAP" && indicator.visible)) return;
    const saved = viewRangesRef.current.get(activeTab.id);
    const firstIndex = saved ? Math.max(0, Math.min(bars.length - 1, Math.floor(saved.from))) : Math.max(0, bars.length - 180);
    const lastIndex = saved ? Math.max(firstIndex, Math.min(bars.length - 1, Math.ceil(saved.to))) : bars.length - 1;
    queueVwapRange(activeTab.symbol.symbol, bars[firstIndex].time, bars[lastIndex].time + 60);
  }, [workspaceLoaded, activeTab.id, activeTab.symbol.symbol, activeTab.timeframe, activeTab.indicators, bars.length]);

  useEffect(() => {
    if (api.isNative || activeTab.timeframe !== "1m" || !vwapSymbolsRef.current.has(activeTab.symbol.symbol) || !bars.length) return;
    setVwapMarkets((current) => ({
      ...current,
      [activeTab.symbol.symbol]: {
        ...(current[activeTab.symbol.symbol] ?? { loadedRanges: [], pendingRanges: [] }),
        bars: mergeVwapBars(current[activeTab.symbol.symbol]?.bars ?? [], bars),
      },
    }));
  }, [activeTab.symbol.symbol, activeTab.timeframe, bars]);

  async function loadOlder() {
    if (!api.isNative || market.loadingOlder || !market.hasOlder || !bars.length) return;
    const tabId = activeTab.id;
    const before = bars[0].time;
    setTabMarkets((current) => ({ ...current, [tabId]: { ...market, loadingOlder: true } }));
    try {
      const older = await api.olderBars(activeTab.symbol.symbol, activeTab.timeframe, before);
      setTabMarkets((current) => ({ ...current, [tabId]: { ...(current[tabId] ?? market), hasOlder: older.length > 0, bars: older.length ? mergeBars(older, current[tabId]?.bars ?? []) : current[tabId]?.bars ?? [] } }));
    } catch (error) { showToast(String(error)); }
    finally { setTabMarkets((current) => ({ ...current, [tabId]: { ...(current[tabId] ?? market), loadingOlder: false } })); }
  }

  useEffect(() => {
    if (!workspaceLoaded) return;
    if (currentWindowId !== MAIN_WINDOW_ID) return;
    const timer = window.setTimeout(() => api.saveWorkspace(workspace), 250);
    return () => clearTimeout(timer);
  }, [workspace, workspaceLoaded]);

  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(() => api.symbolSearch(search).then(setSearchResults).catch(() => setSearchResults([])), 180);
    return () => clearTimeout(timer);
  }, [search, searchOpen]);

  useEffect(() => {
    setTradeDetails({});
    setTradeDetailErrors({});
    setContractChoices({});
    setContractLookupErrors({});
    setVwapMarkets({});
    vwapRangeTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    vwapRangeTimersRef.current.clear();
  }, [environment]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || api.isNative && !authenticated) return;
    let active = true;
    const refresh = async () => {
      const symbols = chartSymbolsKey.split("|").filter(Boolean);
      const settled = await Promise.all(symbols.map(async (symbol) => {
        try { return await api.symbolDetails(symbol); }
        catch { return null; }
      }));
      if (!active) return;
      const details = new Map(settled.filter((item): item is SymbolMeta => Boolean(item)).map((item) => [item.symbol, item]));
      if (!details.size) return;
      commitWorkspace((current) => {
        let changed = false;
        const tabs = current.tabs.map((tab) => {
          const next = details.get(tab.symbol.symbol);
          if (!next || sameSymbolMeta(tab.symbol, next)) return tab;
          changed = true;
          return { ...tab, symbol: next };
        });
        return changed ? { ...current, tabs } : current;
      });
    };
    void refresh();
    const timer = window.setInterval(refresh, 15 * 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [workspaceLoaded, authenticated, environment, authEpoch, chartSymbolsKey]);

  useEffect(() => {
    if (!workspaceLoaded || api.isNative && !authenticated) return;
    let active = true;
    const symbols = tradeDetailSymbolsKey.split("|").filter(Boolean);
    if (!symbols.length) return;
    Promise.all(symbols.map(async (symbol) => {
      try { return { symbol, details: await api.symbolDetails(symbol) }; }
      catch (error) { return { symbol, error: String(error) }; }
    })).then((items) => {
      if (!active) return;
      setTradeDetails((current) => {
        const next = { ...current };
        items.forEach((item) => { if (item.details) next[item.symbol] = item.details; });
        return next;
      });
      setTradeDetailErrors((current) => {
        const next = { ...current };
        items.forEach((item) => {
          if (item.error) next[item.symbol] = item.error;
          else delete next[item.symbol];
        });
        return next;
      });
    });
    return () => { active = false; };
  }, [workspaceLoaded, authenticated, environment, authEpoch, tradeDetailSymbolsKey]);

  useEffect(() => {
    const root = activeContinuous ? activeTab.symbol.root : undefined;
    if (!workspaceLoaded || !root || api.isNative && !authenticated) return;
    let active = true;
    setContractLookupErrors((current) => ({ ...current, [root]: "" }));
    api.futureContracts(root).then((contracts) => {
      if (active) setContractChoices((current) => ({ ...current, [root]: contracts }));
    }).catch((error) => {
      if (active) setContractLookupErrors((current) => ({ ...current, [root]: String(error) }));
    });
    return () => { active = false; };
  }, [workspaceLoaded, authenticated, environment, authEpoch, activeContinuous, activeTab.symbol.root]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }

  function commitWorkspace(update: (current: WorkspaceState) => WorkspaceState) {
    setWorkspace((current) => {
      const next = currentWindowId === MAIN_WINDOW_ID
        ? { ...update(current), revision: Math.max(current.revision + 1, Date.now()) }
        : update(current);
      workspaceRef.current = next;
      if (currentWindowId === MAIN_WINDOW_ID) syncWorkspaceToOpenWindows(next);
      else emitTo(MAIN_WINDOW_ID, "workspace-proposal", next).catch(() => undefined);
      return next;
    });
  }

  function updateWorkspace(patch: Partial<WorkspaceState>) {
    commitWorkspace((current) => ({ ...current, ...patch }));
  }

  function updateChartLabelSettings(patch: Partial<ChartLabelSettings>) {
    commitWorkspace((current) => ({
      ...current,
      settings: {
        ...current.settings,
        chartLabels: { ...current.settings.chartLabels, ...patch },
      },
    }));
  }

  function updateActiveTab(patch: Partial<ChartTabState>) {
    commitWorkspace((current) => ({ ...current, tabs: current.tabs.map((tab) => tab.id === activeTab.id ? { ...tab, ...patch } : tab) }));
  }

  function updateSymbolDrawings(symbol: string, update: (drawings: Drawing[]) => Drawing[]) {
    commitWorkspace((current) => ({ ...current, drawings: { ...current.drawings, [symbol]: update(current.drawings[symbol] ?? []) } }));
  }

  function updateIndicator(id: string, patch: Partial<IndicatorConfig>) {
    updateActiveTab({ indicators: activeTab.indicators.map((indicator) => indicator.id === id ? { ...indicator, ...patch } : indicator) });
  }

  function updateTimeframeAlert(timeframe: Timeframe, patch: Partial<TimeframeAlertConfig>) {
    updateActiveTab({ ema200Alert: { ...activeTab.ema200Alert, [timeframe]: { ...activeTab.ema200Alert[timeframe], ...patch } } });
  }

  function selectTab(tabId: string) {
    commitWorkspace((current) => ({ ...current, windows: current.windows.map((item) => item.id === currentWindowId ? { ...item, activeTabId: tabId } : item) }));
  }

  function addTab() {
    if (workspace.tabs.length >= MAX_CHART_TABS) return showToast(`A maximum of ${MAX_CHART_TABS} chart tabs is supported.`);
    const id = `chart-${crypto.randomUUID()}`;
    commitWorkspace((current) => ({
      ...current,
      tabs: [...current.tabs, cloneChartTab(activeTab, id)],
      windows: current.windows.map((item) => item.id === currentWindowId ? { ...item, tabIds: [...item.tabIds, id], activeTabId: id } : item),
    }));
  }

  async function closeTab(tabId: string) {
    if (workspace.tabs.length === 1) return;
    let removedWindow: string | undefined;
    commitWorkspace((current) => {
      const next = structuredClone(current);
      next.tabs = next.tabs.filter((tab) => tab.id !== tabId);
      const owner = next.windows.find((item) => item.tabIds.includes(tabId));
      if (!owner) return current;
      const index = owner.tabIds.indexOf(tabId);
      owner.tabIds.splice(index, 1);
      if (!owner.tabIds.length) {
        if (owner.id !== MAIN_WINDOW_ID) {
          removedWindow = owner.id;
          next.windows = next.windows.filter((item) => item.id !== owner.id);
        }
      }
      if (!owner.tabIds.includes(owner.activeTabId)) owner.activeTabId = owner.tabIds[Math.min(index, owner.tabIds.length - 1)] ?? "";
      return next;
    });
    if (removedWindow && api.isNative) (await WebviewWindow.getByLabel(removedWindow))?.destroy();
  }

  function reorderTab(tabId: string, targetIndex: number) {
    commitWorkspace((current) => moveTab(current, tabId, currentWindowId, targetIndex));
  }

  async function ensureDetachedWindow(state: ChartWindowState) {
    if (!api.isNative || !state.detached || await WebviewWindow.getByLabel(state.id)) return;
    const monitors = await availableMonitors();
    const screens = monitors.map((monitor) => ({ x: monitor.position.x / monitor.scaleFactor, y: monitor.position.y / monitor.scaleFactor, width: monitor.size.width / monitor.scaleFactor, height: monitor.size.height / monitor.scaleFactor }));
    const geometry = clampWindowGeometry({ x: state.x ?? screens[0]?.x ?? 0, y: state.y ?? screens[0]?.y ?? 0, width: state.width ?? 1100, height: state.height ?? 760 }, screens);
    const view = new WebviewWindow(state.id, {
      url: `/?window=${encodeURIComponent(state.id)}`,
      title: "Northstar Trader — Chart",
      width: geometry.width,
      height: geometry.height,
      x: geometry.x,
      y: geometry.y,
      minWidth: 760,
      minHeight: 520,
      resizable: true,
      decorations: true,
    });
    view.once("tauri://created", async () => {
      await emitTo(state.id, "workspace-sync", workspaceRef.current);
      state.tabIds.forEach((tabId) => {
        const range = viewRangesRef.current.get(tabId);
        if (range) emit("chart-viewport", { tabId, range });
      });
    });
    view.once("tauri://error", ({ payload }) => showToast(`Could not detach chart: ${String(payload)}`));
  }

  async function detachTab(tabId: string) {
    if (!api.isNative) return showToast("Detaching charts is available in the desktop app.");
    const source = workspaceRef.current.windows.find((item) => item.tabIds.includes(tabId));
    if (!source) return;
    const position = await cursorPosition();
    const scale = await getCurrentWindow().scaleFactor();
    const windowId = `chart-window-${crypto.randomUUID()}`;
    let detachedState: ChartWindowState | undefined;
    commitWorkspace((current) => {
      let next = structuredClone(current);
      detachedState = { id: windowId, detached: true, tabIds: [], activeTabId: tabId, x: Math.round(position.x / scale - 180), y: Math.round(position.y / scale - 18), width: 1100, height: 760 };
      next.windows.push(detachedState);
      next = moveTab(next, tabId, windowId, 0);
      return next;
    });
    if (detachedState) await ensureDetachedWindow(detachedState);
    if (source.id !== MAIN_WINDOW_ID && source.tabIds.length === 1) (await WebviewWindow.getByLabel(source.id))?.destroy();
  }

  async function finishTabDrag(tabId: string) {
    if (!api.isNative) return;
    const point = await cursorPosition();
    const targetBounds = [...stripBoundsRef.current.values()].find((bounds) => point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom);
    if (!targetBounds) return detachTab(tabId);
    const targetWindow = workspaceRef.current.windows.find((item) => item.id === targetBounds.windowId);
    if (!targetWindow) return detachTab(tabId);
    const index = tabInsertionIndex(point.x, targetBounds.left, targetBounds.right, targetWindow.tabIds.length);
    const source = workspaceRef.current.windows.find((item) => item.tabIds.includes(tabId));
    const sourceId = source?.id;
    commitWorkspace((current) => moveTab(current, tabId, targetBounds.windowId, index));
    if (sourceId && sourceId !== MAIN_WINDOW_ID && sourceId !== targetBounds.windowId && workspaceRef.current.windows.find((item) => item.id === sourceId)?.tabIds.length === 1) {
      (await WebviewWindow.getByLabel(sourceId))?.destroy();
    }
  }

  useEffect(() => {
    if (!workspaceLoaded || !api.isNative || currentWindowId !== MAIN_WINDOW_ID) return;
    workspace.windows.filter((item) => item.detached).forEach((item) => ensureDetachedWindow(item));
  }, [workspaceLoaded, workspace.windows]);

  useEffect(() => {
    if (!api.isNative) {
      const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement != null);
      syncFullscreenState();
      document.addEventListener("fullscreenchange", syncFullscreenState);
      return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
    }

    const current = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | undefined;
    const syncFullscreenState = () => {
      current.isFullscreen().then((fullscreen) => {
        if (active) setIsFullscreen(fullscreen);
      }).catch(() => undefined);
    };
    syncFullscreenState();
    current.onResized(syncFullscreenState).then((cleanup) => {
      if (active) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const liveWindowIds = new Set(workspace.windows.map((item) => item.id));
    stripBoundsRef.current.forEach((_, id) => { if (!liveWindowIds.has(id)) stripBoundsRef.current.delete(id); });
  }, [workspace.windows]);

  useEffect(() => {
    if (!api.isNative) return;
    const current = getCurrentWindow();
    let closing = false;
    let geometryTimer: number | undefined;
    let dockTimer: number | undefined;
    const cleanups: Array<() => void> = [];
    current.onCloseRequested(async (event) => {
      if (closing) return;
      event.preventDefault();
      closing = true;
      if (currentWindowId === MAIN_WINDOW_ID) {
        const windows = await getAllWindows();
        await Promise.all(windows.filter((item) => item.label !== MAIN_WINDOW_ID).map((item) => item.destroy()));
      } else {
        const next = closeDetachedWindow(workspaceRef.current, currentWindowId);
        workspaceRef.current = next;
        await emitTo(MAIN_WINDOW_ID, "workspace-proposal", next).catch(() => undefined);
      }
      await current.destroy();
    }).then((unlisten) => cleanups.push(unlisten));
    const saveGeometry = () => {
      if (currentWindowId === MAIN_WINDOW_ID) return;
      window.clearTimeout(geometryTimer);
      window.clearTimeout(dockTimer);
      geometryTimer = window.setTimeout(async () => {
        const [position, size, scale] = await Promise.all([current.outerPosition(), current.outerSize(), current.scaleFactor()]);
        commitWorkspace((workspace) => ({ ...workspace, windows: workspace.windows.map((item) => item.id === currentWindowId ? { ...item, x: Math.round(position.x / scale), y: Math.round(position.y / scale), width: Math.round(size.width / scale), height: Math.round(size.height / scale) } : item) }));
      }, 250);
      dockTimer = window.setTimeout(async () => {
        const point = await cursorPosition();
        const bounds = [...stripBoundsRef.current.values()].find((item) => item.windowId !== currentWindowId && point.x >= item.left && point.x <= item.right && point.y >= item.top && point.y <= item.bottom);
        const source = workspaceRef.current.windows.find((item) => item.id === currentWindowId);
        const target = bounds && workspaceRef.current.windows.find((item) => item.id === bounds.windowId);
        if (!bounds || !source || !target) return;
        const insertion = tabInsertionIndex(point.x, bounds.left, bounds.right, target.tabIds.length);
        const movingIds = [...source.tabIds];
        commitWorkspace((workspace) => movingIds.reduce((next, tabId, offset) => moveTab(next, tabId, target.id, insertion + offset), workspace));
        closing = true;
        await current.destroy();
      }, 450);
    };
    current.onMoved(saveGeometry).then((unlisten) => cleanups.push(unlisten));
    current.onResized(saveGeometry).then((unlisten) => cleanups.push(unlisten));
    return () => { window.clearTimeout(geometryTimer); window.clearTimeout(dockTimer); cleanups.forEach((cleanup) => cleanup()); };
  }, []);

  async function confirmEnvironment() {
    if (!envConfirm) return;
    setBusy(true);
    try {
      await api.setEnvironment(envConfirm);
      updateWorkspace({ environment: envConfirm });
      setAuthenticated(api.isNative ? authenticated : false);
      setOrders([]); setPositions([]);
      setEnvConfirm(null);
      setAccounts(await api.accounts().catch(() => []));
      showToast(`Switched to ${envConfirm.toUpperCase()}`);
    } finally { setBusy(false); }
  }

  async function toggleFullscreen() {
    try {
      if (api.isNative) {
        const current = getCurrentWindow();
        const fullscreen = !(await current.isFullscreen());
        await current.setFullscreen(fullscreen);
        setIsFullscreen(fullscreen);
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      showToast(`Could not change fullscreen mode: ${String(error)}`);
    }
  }

  async function saveTradeStationCredentials() {
    if (!clientId.trim() || !secret.trim()) return showToast("Client ID and secret are required.");
    setBusy(true);
    try {
      await api.saveCredentials(clientId.trim(), secret);
      setCredentialsConfigured(true);
      setSecret("");
      showToast("TradeStation credentials saved.");
    } catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  async function connect() {
    if (!credentialsConfigured) return showToast("Save TradeStation credentials before connecting.");
    setBusy(true);
    try {
      await api.beginLogin();
      setSetupOpen(false);
      setSettingsOpen(false);
      showToast("Complete authorization in your browser.");
    } catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  function eligibilityForEntry(sourceTabId: string, expectedChartSymbol: string, expectedTradeSymbol: string): Record<EntryRuleSide, EntryRuleResult> {
    const tab = workspace.tabs.find((item) => item.id === sourceTabId);
    if (!tab || tab.symbol.symbol !== expectedChartSymbol) {
      const result = blockedEntryResult("The originating chart is no longer available for rule evaluation.");
      return { long: result, short: result };
    }
    if (resolveTradeSymbol(tab) !== expectedTradeSymbol) {
      const result = blockedEntryResult("The trade contract changed. Close this review and submit a fresh order.");
      return { long: result, short: result };
    }
    const sourceBars = tabMarkets[sourceTabId]?.bars ?? [];
    const sourceQuote = quotes[tab.symbol.symbol] ?? (api.isNative
      ? { symbol: tab.symbol.symbol, last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" }
      : quoteFor(tab.symbol.symbol));
    return evaluateEntryRules(workspace.entryRules, sourceBars, sourceQuote);
  }

  async function openReview(draft: OrderDraft, sourceTabId: string, chartSymbol: string) {
    if (!api.isNative) return showToast("Browser demo mode cannot place orders. Run the Tauri app to connect.");
    setBusy(true);
    try { setReview({ kind: "entry", sourceTabId, chartSymbol, draft, preview: await api.confirmOrder(draft) }); }
    catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  function clearSubmittedEntry(symbol: string) {
    setOrderProjection((current) => current?.tradeSymbol === symbol
      ? { tradeSymbol: symbol, takeProfit: undefined, stopLoss: undefined }
      : current);
    setOrderTicketResetEpochs((current) => ({ ...current, [symbol]: (current[symbol] ?? 0) + 1 }));
  }

  async function submitOrder(draft: OrderDraft, sourceTabId: string, chartSymbol: string) {
    const side = draft.side === "Buy" ? "long" : "short";
    const eligibility = eligibilityForEntry(sourceTabId, chartSymbol, draft.symbol)[side];
    if (!eligibility.allowed) return showToast(`${draft.side} entry blocked: ${eligibility.reason}`);
    if (workspace.confirmOrders) return openReview(draft, sourceTabId, chartSymbol);
    if (!api.isNative) return showToast("Browser demo mode cannot place orders. Run the Tauri app to connect.");
    setBusy(true);
    try {
      const update = await api.placeOrder(draft);
      setOrders((current) => [update, ...current]);
      brokerageRefreshRef.current(true);
      if (["Working", "Filled", "Pending"].includes(update.status)) clearSubmittedEntry(draft.symbol);
      showToast(`Order ${update.status.toLowerCase()}: ${update.id}`);
    } catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  async function requestClosePosition(position: Position) {
    if (!selectedAccount) return showToast("Select an account before closing a position.");
    if (!api.isNative) return showToast("Position closing is disabled in browser demo mode.");
    if (!workspace.confirmOrders) return executeClosePosition(position.id);
    setBusy(true);
    try {
      const draft = flattenOrderDraft(selectedAccount.id, position);
      setReview({ kind: "close-position", positionId: position.id, draft, preview: await api.confirmOrder(draft) });
    } catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  async function executeClosePosition(positionId: string) {
    if (!selectedAccount || closingPositionIds.has(positionId)) return;
    setClosingPositionIds((current) => new Set(current).add(positionId));
    try {
      const result = await api.closePosition(selectedAccount.id, positionId);
      brokerageRefreshRef.current(true);
      if (result.error) {
        setNotifications((current) => [{ id: crypto.randomUUID(), time: new Date().toISOString(), symbol: result.symbol, title: "Position close aborted", text: result.error!, level: "error" as const }, ...current].slice(0, 250));
        showToast(result.error);
        return;
      }
      if (result.flattenOrder) setOrders((current) => [result.flattenOrder!, ...current]);
      setNotifications((current) => [{
        id: crypto.randomUUID(), time: new Date().toISOString(), symbol: result.symbol,
        title: result.flattenOrder ? "Position close sent" : "Position already closed",
        text: result.flattenOrder
          ? `${result.flattenOrder.side} ${result.flattenOrder.quantity} ${result.symbol} at market after cancelling ${result.cancelledOrderIds.length} exit order${result.cancelledOrderIds.length === 1 ? "" : "s"}.`
          : `${result.symbol} closed before another flatten order was needed.`,
        level: "warning" as const,
      }, ...current].slice(0, 250));
      showToast(result.flattenOrder ? `Close order sent for ${result.symbol}.` : `${result.symbol} is already closed.`);
    } catch (error) { showToast(String(error)); }
    finally {
      setClosingPositionIds((current) => { const next = new Set(current); next.delete(positionId); return next; });
    }
  }

  async function replaceChartOrder(order: OrderUpdate, newPrice: number) {
    if (!selectedAccount || replacingOrderIds.has(order.id)) return;
    const original = order.price ?? order.stopPrice;
    setReplacingOrderIds((current) => new Set(current).add(order.id));
    setOrders((current) => current.map((item) => item.id === order.id ? withOrderPrice(item, newPrice) : item));
    try {
      const updated = await api.replaceOrder(selectedAccount.id, order.id, newPrice);
      setOrders((current) => current.map((item) => item.id === order.id ? { ...item, ...updated } : item));
      brokerageRefreshRef.current(true);
      showToast(`${order.type === "Limit" ? "Take profit" : "Stop loss"} moved to ${formatPrice(newPrice)}.`);
    } catch (error) {
      setOrders((current) => current.map((item) => item.id === order.id ? withOrderPrice(item, original) : item));
      showToast(String(error));
    } finally {
      setReplacingOrderIds((current) => { const next = new Set(current); next.delete(order.id); return next; });
    }
  }

  async function cancelWorkingOrder(id: string) {
    try {
      await api.cancelOrder(id);
      setOrders((current) => current.map((order) => order.id === id ? { ...order, status: "Cancelled", closedAt: new Date().toISOString() } : order));
      brokerageRefreshRef.current(true);
      setNotifications((current) => [{ id: crypto.randomUUID(), time: new Date().toISOString(), title: "Order cancellation sent", text: `Cancellation requested for order ${id}`, level: "warning" }, ...current]);
    } catch (error) { showToast(String(error)); }
  }

  async function submitReviewed() {
    if (!review) return;
    if (review.kind === "close-position") {
      const positionId = review.positionId;
      setReview(null);
      return executeClosePosition(positionId);
    }
    const side = review.draft.side === "Buy" ? "long" : "short";
    const eligibility = eligibilityForEntry(review.sourceTabId, review.chartSymbol, review.draft.symbol)[side];
    if (!eligibility.allowed) return showToast(`${review.draft.side} entry blocked: ${eligibility.reason}`);
    setBusy(true);
    try {
      const update = await api.placeOrder(review.draft);
      setOrders((current) => [update, ...current]);
      brokerageRefreshRef.current(true);
      if (["Working", "Filled", "Pending"].includes(update.status)) clearSubmittedEntry(review.draft.symbol);
      setReview(null);
      showToast(`Order ${update.status.toLowerCase()}: ${update.id}`);
    } catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  const connectionLabel = api.isNative ? (authenticated ? market.streamState.toUpperCase() : "NOT CONNECTED") : "DEMO FEED";
  const marketTime = newYorkClock.format(new Date(currentTime));
  const reviewEntryEligibility = review?.kind === "entry"
    ? eligibilityForEntry(review.sourceTabId, review.chartSymbol, review.draft.symbol)[review.draft.side === "Buy" ? "long" : "short"]
    : null;
  const activeRoot = activeTab.symbol.root;
  const activeContracts = activeRoot ? contractChoices[activeRoot] ?? [] : [];
  const tradeContractStatus = !activeContinuous ? undefined
    : !activeTradeSymbol ? "Auto unavailable: TradeStation did not return an underlying contract."
    : tradeDetailErrors[activeTradeSymbol] ? `Contract details unavailable for ${activeTradeSymbol}.`
    : !activeTradeMeta ? `Loading contract details for ${activeTradeSymbol}…`
    : undefined;

  const activeOrderProjection = !isDetached && workspace.rightPanelOpen && workspace.rightTab === "order"
    && orderProjection && orderProjection.tradeSymbol === activeTradeSymbol ? orderProjection : undefined;
  const activeOrderTicketResetEpoch = activeTradeSymbol ? orderTicketResetEpochs[activeTradeSymbol] ?? 0 : 0;

  return <main className={`app-shell ${isDetached ? "detached-shell" : ""}`}>
    <header className="titlebar">
      <div className="brand"><div className="brand-glyph"><TrendingUp size={16} strokeWidth={2.4} /></div><span>NORTHSTAR</span><small>TRADER</small></div>
      {hasWindowTabs && <div className="instrument-summary"><strong>{activeTab.symbol.symbol}</strong><span>{activeQuote.last.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span><span className={activeChangePct >= 0 ? "positive" : "negative"}>{activeChangePct >= 0 ? "+" : ""}{activeChangePct.toFixed(2)}%</span></div>}
      <div className="titlebar-drag" data-tauri-drag-region />
      {!isDetached && <div className="market-clock" aria-label={`New York market time ${marketTime}`} title="New York market time"><span>NY</span><time>{marketTime}</time></div>}
      {!isDetached && <button className={`environment-badge ${environment}`} onClick={() => setEnvConfirm(environment === "sim" ? "live" : "sim")}><span />{environment.toUpperCase()}<ChevronDown size={13} /></button>}
      <button className="connection-chip" onClick={() => setSetupOpen(true)}><Wifi size={13} /><span>{connectionLabel}</span></button>
    </header>

    <ChartTabStrip tabs={windowState.tabIds.map((id) => workspace.tabs.find((tab) => tab.id === id)).filter((tab): tab is ChartTabState => Boolean(tab))} activeTabId={windowState.activeTabId} totalTabs={workspace.tabs.length} windowId={currentWindowId} onSelect={selectTab} onAdd={addTab} onClose={closeTab} onReorder={reorderTab} onDragEnd={finishTabDrag} onBounds={(bounds) => { stripBoundsRef.current.set(currentWindowId, bounds); emit("chart-strip-bounds", bounds); }} />

    <nav className={`toolbar ${hasWindowTabs ? "" : "empty"}`} aria-label="Chart toolbar">
      <button className="symbol-control" onClick={() => setSearchOpen(true)}><Search size={16} /><strong>{activeTab.symbol.symbol}</strong><span>{activeTab.symbol.exchange}</span><ChevronDown size={14} /></button>
      <div className="divider" />
      <div className="timeframe-group">{timeframes.map((tf) => <button key={tf} className={activeTab.timeframe === tf ? "active" : ""} onClick={() => updateActiveTab({ timeframe: tf })}>{tf}</button>)}</div>
      <div className="divider" />
      <div className="chart-kinds">
        <IconButton label="Candlestick chart" active={activeTab.chartKind === "candles"} onClick={() => updateActiveTab({ chartKind: "candles" })}><BarChart3 size={17} /></IconButton>
        <IconButton label="Line chart" active={activeTab.chartKind === "line"} onClick={() => updateActiveTab({ chartKind: "line" })}><LineChart size={17} /></IconButton>
        <IconButton label="Area chart" active={activeTab.chartKind === "area"} onClick={() => updateActiveTab({ chartKind: "area" })}><Activity size={17} /></IconButton>
      </div>
      <div className="toolbar-popover-anchor">
        <button className={`text-tool-button ${indicatorOpen ? "active" : ""}`} onClick={() => { setAlertOpen(false); setIndicatorOpen((value) => !value); }}><SlidersHorizontal size={16} />Indicators</button>
        {indicatorOpen && <div className="popover indicator-popover"><header><strong>Indicators</strong><span>{activeTab.indicators.filter((i) => i.visible).length} active</span></header>{activeTab.indicators.map((indicator) => <div key={indicator.id} className="indicator-row"><label className="indicator-color" title={`Change ${indicator.kind === "VWAP" ? "NY Session VWAP" : `${indicator.kind} ${indicator.period}`} color`}><input type="color" value={indicator.color} aria-label={`Change ${indicator.kind === "VWAP" ? "NY Session VWAP" : `${indicator.kind} ${indicator.period}`} color`} onChange={(event) => updateIndicator(indicator.id, { color: event.target.value })} /><span className="indicator-swatch" style={{ background: indicator.color }} /></label><button className="indicator-toggle-button" aria-pressed={indicator.visible} onClick={() => updateIndicator(indicator.id, { visible: !indicator.visible })}><span><strong>{indicator.kind === "VWAP" ? "NY Session VWAP" : indicator.kind}</strong><small>{indicator.kind === "VWAP" ? isIntradayTimeframe(activeTab.timeframe) ? "9:30 AM–4:00 PM ET" : "Intraday only" : `Length ${indicator.period}`}</small></span><span className={`toggle ${indicator.visible ? "on" : ""}`} /></button></div>)}</div>}
      </div>
      {!isDetached && <div className="toolbar-popover-anchor">
        <button className={`text-tool-button alert-tool-button ${alertOpen || activeAlertCount > 0 ? "active" : ""}`} aria-pressed={activeAlertCount > 0} title={`${activeAlertCount} EMA 200 alert timeframe${activeAlertCount === 1 ? "" : "s"} active`} onClick={() => { prepareAlertAudio(); setIndicatorOpen(false); setAlertOpen((value) => !value); }}><Bell size={16} fill={activeAlertCount > 0 ? "currentColor" : "none"} /><span className="tool-label">Alert</span></button>
        {alertOpen && <div className="popover alert-popover"><header><strong>EMA 200 Alerts</strong><span>{activeAlertCount} active</span></header><div className="alert-list">{ALERT_TIMEFRAMES.map((timeframe) => {
          const config = activeTab.ema200Alert[timeframe];
          return <section key={timeframe} className={`alert-row ${config.enabled ? "enabled" : ""}`}>
            <button className="alert-toggle-button" aria-pressed={config.enabled} onClick={() => { prepareAlertAudio(); updateTimeframeAlert(timeframe, { enabled: !config.enabled }); }}><span><strong>{timeframe}</strong><small>Price crosses EMA 200</small></span><span className={`toggle ${config.enabled ? "on" : ""}`} /></button>
            <div className="alert-row-controls">
              <label><span>Sound</span><select aria-label={`${timeframe} alert sound`} value={config.sound} onChange={(event) => updateTimeframeAlert(timeframe, { sound: event.target.value as AlertSound })}>{ALERT_SOUNDS.map((sound) => <option key={sound.value} value={sound.value}>{sound.label}</option>)}</select></label>
              <label><span>Duration</span><select aria-label={`${timeframe} alert duration`} value={config.durationSeconds} onChange={(event) => updateTimeframeAlert(timeframe, { durationSeconds: Number(event.target.value) as AlertDurationSeconds })}>{ALERT_DURATIONS.map((duration) => <option key={duration} value={duration}>{duration}s</option>)}</select></label>
              <button className="alert-preview-button" onClick={() => playAlertSound(config.sound, config.durationSeconds)}>Preview</button>
            </div>
          </section>;
        })}</div></div>}
      </div>}
      <div className="divider" />
      <span className="toolbar-spacer" />
      {!isDetached && <><IconButton label="Toggle bottom panel" active={workspace.bottomPanelOpen} onClick={() => updateWorkspace({ bottomPanelOpen: !workspace.bottomPanelOpen })}><PanelBottom size={17} /></IconButton><IconButton label="Toggle right panel" active={workspace.rightPanelOpen} onClick={() => updateWorkspace({ rightPanelOpen: !workspace.rightPanelOpen })}><PanelRight size={17} /></IconButton><IconButton label="Entry rules" active={entryRulesOpen || hasConfiguredEntryRules(workspace.entryRules)} onClick={() => setEntryRulesOpen(true)}><ListChecks size={17} /></IconButton><IconButton label="Settings" active={settingsOpen} onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></IconButton></>}
      <IconButton label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} active={isFullscreen} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton>
    </nav>

    <section className={`workspace ${hasWindowTabs ? "" : "empty-chart-workspace"} ${!isDetached && workspace.rightPanelOpen ? "with-right" : ""} ${!isDetached && workspace.bottomPanelOpen ? "with-bottom" : ""}`} style={{ "--bottom-height": `${workspace.bottomPanelHeight ?? 360}px` } as React.CSSProperties}>
      <aside className="drawing-rail" aria-label="Drawing tools" onKeyDown={(event) => { if (event.key === "Escape") setHorizontalToolsOpen(false); }}>
        <IconButton label="Cursor" active={activeTool === "cursor"} onClick={() => setActiveTool("cursor")}><MousePointer2 size={18} /></IconButton>
        <IconButton label="Magnet: snap crosshair to candle high or low" active={activeTab.magnetEnabled} onClick={() => updateActiveTab({ magnetEnabled: !activeTab.magnetEnabled })}><Magnet size={18} /></IconButton>
        <div className="drawing-tool-anchor">
          <IconButton label="Horizontal drawing tools" active={activeTool === "horizontal" || activeTool === "horizontal-ray"} onClick={() => setHorizontalToolsOpen((value) => !value)}><Minus size={18} /></IconButton>
          {horizontalToolsOpen && <><button className="drawing-flyout-backdrop" aria-label="Close horizontal drawing selector" onClick={() => setHorizontalToolsOpen(false)} /><div className="drawing-flyout" role="menu" aria-label="Horizontal drawing selector">
            <button role="menuitem" onClick={() => { setActiveTool("horizontal"); setHorizontalToolsOpen(false); }}><Minus size={17} /><span><strong>Horizontal Line</strong><small>Extends both directions</small></span></button>
            <button role="menuitem" onClick={() => { setActiveTool("horizontal-ray"); setHorizontalToolsOpen(false); }}><Minus size={17} /><span><strong>Horizontal Ray</strong><small>Extends to the right</small></span></button>
          </div></>}
        </div>
      </aside>

      <TradingChart key={activeTab.id} bars={bars} vwapBars={vwapMarkets[activeTab.symbol.symbol]?.bars ?? []} kind={activeTab.chartKind} magnetEnabled={activeTab.magnetEnabled} symbol={activeTab.symbol.symbol} tradeSymbol={activeTradeSymbol} description={activeTab.symbol.description} exchange={activeTab.symbol.exchange} minMove={activeTab.symbol.minMove} pointValue={activeTradeMeta?.pointValue ?? activeTab.symbol.pointValue} currentPrice={activeTradeQuote.last} chartLabelSettings={workspace.settings.chartLabels} timeframe={activeTab.timeframe} indicators={activeTab.indicators} orders={orders} positions={positions} orderProjection={activeOrderProjection} onOrderProjectionChange={(field, price) => setOrderProjection((current) => current && current.tradeSymbol === activeTradeSymbol ? { ...current, [field]: price } : current)} closingPositionIds={closingPositionIds} replacingOrderIds={replacingOrderIds} onClosePosition={requestClosePosition} onReplaceOrder={replaceChartOrder} timezone={activeTab.chartTimezone} activeTool={activeTool} drawings={workspace.drawings[activeTab.symbol.symbol] ?? []} onToolComplete={() => setActiveTool("cursor")} onCreateDrawing={(drawing) => updateSymbolDrawings(activeTab.symbol.symbol, (items) => [...items, drawing])} onUpdateDrawing={(id, patch) => updateSymbolDrawings(activeTab.symbol.symbol, (items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))} onDeleteDrawing={(id) => updateSymbolDrawings(activeTab.symbol.symbol, (items) => items.filter((item) => item.id !== id))} initialVisibleRange={viewRangesRef.current.get(activeTab.id)} onVisibleRangeChange={requestVisibleVwap} onTimezoneChange={(chartTimezone) => updateActiveTab({ chartTimezone })} onLoadOlder={loadOlder} loadingOlder={market.loadingOlder} />

      {!isDetached && workspace.rightPanelOpen && <aside className="right-panel">
        <div className="panel-tabs"><button className={workspace.rightTab === "order" ? "active" : ""} onClick={() => updateWorkspace({ rightTab: "order" })}>Order</button><button className={workspace.rightTab === "watchlist" ? "active" : ""} onClick={() => updateWorkspace({ rightTab: "watchlist" })}>Watchlist</button></div>
        {workspace.rightTab === "order" ? <OrderTicket chartSymbol={activeTab.symbol} tradeSymbol={activeTradeMeta} quote={activeTradeQuote} contracts={activeContracts} tradeContract={activeTab.tradeContract} contractStatus={tradeContractStatus} contractLookupError={activeRoot ? contractLookupErrors[activeRoot] : undefined} account={selectedAccount} environment={environment} busy={busy} confirmOrders={workspace.confirmOrders} entryEligibility={activeEntryEligibility} rulesConfigured={hasConfiguredEntryRules(workspace.entryRules)} orderProjection={activeOrderProjection} resetEpoch={activeOrderTicketResetEpoch} onTradeContractChange={(tradeContract) => updateActiveTab({ tradeContract })} onConfirmOrdersChange={(confirmOrders) => updateWorkspace({ confirmOrders })} onProjectionChange={(projection) => setOrderProjection({ ...projection, tradeSymbol: activeTradeSymbol })} onSubmit={(draft) => submitOrder(draft, activeTab.id, activeTab.symbol.symbol)} /> : <Watchlist symbols={workspace.watchlist} quotes={quotes} active={activeTab.symbol.symbol} onSelect={(symbol) => { const meta = futures.find((item) => item.symbol === symbol); if (meta) updateActiveTab({ symbol: meta, tradeContract: undefined }); }} />}
      </aside>}

      {!isDetached && workspace.bottomPanelOpen && <BottomPanel workspace={workspace} updateWorkspace={updateWorkspace} accounts={accounts} account={selectedAccount} positions={positions} orders={orders} balances={balances} bodBalances={bodBalances} history={history} setHistory={setHistory} loading={brokerageLoading} error={brokerageError} notifications={notifications} closingPositionIds={closingPositionIds} onClosePosition={requestClosePosition} onNotify={(item) => setNotifications((current) => [item, ...current].slice(0, 250))} onCancel={cancelWorkingOrder} />}
    </section>

    {searchOpen && <Modal title="Select futures contract" onClose={() => setSearchOpen(false)} width={620}><div className="search-box"><Search size={17} /><input autoFocus placeholder="Search symbol or contract name" value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="symbol-results">{searchResults.map((result) => <button key={result.symbol} onClick={() => { updateActiveTab({ symbol: result, tradeContract: undefined }); setSearchOpen(false); setSearch(""); }}><span className="future-icon">F</span><span><strong>{result.symbol}</strong><small>{result.description}</small></span><span className="result-meta">{result.exchange}<small>{result.expiration}</small></span></button>)}{!searchResults.length && <div className="empty-state">No futures contracts matched “{search}”.</div>}</div></Modal>}

    {setupOpen && <Modal title="Connect TradeStation" onClose={() => setSetupOpen(false)}><TradeStationCredentials clientId={clientId} secret={secret} busy={busy} configured={credentialsConfigured} native={api.isNative} onClientIdChange={setClientId} onSecretChange={setSecret} onSave={saveTradeStationCredentials} onConnect={connect} /></Modal>}

    {settingsOpen && <Modal title="Settings" onClose={() => setSettingsOpen(false)} width={540}><div className="settings-content">
      <section className="settings-section" aria-labelledby="chart-label-settings"><header><span>Chart</span><h3 id="chart-label-settings">Position labels</h3><p>Choose which performance values appear beside open positions and protective orders.</p></header><label className="switch-row settings-row"><span><strong>Show dollar amount</strong><small>Full-position profit or loss</small></span><input type="checkbox" checked={workspace.settings.chartLabels.showDollarAmount} onChange={(event) => updateChartLabelSettings({ showDollarAmount: event.target.checked })} /></label><label className="switch-row settings-row"><span><strong>Show R value</strong><small>Profit or loss relative to initial risk</small></span><input type="checkbox" checked={workspace.settings.chartLabels.showRMultiple} onChange={(event) => updateChartLabelSettings({ showRMultiple: event.target.checked })} /></label><label className="settings-font-row"><span><strong>Label font size</strong><small>Adjusts every position and order label</small></span><div><input type="range" min="8" max="16" step="1" value={workspace.settings.chartLabels.fontSize} onChange={(event) => updateChartLabelSettings({ fontSize: Number(event.target.value) })} aria-label="Chart label font size" /><output>{workspace.settings.chartLabels.fontSize}px</output></div></label></section>
      <section className="settings-section settings-api-section" aria-labelledby="tradestation-api-settings"><header><span>Connection</span><h3 id="tradestation-api-settings">TradeStation API</h3><p>Update the API client ID and secret stored in your operating system credential vault.</p></header><TradeStationCredentials clientId={clientId} secret={secret} busy={busy} configured={credentialsConfigured} native={api.isNative} showIntro={false} onClientIdChange={setClientId} onSecretChange={setSecret} onSave={saveTradeStationCredentials} onConnect={connect} /></section>
    </div></Modal>}

    {envConfirm && <Modal title={`Switch to ${envConfirm.toUpperCase()}?`} onClose={() => setEnvConfirm(null)}><div className={`environment-confirm ${envConfirm}`}><Zap size={22} /><div><strong>{envConfirm === "live" ? "Real orders and real money" : "Simulated execution"}</strong><p>{envConfirm === "live" ? "Changing to LIVE clears SIM account data and disables quick-submit for this session." : "SIM uses a separate account environment and simulated fills."}</p></div></div><div className="modal-actions"><button className="secondary-button" onClick={() => setEnvConfirm(null)}>Cancel</button><button className={envConfirm === "live" ? "danger-button" : "primary-button"} disabled={busy} onClick={confirmEnvironment}>Switch to {envConfirm.toUpperCase()}</button></div></Modal>}

    {entryRulesOpen && <Modal title="Entry rules" onClose={() => setEntryRulesOpen(false)} width={860}><EntryRulesBuilder rules={workspace.entryRules} bars={bars} quote={activeQuote} onClose={() => setEntryRulesOpen(false)} onSave={(entryRules) => { updateWorkspace({ entryRules }); setEntryRulesOpen(false); showToast("Entry rules saved."); }} /></Modal>}

    {review && <Modal title={review.kind === "close-position" ? "Close position" : "Review order"} onClose={() => setReview(null)}><div className="review-hero"><span className={review.draft.side === "Buy" ? "buy" : "sell"}>{review.draft.side}</span><strong>{review.draft.quantity} {review.draft.symbol}</strong><small>{review.kind === "close-position" ? "Market close · cancels working exits first" : `${review.draft.type} · ${review.draft.duration}${review.chartSymbol !== review.draft.symbol ? ` · Chart ${review.chartSymbol} · Trading ${review.draft.symbol}` : ""}`}</small></div><dl className="review-list">{review.kind === "entry" && <><div><dt>Take profit</dt><dd>{formatPrice(review.draft.takeProfit)}</dd></div><div><dt>Stop loss</dt><dd>{formatPrice(review.draft.stopLoss)}</dd></div></>}<div><dt>Estimated commission</dt><dd>{review.preview.estimatedCommission ?? "—"}</dd></div><div><dt>Initial margin</dt><dd>{review.preview.initialMargin ?? "—"}</dd></div><div><dt>Environment</dt><dd className={environment === "live" ? "negative" : "cyan"}>{environment.toUpperCase()}</dd></div></dl><p className="preview-summary">{review.kind === "close-position" ? "All working close-side orders for this symbol will be cancelled and confirmed inactive before the market close is submitted." : review.preview.summary}</p>{reviewEntryEligibility && <p className={`entry-review-rule ${reviewEntryEligibility.status}`}>{reviewEntryEligibility.reason}</p>}<button className={review.draft.side === "Buy" ? "buy-button" : "sell-button"} disabled={!review.preview.valid || busy || Boolean(reviewEntryEligibility && !reviewEntryEligibility.allowed)} onClick={submitReviewed}>{review.kind === "close-position" ? "Close position" : `Send ${review.draft.side} order`}</button></Modal>}

    {toast && <div className="toast" role="status">{toast}</div>}
  </main>;
}

function ChartTabStrip({ tabs, activeTabId, totalTabs, windowId, onSelect, onAdd, onClose, onReorder, onDragEnd, onBounds }: {
  tabs: ChartTabState[];
  activeTabId: string;
  totalTabs: number;
  windowId: string;
  onSelect: (tabId: string) => void;
  onAdd: () => void;
  onClose: (tabId: string) => void;
  onReorder: (tabId: string, index: number) => void;
  onDragEnd: (tabId: string) => void;
  onBounds: (bounds: StripBounds) => void;
}) {
  const stripRef = useRef<HTMLElement>(null);
  const draggedRef = useRef<string | undefined>(undefined);
  const droppedRef = useRef(false);
  const [dropIndex, setDropIndex] = useState<number>();

  useEffect(() => {
    let active = true;
    const publish = async () => {
      if (!stripRef.current || !active) return;
      const rect = stripRef.current.getBoundingClientRect();
      if (!api.isNative) return onBounds({ windowId, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      const current = getCurrentWindow();
      const [position, scale] = await Promise.all([current.innerPosition(), current.scaleFactor()]);
      onBounds({ windowId, left: position.x + rect.left * scale, top: position.y + rect.top * scale, right: position.x + rect.right * scale, bottom: position.y + rect.bottom * scale });
    };
    publish();
    const observer = new ResizeObserver(publish);
    if (stripRef.current) observer.observe(stripRef.current);
    const timer = window.setInterval(publish, 750);
    return () => { active = false; observer.disconnect(); clearInterval(timer); };
  }, [windowId, tabs.length]);

  return <nav ref={stripRef} className="chart-tabs" role="tablist" aria-label="Chart tabs" onDragOver={(event) => {
    if (!draggedRef.current) return;
    event.preventDefault();
    const elements = [...event.currentTarget.querySelectorAll<HTMLElement>(".chart-tab")];
    const index = elements.findIndex((element) => event.clientX < element.getBoundingClientRect().left + element.offsetWidth / 2);
    setDropIndex(index < 0 ? elements.length : index);
  }} onDrop={(event) => {
    event.preventDefault();
    if (draggedRef.current) onReorder(draggedRef.current, dropIndex ?? tabs.length);
    droppedRef.current = true;
    setDropIndex(undefined);
  }}>
    <div className="chart-tab-scroll">
      {tabs.map((tab, index) => <div key={tab.id} className={`chart-tab ${tab.id === activeTabId ? "active" : ""} ${dropIndex === index ? "drop-before" : ""}`} role="tab" aria-selected={tab.id === activeTabId} draggable onDragStart={(event) => {
        draggedRef.current = tab.id;
        droppedRef.current = false;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", tab.id);
      }} onDragEnd={() => {
        if (!droppedRef.current) onDragEnd(tab.id);
        draggedRef.current = undefined;
        droppedRef.current = false;
        setDropIndex(undefined);
      }}>
        <button className="chart-tab-label" tabIndex={tab.id === activeTabId ? 0 : -1} onClick={() => onSelect(tab.id)} onKeyDown={(event) => {
          const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!direction) return;
          event.preventDefault();
          onSelect(tabs[(index + direction + tabs.length) % tabs.length].id);
        }}><strong>{tab.symbol.symbol}</strong><span>·</span><span>{tab.timeframe}</span></button>
        <button className="chart-tab-close" aria-label={`Close ${tab.symbol.symbol} ${tab.timeframe} chart`} disabled={totalTabs === 1} onClick={() => onClose(tab.id)}><X size={12} /></button>
      </div>)}
      {dropIndex === tabs.length && <span className="tab-drop-end" />}
    </div>
    <button className="chart-tab-add" aria-label="Add chart tab" title={totalTabs >= MAX_CHART_TABS ? `Maximum ${MAX_CHART_TABS} tabs` : "Add chart tab"} disabled={totalTabs >= MAX_CHART_TABS} onClick={onAdd}><Plus size={15} /></button>
  </nav>;
}

function Watchlist({ symbols, quotes, active, onSelect }: { symbols: string[]; quotes: Record<string, Quote>; active: string; onSelect: (symbol: string) => void }) {
  return <div className="watchlist"><header><span>Symbol</span><span>Last</span><span>Chg%</span></header>{symbols.map((symbol) => { const quote = quotes[symbol] ?? quoteFor(symbol); return <button key={symbol} className={active === symbol ? "active" : ""} onClick={() => onSelect(symbol)}><span><strong>{symbol}</strong><small>{futures.find((f) => f.symbol === symbol)?.exchange}</small></span><b>{quote.last.toLocaleString(undefined, { minimumFractionDigits: 2 })}</b><em className={quote.changePct >= 0 ? "positive" : "negative"}>{quote.changePct >= 0 ? "+" : ""}{quote.changePct.toFixed(2)}%</em></button>; })}</div>;
}

function OrderTicket({ chartSymbol, tradeSymbol, quote, contracts, tradeContract, contractStatus, contractLookupError, account, environment, busy, confirmOrders, entryEligibility, rulesConfigured, orderProjection, resetEpoch, onTradeContractChange, onConfirmOrdersChange, onProjectionChange, onSubmit }: { chartSymbol: SymbolMeta; tradeSymbol?: SymbolMeta; quote: Quote; contracts: SymbolMeta[]; tradeContract?: string; contractStatus?: string; contractLookupError?: string; account?: Account; environment: TradingEnvironment; busy: boolean; confirmOrders: boolean; entryEligibility: Record<EntryRuleSide, EntryRuleResult>; rulesConfigured: boolean; orderProjection?: OrderProjection; resetEpoch: number; onTradeContractChange: (symbol?: string) => void; onConfirmOrdersChange: (enabled: boolean) => void; onProjectionChange: (projection: OrderProjection) => void; onSubmit: (draft: OrderDraft) => void }) {
  const symbol = tradeSymbol ?? chartSymbol;
  const continuous = isContinuousFuture(chartSymbol);
  const [side, setSide] = useState<"Buy" | "Sell">("Buy");
  const [quantity, setQuantity] = useState(1);
  const [duration, setDuration] = useState<"DAY" | "GTC">("DAY");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const ticketSymbolRef = useRef(symbol.symbol);
  const handledResetRef = useRef(`${symbol.symbol}:${resetEpoch}`);

  const projectionPrice = (value: string) => {
    if (!value.trim()) return undefined;
    const price = Number(value);
    return Number.isFinite(price) && price > 0 ? price : undefined;
  };
  const publishProjection = (nextTakeProfit: string, nextStopLoss: string, nextSide = side, nextQuantity = quantity) => onProjectionChange({
    takeProfit: projectionPrice(nextTakeProfit),
    stopLoss: projectionPrice(nextStopLoss),
    side: nextSide,
    quantity: nextQuantity,
  });

  useEffect(() => {
    if (ticketSymbolRef.current === symbol.symbol) return;
    ticketSymbolRef.current = symbol.symbol;
    setTakeProfit("");
    setStopLoss("");
    onProjectionChange({});
  }, [symbol.symbol]);

  useEffect(() => {
    const resetKey = `${symbol.symbol}:${resetEpoch}`;
    if (handledResetRef.current === resetKey) return;
    handledResetRef.current = resetKey;
    if (resetEpoch <= 0) return;
    setTakeProfit("");
    setStopLoss("");
    onProjectionChange({});
  }, [symbol.symbol, side, resetEpoch]);

  useEffect(() => {
    if (orderProjection?.takeProfit != null && orderProjection.takeProfit !== projectionPrice(takeProfit)) {
      setTakeProfit(String(orderProjection.takeProfit));
    }
    if (orderProjection?.stopLoss != null && orderProjection.stopLoss !== projectionPrice(stopLoss)) {
      setStopLoss(String(orderProjection.stopLoss));
    }
  }, [orderProjection?.takeProfit, orderProjection?.stopLoss]);

  const takeProfitPrice = Number(takeProfit);
  const stopLossPrice = Number(stopLoss);
  const entryPrice = side === "Buy" ? quote.ask : quote.bid;
  const takeProfitValid = takeProfit.trim() !== "" && takeProfitPrice > 0 && validateTick(takeProfitPrice, symbol.minMove)
    && (side === "Buy" ? takeProfitPrice > entryPrice : takeProfitPrice < entryPrice);
  const stopLossValid = stopLoss.trim() !== "" && stopLossPrice > 0 && validateTick(stopLossPrice, symbol.minMove)
    && (side === "Buy" ? stopLossPrice < entryPrice : stopLossPrice > entryPrice);

  function draft(): OrderDraft {
    return { accountId: account?.id ?? "", symbol: tradeSymbol?.symbol ?? "", side, type: "Market", quantity, duration, takeProfit: takeProfitPrice, stopLoss: stopLossPrice };
  }

  const marketUnavailable = !tradeSymbol || quote.last <= 0 || quote.halted || quote.delayed || !quote.receivedAt || Date.now() - quote.receivedAt > 5_000;
  const tickValue = symbol.minMove * symbol.pointValue;
  const estimatedRisk = stopLossValid ? estimateOrderRisk(entryPrice, stopLossPrice, side, quantity, symbol.minMove, tickValue) : null;
  const selectedEligibility = entryEligibility[side === "Buy" ? "long" : "short"];
  const orderDisabled = busy || !account || Boolean(contractStatus) || marketUnavailable || !takeProfitValid || !stopLossValid || estimatedRisk == null || !selectedEligibility.allowed;
  const orderLabel = contractStatus ?? (marketUnavailable ? "Contract market data unavailable"
    : !selectedEligibility.allowed ? `${side === "Buy" ? "Long" : "Short"} entry blocked`
    : `${confirmOrders ? "Review" : "Place"} ${side} market order`);
  const manualMissing = tradeContract && !contracts.some((contract) => contract.symbol === tradeContract);
  return <div className="order-ticket">
    <div className="account-line"><span>{account?.displayId ?? "No account"}</span><span className={environment}>{environment.toUpperCase()}</span></div>
    {continuous && <label className="trade-contract-field"><span><strong>Trade contract</strong><small>Chart {chartSymbol.symbol}</small></span><select aria-label="Trade contract" value={tradeContract ?? "__auto__"} onChange={(event) => onTradeContractChange(event.target.value === "__auto__" ? undefined : event.target.value)}><option value="__auto__">Auto · {chartSymbol.underlying ?? "Unavailable"}</option>{manualMissing && <option value={tradeContract}>{tradeContract} · Saved selection</option>}{contracts.map((contract) => <option key={contract.symbol} value={contract.symbol}>{contract.symbol} · {formatContractExpiration(contract.expiration)}</option>)}</select>{contractStatus && <small className="negative">{contractStatus}</small>}{!contractStatus && contractLookupError && <small className="negative">Contract list unavailable; the current selection is unchanged.</small>}</label>}
    <div className="market-buttons"><button className={side === "Sell" ? "selected" : ""} onClick={() => { setSide("Sell"); publishProjection(takeProfit, stopLoss, "Sell"); }}><small>SELL</small><strong>{quote.bid.toFixed(2)}</strong></button><div><span>{(quote.ask - quote.bid).toFixed(2)}</span></div><button className={side === "Buy" ? "selected" : ""} onClick={() => { setSide("Buy"); publishProjection(takeProfit, stopLoss, "Buy"); }}><small>BUY</small><strong>{quote.ask.toFixed(2)}</strong></button></div>
    <label className="field compact"><span>Contracts</span><div className="stepper"><button onClick={() => { const next = Math.max(1, quantity - 1); setQuantity(next); publishProjection(takeProfit, stopLoss, side, next); }}><Minus size={14} /></button><input type="number" min="1" value={quantity} onChange={(event) => { const next = Math.max(1, Number(event.target.value)); setQuantity(next); publishProjection(takeProfit, stopLoss, side, next); }} /><button onClick={() => { const next = quantity + 1; setQuantity(next); publishProjection(takeProfit, stopLoss, side, next); }}><Plus size={14} /></button></div></label>
    <div className="section-label"><span>Exits</span><small>Server-side bracket</small></div>
    <label className="field compact"><span>Take profit price</span><input className={takeProfitValid ? "" : "invalid"} type="number" min={symbol.minMove} step={symbol.minMove} value={takeProfit} onChange={(event) => { const value = event.target.value; setTakeProfit(value); publishProjection(value, stopLoss); }} /></label>
    <label className="field compact"><span>Stop loss price</span><input className={stopLossValid ? "" : "invalid"} type="number" min={symbol.minMove} step={symbol.minMove} value={stopLoss} onChange={(event) => { const value = event.target.value; setStopLoss(value); publishProjection(takeProfit, value); }} /></label>
    <div className="section-label"><span>Time in force</span></div>
    <select value={duration} onChange={(e) => setDuration(e.target.value as "DAY" | "GTC")}><option value="DAY">DAY</option><option value="GTC">GTC</option></select>
    <dl className="ticket-info"><div><dt>Tick value</dt><dd>{tickValue.toFixed(2)} USD</dd></div><div><dt>Data</dt><dd className={quote.delayed ? "negative" : "positive"}>{quote.delayed ? "Delayed" : "Real-time"}</dd></div><div><dt>Estimated risk</dt><dd className={estimatedRisk == null ? "" : "negative"}>{estimatedRisk == null ? "—" : `${estimatedRisk.toFixed(2)} USD`}</dd></div></dl>
    {rulesConfigured && <div className={`ticket-rule-status ${selectedEligibility.status}`}><span /> <strong>{side === "Buy" ? "Long" : "Short"} entry</strong><small>{selectedEligibility.reason}</small></div>}
    <label className="confirm-orders-toggle"><input type="checkbox" checked={confirmOrders} onChange={(event) => onConfirmOrdersChange(event.target.checked)} /><span><strong>Confirm orders</strong><small>Review buy, sell, and close actions</small></span></label>
    <button className={side === "Buy" ? "buy-button" : "sell-button"} disabled={orderDisabled} onClick={() => onSubmit(draft())}>{orderLabel}</button>
  </div>;
}

function BottomPanel({ workspace, updateWorkspace, accounts, account, positions, orders, balances, bodBalances, history, setHistory, loading, error, notifications, closingPositionIds, onClosePosition, onNotify, onCancel }: {
  workspace: WorkspaceState; updateWorkspace: (patch: Partial<WorkspaceState>) => void; accounts: Account[]; account?: Account; positions: Position[]; orders: OrderUpdate[]; balances: AccountBalance[]; bodBalances: AccountBalance[]; history: HistoricalOrderPage; setHistory: React.Dispatch<React.SetStateAction<HistoricalOrderPage>>; loading: boolean; error?: string; notifications: ActivityNotification[]; closingPositionIds: Set<string>; onClosePosition: (position: Position) => void; onNotify: (item: ActivityNotification) => void; onCancel: (id: string) => void;
}) {
  const tabs: Array<[WorkspaceState["bottomTab"], string]> = [["positions", "Positions"], ["orders", "Orders"], ["history", "Order history"], ["summary", "Account summary"], ["notifications", "Notifications log"]];
  const [orderFilter, setOrderFilter] = useState("All");
  const today = new Date().toISOString().slice(0, 10);
  const [since, setSince] = useState(today);
  const [until, setUntil] = useState(today);
  const [historyFilter, setHistoryFilter] = useState("All");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault(); const startY = event.clientY; const startHeight = workspace.bottomPanelHeight ?? 360;
    const move = (next: PointerEvent) => updateWorkspace({ bottomPanelHeight: Math.max(220, Math.min(window.innerHeight - 150, startHeight + startY - next.clientY)) });
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  };
  const loadHistory = async (append = false) => {
    if (!account) return; setHistoryLoading(true);
    try {
      const localDay = (value: string) => {
        const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000;
        return new Date(date.getTime() - offset).toISOString().slice(0, 10);
      };
      const currentRows = orders.filter((order) => { const day = localDay(order.timestamp); return day >= since && day <= until; });
      if (since >= today) {
        setHistory({ orders: currentRows.sort((a, b) => b.timestamp.localeCompare(a.timestamp)) });
        return;
      }
      const page = await api.historicalOrders(account.id, since, append ? history.nextToken : undefined);
      const historicalRows = page.orders.filter((order) => { const day = localDay(order.timestamp); return day >= since && day <= until; });
      const combined = append ? [...history.orders, ...historicalRows] : [...historicalRows, ...currentRows];
      const unique = [...new Map(combined.map((order) => [order.id, order])).values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setHistory({ orders: unique, nextToken: page.nextToken });
    } catch (cause) { onNotify({ id: crypto.randomUUID(), time: new Date().toISOString(), title: "History refresh failed", text: String(cause), level: "error" }); }
    finally { setHistoryLoading(false); }
  };
  useEffect(() => { if (workspace.bottomTab === "history" && account) loadHistory(); }, [workspace.bottomTab, account?.id, since, until, orders]);
  const statusMatches = (status: string, filter: string) => filter === "All" || status.toLowerCase() === filter.toLowerCase() || filter === "Inactive" && ["Pending", "Indeterminate"].includes(status);
  const visibleOrders = orders.filter((order) => statusMatches(order.status, orderFilter));
  const visibleHistory = history.orders.filter((order) => statusMatches(order.status, historyFilter));
  const money = (value?: number) => value == null ? "—" : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const time = (value?: string) => value ? new Date(value).toLocaleString() : "—";
  const balance = balances[0]; const bod = bodBalances[0];
  const exportRows = () => {
    let rows: Array<Record<string, unknown>> = [];
    if (workspace.bottomTab === "positions") rows = positions as unknown as Array<Record<string, unknown>>;
    else if (workspace.bottomTab === "orders") rows = visibleOrders as unknown as Array<Record<string, unknown>>;
    else if (workspace.bottomTab === "history") rows = visibleHistory as unknown as Array<Record<string, unknown>>;
    else if (workspace.bottomTab === "summary") rows = [...balances, ...bodBalances] as unknown as Array<Record<string, unknown>>;
    else rows = notifications as unknown as Array<Record<string, unknown>>;
    if (!rows.length) return;
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [keys.map(quote).join(","), ...rows.map((row) => keys.map((key) => quote(row[key])).join(","))].join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = `${account?.displayId ?? "account"}-${workspace.bottomTab}.csv`; link.click(); URL.revokeObjectURL(link.href);
  };
  const Empty = ({ label }: { label: string }) => <div className="empty-table"><BookOpen size={20} /><span>{label}</span></div>;
  const OrderTable = ({ rows }: { rows: OrderUpdate[] }) => rows.length ? <table><thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Quantity</th><th>Filled quantity</th><th>Limit price</th><th>Stop price</th><th>Avg fill price</th><th>Take profit</th><th>Stop loss</th><th>Status</th><th>Open time</th><th>Close time</th><th>Duration</th><th /></tr></thead><tbody>{rows.map((o) => <tr key={o.id}><td><strong>{o.symbol}</strong></td><td className={o.side === "Buy" ? "buy-text" : "negative"}>{o.side}</td><td>{o.type}</td><td>{o.quantity}</td><td>{o.filledQuantity ?? "—"}</td><td>{money(o.price)}</td><td>{money(o.stopPrice)}</td><td>{money(o.averageFillPrice)}</td><td>{money(o.takeProfit)}</td><td>{money(o.stopLoss)}</td><td><span className={`order-status ${o.status.toLowerCase()}`}>{o.status}</span></td><td>{time(o.timestamp)}</td><td>{time(o.closedAt)}</td><td>{o.duration ?? "—"}</td><td>{o.status === "Working" && <button onClick={() => onCancel(o.id)}>Cancel</button>}</td></tr>)}</tbody></table> : <Empty label="There is no trading data here yet" />;
  return <section className={`bottom-panel ${maximized ? "maximized" : ""}`}><div className="resize-handle" onPointerDown={startResize} />
    <header className="bottom-provider"><strong>TradeStation</strong><span className="bottom-status"><span className={`status-dot ${error ? "error" : ""}`} />{error ? "Data unavailable" : loading ? "Refreshing…" : "Brokerage data active"}</span><button title="Collapse panel" onClick={() => updateWorkspace({ bottomPanelOpen: false })}><Minus size={16} /></button><button title={maximized ? "Restore" : "Maximize"} onClick={() => { setMaximized(!maximized); updateWorkspace({ bottomPanelHeight: maximized ? 360 : window.innerHeight - 150 }); }}><Maximize2 size={15} /></button></header>
    <div className="account-summary"><select value={account?.id ?? ""} onChange={(event) => updateWorkspace({ selectedAccountId: event.target.value })}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.displayId} {item.currency}</option>)}</select><dl><div><dt>Net worth</dt><dd>{money(balance?.equity)}</dd></div><div><dt>Today’s profit</dt><dd>{money(balance?.realizedProfitLoss)}</dd></div><div><dt>Unrealized PnL</dt><dd>{money(balance?.unrealizedProfitLoss ?? positions.reduce((sum, item) => sum + item.unrealizedPnl, 0))}</dd></div></dl></div>
    <nav className="bottom-tabs">{tabs.map(([tab, label]) => <button key={tab} className={workspace.bottomTab === tab ? "active" : ""} onClick={() => updateWorkspace({ bottomTab: tab })}>{label}</button>)}<button className="export-button" title="Export active tab to CSV" onClick={exportRows}><Download size={16} /></button></nav>
    <div className="table-wrap">{error && <div className="panel-error">{error}</div>}
      {workspace.bottomTab === "positions" && (positions.length ? <table><thead><tr><th>Symbol</th><th>Side</th><th>Quantity</th><th>Avg price</th><th>Stop loss</th><th>Take profit</th><th>Last price</th><th>Bid price</th><th>Ask price</th><th>Unrealized PnL</th><th>PnL quantity</th><th>PnL percent</th><th /></tr></thead><tbody>{positions.map((p) => { const closing = closingPositionIds.has(p.id); return <tr key={p.id}><td><strong>{p.symbol}</strong></td><td className={p.side === "Long" ? "buy-text" : "negative"}>{p.side}</td><td>{p.quantity}</td><td>{money(p.averagePrice)}</td><td>—</td><td>—</td><td>{money(p.last)}</td><td>{money(p.bid)}</td><td>{money(p.ask)}</td><td className={p.unrealizedPnl >= 0 ? "positive" : "negative"}>{money(p.unrealizedPnl)}</td><td>{money(p.unrealizedPnlQuantity)}</td><td>{p.unrealizedPnlPercent == null ? "—" : `${p.unrealizedPnlPercent.toFixed(2)}%`}</td><td><button className="close-position-button" disabled={closing} onClick={() => onClosePosition(p)}><X size={12} />{closing ? "Closing…" : "Close Position"}</button></td></tr>; })}</tbody></table> : <Empty label="There are no open positions in this account" />)}
      {workspace.bottomTab === "orders" && <><div className="table-filters">{["All", "Working", "Inactive", "Filled", "Cancelled", "Rejected"].map((filter) => <button key={filter} className={orderFilter === filter ? "active" : ""} onClick={() => setOrderFilter(filter)}>{filter}</button>)}</div><OrderTable rows={visibleOrders} /></>}
      {workspace.bottomTab === "history" && <><div className="history-controls"><label>From <input type="date" value={since} max={until} onChange={(e) => setSince(e.target.value)} /></label><label>To <input type="date" value={until} min={since} onChange={(e) => setUntil(e.target.value)} /></label>{["All", "Filled", "Cancelled", "Rejected"].map((filter) => <button key={filter} className={historyFilter === filter ? "active" : ""} onClick={() => setHistoryFilter(filter)}>{filter}</button>)}</div><OrderTable rows={visibleHistory} />{history.nextToken && <button className="load-more" disabled={historyLoading} onClick={() => loadHistory(true)}>{historyLoading ? "Loading…" : "Load more"}</button>}</>}
      {workspace.bottomTab === "summary" && <div className="balance-sections"><BalanceSection title="Real-time" balance={balance} money={money} /><BalanceSection title="Beginning of day" balance={bod} money={money} /></div>}
      {workspace.bottomTab === "notifications" && (notifications.length ? <table><thead><tr><th>Symbol</th><th>Time</th><th>Title</th><th>Text</th></tr></thead><tbody>{notifications.map((item) => <tr key={item.id}><td>{item.symbol ?? "—"}</td><td>{time(item.time)}</td><td className={item.level === "error" ? "negative" : ""}>{item.title}</td><td>{item.text}</td></tr>)}</tbody></table> : <Empty label="There is no activity here yet" />)}
    </div></section>;
}

function BalanceSection({ title, balance, money }: { title: string; balance?: AccountBalance; money: (value?: number) => string }) {
  const cells: Array<[string, number | undefined]> = [["Currency", undefined], ["Account balance", balance?.cashBalance], ["Realized PnL", balance?.realizedProfitLoss], ["Unrealized PnL", balance?.unrealizedProfitLoss], ["Net worth", balance?.equity], ["Commission", balance?.commission], ["Uncleared deposits", balance?.unclearedDeposit], ["Real time BP", balance?.buyingPower], ["Initial margin", balance?.initialMargin], ["Maintenance margin", balance?.maintenanceMargin], ["Open order margin", balance?.openOrderMargin]];
  return <section><h3>{title}</h3><div className="balance-grid">{cells.map(([label, value], index) => <div key={label}><span>{label}</span><strong>{index === 0 ? balance?.currency ?? "—" : money(value)}</strong></div>)}</div></section>;
}
