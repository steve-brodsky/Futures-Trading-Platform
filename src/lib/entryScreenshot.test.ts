import { describe, expect, it } from "vitest";
import type { OrderUpdate, Position } from "../types";
import { approximateDataUrlBytes, canArmEntryScreenshot, entryScreenshotLinesReady, entryScreenshotRetryDelay, hasOpenPosition } from "./entryScreenshot";

const position: Position = { id: "p1", symbol: "MESU26", side: "Long", quantity: 1, averagePrice: 6250, last: 6251, unrealizedPnl: 5 };
const target: OrderUpdate = { id: "tp", symbol: "MESU26", side: "Sell", type: "Limit", quantity: 1, price: 6260, status: "Working", timestamp: "", openOrClose: "Close", groupName: "BRK 1" };
const stop: OrderUpdate = { ...target, id: "sl", type: "StopMarket", price: undefined, stopPrice: 6245 };

describe("entry chart screenshots", () => {
  it("arms only while flat and without a duplicate pending capture", () => {
    const scope = { environment: "sim" as const, accountId: "A1", tradeSymbol: "MESU26" };
    expect(canArmEntryScreenshot(scope, [], [])).toBe(true);
    expect(canArmEntryScreenshot(scope, [position], [])).toBe(false);
    expect(canArmEntryScreenshot(scope, [], [scope])).toBe(false);
    expect(hasOpenPosition("NQU26", [position])).toBe(false);
  });

  it("waits for the exact position, target, and stop lines on the originating symbol", () => {
    expect(entryScreenshotLinesReady("MESU26", [position], [target, stop])).toBe(true);
    expect(entryScreenshotLinesReady("MESU26", [position], [target])).toBe(false);
    expect(entryScreenshotLinesReady("NQU26", [position], [target, stop])).toBe(false);
  });

  it("estimates payload size and uses the bounded retry schedule", () => {
    expect(approximateDataUrlBytes("data:image/png;base64,AAAA")).toBe(3);
    expect([1, 2, 3, 4].map(entryScreenshotRetryDelay)).toEqual([5_000, 15_000, 60_000, undefined]);
  });
});
