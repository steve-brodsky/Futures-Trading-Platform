import type { Account, AccountBalance, Bar, OrderUpdate, Position, Quote, SymbolMeta } from "../types";

export const futures: SymbolMeta[] = [
  { provider: "tradestation", symbol: "@MES", root: "MES", underlying: "MESU26", description: "Micro E-mini S&P 500 Continuous", exchange: "CME", assetType: "FUTURE", minMove: 0.25, pointValue: 5 },
  { provider: "tradestation", symbol: "MESU26", root: "MES", description: "Micro E-mini S&P 500 Sep 2026", exchange: "CME", assetType: "FUTURE", minMove: 0.25, pointValue: 5, expiration: "2026-09-18" },
  { provider: "tradestation", symbol: "MESZ26", root: "MES", description: "Micro E-mini S&P 500 Dec 2026", exchange: "CME", assetType: "FUTURE", minMove: 0.25, pointValue: 5, expiration: "2026-12-18" },
  { provider: "tradestation", symbol: "MNQU26", root: "MNQ", description: "Micro E-mini Nasdaq-100 Sep 2026", exchange: "CME", assetType: "FUTURE", minMove: 0.25, pointValue: 2, expiration: "2026-09-18" },
  { provider: "tradestation", symbol: "MCLU26", root: "MCL", description: "Micro WTI Crude Oil Sep 2026", exchange: "NYMEX", assetType: "FUTURE", minMove: 0.01, pointValue: 100, expiration: "2026-08-20" },
  { provider: "tradestation", symbol: "MGCQ26", root: "MGC", description: "Micro Gold Aug 2026", exchange: "COMEX", assetType: "FUTURE", minMove: 0.1, pointValue: 10, expiration: "2026-07-29" },
  { provider: "tradestation", symbol: "MYMU26", root: "MYM", description: "Micro E-mini Dow Sep 2026", exchange: "CBOT", assetType: "FUTURE", minMove: 1, pointValue: 0.5, expiration: "2026-09-18" },
];

export const equities: SymbolMeta[] = [
  { provider: "schwab", symbol: "AAPL", description: "Apple Inc", exchange: "NASDAQ", assetType: "EQUITY", minMove: 0.01, pointValue: 1 },
  { provider: "schwab", symbol: "SPY", description: "SPDR S&P 500 ETF Trust", exchange: "NYSE ARCA", assetType: "EQUITY", minMove: 0.01, pointValue: 1 },
];

export const demoSymbols = [...futures, ...equities];

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
export const demoPositions: Position[] = [{ id: "p1", symbol: "MESU26", side: "Long", quantity: 2, averagePrice: 6253.25, last: 6260, bid: 6259.75, ask: 6260, unrealizedPnl: 67.5, unrealizedPnlQuantity: 33.75, unrealizedPnlPercent: .54, marketValue: 62600, timestamp: new Date().toISOString() }];
export const demoOrders: OrderUpdate[] = [
  { id: "1047921", accountId: "SIM-849201", symbol: "MESU26", side: "Sell", type: "Limit", quantity: 2, filledQuantity: 0, remainingQuantity: 2, price: 6267.5, status: "Working", duration: "GTC", timestamp: new Date().toISOString(), takeProfit: 6267.5, rawStatus: "ACK", openOrClose: "Close", groupName: "OCO demo", relatedOrders: [{ orderId: "1047922", relationship: "OCO" }] },
  { id: "1047922", accountId: "SIM-849201", symbol: "MESU26", side: "Sell", type: "StopMarket", quantity: 2, filledQuantity: 0, remainingQuantity: 2, stopPrice: 6249.5, status: "Working", duration: "GTC", timestamp: new Date().toISOString(), stopLoss: 6249.5, rawStatus: "ACK", openOrClose: "Close", groupName: "OCO demo", relatedOrders: [{ orderId: "1047921", relationship: "OCO" }] },
  { id: "1047918", accountId: "SIM-849201", symbol: "MESU26", side: "Buy", type: "Market", quantity: 2, filledQuantity: 2, remainingQuantity: 0, averageFillPrice: 6253.25, status: "Filled", duration: "DAY", timestamp: new Date(Date.now() - 900000).toISOString(), closedAt: new Date(Date.now() - 899000).toISOString(), commission: 2.48, relatedOrders: [] },
  { id: "1047901", accountId: "SIM-849201", symbol: "MNQU26", side: "Sell", type: "StopMarket", quantity: 1, filledQuantity: 0, remainingQuantity: 1, stopPrice: 22980, status: "Cancelled", duration: "GTC", timestamp: new Date(Date.now() - 3600000).toISOString(), closedAt: new Date(Date.now() - 3500000).toISOString(), relatedOrders: [] },
];
export const demoBalance: AccountBalance = { accountId: "SIM-849201", accountType: "Futures", currency: "USD", cashBalance: 4996.52, buyingPower: 4996.52, equity: 5064.02, marketValue: 62600, todaysProfitLoss: 67.5, realizedProfitLoss: 0, unrealizedProfitLoss: 67.5, unclearedDeposit: 0, commission: 2.48, initialMargin: 2460, maintenanceMargin: 2200, openOrderMargin: 0 };
export const demoBodBalance: AccountBalance = { accountId: "SIM-849201", accountType: "Futures", currency: "USD", cashBalance: 4996.52, equity: 4996.52, marketValue: 0 };

export function quoteFor(symbol: string, offset = 0, provider: Quote["provider"] = "tradestation"): Quote {
  const last = symbol === "AAPL" ? 224.85 : symbol === "SPY" ? 632.14 : symbol.startsWith("MNQ") ? 23048.5 : symbol.startsWith("MCL") ? 68.42 : symbol.startsWith("MGC") ? 3478.2 : symbol.startsWith("MYM") ? 44982 : 6260 + offset;
  const move = symbol.charCodeAt(1) % 2 ? 0.42 : -0.18;
  return { provider, symbol, last, bid: last - (provider === "schwab" ? 0.01 : 0.25), ask: last + (provider === "schwab" ? 0.01 : 0.25), change: move * 10, changePct: move, delayed: false, halted: false, timestamp: new Date().toISOString() };
}
