import type { ChartLabelSettings, OrderDraft, OrderUpdate, Position } from "../types";
import { calculateTakeProfitAtR, roundToTick } from "./indicators";

export type TradeLineKind = "position" | "take-profit" | "stop-loss" | "projected-take-profit" | "projected-stop-loss" | "order";
export const orderRMultiples = [1, 1.5, 2] as const;
export type OrderRMultiple = typeof orderRMultiples[number];
export type ProjectedExitField = "takeProfit" | "stopLoss";

export interface OrderProjection {
  takeProfit?: number;
  stopLoss?: number;
  side?: "Buy" | "Sell";
  quantity?: number;
  rMultiple?: OrderRMultiple;
}

export function recalculateOrderProjectionAtR(projection: OrderProjection, entryPrice: number, minMove: number): OrderProjection {
  if (projection.rMultiple == null || projection.stopLoss == null) return projection;
  const takeProfit = calculateTakeProfitAtR(entryPrice, projection.stopLoss, projection.side ?? "Buy", projection.rMultiple, minMove);
  if (takeProfit == null || takeProfit === projection.takeProfit) return projection;
  return { ...projection, takeProfit };
}

export function applyProjectedExitEdit(projection: OrderProjection, field: ProjectedExitField, price: number, entryPrice: number, minMove: number): OrderProjection {
  if (field === "takeProfit") return { ...projection, takeProfit: price, rMultiple: undefined };
  return recalculateOrderProjectionAtR({ ...projection, stopLoss: price }, entryPrice, minMove);
}

export function snapshotOrderProjection(projection: OrderProjection): OrderProjection {
  return { ...projection };
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

export interface TradeLineMetrics {
  dollarAmount: number;
  rMultiple: number | null;
}

const dollarFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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
  const side = projection.side ?? "Buy";
  const quantity = projection.quantity != null && Number.isFinite(projection.quantity) && projection.quantity > 0
    ? Math.abs(projection.quantity)
    : 1;
  if (projection.takeProfit != null && Number.isFinite(projection.takeProfit) && projection.takeProfit > 0) {
    lines.push({ id: "projection:take-profit", kind: "projected-take-profit", price: projection.takeProfit, color: "#16c79a", side, quantity, draggable: true });
  }
  if (projection.stopLoss != null && Number.isFinite(projection.stopLoss) && projection.stopLoss > 0) {
    lines.push({ id: "projection:stop-loss", kind: "projected-stop-loss", price: projection.stopLoss, color: "#ef466f", side, quantity, draggable: true });
  }
  return lines;
}

export function buildTradeLineMetrics(lines: TradeLineModel[], pointValue: number, currentPrice?: number): Map<string, TradeLineMetrics> {
  const metrics = new Map<string, TradeLineMetrics>();
  if (!Number.isFinite(pointValue) || pointValue <= 0) return metrics;

  const positionLines = lines.filter((line) => line.kind === "position" && line.position);
  positionLines.forEach((positionLine) => {
    const position = positionLine.position!;
    const quantity = Math.abs(position.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const direction = position.side === "Long" ? 1 : -1;
    const stopLines = lines.filter((line) => line.kind === "stop-loss" && line.order?.symbol === position.symbol
      && direction * (line.price - position.averagePrice) < 0);
    const nearestStop = stopLines.reduce<TradeLineModel | undefined>((nearest, line) => (
      !nearest || Math.abs(line.price - position.averagePrice) < Math.abs(nearest.price - position.averagePrice) ? line : nearest
    ), undefined);
    const riskAmount = nearestStop
      ? Math.abs(nearestStop.price - position.averagePrice) * pointValue * quantity
      : null;
    const withRisk = (dollarAmount: number): TradeLineMetrics => ({
      dollarAmount,
      rMultiple: riskAmount != null && riskAmount > 0 ? dollarAmount / riskAmount : null,
    });

    const liveDollarAmount = currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0
      ? direction * (currentPrice - position.averagePrice) * pointValue * quantity
      : position.unrealizedPnl;
    if (Number.isFinite(liveDollarAmount)) metrics.set(positionLine.id, withRisk(liveDollarAmount));
    lines.forEach((line) => {
      if ((line.kind !== "take-profit" && line.kind !== "stop-loss") || line.order?.symbol !== position.symbol) return;
      const dollarAmount = direction * (line.price - position.averagePrice) * pointValue * quantity;
      metrics.set(line.id, withRisk(dollarAmount));
    });
  });

  if (currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0) {
    const projectedLines = lines.filter((line) => line.kind === "projected-take-profit" || line.kind === "projected-stop-loss");
    const referenceLine = projectedLines[0];
    const quantity = referenceLine?.quantity ?? 0;
    if (referenceLine && Number.isFinite(quantity) && quantity > 0) {
      const direction = referenceLine.side === "Sell" ? -1 : 1;
      const nearestStop = projectedLines
        .filter((line) => line.kind === "projected-stop-loss" && direction * (line.price - currentPrice) < 0)
        .reduce<TradeLineModel | undefined>((nearest, line) => (
          !nearest || Math.abs(line.price - currentPrice) < Math.abs(nearest.price - currentPrice) ? line : nearest
        ), undefined);
      const riskAmount = nearestStop
        ? Math.abs(nearestStop.price - currentPrice) * pointValue * quantity
        : null;

      projectedLines.forEach((line) => {
        const dollarAmount = direction * (line.price - currentPrice) * pointValue * quantity;
        metrics.set(line.id, {
          dollarAmount,
          rMultiple: riskAmount != null && riskAmount > 0 ? dollarAmount / riskAmount : null,
        });
      });
    }
  }
  return metrics;
}

export function formatTradeLineMetrics(metrics: TradeLineMetrics, settings: Pick<ChartLabelSettings, "showDollarAmount" | "showRMultiple">): string | null {
  const parts: string[] = [];
  if (settings.showDollarAmount) {
    const amount = Math.abs(metrics.dollarAmount) < .005 ? 0 : metrics.dollarAmount;
    const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
    parts.push(`${sign}$${dollarFormatter.format(Math.abs(amount))}`);
  }
  if (settings.showRMultiple) {
    if (metrics.rMultiple == null || !Number.isFinite(metrics.rMultiple)) parts.push("—");
    else {
      const rounded = Math.abs(metrics.rMultiple) < .05 ? 0 : Math.round(metrics.rMultiple * 10) / 10;
      const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
      parts.push(`${sign}${Math.abs(rounded).toFixed(Number.isInteger(rounded) ? 0 : 1)}R`);
    }
  }
  return parts.length ? parts.join(" · ") : null;
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
