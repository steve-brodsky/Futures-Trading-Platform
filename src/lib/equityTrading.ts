import type { OrderTicketSettings, OrderUpdate, Position, Quote, SchwabEquityOrderDraft } from "../types";

export const defaultEquityTicketSettings = {
  swingStopPivotBars: 2, swingStopOffsetTicks: 1, sizingMode: "risk", riskSizingPolicy: "strict", timeInForce: "GTC",
} as const;

export function normalizeEquityTicketSettings(value: unknown): OrderTicketSettings {
  const saved = value && typeof value === "object" ? value as Partial<OrderTicketSettings> : {};
  return {
    ...defaultEquityTicketSettings,
    sizingMode: saved.sizingMode === "contracts" ? "contracts" : "risk",
    timeInForce: saved.timeInForce === "DAY" ? "DAY" : "GTC",
    swingStopPivotBars: saved.swingStopPivotBars === 3 ? 3 : 2,
    swingStopOffsetTicks: typeof saved.swingStopOffsetTicks === "number" && Number.isFinite(saved.swingStopOffsetTicks) ? Math.max(1, Math.min(100, Math.round(saved.swingStopOffsetTicks))) : 1,
    riskAmount: typeof saved.riskAmount === "number" && Number.isFinite(saved.riskAmount) && saved.riskAmount > 0 ? saved.riskAmount : undefined,
  };
}

export function isEquity(assetType?: string): boolean {
  return ["EQUITY", "ETF"].includes(assetType?.toUpperCase() ?? "");
}

export function sharesForRisk(budget: number | undefined, entry: number, stop: number, side: "Buy" | "Sell"): number {
  const distance = side === "Buy" ? entry - stop : stop - entry;
  if (budget == null || !Number.isFinite(budget) || budget <= 0 || !Number.isFinite(distance) || distance <= 0 || stop <= 0 || entry <= 0) return 0;
  // Quotes can contain sub-penny precision; tolerance only corrects binary
  // representation at a whole-share boundary, never rounds up a fractional lot.
  const quotient = budget / distance;
  const shares = Math.min(0xffff_ffff, Math.floor(quotient + Number.EPSILON * Math.max(1, quotient) * 8));
  return shares * distance <= budget + 1e-8 ? shares : Math.max(0, shares - 1);
}

export function equityQuoteAvailable(quote: Quote, now = Date.now()): boolean {
  const quoteAge = now - Date.parse(quote.timestamp);
  return quote.provider === "schwab" && !quote.delayed && !quote.halted
    && Number.isFinite(quote.bid) && quote.bid > 0 && Number.isFinite(quote.ask) && quote.ask >= quote.bid
    && quote.receivedAt != null && now - quote.receivedAt >= 0 && now - quote.receivedAt <= 5_000
    && Number.isFinite(quoteAge) && quoteAge >= -1_000 && quoteAge <= 5_000;
}

export function hasEquityExposure(accountId: string, symbol: string, positions: Position[], orders: OrderUpdate[]): boolean {
  const matches = (row: Position | OrderUpdate) => row.provider === "schwab" && row.accountId === accountId
    && row.symbol.trim().toUpperCase() === symbol.trim().toUpperCase() && isEquity(row.assetType);
  return positions.some((p) => matches(p) && Math.abs(p.quantity) > 0)
    || orders.some((o) => matches(o) && ["Working", "Pending", "Indeterminate"].includes(o.status));
}

export function frozenEquityRisk(draft: SchwabEquityOrderDraft, quote: Quote): number {
  return Math.abs((draft.direction === "Long" ? quote.ask : quote.bid) - draft.stopLoss) * draft.quantity;
}
