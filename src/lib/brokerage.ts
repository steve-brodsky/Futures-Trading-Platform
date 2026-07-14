import type { OrderUpdate, Position, StreamConnectionState } from "../types";

export interface BrokerageStreamStates {
  positions: StreamConnectionState;
  orders: StreamConnectionState;
}

export function isNewOpenPosition(current: Position[], position: Position): boolean {
  return position.quantity !== 0 && !current.some((item) => item.id === position.id);
}

export function orderFillNeedsPositionReconciliation(order: OrderUpdate): boolean {
  return order.status === "Filled";
}

export function isCompletedCloseFill(order: OrderUpdate): boolean {
  if (order.status !== "Filled" || order.openOrClose?.toUpperCase() !== "CLOSE") return false;
  const rawStatus = order.rawStatus?.toUpperCase();
  return rawStatus === "FLL" || rawStatus === "FILLED"
    || order.remainingQuantity === 0
    || order.filledQuantity != null && order.filledQuantity >= order.quantity;
}

export function upsertStreamPosition(current: Position[], position: Position): Position[] {
  if (position.quantity === 0) return current.filter((item) => item.id !== position.id);
  const index = current.findIndex((item) => item.id === position.id);
  if (index < 0) return [position, ...current];
  const next = [...current];
  next[index] = position;
  return next;
}

export function upsertStreamOrder(current: OrderUpdate[], order: OrderUpdate): OrderUpdate[] {
  const index = current.findIndex((item) => item.id === order.id);
  if (index < 0) return [order, ...current];
  const next = [...current];
  const existing = next[index];
  const statusRank = (status: OrderUpdate["status"]) => status === "Pending" || status === "Indeterminate" ? 0
    : status === "Working" ? 1 : 2;
  // The execution stream can beat the POST response back to the UI. Never let
  // that later Pending acknowledgement downgrade a Working or terminal record.
  // A locally acknowledged market conversion is different: it must replace
  // the old protective price/type immediately while the stream confirms it.
  const marketConversionPending = order.rawStatus === "ReplacePending" && order.type === "Market";
  const merged = !marketConversionPending && statusRank(order.status) < statusRank(existing.status)
    ? { ...order, ...existing }
    : { ...existing, ...order };
  // Preserve bracket prices returned by the placement response. TradeStation's
  // later parent-order stream record does not repeat those draft-only fields.
  next[index] = {
    ...merged,
    takeProfit: order.takeProfit ?? existing.takeProfit,
    stopLoss: order.stopLoss ?? existing.stopLoss,
  };
  return next;
}

export function reconcilePositionSnapshot(current: Position[], incoming: Position[], protectedIds: ReadonlySet<string> = new Set()): Position[] {
  const byId = new Map(incoming.map((position) => [position.id, position]));
  current.forEach((position) => {
    if (protectedIds.has(position.id)) byId.set(position.id, position);
  });
  return [...byId.values()];
}

export function reconcileOrderSnapshot(current: OrderUpdate[], incoming: OrderUpdate[], protectedIds: ReadonlySet<string> = new Set()): OrderUpdate[] {
  let next = incoming;
  current.forEach((order) => {
    if (protectedIds.has(order.id)) next = upsertStreamOrder(next, order);
  });
  return next;
}

export function brokerageStreamsHealthy(states: BrokerageStreamStates): boolean {
  return states.positions === "streaming" && states.orders === "streaming";
}

export function brokeragePollInterval(states: BrokerageStreamStates): number {
  return brokerageStreamsHealthy(states) ? 30_000 : 5_000;
}

export function brokerageDisplayState(states: BrokerageStreamStates): StreamConnectionState {
  if (states.positions === "rate-limited" || states.orders === "rate-limited") return "rate-limited";
  if (brokerageStreamsHealthy(states)) return "streaming";
  if (states.positions === "connecting" || states.orders === "connecting") return "connecting";
  if (states.positions === "reconnecting" || states.orders === "reconnecting") return "reconnecting";
  return "disconnected";
}

export function isManagedThrottle(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("temporarily paused") || message.includes("rate limit") || message.includes("too many requests");
}
