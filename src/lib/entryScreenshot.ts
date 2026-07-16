import type { OrderUpdate, Position, TradingEnvironment } from "../types";
import { buildTradeLines } from "./tradeLines";

export const ENTRY_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const ENTRY_SCREENSHOT_QUEUE_LIMIT = 10;
export const ENTRY_SCREENSHOT_RETRY_DELAYS = [5_000, 15_000, 60_000] as const;

export interface EntryScreenshotScope {
  environment: TradingEnvironment;
  accountId: string;
  tradeSymbol: string;
}

export function hasOpenPosition(symbol: string, positions: Position[]): boolean {
  return positions.some((position) => position.symbol === symbol && Math.abs(position.quantity) > 0);
}

export function canArmEntryScreenshot(scope: EntryScreenshotScope, positions: Position[], pending: EntryScreenshotScope[]): boolean {
  return !hasOpenPosition(scope.tradeSymbol, positions)
    && !pending.some((candidate) => candidate.environment === scope.environment && candidate.accountId === scope.accountId && candidate.tradeSymbol === scope.tradeSymbol);
}

export function entryScreenshotLinesReady(symbol: string, positions: Position[], orders: OrderUpdate[]): boolean {
  const lines = buildTradeLines(symbol, positions, orders);
  return ["position", "take-profit", "stop-loss"].every((kind) => lines.some((line) => line.kind === kind));
}

export function approximateDataUrlBytes(dataUrl: string): number {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.ceil(encoded.length * .75);
}

export function entryScreenshotRetryDelay(attempt: number): number | undefined {
  return ENTRY_SCREENSHOT_RETRY_DELAYS[attempt - 1];
}
