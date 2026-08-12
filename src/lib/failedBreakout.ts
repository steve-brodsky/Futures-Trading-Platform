import type { Bar, FailedBreakoutIndicatorConfig, FailedBreakoutPairMode } from "../types";

export type FailedBreakoutSide = "long" | "short";

export interface FailedBreakoutSwing {
  time: number;
  price: number;
}

export interface FailedBreakoutSignal {
  id: string;
  side: FailedBreakoutSide;
  /** Alias of entryTime for direct chart-marker mapping. */
  time: number;
  entryTime: number;
  breakTime: number;
  swings: readonly [FailedBreakoutSwing, FailedBreakoutSwing];
}

interface DetectorSettings {
  pivotBars: 1 | 2 | 3;
  toleranceTicks: number;
  reclaimBars: number;
  pairMode: FailedBreakoutPairMode;
}

interface SwingPair {
  first: FailedBreakoutSwing;
  second: FailedBreakoutSwing;
}

interface ReclaimAttempt {
  pair: SwingPair;
  breakTime: number;
  candlesSeen: number;
}

interface SideState {
  swings: FailedBreakoutSwing[];
  availablePair: SwingPair | null;
  attempt: ReclaimAttempt | null;
}

const clampInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
};

function normalizeSettings(settings: FailedBreakoutIndicatorConfig): DetectorSettings {
  return {
    pivotBars: clampInteger(settings.pivotBars, 2, 1, 3) as 1 | 2 | 3,
    toleranceTicks: clampInteger(settings.toleranceTicks, 4, 0, 100),
    reclaimBars: clampInteger(settings.reclaimBars, 3, 1, 100),
    pairMode: settings.pairMode === "latest-matching" ? "latest-matching" : "consecutive",
  };
}

function matches(first: FailedBreakoutSwing, second: FailedBreakoutSwing, tolerance: number): boolean {
  const scale = Math.max(1, Math.abs(first.price), Math.abs(second.price), Math.abs(tolerance));
  return Math.abs(first.price - second.price) <= tolerance + Number.EPSILON * scale * 8;
}

function isPivot(bars: readonly Bar[], index: number, pivotBars: number, side: FailedBreakoutSide): boolean {
  const price = side === "long" ? bars[index].low : bars[index].high;
  if (!Number.isFinite(price)) return false;

  for (let offset = 1; offset <= pivotBars; offset += 1) {
    const before = side === "long" ? bars[index - offset].low : bars[index - offset].high;
    const after = side === "long" ? bars[index + offset].low : bars[index + offset].high;
    if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
    if (side === "long" ? price >= before || price >= after : price <= before || price <= after) return false;
  }
  return true;
}

function addSwing(
  state: SideState,
  swing: FailedBreakoutSwing,
  pairMode: FailedBreakoutPairMode,
  tolerance: number,
): void {
  if (pairMode === "consecutive") {
    const prior = state.swings.at(-1);
    state.availablePair = prior && matches(prior, swing, tolerance)
      ? { first: prior, second: swing }
      : null;
  } else {
    let prior: FailedBreakoutSwing | undefined;
    for (let index = state.swings.length - 1; index >= 0; index -= 1) {
      if (matches(state.swings[index], swing, tolerance)) {
        prior = state.swings[index];
        break;
      }
    }
    // In latest-matching mode an unmatched pivot does not invalidate the
    // currently available setup.
    if (prior) state.availablePair = { first: prior, second: swing };
  }
  state.swings.push(swing);
}

function pairWasBroken(pair: SwingPair, bar: Bar, side: FailedBreakoutSide): boolean {
  if (side === "long") return Number.isFinite(bar.low) && bar.low < Math.min(pair.first.price, pair.second.price);
  return Number.isFinite(bar.high) && bar.high > Math.max(pair.first.price, pair.second.price);
}

function pairWasReclaimed(pair: SwingPair, bar: Bar, side: FailedBreakoutSide): boolean {
  if (!Number.isFinite(bar.close)) return false;
  if (side === "long") return bar.close > Math.max(pair.first.price, pair.second.price);
  return bar.close < Math.min(pair.first.price, pair.second.price);
}

function signalId(side: FailedBreakoutSide, pair: SwingPair, breakTime: number, entryTime: number): string {
  return `failed-breakout:${side}:${pair.first.time}:${pair.second.time}:${breakTime}:${entryTime}`;
}

function makeSignal(
  side: FailedBreakoutSide,
  pair: SwingPair,
  breakTime: number,
  entryTime: number,
): FailedBreakoutSignal {
  return {
    id: signalId(side, pair, breakTime, entryTime),
    side,
    time: entryTime,
    entryTime,
    breakTime,
    swings: [pair.first, pair.second],
  };
}

function evaluateCandle(
  state: SideState,
  bar: Bar,
  side: FailedBreakoutSide,
  reclaimBars: number,
): FailedBreakoutSignal | null {
  if (state.attempt) {
    const { pair, breakTime } = state.attempt;
    state.attempt.candlesSeen += 1;
    if (pairWasReclaimed(pair, bar, side)) {
      state.attempt = null;
      return makeSignal(side, pair, breakTime, bar.time);
    }
    if (state.attempt.candlesSeen >= reclaimBars) state.attempt = null;
    return null;
  }

  const pair = state.availablePair;
  if (!pair || !pairWasBroken(pair, bar, side)) return null;

  // The exact pair is consumed as soon as an attempt begins. A replacement
  // may form while this attempt is locked, but is evaluated only afterward.
  state.availablePair = null;
  if (pairWasReclaimed(pair, bar, side)) return makeSignal(side, pair, bar.time, bar.time);

  if (reclaimBars > 1) {
    state.attempt = { pair, breakTime: bar.time, candlesSeen: 1 };
  }
  return null;
}

/**
 * Finds completed-candle failed breakouts without look-ahead.
 *
 * The newest bar is excluded only when it is marked realtime. Earlier bars
 * retain eligibility even if the stream also marked them realtime.
 */
export function findFailedBreakouts(
  bars: readonly Bar[],
  minMove: number,
  settings: FailedBreakoutIndicatorConfig,
): FailedBreakoutSignal[] {
  if (!Number.isFinite(minMove) || minMove <= 0) return [];

  const normalized = normalizeSettings(settings);
  const completed = bars.at(-1)?.realtime === true ? bars.slice(0, -1) : bars;
  const tolerance = normalized.toleranceTicks * minMove;
  const longState: SideState = { swings: [], availablePair: null, attempt: null };
  const shortState: SideState = { swings: [], availablePair: null, attempt: null };
  const signals: FailedBreakoutSignal[] = [];

  for (let index = 0; index < completed.length; index += 1) {
    const bar = completed[index];

    // Existing setups are evaluated before a pivot is confirmed by this bar,
    // making the detector causal and preventing right-neighbor look-ahead.
    const longSignal = evaluateCandle(longState, bar, "long", normalized.reclaimBars);
    const shortSignal = evaluateCandle(shortState, bar, "short", normalized.reclaimBars);
    if (longSignal) signals.push(longSignal);
    if (shortSignal) signals.push(shortSignal);

    const pivotIndex = index - normalized.pivotBars;
    if (pivotIndex < normalized.pivotBars) continue;
    const pivot = completed[pivotIndex];

    if (isPivot(completed, pivotIndex, normalized.pivotBars, "long")) {
      addSwing(longState, { time: pivot.time, price: pivot.low }, normalized.pairMode, tolerance);
    }
    if (isPivot(completed, pivotIndex, normalized.pivotBars, "short")) {
      addSwing(shortState, { time: pivot.time, price: pivot.high }, normalized.pairMode, tolerance);
    }
  }

  return signals;
}
