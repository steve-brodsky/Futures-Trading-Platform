import type { Account, Bar, OrderUpdate, Position, Quote, SymbolMeta } from "../types";

export const futures: SymbolMeta[] = [
  { symbol: "MESU26", description: "Micro E-mini S&P 500 Sep 2026", exchange: "CME", assetType: "FUTURE", minMove: 0.25, pointValue: 5, expiration: "2026-09-18" },
  { symbol: "MNQU26", description: "Micro E-mini Nasdaq-100 Sep 2026", exchange: "CME", assetType: "FUTURE", minMove: 0.25, pointValue: 2, expiration: "2026-09-18" },
  { symbol: "MCLU26", description: "Micro WTI Crude Oil Sep 2026", exchange: "NYMEX", assetType: "FUTURE", minMove: 0.01, pointValue: 100, expiration: "2026-08-20" },
  { symbol: "MGCQ26", description: "Micro Gold Aug 2026", exchange: "COMEX", assetType: "FUTURE", minMove: 0.1, pointValue: 10, expiration: "2026-07-29" },
  { symbol: "MYMU26", description: "Micro E-mini Dow Sep 2026", exchange: "CBOT", assetType: "FUTURE", minMove: 1, pointValue: 0.5, expiration: "2026-09-18" },
];

function noise(index: number) {
  return Math.sin(index * 1.73) * 1.2 + Math.cos(index * 0.37) * 0.8 + Math.sin(index * 0.083) * 2.4;
}

export function makeDemoBars(count = 360, start = 6218, scale = 1): Bar[] {
  const now = Math.floor(Date.now() / 60000) * 60;
  let previous = start;
  return Array.from({ length: count }, (_, index) => {
    const drift = (index * 0.105 + Math.sin(index / 18) * 2.2) * scale;
    const open = previous;
    const close = start + drift + noise(index) * scale;
    const high = Math.max(open, close) + (0.3 + Math.abs(Math.sin(index * 2.1)) * 1.05) * scale;
    const low = Math.min(open, close) - (0.3 + Math.abs(Math.cos(index * 1.4)) * 0.9) * scale;
    previous = close;
    return { time: now - (count - index) * 60, open, high, low, close, volume: Math.round(180 + Math.abs(noise(index) * 180) + (index % 47 === 0 ? 1200 : 0)) };
  });
}

export const demoAccounts: Account[] = [{ id: "SIM-849201", displayId: "•••9201", accountType: "Futures", status: "Active", currency: "USD" }];
export const demoPositions: Position[] = [{ id: "p1", symbol: "MESU26", side: "Long", quantity: 2, averagePrice: 6253.25, last: 6260, unrealizedPnl: 67.5 }];
export const demoOrders: OrderUpdate[] = [{ id: "1047921", symbol: "MESU26", side: "Sell", type: "Limit", quantity: 2, price: 6267.5, status: "Working", timestamp: new Date().toISOString() }];

export function quoteFor(symbol: string, offset = 0): Quote {
  const last = symbol.startsWith("MNQ") ? 23048.5 : symbol.startsWith("MCL") ? 68.42 : symbol.startsWith("MGC") ? 3478.2 : symbol.startsWith("MYM") ? 44982 : 6260 + offset;
  const move = symbol.charCodeAt(1) % 2 ? 0.42 : -0.18;
  return { symbol, last, bid: last - 0.25, ask: last + 0.25, change: move * 10, changePct: move, delayed: false, halted: false, timestamp: new Date().toISOString() };
}
