import type { Position } from "../types";

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
