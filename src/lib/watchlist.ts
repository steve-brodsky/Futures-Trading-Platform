import type { MarketDataProvider, SymbolMeta } from "../types";

export const MAX_STREAMED_QUOTE_SYMBOLS = 100;
export const MAX_RECENT_SYMBOLS = 10;

function normalizedSymbol(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const symbol = value.trim().toUpperCase();
  return symbol || undefined;
}

export function instrumentKey(value: Pick<SymbolMeta, "provider" | "symbol">): string {
  return `${value.provider}:${value.symbol.trim().toUpperCase()}`;
}

export function legacyWatchlistInstrument(symbol: string): SymbolMeta {
  return {
    provider: "tradestation",
    symbol,
    description: symbol,
    exchange: "",
    assetType: "FUTURE",
    minMove: 0.01,
    pointValue: 1,
  };
}

export function normalizeSymbolMeta(value: unknown): SymbolMeta | undefined {
  const record = value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const symbol = normalizedSymbol(record?.symbol ?? value);
  if (!symbol) return undefined;
  if (!record) return legacyWatchlistInstrument(symbol);
  const assetType = typeof record.assetType === "string" && record.assetType.trim() ? record.assetType.trim().toUpperCase() : "FUTURE";
  const provider: MarketDataProvider = record.provider === "schwab" || (!record.provider && ["EQUITY", "ETF", "INDEX"].includes(assetType)) ? "schwab" : "tradestation";
  return {
    provider,
    symbol,
    description: typeof record.description === "string" && record.description.trim() ? record.description.trim() : symbol,
    exchange: typeof record.exchange === "string" ? record.exchange : "",
    assetType,
    minMove: typeof record.minMove === "number" && Number.isFinite(record.minMove) && record.minMove > 0 ? record.minMove : 0.01,
    pointValue: typeof record.pointValue === "number" && Number.isFinite(record.pointValue) && record.pointValue > 0 ? record.pointValue : 1,
    expiration: typeof record.expiration === "string" ? record.expiration : undefined,
    root: typeof record.root === "string" ? record.root : undefined,
    underlying: typeof record.underlying === "string" ? record.underlying : undefined,
  };
}

export function normalizeRecentSymbols(value: unknown, fallback: Iterable<SymbolMeta> = []): SymbolMeta[] {
  const source = Array.isArray(value) && value.length ? value : [...fallback];
  const seen = new Set<string>();
  const normalized: SymbolMeta[] = [];
  for (const item of source) {
    const instrument = normalizeSymbolMeta(item);
    if (!instrument) continue;
    const key = instrumentKey(instrument);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(instrument);
    if (normalized.length >= MAX_RECENT_SYMBOLS) break;
  }
  return normalized;
}

export function rememberRecentSymbol(recent: SymbolMeta[], instrument: SymbolMeta): SymbolMeta[] {
  return normalizeRecentSymbols([instrument, ...recent]);
}

export function normalizeWatchlist(value: unknown, subscribedInstruments: Iterable<SymbolMeta> = []): SymbolMeta[] {
  if (!Array.isArray(value)) return [];
  const occupied = new Set([...subscribedInstruments].map(instrumentKey));
  const seen = new Set<string>();
  const normalized: SymbolMeta[] = [];

  value.forEach((item) => {
    const instrument = normalizeSymbolMeta(item);
    if (!instrument) return;
    const key = instrumentKey(instrument);
    if (seen.has(key)) return;
    if (!occupied.has(key) && occupied.size >= MAX_STREAMED_QUOTE_SYMBOLS) return;
    seen.add(key);
    occupied.add(key);
    normalized.push(instrument);
  });

  return normalized;
}

export function reorderWatchlist(symbols: SymbolMeta[], fromIndex: number, toIndex: number): SymbolMeta[] {
  if (fromIndex < 0 || fromIndex >= symbols.length || toIndex < 0 || toIndex >= symbols.length || fromIndex === toIndex) return symbols;
  const next = [...symbols];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
