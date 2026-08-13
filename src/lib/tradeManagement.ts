import type { JournalRiskBaseline, OrderUpdate, Position } from "../types";
import { calculateTakeProfitAtR } from "./indicators";
import { isBracketExit, isPositionExit, snapTradeLinePrice, tradeLinePriceChanged } from "./tradeLines";

export interface ManagedProtectiveOrders {
  stops: OrderUpdate[];
  targets: OrderUpdate[];
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
