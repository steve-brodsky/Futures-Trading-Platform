import type { Account, AccountBalance, Bar, OptionChainSnapshot, OptionExpiration, OrderUpdate, Position, Quote, SymbolMeta } from "../types";

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

export function makeDemoBars(count = 360, start = 6218, scale = 1, intervalSeconds = 60): Bar[] {
  const interval = Math.max(60, Math.round(intervalSeconds / 60) * 60);
  const now = Math.floor(Date.now() / (interval * 1_000)) * interval;
  let previous = start;
  return Array.from({ length: count }, (_, index) => {
    const drift = (index * 0.105 + Math.sin(index / 18) * 2.2) * scale;
    const open = previous;
    const close = start + drift + noise(index) * scale;
    const high = Math.max(open, close) + (0.3 + Math.abs(Math.sin(index * 2.1)) * 1.05) * scale;
    const low = Math.min(open, close) - (0.3 + Math.abs(Math.cos(index * 1.4)) * 0.9) * scale;
    previous = close;
    return { time: now - (count - index) * interval, open, high, low, close, volume: Math.round(180 + Math.abs(noise(index) * 180) + (index % 47 === 0 ? 1200 : 0)) };
  });
}

export const demoAccounts: Account[] = [{ provider: "tradestation", id: "SIM-849201", displayId: "•••9201", accountType: "Futures", status: "Active", currency: "USD" }];
export const demoPositions: Position[] = [{ provider: "tradestation", accountId: "SIM-849201", id: "p1", symbol: "MESU26", assetType: "FUTURE", side: "Long", quantity: 2, averagePrice: 6253.25, last: 6260, bid: 6259.75, ask: 6260, unrealizedPnl: 67.5, currentDayPnl: 67.5, unrealizedPnlQuantity: 33.75, unrealizedPnlPercent: .54, marketValue: 62600, timestamp: new Date().toISOString() }];
export const demoOrders: OrderUpdate[] = [
  { provider: "tradestation", id: "1047921", accountId: "SIM-849201", symbol: "MESU26", side: "Sell", type: "Limit", quantity: 2, filledQuantity: 0, remainingQuantity: 2, price: 6267.5, status: "Working", duration: "GTC", timestamp: new Date().toISOString(), takeProfit: 6267.5, rawStatus: "ACK", openOrClose: "Close", groupName: "OCO demo", relatedOrders: [{ orderId: "1047922", relationship: "OCO" }] },
  { provider: "tradestation", id: "1047922", accountId: "SIM-849201", symbol: "MESU26", side: "Sell", type: "StopMarket", quantity: 2, filledQuantity: 0, remainingQuantity: 2, stopPrice: 6249.5, status: "Working", duration: "GTC", timestamp: new Date().toISOString(), stopLoss: 6249.5, rawStatus: "ACK", openOrClose: "Close", groupName: "OCO demo", relatedOrders: [{ orderId: "1047921", relationship: "OCO" }] },
  { provider: "tradestation", id: "1047918", accountId: "SIM-849201", symbol: "MESU26", side: "Buy", type: "Market", quantity: 2, filledQuantity: 2, remainingQuantity: 0, averageFillPrice: 6253.25, status: "Filled", duration: "DAY", timestamp: new Date(Date.now() - 900000).toISOString(), closedAt: new Date(Date.now() - 899000).toISOString(), commission: 2.48, relatedOrders: [] },
  { provider: "tradestation", id: "1047901", accountId: "SIM-849201", symbol: "MNQU26", side: "Sell", type: "StopMarket", quantity: 1, filledQuantity: 0, remainingQuantity: 1, stopPrice: 22980, status: "Cancelled", duration: "GTC", timestamp: new Date(Date.now() - 3600000).toISOString(), closedAt: new Date(Date.now() - 3500000).toISOString(), relatedOrders: [] },
];
export const demoBalance: AccountBalance = { provider: "tradestation", accountId: "SIM-849201", accountType: "Futures", currency: "USD", cashBalance: 4996.52, buyingPower: 4996.52, equity: 5064.02, marketValue: 62600, todaysProfitLoss: 67.5, realizedProfitLoss: 0, unrealizedProfitLoss: 67.5, unclearedDeposit: 0, commission: 2.48, initialMargin: 2460, maintenanceMargin: 2200, openOrderMargin: 0 };
export const demoBodBalance: AccountBalance = { provider: "tradestation", accountId: "SIM-849201", accountType: "Futures", currency: "USD", cashBalance: 4996.52, equity: 4996.52, marketValue: 0 };

export const demoSchwabAccounts: Account[] = [{ provider: "schwab", id: "demo-schwab-hash-1174", displayId: "Schwab ··1174", accountType: "MARGIN", status: "Active", currency: "USD" }];
const demoOptionExpiration = nextFridays(1)[0];
const demoOptionSymbol = `SPY${"".padEnd(3, " ")}${demoOptionExpiration.slice(2).replaceAll("-", "")}C00632000`;
export const demoSchwabPositions: Position[] = [
  { provider: "schwab", accountId: "demo-schwab-hash-1174", id: "schwab-equity", symbol: "AAPL", assetType: "EQUITY", side: "Long", quantity: 25, averagePrice: 218.4, last: 224.85, bid: 224.84, ask: 224.86, unrealizedPnl: 161.25, currentDayPnl: 42.5, marketValue: 5621.25, multiplier: 1 },
  { provider: "schwab", accountId: "demo-schwab-hash-1174", id: "schwab-option", symbol: demoOptionSymbol, assetType: "OPTION", side: "Long", quantity: 1, averagePrice: .48, last: .605, bid: .575, ask: .635, unrealizedPnl: 12.5, currentDayPnl: 7.5, marketValue: 60.5, multiplier: 100, underlying: "SPY", expirationDate: demoOptionExpiration, strikePrice: 632, putCall: "CALL" },
];
export const demoSchwabBalance: AccountBalance = { provider: "schwab", accountId: "demo-schwab-hash-1174", accountType: "MARGIN", currency: "USD", cashBalance: 18420.44, buyingPower: 36920.88, equity: 50561.75, marketValue: 5681.75, todaysProfitLoss: 50, unrealizedProfitLoss: 173.75 };
export const demoSchwabBodBalance: AccountBalance = { provider: "schwab", accountId: "demo-schwab-hash-1174", accountType: "MARGIN", currency: "USD", cashBalance: 18349.94, equity: 51214.25 };
export const demoSchwabOrders: OrderUpdate[] = [{ provider: "schwab", id: "schwab:1174:48921:1", brokerOrderId: "48921", legId: "1", accountId: "demo-schwab-hash-1174", symbol: "AAPL", assetType: "EQUITY", side: "Buy", type: "Market", quantity: 25, filledQuantity: 25, remainingQuantity: 0, averageFillPrice: 218.4, status: "Filled", duration: "DAY", timestamp: new Date(Date.now() - 3_600_000).toISOString(), openOrClose: "Open", groupName: "SINGLE", relatedOrders: [] }];

export function quoteFor(symbol: string, offset = 0, provider: Quote["provider"] = "tradestation"): Quote {
  const last = symbol === "AAPL" ? 224.85 : symbol === "SPY" ? 632.14 : symbol.startsWith("MNQ") ? 23048.5 : symbol.startsWith("MCL") ? 68.42 : symbol.startsWith("MGC") ? 3478.2 : symbol.startsWith("MYM") ? 44982 : 6260 + offset;
  const move = symbol.charCodeAt(1) % 2 ? 0.42 : -0.18;
  return { provider, symbol, last, bid: last - (provider === "schwab" ? 0.01 : 0.25), ask: last + (provider === "schwab" ? 0.01 : 0.25), change: move * 10, changePct: move, delayed: false, halted: false, timestamp: new Date().toISOString() };
}

function nextFridays(count: number): string[] {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  const daysToFriday = (5 - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysToFriday);
  return Array.from({ length: count }, (_, index) => {
    const expiration = new Date(date);
    expiration.setUTCDate(expiration.getUTCDate() + index * 7);
    return expiration.toISOString().slice(0, 10);
  });
}

export function demoOptionExpirations(_symbol: string): OptionExpiration[] {
  return nextFridays(8).map((expirationDate, index) => ({
    expirationDate,
    daysToExpiration: Math.max(0, Math.round((Date.parse(`${expirationDate}T20:00:00Z`) - Date.now()) / 86_400_000)),
    expirationType: index === 3 || index === 7 ? "S" : "W",
    standard: true,
  }));
}

export function demoOptionChain(symbol: string, expirationDates: string[], strikeCount = 15): OptionChainSnapshot {
  const spot = quoteFor(symbol, 0, "schwab").last;
  const strikeStep = symbol === "SPY" ? 2 : 2.5;
  const center = Math.round(spot / strikeStep) * strikeStep;
  const contracts = expirationDates.flatMap((expirationDate, expirationIndex) => (
    Array.from({ length: strikeCount * 2 + 1 }, (_, strikeIndex) => center + (strikeIndex - strikeCount) * strikeStep).flatMap((strikePrice, strikeIndex) => (
      (["CALL", "PUT"] as const).map((putCall) => {
        const distance = Math.abs(strikeIndex - strikeCount);
        const gamma = 0.0015 + Math.exp(-(distance * distance) / 42) * (0.024 / (1 + expirationIndex * 0.34));
        const sideBias = putCall === "CALL" ? 1 + Math.sin(strikeIndex * 0.71) * 0.18 : 1 + Math.cos(strikeIndex * 0.63) * 0.22;
        const openInterest = Math.round((850 + (strikeCount - Math.min(strikeCount, distance)) * 220 + ((strikeIndex * 173 + expirationIndex * 97) % 900)) * sideBias);
        const compactDate = expirationDate.slice(2).replaceAll("-", "");
        const strikeCode = String(Math.round(strikePrice * 1_000)).padStart(8, "0");
        return {
          symbol: `${symbol.padEnd(6, " ")}${compactDate}${putCall === "CALL" ? "C" : "P"}${strikeCode}`,
          underlying: symbol,
          putCall,
          expirationDate,
          strikePrice,
          multiplier: 100,
          gamma,
          openInterest,
          bidPrice: Math.max(0.01, Math.abs(spot - strikePrice) * 0.18 + 0.55),
          askPrice: Math.max(0.02, Math.abs(spot - strikePrice) * 0.18 + 0.61),
          bidSize: 2 + (strikeIndex * 7) % 68,
          askSize: 1 + (strikeIndex * 11) % 54,
          markPrice: Math.max(0.015, Math.abs(spot - strikePrice) * 0.18 + 0.58),
          totalVolume: (strikeIndex * 47 + expirationIndex * 83) % 1_500,
          volatility: 0.18 + distance * 0.004,
          delta: putCall === "CALL" ? Math.max(0.05, 0.5 - (strikePrice - spot) / 80) : Math.min(-0.05, -0.5 - (strikePrice - spot) / 80),
          theta: -(0.01 + Math.exp(-(distance * distance) / 72) * 0.16),
          vega: 0.02 + Math.exp(-(distance * distance) / 90) * 0.2,
          underlyingPrice: spot,
          quoteTime: Date.now(),
          delayed: false,
          isMini: false,
          isNonStandard: false,
        };
      })
    ))
  ));
  return { symbol, underlyingPrice: spot, delayed: false, fetchedAt: new Date().toISOString(), contracts };
}
