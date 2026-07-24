import { useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarRange, RefreshCw } from "lucide-react";
import { api } from "../lib/bridge";
import { JOURNAL_TIME_ZONE, journalDate, journalStats } from "../lib/journal";
import type { JournalScope, JournalStatsBreakdown, JournalStatsDay, JournalStatsRange } from "../types";

export type JournalStatsPreset = "month" | "30d" | "90d" | "ytd" | "all" | "custom";
export type JournalStatsMode = "pnl" | "r";

interface TradeJournalStatsProps {
  scope?: JournalScope;
  refreshKey: number;
  onDay: (date: string) => void;
  onTrade: (tradeId: string) => void;
}

const shortDate = new Intl.DateTimeFormat("en-US", {
  timeZone: JOURNAL_TIME_ZONE,
  month: "short",
  day: "numeric",
});
const fullDate = new Intl.DateTimeFormat("en-US", {
  timeZone: JOURNAL_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
});

function money(value?: number, dash = "—"): string {
  if (value == null || !Number.isFinite(value)) return dash;
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function multiple(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function percent(value?: number): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function ratio(value?: number): string {
  if (value == null) return "—";
  return Number.isFinite(value) ? value.toFixed(2) : "∞";
}

function metricClass(value?: number): string {
  return value == null || value === 0 ? "" : value > 0 ? "positive" : "negative";
}

function duration(minutes?: number): string {
  if (minutes == null) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function isoShift(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function presetRange(preset: JournalStatsPreset, today: string, customStart: string, customEnd: string) {
  if (preset === "all") return { startDate: undefined, endDate: undefined };
  if (preset === "custom") return { startDate: customStart || undefined, endDate: customEnd || undefined };
  if (preset === "month") return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
  if (preset === "30d") return { startDate: isoShift(today, -29), endDate: today };
  if (preset === "90d") return { startDate: isoShift(today, -89), endDate: today };
  return { startDate: `${today.slice(0, 4)}-01-01`, endDate: today };
}

function rangeLabel(range?: JournalStatsRange): string {
  if (!range?.startDate && !range?.endDate) return "All recorded trades";
  if (!range.startDate || !range.endDate) return range.startDate ? `From ${fullDate.format(new Date(`${range.startDate}T12:00:00Z`))}` : `Through ${fullDate.format(new Date(`${range.endDate}T12:00:00Z`))}`;
  const start = fullDate.format(new Date(`${range.startDate}T12:00:00Z`));
  const end = fullDate.format(new Date(`${range.endDate}T12:00:00Z`));
  return range.startDate === range.endDate ? start : `${start} – ${end}`;
}

function StatsChart({ days, mode, onDay }: { days: JournalStatsDay[]; mode: JournalStatsMode; onDay: (date: string) => void }) {
  const width = 1000;
  const height = 330;
  const left = 64;
  const right = 20;
  const top = 24;
  const lineBottom = 218;
  const barTop = 248;
  const barBottom = 304;
  const plotWidth = width - left - right;
  const cumulative = days.map((day) => mode === "pnl" ? day.cumulativePnl : day.cumulativeR ?? 0);
  const daily = days.map((day) => mode === "pnl" ? day.netPnl : day.totalR ?? 0);
  const domain = [...cumulative, 0];
  let min = Math.min(...domain);
  let max = Math.max(...domain);
  if (min === max) { min -= 1; max += 1; }
  const padding = (max - min) * 0.12;
  min -= padding;
  max += padding;
  const x = (index: number) => days.length === 1 ? left + plotWidth / 2 : left + index / (days.length - 1) * plotWidth;
  const y = (value: number) => top + (max - value) / (max - min) * (lineBottom - top);
  const zeroY = y(0);
  const points = cumulative.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const area = days.length ? `M ${x(0)} ${zeroY} L ${points.replaceAll(",", " ")} L ${x(days.length - 1)} ${zeroY} Z` : "";
  const maxDaily = Math.max(1, ...daily.map((value) => Math.abs(value)));
  const barWidth = Math.max(3, Math.min(20, plotWidth / Math.max(days.length, 1) * 0.54));
  const gridValues = Array.from({ length: 5 }, (_, index) => max - (max - min) * index / 4);
  const labelIndexes = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])].filter((index) => index >= 0);

  return <div className="journal-stats-chart-wrap">
    <svg className="journal-stats-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Cumulative ${mode === "pnl" ? "net P and L" : "R multiple"} by journal day`}>
      <defs>
        <linearGradient id={`stats-area-${mode}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity=".24" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {gridValues.map((value) => <g key={value}>
        <line className="stats-grid-line" x1={left} y1={y(value)} x2={width - right} y2={y(value)} />
        <text className="stats-axis-label" x={left - 12} y={y(value) + 3} textAnchor="end">{mode === "pnl" ? money(value).replace(".00", "") : `${value.toFixed(1)}R`}</text>
      </g>)}
      <line className="stats-zero-line" x1={left} y1={zeroY} x2={width - right} y2={zeroY} />
      <path className="stats-equity-area" d={area} fill={`url(#stats-area-${mode})`} />
      <polyline className="stats-equity-line" points={points} />
      {days.map((day, index) => {
        const value = cumulative[index];
        return <circle
          key={day.date}
          className="stats-chart-point"
          cx={x(index)}
          cy={y(value)}
          r={4}
          role="button"
          tabIndex={0}
          aria-label={`${fullDate.format(new Date(`${day.date}T12:00:00Z`))}: ${mode === "pnl" ? money(value) : multiple(value)} cumulative. Open day.`}
          onClick={() => onDay(day.date)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onDay(day.date); }}
        ><title>{`${shortDate.format(new Date(`${day.date}T12:00:00Z`))} · ${mode === "pnl" ? money(day.netPnl) : multiple(day.totalR)} · ${day.trades} trade${day.trades === 1 ? "" : "s"}`}</title></circle>;
      })}
      <line className="stats-bar-baseline" x1={left} y1={(barTop + barBottom) / 2} x2={width - right} y2={(barTop + barBottom) / 2} />
      {daily.map((value, index) => {
        const middle = (barTop + barBottom) / 2;
        const barHeight = Math.abs(value) / maxDaily * (barBottom - barTop) / 2;
        return <rect
          key={days[index].date}
          className={`stats-daily-bar ${metricClass(value)}`}
          x={x(index) - barWidth / 2}
          y={value >= 0 ? middle - barHeight : middle}
          width={barWidth}
          height={Math.max(value === 0 ? 1 : 2, barHeight)}
          rx={1.5}
          onClick={() => onDay(days[index].date)}
        ><title>{`${shortDate.format(new Date(`${days[index].date}T12:00:00Z`))} · ${mode === "pnl" ? money(value) : multiple(days[index].totalR)}`}</title></rect>;
      })}
      {labelIndexes.map((index) => <text key={index} className="stats-date-label" x={x(index)} y={height - 5} textAnchor={index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}>{shortDate.format(new Date(`${days[index].date}T12:00:00Z`))}</text>)}
    </svg>
  </div>;
}

function Breakdown({ title, note, items, mode, limit = 8 }: { title: string; note: string; items: JournalStatsBreakdown[]; mode: JournalStatsMode; limit?: number }) {
  const visible = items.slice(0, limit);
  const max = Math.max(1, ...visible.map((item) => Math.abs(mode === "pnl" ? item.netPnl : item.totalR ?? 0)));
  return <section className="journal-stats-breakdown">
    <header><div><h3>{title}</h3><p>{note}</p></div><span>{items.length} groups</span></header>
    {visible.length ? <div className="journal-stats-breakdown-table">
      <div className="head"><span>Group</span><span>Trades</span><span>Win</span><span>Avg</span><span>{mode === "pnl" ? "Net" : "Total R"}</span></div>
      {visible.map((item) => {
        const value = mode === "pnl" ? item.netPnl : item.totalR;
        return <div className="row" key={item.key}>
          <span className="label">{item.label}<i><b className={metricClass(value)} style={{ width: `${Math.abs(value ?? 0) / max * 100}%` }} /></i></span>
          <span>{item.trades}</span><span>{percent(item.winRate)}</span><span className={metricClass(item.averageTrade)}>{money(item.averageTrade)}</span><strong className={metricClass(value)}>{mode === "pnl" ? money(value) : multiple(value)}</strong>
        </div>;
      })}
    </div> : <p className="journal-stats-no-groups">No closed trades in this range.</p>}
  </section>;
}

export function TradeJournalStats({ scope, refreshKey, onDay, onTrade }: TradeJournalStatsProps) {
  const today = journalDate(new Date().toISOString());
  const [preset, setPreset] = useState<JournalStatsPreset>("month");
  const [mode, setMode] = useState<JournalStatsMode>("pnl");
  const [customStart, setCustomStart] = useState(`${today.slice(0, 7)}-01`);
  const [customEnd, setCustomEnd] = useState(today);
  const [range, setRange] = useState<JournalStatsRange>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const dates = useMemo(() => presetRange(preset, today, customStart, customEnd), [preset, today, customStart, customEnd]);
  const invalidRange = Boolean(dates.startDate && dates.endDate && dates.startDate > dates.endDate);

  useEffect(() => {
    let disposed = false;
    if (!scope || invalidRange) { setRange(undefined); setLoading(false); return; }
    setLoading(true);
    setError(undefined);
    api.journalStatsTrades(scope, dates.startDate, dates.endDate)
      .then((next) => { if (!disposed) setRange(next); })
      .catch((reason) => { if (!disposed) setError(String(reason)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [scope?.accountId, scope?.environment, dates.startDate, dates.endDate, invalidRange, refreshKey]);

  const stats = useMemo(() => journalStats(range?.trades ?? []), [range]);
  const metrics = stats.metrics;
  const initialLoading = loading && !range;
  const presets: Array<[JournalStatsPreset, string]> = [["month", "This month"], ["30d", "30D"], ["90d", "90D"], ["ytd", "YTD"], ["all", "All"], ["custom", "Custom"]];

  return <div className="journal-stats-page">
    <div className="journal-stats-heading">
      <div><span>Performance statistics</span><h1>Stats</h1><p>{rangeLabel(range)}</p></div>
      <div className="journal-mode-toggle"><button className={mode === "pnl" ? "active" : ""} onClick={() => setMode("pnl")}>$ P&amp;L</button><button className={mode === "r" ? "active" : ""} onClick={() => setMode("r")}>R</button></div>
    </div>
    <div className="journal-stats-filters" aria-label="Stats date range">
      <div>{presets.map(([value, label]) => <button key={value} className={preset === value ? "active" : ""} onClick={() => setPreset(value)}>{label}</button>)}</div>
      {preset === "custom" && <div className="journal-stats-custom">
        <label><span>From</span><input type="date" value={customStart} max={customEnd || today} onChange={(event) => setCustomStart(event.target.value)} /></label>
        <label><span>To</span><input type="date" value={customEnd} min={customStart} max={today} onChange={(event) => setCustomEnd(event.target.value)} /></label>
      </div>}
    </div>
    {invalidRange && <div className="journal-stats-inline-error">Choose an end date on or after the start date.</div>}
    {initialLoading && <div className="journal-stats-loading"><RefreshCw size={18} className="spin" />Loading performance history…</div>}
    {error && <div className="journal-stats-inline-error">{error}</div>}
    {scope && !initialLoading && range && !invalidRange && (!metrics.closedTrades ? <div className="journal-stats-empty"><BarChart3 size={24} /><strong>No closed trades in this range</strong><span>{metrics.openTrades ? `${metrics.openTrades} open trade${metrics.openTrades === 1 ? " is" : "s are"} excluded from realized statistics.` : "Choose a broader date range or sync the journal."}</span></div> : <>
      <dl className="journal-stats-kpis">
        <div><dt>Net P&amp;L</dt><dd className={metricClass(metrics.netPnl)}>{money(metrics.netPnl)}</dd><small>{money(metrics.grossPnl)} gross · {money(-metrics.fees)} fees</small></div>
        <div><dt>Total R</dt><dd className={metricClass(metrics.totalR)}>{multiple(metrics.totalR)}</dd><small>{metrics.rTrades} of {metrics.closedTrades} trades covered</small></div>
        <div><dt>Closed trades</dt><dd>{metrics.closedTrades}</dd><small>{metrics.openTrades ? `${metrics.openTrades} open excluded` : "Realized campaigns"}</small></div>
        <div><dt>Win rate</dt><dd>{percent(metrics.winRate)}</dd><small>{ratio(metrics.payoffRatio)} payoff ratio</small></div>
        <div><dt>Profit factor</dt><dd>{ratio(metrics.profitFactor)}</dd><small>{money(metrics.expectancy)} expectancy</small></div>
      </dl>
      <section className="journal-stats-primary">
        <header><div><span>Equity curve</span><h2>{mode === "pnl" ? "Cumulative net P&L" : "Cumulative R"}</h2></div><p>Daily bars use entry date · select a point to open that ledger day</p></header>
        <StatsChart days={stats.days} mode={mode} onDay={onDay} />
      </section>
      <section className="journal-stats-outcomes">
        <header><div><span>Outcome profile</span><h2>Trade quality and risk</h2></div><p>Realized trades ordered by close time</p></header>
        <dl>
          <div><dt>Max drawdown</dt><dd className="negative">{mode === "pnl" ? money(-metrics.maxDrawdown) : multiple(metrics.maxDrawdownR == null ? undefined : -metrics.maxDrawdownR)}</dd></div>
          <div><dt>Average win</dt><dd className="positive">{money(metrics.averageWin)}</dd></div>
          <div><dt>Average loss</dt><dd className="negative">{money(metrics.averageLoss)}</dd></div>
          <div><dt>Average hold</dt><dd>{duration(metrics.averageHoldMinutes)}</dd></div>
          <div><dt>Win streak</dt><dd>{metrics.longestWinStreak}</dd></div>
          <div><dt>Loss streak</dt><dd>{metrics.longestLossStreak}</dd></div>
          <button disabled={!metrics.largestWin} onClick={() => metrics.largestWin && onTrade(metrics.largestWin.id)}><dt>Largest win</dt><dd className="positive">{money(metrics.largestWin?.netPnl)}</dd><small>{metrics.largestWin?.symbol ?? "—"}</small></button>
          <button disabled={!metrics.largestLoss} onClick={() => metrics.largestLoss && onTrade(metrics.largestLoss.id)}><dt>Largest loss</dt><dd className="negative">{money(metrics.largestLoss?.netPnl)}</dd><small>{metrics.largestLoss?.symbol ?? "—"}</small></button>
        </dl>
      </section>
      <div className="journal-stats-breakdowns">
        <div className="journal-stats-breakdown-column">
          <Breakdown title="By symbol" note="Performance by traded contract" items={stats.symbols} mode={mode} />
          <Breakdown title="By setup tag" note="Tags overlap; totals are non-additive" items={stats.tags} mode={mode} />
        </div>
        <div className="journal-stats-breakdown-column">
          <Breakdown title="By direction" note="Long and short campaigns" items={stats.directions} mode={mode} />
          <Breakdown title="By entry hour" note="New York time" items={stats.entryHours} mode={mode} limit={24} />
        </div>
      </div>
    </>)}
    {!scope && <div className="journal-stats-empty"><CalendarRange size={24} /><strong>No journal account selected</strong><span>Sync an account to begin tracking performance.</span></div>}
  </div>;
}
