import { describe, expect, it, vi } from "vitest";
import type { EtfTrackerSnapshot } from "../types";
import { demoEtfTrackerSnapshot } from "./etfTracker";
import { EtfTrackerLoader, type EtfTrackerState } from "./etfTrackerLoader";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const snapshot = (accountId = "a") => demoEtfTrackerSnapshot(accountId);

describe("ETF account and refresh lifecycle", () => {
  it("shows cache first, refreshes, and suppresses stale completion after failure", async () => {
    const cached = { ...snapshot(), status: "cache" as const };
    const request = deferred<EtfTrackerSnapshot>();
    const api = { getEtfTrackerCache: vi.fn(async () => cached), refreshEtfTracker: vi.fn(() => request.promise) };
    const states: EtfTrackerState[] = [];
    const loader = new EtfTrackerLoader(api, "a", true, (state) => states.push(state));
    const loaded = loader.load();
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({ snapshot: cached, stale: true, loading: false });
    request.resolve(snapshot());
    await loaded;
    expect(states.at(-1)).toMatchObject({ stale: false, loading: false, refreshing: false });
    api.refreshEtfTracker.mockRejectedValueOnce(new Error("Network unavailable"));
    await loader.refresh();
    expect(states.at(-1)).toMatchObject({ stale: true, refreshing: false });
    expect(states.at(-1)?.snapshot?.accountId).toBe("a");
    expect(states.at(-1)?.error).toContain("Network unavailable");
  });

  it.each(["cache", "live"])("discards old-account %s responses after switching accounts", async (phase) => {
    const cache = deferred<EtfTrackerSnapshot | null>();
    const live = deferred<EtfTrackerSnapshot>();
    const api = { getEtfTrackerCache: vi.fn(() => cache.promise), refreshEtfTracker: vi.fn(() => live.promise) };
    const oldNotify = vi.fn();
    const old = new EtfTrackerLoader(api, "a", true, oldNotify);
    const loaded = old.load();
    if (phase === "live") {
      cache.resolve(null);
      await vi.waitFor(() => expect(api.refreshEtfTracker).toHaveBeenCalled());
    }
    old.dispose();
    oldNotify.mockClear();
    const nextNotify = vi.fn();
    const next = new EtfTrackerLoader({ getEtfTrackerCache: async () => null, refreshEtfTracker: async () => snapshot("b") }, "b", true, nextNotify);
    await next.load();
    cache.resolve(snapshot("a"));
    live.resolve(snapshot("a"));
    await loaded;
    expect(oldNotify).not.toHaveBeenCalled();
    expect(nextNotify.mock.lastCall?.[0].snapshot.accountId).toBe("b");
  });

  it("deduplicates simultaneous refreshes and recovers after authentication failure", async () => {
    const notify = vi.fn();
    const api = { getEtfTrackerCache: async () => null, refreshEtfTracker: vi.fn<() => Promise<EtfTrackerSnapshot>>().mockRejectedValueOnce(new Error("Authentication required")) };
    const loader = new EtfTrackerLoader(api, "a", true, notify);
    await loader.load();
    expect(notify.mock.lastCall?.[0]).toMatchObject({ stale: true, refreshing: false });
    const request = deferred<EtfTrackerSnapshot>();
    api.refreshEtfTracker.mockImplementation(() => request.promise);
    const first = loader.refresh();
    expect(loader.refresh()).toBe(first);
    request.resolve(snapshot());
    await first;
    expect(api.refreshEtfTracker).toHaveBeenCalledTimes(2);
    expect(notify.mock.lastCall?.[0].stale).toBe(false);
  });

  it("retains cache while disconnected and rejects mismatched server accounts", async () => {
    const notify = vi.fn();
    const api = { getEtfTrackerCache: async () => snapshot(), refreshEtfTracker: vi.fn(async () => snapshot("b")) };
    await new EtfTrackerLoader(api, "a", false, notify).load();
    expect(api.refreshEtfTracker).not.toHaveBeenCalled();
    expect(notify.mock.lastCall?.[0]).toMatchObject({ stale: true, snapshot: { accountId: "a" } });
    await new EtfTrackerLoader(api, "a", true, notify).load();
    expect(notify.mock.lastCall?.[0].error).toContain("different account");
  });

  it("refreshes even if reading the cache fails", async () => {
    const notify = vi.fn();
    await new EtfTrackerLoader({ getEtfTrackerCache: async () => { throw new Error("Bad cache"); }, refreshEtfTracker: async () => snapshot() }, "a", true, notify).load();
    expect(notify.mock.lastCall?.[0]).toMatchObject({ stale: false, loading: false, snapshot: { accountId: "a" } });
  });
});
