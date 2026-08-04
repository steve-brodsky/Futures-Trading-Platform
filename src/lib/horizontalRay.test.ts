import { describe, expect, it } from "vitest";
import { nearestChartTime, parseDrawingPriceDraft } from "./horizontalRay";

describe("horizontal ray timeframe mapping", () => {
  it("maps an anchor to the nearest available bar time", () => {
    expect(nearestChartTime(180, [100, 200, 300])).toBe(200);
    expect(nearestChartTime(140, [100, 200, 300])).toBe(100);
  });

  it("clamps anchors outside the loaded chart range", () => {
    expect(nearestChartTime(10, [100, 200])).toBe(100);
    expect(nearestChartTime(300, [100, 200])).toBe(200);
  });
});

describe("horizontal drawing price input", () => {
  it("accepts integer and decimal prices on the instrument tick", () => {
    expect(parseDrawingPriceDraft("6260", 0.25)).toEqual({ ok: true, price: 6260 });
    expect(parseDrawingPriceDraft(" 6260.25 ", 0.25)).toEqual({ ok: true, price: 6260.25 });
  });

  it("tolerates floating point representations and normalizes the result", () => {
    expect(parseDrawingPriceDraft(String(0.1 + 0.2), 0.1)).toEqual({ ok: true, price: 0.3 });
  });

  it("rejects empty, non-numeric, and off-tick drafts", () => {
    expect(parseDrawingPriceDraft("", 0.25)).toEqual({ ok: false, error: "Enter a price." });
    expect(parseDrawingPriceDraft("not-a-price", 0.25)).toEqual({ ok: false, error: "Enter a valid number." });
    expect(parseDrawingPriceDraft("6260.10", 0.25)).toEqual({ ok: false, error: "Use 0.25 increments." });
  });

  it("rejects an unavailable instrument tick size", () => {
    expect(parseDrawingPriceDraft("100", 0)).toEqual({ ok: false, error: "Price increment is unavailable." });
  });
});
