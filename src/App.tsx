import { useEffect, useMemo, useRef, useState } from "react";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, cursorPosition, getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity, BarChart3, Bell, BookOpen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download,
  GripVertical, LineChart, ListChecks, LockKeyhole, Maximize2, Minimize2, Minus,
  Magnet, MousePointer2, PanelsTopLeft, Plus,
  Search, Settings2, SlidersHorizontal, SquareStack, TrendingDown, TrendingUp,
  Wifi, X, Zap,
} from "lucide-react";
import { TradingChart, type TradingChartCapture, type TradingChartHandle } from "./components/TradingChart";
import { ChartPaneGrid } from "./components/ChartPaneGrid";
import { EntryRulesBuilder } from "./components/EntryRulesBuilder";
import { JournalCloudSettings, TradeJournalWindow } from "./components/TradeJournalWindow";
import { api } from "./lib/bridge";
import { applyCloudPreferenceProfile, cloudPreferenceProfile, preferencePollInterval, preferenceRetryDelay, profileFromRecords } from "./lib/cloudPreferences";
import { playAlertSound, prepareAlertAudio } from "./lib/alertAudio";
import { mergeBars } from "./lib/barData";
import { demoOrders, demoPositions, futures, quoteFor } from "./lib/demo";
import { ALERT_DURATIONS, ALERT_SOUNDS, ALERT_TIMEFRAMES, alertMarketKey, defaultEma200Alert, deriveEma200TabPositions, desiredAlertMarkets, evaluateEma200Cross, uncoveredAlertMarkets, type Ema200TabPositionCacheEntry, type EmaCrossSide } from "./lib/emaAlerts";
import { calculateContractsForRisk, calculateTakeProfitAtR, estimateOrderRisk, validateTick } from "./lib/indicators";
import { defaultEntryRules, evaluateEntryRules, hasConfiguredEntryRules } from "./lib/entryRules";
import {
  defaultEntryRuleAlerts, entryRuleAlertEpoch, trackEntryRuleAlertTransitions,
  type EntryRuleAlertTrackerState, type EntryRuleAlertTransition,
} from "./lib/entryRuleAlerts";
import { canAddWatchlistSymbol, formatContractExpiration, hasOpenFuturesPosition, isContinuousFuture, quoteSubscriptionInstruments, resolveTradeSymbol, sameSymbolMeta } from "./lib/futuresContracts";
import { quoteDayChangePercent } from "./lib/quotes";
import { brokerageDisplayState, brokeragePollInterval, brokerageStreamsHealthy as areBrokerageStreamsHealthy, isCompletedCloseFill, isManagedThrottle, isNewOpenPosition, orderFillNeedsPositionReconciliation, reconcileOrderSnapshot, reconcilePositionSnapshot, upsertStreamOrder, upsertStreamPosition } from "./lib/brokerage";
import { calculateSwingStop } from "./lib/swingStop";
import { canArmEntryScreenshot, entryScreenshotLinesReady, entryScreenshotRetryDelay, hasOpenPosition, shouldRetryEntryScreenshots, ENTRY_SCREENSHOT_QUEUE_LIMIT } from "./lib/entryScreenshot";
import { applyProjectedExitEdit, flattenOrderDraft, orderRMultiples, recalculateOrderProjectionAtR, withOrderPrice, type OrderProjection, type OrderRMultiple, type ProjectedExitField } from "./lib/tradeLines";
import { isTargetOutside } from "./lib/menuFocus";
import { defaultIndicators } from "./lib/workspace";
import { defaultPointAndFigureSettings, defaultRenkoSettings, normalizePointAndFigureSettings, normalizeRenkoSettings } from "./lib/priceBasedCharts";
import { instrumentKey, rememberRecentSymbol, reorderWatchlist } from "./lib/watchlist";
import { acceptsBarEvent, acceptsDetachedBarGeneration, isBarStateEvent, isSameBarMarket } from "./lib/streamEvents";
import { chartLayoutCapacity, claimDetachedWindowCreation, clampWindowGeometry, cloneChartTab, closeDetachedWindow, defaultChartSplitRatios, detachedSourceWindowToClose, focusChartTab, MAIN_WINDOW_ID, MAX_CHART_TABS, moveTab, normalizedChartLayout, normalizeChartSplitRatio, normalizeChartWorkspace, reconcileChartWindow, rememberWindowGeometry, savedPhysicalWindowGeometry, setChartWindowLayout, setChartWindowSplitRatio, stabilizeChartWorkspace, staleDetachedWindowIds, tabInsertionIndex } from "./lib/chartWorkspace";
import { chunkVwapRange, expandedVwapRange, isIntradayTimeframe, mergeEpochRanges, mergeVwapBars, missingEpochRanges, nySessionVwapSymbols, type EpochRange } from "./lib/vwapData";
import type { Account, AccountBalance, ActivityNotification, AlertDurationSeconds, AlertSound, Bar, BarSnapshotEvent, BarUpdateEvent, BrokerageStreamStateEvent, ChartKind, ChartLabelSettings, ChartLayout, ChartTabState, ChartTool, ChartWindowState, Drawing, EntryRuleResult, EntryRuleSide, HistoricalOrderPage, IndicatorConfig, MarketDataProvider, OrdersSnapshotEvent, OrderDraft, OrderPreview, OrderStreamUpdateEvent, OrderTicketSettings, OrderUpdate, PositionsSnapshotEvent, Position, PositionUpdateEvent, PreferenceRealtimeStateEvent, PreferenceSyncResult, Quote, QuoteUpdateEvent, StreamConnectionState, StreamStateEvent, SymbolMeta, Timeframe, TimeframeAlertConfig, TradingEnvironment, WorkspaceState } from "./types";

const timeframes: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "D", "W", "M"];
const PREFERENCE_FOCUS_THROTTLE_MS = 30_000;
const chartStyles: Array<{ kind: ChartKind; label: string; description: string }> = [
  { kind: "candles", label: "Candles", description: "Time-based OHLC" },
  { kind: "line", label: "Line", description: "Close price" },
  { kind: "area", label: "Area", description: "Filled close price" },
  { kind: "renko", label: "Renko", description: "Fixed price bricks" },
  { kind: "point-and-figure", label: "Point & Figure", description: "X/O price columns" },
];
const chartLayouts: Array<{ layout: ChartLayout; label: string }> = [
  { layout: "single", label: "Single" },
  { layout: "two-columns", label: "2 columns" },
  { layout: "two-rows", label: "2 rows" },
  { layout: "three-columns", label: "3 columns" },
  { layout: "three-rows", label: "3 rows" },
  { layout: "four-grid", label: "4 grid" },
];
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
  tabs: [{ id: "chart-1", symbol: futures[0], timeframe: "1m", chartKind: "candles", renkoSettings: defaultRenkoSettings(), pointAndFigureSettings: defaultPointAndFigureSettings(), indicators: defaultIndicators, ema200Alert: defaultEma200Alert(), chartTimezone: "exchange", magnetEnabled: false }],
  windows: [{ id: MAIN_WINDOW_ID, tabIds: ["chart-1"], activeTabId: "chart-1", visibleTabIds: ["chart-1"], chartLayout: "single", detached: false }],
  drawings: {},
  watchlist: futures.filter((item) => ["MESU26", "MNQU26", "MCLU26", "MGCQ26", "MYMU26"].includes(item.symbol)), recentSymbols: [futures[0]], rightPanelOpen: false, bottomTab: "positions", bottomPanelOpen: false, bottomPanelHeight: 360, confirmOrders: true, entryRules: defaultEntryRules(), entryRuleAlerts: defaultEntryRuleAlerts(),
  settings: { chartLabels: { showEma200TabDots: true, showDollarAmount: true, showRMultiple: true, fontSize: 11 }, orderTicket: { swingStopPivotBars: 2, swingStopOffsetTicks: 1, sizingMode: "contracts", riskSizingPolicy: "strict" }, journal: { commissionPerContractSide: 0.4 } },
};

const currentWindowId = api.isNative ? getCurrentWindow().label : MAIN_WINDOW_ID;

interface TabMarketState {
  provider: MarketDataProvider;
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
  hasOlder: boolean;
  loadingOlder: boolean;
  streamState: StreamConnectionState;
  streamMessage?: string;
  generation?: number;
}

function emptyTabMarket(provider: MarketDataProvider, symbol: string, timeframe: Timeframe, generation?: number): TabMarketState {
  return {
    provider,
    symbol,
    timeframe,
    bars: [],
    hasOlder: true,
    loadingOlder: false,
    streamState: api.isNative ? "connecting" : "streaming",
    generation,
  };
}

interface StripBounds { windowId: string; left: number; top: number; right: number; bottom: number; }

interface WindowMarketSyncEvent {
  environment: TradingEnvironment;
  markets: Array<{ tabId: string; symbol: string; timeframe: Timeframe; market: TabMarketState }>;
  quotes: Record<string, Quote>;
}

interface BarSubscription {
  subscriptionId: string;
  provider: MarketDataProvider;
  symbol: string;
  timeframe: Timeframe;
  epoch: string;
  generation: number;
}

type ReviewState =
  | { kind: "entry"; draft: OrderDraft; preview: OrderPreview; sourceTabId: string; chartSymbol: string }
  | { kind: "close-position"; draft: OrderDraft; preview: OrderPreview; positionId: string };

interface EntryScreenshotCandidate {
  id: string;
  sourceTabId: string;
  chartSymbol: string;
  tradeSymbol: string;
  accountId: string;
  environment: TradingEnvironment;
  brokerOrderId?: string;
  acceptedAt?: number;
  positionSeen?: boolean;
  capture?: TradingChartCapture;
  attempts: number;
  lastError?: string;
}

interface EntryRuleTabSignal {
  symbol: string;
  timeframe: Timeframe;
  sides: EntryRuleSide[];
  pulsing: boolean;
}

type EntryRuleTabSignalEvent =
  | { action: "trigger"; signals: Array<{ tabId: string; symbol: string; timeframe: Timeframe; sides: EntryRuleSide[] }> }
  | { action: "acknowledge"; tabIds: string[] };

function activeProtectionIds(expirations: Map<string, number>, now = Date.now()): Set<string> {
  const active = new Set<string>();
  expirations.forEach((expiresAt, id) => {
    if (expiresAt > now) active.add(id);
    else expirations.delete(id);
  });
  return active;
}

function formatPrice(value?: number): string {
  return value == null ? "—" : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

async function syncWorkspaceToOpenWindows(workspace: WorkspaceState): Promise<void> {
  await Promise.all(workspace.windows.map((window) => emitTo(window.id, "workspace-sync", workspace).catch(() => undefined)));
}

async function restoreMainWindowGeometry(state: ChartWindowState): Promise<void> {
  if (!api.isNative) return;
  const current = getCurrentWindow();
  const savedPhysical = savedPhysicalWindowGeometry(state);
  if (savedPhysical) {
    const monitors = await availableMonitors();
    const screens = monitors.map((monitor) => ({ x: monitor.workArea.position.x, y: monitor.workArea.position.y, width: monitor.workArea.size.width, height: monitor.workArea.size.height }));
    const geometry = clampWindowGeometry(savedPhysical, screens);
    await current.setSize(new PhysicalSize(geometry.width, geometry.height));
    await current.setPosition(new PhysicalPosition(geometry.x, geometry.y));
  }
  if (state.maximized === true) await current.maximize();
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

function positionSnapshotScope(environment: TradingEnvironment, accountId: string): string {
  return `${environment}\u0000${accountId}`;
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

function SchwabCredentials({ clientId, secret, busy, configured, connected, native, onClientIdChange, onSecretChange, onSave, onConnect, onDisconnect }: {
  clientId: string;
  secret: string;
  busy: boolean;
  configured: boolean;
  connected: boolean;
  native: boolean;
  onClientIdChange: (value: string) => void;
  onSecretChange: (value: string) => void;
  onSave: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return <>
    <div className="api-status-line"><span className={connected ? "connected" : configured ? "configured" : ""} />{connected ? "Connected" : configured ? "Configured" : "Not configured"}</div>
    <label className="field"><span>App Key</span><input value={clientId} onChange={(event) => onClientIdChange(event.target.value)} placeholder={configured ? "Enter a new key to replace credentials" : "Enter App Key"} autoComplete="off" /></label>
    <label className="field"><span>App Secret</span><input value={secret} onChange={(event) => onSecretChange(event.target.value)} type="password" placeholder={configured ? "Stored securely — enter to replace" : "Enter App Secret"} autoComplete="new-password" /></label>
    <div className="callback-note"><span>Callback URL</span><code>https://127.0.0.1:8182/callback</code></div>
    {!native && <div className="demo-warning">Schwab browser fixtures are active. OAuth is available in the desktop app.</div>}
    <div className="connection-actions"><button className="secondary-button" disabled={busy || !native || !clientId.trim() || !secret.trim()} onClick={onSave}>Save</button><button className="primary-button" disabled={busy || !native || !configured} onClick={onConnect}>{connected ? "Reconnect" : "Connect"}</button>{connected && <button className="secondary-button" disabled={busy || !native} onClick={onDisconnect}>Disconnect</button>}</div>
  </>;
}

export default function App() {
  if (new URLSearchParams(window.location.search).get("view") === "journal") return <TradeJournalWindow />;
  return <TradingApp />;
}

function TradingApp() {
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const workspaceRef = useRef(workspace);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const environment = workspace.environment;
  const [tabMarkets, setTabMarkets] = useState<Record<string, TabMarketState>>({});
  const tabMarketsRef = useRef(tabMarkets);
  const [vwapMarkets, setVwapMarkets] = useState<Record<string, VwapMarketState>>({});
  const vwapMarketsRef = useRef(vwapMarkets);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [positions, setPositions] = useState<Position[]>(api.isNative ? [] : demoPositions);
  const [positionsReadyScope, setPositionsReadyScope] = useState<string>();
  const [orders, setOrders] = useState<OrderUpdate[]>(api.isNative ? [] : demoOrders);
  const [balances, setBalances] = useState<AccountBalance[]>([]);
  const [bodBalances, setBodBalances] = useState<AccountBalance[]>([]);
  const [history, setHistory] = useState<HistoricalOrderPage>({ orders: [] });
  const [brokerageLoading, setBrokerageLoading] = useState(false);
  const [brokerageError, setBrokerageError] = useState<string>();
  const [brokerageStreamStates, setBrokerageStreamStates] = useState<Record<"positions" | "orders", StreamConnectionState>>({ positions: api.isNative ? "disconnected" : "streaming", orders: api.isNative ? "disconnected" : "streaming" });
  const [notifications, setNotifications] = useState<ActivityNotification[]>([]);
  const [entryRuleTabSignals, setEntryRuleTabSignals] = useState<Record<string, EntryRuleTabSignal>>({});
  const entryRuleTabSignalsRef = useRef(entryRuleTabSignals);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const quotesRef = useRef(quotes);
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
  const [chartStyleOpen, setChartStyleOpen] = useState(false);
  const [chartLayoutOpen, setChartLayoutOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [entryRulesOpen, setEntryRulesOpen] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [envConfirm, setEnvConfirm] = useState<TradingEnvironment | null>(null);
  const [activeTool, setActiveTool] = useState<ChartTool>("cursor");
  const [horizontalToolsOpen, setHorizontalToolsOpen] = useState(false);
  const [positionToolsOpen, setPositionToolsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [bottomPanelMaximized, setBottomPanelMaximized] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [credentialsConfigured, setCredentialsConfigured] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authEpoch, setAuthEpoch] = useState(0);
  const [schwabClientId, setSchwabClientId] = useState("");
  const [schwabSecret, setSchwabSecret] = useState("");
  const [schwabConfigured, setSchwabConfigured] = useState(false);
  const [schwabAuthenticated, setSchwabAuthenticated] = useState(!api.isNative);
  const [schwabAuthEpoch, setSchwabAuthEpoch] = useState(0);
  const [preferenceSync, setPreferenceSync] = useState<{ state: "idle" | "syncing" | PreferenceSyncResult["state"]; lastSyncedAt?: string; message?: string }>({ state: "idle" });
  const [preferenceRealtime, setPreferenceRealtime] = useState<PreferenceRealtimeStateEvent>({ state: "disabled" });
  const [preferenceSyncEpoch, setPreferenceSyncEpoch] = useState(0);
  const preferenceSyncInFlightRef = useRef(false);
  const preferenceSyncPendingRef = useRef(false);
  const preferenceSyncRetryRef = useRef<number | undefined>(undefined);
  const preferenceSyncAttemptRef = useRef(0);
  const preferenceLastSyncStartedAtRef = useRef(0);
  const brokerageRefreshRef = useRef<(settle?: boolean) => void>(() => undefined);
  const brokerageBalanceRefreshRef = useRef<() => void>(() => undefined);
  const brokerageFillReconcileTimerRef = useRef<number | undefined>(undefined);
  const selectedAccountIdRef = useRef<string | undefined>(undefined);
  const recentOrderIdsRef = useRef(new Map<string, number>());
  const recentPositionIdsRef = useRef(new Map<string, number>());
  const [busy, setBusy] = useState(false);
  const [closingPositionIds, setClosingPositionIds] = useState<Set<string>>(() => new Set());
  const closingPositionTimersRef = useRef(new Map<string, number>());
  const [replacingOrderIds, setReplacingOrderIds] = useState<Set<string>>(() => new Set());
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const subscriptionsRef = useRef(new Map<string, BarSubscription>());
  const latestDetachedGenerationRef = useRef(new Map<string, number>());
  const awaitingDetachedGenerationRef = useRef(new Set<string>());
  const tabMarketEnvironmentRef = useRef(environment);
  const detachedWindowCreationsRef = useRef(new Set<string>());
  const ema200TabCacheRef = useRef(new Map<string, Ema200TabPositionCacheEntry>());
  const alertSubscriptionsRef = useRef(new Map<string, BarSubscription>());
  const alertBarsRef = useRef(new Map<string, Bar[]>());
  const alertSidesRef = useRef(new Map<string, EmaCrossSide>());
  const alertLoadedEpochRef = useRef(new Map<string, string>());
  const alertDesiredRef = useRef(new Set<string>());
  const alertDataEpochRef = useRef("");
  const entryRuleAlertTrackerRef = useRef<EntryRuleAlertTrackerState | undefined>(undefined);
  const entryRuleSignalTimersRef = useRef(new Map<string, number>());
  const entryRuleAudioTimersRef = useRef(new Set<number>());
  const entryRuleAudioAvailableAtRef = useRef(0);
  const vwapSubscriptionsRef = useRef(new Map<string, Omit<BarSubscription, "timeframe">>());
  const barSubscriptionGenerationRef = useRef(Date.now() * 1000);
  const vwapSymbolsRef = useRef(new Set<string>());
  const vwapRangeTimersRef = useRef(new Map<string, number>());
  const vwapDataEpochRef = useRef("");
  const chartCaptureRefs = useRef(new Map<string, TradingChartHandle>());
  const [entryScreenshotCandidates, setEntryScreenshotCandidates] = useState<EntryScreenshotCandidate[]>([]);
  const entryScreenshotCandidatesRef = useRef<EntryScreenshotCandidate[]>([]);
  const screenshotCapturingRef = useRef(new Set<string>());
  const screenshotUploadingRef = useRef(new Set<string>());
  const screenshotRetryTimersRef = useRef(new Map<string, number>());
  const retryEntryScreenshotsRef = useRef<() => void>(() => undefined);
  const environmentRef = useRef(environment);
  const stripBoundsRef = useRef(new Map<string, StripBounds>());
  const viewRangesRef = useRef(new Map<string, { from: number; to: number }>());
  const windowState = workspace.windows.find((item) => item.id === currentWindowId) ?? workspace.windows[0];
  const isDetached = currentWindowId !== MAIN_WINDOW_ID;
  const hasWindowTabs = windowState.tabIds.length > 0;
  const activeTab = workspace.tabs.find((item) => item.id === windowState?.activeTabId) ?? workspace.tabs[0];
  const chartLayout = normalizedChartLayout(windowState.chartLayout);
  const visibleTabIds = (windowState.visibleTabIds ?? [activeTab.id]).filter((id) => windowState.tabIds.includes(id)).slice(0, chartLayoutCapacity(chartLayout));
  const visibleTabs = visibleTabIds.map((id) => workspace.tabs.find((tab) => tab.id === id)).filter((tab): tab is ChartTabState => Boolean(tab));
  const activeMarket = tabMarkets[activeTab.id];
  const market = isSameBarMarket(activeMarket, activeTab.symbol.provider, activeTab.symbol.symbol, activeTab.timeframe)
    ? activeMarket
    : emptyTabMarket(activeTab.symbol.provider, activeTab.symbol.symbol, activeTab.timeframe);
  const bars = market.bars;
  const activeContinuous = isContinuousFuture(activeTab.symbol);
  const activeTradeSymbol = resolveTradeSymbol(activeTab);
  const activeTradeMeta = activeContinuous
    ? activeTradeSymbol ? tradeDetails[activeTradeSymbol] : undefined
    : activeTab.symbol;

  useEffect(() => {
    if (!chartStyleOpen) return;
    const closeChartStyle = (event: KeyboardEvent) => { if (event.key === "Escape") setChartStyleOpen(false); };
    window.addEventListener("keydown", closeChartStyle);
    return () => window.removeEventListener("keydown", closeChartStyle);
  }, [chartStyleOpen]);

  useEffect(() => {
    if (!chartLayoutOpen) return;
    const closeChartLayout = (event: KeyboardEvent) => { if (event.key === "Escape") setChartLayoutOpen(false); };
    window.addEventListener("keydown", closeChartLayout);
    return () => window.removeEventListener("keydown", closeChartLayout);
  }, [chartLayoutOpen]);

  workspaceRef.current = workspace;
  tabMarketsRef.current = tabMarkets;
  vwapMarketsRef.current = vwapMarkets;
  quotesRef.current = quotes;
  entryRuleTabSignalsRef.current = entryRuleTabSignals;

  const activeQuote = quotes[instrumentKey(activeTab.symbol)] ?? (api.isNative
    ? { provider: activeTab.symbol.provider, symbol: activeTab.symbol.symbol, last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" }
    : quoteFor(activeTab.symbol.symbol, 0, activeTab.symbol.provider));
  const activeEntryEligibility = useMemo(
    () => evaluateEntryRules(workspace.entryRules, bars, activeQuote),
    [workspace.entryRules, bars, activeQuote],
  );
  const tabStreamKey = workspace.tabs.map((tab) => `${tab.id}:${tab.symbol.provider}:${tab.symbol.symbol}:${tab.timeframe}`).join("|");
  const alertOwnershipKey = workspace.tabs.flatMap((tab) => ALERT_TIMEFRAMES.filter((timeframe) => tab.ema200Alert[timeframe].enabled).map((timeframe) => `${tab.id}:${tab.symbol.symbol}:${timeframe}`)).join("|");
  const alertMarkets = desiredAlertMarkets(workspace.tabs);
  const alertMarketsKey = alertMarkets.map((market) => market.key).sort().join("|");
  const activeAlertCount = ALERT_TIMEFRAMES.filter((timeframe) => activeTab.ema200Alert[timeframe].enabled).length;
  const chartSymbolsKey = [...new Set(workspace.tabs.map((tab) => instrumentKey(tab.symbol)))].sort().join("|");
  const tradeDetailSymbolsKey = [...new Set(workspace.tabs.filter((tab) => isContinuousFuture(tab.symbol)).map(resolveTradeSymbol).filter((symbol): symbol is string => Boolean(symbol)))].sort().join("|");
  const quoteInstruments = quoteSubscriptionInstruments(workspace);
  const quoteSymbolsKey = quoteInstruments.map(instrumentKey).join("|");
  const vwapSymbolsKey = nySessionVwapSymbols(workspace.tabs).join("|");
  const ema200Positions = useMemo(() => deriveEma200TabPositions(
    workspace.tabs,
    tabMarkets,
    workspace.settings.chartLabels.showEma200TabDots,
    ema200TabCacheRef.current,
  ), [workspace.tabs, workspace.settings.chartLabels.showEma200TabDots, tabMarkets]);
  alertDesiredRef.current = new Set(alertMarkets.map((market) => market.key));
  vwapSymbolsRef.current = new Set(vwapSymbolsKey.split("|").filter(Boolean));
  vwapDataEpochRef.current = `${environment}:${authEpoch}`;
  entryScreenshotCandidatesRef.current = entryScreenshotCandidates;
  environmentRef.current = environment;
  const activeTradeQuote: Quote = activeTradeSymbol
    ? quotes[`tradestation:${activeTradeSymbol}`] ?? (api.isNative
      ? { provider: "tradestation", symbol: activeTradeSymbol, last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" }
      : quoteFor(activeTradeSymbol, 0, "tradestation"))
    : { provider: "tradestation", symbol: "", last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" };
  const activeOrderMinMove = activeTradeMeta?.minMove ?? activeTab.symbol.minMove;
  const cloudPreferenceKey = useMemo(
    () => JSON.stringify(cloudPreferenceProfile(workspace)),
    [workspace],
  );

  useEffect(() => {
    if (isDetached || !workspace.rightPanelOpen) return;
    setOrderProjection((current) => {
      if (!current || current.tradeSymbol !== activeTradeSymbol || current.rMultiple == null) return current;
      const entryPrice = (current.side ?? "Buy") === "Buy" ? activeTradeQuote.ask : activeTradeQuote.bid;
      const next = recalculateOrderProjectionAtR(current, entryPrice, activeOrderMinMove);
      return next === current ? current : { ...next, tradeSymbol: current.tradeSymbol };
    });
  }, [isDetached, workspace.rightPanelOpen, activeTradeSymbol, activeTradeQuote.ask, activeTradeQuote.bid, activeOrderMinMove]);

  function alertOwnerKey(tab: ChartTabState, timeframe: Timeframe): string {
    return `${tab.id}\u0000${tab.symbol.symbol}\u0000${timeframe}`;
  }

  function matchingAlertTabs(symbol: string, timeframe: Timeframe): ChartTabState[] {
    return workspaceRef.current.tabs.filter((tab) => tab.symbol.symbol === symbol && tab.ema200Alert[timeframe].enabled);
  }

  function applyEntryRuleTabSignal(event: EntryRuleTabSignalEvent) {
    if (event.action === "acknowledge") {
      event.tabIds.forEach((tabId) => {
        const timer = entryRuleSignalTimersRef.current.get(tabId);
        if (timer != null) window.clearTimeout(timer);
        entryRuleSignalTimersRef.current.delete(tabId);
      });
      setEntryRuleTabSignals((current) => {
        if (!event.tabIds.some((tabId) => current[tabId])) return current;
        const next = { ...current };
        event.tabIds.forEach((tabId) => { delete next[tabId]; });
        return next;
      });
      return;
    }

    setEntryRuleTabSignals((current) => {
      const next = { ...current };
      event.signals.forEach((signal) => {
        const existing = current[signal.tabId];
        const sameMarket = existing?.symbol === signal.symbol && existing.timeframe === signal.timeframe;
        const sides = [...new Set([...(sameMarket ? existing.sides : []), ...signal.sides])]
          .sort((left, right) => left === right ? 0 : left === "long" ? -1 : 1) as EntryRuleSide[];
        next[signal.tabId] = { symbol: signal.symbol, timeframe: signal.timeframe, sides, pulsing: true };
      });
      return next;
    });
    event.signals.forEach(({ tabId }) => {
      const existing = entryRuleSignalTimersRef.current.get(tabId);
      if (existing != null) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        entryRuleSignalTimersRef.current.delete(tabId);
        setEntryRuleTabSignals((current) => current[tabId]
          ? { ...current, [tabId]: { ...current[tabId], pulsing: false } }
          : current);
      }, 1800);
      entryRuleSignalTimersRef.current.set(tabId, timer);
    });
  }

  function broadcastEntryRuleTabSignal(event: EntryRuleTabSignalEvent) {
    applyEntryRuleTabSignal(event);
    if (!api.isNative) return;
    workspaceRef.current.windows.filter((window) => window.id !== currentWindowId)
      .forEach((window) => { void emitTo(window.id, "entry-rule-tab-signal", event).catch(() => undefined); });
  }

  function queueEntryRuleAlertSounds(transitions: EntryRuleAlertTransition[]) {
    const ordered = [...transitions].sort((left, right) => left.side === right.side ? 0 : left.side === "long" ? -1 : 1);
    let availableAt = Math.max(Date.now(), entryRuleAudioAvailableAtRef.current);
    ordered.forEach((transition) => {
      const config = workspaceRef.current.entryRuleAlerts[transition.side];
      const delay = Math.max(0, availableAt - Date.now());
      const timer = window.setTimeout(() => {
        entryRuleAudioTimersRef.current.delete(timer);
        playAlertSound(config.sound, config.durationSeconds);
      }, delay);
      entryRuleAudioTimersRef.current.add(timer);
      availableAt += config.durationSeconds * 1000 + 120;
    });
    entryRuleAudioAvailableAtRef.current = availableAt;
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

  function nextBarSubscriptionGeneration(): number {
    barSubscriptionGenerationRef.current += 1;
    return barSubscriptionGenerationRef.current;
  }

  function markDetachedMarketReplacements(current: WorkspaceState, next: WorkspaceState) {
    if (currentWindowId === MAIN_WINDOW_ID) return;
    const currentTabs = new Map(current.tabs.map((tab) => [tab.id, tab]));
    next.tabs.forEach((tab) => {
      const prior = currentTabs.get(tab.id);
      if (!prior || prior.symbol.symbol === tab.symbol.symbol && prior.timeframe === tab.timeframe) return;
      const currentGeneration = tabMarketsRef.current[tab.id]?.generation;
      const latestGeneration = latestDetachedGenerationRef.current.get(tab.id);
      const highWater = currentGeneration == null
        ? latestGeneration
        : latestGeneration == null ? currentGeneration : Math.max(currentGeneration, latestGeneration);
      if (highWater != null) latestDetachedGenerationRef.current.set(tab.id, highWater);
      awaitingDetachedGenerationRef.current.add(tab.id);
    });
  }

  function acceptsWindowBarEvent(tab: ChartTabState | undefined, payload: BarSnapshotEvent | BarUpdateEvent | (StreamStateEvent & { symbol: string; timeframe: Timeframe; generation: number })): boolean {
    if (!acceptsBarEvent(tab, environmentRef.current, payload)) return false;
    if (currentWindowId === MAIN_WINDOW_ID) {
      const expectedGeneration = subscriptionsRef.current.get(payload.subscriptionId)?.generation;
      return expectedGeneration != null && payload.generation === expectedGeneration;
    }
    const latestGeneration = latestDetachedGenerationRef.current.get(payload.subscriptionId);
    const awaitingReplacement = awaitingDetachedGenerationRef.current.has(payload.subscriptionId);
    if (!acceptsDetachedBarGeneration(payload.generation, latestGeneration, awaitingReplacement)) return false;
    if (latestGeneration == null || payload.generation > latestGeneration) {
      latestDetachedGenerationRef.current.set(payload.subscriptionId, payload.generation);
    }
    awaitingDetachedGenerationRef.current.delete(payload.subscriptionId);
    return true;
  }

  function marketSyncForWindow(windowId: string): WindowMarketSyncEvent {
    const target = workspaceRef.current.windows.find((item) => item.id === windowId);
    const tabs = (target?.tabIds ?? [])
      .map((tabId) => workspaceRef.current.tabs.find((tab) => tab.id === tabId))
      .filter((tab): tab is ChartTabState => Boolean(tab));
    return {
      environment: environmentRef.current,
      markets: tabs.map((tab) => ({
        tabId: tab.id,
        symbol: tab.symbol.symbol,
        timeframe: tab.timeframe,
        market: isSameBarMarket(tabMarketsRef.current[tab.id], tab.symbol.provider, tab.symbol.symbol, tab.timeframe)
          ? tabMarketsRef.current[tab.id]
          : emptyTabMarket(tab.symbol.provider, tab.symbol.symbol, tab.timeframe, subscriptionsRef.current.get(tab.id)?.generation),
      })),
      quotes: Object.fromEntries(tabs.flatMap((tab) => {
        const key = instrumentKey(tab.symbol);
        const quote = quotesRef.current[key];
        return quote ? [[key, quote] as const] : [];
      })),
    };
  }

  useEffect(() => {
    Promise.all([api.loadWorkspace(), api.authStatus(), api.schwabAuthStatus()]).then(async ([saved, auth, schwabAuth]) => {
      const normalized = normalizeChartWorkspace(saved, defaultWorkspace);
      await api.setEnvironment(normalized.environment);
      await api.setJournalCommission(normalized.settings.journal.commissionPerContractSide);
      if (currentWindowId === MAIN_WINDOW_ID) {
        const mainWindow = normalized.windows.find((item) => item.id === MAIN_WINDOW_ID);
        if (mainWindow) await restoreMainWindowGeometry(mainWindow).catch(() => undefined);
      }
      setWorkspace(normalized);
      setCredentialsConfigured(auth.configured);
      setAuthenticated(auth.authenticated);
      setSchwabConfigured(schwabAuth.configured);
      setSchwabAuthenticated(schwabAuth.authenticated);
      setAccounts(currentWindowId === MAIN_WINDOW_ID && auth.authenticated ? await api.accounts().catch(() => []) : []);
      if (currentWindowId === MAIN_WINDOW_ID && api.isNative && !auth.configured && !schwabAuth.configured) setSetupOpen(true);
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
      listen<{ authenticated: boolean }>("schwab-auth-changed", ({ payload }) => {
        setSchwabAuthenticated(payload.authenticated);
        setSchwabConfigured(true);
        setSchwabAuthEpoch((value) => value + 1);
        showToast(payload.authenticated ? "Schwab connected." : "Schwab disconnected.");
      }).then((unlisten) => cleanups.push(unlisten));
      listen<string>("schwab-auth-error", ({ payload }) => showToast(payload)).then((unlisten) => cleanups.push(unlisten));
      listen<BarSnapshotEvent>("bar-snapshot", ({ payload }) => {
        const tab = workspaceRef.current.tabs.find((item) => item.id === payload.subscriptionId);
        if (acceptsWindowBarEvent(tab, payload)) {
          setTabMarkets((current) => {
            const existing = current[payload.subscriptionId];
            const base = isSameBarMarket(existing, payload.provider, payload.symbol, payload.timeframe)
              ? existing
              : emptyTabMarket(payload.provider, payload.symbol, payload.timeframe);
            return { ...current, [payload.subscriptionId]: { ...base, bars: mergeBars(base.bars, payload.bars), generation: payload.generation } };
          });
        }
        if ((payload.provider === "schwab" || payload.environment === environmentRef.current) && payload.timeframe === "1m" && vwapSymbolsRef.current.has(payload.symbol)) {
          setVwapMarkets((current) => ({ ...current, [payload.symbol]: { ...(current[payload.symbol] ?? { loadedRanges: [], pendingRanges: [] }), bars: mergeVwapBars(current[payload.symbol]?.bars ?? [], payload.bars) } }));
        }
        if (payload.provider === "schwab" || payload.environment === environmentRef.current) primeAlertMarket(payload.symbol, payload.timeframe, payload.bars, false);
      }).then((unlisten) => cleanups.push(unlisten));
      listen<BarUpdateEvent>("bar-update", ({ payload }) => {
        const tab = workspaceRef.current.tabs.find((item) => item.id === payload.subscriptionId);
        if (acceptsWindowBarEvent(tab, payload)) {
          setTabMarkets((current) => {
            const existing = current[payload.subscriptionId];
            const base = isSameBarMarket(existing, payload.provider, payload.symbol, payload.timeframe)
              ? existing
              : emptyTabMarket(payload.provider, payload.symbol, payload.timeframe);
            return { ...current, [payload.subscriptionId]: { ...base, bars: mergeBars(base.bars, [payload.bar]), generation: payload.generation } };
          });
        }
        if ((payload.provider === "schwab" || payload.environment === environmentRef.current) && payload.timeframe === "1m" && vwapSymbolsRef.current.has(payload.symbol)) {
          setVwapMarkets((current) => ({ ...current, [payload.symbol]: { ...(current[payload.symbol] ?? { loadedRanges: [], pendingRanges: [] }), bars: mergeVwapBars(current[payload.symbol]?.bars ?? [], [payload.bar]) } }));
        }
        handleAlertBarUpdate(payload);
      }).then((unlisten) => cleanups.push(unlisten));
      listen<QuoteUpdateEvent>("quote-update", ({ payload }) => {
        if (payload.provider === "tradestation" && payload.environment !== environmentRef.current) return;
        setQuotes((current) => ({ ...current, [instrumentKey(payload.quote)]: { ...payload.quote, receivedAt: Date.now() } }));
      }).then((unlisten) => cleanups.push(unlisten));
      listen<StreamStateEvent>("stream-state", ({ payload }) => {
        if (!isBarStateEvent(payload)) return;
        const tab = workspaceRef.current.tabs.find((item) => item.id === payload.subscriptionId);
        if (!acceptsWindowBarEvent(tab, payload)) return;
        setTabMarkets((current) => ({
          ...current,
          [payload.subscriptionId]: {
            ...(isSameBarMarket(current[payload.subscriptionId], payload.provider, payload.symbol, payload.timeframe)
              ? current[payload.subscriptionId]
              : emptyTabMarket(payload.provider, payload.symbol, payload.timeframe)),
            streamState: payload.state,
            streamMessage: payload.message,
            generation: payload.generation,
          },
        }));
      }).then((unlisten) => cleanups.push(unlisten));
      listen<PositionsSnapshotEvent>("positions-snapshot", ({ payload }) => {
        if (payload.accountId !== selectedAccountIdRef.current) return;
        const protectedIds = activeProtectionIds(recentPositionIdsRef.current);
        setPositions((current) => reconcilePositionSnapshot(current, payload.positions, protectedIds));
        setPositionsReadyScope(positionSnapshotScope(environmentRef.current, payload.accountId));
        setBrokerageError(undefined);
        brokerageBalanceRefreshRef.current();
      }).then((unlisten) => cleanups.push(unlisten));
      listen<PositionUpdateEvent>("position-update", ({ payload }) => {
        if (payload.accountId !== selectedAccountIdRef.current) return;
        setPositions((current) => {
          const isNew = isNewOpenPosition(current, payload.position);
          if (isNew) recentPositionIdsRef.current.set(payload.position.id, Date.now() + 10_000);
          if (payload.position.quantity === 0) recentPositionIdsRef.current.delete(payload.position.id);
          return upsertStreamPosition(current, payload.position);
        });
        brokerageBalanceRefreshRef.current();
      }).then((unlisten) => cleanups.push(unlisten));
      listen<OrdersSnapshotEvent>("orders-snapshot", ({ payload }) => {
        if (payload.accountId !== selectedAccountIdRef.current) return;
        const protectedIds = activeProtectionIds(recentOrderIdsRef.current);
        setOrders((current) => reconcileOrderSnapshot(current, payload.orders, protectedIds));
        setBrokerageError(undefined);
        brokerageBalanceRefreshRef.current();
      }).then((unlisten) => cleanups.push(unlisten));
      listen<OrderStreamUpdateEvent>("order-stream-update", ({ payload }) => {
        if (payload.accountId !== selectedAccountIdRef.current) return;
        recentOrderIdsRef.current.set(payload.order.id, Date.now() + 15_000);
        setOrders((current) => upsertStreamOrder(current, payload.order));
        if (isCompletedCloseFill(payload.order)) {
          setPositions((current) => current.filter((position) => {
            if (position.symbol !== payload.order.symbol) return true;
            recentPositionIdsRef.current.delete(position.id);
            return false;
          }));
        }
        brokerageBalanceRefreshRef.current();
        if (orderFillNeedsPositionReconciliation(payload.order) && brokerageFillReconcileTimerRef.current == null) {
          // Allow TradeStation's position view a moment to settle, then perform
          // one authoritative reconciliation for the whole burst of fill events.
          brokerageFillReconcileTimerRef.current = window.setTimeout(() => {
            brokerageFillReconcileTimerRef.current = undefined;
            brokerageRefreshRef.current();
          }, 350);
        }
      }).then((unlisten) => cleanups.push(unlisten));
      listen<BrokerageStreamStateEvent>("brokerage-stream-state", ({ payload }) => {
        if (payload.accountId !== selectedAccountIdRef.current) return;
        setBrokerageStreamStates((current) => ({ ...current, [payload.channel]: payload.state }));
      }).then((unlisten) => cleanups.push(unlisten));
    }
    listen<WorkspaceState>("workspace-sync", ({ payload }) => {
      if (payload.revision <= workspaceRef.current.revision) return;
      const next = stabilizeChartWorkspace(workspaceRef.current, normalizeChartWorkspace(payload, defaultWorkspace));
      markDetachedMarketReplacements(workspaceRef.current, next);
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
      if (currentWindowId !== MAIN_WINDOW_ID) return;
      void (async () => {
        await emitTo(payload.windowId, "workspace-sync", workspaceRef.current).catch(() => undefined);
        await emitTo(payload.windowId, "window-market-sync", marketSyncForWindow(payload.windowId)).catch(() => undefined);
        const signals = Object.entries(entryRuleTabSignalsRef.current).map(([tabId, signal]) => ({
          tabId, symbol: signal.symbol, timeframe: signal.timeframe, sides: signal.sides,
        }));
        if (signals.length) await emitTo(payload.windowId, "entry-rule-tab-signal", { action: "trigger", signals } satisfies EntryRuleTabSignalEvent).catch(() => undefined);
      })();
    }).then((unlisten) => cleanups.push(unlisten));
    listen<WindowMarketSyncEvent>("window-market-sync", ({ payload }) => {
      if (currentWindowId === MAIN_WINDOW_ID || payload.environment !== environmentRef.current) return;
      setTabMarkets((current) => {
        const next = { ...current };
        payload.markets.forEach(({ tabId, symbol, timeframe, market }) => {
          const tab = workspaceRef.current.tabs.find((item) => item.id === tabId);
          if (!tab || tab.symbol.symbol !== symbol || tab.timeframe !== timeframe || !isSameBarMarket(market, tab.symbol.provider, symbol, timeframe)) return;
          if (market.generation != null) {
            const latestGeneration = latestDetachedGenerationRef.current.get(tabId);
            const awaitingReplacement = awaitingDetachedGenerationRef.current.has(tabId);
            if (!acceptsDetachedBarGeneration(market.generation, latestGeneration, awaitingReplacement)) return;
            if (latestGeneration == null || market.generation > latestGeneration) latestDetachedGenerationRef.current.set(tabId, market.generation);
            awaitingDetachedGenerationRef.current.delete(tabId);
          }
          const existing = current[tabId];
          const matchingExisting = isSameBarMarket(existing, tab.symbol.provider, symbol, timeframe) ? existing : undefined;
          const liveStateIsNewer = matchingExisting?.generation != null && matchingExisting.generation === market.generation;
          next[tabId] = {
            ...market,
            ...(liveStateIsNewer ? { streamState: matchingExisting.streamState, streamMessage: matchingExisting.streamMessage } : {}),
            bars: mergeBars(matchingExisting?.bars ?? [], market.bars),
          };
        });
        return next;
      });
      setQuotes((current) => ({ ...current, ...payload.quotes }));
    }).then((unlisten) => cleanups.push(unlisten));
    if (api.isNative) {
      listen<EntryRuleTabSignalEvent>("entry-rule-tab-signal", ({ payload }) => applyEntryRuleTabSignal(payload))
        .then((unlisten) => cleanups.push(unlisten));
    }
    listen<StripBounds>("chart-strip-bounds", ({ payload }) => stripBoundsRef.current.set(payload.windowId, payload)).then((unlisten) => cleanups.push(unlisten));
    listen<{ tabId: string; range: { from: number; to: number } }>("chart-viewport", ({ payload }) => viewRangesRef.current.set(payload.tabId, payload.range)).then((unlisten) => cleanups.push(unlisten));
    listen<{ reason?: string }>("journal-updated", ({ payload }) => {
      if (payload.reason === "cloud-configured" || payload.reason === "cloud-disconnected") {
        setPreferenceSyncEpoch((value) => value + 1);
      }
      if (shouldRetryEntryScreenshots(payload.reason)) {
        retryEntryScreenshotsRef.current();
      }
    }).then((unlisten) => cleanups.push(unlisten));
    return () => {
      if (brokerageFillReconcileTimerRef.current != null) window.clearTimeout(brokerageFillReconcileTimerRef.current);
      brokerageFillReconcileTimerRef.current = undefined;
      entryRuleSignalTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      entryRuleSignalTimersRef.current.clear();
      entryRuleAudioTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      entryRuleAudioTimersRef.current.clear();
      cleanups.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (workspaceLoaded && currentWindowId !== MAIN_WINDOW_ID) emitTo(MAIN_WINDOW_ID, "workspace-window-ready", { windowId: currentWindowId }).catch(() => undefined);
  }, [workspaceLoaded]);

  const selectedAccount = accounts.find((account) => account.id === workspace.selectedAccountId) ?? accounts[0];
  selectedAccountIdRef.current = selectedAccount?.id;
  const entryRuleAccountId = selectedAccount?.id ?? (api.isNative ? undefined : "demo");
  const entryRulePositionScope = entryRuleAccountId ? positionSnapshotScope(environment, entryRuleAccountId) : undefined;
  const entryRulePositionsReady = !api.isNative || positionsReadyScope === entryRulePositionScope;
  const brokerageStreamsHealthy = areBrokerageStreamsHealthy(brokerageStreamStates);

  useEffect(() => {
    if (currentWindowId !== MAIN_WINDOW_ID || !api.isNative) return;
    setPositions([]);
    setPositionsReadyScope(undefined);
    recentPositionIdsRef.current.clear();
  }, [selectedAccount?.id, environment]);

  useEffect(() => {
    if (currentWindowId !== MAIN_WINDOW_ID || !selectedAccount) return;
    if (workspace.selectedAccountId !== selectedAccount.id) updateWorkspace({ selectedAccountId: selectedAccount.id });
    let active = true;
    let balanceRefreshTimer: number | undefined;
    let balanceRefreshInFlight = false;
    let lastBalanceRefreshAt = 0;
    let tradingRefreshInFlight = false;
    let tradingRefreshQueued = false;
    let tradingRefreshForceQueued = false;
    let settlementTimer: number | undefined;
    const refreshTradingState = async (force = false) => {
      if (!active) return;
      if (tradingRefreshInFlight) {
        tradingRefreshQueued = true;
        tradingRefreshForceQueued ||= force;
        return;
      }
      tradingRefreshInFlight = true;
      try {
        do {
          tradingRefreshQueued = false;
          const refreshAllResources = force || tradingRefreshForceQueued;
          tradingRefreshForceQueued = false;
          try {
            const [nextPositions, nextOrders] = await Promise.all([
              refreshAllResources || brokerageStreamStates.positions !== "streaming" ? api.positions(selectedAccount.id) : Promise.resolve(undefined),
              refreshAllResources || brokerageStreamStates.orders !== "streaming" ? api.orders(selectedAccount.id) : Promise.resolve(undefined),
            ]);
            if (active) {
              if (nextPositions) {
                const protectedIds = activeProtectionIds(recentPositionIdsRef.current);
                setPositions((current) => reconcilePositionSnapshot(current, nextPositions, protectedIds));
                setPositionsReadyScope(positionSnapshotScope(environment, selectedAccount.id));
              }
              if (nextOrders) {
                const protectedIds = activeProtectionIds(recentOrderIdsRef.current);
                setOrders((current) => reconcileOrderSnapshot(current, nextOrders, protectedIds));
              }
              setBrokerageError(undefined);
            }
          } catch (error) {
            if (active && !isManagedThrottle(error)) setBrokerageError(String(error));
          }
        } while (active && tradingRefreshQueued);
      } finally {
        tradingRefreshInFlight = false;
      }
    };
    const refreshBalances = async () => {
      if (balanceRefreshInFlight) return;
      balanceRefreshInFlight = true;
      try {
        const nextBalances = await api.balances(selectedAccount.id);
        if (active) { setBalances(nextBalances); lastBalanceRefreshAt = Date.now(); }
      } catch (error) {
        if (active && !isManagedThrottle(error)) setBrokerageError(String(error));
      } finally {
        balanceRefreshInFlight = false;
      }
    };
    const requestBalanceRefresh = () => {
      if (!active || balanceRefreshTimer != null) return;
      const delay = Math.max(0, 10_000 - (Date.now() - lastBalanceRefreshAt));
      balanceRefreshTimer = window.setTimeout(() => {
        balanceRefreshTimer = undefined;
        void refreshBalances();
      }, delay);
    };
    const scheduleSettlementRefreshes = () => {
      if (settlementTimer != null) window.clearTimeout(settlementTimer);
      settlementTimer = window.setTimeout(() => {
        settlementTimer = undefined;
        void Promise.all([refreshTradingState(true), refreshBalances()]);
      }, 2_500);
    };
    const requestBrokerageRefresh = (settle = false) => {
      if (!active) return;
      if (settle) scheduleSettlementRefreshes();
      else { void refreshTradingState(true); requestBalanceRefresh(); }
    };
    brokerageRefreshRef.current = requestBrokerageRefresh;
    brokerageBalanceRefreshRef.current = requestBalanceRefresh;
    const refreshAll = async () => {
      setBrokerageLoading(true); setBrokerageError(undefined);
      await Promise.all([refreshTradingState(true), refreshBalances()]);
      if (active) setBrokerageLoading(false);
    };
    void refreshAll();
    const tradingTimer = window.setInterval(
      () => void refreshTradingState(brokerageStreamsHealthy),
      brokeragePollInterval(brokerageStreamStates),
    );
    const accountTimer = window.setInterval(() => void refreshBalances(), 30_000);
    return () => {
      active = false;
      clearInterval(tradingTimer);
      clearInterval(accountTimer);
      if (balanceRefreshTimer != null) clearTimeout(balanceRefreshTimer);
      if (settlementTimer != null) window.clearTimeout(settlementTimer);
      if (brokerageRefreshRef.current === requestBrokerageRefresh) brokerageRefreshRef.current = () => undefined;
      if (brokerageBalanceRefreshRef.current === requestBalanceRefresh) brokerageBalanceRefreshRef.current = () => undefined;
    };
  }, [selectedAccount?.id, authEpoch, environment, brokerageStreamsHealthy]);

  const brokerageDayKey = new Date(currentTime).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  useEffect(() => {
    if (currentWindowId !== MAIN_WINDOW_ID || !selectedAccount) return;
    let active = true;
    api.bodBalances(selectedAccount.id)
      .then((next) => { if (active) setBodBalances(next); })
      .catch((error) => { if (active && !isManagedThrottle(error)) setBrokerageError(String(error)); });
    return () => { active = false; };
  }, [selectedAccount?.id, authEpoch, environment, brokerageDayKey]);

  useEffect(() => {
    if (currentWindowId !== MAIN_WINDOW_ID || !selectedAccount || !api.isNative || !authenticated) return;
    setBrokerageStreamStates({ positions: "connecting", orders: "connecting" });
    api.startBrokerageStream(selectedAccount.id).catch((error) => setBrokerageError(String(error)));
    return () => { setBrokerageStreamStates({ positions: "disconnected", orders: "disconnected" }); api.stopBrokerageStream(); };
  }, [selectedAccount?.id, authenticated, environment]);

  useEffect(() => {
    if (!workspaceLoaded) return;
    const environmentChanged = tabMarketEnvironmentRef.current !== environment;
    tabMarketEnvironmentRef.current = environment;
    const activeIds = new Set(workspace.tabs.map((tab) => tab.id));
    setTabMarkets((current) => {
      let changed = Object.keys(current).some((tabId) => !activeIds.has(tabId));
      const next: Record<string, TabMarketState> = {};
      workspace.tabs.forEach((tab) => {
        const existing = current[tab.id];
        if ((!environmentChanged || tab.symbol.provider === "schwab") && isSameBarMarket(existing, tab.symbol.provider, tab.symbol.symbol, tab.timeframe)) {
          next[tab.id] = existing;
          return;
        }
        changed ||= existing != null;
        const latestGeneration = latestDetachedGenerationRef.current.get(tab.id);
        const highWater = existing?.generation == null
          ? latestGeneration
          : latestGeneration == null ? existing.generation : Math.max(existing.generation, latestGeneration);
        if (currentWindowId !== MAIN_WINDOW_ID && highWater != null) {
          latestDetachedGenerationRef.current.set(tab.id, highWater);
          awaitingDetachedGenerationRef.current.add(tab.id);
        }
        next[tab.id] = emptyTabMarket(tab.symbol.provider, tab.symbol.symbol, tab.timeframe, currentWindowId === MAIN_WINDOW_ID ? undefined : highWater);
      });
      latestDetachedGenerationRef.current.forEach((_, tabId) => { if (!activeIds.has(tabId)) latestDetachedGenerationRef.current.delete(tabId); });
      awaitingDetachedGenerationRef.current.forEach((tabId) => { if (!activeIds.has(tabId)) awaitingDetachedGenerationRef.current.delete(tabId); });
      return changed ? next : current;
    });
  }, [tabStreamKey, environment, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID) return;
    const providerEpoch = (provider: MarketDataProvider) => provider === "schwab"
      ? `schwab:${schwabAuthEpoch}:${schwabAuthenticated}`
      : `tradestation:${authEpoch}:${environment}:${authenticated}`;
    const activeIds = new Set(workspace.tabs.map((tab) => tab.id));
    subscriptionsRef.current.forEach((subscription, tabId) => {
      const tab = workspace.tabs.find((item) => item.id === tabId);
      if (!activeIds.has(tabId) || !tab || subscription.provider !== tab.symbol.provider || subscription.symbol !== tab.symbol.symbol || subscription.timeframe !== tab.timeframe || subscription.epoch !== providerEpoch(tab.symbol.provider)) {
        if (api.isNative) void api.stopBarStream(subscription.subscriptionId, nextBarSubscriptionGeneration());
        subscriptionsRef.current.delete(tabId);
      }
    });
    workspace.tabs.forEach((tab) => {
      if (subscriptionsRef.current.has(tab.id)) return;
      const epoch = providerEpoch(tab.symbol.provider);
      const subscriptionId = tab.id;
      const generation = nextBarSubscriptionGeneration();
      const providerIsAuthenticated = tab.symbol.provider === "schwab" ? schwabAuthenticated : authenticated;
      subscriptionsRef.current.set(tab.id, { subscriptionId, provider: tab.symbol.provider, symbol: tab.symbol.symbol, timeframe: tab.timeframe, epoch, generation });
      setTabMarkets((current) => {
        const existing = isSameBarMarket(current[tab.id], tab.symbol.provider, tab.symbol.symbol, tab.timeframe)
          ? current[tab.id]
          : emptyTabMarket(tab.symbol.provider, tab.symbol.symbol, tab.timeframe, generation);
        return { ...current, [tab.id]: { ...existing, streamState: api.isNative ? providerIsAuthenticated ? "connecting" : "disconnected" : "streaming", generation } };
      });
      if (!api.isNative) {
        api.bars(tab.symbol.provider, tab.symbol.symbol, tab.timeframe).then((nextBars) => {
          if (subscriptionsRef.current.get(tab.id)?.generation !== generation) return;
          setTabMarkets((current) => ({ ...current, [tab.id]: { ...(isSameBarMarket(current[tab.id], tab.symbol.provider, tab.symbol.symbol, tab.timeframe) ? current[tab.id] : emptyTabMarket(tab.symbol.provider, tab.symbol.symbol, tab.timeframe)), bars: nextBars, generation } }));
        }).catch((error) => showToast(String(error)));
      } else if (providerIsAuthenticated) {
        api.cachedBars(tab.symbol.provider, tab.symbol.symbol, tab.timeframe).then((cached) => {
          if (subscriptionsRef.current.get(tab.id)?.generation !== generation) return;
          setTabMarkets((current) => {
            const existing = isSameBarMarket(current[tab.id], tab.symbol.provider, tab.symbol.symbol, tab.timeframe) ? current[tab.id] : emptyTabMarket(tab.symbol.provider, tab.symbol.symbol, tab.timeframe);
            return { ...current, [tab.id]: { ...existing, bars: mergeBars(cached, existing.bars), generation } };
          });
        }).catch(() => undefined);
        api.startBarStream(subscriptionId, tab.symbol.provider, tab.symbol.symbol, tab.timeframe, "chart", generation).catch((error) => {
          if (subscriptionsRef.current.get(tab.id)?.generation !== generation) return;
          setTabMarkets((current) => ({ ...current, [tab.id]: { ...(isSameBarMarket(current[tab.id], tab.symbol.provider, tab.symbol.symbol, tab.timeframe) ? current[tab.id] : emptyTabMarket(tab.symbol.provider, tab.symbol.symbol, tab.timeframe)), streamState: "disconnected", streamMessage: String(error), generation } }));
          showToast(String(error));
        });
      }
    });
  }, [tabStreamKey, authEpoch, authenticated, schwabAuthEpoch, schwabAuthenticated, environment, workspaceLoaded]);

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
    const desiredByKey = new Map(desired.map((market) => [market.key, market]));
    const desiredKeys = new Set(desired.map((market) => market.key));
    const uncovered = uncoveredAlertMarkets(workspace.tabs);
    const uncoveredKeys = new Set(uncovered.map((market) => market.key));
    const ownerKeys = new Set(workspace.tabs.flatMap((tab) => ALERT_TIMEFRAMES
      .filter((timeframe) => tab.ema200Alert[timeframe].enabled)
      .map((timeframe) => alertOwnerKey(tab, timeframe))));

    alertSubscriptionsRef.current.forEach((subscription, key) => {
      const desiredMarket = desiredByKey.get(key);
      const providerEpoch = desiredMarket?.provider === "schwab"
        ? `schwab:${schwabAuthEpoch}:${schwabAuthenticated}`
        : `tradestation:${authEpoch}:${environment}:${authenticated}`;
      if (uncoveredKeys.has(key) && subscription.epoch === providerEpoch) return;
      if (api.isNative) void api.stopBarStream(subscription.subscriptionId, nextBarSubscriptionGeneration());
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
      const marketEpoch = market.provider === "schwab"
        ? `schwab:${schwabAuthEpoch}:${schwabAuthenticated}`
        : `tradestation:${authEpoch}:${environment}:${authenticated}`;
      const existing = alertBarsRef.current.get(market.key);
      if (existing?.length) primeAlertMarket(market.symbol, market.timeframe, existing, false);
      if (alertLoadedEpochRef.current.get(market.key) === marketEpoch) return;
      alertLoadedEpochRef.current.set(market.key, marketEpoch);
      const load = api.isNative ? api.cachedBars(market.provider, market.symbol, market.timeframe) : api.bars(market.provider, market.symbol, market.timeframe);
      load.then((loaded) => {
        if (alertDesiredRef.current.has(market.key)) primeAlertMarket(market.symbol, market.timeframe, loaded, false);
      }).catch(() => undefined);
    });

    uncovered.forEach((market) => {
      const providerAuthenticated = market.provider === "schwab" ? schwabAuthenticated : authenticated;
      if (alertSubscriptionsRef.current.has(market.key) || !api.isNative || !providerAuthenticated) return;
      const marketEpoch = market.provider === "schwab"
        ? `schwab:${schwabAuthEpoch}:${schwabAuthenticated}`
        : `tradestation:${authEpoch}:${environment}:${authenticated}`;
      const subscriptionId = `ema-alert:${encodeURIComponent(market.symbol)}:${market.timeframe}`;
      const generation = nextBarSubscriptionGeneration();
      alertSubscriptionsRef.current.set(market.key, { subscriptionId, provider: market.provider, symbol: market.symbol, timeframe: market.timeframe, epoch: marketEpoch, generation });
      api.startBarStream(subscriptionId, market.provider, market.symbol, market.timeframe, "ema-alert", generation).catch((error) => {
        if (alertSubscriptionsRef.current.get(market.key)?.generation !== generation) return;
        alertSubscriptionsRef.current.delete(market.key);
        const message = `EMA alert data unavailable for ${market.symbol} ${market.timeframe}: ${String(error)}`;
        showToast(message);
        setNotifications((current) => [{ id: crypto.randomUUID(), symbol: market.symbol, time: new Date().toISOString(), title: "EMA alert stream unavailable", text: message, level: "error" as const }, ...current].slice(0, 250));
      });
    });
  }, [alertMarketsKey, alertOwnershipKey, tabStreamKey, authEpoch, authenticated, schwabAuthEpoch, schwabAuthenticated, environment, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || !entryRulePositionScope || !entryRulePositionsReady) return;
    const inputs = workspace.tabs.flatMap((tab) => {
      const tabMarket = tabMarkets[tab.id];
      const quote = quotes[instrumentKey(tab.symbol)];
      if (!isSameBarMarket(tabMarket, tab.symbol.provider, tab.symbol.symbol, tab.timeframe) || !tabMarket.bars.length || !quote) return [];
      const enabledSides = (["long", "short"] as const).filter((side) => (
        workspace.entryRuleAlerts[side].enabled && workspace.entryRules[side].children.length > 0
      ));
      if (!enabledSides.length || enabledSides.some((side) => {
        const price = side === "long" ? quote.ask : quote.bid;
        return !Number.isFinite(price) || price <= 0;
      })) return [];
      return [{
        tabId: tab.id,
        symbol: tab.symbol.symbol,
        timeframe: tab.timeframe,
        bars: tabMarket.bars,
        quote,
        hasOpenPosition: hasOpenFuturesPosition(tab.symbol, positions),
      }];
    });
    const epoch = entryRuleAlertEpoch(entryRulePositionScope, workspace.entryRules, workspace.entryRuleAlerts);
    const tracked = trackEntryRuleAlertTransitions(
      entryRuleAlertTrackerRef.current,
      epoch,
      workspace.entryRules,
      workspace.entryRuleAlerts,
      inputs,
    );
    entryRuleAlertTrackerRef.current = tracked.state;
    if (!tracked.transitions.length) return;

    queueEntryRuleAlertSounds(tracked.transitions);
    setNotifications((current) => [
      ...tracked.transitions.map((transition) => ({
        id: crypto.randomUUID(),
        symbol: transition.symbol,
        time: new Date().toISOString(),
        title: `${transition.side === "long" ? "Long" : "Short"} entry allowed · ${transition.timeframe}`,
        text: transition.reason,
        level: "success" as const,
      })),
      ...current,
    ].slice(0, 250));

    const marketSignals = new Map<string, { tabIds: Set<string>; symbol: string; timeframe: Timeframe; sides: Set<EntryRuleSide> }>();
    tracked.transitions.forEach((transition) => {
      const key = alertMarketKey(transition.symbol, transition.timeframe);
      const signal = marketSignals.get(key) ?? {
        tabIds: new Set<string>(), symbol: transition.symbol, timeframe: transition.timeframe, sides: new Set<EntryRuleSide>(),
      };
      workspace.tabs.filter((tab) => tab.symbol.symbol === transition.symbol && tab.timeframe === transition.timeframe)
        .forEach((tab) => signal.tabIds.add(tab.id));
      signal.sides.add(transition.side);
      marketSignals.set(key, signal);
    });
    broadcastEntryRuleTabSignal({
      action: "trigger",
      signals: [...marketSignals.values()].flatMap((signal) => [...signal.tabIds].map((tabId) => ({
        tabId,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        sides: [...signal.sides],
      }))),
    });
    showToast(tracked.transitions.map((transition) => (
      `${transition.symbol} ${transition.timeframe} ${transition.side === "long" ? "Long" : "Short"} entry allowed: ${transition.reason}`
    )).join(" · "));
  }, [workspaceLoaded, entryRulePositionScope, entryRulePositionsReady, tabStreamKey, workspace.entryRules, workspace.entryRuleAlerts, tabMarkets, quotes, positions]);

  useEffect(() => {
    setEntryRuleTabSignals((current) => {
      let changed = false;
      const next: Record<string, EntryRuleTabSignal> = {};
      Object.entries(current).forEach(([tabId, signal]) => {
        const tab = workspace.tabs.find((item) => item.id === tabId);
        if (!tab || tab.symbol.symbol !== signal.symbol || tab.timeframe !== signal.timeframe) {
          const timer = entryRuleSignalTimersRef.current.get(tabId);
          if (timer != null) window.clearTimeout(timer);
          entryRuleSignalTimersRef.current.delete(tabId);
          changed = true;
          return;
        }
        next[tabId] = signal;
      });
      return changed ? next : current;
    });
  }, [tabStreamKey]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID) return;
    const desired = new Set(vwapSymbolsKey.split("|").filter(Boolean));
    const sharedOneMinute = new Set(workspace.tabs.filter((tab) => tab.timeframe === "1m").map((tab) => tab.symbol.symbol));

    vwapRangeTimersRef.current.forEach((timer, symbol) => {
      if (desired.has(symbol)) return;
      window.clearTimeout(timer);
      vwapRangeTimersRef.current.delete(symbol);
    });

    vwapSubscriptionsRef.current.forEach((subscription, symbol) => {
      const epoch = subscription.provider === "schwab"
        ? `schwab:${schwabAuthEpoch}:${schwabAuthenticated}`
        : `tradestation:${authEpoch}:${environment}:${authenticated}`;
      if (!desired.has(symbol) || sharedOneMinute.has(symbol) || subscription.epoch !== epoch) {
        if (api.isNative) void api.stopBarStream(subscription.subscriptionId, nextBarSubscriptionGeneration());
        vwapSubscriptionsRef.current.delete(symbol);
      }
    });

    desired.forEach((symbol) => {
      if (sharedOneMinute.has(symbol) || vwapSubscriptionsRef.current.has(symbol)) return;
      const provider = workspace.tabs.find((tab) => tab.symbol.symbol === symbol)?.symbol.provider ?? "tradestation";
      const epoch = provider === "schwab"
        ? `schwab:${schwabAuthEpoch}:${schwabAuthenticated}`
        : `tradestation:${authEpoch}:${environment}:${authenticated}`;
      const subscriptionId = `ny-session-vwap:${symbol}`;
      const generation = nextBarSubscriptionGeneration();
      vwapSubscriptionsRef.current.set(symbol, { subscriptionId, provider, symbol, epoch, generation });
      const mergeSource = (incoming: Bar[]) => {
        if (vwapSubscriptionsRef.current.get(symbol)?.epoch !== epoch) return;
        setVwapMarkets((current) => ({
          ...current,
          [symbol]: { ...(current[symbol] ?? { loadedRanges: [], pendingRanges: [] }), bars: mergeVwapBars(current[symbol]?.bars ?? [], incoming) },
        }));
      };
      if (!api.isNative) {
        api.bars(provider, symbol, "1m").then(mergeSource).catch(() => undefined);
      } else if (provider === "schwab" ? schwabAuthenticated : authenticated) {
        api.cachedBars(provider, symbol, "1m").then(mergeSource).catch(() => undefined);
        api.startBarStream(subscriptionId, provider, symbol, "1m", "vwap", generation).catch((error) => {
          if (vwapSubscriptionsRef.current.get(symbol)?.generation !== generation) return;
          vwapSubscriptionsRef.current.delete(symbol);
          setVwapMarkets((current) => ({
            ...current,
            [symbol]: { ...(current[symbol] ?? { bars: [], loadedRanges: [], pendingRanges: [] }), error: String(error) },
          }));
        });
      }
    });
  }, [vwapSymbolsKey, tabStreamKey, authEpoch, authenticated, schwabAuthEpoch, schwabAuthenticated, environment, workspaceLoaded]);

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
    if (!workspaceLoaded || isSameBarMarket(tabMarkets[activeTab.id], activeTab.symbol.provider, activeTab.symbol.symbol, activeTab.timeframe) && tabMarkets[activeTab.id].bars.length) return;
    const tabId = activeTab.id;
    const symbol = activeTab.symbol.symbol;
    const timeframe = activeTab.timeframe;
    const provider = activeTab.symbol.provider;
    const load = api.isNative ? api.cachedBars(provider, activeTab.symbol.symbol, activeTab.timeframe) : api.bars(provider, activeTab.symbol.symbol, activeTab.timeframe);
    load.then((loadedBars) => {
      const currentTab = workspaceRef.current.tabs.find((tab) => tab.id === tabId);
      if (!currentTab || currentTab.symbol.symbol !== symbol || currentTab.timeframe !== timeframe) return;
      setTabMarkets((current) => {
        const existing = isSameBarMarket(current[tabId], provider, symbol, timeframe) ? current[tabId] : emptyTabMarket(provider, symbol, timeframe);
        return { ...current, [tabId]: { ...existing, bars: mergeBars(loadedBars, existing.bars) } };
      });
    }).catch(() => undefined);
  }, [workspaceLoaded, activeTab.id, activeTab.symbol.provider, activeTab.symbol.symbol, activeTab.timeframe]);

  useEffect(() => () => {
    vwapRangeTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    if (currentWindowId === MAIN_WINDOW_ID) {
      subscriptionsRef.current.forEach((subscription) => api.stopBarStream(subscription.subscriptionId, nextBarSubscriptionGeneration()));
      alertSubscriptionsRef.current.forEach((subscription) => api.stopBarStream(subscription.subscriptionId, nextBarSubscriptionGeneration()));
      vwapSubscriptionsRef.current.forEach((subscription) => api.stopBarStream(subscription.subscriptionId, nextBarSubscriptionGeneration()));
    }
  }, []);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || !api.isNative || !authenticated) return;
    const symbols = quoteInstruments.filter((item) => item.provider === "tradestation").map((item) => item.symbol);
    if (!symbols.length) return;
    api.startQuoteStream("shared-quotes-tradestation", "tradestation", symbols).catch((error) => showToast(String(error)));
    return () => { void api.stopQuoteStream("shared-quotes-tradestation"); };
  }, [quoteSymbolsKey, authEpoch, authenticated, environment, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || !api.isNative || !schwabAuthenticated) return;
    const symbols = quoteInstruments.filter((item) => item.provider === "schwab").map((item) => item.symbol);
    if (!symbols.length) return;
    api.startQuoteStream("shared-quotes-schwab", "schwab", symbols).catch((error) => showToast(String(error)));
    return () => { void api.stopQuoteStream("shared-quotes-schwab"); };
  }, [quoteSymbolsKey, schwabAuthEpoch, schwabAuthenticated, workspaceLoaded]);

  useEffect(() => {
    if (api.isNative) return;
    const refresh = () => Promise.all((["tradestation", "schwab"] as MarketDataProvider[]).map((provider) => {
      const symbols = quoteInstruments.filter((item) => item.provider === provider).map((item) => item.symbol);
      return symbols.length ? api.quotes(provider, symbols) : Promise.resolve([]);
    })).then((groups) => groups.flat()).then((items) => setQuotes(Object.fromEntries(items.map((quote) => [instrumentKey(quote), { ...quote, receivedAt: Date.now() }])))).catch(() => setQuotes({}));
    refresh();
    const timer = window.setInterval(refresh, api.isNative ? 3000 : 1800);
    return () => clearInterval(timer);
  }, [quoteSymbolsKey, authEpoch]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function loadVwapRange(symbol: string, range: EpochRange) {
    const provider = workspaceRef.current.tabs.find((tab) => tab.symbol.symbol === symbol)?.symbol.provider ?? "tradestation";
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
      const cached = await api.cachedBarRange(provider, symbol, "1m", range.first, range.last).catch(() => []);
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
        const edgeTolerance = 4 * 24 * 60 * 60;
        const cacheCoversPastRange = range.last < Math.floor(Date.now() / 1000) - 300
          && cached[0].time <= range.first + edgeTolerance
          && cached[cached.length - 1].time >= range.last - edgeTolerance;
        if (cacheCoversPastRange) {
          setVwapMarkets((current) => ({
            ...current,
            [symbol]: {
              ...(current[symbol] ?? { bars: [], pendingRanges: [] }),
              loadedRanges: mergeEpochRanges([...(current[symbol]?.loadedRanges ?? []), range]),
              pendingRanges: (current[symbol]?.pendingRanges ?? []).filter((item) => item.first !== range.first || item.last !== range.last),
              error: undefined,
            },
          }));
          return;
        }
      }
      const loaded = await api.barRange(provider, symbol, "1m", range.first, range.last);
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

  function requestVisibleVwap(tabId: string, range: { from: number; to: number }) {
    viewRangesRef.current.set(tabId, range);
    if (api.isNative) emit("chart-viewport", { tabId, range });
    const tab = workspaceRef.current.tabs.find((item) => item.id === tabId);
    const tabBars = tabMarketsRef.current[tabId]?.bars ?? [];
    if (!tab || tab.chartKind === "renko" || tab.chartKind === "point-and-figure" || !isIntradayTimeframe(tab.timeframe) || !tab.indicators.some((indicator) => indicator.kind === "VWAP" && indicator.visible) || !tabBars.length) return;
    const firstIndex = Math.max(0, Math.min(tabBars.length - 1, Math.floor(range.from)));
    const lastIndex = Math.max(firstIndex, Math.min(tabBars.length - 1, Math.ceil(range.to)));
    queueVwapRange(tab.symbol.symbol, tabBars[firstIndex].time, tabBars[lastIndex].time + 60);
  }

  const visibleVwapKey = visibleTabs.map((tab) => `${tab.id}:${tab.symbol.symbol}:${tab.timeframe}:${tab.chartKind}:${tab.indicators.map((indicator) => `${indicator.id}-${indicator.visible}`).join(",")}:${tabMarkets[tab.id]?.bars.length ?? 0}`).join("|");
  useEffect(() => {
    if (!workspaceLoaded) return;
    visibleTabs.forEach((tab) => {
      const tabBars = tabMarketsRef.current[tab.id]?.bars ?? [];
      if (!tabBars.length || tab.chartKind === "renko" || tab.chartKind === "point-and-figure" || !isIntradayTimeframe(tab.timeframe) || !tab.indicators.some((indicator) => indicator.kind === "VWAP" && indicator.visible)) return;
      const saved = viewRangesRef.current.get(tab.id);
      const firstIndex = saved ? Math.max(0, Math.min(tabBars.length - 1, Math.floor(saved.from))) : Math.max(0, tabBars.length - 180);
      const lastIndex = saved ? Math.max(firstIndex, Math.min(tabBars.length - 1, Math.ceil(saved.to))) : tabBars.length - 1;
      queueVwapRange(tab.symbol.symbol, tabBars[firstIndex].time, tabBars[lastIndex].time + 60);
    });
  }, [workspaceLoaded, visibleVwapKey]);

  useEffect(() => {
    if (api.isNative) return;
    setVwapMarkets((current) => {
      let changed = false;
      const next = { ...current };
      visibleTabs.forEach((tab) => {
        const tabBars = tabMarketsRef.current[tab.id]?.bars ?? [];
        if (tab.timeframe !== "1m" || !vwapSymbolsRef.current.has(tab.symbol.symbol) || !tabBars.length) return;
        next[tab.symbol.symbol] = {
          ...(next[tab.symbol.symbol] ?? { loadedRanges: [], pendingRanges: [] }),
          bars: mergeVwapBars(next[tab.symbol.symbol]?.bars ?? [], tabBars),
        };
        changed = true;
      });
      return changed ? next : current;
    });
  }, [visibleVwapKey]);

  async function loadOlder(tabId: string) {
    const tab = workspaceRef.current.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const tabMarket = tabMarketsRef.current[tabId] ?? emptyTabMarket(tab.symbol.provider, tab.symbol.symbol, tab.timeframe);
    const tabBars = tabMarket.bars;
    if (!api.isNative || tabMarket.loadingOlder || !tabMarket.hasOlder || !tabBars.length) return;
    const symbol = tab.symbol.symbol;
    const timeframe = tab.timeframe;
    const before = tabBars[0].time;
    setTabMarkets((current) => ({ ...current, [tabId]: { ...tabMarket, loadingOlder: true } }));
    try {
      const older = await api.olderBars(tab.symbol.provider, symbol, timeframe, before);
      const currentTab = workspaceRef.current.tabs.find((tab) => tab.id === tabId);
      if (!currentTab || currentTab.symbol.symbol !== symbol || currentTab.timeframe !== timeframe) return;
      setTabMarkets((current) => {
        const existing = isSameBarMarket(current[tabId], tab.symbol.provider, symbol, timeframe) ? current[tabId] : emptyTabMarket(tab.symbol.provider, symbol, timeframe);
        return { ...current, [tabId]: { ...existing, hasOlder: older.length > 0, bars: older.length ? mergeBars(older, existing.bars) : existing.bars } };
      });
    } catch (error) { showToast(String(error)); }
    finally {
      setTabMarkets((current) => isSameBarMarket(current[tabId], tab.symbol.provider, symbol, timeframe)
        ? { ...current, [tabId]: { ...current[tabId], loadingOlder: false } }
        : current);
    }
  }

  useEffect(() => {
    if (!workspaceLoaded) return;
    if (currentWindowId !== MAIN_WINDOW_ID) return;
    const timer = window.setTimeout(() => api.saveWorkspace(workspace), 250);
    return () => clearTimeout(timer);
  }, [workspace, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || !api.isNative) return;
    const timer = window.setTimeout(() => { void syncCloudPreferences(); }, 1000);
    return () => window.clearTimeout(timer);
  }, [cloudPreferenceKey, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || !api.isNative) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    void listen<PreferenceRealtimeStateEvent>("app-preferences-realtime-state", ({ payload }) => {
      if (!disposed) setPreferenceRealtime(payload);
    }).then((unlisten) => disposed ? unlisten() : cleanups.push(unlisten));
    void listen<{ category?: string; revision?: number }>("app-preferences-changed", () => {
      if (!disposed) void syncCloudPreferences();
    }).then((unlisten) => disposed ? unlisten() : cleanups.push(unlisten));
    void api.journalAuthStatus().then((auth) => {
      if (!disposed && auth.authenticated) {
        setPreferenceRealtime({ state: "connecting" });
        void api.startPreferenceRealtime().catch((error) => {
          if (!disposed) setPreferenceRealtime({ state: "reconnecting", message: String(error) });
        });
      }
    }).catch((error) => {
      if (!disposed) setPreferenceRealtime({ state: "reconnecting", message: String(error) });
    });
    return () => {
      disposed = true;
      cleanups.forEach((unlisten) => unlisten());
      void api.stopPreferenceRealtime();
    };
  }, [workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || !api.isNative) return;
    const sync = () => { void syncCloudPreferences(); };
    const focusSync = () => {
      if (Date.now() - preferenceLastSyncStartedAtRef.current < PREFERENCE_FOCUS_THROTTLE_MS) return;
      sync();
    };
    const pollInterval = preferencePollInterval(preferenceRealtime.state);
    const interval = window.setInterval(sync, pollInterval);
    window.addEventListener("focus", focusSync);
    sync();
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", focusSync);
      if (preferenceSyncRetryRef.current != null) window.clearTimeout(preferenceSyncRetryRef.current);
    };
  }, [workspaceLoaded, preferenceSyncEpoch, preferenceRealtime.state]);

  useEffect(() => {
    if (!searchOpen) return;
    if (!search.trim()) {
      setSearchResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => api.symbolSearch(search)
      .then((results) => { if (active) setSearchResults(results); })
      .catch(() => { if (active) setSearchResults([]); }), 300);
    return () => { active = false; clearTimeout(timer); };
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
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || api.isNative && !authenticated && !schwabAuthenticated) return;
    let active = true;
    const refresh = async () => {
      const instruments = [...new Map(workspaceRef.current.tabs.map((tab) => [instrumentKey(tab.symbol), tab.symbol])).values()];
      const settled = await Promise.all(instruments.map(async (instrument) => {
        if (api.isNative && (instrument.provider === "schwab" ? !schwabAuthenticated : !authenticated)) return null;
        try { return await api.symbolDetails(instrument.provider, instrument.symbol); }
        catch { return null; }
      }));
      if (!active) return;
      const details = new Map(settled.filter((item): item is SymbolMeta => Boolean(item)).map((item) => [instrumentKey(item), item]));
      if (!details.size) return;
      commitWorkspace((current) => {
        let changed = false;
        const tabs = current.tabs.map((tab) => {
          const next = details.get(instrumentKey(tab.symbol));
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
  }, [workspaceLoaded, authenticated, schwabAuthenticated, environment, authEpoch, schwabAuthEpoch, chartSymbolsKey]);

  useEffect(() => {
    if (!workspaceLoaded || api.isNative && !authenticated) return;
    let active = true;
    const symbols = tradeDetailSymbolsKey.split("|").filter(Boolean);
    if (!symbols.length) return;
    Promise.all(symbols.map(async (symbol) => {
      try { return { symbol, details: await api.symbolDetails("tradestation", symbol) }; }
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

  async function syncCloudPreferences() {
    if (!workspaceLoaded || currentWindowId !== MAIN_WINDOW_ID || !api.isNative) return;
    if (preferenceSyncInFlightRef.current) {
      preferenceSyncPendingRef.current = true;
      return;
    }
    preferenceSyncInFlightRef.current = true;
    preferenceLastSyncStartedAtRef.current = Date.now();
    preferenceSyncPendingRef.current = false;
    setPreferenceSync((current) => ({ ...current, state: "syncing", message: undefined }));
    try {
      const auth = await api.journalAuthStatus();
      if (!auth.authenticated) {
        preferenceSyncAttemptRef.current = 0;
        setPreferenceSync({ state: "idle", message: auth.configured ? "Reconnect Supabase to resume preference sync." : "Connect Supabase to sync preferences." });
        return;
      }
      const requested = cloudPreferenceProfile(workspaceRef.current);
      const result = await api.syncPreferences(requested);
      const remote = profileFromRecords(result.records);
      const current = workspaceRef.current;
      const currentProfile = cloudPreferenceProfile(current);
      const mergedProfile = cloudPreferenceProfile(current);
      let deferredLocalEdit = false;
      const eligible = new Set(result.records.flatMap((record) => {
        const category = record.category;
        if (JSON.stringify(currentProfile.categories[category]) !== JSON.stringify(requested.categories[category])) {
          deferredLocalEdit = true;
          return [];
        }
        mergedProfile.categories[category] = remote.categories[category];
        return [category];
      }));
      let mergedWorkspace = current;
      if (JSON.stringify(mergedProfile) !== JSON.stringify(currentProfile)) {
        mergedWorkspace = stabilizeChartWorkspace(current, applyCloudPreferenceProfile(current, mergedProfile));
        markDetachedMarketReplacements(current, mergedWorkspace);
        workspaceRef.current = mergedWorkspace;
        setWorkspace(mergedWorkspace);
        syncWorkspaceToOpenWindows(mergedWorkspace);
        if (mergedWorkspace.settings.journal.commissionPerContractSide !== current.settings.journal.commissionPerContractSide) {
          await api.setJournalCommission(mergedWorkspace.settings.journal.commissionPerContractSide);
        }
        if (result.replacedCategories.some((category) => eligible.has(category))) {
          showToast("Newer preferences from another computer were applied.");
        }
      }
      if (result.conflictedCategories.some((category) => eligible.has(category))) {
        showToast("Another computer synced that setting first, so its version was kept.");
      }
      if (deferredLocalEdit) {
        // The native sync may have accepted a remote row while this request was
        // in flight. Re-record the current value and immediately coalesce one
        // follow-up sync so that the user's newer local edit cannot be lost.
        await api.saveWorkspace(mergedWorkspace);
        preferenceSyncPendingRef.current = true;
      }
      preferenceSyncAttemptRef.current = 0;
      if (preferenceSyncRetryRef.current != null) window.clearTimeout(preferenceSyncRetryRef.current);
      preferenceSyncRetryRef.current = undefined;
      setPreferenceSync({ state: "synced", lastSyncedAt: result.lastSyncedAt, message: result.message });
    } catch (error) {
      const message = String(error);
      setPreferenceSync({ state: /network|connect|offline|fetch|dns/i.test(message) ? "offline" : "error", message });
      const attempt = preferenceSyncAttemptRef.current++;
      const delay = preferenceRetryDelay(attempt);
      if (preferenceSyncRetryRef.current != null) window.clearTimeout(preferenceSyncRetryRef.current);
      preferenceSyncRetryRef.current = window.setTimeout(() => { void syncCloudPreferences(); }, delay);
    } finally {
      preferenceSyncInFlightRef.current = false;
      if (preferenceSyncPendingRef.current) {
        preferenceSyncPendingRef.current = false;
        window.setTimeout(() => { void syncCloudPreferences(); }, 0);
      }
    }
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }

  function screenshotNotification(title: string, text: string, level: ActivityNotification["level"] = "warning", symbol?: string) {
    setNotifications((current) => [{ id: crypto.randomUUID(), time: new Date().toISOString(), symbol, title, text, level }, ...current].slice(0, 250));
  }

  function replaceScreenshotCandidate(id: string, update: (candidate: EntryScreenshotCandidate) => EntryScreenshotCandidate) {
    const next = entryScreenshotCandidatesRef.current.map((candidate) => candidate.id === id ? update(candidate) : candidate);
    entryScreenshotCandidatesRef.current = next;
    setEntryScreenshotCandidates(next);
  }

  function removeScreenshotCandidate(id: string) {
    const timer = screenshotRetryTimersRef.current.get(id);
    if (timer != null) window.clearTimeout(timer);
    screenshotRetryTimersRef.current.delete(id);
    screenshotCapturingRef.current.delete(id);
    screenshotUploadingRef.current.delete(id);
    const next = entryScreenshotCandidatesRef.current.filter((candidate) => candidate.id !== id);
    entryScreenshotCandidatesRef.current = next;
    setEntryScreenshotCandidates(next);
  }

  function armEntryScreenshot(draft: OrderDraft, sourceTabId: string, chartSymbol: string): string | undefined {
    if (!canArmEntryScreenshot({ environment, accountId: draft.accountId, tradeSymbol: draft.symbol }, positions, entryScreenshotCandidatesRef.current)) return undefined;
    if (entryScreenshotCandidatesRef.current.length >= ENTRY_SCREENSHOT_QUEUE_LIMIT) {
      screenshotNotification("Entry chart not queued", "The in-memory screenshot queue is full. The order will continue without blocking.", "error", draft.symbol);
      return undefined;
    }
    const id = crypto.randomUUID();
    const candidate: EntryScreenshotCandidate = { id, sourceTabId, chartSymbol, tradeSymbol: draft.symbol, accountId: draft.accountId, environment, attempts: 0 };
    const next = [...entryScreenshotCandidatesRef.current, candidate];
    entryScreenshotCandidatesRef.current = next;
    setEntryScreenshotCandidates(next);
    return id;
  }

  function acceptEntryScreenshot(id: string | undefined, brokerOrderId: string) {
    if (!id) return;
    replaceScreenshotCandidate(id, (candidate) => ({ ...candidate, brokerOrderId, acceptedAt: Date.now() }));
  }

  async function uploadEntryScreenshot(id: string) {
    const candidate = entryScreenshotCandidatesRef.current.find((item) => item.id === id);
    if (!candidate?.capture || !candidate.brokerOrderId || screenshotUploadingRef.current.has(id)) return;
    screenshotUploadingRef.current.add(id);
    try {
      await api.saveJournalEntryScreenshot({
        brokerOrderId: candidate.brokerOrderId,
        environment: candidate.environment,
        accountId: candidate.accountId,
        symbol: candidate.tradeSymbol,
        capturedAt: candidate.capture.capturedAt,
        width: candidate.capture.width,
        height: candidate.capture.height,
        dataUrl: candidate.capture.dataUrl,
      });
      removeScreenshotCandidate(id);
      screenshotNotification("Entry chart saved", "The chart is available in this trade's journal details.", "info", candidate.tradeSymbol);
    } catch (error) {
      const message = String(error);
      const attempts = candidate.attempts + 1;
      replaceScreenshotCandidate(id, (current) => ({ ...current, attempts, lastError: message }));
      const delay = entryScreenshotRetryDelay(attempts);
      if (delay != null) {
        const previous = screenshotRetryTimersRef.current.get(id);
        if (previous != null) window.clearTimeout(previous);
        screenshotRetryTimersRef.current.set(id, window.setTimeout(() => {
          screenshotRetryTimersRef.current.delete(id);
          void uploadEntryScreenshot(id);
        }, delay));
      }
      if (attempts === 1) screenshotNotification("Entry chart waiting for cloud", `${message}. The order was not affected and the image will be retried during this session.`, "warning", candidate.tradeSymbol);
      if (attempts === 4) screenshotNotification("Entry chart not uploaded", "Automatic retries are exhausted. The image remains in memory until this app session ends and will retry on focus, cloud reconnect, or manual sync.", "error", candidate.tradeSymbol);
    } finally {
      screenshotUploadingRef.current.delete(id);
    }
  }

  function retryEntryScreenshots() {
    entryScreenshotCandidatesRef.current.filter((candidate) => candidate.capture && candidate.brokerOrderId).forEach((candidate) => { void uploadEntryScreenshot(candidate.id); });
  }
  retryEntryScreenshotsRef.current = retryEntryScreenshots;

  useEffect(() => {
    const retry = () => retryEntryScreenshotsRef.current();
    window.addEventListener("focus", retry);
    return () => {
      window.removeEventListener("focus", retry);
      screenshotRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      screenshotRetryTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    entryScreenshotCandidates.forEach((candidate) => {
      const sourceTab = workspace.tabs.find((tab) => tab.id === candidate.sourceTabId);
      if (!sourceTab || sourceTab.symbol.symbol !== candidate.chartSymbol || resolveTradeSymbol(sourceTab) !== candidate.tradeSymbol) {
        screenshotNotification("Entry chart missed", "The originating chart was closed or changed before its trade lines could be captured.", "warning", candidate.tradeSymbol);
        removeScreenshotCandidate(candidate.id);
        return;
      }
      if (candidate.accountId !== selectedAccount?.id || candidate.environment !== environment) return;
      if (candidate.capture || !candidate.brokerOrderId || resolveTradeSymbol(sourceTab) !== candidate.tradeSymbol) return;
      const hasPosition = hasOpenPosition(candidate.tradeSymbol, positions);
      if (hasPosition && !candidate.positionSeen) {
        replaceScreenshotCandidate(candidate.id, (current) => ({ ...current, positionSeen: true }));
      }
      const ready = entryScreenshotLinesReady(candidate.tradeSymbol, positions, orders);
      if (!ready) {
        if (!hasPosition && candidate.positionSeen) {
          screenshotNotification("Entry chart missed", "The position closed before all three trade lines could be captured.", "warning", candidate.tradeSymbol);
          removeScreenshotCandidate(candidate.id);
        } else if (!hasPosition && candidate.acceptedAt != null && currentTime - candidate.acceptedAt > 30_000) {
          screenshotNotification("Entry chart missed", "The position closed or never reached the chart before all three trade lines were available.", "warning", candidate.tradeSymbol);
          removeScreenshotCandidate(candidate.id);
        }
        return;
      }
      const chartCapture = chartCaptureRefs.current.get(candidate.sourceTabId);
      if (!chartCapture || screenshotCapturingRef.current.has(candidate.id)) return;
      screenshotCapturingRef.current.add(candidate.id);
      void chartCapture.captureEntryScreenshot().then((capture) => {
        replaceScreenshotCandidate(candidate.id, (current) => ({ ...current, capture }));
        void uploadEntryScreenshot(candidate.id);
      }).catch((error) => {
        if (!String(error).includes("Waiting for the position")) {
          screenshotNotification("Entry chart capture failed", `${String(error)} The order was not affected.`, "error", candidate.tradeSymbol);
          removeScreenshotCandidate(candidate.id);
        }
      }).finally(() => screenshotCapturingRef.current.delete(candidate.id));
    });
  }, [entryScreenshotCandidates, workspace.tabs, visibleTabIds.join("|"), selectedAccount?.id, environment, positions, orders, currentTime]);

  function commitWorkspace(update: (current: WorkspaceState) => WorkspaceState) {
    setWorkspace((current) => {
      const next = currentWindowId === MAIN_WINDOW_ID
        ? { ...update(current), revision: Math.max(current.revision + 1, Date.now()) }
        : update(current);
      markDetachedMarketReplacements(current, next);
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

  function updateOrderTicketSettings(patch: Partial<OrderTicketSettings>) {
    commitWorkspace((current) => ({
      ...current,
      settings: {
        ...current.settings,
        orderTicket: { ...current.settings.orderTicket, ...patch },
      },
    }));
  }

  function updateTab(tabId: string, patch: Partial<ChartTabState>) {
    commitWorkspace((current) => ({ ...current, tabs: current.tabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab) }));
  }

  function updateActiveTab(patch: Partial<ChartTabState>) {
    updateTab(activeTab.id, patch);
  }

  function updateChartStyle(chartKind: ChartKind) {
    viewRangesRef.current.delete(activeTab.id);
    updateActiveTab({ chartKind });
    if (chartKind !== "renko" && chartKind !== "point-and-figure") setChartStyleOpen(false);
  }

  function updateRenkoSettings(patch: Partial<ChartTabState["renkoSettings"]>) {
    viewRangesRef.current.delete(activeTab.id);
    updateActiveTab({ renkoSettings: normalizeRenkoSettings({ ...activeTab.renkoSettings, ...patch }) });
  }

  function updatePointAndFigureSettings(patch: Partial<ChartTabState["pointAndFigureSettings"]>) {
    viewRangesRef.current.delete(activeTab.id);
    updateActiveTab({ pointAndFigureSettings: normalizePointAndFigureSettings({ ...activeTab.pointAndFigureSettings, ...patch }) });
  }

  async function selectWatchlistSymbol(instrument: SymbolMeta) {
    selectSymbol(instrument);
  }

  function selectSymbol(instrument: SymbolMeta) {
    const tabId = activeTab.id;
    commitWorkspace((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => tab.id === tabId ? { ...tab, symbol: instrument, tradeContract: undefined } : tab),
      recentSymbols: rememberRecentSymbol(current.recentSymbols, instrument),
    }));
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
    broadcastEntryRuleTabSignal({ action: "acknowledge", tabIds: [tabId] });
    commitWorkspace((current) => focusChartTab(current, currentWindowId, tabId));
  }

  function addTab() {
    if (workspace.tabs.length >= MAX_CHART_TABS) return showToast(`A maximum of ${MAX_CHART_TABS} chart tabs is supported.`);
    const id = `chart-${crypto.randomUUID()}`;
    commitWorkspace((current) => focusChartTab({
      ...current,
      tabs: [...current.tabs, cloneChartTab(activeTab, id)],
      windows: current.windows.map((item) => item.id === currentWindowId ? { ...item, tabIds: [...item.tabIds, id] } : item),
    }, currentWindowId, id));
  }

  function changeChartLayout(layout: ChartLayout) {
    const required = Math.max(0, chartLayoutCapacity(layout) - windowState.tabIds.length);
    if (workspace.tabs.length + required > MAX_CHART_TABS) return showToast(`This layout needs ${required} more chart tab${required === 1 ? "" : "s"}; the ${MAX_CHART_TABS}-tab limit has been reached.`);
    commitWorkspace((current) => setChartWindowLayout(current, currentWindowId, layout));
    setChartLayoutOpen(false);
  }

  function changeChartSplitRatios(ratios: number[]) {
    commitWorkspace((current) => setChartWindowSplitRatio(current, currentWindowId, chartLayout, ratios));
  }

  async function closeTab(tabId: string) {
    if (workspace.tabs.length === 1) return;
    const ownerBefore = workspaceRef.current.windows.find((item) => item.tabIds.includes(tabId));
    const removedWindow = ownerBefore?.id !== MAIN_WINDOW_ID && ownerBefore?.tabIds.length === 1 ? ownerBefore.id : undefined;
    commitWorkspace((current) => {
      const next = structuredClone(current);
      next.tabs = next.tabs.filter((tab) => tab.id !== tabId);
      const owner = next.windows.find((item) => item.tabIds.includes(tabId));
      if (!owner) return current;
      const index = owner.tabIds.indexOf(tabId);
      owner.tabIds.splice(index, 1);
      if (!owner.tabIds.length) {
        if (owner.id !== MAIN_WINDOW_ID) {
          next.windows = next.windows.filter((item) => item.id !== owner.id);
        }
      }
      if (!owner.tabIds.includes(owner.activeTabId)) owner.activeTabId = owner.tabIds[Math.min(index, owner.tabIds.length - 1)] ?? "";
      const validTabIds = next.tabs.map((tab) => tab.id);
      next.windows = next.windows.map((window) => reconcileChartWindow(window, validTabIds));
      return next;
    });
    if (removedWindow && api.isNative && currentWindowId === MAIN_WINDOW_ID) {
      (await WebviewWindow.getByLabel(removedWindow))?.destroy();
    }
  }

  function reorderTab(tabId: string, targetIndex: number) {
    commitWorkspace((current) => moveTab(current, tabId, currentWindowId, targetIndex));
  }

  async function ensureDetachedWindow(state: ChartWindowState) {
    if (!api.isNative || !state.detached || !claimDetachedWindowCreation(detachedWindowCreationsRef.current, state.id)) return;
    const existing = await WebviewWindow.getByLabel(state.id).catch(() => null);
    if (existing) {
      detachedWindowCreationsRef.current.delete(state.id);
      return;
    }
    let monitors;
    try {
      monitors = await availableMonitors();
    } catch (error) {
      detachedWindowCreationsRef.current.delete(state.id);
      showToast(`Could not inspect displays for detached chart: ${String(error)}`);
      return;
    }
    const screens = monitors.map((monitor) => ({ x: monitor.position.x / monitor.scaleFactor, y: monitor.position.y / monitor.scaleFactor, width: monitor.size.width / monitor.scaleFactor, height: monitor.size.height / monitor.scaleFactor }));
    const physicalScreens = monitors.map((monitor) => ({ x: monitor.workArea.position.x, y: monitor.workArea.position.y, width: monitor.workArea.size.width, height: monitor.workArea.size.height }));
    const savedPhysical = savedPhysicalWindowGeometry(state);
    const physicalGeometry = savedPhysical ? clampWindowGeometry(savedPhysical, physicalScreens) : undefined;
    const targetMonitor = physicalGeometry && monitors.find((monitor) => physicalGeometry.x < monitor.position.x + monitor.size.width
      && physicalGeometry.x + physicalGeometry.width > monitor.position.x
      && physicalGeometry.y < monitor.position.y + monitor.size.height
      && physicalGeometry.y + 40 > monitor.position.y);
    const targetScale = targetMonitor?.scaleFactor ?? 1;
    const geometry = physicalGeometry
      ? { x: physicalGeometry.x / targetScale, y: physicalGeometry.y / targetScale, width: physicalGeometry.width / targetScale, height: physicalGeometry.height / targetScale }
      : clampWindowGeometry({ x: state.x ?? screens[0]?.x ?? 0, y: state.y ?? screens[0]?.y ?? 0, width: state.width ?? 1100, height: state.height ?? 760 }, screens);
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
      visible: false,
    });
    view.once("tauri://created", async () => {
      detachedWindowCreationsRef.current.delete(state.id);
      const liveState = workspaceRef.current.windows.find((item) => item.id === state.id && item.detached);
      if (!liveState) {
        await view.destroy().catch(() => undefined);
        return;
      }
      try {
        if (physicalGeometry) {
          await view.setSize(new PhysicalSize(physicalGeometry.width, physicalGeometry.height));
          await view.setPosition(new PhysicalPosition(physicalGeometry.x, physicalGeometry.y));
        }
        await view.show();
      } catch (error) {
        await view.destroy().catch(() => undefined);
        showToast(`Could not show detached chart: ${String(error)}`);
        return;
      }
      await emitTo(state.id, "workspace-sync", workspaceRef.current).catch(() => undefined);
      liveState.tabIds.forEach((tabId) => {
        const range = viewRangesRef.current.get(tabId);
        if (range) emit("chart-viewport", { tabId, range });
      });
    });
    view.once("tauri://error", ({ payload }) => {
      detachedWindowCreationsRef.current.delete(state.id);
      showToast(`Could not detach chart: ${String(payload)}`);
    });
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
    // Detached windows only propose workspace changes. The main window is the
    // sole native-window creator and will also reconcile the emptied source.
    if (detachedState && currentWindowId === MAIN_WINDOW_ID) await ensureDetachedWindow(detachedState);
    if (currentWindowId === MAIN_WINDOW_ID && source.id !== MAIN_WINDOW_ID && source.tabIds.length === 1) {
      (await WebviewWindow.getByLabel(source.id))?.destroy();
    }
  }

  async function finishTabDrag(tabId: string) {
    if (!api.isNative) return;
    const point = await cursorPosition();
    const targetBounds = [...stripBoundsRef.current.values()].find((bounds) => point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom);
    if (!targetBounds) return detachTab(tabId);
    const targetWindow = workspaceRef.current.windows.find((item) => item.id === targetBounds.windowId);
    if (!targetWindow) return detachTab(tabId);
    const index = tabInsertionIndex(point.x, targetBounds.left, targetBounds.right, targetWindow.tabIds.length);
    const sourceWindowToClose = detachedSourceWindowToClose(workspaceRef.current, tabId, targetBounds.windowId);
    commitWorkspace((current) => moveTab(current, tabId, targetBounds.windowId, index));
    if (sourceWindowToClose && currentWindowId === MAIN_WINDOW_ID) {
      (await WebviewWindow.getByLabel(sourceWindowToClose))?.destroy();
    }
  }

  useEffect(() => {
    if (!workspaceLoaded || !api.isNative || currentWindowId !== MAIN_WINDOW_ID) return;
    workspace.windows.filter((item) => item.detached).forEach((item) => void ensureDetachedWindow(item));
    void getAllWindows().then((windows) => {
      const staleIds = new Set(staleDetachedWindowIds(windows.map((item) => item.label), workspace.windows));
      return Promise.all(windows.filter((item) => staleIds.has(item.label)).map((item) => item.destroy().catch(() => undefined)));
    }).catch(() => undefined);
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
        const savedWindows = await Promise.all(windows.map(async (item) => {
          const state = workspaceRef.current.windows.find((window) => window.id === item.label);
          if (!state) return undefined;
          const [position, size, scale, maximized] = await Promise.all([item.outerPosition(), item.innerSize(), item.scaleFactor(), item.isMaximized()]);
          return rememberWindowGeometry(state, { x: position.x, y: position.y, width: size.width, height: size.height }, scale, maximized);
        }));
        const geometryById = new Map(savedWindows.filter((item): item is ChartWindowState => item != null).map((item) => [item.id, item]));
        if (geometryById.size) {
          const next = {
            ...workspaceRef.current,
            revision: Math.max(workspaceRef.current.revision + 1, Date.now()),
            windows: workspaceRef.current.windows.map((item) => geometryById.get(item.id) ?? item),
          };
          workspaceRef.current = next;
          await api.saveWorkspace(next).catch(() => undefined);
        }
        await Promise.all(windows.filter((item) => item.label !== MAIN_WINDOW_ID).map((item) => item.destroy()));
      } else {
        const next = closeDetachedWindow(workspaceRef.current, currentWindowId);
        workspaceRef.current = next;
        await emitTo(MAIN_WINDOW_ID, "workspace-proposal", next).catch(() => undefined);
      }
      await current.destroy();
    }).then((unlisten) => cleanups.push(unlisten));
    const saveGeometry = () => {
      window.clearTimeout(geometryTimer);
      window.clearTimeout(dockTimer);
      geometryTimer = window.setTimeout(async () => {
        const [position, size, scale, maximized] = await Promise.all([current.outerPosition(), current.innerSize(), current.scaleFactor(), current.isMaximized()]);
        commitWorkspace((workspace) => ({ ...workspace, windows: workspace.windows.map((item) => item.id === currentWindowId ? rememberWindowGeometry(item, { x: position.x, y: position.y, width: size.width, height: size.height }, scale, maximized) : item) }));
      }, 250);
      if (currentWindowId === MAIN_WINDOW_ID) return;
      dockTimer = window.setTimeout(async () => {
        const point = await cursorPosition();
        const bounds = [...stripBoundsRef.current.values()].find((item) => item.windowId !== currentWindowId && point.x >= item.left && point.x <= item.right && point.y >= item.top && point.y <= item.bottom);
        const source = workspaceRef.current.windows.find((item) => item.id === currentWindowId);
        const target = bounds && workspaceRef.current.windows.find((item) => item.id === bounds.windowId);
        if (!bounds || !source || !target) return;
        const insertion = tabInsertionIndex(point.x, bounds.left, bounds.right, target.tabIds.length);
        const movingIds = [...source.tabIds];
        const next = movingIds.reduce((workspace, tabId, offset) => moveTab(workspace, tabId, target.id, insertion + offset), workspaceRef.current);
        workspaceRef.current = next;
        setWorkspace(next);
        closing = true;
        await emitTo(MAIN_WINDOW_ID, "workspace-proposal", next).catch(() => undefined);
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

  function updateJournalCommission(value: number) {
    const commissionPerContractSide = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
    commitWorkspace((current) => ({
      ...current,
      settings: {
        ...current.settings,
        journal: { commissionPerContractSide },
      },
    }));
    void api.setJournalCommission(commissionPerContractSide).catch((error) => showToast(String(error)));
  }

  async function openTradeJournal() {
    if (!api.isNative) {
      window.open("/?view=journal", "northstar-trade-journal", "width=1280,height=800");
      return;
    }
    try {
      const existing = await WebviewWindow.getByLabel("trade-journal");
      if (existing) {
        await existing.show();
        await existing.unminimize();
        await existing.setFocus();
        return;
      }
      const journal = new WebviewWindow("trade-journal", {
        url: "/?view=journal", title: "Northstar Trade Journal", width: 1280, height: 800,
        minWidth: 960, minHeight: 640, center: true, resizable: true, decorations: true,
      });
      journal.once("tauri://error", (event) => showToast(`Could not open Trade Journal: ${String(event.payload)}`));
    } catch (error) { showToast(`Could not open Trade Journal: ${String(error)}`); }
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

  async function saveSchwabApiCredentials() {
    if (!schwabClientId.trim() || !schwabSecret.trim()) return showToast("Schwab App Key and App Secret are required.");
    setBusy(true);
    try {
      await api.saveSchwabCredentials(schwabClientId.trim(), schwabSecret);
      setSchwabConfigured(true);
      setSchwabAuthenticated(false);
      setSchwabSecret("");
      showToast("Schwab credentials saved. Connect to authorize market data.");
    } catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  async function connectSchwab() {
    if (!schwabConfigured) return showToast("Save Schwab credentials before connecting.");
    setBusy(true);
    try { await api.beginSchwabLogin(); }
    catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  async function disconnectSchwab() {
    setBusy(true);
    try {
      await api.logoutSchwab();
      setSchwabAuthenticated(false);
      setSchwabAuthEpoch((value) => value + 1);
      showToast("Schwab disconnected. Cached equity charts remain available.");
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
    const sourceQuote = quotes[instrumentKey(tab.symbol)] ?? (api.isNative
      ? { provider: tab.symbol.provider, symbol: tab.symbol.symbol, last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" }
      : quoteFor(tab.symbol.symbol, 0, tab.symbol.provider));
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
    const screenshotCandidateId = armEntryScreenshot(draft, sourceTabId, chartSymbol);
    setBusy(true);
    try {
      const update = await api.placeOrder(draft);
      if (["Working", "Filled", "Pending"].includes(update.status)) acceptEntryScreenshot(screenshotCandidateId, update.id);
      else if (screenshotCandidateId) removeScreenshotCandidate(screenshotCandidateId);
      recentOrderIdsRef.current.set(update.id, Date.now() + 15_000);
      setOrders((current) => upsertStreamOrder(current, update));
      brokerageRefreshRef.current(true);
      if (["Working", "Filled", "Pending"].includes(update.status)) clearSubmittedEntry(draft.symbol);
      showToast(`Order ${update.status.toLowerCase()}: ${update.id}`);
    } catch (error) {
      if (screenshotCandidateId) removeScreenshotCandidate(screenshotCandidateId);
      showToast(String(error));
    }
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
    // The post-close snapshot must be allowed to remove this position. Ordinary
    // P&L ticks must not extend the new-position reconciliation grace period.
    recentPositionIdsRef.current.delete(positionId);
    const previousTimer = closingPositionTimersRef.current.get(positionId);
    if (previousTimer != null) window.clearTimeout(previousTimer);
    closingPositionTimersRef.current.delete(positionId);
    setClosingPositionIds((current) => new Set(current).add(positionId));
    let waitForFill = false;
    try {
      const result = await api.closePosition(selectedAccount.id, positionId);
      brokerageRefreshRef.current(true);
      if (result.error) {
        setNotifications((current) => [{ id: crypto.randomUUID(), time: new Date().toISOString(), symbol: result.symbol, title: "Position close aborted", text: result.error!, level: "error" as const }, ...current].slice(0, 250));
        showToast(result.error);
        return;
      }
      if (!result.flattenOrder) setPositions((current) => current.filter((position) => position.id !== positionId));
      if (result.flattenOrder) {
        waitForFill = true;
        recentOrderIdsRef.current.set(result.flattenOrder.id, Date.now() + 15_000);
        setOrders((current) => upsertStreamOrder(current, result.flattenOrder!));
        const timer = window.setTimeout(() => {
          closingPositionTimersRef.current.delete(positionId);
          setClosingPositionIds((current) => { const next = new Set(current); next.delete(positionId); return next; });
        }, 5_000);
        closingPositionTimersRef.current.set(positionId, timer);
      }
      const convertedProtectiveOrder = result.flattenOrder?.rawStatus === "ReplacePending";
      setNotifications((current) => [{
        id: crypto.randomUUID(), time: new Date().toISOString(), symbol: result.symbol,
        title: result.flattenOrder ? "Position close sent" : "Position already closed",
        text: result.flattenOrder
          ? convertedProtectiveOrder
            ? `${result.flattenOrder.side} ${result.flattenOrder.quantity} ${result.symbol} at market by converting the protective exit; TradeStation will cancel ${result.cancelledOrderIds.length} linked exit order${result.cancelledOrderIds.length === 1 ? "" : "s"} through the bracket.`
            : `${result.flattenOrder.side} ${result.flattenOrder.quantity} ${result.symbol} at market after cancelling ${result.cancelledOrderIds.length} exit order${result.cancelledOrderIds.length === 1 ? "" : "s"}.`
          : `${result.symbol} closed before another flatten order was needed.`,
        level: "warning" as const,
      }, ...current].slice(0, 250));
      showToast(result.flattenOrder ? `Close order sent for ${result.symbol}.` : `${result.symbol} is already closed.`);
    } catch (error) {
      const message = String(error);
      if (message.toLowerCase().includes("position is no longer open")) {
        setPositions((current) => current.filter((position) => position.id !== positionId));
      }
      showToast(message);
    }
    finally {
      if (!waitForFill) {
        const timer = closingPositionTimersRef.current.get(positionId);
        if (timer != null) window.clearTimeout(timer);
        closingPositionTimersRef.current.delete(positionId);
        setClosingPositionIds((current) => { const next = new Set(current); next.delete(positionId); return next; });
      }
    }
  }

  useEffect(() => {
    const openPositionIds = new Set(positions.map((position) => position.id));
    setClosingPositionIds((current) => {
      const completed = [...current].filter((positionId) => !openPositionIds.has(positionId));
      if (!completed.length) return current;
      const next = new Set(current);
      completed.forEach((positionId) => {
        next.delete(positionId);
        const timer = closingPositionTimersRef.current.get(positionId);
        if (timer != null) window.clearTimeout(timer);
        closingPositionTimersRef.current.delete(positionId);
      });
      return next;
    });
  }, [positions]);

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
    const screenshotCandidateId = armEntryScreenshot(review.draft, review.sourceTabId, review.chartSymbol);
    setBusy(true);
    try {
      const update = await api.placeOrder(review.draft);
      if (["Working", "Filled", "Pending"].includes(update.status)) acceptEntryScreenshot(screenshotCandidateId, update.id);
      else if (screenshotCandidateId) removeScreenshotCandidate(screenshotCandidateId);
      recentOrderIdsRef.current.set(update.id, Date.now() + 15_000);
      setOrders((current) => upsertStreamOrder(current, update));
      brokerageRefreshRef.current(true);
      if (["Working", "Filled", "Pending"].includes(update.status)) clearSubmittedEntry(review.draft.symbol);
      setReview(null);
      showToast(`Order ${update.status.toLowerCase()}: ${update.id}`);
    } catch (error) {
      if (screenshotCandidateId) removeScreenshotCandidate(screenshotCandidateId);
      showToast(String(error));
    }
    finally { setBusy(false); }
  }

  const activeProviderConnected = activeTab.symbol.provider === "schwab" ? schwabAuthenticated : authenticated;
  const providerLabel = activeTab.symbol.provider === "schwab" ? "SCHWAB" : "TRADESTATION";
  const connectionLabel = api.isNative ? (activeProviderConnected ? `${providerLabel} ${market.streamState === "rate-limited" ? "PAUSED" : market.streamState.toUpperCase()}` : `${providerLabel} OFFLINE`) : `${providerLabel} DEMO`;
  const symbolPickerResults = search.trim() ? searchResults : workspace.recentSymbols;
  const brokerageConnectionState = brokerageDisplayState(brokerageStreamStates);
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

  const activeOrderProjection = !isDetached && workspace.rightPanelOpen
    && orderProjection && orderProjection.tradeSymbol === activeTradeSymbol ? orderProjection : undefined;
  const activeOrderTicketResetEpoch = activeTradeSymbol ? orderTicketResetEpochs[activeTradeSymbol] ?? 0 : 0;
  const projectedEntryPrice = (projection: OrderProjection) => (projection.side ?? "Buy") === "Buy" ? activeTradeQuote.ask : activeTradeQuote.bid;
  const editProjectedExit = (field: ProjectedExitField, price: number) => setOrderProjection((current) => {
    if (!current || current.tradeSymbol !== activeTradeSymbol) return current;
    const next = applyProjectedExitEdit(current, field, price, projectedEntryPrice(current), activeOrderMinMove);
    return { ...next, tradeSymbol: current.tradeSymbol };
  });
  const restoreOrderProjection = (projection: OrderProjection) => setOrderProjection({ ...projection, tradeSymbol: activeTradeSymbol });
  const replaceOrderProjection = (projection: OrderProjection) => {
    const next = recalculateOrderProjectionAtR(projection, projectedEntryPrice(projection), activeOrderMinMove);
    setOrderProjection({ ...next, tradeSymbol: activeTradeSymbol });
  };

  function renderChartPane(tab: ChartTabState) {
    const tabMarket = isSameBarMarket(tabMarkets[tab.id], tab.symbol.provider, tab.symbol.symbol, tab.timeframe)
      ? tabMarkets[tab.id]
      : emptyTabMarket(tab.symbol.provider, tab.symbol.symbol, tab.timeframe);
    const tabTradeSymbol = resolveTradeSymbol(tab);
    const tabTradeMeta = isContinuousFuture(tab.symbol)
      ? tabTradeSymbol ? tradeDetails[tabTradeSymbol] : undefined
      : tab.symbol;
    const tabQuoteSymbol = tabTradeSymbol ?? tab.symbol.symbol;
    const tabTradeQuote = quotes[`${tab.symbol.provider}:${tabQuoteSymbol}`] ?? (api.isNative
      ? { provider: tab.symbol.provider, symbol: tabQuoteSymbol, last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" }
      : quoteFor(tabQuoteSymbol, 0, tab.symbol.provider));
    const focused = tab.id === activeTab.id;
    return <TradingChart
      ref={(handle) => { if (handle) chartCaptureRefs.current.set(tab.id, handle); else chartCaptureRefs.current.delete(tab.id); }}
      bars={tabMarket.bars}
      vwapBars={vwapMarkets[tab.symbol.symbol]?.bars ?? []}
      kind={tab.chartKind}
      renkoSettings={tab.renkoSettings}
      pointAndFigureSettings={tab.pointAndFigureSettings}
      magnetEnabled={tab.magnetEnabled}
      symbol={tab.symbol.symbol}
      tradeSymbol={tabTradeSymbol}
      description={tab.symbol.description}
      exchange={tab.symbol.exchange}
      minMove={tab.symbol.minMove}
      pointValue={tabTradeMeta?.pointValue ?? tab.symbol.pointValue}
      currentPrice={tabTradeQuote.last}
      projectedEntryPrice={focused && activeOrderProjection ? projectedEntryPrice(activeOrderProjection) : undefined}
      chartLabelSettings={workspace.settings.chartLabels}
      timeframe={tab.timeframe}
      indicators={tab.indicators}
      orders={orders}
      positions={positions}
      orderProjection={focused ? activeOrderProjection : undefined}
      onOrderProjectionChange={editProjectedExit}
      onOrderProjectionRestore={restoreOrderProjection}
      closingPositionIds={closingPositionIds}
      replacingOrderIds={replacingOrderIds}
      onClosePosition={requestClosePosition}
      onReplaceOrder={replaceChartOrder}
      timezone={tab.chartTimezone}
      activeTool={focused ? activeTool : "cursor"}
      drawings={workspace.drawings[tab.symbol.symbol] ?? []}
      onToolComplete={() => { if (focused) setActiveTool("cursor"); }}
      onCreateDrawing={(drawing) => updateSymbolDrawings(tab.symbol.symbol, (items) => [...items, drawing])}
      onUpdateDrawing={(id, patch) => updateSymbolDrawings(tab.symbol.symbol, (items) => items.map((item) => item.id === id ? { ...item, ...patch } as Drawing : item))}
      onDeleteDrawing={(id) => updateSymbolDrawings(tab.symbol.symbol, (items) => items.filter((item) => item.id !== id))}
      initialVisibleRange={viewRangesRef.current.get(tab.id)}
      onVisibleRangeChange={(range) => requestVisibleVwap(tab.id, range)}
      onTimezoneChange={(chartTimezone) => updateTab(tab.id, { chartTimezone })}
      onLoadOlder={() => loadOlder(tab.id)}
      loadingOlder={tabMarket.loadingOlder}
    />;
  }

  return <main className={`app-shell ${isDetached ? "detached-shell" : ""}`}>
    <header className="titlebar">
      <div className="brand"><div className="brand-glyph"><TrendingUp size={16} strokeWidth={2.4} /></div><span>NORTHSTAR</span><small>TRADER</small></div>
      {hasWindowTabs && <TopbarWatchlist symbols={workspace.watchlist} quotes={quotes} active={instrumentKey(activeTab.symbol)} onSelect={selectWatchlistSymbol} />}
      <div className="titlebar-drag" data-tauri-drag-region />
      {!isDetached && <div className="market-clock" aria-label={`New York market time ${marketTime}`} title="New York market time"><span>NY</span><time>{marketTime}</time></div>}
      {!isDetached && <button className={`environment-badge ${environment}`} title="TradeStation futures environment" onClick={() => setEnvConfirm(environment === "sim" ? "live" : "sim")}><span />{environment.toUpperCase()}<ChevronDown size={13} /></button>}
      <button className={`connection-chip ${market.streamState}`} title={market.streamMessage ?? `Chart data ${connectionLabel.toLowerCase()}`} onClick={() => activeTab.symbol.provider === "schwab" ? setSettingsOpen(true) : setSetupOpen(true)}><Wifi size={13} /><span>{connectionLabel}</span></button>
    </header>

    <ChartTabStrip tabs={windowState.tabIds.map((id) => workspace.tabs.find((tab) => tab.id === id)).filter((tab): tab is ChartTabState => Boolean(tab))} activeTabId={windowState.activeTabId} visibleTabIds={visibleTabIds} totalTabs={workspace.tabs.length} windowId={currentWindowId} ema200Positions={ema200Positions} entryRuleSignals={entryRuleTabSignals} onSelect={selectTab} onAdd={addTab} onClose={closeTab} onReorder={reorderTab} onDragEnd={finishTabDrag} onBounds={(bounds) => { stripBoundsRef.current.set(currentWindowId, bounds); if (api.isNative) emit("chart-strip-bounds", bounds); }} />

    <nav className={`toolbar ${hasWindowTabs ? "" : "empty"}`} aria-label="Chart toolbar">
      <button className="symbol-control" onClick={() => { setSearch(""); setSearchOpen(true); }}><Search size={16} /><strong>{activeTab.symbol.symbol}</strong><span>{activeTab.symbol.exchange}</span><ChevronDown size={14} /></button>
      <div className="divider" />
      <div className="timeframe-group">{timeframes.map((tf) => <button key={tf} className={activeTab.timeframe === tf ? "active" : ""} onClick={() => updateActiveTab({ timeframe: tf })}>{tf}</button>)}</div>
      <div className="divider" />
      <div className="toolbar-popover-anchor chart-layout-anchor">
        <IconButton label="Chart layout" active={chartLayoutOpen || chartLayout !== "single"} onClick={() => { setIndicatorOpen(false); setChartStyleOpen(false); setAlertOpen(false); setChartLayoutOpen((value) => !value); }}><PanelsTopLeft size={17} /></IconButton>
        {chartLayoutOpen && <><button className="popover-backdrop" aria-label="Close chart layout menu" onClick={() => setChartLayoutOpen(false)} /><div className="popover chart-layout-popover" role="menu" aria-label="Chart layout">
          <header><strong>Chart layout</strong><span>{visibleTabs.length} visible</span></header>
          <div className="chart-layout-list">{chartLayouts.map((item) => {
            const missing = Math.max(0, chartLayoutCapacity(item.layout) - windowState.tabIds.length);
            const unavailable = workspace.tabs.length + missing > MAX_CHART_TABS;
            return <button key={item.layout} type="button" role="menuitemradio" aria-checked={chartLayout === item.layout} disabled={unavailable} title={unavailable ? `Needs ${missing} more tabs; maximum ${MAX_CHART_TABS}` : item.label} onClick={() => changeChartLayout(item.layout)}><ChartLayoutGlyph layout={item.layout} /><span>{item.label}</span>{chartLayout === item.layout && <i />}</button>;
          })}</div>
          <small className="chart-layout-hint">Drag dividers to resize · double-click to reset</small>
        </div></>}
      </div>
      <div className="toolbar-popover-anchor chart-style-anchor">
        <button className={`text-tool-button chart-style-button ${chartStyleOpen ? "active" : ""}`} aria-haspopup="menu" aria-expanded={chartStyleOpen} onClick={() => { setIndicatorOpen(false); setAlertOpen(false); setChartLayoutOpen(false); setChartStyleOpen((value) => !value); }}><ChartStyleGlyph kind={activeTab.chartKind} /><span>{chartStyles.find((style) => style.kind === activeTab.chartKind)?.label}</span><ChevronDown size={13} /></button>
        {chartStyleOpen && <><button className="popover-backdrop" aria-label="Close chart style menu" onClick={() => setChartStyleOpen(false)} /><div className="popover chart-style-popover" role="menu" aria-label="Chart style">
          <header><strong>Chart style</strong><span>Per tab</span></header>
          <div className="chart-style-list">{chartStyles.map((style) => <button key={style.kind} role="menuitemradio" aria-checked={activeTab.chartKind === style.kind} className={activeTab.chartKind === style.kind ? "selected" : ""} onClick={() => updateChartStyle(style.kind)}><ChartStyleGlyph kind={style.kind} size={17} /><span><strong>{style.label}</strong><small>{style.description}</small></span><i /></button>)}</div>
          {activeTab.chartKind === "renko" && <section className="synthetic-chart-settings" aria-label="Renko settings">
            <div className="synthetic-settings-heading"><strong>Renko construction</strong><span>SMA/EMA use bricks</span></div>
            <label><span>Brick size</span><div className="tick-input"><input type="number" min="1" max="10000" step="1" aria-label="Renko brick size in ticks" value={activeTab.renkoSettings.brickSizeTicks} onChange={(event) => updateRenkoSettings({ brickSizeTicks: Number(event.target.value) })} /><em>ticks</em></div><small>{(activeTab.renkoSettings.brickSizeTicks * activeTab.symbol.minMove).toFixed(Math.max(0, String(activeTab.symbol.minMove).split(".")[1]?.length ?? 0))} price</small></label>
            <label><span>Price source</span><select aria-label="Renko price source" value={activeTab.renkoSettings.priceSource} onChange={(event) => updateRenkoSettings({ priceSource: event.target.value as "close" | "high-low" })}><option value="close">Close</option><option value="high-low">High / Low</option></select></label>
            <label><span>Reversal</span><select aria-label="Renko reversal bricks" value={activeTab.renkoSettings.reversalBricks} onChange={(event) => updateRenkoSettings({ reversalBricks: Number(event.target.value) as 1 | 2 })}><option value="1">1 brick</option><option value="2">2 bricks</option></select><small>{activeTab.renkoSettings.reversalBricks === 2 ? "Traditional non-overlap" : "Immediate reversal"}</small></label>
          </section>}
          {activeTab.chartKind === "point-and-figure" && <section className="synthetic-chart-settings" aria-label="Point and Figure settings">
            <div className="synthetic-settings-heading"><strong>Point & Figure construction</strong><span>SMA/EMA use columns</span></div>
            <label><span>Box size</span><div className="tick-input"><input type="number" min="1" max="10000" step="1" aria-label="Point and Figure box size in ticks" value={activeTab.pointAndFigureSettings.boxSizeTicks} onChange={(event) => updatePointAndFigureSettings({ boxSizeTicks: Number(event.target.value) })} /><em>ticks</em></div><small>{(activeTab.pointAndFigureSettings.boxSizeTicks * activeTab.symbol.minMove).toFixed(Math.max(0, String(activeTab.symbol.minMove).split(".")[1]?.length ?? 0))} price</small></label>
            <label><span>Price source</span><select aria-label="Point and Figure price source" value={activeTab.pointAndFigureSettings.priceSource} onChange={(event) => updatePointAndFigureSettings({ priceSource: event.target.value as "close" | "high-low" })}><option value="close">Close</option><option value="high-low">High / Low</option></select></label>
            <label><span>Reversal boxes</span><input type="number" min="1" max="10" step="1" aria-label="Point and Figure reversal boxes" value={activeTab.pointAndFigureSettings.reversalBoxes} onChange={(event) => updatePointAndFigureSettings({ reversalBoxes: Number(event.target.value) })} /></label>
          </section>}
        </div></>}
      </div>
      <div className="toolbar-popover-anchor">
        <button className={`text-tool-button ${indicatorOpen ? "active" : ""}`} onClick={() => { setAlertOpen(false); setChartStyleOpen(false); setIndicatorOpen((value) => !value); }}><SlidersHorizontal size={16} />Indicators</button>
        {indicatorOpen && <div className="popover indicator-popover"><header><strong>Indicators</strong><span>{activeTab.indicators.filter((i) => i.visible && (i.kind !== "VWAP" || (activeTab.chartKind !== "renko" && activeTab.chartKind !== "point-and-figure"))).length} active</span></header>{activeTab.indicators.map((indicator) => {
          const unavailable = indicator.kind === "VWAP" && (activeTab.chartKind === "renko" || activeTab.chartKind === "point-and-figure");
          return <div key={indicator.id} className={`indicator-row ${unavailable ? "unavailable" : ""}`}><label className="indicator-color" title={`Change ${indicator.kind === "VWAP" ? "NY Session VWAP" : `${indicator.kind} ${indicator.period}`} color`}><input type="color" value={indicator.color} disabled={unavailable} aria-label={`Change ${indicator.kind === "VWAP" ? "NY Session VWAP" : `${indicator.kind} ${indicator.period}`} color`} onChange={(event) => updateIndicator(indicator.id, { color: event.target.value })} /><span className="indicator-swatch" style={{ background: indicator.color }} /></label><button className="indicator-toggle-button" disabled={unavailable} aria-pressed={unavailable ? false : indicator.visible} onClick={() => updateIndicator(indicator.id, { visible: !indicator.visible })}><span><strong>{indicator.kind === "VWAP" ? "NY Session VWAP" : indicator.kind}</strong><small>{unavailable ? "Time-based charts only" : indicator.kind === "VWAP" ? isIntradayTimeframe(activeTab.timeframe) ? "9:30 AM–4:00 PM ET" : "Intraday only" : `${activeTab.chartKind === "renko" || activeTab.chartKind === "point-and-figure" ? "Synthetic" : "Source"} length ${indicator.period}`}</small></span><span className={`toggle ${!unavailable && indicator.visible ? "on" : ""}`} /></button></div>;
        })}</div>}
      </div>
      {!isDetached && <div className="toolbar-popover-anchor">
        <button className={`text-tool-button alert-tool-button ${alertOpen || activeAlertCount > 0 ? "active" : ""}`} aria-pressed={activeAlertCount > 0} title={`${activeAlertCount} EMA 200 alert timeframe${activeAlertCount === 1 ? "" : "s"} active`} onClick={() => { prepareAlertAudio(); setIndicatorOpen(false); setChartStyleOpen(false); setAlertOpen((value) => !value); }}><Bell size={16} fill={activeAlertCount > 0 ? "currentColor" : "none"} /><span className="tool-label">Alert</span></button>
        {alertOpen && <div className="popover alert-popover"><header><strong>EMA 200 Alerts</strong><span>{activeAlertCount} active · source bars</span></header><div className="alert-list">{ALERT_TIMEFRAMES.map((timeframe) => {
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
      {!isDetached && <><IconButton label="Trade journal" onClick={openTradeJournal}><BookOpen size={17} /></IconButton><IconButton label="Entry rules" active={entryRulesOpen || hasConfiguredEntryRules(workspace.entryRules)} onClick={() => setEntryRulesOpen(true)}><ListChecks size={17} /></IconButton><IconButton label="Settings" active={settingsOpen} onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></IconButton></>}
      <IconButton label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} active={isFullscreen} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton>
    </nav>

    <section className={`workspace ${hasWindowTabs ? "" : "empty-chart-workspace"} ${!isDetached ? `with-right ${workspace.rightPanelOpen ? "right-open" : "right-collapsed"}` : ""} ${!isDetached ? "with-bottom" : ""} ${!isDetached && !workspace.bottomPanelOpen ? "bottom-collapsed" : ""} ${!isDetached && workspace.bottomPanelOpen && bottomPanelMaximized ? "bottom-maximized" : ""}`} style={{ "--bottom-height": workspace.bottomPanelOpen && bottomPanelMaximized ? "100%" : `${workspace.bottomPanelOpen ? workspace.bottomPanelHeight ?? 360 : 42}px` } as React.CSSProperties}>
      <aside className="drawing-rail" aria-label="Drawing tools" onKeyDown={(event) => { if (event.key === "Escape") { setHorizontalToolsOpen(false); setPositionToolsOpen(false); } }}>
        <IconButton label="Cursor" active={activeTool === "cursor"} onClick={() => { setActiveTool("cursor"); setHorizontalToolsOpen(false); setPositionToolsOpen(false); }}><MousePointer2 size={18} /></IconButton>
        <IconButton label={`Magnet: snap crosshair to ${activeTab.chartKind === "point-and-figure" ? "box levels" : activeTab.chartKind === "renko" ? "brick extremes" : "candle high or low"}`} active={activeTab.magnetEnabled} onClick={() => updateActiveTab({ magnetEnabled: !activeTab.magnetEnabled })}><Magnet size={18} /></IconButton>
        <div className="drawing-tool-anchor">
          <IconButton label="Horizontal drawing tools" active={activeTool === "horizontal" || activeTool === "horizontal-ray"} onClick={() => { setPositionToolsOpen(false); setHorizontalToolsOpen((value) => !value); }}><Minus size={18} /></IconButton>
          {horizontalToolsOpen && <><button className="drawing-flyout-backdrop" aria-label="Close horizontal drawing selector" onClick={() => setHorizontalToolsOpen(false)} /><div className="drawing-flyout" role="menu" aria-label="Horizontal drawing selector">
            <button role="menuitem" onClick={() => { setActiveTool("horizontal"); setHorizontalToolsOpen(false); }}><Minus size={17} /><span><strong>Horizontal Line</strong><small>Extends both directions</small></span></button>
            <button role="menuitem" onClick={() => { setActiveTool("horizontal-ray"); setHorizontalToolsOpen(false); }}><Minus size={17} /><span><strong>Horizontal Ray</strong><small>Extends to the right</small></span></button>
          </div></>}
        </div>
        <div className="drawing-tool-anchor">
          <IconButton label="Long and short position tools" active={activeTool === "long-position" || activeTool === "short-position"} onClick={() => { setHorizontalToolsOpen(false); setPositionToolsOpen((value) => !value); }}><TrendingUp size={18} /></IconButton>
          {positionToolsOpen && <><button className="drawing-flyout-backdrop" aria-label="Close position drawing selector" onClick={() => setPositionToolsOpen(false)} /><div className="drawing-flyout" role="menu" aria-label="Position drawing selector">
            <button role="menuitem" onClick={() => { setActiveTool("long-position"); setPositionToolsOpen(false); }}><TrendingUp size={17} /><span><strong>Long Position</strong><small>Target above entry</small></span></button>
            <button role="menuitem" onClick={() => { setActiveTool("short-position"); setPositionToolsOpen(false); }}><TrendingDown size={17} /><span><strong>Short Position</strong><small>Target below entry</small></span></button>
          </div></>}
        </div>
      </aside>

      <ChartPaneGrid
        layout={chartLayout}
        ratios={normalizeChartSplitRatio(chartLayout, windowState.splitRatios?.[chartLayout] ?? defaultChartSplitRatios(chartLayout))}
        panes={visibleTabs.map((tab) => ({ id: tab.id, label: tab.symbol.symbol, node: renderChartPane(tab) }))}
        activePaneId={activeTab.id}
        onFocus={selectTab}
        onRatiosChange={changeChartSplitRatios}
      />

      {!isDetached && <aside className={`right-panel ${workspace.rightPanelOpen ? "open" : "collapsed"}`} aria-labelledby="order-panel-title">
        <header className="right-panel-header"><strong id="order-panel-title">Order Panel</strong><button type="button" aria-label={workspace.rightPanelOpen ? "Collapse order panel" : "Open order panel"} aria-expanded={workspace.rightPanelOpen} aria-controls="order-panel-content" title={workspace.rightPanelOpen ? "Collapse order panel" : "Open order panel"} onClick={() => updateWorkspace({ rightPanelOpen: !workspace.rightPanelOpen })}>{workspace.rightPanelOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}</button></header>
        {workspace.rightPanelOpen && <div id="order-panel-content" className="right-panel-content">
          {activeTab.symbol.provider === "schwab"
            ? <div className="equity-order-disabled"><span>Schwab</span><strong>Chart data only</strong><p>Equity trading is not enabled yet. Quotes, history, indicators, and live candles remain available.</p></div>
            : <OrderTicket chartSymbol={activeTab.symbol} tradeSymbol={activeTradeMeta} quote={activeTradeQuote} bars={bars} timeframe={activeTab.timeframe} settings={workspace.settings.orderTicket} contracts={activeContracts} tradeContract={activeTab.tradeContract} contractStatus={tradeContractStatus} contractLookupError={activeRoot ? contractLookupErrors[activeRoot] : undefined} account={selectedAccount} environment={environment} busy={busy} confirmOrders={workspace.confirmOrders} entryEligibility={activeEntryEligibility} rulesConfigured={hasConfiguredEntryRules(workspace.entryRules)} orderProjection={activeOrderProjection} resetEpoch={activeOrderTicketResetEpoch} onTradeContractChange={(tradeContract) => updateActiveTab({ tradeContract })} onSettingsChange={updateOrderTicketSettings} onConfirmOrdersChange={(confirmOrders) => updateWorkspace({ confirmOrders })} onProjectionChange={replaceOrderProjection} onSubmit={(draft) => submitOrder(draft, activeTab.id, activeTab.symbol.symbol)} />}
        </div>}
      </aside>}

      {!isDetached && <BottomPanel workspace={workspace} updateWorkspace={updateWorkspace} maximized={bottomPanelMaximized} onMaximizedChange={setBottomPanelMaximized} accounts={accounts} account={selectedAccount} positions={positions} orders={orders} balances={balances} bodBalances={bodBalances} history={history} setHistory={setHistory} loading={brokerageLoading} error={brokerageError} streamState={brokerageConnectionState} notifications={notifications} closingPositionIds={closingPositionIds} onClosePosition={requestClosePosition} onNotify={(item) => setNotifications((current) => [item, ...current].slice(0, 250))} onCancel={cancelWorkingOrder} />}
    </section>

    {searchOpen && <Modal title="Select symbol" onClose={() => { setSearchOpen(false); setSearch(""); }} width={620}>
      <div className="search-box"><Search size={17} /><input autoFocus placeholder="Search equity, ETF, or futures contract" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <div className="symbol-results">
        {!search.trim() && symbolPickerResults.length > 0 && <div className="symbol-results-label">Recent symbols</div>}
        {symbolPickerResults.map((result) => <button key={instrumentKey(result)} onClick={() => { selectSymbol(result); setSearchOpen(false); setSearch(""); }}><span className={`instrument-icon ${result.provider}`}>{result.provider === "schwab" ? "E" : "F"}</span><span><strong>{result.symbol}</strong><small>{result.description}</small></span><span className="result-meta">{result.exchange}<small>{result.provider === "schwab" ? "Schwab" : `TradeStation${result.expiration ? ` · ${result.expiration}` : ""}`}</small></span></button>)}
        {!symbolPickerResults.length && <div className="empty-state">{search.trim() ? <>No supported symbols matched “{search}”.</> : "No recent symbols yet."}</div>}
      </div>
    </Modal>}

    {setupOpen && <Modal title="Connect TradeStation" onClose={() => setSetupOpen(false)}><TradeStationCredentials clientId={clientId} secret={secret} busy={busy} configured={credentialsConfigured} native={api.isNative} onClientIdChange={setClientId} onSecretChange={setSecret} onSave={saveTradeStationCredentials} onConnect={connect} /></Modal>}

    {settingsOpen && <Modal title="Settings" onClose={() => setSettingsOpen(false)} width={540}><div className="settings-content">
      <WatchlistSettings workspace={workspace} onChange={(watchlist) => updateWorkspace({ watchlist })} onNotify={showToast} />
      <section className="settings-section" aria-labelledby="chart-label-settings"><header><span>Chart</span><h3 id="chart-label-settings">Chart display</h3><p>Configure tab signals and the values shown beside open positions and protective orders.</p></header><label className="switch-row settings-row"><span><strong>EMA 200 tab status</strong><small>Green above EMA 200, red below</small></span><input type="checkbox" checked={workspace.settings.chartLabels.showEma200TabDots} onChange={(event) => updateChartLabelSettings({ showEma200TabDots: event.target.checked })} /></label><label className="switch-row settings-row"><span><strong>Show dollar amount</strong><small>Full-position profit or loss</small></span><input type="checkbox" checked={workspace.settings.chartLabels.showDollarAmount} onChange={(event) => updateChartLabelSettings({ showDollarAmount: event.target.checked })} /></label><label className="switch-row settings-row"><span><strong>Show R value</strong><small>Profit or loss relative to initial risk</small></span><input type="checkbox" checked={workspace.settings.chartLabels.showRMultiple} onChange={(event) => updateChartLabelSettings({ showRMultiple: event.target.checked })} /></label><label className="settings-font-row"><span><strong>Label font size</strong><small>Adjusts every position and order label</small></span><div><input type="range" min="8" max="16" step="1" value={workspace.settings.chartLabels.fontSize} onChange={(event) => updateChartLabelSettings({ fontSize: Number(event.target.value) })} aria-label="Chart label font size" /><output>{workspace.settings.chartLabels.fontSize}px</output></div></label></section>
      <section className="settings-section" aria-labelledby="order-entry-settings"><header><span>Trading</span><h3 id="order-entry-settings">Order entry</h3><p>Configure risk sizing and projected swing stops.</p></header><label className="settings-control-row"><span><strong>Risk budget behavior</strong><small>Choose whether risk sizing may exceed the limit</small></span><select aria-label="Risk budget behavior" value={workspace.settings.orderTicket.riskSizingPolicy} onChange={(event) => updateOrderTicketSettings({ riskSizingPolicy: event.target.value as OrderTicketSettings["riskSizingPolicy"] })}><option value="strict">Stay within risk</option><option value="minimum-one">Always allow 1 contract</option></select></label><label className="settings-control-row"><span><strong>Swing pivot strength</strong><small>Completed candles required on each side</small></span><select aria-label="Swing stop pivot strength" value={workspace.settings.orderTicket.swingStopPivotBars} onChange={(event) => updateOrderTicketSettings({ swingStopPivotBars: Number(event.target.value) as 2 | 3 })}><option value="2">2-bar pivot</option><option value="3">3-bar pivot</option></select></label><label className="settings-control-row"><span><strong>Stop offset</strong><small>Minimum ticks beyond the swing high or low</small></span><div className="settings-number-control"><input aria-label="Swing stop offset ticks" type="number" min="1" max="100" step="1" value={workspace.settings.orderTicket.swingStopOffsetTicks} onChange={(event) => updateOrderTicketSettings({ swingStopOffsetTicks: Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1))) })} /><span>ticks</span></div></label></section>
      <section className="settings-section" aria-labelledby="journal-fee-settings"><header><span>Journal</span><h3 id="journal-fee-settings">Commission and fees</h3><p>Used for journal net P&amp;L on every opening and closing fill.</p></header><label className="settings-control-row"><span><strong>Fee per contract, per side</strong><small>One contract opened and closed is charged twice</small></span><div className="settings-number-control"><input aria-label="Journal fee per contract per side" type="number" min="0" max="100" step="0.01" value={workspace.settings.journal.commissionPerContractSide} onChange={(event) => updateJournalCommission(Number(event.target.value))} /><span>USD</span></div></label></section>
      <section className="settings-section settings-api-section" aria-labelledby="journal-cloud-settings"><JournalCloudSettings preferenceSync={preferenceSync} preferenceRealtime={preferenceRealtime} onConnectionChanged={() => { void syncCloudPreferences(); }} /></section>
      <section className="settings-section settings-api-section" aria-labelledby="tradestation-api-settings"><header><span>Connection</span><h3 id="tradestation-api-settings">TradeStation API</h3><p>Update the API client ID and secret stored in your operating system credential vault.</p></header><TradeStationCredentials clientId={clientId} secret={secret} busy={busy} configured={credentialsConfigured} native={api.isNative} showIntro={false} onClientIdChange={setClientId} onSecretChange={setSecret} onSave={saveTradeStationCredentials} onConnect={connect} /></section>
      <section className="settings-section settings-api-section" aria-labelledby="schwab-api-settings"><header><span>Connection</span><h3 id="schwab-api-settings">Schwab API</h3><p>Equity and ETF chart data. Credentials and the refresh token stay in the operating system credential vault.</p></header><SchwabCredentials clientId={schwabClientId} secret={schwabSecret} busy={busy} configured={schwabConfigured} connected={schwabAuthenticated} native={api.isNative} onClientIdChange={setSchwabClientId} onSecretChange={setSchwabSecret} onSave={saveSchwabApiCredentials} onConnect={connectSchwab} onDisconnect={disconnectSchwab} /></section>
    </div></Modal>}

    {envConfirm && <Modal title={`Switch to ${envConfirm.toUpperCase()}?`} onClose={() => setEnvConfirm(null)}><div className={`environment-confirm ${envConfirm}`}><Zap size={22} /><div><strong>{envConfirm === "live" ? "Real orders and real money" : "Simulated execution"}</strong><p>{envConfirm === "live" ? "Changing to LIVE clears SIM account data." : "SIM uses a separate account environment and simulated fills."}</p></div></div><div className="modal-actions"><button className="secondary-button" onClick={() => setEnvConfirm(null)}>Cancel</button><button className={envConfirm === "live" ? "danger-button" : "primary-button"} disabled={busy} onClick={confirmEnvironment}>Switch to {envConfirm.toUpperCase()}</button></div></Modal>}

    {entryRulesOpen && <Modal title="Entry rules" onClose={() => setEntryRulesOpen(false)} width={860}><EntryRulesBuilder rules={workspace.entryRules} alerts={workspace.entryRuleAlerts} bars={bars} quote={activeQuote} onClose={() => setEntryRulesOpen(false)} onSave={(entryRules, entryRuleAlerts) => { updateWorkspace({ entryRules, entryRuleAlerts }); setEntryRulesOpen(false); showToast("Entry rules and alerts saved."); }} /></Modal>}

    {review && <Modal title={review.kind === "close-position" ? "Close position" : "Review order"} onClose={() => setReview(null)}><div className="review-hero"><span className={review.draft.side === "Buy" ? "buy" : "sell"}>{review.draft.side}</span><strong>{review.draft.quantity} {review.draft.symbol}</strong><small>{review.kind === "close-position" ? "Market close · cancels working exits first" : `${review.draft.type} · ${review.draft.duration}${review.chartSymbol !== review.draft.symbol ? ` · Chart ${review.chartSymbol} · Trading ${review.draft.symbol}` : ""}`}</small></div><dl className="review-list">{review.kind === "entry" && <><div><dt>Take profit</dt><dd>{formatPrice(review.draft.takeProfit)}</dd></div><div><dt>Stop loss</dt><dd>{formatPrice(review.draft.stopLoss)}</dd></div></>}<div><dt>Estimated commission</dt><dd>{review.preview.estimatedCommission ?? "—"}</dd></div><div><dt>Initial margin</dt><dd>{review.preview.initialMargin ?? "—"}</dd></div><div><dt>Environment</dt><dd className={environment === "live" ? "negative" : "cyan"}>{environment.toUpperCase()}</dd></div></dl><p className="preview-summary">{review.kind === "close-position" ? "All working close-side orders for this symbol will be cancelled and confirmed inactive before the market close is submitted." : review.preview.summary}</p>{reviewEntryEligibility && <p className={`entry-review-rule ${reviewEntryEligibility.status}`}>{reviewEntryEligibility.reason}</p>}<button className={review.draft.side === "Buy" ? "buy-button" : "sell-button"} disabled={!review.preview.valid || busy || Boolean(reviewEntryEligibility && !reviewEntryEligibility.allowed)} onClick={submitReviewed}>{review.kind === "close-position" ? "Close position" : `Send ${review.draft.side} order`}</button></Modal>}

    {toast && <div className="toast" role="status">{toast}</div>}
  </main>;
}

function ChartTabStrip({ tabs, activeTabId, visibleTabIds, totalTabs, windowId, ema200Positions, entryRuleSignals, onSelect, onAdd, onClose, onReorder, onDragEnd, onBounds }: {
  tabs: ChartTabState[];
  activeTabId: string;
  visibleTabIds: string[];
  totalTabs: number;
  windowId: string;
  ema200Positions: Partial<Record<string, EmaCrossSide>>;
  entryRuleSignals: Record<string, EntryRuleTabSignal>;
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
      {tabs.map((tab, index) => {
        const entrySignal = entryRuleSignals[tab.id];
        const entrySignalLabel = entrySignal?.sides.length === 2 ? "L/S" : entrySignal?.sides[0] === "long" ? "L" : "S";
        return <div key={tab.id} className={`chart-tab ${visibleTabIds.includes(tab.id) ? "visible" : ""} ${tab.id === activeTabId ? "active" : ""} ${dropIndex === index ? "drop-before" : ""} ${entrySignal?.pulsing ? "entry-rule-pulsing" : ""}`} role="tab" aria-selected={tab.id === activeTabId} draggable onDragStart={(event) => {
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
        <button className="chart-tab-label" aria-label={`${tab.symbol.symbol} ${tab.timeframe} chart${ema200Positions[tab.id] ? `, price ${ema200Positions[tab.id]} EMA 200` : ""}${entrySignal ? `, ${entrySignal.sides.map((side) => side === "long" ? "Long" : "Short").join(" and ")} entry allowed` : ""}`} tabIndex={tab.id === activeTabId ? 0 : -1} onClick={() => onSelect(tab.id)} onKeyDown={(event) => {
          const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!direction) return;
          event.preventDefault();
          onSelect(tabs[(index + direction + tabs.length) % tabs.length].id);
        }}><strong>{tab.symbol.symbol}</strong><span>·</span><span>{tab.timeframe}</span>{visibleTabIds.includes(tab.id) && <span className="chart-tab-visible-dot" aria-label="Shown in split layout" title="Shown in split layout" />}{ema200Positions[tab.id] && <span className={`chart-tab-ema-dot ${ema200Positions[tab.id]}`} role="img" aria-label={`Price ${ema200Positions[tab.id]} EMA 200`} title={`Price ${ema200Positions[tab.id]} EMA 200`} />}{entrySignal && <span className={`chart-tab-entry-badge ${entrySignal.sides.length === 2 ? "both" : entrySignal.sides[0]}`} role="status" title={`${entrySignal.sides.map((side) => side === "long" ? "Long" : "Short").join(" and ")} entry allowed`}>{entrySignalLabel}</span>}</button>
        <button className="chart-tab-close" aria-label={`Close ${tab.symbol.symbol} ${tab.timeframe} chart`} disabled={totalTabs === 1} onClick={() => onClose(tab.id)}><X size={12} /></button>
      </div>;
      })}
      {dropIndex === tabs.length && <span className="tab-drop-end" />}
    </div>
    <button className="chart-tab-add" aria-label="Add chart tab" title={totalTabs >= MAX_CHART_TABS ? `Maximum ${MAX_CHART_TABS} tabs` : "Add chart tab"} disabled={totalTabs >= MAX_CHART_TABS} onClick={onAdd}><Plus size={15} /></button>
  </nav>;
}

function TopbarWatchlist({ symbols, quotes, active, onSelect }: { symbols: SymbolMeta[]; quotes: Record<string, Quote>; active: string; onSelect: (symbol: SymbolMeta) => void | Promise<void> }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const strip = scrollRef.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  };

  if (!symbols.length) return <div className="topbar-watchlist empty" aria-label="Watchlist is empty"><span>Watchlist empty</span></div>;

  return <div ref={scrollRef} className="topbar-watchlist" role="navigation" aria-label="Watchlist" onWheel={handleWheel}>
    <div className="topbar-watchlist-track">
      {symbols.map((instrument) => {
        const key = instrumentKey(instrument);
        const quote = quotes[key] ?? (api.isNative ? undefined : quoteFor(instrument.symbol, 0, instrument.provider));
        const changePct = quote ? quoteDayChangePercent(quote) : undefined;
        const price = quote ? quote.last.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—";
        const change = changePct == null ? "—" : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
        return <button key={key} type="button" className={active === key ? "active" : ""} aria-current={active === key ? "true" : undefined} aria-label={`${instrument.symbol}, ${instrument.provider}, ${price}, ${change}`} onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })} onClick={() => void onSelect(instrument)}><strong>{instrument.symbol}</strong><span>{price}</span><span className={changePct == null ? "muted" : changePct >= 0 ? "positive" : "negative"}>{change}</span></button>;
      })}
    </div>
  </div>;
}

function ChartStyleGlyph({ kind, size = 16 }: { kind: ChartKind; size?: number }) {
  if (kind === "line") return <LineChart size={size} />;
  if (kind === "area") return <Activity size={size} />;
  if (kind === "renko") return <SquareStack size={size} />;
  if (kind === "point-and-figure") return <TrendingUp size={size} />;
  return <BarChart3 size={size} />;
}

function ChartLayoutGlyph({ layout }: { layout: ChartLayout }) {
  return <span className={`chart-layout-glyph glyph-${layout}`} aria-hidden="true">
    {Array.from({ length: chartLayoutCapacity(layout) }, (_, index) => <i key={index} />)}
  </span>;
}

function WatchlistSettings({ workspace, onChange, onNotify }: { workspace: WorkspaceState; onChange: (symbols: SymbolMeta[]) => void; onNotify: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [draggedSymbol, setDraggedSymbol] = useState<string>();
  const [dropSymbol, setDropSymbol] = useState<string>();
  const watchlistRef = useRef(workspace.watchlist);
  const pointerDragRef = useRef<{ symbol: string; pointerId: number } | undefined>(undefined);
  watchlistRef.current = workspace.watchlist;

  useEffect(() => {
    const value = query.trim();
    if (!value) {
      setResults([]);
      setLoading(false);
      setError(undefined);
      return;
    }
    let active = true;
    setLoading(true);
    setError(undefined);
    const timer = window.setTimeout(() => api.symbolSearch(value).then((items) => {
      if (active) setResults(items);
    }).catch(() => {
      if (active) {
        setResults([]);
        setError("Symbol search is unavailable. Try again in a moment.");
      }
    }).finally(() => {
      if (active) setLoading(false);
    }), 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const move = (fromIndex: number, toIndex: number) => {
    const current = watchlistRef.current;
    const next = reorderWatchlist(current, fromIndex, toIndex);
    if (next === current) return;
    watchlistRef.current = next;
    onChange(next);
  };

  const startPointerDrag = (event: React.PointerEvent<HTMLButtonElement>, symbol: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = { symbol, pointerId: event.pointerId };
    setDraggedSymbol(symbol);
    setDropSymbol(undefined);
  };

  const updatePointerDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-watchlist-symbol]")?.dataset.watchlistSymbol;
    if (!target || target === drag.symbol) {
      setDropSymbol(undefined);
      return;
    }
    setDropSymbol(target);
    const current = watchlistRef.current;
    move(current.findIndex((item) => instrumentKey(item) === drag.symbol), current.findIndex((item) => instrumentKey(item) === target));
  };

  const finishPointerDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointerDragRef.current = undefined;
    setDraggedSymbol(undefined);
    setDropSymbol(undefined);
  };

  const add = (result: SymbolMeta) => {
    const key = instrumentKey(result);
    if (workspace.watchlist.some((item) => instrumentKey(item) === key)) return;
    if (!canAddWatchlistSymbol(workspace, result)) {
      onNotify("The watchlist cannot exceed the 100-instrument streaming limit.");
      return;
    }
    onChange([...workspace.watchlist, result]);
  };

  return <section className="settings-section watchlist-settings" aria-labelledby="watchlist-settings-title">
    <header><span>Market data</span><h3 id="watchlist-settings-title">Top bar watchlist</h3><p>Search equities, ETFs, and futures, then drag them into the order shown beside the Northstar logo.</p></header>
    <div className="watchlist-search-box"><Search size={15} /><input aria-label="Search symbols for watchlist" placeholder="Search symbol or instrument name" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {query.trim() && <div className="watchlist-search-results" aria-live="polite">
      {loading && <div className="watchlist-search-state">Searching…</div>}
      {!loading && error && <div className="watchlist-search-state negative">{error}</div>}
      {!loading && !error && results.map((result) => {
        const added = workspace.watchlist.some((item) => instrumentKey(item) === instrumentKey(result));
        const available = canAddWatchlistSymbol(workspace, result);
        return <div className="watchlist-search-result" key={instrumentKey(result)}><span className={`instrument-icon ${result.provider}`}>{result.provider === "schwab" ? "E" : "F"}</span><span><strong>{result.symbol}</strong><small>{result.description}</small></span><span className="result-meta">{result.exchange}<small>{result.provider === "schwab" ? "Schwab · Equity" : `TradeStation · ${formatContractExpiration(result.expiration)}`}</small></span><button type="button" disabled={added || !available} title={!available && !added ? "100-instrument quote stream limit reached" : undefined} onClick={() => add(result)}>{added ? "Added" : !available ? "Limit" : "Add"}</button></div>;
      })}
      {!loading && !error && !results.length && <div className="watchlist-search-state">No supported symbols matched “{query}”.</div>}
    </div>}
    <div className={`watchlist-editor ${draggedSymbol ? "dragging" : ""}`} aria-label="Saved watchlist">
      {workspace.watchlist.map((instrument, index) => {
        const key = instrumentKey(instrument);
        return <div key={key} data-watchlist-symbol={key} className={`watchlist-editor-row ${draggedSymbol === key ? "dragging" : ""} ${dropSymbol === key ? "drop-target" : ""}`}>
          <button type="button" className="watchlist-drag-handle" aria-label={`Reorder ${instrument.symbol}`} aria-pressed={draggedSymbol === key} title="Drag or use the up and down arrow keys" onPointerDown={(event) => startPointerDrag(event, key)} onPointerMove={updatePointerDrag} onPointerUp={finishPointerDrag} onPointerCancel={finishPointerDrag} onLostPointerCapture={(event) => { if (pointerDragRef.current?.pointerId === event.pointerId) finishPointerDrag(event); }} onKeyDown={(event) => { const offset = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0; if (!offset) return; event.preventDefault(); move(index, index + offset); }}><GripVertical size={15} /></button>
          <span><strong>{instrument.symbol}</strong><small>{instrument.provider === "schwab" ? `Schwab · ${instrument.description}` : `TradeStation · ${instrument.exchange || instrument.description}`}</small></span>
          <button type="button" className="watchlist-remove" aria-label={`Remove ${instrument.symbol} from watchlist`} onClick={() => onChange(workspace.watchlist.filter((item) => instrumentKey(item) !== key))}><X size={14} /></button>
        </div>;
      })}
      {!workspace.watchlist.length && <div className="watchlist-editor-empty"><strong>No symbols saved</strong><span>Use the search above to build your top bar watchlist.</span></div>}
    </div>
  </section>;
}

function OrderTicket({ chartSymbol, tradeSymbol, quote, bars, timeframe, settings, contracts, tradeContract, contractStatus, contractLookupError, account, environment, busy, confirmOrders, entryEligibility, rulesConfigured, orderProjection, resetEpoch, onTradeContractChange, onSettingsChange, onConfirmOrdersChange, onProjectionChange, onSubmit }: { chartSymbol: SymbolMeta; tradeSymbol?: SymbolMeta; quote: Quote; bars: Bar[]; timeframe: Timeframe; settings: OrderTicketSettings; contracts: SymbolMeta[]; tradeContract?: string; contractStatus?: string; contractLookupError?: string; account?: Account; environment: TradingEnvironment; busy: boolean; confirmOrders: boolean; entryEligibility: Record<EntryRuleSide, EntryRuleResult>; rulesConfigured: boolean; orderProjection?: OrderProjection; resetEpoch: number; onTradeContractChange: (symbol?: string) => void; onSettingsChange: (patch: Partial<OrderTicketSettings>) => void; onConfirmOrdersChange: (enabled: boolean) => void; onProjectionChange: (projection: OrderProjection) => void; onSubmit: (draft: OrderDraft) => void }) {
  const symbol = tradeSymbol ?? chartSymbol;
  const continuous = isContinuousFuture(chartSymbol);
  const [side, setSide] = useState<"Buy" | "Sell">("Buy");
  const [quantity, setQuantity] = useState(1);
  const [riskInput, setRiskInput] = useState(settings.riskAmount == null ? "" : String(settings.riskAmount));
  const [duration, setDuration] = useState<"DAY" | "GTC">("DAY");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [rMenuOpen, setRMenuOpen] = useState(false);
  const ticketSymbolRef = useRef(symbol.symbol);
  const handledResetRef = useRef(`${symbol.symbol}:${resetEpoch}`);
  const rSelectorRef = useRef<HTMLDivElement>(null);
  const rMenuRef = useRef<HTMLDivElement>(null);
  const rButtonRef = useRef<HTMLButtonElement>(null);
  const riskInputFocusedRef = useRef(false);
  const selectedR = orderProjection?.rMultiple;

  const projectionPrice = (value: string) => {
    if (!value.trim()) return undefined;
    const price = Number(value);
    return Number.isFinite(price) && price > 0 ? price : undefined;
  };
  const parsedRiskAmount = riskInput.trim() === "" ? undefined : Number(riskInput);
  const riskAmount = parsedRiskAmount != null && Number.isFinite(parsedRiskAmount) && parsedRiskAmount > 0 ? parsedRiskAmount : undefined;
  const takeProfitPrice = Number(takeProfit);
  const stopLossPrice = Number(stopLoss);
  const entryPrice = side === "Buy" ? quote.ask : quote.bid;
  const tickValue = symbol.minMove * symbol.pointValue;
  const minimumRiskQuantity = settings.riskSizingPolicy === "minimum-one" ? 1 : 0;
  function resolvedQuantity(nextSide = side, nextStopLoss = stopLoss, mode = settings.sizingMode, nextRiskAmount = riskAmount) {
    if (mode === "contracts") return quantity;
    const nextEntryPrice = nextSide === "Buy" ? quote.ask : quote.bid;
    return calculateContractsForRisk(nextRiskAmount, nextEntryPrice, Number(nextStopLoss), nextSide, symbol.minMove, tickValue, minimumRiskQuantity) ?? 0;
  }

  const strictRiskQuantity = calculateContractsForRisk(riskAmount, entryPrice, stopLossPrice, side, symbol.minMove, tickValue);
  const calculatedRiskQuantity = minimumRiskQuantity === 0
    ? strictRiskQuantity
    : calculateContractsForRisk(riskAmount, entryPrice, stopLossPrice, side, symbol.minMove, tickValue, minimumRiskQuantity);
  const riskQuantity = calculatedRiskQuantity ?? 0;
  const effectiveQuantity = settings.sizingMode === "risk" ? riskQuantity : quantity;
  const publishProjection = (nextTakeProfit: string, nextStopLoss: string, nextSide = side, nextQuantity = resolvedQuantity(nextSide, nextStopLoss), nextR: OrderRMultiple | null = selectedR ?? null) => onProjectionChange({
    takeProfit: projectionPrice(nextTakeProfit),
    stopLoss: projectionPrice(nextStopLoss),
    side: nextSide,
    quantity: nextQuantity,
    rMultiple: nextR ?? undefined,
  });

  useEffect(() => {
    if (ticketSymbolRef.current === symbol.symbol) return;
    ticketSymbolRef.current = symbol.symbol;
    setTakeProfit("");
    setStopLoss("");
    setRMenuOpen(false);
    onProjectionChange({});
  }, [symbol.symbol]);

  useEffect(() => {
    const resetKey = `${symbol.symbol}:${resetEpoch}`;
    if (handledResetRef.current === resetKey) return;
    handledResetRef.current = resetKey;
    if (resetEpoch <= 0) return;
    setTakeProfit("");
    setStopLoss("");
    setRMenuOpen(false);
    onProjectionChange({});
  }, [symbol.symbol, side, resetEpoch]);

  useEffect(() => {
    if (riskInputFocusedRef.current) return;
    setRiskInput(settings.riskAmount == null ? "" : String(settings.riskAmount));
  }, [settings.riskAmount]);

  useEffect(() => {
    if (orderProjection?.takeProfit != null && orderProjection.takeProfit !== projectionPrice(takeProfit)) {
      setTakeProfit(String(orderProjection.takeProfit));
    }
    if (orderProjection?.stopLoss != null && orderProjection.stopLoss !== projectionPrice(stopLoss)) {
      setStopLoss(String(orderProjection.stopLoss));
    }
  }, [orderProjection?.takeProfit, orderProjection?.stopLoss]);

  useEffect(() => {
    if (!orderProjection || orderProjection.quantity === effectiveQuantity) return;
    onProjectionChange({
      takeProfit: orderProjection.takeProfit,
      stopLoss: orderProjection.stopLoss,
      side: orderProjection.side,
      quantity: effectiveQuantity,
      rMultiple: orderProjection.rMultiple,
    });
  }, [effectiveQuantity, orderProjection?.quantity]);

  const swingStopPrice = calculateSwingStop({
    bars,
    side,
    entryPrice,
    minMove: symbol.minMove,
    pivotBars: settings.swingStopPivotBars,
    offsetTicks: settings.swingStopOffsetTicks,
  });
  const takeProfitValid = takeProfit.trim() !== "" && takeProfitPrice > 0 && validateTick(takeProfitPrice, symbol.minMove)
    && (side === "Buy" ? takeProfitPrice > entryPrice : takeProfitPrice < entryPrice);
  const stopLossValid = stopLoss.trim() !== "" && stopLossPrice > 0 && validateTick(stopLossPrice, symbol.minMove)
    && (side === "Buy" ? stopLossPrice < entryPrice : stopLossPrice > entryPrice);
  const rSelectorEnabled = stopLossValid && Number.isFinite(entryPrice) && entryPrice > 0;

  useEffect(() => {
    if (!rMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (isTargetOutside<Node>(rSelectorRef.current, event.target as Node)) setRMenuOpen(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isTargetOutside<Node>(rSelectorRef.current, event.target as Node)) setRMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setRMenuOpen(false);
      rButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [rMenuOpen]);

  useEffect(() => {
    if (!rMenuOpen) return;
    const frame = requestAnimationFrame(() => {
      const selected = rMenuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      (selected ?? rMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [rMenuOpen]);

  useEffect(() => {
    if (rSelectorEnabled) return;
    setRMenuOpen(false);
  }, [rSelectorEnabled]);

  useEffect(() => {
    if (selectedR == null) setRMenuOpen(false);
  }, [selectedR]);

  const selectRMultiple = (rMultiple: OrderRMultiple) => {
    const target = calculateTakeProfitAtR(entryPrice, stopLossPrice, side, rMultiple, symbol.minMove);
    if (target == null) return;
    const nextTakeProfit = String(target);
    setRMenuOpen(false);
    setTakeProfit(nextTakeProfit);
    publishProjection(nextTakeProfit, stopLoss, side, effectiveQuantity, rMultiple);
  };

  const handleRMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex].focus();
  };

  const updateProjectedStop = (value: string) => {
    setStopLoss(value);
    const nextStopLoss = Number(value);
    const target = selectedR == null ? null : calculateTakeProfitAtR(entryPrice, nextStopLoss, side, selectedR, symbol.minMove);
    if (target == null) {
      publishProjection(takeProfit, value);
      return;
    }
    const nextTakeProfit = String(target);
    setTakeProfit(nextTakeProfit);
    publishProjection(nextTakeProfit, value);
  };

  function draft(): OrderDraft {
    return { accountId: account?.id ?? "", symbol: tradeSymbol?.symbol ?? "", side, type: "Market", quantity: effectiveQuantity, duration, takeProfit: takeProfitPrice, stopLoss: stopLossPrice };
  }

  const marketUnavailable = !tradeSymbol || quote.last <= 0 || quote.halted || quote.delayed || !quote.receivedAt || Date.now() - quote.receivedAt > 5_000;
  const perContractRisk = stopLossValid ? estimateOrderRisk(entryPrice, stopLossPrice, side, 1, symbol.minMove, tickValue) : null;
  const estimatedRisk = stopLossValid && effectiveQuantity > 0 ? estimateOrderRisk(entryPrice, stopLossPrice, side, effectiveQuantity, symbol.minMove, tickValue) : null;
  const riskExceedsBudget = settings.sizingMode === "risk" && strictRiskQuantity === 0 && calculatedRiskQuantity === 1;
  const selectedEligibility = entryEligibility[side === "Buy" ? "long" : "short"];
  const orderDisabled = busy || !account || Boolean(contractStatus) || marketUnavailable || effectiveQuantity < 1 || !takeProfitValid || !stopLossValid || estimatedRisk == null || !selectedEligibility.allowed;
  const orderLabel = contractStatus ?? (marketUnavailable ? "Contract market data unavailable"
    : !selectedEligibility.allowed ? `${side === "Buy" ? "Long" : "Short"} entry blocked`
    : `${confirmOrders ? "Review" : "Place"} ${side} market order`);
  const manualMissing = tradeContract && !contracts.some((contract) => contract.symbol === tradeContract);
  const riskSizingStatus = riskInput.trim() === "" ? "Enter risk amount"
    : riskAmount == null ? "Enter a positive amount"
    : !stopLoss.trim() ? "Set stop loss"
    : !Number.isFinite(entryPrice) || entryPrice <= 0 ? "Waiting for live price"
    : !stopLossValid ? `Stop must be ${side === "Buy" ? "below ask" : "above bid"}`
    : calculatedRiskQuantity == null ? "Unable to calculate"
    : calculatedRiskQuantity === 0 && perContractRisk != null ? `1 contract risks $${perContractRisk.toFixed(2)}`
    : riskExceedsBudget && estimatedRisk != null ? `1 contract · $${estimatedRisk.toFixed(2)} risk`
    : `${calculatedRiskQuantity} contract${calculatedRiskQuantity === 1 ? "" : "s"}`;
  const selectSizingMode = (sizingMode: OrderTicketSettings["sizingMode"]) => {
    if (sizingMode === settings.sizingMode) return;
    onSettingsChange({ sizingMode });
    publishProjection(takeProfit, stopLoss, side, resolvedQuantity(side, stopLoss, sizingMode));
  };
  const updateRiskAmount = (value: string) => {
    setRiskInput(value);
    const parsed = value.trim() === "" ? undefined : Number(value);
    const nextRiskAmount = parsed != null && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    onSettingsChange({ riskAmount: nextRiskAmount });
    if (settings.sizingMode === "risk") {
      publishProjection(takeProfit, stopLoss, side, resolvedQuantity(side, stopLoss, "risk", nextRiskAmount));
    }
  };
  return <div className="order-ticket">
    <div className="account-line"><span>{account?.displayId ?? "No account"}</span><span className={environment}>{environment.toUpperCase()}</span></div>
    {continuous && <label className="trade-contract-field"><span><strong>Trade contract</strong><small>Chart {chartSymbol.symbol}</small></span><select aria-label="Trade contract" value={tradeContract ?? "__auto__"} onChange={(event) => onTradeContractChange(event.target.value === "__auto__" ? undefined : event.target.value)}><option value="__auto__">Auto · {chartSymbol.underlying ?? "Unavailable"}</option>{manualMissing && <option value={tradeContract}>{tradeContract} · Saved selection</option>}{contracts.map((contract) => <option key={contract.symbol} value={contract.symbol}>{contract.symbol} · {formatContractExpiration(contract.expiration)}</option>)}</select>{contractStatus && <small className="negative">{contractStatus}</small>}{!contractStatus && contractLookupError && <small className="negative">Contract list unavailable; the current selection is unchanged.</small>}</label>}
    <div className="market-buttons"><button className={side === "Sell" ? "selected" : ""} onClick={() => { setSide("Sell"); publishProjection(takeProfit, stopLoss, "Sell"); }}><small>SELL</small><strong>{quote.bid.toFixed(2)}</strong></button><div><span>{(quote.ask - quote.bid).toFixed(2)}</span></div><button className={side === "Buy" ? "selected" : ""} onClick={() => { setSide("Buy"); publishProjection(takeProfit, stopLoss, "Buy"); }}><small>BUY</small><strong>{quote.ask.toFixed(2)}</strong></button></div>
    <div className="field compact sizing-field">
      <div className="sizing-mode" role="group" aria-label="Position sizing method">
        <button type="button" className={settings.sizingMode === "contracts" ? "active" : ""} aria-pressed={settings.sizingMode === "contracts"} onClick={() => selectSizingMode("contracts")}>Contracts</button>
        <button type="button" className={settings.sizingMode === "risk" ? "active" : ""} aria-pressed={settings.sizingMode === "risk"} onClick={() => selectSizingMode("risk")}>Risk $</button>
      </div>
      {settings.sizingMode === "contracts"
        ? <div className="stepper"><button type="button" aria-label="Decrease contracts" onClick={() => { const next = Math.max(1, quantity - 1); setQuantity(next); publishProjection(takeProfit, stopLoss, side, next); }}><Minus size={14} /></button><input aria-label="Contracts" type="number" min="1" step="1" value={quantity} onChange={(event) => { const next = Math.max(1, Math.floor(Number(event.target.value) || 1)); setQuantity(next); publishProjection(takeProfit, stopLoss, side, next); }} /><button type="button" aria-label="Increase contracts" onClick={() => { const next = quantity + 1; setQuantity(next); publishProjection(takeProfit, stopLoss, side, next); }}><Plus size={14} /></button></div>
        : <div className="risk-sizing-control"><label><span>$</span><input aria-label="Risk amount in dollars" type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="0.00" value={riskInput} onFocus={() => { riskInputFocusedRef.current = true; }} onBlur={() => { riskInputFocusedRef.current = false; setRiskInput(riskAmount == null ? "" : String(riskAmount)); }} onChange={(event) => updateRiskAmount(event.target.value)} /></label><output className={riskExceedsBudget ? "over-risk" : calculatedRiskQuantity === 0 ? "insufficient" : ""} aria-live="polite">{riskSizingStatus}</output></div>}
    </div>
    <div className="section-label"><span>Exits</span><small>Server-side bracket</small></div>
    <div className="field compact"><span>Take profit price</span><div className="take-profit-control"><input aria-label="Take profit price" className={takeProfitValid ? "" : "invalid"} type="number" min={symbol.minMove} step={symbol.minMove} value={takeProfit} onChange={(event) => { const value = event.target.value; setRMenuOpen(false); setTakeProfit(value); publishProjection(value, stopLoss, side, effectiveQuantity, null); }} /><div ref={rSelectorRef} className="r-selector"><button ref={rButtonRef} type="button" className={selectedR == null ? "r-selector-button" : "r-selector-button active"} aria-label="Set take profit by risk multiple" aria-haspopup="menu" aria-expanded={rMenuOpen} aria-controls="r-multiple-menu" disabled={!rSelectorEnabled} onClick={() => setRMenuOpen((open) => !open)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setRMenuOpen(true); } }}>{selectedR == null ? "R" : `${selectedR}R`}<ChevronDown size={11} /></button>{rMenuOpen && <div ref={rMenuRef} id="r-multiple-menu" className="r-multiple-menu" role="menu" aria-label="Take profit risk multiple" onKeyDown={handleRMenuKeyDown}>{orderRMultiples.map((rMultiple) => <button key={rMultiple} type="button" role="menuitemradio" aria-checked={selectedR === rMultiple} className={selectedR === rMultiple ? "selected" : ""} onClick={() => selectRMultiple(rMultiple)}>{rMultiple}R</button>)}</div>}</div></div></div>
    <div className="field compact"><span>Stop loss price</span><div className="stop-loss-control"><input aria-label="Stop loss price" className={stopLossValid ? "" : "invalid"} type="number" min={symbol.minMove} step={symbol.minMove} value={stopLoss} onChange={(event) => updateProjectedStop(event.target.value)} /><button type="button" disabled={swingStopPrice == null} aria-label={`Set stop ${side === "Buy" ? "below the latest swing low" : "above the latest swing high"}`} title={swingStopPrice == null ? `No confirmed ${settings.swingStopPivotBars}-bar swing is available on the ${timeframe} chart` : `Set ${settings.swingStopOffsetTicks} tick${settings.swingStopOffsetTicks === 1 ? "" : "s"} beyond the latest confirmed ${timeframe} swing`} onClick={() => { if (swingStopPrice != null) updateProjectedStop(String(swingStopPrice)); }}>Swing</button></div></div>
    <div className="section-label"><span>Time in force</span></div>
    <select value={duration} onChange={(e) => setDuration(e.target.value as "DAY" | "GTC")}><option value="DAY">DAY</option><option value="GTC">GTC</option></select>
    <dl className="ticket-info"><div><dt>Tick value</dt><dd>{tickValue.toFixed(2)} USD</dd></div><div><dt>Data</dt><dd className={quote.delayed ? "negative" : "positive"}>{quote.delayed ? "Delayed" : "Real-time"}</dd></div><div><dt>Estimated risk</dt><dd className={estimatedRisk == null ? "" : "negative"}>{estimatedRisk == null ? "—" : `${estimatedRisk.toFixed(2)} USD`}</dd></div></dl>
    {rulesConfigured && <div className={`ticket-rule-status ${selectedEligibility.status}`}><span /> <strong>{side === "Buy" ? "Long" : "Short"} entry</strong><small>{selectedEligibility.reason}</small></div>}
    <label className="confirm-orders-toggle"><input type="checkbox" checked={confirmOrders} onChange={(event) => onConfirmOrdersChange(event.target.checked)} /><span><strong>Confirm orders</strong><small>Review buy, sell, and close actions</small></span></label>
    <button className={side === "Buy" ? "buy-button" : "sell-button"} disabled={orderDisabled} onClick={() => onSubmit(draft())}>{orderLabel}</button>
  </div>;
}

function BottomPanel({ workspace, updateWorkspace, maximized, onMaximizedChange, accounts, account, positions, orders, balances, bodBalances, history, setHistory, loading, error, streamState, notifications, closingPositionIds, onClosePosition, onNotify, onCancel }: {
  workspace: WorkspaceState; updateWorkspace: (patch: Partial<WorkspaceState>) => void; maximized: boolean; onMaximizedChange: (maximized: boolean) => void; accounts: Account[]; account?: Account; positions: Position[]; orders: OrderUpdate[]; balances: AccountBalance[]; bodBalances: AccountBalance[]; history: HistoricalOrderPage; setHistory: React.Dispatch<React.SetStateAction<HistoricalOrderPage>>; loading: boolean; error?: string; streamState: StreamConnectionState; notifications: ActivityNotification[]; closingPositionIds: Set<string>; onClosePosition: (position: Position) => void; onNotify: (item: ActivityNotification) => void; onCancel: (id: string) => void;
}) {
  const tabs: Array<[WorkspaceState["bottomTab"], string]> = [["positions", "Positions"], ["orders", "Orders"], ["history", "Order history"], ["summary", "Account summary"], ["notifications", "Notifications log"]];
  const [orderFilter, setOrderFilter] = useState("All");
  const today = new Date().toISOString().slice(0, 10);
  const [since, setSince] = useState(today);
  const [until, setUntil] = useState(today);
  const [historyFilter, setHistoryFilter] = useState("All");
  const [historyLoading, setHistoryLoading] = useState(false);
  const localDay = (value: string) => {
    const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  };
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const panel = event.currentTarget.parentElement;
    const workspaceElement = panel?.parentElement;
    const startY = event.clientY;
    const startHeight = panel?.clientHeight ?? workspace.bottomPanelHeight ?? 360;
    const maxHeight = workspaceElement?.clientHeight ?? window.innerHeight;
    let pendingHeight = startHeight;
    let frame: number | undefined;
    if (maximized) {
      updateWorkspace({ bottomPanelHeight: startHeight });
      onMaximizedChange(false);
    }
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    const applyHeight = () => {
      frame = undefined;
      workspaceElement?.style.setProperty("--bottom-height", `${pendingHeight}px`);
    };
    const move = (next: PointerEvent) => {
      pendingHeight = Math.max(220, Math.min(maxHeight, startHeight + startY - next.clientY));
      if (frame == null) frame = window.requestAnimationFrame(applyHeight);
    };
    const stop = () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      updateWorkspace({ bottomPanelHeight: pendingHeight });
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  };
  const loadHistory = async (append = false) => {
    if (!account) return; setHistoryLoading(true);
    try {
      if (since >= today) {
        setHistory({ orders: [] });
        return;
      }
      const page = await api.historicalOrders(account.id, since, append ? history.nextToken : undefined);
      const historicalRows = page.orders.filter((order) => { const day = localDay(order.timestamp); return day >= since && day <= until; });
      const combined = append ? [...history.orders, ...historicalRows] : historicalRows;
      const unique = [...new Map(combined.map((order) => [order.id, order])).values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setHistory({ orders: unique, nextToken: page.nextToken });
    } catch (cause) { onNotify({ id: crypto.randomUUID(), time: new Date().toISOString(), title: "History refresh failed", text: String(cause), level: "error" }); }
    finally { setHistoryLoading(false); }
  };
  useEffect(() => { if (workspace.bottomPanelOpen && workspace.bottomTab === "history" && account) loadHistory(); }, [workspace.bottomPanelOpen, workspace.bottomTab, account?.id, since, until]);
  const statusMatches = (status: string, filter: string) => filter === "All" || status.toLowerCase() === filter.toLowerCase() || filter === "Inactive" && ["Pending", "Indeterminate"].includes(status);
  const visibleOrders = orders.filter((order) => statusMatches(order.status, orderFilter));
  const currentHistoryRows = orders.filter((order) => { const day = localDay(order.timestamp); return day >= since && day <= until; });
  const mergedHistoryRows = [...new Map([...history.orders, ...currentHistoryRows].map((order) => [order.id, order])).values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const visibleHistory = mergedHistoryRows.filter((order) => statusMatches(order.status, historyFilter));
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
  return <section className={`bottom-panel ${workspace.bottomPanelOpen ? "open" : "collapsed"} ${maximized ? "maximized" : ""}`}>
    {workspace.bottomPanelOpen && <div className="resize-handle" onPointerDown={startResize} />}
    <header className="bottom-provider"><strong>TradeStation</strong><span className="bottom-status"><span className={`status-dot ${error ? "error" : streamState === "streaming" ? "" : "paused"}`} />{error ? "Data unavailable" : streamState === "rate-limited" ? "Brokerage data paused" : streamState === "connecting" || streamState === "reconnecting" ? "Brokerage stream reconnecting" : streamState === "disconnected" ? "Brokerage snapshot polling" : loading ? "Refreshing…" : "Brokerage data active"}</span><button className="drawer-toggle" type="button" aria-label={workspace.bottomPanelOpen ? "Collapse bottom drawer" : "Open bottom drawer"} aria-expanded={workspace.bottomPanelOpen} title={workspace.bottomPanelOpen ? "Collapse drawer" : "Open drawer"} onClick={() => updateWorkspace({ bottomPanelOpen: !workspace.bottomPanelOpen })}>{workspace.bottomPanelOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</button>{workspace.bottomPanelOpen && <button type="button" title={maximized ? "Restore" : "Maximize"} onClick={() => onMaximizedChange(!maximized)}><Maximize2 size={15} /></button>}</header>
    {workspace.bottomPanelOpen && <><div className="account-summary"><select value={account?.id ?? ""} onChange={(event) => updateWorkspace({ selectedAccountId: event.target.value })}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.displayId} {item.currency}</option>)}</select><dl><div><dt>Net worth</dt><dd>{money(balance?.equity)}</dd></div><div><dt>Today’s profit</dt><dd>{money(balance?.realizedProfitLoss)}</dd></div><div><dt>Unrealized PnL</dt><dd>{money(balance?.unrealizedProfitLoss ?? positions.reduce((sum, item) => sum + item.unrealizedPnl, 0))}</dd></div></dl></div>
    <nav className="bottom-tabs">{tabs.map(([tab, label]) => <button key={tab} className={workspace.bottomTab === tab ? "active" : ""} onClick={() => updateWorkspace({ bottomTab: tab })}>{label}</button>)}<button className="export-button" title="Export active tab to CSV" onClick={exportRows}><Download size={16} /></button></nav>
    <div className="table-wrap">{error && <div className="panel-error">{error}</div>}
      {workspace.bottomTab === "positions" && (positions.length ? <table><thead><tr><th>Symbol</th><th>Side</th><th>Quantity</th><th>Avg price</th><th>Stop loss</th><th>Take profit</th><th>Last price</th><th>Bid price</th><th>Ask price</th><th>Unrealized PnL</th><th>PnL quantity</th><th>PnL percent</th><th /></tr></thead><tbody>{positions.map((p) => { const closing = closingPositionIds.has(p.id); return <tr key={p.id}><td><strong>{p.symbol}</strong></td><td className={p.side === "Long" ? "buy-text" : "negative"}>{p.side}</td><td>{p.quantity}</td><td>{money(p.averagePrice)}</td><td>—</td><td>—</td><td>{money(p.last)}</td><td>{money(p.bid)}</td><td>{money(p.ask)}</td><td className={p.unrealizedPnl >= 0 ? "positive" : "negative"}>{money(p.unrealizedPnl)}</td><td>{money(p.unrealizedPnlQuantity)}</td><td>{p.unrealizedPnlPercent == null ? "—" : `${p.unrealizedPnlPercent.toFixed(2)}%`}</td><td><button className="close-position-button" disabled={closing} onClick={() => onClosePosition(p)}><X size={12} />{closing ? "Closing…" : "Close Position"}</button></td></tr>; })}</tbody></table> : <Empty label="There are no open positions in this account" />)}
      {workspace.bottomTab === "orders" && <><div className="table-filters">{["All", "Working", "Inactive", "Filled", "Cancelled", "Rejected"].map((filter) => <button key={filter} className={orderFilter === filter ? "active" : ""} onClick={() => setOrderFilter(filter)}>{filter}</button>)}</div><OrderTable rows={visibleOrders} /></>}
      {workspace.bottomTab === "history" && <><div className="history-controls"><label>From <input type="date" value={since} max={until} onChange={(e) => setSince(e.target.value)} /></label><label>To <input type="date" value={until} min={since} onChange={(e) => setUntil(e.target.value)} /></label>{["All", "Filled", "Cancelled", "Rejected"].map((filter) => <button key={filter} className={historyFilter === filter ? "active" : ""} onClick={() => setHistoryFilter(filter)}>{filter}</button>)}</div><OrderTable rows={visibleHistory} />{history.nextToken && <button className="load-more" disabled={historyLoading} onClick={() => loadHistory(true)}>{historyLoading ? "Loading…" : "Load more"}</button>}</>}
      {workspace.bottomTab === "summary" && <div className="balance-sections"><BalanceSection title="Real-time" balance={balance} money={money} /><BalanceSection title="Beginning of day" balance={bod} money={money} /></div>}
      {workspace.bottomTab === "notifications" && (notifications.length ? <table><thead><tr><th>Symbol</th><th>Time</th><th>Title</th><th>Text</th></tr></thead><tbody>{notifications.map((item) => <tr key={item.id}><td>{item.symbol ?? "—"}</td><td>{time(item.time)}</td><td className={item.level === "error" ? "negative" : ""}>{item.title}</td><td>{item.text}</td></tr>)}</tbody></table> : <Empty label="There is no activity here yet" />)}
    </div></>}
  </section>;
}

function BalanceSection({ title, balance, money }: { title: string; balance?: AccountBalance; money: (value?: number) => string }) {
  const cells: Array<[string, number | undefined]> = [["Currency", undefined], ["Account balance", balance?.cashBalance], ["Realized PnL", balance?.realizedProfitLoss], ["Unrealized PnL", balance?.unrealizedProfitLoss], ["Net worth", balance?.equity], ["Commission", balance?.commission], ["Uncleared deposits", balance?.unclearedDeposit], ["Real time BP", balance?.buyingPower], ["Initial margin", balance?.initialMargin], ["Maintenance margin", balance?.maintenanceMargin], ["Open order margin", balance?.openOrderMargin]];
  return <section><h3>{title}</h3><div className="balance-grid">{cells.map(([label, value], index) => <div key={label}><span>{label}</span><strong>{index === 0 ? balance?.currency ?? "—" : money(value)}</strong></div>)}</div></section>;
}
