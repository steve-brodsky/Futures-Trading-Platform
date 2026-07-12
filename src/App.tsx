import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Activity, BarChart3, Bell, BookOpen, ChevronDown, Crosshair, Download,
  Eye, Gauge, LineChart, LockKeyhole, Maximize2, Minus, Percent,
  Magnet, MousePointer2, PanelBottom, PanelRight, PencilLine, Plus, RectangleHorizontal, RotateCcw,
  Search, Settings2, SlidersHorizontal, SquareStack, TextCursorInput, Trash2, TrendingUp,
  Undo2, Wifi, X, Zap,
} from "lucide-react";
import { TradingChart } from "./components/TradingChart";
import { api } from "./lib/bridge";
import { demoOrders, demoPositions, futures, quoteFor } from "./lib/demo";
import { roundToTick, validateTick } from "./lib/indicators";
import { defaultIndicators, normalizeIndicators, normalizeMagnetEnabled } from "./lib/workspace";
import type { Account, AccountBalance, ActivityNotification, Bar, BarSnapshotEvent, BarUpdateEvent, ChartKind, HistoricalOrderPage, IndicatorConfig, OrderDraft, OrderPreview, OrderType, OrderUpdate, Position, Quote, QuoteUpdateEvent, StreamConnectionState, StreamStateEvent, SymbolMeta, Timeframe, TradingEnvironment, WorkspaceState } from "./types";

const timeframes: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "D", "W", "M"];

const defaultWorkspace: WorkspaceState = {
  symbol: futures[0], timeframe: "1m", chartKind: "candles", indicators: defaultIndicators,
  watchlist: ["MESU26", "MNQU26", "MCLU26", "MGCQ26", "MYMU26"], rightTab: "order", rightPanelOpen: false, bottomTab: "positions", bottomPanelOpen: false, bottomPanelHeight: 360,
  chartTimezone: "exchange",
  magnetEnabled: false,
};

function mergeBars(current: Bar[], incoming: Bar[]): Bar[] {
  const byTime = new Map(current.map((bar) => [bar.time, bar]));
  incoming.forEach((bar) => byTime.set(bar.time, bar));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function IconButton({ label, active, children, onClick }: { label: string; active?: boolean; children: React.ReactNode; onClick?: () => void }) {
  return <button className={`icon-button ${active ? "active" : ""}`} aria-label={label} aria-pressed={active == null ? undefined : active} title={label} onClick={onClick}>{children}</button>;
}

function Modal({ title, children, onClose, width = 440 }: { title: string; children: React.ReactNode; onClose: () => void; width?: number }) {
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}><header><h2>{title}</h2><IconButton label="Close" onClick={onClose}><X size={17} /></IconButton></header>{children}</section></div>;
}

export default function App() {
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [environment, setEnvironmentState] = useState<TradingEnvironment>("sim");
  const [barState, setBarState] = useState<{ symbol: string; timeframe: Timeframe; bars: Bar[] }>({
    symbol: defaultWorkspace.symbol.symbol,
    timeframe: defaultWorkspace.timeframe,
    bars: [],
  });
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SymbolMeta[]>(futures);
  const [indicatorOpen, setIndicatorOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [review, setReview] = useState<{ draft: OrderDraft; preview: OrderPreview } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [envConfirm, setEnvConfirm] = useState<TradingEnvironment | null>(null);
  const [activeTool, setActiveTool] = useState("cursor");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [authEpoch, setAuthEpoch] = useState(0);
  const [brokerageEpoch, setBrokerageEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [streamState, setStreamState] = useState<StreamConnectionState>(api.isNative ? "disconnected" : "streaming");
  const [hasOlder, setHasOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [, setFreshnessTick] = useState(0);
  const activeChartRef = useRef({ subscriptionId: "", symbol: defaultWorkspace.symbol.symbol, timeframe: defaultWorkspace.timeframe });
  const bars = barState.symbol === workspace.symbol.symbol && barState.timeframe === workspace.timeframe ? barState.bars : [];

  const activeQuote = quotes[workspace.symbol.symbol] ?? (api.isNative
    ? { symbol: workspace.symbol.symbol, last: 0, bid: 0, ask: 0, change: 0, changePct: 0, delayed: true, halted: false, timestamp: "" }
    : quoteFor(workspace.symbol.symbol));

  useEffect(() => {
    Promise.all([api.loadWorkspace(), api.authStatus()]).then(async ([saved, auth]) => {
      if (saved) {
        const legacyTab = (saved as unknown as { bottomTab: string }).bottomTab;
        setWorkspace({ ...defaultWorkspace, ...saved, bottomTab: legacyTab === "fills" ? "history" : legacyTab === "balances" ? "summary" : saved.bottomTab, bottomPanelHeight: saved.bottomPanelHeight ?? 360, indicators: normalizeIndicators(saved.indicators), chartTimezone: saved.chartTimezone ?? "exchange", magnetEnabled: normalizeMagnetEnabled(saved.magnetEnabled) });
      }
      setAuthenticated(auth.authenticated);
      setAccounts(auth.authenticated ? await api.accounts().catch(() => []) : []);
      if (api.isNative && !auth.configured) setSetupOpen(true);
    }).finally(() => setWorkspaceLoaded(true));
    const cleanups: Array<() => void> = [];
    if (api.isNative) {
      listen<{ authenticated: boolean }>("auth-changed", async ({ payload }) => {
        if (!payload.authenticated) return;
        setAuthenticated(true);
        setSetupOpen(false);
        setAccounts(await api.accounts().catch(() => []));
        setAuthEpoch((value) => value + 1);
        showToast("TradeStation connected.");
      }).then((unlisten) => cleanups.push(unlisten));
      listen<string>("auth-error", ({ payload }) => showToast(payload)).then((unlisten) => cleanups.push(unlisten));
      listen<BarSnapshotEvent>("bar-snapshot", ({ payload }) => {
        const active = activeChartRef.current;
        if (payload.subscriptionId !== active.subscriptionId || payload.symbol !== active.symbol || payload.timeframe !== active.timeframe) return;
        setBarState({ symbol: payload.symbol, timeframe: payload.timeframe, bars: payload.bars });
      }).then((unlisten) => cleanups.push(unlisten));
      listen<BarUpdateEvent>("bar-update", ({ payload }) => {
        const active = activeChartRef.current;
        if (payload.subscriptionId !== active.subscriptionId || payload.symbol !== active.symbol || payload.timeframe !== active.timeframe) return;
        setBarState((current) => ({
          symbol: payload.symbol,
          timeframe: payload.timeframe,
          bars: current.symbol === payload.symbol && current.timeframe === payload.timeframe
            ? mergeBars(current.bars, [payload.bar])
            : [payload.bar],
        }));
      }).then((unlisten) => cleanups.push(unlisten));
      listen<QuoteUpdateEvent>("quote-update", ({ payload }) => {
        if (payload.subscriptionId !== activeChartRef.current.subscriptionId) return;
        setQuotes((current) => ({ ...current, [payload.quote.symbol]: { ...payload.quote, receivedAt: Date.now() } }));
      }).then((unlisten) => cleanups.push(unlisten));
      listen<StreamStateEvent>("stream-state", ({ payload }) => {
        if (payload.subscriptionId !== activeChartRef.current.subscriptionId) return;
        setStreamState(payload.state);
      }).then((unlisten) => cleanups.push(unlisten));
      listen<{ accountId: string }>("brokerage-update", () => setBrokerageEpoch((value) => value + 1)).then((unlisten) => cleanups.push(unlisten));
      listen<string>("brokerage-stream-error", ({ payload }) => setNotifications((current) => [{ id: crypto.randomUUID(), time: new Date().toISOString(), title: "Brokerage stream reconnecting", text: payload, level: "warning" as const }, ...current].slice(0, 250))).then((unlisten) => cleanups.push(unlisten));
    }
    return () => cleanups.forEach((unlisten) => unlisten());
  }, []);

  const selectedAccount = accounts.find((account) => account.id === workspace.selectedAccountId) ?? accounts[0];

  useEffect(() => {
    if (!selectedAccount) return;
    if (workspace.selectedAccountId !== selectedAccount.id) updateWorkspace({ selectedAccountId: selectedAccount.id });
    let active = true;
    const refresh = async () => {
      setBrokerageLoading(true); setBrokerageError(undefined);
      try {
        const [nextPositions, nextOrders, nextBalances, nextBod] = await Promise.all([
          api.positions(selectedAccount.id), api.orders(selectedAccount.id), api.balances(selectedAccount.id), api.bodBalances(selectedAccount.id),
        ]);
        if (!active) return;
        setPositions(nextPositions); setOrders(nextOrders); setBalances(nextBalances); setBodBalances(nextBod);
      } catch (error) {
        if (active) setBrokerageError(String(error));
      } finally { if (active) setBrokerageLoading(false); }
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [selectedAccount?.id, authEpoch, environment, brokerageEpoch]);

  useEffect(() => {
    if (!selectedAccount || !api.isNative || !authenticated) return;
    api.startBrokerageStream(selectedAccount.id).catch((error) => setBrokerageError(String(error)));
    return () => { api.stopBrokerageStream(); };
  }, [selectedAccount?.id, authenticated, environment]);

  useEffect(() => {
    const symbol = workspace.symbol.symbol;
    const timeframe = workspace.timeframe;
    const subscriptionId = crypto.randomUUID();
    activeChartRef.current = { subscriptionId, symbol, timeframe };
    setBarState({ symbol, timeframe, bars: [] });
    setHasOlder(true);
    setLoadingOlder(false);
    if (!api.isNative) {
      api.bars(symbol, timeframe).then((nextBars) => {
        const active = activeChartRef.current;
        if (active.subscriptionId === subscriptionId && active.symbol === symbol && active.timeframe === timeframe) {
          setBarState({ symbol, timeframe, bars: nextBars });
        }
      }).catch((error) => showToast(String(error)));
      return;
    }
    if (!authenticated) return;
    setStreamState("connecting");
    api.cachedBars(symbol, timeframe).then((cached) => {
      const active = activeChartRef.current;
      if (active.subscriptionId !== subscriptionId || active.symbol !== symbol || active.timeframe !== timeframe) return;
      setBarState((current) => ({
        symbol,
        timeframe,
        bars: current.symbol === symbol && current.timeframe === timeframe
          ? mergeBars(cached, current.bars)
          : cached,
      }));
    }).catch(() => undefined);
    api.startMarketStream(subscriptionId, symbol, timeframe, workspace.watchlist).catch((error) => {
      if (activeChartRef.current.subscriptionId !== subscriptionId) return;
      setStreamState("disconnected"); showToast(String(error));
    });
    return () => { if (activeChartRef.current.subscriptionId === subscriptionId) api.stopMarketStream(); };
  }, [workspace.symbol.symbol, workspace.timeframe, workspace.watchlist, authEpoch, authenticated, environment]);

  useEffect(() => {
    if (api.isNative) return;
    const refresh = () => api.quotes(workspace.watchlist).then((items) => setQuotes(Object.fromEntries(items.map((quote) => [quote.symbol, { ...quote, receivedAt: Date.now() }])))).catch(() => setQuotes({}));
    refresh();
    const timer = window.setInterval(refresh, api.isNative ? 3000 : 1800);
    return () => clearInterval(timer);
  }, [workspace.watchlist, authEpoch]);

  useEffect(() => {
    const timer = window.setInterval(() => setFreshnessTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  async function loadOlder() {
    if (!api.isNative || loadingOlder || !hasOlder || !bars.length) return;
    const request = activeChartRef.current;
    const before = bars[0].time;
    setLoadingOlder(true);
    try {
      const older = await api.olderBars(request.symbol, request.timeframe, before);
      const active = activeChartRef.current;
      if (active.subscriptionId !== request.subscriptionId || active.symbol !== request.symbol || active.timeframe !== request.timeframe) return;
      if (!older.length) setHasOlder(false);
      else setBarState((current) => current.symbol === request.symbol && current.timeframe === request.timeframe
        ? { ...current, bars: mergeBars(older, current.bars) }
        : current);
    } catch (error) { showToast(String(error)); }
    finally { setLoadingOlder(false); }
  }

  useEffect(() => {
    if (!workspaceLoaded) return;
    const timer = window.setTimeout(() => api.saveWorkspace(workspace), 250);
    return () => clearTimeout(timer);
  }, [workspace, workspaceLoaded]);

  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(() => api.symbolSearch(search).then(setSearchResults).catch(() => setSearchResults([])), 180);
    return () => clearTimeout(timer);
  }, [search, searchOpen]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }

  function updateWorkspace(patch: Partial<WorkspaceState>) {
    setWorkspace((current) => ({ ...current, ...patch }));
  }

  function updateIndicator(id: string, patch: Partial<IndicatorConfig>) {
    setWorkspace((current) => ({
      ...current,
      indicators: current.indicators.map((indicator) => indicator.id === id ? { ...indicator, ...patch } : indicator),
    }));
  }

  async function confirmEnvironment() {
    if (!envConfirm) return;
    setBusy(true);
    try {
      await api.setEnvironment(envConfirm);
      setEnvironmentState(envConfirm);
      setAuthenticated(api.isNative ? authenticated : false);
      setOrders([]); setPositions([]);
      setEnvConfirm(null);
      setAccounts(await api.accounts().catch(() => []));
      showToast(`Switched to ${envConfirm.toUpperCase()}`);
    } finally { setBusy(false); }
  }

  async function connect() {
    if (!clientId.trim() || !secret.trim()) return showToast("Client ID and secret are required.");
    setBusy(true);
    try {
      await api.saveCredentials(clientId.trim(), secret);
      await api.beginLogin();
      setSetupOpen(false);
      showToast("Complete authorization in your browser.");
    } catch (error) { showToast(String(error)); }
    finally { setBusy(false); setSecret(""); }
  }

  async function openReview(draft: OrderDraft) {
    if (!api.isNative) return showToast("Browser demo mode cannot place orders. Run the Tauri app to connect.");
    setBusy(true);
    try { setReview({ draft, preview: await api.confirmOrder(draft) }); }
    catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  async function submitReviewed() {
    if (!review) return;
    setBusy(true);
    try {
      const update = await api.placeOrder(review.draft);
      setOrders((current) => [update, ...current]);
      setReview(null);
      showToast(`Order ${update.status.toLowerCase()}: ${update.id}`);
    } catch (error) { showToast(String(error)); }
    finally { setBusy(false); }
  }

  const connectionLabel = api.isNative ? (authenticated ? streamState.toUpperCase() : "NOT CONNECTED") : "DEMO FEED";

  return <main className="app-shell">
    <header className="titlebar">
      <div className="brand"><div className="brand-glyph"><TrendingUp size={16} strokeWidth={2.4} /></div><span>NORTHSTAR</span><small>TRADER</small></div>
      <div className="instrument-summary"><strong>{workspace.symbol.symbol}</strong><span>{activeQuote.last.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span><span className={activeQuote.change >= 0 ? "positive" : "negative"}>{activeQuote.change >= 0 ? "+" : ""}{activeQuote.changePct.toFixed(2)}%</span></div>
      <div className="titlebar-drag" data-tauri-drag-region />
      <button className={`environment-badge ${environment}`} onClick={() => setEnvConfirm(environment === "sim" ? "live" : "sim")}><span />{environment.toUpperCase()}<ChevronDown size={13} /></button>
      <button className="connection-chip" onClick={() => !authenticated && setSetupOpen(true)}><Wifi size={13} /><span>{connectionLabel}</span></button>
      <IconButton label="Notifications"><Bell size={17} /></IconButton>
      <IconButton label="Settings" onClick={() => setSetupOpen(true)}><Settings2 size={17} /></IconButton>
    </header>

    <nav className="toolbar" aria-label="Chart toolbar">
      <button className="symbol-control" onClick={() => setSearchOpen(true)}><Search size={16} /><strong>{workspace.symbol.symbol}</strong><span>{workspace.symbol.exchange}</span><ChevronDown size={14} /></button>
      <div className="divider" />
      <div className="timeframe-group">{timeframes.map((tf) => <button key={tf} className={workspace.timeframe === tf ? "active" : ""} onClick={() => updateWorkspace({ timeframe: tf })}>{tf}</button>)}</div>
      <div className="divider" />
      <div className="chart-kinds">
        <IconButton label="Candlestick chart" active={workspace.chartKind === "candles"} onClick={() => updateWorkspace({ chartKind: "candles" })}><BarChart3 size={17} /></IconButton>
        <IconButton label="Line chart" active={workspace.chartKind === "line"} onClick={() => updateWorkspace({ chartKind: "line" })}><LineChart size={17} /></IconButton>
        <IconButton label="Area chart" active={workspace.chartKind === "area"} onClick={() => updateWorkspace({ chartKind: "area" })}><Activity size={17} /></IconButton>
      </div>
      <div className="toolbar-popover-anchor">
        <button className={`text-tool-button ${indicatorOpen ? "active" : ""}`} onClick={() => setIndicatorOpen((value) => !value)}><SlidersHorizontal size={16} />Indicators</button>
        {indicatorOpen && <div className="popover indicator-popover"><header><strong>Indicators</strong><span>{workspace.indicators.filter((i) => i.visible).length} active</span></header>{workspace.indicators.map((indicator) => <div key={indicator.id} className="indicator-row"><label className="indicator-color" title={`Change ${indicator.kind} ${indicator.period} color`}><input type="color" value={indicator.color} aria-label={`Change ${indicator.kind} ${indicator.period} color`} onChange={(event) => updateIndicator(indicator.id, { color: event.target.value })} /><span className="indicator-swatch" style={{ background: indicator.color }} /></label><button className="indicator-toggle-button" aria-pressed={indicator.visible} onClick={() => updateIndicator(indicator.id, { visible: !indicator.visible })}><span><strong>{indicator.kind}</strong><small>{indicator.kind === "VWAP" ? "Session" : `Length ${indicator.period}`}</small></span><span className={`toggle ${indicator.visible ? "on" : ""}`} /></button></div>)}</div>}
      </div>
      <button className="text-tool-button"><Bell size={16} />Alert</button>
      <div className="divider" />
      <IconButton label="Undo"><Undo2 size={17} /></IconButton>
      <IconButton label="Reset chart"><RotateCcw size={17} /></IconButton>
      <span className="toolbar-spacer" />
      <IconButton label="Toggle bottom panel" active={workspace.bottomPanelOpen} onClick={() => updateWorkspace({ bottomPanelOpen: !workspace.bottomPanelOpen })}><PanelBottom size={17} /></IconButton>
      <IconButton label="Toggle right panel" active={workspace.rightPanelOpen} onClick={() => updateWorkspace({ rightPanelOpen: !workspace.rightPanelOpen })}><PanelRight size={17} /></IconButton>
      <IconButton label="Fullscreen"><Maximize2 size={17} /></IconButton>
    </nav>

    <section className={`workspace ${workspace.rightPanelOpen ? "with-right" : ""} ${workspace.bottomPanelOpen ? "with-bottom" : ""}`} style={{ "--bottom-height": `${workspace.bottomPanelHeight ?? 360}px` } as React.CSSProperties}>
      <aside className="drawing-rail" aria-label="Drawing tools">
        {[
          ["cursor", MousePointer2, "Cursor"], ["crosshair", Crosshair, "Crosshair"],
        ].map(([id, Icon, label]) => <IconButton key={id as string} label={label as string} active={activeTool === id} onClick={() => setActiveTool(id as string)}><Icon size={18} /></IconButton>)}
        <IconButton label="Magnet: snap crosshair to candle high or low" active={workspace.magnetEnabled} onClick={() => updateWorkspace({ magnetEnabled: !workspace.magnetEnabled })}><Magnet size={18} /></IconButton>
        {[
          ["trend", PencilLine, "Trend line"],
          ["horizontal", Minus, "Horizontal line"], ["ray", TrendingUp, "Ray"], ["rectangle", RectangleHorizontal, "Rectangle"],
          ["fibonacci", Percent, "Fibonacci retracement"], ["text", TextCursorInput, "Text"], ["measure", Gauge, "Measure"],
        ].map(([id, Icon, label]) => <IconButton key={id as string} label={label as string} active={activeTool === id} onClick={() => setActiveTool(id as string)}><Icon size={18} /></IconButton>)}
        <span className="rail-spacer" /><IconButton label="Show drawings"><Eye size={18} /></IconButton><IconButton label="Delete drawings"><Trash2 size={18} /></IconButton>
      </aside>

      <TradingChart bars={bars} kind={workspace.chartKind} magnetEnabled={workspace.magnetEnabled} symbol={workspace.symbol.symbol} description={workspace.symbol.description} exchange={workspace.symbol.exchange} timeframe={workspace.timeframe} indicators={workspace.indicators} orders={orders} positions={positions} timezone={workspace.chartTimezone} onTimezoneChange={(chartTimezone) => updateWorkspace({ chartTimezone })} onLoadOlder={loadOlder} loadingOlder={loadingOlder} />

      {workspace.rightPanelOpen && <aside className="right-panel">
        <div className="panel-tabs"><button className={workspace.rightTab === "order" ? "active" : ""} onClick={() => updateWorkspace({ rightTab: "order" })}>Order</button><button className={workspace.rightTab === "watchlist" ? "active" : ""} onClick={() => updateWorkspace({ rightTab: "watchlist" })}>Watchlist</button></div>
        {workspace.rightTab === "order" ? <OrderTicket symbol={workspace.symbol} quote={activeQuote} account={selectedAccount} environment={environment} busy={busy} onReview={openReview} /> : <Watchlist symbols={workspace.watchlist} quotes={quotes} active={workspace.symbol.symbol} onSelect={(symbol) => { const meta = futures.find((item) => item.symbol === symbol); if (meta) updateWorkspace({ symbol: meta }); }} />}
      </aside>}

      {workspace.bottomPanelOpen && <BottomPanel workspace={workspace} updateWorkspace={updateWorkspace} accounts={accounts} account={selectedAccount} positions={positions} orders={orders} balances={balances} bodBalances={bodBalances} history={history} setHistory={setHistory} loading={brokerageLoading} error={brokerageError} notifications={notifications} onNotify={(item) => setNotifications((current) => [item, ...current].slice(0, 250))} onCancel={async (id) => { await api.cancelOrder(id); setOrders((current) => current.map((order) => order.id === id ? { ...order, status: "Cancelled", closedAt: new Date().toISOString() } : order)); setNotifications((current) => [{ id: crypto.randomUUID(), time: new Date().toISOString(), title: "Order cancellation sent", text: `Cancellation requested for order ${id}`, level: "warning" }, ...current]); }} />}
    </section>

    {searchOpen && <Modal title="Select futures contract" onClose={() => setSearchOpen(false)} width={620}><div className="search-box"><Search size={17} /><input autoFocus placeholder="Search symbol or contract name" value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="symbol-results">{searchResults.map((result) => <button key={result.symbol} onClick={() => { updateWorkspace({ symbol: result }); setSearchOpen(false); setSearch(""); }}><span className="future-icon">F</span><span><strong>{result.symbol}</strong><small>{result.description}</small></span><span className="result-meta">{result.exchange}<small>{result.expiration}</small></span></button>)}{!searchResults.length && <div className="empty-state">No futures contracts matched “{search}”.</div>}</div></Modal>}

    {setupOpen && <Modal title="Connect TradeStation" onClose={() => setSetupOpen(false)}><div className="setup-intro"><LockKeyhole size={20} /><div><strong>Credentials stay on this device</strong><p>Your secret and refresh token are handled by the native process and stored in the operating system credential vault.</p></div></div>{!api.isNative && <div className="demo-warning">You are viewing the browser-safe demo. Launch with <code>npm run tauri dev</code> to connect.</div>}<label className="field"><span>Auth0 API key / client ID</span><input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Enter client ID" autoComplete="off" /></label><label className="field"><span>Client secret</span><input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder="Enter client secret" autoComplete="new-password" /></label><div className="callback-note"><span>Callback URL</span><code>http://localhost:8080</code></div><button className="primary-button" disabled={busy || !api.isNative} onClick={connect}>{busy ? "Starting…" : "Continue to TradeStation"}</button></Modal>}

    {envConfirm && <Modal title={`Switch to ${envConfirm.toUpperCase()}?`} onClose={() => setEnvConfirm(null)}><div className={`environment-confirm ${envConfirm}`}><Zap size={22} /><div><strong>{envConfirm === "live" ? "Real orders and real money" : "Simulated execution"}</strong><p>{envConfirm === "live" ? "Changing to LIVE clears SIM account data and disables quick-submit for this session." : "SIM uses a separate account environment and simulated fills."}</p></div></div><div className="modal-actions"><button className="secondary-button" onClick={() => setEnvConfirm(null)}>Cancel</button><button className={envConfirm === "live" ? "danger-button" : "primary-button"} disabled={busy} onClick={confirmEnvironment}>Switch to {envConfirm.toUpperCase()}</button></div></Modal>}

    {review && <Modal title="Review order" onClose={() => setReview(null)}><div className="review-hero"><span className={review.draft.side === "Buy" ? "buy" : "sell"}>{review.draft.side}</span><strong>{review.draft.quantity} {review.draft.symbol}</strong><small>{review.draft.type} · {review.draft.duration}</small></div><dl className="review-list"><div><dt>Estimated commission</dt><dd>{review.preview.estimatedCommission ?? "—"}</dd></div><div><dt>Initial margin</dt><dd>{review.preview.initialMargin ?? "—"}</dd></div><div><dt>Environment</dt><dd className={environment === "live" ? "negative" : "cyan"}>{environment.toUpperCase()}</dd></div></dl><p className="preview-summary">{review.preview.summary}</p><button className={review.draft.side === "Buy" ? "buy-button" : "sell-button"} disabled={!review.preview.valid || busy} onClick={submitReviewed}>Send {review.draft.side} order</button></Modal>}

    {toast && <div className="toast" role="status">{toast}</div>}
  </main>;
}

function Watchlist({ symbols, quotes, active, onSelect }: { symbols: string[]; quotes: Record<string, Quote>; active: string; onSelect: (symbol: string) => void }) {
  return <div className="watchlist"><header><span>Symbol</span><span>Last</span><span>Chg%</span></header>{symbols.map((symbol) => { const quote = quotes[symbol] ?? quoteFor(symbol); return <button key={symbol} className={active === symbol ? "active" : ""} onClick={() => onSelect(symbol)}><span><strong>{symbol}</strong><small>{futures.find((f) => f.symbol === symbol)?.exchange}</small></span><b>{quote.last.toLocaleString(undefined, { minimumFractionDigits: 2 })}</b><em className={quote.changePct >= 0 ? "positive" : "negative"}>{quote.changePct >= 0 ? "+" : ""}{quote.changePct.toFixed(2)}%</em></button>; })}</div>;
}

function OrderTicket({ symbol, quote, account, environment, busy, onReview }: { symbol: SymbolMeta; quote: Quote; account?: Account; environment: TradingEnvironment; busy: boolean; onReview: (draft: OrderDraft) => void }) {
  const [side, setSide] = useState<"Buy" | "Sell">("Buy");
  const [type, setType] = useState<OrderType>("Market");
  const [quantity, setQuantity] = useState(1);
  const [limitPrice, setLimitPrice] = useState(quote.ask);
  const [stopPrice, setStopPrice] = useState(quote.ask + symbol.minMove * 4);
  const [duration, setDuration] = useState<"DAY" | "GTC">("DAY");
  const [takeProfitOn, setTakeProfitOn] = useState(false);
  const [stopLossOn, setStopLossOn] = useState(false);

  useEffect(() => { setLimitPrice(quote.ask); setStopPrice(quote.ask + symbol.minMove * 4); }, [symbol.symbol]);
  const invalidTick = (type === "Limit" || type === "StopLimit") && !validateTick(limitPrice, symbol.minMove) || (type === "StopMarket" || type === "StopLimit") && !validateTick(stopPrice, symbol.minMove);

  function draft(): OrderDraft {
    return { accountId: account?.id ?? "", symbol: symbol.symbol, side, type, quantity, duration, limitPrice: type === "Limit" || type === "StopLimit" ? limitPrice : undefined, stopPrice: type === "StopMarket" || type === "StopLimit" ? stopPrice : undefined, takeProfit: takeProfitOn ? roundToTick(side === "Buy" ? quote.last + symbol.minMove * 20 : quote.last - symbol.minMove * 20, symbol.minMove) : undefined, stopLoss: stopLossOn ? roundToTick(side === "Buy" ? quote.last - symbol.minMove * 12 : quote.last + symbol.minMove * 12, symbol.minMove) : undefined };
  }

    const marketUnavailable = quote.last <= 0 || quote.halted || quote.delayed || !quote.receivedAt || Date.now() - quote.receivedAt > 5_000;
  return <div className="order-ticket">
    <div className="account-line"><span>{account?.displayId ?? "No account"}</span><span className={environment}>{environment.toUpperCase()}</span></div>
    <div className="market-buttons"><button className={side === "Sell" ? "selected" : ""} onClick={() => setSide("Sell")}><small>SELL</small><strong>{quote.bid.toFixed(2)}</strong></button><div><span>{(quote.ask - quote.bid).toFixed(2)}</span></div><button className={side === "Buy" ? "selected" : ""} onClick={() => setSide("Buy")}><small>BUY</small><strong>{quote.ask.toFixed(2)}</strong></button></div>
    <div className="order-types">{(["Market", "Limit", "StopMarket", "StopLimit"] as OrderType[]).map((item) => <button key={item} className={type === item ? "active" : ""} onClick={() => setType(item)}>{item.replace("Market", " Mkt").trim()}</button>)}</div>
    <label className="field compact"><span>Contracts</span><div className="stepper"><button onClick={() => setQuantity(Math.max(1, quantity - 1))}><Minus size={14} /></button><input type="number" min="1" value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))} /><button onClick={() => setQuantity(quantity + 1)}><Plus size={14} /></button></div></label>
    {(type === "Limit" || type === "StopLimit") && <label className="field compact"><span>Limit price</span><input className={invalidTick ? "invalid" : ""} type="number" step={symbol.minMove} value={limitPrice} onChange={(e) => setLimitPrice(Number(e.target.value))} /></label>}
    {(type === "StopMarket" || type === "StopLimit") && <label className="field compact"><span>Stop price</span><input className={invalidTick ? "invalid" : ""} type="number" step={symbol.minMove} value={stopPrice} onChange={(e) => setStopPrice(Number(e.target.value))} /></label>}
    <div className="section-label"><span>Exits</span><small>Server-side bracket</small></div>
    <label className="switch-row"><span><strong>Take profit</strong><small>20 ticks · {(symbol.minMove * 20 * symbol.pointValue).toFixed(2)} USD</small></span><input type="checkbox" checked={takeProfitOn} onChange={(e) => setTakeProfitOn(e.target.checked)} /></label>
    <label className="switch-row"><span><strong>Stop loss</strong><small>12 ticks · {(symbol.minMove * 12 * symbol.pointValue).toFixed(2)} USD</small></span><input type="checkbox" checked={stopLossOn} onChange={(e) => setStopLossOn(e.target.checked)} /></label>
    <div className="section-label"><span>Time in force</span></div>
    <select value={duration} onChange={(e) => setDuration(e.target.value as "DAY" | "GTC")}><option value="DAY">DAY</option><option value="GTC">GTC</option></select>
    <dl className="ticket-info"><div><dt>Tick value</dt><dd>{(symbol.minMove * symbol.pointValue).toFixed(2)} USD</dd></div><div><dt>Data</dt><dd className={quote.delayed ? "negative" : "positive"}>{quote.delayed ? "Delayed" : "Real-time"}</dd></div></dl>
    <button className={side === "Buy" ? "buy-button" : "sell-button"} disabled={busy || invalidTick || !account || marketUnavailable} onClick={() => onReview(draft())}>{marketUnavailable ? "Market data unavailable" : `Review ${side} order`}</button>
  </div>;
}

function BottomPanel({ workspace, updateWorkspace, accounts, account, positions, orders, balances, bodBalances, history, setHistory, loading, error, notifications, onNotify, onCancel }: {
  workspace: WorkspaceState; updateWorkspace: (patch: Partial<WorkspaceState>) => void; accounts: Account[]; account?: Account; positions: Position[]; orders: OrderUpdate[]; balances: AccountBalance[]; bodBalances: AccountBalance[]; history: HistoricalOrderPage; setHistory: React.Dispatch<React.SetStateAction<HistoricalOrderPage>>; loading: boolean; error?: string; notifications: ActivityNotification[]; onNotify: (item: ActivityNotification) => void; onCancel: (id: string) => void;
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
    <div className="account-summary"><select value={account?.id ?? ""} onChange={(event) => updateWorkspace({ selectedAccountId: event.target.value })}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.displayId} {item.currency}</option>)}</select><dl><div><dt>Net worth</dt><dd>{money(balance?.equity)}</dd></div><div><dt>Realized PnL</dt><dd>{money(balance?.todaysProfitLoss)}</dd></div><div><dt>Unrealized PnL</dt><dd>{money(balance?.unrealizedProfitLoss ?? positions.reduce((sum, item) => sum + item.unrealizedPnl, 0))}</dd></div></dl></div>
    <nav className="bottom-tabs">{tabs.map(([tab, label]) => <button key={tab} className={workspace.bottomTab === tab ? "active" : ""} onClick={() => updateWorkspace({ bottomTab: tab })}>{label}</button>)}<button className="export-button" title="Export active tab to CSV" onClick={exportRows}><Download size={16} /></button></nav>
    <div className="table-wrap">{error && <div className="panel-error">{error}</div>}
      {workspace.bottomTab === "positions" && (positions.length ? <table><thead><tr><th>Symbol</th><th>Side</th><th>Quantity</th><th>Avg price</th><th>Stop loss</th><th>Take profit</th><th>Last price</th><th>Bid price</th><th>Ask price</th><th>Unrealized PnL</th><th>PnL quantity</th><th>PnL percent</th></tr></thead><tbody>{positions.map((p) => <tr key={p.id}><td><strong>{p.symbol}</strong></td><td className={p.side === "Long" ? "buy-text" : "negative"}>{p.side}</td><td>{p.quantity}</td><td>{money(p.averagePrice)}</td><td>—</td><td>—</td><td>{money(p.last)}</td><td>{money(p.bid)}</td><td>{money(p.ask)}</td><td className={p.unrealizedPnl >= 0 ? "positive" : "negative"}>{money(p.unrealizedPnl)}</td><td>{money(p.unrealizedPnlQuantity)}</td><td>{p.unrealizedPnlPercent == null ? "—" : `${p.unrealizedPnlPercent.toFixed(2)}%`}</td></tr>)}</tbody></table> : <Empty label="There are no open positions in this account" />)}
      {workspace.bottomTab === "orders" && <><div className="table-filters">{["All", "Working", "Inactive", "Filled", "Cancelled", "Rejected"].map((filter) => <button key={filter} className={orderFilter === filter ? "active" : ""} onClick={() => setOrderFilter(filter)}>{filter}</button>)}</div><OrderTable rows={visibleOrders} /></>}
      {workspace.bottomTab === "history" && <><div className="history-controls"><label>From <input type="date" value={since} max={until} onChange={(e) => setSince(e.target.value)} /></label><label>To <input type="date" value={until} min={since} onChange={(e) => setUntil(e.target.value)} /></label>{["All", "Filled", "Cancelled", "Rejected"].map((filter) => <button key={filter} className={historyFilter === filter ? "active" : ""} onClick={() => setHistoryFilter(filter)}>{filter}</button>)}</div><OrderTable rows={visibleHistory} />{history.nextToken && <button className="load-more" disabled={historyLoading} onClick={() => loadHistory(true)}>{historyLoading ? "Loading…" : "Load more"}</button>}</>}
      {workspace.bottomTab === "summary" && <div className="balance-sections"><BalanceSection title="Real-time" balance={balance} money={money} /><BalanceSection title="Beginning of day" balance={bod} money={money} /></div>}
      {workspace.bottomTab === "notifications" && (notifications.length ? <table><thead><tr><th>Symbol</th><th>Time</th><th>Title</th><th>Text</th></tr></thead><tbody>{notifications.map((item) => <tr key={item.id}><td>{item.symbol ?? "—"}</td><td>{time(item.time)}</td><td className={item.level === "error" ? "negative" : ""}>{item.title}</td><td>{item.text}</td></tr>)}</tbody></table> : <Empty label="There is no activity here yet" />)}
    </div></section>;
}

function BalanceSection({ title, balance, money }: { title: string; balance?: AccountBalance; money: (value?: number) => string }) {
  const cells: Array<[string, number | undefined]> = [["Currency", undefined], ["Account balance", balance?.cashBalance], ["Realized PnL", balance?.todaysProfitLoss], ["Unrealized PnL", balance?.unrealizedProfitLoss], ["Net worth", balance?.equity], ["Commission", balance?.commission], ["Uncleared deposits", balance?.unclearedDeposit], ["Real time BP", balance?.buyingPower], ["Initial margin", balance?.initialMargin], ["Maintenance margin", balance?.maintenanceMargin], ["Open order margin", balance?.openOrderMargin]];
  return <section><h3>{title}</h3><div className="balance-grid">{cells.map(([label, value], index) => <div key={label}><span>{label}</span><strong>{index === 0 ? balance?.currency ?? "—" : money(value)}</strong></div>)}</div></section>;
}
