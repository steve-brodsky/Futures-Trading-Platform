import type {
  JournalCalendarDay, JournalDaySummary, JournalEvent, JournalMonthSummary, JournalScope,
  JournalStatsBreakdown, JournalStatsRange, JournalStatsResult, JournalStatsTrade,
  JournalSummaryMetrics, JournalTrade,
} from "../types";

export const JOURNAL_TIME_ZONE = "America/New_York";

const newYorkDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: JOURNAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function journalDate(iso: string): string {
  const parts = newYorkDateFormatter.formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

const MOVE_EVENT_WINDOW_MS = 3 * 60 * 1000;

function moveEventPriority(event: JournalEvent): number {
  if (event.status === "failed") return 4;
  if (event.status === "confirmed" && event.source === "northstar") return 3;
  if (event.status === "confirmed") return 2;
  if (event.status === "requested") return 1;
  return 0;
}

export function journalTimelineEvents(events: JournalEvent[]): JournalEvent[] {
  const groups: Array<{ event: JournalEvent; lastAt: number; moveKey?: string }> = [];
  const sorted = [...events].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  for (const event of sorted) {
    if (event.eventType !== "stop-move" && event.eventType !== "target-move") {
      groups.push({ event, lastAt: Date.parse(event.occurredAt) });
      continue;
    }
    const moveKey = [event.eventType, event.brokerOrderId ?? "", event.oldPrice ?? "", event.newPrice ?? ""].join(":");
    const occurredAt = Date.parse(event.occurredAt);
    const existing = groups.slice().reverse().find((group) => group.moveKey === moveKey && Math.abs(occurredAt - group.lastAt) <= MOVE_EVENT_WINDOW_MS);
    if (!existing) {
      groups.push({ event, lastAt: occurredAt, moveKey });
      continue;
    }
    existing.lastAt = Math.max(existing.lastAt, occurredAt);
    if (moveEventPriority(event) >= moveEventPriority(existing.event)) existing.event = event;
  }
  return groups.map((group) => group.event).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
}

export function journalProjectedTargetR(
  trade: Pick<JournalTrade, "direction" | "averageEntry" | "originalStop">,
  target?: number,
): number | undefined {
  const { averageEntry: entry, originalStop: stop } = trade;
  if (target == null || stop == null || !Number.isFinite(target) || !Number.isFinite(entry) || !Number.isFinite(stop)) return undefined;
  const direction = trade.direction === "Long" ? 1 : -1;
  const initialPriceRisk = direction * (entry - stop);
  if (initialPriceRisk <= 0) return undefined;
  return direction * (target - entry) / initialPriceRisk;
}

export function journalMetrics(trades: JournalTrade[]): JournalSummaryMetrics {
  const closed = trades.filter((trade) => trade.status === "closed");
  const wins = closed.filter((trade) => trade.netPnl > 0);
  const losses = closed.filter((trade) => trade.netPnl < 0);
  const knownR = closed.map((trade) => trade.rMultiple).filter((value): value is number => value != null && Number.isFinite(value));
  const positive = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const negative = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = closed.reduce((sum, trade) => sum + trade.netPnl, 0);
  return {
    netPnl,
    grossPnl: closed.reduce((sum, trade) => sum + trade.grossPnl, 0),
    fees: closed.reduce((sum, trade) => sum + trade.fees, 0),
    trades: trades.length,
    closedTrades: closed.length,
    winRate: closed.length ? wins.length / closed.length : undefined,
    totalR: knownR.length ? knownR.reduce((sum, value) => sum + value, 0) : undefined,
    averageTrade: closed.length ? netPnl / closed.length : undefined,
    profitFactor: negative > 0 ? positive / negative : positive > 0 ? Infinity : undefined,
    longTrades: trades.filter((trade) => trade.direction === "Long").length,
    shortTrades: trades.filter((trade) => trade.direction === "Short").length,
  };
}

export function monthSummary(scope: JournalScope, year: number, month: number, trades: JournalTrade[]): JournalMonthSummary {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const monthTrades = trades.filter((trade) => journalDate(trade.openedAt).startsWith(prefix));
  const grouped = new Map<string, JournalTrade[]>();
  monthTrades.forEach((trade) => {
    const date = journalDate(trade.openedAt);
    grouped.set(date, [...(grouped.get(date) ?? []), trade]);
  });
  const days: JournalCalendarDay[] = [...grouped.entries()].map(([date, items]) => {
    const metrics = journalMetrics(items);
    return { date, trades: metrics.trades, closedTrades: metrics.closedTrades, netPnl: metrics.netPnl, totalR: metrics.totalR };
  });
  return { scope, year, month, metrics: journalMetrics(monthTrades), days };
}

export function daySummary(scope: JournalScope, date: string, trades: JournalTrade[]): JournalDaySummary {
  const dayTrades = trades.filter((trade) => journalDate(trade.openedAt) === date).sort((left, right) => left.openedAt.localeCompare(right.openedAt));
  return { scope, date, metrics: journalMetrics(dayTrades), trades: dayTrades };
}

function journalHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JOURNAL_TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0);
}

export function journalStatsRange(
  scope: JournalScope,
  trades: JournalStatsTrade[],
  startDate?: string,
  endDate?: string,
): JournalStatsRange {
  return {
    scope,
    startDate,
    endDate,
    trades: trades.filter((trade) => {
      const date = journalDate(trade.openedAt);
      return (!startDate || date >= startDate) && (!endDate || date <= endDate);
    }),
  };
}

const JOURNAL_STATS_REFRESH_REASONS = new Set([
  "stream-start-cloud-sync",
  "entry-intent",
  "cloud-configured",
  "journal-reset-now",
  "commission-updated",
  "close-reconciled",
  "broker-fill",
  "cloud-sync",
  "annotation",
]);

export function journalStatsNeedsRefresh(reason?: string): boolean {
  return reason == null || JOURNAL_STATS_REFRESH_REASONS.has(reason);
}

function statsBreakdown(
  groups: Map<string, { label: string; trades: JournalStatsTrade[] }>,
): JournalStatsBreakdown[] {
  return [...groups.entries()].map(([key, group]) => {
    const wins = group.trades.filter((trade) => trade.netPnl > 0);
    const knownR = group.trades
      .map((trade) => trade.rMultiple)
      .filter((value): value is number => value != null && Number.isFinite(value));
    const netPnl = group.trades.reduce((sum, trade) => sum + trade.netPnl, 0);
    return {
      key,
      label: group.label,
      trades: group.trades.length,
      netPnl,
      totalR: knownR.length ? knownR.reduce((sum, value) => sum + value, 0) : undefined,
      winRate: group.trades.length ? wins.length / group.trades.length : undefined,
      averageTrade: group.trades.length ? netPnl / group.trades.length : undefined,
    };
  });
}

function addBreakdownTrade(
  groups: Map<string, { label: string; trades: JournalStatsTrade[] }>,
  key: string,
  label: string,
  trade: JournalStatsTrade,
) {
  const current = groups.get(key);
  if (current) current.trades.push(trade);
  else groups.set(key, { label, trades: [trade] });
}

function maximumDrawdown(values: number[]): number {
  let peak = 0;
  let cumulative = 0;
  let maximum = 0;
  values.forEach((value) => {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maximum = Math.max(maximum, peak - cumulative);
  });
  return maximum;
}

export function journalStats(trades: JournalStatsTrade[]): JournalStatsResult {
  const closed = trades
    .filter((trade) => trade.status === "closed")
    .sort((left, right) => (left.closedAt ?? left.openedAt).localeCompare(right.closedAt ?? right.openedAt));
  const wins = closed.filter((trade) => trade.netPnl > 0);
  const losses = closed.filter((trade) => trade.netPnl < 0);
  const knownRTrades = closed.filter((trade) => trade.rMultiple != null && Number.isFinite(trade.rMultiple));
  const positive = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const negative = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = closed.reduce((sum, trade) => sum + trade.netPnl, 0);
  const averageWin = wins.length ? positive / wins.length : undefined;
  const averageLoss = losses.length ? losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length : undefined;
  const holdDurations = closed
    .map((trade) => trade.closedAt ? (Date.parse(trade.closedAt) - Date.parse(trade.openedAt)) / 60_000 : Number.NaN)
    .filter((value) => Number.isFinite(value) && value >= 0);

  let currentWinStreak = 0;
  let currentLossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  closed.forEach((trade) => {
    if (trade.netPnl > 0) {
      currentWinStreak += 1;
      currentLossStreak = 0;
    } else if (trade.netPnl < 0) {
      currentLossStreak += 1;
      currentWinStreak = 0;
    } else {
      currentWinStreak = 0;
      currentLossStreak = 0;
    }
    longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
    longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
  });

  const dailyGroups = new Map<string, JournalStatsTrade[]>();
  closed.forEach((trade) => {
    const date = journalDate(trade.openedAt);
    dailyGroups.set(date, [...(dailyGroups.get(date) ?? []), trade]);
  });
  let cumulativePnl = 0;
  let cumulativeR = 0;
  let pnlPeak = 0;
  let rPeak = 0;
  const days = [...dailyGroups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, dayTrades]) => {
    const dayR = dayTrades
      .map((trade) => trade.rMultiple)
      .filter((value): value is number => value != null && Number.isFinite(value));
    const net = dayTrades.reduce((sum, trade) => sum + trade.netPnl, 0);
    cumulativePnl += net;
    pnlPeak = Math.max(pnlPeak, cumulativePnl);
    const totalR = dayR.length ? dayR.reduce((sum, value) => sum + value, 0) : undefined;
    if (totalR != null) cumulativeR += totalR;
    rPeak = Math.max(rPeak, cumulativeR);
    return {
      date,
      trades: dayTrades.length,
      netPnl: net,
      totalR,
      cumulativePnl,
      cumulativeR: knownRTrades.length ? cumulativeR : undefined,
      drawdownPnl: pnlPeak - cumulativePnl,
      drawdownR: knownRTrades.length ? rPeak - cumulativeR : undefined,
    };
  });

  const symbolGroups = new Map<string, { label: string; trades: JournalStatsTrade[] }>();
  const directionGroups = new Map<string, { label: string; trades: JournalStatsTrade[] }>();
  const tagGroups = new Map<string, { label: string; trades: JournalStatsTrade[] }>();
  const hourGroups = new Map<string, { label: string; trades: JournalStatsTrade[] }>();
  closed.forEach((trade) => {
    addBreakdownTrade(symbolGroups, trade.symbol.toUpperCase(), trade.symbol.toUpperCase(), trade);
    addBreakdownTrade(directionGroups, trade.direction.toLowerCase(), trade.direction, trade);
    const uniqueTags = new Map<string, string>();
    trade.tags.forEach((tag) => {
      const label = tag.trim();
      if (label) uniqueTags.set(label.toLocaleLowerCase(), label);
    });
    if (!uniqueTags.size) uniqueTags.set("untagged", "Untagged");
    uniqueTags.forEach((label, key) => addBreakdownTrade(tagGroups, key, label, trade));
    const hour = journalHour(trade.openedAt);
    const hourKey = String(hour).padStart(2, "0");
    addBreakdownTrade(hourGroups, hourKey, `${hourKey}:00`, trade);
  });
  const performanceSort = (left: JournalStatsBreakdown, right: JournalStatsBreakdown) => right.netPnl - left.netPnl || right.trades - left.trades;

  return {
    metrics: {
      closedTrades: closed.length,
      openTrades: trades.length - closed.length,
      netPnl,
      grossPnl: closed.reduce((sum, trade) => sum + trade.grossPnl, 0),
      fees: closed.reduce((sum, trade) => sum + trade.fees, 0),
      totalR: knownRTrades.length ? knownRTrades.reduce((sum, trade) => sum + (trade.rMultiple ?? 0), 0) : undefined,
      rTrades: knownRTrades.length,
      winRate: closed.length ? wins.length / closed.length : undefined,
      profitFactor: negative > 0 ? positive / negative : positive > 0 ? Infinity : undefined,
      expectancy: closed.length ? netPnl / closed.length : undefined,
      averageWin,
      averageLoss,
      payoffRatio: averageWin != null && averageLoss != null && averageLoss !== 0 ? averageWin / Math.abs(averageLoss) : undefined,
      averageHoldMinutes: holdDurations.length ? holdDurations.reduce((sum, value) => sum + value, 0) / holdDurations.length : undefined,
      longestWinStreak,
      longestLossStreak,
      maxDrawdown: maximumDrawdown(closed.map((trade) => trade.netPnl)),
      maxDrawdownR: knownRTrades.length ? maximumDrawdown(knownRTrades.map((trade) => trade.rMultiple ?? 0)) : undefined,
      largestWin: wins.length ? wins.reduce((best, trade) => trade.netPnl > best.netPnl ? trade : best) : undefined,
      largestLoss: losses.length ? losses.reduce((worst, trade) => trade.netPnl < worst.netPnl ? trade : worst) : undefined,
    },
    days,
    symbols: statsBreakdown(symbolGroups).sort(performanceSort),
    directions: statsBreakdown(directionGroups).sort(performanceSort),
    tags: statsBreakdown(tagGroups).sort(performanceSort),
    entryHours: statsBreakdown(hourGroups).sort((left, right) => left.key.localeCompare(right.key)),
  };
}

export function journalCalendarDates(year: number, month: number): Array<{ date: string; inMonth: boolean }> {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - first.getUTCDay());
  const end = new Date(last);
  const endDay = last.getUTCDay();
  end.setUTCDate(last.getUTCDate() + (endDay === 6 ? 0 : 6 - endDay));
  const dates: Array<{ date: string; inMonth: boolean }> = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (cursor.getUTCDay() === 6) continue;
    const date = cursor.toISOString().slice(0, 10);
    dates.push({ date, inMonth: cursor.getUTCMonth() === month - 1 });
  }
  while (dates.length < 30) {
    const cursor = new Date(`${dates.at(-1)!.date}T00:00:00Z`);
    do cursor.setUTCDate(cursor.getUTCDate() + 1); while (cursor.getUTCDay() === 6);
    dates.push({ date: cursor.toISOString().slice(0, 10), inMonth: cursor.getUTCMonth() === month - 1 });
  }
  return dates;
}

export function demoJournalTrades(): JournalTrade[] {
  const now = new Date();
  const stamp = (daysAgo: number, hour: number, minute = 0) => new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, hour, minute,
  )).toISOString();
  const closed = (
    id: string,
    daysAgo: number,
    symbol: string,
    direction: "Long" | "Short",
    netPnl: number,
    rMultiple: number | undefined,
    tags: string[],
    hour: number,
    holdMinutes: number,
  ): JournalTrade => {
    const openedAt = stamp(daysAgo, hour);
    const closedAt = new Date(Date.parse(openedAt) + holdMinutes * 60_000).toISOString();
    const averageEntry = symbol.startsWith("MNQ") ? 23_200 : symbol.startsWith("MCL") ? 67.5 : symbol.startsWith("MGC") ? 2_420 : 6_250;
    const priceMove = netPnl / (symbol.startsWith("MNQ") ? 2 : symbol.startsWith("MCL") ? 100 : symbol.startsWith("MGC") ? 10 : 5);
    const averageExit = averageEntry + priceMove * (direction === "Long" ? 1 : -1);
    return {
      id, environment: "sim", accountId: "SIM-DEMO-4821", symbol, direction, status: "closed",
      openedAt, closedAt, entryQuantity: 1, exitQuantity: 1, averageEntry, averageExit,
      originalStop: averageEntry + (direction === "Long" ? -4 : 4),
      originalTarget: averageEntry + (direction === "Long" ? 8 : -8),
      plannedRisk: 24, deployedRisk: 24, pointValue: 5,
      grossPnl: netPnl + 1.9, fees: 1.9, netPnl, rMultiple,
      riskProvenance: rMultiple == null ? "unknown" : "exact", notes: "", tags, events: [],
    };
  };
  const trades = [
    closed("demo-win", 18, "MESU26", "Long", 84.1, 1.75, ["opening-range", "A setup"], 13, 28),
    closed("demo-loss", 16, "MESU26", "Long", -46.9, -1, ["retest"], 14, 86),
    closed("demo-mnq-win", 14, "MNQU26", "Short", 116.1, 2.2, ["failed-breakout", "A setup"], 15, 42),
    closed("demo-mcl-loss", 12, "MCLU26", "Long", -31.9, -0.75, ["retest", "impulsive"], 16, 19),
    closed("demo-mes-scratch", 10, "MESU26", "Short", -1.9, 0, ["opening-range"], 13, 11),
    closed("demo-mgc-win", 8, "MGCQ26", "Long", 58.1, 1.25, ["trend", "B setup"], 17, 67),
    closed("demo-mnq-loss", 6, "MNQU26", "Long", -72.9, -1.1, ["failed-breakout"], 18, 34),
    closed("demo-mes-win-two", 4, "MESU26", "Short", 41.1, 0.9, ["retest", "B setup"], 14, 23),
    closed("demo-mcl-win", 2, "MCLU26", "Short", 73.1, undefined, ["trend"], 20, 51),
    closed("demo-mnq-win-two", 1, "MNQU26", "Long", 94.1, 1.6, ["opening-range", "A setup"], 13, 37),
  ];
  trades[0].notes = "Waited for the reclaim and respected the bracket.";
  trades[0].events = [
    { id: "e1", tradeId: "demo-win", eventType: "entry-intent", occurredAt: trades[0].openedAt, source: "northstar", status: "confirmed", price: trades[0].averageEntry, quantity: 1 },
    { id: "e2", tradeId: "demo-win", eventType: "stop-move", occurredAt: new Date(Date.parse(trades[0].openedAt) + 15 * 60_000).toISOString(), source: "northstar", status: "confirmed", oldPrice: trades[0].originalStop, newPrice: trades[0].averageEntry },
    { id: "e3", tradeId: "demo-win", eventType: "fill", occurredAt: trades[0].closedAt!, source: "broker-stream", status: "confirmed", price: trades[0].averageExit, quantity: 1 },
  ];
  return [...trades, {
    id: "demo-open", environment: "sim", accountId: "SIM-DEMO-4821", symbol: "MESU26", direction: "Long", status: "open",
    openedAt: stamp(0, 15), entryQuantity: 1, exitQuantity: 0, averageEntry: 6258.25,
    originalStop: 6254.25, originalTarget: 6266.25, plannedRisk: 20, deployedRisk: 20, pointValue: 5,
    grossPnl: 0, fees: 0.4, netPnl: 0, rMultiple: undefined, riskProvenance: "exact", notes: "", tags: ["retest"], events: [],
  }];
}
