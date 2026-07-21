import { describe, expect, it } from "vitest";
import {
  createPositionDrawing, isValidPositionDrawing, logicalToSourceTime, movePositionDrawing,
  normalizePositionQuantity, positionMetrics, sourceTimeToLogical, updatePositionPrice,
} from "./positionDrawing";

describe("position drawing", () => {
  it("creates long and short positions with a ten-tick stop and two-R target", () => {
    const long = createPositionDrawing({ id: "long", side: "long", entryPrice: 5000.12, startTime: 100, endTime: 200, minMove: 0.25 });
    expect(long).toMatchObject({ entryPrice: 5000, stopPrice: 4997.5, targetPrice: 5005, quantity: 1 });
    const short = createPositionDrawing({ id: "short", side: "short", entryPrice: 5000.12, startTime: 100, endTime: 200, minMove: 0.25 });
    expect(short).toMatchObject({ entryPrice: 5000, stopPrice: 5002.5, targetPrice: 4995, quantity: 1 });
  });

  it("keeps edited prices on the correct side of entry", () => {
    const drawing = createPositionDrawing({ id: "long", side: "long", entryPrice: 100, startTime: 100, endTime: 200, minMove: 1 });
    expect(updatePositionPrice(drawing, "stopPrice", 105, 1).stopPrice).toBe(99);
    expect(updatePositionPrice(drawing, "targetPrice", 95, 1).targetPrice).toBe(101);
    expect(updatePositionPrice(drawing, "entryPrice", 200, 1).entryPrice).toBe(119);
  });

  it("moves the complete geometry and normalizes whole-contract quantities", () => {
    const drawing = createPositionDrawing({ id: "short", side: "short", entryPrice: 100, startTime: 100, endTime: 200, minMove: 0.25 });
    expect(movePositionDrawing(drawing, 60, 1.12, 0.25)).toMatchObject({ startTime: 160, endTime: 260, entryPrice: 101, stopPrice: 103.5, targetPrice: 96 });
    expect(normalizePositionQuantity(2.6)).toBe(3);
    expect(normalizePositionQuantity(-5)).toBe(1);
  });

  it("calculates futures risk, reward, percentage, and live PnL", () => {
    const drawing = { ...createPositionDrawing({ id: "long", side: "long" as const, entryPrice: 5000, startTime: 100, endTime: 200, minMove: 0.25 }), quantity: 2 };
    expect(positionMetrics(drawing, 0.25, 5, 5001)).toMatchObject({ riskTicks: 10, targetTicks: 20, riskAmount: 25, targetAmount: 50, riskReward: 2, openPnl: 10 });
    expect(positionMetrics(drawing, 0.25, 5, 5001).riskPercent).toBeCloseTo(0.05);
  });

  it("interpolates and extrapolates between persisted source times and logical coordinates", () => {
    const points = [{ plotTime: 10, sourceTime: 100 }, { plotTime: 20, sourceTime: 160 }, { plotTime: 30, sourceTime: 220 }];
    expect(logicalToSourceTime(1.5, points)).toBe(190);
    expect(logicalToSourceTime(4, points)).toBe(340);
    expect(sourceTimeToLogical(190, points)).toBe(1.5);
    expect(sourceTimeToLogical(40, points)).toBe(-1);
  });

  it("validates persisted position geometry", () => {
    const drawing = createPositionDrawing({ id: "position", side: "long", entryPrice: 100, startTime: 100, endTime: 200, minMove: 1 });
    expect(isValidPositionDrawing(drawing)).toBe(true);
    expect(isValidPositionDrawing({ ...drawing, quantity: 1.5 })).toBe(false);
    expect(isValidPositionDrawing({ ...drawing, stopPrice: 101 })).toBe(false);
  });
});
