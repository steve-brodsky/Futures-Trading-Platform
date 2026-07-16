import type { JournalCalendarDay, JournalDaySummary, JournalEvent, JournalMonthSummary, JournalScope, JournalSummaryMetrics, JournalTrade } from "../types";

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
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(Math.min(now.getDate(), 24)).padStart(2, "0");
  const base = `${year}-${month}-${day}`;
  return [
    {
      id: "demo-win", environment: "sim", accountId: "SIM-DEMO-4821", symbol: "MESU26", direction: "Long", status: "closed",
      openedAt: `${base}T16:37:00Z`, closedAt: `${base}T17:05:00Z`, entryQuantity: 1, exitQuantity: 1,
      averageEntry: 6252.5, averageExit: 6259.5, originalStop: 6248.25, originalTarget: 6259.5,
      plannedRisk: 21.25, deployedRisk: 21.25, pointValue: 5, grossPnl: 35, fees: 1.9, netPnl: 33.1, rMultiple: 1.65,
      riskProvenance: "exact", notes: "Waited for the reclaim and respected the bracket.", tags: ["opening-range", "A setup"],
      events: [
        { id: "e1", tradeId: "demo-win", eventType: "entry-intent", occurredAt: `${base}T16:37:00Z`, source: "northstar", status: "confirmed", price: 6252.5, quantity: 1 },
        { id: "e2", tradeId: "demo-win", eventType: "stop-move", occurredAt: `${base}T16:52:00Z`, source: "northstar", status: "confirmed", oldPrice: 6248.25, newPrice: 6252.75 },
        { id: "e3", tradeId: "demo-win", eventType: "fill", occurredAt: `${base}T17:05:00Z`, source: "broker-stream", status: "confirmed", price: 6259.5, quantity: 1 },
      ],
    },
    {
      id: "demo-loss", environment: "sim", accountId: "SIM-DEMO-4821", symbol: "MESU26", direction: "Long", status: "closed",
      openedAt: `${base}T17:23:00Z`, closedAt: `${base}T18:49:00Z`, entryQuantity: 1, exitQuantity: 1,
      averageEntry: 6257.25, averageExit: 6250.25, originalStop: 6250.25, originalTarget: 6267.75,
      plannedRisk: 35, deployedRisk: 35, pointValue: 5, grossPnl: -35, fees: 1.9, netPnl: -36.9, rMultiple: -1,
      riskProvenance: "exact", notes: "", tags: ["retest"],
      events: [
        { id: "e4", tradeId: "demo-loss", eventType: "entry-intent", occurredAt: `${base}T17:23:00Z`, source: "northstar", status: "confirmed", price: 6257.25, quantity: 1 },
        { id: "e5", tradeId: "demo-loss", eventType: "fill", occurredAt: `${base}T18:49:00Z`, source: "broker-stream", status: "confirmed", price: 6250.25, quantity: 1 },
      ],
    },
  ];
}
