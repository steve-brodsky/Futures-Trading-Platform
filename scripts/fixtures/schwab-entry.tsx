// Serve with `npm run dev`, open /scripts/fixtures/schwab-entry.html, and run
// window.runSchwabEntryRegression(). All broker methods are replaced with mocks;
// the only allowed Tauri calls are inert event-listener registrations.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useSchwabEquityTrading } from "../../src/components/SchwabEquityTrading";
import { api } from "../../src/lib/bridge";
import type { Account, BrokerMutationResult, OrderPreview, Quote, SchwabEquityOrderDraft, SchwabEquityState } from "../../src/types";
import "../../src/styles.css";

Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: () => 1,
    invoke: (command: string) => {
      if (command === "plugin:event|listen" || command === "plugin:event|unlisten") return Promise.resolve(1);
      throw new Error(`Native commands forbidden in fixture: ${command}`);
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
});
const account: Account = { provider: "schwab", id: "fixture-account", displayId: "Mock Schwab", accountType: "Margin", status: "Active", currency: "USD" };
const draft: SchwabEquityOrderDraft = { accountId: account.id, symbol: "SPY", direction: "Long", sizingMode: "risk", riskBudget: 100, quantity: 50, referenceEntry: 100, stopLoss: 98, takeProfit: 103, rMultiple: 1.5, exitDuration: "GTC" };
const riskError = "Price moved: the reviewed quantity exceeds your risk budget. Refresh the ticket";
const state: SchwabEquityState = { sessionOpen: true, sessionMessage: "Fixture", positions: [], orders: [], riskBaselines: [], issues: [], warnings: [], mutations: [] };
const result = (brokerOutcome: BrokerMutationResult["brokerOutcome"], rejectionReason?: string): BrokerMutationResult => ({ brokerOutcome, rejectionReason, mutationId: "fixture", localPersistence: "complete", reconciliationStatus: brokerOutcome === "unknown" ? "required" : "not_required", warnings: [], brokerOrder: null, closeResult: null, retryBlocked: brokerOutcome !== "rejected" });
const placed: Array<{ draft: SchwabEquityOrderDraft; id: string }> = [];
let notifications: string[] = [];
let accepted: string[] = [];
let ask = 100.1;
let blocked: string | undefined;
let placements: BrokerMutationResult[] = [];
let preview: () => Promise<OrderPreview> = async () => ({ valid: true, summary: "Fixture preview", errors: [] });
let readState: () => Promise<SchwabEquityState> = async () => state;
let snapshots: SchwabEquityState[] = [];
Object.assign(api, {
  isNative: true,
  schwabEquityState: () => readState(),
  quotes: async (): Promise<Quote[]> => [{ provider: "schwab", symbol: "SPY", ask, bid: ask - .02, last: ask, change: 0, changePct: 0, delayed: false, halted: false, timestamp: new Date().toISOString(), receivedAt: Date.now() }],
  previewSchwabEquityOrder: () => preview(),
  placeSchwabEquityOrder: async (order: SchwabEquityOrderDraft, id: string) => {
    placed.push({ draft: { ...order }, id });
    const next = placements.shift();
    if (!next) throw new Error("Unexpected duplicate placement");
    return next;
  },
});

let control: ReturnType<typeof useSchwabEquityTrading>;
function Fixture({ confirmOrders }: { confirmOrders: boolean }) {
  control = useSchwabEquityTrading({ account, connected: true, confirmOrders, onSnapshot: value => snapshots.push(value), onAccepted: symbol => accepted.push(symbol), onNotify: message => notifications.push(message), validateEntry: () => blocked });
  return <main style={{ padding: 20, width: 480 }}>{control.alerts}{control.review}</main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture confirmOrders={false} />);
let generation = 0;
const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
const text = () => document.body.textContent ?? "";
const button = (pattern: RegExp) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(value => pattern.test(value.textContent ?? ""))!;
const reset = async (confirmOrders = false) => {
  placed.length = 0; notifications = []; accepted = []; ask = 100.1; blocked = undefined; placements = [];
  preview = async () => ({ valid: true, summary: "Fixture preview", errors: [] });
  readState = async () => state;
  await act(async () => { root.render(<Fixture key={++generation} confirmOrders={confirmOrders} />); });
  snapshots = [];
};
const submit = () => act(async () => { await control.submit(draft, "fixture-tab", "SPY"); });
const click = (pattern: RegExp) => act(async () => { button(pattern).click(); });

Object.assign(window, {
  async showSchwabRiskReview() {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await reset(); placements = [result("rejected", riskError)];
    await submit();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  },
  async runSchwabEntryRegression() {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const passed: string[] = [];
    await reset();
    let resolveOld!: (value: SchwabEquityState) => void;
    let reads = 0;
    const updated = { ...state, sessionMessage: "After confirmed mutation" };
    readState = () => ++reads === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(updated);
    let first!: Promise<void>;
    await act(async () => { first = control.refresh(true); });
    placements = [result("confirmed")];
    let mutationRefresh!: Promise<void>;
    await act(async () => { mutationRefresh = control.submit(draft, "fixture-tab", "SPY"); });
    const forced = [control.refresh(true), control.refresh(true)];
    assert(reads === 1, "Concurrent refreshes started competing native reads");
    await act(async () => { resolveOld({ ...state, sessionMessage: "Stale before mutation" }); await Promise.all([first, mutationRefresh, ...forced]); });
    assert(Number(reads) === 2, `Expected one coalesced follow-up, got ${reads} reads`);
    assert(snapshots.length === 1 && snapshots[0].sessionMessage === updated.sessionMessage, "A stale pre-mutation snapshot overwrote the accepted order state");
    assert(!control.busy && accepted.length === 1, "Confirmed mutation did not finish after refresh");
    passed.push("Coalesced post-mutation refresh discards stale account state");
    await reset();
    placements = [{ ...result("confirmed"), brokerOrder: { provider: "schwab", accountId: account.id, id: "filled", symbol: "SPY", side: "Buy", type: "Market", quantity: 50, filledQuantity: 50, averageFillPrice: 100.01, status: "Filled", timestamp: new Date().toISOString(), assetType: "EQUITY" } }];
    await submit();
    assert(text().includes("Schwab filled 50 shares of SPY at $100.01.") && !text().includes("order status is updating"), "A confirmed fill still looks like an order in progress");
    passed.push("Confirmed fills report completion immediately");
    await reset();
    placements = [result("rejected", riskError), result("confirmed")];
    await submit();
    assert(text().includes("Reduce shares to stay within risk?") && text().includes("50 → 47"), "Risk rejection did not open reduced-share review");
    assert(placed.length === 1 && accepted.length === 0, "Resubmitted without consent");
    await act(async () => { const submitButton = button(/^Submit 47 shares/); submitButton.click(); submitButton.click(); });
    assert(placed.length === 2 && placed[1].draft.quantity === 47, "Consent did not submit proposed shares");
    assert(placed[1].draft.stopLoss === 98 && placed[1].draft.takeProfit === 103, "Consent changed reviewed exits");
    assert(placed[0].id !== placed[1].id && accepted.length === 1, "Reduced retry did not use a new mutation ID");
    passed.push("Risk rejection proposes 47 shares; explicit approval sends exactly one reduced order");

    await reset(); placements = [result("rejected", riskError)];
    await submit(); await click(/^Cancel$/);
    assert(placed.length === 1 && !document.querySelector('[role="dialog"]'), "Cancel placed an order or kept the modal open");
    await act(async () => { await control.refresh(true); });
    assert(Boolean(document.querySelector('[role="alert"]')?.textContent?.includes("Order not submitted")), "Refresh erased order rejection");
    passed.push("Cancel sends nothing; rejection remains visible after account refresh");

    await reset(); placements = [result("rejected", riskError), result("rejected", riskError), result("confirmed")];
    await submit(); ask = 100.3; await click(/^Submit 47 shares/);
    assert(placed.length === 2 && text().includes("47 → 43"), "Further price movement did not ask again");
    await click(/^Submit 43 shares/);
    assert(placed.length === 3 && placed[2].draft.quantity === 43, "Second consent did not use the new proposal");
    passed.push("Further price movement asks again before another reduction");

    await reset(); placements = [result("rejected", riskError)];
    await submit(); blocked = "Long entry blocked by the updated entry rules";
    await click(/^Submit 47 shares/);
    assert(placed.length === 1 && text().includes(blocked), "Reduced order bypassed updated entry rules");
    passed.push("Reduced confirmation rechecks entry rules");

    await reset(); placements = [result("unknown", riskError)];
    await submit();
    assert(placed.length === 1 && !document.querySelector('[role="dialog"]'), "Unknown write incorrectly offered a retry");
    passed.push("Ambiguous outcomes never offer a reduced retry");

    await reset(); placements = [result("rejected", "Insufficient buying power")];
    await submit();
    assert(!document.querySelector('[role="dialog"]') && text().includes("Insufficient buying power"), "Ordinary rejection did not persist");
    passed.push("Ordinary broker rejections stay visible");

    await reset(true);
    preview = async () => { throw new Error(riskError); };
    await submit();
    assert(placed.length === 0 && text().includes("50 → 47"), "Preview risk rejection did not offer a safe reduction");
    placements = [result("confirmed")]; await click(/^Submit 47 shares/);
    assert(placed.length === 1 && placed[0].draft.quantity === 47, "Preview reduction acceptance failed");
    passed.push("Preview preflight rejection offers reduction before any placement");

    await reset(true); placements = [result("rejected", riskError)];
    await submit(); await click(/^Confirm SCHWAB LIVE$/);
    assert(placed.length === 1 && text().includes("50 → 47"), "Post-review budget rejection failed to offer reduction");
    passed.push("Price movement after the standard review opens the reduction modal");

    await reset(true);
    let resolvePreview!: (value: OrderPreview) => void;
    preview = () => new Promise(resolve => { resolvePreview = resolve; });
    let submitting!: Promise<void>;
    await act(async () => { submitting = control.submit(draft, "fixture-tab", "SPY"); });
    assert(text().includes("Checking preview") && Boolean(document.querySelector('[role="dialog"]')), "Pending preview has no immediate progress");
    assert(button(/Checking preview/).disabled && placed.length === 0, "Placement enabled before preview completion");
    await click(/^Back$/);
    await act(async () => { resolvePreview({ valid: true, summary: "Ready", errors: [] }); await submitting; });
    assert(!document.querySelector('[role="dialog"]') && placed.length === 0, "Late preview reopened a canceled review");
    passed.push("Preview opens immediately; Back prevents a late response reopening it");

    await reset(true); preview = async () => { throw new Error("Fixture network failure"); };
    await submit();
    assert(text().includes("Schwab preview failed") && button(/^Confirm SCHWAB LIVE$/).disabled, "Preview failure is silent or allows submission");
    passed.push("Preview failures remain visible and block confirmation");

    await reset(); placements = [result("rejected", riskError)]; ask = 200;
    await submit();
    assert(text().includes("outside the stop/target range") && button(/^Submit reduced shares/).disabled, "Invalid exits allowed a reduced retry");
    passed.push("Unusable proposals show an error and block submission");
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
    return passed;
  },
});
