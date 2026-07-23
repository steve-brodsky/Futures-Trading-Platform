import { describe, expect, it } from "vitest";
import type { DrawingAlertConfig, LineDrawing, Quote, WorkspaceState } from "../types";
import {
  activeDrawingAlerts,
  applyDrawingPatch,
  defaultDrawingAlert,
  drawingAlertQuoteInstruments,
  normalizeDrawingAlert,
  trackDrawingAlertTransitions,
} from "./drawingAlerts";

const quote = (symbol: string, last: number, provider: "tradestation" | "schwab" = "tradestation"): Quote => ({
  provider, symbol, last, bid: last, ask: last, change: 0, changePct: 0, delayed: false, halted: false, timestamp: new Date().toISOString(),
});

const drawing = (id: string, price: number, alert: DrawingAlertConfig = defaultDrawingAlert("tradestation", "MES")): LineDrawing => ({
  id, kind: "horizontal", points: [{ time: 1, price }], color: "#fff", alert,
});

describe("drawing alerts", () => {
  it("normalizes persisted configuration and rejects missing sources", () => {
    expect(normalizeDrawingAlert({ enabled: true, provider: "tradestation", symbol: " mes " })).toEqual({
      enabled: true, direction: "either", frequency: "once", sound: "chime", durationSeconds: 3, provider: "tradestation", symbol: "MES", lastTriggeredAt: undefined,
    });
    expect(normalizeDrawingAlert({ enabled: true, symbol: "MES" })).toBeUndefined();
  });

  it("lists active alerts deterministically and distinguishes duplicate drawing ids by symbol", () => {
    const drawings = {
      NQ: [drawing("same", 200)],
      ES: [drawing("same", 101), drawing("disabled", 99, { ...defaultDrawingAlert("tradestation", "ES"), enabled: false })],
    };
    expect(activeDrawingAlerts(drawings).map((item) => `${item.workspaceSymbol}:${item.drawing.id}`)).toEqual(["ES:same", "NQ:same"]);
  });

  it("primes without firing and detects either-direction crossings through equality", () => {
    const drawings = { MES: [drawing("line", 100)] };
    const primed = trackDrawingAlertTransitions(undefined, drawings, { "tradestation:MES": quote("MES", 99) });
    expect(primed.transitions).toEqual([]);
    const equal = trackDrawingAlertTransitions(primed.state, drawings, { "tradestation:MES": quote("MES", 100) });
    expect(equal.transitions).toEqual([]);
    const crossed = trackDrawingAlertTransitions(equal.state, drawings, { "tradestation:MES": quote("MES", 101) });
    expect(crossed.transitions).toMatchObject([{ workspaceSymbol: "MES", price: 101, direction: "above" }]);
  });

  it("filters upward and downward conditions and re-arms recurring crossings", () => {
    const up = drawing("up", 100, { ...defaultDrawingAlert("tradestation", "MES"), direction: "above", frequency: "recurring" });
    const down = drawing("down", 100, { ...defaultDrawingAlert("tradestation", "MES"), direction: "below", frequency: "recurring" });
    const drawings = { MES: [up, down] };
    const below = trackDrawingAlertTransitions(undefined, drawings, { "tradestation:MES": quote("MES", 99) });
    const above = trackDrawingAlertTransitions(below.state, drawings, { "tradestation:MES": quote("MES", 101) });
    expect(above.transitions.map((item) => item.drawing.id)).toEqual(["up"]);
    const backBelow = trackDrawingAlertTransitions(above.state, drawings, { "tradestation:MES": quote("MES", 99) });
    expect(backBelow.transitions.map((item) => item.drawing.id)).toEqual(["down"]);
  });

  it("resets its baseline after a level, condition, or epoch change", () => {
    const drawings = { MES: [drawing("line", 100)] };
    const below = trackDrawingAlertTransitions(undefined, drawings, { "tradestation:MES": quote("MES", 99) }, "sim");
    const moved = { MES: [{ ...drawings.MES[0], points: [{ time: 2, price: 98 }] }] };
    expect(trackDrawingAlertTransitions(below.state, moved, { "tradestation:MES": quote("MES", 99) }, "sim").transitions).toEqual([]);
    expect(trackDrawingAlertTransitions(below.state, drawings, { "tradestation:MES": quote("MES", 101) }, "live").transitions).toEqual([]);
  });

  it("drops disabled one-time alerts from tracking and supports removing alert metadata", () => {
    const active = drawing("line", 100);
    const disabled = { ...active, alert: { ...active.alert!, enabled: false } };
    expect(trackDrawingAlertTransitions(undefined, { MES: [disabled] }, { "tradestation:MES": quote("MES", 99) }).state.size).toBe(0);
    expect(applyDrawingPatch(active, { alert: null })).not.toHaveProperty("alert");
  });

  it("deduplicates enabled quote requirements across drawings", () => {
    const drawings: WorkspaceState["drawings"] = {
      MES: [drawing("one", 100), drawing("two", 101)],
      SPY: [drawing("spy", 500, defaultDrawingAlert("schwab", "SPY"))],
    };
    expect(drawingAlertQuoteInstruments(drawings)).toEqual([
      { provider: "schwab", symbol: "SPY" },
      { provider: "tradestation", symbol: "MES" },
    ]);
  });
});
