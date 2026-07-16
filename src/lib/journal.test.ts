import { describe, expect, it } from "vitest";
import { daySummary, demoJournalTrades, journalCalendarDates, journalDate, journalMetrics, journalProjectedTargetR, journalTimelineEvents, monthSummary } from "./journal";
import type { JournalEvent, JournalScope, JournalTrade } from "../types";

const scope: JournalScope = { environment: "sim", accountId: "a", accountLabel: "SIM ••01" };
const trades: JournalTrade[] = [
  { id: "1", environment: "sim", accountId: "a", symbol: "MES", direction: "Long", status: "closed", openedAt: "2026-03-08T04:30:00Z", closedAt: "2026-03-08T05:00:00Z", entryQuantity: 1, exitQuantity: 1, averageEntry: 1, averageExit: 2, deployedRisk: 5, grossPnl: 10, fees: 1, netPnl: 9, rMultiple: 2, riskProvenance: "exact", notes: "", tags: [] },
  { id: "2", environment: "sim", accountId: "a", symbol: "MES", direction: "Short", status: "closed", openedAt: "2026-03-08T07:30:00Z", closedAt: "2026-03-08T08:00:00Z", entryQuantity: 1, exitQuantity: 1, averageEntry: 2, averageExit: 3, grossPnl: -5, fees: 1, netPnl: -6, riskProvenance: "unknown", notes: "", tags: [] },
  { id: "3", environment: "sim", accountId: "a", symbol: "MNQ", direction: "Long", status: "open", openedAt: "2026-03-08T09:00:00Z", entryQuantity: 1, exitQuantity: 0, averageEntry: 3, grossPnl: 0, fees: 0, netPnl: 0, riskProvenance: "inferred", notes: "", tags: [] },
];

describe("journal analytics", () => {
  it("assigns days in New York across DST boundaries", () => {
    expect(journalDate("2026-03-08T04:30:00Z")).toBe("2026-03-07");
    expect(journalDate("2026-03-08T07:30:00Z")).toBe("2026-03-08");
  });

  it("excludes open trades from realized statistics and unknown risk from R", () => {
    const metrics = journalMetrics(trades);
    expect(metrics.trades).toBe(3);
    expect(metrics.closedTrades).toBe(2);
    expect(metrics.netPnl).toBe(3);
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.totalR).toBe(2);
    expect(metrics.profitFactor).toBe(1.5);
  });

  it("groups month and entry-day summaries", () => {
    expect(monthSummary(scope, 2026, 3, trades).metrics.trades).toBe(3);
    expect(daySummary(scope, "2026-03-07", trades).trades.map((trade) => trade.id)).toEqual(["1"]);
  });

  it("builds a six-column Sunday-Friday calendar", () => {
    const dates = journalCalendarDates(2026, 7);
    expect(dates.every(({ date }) => new Date(`${date}T00:00:00Z`).getUTCDay() !== 6)).toBe(true);
    expect(dates.length % 6).toBe(0);
  });

  it("keeps browser fixtures inside the strict demo account scope", () => {
    const fixtureTrades = demoJournalTrades();
    const fixtureScope: JournalScope = { environment: "sim", accountId: "SIM-DEMO-4821", accountLabel: "SIM ··4821" };
    const now = new Date();
    expect(monthSummary(fixtureScope, now.getFullYear(), now.getMonth() + 1, fixtureTrades).metrics.trades).toBe(2);
  });

  it("shows one logical adjustment for request, confirmation, and broker echo events", () => {
    const events: JournalEvent[] = [
      { id: "broker", brokerOrderId: "stop-1", eventType: "stop-move", occurredAt: "2026-07-16T02:07:20Z", source: "broker-stream", status: "confirmed", oldPrice: 7612.5, newPrice: 7610.75 },
      { id: "fill", eventType: "fill", occurredAt: "2026-07-16T02:07:30Z", source: "broker-stream", status: "confirmed", quantity: 1, price: 7617.75 },
      { id: "requested", brokerOrderId: "stop-1", eventType: "stop-move", occurredAt: "2026-07-16T02:08:00Z", source: "northstar", status: "requested", oldPrice: 7612.5, newPrice: 7610.75 },
      { id: "confirmed", brokerOrderId: "stop-1", eventType: "stop-move", occurredAt: "2026-07-16T02:08:01Z", source: "northstar", status: "confirmed", oldPrice: 7612.5, newPrice: 7610.75 },
    ];
    expect(journalTimelineEvents(events).map((event) => event.id)).toEqual(["fill", "confirmed"]);
  });

  it("keeps identical price transitions when they happen in separate adjustment windows", () => {
    const events: JournalEvent[] = [
      { id: "first", brokerOrderId: "target-1", eventType: "target-move", occurredAt: "2026-07-16T02:00:00Z", source: "northstar", status: "confirmed", oldPrice: 7629, newPrice: 7627 },
      { id: "later", brokerOrderId: "target-1", eventType: "target-move", occurredAt: "2026-07-16T02:10:00Z", source: "northstar", status: "confirmed", oldPrice: 7629, newPrice: 7627 },
    ];
    expect(journalTimelineEvents(events)).toHaveLength(2);
  });

  it("calculates projected target R for long and short trades", () => {
    expect(journalProjectedTargetR({ direction: "Long", averageEntry: 100, originalStop: 95 }, 110)).toBe(2);
    expect(journalProjectedTargetR({ direction: "Long", averageEntry: 100, originalStop: 95 }, 90)).toBe(-2);
    expect(journalProjectedTargetR({ direction: "Short", averageEntry: 100, originalStop: 105 }, 90)).toBe(2);
    expect(journalProjectedTargetR({ direction: "Short", averageEntry: 100, originalStop: 105 }, 110)).toBe(-2);
  });

  it("omits projected target R when initial price risk is unavailable or invalid", () => {
    expect(journalProjectedTargetR({ direction: "Long", averageEntry: 100, originalStop: undefined }, 110)).toBeUndefined();
    expect(journalProjectedTargetR({ direction: "Long", averageEntry: 100, originalStop: 100 }, 110)).toBeUndefined();
    expect(journalProjectedTargetR({ direction: "Long", averageEntry: 100, originalStop: 101 }, 110)).toBeUndefined();
    expect(journalProjectedTargetR({ direction: "Short", averageEntry: 100, originalStop: 99 }, 90)).toBeUndefined();
    expect(journalProjectedTargetR({ direction: "Long", averageEntry: 100, originalStop: 95 }, undefined)).toBeUndefined();
    expect(journalProjectedTargetR({ direction: "Long", averageEntry: Number.NaN, originalStop: 95 }, 110)).toBeUndefined();
  });

  it("keeps moved-target R anchored to the original stop", () => {
    const trade = { direction: "Long" as const, averageEntry: 100, originalStop: 95 };
    const events: JournalEvent[] = [
      { id: "stop", eventType: "stop-move", occurredAt: "2026-07-16T02:00:00Z", source: "northstar", status: "confirmed", oldPrice: 95, newPrice: 100 },
      { id: "target", eventType: "target-move", occurredAt: "2026-07-16T02:01:00Z", source: "northstar", status: "confirmed", oldPrice: 110, newPrice: 115 },
    ];
    const targetMove = journalTimelineEvents(events).find((event) => event.eventType === "target-move");
    expect(journalProjectedTargetR(trade, targetMove?.newPrice)).toBe(3);
  });
});
