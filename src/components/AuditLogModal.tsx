import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Database,
  Download,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import type {
  AuditEvent,
  AuditEventCategory,
  AuditEventStatus,
  AuditFilters,
  AuditHealth,
} from "../types";
import { api } from "../lib/bridge";
import { auditStatusLabel, subscribeDemoAudit } from "../lib/audit";

interface AuditLogModalProps {
  onClose: () => void;
  onHealthChange?: (health: AuditHealth) => void;
}

const categories: Array<{ value: "" | AuditEventCategory; label: string }> = [
  { value: "", label: "All activity" },
  { value: "api", label: "API calls" },
  { value: "record", label: "Record changes" },
  { value: "stream", label: "Streams" },
  { value: "system", label: "System" },
];

const statuses: Array<{ value: "" | AuditEventStatus; label: string }> = [
  { value: "", label: "Any status" },
  { value: "error", label: "Errors" },
  { value: "warning", label: "Warnings" },
  { value: "pending", label: "Pending" },
  { value: "success", label: "Successful" },
];

const ranges = [
  { value: "all", label: "All 7 days", milliseconds: 0 },
  { value: "1h", label: "Last hour", milliseconds: 60 * 60 * 1_000 },
  { value: "24h", label: "Last 24 hours", milliseconds: 24 * 60 * 60 * 1_000 },
  { value: "7d", label: "Last 7 days", milliseconds: 7 * 24 * 60 * 60 * 1_000 },
] as const;

function eventMatches(event: AuditEvent, filters: AuditFilters): boolean {
  if (filters.categories.length && !filters.categories.includes(event.category)) return false;
  if (filters.sources.length && !filters.sources.includes(event.source)) return false;
  if (filters.statuses.length && !filters.statuses.includes(event.status)) return false;
  if (filters.startAt && event.startedAt < filters.startAt) return false;
  if (filters.endAt && event.startedAt > filters.endAt) return false;
  const query = filters.search.trim().toLowerCase();
  return !query || [
    event.source, event.operation, event.summary, event.entityType, event.entityId, event.error,
  ].some((value) => value?.toLowerCase().includes(query));
}

function displayTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function elapsed(event: AuditEvent): string {
  if (event.durationMs == null) return event.status === "pending" ? "In progress" : "—";
  if (event.durationMs < 1_000) return `${event.durationMs} ms`;
  return `${(event.durationMs / 1_000).toFixed(event.durationMs < 10_000 ? 1 : 0)} s`;
}

function downloadJson(content: string): void {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `northstar-audit-${stamp}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function JsonEvidence({ title, value }: { title: string; value: unknown }) {
  if (value == null) return null;
  return (
    <section className="audit-evidence">
      <h4>{title}</h4>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function EventDetails({ event }: { event: AuditEvent }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(JSON.stringify(event, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className="audit-event-details">
      <div className="audit-event-metadata">
        <span><small>Event ID</small><code>{event.id}</code></span>
        {event.correlationId && <span><small>Correlation</small><code>{event.correlationId}</code></span>}
        {event.route && <span className="wide"><small>Route</small><code>{event.method ? `${event.method} ` : ""}{event.route}</code></span>}
        {(event.entityType || event.entityId) && <span><small>Entity</small><code>{[event.entityType, event.entityId].filter(Boolean).join(" · ")}</code></span>}
        {event.statusCode != null && <span><small>HTTP status</small><code>{event.statusCode}</code></span>}
        <button type="button" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy event"}</button>
      </div>
      {event.error && <div className="audit-event-error"><AlertTriangle size={14} /><span>{event.error}</span></div>}
      <div className="audit-evidence-grid">
        <JsonEvidence title="Request" value={event.request} />
        <JsonEvidence title="Response" value={event.response} />
        <JsonEvidence title="Record changes" value={event.changes} />
      </div>
    </div>
  );
}

export function AuditLogModal({ onClose, onHealthChange }: AuditLogModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState<"" | AuditEventCategory>("");
  const [status, setStatus] = useState<"" | AuditEventStatus>("");
  const [source, setSource] = useState("");
  const [range, setRange] = useState<(typeof ranges)[number]["value"]>("all");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [total, setTotal] = useState(0);
  const [health, setHealth] = useState<AuditHealth>({ healthy: true, droppedEvents: 0, sessionOnly: !api.isNative });
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string>();
  const [newEvents, setNewEvents] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  const filters = useMemo<AuditFilters>(() => {
    const selectedRange = ranges.find((candidate) => candidate.value === range);
    return {
      search: debouncedSearch,
      categories: category ? [category] : [],
      sources: source ? [source] : [],
      statuses: status ? [status] : [],
      startAt: selectedRange?.milliseconds ? new Date(Date.now() - selectedRange.milliseconds).toISOString() : undefined,
    };
  }, [category, debouncedSearch, range, source, status]);
  const filterKey = JSON.stringify(filters);

  const load = useCallback(async (append = false) => {
    if (append) setLoadingOlder(true);
    else setLoading(true);
    setError("");
    try {
      const page = await api.auditEvents(filters, append ? cursor : undefined, 100);
      setEvents((current) => append
        ? [...current, ...page.events.filter((event) => !current.some((candidate) => candidate.id === event.id))]
        : page.events);
      setCursor(page.nextCursor);
      setTotal(page.total);
      setHealth(page.health);
      onHealthChange?.(page.health);
      if (!append) setNewEvents(0);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
      setLoadingOlder(false);
    }
  }, [cursor, filterKey, onHealthChange]);

  useEffect(() => { void load(false); }, [filterKey]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const acceptEvent = (event: AuditEvent) => {
      if (!eventMatches(event, filters)) return;
      const nearTop = (scrollRef.current?.scrollTop ?? 0) < 24;
      if (nearTop) {
        setEvents((current) => {
          const existed = current.some((candidate) => candidate.id === event.id);
          if (!existed) setTotal((count) => count + 1);
          return [event, ...current.filter((candidate) => candidate.id !== event.id)].slice(0, 100);
        });
      } else {
        setNewEvents((current) => current + 1);
      }
    };
    if (!api.isNative) return subscribeDemoAudit(acceptEvent);
    let unlistenEvent: (() => void) | undefined;
    let unlistenHealth: (() => void) | undefined;
    void listen<AuditEvent>("audit-event-created", ({ payload }) => acceptEvent(payload)).then((unlisten) => { unlistenEvent = unlisten; });
    void listen<AuditHealth>("audit-health-changed", ({ payload }) => {
      setHealth(payload);
      onHealthChange?.(payload);
    }).then((unlisten) => { unlistenHealth = unlisten; });
    return () => {
      unlistenEvent?.();
      unlistenHealth?.();
    };
  }, [filterKey, onHealthChange]);

  const knownSources = useMemo(
    () => [...new Set(events.map((event) => event.source))].sort(),
    [events],
  );
  const visibleErrors = events.filter((event) => event.status === "error").length;

  const exportLog = async () => {
    setExporting(true);
    try {
      downloadJson(await api.exportAuditEvents(filters));
    } catch (reason) {
      setError(`Could not export the audit log: ${String(reason)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="audit-log-backdrop" role="presentation">
      <section ref={dialogRef} className="audit-log-modal" role="dialog" aria-modal="true" aria-labelledby="audit-log-title">
        <header className="audit-log-header">
          <div>
            <span><Activity size={14} /> Diagnostics</span>
            <h2 id="audit-log-title">Audit log</h2>
            <p>API activity and saved record changes on this device.</p>
          </div>
          <div className="audit-log-header-actions">
            <button type="button" className="audit-export-button" disabled={exporting} onClick={exportLog}>
              {exporting ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
              {exporting ? "Exporting" : "Export JSON"}
            </button>
            <button ref={closeRef} type="button" className="audit-close-button" aria-label="Close audit log" onClick={onClose}><X size={18} /></button>
          </div>
        </header>

        <div className="audit-log-status-strip">
          <span className={health.healthy ? "healthy" : "degraded"}><i />{health.healthy ? "Logging healthy" : "Logging degraded"}</span>
          <span><Database size={12} /><strong>{total.toLocaleString()}</strong> matching events</span>
          <span><AlertTriangle size={12} /><strong>{visibleErrors}</strong> errors loaded</span>
          <span><Clock3 size={12} />7 days · 10,000 maximum</span>
          <em>{health.sessionOnly ? "Session-only browser demo" : "Local device only"}</em>
        </div>

        {!health.healthy && (
          <div className="audit-health-warning" role="alert">
            <AlertTriangle size={15} />
            <div><strong>Some diagnostic events may be missing</strong><span>{health.lastError ?? "The local audit writer is unavailable."} {health.droppedEvents ? `${health.droppedEvents} event${health.droppedEvents === 1 ? "" : "s"} dropped.` : ""}</span></div>
          </div>
        )}

        <div className="audit-filter-bar">
          <label className="audit-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search actions, entities, errors…" aria-label="Search audit log" /></label>
          <label><span>Activity</span><select value={category} onChange={(event) => setCategory(event.target.value as "" | AuditEventCategory)}>{categories.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as "" | AuditEventStatus)}>{statuses.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="">All sources</option>{knownSources.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>Range</span><select value={range} onChange={(event) => setRange(event.target.value as typeof range)}>{ranges.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        </div>

        {newEvents > 0 && <button type="button" className="audit-new-events" onClick={() => { scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }); void load(false); }}>{newEvents} new event{newEvents === 1 ? "" : "s"} · Show latest</button>}

        <div ref={scrollRef} className="audit-event-scroll">
          <div className="audit-event-columns" aria-hidden="true"><span>Time / status</span><span>Source</span><span>Operation</span><span>Evidence</span><span>Duration</span><span /></div>
          {loading ? (
            <div className="audit-log-state"><LoaderCircle className="spin" size={20} /><strong>Loading audit events</strong><span>Reading local diagnostic history…</span></div>
          ) : error ? (
            <div className="audit-log-state error" role="alert"><AlertTriangle size={20} /><strong>Audit events could not be loaded</strong><span>{error}</span><button type="button" onClick={() => void load(false)}>Retry</button></div>
          ) : !events.length ? (
            <div className="audit-log-state"><Activity size={20} /><strong>No matching activity</strong><span>Try a broader filter, or use the app to generate diagnostic events.</span></div>
          ) : events.map((event) => {
            const open = expanded === event.id;
            return (
              <article key={event.id} className={`audit-event ${event.status}${open ? " expanded" : ""}`}>
                <button type="button" className="audit-event-summary" aria-expanded={open} onClick={() => setExpanded(open ? undefined : event.id)}>
                  <span className="audit-event-time"><time dateTime={event.startedAt}>{displayTime(event.startedAt)}</time><small className={event.status}><i />{auditStatusLabel(event.status)}</small></span>
                  <span className="audit-event-source">{event.source}<small>{event.category}</small></span>
                  <span className="audit-event-operation"><strong>{event.operation}</strong><small>{event.summary}</small></span>
                  <span className="audit-event-entity">{event.entityType || event.recordCount != null ? <><strong>{event.entityType ?? "Records"}</strong><small>{event.entityId ?? `${event.recordCount} record${event.recordCount === 1 ? "" : "s"}`}</small></> : <small>—</small>}</span>
                  <span className="audit-event-duration">{elapsed(event)}</span>
                  <ChevronDown size={14} />
                </button>
                {open && <EventDetails event={event} />}
              </article>
            );
          })}
          {!loading && cursor && <button type="button" className="audit-load-older" disabled={loadingOlder} onClick={() => void load(true)}>{loadingOlder ? <LoaderCircle className="spin" size={14} /> : <Clock3 size={14} />}{loadingOlder ? "Loading older events" : "Load older events"}</button>}
        </div>
      </section>
    </div>
  );
}
