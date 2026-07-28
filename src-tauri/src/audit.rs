use chrono::{Duration as ChronoDuration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{sync_channel, SyncSender, TrySendError},
        Arc, RwLock,
    },
    time::Instant,
};
use tauri::Emitter;

use crate::AppError;

const RETENTION_DAYS: i64 = 7;
const RETENTION_ROWS: i64 = 10_000;
const DETAIL_LIMIT: usize = 32 * 1024;
const WRITER_CAPACITY: usize = 4_096;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub sequence: i64,
    pub id: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub category: String,
    pub source: String,
    pub operation: String,
    pub status: String,
    pub summary: String,
    pub method: Option<String>,
    pub route: Option<String>,
    pub status_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub correlation_id: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub record_count: Option<i64>,
    pub request: Option<Value>,
    pub response: Option<Value>,
    pub changes: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditFilters {
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub statuses: Vec<String>,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    pub events: Vec<AuditEvent>,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub health: AuditHealth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditHealth {
    pub healthy: bool,
    pub dropped_events: u64,
    pub last_error: Option<String>,
    pub last_recovered_at: Option<String>,
    pub session_only: bool,
}

impl Default for AuditHealth {
    fn default() -> Self {
        Self {
            healthy: true,
            dropped_events: 0,
            last_error: None,
            last_recovered_at: None,
            session_only: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuditRecord {
    pub id: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub category: String,
    pub source: String,
    pub operation: String,
    pub status: String,
    pub summary: String,
    pub method: Option<String>,
    pub route: Option<String>,
    pub status_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub correlation_id: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub record_count: Option<i64>,
    pub request: Option<Value>,
    pub response: Option<Value>,
    pub changes: Option<Value>,
    pub error: Option<String>,
}

impl AuditRecord {
    pub fn completed(
        category: &str,
        source: &str,
        operation: &str,
        status: &str,
        summary: impl Into<String>,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            started_at: now.clone(),
            completed_at: Some(now),
            category: category.into(),
            source: source.into(),
            operation: operation.into(),
            status: status.into(),
            summary: summary.into(),
            method: None,
            route: None,
            status_code: None,
            duration_ms: None,
            correlation_id: None,
            entity_type: None,
            entity_id: None,
            record_count: None,
            request: None,
            response: None,
            changes: None,
            error: None,
        }
    }
}

#[derive(Clone)]
pub struct AuditService {
    sender: SyncSender<WriterMessage>,
    health: Arc<RwLock<AuditHealth>>,
    dropped: Arc<AtomicU64>,
}

enum WriterMessage {
    Insert(AuditRecord),
    Complete {
        id: String,
        completed_at: String,
        status: String,
        status_code: Option<i64>,
        duration_ms: i64,
        response: Option<Value>,
        error: Option<String>,
    },
}

pub struct AuditSpan {
    service: AuditService,
    id: String,
    started: Instant,
}

impl AuditSpan {
    pub fn success(self, status_code: Option<u16>, response: Option<Value>) {
        self.service.finish(
            self.id,
            "success",
            status_code,
            response,
            None,
            self.started.elapsed().as_millis() as i64,
        );
    }

    pub fn warning(
        self,
        status_code: Option<u16>,
        response: Option<Value>,
        error: impl Into<String>,
    ) {
        self.service.finish(
            self.id,
            "warning",
            status_code,
            response,
            Some(error.into()),
            self.started.elapsed().as_millis() as i64,
        );
    }

    pub fn error(self, status_code: Option<u16>, error: impl Into<String>) {
        self.service.finish(
            self.id,
            "error",
            status_code,
            None,
            Some(error.into()),
            self.started.elapsed().as_millis() as i64,
        );
    }
}

impl AuditService {
    pub fn new(path: PathBuf, app: tauri::AppHandle) -> Self {
        let (sender, receiver) = sync_channel(WRITER_CAPACITY);
        let health = Arc::new(RwLock::new(AuditHealth::default()));
        let dropped = Arc::new(AtomicU64::new(0));
        let writer_health = health.clone();
        let writer_dropped = dropped.clone();
        std::thread::Builder::new()
            .name("northstar-audit".into())
            .spawn(move || {
                let mut writes = 0usize;
                while let Ok(message) = receiver.recv() {
                    let result = write_message(&path, &message, writes % 50 == 0);
                    match result {
                        Ok(event) => {
                            writes = writes.wrapping_add(1);
                            let recovered_drops = writer_dropped.swap(0, Ordering::Relaxed);
                            let mut next_health = writer_health.write().expect("audit health poisoned");
                            let was_unhealthy = !next_health.healthy;
                            next_health.healthy = true;
                            next_health.dropped_events = 0;
                            if was_unhealthy || recovered_drops > 0 {
                                next_health.last_recovered_at = Some(Utc::now().to_rfc3339());
                            }
                            let health_snapshot = next_health.clone();
                            drop(next_health);
                            let _ = app.emit("audit-event-created", &event);
                            if was_unhealthy || recovered_drops > 0 {
                                let _ = app.emit("audit-health-changed", &health_snapshot);
                                let mut recovery = AuditRecord::completed(
                                    "system",
                                    "audit",
                                    "writer-recovered",
                                    "warning",
                                    format!(
                                        "Audit logging recovered after {recovered_drops} event{} could not be retained",
                                        if recovered_drops == 1 { "" } else { "s" }
                                    ),
                                );
                                recovery.record_count = Some(recovered_drops as i64);
                                if let Ok(event) = write_message(&path, &WriterMessage::Insert(recovery), false) {
                                    let _ = app.emit("audit-event-created", &event);
                                }
                            }
                        }
                        Err(error) => {
                            writer_dropped.fetch_add(1, Ordering::Relaxed);
                            let mut next_health = writer_health.write().expect("audit health poisoned");
                            let changed = next_health.healthy;
                            next_health.healthy = false;
                            next_health.dropped_events = writer_dropped.load(Ordering::Relaxed);
                            next_health.last_error = Some(sanitize_text(&error.to_string()));
                            let snapshot = next_health.clone();
                            drop(next_health);
                            if changed {
                                let _ = app.emit("audit-health-changed", snapshot);
                            }
                        }
                    }
                }
            })
            .expect("failed to start audit writer");
        Self {
            sender,
            health,
            dropped,
        }
    }

    pub fn health(&self) -> AuditHealth {
        let mut health = self.health.read().expect("audit health poisoned").clone();
        health.dropped_events = health
            .dropped_events
            .saturating_add(self.dropped.load(Ordering::Relaxed));
        health
    }

    pub fn begin_api(
        &self,
        source: &str,
        operation: &str,
        method: &str,
        route: &str,
        request: Option<Value>,
        correlation_id: Option<String>,
    ) -> AuditSpan {
        let id = uuid::Uuid::new_v4().to_string();
        let record = AuditRecord {
            id: id.clone(),
            started_at: Utc::now().to_rfc3339(),
            completed_at: None,
            category: "api".into(),
            source: source.into(),
            operation: operation.into(),
            status: "pending".into(),
            summary: format!("{method} {}", sanitize_route(route)),
            method: Some(method.into()),
            route: Some(sanitize_route(route)),
            status_code: None,
            duration_ms: None,
            correlation_id,
            entity_type: None,
            entity_id: None,
            record_count: None,
            request: request.map(redact_value),
            response: None,
            changes: None,
            error: None,
        };
        self.enqueue(WriterMessage::Insert(record));
        AuditSpan {
            service: self.clone(),
            id,
            started: Instant::now(),
        }
    }

    pub fn record(&self, mut record: AuditRecord) {
        record.summary = sanitize_text(&record.summary);
        record.route = record.route.as_deref().map(sanitize_route);
        record.request = record.request.map(redact_value);
        record.response = record.response.map(redact_value);
        record.changes = record.changes.map(redact_value);
        record.error = record.error.as_deref().map(sanitize_text);
        self.enqueue(WriterMessage::Insert(record));
    }

    fn finish(
        &self,
        id: String,
        status: &str,
        status_code: Option<u16>,
        response: Option<Value>,
        error: Option<String>,
        duration_ms: i64,
    ) {
        self.enqueue(WriterMessage::Complete {
            id,
            completed_at: Utc::now().to_rfc3339(),
            status: status.into(),
            status_code: status_code.map(i64::from),
            duration_ms,
            response: response.map(redact_value),
            error: error.as_deref().map(sanitize_text),
        });
    }

    fn enqueue(&self, message: WriterMessage) {
        if let Err(error) = self.sender.try_send(message) {
            match error {
                TrySendError::Full(_) | TrySendError::Disconnected(_) => {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    let mut health = self.health.write().expect("audit health poisoned");
                    health.healthy = false;
                    health.dropped_events = self.dropped.load(Ordering::Relaxed);
                    health.last_error = Some(match error {
                        TrySendError::Full(_) => "Audit writer queue is full".into(),
                        TrySendError::Disconnected(_) => "Audit writer is unavailable".into(),
                    });
                }
            }
        }
    }
}

pub fn init(path: &Path) -> Result<(), AppError> {
    let db = Connection::open(path)?;
    ensure_schema(&db)?;
    prune(&db)?;
    Ok(())
}

fn ensure_schema(db: &Connection) -> Result<(), rusqlite::Error> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            category TEXT NOT NULL,
            source TEXT NOT NULL,
            operation TEXT NOT NULL,
            status TEXT NOT NULL,
            summary TEXT NOT NULL,
            method TEXT,
            route TEXT,
            status_code INTEGER,
            duration_ms INTEGER,
            correlation_id TEXT,
            entity_type TEXT,
            entity_id TEXT,
            record_count INTEGER,
            request_json TEXT,
            response_json TEXT,
            changes_json TEXT,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS audit_events_started ON audit_events(started_at DESC, sequence DESC);
        CREATE INDEX IF NOT EXISTS audit_events_category ON audit_events(category, started_at DESC);
        CREATE INDEX IF NOT EXISTS audit_events_status ON audit_events(status, started_at DESC);
        CREATE INDEX IF NOT EXISTS audit_events_source ON audit_events(source, started_at DESC);
        CREATE INDEX IF NOT EXISTS audit_events_correlation ON audit_events(correlation_id);",
    )
}

fn write_message(
    path: &Path,
    message: &WriterMessage,
    should_prune: bool,
) -> Result<AuditEvent, AppError> {
    let db = Connection::open(path)?;
    ensure_schema(&db)?;
    match message {
        WriterMessage::Insert(record) => {
            db.execute(
                "INSERT INTO audit_events(
                    id,started_at,completed_at,category,source,operation,status,summary,method,route,
                    status_code,duration_ms,correlation_id,entity_type,entity_id,record_count,
                    request_json,response_json,changes_json,error
                ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
                params![
                    record.id,
                    record.started_at,
                    record.completed_at,
                    record.category,
                    record.source,
                    record.operation,
                    record.status,
                    record.summary,
                    record.method,
                    record.route,
                    record.status_code,
                    record.duration_ms,
                    record.correlation_id,
                    record.entity_type,
                    record.entity_id,
                    record.record_count,
                    json_string(record.request.as_ref())?,
                    json_string(record.response.as_ref())?,
                    json_string(record.changes.as_ref())?,
                    record.error,
                ],
            )?;
        }
        WriterMessage::Complete {
            id,
            completed_at,
            status,
            status_code,
            duration_ms,
            response,
            error,
        } => {
            db.execute(
                "UPDATE audit_events SET completed_at=?2,status=?3,status_code=?4,duration_ms=?5,response_json=?6,error=?7 WHERE id=?1",
                params![
                    id,
                    completed_at,
                    status,
                    status_code,
                    duration_ms,
                    json_string(response.as_ref())?,
                    error,
                ],
            )?;
        }
    }
    if should_prune {
        prune(&db)?;
    }
    let id = match message {
        WriterMessage::Insert(record) => &record.id,
        WriterMessage::Complete { id, .. } => id,
    };
    event_by_id(&db, id)?.ok_or_else(|| AppError::Api("Audit event was not retained".into()))
}

fn json_string(value: Option<&Value>) -> Result<Option<String>, serde_json::Error> {
    value.map(serde_json::to_string).transpose()
}

fn prune(db: &Connection) -> Result<(), rusqlite::Error> {
    let cutoff = (Utc::now() - ChronoDuration::days(RETENTION_DAYS)).to_rfc3339();
    db.execute(
        "DELETE FROM audit_events WHERE started_at < ?1",
        params![cutoff],
    )?;
    db.execute(
        "DELETE FROM audit_events WHERE sequence NOT IN (
            SELECT sequence FROM audit_events ORDER BY started_at DESC, sequence DESC LIMIT ?1
        )",
        params![RETENTION_ROWS],
    )?;
    Ok(())
}

pub fn query(
    path: &Path,
    filters: &AuditFilters,
    cursor: Option<&str>,
    limit: usize,
    health: AuditHealth,
) -> Result<AuditPage, AppError> {
    let db = Connection::open(path)?;
    ensure_schema(&db)?;
    let mut statement = db.prepare(
        "SELECT sequence,id,started_at,completed_at,category,source,operation,status,summary,
                method,route,status_code,duration_ms,correlation_id,entity_type,entity_id,
                record_count,request_json,response_json,changes_json,error
         FROM audit_events ORDER BY started_at DESC, sequence DESC",
    )?;
    let rows = statement.query_map([], row_to_event)?;
    let cursor_sequence = cursor.and_then(|value| value.parse::<i64>().ok());
    let filtered = rows
        .filter_map(Result::ok)
        .filter(|event| matches_filters(event, filters))
        .collect::<Vec<_>>();
    let total = filtered.len();
    let mut events = filtered
        .into_iter()
        .filter(|event| cursor_sequence.is_none_or(|sequence| event.sequence < sequence))
        .take(limit.clamp(1, 500) + 1)
        .collect::<Vec<_>>();
    let has_more = events.len() > limit.clamp(1, 500);
    if has_more {
        events.pop();
    }
    let next_cursor = has_more
        .then(|| events.last().map(|event| event.sequence.to_string()))
        .flatten();
    Ok(AuditPage {
        events,
        next_cursor,
        total,
        health,
    })
}

pub fn export_json(
    path: &Path,
    filters: &AuditFilters,
    health: AuditHealth,
) -> Result<String, AppError> {
    let mut page = query(path, filters, None, RETENTION_ROWS as usize, health.clone())?;
    page.events.reverse();
    Ok(serde_json::to_string_pretty(&json!({
        "exportedAt": Utc::now().to_rfc3339(),
        "retention": {"days": RETENTION_DAYS, "maximumEvents": RETENTION_ROWS},
        "filters": filters,
        "health": health,
        "events": page.events,
    }))?)
}

fn event_by_id(db: &Connection, id: &str) -> Result<Option<AuditEvent>, AppError> {
    db.query_row(
        "SELECT sequence,id,started_at,completed_at,category,source,operation,status,summary,
                method,route,status_code,duration_ms,correlation_id,entity_type,entity_id,
                record_count,request_json,response_json,changes_json,error
         FROM audit_events WHERE id=?1",
        params![id],
        row_to_event,
    )
    .optional()
    .map_err(Into::into)
}

fn row_to_event(row: &rusqlite::Row<'_>) -> Result<AuditEvent, rusqlite::Error> {
    Ok(AuditEvent {
        sequence: row.get(0)?,
        id: row.get(1)?,
        started_at: row.get(2)?,
        completed_at: row.get(3)?,
        category: row.get(4)?,
        source: row.get(5)?,
        operation: row.get(6)?,
        status: row.get(7)?,
        summary: row.get(8)?,
        method: row.get(9)?,
        route: row.get(10)?,
        status_code: row.get(11)?,
        duration_ms: row.get(12)?,
        correlation_id: row.get(13)?,
        entity_type: row.get(14)?,
        entity_id: row.get(15)?,
        record_count: row.get(16)?,
        request: parse_json_column(row.get(17)?),
        response: parse_json_column(row.get(18)?),
        changes: parse_json_column(row.get(19)?),
        error: row.get(20)?,
    })
}

fn parse_json_column(value: Option<String>) -> Option<Value> {
    value.and_then(|value| serde_json::from_str(&value).ok())
}

fn matches_filters(event: &AuditEvent, filters: &AuditFilters) -> bool {
    if !filters.categories.is_empty() && !filters.categories.contains(&event.category) {
        return false;
    }
    if !filters.sources.is_empty() && !filters.sources.contains(&event.source) {
        return false;
    }
    if !filters.statuses.is_empty() && !filters.statuses.contains(&event.status) {
        return false;
    }
    if filters
        .start_at
        .as_ref()
        .is_some_and(|start| &event.started_at < start)
        || filters
            .end_at
            .as_ref()
            .is_some_and(|end| &event.started_at > end)
    {
        return false;
    }
    let search = filters.search.trim().to_lowercase();
    search.is_empty()
        || [
            event.source.as_str(),
            event.operation.as_str(),
            event.summary.as_str(),
            event.entity_type.as_deref().unwrap_or_default(),
            event.entity_id.as_deref().unwrap_or_default(),
            event.error.as_deref().unwrap_or_default(),
        ]
        .iter()
        .any(|value| value.to_lowercase().contains(&search))
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "authorization",
        "cookie",
        "password",
        "secret",
        "apikey",
        "appkey",
        "accesstoken",
        "refreshtoken",
        "publishtablekey",
        "publishablekey",
        "oauthcode",
        "clientid",
        "email",
        "dataurl",
        "image",
        "screenshotdata",
    ]
    .iter()
    .any(|sensitive| normalized.contains(sensitive))
}

pub fn redact_value(value: Value) -> Value {
    let sanitized = redact_inner(value);
    let serialized = serde_json::to_string(&sanitized).unwrap_or_default();
    if serialized.len() <= DETAIL_LIMIT {
        sanitized
    } else {
        let preview = serialized.chars().take(4_096).collect::<String>();
        json!({
            "truncated": true,
            "originalBytes": serialized.len(),
            "preview": preview,
        })
    }
}

fn redact_inner(value: Value) -> Value {
    match value {
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    if sensitive_key(&key) {
                        (key, Value::String("[REDACTED]".into()))
                    } else {
                        (key, redact_inner(value))
                    }
                })
                .collect(),
        ),
        Value::Array(values) if values.len() > 100 => {
            let count = values.len();
            let preview = values
                .into_iter()
                .take(10)
                .map(redact_inner)
                .collect::<Vec<_>>();
            json!({"recordCount": count, "preview": preview, "truncated": true})
        }
        Value::Array(values) => Value::Array(values.into_iter().map(redact_inner).collect()),
        Value::String(value) => Value::String(sanitize_text(&value)),
        other => other,
    }
}

pub fn sanitize_route(route: &str) -> String {
    if let Ok(mut url) = url::Url::parse(route) {
        let pairs = url
            .query_pairs()
            .map(|(key, value)| {
                let value = if sensitive_key(&key) {
                    "[REDACTED]".into()
                } else {
                    value.into_owned()
                };
                (key.into_owned(), value)
            })
            .collect::<Vec<_>>();
        url.set_query(None);
        if !pairs.is_empty() {
            url.query_pairs_mut().extend_pairs(pairs);
        }
        let _ = url.set_username("");
        let _ = url.set_password(None);
        return url.to_string();
    }
    sanitize_text(route)
}

pub fn sanitize_text(input: &str) -> String {
    let mut output = input.to_string();
    for marker in ["Bearer ", "Basic "] {
        while let Some(start) = output.find(marker) {
            let token_start = start + marker.len();
            let token_len = output[token_start..]
                .find(char::is_whitespace)
                .unwrap_or(output.len() - token_start);
            output.replace_range(token_start..token_start + token_len, "[REDACTED]");
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path() -> PathBuf {
        std::env::temp_dir().join(format!("northstar-audit-{}.sqlite", uuid::Uuid::new_v4()))
    }

    #[test]
    fn recursive_redaction_and_large_arrays_are_safe() {
        let value = redact_value(json!({
            "authorization": "Bearer abc",
            "nested": {"clientSecret": "secret", "symbol": "MES"},
            "dataUrl": "data:image/png;base64,abc",
            "records": (0..150).collect::<Vec<_>>(),
        }));
        assert_eq!(value["authorization"], "[REDACTED]");
        assert_eq!(value["nested"]["clientSecret"], "[REDACTED]");
        assert_eq!(value["nested"]["symbol"], "MES");
        assert_eq!(value["dataUrl"], "[REDACTED]");
        assert_eq!(value["records"]["recordCount"], 150);
    }

    #[test]
    fn query_filters_and_cursor_are_stable() {
        let path = test_path();
        init(&path).unwrap();
        for index in 0..3 {
            let mut record = AuditRecord::completed(
                if index == 1 { "record" } else { "api" },
                "test",
                &format!("operation-{index}"),
                if index == 2 { "error" } else { "success" },
                format!("event {index}"),
            );
            record.started_at = format!("2026-07-28T12:00:0{index}Z");
            write_message(&path, &WriterMessage::Insert(record), false).unwrap();
        }
        let first = query(
            &path,
            &AuditFilters::default(),
            None,
            2,
            AuditHealth::default(),
        )
        .unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(first.events.len(), 2);
        let second = query(
            &path,
            &AuditFilters::default(),
            first.next_cursor.as_deref(),
            2,
            AuditHealth::default(),
        )
        .unwrap();
        assert_eq!(second.events.len(), 1);
        let errors = query(
            &path,
            &AuditFilters {
                statuses: vec!["error".into()],
                ..Default::default()
            },
            None,
            100,
            AuditHealth::default(),
        )
        .unwrap();
        assert_eq!(errors.total, 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pending_events_are_completed_in_place() {
        let path = test_path();
        init(&path).unwrap();
        let record = AuditRecord {
            id: "request-1".into(),
            started_at: Utc::now().to_rfc3339(),
            completed_at: None,
            category: "api".into(),
            source: "test".into(),
            operation: "fetch".into(),
            status: "pending".into(),
            summary: "GET /test".into(),
            method: Some("GET".into()),
            route: Some("/test".into()),
            status_code: None,
            duration_ms: None,
            correlation_id: Some("correlation-1".into()),
            entity_type: None,
            entity_id: None,
            record_count: None,
            request: None,
            response: None,
            changes: None,
            error: None,
        };
        write_message(&path, &WriterMessage::Insert(record), false).unwrap();
        let completed = write_message(
            &path,
            &WriterMessage::Complete {
                id: "request-1".into(),
                completed_at: Utc::now().to_rfc3339(),
                status: "success".into(),
                status_code: Some(200),
                duration_ms: 12,
                response: Some(json!({"ok": true})),
                error: None,
            },
            false,
        )
        .unwrap();
        assert_eq!(completed.status, "success");
        assert_eq!(completed.status_code, Some(200));
        assert_eq!(completed.correlation_id.as_deref(), Some("correlation-1"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pruning_enforces_age_and_row_limits() {
        let path = test_path();
        init(&path).unwrap();
        let mut db = Connection::open(&path).unwrap();
        let old_started_at = (Utc::now() - ChronoDuration::days(8)).to_rfc3339();
        db.execute(
            "INSERT INTO audit_events
             (id,started_at,completed_at,category,source,operation,status,summary)
             VALUES ('old-event',?1,?1,'system','test','old','success','old event')",
            params![old_started_at],
        )
        .unwrap();
        let current_started_at = Utc::now().to_rfc3339();
        let transaction = db.transaction().unwrap();
        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO audit_events
                     (id,started_at,completed_at,category,source,operation,status,summary)
                     VALUES (?1,?2,?2,'api','test','fetch','success','current event')",
                )
                .unwrap();
            for index in 0..(RETENTION_ROWS + 5) {
                insert
                    .execute(params![format!("current-{index}"), current_started_at])
                    .unwrap();
            }
        }
        transaction.commit().unwrap();

        prune(&db).unwrap();

        let retained: i64 = db
            .query_row("SELECT COUNT(*) FROM audit_events", [], |row| row.get(0))
            .unwrap();
        let old_retained: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE id='old-event'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, RETENTION_ROWS);
        assert_eq!(old_retained, 0);
        let _ = std::fs::remove_file(path);
    }
}
