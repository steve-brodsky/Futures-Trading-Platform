import type {
  AuditEvent,
  AuditEventCategory,
  AuditEventStatus,
  AuditFilters,
  AuditHealth,
  AuditPage,
} from "../types";

const MAX_EVENTS = 10_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DETAIL_LIMIT = 32 * 1024;
const listeners = new Set<(event: AuditEvent) => void>();
let events: AuditEvent[] = [];
let sequence = 0;

const sensitiveKeys = [
  "authorization", "cookie", "password", "secret", "apikey", "appkey", "accesstoken",
  "refreshtoken", "publishablekey", "oauthcode", "clientid", "email", "dataurl", "image",
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return sensitiveKeys.some((candidate) => normalized.includes(candidate));
}

function sanitizeText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:code|token|key|secret|password|email)=)[^&\s]+/gi, "$1[REDACTED]");
}

export function redactAuditValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return sanitizeText(item);
    if (item == null || typeof item !== "object") return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 100) return { recordCount: item.length, preview: item.slice(0, 10).map(visit), truncated: true };
      return item.map(visit);
    }
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, nested]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : visit(nested),
    ]));
  };
  const redacted = visit(value);
  const serialized = JSON.stringify(redacted) ?? "null";
  if (serialized.length <= DETAIL_LIMIT) return redacted;
  return { truncated: true, originalBytes: serialized.length, preview: serialized.slice(0, 4096) };
}

function prune(): void {
  const cutoff = Date.now() - RETENTION_MS;
  events = events.filter((event) => Date.parse(event.startedAt) >= cutoff).slice(0, MAX_EVENTS);
}

function emit(event: AuditEvent): void {
  const index = events.findIndex((candidate) => candidate.id === event.id);
  if (index >= 0) events[index] = event;
  else events.unshift(event);
  prune();
  listeners.forEach((listener) => listener(event));
}

function defaultHealth(): AuditHealth {
  return { healthy: true, droppedEvents: 0, sessionOnly: true };
}

function matches(event: AuditEvent, filters: AuditFilters): boolean {
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

export function demoAuditPage(filters: AuditFilters, cursor?: string, limit = 100): AuditPage {
  const filtered = events.filter((event) => matches(event, filters));
  const cursorSequence = cursor ? Number(cursor) : undefined;
  const available = filtered.filter((event) => cursorSequence == null || event.sequence < cursorSequence);
  const page = available.slice(0, limit);
  return {
    events: page,
    nextCursor: available.length > limit ? String(page.at(-1)?.sequence) : undefined,
    total: filtered.length,
    health: defaultHealth(),
  };
}

export function demoAuditExport(filters: AuditFilters): string {
  const filtered = events.filter((event) => matches(event, filters)).reverse();
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    retention: { days: 7, maximumEvents: MAX_EVENTS },
    filters,
    health: defaultHealth(),
    events: filtered,
  }, null, 2);
}

export function subscribeDemoAudit(listener: (event: AuditEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const recordOperations = new Set([
  "saveWorkspace", "refreshTradingToday", "saveCredentials", "saveSchwabCredentials",
  "setEnvironment", "configureJournal", "disconnectJournal", "setJournalBackfillStart",
  "resetJournalNow", "setJournalCommission", "saveJournalEntryScreenshot",
  "updateJournalAnnotation", "ingestJournalOrders",
]);

export async function auditedDemoCall<T>(
  operation: string,
  args: unknown[],
  call: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const category: AuditEventCategory = recordOperations.has(operation) ? "record" : operation.toLowerCase().includes("stream") ? "stream" : "api";
  const id = crypto.randomUUID();
  const pending: AuditEvent = {
    sequence: ++sequence,
    id,
    startedAt,
    category,
    source: "browser-demo",
    operation,
    status: "pending",
    summary: `${operation} started`,
    request: redactAuditValue(args),
  };
  emit(pending);
  try {
    const result = await call();
    emit({
      ...pending,
      completedAt: new Date().toISOString(),
      status: "success",
      summary: `${operation} completed`,
      durationMs: Math.round(performance.now() - started),
      response: redactAuditValue(result),
      changes: category === "record" ? { operation, input: redactAuditValue(args) } : undefined,
    });
    return result;
  } catch (reason) {
    emit({
      ...pending,
      completedAt: new Date().toISOString(),
      status: "error",
      summary: `${operation} failed`,
      durationMs: Math.round(performance.now() - started),
      error: sanitizeText(String(reason)),
    });
    throw reason;
  }
}

export function instrumentDemoApi<T extends object>(raw: T, excluded: ReadonlySet<string>): T {
  const instrumented: Record<string, unknown> = {};
  Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
    if (typeof value !== "function" || excluded.has(key)) {
      instrumented[key] = value;
      return;
    }
    instrumented[key] = (...args: unknown[]) => auditedDemoCall(
      key,
      args,
      () => Promise.resolve((value as (...values: unknown[]) => unknown).apply(instrumented, args)) as Promise<unknown>,
    );
  });
  return instrumented as T;
}

export function auditStatusLabel(status: AuditEventStatus): string {
  return status === "pending" ? "Pending" : status[0].toUpperCase() + status.slice(1);
}
