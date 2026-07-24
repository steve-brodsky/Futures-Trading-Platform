import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, CalendarDays, ChevronLeft, ChevronRight, Cloud, CloudOff, Expand, Image as ImageIcon, RefreshCw, Save, ShieldCheck, Tag, TrendingUp, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { availableMonitors, getCurrentWindow, primaryMonitor, type Window as TauriWindow } from "@tauri-apps/api/window";
import { api } from "../lib/bridge";
import { journalCalendarDates, journalProjectedTargetR, journalStatsNeedsRefresh, journalTimelineEvents } from "../lib/journal";
import {
  JOURNAL_WINDOW_GEOMETRY_STORAGE_KEY,
  LEGACY_JOURNAL_WINDOW_GEOMETRY_STORAGE_KEY,
  defaultJournalWindowGeometry,
  fitJournalWindowGeometry,
  parseJournalWindowGeometry,
  type JournalWindowGeometryV2,
} from "../lib/journalWindowGeometry";
import type { JournalAuthStatus, JournalDaySummary, JournalMonthSummary, JournalScope, JournalSyncStatus, JournalTrade, PreferenceRealtimeStateEvent } from "../types";
import { TradeJournalStats } from "./TradeJournalStats";

const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dayHeading = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const journalTime = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });

function money(value: number | undefined, dash = "—"): string {
  if (value == null || !Number.isFinite(value)) return dash;
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function price(value?: number): string {
  return value == null ? "—" : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function multiple(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function metricClass(value?: number): string {
  return value == null || value === 0 ? "" : value > 0 ? "positive" : "negative";
}

function maskAccount(value: string): string {
  if (value.includes("•") || value.length <= 4) return value;
  return `${value.slice(0, 3)} ··${value.slice(-4)}`;
}

function writeJournalWindowGeometry(geometry: JournalWindowGeometryV2): void {
  localStorage.setItem(JOURNAL_WINDOW_GEOMETRY_STORAGE_KEY, JSON.stringify(geometry));
}

async function restoreJournalWindowGeometry(current: TauriWindow): Promise<void> {
  const stored = parseJournalWindowGeometry(localStorage.getItem(JOURNAL_WINDOW_GEOMETRY_STORAGE_KEY));
  localStorage.removeItem(LEGACY_JOURNAL_WINDOW_GEOMETRY_STORAGE_KEY);

  const [innerSize, outerSize, monitors, preferredMonitor] = await Promise.all([
    current.innerSize(),
    current.outerSize(),
    availableMonitors(),
    primaryMonitor(),
  ]);
  const frame = {
    width: Math.max(0, outerSize.width - innerSize.width),
    height: Math.max(0, outerSize.height - innerSize.height),
  };
  const desired = stored
    ? fitJournalWindowGeometry(stored, frame, monitors, preferredMonitor)
    : defaultJournalWindowGeometry(monitors, preferredMonitor, frame);

  await current.setSize(new PhysicalSize(desired.innerWidth, desired.innerHeight));
  await current.setPosition(new PhysicalPosition(desired.x, desired.y));

  const [movedInnerSize, movedOuterSize] = await Promise.all([current.innerSize(), current.outerSize()]);
  const movedFrame = {
    width: Math.max(0, movedOuterSize.width - movedInnerSize.width),
    height: Math.max(0, movedOuterSize.height - movedInnerSize.height),
  };
  const fitted = fitJournalWindowGeometry(desired, movedFrame, monitors, preferredMonitor);
  if (fitted.x !== desired.x
    || fitted.y !== desired.y
    || fitted.innerWidth !== desired.innerWidth
    || fitted.innerHeight !== desired.innerHeight) {
    await current.setSize(new PhysicalSize(fitted.innerWidth, fitted.innerHeight));
    await current.setPosition(new PhysicalPosition(fitted.x, fitted.y));
  }

  const [position, appliedInnerSize] = await Promise.all([current.outerPosition(), current.innerSize()]);
  writeJournalWindowGeometry({
    version: 2,
    x: Math.round(position.x),
    y: Math.round(position.y),
    innerWidth: Math.round(appliedInnerSize.width),
    innerHeight: Math.round(appliedInnerSize.height),
  });
}

async function readJournalWindowGeometry(current: TauriWindow): Promise<JournalWindowGeometryV2 | undefined> {
  const [position, innerSize, maximized, minimized] = await Promise.all([
    current.outerPosition(),
    current.innerSize(),
    current.isMaximized(),
    current.isMinimized(),
  ]);
  if (maximized || minimized) return undefined;
  return parseJournalWindowGeometry({
    version: 2,
    x: Math.round(position.x),
    y: Math.round(position.y),
    innerWidth: Math.round(innerSize.width),
    innerHeight: Math.round(innerSize.height),
  });
}

export function JournalCloudSettings({ compact = false, onConfigured, onConnectionChanged, preferenceSync, preferenceRealtime }: {
  compact?: boolean;
  onConfigured?: () => void;
  onConnectionChanged?: () => void;
  preferenceSync?: { state: "idle" | "syncing" | "synced" | "offline" | "error"; lastSyncedAt?: string; message?: string };
  preferenceRealtime?: PreferenceRealtimeStateEvent;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = `${new Date().getFullYear()}-01-01`;
  const [status, setStatus] = useState<JournalAuthStatus>({ configured: false, authenticated: false });
  const [projectUrl, setProjectUrl] = useState("");
  const [publishableKey, setPublishableKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [backfillStart, setBackfillStart] = useState(defaultStart);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    api.journalAuthStatus().then((next) => {
      setStatus(next);
      setProjectUrl(next.projectUrl ?? "");
      setEmail(next.email ?? "");
      setBackfillStart(next.backfillStart ?? defaultStart);
    }).catch((error) => setMessage(String(error)));
  }, []);

  async function connect() {
    if (!projectUrl.trim() || !publishableKey.trim() || !email.trim() || !password || !backfillStart) {
      return setMessage("Project URL, publishable key, email, password, and backfill date are required.");
    }
    setBusy(true); setMessage(undefined);
    try {
      const next = await api.configureJournal(projectUrl.trim(), publishableKey.trim(), email.trim(), password, backfillStart);
      setStatus(next); setPassword(""); setMessage("Supabase connected. Journal and preference synchronization are enabled."); onConfigured?.(); onConnectionChanged?.();
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    try { await api.disconnectJournal(); setStatus({ configured: false, authenticated: false }); setMessage("Supabase session removed from this device. Local data was kept."); onConnectionChanged?.(); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function resetNow() {
    setConfirmReset(false);
    setBusy(true); setMessage(undefined);
    try {
      const next = await api.resetJournalNow();
      setStatus(next); setBackfillStart(next.backfillStart ?? today);
      setMessage("Journal cleared. Recording will begin with orders created after the new cutoff.");
      onConfigured?.();
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  function requestReset() {
    if (!status.authenticated) {
      setMessage("Reconnect the Supabase journal first so Northstar can clear both this Mac and the cloud copy.");
      return;
    }
    setMessage(undefined);
    setConfirmReset(true);
  }

  const preferenceVisualState = preferenceSync?.state === "offline" || preferenceSync?.state === "error"
    ? preferenceSync.state
    : preferenceRealtime?.state === "reconnecting"
      ? "offline"
      : preferenceRealtime?.state === "connected"
        ? "synced"
        : preferenceSync?.state ?? "idle";

  return <section className={`journal-cloud-settings ${compact ? "compact" : ""}`}>
    <header><div className="journal-cloud-icon"><ShieldCheck size={18} /></div><div><span>Private cloud</span><h3>Supabase connection</h3><p>Journal data and non-secret app preferences are owner-scoped. The refresh token stays in a separate operating-system vault record.</p></div><i className={status.authenticated ? "connected" : ""}>{status.authenticated ? "Connected" : "Not connected"}</i></header>
    {!api.isNative && <p className="journal-inline-notice">Cloud setup is disabled in browser demo mode.</p>}
    <div className="journal-cloud-fields">
      <label><span>Project URL</span><input value={projectUrl} onChange={(event) => setProjectUrl(event.target.value)} placeholder="https://project.supabase.co" disabled={!api.isNative || busy} /></label>
      <label><span>Publishable key</span><input value={publishableKey} onChange={(event) => setPublishableKey(event.target.value)} placeholder="sb_publishable_…" type="password" disabled={!api.isNative || busy} /></label>
      <label><span>Email</span><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="username" disabled={!api.isNative || busy} /></label>
      <label><span>Password</span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" placeholder={status.configured ? "Enter to reconnect" : "Supabase password"} disabled={!api.isNative || busy} /></label>
      <label><span>Backfill from (inclusive)</span><input value={backfillStart} onChange={(event) => setBackfillStart(event.target.value)} type="date" max={today} disabled={!api.isNative || busy} /></label>
    </div>
    <p className="journal-backfill-help">A backfill date includes that entire day through today. To ignore all earlier executions and begin at the current moment, use Start fresh now.</p>
    {status.recordFrom && <p className="journal-recording-cutoff">Recording from {new Date(status.recordFrom).toLocaleString()}.</p>}
    {preferenceSync && <p className={`journal-settings-message preference-sync-${preferenceVisualState}`} role="status">
      {preferenceSync.state === "offline" || preferenceSync.state === "error" ? preferenceSync.message ?? "App preference sync failed."
        : preferenceRealtime?.state === "connected" ? `Live preference sync connected${preferenceSync.lastSyncedAt ? ` · Last synced ${new Date(preferenceSync.lastSyncedAt).toLocaleString()}` : ""}.`
        : preferenceRealtime?.state === "connecting" ? "Connecting live preference sync…"
        : preferenceRealtime?.state === "reconnecting" ? `Live preference sync is reconnecting; 30-second fallback checks are active${preferenceRealtime.message ? `: ${preferenceRealtime.message}` : "."}`
        : preferenceSync.state === "syncing" ? "Syncing app preferences…"
        : preferenceSync.state === "synced" ? `App preferences synced${preferenceSync.lastSyncedAt ? ` ${new Date(preferenceSync.lastSyncedAt).toLocaleString()}` : ""}.`
        : preferenceSync.message ?? "App preference sync is idle."}
    </p>}
    {message && <p className="journal-settings-message" role="status">{message}</p>}
    <div className="journal-cloud-actions"><button className="danger-button" disabled={busy || !api.isNative} onClick={requestReset}>Start fresh now</button><button className="secondary-button" disabled={busy || !status.configured} onClick={disconnect}>Disconnect</button><button className="primary-button" disabled={busy || !api.isNative} onClick={connect}>{busy ? "Working…" : status.configured ? "Reconnect" : "Connect Supabase"}</button></div>
    {confirmReset && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmReset(false); }}><section className="modal journal-reset-confirm" role="dialog" aria-modal="true" aria-labelledby="journal-reset-title"><header><h2 id="journal-reset-title">Start the Trade Journal fresh now?</h2><button className="icon-button" aria-label="Cancel journal reset" onClick={() => setConfirmReset(false)}><X size={17} /></button></header><div className="journal-reset-copy"><strong>This permanently deletes the current journal.</strong><p>All local and Supabase trades, annotations, and execution history will be removed. Only broker orders created after the new exact-time cutoff will be recorded.</p></div><div className="modal-actions"><button className="secondary-button" onClick={() => setConfirmReset(false)}>Cancel</button><button className="danger-button" onClick={resetNow}>Delete history and start now</button></div></section></div>}
  </section>;
}

export function TradeJournalWindow() {
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [page, setPage] = useState<"calendar" | "stats">(
    new URLSearchParams(window.location.search).get("journalPage") === "stats" ? "stats" : "calendar",
  );
  const [view, setView] = useState<{ kind: "month" } | { kind: "day"; date: string }>({ kind: "month" });
  const [mode, setMode] = useState<"pnl" | "r">("pnl");
  const [auth, setAuth] = useState<JournalAuthStatus>({ configured: !api.isNative, authenticated: !api.isNative });
  const [sync, setSync] = useState<JournalSyncStatus>({ state: "idle", pendingEvents: 0 });
  const [scopes, setScopes] = useState<JournalScope[]>([]);
  const [scope, setScope] = useState<JournalScope>();
  const [month, setMonth] = useState<JournalMonthSummary>();
  const [day, setDay] = useState<JournalDaySummary>();
  const [selectedTrade, setSelectedTrade] = useState<JournalTrade>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showSetup, setShowSetup] = useState(false);
  const [journalRevision, setJournalRevision] = useState(0);
  const selectedTradeIdRef = useRef<string | undefined>(undefined);
  const geometryInitializationRef = useRef<Promise<void> | null>(null);

  useEffect(() => { selectedTradeIdRef.current = selectedTrade?.id; }, [selectedTrade?.id]);

  const loadScopes = useCallback(async () => {
    const [authStatus, nextScopes] = await Promise.all([api.journalAuthStatus(), api.journalScopes()]);
    setAuth(authStatus); setScopes(nextScopes);
    if (nextScopes.length === 0) setSelectedTrade(undefined);
    setScope((current) => nextScopes.find((item) => current && item.accountId === current.accountId && item.environment === current.environment) ?? nextScopes[0]);
    if (api.isNative && !authStatus.configured) setShowSetup(true);
  }, []);

  useEffect(() => { loadScopes().catch((reason) => setError(String(reason))).finally(() => setLoading(false)); }, [loadScopes]);

  useEffect(() => {
    if (!api.isNative) return;
    const current = getCurrentWindow();
    let active = true;
    let moved: (() => void) | undefined;
    let resized: (() => void) | undefined;
    let timer: number | undefined;
    let saveGeneration = 0;

    geometryInitializationRef.current ??= restoreJournalWindowGeometry(current);
    const remember = () => {
      if (!active) return;
      const generation = ++saveGeneration;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void readJournalWindowGeometry(current).then((geometry) => {
          if (active && generation === saveGeneration && geometry) writeJournalWindowGeometry(geometry);
        }).catch(() => undefined);
      }, 180);
    };

    void (async () => {
      try {
        await geometryInitializationRef.current;
      } catch {
        localStorage.removeItem(JOURNAL_WINDOW_GEOMETRY_STORAGE_KEY);
        localStorage.removeItem(LEGACY_JOURNAL_WINDOW_GEOMETRY_STORAGE_KEY);
      }
      if (!active) return;

      let nextMoved: (() => void) | undefined;
      let nextResized: (() => void) | undefined;
      try {
        nextMoved = await current.onMoved(remember);
        if (!active) { nextMoved(); return; }
        nextResized = await current.onResized(remember);
        if (!active) { nextMoved(); nextResized(); return; }
        moved = nextMoved;
        resized = nextResized;
      } catch {
        nextMoved?.();
        nextResized?.();
      }

      try {
        await current.show();
        if (active) await current.setFocus();
      } catch { /* the current native window may already be closing */ }
      remember();
    })();

    return () => {
      active = false;
      saveGeneration += 1;
      window.clearTimeout(timer);
      moved?.();
      resized?.();
    };
  },[]);

  useEffect(() => {
    if (!api.isNative) return;
    let cleanup: (() => void) | undefined; let disposed = false;
    listen<{ reason?: string }>("journal-updated", ({ payload }) => {
      if (journalStatsNeedsRefresh(payload.reason)) setJournalRevision((current) => current + 1);
      void loadScopes().catch(() => undefined);
      if (scope) api.journalMonth(scope, cursor.year, cursor.month).then(setMonth).catch(() => undefined);
      if (scope && view.kind === "day") api.journalDay(scope, view.date).then(setDay).catch(() => undefined);
      const selectedTradeId = selectedTradeIdRef.current;
      if (selectedTradeId) api.journalTrade(selectedTradeId).then((next) => {
        setSelectedTrade((current) => current?.id === selectedTradeId ? next : current);
      }).catch(() => undefined);
    }).then((unlisten) => { if (disposed) unlisten(); else cleanup = unlisten; });
    return () => { disposed = true; cleanup?.(); };
  }, [scope?.accountId, scope?.environment, cursor.year, cursor.month, view.kind === "day" ? view.date : "month"]);

  useEffect(() => {
    if (!scope) { setMonth(undefined); return; }
    setLoading(true); setError(undefined);
    api.journalMonth(scope, cursor.year, cursor.month).then(setMonth).catch((reason) => setError(String(reason))).finally(() => setLoading(false));
  }, [scope?.accountId, scope?.environment, cursor.year, cursor.month]);

  useEffect(() => {
    if (!scope || view.kind !== "day") { setDay(undefined); return; }
    setLoading(true); setError(undefined);
    api.journalDay(scope, view.date).then(setDay).catch((reason) => setError(String(reason))).finally(() => setLoading(false));
  }, [scope?.accountId, scope?.environment, view.kind === "day" ? view.date : "month"]);

  async function runSync() {
    setSync((current) => ({ ...current, state: "syncing", message: "Reconciling orders and flushing the outbox…" }));
    try { setSync(await api.syncJournal(scope)); await loadScopes(); if (scope) setMonth(await api.journalMonth(scope, cursor.year, cursor.month)); }
    catch (reason) { setSync({ state: "error", pendingEvents: sync.pendingEvents, message: String(reason) }); }
  }

  function moveMonth(delta: number) {
    const date = new Date(Date.UTC(cursor.year, cursor.month - 1 + delta, 1));
    setCursor({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 });
  }

  async function openTrade(trade: JournalTrade) {
    setSelectedTrade(trade);
    try {
      const detail = await api.journalTrade(trade.id);
      setSelectedTrade((current) => current?.id === trade.id ? detail : current);
    } catch { /* summary row remains useful */ }
  }

  async function openStatsTrade(tradeId: string) {
    try { setSelectedTrade(await api.journalTrade(tradeId)); }
    catch { /* stats remain useful if a trade changed during refresh */ }
  }

  const dates = useMemo(() => journalCalendarDates(cursor.year, cursor.month), [cursor]);
  const dayMap = useMemo(() => new Map(month?.days.map((item) => [item.date, item]) ?? []), [month]);
  const activeScopeValue = scope ? `${scope.environment}:${scope.accountId}` : "";

  return <main className="journal-shell">
    <header className="journal-titlebar">
      <div className="journal-brand"><div><TrendingUp size={15} /></div><span>NORTHSTAR</span><small>JOURNAL</small></div>
      <div className="journal-drag" data-tauri-drag-region />
      <div className={`journal-sync-state ${sync.state}`} title={sync.message}><span />{sync.state === "syncing" ? "Syncing" : sync.pendingEvents ? `${sync.pendingEvents} pending` : auth.authenticated ? "Cloud ready" : api.isNative ? "Local only" : "Demo"}</div>
    </header>

    <nav className="journal-nav">
      <div className="journal-nav-title"><BookOpen size={18} /><div><strong>Trade Journal</strong><span>Futures execution ledger</span></div></div>
      <div className="journal-view-switch" aria-label="Journal page">
        <button className={page === "calendar" ? "active" : ""} aria-pressed={page === "calendar"} onClick={() => { setPage("calendar"); setSelectedTrade(undefined); }}><CalendarDays size={14} />Calendar</button>
        <button className={page === "stats" ? "active" : ""} aria-pressed={page === "stats"} onClick={() => { setPage("stats"); setSelectedTrade(undefined); }}><TrendingUp size={14} />Stats</button>
      </div>
      <div className="journal-nav-controls">
        <select aria-label="Journal account and environment" value={activeScopeValue} onChange={(event) => setScope(scopes.find((item) => `${item.environment}:${item.accountId}` === event.target.value))}>
          {!scopes.length && <option value="">No journal accounts</option>}
          {scopes.map((item) => <option key={`${item.environment}:${item.accountId}`} value={`${item.environment}:${item.accountId}`}>{item.environment.toUpperCase()} · {maskAccount(item.accountLabel || item.accountId)}</option>)}
        </select>
        <button className="journal-nav-button" onClick={() => setShowSetup(true)}><Cloud size={15} />Cloud</button>
        <button className="journal-nav-button primary" disabled={sync.state === "syncing" || (api.isNative && !auth.configured)} onClick={runSync}><RefreshCw size={15} className={sync.state === "syncing" ? "spin" : ""} />Sync</button>
      </div>
    </nav>

    <section className={`journal-content ${page === "stats" ? "stats" : view.kind}`}>
      {page === "stats" ? <TradeJournalStats
        scope={scope}
        refreshKey={journalRevision}
        onDay={(date) => { setView({ kind: "day", date }); setPage("calendar"); setSelectedTrade(undefined); }}
        onTrade={(tradeId) => { void openStatsTrade(tradeId); }}
      /> : view.kind === "month" ? <>
        <div className="journal-month-heading"><div><span>Monthly performance</span><h1>{monthLabel.format(new Date(Date.UTC(cursor.year, cursor.month - 1, 1)))}</h1></div><div className="journal-month-actions"><div className="journal-mode-toggle"><button className={mode === "pnl" ? "active" : ""} onClick={() => setMode("pnl")}>$ P&amp;L</button><button className={mode === "r" ? "active" : ""} onClick={() => setMode("r")}>R</button></div><button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={18} /></button><button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={18} /></button></div></div>
        <MetricStrip items={[
          ["Net P&L", money(month?.metrics.netPnl), metricClass(month?.metrics.netPnl)],
          ["Trades", String(month?.metrics.trades ?? 0), ""],
          ["Win rate", month?.metrics.winRate == null ? "—" : `${Math.round(month.metrics.winRate * 100)}%`, ""],
          ["Total R", multiple(month?.metrics.totalR), metricClass(month?.metrics.totalR)],
        ]} />
        <div className="journal-calendar" aria-label="Monthly P and L calendar">
          <div className="journal-weekdays">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri"].map((name) => <span key={name}>{name}</span>)}</div>
          <div className="journal-calendar-grid">{dates.map(({ date, inMonth }) => {
            const summary = dayMap.get(date); const value = mode === "pnl" ? summary?.netPnl : summary?.totalR;
            return <button key={date} className={`${inMonth ? "" : "outside"} ${summary ? "has-trades" : ""}`} onClick={() => summary && setView({ kind: "day", date })} disabled={!summary}>
              <time>{date.slice(-2)}</time>{summary && <span className="journal-trade-count">{summary.trades}</span>}
              <strong className={metricClass(value)}>{summary ? mode === "pnl" ? money(summary.netPnl) : multiple(summary.totalR) : "—"}</strong>
            </button>;
          })}</div>
        </div>
      </> : <DayView day={day} date={view.date} loading={loading} onBack={() => { setView({ kind: "month" }); setSelectedTrade(undefined); }} onTrade={openTrade} />}

      {page === "calendar" && loading && <div className="journal-state"><RefreshCw size={20} className="spin" /><span>Loading journal…</span></div>}
      {page === "calendar" && !loading && error && <div className="journal-state error"><CloudOff size={20} /><span>{error}</span><button onClick={runSync}>Retry sync</button></div>}
      {page === "calendar" && !loading && !error && !scope && <div className="journal-state empty"><CalendarDays size={22} /><strong>No journal data yet</strong><span>Connect Supabase and sync a TradeStation account, or place a new trade through Northstar.</span></div>}
    </section>

    {selectedTrade && <TradeDrawer trade={selectedTrade} onClose={() => setSelectedTrade(undefined)} onSaved={(next) => setSelectedTrade(next)} />}
    {showSetup && <div className="journal-modal-backdrop"><section className="journal-setup-modal"><header><div><span>Private cloud storage</span><h2>Trade Journal Cloud</h2></div><button aria-label="Close cloud setup" onClick={() => setShowSetup(false)}><X size={18} /></button></header><JournalCloudSettings compact onConfigured={() => { void loadScopes(); }} /></section></div>}
  </main>;
}

function MetricStrip({ items }: { items: Array<[string, string, string]> }) {
  return <dl className="journal-metric-strip">{items.map(([label, value, className]) => <div key={label}><dt>{label}</dt><dd className={className}>{value}</dd></div>)}</dl>;
}

function DayView({ day, date, loading, onBack, onTrade }: { day?: JournalDaySummary; date: string; loading: boolean; onBack: () => void; onTrade: (trade: JournalTrade) => void }) {
  const metrics = day?.metrics;
  return <>
    <div className="journal-day-heading"><div><button onClick={onBack}><ArrowLeft size={15} />Month</button><h1>{dayHeading.format(new Date(`${date}T00:00:00Z`))}</h1></div><span>{day?.trades.length ?? 0} trades</span></div>
    <MetricStrip items={[
      ["Net P&L", money(metrics?.netPnl), metricClass(metrics?.netPnl)], ["Total R", multiple(metrics?.totalR), metricClass(metrics?.totalR)],
      ["Win rate", metrics?.winRate == null ? "—" : `${Math.round(metrics.winRate * 100)}%`, ""], ["Avg trade", money(metrics?.averageTrade), metricClass(metrics?.averageTrade)],
    ]} />
    <MetricStrip items={[
      ["Gross P&L", money(metrics?.grossPnl), metricClass(metrics?.grossPnl)], ["Total fees", money(metrics == null ? undefined : -metrics.fees), "negative"],
      ["Profit factor", metrics?.profitFactor == null ? "—" : Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : "∞", ""], ["Long / short", `${metrics?.longTrades ?? 0} / ${metrics?.shortTrades ?? 0}`, ""],
    ]} />
    {!loading && day && <div className="journal-trade-table-wrap"><table className="journal-trade-table"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Initial stop</th><th>$ risk</th><th>Fees</th><th>Net</th><th>R</th><th /></tr></thead><tbody>
      {day.trades.map((trade) => <tr key={trade.id} onClick={() => onTrade(trade)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") onTrade(trade); }}>
        <td>{journalTime.format(new Date(trade.openedAt))}{trade.closedAt ? `–${journalTime.format(new Date(trade.closedAt))}` : "–open"}</td><td><strong>{trade.symbol}</strong></td><td><span className={`journal-side ${trade.direction.toLowerCase()}`}>{trade.direction}</span></td><td>{trade.entryQuantity}</td><td>{price(trade.averageEntry)}</td><td>{price(trade.averageExit)}</td><td>{price(trade.originalStop)}</td><td title={`Risk provenance: ${trade.riskProvenance}`}>{money(trade.deployedRisk)}<i className={`risk-dot ${trade.riskProvenance}`} /></td><td className="muted">{money(-trade.fees)}</td><td className={metricClass(trade.netPnl)}>{trade.status === "open" ? "Open" : money(trade.netPnl)}</td><td className={metricClass(trade.rMultiple)}>{multiple(trade.rMultiple)}</td><td><ChevronRight size={15} /></td>
      </tr>)}
      {!day.trades.length && <tr><td colSpan={12} className="journal-table-empty">No campaigns were initiated on this day.</td></tr>}
    </tbody></table></div>}
  </>;
}

function TradeDrawer({ trade, onClose, onSaved }: { trade: JournalTrade; onClose: () => void; onSaved: (trade: JournalTrade) => void }) {
  const [notes, setNotes] = useState(trade.notes);
  const [tags, setTags] = useState(trade.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [entryImage, setEntryImage] = useState<string>();
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string>();
  const [imageExpanded, setImageExpanded] = useState(false);
  const timelineEvents = useMemo(() => journalTimelineEvents(trade.events ?? []), [trade.events]);
  useEffect(() => { setNotes(trade.notes); setTags(trade.tags.join(", ")); }, [trade.id]);

  const loadEntryImage = useCallback(async () => {
    if (!trade.entryScreenshot || !api.isNative) return;
    setImageLoading(true);
    setImageError(undefined);
    try {
      const image = await api.journalEntryScreenshot(trade.id);
      setEntryImage(image.dataUrl);
    } catch (error) {
      setEntryImage(undefined);
      setImageError(String(error));
    } finally {
      setImageLoading(false);
    }
  }, [trade.id, trade.entryScreenshot?.capturedAt]);

  useEffect(() => {
    setEntryImage(undefined);
    setImageExpanded(false);
    if (trade.entryScreenshot) void loadEntryImage();
    else { setImageLoading(false); setImageError(undefined); }
  }, [trade.id, trade.entryScreenshot?.capturedAt, loadEntryImage]);

  useEffect(() => {
    if (!imageExpanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setImageExpanded(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [imageExpanded]);

  async function save() {
    const nextTags = tags.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
    setSaving(true);
    try { await api.updateJournalAnnotation(trade.id, notes, nextTags); onSaved({ ...trade, notes, tags: nextTags }); }
    finally { setSaving(false); }
  }

  return <><div className="journal-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="journal-trade-drawer">
    <header><div><span>{trade.status === "open" ? "Open Trade" : "Closed Trade"}</span><h2>{trade.symbol} <em className={trade.direction.toLowerCase()}>{trade.direction}</em></h2><p>{journalTime.format(new Date(trade.openedAt))}{trade.closedAt ? ` – ${journalTime.format(new Date(trade.closedAt))} ET` : " – Open"}</p></div><button aria-label="Close trade details" onClick={onClose}><X size={18} /></button></header>
    <dl className="journal-drawer-metrics"><div><dt>Net P&L</dt><dd className={metricClass(trade.netPnl)}>{trade.status === "open" ? "Open" : money(trade.netPnl)}</dd></div><div><dt>R multiple</dt><dd className={metricClass(trade.rMultiple)}>{multiple(trade.rMultiple)}</dd></div><div><dt>Initial risk</dt><dd>{money(trade.deployedRisk)}</dd></div><div><dt>Risk source</dt><dd className={`provenance ${trade.riskProvenance}`}>{trade.riskProvenance}</dd></div></dl>
    <section className="journal-drawer-section"><span>Execution plan</span><dl className="journal-plan-grid"><div><dt>Entry</dt><dd>{trade.entryQuantity} @ {price(trade.averageEntry)}</dd></div><div><dt>Exit</dt><dd>{trade.exitQuantity || "—"} @ {price(trade.averageExit)}</dd></div><div><dt>Original stop</dt><dd>{price(trade.originalStop)}</dd></div><div><dt>Original target</dt><dd>{price(trade.originalTarget)} · {multiple(journalProjectedTargetR(trade, trade.originalTarget))}</dd></div><div><dt>Gross P&L</dt><dd>{money(trade.grossPnl)}</dd></div><div><dt>Fees</dt><dd>{money(-trade.fees)}</dd></div></dl></section>
    <section className="journal-drawer-section journal-entry-chart"><span>Entry chart</span>
      {imageLoading && <div className="journal-entry-chart-loading"><i /><small>Loading private chart image…</small></div>}
      {!imageLoading && entryImage && <button type="button" className="journal-entry-chart-image" onClick={() => setImageExpanded(true)} aria-label={`Expand ${trade.symbol} entry chart`}><img src={entryImage} alt={`${trade.symbol} ${trade.direction.toLowerCase()} entry chart`} /><span><Expand size={13} />Expand</span></button>}
      {!imageLoading && imageError && <div className="journal-entry-chart-state error"><ImageIcon size={18} /><p>Entry chart unavailable</p><small>{imageError}</small><button type="button" onClick={() => { void loadEntryImage(); }}><RefreshCw size={13} />Retry</button></div>}
      {!imageLoading && !entryImage && !imageError && <div className="journal-entry-chart-state"><ImageIcon size={18} /><p>No entry chart was captured.</p></div>}
    </section>
    <section className="journal-drawer-section"><span>Order and risk history</span><div className="journal-timeline">{timelineEvents.map((event) => {
      const targetR = event.eventType === "target-move" ? ` · ${multiple(journalProjectedTargetR(trade, event.newPrice))}` : "";
      return <article key={event.id}><i className={`${event.status ?? "confirmed"}`} /><div><header><strong>{event.eventType.replaceAll("-", " ")}</strong><time>{journalTime.format(new Date(event.occurredAt))} ET</time></header><p>{event.oldPrice != null || event.newPrice != null ? `${price(event.oldPrice)} → ${price(event.newPrice)}${targetR}` : event.price != null ? `${event.quantity ?? ""} @ ${price(event.price)}` : event.note ?? event.source}</p><small>{event.source} · {event.status ?? "confirmed"}</small></div></article>;
    })}{!timelineEvents.length && <p className="journal-no-events">No detailed events are available for this imported campaign.</p>}</div></section>
    <section className="journal-drawer-section journal-notes"><span>Review notes</span><label><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What happened in this trade?" rows={5} /></label><label><Tag size={14} /><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="setup, session, mistake" /></label><button onClick={save} disabled={saving || !api.isNative}><Save size={15} />{saving ? "Saving…" : api.isNative ? "Save notes" : "Demo is read-only"}</button></section>
  </aside></div>{imageExpanded && entryImage && <div className="journal-image-lightbox" role="dialog" aria-modal="true" aria-label={`${trade.symbol} entry chart`} onMouseDown={(event) => { if (event.target === event.currentTarget) setImageExpanded(false); }}><button type="button" aria-label="Close expanded entry chart" onClick={() => setImageExpanded(false)}><X size={19} /></button><img src={entryImage} alt={`${trade.symbol} ${trade.direction.toLowerCase()} entry chart`} /></div>}</>;
}
