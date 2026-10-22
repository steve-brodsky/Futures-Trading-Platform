import { useEffect, useRef, useState } from "react";
import { ChevronDown, Minus, Plus, X, CalendarDays } from "lucide-react";
import { calculateContractsForRisk, calculateTakeProfitAtR, estimateOrderRisk, validateTick } from "../lib/indicators";
import { calculateSwingStop } from "../lib/swingStop";
import { isContinuousFuture, formatContractExpiration } from "../lib/futuresContracts";
import { isTargetOutside } from "../lib/menuFocus";
import { orderRMultiples, type OrderProjection, type OrderRMultiple } from "../lib/tradeLines";
import { sharesForRisk, equityQuoteAvailable } from "../lib/equityTrading";
import type { SymbolMeta, Quote, Bar, Timeframe, OrderTicketSettings, ContractRollStatus, Account, TradingEnvironment, EntryRuleSide, EntryRuleResult, OrderDraft, SchwabEquityOrderDraft } from "../types";
function formatRollDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}
export function OrderTicket({ equity, equityBlockReason, onEquitySubmit, chartSymbol, tradeSymbol, quote, bars, timeframe, settings, contracts, tradeContract, contractStatus, contractLookupError, rollStatus, account, environment, busy, confirmOrders, entryEligibility, rulesConfigured, orderProjection, resetEpoch, onTradeContractChange, onUseNextContract, onSettingsChange, onConfirmOrdersChange, onProjectionChange, onSubmit }: { equity?: boolean; equityBlockReason?: string; onEquitySubmit?: (draft: SchwabEquityOrderDraft) => void; chartSymbol: SymbolMeta; tradeSymbol?: SymbolMeta; quote: Quote; bars: Bar[]; timeframe: Timeframe; settings: OrderTicketSettings; contracts: SymbolMeta[]; tradeContract?: string; contractStatus?: string; contractLookupError?: string; rollStatus?: ContractRollStatus; account?: Account; environment: TradingEnvironment; busy: boolean; confirmOrders: boolean; entryEligibility: Record<EntryRuleSide, EntryRuleResult>; rulesConfigured: boolean; orderProjection?: OrderProjection; resetEpoch: number; onTradeContractChange: (symbol?: string) => void; onUseNextContract: () => void; onSettingsChange: (patch: Partial<OrderTicketSettings>) => void; onConfirmOrdersChange: (enabled: boolean) => void; onProjectionChange: (projection: OrderProjection) => void; onSubmit: (draft: OrderDraft) => void }) {
  const symbol = tradeSymbol ?? chartSymbol;
  const continuous = isContinuousFuture(chartSymbol);
  const [side, setSide] = useState<"Buy" | "Sell">("Buy");
  const [quantity, setQuantity] = useState(1);
  const [riskInput, setRiskInput] = useState(settings.riskAmount == null ? "" : String(settings.riskAmount));
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
  const minimumRiskQuantity = !equity && settings.riskSizingPolicy === "minimum-one" ? 1 : 0;
  function resolvedQuantity(nextSide = side, nextStopLoss = stopLoss, mode = settings.sizingMode, nextRiskAmount = riskAmount) {
    if (mode === "contracts") return quantity;
    const nextEntryPrice = nextSide === "Buy" ? quote.ask : quote.bid;
    if (equity) return sharesForRisk(nextRiskAmount, nextEntryPrice, Number(nextStopLoss), nextSide);
    return calculateContractsForRisk(nextRiskAmount, nextEntryPrice, Number(nextStopLoss), nextSide, symbol.minMove, tickValue, minimumRiskQuantity) ?? 0;
  }

  const strictRiskQuantity = equity ? sharesForRisk(riskAmount, entryPrice, stopLossPrice, side) : calculateContractsForRisk(riskAmount, entryPrice, stopLossPrice, side, symbol.minMove, tickValue);
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
    entryPrice: equity ? (nextSide === "Buy" ? quote.ask : quote.bid) : undefined,
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

  useEffect(() => {
    if (!equity || (!takeProfit.trim() && !stopLoss.trim())) return;
    const target = selectedR == null ? null : calculateTakeProfitAtR(entryPrice, Number(stopLoss), side, selectedR, symbol.minMove);
    const nextTarget = target == null ? takeProfit : String(target);
    if (nextTarget !== takeProfit) setTakeProfit(nextTarget);
    publishProjection(nextTarget, stopLoss, side, effectiveQuantity);
  }, [equity, entryPrice, effectiveQuantity, selectedR, stopLoss]);

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

  const clearTakeProfit = () => {
    setRMenuOpen(false);
    setTakeProfit("");
    publishProjection("", stopLoss, side, effectiveQuantity, null);
  };

  const clearStopLoss = () => updateProjectedStop("");

  function draft(): OrderDraft {
    return { accountId: account?.id ?? "", symbol: tradeSymbol?.symbol ?? "", side, type: "Market", quantity: effectiveQuantity, duration: settings.timeInForce, takeProfit: takeProfitPrice, stopLoss: stopLossPrice };
  }

  const marketUnavailable = (equity && !equityQuoteAvailable(quote)) || !tradeSymbol || quote.last <= 0 || quote.halted || quote.delayed || !quote.receivedAt || Date.now() - quote.receivedAt > 5_000;
  const perContractRisk = stopLossValid ? estimateOrderRisk(entryPrice, stopLossPrice, side, 1, symbol.minMove, tickValue) : null;
  const estimatedRisk = stopLossValid && effectiveQuantity > 0 ? estimateOrderRisk(entryPrice, stopLossPrice, side, effectiveQuantity, symbol.minMove, tickValue) : null;
  const riskExceedsBudget = settings.sizingMode === "risk" && strictRiskQuantity === 0 && calculatedRiskQuantity === 1;
  const selectedEligibility = entryEligibility[side === "Buy" ? "long" : "short"];
  const orderDisabled = Boolean(equityBlockReason) || busy || !account || Boolean(contractStatus) || marketUnavailable || effectiveQuantity < 1 || !takeProfitValid || !stopLossValid || estimatedRisk == null || !selectedEligibility.allowed;
  const orderLabel = equityBlockReason ?? contractStatus ?? (marketUnavailable ? equity ? "Live bid/ask unavailable" : "Contract market data unavailable"
    : !selectedEligibility.allowed ? `${side === "Buy" ? "Long" : "Short"} entry blocked`
    : `${confirmOrders ? "Review" : "Place"} ${equity ? (side === "Buy" ? "Long" : "Short") : side} market order`);
  const manualMissing = tradeContract && !contracts.some((contract) => contract.symbol === tradeContract);
  const riskSizingStatus = riskInput.trim() === "" ? "Enter risk amount"
    : riskAmount == null ? "Enter a positive amount"
    : !stopLoss.trim() ? "Set stop loss"
    : !Number.isFinite(entryPrice) || entryPrice <= 0 ? "Waiting for live price"
    : !stopLossValid ? `Stop must be ${side === "Buy" ? "below ask" : "above bid"}`
    : calculatedRiskQuantity == null ? "Unable to calculate"
    : calculatedRiskQuantity === 0 && perContractRisk != null ? `1 ${equity ? "share" : "contract"} risks $${perContractRisk.toFixed(2)}`
    : riskExceedsBudget && estimatedRisk != null ? `1 contract · $${estimatedRisk.toFixed(2)} risk`
    : `${calculatedRiskQuantity} ${equity ? "share" : "contract"}${calculatedRiskQuantity === 1 ? "" : "s"}`;
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
    <div className="account-line"><span>{account?.displayId ?? "No account"}</span><span className={environment}>{equity ? "SCHWAB LIVE" : environment.toUpperCase()}</span></div>
    {continuous && <label className="trade-contract-field"><span><strong>Trade contract</strong><small>Chart {chartSymbol.symbol}</small></span><select aria-label="Trade contract" value={tradeContract ?? "__auto__"} onChange={(event) => onTradeContractChange(event.target.value === "__auto__" ? undefined : event.target.value)}><option value="__auto__">Auto · {chartSymbol.underlying ?? "Unavailable"}</option>{manualMissing && <option value={tradeContract}>{tradeContract} · Saved selection</option>}{contracts.map((contract) => <option key={contract.symbol} value={contract.symbol}>{contract.symbol} · {formatContractExpiration(contract.expiration)}</option>)}</select>{contractStatus && <small className="negative">{contractStatus}</small>}{!contractStatus && contractLookupError && <small className="negative">Contract list unavailable; the current selection is unchanged.</small>}</label>}
    {rollStatus && rollStatus.phase !== "clear" && <div className={`contract-roll-warning ${rollStatus.phase}`} role={rollStatus.phase === "roll-due" ? "alert" : "status"}>
      <CalendarDays size={15} />
      <span>
        <strong>{rollStatus.phase === "roll-due" ? "Contract roll date reached" : `Roll in ${rollStatus.sessionsUntilRoll} session${rollStatus.sessionsUntilRoll === 1 ? "" : "s"}`}</strong>
        <small>{rollStatus.phase === "roll-due"
          ? `${rollStatus.symbol} is no longer the customary lead month as of ${formatRollDate(rollStatus.rollDate)}.`
          : `${rollStatus.symbol} rolls ${formatRollDate(rollStatus.rollDate)}.${rollStatus.nextContract ? ` Next: ${rollStatus.nextContract.symbol}.` : ""}`}</small>
      </span>
      {rollStatus.nextContract && <button type="button" onClick={onUseNextContract}>{continuous ? "Trade" : "Switch chart"} {rollStatus.nextContract.symbol}</button>}
    </div>}
    <div className="market-buttons"><button className={side === "Sell" ? "selected" : ""} onClick={() => { setSide("Sell"); publishProjection(takeProfit, stopLoss, "Sell"); }}><small>{equity ? "SHORT" : "SELL"}</small><strong>{quote.bid.toFixed(2)}</strong></button><div><span>{(quote.ask - quote.bid).toFixed(2)}</span></div><button className={side === "Buy" ? "selected" : ""} onClick={() => { setSide("Buy"); publishProjection(takeProfit, stopLoss, "Buy"); }}><small>{equity ? "LONG" : "BUY"}</small><strong>{quote.ask.toFixed(2)}</strong></button></div>
    <div className="field compact sizing-field">
      <div className="sizing-mode" role="group" aria-label="Position sizing method">
        <button type="button" className={settings.sizingMode === "contracts" ? "active" : ""} aria-pressed={settings.sizingMode === "contracts"} onClick={() => selectSizingMode("contracts")}>{equity ? "Shares" : "Contracts"}</button>
        <button type="button" className={settings.sizingMode === "risk" ? "active" : ""} aria-pressed={settings.sizingMode === "risk"} onClick={() => selectSizingMode("risk")}>Risk $</button>
      </div>
      {settings.sizingMode === "contracts"
        ? <div className="stepper"><button type="button" aria-label={equity ? "Decrease shares" : "Decrease contracts"} onClick={() => { const next = Math.max(1, quantity - 1); setQuantity(next); publishProjection(takeProfit, stopLoss, side, next); }}><Minus size={14} /></button><input aria-label={equity ? "Shares" : "Contracts"} type="number" min="1" step="1" value={quantity} onChange={(event) => { const next = Math.max(1, Math.floor(Number(event.target.value) || 1)); setQuantity(next); publishProjection(takeProfit, stopLoss, side, next); }} /><button type="button" aria-label={equity ? "Increase shares" : "Increase contracts"} onClick={() => { const next = quantity + 1; setQuantity(next); publishProjection(takeProfit, stopLoss, side, next); }}><Plus size={14} /></button></div>
        : <div className="risk-sizing-control"><label><span>$</span><input aria-label="Risk amount in dollars" type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="0.00" value={riskInput} onFocus={() => { riskInputFocusedRef.current = true; }} onBlur={() => { riskInputFocusedRef.current = false; setRiskInput(riskAmount == null ? "" : String(riskAmount)); }} onChange={(event) => updateRiskAmount(event.target.value)} /></label><output className={riskExceedsBudget ? "over-risk" : calculatedRiskQuantity === 0 ? "insufficient" : ""} aria-live="polite">{riskSizingStatus}</output></div>}
    </div>
    <div className="section-label"><span>Exits</span><small>Server-side bracket</small></div>
    <div className="field compact"><span>Take profit price</span><div className="take-profit-control"><input aria-label="Take profit price" className={takeProfitValid ? "" : "invalid"} type="number" min={symbol.minMove} step={symbol.minMove} value={takeProfit} onChange={(event) => { const value = event.target.value; setRMenuOpen(false); setTakeProfit(value); publishProjection(value, stopLoss, side, effectiveQuantity, null); }} /><button type="button" className={`exit-price-clear ${takeProfit.trim() ? "visible" : ""}`} aria-label="Clear take profit price" title="Clear take profit price" disabled={!takeProfit.trim()} onClick={clearTakeProfit}><X size={10} /></button><div ref={rSelectorRef} className="r-selector"><button ref={rButtonRef} type="button" className={selectedR == null ? "r-selector-button" : "r-selector-button active"} aria-label="Set take profit by risk multiple" aria-haspopup="menu" aria-expanded={rMenuOpen} aria-controls="r-multiple-menu" disabled={!rSelectorEnabled} onClick={() => setRMenuOpen((open) => !open)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setRMenuOpen(true); } }}>{selectedR == null ? "R" : `${selectedR}R`}<ChevronDown size={11} /></button>{rMenuOpen && <div ref={rMenuRef} id="r-multiple-menu" className="r-multiple-menu" role="menu" aria-label="Take profit risk multiple" onKeyDown={handleRMenuKeyDown}>{orderRMultiples.map((rMultiple) => <button key={rMultiple} type="button" role="menuitemradio" aria-checked={selectedR === rMultiple} className={selectedR === rMultiple ? "selected" : ""} onClick={() => selectRMultiple(rMultiple)}>{rMultiple}R</button>)}</div>}</div></div></div>
    <div className="field compact"><span>Stop loss price</span><div className="stop-loss-control"><input aria-label="Stop loss price" className={stopLossValid ? "" : "invalid"} type="number" min={symbol.minMove} step={symbol.minMove} value={stopLoss} onChange={(event) => updateProjectedStop(event.target.value)} /><button type="button" className={`exit-price-clear ${stopLoss.trim() ? "visible" : ""}`} aria-label="Clear stop loss price" title="Clear stop loss price" disabled={!stopLoss.trim()} onClick={clearStopLoss}><X size={10} /></button><button type="button" disabled={swingStopPrice == null} aria-label={`Set stop ${side === "Buy" ? "below the latest swing low" : "above the latest swing high"}`} title={swingStopPrice == null ? `No confirmed ${settings.swingStopPivotBars}-bar swing is available on the ${timeframe} chart` : `Set ${settings.swingStopOffsetTicks} tick${settings.swingStopOffsetTicks === 1 ? "" : "s"} beyond the latest confirmed ${timeframe} swing`} onClick={() => { if (swingStopPrice != null) updateProjectedStop(String(swingStopPrice)); }}>Swing</button></div></div>
    <div className="section-label"><span>{equity ? "Protective exits time in force" : "Time in force"}</span></div>
    <select value={settings.timeInForce} onChange={(event) => onSettingsChange({ timeInForce: event.target.value as OrderTicketSettings["timeInForce"] })}><option value="DAY">DAY</option><option value="GTC">GTC</option></select>
    <dl className="ticket-info"><div><dt>{equity ? "Shares" : "Tick value"}</dt><dd>{equity ? effectiveQuantity : `${tickValue.toFixed(2)} USD`}</dd></div><div><dt>Data</dt><dd className={quote.delayed ? "negative" : "positive"}>{quote.delayed ? "Delayed" : "Real-time"}</dd></div><div><dt>Estimated risk</dt><dd className={estimatedRisk == null ? "" : "negative"}>{estimatedRisk == null ? "—" : `${estimatedRisk.toFixed(2)} USD`}</dd></div></dl>
    {rulesConfigured && <div className={`ticket-rule-status ${selectedEligibility.status}`}><span /> <strong>{side === "Buy" ? "Long" : "Short"} entry</strong><small>{selectedEligibility.reason}</small></div>}
    <label className="confirm-orders-toggle"><input type="checkbox" checked={confirmOrders} onChange={(event) => onConfirmOrdersChange(event.target.checked)} /><span><strong>Confirm orders</strong><small>Review buy, sell, and close actions</small></span></label>
    <button className={side === "Buy" ? "buy-button" : "sell-button"} disabled={orderDisabled} onClick={() => equity && onEquitySubmit ? onEquitySubmit({ accountId: account?.id ?? "", symbol: symbol.symbol, direction: side === "Buy" ? "Long" : "Short", sizingMode: settings.sizingMode === "risk" ? "risk" : "shares", riskBudget: settings.sizingMode === "risk" ? riskAmount : undefined, quantity: effectiveQuantity, referenceEntry: entryPrice, stopLoss: stopLossPrice, takeProfit: takeProfitPrice, rMultiple: selectedR, exitDuration: settings.timeInForce }) : onSubmit(draft())}>{orderLabel}</button>
  </div>;
}
