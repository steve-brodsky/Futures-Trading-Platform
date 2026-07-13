import type { OrderDraft, OrderUpdate, Position } from "../types";
import { roundToTick } from "./indicators";

export type TradeLineKind = "position" | "take-profit" | "stop-loss" | "order";

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
  return order.openOrClose === "Close" && (
    order.groupName?.toUpperCase().startsWith("OCO") === true
    || order.relatedOrders?.some((related) => related.relationship.toUpperCase() === "OCO") === true
  );
}

export function buildTradeLines(symbol: string, positions: Position[], orders: OrderUpdate[]): TradeLineModel[] {
  const positionLines = positions
    .filter((position) => position.symbol === symbol && position.quantity > 0)
    .map((position): TradeLineModel => ({
      id: `position:${position.id}`,
      kind: "position",
      price: position.averagePrice,
      color: "#37d5e8",
      side: position.side,
      quantity: position.quantity,
      draggable: false,
      position,
    }));
  const orderLines = orders.flatMap((order): TradeLineModel[] => {
    if (order.symbol !== symbol || order.status !== "Working") return [];
    const price = order.price ?? order.stopPrice;
    if (price == null || price <= 0) return [];
    const bracket = isBracketExit(order);
    const kind: TradeLineKind = bracket && order.type === "Limit"
      ? "take-profit"
      : bracket && order.type === "StopMarket"
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

export function flattenOrderDraft(accountId: string, position: Position): OrderDraft {
  return {
    accountId,
    symbol: position.symbol,
    side: position.side === "Long" ? "Sell" : "Buy",
    type: "Market",
    quantity: position.quantity,
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
