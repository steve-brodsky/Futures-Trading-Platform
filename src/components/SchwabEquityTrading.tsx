import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/bridge";
import { isEquity } from "../lib/equityTrading";
import type { Account, OrderPreview, OrderUpdate, Position, SchwabEquityOrderDraft, SchwabEquityState } from "../types";

type Review = { kind: "entry"; draft: SchwabEquityOrderDraft; sourceTabId: string; chartSymbol: string; preview: OrderPreview }
  | { kind: "close"; position: Position } | { kind: "cancel"; order: OrderUpdate };

export function useSchwabEquityTrading({ account, connected, confirmOrders, onSnapshot, onAccepted, onNotify, validateEntry }: {
  account?: Account; connected: boolean; confirmOrders: boolean;
  onSnapshot: (snapshot: SchwabEquityState) => void;
  onAccepted: (symbol: string) => void; onNotify: (message: string) => void;
  validateEntry: (draft: SchwabEquityOrderDraft, sourceTabId: string, chartSymbol: string) => string | undefined;
}) {
  const [snapshot, setSnapshot] = useState<(SchwabEquityState & { accountId: string; fetchedAt: number })>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review>();
  const [recoveryId, setRecoveryId] = useState("");
  const [pendingIds, setPendingIds] = useState(new Set<string>());
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const latest = useRef({ account, connected, confirmOrders, onSnapshot, onAccepted, onNotify, validateEntry });
  latest.current = { account, connected, confirmOrders, onSnapshot, onAccepted, onNotify, validateEntry };
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const operation = useRef(false);
  const pendingUntil = useRef(0);
  const refresh = useCallback(async (force = false) => {
    if (inFlight.current) { await inFlight.current; if (!force) return; }
    const id = latest.current.account?.id;
    if (!id || !latest.current.connected) return;
    const work = (async () => {
      try {
        const state = await api.schwabEquityState(id);
        if (latest.current.account?.id !== id || !latest.current.connected) return;
        setSnapshot({ ...state, accountId: id, fetchedAt: Date.now() }); setError(undefined);
        latest.current.onSnapshot(state);
      } catch (reason) { if (latest.current.account?.id === id) setError(String(reason)); }
    })();
    inFlight.current = work;
    try { await work; } finally { inFlight.current = undefined; }
  }, []);

  useEffect(() => {
    setSnapshot(undefined); setError(undefined); setReview(undefined);
  }, [account?.id, connected]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (!disposed) timer = setTimeout(tick, Date.now() < pendingUntil.current ? 1_000 : 15_000);
    };
    if (account && connected) void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [account?.id, connected, refresh, refreshEpoch]);

  useEffect(() => {
    if (!api.isNative || !account || !connected) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void listen<{ provider?: string; accountId: string }>("orders-snapshot", ({ payload }) => {
      if (payload.provider === "schwab" && payload.accountId === account.id) setRefreshEpoch((value) => value + 1);
    }).then((unlisten) => { if (disposed) unlisten(); else cleanup = unlisten; });
    return () => { disposed = true; cleanup?.(); };
  }, [account?.id, connected]);

  const run = async (action: () => ReturnType<typeof api.placeSchwabEquityOrder>, symbol?: string, pendingId?: string) => {
    if (operation.current) return;
    const actionAccountId = latest.current.account?.id;
    operation.current = true; setBusy(true);
    if (pendingId) setPendingIds((ids) => new Set(ids).add(pendingId));
    try {
      const result = await action();
      pendingUntil.current = Date.now() + 15_000;
      setRefreshEpoch((value) => value + 1);
      if (result.brokerOutcome === "confirmed") {
        if (result.brokerOrder?.status === "Rejected") {
          latest.current.onNotify(result.brokerOrder.statusDescription || "Schwab rejected the order. Review the ticket and broker order status.");
          await refresh(true);
          return;
        }
        if (symbol && latest.current.account?.id === actionAccountId) latest.current.onAccepted(symbol);
        latest.current.onNotify(result.warnings.join("; ") || "Schwab confirmed the request; order status is updating.");
        setReview(undefined);
      } else {
        latest.current.onNotify(result.rejectionReason || result.warnings.join("; ") || "Schwab outcome unknown; do not retry.");
      }
      await refresh(true);
    } catch (reason) { latest.current.onNotify(String(reason)); await refresh(true); }
    finally {
      setBusy(false); operation.current = false;
      if (pendingId) setPendingIds((ids) => { const next = new Set(ids); next.delete(pendingId); return next; });
    }
  };
  const submit = async (draft: SchwabEquityOrderDraft, sourceTabId: string, chartSymbol: string) => {
    const blocked = latest.current.validateEntry(draft, sourceTabId, chartSymbol);
    if (blocked) return latest.current.onNotify(blocked);
    if (!api.isNative) return latest.current.onNotify("Schwab trading is disabled in browser demo mode.");
    if (operation.current) return;
    if (!latest.current.confirmOrders) return run(() => api.placeSchwabEquityOrder(draft, crypto.randomUUID()), draft.symbol);
    operation.current = true; setBusy(true);
    try {
      const preview = await api.previewSchwabEquityOrder(draft);
      if (latest.current.account?.id === draft.accountId) setReview({ kind: "entry", draft: { ...draft }, sourceTabId, chartSymbol, preview });
    } catch (reason) { latest.current.onNotify(String(reason)); }
    finally { setBusy(false); operation.current = false; }
  };
  const close = async (position: Position) => {
    if (!isEquity(position.assetType) || position.provider !== "schwab" || position.accountId !== latest.current.account?.id) return;
    if (!api.isNative) return latest.current.onNotify("Schwab trading is disabled in browser demo mode.");
    if (latest.current.confirmOrders) setReview({ kind: "close", position });
    else await run(() => api.closeSchwabEquityPosition(position.accountId!, position.id, position.symbol), undefined, position.id);
  };
  const replace = async (order: OrderUpdate, price: number) => {
    if (order.provider !== "schwab" || order.accountId !== latest.current.account?.id) return;
    await run(() => api.replaceSchwabEquityOrder(order.accountId!, order.id, order.symbol, price), undefined, order.id);
  };
  const cancel = async (order: OrderUpdate) => {
    if (order.provider !== "schwab" || order.accountId !== latest.current.account?.id || !isEquity(order.assetType)) return;
    if (latest.current.confirmOrders) setReview({ kind: "cancel", order });
    else await run(() => api.cancelSchwabEquityOrder(order.accountId!, order.id, order.symbol), undefined, order.id);
  };
  const confirm = async () => {
    if (!review) return;
    if (review.kind === "entry") {
      const blocked = latest.current.validateEntry(review.draft, review.sourceTabId, review.chartSymbol);
      if (blocked) return latest.current.onNotify(blocked);
      if (!review.preview.valid) return;
      await run(() => api.placeSchwabEquityOrder(review.draft, crypto.randomUUID()), review.draft.symbol);
    } else if (review.kind === "close") {
      const position = review.position;
      if (position.accountId !== latest.current.account?.id) return;
      await run(() => api.closeSchwabEquityPosition(position.accountId!, position.id, position.symbol), undefined, position.id);
    } else {
      const order = review.order;
      if (order.accountId !== latest.current.account?.id) return;
      await run(() => api.cancelSchwabEquityOrder(order.accountId!, order.id, order.symbol), undefined, order.id);
    }
  };
  const ready = connected && account != null && snapshot?.accountId === account.id && !error && Date.now() - snapshot.fetchedAt < 30_000;
  const unresolved = snapshot?.mutations.filter((m) => ["submitting", "unknown", "reconciling", "reconciliation_failed"].includes(m.state) || m.manualReviewRequired) ?? [];
  const recover = async (mutationId: string) => {
    if (!account || !/^\d+$/.test(recoveryId)) return;
    setBusy(true);
    try { await api.reconcileSchwabEquityMutation(account.id, mutationId, recoveryId); setRecoveryId(""); await refresh(); }
    catch (reason) { latest.current.onNotify(String(reason)); }
    finally { setBusy(false); }
  };
  const durablePendingIds = new Set([...pendingIds, ...unresolved.flatMap((intent) => intent.targetId ? [intent.targetId] : [])]);
  return { snapshot, error, ready, busy, pendingIds: durablePendingIds, refresh, submit, close, replace, cancel,
    alerts: <>{error && <div className="demo-warning" role="alert">Schwab trading unavailable: {error}</div>}
      {snapshot?.warnings?.map((warning) => <div className="demo-warning" role="status" key={warning}>{warning}</div>)}
      {snapshot?.issues.map((issue) => <div className="demo-warning" role="alert" key={issue}>{issue}</div>)}
      {unresolved.map((mutation) => <div className="schwab-recovery" key={mutation.id}>
        <strong>Recover {mutation.symbol} order</strong><small>Match this request to its broker order number from Schwab.</small>
        <input aria-label="Schwab broker order number" inputMode="numeric" value={recoveryId} onChange={(event) => setRecoveryId(event.target.value)} />
        <button disabled={busy || !/^\d+$/.test(recoveryId)} onClick={() => void recover(mutation.id)}>Match broker order</button>
      </div>)}</>,
    review: review && <div className="modal-backdrop"><section className="modal schwab-order-review" role="dialog" aria-modal="true" aria-label="Review Schwab live order">
      <header><h2>SCHWAB LIVE · {review.kind === "entry" ? "Review equity entry" : review.kind === "close" ? "Close position" : "Cancel linked orders"}</h2></header>
      {review.kind === "entry" ? <><p>{review.draft.direction} {review.draft.quantity} shares of {review.draft.symbol}</p>
        <dl className="ticket-info"><div><dt>Estimated entry</dt><dd>${review.draft.referenceEntry.toFixed(2)}</dd></div>
          <div><dt>Stop</dt><dd>${review.draft.stopLoss.toFixed(2)}</dd></div><div><dt>Target</dt><dd>${review.draft.takeProfit.toFixed(2)}</dd></div>
          <div><dt>Estimated initial risk</dt><dd>${(Math.abs(review.draft.referenceEntry - review.draft.stopLoss) * review.draft.quantity).toFixed(2)}</dd></div>
          <div><dt>Protective exits</dt><dd>{review.draft.exitDuration}</dd></div></dl>
        <p>Share count and exit prices stay fixed after submission. Market fills and stop execution can differ from these estimates.</p>
        {review.preview.errors.map((message) => <p className="negative" key={message}>{message}</p>)}</>
        : review.kind === "close" ? <p>Cancel linked equity orders, confirm cancellation, then close the remaining {review.position.symbol} shares at market.</p>
          : <p>Cancel the linked {review.order.symbol} order group. An open position may be left without its stop and target.</p>}
      <footer><button disabled={busy} onClick={() => setReview(undefined)}>Back</button><button className="buy-button" disabled={busy || (review.kind === "entry" && !review.preview.valid)} onClick={() => void confirm()}>{busy ? "Submitting…" : "Confirm SCHWAB LIVE"}</button></footer>
    </section></div>,
  };
}
