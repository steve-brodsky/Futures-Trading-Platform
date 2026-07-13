import type { ChartTabState, SymbolMeta, WorkspaceState } from "../types";

export function isContinuousFuture(symbol: SymbolMeta): boolean {
  return symbol.symbol.startsWith("@") && symbol.assetType.toUpperCase().includes("FUTURE");
}

function concreteSymbol(value?: string): string | undefined {
  const symbol = value?.trim().toUpperCase();
  return symbol && !symbol.startsWith("@") ? symbol : undefined;
}

export function resolveTradeSymbol(tab: ChartTabState): string | undefined {
  if (!isContinuousFuture(tab.symbol)) return concreteSymbol(tab.symbol.symbol);
  return concreteSymbol(tab.tradeContract) ?? concreteSymbol(tab.symbol.underlying);
}

export function quoteSubscriptionSymbols(workspace: Pick<WorkspaceState, "tabs" | "watchlist">): string[] {
  const symbols = new Set(workspace.watchlist.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
  workspace.tabs.forEach((tab) => {
    symbols.add(tab.symbol.symbol);
    const tradeSymbol = resolveTradeSymbol(tab);
    if (tradeSymbol) symbols.add(tradeSymbol);
  });
  return [...symbols].sort();
}

export function sameSymbolMeta(left: SymbolMeta, right: SymbolMeta): boolean {
  return left.symbol === right.symbol
    && left.description === right.description
    && left.exchange === right.exchange
    && left.assetType === right.assetType
    && left.minMove === right.minMove
    && left.pointValue === right.pointValue
    && left.expiration === right.expiration
    && left.root === right.root
    && left.underlying === right.underlying;
}

export function formatContractExpiration(expiration?: string): string {
  if (!expiration) return "Expiration unavailable";
  const value = expiration.trim();
  const microsoftDate = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const date = microsoftDate
    ? new Date(Number(microsoftDate[1]))
    : isoDate
      ? new Date(Date.UTC(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]), 12))
      : new Date(value);
  if (Number.isNaN(date.getTime())) return expiration;
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}
