import type { OrderDraft, OrderUpdate, Position } from "../types";
import { roundToTick } from "./indicators";

export type TradeLineKind = "position" | "take-profit" | "stop-loss" | "projected-take-profit" | "projected-stop-loss" | "order";

export interface OrderProjection {
  takeProfit?: number;
  stopLoss?: number;
}

export interface TradeLineModel {
  id: string;
  kind: TradeLineKind;
  price: number;
  color: string;
  side: string;
  quantity: number;
  draggable: boolean;
  order?: OrderUpdate;
  position?: Position;
}

export function isBracketExit(order: OrderUpdate): boolean {
  const groupName = order.groupName?.toUpperCase() ?? "";
  return order.openOrClose?.toUpperCase() === "CLOSE" && (
    groupName.startsWith("OCO") || groupName.startsWith("BRK")
    || order.relatedOrders?.some((related) => ["OCO", "BRK", "BRACKET"].includes(related.relationship.toUpperCase())) === true
  );
}

export function isPositionExit(order: OrderUpdate, positions: Position[]): boolean {
  if (!matchesProtectiveType(order)) return false;
  const position = positions.find((item) => item.symbol === order.symbol && Math.abs(item.quantity) > 0);
  if (!position) return false;
  const closingSide = position.side === "Long" ? "SELL" : "BUY";
  return order.side.toUpperCase() === closingSide;
}

function matchesProtectiveType(order: OrderUpdate): boolean {
  return order.type === "Limit" || order.type === "StopMarket";
}

export function buildTradeLines(tradeSymbol: string | undefined, positions: Position[], orders: OrderUpdate[]): TradeLineModel[] {
  if (!tradeSymbol) return [];
  const positionLines = positions
    .filter((position) => position.symbol === tradeSymbol && Math.abs(position.quantity) > 0)
    .map((position): TradeLineModel => ({
      id: `position:${position.id}`,
      kind: "position",
      price: position.averagePrice,
      color: position.side === "Long" ? "#16c79a" : "#ef466f",
      side: position.side,
      quantity: Math.abs(position.quantity),
      draggable: false,
      position,
    }));
  const orderLines = orders.flatMap((order): TradeLineModel[] => {
    if (order.symbol !== tradeSymbol || order.status !== "Working") return [];
    const price = order.price ?? order.stopPrice;
    if (price == null || price <= 0) return [];
    const protective = isBracketExit(order) || isPositionExit(order, positions);
    const kind: TradeLineKind = protective && order.type === "Limit"
      ? "take-profit"
      : protective && order.type === "StopMarket"
        ? "stop-loss"
        : "order";
    return [{
      id: `order:${order.id}`,
      kind,
      price,
      color: kind === "take-profit" ? "#16c79a" : kind === "stop-loss" ? "#ef466f" : "#f0b84b",
      side: order.side,
      quantity: order.remainingQuantity ?? order.quantity,
      draggable: kind === "take-profit" || kind === "stop-loss",
      order,
    }];
  });
  return [...positionLines, ...orderLines];
}

export function buildProjectedTradeLines(projection?: OrderProjection): TradeLineModel[] {
  if (!projection) return [];
  const lines: TradeLineModel[] = [];
  if (projection.takeProfit != null && Number.isFinite(projection.takeProfit) && projection.takeProfit > 0) {
    lines.push({ id: "projection:take-profit", kind: "projected-take-profit", price: projection.takeProfit, color: "#16c79a", side: "", quantity: 0, draggable: true });
  }
  if (projection.stopLoss != null && Number.isFinite(projection.stopLoss) && projection.stopLoss > 0) {
    lines.push({ id: "projection:stop-loss", kind: "projected-stop-loss", price: projection.stopLoss, color: "#ef466f", side: "", quantity: 0, draggable: true });
  }
  return lines;
}

export function flattenOrderDraft(accountId: string, position: Position): OrderDraft {
  return {
    accountId,
    symbol: position.symbol,
    side: position.side === "Long" ? "Sell" : "Buy",
    type: "Market",
    quantity: Math.abs(position.quantity),
    duration: "DAY",
  };
}

export function snapTradeLinePrice(price: number, minMove: number): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(minMove) || minMove <= 0) return null;
  const snapped = roundToTick(price, minMove);
  return snapped > 0 ? snapped : null;
}

export function tradeLinePriceChanged(originalPrice: number, nextPrice: number, minMove: number): boolean {
  return Math.abs(nextPrice - originalPrice) >= minMove / 2;
}

export function withOrderPrice(order: OrderUpdate, price: number | undefined): OrderUpdate {
  return order.type === "Limit" ? { ...order, price } : { ...order, stopPrice: price };
}
