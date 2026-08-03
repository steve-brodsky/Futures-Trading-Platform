import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownToLine, ArrowUpFromLine, ChevronDown, ExternalLink, GripVertical, LoaderCircle,
  Maximize2, Minus, PanelTopClose, RefreshCw, Search, Wifi, X,
} from "lucide-react";
import { api } from "../lib/bridge";
import { useSymbolSuggestions } from "../lib/symbolSearch";
import {
  MAX_OPTION_DRAFT_LEGS, OPTION_STRIKE_COUNTS, classifyOptionDraft, defaultOptionOrderDraft,
  formatOptionCount, formatOptionGreek, formatOptionPrice, optionDraftNatural, pairOptionContracts,
  refreshOptionDraftPrices, toggleOptionDraftLeg,
} from "../lib/optionChain";
import type {
  OptionChainPreferences, OptionContract, OptionDraftAction, OptionOrderDraft, OptionStreamStateEvent,
  OptionUpdateEvent, Quote, QuoteUpdateEvent, SymbolMeta,
} from "../types";

const MAIN_WINDOW_ID = "main";
const OPTION_WINDOW_ID = "option-chain";
const REFRESH_INTERVAL_MS = 5 * 60_000;
const OPTION_FIELDS_TO_FLASH: Array<keyof OptionContract> = [
  "bidPrice", "askPrice", "bidSize", "askSize", "totalVolume", "openInterest", "delta", "gamma", "theta", "vega",
];

export interface OptionChainTransferState {
  preferences: OptionChainPreferences;
  draft: OptionOrderDraft;
}

interface OptionChainWorkspaceProps extends OptionChainTransferState {
  detached?: boolean;
  authenticated: boolean;
  onPreferencesChange: (preferences: OptionChainPreferences) => void;
  onDraftChange: (draft: OptionOrderDraft) => void;
  onRequestBudget: (contractCount: number) => Promise<void>;
  onReleaseBudget: () => void | Promise<void>;
  onDetach?: (state: OptionChainTransferState) => void | Promise<void>;
  onDock?: (state: OptionChainTransferState) => void | Promise<void>;
  onOpenSettings?: () => void;
}

type ChainState = "loading" | "connecting" | "live" | "delayed" | "stale" | "rest-only" | "error";
type FlashDirection = "up" | "down";

function quoteClass(value: number): string {
  return value > 0 ? "positive" : value < 0 ? "negative" : "";
}

function expirationLabel(date: string, dte: number, type: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`));
  return `${formatted} · ${dte === 0 ? "0DTE" : `${dte} DTE`} · ${type}`;
}

function contractCellKey(contract: OptionContract | undefined, field: keyof OptionContract): string {
  return contract ? `${contract.symbol}:${field}` : "";
}

function PriceCell({ contract, field, action, selected, flashes, onSelect }: {
  contract?: OptionContract;
  field: "bidPrice" | "askPrice";
  action: OptionDraftAction;
  selected: boolean;
  flashes: Record<string, FlashDirection>;
  onSelect: (contract: OptionContract, action: OptionDraftAction) => void;
}) {
  if (!contract) return <td className="option-price-cell empty">—</td>;
  const size = field === "bidPrice" ? contract.bidSize : contract.askSize;
  const flash = flashes[contractCellKey(contract, field)];
  return <td className={`option-price-cell ${field === "bidPrice" ? "bid" : "ask"} ${selected ? "selected" : ""} ${flash ? `flash-${flash}` : ""}`}>
    <button type="button" aria-pressed={selected} title={`${action === "BUY" ? "Buy" : "Sell"} ${contract.symbol}`} onClick={() => onSelect(contract, action)}>
      <strong>{formatOptionPrice(contract[field])}</strong><span>×{formatOptionCount(size)}</span>
    </button>
  </td>;
}

function DataCell({ contract, field, format, flashes }: {
  contract?: OptionContract;
  field: keyof OptionContract;
  format: (value: number | undefined) => string;
  flashes: Record<string, FlashDirection>;
}) {
  const flash = flashes[contractCellKey(contract, field)];
  const value = contract?.[field];
  return <td className={`option-data-cell ${flash ? `flash-${flash}` : ""}`}>{format(typeof value === "number" ? value : undefined)}</td>;
}

function OptionDraftBuilder({ draft, onChange }: { draft: OptionOrderDraft; onChange: (draft: OptionOrderDraft) => void }) {
  const natural = optionDraftNatural(draft);
  const strategy = classifyOptionDraft(draft.legs);
  const updateLegRatio = (contractSymbol: string, ratio: number) => {
    const legs = draft.legs.map((leg) => leg.contractSymbol === contractSymbol ? { ...leg, ratio: Math.max(1, Math.min(99, Math.round(ratio) || 1)) } : leg);
    const next = { ...draft, legs };
    const value = optionDraftNatural(next);
    onChange({ ...next, priceEffect: value.effect, limitAmount: Number(value.amount.toFixed(4)) });
  };
  return <section className={`option-draft ${draft.legs.length ? "has-legs" : ""}`} aria-label="Option order draft">
    <header className="option-draft-heading">
      <span className="option-draft-mark"><GripVertical size={14} /></span>
      <div><strong>{strategy}</strong><small>{draft.legs.length}/{MAX_OPTION_DRAFT_LEGS} legs · analytical draft</small></div>
      <span className="draft-only-badge">DRAFT ONLY</span>
      <button type="button" className="option-draft-clear" disabled={!draft.legs.length} onClick={() => onChange(defaultOptionOrderDraft(draft.underlying))}><X size={13} />Clear</button>
    </header>
    <div className="option-draft-body">
      <div className="option-draft-controls">
        <label><span>Qty</span><input type="number" min="1" max="999" value={draft.quantity} onChange={(event) => onChange({ ...draft, quantity: Math.max(1, Math.min(999, Math.round(Number(event.target.value)) || 1)) })} /></label>
        <label><span>Order</span><select value={draft.orderType} onChange={(event) => onChange({ ...draft, orderType: event.target.value as OptionOrderDraft["orderType"] })}><option value="LIMIT">Limit</option><option value="MARKET">Market</option></select></label>
        <label><span>TIF</span><select value={draft.timeInForce} onChange={(event) => onChange({ ...draft, timeInForce: event.target.value as OptionOrderDraft["timeInForce"] })}><option value="DAY">Day</option><option value="GTC">GTC</option></select></label>
        <label className="option-limit-control"><span>Limit</span><div><select disabled={draft.orderType === "MARKET"} value={draft.priceEffect} onChange={(event) => onChange({ ...draft, priceEffect: event.target.value as OptionOrderDraft["priceEffect"] })}><option value="DEBIT">Debit</option><option value="CREDIT">Credit</option></select><input disabled={draft.orderType === "MARKET"} type="number" min="0" step="0.01" value={draft.limitAmount} onChange={(event) => onChange({ ...draft, limitAmount: Math.max(0, Number(event.target.value) || 0) })} /></div></label>
      </div>
      <div className="option-draft-legs">
        {draft.legs.map((leg) => <div key={leg.contractSymbol} className={`option-draft-leg ${leg.action.toLowerCase()}`}>
          <span className="option-leg-action">{leg.action === "BUY" ? <ArrowDownToLine size={12} /> : <ArrowUpFromLine size={12} />}{leg.action}</span>
          <input aria-label={`${leg.contractSymbol} ratio`} type="number" min="1" max="99" value={leg.ratio} onChange={(event) => updateLegRatio(leg.contractSymbol, Number(event.target.value))} />
          <strong>{leg.expirationDate.slice(5).replace("-", "/")}</strong><strong>{formatOptionPrice(leg.strikePrice)} {leg.putCall === "CALL" ? "C" : "P"}</strong>
          <span>{formatOptionPrice(leg.action === "BUY" ? leg.askPrice : leg.bidPrice)}</span>
          <button type="button" aria-label={`Remove ${leg.contractSymbol}`} onClick={() => {
            const next = { ...draft, legs: draft.legs.filter((item) => item.contractSymbol !== leg.contractSymbol) };
            const value = optionDraftNatural(next);
            onChange({ ...next, priceEffect: value.effect, limitAmount: Number(value.amount.toFixed(4)) });
          }}><X size={12} /></button>
        </div>)}
        {!draft.legs.length && <div className="option-draft-empty"><strong>Select a bid or ask</strong><span>Bid sells · Ask buys · up to four legs</span></div>}
      </div>
      <div className="option-draft-totals">
        <span>Natural <strong>{natural.effect} {formatOptionPrice(natural.amount)}</strong></span>
        <span>Est. value <strong>${natural.estimatedValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
      </div>
    </div>
  </section>;
}

export function OptionChainWorkspace({
  preferences, draft, detached = false, authenticated, onPreferencesChange, onDraftChange,
  onRequestBudget, onReleaseBudget, onDetach, onDock, onOpenSettings,
}: OptionChainWorkspaceProps) {
  const [symbolMeta, setSymbolMeta] = useState<SymbolMeta>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState(preferences.symbol);
  const suggestions = useSymbolSuggestions(search, api.symbolSearch, searchOpen);
  const optionSuggestions = suggestions.results.filter((item) => item.provider === "schwab" && ["EQUITY", "ETF", "INDEX"].includes(item.assetType.toUpperCase()));
  const [expirations, setExpirations] = useState<Array<{ expirationDate: string; daysToExpiration: number; expirationType: string; standard: boolean }>>([]);
  const [contracts, setContracts] = useState<Record<string, OptionContract>>({});
  const [underlyingPrice, setUnderlyingPrice] = useState(0);
  const [quote, setQuote] = useState<Quote>();
  const [fetchedAt, setFetchedAt] = useState<string>();
  const [state, setState] = useState<ChainState>("loading");
  const [message, setMessage] = useState<string>();
  const [flashes, setFlashes] = useState<Record<string, FlashDirection>>({});
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [draftMessage, setDraftMessage] = useState<string>();
  const contractsRef = useRef(contracts);
  const flashTimersRef = useRef(new Map<string, number>());
  const activeStreamIdsRef = useRef(new Set<string>());
  const chainScrollRef = useRef<HTMLDivElement>(null);
  const subscriptionId = `${detached ? "option-window" : "option-main"}:${preferences.symbol}`;
  const displayed = useMemo(() => pairOptionContracts(Object.values(contracts), quote?.last || underlyingPrice), [contracts, quote?.last, underlyingPrice]);
  const selectedExpiration = expirations.find((item) => item.expirationDate === preferences.expirationDate);

  contractsRef.current = contracts;

  const setPreference = (patch: Partial<OptionChainPreferences>) => onPreferencesChange({ ...preferences, ...patch });
  const chooseSymbol = async (meta: SymbolMeta) => {
    if (draft.legs.length && draft.underlying !== meta.symbol && !window.confirm(`Clear the ${draft.legs.length}-leg ${draft.underlying} draft and load ${meta.symbol}?`)) return;
    if (draft.legs.length && draft.underlying !== meta.symbol) onDraftChange(defaultOptionOrderDraft(meta.symbol));
    setSymbolMeta(meta);
    setSearch(meta.symbol);
    setSearchOpen(false);
    onPreferencesChange({ symbol: meta.symbol, strikeCount: preferences.strikeCount });
  };
  const submitSearch = async () => {
    const exact = optionSuggestions.find((item) => item.symbol.toUpperCase() === search.trim().toUpperCase());
    if (exact) return chooseSymbol(exact);
    try {
      const meta = await api.symbolDetails("schwab", search.trim().toUpperCase());
      if (!["EQUITY", "ETF", "INDEX"].includes(meta.assetType.toUpperCase())) throw new Error("Only Schwab equity, ETF, and index options are supported.");
      await chooseSymbol(meta);
    } catch (error) {
      setState("error");
      setMessage(String(error));
    }
  };

  useEffect(() => {
    let cancelled = false;
    setSearch(preferences.symbol);
    void api.symbolDetails("schwab", preferences.symbol).then((meta) => { if (!cancelled) setSymbolMeta(meta); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [preferences.symbol]);

  useEffect(() => {
    let cancelled = false;
    if (api.isNative && !authenticated) {
      setState("error");
      setMessage("Connect Schwab in Settings to load option chains.");
      setExpirations([]);
      return;
    }
    setState("loading");
    setMessage(undefined);
    void api.optionExpirations(preferences.symbol).then((items) => {
      if (cancelled) return;
      const available = items.filter((item) => item.standard && item.daysToExpiration >= 0);
      setExpirations(available);
      const selected = available.some((item) => item.expirationDate === preferences.expirationDate)
        ? preferences.expirationDate
        : available[0]?.expirationDate;
      if (!selected) throw new Error(`${preferences.symbol} has no unexpired standard option expirations.`);
      if (selected !== preferences.expirationDate) setPreference({ expirationDate: selected });
    }).catch((error) => {
      if (!cancelled) { setState("error"); setMessage(String(error)); setExpirations([]); }
    });
    return () => { cancelled = true; };
  }, [preferences.symbol, authenticated]);

  const loadChain = useCallback(async (background = false) => {
    if (!preferences.expirationDate || api.isNative && !authenticated) return;
    if (!background || !Object.keys(contractsRef.current).length) setState("loading");
    try {
      const snapshot = await api.optionChain(preferences.symbol, [preferences.expirationDate], preferences.strikeCount);
      const next = Object.fromEntries(snapshot.contracts.map((contract) => [contract.symbol, contract]));
      setContracts(next);
      setUnderlyingPrice(snapshot.underlyingPrice);
      setFetchedAt(snapshot.fetchedAt);
      setState(snapshot.delayed ? "delayed" : "connecting");
      setMessage(snapshot.contracts.length ? undefined : "This expiration returned no standard contracts.");
    } catch (error) {
      setState(Object.keys(contractsRef.current).length ? "stale" : "error");
      setMessage(String(error));
    }
  }, [preferences.symbol, preferences.expirationDate, preferences.strikeCount, authenticated]);

  useEffect(() => {
    void loadChain(false);
    const timer = window.setInterval(() => void loadChain(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadChain, refreshEpoch]);

  useEffect(() => {
    const symbols = Object.values(contracts).filter((contract) => !contract.isMini && !contract.isNonStandard).map((contract) => contract.symbol);
    if (!symbols.length || api.isNative && !authenticated) return;
    let cancelled = false;
    setState((current) => current === "delayed" ? current : "connecting");
    void onRequestBudget(symbols.length).then(() => {
      if (cancelled) return;
      activeStreamIdsRef.current.add(subscriptionId);
      return api.startOptionStream(subscriptionId, preferences.symbol, symbols);
    }).then(() => {
      if (!cancelled) setState((current) => current === "delayed" ? current : "live");
    }).catch((error) => {
      if (!cancelled) { setState("rest-only"); setMessage(String(error)); }
    });
    return () => {
      cancelled = true;
      void api.stopOptionStream(subscriptionId).finally(() => activeStreamIdsRef.current.delete(subscriptionId));
    };
  }, [subscriptionId, preferences.symbol, authenticated, Object.keys(contracts).sort().join("|")]);

  useEffect(() => {
    const quoteSubscriptionId = `${subscriptionId}:quote`;
    let disposed = false;
    void api.quotes("schwab", [preferences.symbol]).then((items) => { if (!disposed) setQuote(items[0]); }).catch(() => undefined);
    const cleanups: Array<() => void> = [];
    if (api.isNative) {
      void api.startQuoteStream(quoteSubscriptionId, "schwab", [preferences.symbol]);
      void listen<QuoteUpdateEvent>("quote-update", ({ payload }) => {
        if (payload.subscriptionId === quoteSubscriptionId && payload.quote.symbol === preferences.symbol) setQuote({ ...payload.quote, receivedAt: Date.now() });
      }).then((cleanup) => cleanups.push(cleanup));
    }
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      if (api.isNative) void api.stopQuoteStream(quoteSubscriptionId);
    };
  }, [subscriptionId, preferences.symbol]);

  useEffect(() => {
    if (!api.isNative) return;
    const cleanups: Array<() => void> = [];
    void listen<OptionUpdateEvent>("option-update", ({ payload }) => {
      if (payload.subscriptionId !== subscriptionId) return;
      const existing = contractsRef.current[payload.contract.symbol];
      if (!existing) return;
      const changed: Record<string, FlashDirection> = {};
      OPTION_FIELDS_TO_FLASH.forEach((field) => {
        const before = existing[field];
        const after = payload.contract[field];
        if (typeof before !== "number" || typeof after !== "number" || before === after) return;
        const key = `${payload.contract.symbol}:${field}`;
        changed[key] = after > before ? "up" : "down";
        const prior = flashTimersRef.current.get(key);
        if (prior) window.clearTimeout(prior);
        flashTimersRef.current.set(key, window.setTimeout(() => setFlashes((items) => {
          const next = { ...items }; delete next[key]; return next;
        }), 520));
      });
      if (Object.keys(changed).length) setFlashes((items) => ({ ...items, ...changed }));
      setContracts((current) => ({ ...current, [payload.contract.symbol]: { ...existing, ...payload.contract, isMini: existing.isMini, isNonStandard: existing.isNonStandard, delayed: existing.delayed } }));
      setState((current) => current === "delayed" ? current : "live");
      setFetchedAt(new Date().toISOString());
    }).then((cleanup) => cleanups.push(cleanup));
    void listen<OptionStreamStateEvent>("option-stream-state", ({ payload }) => {
      if (payload.subscriptionId !== subscriptionId) return;
      if (payload.state === "streaming") setState((current) => current === "delayed" ? current : "live");
      else if (payload.state === "rest-only") setState("rest-only");
      else if (["stale", "reconnecting", "disconnected"].includes(payload.state)) setState("stale");
      else if (payload.state === "connecting") setState("connecting");
      setMessage(payload.message);
    }).then((cleanup) => cleanups.push(cleanup));
    return () => {
      cleanups.forEach((cleanup) => cleanup());
      flashTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      flashTimersRef.current.clear();
    };
  }, [subscriptionId]);

  useEffect(() => () => {
    const active = [...activeStreamIdsRef.current];
    void Promise.all(active.map((id) => api.stopOptionStream(id).catch(() => undefined))).finally(() => onReleaseBudget());
  }, []);

  useEffect(() => {
    if (!draft.legs.length) return;
    const refreshed = refreshOptionDraftPrices(draft, Object.values(contracts));
    if (refreshed.legs.some((leg, index) => leg.bidPrice !== draft.legs[index]?.bidPrice || leg.askPrice !== draft.legs[index]?.askPrice)) onDraftChange(refreshed);
  }, [contracts]);

  useEffect(() => {
    if (displayed.atTheMoneyStrike == null) return;
    const row = chainScrollRef.current?.querySelector<HTMLElement>(`[data-strike="${displayed.atTheMoneyStrike}"]`);
    row?.scrollIntoView({ block: "center" });
  }, [preferences.expirationDate, preferences.strikeCount, displayed.atTheMoneyStrike]);

  const selectContract = (contract: OptionContract, action: OptionDraftAction) => {
    const result = toggleOptionDraftLeg(draft, contract, action);
    setDraftMessage(result.error);
    if (!result.error) onDraftChange(result.draft);
  };
  const isSelected = (contract: OptionContract | undefined, action: OptionDraftAction) => Boolean(contract && draft.legs.some((leg) => leg.contractSymbol === contract.symbol && leg.action === action));

  return <section className={`option-chain-workspace ${detached ? "detached" : ""}`}>
    <header className="option-chain-toolbar">
      <div className="option-symbol-search">
        <Search size={15} />
        <input value={search} aria-label="Option underlying symbol" onFocus={() => setSearchOpen(true)} onChange={(event) => { setSearch(event.target.value.toUpperCase()); setSearchOpen(true); }} onKeyDown={(event) => { if (event.key === "Enter") void submitSearch(); if (event.key === "Escape") setSearchOpen(false); }} />
        <button type="button" aria-label="Show symbol results" onClick={() => setSearchOpen((open) => !open)}><ChevronDown size={13} /></button>
        {searchOpen && <div className="option-symbol-results" role="listbox">
          {optionSuggestions.map((item) => <button type="button" role="option" key={`${item.provider}:${item.symbol}`} onClick={() => void chooseSymbol(item)}><strong>{item.symbol}</strong><span>{item.description}</span><small>{item.assetType}</small></button>)}
          {suggestions.loading && <span className="option-search-message"><LoaderCircle size={13} className="spin" />Searching Schwab…</span>}
          {!suggestions.loading && search.trim() && !optionSuggestions.length && <button type="button" className="option-search-message" onClick={() => void submitSearch()}>Load {search.trim().toUpperCase()}</button>}
        </div>}
      </div>
      <div className="option-underlying-identity"><strong>{symbolMeta?.description ?? preferences.symbol}</strong><span>{symbolMeta?.exchange ?? "SCHWAB"}</span></div>
      <div className="option-underlying-quote">
        <strong>{formatOptionPrice(quote?.last || underlyingPrice)}</strong>
        <span className={quoteClass(quote?.change ?? 0)}>{quote ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)} · ${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(2)}%` : "—"}</span>
        <small>B {formatOptionPrice(quote?.bid)} / A {formatOptionPrice(quote?.ask)}</small>
      </div>
      <label className="option-expiration-control"><span>Expiration</span><select value={preferences.expirationDate ?? ""} onChange={(event) => setPreference({ expirationDate: event.target.value })}>{expirations.map((item) => <option key={item.expirationDate} value={item.expirationDate}>{expirationLabel(item.expirationDate, item.daysToExpiration, item.expirationType)}</option>)}</select></label>
      <label className="option-strike-control"><span>Strikes ±</span><select value={preferences.strikeCount} onChange={(event) => setPreference({ strikeCount: Number(event.target.value) as OptionChainPreferences["strikeCount"] })}>{OPTION_STRIKE_COUNTS.map((count) => <option value={count} key={count}>{count}</option>)}</select></label>
      <button type="button" className="option-toolbar-icon" aria-label="Refresh option chain" title="Refresh option chain" onClick={() => setRefreshEpoch((value) => value + 1)}><RefreshCw size={15} /></button>
      {detached
        ? <button type="button" className="option-toolbar-icon" aria-label="Dock option chain" title="Dock to main window" onClick={() => void onDock?.({ preferences, draft })}><PanelTopClose size={15} /></button>
        : <button type="button" className="option-toolbar-icon" aria-label="Detach option chain" title="Detach option chain" onClick={() => void onDetach?.({ preferences, draft })}><ExternalLink size={15} /></button>}
      <button type="button" className={`option-stream-chip ${state}`} title={message ?? state} onClick={state === "error" ? onOpenSettings : undefined}><Wifi size={12} /><span>{state === "rest-only" ? "REST ONLY" : state.toUpperCase()}</span></button>
    </header>

    <OptionDraftBuilder draft={draft} onChange={onDraftChange} />
    {draftMessage && <button type="button" className="option-draft-message" onClick={() => setDraftMessage(undefined)}>{draftMessage}<X size={12} /></button>}

    <div className="option-chain-section-heading">
      <div><strong>{selectedExpiration ? expirationLabel(selectedExpiration.expirationDate, selectedExpiration.daysToExpiration, selectedExpiration.expirationType) : "Option chain"}</strong><span>{displayed.rows.length} strikes · {Object.keys(contracts).length - displayed.excludedCount} contracts</span></div>
      <div><span>{displayed.excludedCount ? `${displayed.excludedCount} adjusted excluded · ` : ""}{fetchedAt ? `Updated ${new Date(fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Waiting for data"}</span>{message && <em title={message}>{message}</em>}</div>
    </div>

    <div className="option-chain-scroll" ref={chainScrollRef}>
      <table className="option-chain-table">
        <thead><tr className="option-side-heading"><th colSpan={8}>CALLS</th><th>STRIKE</th><th colSpan={8}>PUTS</th></tr><tr><th>Volume</th><th>OI</th><th>Vega</th><th>Theta</th><th>Gamma</th><th>Delta</th><th>Bid × Size</th><th>Ask × Size</th><th>Strike</th><th>Bid × Size</th><th>Ask × Size</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Vega</th><th>OI</th><th>Volume</th></tr></thead>
        <tbody>{displayed.rows.map((row) => <tr key={row.strikePrice} data-strike={row.strikePrice} className={`${row.atTheMoney ? "atm" : ""} ${row.callInTheMoney ? "call-itm" : ""} ${row.putInTheMoney ? "put-itm" : ""}`}>
          <DataCell contract={row.call} field="totalVolume" format={formatOptionCount} flashes={flashes} />
          <DataCell contract={row.call} field="openInterest" format={formatOptionCount} flashes={flashes} />
          <DataCell contract={row.call} field="vega" format={formatOptionGreek} flashes={flashes} />
          <DataCell contract={row.call} field="theta" format={formatOptionGreek} flashes={flashes} />
          <DataCell contract={row.call} field="gamma" format={formatOptionGreek} flashes={flashes} />
          <DataCell contract={row.call} field="delta" format={formatOptionGreek} flashes={flashes} />
          <PriceCell contract={row.call} field="bidPrice" action="SELL" selected={isSelected(row.call, "SELL")} flashes={flashes} onSelect={selectContract} />
          <PriceCell contract={row.call} field="askPrice" action="BUY" selected={isSelected(row.call, "BUY")} flashes={flashes} onSelect={selectContract} />
          <th scope="row" className="option-strike-cell"><strong>{formatOptionPrice(row.strikePrice)}</strong>{row.atTheMoney && <span>ATM</span>}</th>
          <PriceCell contract={row.put} field="bidPrice" action="SELL" selected={isSelected(row.put, "SELL")} flashes={flashes} onSelect={selectContract} />
          <PriceCell contract={row.put} field="askPrice" action="BUY" selected={isSelected(row.put, "BUY")} flashes={flashes} onSelect={selectContract} />
          <DataCell contract={row.put} field="delta" format={formatOptionGreek} flashes={flashes} />
          <DataCell contract={row.put} field="gamma" format={formatOptionGreek} flashes={flashes} />
          <DataCell contract={row.put} field="theta" format={formatOptionGreek} flashes={flashes} />
          <DataCell contract={row.put} field="vega" format={formatOptionGreek} flashes={flashes} />
          <DataCell contract={row.put} field="openInterest" format={formatOptionCount} flashes={flashes} />
          <DataCell contract={row.put} field="totalVolume" format={formatOptionCount} flashes={flashes} />
        </tr>)}</tbody>
      </table>
      {state === "loading" && !displayed.rows.length && <div className="option-chain-loading"><LoaderCircle size={19} className="spin" /><strong>Loading {preferences.symbol} option chain</strong><span>Fetching expirations, contracts, and underlying quote</span></div>}
      {state === "error" && !displayed.rows.length && <div className="option-chain-loading error"><Wifi size={19} /><strong>Option chain unavailable</strong><span>{message}</span>{onOpenSettings && <button type="button" onClick={onOpenSettings}>Open Schwab settings</button>}</div>}
    </div>
  </section>;
}

async function requestDetachedBudget(contractCount: number): Promise<void> {
  if (!api.isNative) return;
  const requestId = `option-budget:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  await new Promise<void>(async (resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("The main window did not grant the option stream budget.")), 8_000);
    const unlisten = await listen<{ requestId: string }>("option-chain-budget-granted", ({ payload }) => {
      if (payload.requestId !== requestId) return;
      window.clearTimeout(timeout);
      unlisten();
      resolve();
    });
    await emitTo(MAIN_WINDOW_ID, "option-chain-budget-request", { requestId, contractCount, windowId: OPTION_WINDOW_ID }).catch(reject);
  });
}

export function DetachedOptionChainWindow() {
  const [transfer, setTransfer] = useState<OptionChainTransferState>();
  const [startupError, setStartupError] = useState<string>();
  const transferRef = useRef<OptionChainTransferState | undefined>(undefined);
  const [authenticated, setAuthenticated] = useState(!api.isNative);
  transferRef.current = transfer;
  useEffect(() => {
    if (!api.isNative) {
      setTransfer({ preferences: { symbol: "SPY", strikeCount: 20 }, draft: defaultOptionOrderDraft("SPY") });
      setAuthenticated(true);
      return;
    }
    const cleanups: Array<() => void> = [];
    let disposed = false;
    let closing = false;
    let receivedTransfer = false;
    let readyTimer: number | undefined;
    void (async () => {
      try {
        const transferCleanup = await listen<OptionChainTransferState>("option-chain-transfer", ({ payload }) => {
          receivedTransfer = true;
          if (readyTimer != null) window.clearInterval(readyTimer);
          setTransfer(payload);
          void emitTo(MAIN_WINDOW_ID, "option-chain-transfer-received", { windowId: OPTION_WINDOW_ID }).catch(() => undefined);
        });
        if (disposed) {
          transferCleanup();
          return;
        }
        cleanups.push(transferCleanup);
        await emitTo(MAIN_WINDOW_ID, "option-chain-window-ready", { windowId: OPTION_WINDOW_ID });
        readyTimer = window.setInterval(() => {
          if (!receivedTransfer) void emitTo(MAIN_WINDOW_ID, "option-chain-window-ready", { windowId: OPTION_WINDOW_ID }).catch(() => undefined);
        }, 750);
        const closeCleanup = await getCurrentWindow().onCloseRequested(async (event) => {
          if (closing) return;
          event.preventDefault();
          closing = true;
          const symbol = transferRef.current?.preferences.symbol;
          if (symbol) await api.stopOptionStream(`option-window:${symbol}`).catch(() => undefined);
          await emitTo(MAIN_WINDOW_ID, "option-chain-budget-release", { windowId: OPTION_WINDOW_ID }).catch(() => undefined);
          await getCurrentWindow().destroy();
        });
        if (disposed) closeCleanup();
        else cleanups.push(closeCleanup);
      } catch (error) {
        if (!disposed) setStartupError(String(error));
      }
    })();
    void api.schwabAuthStatus().then((status) => {
      if (!disposed) setAuthenticated(status.authenticated);
    }).catch(() => {
      if (!disposed) setAuthenticated(false);
    });
    return () => {
      disposed = true;
      if (readyTimer != null) window.clearInterval(readyTimer);
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);
  if (!transfer) return <main className="option-window-shell"><div className={`option-chain-loading ${startupError ? "error" : ""}`}>{startupError ? <Wifi size={20} /> : <LoaderCircle size={20} className="spin" />}<strong>{startupError ? "Could not open option chain" : "Opening option chain"}</strong>{startupError && <span>{startupError}</span>}</div></main>;
  return <main className="option-window-shell">
    <header className="option-window-titlebar" data-tauri-drag-region>
      <div className="brand"><div className="brand-glyph">N</div><span>NORTHSTAR</span><small>OPTIONS</small></div>
      <span className="option-window-title">{transfer.preferences.symbol} Option Chain</span>
      <div className="option-window-controls"><button type="button" onClick={() => void getCurrentWindow().minimize()}><Minus size={13} /></button><button type="button" onClick={() => void getCurrentWindow().toggleMaximize()}><Maximize2 size={13} /></button><button type="button" onClick={() => void getCurrentWindow().close()}><X size={14} /></button></div>
    </header>
    <OptionChainWorkspace
      detached authenticated={authenticated} preferences={transfer.preferences} draft={transfer.draft}
      onPreferencesChange={(preferences) => setTransfer((current) => current ? { ...current, preferences } : current)}
      onDraftChange={(draft) => setTransfer((current) => current ? { ...current, draft } : current)}
      onRequestBudget={requestDetachedBudget}
      onReleaseBudget={() => api.isNative ? emitTo(MAIN_WINDOW_ID, "option-chain-budget-release", { windowId: OPTION_WINDOW_ID }) : undefined}
      onDock={async (state) => {
        if (!api.isNative) return;
        await emitTo(MAIN_WINDOW_ID, "option-chain-dock", state);
        await getCurrentWindow().close();
      }}
    />
  </main>;
}
