mod models;
mod storage;
mod tradestation;

use models::*;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{Emitter, Manager, State};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tradestation::TradeStation;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Authentication required")]
    AuthenticationRequired,
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Api(String),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Keyring(#[from] keyring::Error),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub struct NativeState {
    api: TradeStation,
    db_path: PathBuf,
}

#[tauri::command]
async fn auth_status(state: State<'_, NativeState>) -> Result<AuthStatus, AppError> {
    let configured = storage::get_secret("client_id")?.is_some()
        && storage::get_secret("client_secret")?.is_some();
    let authenticated = state.api.token().await.is_ok();
    Ok(AuthStatus {
        configured,
        authenticated,
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn save_credentials(client_id: String, client_secret: String) -> Result<(), AppError> {
    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return Err(AppError::Validation(
            "Client ID and secret are required".into(),
        ));
    }
    storage::set_secret("client_id", client_id.trim())?;
    storage::set_secret("client_secret", client_secret.trim())?;
    Ok(())
}

#[tauri::command]
async fn begin_login(app: tauri::AppHandle, state: State<'_, NativeState>) -> Result<(), AppError> {
    let client_id = storage::get_secret("client_id")?.ok_or(AppError::AuthenticationRequired)?;
    let csrf = uuid::Uuid::new_v4().to_string();
    let mut url = url::Url::parse("https://signin.tradestation.com/authorize")?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", "http://localhost:8080")
        .append_pair("audience", "https://api.tradestation.com")
        .append_pair("state", &csrf)
        .append_pair(
            "scope",
            "openid profile offline_access MarketData ReadAccount Trade",
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080")
        .await
        .map_err(|_| AppError::Api("OAuth callback port 8080 is already in use".into()))?;
    open::that(url.as_str())
        .map_err(|error| AppError::Api(format!("Could not open system browser: {error}")))?;
    let api = state.api.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<(), AppError> = async {
            let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept()).await
                .map_err(|_| AppError::Api("TradeStation login timed out".into()))??;
            let mut bytes = vec![0u8; 8192];
            let count = stream.read(&mut bytes).await?;
            let request = String::from_utf8_lossy(&bytes[..count]);
            let path = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).ok_or_else(|| AppError::Api("Invalid OAuth callback".into()))?;
            let callback = url::Url::parse(&format!("http://localhost{path}"))?;
            let params: std::collections::HashMap<_, _> = callback.query_pairs().into_owned().collect();
            if params.get("state") != Some(&csrf) { return Err(AppError::Api("OAuth state validation failed".into())); }
            let code = params.get("code").ok_or_else(|| AppError::Api(params.get("error_description").cloned().unwrap_or_else(|| "Authorization denied".into())))?;
            let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><title>Northstar Trader</title><style>body{font-family:system-ui;background:#090c11;color:#d7dce5;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}b{color:#37d5e8}</style><div><h2><b>Connected.</b></h2><p>You can close this window and return to Northstar Trader.</p></div>";
            stream.write_all(response.as_bytes()).await?;
            api.exchange_code(code).await
        }.await;
        match result {
            Ok(()) => {
                let _ = app.emit("auth-changed", serde_json::json!({"authenticated":true}));
            }
            Err(error) => {
                let _ = app.emit("auth-error", error.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn logout(state: State<'_, NativeState>) -> Result<(), AppError> {
    state.api.clear_token().await;
    storage::delete_secret("refresh_token")?;
    Ok(())
}

#[tauri::command]
async fn set_environment(
    environment: TradingEnvironment,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    state.api.set_environment(environment).await;
    Ok(())
}

#[tauri::command]
async fn get_accounts(state: State<'_, NativeState>) -> Result<Vec<Account>, AppError> {
    state.api.accounts().await
}

#[tauri::command]
async fn search_symbols(
    query: String,
    state: State<'_, NativeState>,
) -> Result<Vec<SymbolMeta>, AppError> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    state.api.search_symbols(query.trim()).await
}

#[tauri::command]
async fn get_bars(
    symbol: String,
    timeframe: String,
    state: State<'_, NativeState>,
) -> Result<Vec<Bar>, AppError> {
    state.api.bars(&symbol, &timeframe).await
}

#[tauri::command]
async fn get_quotes(
    symbols: Vec<String>,
    state: State<'_, NativeState>,
) -> Result<Vec<Quote>, AppError> {
    state.api.quotes(&symbols).await
}

async fn first_account(state: &State<'_, NativeState>) -> Result<String, AppError> {
    state
        .api
        .accounts()
        .await?
        .first()
        .map(|account| account.id.clone())
        .ok_or_else(|| AppError::Validation("No futures account is available".into()))
}

#[tauri::command]
async fn get_positions(state: State<'_, NativeState>) -> Result<Vec<Position>, AppError> {
    let account = first_account(&state).await?;
    state.api.positions(&account).await
}

#[tauri::command]
async fn get_orders(state: State<'_, NativeState>) -> Result<Vec<OrderUpdate>, AppError> {
    let account = first_account(&state).await?;
    state.api.orders(&account).await
}

#[tauri::command]
async fn confirm_order(
    order: OrderDraft,
    state: State<'_, NativeState>,
) -> Result<OrderPreview, AppError> {
    state.api.confirm_order(&order).await
}

#[tauri::command]
async fn place_order(
    order: OrderDraft,
    state: State<'_, NativeState>,
) -> Result<OrderUpdate, AppError> {
    state.api.place_order(&order).await
}

#[tauri::command(rename_all = "camelCase")]
async fn cancel_order(order_id: String, state: State<'_, NativeState>) -> Result<(), AppError> {
    state.api.cancel_order(&order_id).await
}

#[tauri::command]
fn load_workspace(state: State<'_, NativeState>) -> Result<Option<Value>, AppError> {
    storage::load_workspace(&state.db_path)
}

#[tauri::command]
fn save_workspace(workspace: Value, state: State<'_, NativeState>) -> Result<(), AppError> {
    storage::save_workspace(&state.db_path, &workspace)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_dir)?;
            let api = TradeStation::new()?;
            app.manage(NativeState {
                api,
                db_path: app_dir.join("northstar.sqlite3"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            save_credentials,
            begin_login,
            logout,
            set_environment,
            get_accounts,
            search_symbols,
            get_bars,
            get_quotes,
            get_positions,
            get_orders,
            confirm_order,
            place_order,
            cancel_order,
            load_workspace,
            save_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running Northstar Trader");
}
