use crate::AppError;
use keyring::Entry;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};

const SERVICE: &str = "com.northstar.trader";
const LEGACY_CREDENTIALS_ACCOUNT: &str = "credentials";
const TRADESTATION_CREDENTIALS_ACCOUNT: &str = "tradestation";
const SCHWAB_CREDENTIALS_ACCOUNT: &str = "schwab";
const SUPABASE_CREDENTIALS_ACCOUNT: &str = "supabase";
const BAR_TIME_FORMAT_VERSION: &str = "2";

pub const PREFERENCE_CATEGORIES: [&str; 7] = [
    "chart_workspace",
    "alerts",
    "drawings",
    "watchlist",
    "chart_display",
    "order_entry",
    "journal_fees",
];

#[derive(Clone, Default, Deserialize, Serialize)]
struct Credentials {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
    journal_refresh_token: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct TradeStationCredentials {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct SchwabCredentials {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct SupabaseCredentials {
    refresh_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceRecord {
    pub category: String,
    pub schema_version: i64,
    pub payload: serde_json::Value,
    pub revision: i64,
    pub mutation_id: String,
    pub device_id: String,
    pub server_updated_at: String,
    #[serde(skip)]
    pub dirty: bool,
}

static TRADESTATION_CREDENTIALS: OnceLock<Mutex<Option<TradeStationCredentials>>> = OnceLock::new();
static SCHWAB_CREDENTIALS: OnceLock<Mutex<Option<SchwabCredentials>>> = OnceLock::new();
static SUPABASE_CREDENTIALS: OnceLock<Mutex<Option<SupabaseCredentials>>> = OnceLock::new();
static CREDENTIAL_MIGRATED: OnceLock<Mutex<bool>> = OnceLock::new();

fn tradestation_credentials_cache() -> &'static Mutex<Option<TradeStationCredentials>> {
    TRADESTATION_CREDENTIALS.get_or_init(|| Mutex::new(None))
}

fn schwab_credentials_cache() -> &'static Mutex<Option<SchwabCredentials>> {
    SCHWAB_CREDENTIALS.get_or_init(|| Mutex::new(None))
}

fn supabase_credentials_cache() -> &'static Mutex<Option<SupabaseCredentials>> {
    SUPABASE_CREDENTIALS.get_or_init(|| Mutex::new(None))
}

fn credentials_entry(account: &str) -> Result<Entry, AppError> {
    Ok(Entry::new(SERVICE, account)?)
}

fn split_legacy_credentials(legacy: Credentials) -> (TradeStationCredentials, SupabaseCredentials) {
    (
        TradeStationCredentials {
            client_id: legacy.client_id,
            client_secret: legacy.client_secret,
            refresh_token: legacy.refresh_token,
        },
        SupabaseCredentials {
            refresh_token: legacy.journal_refresh_token,
        },
    )
}

fn migrate_legacy_credentials() -> Result<(), AppError> {
    let mut migrated = CREDENTIAL_MIGRATED
        .get_or_init(|| Mutex::new(false))
        .lock()
        .map_err(|_| AppError::Api("Credential migration lock is unavailable".into()))?;
    if *migrated {
        return Ok(());
    }
    let legacy_entry = credentials_entry(LEGACY_CREDENTIALS_ACCOUNT)?;
    let legacy = match legacy_entry.get_password() {
        Ok(value) => Some(serde_json::from_str::<Credentials>(&value)?),
        Err(keyring::Error::NoEntry) => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(legacy) = legacy {
        let (tradestation, supabase) = split_legacy_credentials(legacy);
        credentials_entry(TRADESTATION_CREDENTIALS_ACCOUNT)?
            .set_password(&serde_json::to_string(&tradestation)?)?;
        credentials_entry(SUPABASE_CREDENTIALS_ACCOUNT)?
            .set_password(&serde_json::to_string(&supabase)?)?;
        legacy_entry.delete_credential()?;
        *tradestation_credentials_cache()
            .lock()
            .map_err(|_| AppError::Api("Credential cache is unavailable".into()))? =
            Some(tradestation);
        *supabase_credentials_cache()
            .lock()
            .map_err(|_| AppError::Api("Credential cache is unavailable".into()))? = Some(supabase);
    }
    *migrated = true;
    Ok(())
}

fn read_tradestation_credentials() -> Result<TradeStationCredentials, AppError> {
    migrate_legacy_credentials()?;
    let mut cached = tradestation_credentials_cache()
        .lock()
        .map_err(|_| AppError::Api("Credential cache is unavailable".into()))?;
    if let Some(credentials) = cached.as_ref() {
        return Ok(credentials.clone());
    }
    let credentials = match credentials_entry(TRADESTATION_CREDENTIALS_ACCOUNT)?.get_password() {
        Ok(value) => serde_json::from_str(&value)?,
        Err(keyring::Error::NoEntry) => TradeStationCredentials::default(),
        Err(error) => return Err(error.into()),
    };
    *cached = Some(credentials.clone());
    Ok(credentials)
}

fn read_supabase_credentials() -> Result<SupabaseCredentials, AppError> {
    migrate_legacy_credentials()?;
    let mut cached = supabase_credentials_cache()
        .lock()
        .map_err(|_| AppError::Api("Credential cache is unavailable".into()))?;
    if let Some(credentials) = cached.as_ref() {
        return Ok(credentials.clone());
    }
    let credentials = match credentials_entry(SUPABASE_CREDENTIALS_ACCOUNT)?.get_password() {
        Ok(value) => serde_json::from_str(&value)?,
        Err(keyring::Error::NoEntry) => SupabaseCredentials::default(),
        Err(error) => return Err(error.into()),
    };
    *cached = Some(credentials.clone());
    Ok(credentials)
}

fn read_schwab_credentials() -> Result<SchwabCredentials, AppError> {
    let mut cached = schwab_credentials_cache()
        .lock()
        .map_err(|_| AppError::Api("Credential cache is unavailable".into()))?;
    if let Some(credentials) = cached.as_ref() {
        return Ok(credentials.clone());
    }
    let credentials = match credentials_entry(SCHWAB_CREDENTIALS_ACCOUNT)?.get_password() {
        Ok(value) => serde_json::from_str(&value)?,
        Err(keyring::Error::NoEntry) => SchwabCredentials::default(),
        Err(error) => return Err(error.into()),
    };
    *cached = Some(credentials.clone());
    Ok(credentials)
}

fn write_tradestation_credentials(credentials: &TradeStationCredentials) -> Result<(), AppError> {
    credentials_entry(TRADESTATION_CREDENTIALS_ACCOUNT)?
        .set_password(&serde_json::to_string(credentials)?)?;
    *tradestation_credentials_cache()
        .lock()
        .map_err(|_| AppError::Api("Credential cache is unavailable".into()))? =
        Some(credentials.clone());
    Ok(())
}

fn write_supabase_credentials(credentials: &SupabaseCredentials) -> Result<(), AppError> {
    credentials_entry(SUPABASE_CREDENTIALS_ACCOUNT)?
        .set_password(&serde_json::to_string(credentials)?)?;
    *supabase_credentials_cache()
        .lock()
        .map_err(|_| AppError::Api("Credential cache is unavailable".into()))? =
        Some(credentials.clone());
    Ok(())
}

fn write_schwab_credentials(credentials: &SchwabCredentials) -> Result<(), AppError> {
    credentials_entry(SCHWAB_CREDENTIALS_ACCOUNT)?
        .set_password(&serde_json::to_string(credentials)?)?;
    *schwab_credentials_cache()
        .lock()
        .map_err(|_| AppError::Api("Credential cache is unavailable".into()))? =
        Some(credentials.clone());
    Ok(())
}

pub fn schwab_client() -> Result<Option<(String, String)>, AppError> {
    let credentials = read_schwab_credentials()?;
    Ok(match (credentials.client_id, credentials.client_secret) {
        (Some(client_id), Some(client_secret)) => Some((client_id, client_secret)),
        _ => None,
    })
}

pub fn save_schwab_client(client_id: &str, client_secret: &str) -> Result<bool, AppError> {
    if client_id.trim().is_empty() || client_secret.is_empty() {
        return Err(AppError::Validation(
            "Schwab App Key and App Secret are required".into(),
        ));
    }
    let mut credentials = read_schwab_credentials()?;
    let changed = credentials.client_id.as_deref() != Some(client_id.trim())
        || credentials.client_secret.as_deref() != Some(client_secret);
    credentials.client_id = Some(client_id.trim().to_owned());
    credentials.client_secret = Some(client_secret.to_owned());
    if changed {
        credentials.refresh_token = None;
    }
    write_schwab_credentials(&credentials)?;
    Ok(changed)
}

pub fn schwab_refresh_token() -> Result<Option<String>, AppError> {
    Ok(read_schwab_credentials()?.refresh_token)
}

pub fn save_schwab_refresh_token(value: &str) -> Result<(), AppError> {
    let mut credentials = read_schwab_credentials()?;
    credentials.refresh_token = Some(value.to_owned());
    write_schwab_credentials(&credentials)
}

pub fn clear_schwab_refresh_token() -> Result<(), AppError> {
    let mut credentials = read_schwab_credentials()?;
    credentials.refresh_token = None;
    write_schwab_credentials(&credentials)
}

pub fn get_secret(key: &str) -> Result<Option<String>, AppError> {
    match key {
        "client_id" => Ok(read_tradestation_credentials()?.client_id),
        "client_secret" => Ok(read_tradestation_credentials()?.client_secret),
        "refresh_token" => Ok(read_tradestation_credentials()?.refresh_token),
        "journal_refresh_token" => Ok(read_supabase_credentials()?.refresh_token),
        _ => Err(AppError::Validation(format!(
            "Unknown credential key: {key}"
        ))),
    }
}

pub fn set_secret(key: &str, value: &str) -> Result<(), AppError> {
    match key {
        "client_id" | "client_secret" | "refresh_token" => {
            let mut credentials = read_tradestation_credentials()?;
            match key {
                "client_id" => credentials.client_id = Some(value.to_owned()),
                "client_secret" => credentials.client_secret = Some(value.to_owned()),
                "refresh_token" => credentials.refresh_token = Some(value.to_owned()),
                _ => unreachable!(),
            }
            write_tradestation_credentials(&credentials)
        }
        "journal_refresh_token" => {
            let mut credentials = read_supabase_credentials()?;
            credentials.refresh_token = Some(value.to_owned());
            write_supabase_credentials(&credentials)
        }
        _ => Err(AppError::Validation(format!(
            "Unknown credential key: {key}"
        ))),
    }
}

pub fn delete_secret(key: &str) -> Result<(), AppError> {
    match key {
        "client_id" | "client_secret" | "refresh_token" => {
            let mut credentials = read_tradestation_credentials()?;
            match key {
                "client_id" => credentials.client_id = None,
                "client_secret" => credentials.client_secret = None,
                "refresh_token" => credentials.refresh_token = None,
                _ => unreachable!(),
            }
            write_tradestation_credentials(&credentials)
        }
        "journal_refresh_token" => {
            let mut credentials = read_supabase_credentials()?;
            credentials.refresh_token = None;
            write_supabase_credentials(&credentials)
        }
        _ => Err(AppError::Validation(format!(
            "Unknown credential key: {key}"
        ))),
    }
}

fn connection(path: &Path) -> Result<Connection, AppError> {
    let mut db = Connection::open(path)?;
    db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)", [])?;
    db.execute("CREATE TABLE IF NOT EXISTS bars (environment TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, realtime INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(environment,symbol,timeframe,time))", [])?;
    db.execute("CREATE TABLE IF NOT EXISTS app_preference_local (category TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, payload TEXT NOT NULL, modified_at TEXT NOT NULL, device_id TEXT NOT NULL)", [])?;
    ensure_column(
        &db,
        "app_preference_local",
        "revision",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &db,
        "app_preference_local",
        "mutation_id",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &db,
        "app_preference_local",
        "server_updated_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &db,
        "app_preference_local",
        "dirty",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    let current_version = db.query_row(
        "SELECT value FROM settings WHERE key='bar_time_format_version'",
        [],
        |row| row.get::<_, String>(0),
    );
    if !matches!(current_version, Ok(ref version) if version == BAR_TIME_FORMAT_VERSION) {
        let tx = db.transaction()?;
        tx.execute("DELETE FROM bars", [])?;
        tx.execute(
            "INSERT INTO settings(key,value) VALUES('bar_time_format_version',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
            params![BAR_TIME_FORMAT_VERSION],
        )?;
        tx.commit()?;
    }
    Ok(db)
}

fn ensure_column(
    db: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<(), AppError> {
    let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    if !columns.iter().any(|existing| existing == column) {
        db.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
        ))?;
    }
    Ok(())
}

fn preference_device_id(db: &Connection) -> Result<String, AppError> {
    if let Some(value) = db
        .query_row(
            "SELECT value FROM settings WHERE key='preference_device_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(value);
    }
    let value = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO settings(key,value) VALUES('preference_device_id',?1)",
        params![value],
    )?;
    Ok(value)
}

pub fn local_preference_device_id(path: &Path) -> Result<String, AppError> {
    let db = connection(path)?;
    preference_device_id(&db)
}

fn record_preference_profile_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    profile: &serde_json::Value,
    device_id: &str,
) -> Result<(), AppError> {
    let Some(categories) = profile
        .get("categories")
        .and_then(serde_json::Value::as_object)
    else {
        return Err(AppError::Validation(
            "Cloud preference profile is missing categories".into(),
        ));
    };
    for category in PREFERENCE_CATEGORIES {
        let Some(payload) = categories.get(category).filter(|value| value.is_object()) else {
            return Err(AppError::Validation(format!(
                "Cloud preference category {category} must be an object"
            )));
        };
        let payload = serde_json::to_string(payload)?;
        let existing = tx
            .query_row(
                "SELECT payload,mutation_id,dirty FROM app_preference_local WHERE category=?1",
                params![category],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? != 0,
                    ))
                },
            )
            .optional()?;
        if existing
            .as_ref()
            .is_some_and(|(saved, mutation_id, _)| saved == &payload && !mutation_id.is_empty())
        {
            continue;
        }
        let mutation_id = uuid::Uuid::new_v4().to_string();
        let dirty = existing
            .as_ref()
            .map(|(saved, _, already_dirty)| i32::from(saved != &payload || *already_dirty))
            .unwrap_or(0);
        tx.execute(
            "INSERT INTO app_preference_local(category,schema_version,payload,modified_at,device_id,revision,mutation_id,server_updated_at,dirty) VALUES(?1,1,?2,'1970-01-01T00:00:00Z',?3,0,?4,'',?5) ON CONFLICT(category) DO UPDATE SET schema_version=1,payload=excluded.payload,mutation_id=excluded.mutation_id,device_id=excluded.device_id,dirty=excluded.dirty",
            params![category, payload, device_id, mutation_id, dirty],
        )?;
    }
    Ok(())
}

pub fn record_preference_profile(path: &Path, profile: &serde_json::Value) -> Result<(), AppError> {
    let mut db = connection(path)?;
    let device_id = preference_device_id(&db)?;
    let tx = db.transaction()?;
    record_preference_profile_in_transaction(&tx, profile, &device_id)?;
    tx.commit()?;
    Ok(())
}

pub fn save_workspace(
    path: &Path,
    value: &serde_json::Value,
    profile: Option<&serde_json::Value>,
) -> Result<(), AppError> {
    let mut db = connection(path)?;
    let device_id = preference_device_id(&db)?;
    let tx = db.transaction()?;
    tx.execute(
        "INSERT INTO settings(key,value) VALUES('workspace',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
        params![serde_json::to_string(value)?],
    )?;
    if let Some(profile) = profile {
        record_preference_profile_in_transaction(&tx, profile, &device_id)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn local_preferences(path: &Path) -> Result<Vec<PreferenceRecord>, AppError> {
    let db = connection(path)?;
    let mut statement = db.prepare(
        "SELECT category,schema_version,payload,revision,mutation_id,device_id,server_updated_at,dirty FROM app_preference_local",
    )?;
    let rows = statement.query_map([], |row| {
        let payload = row.get::<_, String>(2)?;
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            payload,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, i64>(7)? != 0,
        ))
    })?;
    rows.map(|row| {
        let (
            category,
            schema_version,
            payload,
            revision,
            mutation_id,
            device_id,
            server_updated_at,
            dirty,
        ) = row?;
        Ok(PreferenceRecord {
            category,
            schema_version,
            payload: serde_json::from_str(&payload)?,
            revision,
            mutation_id,
            device_id,
            server_updated_at,
            dirty,
        })
    })
    .collect()
}

pub fn replace_local_preference(path: &Path, record: &PreferenceRecord) -> Result<(), AppError> {
    if !PREFERENCE_CATEGORIES.contains(&record.category.as_str())
        || record.schema_version != 1
        || !record.payload.is_object()
    {
        return Err(AppError::Validation(
            "Invalid cloud preference record".into(),
        ));
    }
    connection(path)?.execute(
        "INSERT INTO app_preference_local(category,schema_version,payload,modified_at,device_id,revision,mutation_id,server_updated_at,dirty) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0) ON CONFLICT(category) DO UPDATE SET schema_version=excluded.schema_version,payload=excluded.payload,device_id=excluded.device_id,revision=excluded.revision,mutation_id=excluded.mutation_id,server_updated_at=excluded.server_updated_at,dirty=0",
        params![record.category, record.schema_version, serde_json::to_string(&record.payload)?, record.server_updated_at, record.device_id, record.revision, record.mutation_id, record.server_updated_at],
    )?;
    Ok(())
}

pub fn save_bars(
    path: &Path,
    environment: &str,
    symbol: &str,
    timeframe: &str,
    bars: &[crate::models::Bar],
) -> Result<(), AppError> {
    if bars.is_empty() {
        return Ok(());
    }
    let mut db = connection(path)?;
    let tx = db.transaction()?;
    {
        let mut statement = tx.prepare("INSERT INTO bars(environment,symbol,timeframe,time,open,high,low,close,volume,realtime) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(environment,symbol,timeframe,time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,realtime=excluded.realtime")?;
        for bar in bars {
            statement.execute(params![
                environment,
                symbol,
                timeframe,
                bar.time,
                bar.open,
                bar.high,
                bar.low,
                bar.close,
                bar.volume,
                bar.realtime as i32
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn load_bars(
    path: &Path,
    environment: &str,
    symbol: &str,
    timeframe: &str,
    limit: usize,
) -> Result<Vec<crate::models::Bar>, AppError> {
    let db = connection(path)?;
    let mut statement = db.prepare("SELECT time,open,high,low,close,volume,realtime FROM bars WHERE environment=?1 AND symbol=?2 AND timeframe=?3 ORDER BY time DESC LIMIT ?4")?;
    let rows = statement.query_map(
        params![environment, symbol, timeframe, limit as i64],
        |row| {
            Ok(crate::models::Bar {
                time: row.get(0)?,
                open: row.get(1)?,
                high: row.get(2)?,
                low: row.get(3)?,
                close: row.get(4)?,
                volume: row.get(5)?,
                realtime: row.get::<_, i32>(6)? != 0,
            })
        },
    )?;
    let mut bars: Vec<_> = rows.collect::<Result<_, _>>()?;
    bars.reverse();
    Ok(bars)
}

pub fn load_bars_range(
    path: &Path,
    environment: &str,
    symbol: &str,
    timeframe: &str,
    first: i64,
    last: i64,
) -> Result<Vec<crate::models::Bar>, AppError> {
    let db = connection(path)?;
    let mut statement = db.prepare("SELECT time,open,high,low,close,volume,realtime FROM bars WHERE environment=?1 AND symbol=?2 AND timeframe=?3 AND time>=?4 AND time<?5 ORDER BY time ASC")?;
    let rows = statement.query_map(
        params![environment, symbol, timeframe, first, last],
        |row| {
            Ok(crate::models::Bar {
                time: row.get(0)?,
                open: row.get(1)?,
                high: row.get(2)?,
                low: row.get(3)?,
                close: row.get(4)?,
                volume: row.get(5)?,
                realtime: row.get::<_, i32>(6)? != 0,
            })
        },
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn load_workspace(path: &Path) -> Result<Option<serde_json::Value>, AppError> {
    let db = connection(path)?;
    let mut query = db.prepare("SELECT value FROM settings WHERE key='workspace'")?;
    let value = query.query_row([], |row| row.get::<_, String>(0));
    match value {
        Ok(json) => Ok(Some(serde_json::from_str(&json)?)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Bar;

    #[test]
    fn cached_bar_ranges_are_ordered_and_scoped() {
        let path = std::env::temp_dir().join(format!(
            "northstar-vwap-range-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let bars = vec![
            Bar {
                time: 300,
                open: 3.0,
                high: 3.0,
                low: 3.0,
                close: 3.0,
                volume: 3.0,
                realtime: false,
            },
            Bar {
                time: 100,
                open: 1.0,
                high: 1.0,
                low: 1.0,
                close: 1.0,
                volume: 1.0,
                realtime: false,
            },
            Bar {
                time: 200,
                open: 2.0,
                high: 2.0,
                low: 2.0,
                close: 2.0,
                volume: 2.0,
                realtime: false,
            },
        ];
        save_bars(&path, "sim", "@MES", "1m", &bars).unwrap();
        save_bars(&path, "live", "@MES", "1m", &bars).unwrap();
        let loaded = load_bars_range(&path, "sim", "@MES", "1m", 150, 301).unwrap();
        assert_eq!(
            loaded.iter().map(|bar| bar.time).collect::<Vec<_>>(),
            vec![200, 300]
        );
        assert!(load_bars_range(&path, "sim", "@NQ", "1m", 0, 400)
            .unwrap()
            .is_empty());
        std::fs::remove_file(path).unwrap();
    }

    fn profile(watchlist: &str) -> serde_json::Value {
        let categories = PREFERENCE_CATEGORIES
            .iter()
            .map(|category| {
                let payload = if *category == "watchlist" {
                    serde_json::json!({"symbols":[watchlist]})
                } else {
                    serde_json::json!({"value":category})
                };
                ((*category).to_string(), payload)
            })
            .collect::<serde_json::Map<_, _>>();
        serde_json::json!({"schemaVersion":1,"categories":categories})
    }

    #[test]
    fn new_workspace_preferences_start_clean_then_track_only_changed_categories() {
        let path = std::env::temp_dir().join(format!(
            "northstar-preferences-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let first = profile("MESU26");
        save_workspace(&path, &serde_json::json!({"revision":1}), Some(&first)).unwrap();
        let seeded = local_preferences(&path).unwrap();
        assert_eq!(seeded.len(), PREFERENCE_CATEGORIES.len());
        assert!(seeded
            .iter()
            .all(|record| !record.dirty && record.revision == 0));
        assert!(seeded
            .iter()
            .all(|record| uuid::Uuid::parse_str(&record.mutation_id).is_ok()));
        let device_id = seeded[0].device_id.clone();
        assert!(seeded.iter().all(|record| record.device_id == device_id));
        let seeded_watchlist_mutation = seeded
            .iter()
            .find(|record| record.category == "watchlist")
            .unwrap()
            .mutation_id
            .clone();

        let second = profile("MNQU26");
        save_workspace(&path, &serde_json::json!({"revision":2}), Some(&second)).unwrap();
        let tracked = local_preferences(&path).unwrap();
        let tracked_watchlist = tracked
            .iter()
            .find(|record| record.category == "watchlist")
            .unwrap();
        assert!(tracked_watchlist.dirty);
        assert_ne!(tracked_watchlist.mutation_id, seeded_watchlist_mutation);
        assert!(tracked
            .iter()
            .filter(|record| record.category != "watchlist")
            .all(|record| !record.dirty));

        let retry_mutation = tracked_watchlist.mutation_id.clone();
        save_workspace(&path, &serde_json::json!({"revision":3}), Some(&second)).unwrap();
        let retried = local_preferences(&path)
            .unwrap()
            .into_iter()
            .find(|record| record.category == "watchlist")
            .unwrap();
        assert_eq!(retried.mutation_id, retry_mutation);
        assert!(retried.dirty);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn downloaded_preference_replaces_local_metadata_without_marking_a_new_edit() {
        let path = std::env::temp_dir().join(format!(
            "northstar-preference-remote-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        record_preference_profile(&path, &profile("MESU26")).unwrap();
        let record = PreferenceRecord {
            category: "watchlist".into(),
            schema_version: 1,
            payload: serde_json::json!({"symbols":["MCLU26"]}),
            revision: 7,
            mutation_id: uuid::Uuid::new_v4().to_string(),
            device_id: uuid::Uuid::new_v4().to_string(),
            server_updated_at: "2026-07-15T20:00:00Z".into(),
            dirty: false,
        };
        replace_local_preference(&path, &record).unwrap();
        let saved = local_preferences(&path)
            .unwrap()
            .into_iter()
            .find(|item| item.category == "watchlist")
            .unwrap();
        assert_eq!(saved.payload, record.payload);
        assert_eq!(saved.revision, record.revision);
        assert_eq!(saved.mutation_id, record.mutation_id);
        assert_eq!(saved.device_id, record.device_id);
        assert!(!saved.dirty);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn legacy_credentials_split_into_independent_vault_payloads() {
        let (tradestation, supabase) = split_legacy_credentials(Credentials {
            client_id: Some("ts-client".into()),
            client_secret: Some("ts-secret".into()),
            refresh_token: Some("ts-refresh".into()),
            journal_refresh_token: Some("sb-refresh".into()),
        });
        let tradestation_json = serde_json::to_string(&tradestation).unwrap();
        let supabase_json = serde_json::to_string(&supabase).unwrap();
        assert!(tradestation_json.contains("ts-client"));
        assert!(tradestation_json.contains("ts-secret"));
        assert!(tradestation_json.contains("ts-refresh"));
        assert!(!tradestation_json.contains("sb-refresh"));
        assert_eq!(supabase_json, r#"{"refresh_token":"sb-refresh"}"#);
        assert!(!supabase_json.contains("ts-"));
    }
}
