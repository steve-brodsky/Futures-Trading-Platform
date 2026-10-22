// Browser regression fixture. Serve with `npm run dev`, then open
// /scripts/fixtures/order-projection.html and run window.runProjectionRegression().
// This mounts the real ticket; it never connects to a broker or submits orders.
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OrderTicket } from "../../src/components/OrderTicket";
import { applyProjectedExitEdit, recalculateOrderProjectionAtR, type OrderProjection } from "../../src/lib/tradeLines";
import { calculateTakeProfitAtR } from "../../src/lib/indicators";
import type { OrderTicketSettings, Quote, SymbolMeta } from "../../src/types";

const symbol: SymbolMeta = { provider: "schwab", symbol: "SPY", description: "SPY", exchange: "NYSE", assetType: "ETF", minMove: .01, pointValue: 1 };
const initial: OrderProjection = { entryPrice: 100, side: "Buy", stopLoss: 98, takeProfit: 103, quantity: 50, rMultiple: 1.5 };
const initialSettings: OrderTicketSettings = { sizingMode: "risk", riskAmount: 100, riskSizingPolicy: "strict", timeInForce: "GTC", swingStopPivotBars: 2, swingStopOffsetTicks: 1 };
const allowed = { allowed: true, status: "allowed" as const, reason: "", nodeResults: {} };
let control: { edit: (field: "stopLoss" | "takeProfit", price: number, entry: number) => void; snapshot: () => OrderProjection; reset: (projection: OrderProjection, settings?: Partial<OrderTicketSettings>) => void };
let writes: OrderProjection[] = [];

function Fixture() {
  const [projection, setProjection] = useState(initial);
  const [entry, setEntry] = useState(100);
  const [settings, setSettings] = useState(initialSettings);
  const quote: Quote = { provider: "schwab", symbol: "SPY", bid: entry - .02, ask: entry, last: entry, change: 0, changePct: 0, delayed: false, halted: false, timestamp: new Date().toISOString(), receivedAt: Date.now() };
  control = {
    edit(field, price, nextEntry) {
      setEntry(nextEntry);
      setProjection(current => applyProjectedExitEdit(current, field, price, nextEntry, .01));
    },
    snapshot: () => projection,
    reset(next, nextSettings) { setEntry(next.entryPrice ?? 100); setSettings({ ...initialSettings, ...nextSettings }); setProjection(next); },
  };
  useEffect(() => {
    setProjection(current => recalculateOrderProjectionAtR(current, current.side === "Sell" ? quote.bid : quote.ask, .01));
  }, [quote.bid, quote.ask]);
  return <OrderTicket equity chartSymbol={symbol} tradeSymbol={symbol} quote={quote} bars={[]} timeframe="1m" settings={settings} contracts={[]} environment="live" busy={false} confirmOrders rulesConfigured={false} entryEligibility={{ long: allowed, short: allowed }} orderProjection={projection} resetEpoch={0}
    onTradeContractChange={() => {}} onUseNextContract={() => {}} onConfirmOrdersChange={() => {}} onSubmit={() => { throw new Error("Submission is forbidden in this fixture"); }}
    onSettingsChange={patch => setSettings(current => ({ ...current, ...patch }))}
    onProjectionChange={next => {
      writes.push(next);
      if (writes.length > 100) throw new Error("Projection feedback loop: more than 100 writes");
      setProjection(recalculateOrderProjectionAtR(next, next.side === "Sell" ? quote.bid : quote.ask, .01));
    }} />;
}

const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const selectSide = (side: "Buy" | "Sell") => (document.querySelectorAll(".market-buttons button")[side === "Buy" ? 1 : 0] as HTMLButtonElement).click();
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

Object.assign(window, {
  async runProjectionRegression() {
    // act flushes the real local-state/parent-effect cycle, including stale writes.
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const results: string[] = [];
    for (const side of ["Buy", "Sell"] as const) {
      const stop = side === "Buy" ? 98 : 101.98;
      writes = [];
      await act(async () => {
        control.reset({ ...initial, side, stopLoss: stop, takeProfit: side === "Buy" ? 103 : 96.98 });
      });
      await act(async () => { selectSide(side); });
      // Quote changes across a whole-share boundary at the same time as a drag.
      // Previously the quote effect repeatedly republished the pre-drag stop.
      for (const [nextStop, nextAsk] of side === "Buy" ? [[96, 100.1], [97, 100.11], [97.5, 100.12]] : [[104, 100.1], [103, 100.11], [102.5, 100.12]]) {
        writes = [];
        await act(async () => { control.edit("stopLoss", nextStop, nextAsk); });
        await settle();
        const snapshot = control.snapshot();
        const nextEntry = side === "Buy" ? nextAsk : nextAsk - .02;
        assert(snapshot.stopLoss === nextStop, `${side}: stop reverted after drag`);
        assert(Number(input("Stop loss price").value) === nextStop, `${side}: ticket stop differs from chart`);
        assert(snapshot.takeProfit === calculateTakeProfitAtR(nextEntry, nextStop, side, 1.5, .01), `${side}: R target incorrect`);
        assert(snapshot.quantity === Math.floor((100 + 1e-9) / Math.abs(nextEntry - nextStop)), `${side}: stale share quantity`);
        assert(writes.every(write => write.stopLoss === nextStop), `${side}: an effect republished a stale stop`);
        assert(writes.length <= 2, `${side}: projection failed to settle`);
      }
      results.push(`${side}: stop drag with simultaneous quote changes and risk sizing`);
    }
    writes = [];
    await act(async () => { control.reset(initial); });
    await act(async () => { selectSide("Buy"); });
    writes = [];
    await act(async () => { control.edit("takeProfit", 105, 100.1); });
    assert(control.snapshot().takeProfit === 105 && control.snapshot().rMultiple == null, "Manual target drag was overwritten or kept R");
    assert(writes.every(write => write.takeProfit === 105 && write.rMultiple == null), "Stale R target republished after target drag");
    await act(async () => { control.edit("stopLoss", 96, 100.2); });
    assert(control.snapshot().takeProfit === 105, "Quote/stop changes moved a manual target");
    results.push("Manual target drag clears R and stays fixed");
    writes = [];
    await act(async () => { control.reset(initial); });
    writes = [];
    // A quote tick smaller than a share boundary must still update entry and R.
    await act(async () => { control.edit("stopLoss", 98, 99.999); });
    assert(control.snapshot().quantity === 50 && control.snapshot().entryPrice === 99.999, "Entry did not refresh with unchanged quantity");
    results.push("Quote refresh with unchanged shares");
    writes = [];
    await act(async () => { control.reset(initial, { sizingMode: "contracts" }); });
    writes = [];
    await act(async () => { control.edit("stopLoss", 96, 100.1); });
    assert(control.snapshot().stopLoss === 96 && control.snapshot().quantity === 1, "Drag changed manual share count");
    results.push("Manual shares stay fixed during dragging");
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
    return results;
  },
});
