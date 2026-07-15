import { describe, expect, it } from "vitest";
import { daySummary, demoJournalTrades, journalCalendarDates, journalDate, journalMetrics, monthSummary } from "./journal";
import type { JournalScope, JournalTrade } from "../types";

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
});
