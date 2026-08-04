import type { OptionContract, OrderUpdate, Position } from "../types";

export function readableBrokerOrderSymbol(order: Pick<OrderUpdate, "symbol" | "assetType">): string {
  if (!(order.assetType ?? "").toUpperCase().includes("OPTION")) return order.symbol;
  const symbol = order.symbol.replaceAll(" ", "").toUpperCase();
  if (symbol.length <= 15) return order.symbol;
  const underlying = symbol.slice(0, -15);
  const suffix = symbol.slice(-15);
  const date = suffix.slice(0, 6);
  const putCall = suffix.slice(6, 7);
  const strikeCode = suffix.slice(7);
  if (!/^\d{6}$/.test(date) || !/^[CP]$/.test(putCall) || !/^\d{8}$/.test(strikeCode)) return order.symbol;
  const strike = Number(strikeCode) / 1_000;
  return `${underlying} ${date.slice(2, 4)}/${date.slice(4, 6)}/${date.slice(0, 2)} ${strike.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${putCall}`;
}

export function positionPnlTotal(positions: Position[], field: "unrealizedPnl" | "currentDayPnl"): number | undefined {
  if (field === "currentDayPnl" && !positions.some((position) => position.currentDayPnl != null)) return undefined;
  return positions.reduce((sum, position) => sum + (position[field] ?? 0), 0);
}

export function combinedCurrencyTotal(currencyA: string | undefined, valueA: number | undefined, currencyB: string | undefined, valueB: number | undefined): number | undefined {
  return currencyA && currencyA === currencyB && valueA != null && valueB != null ? valueA + valueB : undefined;
}

export function positionMatchesSchwabChart(position: Position, symbol: string): boolean {
  if (position.provider !== "schwab") return false;
  const chart = symbol.trim().toUpperCase();
  return (position.assetType ?? "").toUpperCase().includes("OPTION")
    ? position.underlying?.trim().toUpperCase() === chart
    : position.symbol.trim().toUpperCase() === chart;
}

export function heldOptionsForUnderlying(positions: Position[], underlying: string): Position[] {
  return positions.filter((position) => position.provider === "schwab" && (position.assetType ?? "").toUpperCase().includes("OPTION")
    && position.underlying?.trim().toUpperCase() === underlying.trim().toUpperCase());
}

export function applySchwabOptionQuote(positions: Position[], contract: Pick<OptionContract, "symbol" | "markPrice" | "bidPrice" | "askPrice" | "multiplier">): Position[] {
  return positions.map((position) => {
    if (position.symbol.trim() !== contract.symbol.trim()) return position;
    const mark = contract.markPrice || (contract.bidPrice + contract.askPrice) / 2;
    const direction = position.side === "Long" ? 1 : -1;
    const unrealizedPnl = (mark - position.averagePrice) * direction * position.quantity * (position.multiplier ?? contract.multiplier ?? 100);
    return { ...position, last: mark, bid: contract.bidPrice, ask: contract.askPrice, unrealizedPnl };
  });
}
