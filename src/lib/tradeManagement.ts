import type { AutoBreakEvenRule, AutoTrailStopRule, Bar, JournalRiskBaseline, OrderUpdate, Position, TradingEnvironment } from "../types";
import { calculateTakeProfitAtR } from "./indicators";
import { latestConfirmedSwing, offsetBeyondSwing } from "./swingStop";
import { isBracketExit, isPositionExit, snapTradeLinePrice, tradeLinePriceChanged } from "./tradeLines";

export interface ManagedProtectiveOrders {
  stops: OrderUpdate[];
  targets: OrderUpdate[];
}

export interface AutoBreakEvenEvaluation {
  state: "waiting" | "paused" | "trigger" | "complete";
  reason: string;
  currentR: number | null;
  breakEven: number | null;
  stop?: OrderUpdate;
}

export interface AutoTrailStopEvaluation {
  state: "waiting" | "paused" | "trigger";
  reason: string;
  candidatePrice: number | null;
  swingPrice: number | null;
  stop?: OrderUpdate;
}

export function isMoreProtectiveStop(side: Position["side"], candidate: number, reference: number, tolerance = 0): boolean {
  return side === "Long" ? candidate > reference + tolerance : candidate < reference - tolerance;
}

export function mostProtectiveStop(side: Position["side"], left: number, right: number): number {
  return side === "Long" ? Math.max(left, right) : Math.min(left, right);
}

export function autoBreakEvenRuleKey(environment: TradingEnvironment, accountId: string, positionId: string): string {
  return `${environment}:${accountId}:${positionId}`;
}

export function autoTrailStopRuleKey(environment: TradingEnvironment, accountId: string, positionId: string): string {
  return `${environment}:${accountId}:${positionId}`;
}

export function normalizeAutoTrailStopRules(value: unknown): Record<string, AutoTrailStopRule> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const rule = candidate as Partial<AutoTrailStopRule>;
    if ((rule.environment !== "live" && rule.environment !== "sim")
      || typeof rule.accountId !== "string" || !rule.accountId.trim()
      || typeof rule.positionId !== "string" || !rule.positionId.trim()
      || typeof rule.symbol !== "string" || !rule.symbol.trim()
      || !["armed", "triggering", "attention"].includes(rule.status ?? "")
      || typeof rule.clientMutationId !== "string" || !rule.clientMutationId.trim()
      || (rule.lastAppliedPrice != null && (!Number.isFinite(rule.lastAppliedPrice) || rule.lastAppliedPrice <= 0))) return [];
    const normalizedKey = autoTrailStopRuleKey(rule.environment, rule.accountId, rule.positionId);
    if (key !== normalizedKey) return [];
    return [[normalizedKey, {
      environment: rule.environment,
      accountId: rule.accountId,
      positionId: rule.positionId,
      symbol: rule.symbol.trim().toUpperCase(),
      status: rule.status as AutoTrailStopRule["status"],
      clientMutationId: rule.clientMutationId,
      ...(rule.lastAppliedPrice != null ? { lastAppliedPrice: rule.lastAppliedPrice } : {}),
      ...(typeof rule.message === "string" && rule.message.trim() ? { message: rule.message.trim() } : {}),
    } satisfies AutoTrailStopRule]];
  }));
}

export function normalizeAutoBreakEvenRules(value: unknown): Record<string, AutoBreakEvenRule> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const rule = candidate as Partial<AutoBreakEvenRule>;
    if ((rule.environment !== "live" && rule.environment !== "sim")
      || typeof rule.accountId !== "string" || !rule.accountId.trim()
      || typeof rule.positionId !== "string" || !rule.positionId.trim()
      || typeof rule.symbol !== "string" || !rule.symbol.trim()
      || typeof rule.thresholdR !== "number" || !Number.isFinite(rule.thresholdR) || rule.thresholdR <= 0
      || !["armed", "triggering", "attention"].includes(rule.status ?? "")
      || typeof rule.clientMutationId !== "string" || !rule.clientMutationId.trim()) return [];
    const normalizedKey = autoBreakEvenRuleKey(rule.environment, rule.accountId, rule.positionId);
    if (key !== normalizedKey) return [];
    return [[normalizedKey, {
      environment: rule.environment,
      accountId: rule.accountId,
      positionId: rule.positionId,
      symbol: rule.symbol.trim().toUpperCase(),
      thresholdR: rule.thresholdR,
      status: rule.status as AutoBreakEvenRule["status"],
      clientMutationId: rule.clientMutationId,
      ...(typeof rule.message === "string" && rule.message.trim() ? { message: rule.message.trim() } : {}),
    } satisfies AutoBreakEvenRule]];
  }));
}

export function findManagedPosition(
  tradeSymbol: string | undefined,
  accountId: string | undefined,
  positions: Position[],
): Position | undefined {
  if (!tradeSymbol || !accountId) return undefined;
  const symbol = tradeSymbol.trim().toUpperCase();
  return positions.find((position) => (
    (position.provider ?? "tradestation") === "tradestation"
    && (!position.accountId || position.accountId === accountId)
    && position.symbol.trim().toUpperCase() === symbol
    && Math.abs(position.quantity) > 0
  ));
}

export function managedProtectiveOrders(
  position: Position | undefined,
  accountId: string | undefined,
  orders: OrderUpdate[],
): ManagedProtectiveOrders {
  if (!position || !accountId) return { stops: [], targets: [] };
  const matching = orders.filter((order) => (
    order.status === "Working"
    && (!order.accountId || order.accountId === accountId)
    && order.symbol.trim().toUpperCase() === position.symbol.trim().toUpperCase()
    && (isBracketExit(order) || isPositionExit(order, [position]))
  ));
  return {
    stops: matching.filter((order) => order.type === "StopMarket"),
    targets: matching.filter((order) => order.type === "Limit"),
  };
}

export function originalRiskBaseline(
  position: Position | undefined,
  baselines: JournalRiskBaseline[],
): JournalRiskBaseline | undefined {
  if (!position) return undefined;
  return baselines.find((baseline) => (
    baseline.symbol.trim().toUpperCase() === position.symbol.trim().toUpperCase()
    && baseline.direction === position.side
    && baseline.riskProvenance !== "unknown"
    && baseline.originalStop != null
    && Number.isFinite(baseline.originalStop)
    && baseline.originalStop > 0
  ));
}

export function breakEvenPrice(position: Position | undefined, minMove: number): number | null {
  return position ? snapTradeLinePrice(position.averagePrice, minMove) : null;
}

export function stopIsAtBreakEven(order: OrderUpdate | undefined, breakEven: number | null, minMove: number): boolean {
  if (!order || breakEven == null) return false;
  const price = order.stopPrice ?? order.price;
  return price != null && !tradeLinePriceChanged(price, breakEven, minMove);
}

export function stopProtectsBreakEven(position: Position | undefined, order: OrderUpdate | undefined, breakEven: number | null, minMove: number): boolean {
  if (!position || !order || breakEven == null || !Number.isFinite(minMove) || minMove <= 0) return false;
  const price = order.stopPrice ?? order.price;
  if (price == null || !Number.isFinite(price)) return false;
  const tolerance = minMove / 2;
  return position.side === "Long" ? price >= breakEven - tolerance : price <= breakEven + tolerance;
}

export function takeProfitAtOriginalR(
  position: Position | undefined,
  baseline: JournalRiskBaseline | undefined,
  rMultiple: number,
  minMove: number,
): number | null {
  if (!position || baseline?.originalStop == null) return null;
  return calculateTakeProfitAtR(
    position.averagePrice,
    baseline.originalStop,
    position.side === "Long" ? "Buy" : "Sell",
    rMultiple,
    minMove,
  );
}

export function currentRMultiple(position: Position | undefined, baseline: JournalRiskBaseline | undefined): number | null {
  if (!position || baseline?.deployedRisk == null || !Number.isFinite(baseline.deployedRisk) || baseline.deployedRisk <= 0) return null;
  return position.unrealizedPnl / baseline.deployedRisk;
}

export function evaluateAutoBreakEven(args: {
  position?: Position;
  accountId?: string;
  orders: OrderUpdate[];
  baseline?: JournalRiskBaseline;
  minMove?: number;
  thresholdR: number;
  brokerageReady: boolean;
}): AutoBreakEvenEvaluation {
  const currentR = currentRMultiple(args.position, args.baseline);
  const minMove = args.minMove ?? 0;
  const breakEven = breakEvenPrice(args.position, minMove);
  if (!args.position) return { state: "paused", reason: "Waiting for the open position.", currentR, breakEven };
  if (!args.baseline || currentR == null) return { state: "paused", reason: "Original risk is unavailable.", currentR, breakEven };
  if (!Number.isFinite(minMove) || minMove <= 0 || breakEven == null) return { state: "paused", reason: "Contract details are unavailable.", currentR, breakEven };
  if (!args.brokerageReady) return { state: "paused", reason: "Waiting for current brokerage data.", currentR, breakEven };
  const protective = managedProtectiveOrders(args.position, args.accountId, args.orders);
  if (protective.stops.length === 0) return { state: "paused", reason: "No working protective stop is available.", currentR, breakEven };
  if (protective.stops.length > 1) return { state: "paused", reason: "Multiple protective stops require manual management.", currentR, breakEven };
  const stop = protective.stops[0];
  if (stopProtectsBreakEven(args.position, stop, breakEven, minMove)) {
    return { state: "complete", reason: "The stop already protects break-even.", currentR, breakEven, stop };
  }
  if (!Number.isFinite(args.thresholdR) || args.thresholdR <= 0) return { state: "paused", reason: "Enter a positive R threshold.", currentR, breakEven, stop };
  return currentR >= args.thresholdR
    ? { state: "trigger", reason: `Threshold reached at ${currentR.toFixed(2)}R.`, currentR, breakEven, stop }
    : { state: "waiting", reason: `Waiting for +${args.thresholdR.toFixed(2)}R.`, currentR, breakEven, stop };
}

export function evaluateAutoTrailStop(args: {
  position?: Position;
  accountId?: string;
  orders: OrderUpdate[];
  bars: Bar[];
  minMove?: number;
  pivotBars: number;
  offsetTicks: number;
  marketPrice?: number;
  brokerageReady: boolean;
}): AutoTrailStopEvaluation {
  const minMove = args.minMove ?? 0;
  if (!args.position) return { state: "paused", reason: "Waiting for the open position.", candidatePrice: null, swingPrice: null };
  if (!Number.isFinite(minMove) || minMove <= 0) return { state: "paused", reason: "Contract details are unavailable.", candidatePrice: null, swingPrice: null };
  if (!args.brokerageReady) return { state: "paused", reason: "Waiting for current brokerage data.", candidatePrice: null, swingPrice: null };
  const protective = managedProtectiveOrders(args.position, args.accountId, args.orders);
  if (protective.stops.length === 0) return { state: "paused", reason: "No working protective stop is available.", candidatePrice: null, swingPrice: null };
  if (protective.stops.length > 1) return { state: "paused", reason: "Multiple protective stops require manual management.", candidatePrice: null, swingPrice: null };
  const stop = protective.stops[0];
  const side = args.position.side === "Long" ? "Buy" : "Sell";
  const swing = latestConfirmedSwing(args.bars, side, args.pivotBars);
  if (!swing) return { state: "waiting", reason: `No confirmed ${args.pivotBars}/side swing is available.`, candidatePrice: null, swingPrice: null, stop };
  const candidatePrice = offsetBeyondSwing(swing.price, side, minMove, args.offsetTicks);
  if (candidatePrice == null) return { state: "paused", reason: "The swing stop price is invalid.", candidatePrice: null, swingPrice: swing.price, stop };
  const currentStop = stop.stopPrice ?? stop.price;
  if (currentStop == null || !Number.isFinite(currentStop)) return { state: "paused", reason: "The current stop price is unavailable.", candidatePrice, swingPrice: swing.price, stop };
  const tolerance = minMove / 2;
  const improves = isMoreProtectiveStop(args.position.side, candidatePrice, currentStop, tolerance);
  if (!improves) return { state: "waiting", reason: "The latest swing does not tighten the current stop.", candidatePrice, swingPrice: swing.price, stop };
  const marketPrice = args.marketPrice;
  if (marketPrice != null && Number.isFinite(marketPrice) && marketPrice > 0) {
    const validSide = args.position.side === "Long" ? candidatePrice < marketPrice - tolerance : candidatePrice > marketPrice + tolerance;
    if (!validSide) return { state: "waiting", reason: "The latest swing is no longer on the protective side of the market.", candidatePrice, swingPrice: swing.price, stop };
  }
  return { state: "trigger", reason: `Move the stop beyond the latest swing at ${swing.price}.`, candidatePrice, swingPrice: swing.price, stop };
}

export function removeClosedAutoBreakEvenRules(
  rules: Record<string, AutoBreakEvenRule>,
  environment: TradingEnvironment,
  accountId: string,
  positions: Position[],
): Record<string, AutoBreakEvenRule> {
  const openIds = new Set(positions.filter((position) => Math.abs(position.quantity) > 0).map((position) => position.id));
  const next = Object.fromEntries(Object.entries(rules).filter(([, rule]) => (
    rule.environment !== environment || rule.accountId !== accountId || openIds.has(rule.positionId)
  )));
  return Object.keys(next).length === Object.keys(rules).length ? rules : next;
}

export function removeClosedAutoTrailStopRules(
  rules: Record<string, AutoTrailStopRule>,
  environment: TradingEnvironment,
  accountId: string,
  positions: Position[],
): Record<string, AutoTrailStopRule> {
  const openIds = new Set(positions.filter((position) => Math.abs(position.quantity) > 0).map((position) => position.id));
  const next = Object.fromEntries(Object.entries(rules).filter(([, rule]) => (
    rule.environment !== environment || rule.accountId !== accountId || openIds.has(rule.positionId)
  )));
  return Object.keys(next).length === Object.keys(rules).length ? rules : next;
}
