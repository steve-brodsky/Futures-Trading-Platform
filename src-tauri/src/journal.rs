use crate::{
    models::{MarketDataProvider, OrderDraft, OrderUpdate, SymbolMeta, TradingEnvironment},
    storage, AppError,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration as StdDuration, Instant},
};

static CLOUD_SYNCING: AtomicBool = AtomicBool::new(false);
static PREFERENCES_SYNCING: AtomicBool = AtomicBool::new(false);
const DEFAULT_COMMISSION_PER_CONTRACT_SIDE: f64 = 0.40;
const DEFAULT_SCHWAB_OPTION_FEE_PER_CONTRACT_SIDE: f64 = 0.65;
const DEFAULT_SUPABASE_TOKEN_LIFETIME_SECONDS: u64 = 3600;

#[derive(Clone)]
struct CachedAccessToken {
    project_url: String,
    user_id: String,
    value: String,
    refresh_after: Instant,
}

static SUPABASE_ACCESS_TOKEN: OnceLock<Mutex<Option<CachedAccessToken>>> = OnceLock::new();

fn access_token_cache() -> &'static Mutex<Option<CachedAccessToken>> {
    SUPABASE_ACCESS_TOKEN.get_or_init(|| Mutex::new(None))
}

fn cache_access_token(cfg: &CloudConfig, value: String, expires_in: Option<u64>) {
    let lifetime = expires_in.unwrap_or(DEFAULT_SUPABASE_TOKEN_LIFETIME_SECONDS);
    let refresh_in = lifetime.saturating_sub(60).max(1);
    if let Ok(mut cache) = access_token_cache().lock() {
        *cache = Some(CachedAccessToken {
            project_url: cfg.project_url.clone(),
            user_id: cfg.user_id.clone(),
            value,
            refresh_after: Instant::now() + StdDuration::from_secs(refresh_in),
        });
    }
}

fn invalidate_access_token() {
    if let Ok(mut cache) = access_token_cache().lock() {
        *cache = None;
    }
}
struct SyncGuard;
impl Drop for SyncGuard {
    fn drop(&mut self) {
        CLOUD_SYNCING.store(false, Ordering::Release);
    }
}

struct PreferenceSyncGuard;
impl Drop for PreferenceSyncGuard {
    fn drop(&mut self) {
        PREFERENCES_SYNCING.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalScope {
    #[serde(default)]
    pub provider: MarketDataProvider,
    pub environment: TradingEnvironment,
    pub account_id: String,
    pub account_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalAuthStatus {
    pub configured: bool,
    pub authenticated: bool,
    pub email: Option<String>,
    pub project_url: Option<String>,
    pub backfill_start: Option<String>,
    pub record_from: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalConnectionInput {
    pub project_url: String,
    pub publishable_key: String,
    pub email: String,
    pub password: String,
    pub backfill_start: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSyncStatus {
    pub state: String,
    pub pending_events: usize,
    pub last_synced_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceSyncResult {
    pub state: String,
    pub records: Vec<storage::PreferenceRecord>,
    pub replaced_categories: Vec<String>,
    pub conflicted_categories: Vec<String>,
    pub last_synced_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Default)]
pub struct JournalIngestResult {
    pub fills: usize,
    pub unmatched_closes: Vec<OrderUpdate>,
}

#[derive(Debug, Clone)]
struct JournalIntentMatch {
    id: String,
    original_stop: Option<f64>,
    original_target: Option<f64>,
    quantity: f64,
    point_value: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEvent {
    pub id: String,
    pub trade_id: Option<String>,
    pub broker_order_id: Option<String>,
    pub provider: Option<MarketDataProvider>,
    pub option_symbol: Option<String>,
    pub broker_leg_id: Option<String>,
    pub event_type: String,
    pub occurred_at: String,
    pub source: String,
    pub status: Option<String>,
    pub old_price: Option<f64>,
    pub new_price: Option<f64>,
    pub quantity: Option<f64>,
    pub price: Option<f64>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalOptionLeg {
    pub id: String,
    pub trade_id: String,
    pub option_symbol: String,
    pub underlying: String,
    pub expiration_date: String,
    pub strike_price: f64,
    pub put_call: String,
    pub opening_side: String,
    pub opened_quantity: f64,
    pub closed_quantity: f64,
    pub average_entry: f64,
    pub average_exit: Option<f64>,
    pub multiplier: f64,
    pub gross_pnl: f64,
    pub fees: f64,
    pub status: String,
    pub replaces_leg_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalTrade {
    pub id: String,
    #[serde(default)]
    pub provider: MarketDataProvider,
    pub environment: TradingEnvironment,
    pub account_id: String,
    pub symbol: String,
    pub direction: String,
    pub asset_class: String,
    pub strategy: String,
    pub underlying: Option<String>,
    pub status: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub entry_quantity: f64,
    pub exit_quantity: f64,
    pub average_entry: f64,
    pub average_exit: Option<f64>,
    pub original_stop: Option<f64>,
    pub original_target: Option<f64>,
    pub planned_risk: Option<f64>,
    pub deployed_risk: Option<f64>,
    pub point_value: Option<f64>,
    pub gross_pnl: f64,
    pub fees: f64,
    pub net_pnl: f64,
    pub r_multiple: Option<f64>,
    pub risk_provenance: String,
    pub notes: String,
    pub tags: Vec<String>,
    pub events: Option<Vec<JournalEvent>>,
    pub entry_screenshot: Option<JournalScreenshotMetadata>,
    pub legs: Option<Vec<JournalOptionLeg>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalScreenshotMetadata {
    pub trade_id: String,
    pub captured_at: String,
    pub width: u32,
    pub height: u32,
    pub content_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalScreenshotInput {
    pub broker_order_id: String,
    pub environment: TradingEnvironment,
    pub account_id: String,
    pub symbol: String,
    pub captured_at: String,
    pub width: u32,
    pub height: u32,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalScreenshotImage {
    pub trade_id: String,
    pub captured_at: String,
    pub width: u32,
    pub height: u32,
    pub content_type: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSummaryMetrics {
    pub net_pnl: f64,
    pub gross_pnl: f64,
    pub fees: f64,
    pub trades: usize,
    pub closed_trades: usize,
    pub win_rate: Option<f64>,
    pub total_r: Option<f64>,
    pub average_trade: Option<f64>,
    pub profit_factor: Option<f64>,
    pub long_trades: usize,
    pub short_trades: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalCalendarDay {
    pub date: String,
    pub trades: usize,
    pub closed_trades: usize,
    pub net_pnl: f64,
    pub total_r: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalMonthSummary {
    pub scope: JournalScope,
    pub year: i32,
    pub month: u32,
    pub metrics: JournalSummaryMetrics,
    pub days: Vec<JournalCalendarDay>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalDaySummary {
    pub scope: JournalScope,
    pub date: String,
    pub metrics: JournalSummaryMetrics,
    pub trades: Vec<JournalTrade>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalStatsTrade {
    pub id: String,
    pub provider: MarketDataProvider,
    pub symbol: String,
    pub direction: String,
    pub asset_class: String,
    pub strategy: String,
    pub underlying: Option<String>,
    pub status: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub gross_pnl: f64,
    pub fees: f64,
    pub net_pnl: f64,
    pub r_multiple: Option<f64>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalStatsRange {
    pub scope: JournalScope,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub trades: Vec<JournalStatsTrade>,
}

#[derive(Debug, Clone)]
struct CloudConfig {
    project_url: String,
    publishable_key: String,
    email: String,
    user_id: String,
    backfill_start: String,
    record_from: Option<String>,
    updated_at: String,
}

#[derive(Clone)]
pub struct PreferenceRealtimeCredentials {
    pub project_url: String,
    pub publishable_key: String,
    pub user_id: String,
    pub access_token: String,
    pub device_id: String,
    pub refresh_after: StdDuration,
}

#[derive(Debug, Deserialize)]
struct RemoteSettingsRow {
    backfill_start: String,
    record_from: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RemotePreferenceRow {
    category: String,
    schema_version: i64,
    payload: Value,
    revision: i64,
    mutation_id: String,
    device_id: String,
    server_updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
struct PreferenceCommitRow {
    applied: bool,
    category: String,
    schema_version: i64,
    payload: Value,
    revision: i64,
    mutation_id: String,
    device_id: String,
    server_updated_at: String,
}

impl PreferenceCommitRow {
    fn into_record(self) -> storage::PreferenceRecord {
        storage::PreferenceRecord {
            category: self.category,
            schema_version: self.schema_version,
            payload: self.payload,
            revision: self.revision,
            mutation_id: self.mutation_id,
            device_id: self.device_id,
            server_updated_at: self.server_updated_at,
            dirty: false,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RemoteTradeRow {
    id: String,
    #[serde(default = "default_tradestation_provider")]
    provider: String,
    environment: String,
    account_id: String,
    symbol: String,
    direction: String,
    #[serde(default = "default_futures_asset_class")]
    asset_class: String,
    #[serde(default = "default_futures_strategy")]
    strategy: String,
    underlying: Option<String>,
    status: String,
    opened_at: String,
    closed_at: Option<String>,
    entry_quantity: f64,
    exit_quantity: f64,
    average_entry: f64,
    average_exit: Option<f64>,
    original_stop: Option<f64>,
    original_target: Option<f64>,
    planned_risk: Option<f64>,
    deployed_risk: Option<f64>,
    point_value: Option<f64>,
    gross_pnl: f64,
    fees: f64,
    net_pnl: f64,
    r_multiple: Option<f64>,
    risk_provenance: String,
    updated_at: String,
}
fn default_tradestation_provider() -> String {
    "tradestation".into()
}
fn default_futures_asset_class() -> String {
    "futures".into()
}
fn default_futures_strategy() -> String {
    "futures-directional".into()
}

#[derive(Debug, Deserialize)]
struct RemoteOptionLegRow {
    id: String,
    trade_id: String,
    option_symbol: String,
    underlying: String,
    expiration_date: String,
    strike_price: f64,
    put_call: String,
    opening_side: String,
    opened_quantity: f64,
    closed_quantity: f64,
    average_entry: f64,
    average_exit: Option<f64>,
    multiplier: f64,
    gross_pnl: f64,
    fees: f64,
    status: String,
    replaces_leg_id: Option<String>,
    updated_at: String,
}
#[derive(Debug, Deserialize)]
struct RemoteAnnotationRow {
    trade_id: String,
    notes: String,
    tags: Vec<String>,
    updated_at: String,
}
#[derive(Debug, Deserialize)]
struct RemoteScreenshotRow {
    trade_id: String,
    object_path: String,
    captured_at: String,
    width: u32,
    height: u32,
    content_type: String,
}
#[derive(Debug, Deserialize)]
struct RemoteEventRow {
    id: String,
    event_key: String,
    trade_id: Option<String>,
    #[serde(default = "default_tradestation_provider")]
    provider: String,
    environment: String,
    account_id: String,
    broker_order_id: Option<String>,
    broker_leg_id: Option<String>,
    option_symbol: Option<String>,
    event_type: String,
    occurred_at: String,
    source: String,
    status: Option<String>,
    old_price: Option<f64>,
    new_price: Option<f64>,
    quantity: Option<f64>,
    price: Option<f64>,
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthResponse {
    access_token: String,
    refresh_token: String,
    expires_in: Option<u64>,
    user: Option<AuthUser>,
}
#[derive(Debug, Deserialize)]
struct AuthUser {
    id: String,
}

pub fn init(path: &Path) -> Result<(), AppError> {
    let db = Connection::open(path)?;
    db.execute_batch("PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS journal_config (id INTEGER PRIMARY KEY CHECK(id=1), project_url TEXT NOT NULL, publishable_key TEXT NOT NULL, email TEXT NOT NULL, user_id TEXT NOT NULL, backfill_start TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_intents (id TEXT PRIMARY KEY, environment TEXT NOT NULL, account_id TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, quantity REAL NOT NULL, original_stop REAL, original_target REAL, point_value REAL, broker_order_id TEXT UNIQUE, created_at TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_events (id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, trade_id TEXT, provider TEXT NOT NULL DEFAULT 'tradestation', environment TEXT NOT NULL, account_id TEXT NOT NULL, broker_order_id TEXT, broker_leg_id TEXT, option_symbol TEXT, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, source TEXT NOT NULL, status TEXT, old_price REAL, new_price REAL, quantity REAL, price REAL, note TEXT, synced INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS journal_events_trade_time ON journal_events(trade_id,occurred_at);
      CREATE TABLE IF NOT EXISTS journal_trades (id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'tradestation', environment TEXT NOT NULL, account_id TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL, asset_class TEXT NOT NULL DEFAULT 'futures', strategy TEXT NOT NULL DEFAULT 'futures-directional', underlying TEXT, status TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT, entry_quantity REAL NOT NULL DEFAULT 0, exit_quantity REAL NOT NULL DEFAULT 0, average_entry REAL NOT NULL DEFAULT 0, average_exit REAL, original_stop REAL, original_target REAL, planned_risk REAL, deployed_risk REAL, point_value REAL, gross_pnl REAL NOT NULL DEFAULT 0, fees REAL NOT NULL DEFAULT 0, net_pnl REAL NOT NULL DEFAULT 0, r_multiple REAL, risk_provenance TEXT NOT NULL DEFAULT 'unknown', updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_trades_scope_time ON journal_trades(environment,account_id,opened_at);
      CREATE TABLE IF NOT EXISTS journal_annotations (trade_id TEXT PRIMARY KEY, notes TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS journal_screenshots (trade_id TEXT PRIMARY KEY, object_path TEXT NOT NULL UNIQUE, captured_at TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, content_type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_order_state (environment TEXT NOT NULL, account_id TEXT NOT NULL, order_id TEXT NOT NULL, filled_quantity REAL NOT NULL DEFAULT 0, commission REAL NOT NULL DEFAULT 0, PRIMARY KEY(environment,account_id,order_id));
      CREATE TABLE IF NOT EXISTS journal_option_order_state (provider TEXT NOT NULL, account_id TEXT NOT NULL, order_id TEXT NOT NULL, filled_quantity REAL NOT NULL DEFAULT 0, average_fill_price REAL NOT NULL DEFAULT 0, commission REAL NOT NULL DEFAULT 0, PRIMARY KEY(provider,account_id,order_id));
      CREATE TABLE IF NOT EXISTS journal_option_legs (id TEXT PRIMARY KEY, trade_id TEXT NOT NULL, option_symbol TEXT NOT NULL, underlying TEXT NOT NULL, expiration_date TEXT NOT NULL, strike_price REAL NOT NULL, put_call TEXT NOT NULL, opening_side TEXT NOT NULL, opened_quantity REAL NOT NULL DEFAULT 0, closed_quantity REAL NOT NULL DEFAULT 0, average_entry REAL NOT NULL DEFAULT 0, average_exit REAL, multiplier REAL NOT NULL DEFAULT 100, gross_pnl REAL NOT NULL DEFAULT 0, fees REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', replaces_leg_id TEXT, updated_at TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(trade_id) REFERENCES journal_trades(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS journal_option_legs_trade ON journal_option_legs(trade_id);
      CREATE INDEX IF NOT EXISTS journal_option_legs_symbol_open ON journal_option_legs(option_symbol,status);
      CREATE TABLE IF NOT EXISTS journal_protective_state (environment TEXT NOT NULL, account_id TEXT NOT NULL, order_id TEXT NOT NULL, order_type TEXT NOT NULL, last_price REAL NOT NULL, PRIMARY KEY(environment,account_id,order_id));
      CREATE TABLE IF NOT EXISTS journal_sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_trade_tombstones (trade_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);")?;
    let has_record_from = {
        let mut stmt = db.prepare("PRAGMA table_info(journal_config)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        columns.iter().any(|column| column == "record_from")
    };
    if !has_record_from {
        db.execute("ALTER TABLE journal_config ADD COLUMN record_from TEXT", [])?;
    }
    let ensure_column = |table: &str, column: &str, declaration: &str| -> Result<(), AppError> {
        let mut stmt = db.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !columns.iter().any(|candidate| candidate == column) {
            db.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {declaration}"),
                [],
            )?;
        }
        Ok(())
    };
    ensure_column(
        "journal_trades",
        "provider",
        "TEXT NOT NULL DEFAULT 'tradestation'",
    )?;
    ensure_column(
        "journal_trades",
        "asset_class",
        "TEXT NOT NULL DEFAULT 'futures'",
    )?;
    ensure_column(
        "journal_trades",
        "strategy",
        "TEXT NOT NULL DEFAULT 'futures-directional'",
    )?;
    ensure_column("journal_trades", "underlying", "TEXT")?;
    ensure_column(
        "journal_events",
        "provider",
        "TEXT NOT NULL DEFAULT 'tradestation'",
    )?;
    ensure_column("journal_events", "broker_leg_id", "TEXT")?;
    ensure_column("journal_events", "option_symbol", "TEXT")?;
    db.execute_batch("DROP INDEX IF EXISTS journal_trades_scope_time; CREATE INDEX journal_trades_scope_time ON journal_trades(provider,environment,account_id,opened_at);")?;
    db.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS journal_preferences (id INTEGER PRIMARY KEY CHECK(id=1), commission_per_contract_side REAL NOT NULL, schwab_option_fee_per_contract_side REAL NOT NULL DEFAULT {DEFAULT_SCHWAB_OPTION_FEE_PER_CONTRACT_SIDE}, updated_at TEXT NOT NULL);"
    ))?;
    ensure_column(
        "journal_preferences",
        "schwab_option_fee_per_contract_side",
        &format!("REAL NOT NULL DEFAULT {DEFAULT_SCHWAB_OPTION_FEE_PER_CONTRACT_SIDE}"),
    )?;
    db.execute(&format!("INSERT OR IGNORE INTO journal_preferences(id,commission_per_contract_side,schwab_option_fee_per_contract_side,updated_at) VALUES(1,{DEFAULT_COMMISSION_PER_CONTRACT_SIDE},{DEFAULT_SCHWAB_OPTION_FEE_PER_CONTRACT_SIDE},datetime('now'))"), [])?;
    Ok(())
}

fn commission_per_contract_side(db: &Connection) -> Result<f64, AppError> {
    Ok(db.query_row(
        "SELECT commission_per_contract_side FROM journal_preferences WHERE id=1",
        [],
        |row| row.get::<_, f64>(0),
    )?)
}

pub fn set_commission_per_contract_side(path: &Path, value: f64) -> Result<(), AppError> {
    if !value.is_finite() || !(0.0..=100.0).contains(&value) {
        return Err(AppError::Validation(
            "Journal commission must be between $0 and $100 per contract per side".into(),
        ));
    }
    init(path)?;
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    tx.execute(
        "UPDATE journal_preferences SET commission_per_contract_side=?1,updated_at=?2 WHERE id=1",
        params![value, now()],
    )?;
    tx.execute(
        "UPDATE journal_order_state SET commission=filled_quantity*?1",
        params![value],
    )?;
    tx.execute(
        "UPDATE journal_trades SET fees=COALESCE((SELECT SUM(ABS(quantity))*?1 FROM journal_events WHERE journal_events.trade_id=journal_trades.id AND event_type='fill'),0), net_pnl=gross_pnl-COALESCE((SELECT SUM(ABS(quantity))*?1 FROM journal_events WHERE journal_events.trade_id=journal_trades.id AND event_type='fill'),0), updated_at=?2 WHERE provider='tradestation'",
        params![value, now()],
    )?;
    tx.commit()?;
    Ok(())
}

fn schwab_option_fee_per_contract_side(db: &Connection) -> Result<f64, AppError> {
    Ok(db.query_row(
        "SELECT schwab_option_fee_per_contract_side FROM journal_preferences WHERE id=1",
        [],
        |row| row.get::<_, f64>(0),
    )?)
}

pub fn set_schwab_option_fee_per_contract_side(path: &Path, value: f64) -> Result<(), AppError> {
    if !value.is_finite() || !(0.0..=100.0).contains(&value) {
        return Err(AppError::Validation(
            "Schwab option fee must be between $0 and $100 per contract, per leg, per side".into(),
        ));
    }
    init(path)?;
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    tx.execute("UPDATE journal_preferences SET schwab_option_fee_per_contract_side=?1,updated_at=?2 WHERE id=1", params![value, now()])?;
    tx.execute("UPDATE journal_option_order_state SET commission=filled_quantity*?1 WHERE provider='schwab'", params![value])?;
    tx.execute("UPDATE journal_option_legs SET fees=(opened_quantity+closed_quantity)*?1,updated_at=?2,synced=0", params![value, now()])?;
    let trade_ids = {
        let mut stmt = tx.prepare("SELECT DISTINCT trade_id FROM journal_option_legs")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for trade_id in trade_ids {
        refresh_option_campaign(&tx, &trade_id, None)?;
    }
    tx.commit()?;
    Ok(())
}

fn is_schwab_option(order: &OrderUpdate) -> bool {
    order.provider == MarketDataProvider::Schwab
        && order
            .asset_type
            .as_deref()
            .is_some_and(|value| value.to_ascii_uppercase().contains("OPTION"))
        && order
            .underlying
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        && order
            .expiration_date
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        && order
            .put_call
            .as_deref()
            .is_some_and(|value| matches!(value, "CALL" | "PUT"))
        && order.strike_price.is_some()
}

fn option_order_delta(
    db: &Connection,
    order: &OrderUpdate,
    fee_rate: f64,
) -> Result<(f64, f64, f64), AppError> {
    let account = order.account_id.as_deref().unwrap_or_default();
    let filled = order.filled_quantity.unwrap_or(0.0).max(0.0);
    let average = order.average_fill_price.unwrap_or(0.0).max(0.0);
    let previous = db.query_row(
        "SELECT filled_quantity,average_fill_price,commission FROM journal_option_order_state WHERE provider='schwab' AND account_id=?1 AND order_id=?2",
        params![account, order.id],
        |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?)),
    ).optional()?.unwrap_or((0.0, 0.0, 0.0));
    let delta = (filled - previous.0).max(0.0);
    let delta_price = if delta > 0.0 {
        ((average * filled) - (previous.1 * previous.0)) / delta
    } else {
        average
    };
    let commission = filled * fee_rate;
    let fee_delta = (commission - previous.2).max(0.0);
    db.execute(
        "INSERT INTO journal_option_order_state(provider,account_id,order_id,filled_quantity,average_fill_price,commission) VALUES('schwab',?1,?2,?3,?4,?5) ON CONFLICT(provider,account_id,order_id) DO UPDATE SET filled_quantity=MAX(journal_option_order_state.filled_quantity,excluded.filled_quantity),average_fill_price=CASE WHEN excluded.filled_quantity>=journal_option_order_state.filled_quantity THEN excluded.average_fill_price ELSE journal_option_order_state.average_fill_price END,commission=MAX(journal_option_order_state.commission,excluded.commission)",
        params![account, order.id, filled, average, commission],
    )?;
    Ok((delta, delta_price.max(0.0), fee_delta))
}

fn insert_option_event(
    db: &Connection,
    trade_id: Option<&str>,
    order: &OrderUpdate,
    event_type: &str,
    occurred_at: &str,
    source: &str,
    quantity: Option<f64>,
    price: Option<f64>,
    note: &str,
) -> Result<(), AppError> {
    let account = order.account_id.as_deref().unwrap_or_default();
    let parent = order.broker_order_id.as_deref().unwrap_or(&order.id);
    let key = format!(
        "schwab:{event_type}:{account}:{}:{}:{}",
        order.id,
        quantity.unwrap_or_default(),
        price.unwrap_or_default()
    );
    db.execute(
        "INSERT OR IGNORE INTO journal_events(id,event_key,trade_id,provider,environment,account_id,broker_order_id,broker_leg_id,option_symbol,event_type,occurred_at,source,status,quantity,price,note,synced) VALUES(?1,?2,?3,'schwab','live',?4,?5,?6,?7,?8,?9,?10,'confirmed',?11,?12,?13,0)",
        params![stable_id(&key), key, trade_id, account, parent, order.leg_id, order.symbol, event_type, occurred_at, source, quantity, price, note],
    )?;
    Ok(())
}

fn option_observed_at(order: &OrderUpdate) -> String {
    order
        .closed_at
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if order.timestamp.is_empty() {
                now()
            } else {
                order.timestamp.clone()
            }
        })
}

fn refresh_option_campaign(
    db: &Connection,
    trade_id: &str,
    closed_at: Option<&str>,
) -> Result<(), AppError> {
    let (gross, fees, opened, closed, open_legs): (f64, f64, f64, f64, i64) = db.query_row(
        "SELECT COALESCE(SUM(gross_pnl),0),COALESCE(SUM(fees),0),COALESCE(SUM(opened_quantity),0)/2.0,COALESCE(SUM(closed_quantity),0)/2.0,COALESCE(SUM(CASE WHEN opened_quantity-closed_quantity>0.000000001 THEN 1 ELSE 0 END),0) FROM journal_option_legs WHERE trade_id=?1",
        params![trade_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))
    )?;
    let status = if opened > 0.0 && open_legs == 0 {
        "closed"
    } else {
        "open"
    };
    db.execute(
        "UPDATE journal_trades SET status=?1,closed_at=CASE WHEN ?1='closed' THEN COALESCE(?2,closed_at,?3) ELSE NULL END,entry_quantity=?4,exit_quantity=?5,gross_pnl=?6,fees=?7,net_pnl=?6-?7,updated_at=?3 WHERE id=?8",
        params![status, closed_at, now(), opened, closed, gross, fees, trade_id],
    )?;
    Ok(())
}

fn active_exact_strangle(
    db: &Connection,
    account: &str,
    first: &OrderUpdate,
    second: &OrderUpdate,
    direction: &str,
) -> Result<Option<String>, AppError> {
    db.query_row(
        "SELECT t.id FROM journal_trades t WHERE t.provider='schwab' AND t.environment='live' AND t.account_id=?1 AND t.status='open' AND t.underlying=?2 AND t.direction=?3 AND EXISTS(SELECT 1 FROM journal_option_legs l WHERE l.trade_id=t.id AND l.option_symbol=?4) AND EXISTS(SELECT 1 FROM journal_option_legs l WHERE l.trade_id=t.id AND l.option_symbol=?5) AND NOT EXISTS(SELECT 1 FROM journal_option_legs l WHERE l.trade_id=t.id AND l.opened_quantity>l.closed_quantity AND l.option_symbol NOT IN (?4,?5)) ORDER BY t.opened_at DESC LIMIT 1",
        params![account, first.underlying, direction, first.symbol, second.symbol], |row| row.get(0)
    ).optional().map_err(Into::into)
}

fn create_option_campaign(
    db: &Connection,
    account: &str,
    order: &OrderUpdate,
    direction: &str,
    occurred_at: &str,
) -> Result<String, AppError> {
    let parent = order.broker_order_id.as_deref().unwrap_or(&order.id);
    let id = stable_id(&format!("schwab:live:{account}:strangle:{parent}"));
    let strategy = if direction == "Short" {
        "short-strangle"
    } else {
        "long-strangle"
    };
    db.execute(
        "INSERT OR IGNORE INTO journal_trades(id,provider,environment,account_id,symbol,direction,asset_class,strategy,underlying,status,opened_at,entry_quantity,exit_quantity,average_entry,gross_pnl,fees,net_pnl,risk_provenance,updated_at) VALUES(?1,'schwab','live',?2,?3,?4,'option',?5,?3,'open',?6,0,0,0,0,0,0,'unknown',?6)",
        params![id, account, order.underlying, direction, strategy, occurred_at],
    )?;
    Ok(id)
}

fn upsert_option_open(
    db: &Connection,
    trade_id: &str,
    order: &OrderUpdate,
    fee_rate: f64,
    source: &str,
    replaces_leg_id: Option<&str>,
) -> Result<(), AppError> {
    let occurred = option_observed_at(order);
    let existing = db.query_row("SELECT id,opened_quantity,average_entry,fees FROM journal_option_legs WHERE trade_id=?1 AND option_symbol=?2 AND status='open' ORDER BY updated_at DESC LIMIT 1", params![trade_id, order.symbol], |row| Ok((row.get::<_,String>(0)?,row.get::<_,f64>(1)?,row.get::<_,f64>(2)?,row.get::<_,f64>(3)?))).optional()?;
    let leg_id = existing
        .as_ref()
        .map(|item| item.0.clone())
        .unwrap_or_else(|| {
            stable_id(&format!(
                "option-leg:{trade_id}:{}:{}",
                order.symbol, order.id
            ))
        });
    if existing.is_none() {
        db.execute("INSERT INTO journal_option_legs(id,trade_id,option_symbol,underlying,expiration_date,strike_price,put_call,opening_side,multiplier,replaces_leg_id,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)", params![leg_id,trade_id,order.symbol,order.underlying,order.expiration_date,order.strike_price,order.put_call,order.side,order.multiplier.unwrap_or(100.0),replaces_leg_id,occurred])?;
    }
    db.execute("UPDATE journal_events SET trade_id=?1,synced=0 WHERE provider='schwab' AND account_id=?2 AND broker_order_id=?3 AND option_symbol=?4 AND trade_id IS NULL", params![trade_id,order.account_id,order.broker_order_id.as_deref().unwrap_or(&order.id),order.symbol])?;
    let (delta, delta_price, fee_delta) = option_order_delta(db, order, fee_rate)?;
    if delta > 0.0 {
        let (prior_qty, prior_average, prior_fees) = db.query_row(
            "SELECT opened_quantity,average_entry,fees FROM journal_option_legs WHERE id=?1",
            params![leg_id],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )?;
        let quantity = prior_qty + delta;
        let average = if quantity > 0.0 {
            (prior_average * prior_qty + delta_price * delta) / quantity
        } else {
            0.0
        };
        db.execute("UPDATE journal_option_legs SET opened_quantity=?1,average_entry=?2,fees=?3,status='open',updated_at=?4 WHERE id=?5", params![quantity,average,prior_fees+fee_delta,occurred,leg_id])?;
        insert_option_event(
            db,
            Some(trade_id),
            order,
            "fill",
            &occurred,
            source,
            Some(delta),
            Some(delta_price),
            "Opening option-leg fill",
        )?;
    }
    Ok(())
}

fn apply_option_close(
    db: &Connection,
    order: &OrderUpdate,
    fee_rate: f64,
    source: &str,
) -> Result<Vec<(String, String)>, AppError> {
    let (mut delta, delta_price, fee_delta) = option_order_delta(db, order, fee_rate)?;
    if delta <= 0.0 {
        return Ok(vec![]);
    }
    let account = order.account_id.as_deref().unwrap_or_default();
    let candidates = {
        let mut stmt = db.prepare("SELECT l.id,l.trade_id,l.opening_side,l.opened_quantity,l.closed_quantity,l.average_entry,l.average_exit,l.multiplier,l.fees FROM journal_option_legs l JOIN journal_trades t ON t.id=l.trade_id WHERE t.provider='schwab' AND t.account_id=?1 AND t.status='open' AND l.option_symbol=?2 AND l.opened_quantity>l.closed_quantity ORDER BY t.opened_at,l.updated_at")?;
        let rows = stmt
            .query_map(params![account, order.symbol], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, f64>(5)?,
                    row.get::<_, Option<f64>>(6)?,
                    row.get::<_, f64>(7)?,
                    row.get::<_, f64>(8)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let total = delta;
    let mut matched = vec![];
    let occurred = option_observed_at(order);
    for (leg_id, trade_id, opening_side, opened, closed, entry, average_exit, multiplier, fees) in
        candidates
    {
        if delta <= 0.0 {
            break;
        }
        let allocation = delta.min((opened - closed).max(0.0));
        if allocation <= 0.0 {
            continue;
        }
        let next_closed = closed + allocation;
        let next_exit = ((average_exit.unwrap_or_default() * closed) + (delta_price * allocation))
            / next_closed;
        let direction = if opening_side == "Sell" { 1.0 } else { -1.0 };
        let gross = direction * (entry - next_exit) * multiplier * next_closed;
        let allocated_fee = fee_delta * allocation / total;
        let status = if next_closed + 1e-9 >= opened {
            "closed"
        } else {
            "open"
        };
        db.execute("UPDATE journal_option_legs SET closed_quantity=?1,average_exit=?2,gross_pnl=?3,fees=?4,status=?5,updated_at=?6 WHERE id=?7", params![next_closed,next_exit,gross,fees+allocated_fee,status,occurred,leg_id])?;
        insert_option_event(
            db,
            Some(&trade_id),
            order,
            "fill",
            &occurred,
            source,
            Some(allocation),
            Some(delta_price),
            "Closing option-leg fill",
        )?;
        db.execute("UPDATE journal_events SET trade_id=?1,synced=0 WHERE provider='schwab' AND account_id=?2 AND broker_order_id=?3 AND option_symbol=?4 AND trade_id IS NULL", params![trade_id,order.account_id,order.broker_order_id.as_deref().unwrap_or(&order.id),order.symbol])?;
        matched.push((trade_id, leg_id));
        delta -= allocation;
    }
    Ok(matched)
}

pub fn ingest_schwab_strangles(
    path: &Path,
    orders: &[OrderUpdate],
    source: &str,
) -> Result<JournalIngestResult, AppError> {
    init(path)?;
    let cutoff = parse_record_from(record_from(path)?.as_deref());
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    let fee_rate = schwab_option_fee_per_contract_side(&tx)?;
    let mut grouped: HashMap<String, Vec<OrderUpdate>> = HashMap::new();
    for order in orders
        .iter()
        .filter(|order| is_schwab_option(order) && order_is_recordable(order, cutoff))
    {
        let parent = order
            .broker_order_id
            .clone()
            .unwrap_or_else(|| order.id.clone());
        grouped.entry(parent).or_default().push(order.clone());
    }
    let mut groups = grouped.into_values().collect::<Vec<_>>();
    groups.sort_by_key(|items| {
        items
            .iter()
            .map(option_observed_at)
            .min()
            .unwrap_or_default()
    });
    let mut fills = 0usize;
    for group in groups {
        let opens = group
            .iter()
            .filter(|order| {
                order
                    .open_or_close
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case("open"))
            })
            .cloned()
            .collect::<Vec<_>>();
        let closes = group
            .iter()
            .filter(|order| {
                order
                    .open_or_close
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case("close"))
            })
            .cloned()
            .collect::<Vec<_>>();
        let initial_candidate = opens.len() == 2
            && opens[0].put_call != opens[1].put_call
            && opens[0].underlying == opens[1].underlying
            && opens[0].expiration_date == opens[1].expiration_date
            && opens[0].side == opens[1].side
            && opens[0].quantity == opens[1].quantity;
        let tracked_close = closes.iter().any(|order| tx.query_row("SELECT EXISTS(SELECT 1 FROM journal_option_legs l JOIN journal_trades t ON t.id=l.trade_id WHERE t.provider='schwab' AND t.account_id=?1 AND t.status='open' AND l.option_symbol=?2 AND l.opened_quantity>l.closed_quantity)", params![order.account_id,order.symbol], |row| row.get::<_,bool>(0)).unwrap_or(false));
        if !initial_candidate && !tracked_close {
            continue;
        }
        for order in &group {
            insert_option_event(
                &tx,
                None,
                order,
                "order-observed",
                &option_observed_at(order),
                source,
                order.filled_quantity,
                order.average_fill_price,
                "Schwab option order observed",
            )?;
        }
        let mut matched = vec![];
        for close in &closes {
            let next = apply_option_close(&tx, close, fee_rate, source)?;
            fills += usize::from(!next.is_empty());
            matched.extend(next);
        }
        let mut affected = matched
            .iter()
            .map(|item| item.0.clone())
            .collect::<Vec<_>>();
        affected.sort();
        affected.dedup();
        let latest_close = closes.iter().map(option_observed_at).max();
        for trade_id in &affected {
            refresh_option_campaign(&tx, trade_id, latest_close.as_deref())?;
        }
        if initial_candidate
            && opens
                .iter()
                .any(|order| order.filled_quantity.unwrap_or_default() > 0.0)
        {
            let direction = if opens[0].side == "Sell" {
                "Short"
            } else {
                "Long"
            };
            let account = opens[0].account_id.as_deref().unwrap_or_default();
            let trade_id =
                match active_exact_strangle(&tx, account, &opens[0], &opens[1], direction)? {
                    Some(id) => id,
                    None => create_option_campaign(
                        &tx,
                        account,
                        &opens[0],
                        direction,
                        &opens
                            .iter()
                            .map(option_observed_at)
                            .min()
                            .unwrap_or_else(now),
                    )?,
                };
            for open in &opens {
                let before = open.filled_quantity.unwrap_or_default();
                upsert_option_open(&tx, &trade_id, open, fee_rate, source, None)?;
                fills += usize::from(before > 0.0);
            }
            refresh_option_campaign(&tx, &trade_id, None)?;
        } else if opens.len() == 1 && closes.len() == 1 {
            if let Some((trade_id, replaced_leg)) = matched.first() {
                upsert_option_open(
                    &tx,
                    trade_id,
                    &opens[0],
                    fee_rate,
                    source,
                    Some(replaced_leg),
                )?;
                fills += usize::from(opens[0].filled_quantity.unwrap_or_default() > 0.0);
                refresh_option_campaign(&tx, trade_id, None)?;
            }
        }
    }
    tx.commit()?;
    Ok(JournalIngestResult {
        fills,
        unmatched_closes: vec![],
    })
}

fn stable_id(value: &str) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn parse_broker_timestamp(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    DateTime::parse_from_rfc3339(value)
        .or_else(|_| {
            let bytes = value.as_bytes();
            let offset_start = bytes.len().checked_sub(5);
            if offset_start.is_some_and(|index| {
                matches!(bytes[index], b'+' | b'-')
                    && bytes[index + 1..].iter().all(u8::is_ascii_digit)
            }) {
                let split = value.len() - 2;
                DateTime::parse_from_rfc3339(&format!("{}:{}", &value[..split], &value[split..]))
            } else {
                DateTime::parse_from_rfc3339(value)
            }
        })
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn parse_record_from(value: Option<&str>) -> Option<DateTime<Utc>> {
    value.and_then(parse_broker_timestamp)
}

fn order_recorded_at(order: &OrderUpdate) -> Option<DateTime<Utc>> {
    let timestamp = if order.timestamp.trim().is_empty() {
        order.closed_at.as_deref()
    } else {
        Some(order.timestamp.as_str())
    };
    timestamp.and_then(parse_broker_timestamp)
}

fn order_is_recordable(order: &OrderUpdate, cutoff: Option<DateTime<Utc>>) -> bool {
    cutoff.is_none_or(|cutoff| order_recorded_at(order).is_none_or(|occurred| occurred >= cutoff))
}

pub fn record_from(path: &Path) -> Result<Option<String>, AppError> {
    Ok(config(path)?.and_then(|value| value.record_from))
}
fn environment_key(environment: &TradingEnvironment) -> &'static str {
    environment.key()
}

fn matching_entry_intent(
    db: &Connection,
    env: &str,
    account_id: &str,
    order: &OrderUpdate,
) -> Result<Option<JournalIntentMatch>, AppError> {
    let map = |row: &rusqlite::Row<'_>| {
        Ok(JournalIntentMatch {
            id: row.get(0)?,
            original_stop: row.get(1)?,
            original_target: row.get(2)?,
            quantity: row.get(3)?,
            point_value: row.get(4)?,
        })
    };
    let direct = db
        .query_row(
            "SELECT id,original_stop,original_target,quantity,point_value FROM journal_intents WHERE broker_order_id=?1 AND status='confirmed'",
            params![order.id],
            map,
        )
        .optional()?;
    if direct.is_some() {
        return Ok(direct);
    }
    if order
        .open_or_close
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("close"))
    {
        return Ok(None);
    }
    let occurred_at = if order.timestamp.is_empty() {
        now()
    } else {
        order.timestamp.clone()
    };
    let fallback = db
        .query_row(
            "SELECT i.id,i.original_stop,i.original_target,i.quantity,i.point_value FROM journal_intents i LEFT JOIN journal_events e ON e.event_key=('intent:' || i.id) WHERE i.environment=?1 AND i.account_id=?2 AND i.symbol=?3 AND i.side=?4 COLLATE NOCASE AND i.status='confirmed' AND e.trade_id IS NULL AND ABS((julianday(i.created_at)-julianday(?5))*86400.0)<=3600 ORDER BY i.created_at DESC LIMIT 1",
            params![env, account_id, order.symbol, order.side, occurred_at],
            map,
        )
        .optional()?;
    if let Some(intent) = fallback.as_ref() {
        db.execute(
            "UPDATE journal_intents SET broker_order_id=COALESCE(broker_order_id,?1) WHERE id=?2",
            params![order.id, intent.id],
        )?;
        db.execute(
            "UPDATE journal_events SET broker_order_id=COALESCE(broker_order_id,?1),synced=0 WHERE event_key=?2",
            params![order.id, format!("intent:{}", intent.id)],
        )?;
    }
    Ok(fallback)
}

fn repair_active_trade_risk_from_intent(
    db: &Connection,
    env: &str,
    account_id: &str,
    order: &OrderUpdate,
) -> Result<bool, AppError> {
    let Some(mut trade) = query_active_trade(db, env, account_id, &order.symbol)? else {
        return Ok(false);
    };
    let opening_side = (trade.direction == "Long" && order.side.eq_ignore_ascii_case("buy"))
        || (trade.direction == "Short" && order.side.eq_ignore_ascii_case("sell"));
    if !opening_side || trade.risk_provenance == "exact" {
        return Ok(false);
    }
    let Some(intent) = matching_entry_intent(db, env, account_id, order)? else {
        return Ok(false);
    };
    let Some(stop) = intent.original_stop else {
        return Ok(false);
    };
    let Some(point_value) = intent.point_value.or(trade.point_value) else {
        return Ok(false);
    };
    trade.original_stop = Some(stop);
    trade.original_target = intent.original_target.or(trade.original_target);
    trade.point_value = Some(point_value);
    trade.planned_risk = Some((trade.average_entry - stop).abs() * point_value * intent.quantity);
    trade.deployed_risk =
        Some((trade.average_entry - stop).abs() * point_value * trade.entry_quantity);
    trade.risk_provenance = "exact".into();
    save_trade(db, &trade)?;
    db.execute(
        "UPDATE journal_events SET trade_id=?1,synced=0 WHERE event_key=?2",
        params![trade.id, format!("intent:{}", intent.id)],
    )?;
    insert_event(
        db,
        &format!("risk-reconciled:{}:{}", trade.id, intent.id),
        Some(&trade.id),
        env,
        account_id,
        Some(&order.id),
        "risk-added",
        &now(),
        "northstar",
        Some("confirmed"),
        Some(stop),
        Some(trade.average_entry),
        Some(trade.entry_quantity),
        None,
        Some("Exact submitted risk linked during order reconciliation"),
    )?;
    Ok(true)
}
fn parse_environment(value: String) -> TradingEnvironment {
    if value == "live" {
        TradingEnvironment::Live
    } else {
        TradingEnvironment::Sim
    }
}
fn mask_account(value: &str) -> String {
    if value.len() <= 4 {
        value.to_string()
    } else {
        format!(
            "{} ··{}",
            &value[..value.len().min(3)],
            &value[value.len() - 4..]
        )
    }
}

fn insert_event(
    db: &Connection,
    event_key: &str,
    trade_id: Option<&str>,
    environment: &str,
    account_id: &str,
    broker_order_id: Option<&str>,
    event_type: &str,
    occurred_at: &str,
    source: &str,
    status: Option<&str>,
    old_price: Option<f64>,
    new_price: Option<f64>,
    quantity: Option<f64>,
    price: Option<f64>,
    note: Option<&str>,
) -> Result<(), AppError> {
    let id = stable_id(event_key);
    db.execute("INSERT OR IGNORE INTO journal_events(id,event_key,trade_id,environment,account_id,broker_order_id,event_type,occurred_at,source,status,old_price,new_price,quantity,price,note) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)", params![id,event_key,trade_id,environment,account_id,broker_order_id,event_type,occurred_at,source,status,old_price,new_price,quantity,price,note])?;
    Ok(())
}

pub fn start_entry_intent(
    path: &Path,
    environment: &TradingEnvironment,
    order: &OrderDraft,
    meta: &SymbolMeta,
) -> Result<String, AppError> {
    init(path)?;
    let db = Connection::open(path)?;
    let id = uuid::Uuid::new_v4().to_string();
    let created = now();
    db.execute("INSERT INTO journal_intents(id,environment,account_id,symbol,side,quantity,original_stop,original_target,point_value,created_at,status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'requested')", params![id,environment_key(environment),order.account_id,order.symbol,order.side,order.quantity as f64,order.stop_loss,order.take_profit,meta.point_value,created])?;
    insert_event(
        &db,
        &format!("intent:{id}"),
        None,
        environment_key(environment),
        &order.account_id,
        None,
        "entry-intent",
        &created,
        "northstar",
        Some("requested"),
        None,
        None,
        Some(order.quantity as f64),
        None,
        Some("Entry and bracket submitted"),
    )?;
    Ok(id)
}

pub fn complete_entry_intent(
    path: &Path,
    intent_id: &str,
    order: &OrderUpdate,
) -> Result<(), AppError> {
    let db = Connection::open(path)?;
    db.execute(
        "UPDATE journal_intents SET broker_order_id=?1,status='confirmed' WHERE id=?2",
        params![order.id, intent_id],
    )?;
    db.execute("UPDATE journal_events SET broker_order_id=?1,status='confirmed',synced=0 WHERE event_key=?2",params![order.id,format!("intent:{intent_id}")])?;
    Ok(())
}

pub fn fail_entry_intent(path: &Path, intent_id: &str, message: &str) -> Result<(), AppError> {
    let db = Connection::open(path)?;
    db.execute(
        "UPDATE journal_intents SET status='failed' WHERE id=?1",
        params![intent_id],
    )?;
    db.execute("UPDATE journal_events SET event_type='order-rejected',status='failed',note=?1,synced=0 WHERE event_key=?2",params![message,format!("intent:{intent_id}")])?;
    Ok(())
}

pub fn record_order_move(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
    order: &OrderUpdate,
    old_price: Option<f64>,
    new_price: f64,
    status: &str,
    note: Option<&str>,
) -> Result<(), AppError> {
    init(path)?;
    let db = Connection::open(path)?;
    let event_type = if order.order_type == "Limit" {
        "target-move"
    } else {
        "stop-move"
    };
    let trade_id: Option<String> = db.query_row("SELECT id FROM journal_trades WHERE environment=?1 AND account_id=?2 AND symbol=?3 AND status='open' ORDER BY opened_at DESC LIMIT 1",params![environment_key(environment),account_id,order.symbol],|row|row.get(0)).optional()?;
    let occurred = now();
    let key = format!("move:{}:{new_price}:{status}:{occurred}", order.id);
    insert_event(
        &db,
        &key,
        trade_id.as_deref(),
        environment_key(environment),
        account_id,
        Some(&order.id),
        event_type,
        &occurred,
        "northstar",
        Some(status),
        old_price,
        Some(new_price),
        None,
        None,
        note,
    )?;
    let protective_price = if status == "failed" {
        old_price
    } else {
        Some(new_price)
    };
    if let Some(price) = protective_price {
        db.execute(
            "INSERT INTO journal_protective_state(environment,account_id,order_id,order_type,last_price) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(environment,account_id,order_id) DO UPDATE SET order_type=excluded.order_type,last_price=excluded.last_price",
            params![environment_key(environment),account_id,order.id,order.order_type,price],
        )?;
    }
    Ok(())
}

pub fn record_close_intent(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
    symbol: &str,
    status: &str,
    note: Option<&str>,
) -> Result<(), AppError> {
    init(path)?;
    let db = Connection::open(path)?;
    let trade_id: Option<String> = db.query_row("SELECT id FROM journal_trades WHERE environment=?1 AND account_id=?2 AND symbol=?3 AND status='open' ORDER BY opened_at DESC LIMIT 1",params![environment_key(environment),account_id,symbol],|row|row.get(0)).optional()?;
    let occurred = now();
    insert_event(
        &db,
        &format!("close:{account_id}:{symbol}:{occurred}:{status}"),
        trade_id.as_deref(),
        environment_key(environment),
        account_id,
        None,
        "close-intent",
        &occurred,
        "northstar",
        Some(status),
        None,
        None,
        None,
        None,
        note,
    )
}

pub fn record_cancel_intent(
    path: &Path,
    environment: &TradingEnvironment,
    order_id: &str,
    status: &str,
    note: Option<&str>,
) -> Result<(), AppError> {
    init(path)?;
    let db = Connection::open(path)?;
    let context: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT account_id,trade_id FROM journal_events WHERE broker_order_id=?1 ORDER BY trade_id IS NOT NULL DESC, occurred_at DESC LIMIT 1",
            params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (account_id, trade_id) = context.unwrap_or_else(|| ("unattributed".into(), None));
    let occurred = now();
    insert_event(
        &db,
        &format!("cancel:{order_id}:{status}:{occurred}"),
        trade_id.as_deref(),
        environment_key(environment),
        &account_id,
        Some(order_id),
        "cancel-intent",
        &occurred,
        "northstar",
        Some(status),
        None,
        None,
        None,
        None,
        note,
    )
}

pub fn ingest_orders(
    path: &Path,
    environment: &TradingEnvironment,
    orders: &[OrderUpdate],
    source: &str,
    point_values: &HashMap<String, f64>,
) -> Result<JournalIngestResult, AppError> {
    init(path)?;
    let cutoff = parse_record_from(record_from(path)?.as_deref());
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    let env = environment_key(environment);
    let mut fills = 0;
    let mut unmatched_closes = Vec::new();
    let mut ordered = orders.to_vec();
    ordered.sort_by(|a, b| {
        let a_time = a
            .closed_at
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(&a.timestamp);
        let b_time = b
            .closed_at
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(&b.timestamp);
        let close_rank = |order: &OrderUpdate| {
            if order
                .open_or_close
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case("open"))
            {
                0
            } else if order
                .open_or_close
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case("close"))
            {
                2
            } else {
                1
            }
        };
        a_time
            .cmp(b_time)
            .then_with(|| close_rank(a).cmp(&close_rank(b)))
    });
    for order in ordered {
        if !order_is_recordable(&order, cutoff) {
            continue;
        }
        if order.id.is_empty() || order.symbol.is_empty() {
            continue;
        }
        let account = order.account_id.clone().unwrap_or_default();
        if account.is_empty() {
            continue;
        }
        let filled = order.filled_quantity.unwrap_or(0.0);
        let commission = filled * commission_per_contract_side(&tx)?;
        let previous: Option<(f64,f64)>=tx.query_row("SELECT filled_quantity,commission FROM journal_order_state WHERE environment=?1 AND account_id=?2 AND order_id=?3",params![env,account,order.id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        let (prior_filled, prior_commission) = previous.unwrap_or((0.0, 0.0));
        let delta = (filled - prior_filled).max(0.0);
        let fee_delta = (commission - prior_commission).max(0.0);
        let observed_at = if order.closed_at.as_deref().is_some_and(|v| !v.is_empty()) {
            order.closed_at.clone().unwrap()
        } else if order.timestamp.is_empty() {
            now()
        } else {
            order.timestamp.clone()
        };
        let observed_key = format!(
            "order:{}:{}:{}:{}:{}",
            env, account, order.id, order.status, filled
        );
        insert_event(
            &tx,
            &observed_key,
            None,
            env,
            &account,
            Some(&order.id),
            "order-observed",
            &observed_at,
            source,
            Some("confirmed"),
            None,
            None,
            Some(filled),
            order.average_fill_price,
            None,
        )?;
        tx.execute("INSERT INTO journal_order_state(environment,account_id,order_id,filled_quantity,commission) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(environment,account_id,order_id) DO UPDATE SET filled_quantity=excluded.filled_quantity,commission=excluded.commission",params![env,account,order.id,filled,commission])?;
        if matches!(order.order_type.as_str(), "Limit" | "StopMarket") && order.status == "Working"
        {
            if let Some(current_price) = order.price.or(order.stop_price) {
                if let Some(mut trade) = query_active_trade(&tx, env, &account, &order.symbol)? {
                    let prior:Option<f64>=tx.query_row("SELECT last_price FROM journal_protective_state WHERE environment=?1 AND account_id=?2 AND order_id=?3",params![env,account,order.id],|row|row.get(0)).optional()?;
                    let kind = if order.order_type == "Limit" {
                        "target-move"
                    } else {
                        "stop-move"
                    };
                    if let Some(old) = prior {
                        if (old - current_price).abs() > 1e-9 {
                            insert_event(
                                &tx,
                                &format!("observed-move:{}:{current_price}", order.id),
                                Some(&trade.id),
                                env,
                                &account,
                                Some(&order.id),
                                kind,
                                &observed_at,
                                source,
                                Some("confirmed"),
                                Some(old),
                                Some(current_price),
                                None,
                                None,
                                Some("Protective price change observed from broker"),
                            )?;
                        }
                    } else if order.order_type == "StopMarket" && trade.original_stop.is_none() {
                        trade.original_stop = Some(current_price);
                        trade.risk_provenance = "inferred".into();
                        if let Some(pv) = trade.point_value {
                            trade.deployed_risk = Some(
                                (trade.average_entry - current_price).abs()
                                    * pv
                                    * trade.entry_quantity,
                            );
                        }
                        save_trade(&tx, &trade)?;
                    } else if order.order_type == "Limit" && trade.original_target.is_none() {
                        trade.original_target = Some(current_price);
                        if trade.risk_provenance == "unknown" {
                            trade.risk_provenance = "inferred".into();
                        }
                        save_trade(&tx, &trade)?;
                    }
                    tx.execute("INSERT INTO journal_protective_state(environment,account_id,order_id,order_type,last_price) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(environment,account_id,order_id) DO UPDATE SET order_type=excluded.order_type,last_price=excluded.last_price",params![env,account,order.id,order.order_type,current_price])?;
                }
            }
        }
        if delta <= 0.0 || order.average_fill_price.is_none() {
            if filled > 0.0 && order.average_fill_price.is_some() {
                repair_active_trade_risk_from_intent(&tx, env, &account, &order)?;
            }
            continue;
        }
        fills += 1;
        let fill_price = order.average_fill_price.unwrap();
        let active: Option<JournalTrade> = query_active_trade(&tx, env, &account, &order.symbol)?;
        let explicitly_close = order
            .open_or_close
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case("close"));
        let closes = explicitly_close
            || active.as_ref().is_some_and(|trade| {
                (trade.direction == "Long" && order.side == "Sell")
                    || (trade.direction == "Short" && order.side == "Buy")
            });
        if closes {
            if let Some(mut trade) = active {
                let close_qty = delta.min((trade.entry_quantity - trade.exit_quantity).max(0.0));
                let close_fee = if delta > 0.0 {
                    fee_delta * (close_qty / delta)
                } else {
                    0.0
                };
                if close_qty > 0.0 {
                    let prior_exit = trade.exit_quantity;
                    trade.average_exit = Some(
                        ((trade.average_exit.unwrap_or(0.0) * prior_exit)
                            + (fill_price * close_qty))
                            / (prior_exit + close_qty),
                    );
                    trade.exit_quantity += close_qty;
                    trade.fees += close_fee;
                    let pv = trade.point_value.unwrap_or(0.0);
                    let direction = if trade.direction == "Long" { 1.0 } else { -1.0 };
                    trade.gross_pnl = direction
                        * (trade.average_exit.unwrap_or(fill_price) - trade.average_entry)
                        * pv
                        * trade.exit_quantity;
                    trade.net_pnl = trade.gross_pnl - trade.fees;
                    if trade.deployed_risk.is_some_and(|risk| risk > 0.0) {
                        trade.r_multiple = Some(trade.gross_pnl / trade.deployed_risk.unwrap());
                    }
                    if trade.exit_quantity + 1e-9 >= trade.entry_quantity {
                        trade.status = "closed".into();
                        trade.closed_at = Some(observed_at.clone());
                    }
                    save_trade(&tx, &trade)?;
                    insert_event(
                        &tx,
                        &format!("fill:{}:{filled}", order.id),
                        Some(&trade.id),
                        env,
                        &account,
                        Some(&order.id),
                        "fill",
                        &observed_at,
                        source,
                        Some("confirmed"),
                        None,
                        None,
                        Some(close_qty),
                        Some(fill_price),
                        Some("Closing fill"),
                    )?;
                }
                let excess = delta - close_qty;
                if excess > 0.0 {
                    create_trade_from_fill(
                        &tx,
                        env,
                        &account,
                        &order,
                        excess,
                        fill_price,
                        fee_delta - close_fee,
                        point_values.get(&order.symbol).copied(),
                        source,
                        &observed_at,
                    )?;
                }
            } else {
                tx.execute(
                    "DELETE FROM journal_order_state WHERE environment=?1 AND account_id=?2 AND order_id=?3",
                    params![env, account, order.id],
                )?;
                insert_event(
                    &tx,
                    &format!("unmatched-close:{env}:{account}:{}:{filled}", order.id),
                    None,
                    env,
                    &account,
                    Some(&order.id),
                    "unmatched-close",
                    &observed_at,
                    source,
                    Some("pending-reconciliation"),
                    None,
                    None,
                    Some(delta),
                    Some(fill_price),
                    Some("Closing fill arrived before its opening campaign; historical reconciliation queued"),
                )?;
                unmatched_closes.push(order.clone());
            }
        } else if let Some(mut trade) = active {
            let intent = matching_entry_intent(&tx, env, &account, &order)?;
            if let Some(intent) = intent {
                let stop = intent.original_stop;
                let planned_qty = intent.quantity;
                let pv = intent.point_value;
                if let (Some(stop), Some(pv)) = (stop, pv.or(trade.point_value)) {
                    trade.planned_risk = Some(
                        trade.planned_risk.unwrap_or(0.0)
                            + (fill_price - stop).abs() * pv * planned_qty,
                    );
                    trade.deployed_risk = Some(
                        trade.deployed_risk.unwrap_or(0.0) + (fill_price - stop).abs() * pv * delta,
                    );
                    trade.risk_provenance = "exact".into();
                    trade.original_stop = trade.original_stop.or(Some(stop));
                    insert_event(
                        &tx,
                        &format!("risk:{}:{filled}", order.id),
                        Some(&trade.id),
                        env,
                        &account,
                        Some(&order.id),
                        "risk-added",
                        &observed_at,
                        "northstar",
                        Some("confirmed"),
                        Some(stop),
                        Some(fill_price),
                        Some(delta),
                        None,
                        Some("Deployed entry risk from the immutable submitted stop"),
                    )?;
                }
                tx.execute(
                    "UPDATE journal_events SET trade_id=?1,synced=0 WHERE event_key=?2",
                    params![trade.id, format!("intent:{}", intent.id)],
                )?;
            }
            let prior = trade.entry_quantity;
            trade.average_entry =
                ((trade.average_entry * prior) + (fill_price * delta)) / (prior + delta);
            trade.entry_quantity += delta;
            trade.fees += fee_delta;
            trade.net_pnl = trade.gross_pnl - trade.fees;
            save_trade(&tx, &trade)?;
            insert_event(
                &tx,
                &format!("fill:{}:{filled}", order.id),
                Some(&trade.id),
                env,
                &account,
                Some(&order.id),
                "fill",
                &observed_at,
                source,
                Some("confirmed"),
                None,
                None,
                Some(delta),
                Some(fill_price),
                Some("Scale-in fill"),
            )?;
        } else {
            create_trade_from_fill(
                &tx,
                env,
                &account,
                &order,
                delta,
                fill_price,
                fee_delta,
                point_values.get(&order.symbol).copied(),
                source,
                &observed_at,
            )?;
        }
    }
    tx.commit()?;
    Ok(JournalIngestResult {
        fills,
        unmatched_closes,
    })
}

pub fn repair_misclassified_close_campaigns(
    path: &Path,
    environment: &TradingEnvironment,
    orders: &[OrderUpdate],
) -> Result<usize, AppError> {
    init(path)?;
    let cutoff = parse_record_from(record_from(path)?.as_deref());
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    let env = environment_key(environment);
    let mut repaired = 0;
    for order in orders.iter().filter(|order| {
        order_is_recordable(order, cutoff)
            && order.filled_quantity.unwrap_or(0.0) > 0.0
            && order
                .open_or_close
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case("close"))
    }) {
        let account_id = order.account_id.clone().unwrap_or_default();
        if account_id.is_empty() || order.symbol.is_empty() {
            continue;
        }
        let bad_id = stable_id(&format!("{env}:{account_id}:{}:{}", order.symbol, order.id));
        let bad_direction = if order.side == "Buy" { "Long" } else { "Short" };
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM journal_trades WHERE id=?1 AND direction=?2)",
            params![bad_id, bad_direction],
            |row| row.get(0),
        )?;
        if !exists {
            continue;
        }
        let allocated_to_other_trades: f64 = tx.query_row(
            "SELECT COALESCE(SUM(ABS(quantity)),0) FROM journal_events WHERE broker_order_id=?1 AND event_type='fill' AND trade_id IS NOT NULL AND trade_id<>?2",
            params![order.id, bad_id],
            |row| row.get(0),
        )?;
        let filled = order.filled_quantity.unwrap_or(0.0);
        if allocated_to_other_trades > 1e-9 && allocated_to_other_trades + 1e-9 < filled {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO journal_trade_tombstones(trade_id,created_at) VALUES(?1,?2)",
            params![bad_id, now()],
        )?;
        tx.execute(
            "DELETE FROM journal_annotations WHERE trade_id=?1",
            params![bad_id],
        )?;
        tx.execute(
            "DELETE FROM journal_screenshots WHERE trade_id=?1",
            params![bad_id],
        )?;
        tx.execute(
            "UPDATE journal_events SET trade_id=NULL WHERE trade_id=?1",
            params![bad_id],
        )?;
        tx.execute("DELETE FROM journal_trades WHERE id=?1", params![bad_id])?;
        tx.execute(
            "DELETE FROM journal_order_state WHERE environment=?1 AND account_id=?2 AND order_id=?3",
            params![env, account_id, order.id],
        )?;
        repaired += 1;
    }
    tx.commit()?;
    Ok(repaired)
}

pub fn repair_mirrored_duplicate_trades(path: &Path) -> Result<usize, AppError> {
    init(path)?;
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    let trade_ids = {
        let mut stmt = tx.prepare(
            "WITH reversed AS (
               SELECT id FROM journal_trades WHERE closed_at IS NOT NULL AND julianday(closed_at)<julianday(opened_at)
             ), candidate_orders AS (
               SELECT reversed.id AS candidate_id,journal_events.broker_order_id
               FROM reversed
               JOIN journal_events ON journal_events.trade_id=reversed.id AND journal_events.event_type='fill' AND journal_events.broker_order_id IS NOT NULL
               GROUP BY reversed.id,journal_events.broker_order_id
             ), candidate_totals AS (
               SELECT candidate_id,COUNT(*) AS order_count FROM candidate_orders GROUP BY candidate_id
             ), mirrored_orders AS (
               SELECT candidate_orders.candidate_id,other_events.trade_id AS valid_trade_id,COUNT(*) AS matched_orders
               FROM candidate_orders
               JOIN journal_events AS other_events ON other_events.event_type='fill' AND other_events.broker_order_id=candidate_orders.broker_order_id AND other_events.trade_id IS NOT NULL AND other_events.trade_id<>candidate_orders.candidate_id
               JOIN journal_trades AS valid_trade ON valid_trade.id=other_events.trade_id AND valid_trade.closed_at IS NOT NULL AND julianday(valid_trade.closed_at)>=julianday(valid_trade.opened_at)
               GROUP BY candidate_orders.candidate_id,other_events.trade_id
             )
             SELECT DISTINCT mirrored_orders.candidate_id
             FROM mirrored_orders
             JOIN candidate_totals ON candidate_totals.candidate_id=mirrored_orders.candidate_id
             WHERE candidate_totals.order_count>=2 AND mirrored_orders.matched_orders=candidate_totals.order_count",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for trade_id in &trade_ids {
        tx.execute(
            "INSERT OR IGNORE INTO journal_trade_tombstones(trade_id,created_at) VALUES(?1,?2)",
            params![trade_id, now()],
        )?;
        tx.execute(
            "DELETE FROM journal_annotations WHERE trade_id=?1",
            params![trade_id],
        )?;
        tx.execute(
            "DELETE FROM journal_screenshots WHERE trade_id=?1",
            params![trade_id],
        )?;
        tx.execute(
            "UPDATE journal_events SET trade_id=NULL WHERE trade_id=?1",
            params![trade_id],
        )?;
        tx.execute("DELETE FROM journal_trades WHERE id=?1", params![trade_id])?;
    }
    tx.commit()?;
    Ok(trade_ids.len())
}

fn create_trade_from_fill(
    db: &Connection,
    env: &str,
    account: &str,
    order: &OrderUpdate,
    quantity: f64,
    fill_price: f64,
    fees: f64,
    point_value: Option<f64>,
    source: &str,
    occurred: &str,
) -> Result<(), AppError> {
    let id = stable_id(&format!("{env}:{account}:{}:{}", order.symbol, order.id));
    let direction = if order.side == "Buy" { "Long" } else { "Short" };
    let intent = matching_entry_intent(db, env, account, order)?;
    let (stop, target, planned_qty, intent_pv) = intent
        .as_ref()
        .map(|intent| {
            (
                intent.original_stop,
                intent.original_target,
                intent.quantity,
                intent.point_value,
            )
        })
        .unwrap_or((None, None, quantity, None));
    let pv = intent_pv.or(point_value);
    let planned = stop
        .zip(pv)
        .map(|(s, p)| (fill_price - s).abs() * p * planned_qty);
    let deployed = stop
        .zip(pv)
        .map(|(s, p)| (fill_price - s).abs() * p * quantity);
    let provenance = if deployed.is_some() {
        "exact"
    } else {
        "unknown"
    };
    let trade = JournalTrade {
        id: id.clone(),
        provider: MarketDataProvider::Tradestation,
        environment: parse_environment(env.into()),
        account_id: account.into(),
        symbol: order.symbol.clone(),
        direction: direction.into(),
        asset_class: "futures".into(),
        strategy: "futures-directional".into(),
        underlying: None,
        status: "open".into(),
        opened_at: occurred.into(),
        closed_at: None,
        entry_quantity: quantity,
        exit_quantity: 0.0,
        average_entry: fill_price,
        average_exit: None,
        original_stop: stop,
        original_target: target,
        planned_risk: planned,
        deployed_risk: deployed,
        point_value: pv,
        gross_pnl: 0.0,
        fees,
        net_pnl: -fees,
        r_multiple: None,
        risk_provenance: provenance.into(),
        notes: String::new(),
        tags: vec![],
        events: None,
        entry_screenshot: None,
        legs: None,
    };
    save_trade(db, &trade)?;
    if let Some(intent) = intent.as_ref() {
        db.execute(
            "UPDATE journal_events SET trade_id=?1,synced=0 WHERE event_key=?2",
            params![id, format!("intent:{}", intent.id)],
        )?;
    }
    if let (Some(stop), Some(_)) = (stop, pv) {
        insert_event(
            db,
            &format!(
                "risk:{}:{}",
                order.id,
                order.filled_quantity.unwrap_or(quantity)
            ),
            Some(&id),
            env,
            account,
            Some(&order.id),
            "risk-added",
            occurred,
            "northstar",
            Some("confirmed"),
            Some(stop),
            Some(fill_price),
            Some(quantity),
            None,
            Some("Deployed entry risk from the immutable submitted stop"),
        )?;
    }
    insert_event(
        db,
        &format!(
            "fill:{}:{}:open:{}",
            order.id,
            order.filled_quantity.unwrap_or(quantity),
            id
        ),
        Some(&id),
        env,
        account,
        Some(&order.id),
        "fill",
        occurred,
        source,
        Some("confirmed"),
        None,
        None,
        Some(quantity),
        Some(fill_price),
        Some("Opening fill"),
    )?;
    Ok(())
}

fn save_trade(db: &Connection, trade: &JournalTrade) -> Result<(), AppError> {
    db.execute("INSERT INTO journal_trades(id,environment,account_id,symbol,direction,status,opened_at,closed_at,entry_quantity,exit_quantity,average_entry,average_exit,original_stop,original_target,planned_risk,deployed_risk,point_value,gross_pnl,fees,net_pnl,r_multiple,risk_provenance,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23) ON CONFLICT(id) DO UPDATE SET status=excluded.status,closed_at=excluded.closed_at,entry_quantity=excluded.entry_quantity,exit_quantity=excluded.exit_quantity,average_entry=excluded.average_entry,average_exit=excluded.average_exit,original_stop=excluded.original_stop,original_target=excluded.original_target,planned_risk=excluded.planned_risk,deployed_risk=excluded.deployed_risk,point_value=excluded.point_value,gross_pnl=excluded.gross_pnl,fees=excluded.fees,net_pnl=excluded.net_pnl,r_multiple=excluded.r_multiple,risk_provenance=excluded.risk_provenance,updated_at=excluded.updated_at",params![trade.id,environment_key(&trade.environment),trade.account_id,trade.symbol,trade.direction,trade.status,trade.opened_at,trade.closed_at,trade.entry_quantity,trade.exit_quantity,trade.average_entry,trade.average_exit,trade.original_stop,trade.original_target,trade.planned_risk,trade.deployed_risk,trade.point_value,trade.gross_pnl,trade.fees,trade.net_pnl,trade.r_multiple,trade.risk_provenance,now()])?;
    Ok(())
}

fn query_active_trade(
    db: &Connection,
    env: &str,
    account: &str,
    symbol: &str,
) -> Result<Option<JournalTrade>, AppError> {
    db.query_row("SELECT id,environment,account_id,symbol,direction,status,opened_at,closed_at,entry_quantity,exit_quantity,average_entry,average_exit,original_stop,original_target,planned_risk,deployed_risk,point_value,gross_pnl,fees,net_pnl,r_multiple,risk_provenance,provider,asset_class,strategy,underlying FROM journal_trades WHERE provider='tradestation' AND environment=?1 AND account_id=?2 AND symbol=?3 AND status='open' ORDER BY opened_at DESC LIMIT 1",params![env,account,symbol],trade_from_row).optional().map_err(Into::into)
}

pub fn has_active_trade(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
    symbol: &str,
) -> Result<bool, AppError> {
    init(path)?;
    Ok(query_active_trade(
        &Connection::open(path)?,
        environment_key(environment),
        account_id,
        symbol,
    )?
    .is_some())
}

fn trade_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JournalTrade> {
    Ok(JournalTrade {
        id: row.get(0)?,
        provider: match row.get::<_, String>(22)?.as_str() {
            "schwab" => MarketDataProvider::Schwab,
            _ => MarketDataProvider::Tradestation,
        },
        environment: parse_environment(row.get(1)?),
        account_id: row.get(2)?,
        symbol: row.get(3)?,
        direction: row.get(4)?,
        asset_class: row.get(23)?,
        strategy: row.get(24)?,
        underlying: row.get(25)?,
        status: row.get(5)?,
        opened_at: row.get(6)?,
        closed_at: row.get(7)?,
        entry_quantity: row.get(8)?,
        exit_quantity: row.get(9)?,
        average_entry: row.get(10)?,
        average_exit: row.get(11)?,
        original_stop: row.get(12)?,
        original_target: row.get(13)?,
        planned_risk: row.get(14)?,
        deployed_risk: row.get(15)?,
        point_value: row.get(16)?,
        gross_pnl: row.get(17)?,
        fees: row.get(18)?,
        net_pnl: row.get(19)?,
        r_multiple: row.get(20)?,
        risk_provenance: row.get(21)?,
        notes: String::new(),
        tags: vec![],
        events: None,
        entry_screenshot: None,
        legs: None,
    })
}

fn load_option_legs(db: &Connection, trade_id: &str) -> Result<Vec<JournalOptionLeg>, AppError> {
    let mut stmt = db.prepare("SELECT id,trade_id,option_symbol,underlying,expiration_date,strike_price,put_call,opening_side,opened_quantity,closed_quantity,average_entry,average_exit,multiplier,gross_pnl,fees,status,replaces_leg_id FROM journal_option_legs WHERE trade_id=?1 ORDER BY put_call,strike_price,updated_at")?;
    let rows = stmt
        .query_map(params![trade_id], |row| {
            Ok(JournalOptionLeg {
                id: row.get(0)?,
                trade_id: row.get(1)?,
                option_symbol: row.get(2)?,
                underlying: row.get(3)?,
                expiration_date: row.get(4)?,
                strike_price: row.get(5)?,
                put_call: row.get(6)?,
                opening_side: row.get(7)?,
                opened_quantity: row.get(8)?,
                closed_quantity: row.get(9)?,
                average_entry: row.get(10)?,
                average_exit: row.get(11)?,
                multiplier: row.get(12)?,
                gross_pnl: row.get(13)?,
                fees: row.get(14)?,
                status: row.get(15)?,
                replaces_leg_id: row.get(16)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn load_trades(path: &Path, scope: Option<&JournalScope>) -> Result<Vec<JournalTrade>, AppError> {
    init(path)?;
    let db = Connection::open(path)?;
    let mut sql="SELECT id,environment,account_id,symbol,direction,status,opened_at,closed_at,entry_quantity,exit_quantity,average_entry,average_exit,original_stop,original_target,planned_risk,deployed_risk,point_value,gross_pnl,fees,net_pnl,r_multiple,risk_provenance,provider,asset_class,strategy,underlying FROM journal_trades".to_string();
    if scope.is_some() {
        sql.push_str(" WHERE provider=?1 AND environment=?2 AND account_id=?3");
    }
    sql.push_str(" ORDER BY opened_at");
    let mut stmt = db.prepare(&sql)?;
    let rows = if let Some(s) = scope {
        stmt.query_map(
            params![
                s.provider.key(),
                environment_key(&s.environment),
                s.account_id
            ],
            trade_from_row,
        )?
        .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map([], trade_from_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut trades = rows;
    for trade in &mut trades {
        if let Some((notes, tags)) = db
            .query_row(
                "SELECT notes,tags FROM journal_annotations WHERE trade_id=?1",
                params![trade.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            trade.notes = notes;
            trade.tags = serde_json::from_str(&tags).unwrap_or_default();
        }
        trade.entry_screenshot = db
            .query_row(
                "SELECT captured_at,width,height,content_type FROM journal_screenshots WHERE trade_id=?1",
                params![trade.id],
                |row| Ok(JournalScreenshotMetadata {
                    trade_id: trade.id.clone(),
                    captured_at: row.get(0)?,
                    width: row.get(1)?,
                    height: row.get(2)?,
                    content_type: row.get(3)?,
                }),
            )
            .optional()?;
        if trade.asset_class == "option" {
            trade.legs = Some(load_option_legs(&db, &trade.id)?);
        }
    }
    Ok(trades)
}

fn nth_sunday_utc(year: i32, month: u32, nth: u32, hour: u32) -> DateTime<Utc> {
    let first = Utc
        .with_ymd_and_hms(year, month, 1, hour, 0, 0)
        .single()
        .unwrap();
    let offset = (7 - first.weekday().num_days_from_sunday()) % 7 + 7 * (nth - 1);
    first + Duration::days(offset as i64)
}
fn ny_date(iso: &str) -> Option<String> {
    parse_broker_timestamp(iso).map(|utc| {
        let year = utc.year();
        let dst_start = nth_sunday_utc(year, 3, 2, 7);
        let dst_end = nth_sunday_utc(year, 11, 1, 6);
        let offset = if utc >= dst_start && utc < dst_end {
            -4
        } else {
            -5
        };
        (utc + Duration::hours(offset))
            .format("%Y-%m-%d")
            .to_string()
    })
}
fn metrics(trades: &[JournalTrade]) -> JournalSummaryMetrics {
    let closed: Vec<_> = trades.iter().filter(|t| t.status == "closed").collect();
    let net = closed.iter().map(|t| t.net_pnl).sum();
    let wins: Vec<_> = closed.iter().filter(|t| t.net_pnl > 0.0).collect();
    let positive: f64 = wins.iter().map(|t| t.net_pnl).sum();
    let negative: f64 = closed
        .iter()
        .filter(|t| t.net_pnl < 0.0)
        .map(|t| t.net_pnl.abs())
        .sum();
    let r: Vec<f64> = closed.iter().filter_map(|t| t.r_multiple).collect();
    JournalSummaryMetrics {
        net_pnl: net,
        gross_pnl: closed.iter().map(|t| t.gross_pnl).sum(),
        fees: closed.iter().map(|t| t.fees).sum(),
        trades: trades.len(),
        closed_trades: closed.len(),
        win_rate: if closed.is_empty() {
            None
        } else {
            Some(wins.len() as f64 / closed.len() as f64)
        },
        total_r: if r.is_empty() {
            None
        } else {
            Some(r.iter().sum())
        },
        average_trade: if closed.is_empty() {
            None
        } else {
            Some(net / closed.len() as f64)
        },
        profit_factor: if negative > 0.0 {
            Some(positive / negative)
        } else if positive > 0.0 {
            Some(f64::INFINITY)
        } else {
            None
        },
        long_trades: trades.iter().filter(|t| t.direction == "Long").count(),
        short_trades: trades.iter().filter(|t| t.direction == "Short").count(),
    }
}

pub fn scopes(path: &Path) -> Result<Vec<JournalScope>, AppError> {
    let trades = load_trades(path, None)?;
    let mut result = vec![];
    for trade in trades {
        if !result.iter().any(|s: &JournalScope| {
            s.provider == trade.provider
                && s.account_id == trade.account_id
                && s.environment == trade.environment
        }) {
            result.push(JournalScope {
                provider: trade.provider,
                environment: trade.environment,
                account_label: mask_account(&trade.account_id),
                account_id: trade.account_id,
            });
        }
    }
    Ok(result)
}
pub fn month(
    path: &Path,
    scope: JournalScope,
    year: i32,
    month: u32,
) -> Result<JournalMonthSummary, AppError> {
    let trades: Vec<_> = load_trades(path, Some(&scope))?
        .into_iter()
        .filter(|t| {
            ny_date(&t.opened_at)
                .and_then(|d| DateTime::parse_from_rfc3339(&format!("{d}T00:00:00Z")).ok())
                .is_some_and(|d| d.year() == year && d.month() == month)
        })
        .collect();
    let mut groups: HashMap<String, Vec<JournalTrade>> = HashMap::new();
    for trade in &trades {
        if let Some(date) = ny_date(&trade.opened_at) {
            groups.entry(date).or_default().push(trade.clone());
        }
    }
    let mut days: Vec<_> = groups
        .into_iter()
        .map(|(date, items)| {
            let m = metrics(&items);
            JournalCalendarDay {
                date,
                trades: m.trades,
                closed_trades: m.closed_trades,
                net_pnl: m.net_pnl,
                total_r: m.total_r,
            }
        })
        .collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(JournalMonthSummary {
        scope,
        year,
        month,
        metrics: metrics(&trades),
        days,
    })
}
pub fn day(path: &Path, scope: JournalScope, date: &str) -> Result<JournalDaySummary, AppError> {
    let trades: Vec<_> = load_trades(path, Some(&scope))?
        .into_iter()
        .filter(|t| ny_date(&t.opened_at).as_deref() == Some(date))
        .collect();
    Ok(JournalDaySummary {
        scope,
        date: date.into(),
        metrics: metrics(&trades),
        trades,
    })
}
pub fn stats_range(
    path: &Path,
    scope: JournalScope,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<JournalStatsRange, AppError> {
    if start_date
        .as_deref()
        .is_some_and(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err())
        || end_date
            .as_deref()
            .is_some_and(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err())
    {
        return Err(AppError::Validation(
            "Journal stats dates must use YYYY-MM-DD".into(),
        ));
    }
    if start_date
        .as_ref()
        .zip(end_date.as_ref())
        .is_some_and(|(start, end)| start > end)
    {
        return Err(AppError::Validation(
            "Journal stats start date must not be after the end date".into(),
        ));
    }
    let trades = load_trades(path, Some(&scope))?
        .into_iter()
        .filter(|trade| {
            ny_date(&trade.opened_at).is_some_and(|date| {
                start_date.as_ref().is_none_or(|start| date >= *start)
                    && end_date.as_ref().is_none_or(|end| date <= *end)
            })
        })
        .map(|trade| JournalStatsTrade {
            id: trade.id,
            provider: trade.provider,
            symbol: trade.symbol,
            direction: trade.direction,
            asset_class: trade.asset_class,
            strategy: trade.strategy,
            underlying: trade.underlying,
            status: trade.status,
            opened_at: trade.opened_at,
            closed_at: trade.closed_at,
            gross_pnl: trade.gross_pnl,
            fees: trade.fees,
            net_pnl: trade.net_pnl,
            r_multiple: trade.r_multiple,
            tags: trade.tags,
        })
        .collect();
    Ok(JournalStatsRange {
        scope,
        start_date,
        end_date,
        trades,
    })
}
pub fn trade(path: &Path, id: &str) -> Result<JournalTrade, AppError> {
    let mut trade = load_trades(path, None)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| AppError::Validation("Journal trade not found".into()))?;
    let db = Connection::open(path)?;
    let mut stmt=db.prepare("SELECT id,trade_id,broker_order_id,event_type,occurred_at,source,status,old_price,new_price,quantity,price,note,provider,option_symbol,broker_leg_id FROM journal_events WHERE trade_id=?1 ORDER BY occurred_at")?;
    trade.events = Some(
        stmt.query_map(params![id], |row| {
            Ok(JournalEvent {
                id: row.get(0)?,
                trade_id: row.get(1)?,
                broker_order_id: row.get(2)?,
                provider: Some(match row.get::<_, String>(12)?.as_str() {
                    "schwab" => MarketDataProvider::Schwab,
                    _ => MarketDataProvider::Tradestation,
                }),
                option_symbol: row.get(13)?,
                broker_leg_id: row.get(14)?,
                event_type: row.get(3)?,
                occurred_at: row.get(4)?,
                source: row.get(5)?,
                status: row.get(6)?,
                old_price: row.get(7)?,
                new_price: row.get(8)?,
                quantity: row.get(9)?,
                price: row.get(10)?,
                note: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?,
    );
    Ok(trade)
}
pub fn update_annotation(
    path: &Path,
    trade_id: &str,
    notes: &str,
    tags: &[String],
) -> Result<(), AppError> {
    init(path)?;
    let db = Connection::open(path)?;
    db.execute("INSERT INTO journal_annotations(trade_id,notes,tags,updated_at,synced) VALUES(?1,?2,?3,?4,0) ON CONFLICT(trade_id) DO UPDATE SET notes=excluded.notes,tags=excluded.tags,updated_at=excluded.updated_at,synced=0",params![trade_id,notes,serde_json::to_string(tags)?,now()])?;
    Ok(())
}

const SCREENSHOT_BUCKET: &str = "trade-screenshots";
const MAX_SCREENSHOT_BYTES: usize = 5 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION: u32 = 8192;

fn screenshot_object_path(user_id: &str, trade_id: &str) -> String {
    format!("{user_id}/{trade_id}/entry.png")
}

fn screenshot_metadata_from_row(
    db: &Connection,
    trade_id: &str,
) -> Result<Option<(JournalScreenshotMetadata, String)>, AppError> {
    db.query_row(
        "SELECT captured_at,width,height,content_type,object_path FROM journal_screenshots WHERE trade_id=?1",
        params![trade_id],
        |row| Ok((JournalScreenshotMetadata {
            trade_id: trade_id.into(),
            captured_at: row.get(0)?,
            width: row.get(1)?,
            height: row.get(2)?,
            content_type: row.get(3)?,
        }, row.get(4)?)),
    )
    .optional()
    .map_err(Into::into)
}

fn cache_screenshot_metadata(
    path: &Path,
    row: &RemoteScreenshotRow,
) -> Result<JournalScreenshotMetadata, AppError> {
    Connection::open(path)?.execute(
        "INSERT INTO journal_screenshots(trade_id,object_path,captured_at,width,height,content_type) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(trade_id) DO UPDATE SET object_path=excluded.object_path,captured_at=excluded.captured_at,width=excluded.width,height=excluded.height,content_type=excluded.content_type",
        params![row.trade_id,row.object_path,row.captured_at,row.width,row.height,row.content_type],
    )?;
    Ok(JournalScreenshotMetadata {
        trade_id: row.trade_id.clone(),
        captured_at: row.captured_at.clone(),
        width: row.width,
        height: row.height,
        content_type: row.content_type.clone(),
    })
}

fn storage_headers(
    cfg: &CloudConfig,
    token: &str,
    content_type: &str,
) -> Result<HeaderMap, AppError> {
    let mut value = HeaderMap::new();
    value.insert(
        "apikey",
        HeaderValue::from_str(&cfg.publishable_key)
            .map_err(|error| AppError::Validation(error.to_string()))?,
    );
    value.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|error| AppError::Validation(error.to_string()))?,
    );
    value.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .map_err(|error| AppError::Validation(error.to_string()))?,
    );
    Ok(value)
}

async fn remote_screenshot(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
    trade_id: &str,
) -> Result<Option<RemoteScreenshotRow>, AppError> {
    let response = client
        .get(format!("{}/rest/v1/journal_screenshots", cfg.project_url))
        .headers(headers(cfg, token, false)?)
        .query(&[
            (
                "select",
                "trade_id,object_path,captured_at,width,height,content_type".into(),
            ),
            ("trade_id", format!("eq.{trade_id}")),
            ("limit", "1".into()),
        ])
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(AppError::Api(format!(
            "Supabase screenshot lookup failed ({status}): {}. Apply the latest journal migration and retry",
            response.text().await?
        )));
    }
    Ok(response
        .json::<Vec<RemoteScreenshotRow>>()
        .await?
        .into_iter()
        .next())
}

fn validate_screenshot(input: &JournalScreenshotInput) -> Result<Vec<u8>, AppError> {
    if DateTime::parse_from_rfc3339(&input.captured_at).is_err() {
        return Err(AppError::Validation(
            "Invalid screenshot capture time".into(),
        ));
    }
    if input.width == 0
        || input.height == 0
        || input.width > MAX_SCREENSHOT_DIMENSION
        || input.height > MAX_SCREENSHOT_DIMENSION
    {
        return Err(AppError::Validation("Invalid screenshot dimensions".into()));
    }
    let encoded = input
        .data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| AppError::Validation("The entry chart must be a PNG image".into()))?;
    if encoded.len() > (MAX_SCREENSHOT_BYTES * 4 / 3) + 8 {
        return Err(AppError::Validation(
            "The entry chart exceeds the 5 MB limit".into(),
        ));
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| AppError::Validation("The entry chart PNG is invalid".into()))?;
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err(AppError::Validation(
            "The entry chart exceeds the 5 MB limit".into(),
        ));
    }
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err(AppError::Validation(
            "The entry chart PNG is invalid".into(),
        ));
    }
    let png_width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let png_height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if png_width != input.width || png_height != input.height {
        return Err(AppError::Validation(
            "The entry chart dimensions do not match the PNG".into(),
        ));
    }
    Ok(bytes)
}

fn resolve_screenshot_trade(
    path: &Path,
    input: &JournalScreenshotInput,
) -> Result<String, AppError> {
    init(path)?;
    let db = Connection::open(path)?;
    let trade_id = db
        .query_row(
            "SELECT t.id FROM journal_events e JOIN journal_trades t ON t.id=e.trade_id WHERE e.broker_order_id=?1 AND e.trade_id IS NOT NULL AND t.environment=?2 AND t.account_id=?3 AND t.symbol=?4 ORDER BY e.occurred_at LIMIT 1",
            params![input.broker_order_id,environment_key(&input.environment),input.account_id,input.symbol],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    trade_id.ok_or_else(|| {
        AppError::Api("Entry chart trade is not ready; waiting for the opening fill".into())
    })
}

pub async fn save_entry_screenshot(
    path: &Path,
    input: JournalScreenshotInput,
) -> Result<JournalScreenshotMetadata, AppError> {
    let bytes = validate_screenshot(&input)?;
    let trade_id = resolve_screenshot_trade(path, &input)?;
    if let Some((metadata, _)) = screenshot_metadata_from_row(&Connection::open(path)?, &trade_id)?
    {
        return Ok(metadata);
    }
    let cfg = config(path)?.ok_or_else(|| {
        AppError::Api("Connect Trade Journal Cloud to save the entry chart".into())
    })?;
    let token = access_token(&cfg).await?;
    let client = reqwest::Client::new();
    if let Some(remote) = remote_screenshot(&client, &cfg, &token, &trade_id).await? {
        if remote.object_path != screenshot_object_path(&cfg.user_id, &trade_id) {
            return Err(AppError::Api(
                "The entry chart object path is invalid".into(),
            ));
        }
        return cache_screenshot_metadata(path, &remote);
    }
    let object_path = screenshot_object_path(&cfg.user_id, &trade_id);
    let response = client
        .post(format!(
            "{}/storage/v1/object/{SCREENSHOT_BUCKET}/{object_path}",
            cfg.project_url
        ))
        .headers(storage_headers(&cfg, &token, "image/png")?)
        .header("x-upsert", "false")
        .body(bytes)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(AppError::Api(format!(
            "Entry chart upload failed ({status}): {}",
            response.text().await?
        )));
    }
    let row = json!({
        "user_id": cfg.user_id.clone(),
        "trade_id": trade_id.clone(),
        "object_path": object_path.clone(),
        "captured_at": input.captured_at.clone(),
        "width": input.width,
        "height": input.height,
        "content_type": "image/png"
    });
    if let Err(error) = upload(
        &client,
        &cfg,
        &token,
        "journal_screenshots",
        "user_id,trade_id",
        vec![row],
        true,
    )
    .await
    {
        let _ = client
            .delete(format!(
                "{}/storage/v1/object/{SCREENSHOT_BUCKET}",
                cfg.project_url
            ))
            .headers(storage_headers(&cfg, &token, "application/json")?)
            .json(&json!({"prefixes":[object_path]}))
            .send()
            .await;
        return Err(error);
    }
    let remote = RemoteScreenshotRow {
        trade_id,
        object_path,
        captured_at: input.captured_at,
        width: input.width,
        height: input.height,
        content_type: "image/png".into(),
    };
    cache_screenshot_metadata(path, &remote)
}

pub async fn entry_screenshot(
    path: &Path,
    trade_id: &str,
) -> Result<JournalScreenshotImage, AppError> {
    init(path)?;
    let cfg = config(path)?.ok_or_else(|| {
        AppError::Api("Connect Trade Journal Cloud to load the entry chart".into())
    })?;
    let token = access_token(&cfg).await?;
    let client = reqwest::Client::new();
    let (metadata, object_path) =
        match screenshot_metadata_from_row(&Connection::open(path)?, trade_id)? {
            Some(value) => value,
            None => {
                let remote = remote_screenshot(&client, &cfg, &token, trade_id)
                    .await?
                    .ok_or_else(|| AppError::Validation("This trade has no entry chart".into()))?;
                let object_path = remote.object_path.clone();
                (cache_screenshot_metadata(path, &remote)?, object_path)
            }
        };
    if object_path != screenshot_object_path(&cfg.user_id, trade_id) {
        return Err(AppError::Api(
            "The entry chart object path is invalid".into(),
        ));
    }
    let response = client
        .get(format!(
            "{}/storage/v1/object/authenticated/{SCREENSHOT_BUCKET}/{object_path}",
            cfg.project_url
        ))
        .headers(storage_headers(&cfg, &token, "application/octet-stream")?)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(AppError::Api(format!(
            "Entry chart download failed ({status})"
        )));
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_SCREENSHOT_BYTES
        || bytes.len() < 24
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[12..16] != b"IHDR"
    {
        return Err(AppError::Api("The stored entry chart is invalid".into()));
    }
    let png_width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let png_height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if metadata.content_type != "image/png"
        || png_width != metadata.width
        || png_height != metadata.height
    {
        return Err(AppError::Api(
            "The stored entry chart metadata is invalid".into(),
        ));
    }
    Ok(JournalScreenshotImage {
        trade_id: metadata.trade_id,
        captured_at: metadata.captured_at,
        width: metadata.width,
        height: metadata.height,
        content_type: metadata.content_type,
        data_url: format!("data:image/png;base64,{}", BASE64.encode(bytes)),
    })
}

fn config(path: &Path) -> Result<Option<CloudConfig>, AppError> {
    init(path)?;
    let db = Connection::open(path)?;
    db.query_row("SELECT project_url,publishable_key,email,user_id,backfill_start,record_from,updated_at FROM journal_config WHERE id=1",[],|row|Ok(CloudConfig{project_url:row.get(0)?,publishable_key:row.get(1)?,email:row.get(2)?,user_id:row.get(3)?,backfill_start:row.get(4)?,record_from:row.get(5)?,updated_at:row.get(6)?})).optional().map_err(Into::into)
}
pub fn auth_status(path: &Path) -> Result<JournalAuthStatus, AppError> {
    let cfg = config(path)?;
    let authenticated = storage::get_secret("journal_refresh_token")?.is_some();
    Ok(JournalAuthStatus {
        configured: cfg.is_some(),
        authenticated,
        email: cfg.as_ref().map(|v| v.email.clone()),
        project_url: cfg.as_ref().map(|v| v.project_url.clone()),
        backfill_start: cfg.as_ref().map(|v| v.backfill_start.clone()),
        record_from: cfg.and_then(|v| v.record_from),
        error: None,
    })
}

pub async fn configure(
    path: &Path,
    input: JournalConnectionInput,
) -> Result<JournalAuthStatus, AppError> {
    if input.project_url.trim().is_empty()
        || input.publishable_key.trim().is_empty()
        || input.email.trim().is_empty()
        || input.password.is_empty()
    {
        return Err(AppError::Validation(
            "All Supabase journal fields are required".into(),
        ));
    }
    let url = format!(
        "{}/auth/v1/token?grant_type=password",
        input.project_url.trim_end_matches('/')
    );
    let response = reqwest::Client::new()
        .post(url)
        .header("apikey", input.publishable_key.trim())
        .json(&json!({"email":input.email.trim(),"password":input.password}))
        .send()
        .await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(AppError::Api(format!("Supabase sign-in failed: {body}")));
    }
    let auth: AuthResponse = serde_json::from_str(&body)?;
    let AuthResponse {
        access_token,
        refresh_token,
        expires_in,
        user,
    } = auth;
    let user_id = user
        .ok_or_else(|| AppError::Api("Supabase did not return a user".into()))?
        .id;
    storage::set_secret("journal_refresh_token", &refresh_token)?;
    init(path)?;
    Connection::open(path)?.execute("INSERT INTO journal_config(id,project_url,publishable_key,email,user_id,backfill_start,record_from,updated_at) VALUES(1,?1,?2,?3,?4,?5,NULL,?6) ON CONFLICT(id) DO UPDATE SET project_url=excluded.project_url,publishable_key=excluded.publishable_key,email=excluded.email,user_id=excluded.user_id,backfill_start=excluded.backfill_start,updated_at=excluded.updated_at",params![input.project_url.trim_end_matches('/'),input.publishable_key.trim(),input.email.trim(),user_id,input.backfill_start,now()])?;
    if let Some(cfg) = config(path)? {
        cache_access_token(&cfg, access_token, expires_in);
    }
    auth_status(path)
}
pub fn disconnect(path: &Path) -> Result<(), AppError> {
    invalidate_access_token();
    storage::delete_secret("journal_refresh_token")?;
    if path.exists() {
        Connection::open(path)?.execute("DELETE FROM journal_config WHERE id=1", [])?;
    }
    Ok(())
}
pub fn set_backfill(path: &Path, value: &str) -> Result<(), AppError> {
    init(path)?;
    Connection::open(path)?.execute(
        "UPDATE journal_config SET backfill_start=?1,updated_at=?2 WHERE id=1",
        params![value, now()],
    )?;
    Ok(())
}

fn purge_before_record_from(path: &Path, cutoff: &str) -> Result<(), AppError> {
    init(path)?;
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM journal_screenshots WHERE trade_id IN (SELECT id FROM journal_trades WHERE julianday(opened_at)<julianday(?1))",
        params![cutoff],
    )?;
    tx.execute(
        "DELETE FROM journal_annotations WHERE trade_id IN (SELECT id FROM journal_trades WHERE julianday(opened_at)<julianday(?1))",
        params![cutoff],
    )?;
    tx.execute(
        "DELETE FROM journal_events WHERE julianday(occurred_at)<julianday(?1)",
        params![cutoff],
    )?;
    tx.execute(
        "DELETE FROM journal_trades WHERE julianday(opened_at)<julianday(?1)",
        params![cutoff],
    )?;
    tx.execute(
        "DELETE FROM journal_option_legs WHERE trade_id NOT IN (SELECT id FROM journal_trades)",
        [],
    )?;
    tx.execute(
        "DELETE FROM journal_annotations WHERE trade_id NOT IN (SELECT id FROM journal_trades)",
        [],
    )?;
    tx.execute(
        "DELETE FROM journal_screenshots WHERE trade_id NOT IN (SELECT id FROM journal_trades)",
        [],
    )?;
    tx.execute(
        "DELETE FROM journal_events WHERE trade_id IS NOT NULL AND trade_id NOT IN (SELECT id FROM journal_trades)",
        [],
    )?;
    tx.execute(
        "DELETE FROM journal_intents WHERE julianday(created_at)<julianday(?1)",
        params![cutoff],
    )?;
    tx.execute("DELETE FROM journal_order_state", [])?;
    tx.execute(
        "DELETE FROM journal_sync_state WHERE key LIKE 'broker-checkpoint:%'",
        [],
    )?;
    hydrate_order_state_from_events(&tx)?;
    tx.commit()?;
    Ok(())
}

fn reset_local_journal(path: &Path, cutoff: &str) -> Result<(), AppError> {
    init(path)?;
    let backfill_start = cutoff
        .get(..10)
        .ok_or_else(|| AppError::Validation("Invalid journal recording cutoff".into()))?;
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    tx.execute("DELETE FROM journal_screenshots", [])?;
    tx.execute("DELETE FROM journal_annotations", [])?;
    tx.execute("DELETE FROM journal_events", [])?;
    tx.execute("DELETE FROM journal_option_legs", [])?;
    tx.execute("DELETE FROM journal_trades", [])?;
    tx.execute("DELETE FROM journal_intents", [])?;
    tx.execute("DELETE FROM journal_order_state", [])?;
    tx.execute("DELETE FROM journal_option_order_state", [])?;
    tx.execute("DELETE FROM journal_protective_state", [])?;
    tx.execute("DELETE FROM journal_trade_tombstones", [])?;
    tx.execute("DELETE FROM journal_sync_state", [])?;
    tx.execute(
        "UPDATE journal_config SET backfill_start=?1,record_from=?2,updated_at=?3 WHERE id=1",
        params![backfill_start, cutoff, cutoff],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn reconciliation_since(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
    backfill_start: &str,
) -> Result<String, AppError> {
    init(path)?;
    let db = Connection::open(path)?;
    let key = format!(
        "broker-checkpoint:{}:{account_id}",
        environment_key(environment)
    );
    let checkpoint: Option<String> = db
        .query_row(
            "SELECT value FROM journal_sync_state WHERE key=?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    let backfill = NaiveDate::parse_from_str(backfill_start, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("Backfill start must be YYYY-MM-DD".into()))?;
    let since = checkpoint
        .and_then(|value| NaiveDate::parse_from_str(&value, "%Y-%m-%d").ok())
        .map(|date| date - Duration::days(2))
        .map(|date| date.max(backfill))
        .unwrap_or(backfill);
    Ok(since.format("%Y-%m-%d").to_string())
}

pub fn set_reconciliation_checkpoint(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
) -> Result<(), AppError> {
    init(path)?;
    let key = format!(
        "broker-checkpoint:{}:{account_id}",
        environment_key(environment)
    );
    Connection::open(path)?.execute(
        "INSERT INTO journal_sync_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, Utc::now().format("%Y-%m-%d").to_string()],
    )?;
    Ok(())
}

async fn access_token(cfg: &CloudConfig) -> Result<String, AppError> {
    if let Ok(cache) = access_token_cache().lock() {
        if let Some(cached) = cache.as_ref().filter(|cached| {
            cached.project_url == cfg.project_url
                && cached.user_id == cfg.user_id
                && Instant::now() < cached.refresh_after
        }) {
            return Ok(cached.value.clone());
        }
    }
    let refresh =
        storage::get_secret("journal_refresh_token")?.ok_or(AppError::AuthenticationRequired)?;
    let url = format!("{}/auth/v1/token?grant_type=refresh_token", cfg.project_url);
    let response = reqwest::Client::new()
        .post(url)
        .header("apikey", &cfg.publishable_key)
        .json(&json!({"refresh_token":refresh}))
        .send()
        .await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(AppError::Api(format!(
            "Supabase session refresh failed: {body}"
        )));
    }
    let auth: AuthResponse = serde_json::from_str(&body)?;
    storage::set_secret("journal_refresh_token", &auth.refresh_token)?;
    let token = auth.access_token;
    cache_access_token(cfg, token.clone(), auth.expires_in);
    Ok(token)
}

pub async fn preference_realtime_credentials(
    path: &Path,
) -> Result<PreferenceRealtimeCredentials, AppError> {
    let cfg =
        config(path)?.ok_or_else(|| AppError::Validation("Configure Supabase first".into()))?;
    let token = access_token(&cfg).await?;
    let refresh_after = access_token_cache()
        .lock()
        .ok()
        .and_then(|cache| {
            cache.as_ref().and_then(|cached| {
                (cached.project_url == cfg.project_url && cached.user_id == cfg.user_id).then(
                    || {
                        cached
                            .refresh_after
                            .saturating_duration_since(Instant::now())
                    },
                )
            })
        })
        .unwrap_or_else(|| StdDuration::from_secs(15 * 60));
    Ok(PreferenceRealtimeCredentials {
        project_url: cfg.project_url,
        publishable_key: cfg.publishable_key,
        user_id: cfg.user_id,
        access_token: token,
        device_id: storage::local_preference_device_id(path)?,
        refresh_after: refresh_after.max(StdDuration::from_secs(1)),
    })
}
fn headers(cfg: &CloudConfig, token: &str, ignore_duplicates: bool) -> Result<HeaderMap, AppError> {
    let mut h = HeaderMap::new();
    h.insert(
        "apikey",
        HeaderValue::from_str(&cfg.publishable_key)
            .map_err(|e| AppError::Validation(e.to_string()))?,
    );
    h.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|e| AppError::Validation(e.to_string()))?,
    );
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    h.insert(
        "Prefer",
        HeaderValue::from_static(if ignore_duplicates {
            "resolution=ignore-duplicates,return=minimal"
        } else {
            "resolution=merge-duplicates,return=minimal"
        }),
    );
    Ok(h)
}
async fn upload(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
    table: &str,
    on_conflict: &str,
    rows: Vec<Value>,
    ignore_duplicates: bool,
) -> Result<(), AppError> {
    if rows.is_empty() {
        return Ok(());
    }
    let response = client
        .post(format!(
            "{}/rest/v1/{table}?on_conflict={on_conflict}",
            cfg.project_url
        ))
        .headers(headers(cfg, token, ignore_duplicates)?)
        .json(&rows)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await?;
        return Err(AppError::Api(format!(
            "Supabase {table} sync failed ({status}): {body}"
        )));
    }
    Ok(())
}

async fn pull_app_preferences(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
) -> Result<Vec<RemotePreferenceRow>, AppError> {
    let response = client
        .get(format!("{}/rest/v1/app_preferences", cfg.project_url))
        .headers(headers(cfg, token, false)?)
        .query(&[(
            "select",
            "category,schema_version,payload,revision,mutation_id,device_id,server_updated_at",
        )])
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await?;
        return Err(AppError::Api(format!(
            "Supabase preference download failed ({status}): {body}. Apply the latest Supabase migration and retry"
        )));
    }
    Ok(response.json().await?)
}

fn valid_remote_preference(row: &RemotePreferenceRow) -> bool {
    storage::PREFERENCE_CATEGORIES.contains(&row.category.as_str())
        && row.schema_version == 1
        && row.payload.is_object()
        && row.revision > 0
        && uuid::Uuid::parse_str(&row.mutation_id).is_ok()
        && uuid::Uuid::parse_str(&row.device_id).is_ok()
        && DateTime::parse_from_rfc3339(&row.server_updated_at).is_ok()
}

fn remote_preference_record(remote: RemotePreferenceRow) -> storage::PreferenceRecord {
    storage::PreferenceRecord {
        category: remote.category,
        schema_version: remote.schema_version,
        payload: remote.payload,
        revision: remote.revision,
        mutation_id: remote.mutation_id,
        device_id: remote.device_id,
        server_updated_at: remote.server_updated_at,
        dirty: false,
    }
}

fn remote_conflicts_with_dirty_local(
    local: &storage::PreferenceRecord,
    remote: Option<&RemotePreferenceRow>,
) -> bool {
    match remote {
        Some(remote) => {
            remote.mutation_id != local.mutation_id && remote.revision != local.revision
        }
        None => local.revision != 0,
    }
}

async fn commit_app_preference(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
    local: &storage::PreferenceRecord,
) -> Result<PreferenceCommitRow, AppError> {
    let mut commit_headers = headers(cfg, token, false)?;
    commit_headers.insert("Prefer", HeaderValue::from_static("return=representation"));
    let response = client
        .post(format!(
            "{}/rest/v1/rpc/commit_app_preference",
            cfg.project_url
        ))
        .headers(commit_headers)
        .json(&json!({
            "p_category": local.category,
            "p_schema_version": local.schema_version,
            "p_payload": local.payload,
            "p_device_id": local.device_id,
            "p_mutation_id": local.mutation_id,
            "p_expected_revision": local.revision,
        }))
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await?;
        return Err(AppError::Api(format!(
            "Supabase preference commit failed ({status}): {body}. Apply the latest Supabase migration and update Northstar on every computer"
        )));
    }
    response
        .json::<Vec<PreferenceCommitRow>>()
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Api("Supabase preference commit returned no record".into()))
}

fn adopt_remote_preference(
    path: &Path,
    local: &storage::PreferenceRecord,
    remote: RemotePreferenceRow,
    replaced_categories: &mut Vec<String>,
) -> Result<storage::PreferenceRecord, AppError> {
    if remote.payload != local.payload && !replaced_categories.contains(&remote.category) {
        replaced_categories.push(remote.category.clone());
    }
    let record = remote_preference_record(remote);
    storage::replace_local_preference(path, &record)?;
    Ok(record)
}

pub async fn sync_app_preferences(
    path: &Path,
    profile: &Value,
) -> Result<PreferenceSyncResult, AppError> {
    if PREFERENCES_SYNCING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(AppError::Api(
            "Another preference sync is already running".into(),
        ));
    }
    let _guard = PreferenceSyncGuard;
    storage::record_preference_profile(path, profile)?;
    let cfg =
        config(path)?.ok_or_else(|| AppError::Validation("Configure Supabase first".into()))?;
    let token = access_token(&cfg).await?;
    let client = reqwest::Client::new();
    let initial_remote = pull_app_preferences(&client, &cfg, &token).await?;
    let mut remote_by_category: HashMap<_, _> = initial_remote
        .into_iter()
        .filter(|record| valid_remote_preference(record))
        .map(|record| (record.category.clone(), record))
        .collect();
    let mut local_by_category: HashMap<_, _> = storage::local_preferences(path)?
        .into_iter()
        .map(|record| (record.category.clone(), record))
        .collect();
    let mut replaced_categories = Vec::new();
    let mut conflicted_categories = Vec::new();
    let mut upload_count = 0usize;

    for category in storage::PREFERENCE_CATEGORIES {
        let Some(local) = local_by_category.get(category).cloned() else {
            continue;
        };
        let remote = remote_by_category.remove(category);

        if local.dirty && remote_conflicts_with_dirty_local(&local, remote.as_ref()) {
            if let Some(remote) = remote {
                if !conflicted_categories.contains(&local.category) {
                    conflicted_categories.push(local.category.clone());
                }
                let record =
                    adopt_remote_preference(path, &local, remote, &mut replaced_categories)?;
                local_by_category.insert(record.category.clone(), record);
            }
            continue;
        }

        let should_commit = local.dirty || remote.is_none();
        if should_commit {
            let committed = commit_app_preference(&client, &cfg, &token, &local).await?;
            let applied = committed.applied;
            let record = committed.into_record();
            if !applied {
                if !conflicted_categories.contains(&local.category) {
                    conflicted_categories.push(local.category.clone());
                }
                if record.payload != local.payload && !replaced_categories.contains(&local.category)
                {
                    replaced_categories.push(local.category.clone());
                }
            } else {
                upload_count += 1;
            }
            storage::replace_local_preference(path, &record)?;
            local_by_category.insert(record.category.clone(), record);
        } else if let Some(remote) = remote {
            if remote.revision != local.revision
                || remote.mutation_id != local.mutation_id
                || remote.payload != local.payload
            {
                let record =
                    adopt_remote_preference(path, &local, remote, &mut replaced_categories)?;
                local_by_category.insert(record.category.clone(), record);
            }
        }
    }
    let mut records = storage::local_preferences(path)?;
    records.sort_by_key(|record| {
        storage::PREFERENCE_CATEGORIES
            .iter()
            .position(|category| *category == record.category)
            .unwrap_or(usize::MAX)
    });
    let synced_at = now();
    Ok(PreferenceSyncResult {
        state: "synced".into(),
        records,
        replaced_categories,
        conflicted_categories,
        last_synced_at: Some(synced_at),
        message: Some(if upload_count == 0 {
            "Preferences are up to date".into()
        } else {
            format!("Synced {upload_count} changed preference categories")
        }),
    })
}

async fn delete_tombstoned_trades(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
    path: &Path,
) -> Result<(), AppError> {
    let db = Connection::open(path)?;
    let tombstones = {
        let mut stmt = db.prepare("SELECT trade_id FROM journal_trade_tombstones")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    drop(db);
    for trade_id in tombstones {
        delete_storage_paths(
            client,
            cfg,
            token,
            vec![format!("{}/{trade_id}/entry.png", cfg.user_id)],
        )
        .await?;
        let response = client
            .delete(format!("{}/rest/v1/journal_trades", cfg.project_url))
            .headers(headers(cfg, token, false)?)
            .query(&[
                ("user_id", format!("eq.{}", cfg.user_id)),
                ("id", format!("eq.{trade_id}")),
            ])
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await?;
            return Err(AppError::Api(format!(
                "Supabase journal repair failed ({status}): {body}. Apply the latest journal migration and retry sync"
            )));
        }
        Connection::open(path)?.execute(
            "DELETE FROM journal_trade_tombstones WHERE trade_id=?1",
            params![trade_id],
        )?;
    }
    Ok(())
}

async fn delete_storage_paths(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
    paths: Vec<String>,
) -> Result<(), AppError> {
    if paths.is_empty() {
        return Ok(());
    }
    let response = client
        .delete(format!(
            "{}/storage/v1/object/{SCREENSHOT_BUCKET}",
            cfg.project_url
        ))
        .headers(storage_headers(cfg, token, "application/json")?)
        .json(&json!({"prefixes": paths}))
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(AppError::Api(format!(
            "Supabase entry-chart cleanup failed ({status}): {}",
            response.text().await?
        )));
    }
    Ok(())
}

async fn delete_all_cloud_screenshots(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
) -> Result<(), AppError> {
    let response = client
        .get(format!("{}/rest/v1/journal_screenshots", cfg.project_url))
        .headers(headers(cfg, token, false)?)
        .query(&[("select", "object_path")])
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(AppError::Api(format!(
            "Supabase entry-chart cleanup lookup failed ({status}): {}",
            response.text().await?
        )));
    }
    let paths = response
        .json::<Vec<Value>>()
        .await?
        .into_iter()
        .filter_map(|row| {
            row.get("object_path")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    delete_storage_paths(client, cfg, token, paths).await
}

async fn pull_cloud_settings(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
) -> Result<Option<RemoteSettingsRow>, AppError> {
    let response = client
        .get(format!("{}/rest/v1/journal_settings", cfg.project_url))
        .headers(headers(cfg, token, false)?)
        .query(&[
            ("select", "backfill_start,record_from,updated_at"),
            ("limit", "1"),
        ])
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await?;
        return Err(AppError::Api(format!(
            "Supabase journal settings download failed ({status}): {body}. Apply the latest journal migration and retry sync"
        )));
    }
    Ok(response
        .json::<Vec<RemoteSettingsRow>>()
        .await?
        .into_iter()
        .next())
}

fn merge_cloud_settings(
    path: &Path,
    local: &CloudConfig,
    remote: Option<RemoteSettingsRow>,
) -> Result<(), AppError> {
    let Some(remote) = remote else {
        if let Some(cutoff) = local.record_from.as_deref() {
            purge_before_record_from(path, cutoff)?;
        }
        return Ok(());
    };
    let remote_cutoff = parse_record_from(remote.record_from.as_deref());
    let local_cutoff = parse_record_from(local.record_from.as_deref());
    let remote_cutoff_wins = match (remote_cutoff.as_ref(), local_cutoff.as_ref()) {
        (Some(remote), Some(local)) => remote > local,
        (Some(_), None) => true,
        _ => false,
    };
    let remote_updated_at = parse_record_from(Some(&remote.updated_at));
    let local_updated_at = parse_record_from(Some(&local.updated_at));
    let remote_is_newer = remote_updated_at
        .zip(local_updated_at)
        .map(|(remote, local)| remote > local)
        .unwrap_or_else(|| remote.updated_at > local.updated_at);
    if remote_cutoff_wins || (remote.record_from == local.record_from && remote_is_newer) {
        Connection::open(path)?.execute(
            "UPDATE journal_config SET backfill_start=?1,record_from=?2,updated_at=?3 WHERE id=1",
            params![remote.backfill_start, remote.record_from, remote.updated_at],
        )?;
    }
    if let Some(cutoff) = config(path)?.and_then(|value| value.record_from) {
        purge_before_record_from(path, &cutoff)?;
    }
    Ok(())
}

async fn pull_cloud(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
) -> Result<
    (
        Vec<RemoteTradeRow>,
        Vec<RemoteOptionLegRow>,
        Vec<RemoteAnnotationRow>,
        Vec<RemoteEventRow>,
        Vec<RemoteScreenshotRow>,
    ),
    AppError,
> {
    let mut trades_request = client
        .get(format!("{}/rest/v1/journal_trades", cfg.project_url))
        .headers(headers(cfg, token, false)?)
        .query(&[("select", "*"), ("order", "opened_at.asc")]);
    if let Some(cutoff) = cfg.record_from.as_deref() {
        trades_request = trades_request.query(&[("opened_at", format!("gte.{cutoff}"))]);
    }
    let trades_response = trades_request.send().await?;
    if !trades_response.status().is_success() {
        return Err(AppError::Api(format!(
            "Supabase trade download failed: {}",
            trades_response.text().await?
        )));
    }
    let annotations_response = client
        .get(format!(
            "{}/rest/v1/journal_annotations?select=*",
            cfg.project_url
        ))
        .headers(headers(cfg, token, false)?)
        .send()
        .await?;
    if !annotations_response.status().is_success() {
        return Err(AppError::Api(format!(
            "Supabase annotation download failed: {}",
            annotations_response.text().await?
        )));
    }
    let option_legs_response = client
        .get(format!(
            "{}/rest/v1/journal_option_legs?select=*",
            cfg.project_url
        ))
        .headers(headers(cfg, token, false)?)
        .send()
        .await?;
    if !option_legs_response.status().is_success() {
        return Err(AppError::Api(format!("Supabase option-leg download failed: {}. Apply the latest journal migration and retry sync", option_legs_response.text().await?)));
    }
    let mut events_request = client
        .get(format!("{}/rest/v1/journal_events", cfg.project_url))
        .headers(headers(cfg, token, false)?)
        .query(&[("select", "*"), ("order", "occurred_at.asc")]);
    if let Some(cutoff) = cfg.record_from.as_deref() {
        events_request = events_request.query(&[("occurred_at", format!("gte.{cutoff}"))]);
    }
    let events_response = events_request.send().await?;
    if !events_response.status().is_success() {
        return Err(AppError::Api(format!(
            "Supabase event download failed: {}",
            events_response.text().await?
        )));
    }
    let screenshots_response = client
        .get(format!("{}/rest/v1/journal_screenshots", cfg.project_url))
        .headers(headers(cfg, token, false)?)
        .query(&[(
            "select",
            "trade_id,object_path,captured_at,width,height,content_type",
        )])
        .send()
        .await?;
    if !screenshots_response.status().is_success() {
        return Err(AppError::Api(format!(
            "Supabase screenshot metadata download failed: {}. Apply the latest journal migration and retry sync",
            screenshots_response.text().await?
        )));
    }
    Ok((
        trades_response.json().await?,
        option_legs_response.json().await?,
        annotations_response.json().await?,
        events_response.json().await?,
        screenshots_response.json().await?,
    ))
}

fn merge_cloud(
    path: &Path,
    trades: Vec<RemoteTradeRow>,
    option_legs: Vec<RemoteOptionLegRow>,
    annotations: Vec<RemoteAnnotationRow>,
    events: Vec<RemoteEventRow>,
    screenshots: Vec<RemoteScreenshotRow>,
) -> Result<(), AppError> {
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    for t in trades {
        tx.execute("INSERT INTO journal_trades(id,provider,environment,account_id,symbol,direction,asset_class,strategy,underlying,status,opened_at,closed_at,entry_quantity,exit_quantity,average_entry,average_exit,original_stop,original_target,planned_risk,deployed_risk,point_value,gross_pnl,fees,net_pnl,r_multiple,risk_provenance,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,asset_class=excluded.asset_class,strategy=excluded.strategy,underlying=excluded.underlying,status=excluded.status,closed_at=excluded.closed_at,entry_quantity=excluded.entry_quantity,exit_quantity=excluded.exit_quantity,average_entry=excluded.average_entry,average_exit=excluded.average_exit,original_stop=excluded.original_stop,original_target=excluded.original_target,planned_risk=excluded.planned_risk,deployed_risk=excluded.deployed_risk,point_value=excluded.point_value,gross_pnl=excluded.gross_pnl,fees=excluded.fees,net_pnl=excluded.net_pnl,r_multiple=excluded.r_multiple,risk_provenance=excluded.risk_provenance,updated_at=excluded.updated_at WHERE excluded.updated_at>journal_trades.updated_at OR (journal_trades.status='open' AND excluded.status='closed') OR (journal_trades.status=excluded.status AND excluded.exit_quantity>journal_trades.exit_quantity) OR (journal_trades.risk_provenance!='exact' AND excluded.risk_provenance='exact' AND NOT (journal_trades.status='closed' AND excluded.status='open'))",params![t.id,t.provider,t.environment,t.account_id,t.symbol,t.direction,t.asset_class,t.strategy,t.underlying,t.status,t.opened_at,t.closed_at,t.entry_quantity,t.exit_quantity,t.average_entry,t.average_exit,t.original_stop,t.original_target,t.planned_risk,t.deployed_risk,t.point_value,t.gross_pnl,t.fees,t.net_pnl,t.r_multiple,t.risk_provenance,t.updated_at])?;
    }
    for leg in option_legs {
        tx.execute("INSERT INTO journal_option_legs(id,trade_id,option_symbol,underlying,expiration_date,strike_price,put_call,opening_side,opened_quantity,closed_quantity,average_entry,average_exit,multiplier,gross_pnl,fees,status,replaces_leg_id,updated_at,synced) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,1) ON CONFLICT(id) DO UPDATE SET opened_quantity=excluded.opened_quantity,closed_quantity=excluded.closed_quantity,average_entry=excluded.average_entry,average_exit=excluded.average_exit,gross_pnl=excluded.gross_pnl,fees=excluded.fees,status=excluded.status,replaces_leg_id=excluded.replaces_leg_id,updated_at=excluded.updated_at,synced=1 WHERE excluded.updated_at>journal_option_legs.updated_at",params![leg.id,leg.trade_id,leg.option_symbol,leg.underlying,leg.expiration_date,leg.strike_price,leg.put_call,leg.opening_side,leg.opened_quantity,leg.closed_quantity,leg.average_entry,leg.average_exit,leg.multiplier,leg.gross_pnl,leg.fees,leg.status,leg.replaces_leg_id,leg.updated_at])?;
    }
    for a in annotations {
        tx.execute("INSERT INTO journal_annotations(trade_id,notes,tags,updated_at,synced) SELECT ?1,?2,?3,?4,1 WHERE EXISTS(SELECT 1 FROM journal_trades WHERE id=?1) ON CONFLICT(trade_id) DO UPDATE SET notes=excluded.notes,tags=excluded.tags,updated_at=excluded.updated_at,synced=1 WHERE excluded.updated_at>journal_annotations.updated_at",params![a.trade_id,a.notes,serde_json::to_string(&a.tags)?,a.updated_at])?;
    }
    for e in events {
        tx.execute("INSERT OR IGNORE INTO journal_events(id,event_key,trade_id,provider,environment,account_id,broker_order_id,broker_leg_id,option_symbol,event_type,occurred_at,source,status,old_price,new_price,quantity,price,note,synced) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,1)",params![e.id,e.event_key,e.trade_id,e.provider,e.environment,e.account_id,e.broker_order_id,e.broker_leg_id,e.option_symbol,e.event_type,e.occurred_at,e.source,e.status,e.old_price,e.new_price,e.quantity,e.price,e.note])?;
    }
    for screenshot in screenshots {
        tx.execute(
            "INSERT INTO journal_screenshots(trade_id,object_path,captured_at,width,height,content_type) SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM journal_trades WHERE id=?1) ON CONFLICT(trade_id) DO UPDATE SET object_path=excluded.object_path,captured_at=excluded.captured_at,width=excluded.width,height=excluded.height,content_type=excluded.content_type",
            params![screenshot.trade_id,screenshot.object_path,screenshot.captured_at,screenshot.width,screenshot.height,screenshot.content_type],
        )?;
    }
    hydrate_order_state_from_events(&tx)?;
    tx.commit()?;
    Ok(())
}

fn hydrate_order_state_from_events(db: &Connection) -> Result<(), AppError> {
    let commission_rate = commission_per_contract_side(db)?;
    let states = {
        let mut stmt = db.prepare(
            "SELECT environment,account_id,broker_order_id,MAX(ABS(quantity)) FROM journal_events WHERE provider='tradestation' AND event_type='order-observed' AND broker_order_id IS NOT NULL AND quantity IS NOT NULL GROUP BY environment,account_id,broker_order_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (environment, account_id, order_id, filled_quantity) in states {
        db.execute(
            "INSERT INTO journal_order_state(environment,account_id,order_id,filled_quantity,commission) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(environment,account_id,order_id) DO UPDATE SET filled_quantity=MAX(journal_order_state.filled_quantity,excluded.filled_quantity),commission=MAX(journal_order_state.commission,excluded.commission)",
            params![environment, account_id, order_id, filled_quantity, filled_quantity * commission_rate],
        )?;
    }
    let option_fee = schwab_option_fee_per_contract_side(db)?;
    let option_states = {
        let mut stmt = db.prepare("SELECT account_id,broker_order_id,broker_leg_id,MAX(ABS(quantity)),MAX(COALESCE(price,0)) FROM journal_events WHERE provider='schwab' AND event_type='order-observed' AND broker_order_id IS NOT NULL AND broker_leg_id IS NOT NULL AND quantity IS NOT NULL GROUP BY account_id,broker_order_id,broker_leg_id")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, f64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (account, broker, leg, filled, average) in option_states {
        let order_id = format!("schwab:{account}:{broker}:{leg}");
        db.execute("INSERT INTO journal_option_order_state(provider,account_id,order_id,filled_quantity,average_fill_price,commission) VALUES('schwab',?1,?2,?3,?4,?5) ON CONFLICT(provider,account_id,order_id) DO UPDATE SET filled_quantity=MAX(journal_option_order_state.filled_quantity,excluded.filled_quantity),average_fill_price=CASE WHEN excluded.filled_quantity>=journal_option_order_state.filled_quantity THEN excluded.average_fill_price ELSE journal_option_order_state.average_fill_price END,commission=MAX(journal_option_order_state.commission,excluded.commission)",params![account,order_id,filled,average,filled*option_fee])?;
    }
    Ok(())
}

pub async fn sync_cloud(path: &Path) -> Result<JournalSyncStatus, AppError> {
    if CLOUD_SYNCING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(JournalSyncStatus {
            state: "syncing".into(),
            pending_events: 0,
            last_synced_at: None,
            message: Some("A journal sync is already running".into()),
        });
    }
    let _guard = SyncGuard;
    let mut cfg = config(path)?
        .ok_or_else(|| AppError::Validation("Configure Trade Journal Cloud first".into()))?;
    let token = access_token(&cfg).await?;
    let client = reqwest::Client::new();
    let remote_settings = pull_cloud_settings(&client, &cfg, &token).await?;
    merge_cloud_settings(path, &cfg, remote_settings)?;
    cfg = config(path)?
        .ok_or_else(|| AppError::Validation("Configure Trade Journal Cloud first".into()))?;
    let user_id = cfg.user_id.clone();
    repair_mirrored_duplicate_trades(path)?;
    delete_tombstoned_trades(&client, &cfg, &token, path).await?;
    let (remote_trades, remote_option_legs, remote_annotations, remote_events, remote_screenshots) =
        pull_cloud(&client, &cfg, &token).await?;
    merge_cloud(
        path,
        remote_trades,
        remote_option_legs,
        remote_annotations,
        remote_events,
        remote_screenshots,
    )?;
    repair_mirrored_duplicate_trades(path)?;
    delete_tombstoned_trades(&client, &cfg, &token, path).await?;
    let (events, option_legs, annotations, trades) = {
        let db = Connection::open(path)?;
        let events = {
            let mut stmt = db.prepare("SELECT id,event_key,trade_id,environment,account_id,broker_order_id,event_type,occurred_at,source,status,old_price,new_price,quantity,price,note,provider,broker_leg_id,option_symbol FROM journal_events WHERE synced=0")?;
            let rows = stmt.query_map([], |row| Ok(json!({
                "id": row.get::<_,String>(0)?, "event_key": row.get::<_,String>(1)?, "trade_id": row.get::<_,Option<String>>(2)?, "user_id": user_id,
                "environment": row.get::<_,String>(3)?, "account_id": row.get::<_,String>(4)?, "broker_order_id": row.get::<_,Option<String>>(5)?,
                "event_type": row.get::<_,String>(6)?, "occurred_at": row.get::<_,String>(7)?, "source": row.get::<_,String>(8)?, "status": row.get::<_,Option<String>>(9)?,
                "old_price": row.get::<_,Option<f64>>(10)?, "new_price": row.get::<_,Option<f64>>(11)?, "quantity": row.get::<_,Option<f64>>(12)?, "price": row.get::<_,Option<f64>>(13)?, "note": row.get::<_,Option<String>>(14)?,
                "provider":row.get::<_,String>(15)?,"broker_leg_id":row.get::<_,Option<String>>(16)?,"option_symbol":row.get::<_,Option<String>>(17)?
            })))?.collect::<Result<Vec<_>,_>>()?;
            rows
        };
        let option_legs = {
            let mut stmt = db.prepare("SELECT id,trade_id,option_symbol,underlying,expiration_date,strike_price,put_call,opening_side,opened_quantity,closed_quantity,average_entry,average_exit,multiplier,gross_pnl,fees,status,replaces_leg_id,updated_at FROM journal_option_legs WHERE synced=0")?;
            let rows = stmt.query_map([], |row| Ok(json!({
                "id":row.get::<_,String>(0)?,"user_id":user_id,"trade_id":row.get::<_,String>(1)?,"option_symbol":row.get::<_,String>(2)?,"underlying":row.get::<_,String>(3)?,
                "expiration_date":row.get::<_,String>(4)?,"strike_price":row.get::<_,f64>(5)?,"put_call":row.get::<_,String>(6)?,"opening_side":row.get::<_,String>(7)?,
                "opened_quantity":row.get::<_,f64>(8)?,"closed_quantity":row.get::<_,f64>(9)?,"average_entry":row.get::<_,f64>(10)?,"average_exit":row.get::<_,Option<f64>>(11)?,
                "multiplier":row.get::<_,f64>(12)?,"gross_pnl":row.get::<_,f64>(13)?,"fees":row.get::<_,f64>(14)?,"status":row.get::<_,String>(15)?,"replaces_leg_id":row.get::<_,Option<String>>(16)?,"updated_at":row.get::<_,String>(17)?
            })))?.collect::<Result<Vec<_>,_>>()?;
            rows
        };
        let annotations = {
            let mut stmt = db.prepare(
                "SELECT trade_id,notes,tags,updated_at FROM journal_annotations WHERE synced=0",
            )?;
            let rows = stmt.query_map([], |row| Ok(json!({
                "trade_id": row.get::<_,String>(0)?, "user_id": user_id, "notes": row.get::<_,String>(1)?,
                "tags": serde_json::from_str::<Vec<String>>(&row.get::<_,String>(2)?).unwrap_or_default(), "updated_at": row.get::<_,String>(3)?
            })))?.collect::<Result<Vec<_>,_>>()?;
            rows
        };
        let trades = {
            let mut stmt = db.prepare("SELECT id,environment,account_id,symbol,direction,status,opened_at,closed_at,entry_quantity,exit_quantity,average_entry,average_exit,original_stop,original_target,planned_risk,deployed_risk,point_value,gross_pnl,fees,net_pnl,r_multiple,risk_provenance,updated_at,provider,asset_class,strategy,underlying FROM journal_trades")?;
            let rows = stmt.query_map([], |row| Ok(json!({
                "id":row.get::<_,String>(0)?,"user_id":user_id,"environment":row.get::<_,String>(1)?,"account_id":row.get::<_,String>(2)?,
                "symbol":row.get::<_,String>(3)?,"direction":row.get::<_,String>(4)?,"status":row.get::<_,String>(5)?,"opened_at":row.get::<_,String>(6)?,
                "closed_at":row.get::<_,Option<String>>(7)?,"entry_quantity":row.get::<_,f64>(8)?,"exit_quantity":row.get::<_,f64>(9)?,
                "average_entry":row.get::<_,f64>(10)?,"average_exit":row.get::<_,Option<f64>>(11)?,"original_stop":row.get::<_,Option<f64>>(12)?,
                "original_target":row.get::<_,Option<f64>>(13)?,"planned_risk":row.get::<_,Option<f64>>(14)?,"deployed_risk":row.get::<_,Option<f64>>(15)?,
                "point_value":row.get::<_,Option<f64>>(16)?,"gross_pnl":row.get::<_,f64>(17)?,"fees":row.get::<_,f64>(18)?,"net_pnl":row.get::<_,f64>(19)?,
                "r_multiple":row.get::<_,Option<f64>>(20)?,"risk_provenance":row.get::<_,String>(21)?,"updated_at":row.get::<_,String>(22)?,
                "provider":row.get::<_,String>(23)?,"asset_class":row.get::<_,String>(24)?,"strategy":row.get::<_,String>(25)?,"underlying":row.get::<_,Option<String>>(26)?
            })))?.collect::<Result<Vec<_>,_>>()?;
            rows
        };
        (events, option_legs, annotations, trades)
    };
    let pending = events.len();
    let uploaded_event_ids: Vec<String> = events
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let uploaded_option_leg_ids: Vec<String> = option_legs
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let uploaded_annotation_ids: Vec<String> = annotations
        .iter()
        .filter_map(|row| {
            row.get("trade_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    upload(&client,&cfg,&token,"journal_settings","user_id",vec![json!({"user_id":user_id,"timezone":"America/New_York","backfill_start":cfg.backfill_start,"record_from":cfg.record_from,"updated_at":cfg.updated_at})],false).await?;
    upload(
        &client,
        &cfg,
        &token,
        "journal_events",
        "user_id,event_key",
        events,
        true,
    )
    .await?;
    upload(
        &client,
        &cfg,
        &token,
        "journal_option_legs",
        "user_id,id",
        option_legs,
        false,
    )
    .await?;
    upload(
        &client,
        &cfg,
        &token,
        "journal_trades",
        "user_id,id",
        trades,
        false,
    )
    .await?;
    upload(
        &client,
        &cfg,
        &token,
        "journal_annotations",
        "user_id,trade_id",
        annotations,
        false,
    )
    .await?;
    let synced = now();
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    for id in uploaded_event_ids {
        tx.execute(
            "UPDATE journal_events SET synced=1 WHERE id=?1",
            params![id],
        )?;
    }
    for id in uploaded_option_leg_ids {
        tx.execute(
            "UPDATE journal_option_legs SET synced=1 WHERE id=?1",
            params![id],
        )?;
    }
    for trade_id in uploaded_annotation_ids {
        tx.execute(
            "UPDATE journal_annotations SET synced=1 WHERE trade_id=?1",
            params![trade_id],
        )?;
    }
    tx.execute("INSERT INTO journal_sync_state(key,value) VALUES('last_synced_at',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![synced])?;
    tx.commit()?;
    Ok(JournalSyncStatus {
        state: "synced".into(),
        pending_events: 0,
        last_synced_at: Some(synced),
        message: Some(format!("Uploaded {pending} new journal events")),
    })
}

async fn delete_cloud_journal_table(
    client: &reqwest::Client,
    cfg: &CloudConfig,
    token: &str,
    table: &str,
) -> Result<(), AppError> {
    let response = client
        .delete(format!("{}/rest/v1/{table}", cfg.project_url))
        .headers(headers(cfg, token, false)?)
        .query(&[("user_id", format!("eq.{}", cfg.user_id))])
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await?;
        return Err(AppError::Api(format!(
            "Supabase journal reset failed for {table} ({status}): {body}. Apply the latest journal migration and retry"
        )));
    }
    Ok(())
}

pub async fn reset_now(path: &Path) -> Result<JournalAuthStatus, AppError> {
    if CLOUD_SYNCING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(AppError::Api(
            "A journal sync is running. Wait for it to finish, then start fresh again".into(),
        ));
    }
    let _guard = SyncGuard;
    let cfg = config(path)?
        .ok_or_else(|| AppError::Validation("Configure Trade Journal Cloud first".into()))?;
    let token = access_token(&cfg).await?;
    let cutoff = now();
    reset_local_journal(path, &cutoff)?;
    let cfg = config(path)?
        .ok_or_else(|| AppError::Validation("Configure Trade Journal Cloud first".into()))?;
    let client = reqwest::Client::new();
    upload(
        &client,
        &cfg,
        &token,
        "journal_settings",
        "user_id",
        vec![json!({
            "user_id": cfg.user_id.clone(),
            "timezone": "America/New_York",
            "backfill_start": cfg.backfill_start.clone(),
            "record_from": cfg.record_from.clone(),
            "updated_at": cfg.updated_at.clone()
        })],
        false,
    )
    .await?;
    delete_all_cloud_screenshots(&client, &cfg, &token).await?;
    delete_cloud_journal_table(&client, &cfg, &token, "journal_screenshots").await?;
    delete_cloud_journal_table(&client, &cfg, &token, "journal_events").await?;
    delete_cloud_journal_table(&client, &cfg, &token, "journal_annotations").await?;
    delete_cloud_journal_table(&client, &cfg, &token, "journal_option_legs").await?;
    delete_cloud_journal_table(&client, &cfg, &token, "journal_trades").await?;
    auth_status(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MarketDataProvider;
    fn temp() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("northstar-journal-{}.sqlite", uuid::Uuid::new_v4()))
    }
    fn order(id: &str, side: &str, open_close: &str, qty: f64, price: f64) -> OrderUpdate {
        OrderUpdate {
            provider: MarketDataProvider::Tradestation,
            id: id.into(),
            symbol: "MESU26".into(),
            side: side.into(),
            order_type: "Market".into(),
            quantity: qty as u32,
            price: None,
            stop_price: None,
            status: "Filled".into(),
            timestamp: "2026-03-08T04:30:00Z".into(),
            account_id: Some("A1".into()),
            filled_quantity: Some(qty),
            remaining_quantity: Some(0.0),
            average_fill_price: Some(price),
            duration: Some("DAY".into()),
            closed_at: Some("2026-03-08T04:31:00Z".into()),
            commission: Some(1.0),
            stop_loss: None,
            take_profit: None,
            raw_status: None,
            status_description: None,
            open_or_close: Some(open_close.into()),
            group_name: None,
            related_orders: vec![],
            broker_order_id: None,
            leg_id: None,
            asset_type: Some("FUTURE".into()),
            underlying: None,
            expiration_date: None,
            strike_price: None,
            put_call: None,
            multiplier: None,
        }
    }
    fn option_order(
        parent: &str,
        leg: &str,
        symbol: &str,
        side: &str,
        open_close: &str,
        qty: f64,
        filled: f64,
        price: f64,
        time: &str,
    ) -> OrderUpdate {
        let suffix = &symbol[symbol.len() - 15..];
        let put_call = if &suffix[6..7] == "C" { "CALL" } else { "PUT" };
        let strike = suffix[7..].parse::<u64>().unwrap() as f64 / 1000.0;
        OrderUpdate {
            provider: MarketDataProvider::Schwab,
            id: format!("schwab:S1:{parent}:{leg}"),
            symbol: symbol.into(),
            side: side.into(),
            order_type: "Limit".into(),
            quantity: qty as u32,
            price: None,
            stop_price: None,
            status: if filled >= qty {
                "Filled".into()
            } else {
                "Working".into()
            },
            timestamp: time.into(),
            account_id: Some("S1".into()),
            filled_quantity: Some(filled),
            remaining_quantity: Some((qty - filled).max(0.0)),
            average_fill_price: (filled > 0.0).then_some(price),
            duration: Some("DAY".into()),
            closed_at: (filled > 0.0).then_some(time.into()),
            commission: None,
            stop_loss: None,
            take_profit: None,
            raw_status: None,
            status_description: None,
            open_or_close: Some(open_close.into()),
            group_name: Some("SINGLE".into()),
            related_orders: vec![],
            broker_order_id: Some(parent.into()),
            leg_id: Some(leg.into()),
            asset_type: Some("OPTION".into()),
            underlying: Some("SPY".into()),
            expiration_date: Some(format!(
                "20{}-{}-{}",
                &suffix[0..2],
                &suffix[2..4],
                &suffix[4..6]
            )),
            strike_price: Some(strike),
            put_call: Some(put_call.into()),
            multiplier: Some(100.0),
        }
    }

    #[test]
    fn schwab_short_strangle_is_one_deduplicated_campaign_with_leg_pnl() {
        let path = temp();
        configure_local(&path, None);
        let call = "SPY   260807C00632000";
        let put = "SPY   260807P00620000";
        let opens = vec![
            option_order(
                "100",
                "1",
                call,
                "Sell",
                "Open",
                1.0,
                1.0,
                2.0,
                "2026-08-04T15:00:00Z",
            ),
            option_order(
                "100",
                "2",
                put,
                "Sell",
                "Open",
                1.0,
                0.0,
                3.0,
                "2026-08-04T15:00:01Z",
            ),
        ];
        ingest_schwab_strangles(&path, &opens, "broker-stream").unwrap();
        let forming = load_trades(&path, None).unwrap();
        assert_eq!(forming.len(), 1);
        assert_eq!(
            forming[0]
                .legs
                .as_ref()
                .unwrap()
                .iter()
                .filter(|leg| leg.opened_quantity == 0.0)
                .count(),
            1
        );
        let completed = vec![
            opens[0].clone(),
            option_order(
                "100",
                "2",
                put,
                "Sell",
                "Open",
                1.0,
                1.0,
                3.0,
                "2026-08-04T15:00:02Z",
            ),
        ];
        ingest_schwab_strangles(&path, &completed, "broker-stream").unwrap();
        ingest_schwab_strangles(&path, &completed, "broker-stream").unwrap();
        let scopes = scopes(&path).unwrap();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].provider, MarketDataProvider::Schwab);
        let open = load_trades(&path, None).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].strategy, "short-strangle");
        assert_eq!(open[0].legs.as_ref().unwrap().len(), 2);
        let closes = vec![
            option_order(
                "101",
                "1",
                call,
                "Buy",
                "Close",
                1.0,
                1.0,
                1.0,
                "2026-08-04T17:00:00Z",
            ),
            option_order(
                "101",
                "2",
                put,
                "Buy",
                "Close",
                1.0,
                1.0,
                1.0,
                "2026-08-04T17:00:01Z",
            ),
        ];
        ingest_schwab_strangles(&path, &closes, "broker-stream").unwrap();
        let trade = &load_trades(&path, None).unwrap()[0];
        assert_eq!(trade.status, "closed");
        assert!((trade.gross_pnl - 300.0).abs() < 1e-9);
        assert!((trade.fees - 2.6).abs() < 1e-9);
        assert!((trade.net_pnl - 297.4).abs() < 1e-9);
        set_commission_per_contract_side(&path, 2.0).unwrap();
        assert!(
            (load_trades(&path, None).unwrap()[0].fees - 2.6).abs() < 1e-9,
            "futures fee changes must not alter option campaigns"
        );
        set_schwab_option_fee_per_contract_side(&path, 0.5).unwrap();
        let repriced = &load_trades(&path, None).unwrap()[0];
        assert!((repriced.fees - 2.0).abs() < 1e-9);
        assert!((repriced.net_pnl - 298.0).abs() < 1e-9);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn schwab_one_leg_roll_stays_in_campaign_and_other_strategies_are_ignored() {
        let path = temp();
        configure_local(&path, None);
        let call = "SPY   260807C00632000";
        let old_put = "SPY   260807P00620000";
        let new_put = "SPY   260807P00618000";
        ingest_schwab_strangles(
            &path,
            &[
                option_order(
                    "200",
                    "1",
                    call,
                    "Sell",
                    "Open",
                    1.0,
                    1.0,
                    2.0,
                    "2026-08-04T15:00:00Z",
                ),
                option_order(
                    "200",
                    "2",
                    old_put,
                    "Sell",
                    "Open",
                    1.0,
                    1.0,
                    3.0,
                    "2026-08-04T15:00:01Z",
                ),
            ],
            "broker-history",
        )
        .unwrap();
        ingest_schwab_strangles(
            &path,
            &[
                option_order(
                    "201",
                    "1",
                    old_put,
                    "Buy",
                    "Close",
                    1.0,
                    1.0,
                    1.0,
                    "2026-08-04T16:00:00Z",
                ),
                option_order(
                    "201",
                    "2",
                    new_put,
                    "Sell",
                    "Open",
                    1.0,
                    1.0,
                    2.5,
                    "2026-08-04T16:00:01Z",
                ),
            ],
            "broker-stream",
        )
        .unwrap();
        let trades = load_trades(&path, None).unwrap();
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].status, "open");
        let legs = trades[0].legs.as_ref().unwrap();
        assert_eq!(legs.len(), 3);
        assert!(legs
            .iter()
            .any(|leg| leg.option_symbol == new_put && leg.replaces_leg_id.is_some()));
        let single = option_order(
            "202",
            "1",
            "SPY   260807C00640000",
            "Buy",
            "Open",
            1.0,
            1.0,
            1.0,
            "2026-08-04T17:00:00Z",
        );
        ingest_schwab_strangles(&path, &[single], "broker-stream").unwrap();
        assert_eq!(load_trades(&path, None).unwrap().len(), 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn schwab_full_close_and_reopen_creates_a_new_campaign() {
        let path = temp();
        configure_local(&path, None);
        let old_call = "SPY   260807C00632000";
        let old_put = "SPY   260807P00620000";
        ingest_schwab_strangles(
            &path,
            &[
                option_order(
                    "300",
                    "1",
                    old_call,
                    "Sell",
                    "Open",
                    1.0,
                    1.0,
                    2.0,
                    "2026-08-04T15:00:00Z",
                ),
                option_order(
                    "300",
                    "2",
                    old_put,
                    "Sell",
                    "Open",
                    1.0,
                    1.0,
                    3.0,
                    "2026-08-04T15:00:01Z",
                ),
            ],
            "broker-stream",
        )
        .unwrap();
        ingest_schwab_strangles(
            &path,
            &[
                option_order(
                    "301",
                    "1",
                    old_call,
                    "Buy",
                    "Close",
                    1.0,
                    1.0,
                    1.0,
                    "2026-08-04T16:00:00Z",
                ),
                option_order(
                    "301",
                    "2",
                    old_put,
                    "Buy",
                    "Close",
                    1.0,
                    1.0,
                    1.0,
                    "2026-08-04T16:00:01Z",
                ),
                option_order(
                    "301",
                    "3",
                    "SPY   260807C00635000",
                    "Sell",
                    "Open",
                    1.0,
                    1.0,
                    1.5,
                    "2026-08-04T16:00:02Z",
                ),
                option_order(
                    "301",
                    "4",
                    "SPY   260807P00617000",
                    "Sell",
                    "Open",
                    1.0,
                    1.0,
                    2.2,
                    "2026-08-04T16:00:03Z",
                ),
            ],
            "broker-stream",
        )
        .unwrap();
        let trades = load_trades(&path, None).unwrap();
        assert_eq!(trades.len(), 2);
        assert_eq!(
            trades
                .iter()
                .filter(|trade| trade.status == "closed")
                .count(),
            1
        );
        assert_eq!(
            trades.iter().filter(|trade| trade.status == "open").count(),
            1
        );
        std::fs::remove_file(path).unwrap();
    }
    fn configure_local(path: &Path, record_from: Option<&str>) {
        init(path).unwrap();
        Connection::open(path)
            .unwrap()
            .execute(
                "INSERT INTO journal_config(id,project_url,publishable_key,email,user_id,backfill_start,record_from,updated_at) VALUES(1,'https://example.supabase.co','key','owner@example.com','user-1','2026-01-01',?1,'2026-01-01T00:00:00Z')",
                params![record_from],
            )
            .unwrap();
    }
    #[test]
    fn legacy_journal_schema_adds_provider_strategy_and_option_fee_columns() {
        let path = temp();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE journal_trades(id TEXT PRIMARY KEY,environment TEXT NOT NULL,account_id TEXT NOT NULL,opened_at TEXT NOT NULL); CREATE TABLE journal_preferences(id INTEGER PRIMARY KEY,commission_per_contract_side REAL NOT NULL,updated_at TEXT NOT NULL); INSERT INTO journal_preferences VALUES(1,0.4,'2026-01-01T00:00:00Z');").unwrap();
        drop(db);
        init(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        for (table, column) in [
            ("journal_trades", "provider"),
            ("journal_trades", "asset_class"),
            ("journal_trades", "strategy"),
            ("journal_preferences", "schwab_option_fee_per_contract_side"),
        ] {
            let mut stmt = db.prepare(&format!("PRAGMA table_info({table})")).unwrap();
            let columns = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(
                columns.iter().any(|item| item == column),
                "missing {table}.{column}"
            );
        }
        assert_eq!(schwab_option_fee_per_contract_side(&db).unwrap(), 0.65);
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn reduces_flat_to_flat_and_deduplicates() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[
                order("1", "Buy", "Open", 2.0, 6250.0),
                order("2", "Sell", "Close", 2.0, 6252.0),
            ],
            "broker-history",
            &points,
        )
        .unwrap();
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[order("2", "Sell", "Close", 2.0, 6252.0)],
            "broker-history",
            &points,
        )
        .unwrap();
        let trades = load_trades(&path, None).unwrap();
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].status, "closed");
        assert_eq!(trades[0].gross_pnl, 20.0);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn converted_protective_close_waits_for_and_then_closes_its_opening_campaign() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        let close = order("protective-1", "Sell", "Close", 3.0, 7616.0);

        let first = ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            std::slice::from_ref(&close),
            "broker-stream",
            &points,
        )
        .unwrap();
        assert_eq!(first.unmatched_closes.len(), 1);
        assert!(load_trades(&path, None).unwrap().is_empty());

        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[order("entry-1", "Buy", "Open", 3.0, 7610.0)],
            "broker-history",
            &points,
        )
        .unwrap();
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[close],
            "broker-stream",
            &points,
        )
        .unwrap();

        let trades = load_trades(&path, None).unwrap();
        assert_eq!(
            trades.len(),
            1,
            "the closing sell must not become a short campaign"
        );
        assert_eq!(trades[0].direction, "Long");
        assert_eq!(trades[0].status, "closed");
        assert_eq!(trades[0].exit_quantity, 3.0);
        assert_eq!(trades[0].average_exit, Some(7616.0));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn historical_replay_orders_bracket_fills_by_execution_time() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        let mut entry = order("entry-history", "Buy", "Open", 1.0, 7617.75);
        entry.timestamp = "2026-07-15T19:07:05Z".into();
        entry.closed_at = Some("2026-07-15T19:07:06Z".into());
        let mut protective_close = order("close-history", "Sell", "Close", 1.0, 7617.75);
        protective_close.timestamp = "2026-07-15T19:07:04Z".into();
        protective_close.closed_at = Some("2026-07-15T19:09:00Z".into());

        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[protective_close, entry],
            "broker-history",
            &points,
        )
        .unwrap();

        let trades = load_trades(&path, None).unwrap();
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].direction, "Long");
        assert_eq!(trades[0].status, "closed");
        assert_eq!(trades[0].opened_at, "2026-07-15T19:07:06Z");
        assert_eq!(trades[0].closed_at.as_deref(), Some("2026-07-15T19:09:00Z"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn repairs_legacy_close_fill_that_was_saved_as_an_open_campaign() {
        let path = temp();
        init(&path).unwrap();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        let mut close = order("protective-legacy", "Sell", "Close", 3.0, 7616.0);
        close.timestamp = "2026-03-08T04:35:00Z".into();
        close.closed_at = Some("2026-03-08T04:36:00Z".into());
        create_trade_from_fill(
            &Connection::open(&path).unwrap(),
            "sim",
            "A1",
            &close,
            3.0,
            7616.0,
            1.0,
            Some(5.0),
            "broker-stream",
            "2026-03-08T04:36:00Z",
        )
        .unwrap();
        assert_eq!(load_trades(&path, None).unwrap()[0].direction, "Short");

        assert_eq!(
            repair_misclassified_close_campaigns(
                &path,
                &TradingEnvironment::Sim,
                std::slice::from_ref(&close),
            )
            .unwrap(),
            1
        );
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[order("entry-legacy", "Buy", "Open", 3.0, 7610.0), close],
            "broker-history",
            &points,
        )
        .unwrap();

        let trades = load_trades(&path, None).unwrap();
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].direction, "Long");
        assert_eq!(trades[0].status, "closed");
        let tombstones: i64 = Connection::open(&path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM journal_trade_tombstones", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(tombstones, 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn repairs_a_misclassified_close_campaign_after_it_was_closed() {
        let path = temp();
        init(&path).unwrap();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        let mut close = order("closed-duplicate", "Sell", "Close", 1.0, 7618.0);
        close.closed_at = Some("2026-07-15T19:17:00Z".into());
        create_trade_from_fill(
            &Connection::open(&path).unwrap(),
            "sim",
            "A1",
            &close,
            1.0,
            7618.0,
            0.4,
            Some(5.0),
            "broker-history",
            "2026-07-15T19:17:00Z",
        )
        .unwrap();
        let mut later_buy = order("later-buy", "Buy", "Open", 1.0, 7618.5);
        later_buy.closed_at = Some("2026-07-15T19:18:00Z".into());
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[later_buy],
            "broker-history",
            &points,
        )
        .unwrap();
        assert_eq!(load_trades(&path, None).unwrap()[0].status, "closed");
        insert_event(
            &Connection::open(&path).unwrap(),
            "correct-close-event",
            Some("correct-trade"),
            "sim",
            "A1",
            Some(&close.id),
            "fill",
            "2026-07-15T19:17:00Z",
            "broker-stream",
            Some("confirmed"),
            None,
            None,
            Some(1.0),
            Some(7618.0),
            Some("Correct cloud closing fill"),
        )
        .unwrap();

        assert_eq!(
            repair_misclassified_close_campaigns(
                &path,
                &TradingEnvironment::Sim,
                std::slice::from_ref(&close),
            )
            .unwrap(),
            1
        );
        assert!(load_trades(&path, None).unwrap().is_empty());
        let tombstones: i64 = Connection::open(&path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM journal_trade_tombstones", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(tombstones, 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn repairs_the_mirrored_cross_device_trade_from_its_reversed_timestamps() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        let mut entry = order("mirrored-entry", "Buy", "Open", 1.0, 7617.75);
        entry.closed_at = Some("2026-07-15T23:07:38Z".into());
        let mut close = order("mirrored-close", "Sell", "Close", 1.0, 7617.75);
        close.closed_at = Some("2026-07-15T23:09:08Z".into());
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[entry.clone(), close.clone()],
            "broker-stream",
            &points,
        )
        .unwrap();
        let correct_trade_id = load_trades(&path, None).unwrap()[0].id.clone();

        create_trade_from_fill(
            &Connection::open(&path).unwrap(),
            "sim",
            "A1",
            &close,
            1.0,
            7617.75,
            0.4,
            Some(5.0),
            "broker-history",
            "2026-07-15T23:09:08Z",
        )
        .unwrap();
        Connection::open(&path)
            .unwrap()
            .execute(
                "DELETE FROM journal_order_state WHERE environment='sim' AND account_id='A1' AND order_id=?1",
                params![entry.id],
            )
            .unwrap();
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[entry],
            "broker-history",
            &points,
        )
        .unwrap();
        let mut standalone_entry = order("standalone-entry", "Sell", "Open", 1.0, 7618.0);
        standalone_entry.closed_at = Some("2026-07-15T23:20:00Z".into());
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[standalone_entry],
            "broker-history",
            &points,
        )
        .unwrap();
        let standalone_trade_id =
            query_active_trade(&Connection::open(&path).unwrap(), "sim", "A1", "MESU26")
                .unwrap()
                .unwrap()
                .id;
        let mut standalone_close = order("standalone-close", "Buy", "Close", 1.0, 7618.25);
        standalone_close.closed_at = Some("2026-07-15T23:19:00Z".into());
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[standalone_close],
            "broker-history",
            &points,
        )
        .unwrap();
        let before = load_trades(&path, None).unwrap();
        assert_eq!(before.len(), 3);
        assert_eq!(
            before
                .iter()
                .filter(|trade| {
                    trade.closed_at.as_deref().is_some_and(|closed| {
                        DateTime::parse_from_rfc3339(closed).unwrap()
                            < DateTime::parse_from_rfc3339(&trade.opened_at).unwrap()
                    })
                })
                .count(),
            2
        );

        assert_eq!(repair_mirrored_duplicate_trades(&path).unwrap(), 1);
        let after = load_trades(&path, None).unwrap();
        assert_eq!(after.len(), 2);
        assert!(after.iter().any(|trade| trade.id == correct_trade_id));
        assert!(after.iter().any(|trade| trade.id == standalone_trade_id));
        let tombstones: i64 = Connection::open(&path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM journal_trade_tombstones", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(tombstones, 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn synced_order_events_restore_replay_deduplication_state() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        let mut entry = order("synced-entry", "Buy", "Open", 1.0, 7619.5);
        entry.closed_at = Some("2026-07-15T19:44:00Z".into());
        let mut close = order("synced-close", "Sell", "Close", 1.0, 7618.0);
        close.timestamp = "2026-07-15T19:43:59Z".into();
        close.closed_at = Some("2026-07-15T19:47:00Z".into());
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            std::slice::from_ref(&entry),
            "broker-stream",
            &points,
        )
        .unwrap();
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            std::slice::from_ref(&close),
            "broker-stream",
            &points,
        )
        .unwrap();
        let before = load_trades(&path, None).unwrap();

        let db = Connection::open(&path).unwrap();
        db.execute("DELETE FROM journal_order_state", []).unwrap();
        hydrate_order_state_from_events(&db).unwrap();
        drop(db);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[close, entry],
            "broker-history",
            &points,
        )
        .unwrap();

        let after = load_trades(&path, None).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, before[0].id);
        assert_eq!(after[0].status, "closed");
        assert_eq!(after[0].entry_quantity, before[0].entry_quantity);
        assert_eq!(after[0].exit_quantity, before[0].exit_quantity);
        assert_eq!(after[0].net_pnl, before[0].net_pnl);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cloud_merge_prefers_a_completed_exact_trade_over_a_newer_partial_replay() {
        let path = temp();
        init(&path).unwrap();
        let local_replay = JournalTrade {
            id: "shared-trade".into(),
            provider: MarketDataProvider::Tradestation,
            environment: TradingEnvironment::Sim,
            account_id: "A1".into(),
            symbol: "MESU26".into(),
            direction: "Long".into(),
            asset_class: "futures".into(),
            strategy: "futures-directional".into(),
            underlying: None,
            status: "open".into(),
            opened_at: "2026-07-15T19:44:00Z".into(),
            closed_at: None,
            entry_quantity: 1.0,
            exit_quantity: 0.0,
            average_entry: 7619.5,
            average_exit: None,
            original_stop: None,
            original_target: None,
            planned_risk: None,
            deployed_risk: None,
            point_value: Some(5.0),
            gross_pnl: 0.0,
            fees: 0.4,
            net_pnl: -0.4,
            r_multiple: None,
            risk_provenance: "unknown".into(),
            notes: String::new(),
            tags: vec![],
            events: None,
            entry_screenshot: None,
            legs: None,
        };
        save_trade(&Connection::open(&path).unwrap(), &local_replay).unwrap();

        merge_cloud(
            &path,
            vec![RemoteTradeRow {
                id: "shared-trade".into(),
                provider: "tradestation".into(),
                environment: "sim".into(),
                account_id: "A1".into(),
                symbol: "MESU26".into(),
                direction: "Long".into(),
                asset_class: "futures".into(),
                strategy: "futures-directional".into(),
                underlying: None,
                status: "closed".into(),
                opened_at: "2026-07-15T19:44:00Z".into(),
                closed_at: Some("2026-07-15T19:47:00Z".into()),
                entry_quantity: 1.0,
                exit_quantity: 1.0,
                average_entry: 7619.5,
                average_exit: Some(7618.0),
                original_stop: Some(7616.75),
                original_target: Some(7625.0),
                planned_risk: Some(13.75),
                deployed_risk: Some(13.75),
                point_value: Some(5.0),
                gross_pnl: -7.5,
                fees: 0.8,
                net_pnl: -8.3,
                r_multiple: Some(-0.545454545),
                risk_provenance: "exact".into(),
                updated_at: "2020-01-01T00:00:00Z".into(),
            }],
            vec![],
            vec![],
            vec![],
            vec![],
        )
        .unwrap();

        let merged = &load_trades(&path, None).unwrap()[0];
        assert_eq!(merged.status, "closed");
        assert_eq!(merged.exit_quantity, 1.0);
        assert_eq!(merged.original_stop, Some(7616.75));
        assert_eq!(merged.risk_provenance, "exact");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn northstar_protective_move_suppresses_the_matching_broker_echo() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[order("entry-move", "Buy", "Open", 1.0, 6250.0)],
            "broker-stream",
            &points,
        )
        .unwrap();
        let mut stop = order("stop-move", "Sell", "Close", 1.0, 0.0);
        stop.order_type = "StopMarket".into();
        stop.status = "Working".into();
        stop.filled_quantity = Some(0.0);
        stop.remaining_quantity = Some(1.0);
        stop.average_fill_price = None;
        stop.stop_price = Some(6245.0);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            std::slice::from_ref(&stop),
            "broker-stream",
            &points,
        )
        .unwrap();

        record_order_move(
            &path,
            &TradingEnvironment::Sim,
            "A1",
            &stop,
            Some(6245.0),
            6246.0,
            "requested",
            None,
        )
        .unwrap();
        record_order_move(
            &path,
            &TradingEnvironment::Sim,
            "A1",
            &stop,
            Some(6245.0),
            6246.0,
            "confirmed",
            None,
        )
        .unwrap();
        stop.stop_price = Some(6246.0);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[stop],
            "broker-stream",
            &points,
        )
        .unwrap();

        let trade_id = load_trades(&path, None).unwrap()[0].id.clone();
        let detail = trade(&path, &trade_id).unwrap();
        assert_eq!(
            detail
                .events
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "stop-move")
                .count(),
            2,
            "only the request and confirmation should remain in the raw audit"
        );
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn month_uses_new_york_entry_day() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[order("1", "Buy", "Open", 1.0, 6250.0)],
            "broker-history",
            &points,
        )
        .unwrap();
        let scope = JournalScope {
            provider: MarketDataProvider::Tradestation,
            environment: TradingEnvironment::Sim,
            account_id: "A1".into(),
            account_label: "A1".into(),
        };
        assert_eq!(day(&path, scope, "2026-03-07").unwrap().trades.len(), 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn schwab_compact_utc_offset_is_grouped_into_the_calendar() {
        assert_eq!(
            ny_date("2026-08-04T18:40:10+0000").as_deref(),
            Some("2026-08-04")
        );
        let path = temp();
        configure_local(&path, None);
        let opens = [
            option_order(
                "compact-offset",
                "1",
                "SPY   260804C00774000",
                "Buy",
                "Open",
                1.0,
                1.0,
                0.25,
                "2026-08-04T18:40:10+0000",
            ),
            option_order(
                "compact-offset",
                "2",
                "SPY   260804P00770000",
                "Buy",
                "Open",
                1.0,
                1.0,
                0.41,
                "2026-08-04T18:40:10+0000",
            ),
        ];
        ingest_schwab_strangles(&path, &opens, "broker-stream").unwrap();
        assert_eq!(
            day(
                &path,
                JournalScope {
                    provider: MarketDataProvider::Schwab,
                    environment: TradingEnvironment::Live,
                    account_id: "S1".into(),
                    account_label: "S1".into(),
                },
                "2026-08-04",
            )
            .unwrap()
            .trades
            .len(),
            1
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reversal_splits_fees_between_campaigns() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        let reversal = order("2", "Sell", "Close", 3.0, 6252.0);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[order("1", "Buy", "Open", 2.0, 6250.0), reversal.clone()],
            "broker-history",
            &points,
        )
        .unwrap();
        let trades = load_trades(&path, None).unwrap();
        assert_eq!(trades.len(), 2);
        assert_eq!(
            trades
                .iter()
                .filter(|trade| trade.status == "closed")
                .count(),
            1
        );
        assert_eq!(
            trades
                .iter()
                .filter(|trade| trade.direction == "Short")
                .count(),
            1
        );
        // Two opening contracts plus a three-contract reversal fill are five
        // charged sides at the default $0.40 rate.
        assert!((trades.iter().map(|trade| trade.fees).sum::<f64>() - 2.0).abs() < 1e-9);
        assert_eq!(
            repair_misclassified_close_campaigns(
                &path,
                &TradingEnvironment::Sim,
                std::slice::from_ref(&reversal),
            )
            .unwrap(),
            0,
            "a close fill with excess quantity is a real reversal, not a duplicate"
        );
        assert_eq!(repair_mirrored_duplicate_trades(&path).unwrap(), 0);
        assert_eq!(load_trades(&path, None).unwrap().len(), 2);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn configured_commission_applies_per_contract_per_side_and_recalculates_history() {
        let path = temp();
        set_commission_per_contract_side(&path, 0.75).unwrap();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[
                order("fee-entry", "Buy", "Open", 2.0, 6250.0),
                order("fee-exit", "Sell", "Close", 2.0, 6252.0),
            ],
            "broker-history",
            &points,
        )
        .unwrap();
        let trade = &load_trades(&path, None).unwrap()[0];
        assert_eq!(trade.fees, 3.0);
        assert_eq!(trade.net_pnl, trade.gross_pnl - 3.0);

        set_commission_per_contract_side(&path, 0.5).unwrap();
        let recalculated = &load_trades(&path, None).unwrap()[0];
        assert_eq!(recalculated.fees, 2.0);
        assert_eq!(recalculated.net_pnl, recalculated.gross_pnl - 2.0);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn bracket_fill_child_id_inherits_exact_northstar_risk() {
        let path = temp();
        let draft = OrderDraft {
            account_id: "A1".into(),
            symbol: "MESU26".into(),
            side: "Buy".into(),
            order_type: "Market".into(),
            quantity: 1,
            limit_price: None,
            stop_price: None,
            duration: "DAY".into(),
            take_profit: Some(6260.0),
            stop_loss: Some(6245.0),
            rollover_acknowledged: false,
        };
        let meta = SymbolMeta {
            provider: MarketDataProvider::Tradestation,
            symbol: "MESU26".into(),
            description: "Micro E-mini S&P".into(),
            exchange: "CME".into(),
            asset_type: "Future".into(),
            min_move: 0.25,
            point_value: 5.0,
            expiration: None,
            root: Some("MES".into()),
            underlying: None,
        };
        let intent = start_entry_intent(&path, &TradingEnvironment::Sim, &draft, &meta).unwrap();
        let submitted = order("parent-order", "Buy", "Open", 0.0, 0.0);
        complete_entry_intent(&path, &intent, &submitted).unwrap();

        let mut fill = order("child-fill", "Buy", "Open", 1.0, 6250.0);
        fill.timestamp = now();
        fill.closed_at = Some(fill.timestamp.clone());
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[fill],
            "broker-stream",
            &HashMap::from([("MESU26".into(), 5.0)]),
        )
        .unwrap();
        let trade = &load_trades(&path, None).unwrap()[0];
        assert_eq!(trade.risk_provenance, "exact");
        assert_eq!(trade.original_stop, Some(6245.0));
        assert_eq!(trade.deployed_risk, Some(25.0));
        let mut screenshot = screenshot_input(1512, 720);
        screenshot.broker_order_id = "parent-order".into();
        assert_eq!(
            resolve_screenshot_trade(&path, &screenshot).unwrap(),
            trade.id
        );
        let persisted_order_id: String = Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT broker_order_id FROM journal_intents WHERE id=?1",
                params![intent],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(persisted_order_id, "parent-order");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reconciliation_upgrades_an_existing_inferred_trade_to_exact_risk() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        let mut fill = order("late-linked-fill", "Buy", "Open", 1.0, 6250.0);
        fill.timestamp = now();
        fill.closed_at = Some(fill.timestamp.clone());
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            std::slice::from_ref(&fill),
            "broker-stream",
            &points,
        )
        .unwrap();
        assert_eq!(
            load_trades(&path, None).unwrap()[0].risk_provenance,
            "unknown"
        );

        let draft = OrderDraft {
            account_id: "A1".into(),
            symbol: "MESU26".into(),
            side: "BUY".into(),
            order_type: "Market".into(),
            quantity: 1,
            limit_price: None,
            stop_price: None,
            duration: "DAY".into(),
            take_profit: Some(6260.0),
            stop_loss: Some(6245.0),
            rollover_acknowledged: false,
        };
        let meta = SymbolMeta {
            provider: MarketDataProvider::Tradestation,
            symbol: "MESU26".into(),
            description: "Micro E-mini S&P".into(),
            exchange: "CME".into(),
            asset_type: "Future".into(),
            min_move: 0.25,
            point_value: 5.0,
            expiration: None,
            root: Some("MES".into()),
            underlying: None,
        };
        let intent = start_entry_intent(&path, &TradingEnvironment::Sim, &draft, &meta).unwrap();
        complete_entry_intent(
            &path,
            &intent,
            &order("late-parent", "Buy", "Open", 0.0, 0.0),
        )
        .unwrap();

        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[fill],
            "broker-stream",
            &points,
        )
        .unwrap();
        let trade = &load_trades(&path, None).unwrap()[0];
        assert_eq!(trade.risk_provenance, "exact");
        assert_eq!(trade.original_stop, Some(6245.0));
        assert_eq!(trade.deployed_risk, Some(25.0));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cancellation_attempts_are_append_only_campaign_events() {
        let path = temp();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[order("1", "Buy", "Open", 1.0, 6250.0)],
            "broker-stream",
            &points,
        )
        .unwrap();
        record_cancel_intent(&path, &TradingEnvironment::Sim, "1", "requested", None).unwrap();
        record_cancel_intent(&path, &TradingEnvironment::Sim, "1", "confirmed", None).unwrap();
        let trade_id = load_trades(&path, None).unwrap()[0].id.clone();
        let detail = trade(&path, &trade_id).unwrap();
        assert_eq!(
            detail
                .events
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "cancel-intent")
                .count(),
            2
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reconciliation_checkpoint_uses_a_two_day_overlap() {
        let path = temp();
        init(&path).unwrap();
        Connection::open(&path)
            .unwrap()
            .execute(
                "INSERT INTO journal_sync_state(key,value) VALUES(?1,'2026-07-15')",
                params!["broker-checkpoint:sim:A1"],
            )
            .unwrap();
        assert_eq!(
            reconciliation_since(&path, &TradingEnvironment::Sim, "A1", "2026-01-01").unwrap(),
            "2026-07-13"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn exact_recording_cutoff_ignores_earlier_broker_history() {
        let path = temp();
        configure_local(&path, Some("2026-03-08T05:00:00Z"));
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        let old = order("old", "Buy", "Open", 1.0, 6250.0);
        let mut new = order("new", "Buy", "Open", 1.0, 6251.0);
        new.timestamp = "2026-03-08T05:30:00Z".into();
        new.closed_at = Some("2026-03-08T05:31:00Z".into());

        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[old, new],
            "broker-history",
            &points,
        )
        .unwrap();

        let trades = load_trades(&path, None).unwrap();
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].average_entry, 6251.0);
        let db = Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM journal_events", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn start_fresh_clears_local_ledger_and_sets_exact_cutoff() {
        let path = temp();
        configure_local(&path, None);
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[order("old", "Buy", "Open", 1.0, 6250.0)],
            "broker-stream",
            &points,
        )
        .unwrap();
        Connection::open(&path)
            .unwrap()
            .execute(
                "INSERT INTO journal_sync_state(key,value) VALUES('broker-checkpoint:sim:A1','2026-03-08')",
                [],
            )
            .unwrap();

        let cutoff = "2026-07-15T23:45:12Z";
        reset_local_journal(&path, cutoff).unwrap();

        let db = Connection::open(&path).unwrap();
        for table in [
            "journal_trades",
            "journal_events",
            "journal_annotations",
            "journal_order_state",
            "journal_sync_state",
        ] {
            let count: i64 = db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} was not cleared");
        }
        let (backfill, stored_cutoff): (String, Option<String>) = db
            .query_row(
                "SELECT backfill_start,record_from FROM journal_config WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(backfill, "2026-07-15");
        assert_eq!(stored_cutoff.as_deref(), Some(cutoff));
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn newer_cross_device_cutoff_wins_and_purges_local_history() {
        let path = temp();
        configure_local(&path, None);
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE journal_config SET updated_at='2026-07-16T00:00:00Z' WHERE id=1",
                [],
            )
            .unwrap();
        let points = HashMap::from([("MESU26".into(), 5.0)]);
        ingest_orders(
            &path,
            &TradingEnvironment::Sim,
            &[order("old", "Buy", "Open", 1.0, 6250.0)],
            "broker-stream",
            &points,
        )
        .unwrap();
        let local = config(&path).unwrap().unwrap();

        merge_cloud_settings(
            &path,
            &local,
            Some(RemoteSettingsRow {
                backfill_start: "2026-07-15".into(),
                record_from: Some("2026-07-15T23:45:12Z".into()),
                updated_at: "2026-07-15T23:45:12Z".into(),
            }),
        )
        .unwrap();

        assert!(load_trades(&path, None).unwrap().is_empty());
        assert_eq!(
            record_from(&path).unwrap().as_deref(),
            Some("2026-07-15T23:45:12Z")
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn preference_conflicts_use_server_revisions_not_device_clocks() {
        let local = storage::PreferenceRecord {
            category: "watchlist".into(),
            schema_version: 1,
            payload: json!({"symbols":["MESU26"]}),
            revision: 4,
            mutation_id: "11111111-1111-1111-1111-111111111111".into(),
            device_id: "00000000-0000-0000-0000-000000000001".into(),
            server_updated_at: "2026-07-15T20:00:00Z".into(),
            dirty: true,
        };
        let same_remote = RemotePreferenceRow {
            category: local.category.clone(),
            schema_version: 1,
            payload: local.payload.clone(),
            revision: local.revision,
            mutation_id: local.mutation_id.clone(),
            device_id: local.device_id.clone(),
            server_updated_at: local.server_updated_at.clone(),
        };
        assert!(!remote_conflicts_with_dirty_local(
            &local,
            Some(&same_remote)
        ));

        let mut acknowledged_retry = same_remote.clone();
        acknowledged_retry.revision += 1;
        assert!(!remote_conflicts_with_dirty_local(
            &local,
            Some(&acknowledged_retry)
        ));

        let mut winning_remote = same_remote.clone();
        winning_remote.revision += 1;
        winning_remote.mutation_id = "22222222-2222-2222-2222-222222222222".into();
        assert!(remote_conflicts_with_dirty_local(
            &local,
            Some(&winning_remote)
        ));
        assert!(remote_conflicts_with_dirty_local(&local, None));

        let unseeded = storage::PreferenceRecord {
            revision: 0,
            ..local
        };
        assert!(!remote_conflicts_with_dirty_local(&unseeded, None));
    }

    fn screenshot_input(width: u32, height: u32) -> JournalScreenshotInput {
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&width.to_be_bytes());
        png[20..24].copy_from_slice(&height.to_be_bytes());
        JournalScreenshotInput {
            broker_order_id: "entry-1".into(),
            environment: TradingEnvironment::Sim,
            account_id: "A1".into(),
            symbol: "MESU26".into(),
            captured_at: "2026-07-15T20:00:00Z".into(),
            width,
            height,
            data_url: format!("data:image/png;base64,{}", BASE64.encode(png)),
        }
    }

    #[test]
    fn validates_entry_chart_png_type_dimensions_and_limit() {
        assert_eq!(
            validate_screenshot(&screenshot_input(1512, 720))
                .unwrap()
                .len(),
            24
        );
        let mut mismatch = screenshot_input(1512, 720);
        mismatch.width = 1511;
        assert!(validate_screenshot(&mismatch).is_err());
        let mut wrong_type = screenshot_input(1512, 720);
        wrong_type.data_url = wrong_type.data_url.replacen("image/png", "image/jpeg", 1);
        assert!(validate_screenshot(&wrong_type).is_err());
        assert!(validate_screenshot(&screenshot_input(8193, 720)).is_err());
    }

    #[test]
    fn entry_chart_object_path_is_owner_scoped_and_deterministic() {
        assert_eq!(
            screenshot_object_path("user-1", "trade-1"),
            "user-1/trade-1/entry.png"
        );
    }

    #[test]
    fn resolves_entry_chart_only_through_the_matching_trade_scope() {
        let path = temp();
        init(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute("INSERT INTO journal_trades(id,environment,account_id,symbol,direction,status,opened_at,entry_quantity,exit_quantity,average_entry,gross_pnl,fees,net_pnl,risk_provenance,updated_at) VALUES('trade-1','sim','A1','MESU26','Long','open','2026-07-15T20:00:00Z',1,0,6250,0,.4,-.4,'exact','2026-07-15T20:00:00Z')", []).unwrap();
        db.execute("INSERT INTO journal_events(id,event_key,trade_id,environment,account_id,broker_order_id,event_type,occurred_at,source,status) VALUES('event-1','intent:entry-1','trade-1','sim','A1','entry-1','entry-intent','2026-07-15T20:00:00Z','northstar','confirmed')", []).unwrap();
        let input = screenshot_input(1512, 720);
        assert_eq!(resolve_screenshot_trade(&path, &input).unwrap(), "trade-1");
        let mut wrong_account = input;
        wrong_account.account_id = "A2".into();
        assert!(resolve_screenshot_trade(&path, &wrong_account)
            .unwrap_err()
            .to_string()
            .contains("not ready"));
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn screenshot_cache_contains_metadata_but_no_image_bytes() {
        let path = temp();
        init(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        let columns = db
            .prepare("PRAGMA table_info(journal_screenshots)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            columns,
            vec![
                "trade_id",
                "object_path",
                "captured_at",
                "width",
                "height",
                "content_type"
            ]
        );
        assert!(!columns
            .iter()
            .any(|column| column.contains("data") || column.contains("blob")));
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn stats_range_is_inclusive_in_new_york_and_scope_isolated() {
        let path = temp();
        init(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        for (id, account, opened_at) in [
            ("before", "A1", "2026-03-08T04:30:00Z"),
            ("inside", "A1", "2026-03-08T07:30:00Z"),
            ("end", "A1", "2026-03-09T03:59:00Z"),
            ("other-account", "A2", "2026-03-08T18:00:00Z"),
        ] {
            db.execute(
                "INSERT INTO journal_trades(id,environment,account_id,symbol,direction,status,opened_at,closed_at,entry_quantity,exit_quantity,average_entry,average_exit,gross_pnl,fees,net_pnl,risk_provenance,updated_at) VALUES(?1,'sim',?2,'MESU26','Long','closed',?3,?3,1,1,6250,6251,5,1,4,'exact',?3)",
                params![id, account, opened_at],
            )
            .unwrap();
        }
        drop(db);
        let result = stats_range(
            &path,
            JournalScope {
                provider: MarketDataProvider::Tradestation,
                environment: TradingEnvironment::Sim,
                account_id: "A1".into(),
                account_label: "A1".into(),
            },
            Some("2026-03-08".into()),
            Some("2026-03-08".into()),
        )
        .unwrap();
        assert_eq!(
            result
                .trades
                .iter()
                .map(|trade| trade.id.as_str())
                .collect::<Vec<_>>(),
            vec!["inside", "end"]
        );
        std::fs::remove_file(path).unwrap();
    }
}
