import type {
  AlertDurationSeconds,
  AlertSound,
  Drawing,
  DrawingAlertConfig,
  DrawingAlertDirection,
  DrawingPatch,
  LineDrawing,
  MarketDataProvider,
  Quote,
  WorkspaceState,
} from "../types";
import { ALERT_DURATIONS, ALERT_SOUNDS } from "./emaAlerts";
import { instrumentKey } from "./watchlist";

const alertSounds = new Set<AlertSound>(ALERT_SOUNDS.map((item) => item.value));
const alertDurations = new Set<AlertDurationSeconds>(ALERT_DURATIONS);
const alertDirections = new Set<DrawingAlertDirection>(["either", "above", "below"]);

export interface ActiveDrawingAlert {
  workspaceSymbol: string;
  drawing: LineDrawing;
  alert: DrawingAlertConfig;
}

export type DrawingAlertSide = "above" | "below";

export interface DrawingAlertTrackerEntry {
  fingerprint: string;
  side?: DrawingAlertSide;
}

export type DrawingAlertTrackerState = Map<string, DrawingAlertTrackerEntry>;

export interface DrawingAlertTransition extends ActiveDrawingAlert {
  price: number;
  direction: Exclude<DrawingAlertDirection, "either">;
}

export function defaultDrawingAlert(provider: MarketDataProvider, symbol: string): DrawingAlertConfig {
  return {
    enabled: true,
    direction: "either",
    frequency: "once",
    sound: "chime",
    durationSeconds: 3,
    provider,
    symbol: symbol.trim().toUpperCase(),
  };
}

export function normalizeDrawingAlert(value: unknown): DrawingAlertConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const saved = value as Partial<DrawingAlertConfig>;
  const symbol = typeof saved.symbol === "string" ? saved.symbol.trim().toUpperCase() : "";
  if (!symbol || saved.provider !== "tradestation" && saved.provider !== "schwab") return undefined;
  return {
    enabled: saved.enabled === true,
    direction: alertDirections.has(saved.direction as DrawingAlertDirection) ? saved.direction as DrawingAlertDirection : "either",
    frequency: saved.frequency === "recurring" ? "recurring" : "once",
    sound: alertSounds.has(saved.sound as AlertSound) ? saved.sound as AlertSound : "chime",
    durationSeconds: alertDurations.has(saved.durationSeconds as AlertDurationSeconds) ? saved.durationSeconds as AlertDurationSeconds : 3,
    provider: saved.provider,
    symbol,
    lastTriggeredAt: typeof saved.lastTriggeredAt === "string" && !Number.isNaN(Date.parse(saved.lastTriggeredAt))
      ? saved.lastTriggeredAt
      : undefined,
  };
}

export function sameDrawingAlert(left?: DrawingAlertConfig, right?: DrawingAlertConfig): boolean {
  return left === right || Boolean(left && right
    && left.enabled === right.enabled
    && left.direction === right.direction
    && left.frequency === right.frequency
    && left.sound === right.sound
    && left.durationSeconds === right.durationSeconds
    && left.provider === right.provider
    && left.symbol === right.symbol
    && left.lastTriggeredAt === right.lastTriggeredAt);
}

function isAlertableDrawing(drawing: Drawing): drawing is LineDrawing {
  return drawing.kind === "horizontal" || drawing.kind === "horizontal-ray";
}

export function activeDrawingAlerts(drawings: WorkspaceState["drawings"]): ActiveDrawingAlert[] {
  return Object.entries(drawings).flatMap(([workspaceSymbol, items]) => items.flatMap((drawing) => (
    isAlertableDrawing(drawing) && drawing.alert?.enabled
      ? [{ workspaceSymbol, drawing, alert: drawing.alert }]
      : []
  ))).sort((left, right) => left.workspaceSymbol.localeCompare(right.workspaceSymbol)
    || left.drawing.points[0].price - right.drawing.points[0].price
    || left.drawing.id.localeCompare(right.drawing.id));
}

export function drawingAlertKey(item: Pick<ActiveDrawingAlert, "workspaceSymbol" | "drawing">): string {
  return `${item.workspaceSymbol}\u0000${item.drawing.id}`;
}

function alertFingerprint(item: ActiveDrawingAlert, epoch: string): string {
  return [
    epoch,
    item.alert.provider,
    item.alert.symbol,
    item.drawing.points[0].price,
    item.alert.direction,
    item.alert.frequency,
  ].join("\u0000");
}

export function drawingAlertSide(price: number, level: number, previous?: DrawingAlertSide): DrawingAlertSide | undefined {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(level)) return previous;
  const difference = price - level;
  const tolerance = Math.max(1, Math.abs(price), Math.abs(level)) * 1e-10;
  return difference > tolerance ? "above" : difference < -tolerance ? "below" : previous;
}

export function trackDrawingAlertTransitions(
  previous: DrawingAlertTrackerState | undefined,
  drawings: WorkspaceState["drawings"],
  quotes: Record<string, Quote>,
  epoch = "",
): { state: DrawingAlertTrackerState; transitions: DrawingAlertTransition[] } {
  const prior = previous ?? new Map<string, DrawingAlertTrackerEntry>();
  const state = new Map<string, DrawingAlertTrackerEntry>();
  const transitions: DrawingAlertTransition[] = [];

  activeDrawingAlerts(drawings).forEach((item) => {
    const key = drawingAlertKey(item);
    const fingerprint = alertFingerprint(item, epoch);
    const quote = quotes[instrumentKey(item.alert)];
    const old = prior.get(key);
    const oldSide = old?.fingerprint === fingerprint ? old.side : undefined;
    const side = quote ? drawingAlertSide(quote.last, item.drawing.points[0].price, oldSide) : oldSide;
    state.set(key, { fingerprint, side });
    if (!quote || !oldSide || !side || oldSide === side) return;
    if (item.alert.direction !== "either" && item.alert.direction !== side) return;
    transitions.push({ ...item, price: quote.last, direction: side });
  });

  return { state, transitions };
}

export function drawingAlertQuoteInstruments(drawings: WorkspaceState["drawings"]): Array<{ provider: MarketDataProvider; symbol: string }> {
  const instruments = new Map<string, { provider: MarketDataProvider; symbol: string }>();
  activeDrawingAlerts(drawings).forEach(({ alert }) => {
    instruments.set(instrumentKey(alert), { provider: alert.provider, symbol: alert.symbol });
  });
  return [...instruments.values()].sort((left, right) => instrumentKey(left).localeCompare(instrumentKey(right)));
}

export function applyDrawingPatch(drawing: Drawing, patch: DrawingPatch): Drawing {
  if (drawing.kind === "position") return { ...drawing, ...patch } as Drawing;
  const { alert, ...rest } = patch;
  const next: LineDrawing = { ...drawing, ...rest };
  if ("alert" in patch) {
    if (alert) next.alert = alert;
    else delete next.alert;
  }
  return next;
}
