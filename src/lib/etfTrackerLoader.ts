import type { EtfTrackerSnapshot } from "../types";

export interface EtfTrackerState {
  accountId?: string;
  snapshot: EtfTrackerSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error?: string;
}

interface TrackerApi {
  getEtfTrackerCache(accountId: string): Promise<EtfTrackerSnapshot | null>;
  refreshEtfTracker(accountId: string): Promise<EtfTrackerSnapshot>;
}

// One loader belongs to one account/auth session. Disposing it also invalidates
// in-flight callbacks, including callbacks from the cache read.
export class EtfTrackerLoader {
  private disposed = false;
  private pending: Promise<void> | null = null;
  private cacheRead: Promise<void> | null = null;
  private state: EtfTrackerState;

  constructor(private api: TrackerApi, private accountId: string | undefined, private connected: boolean, private notify: (state: EtfTrackerState) => void) {
    this.state = { accountId, snapshot: null, loading: Boolean(accountId), refreshing: false, stale: true };
  }

  private update(patch: Partial<EtfTrackerState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.notify(this.state);
  }

  async load() {
    this.update({});
    if (!this.accountId) {
      this.update({ loading: false, error: "Select a Schwab account to load ETF history." });
      return;
    }
    this.cacheRead = this.api.getEtfTrackerCache(this.accountId).then((snapshot) => {
      if (snapshot?.accountId === this.accountId) this.update({ snapshot, loading: false, stale: true });
    }).catch(() => { /* A cache failure must not prevent live data. */ });
    await this.cacheRead;
    this.cacheRead = null;
    if (!this.disposed) await this.refresh();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    if (this.cacheRead) return this.cacheRead.then(() => this.refresh());
    if (!this.accountId || !this.connected) {
      this.update({ loading: false, refreshing: false, stale: true, error: this.accountId ? "Connect Schwab to refresh ETF history." : "Select a Schwab account to load ETF history." });
      return Promise.resolve();
    }
    this.update({ refreshing: true, error: undefined });
    this.pending = this.api.refreshEtfTracker(this.accountId).then((snapshot) => {
      if (snapshot.accountId !== this.accountId) throw new Error("ETF history returned for a different account.");
      this.update({ snapshot, stale: false, error: undefined });
    }).catch((error: unknown) => {
      this.update({ stale: true, error: `Could not refresh ETF history: ${String(error)}` });
    }).finally(() => {
      this.pending = null;
      this.update({ loading: false, refreshing: false });
    });
    return this.pending;
  }

  dispose() { this.disposed = true; }
}
