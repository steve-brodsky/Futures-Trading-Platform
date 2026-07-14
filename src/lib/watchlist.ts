export const MAX_STREAMED_QUOTE_SYMBOLS = 100;

function normalizedSymbol(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const symbol = value.trim().toUpperCase();
  return symbol || undefined;
}

export function normalizeWatchlist(value: unknown, subscribedSymbols: Iterable<string> = []): string[] {
  if (!Array.isArray(value)) return [];
  const occupied = new Set([...subscribedSymbols].map(normalizedSymbol).filter((symbol): symbol is string => Boolean(symbol)));
  const seen = new Set<string>();
  const normalized: string[] = [];

  value.forEach((item) => {
    const symbol = normalizedSymbol(item);
    if (!symbol || seen.has(symbol)) return;
    if (!occupied.has(symbol) && occupied.size >= MAX_STREAMED_QUOTE_SYMBOLS) return;
    seen.add(symbol);
    occupied.add(symbol);
    normalized.push(symbol);
  });

  return normalized;
}

export function reorderWatchlist(symbols: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= symbols.length || toIndex < 0 || toIndex >= symbols.length || fromIndex === toIndex) return symbols;
  const next = [...symbols];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
