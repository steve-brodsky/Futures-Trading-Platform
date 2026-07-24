import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertTriangle, CalendarDays, ExternalLink, RefreshCw, X } from "lucide-react";
import type { EconomicEventImportance, TradingTodaySnapshot } from "../types";
import { eventState, formatEventTime, formatHolidayDate, newYorkDateHeading } from "../lib/tradingToday";

export type TradingTodaySource = "calendar" | "nyse" | "cme";

interface TradingTodayModalProps {
  date: string;
  snapshot: TradingTodaySnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  warning?: string;
  onRefresh: () => void;
  onOpenSource: (source: TradingTodaySource) => void;
  onClose: () => void;
}

function impactLabel(importance: EconomicEventImportance): string {
  return importance === 3 ? "High impact" : importance === 2 ? "Medium impact" : importance === 1 ? "Low impact" : "Impact unknown";
}

function statusLabel(status: "closed" | "early-close" | "modified-hours"): string {
  return status === "early-close" ? "Early close" : status === "modified-hours" ? "Modified" : "Closed";
}

export function TradingTodayModal({
  date,
  snapshot,
  loading,
  refreshing,
  error,
  warning,
  onRefresh,
  onOpenSource,
  onClose,
}: TradingTodayModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [now, setNow] = useState(Date.now());
  const heading = newYorkDateHeading(new Date(`${date}T12:00:00Z`));
  const comma = heading.indexOf(",");
  const weekday = heading.slice(0, comma);
  const calendarDate = heading.slice(comma + 1).trim();
  const states = useMemo(() => eventState(snapshot?.events ?? [], now), [snapshot?.events, now]);
  const events = useMemo(
    () => [...(snapshot?.events ?? [])].sort((left, right) => Date.parse(left.occursAt) - Date.parse(right.occursAt)),
    [snapshot?.events],
  );

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("keydown", onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, []);

  const cacheStatus = snapshot?.status === "demo"
    ? "Demo data"
    : snapshot?.status === "cache"
      ? "Cached"
      : "Live";
  const verifiedRangeExpired = Boolean(snapshot && date > snapshot.holidayVerifiedThrough);

  return (
    <div className="trading-today-backdrop" role="presentation">
      <section ref={dialogRef} className="trading-today-modal" role="dialog" aria-modal="true" aria-labelledby="trading-today-title" tabIndex={-1}>
        <header className="trading-today-header">
          <div className="trading-today-kicker"><CalendarDays size={14} /><span>Trading Today</span></div>
          <button ref={closeRef} type="button" className="trading-today-close" aria-label="Close Trading Today" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="trading-today-summary">
          <div className="trading-today-date">
            <span>{weekday}</span>
            <h1 id="trading-today-title">{calendarDate}</h1>
            <p>New York time · U.S. economic calendar</p>
          </div>
          <section className="trading-today-holidays" aria-labelledby="trading-today-holidays-title">
            <header>
              <span>Upcoming market schedule</span>
              {verifiedRangeExpired ? (
                <button type="button" className="holiday-coverage-warning" onClick={() => onOpenSource("cme")}>
                  CME schedule update required <ExternalLink size={9} />
                </button>
              ) : <small>Next 4 dates</small>}
            </header>
            <h2 id="trading-today-holidays-title" className="sr-only">Upcoming market schedule</h2>
            {snapshot?.holidays.length ? snapshot.holidays.map((holiday) => {
              const display = formatHolidayDate(holiday.date);
              return (
                <article key={holiday.date}>
                  <time dateTime={holiday.date}><strong>{display.day}</strong><span>{display.month}<small>{display.weekday}</small></span></time>
                  <div className="trading-today-holiday-name"><strong>{holiday.name}</strong><span>{holiday.venues.map((venue) => venue.venue).join(" · ")}</span></div>
                  <div className="trading-today-venue-statuses">
                    {holiday.venues.map((venue) => (
                      <button key={venue.venue} type="button" className={`venue-status ${venue.status}`} title={`${venue.venue}: ${venue.detail}`} onClick={() => onOpenSource(venue.venue === "NYSE" ? "nyse" : "cme")}>
                        <b>{venue.venue}</b><span>{statusLabel(venue.status)}</span>
                      </button>
                    ))}
                  </div>
                </article>
              );
            }) : (
              <div className="trading-today-holidays-empty">
                {verifiedRangeExpired ? "Schedule update required" : snapshot ? "No upcoming schedule changes in the published range" : "Loading venue schedules…"}
              </div>
            )}
          </section>
        </div>

        {(warning || (error && snapshot)) && (
          <div className="trading-today-notice" role="status"><AlertTriangle size={14} /><span>{warning ?? error}</span></div>
        )}

        <section className="trading-today-events" aria-labelledby="trading-today-events-title">
          <header>
            <div><span>United States</span><h2 id="trading-today-events-title">Economic events</h2></div>
            <div className="trading-today-data-state"><i className={snapshot?.status ?? "loading"} />{snapshot ? cacheStatus : "Loading"}</div>
          </header>

          {loading && !snapshot ? (
            <div className="trading-today-loading" role="status"><i /><strong>Loading today’s calendar</strong><span>Checking Trading Economics and venue schedules…</span></div>
          ) : error && !snapshot ? (
            <div className="trading-today-error" role="alert">
              <AlertTriangle size={22} />
              <strong>Today’s events are unavailable</strong>
              <p>{error}</p>
              <div><button type="button" onClick={onRefresh}><RefreshCw size={13} />Retry</button><button type="button" onClick={() => onOpenSource("calendar")}><ExternalLink size={13} />Open source</button></div>
            </div>
          ) : events.length ? (
            <div className="trading-today-table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Event</th><th>Actual</th><th>Consensus</th><th>Previous</th><th>Forecast</th></tr></thead>
                <tbody>
                  {events.map((event, index) => (
                    <tr key={event.id} className={states[event.id]} style={{ "--event-index": index } as CSSProperties}>
                      <td><time dateTime={event.occursAt}>{formatEventTime(event.occursAt)}</time><i className={`impact impact-${event.importance ?? "unknown"}`} title={impactLabel(event.importance)} aria-label={impactLabel(event.importance)} /></td>
                      <td><strong>{event.title}</strong>{event.reference && <small>{event.reference}</small>}</td>
                      <td className={event.actual ? "has-value" : ""}>{event.actual || "—"}</td>
                      <td>{event.consensus || "—"}</td>
                      <td>{event.previous || "—"}</td>
                      <td>{event.forecast || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="trading-today-empty"><CalendarDays size={21} /><strong>No U.S. events scheduled today</strong><span>The calendar is clear for this New York trading day.</span></div>
          )}
        </section>

        <footer className="trading-today-footer">
          <div>
            <button type="button" onClick={() => onOpenSource("calendar")}>Data: Trading Economics <ExternalLink size={11} /></button>
            <span>{snapshot ? `Updated ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(snapshot.fetchedAt))} ET` : "Not updated"}</span>
          </div>
          <button type="button" className="trading-today-refresh" disabled={refreshing} onClick={onRefresh}><RefreshCw size={14} className={refreshing ? "rotating" : ""} />{refreshing ? "Refreshing" : "Refresh"}</button>
        </footer>
      </section>
    </div>
  );
}
