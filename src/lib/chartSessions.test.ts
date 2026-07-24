import { describe, expect, it } from "vitest";
import { chartMarketSession, chartSessionColor, DEFAULT_CHART_SESSION_SETTINGS, normalizeChartSessionSettings } from "./chartSessions";

const epoch = (iso: string) => Date.parse(iso) / 1000;

describe("chart sessions", () => {
  it("classifies the overnight windows in New York time", () => {
    expect(chartMarketSession(epoch("2026-07-13T21:59:00Z"))).toBe("overnight");
    expect(chartMarketSession(epoch("2026-07-13T22:00:00Z"))).toBe("asia");
    expect(chartMarketSession(epoch("2026-07-14T05:59:00Z"))).toBe("asia");
    expect(chartMarketSession(epoch("2026-07-14T06:00:00Z"))).toBe("london");
    expect(chartMarketSession(epoch("2026-07-14T13:29:00Z"))).toBe("london");
    expect(chartMarketSession(epoch("2026-07-14T13:30:00Z"))).toBe("regular");
    expect(chartMarketSession(epoch("2026-07-14T20:00:00Z"))).toBe("overnight");
  });

  it("uses one color in uniform mode and individual colors by session", () => {
    expect(chartSessionColor("asia", DEFAULT_CHART_SESSION_SETTINGS)).toBe(DEFAULT_CHART_SESSION_SETTINGS.overnightColor);
    const split = { ...DEFAULT_CHART_SESSION_SETTINGS, colorMode: "by-session" as const };
    expect(chartSessionColor("asia", split)).toBe(split.asiaColor);
    expect(chartSessionColor("london", split)).toBe(split.londonColor);
    expect(chartSessionColor("overnight", split)).toBe(split.overnightColor);
  });

  it("repairs invalid saved colors and modes", () => {
    expect(normalizeChartSessionSettings({
      colorMode: "invalid",
      overnightColor: "red",
      asiaColor: "#ABCDEF",
      londonColor: "#12345g",
    })).toEqual({
      ...DEFAULT_CHART_SESSION_SETTINGS,
      asiaColor: "#abcdef",
    });
  });
});
