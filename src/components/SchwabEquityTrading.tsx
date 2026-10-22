import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/bridge";
import { isEquity, isEquityRiskBudgetRejection, reducedEquityRiskDraft } from "../lib/equityTrading";
import type { Account, OrderPreview, OrderUpdate, Position, SchwabEquityOrderDraft, SchwabEquityState } from "../types";

type EntryContext = { draft: SchwabEquityOrderDraft; sourceTabId: string; chartSymbol: string };
type Review = (EntryContext & { kind: "entry"; preview?: OrderPreview; previewLoading: boolean; previewError?: string })
  | (EntryContext & { kind: "risk-adjustment"; proposal?: SchwabEquityOrderDraft; loading: boolean; error?: string })
  | { kind: "close"; position: Position } | { kind: "cancel"; order: OrderUpdate };
type Feedback = { accountId?: string; level: "pending" | "error" | "warning" | "success"; message: string };

export function useSchwabEquityTrading({ account, connected, confirmOrders, onSnapshot, onAccepted, onNotify, validateEntry }: {
  account?: Account; connected: boolean; confirmOrders: boolean;
  onSnapshot: (snapshot: SchwabEquityState) => void;
  onAccepted: (symbol: string) => void; onNotify: (message: string) => void;
  validateEntry: (draft: SchwabEquityOrderDraft, sourceTabId: string, chartSymbol: string) => string | undefined;
}) {
  const [snapshot, setSnapshot] = useState<(SchwabEquityState & { accountId: string; fetchedAt: number })>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const [review, setReview] = useState<Review>();
  const [recoveryId, setRecoveryId] = useState("");
  const [pendingIds, setPendingIds] = useState(new Set<string>());
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const latest = useRef({ account, connected, confirmOrders, onSnapshot, onAccepted, onNotify, validateEntry });
  latest.current = { account, connected, confirmOrders, onSnapshot, onAccepted, onNotify, validateEntry };
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const refreshQueued = useRef(false);
  const snapshotEpoch = useRef(0);
  const operation = useRef(false);
  const pendingUntil = useRef(0);
  const refresh = useCallback(async (force = false) => {
    if (inFlight.current) {
      refreshQueued.current ||= force;
      return inFlight.current;
    }
    const work = (async () => {
      do {
        refreshQueued.current = false;
        const id = latest.current.account?.id;
        if (!id || !latest.current.connected) return;
        const epoch = snapshotEpoch.current;
        try {
          const state = await api.schwabEquityState(id);
          if (latest.current.account?.id !== id || !latest.current.connected || snapshotEpoch.current !== epoch) continue;
          setSnapshot({ ...state, accountId: id, fetchedAt: Date.now() }); setError(undefined);
          latest.current.onSnapshot(state);
        } catch (reason) { if (latest.current.account?.id === id && snapshotEpoch.current === epoch) setError(String(reason)); }
      } while (refreshQueued.current);
    })();
    inFlight.current = work;
    try { await work; } finally { inFlight.current = undefined; }
  }, []);

  useEffect(() => {
    snapshotEpoch.current += 1;
    refreshQueued.current = true;
    setSnapshot(undefined); setError(undefined); setReview(undefined); setFeedback(undefined);
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

  const report = (message: string, level: Feedback["level"] = "error", accountId = latest.current.account?.id) => {
    setFeedback({ accountId, level, message });
    latest.current.onNotify(message);
  };
  const offerRiskAdjustment = async (entry: EntryContext) => {
    const id = entry.draft.accountId;
    if (latest.current.account?.id !== id || !latest.current.connected) return;
    const pending: Review = { ...entry, draft: { ...entry.draft }, kind: "risk-adjustment", loading: true };
    setReview(pending);
    setFeedback({ accountId: id, level: "pending", message: "Price moved beyond the risk budget. Calculating a lower share count… No order was sent." });
    try {
      const quotes = await api.quotes("schwab", [entry.draft.symbol]);
      if (latest.current.account?.id !== id || !latest.current.connected) return;
      const quote = quotes.find(value => value.symbol.toUpperCase() === entry.draft.symbol.toUpperCase());
      if (!quote) throw new Error("Live Schwab quotes are unavailable. Refresh the ticket.");
      const proposal = reducedEquityRiskDraft(entry.draft, quote);
      setReview(current => current === pending ? { ...pending, loading: false, proposal } : current);
      setFeedback({ accountId: id, level: "warning", message: `Order not submitted: price moved beyond the risk budget. Review the proposed reduction from ${entry.draft.quantity} to ${proposal.quantity} shares.` });
    } catch (reason) {
      const message = String(reason);
      setReview(current => current === pending ? { ...pending, loading: false, error: message } : current);
      report(message, "error", id);
    }
  };
  const run = async (action: () => ReturnType<typeof api.placeSchwabEquityOrder>, { entry, pendingId, progress = "Submitting Schwab live order…" }: { entry?: EntryContext; pendingId?: string; progress?: string } = {}) => {
    if (operation.current) return;
    const actionAccountId = latest.current.account?.id;
    operation.current = true; setBusy(true);
    setFeedback({ accountId: actionAccountId, level: "pending", message: progress });
    if (pendingId) setPendingIds((ids) => new Set(ids).add(pendingId));
    try {
      const result = await action();
      // Discard a read begun before this mutation, then coalesce its forced
      // follow-up instead of starting competing refreshes for the same account.
      snapshotEpoch.current += 1;
      pendingUntil.current = Date.now() + 30_000;
      setRefreshEpoch((value) => value + 1);
      if (result.brokerOutcome === "confirmed") {
        if (result.brokerOrder?.status === "Rejected") {
          report(result.brokerOrder.statusDescription || "Schwab rejected the order. Review the ticket and broker order status.", "error", actionAccountId);
          await refresh(true);
          return;
        }
        if (entry && latest.current.account?.id === actionAccountId) latest.current.onAccepted(entry.draft.symbol);
        report(result.warnings.join("; ") || "Schwab confirmed the request; order status is updating.", result.warnings.length ? "warning" : "success", actionAccountId);
        setReview(undefined);
      } else {
        const rejected = result.brokerOutcome === "rejected";
        const message = result.rejectionReason || result.warnings.join("; ") || (rejected ? "Schwab rejected the request." : "Schwab outcome unknown; do not retry.");
        report(rejected ? `Order not submitted: ${message}` : `Schwab outcome unknown. Do not retry. ${message}`, rejected ? "error" : "warning", actionAccountId);
        // Only a definitive preflight rejection is safe to resize and resubmit.
        // Unknown broker outcomes retain the existing reconciliation workflow.
        if (rejected && entry?.draft.sizingMode === "risk" && isEquityRiskBudgetRejection(message)) await offerRiskAdjustment(entry);
      }
      await refresh(true);
    } catch (reason) { report(String(reason), "error", actionAccountId); await refresh(true); }
    finally {
      setBusy(false); operation.current = false;
      if (pendingId) setPendingIds((ids) => { const next = new Set(ids); next.delete(pendingId); return next; });
    }
  };
  const submit = async (draft: SchwabEquityOrderDraft, sourceTabId: string, chartSymbol: string) => {
    const blocked = latest.current.validateEntry(draft, sourceTabId, chartSymbol);
    if (blocked) return report(blocked);
    if (!api.isNative) return report("Schwab trading is disabled in browser demo mode.");
    if (operation.current) return;
    const entry = { draft: { ...draft }, sourceTabId, chartSymbol };
    if (!latest.current.confirmOrders) return run(() => api.placeSchwabEquityOrder(entry.draft, crypto.randomUUID()), { entry });
    const pendingReview: Review = { kind: "entry", draft: { ...draft }, sourceTabId, chartSymbol, previewLoading: true };
    setReview(pendingReview);
    operation.current = true; setBusy(true);
    setFeedback({ accountId: draft.accountId, level: "pending", message: "Checking Schwab order preview… No order has been sent." });
    try {
      const preview = await api.previewSchwabEquityOrder(draft);
      if (latest.current.account?.id === draft.accountId && latest.current.connected) {
        setReview(current => current === pendingReview ? { ...pendingReview, preview, previewLoading: false } : current);
        if (!preview.valid) report(preview.errors.join("; ") || "Schwab did not approve this order preview. No order was sent.", "error", draft.accountId);
        else setFeedback({ accountId: draft.accountId, level: "success", message: "Schwab preview ready. Confirm the review to send the live order." });
      }
    } catch (reason) {
      if (draft.sizingMode === "risk" && isEquityRiskBudgetRejection(String(reason))) {
        await offerRiskAdjustment(entry);
        return;
      }
      const message = `Schwab preview failed. No order was sent. ${String(reason)}`;
      setReview(current => current === pendingReview ? { ...pendingReview, previewLoading: false, previewError: message } : current);
      report(message, "error", draft.accountId);
    }
    finally { setBusy(false); operation.current = false; }
  };
  const close = async (position: Position) => {
    if (!isEquity(position.assetType) || position.provider !== "schwab" || position.accountId !== latest.current.account?.id) return;
    if (!api.isNative) return report("Schwab trading is disabled in browser demo mode.");
    if (latest.current.confirmOrders) setReview({ kind: "close", position });
    else await run(() => api.closeSchwabEquityPosition(position.accountId!, position.id, position.symbol), { pendingId: position.id, progress: "Closing Schwab position: checking linked orders and remaining shares…" });
  };
  const replace = async (order: OrderUpdate, price: number) => {
    if (order.provider !== "schwab" || order.accountId !== latest.current.account?.id) return;
    await run(() => api.replaceSchwabEquityOrder(order.accountId!, order.id, order.symbol, price), { pendingId: order.id, progress: "Replacing Schwab protective order…" });
  };
  const cancel = async (order: OrderUpdate) => {
    if (order.provider !== "schwab" || order.accountId !== latest.current.account?.id || !isEquity(order.assetType)) return;
    if (latest.current.confirmOrders) setReview({ kind: "cancel", order });
    else await run(() => api.cancelSchwabEquityOrder(order.accountId!, order.id, order.symbol), { pendingId: order.id, progress: "Canceling linked Schwab orders…" });
  };
  const confirm = async () => {
    if (!review) return;
    if (review.kind === "entry") {
      const blocked = latest.current.validateEntry(review.draft, review.sourceTabId, review.chartSymbol);
      if (blocked) return report(blocked);
      if (!review.preview?.valid || review.previewLoading) return;
      await run(() => api.placeSchwabEquityOrder(review.draft, crypto.randomUUID()), { entry: review });
    } else if (review.kind === "risk-adjustment") {
      if (!review.proposal || review.loading) return;
      const blocked = latest.current.validateEntry(review.proposal, review.sourceTabId, review.chartSymbol);
      if (blocked) return report(blocked);
      const entry = { draft: review.proposal, sourceTabId: review.sourceTabId, chartSymbol: review.chartSymbol };
      setReview(undefined);
      await run(() => api.placeSchwabEquityOrder(entry.draft, crypto.randomUUID()), { entry });
    } else if (review.kind === "close") {
      const position = review.position;
      if (position.accountId !== latest.current.account?.id) return;
      await run(() => api.closeSchwabEquityPosition(position.accountId!, position.id, position.symbol), { pendingId: position.id, progress: "Closing Schwab position: checking linked orders and remaining shares…" });
    } else {
      const order = review.order;
      if (order.accountId !== latest.current.account?.id) return;
      await run(() => api.cancelSchwabEquityOrder(order.accountId!, order.id, order.symbol), { pendingId: order.id, progress: "Canceling linked Schwab orders…" });
    }
  };
  const ready = connected && account != null && snapshot?.accountId === account.id && !error && Date.now() - snapshot.fetchedAt < 30_000;
  const unresolved = snapshot?.mutations.filter((m) => ["submitting", "unknown", "reconciling", "reconciliation_failed"].includes(m.state) || m.manualReviewRequired) ?? [];
  const recover = async (mutationId: string) => {
    if (!account || !/^\d+$/.test(recoveryId)) return;
    setBusy(true);
    try { await api.reconcileSchwabEquityMutation(account.id, mutationId, recoveryId); setRecoveryId(""); await refresh(); }
    catch (reason) { report(String(reason)); }
    finally { setBusy(false); }
  };
  const durablePendingIds = new Set([...pendingIds, ...unresolved.flatMap((intent) => intent.targetId ? [intent.targetId] : [])]);
  const reviewLoading = (review?.kind === "entry" && review.previewLoading) || (review?.kind === "risk-adjustment" && review.loading);
  const confirmDisabled = busy || (review?.kind === "entry" && !review.preview?.valid) || (review?.kind === "risk-adjustment" && !review.proposal);
  const confirmLabel = review?.kind === "entry" && review.previewLoading ? "Checking preview…"
    : review?.kind === "risk-adjustment" && review.loading ? "Calculating shares…"
    : busy ? review?.kind === "risk-adjustment" ? "Updating account…" : "Submitting…"
    : review?.kind === "risk-adjustment" ? `Submit ${review.proposal?.quantity ?? "reduced"} shares · SCHWAB LIVE` : "Confirm SCHWAB LIVE";
  return { snapshot, error, ready, busy, pendingIds: durablePendingIds, refresh, submit, close, replace, cancel,
    alerts: <>{feedback && feedback.accountId === account?.id && <div className={`schwab-action-feedback ${feedback.level}`} role={feedback.level === "error" || feedback.level === "warning" ? "alert" : "status"}>
      <span>{feedback.message}</span>{feedback.level !== "pending" && <button type="button" aria-label="Dismiss Schwab order message" onClick={() => setFeedback(undefined)}>Dismiss</button>}
    </div>}
      {error && <div className="demo-warning" role="alert">Schwab trading unavailable: {error}</div>}
      {snapshot?.warnings?.map((warning) => <div className="demo-warning" role="status" key={warning}>{warning}</div>)}
      {snapshot?.issues.map((issue) => <div className="demo-warning" role="alert" key={issue}>{issue}</div>)}
      {unresolved.map((mutation) => <div className="schwab-recovery" key={mutation.id}>
        <strong>Recover {mutation.symbol} order</strong><small>Match this request to its broker order number from Schwab.</small>
        <input aria-label="Schwab broker order number" inputMode="numeric" value={recoveryId} onChange={(event) => setRecoveryId(event.target.value)} />
        <button disabled={busy || !/^\d+$/.test(recoveryId)} onClick={() => void recover(mutation.id)}>Match broker order</button>
      </div>)}</>,
    review: review && <div className="modal-backdrop"><section className="modal schwab-order-review" role="dialog" aria-modal="true" aria-label={review.kind === "risk-adjustment" ? "Reduce shares to stay within risk?" : "Review Schwab live order"}>
      <header><h2>SCHWAB LIVE · {review.kind === "entry" ? "Review equity entry" : review.kind === "risk-adjustment" ? "Reduce shares to stay within risk?" : review.kind === "close" ? "Close position" : "Cancel linked orders"}</h2></header>
      {review.kind === "entry" ? <><p>{review.draft.direction} {review.draft.quantity} shares of {review.draft.symbol}</p>
        <dl className="ticket-info"><div><dt>Estimated entry</dt><dd>${review.draft.referenceEntry.toFixed(2)}</dd></div>
          <div><dt>Stop</dt><dd>${review.draft.stopLoss.toFixed(2)}</dd></div><div><dt>Target</dt><dd>${review.draft.takeProfit.toFixed(2)}</dd></div>
          <div><dt>Estimated initial risk</dt><dd>${(Math.abs(review.draft.referenceEntry - review.draft.stopLoss) * review.draft.quantity).toFixed(2)}</dd></div>
          <div><dt>Protective exits</dt><dd>{review.draft.exitDuration}</dd></div></dl>
        <p>Share count and exit prices stay fixed after submission. Market fills and stop execution can differ from these estimates.</p>
        {review.previewLoading && <p role="status">Checking Schwab order preview… No order has been sent.</p>}
        {review.previewError && <p className="negative" role="alert">{review.previewError}</p>}
        {review.preview?.errors.map((message) => <p className="negative" role="alert" key={message}>{message}</p>)}</>
        : review.kind === "risk-adjustment" ? <>
          <p>The price moved and {review.draft.quantity} shares would exceed your ${review.draft.riskBudget?.toFixed(2)} risk budget. No order was sent.</p>
          {review.loading && <p role="status">Getting a fresh quote and calculating shares…</p>}
          {review.error && <p className="negative" role="alert">{review.error}</p>}
          {review.proposal && <>
            <p>Enter {review.proposal.direction.toLowerCase()} {review.proposal.symbol} with fewer shares?</p>
            <dl className="ticket-info"><div><dt>Shares</dt><dd>{review.draft.quantity} → {review.proposal.quantity}</dd></div>
              <div><dt>Current entry estimate</dt><dd>${review.proposal.referenceEntry.toFixed(2)}</dd></div>
              <div><dt>Estimated risk</dt><dd>${(Math.abs(review.proposal.referenceEntry - review.proposal.stopLoss) * review.proposal.quantity).toFixed(2)} / ${review.proposal.riskBudget?.toFixed(2)}</dd></div>
              <div><dt>Stop</dt><dd>${review.proposal.stopLoss.toFixed(2)}</dd></div><div><dt>Target</dt><dd>${review.proposal.takeProfit.toFixed(2)}</dd></div>
              <div><dt>Protective exits</dt><dd>{review.proposal.exitDuration}</dd></div></dl>
            <p>The stop and target stay at these prices. Market fills can differ from this estimate. The order will be checked again before submission.</p>
          </>}
        </> : review.kind === "close" ? <p>Cancel linked equity orders, confirm cancellation, then close the remaining {review.position.symbol} shares at market.</p>
          : <p>Cancel the linked {review.order.symbol} order group. An open position may be left without its stop and target.</p>}
      {feedback && feedback.accountId === account?.id && ["error", "warning"].includes(feedback.level) && (review.kind === "close" || review.kind === "cancel" || (review.kind === "entry" && review.preview?.valid) || (review.kind === "risk-adjustment" && !review.error && feedback.level === "error")) && <p className="negative" role="alert">{feedback.message}</p>}
      <footer><button className="secondary-button" disabled={busy && !reviewLoading} onClick={() => setReview(undefined)}>{review.kind === "risk-adjustment" ? "Cancel" : "Back"}</button><button className="buy-button" disabled={confirmDisabled} onClick={() => void confirm()}>{confirmLabel}</button></footer>
    </section></div>,
  };
}
