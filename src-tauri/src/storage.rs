use crate::AppError;
use keyring::Entry;
use rusqlite::{params, Connection};
use std::path::Path;

const SERVICE: &str = "com.northstar.trader";

fn entry(key: &str) -> Result<Entry, AppError> {
    Ok(Entry::new(SERVICE, key)?)
}

pub fn set_secret(key: &str, value: &str) -> Result<(), AppError> {
    entry(key)?.set_password(value)?;
    Ok(())
}

pub fn get_secret(key: &str) -> Result<Option<String>, AppError> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn delete_secret(key: &str) -> Result<(), AppError> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn connection(path: &Path) -> Result<Connection, AppError> {
    let db = Connection::open(path)?;
    db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)", [])?;
    Ok(db)
}

pub fn save_workspace(path: &Path, value: &serde_json::Value) -> Result<(), AppError> {
    connection(path)?.execute(
        "INSERT INTO settings(key,value) VALUES('workspace',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
        params![serde_json::to_string(value)?],
    )?;
    Ok(())
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
