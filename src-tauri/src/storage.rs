use crate::AppError;
use keyring::Entry;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};

const SERVICE: &str = "com.northstar.trader";
const CREDENTIALS_ACCOUNT: &str = "credentials";
const BAR_TIME_FORMAT_VERSION: &str = "2";

#[derive(Clone, Default, Deserialize, Serialize)]
struct Credentials {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
}

static CREDENTIALS: OnceLock<Mutex<Option<Credentials>>> = OnceLock::new();

fn credentials_cache() -> &'static Mutex<Option<Credentials>> {
    CREDENTIALS.get_or_init(|| Mutex::new(None))
}

fn credentials_entry() -> Result<Entry, AppError> {
    Ok(Entry::new(SERVICE, CREDENTIALS_ACCOUNT)?)
}

fn read_credentials() -> Result<Credentials, AppError> {
    let mut cached = credentials_cache()
        .lock()
        .map_err(|_| AppError::Api("Credential cache is unavailable".into()))?;
    if let Some(credentials) = cached.as_ref() {
        return Ok(credentials.clone());
    }
    let credentials = match credentials_entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)?,
        Err(keyring::Error::NoEntry) => Credentials::default(),
        Err(error) => return Err(error.into()),
    };
    *cached = Some(credentials.clone());
    Ok(credentials)
}

fn write_credentials(credentials: &Credentials) -> Result<(), AppError> {
    credentials_entry()?.set_password(&serde_json::to_string(credentials)?)?;
    *credentials_cache()
        .lock()
        .map_err(|_| AppError::Api("Credential cache is unavailable".into()))? =
        Some(credentials.clone());
    Ok(())
}

pub fn get_secret(key: &str) -> Result<Option<String>, AppError> {
    let credentials = read_credentials()?;
    match key {
        "client_id" => Ok(credentials.client_id),
        "client_secret" => Ok(credentials.client_secret),
        "refresh_token" => Ok(credentials.refresh_token),
        _ => Err(AppError::Validation(format!(
            "Unknown credential key: {key}"
        ))),
    }
}

pub fn set_secret(key: &str, value: &str) -> Result<(), AppError> {
    let mut credentials = read_credentials()?;
    match key {
        "client_id" => credentials.client_id = Some(value.to_owned()),
        "client_secret" => credentials.client_secret = Some(value.to_owned()),
        "refresh_token" => credentials.refresh_token = Some(value.to_owned()),
        _ => {
            return Err(AppError::Validation(format!(
                "Unknown credential key: {key}"
            )))
        }
    }
    write_credentials(&credentials)
}

pub fn delete_secret(key: &str) -> Result<(), AppError> {
    let mut credentials = read_credentials()?;
    match key {
        "client_id" => credentials.client_id = None,
        "client_secret" => credentials.client_secret = None,
        "refresh_token" => credentials.refresh_token = None,
        _ => {
            return Err(AppError::Validation(format!(
                "Unknown credential key: {key}"
            )))
        }
    }
    write_credentials(&credentials)
}

fn connection(path: &Path) -> Result<Connection, AppError> {
    let mut db = Connection::open(path)?;
    db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)", [])?;
    db.execute("CREATE TABLE IF NOT EXISTS bars (environment TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, realtime INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(environment,symbol,timeframe,time))", [])?;
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

pub fn save_workspace(path: &Path, value: &serde_json::Value) -> Result<(), AppError> {
    connection(path)?.execute(
        "INSERT INTO settings(key,value) VALUES('workspace',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
        params![serde_json::to_string(value)?],
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
