import { useEffect, useRef, useState } from "react";
import { api } from "../lib/bridge";
import { ETF_TRACKER_SYMBOLS, etfTrackerView } from "../lib/etfTracker";
import { EtfTrackerLoader, type EtfTrackerState } from "../lib/etfTrackerLoader";

interface EtfTrackerProps {
  accountId?: string;
  accountLabel?: string;
  connected: boolean;
  authEpoch: number;
  today: string;
  refreshKey: number;
  onRefreshingChange: (refreshing: boolean) => void;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
function displayDate(date: string) { return dateFormatter.format(new Date(`${date}T12:00:00Z`)); }
const timeFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function EtfTracker({ accountId, accountLabel, connected, authEpoch, today, refreshKey, onRefreshingChange }: EtfTrackerProps) {
  const [state, setState] = useState<EtfTrackerState>({ snapshot: null, loading: true, refreshing: false, stale: true });
  const loader = useRef<EtfTrackerLoader | null>(null);
  useEffect(() => {
    const current = new EtfTrackerLoader(api, accountId, connected, setState);
    loader.current = current;
    void current.load();
    const timer = window.setInterval(() => { void current.refresh(); }, 60_000);
    return () => { current.dispose(); window.clearInterval(timer); loader.current = null; };
  }, [accountId, connected, authEpoch]);
  useEffect(() => { if (refreshKey) void loader.current?.refresh(); }, [refreshKey]);
  useEffect(() => { onRefreshingChange(state.refreshing); }, [state.refreshing, onRefreshingChange]);
  useEffect(() => () => onRefreshingChange(false), [onRefreshingChange]);

  const snapshot = state.accountId === accountId ? state.snapshot : null;
  const stale = state.stale || !connected || !snapshot;
  const loading = state.loading || state.accountId !== accountId;
  const source = stale ? api.isNative ? "Stale" : "Demo · stale" : api.isNative ? "Live" : "Demo data";
  const accountHeading = accountLabel ? /^Schwab\b/i.test(accountLabel) ? accountLabel : `Schwab · ${accountLabel}` : "Schwab account";

  return (
    <section className="etf-tracker" aria-labelledby="etf-tracker-title" aria-busy={state.refreshing || loading}>
      <header>
        <div><h2 id="etf-tracker-title">ETF 31-day tracker</h2><p>{accountHeading}<span>Full close = day 0 · New York dates</span></p></div>
        <div className="etf-tracker-freshness"><span className={stale ? "stale" : snapshot?.status ?? "loading"}>{state.refreshing ? "Refreshing" : loading ? "Loading" : source}</span><small>{snapshot ? `Updated ${timeFormatter.format(new Date(snapshot.fetchedAt))} ET` : "Not updated"}</small></div>
      </header>
      {state.error && <p className="etf-tracker-notice" role="status">{state.error}{snapshot ? " Showing the last saved values; countdown status is unverified." : ""}</p>}
      <div className="etf-tracker-table-wrap">
        <table>
          <thead><tr><th>ETF</th><th>Last fully closed</th><th>Days elapsed</th><th>Day-31 date</th><th>Status</th></tr></thead>
          <tbody>{ETF_TRACKER_SYMBOLS.map((symbol) => {
            const row = snapshot?.rows.find((item) => item.symbol === symbol);
            const view = etfTrackerView(row, today, stale);
            const noClose = row && !row.lastClosedDate && !row.availabilityReason;
            return <tr key={symbol}>
              <th scope="row">{symbol}</th>
              <td>{row?.lastClosedDate ? <time dateTime={row.lastClosedDate}>{displayDate(row.lastClosedDate)}</time> : noClose ? <span className="etf-tracker-no-close">No full close found in available history</span> : "—"}</td>
              <td>{view.daysElapsed === null ? "—" : `${view.daysElapsed} ${view.daysElapsed === 1 ? "day" : "days"}`}</td>
              <td>{view.day31Date ? <time dateTime={view.day31Date}>{displayDate(view.day31Date)}</time> : "—"}</td>
              <td><span className={`etf-tracker-status ${loading && !snapshot ? "unavailable" : view.status}`}>{loading && !snapshot ? "Loading history…" : !snapshot ? "History unavailable" : view.label}</span>{row?.availabilityReason && <small className="etf-tracker-row-reason">{row.availabilityReason}</small>}{row && Math.abs(row.quantity) > 0.00000001 && <small className="etf-tracker-row-reason">{Math.abs(row.quantity).toLocaleString("en-US", { maximumFractionDigits: 8 })} shares{row.quantity < 0 ? " short" : " held"}</small>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <footer>{snapshot ? `History: ${displayDate(snapshot.coverageStart)} – ${displayDate(snapshot.coverageEnd)}` : "365 days of account history"}<span>Partial sales do not restart the timer</span></footer>
    </section>
  );
}
