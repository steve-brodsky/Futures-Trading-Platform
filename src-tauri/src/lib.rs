mod models;
mod storage;
mod tradestation;

use futures_util::StreamExt;
use models::*;
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf};
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
    bar_streams: tokio::sync::Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    quote_stream: tokio::sync::Mutex<Option<(String, tauri::async_runtime::JoinHandle<()>)>>,
    brokerage_streams: tokio::sync::Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
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

#[tauri::command(rename_all = "camelCase")]
async fn load_cached_bars(
    symbol: String,
    timeframe: String,
    state: State<'_, NativeState>,
) -> Result<Vec<Bar>, AppError> {
    let environment = state.api.environment().await;
    storage::load_bars(
        &state.db_path,
        environment.key(),
        &symbol,
        &timeframe,
        10_000,
    )
}

#[tauri::command(rename_all = "camelCase")]
async fn get_older_bars(
    symbol: String,
    timeframe: String,
    before: i64,
    state: State<'_, NativeState>,
) -> Result<Vec<Bar>, AppError> {
    let environment = state.api.environment().await;
    let bars = state.api.older_bars(&symbol, &timeframe, before).await?;
    storage::save_bars(
        &state.db_path,
        environment.key(),
        &symbol,
        &timeframe,
        &bars,
    )?;
    Ok(bars)
}

#[tauri::command(rename_all = "camelCase")]
async fn start_bar_stream(
    app: tauri::AppHandle,
    subscription_id: String,
    symbol: String,
    timeframe: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    TradeStation::bar_stream_path(&symbol, &timeframe)?;
    let environment = state.api.environment().await;
    let task = tauri::async_runtime::spawn(run_bar_stream(
        app.clone(),
        state.api.clone(),
        state.db_path.clone(),
        subscription_id.clone(),
        environment.clone(),
        symbol,
        timeframe,
    ));
    if let Some(previous) = state.bar_streams.lock().await.insert(subscription_id, task) {
        previous.abort();
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn stop_bar_stream(subscription_id: String, state: State<'_, NativeState>) -> Result<(), AppError> {
    if let Some(task) = state.bar_streams.lock().await.remove(&subscription_id) {
        task.abort();
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn start_quote_stream(
    app: tauri::AppHandle,
    subscription_id: String,
    mut symbols: Vec<String>,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    symbols.sort();
    symbols.dedup();
    if symbols.len() > 100 {
        return Err(AppError::Validation("A maximum of 100 streamed quote symbols is supported".into()));
    }
    let environment = state.api.environment().await;
    let task = tauri::async_runtime::spawn(run_quote_stream(
        app,
        state.api.clone(),
        subscription_id.clone(),
        environment,
        symbols,
    ));
    let mut current = state.quote_stream.lock().await;
    if let Some((_, previous)) = current.replace((subscription_id, task)) {
        previous.abort();
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn stop_quote_stream(subscription_id: String, state: State<'_, NativeState>) -> Result<(), AppError> {
    let mut current = state.quote_stream.lock().await;
    if current.as_ref().is_some_and(|(id, _)| id == &subscription_id) {
        if let Some((_, task)) = current.take() {
            task.abort();
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn start_brokerage_stream(app: tauri::AppHandle, account_id: String, state: State<'_, NativeState>) -> Result<(), AppError> {
    let mut tasks = state.brokerage_streams.lock().await;
    for task in tasks.drain(..) { task.abort(); }
    for channel in ["positions", "orders"] {
        tasks.push(tauri::async_runtime::spawn(run_brokerage_stream(app.clone(), state.api.clone(), account_id.clone(), channel.to_string())));
    }
    Ok(())
}

#[tauri::command]
async fn stop_brokerage_stream(state: State<'_, NativeState>) -> Result<(), AppError> {
    for task in state.brokerage_streams.lock().await.drain(..) { task.abort(); }
    Ok(())
}

async fn run_brokerage_stream(app: tauri::AppHandle, api: TradeStation, account_id: String, channel: String) {
    let path = if channel == "positions" {
        format!("/brokerage/stream/accounts/{account_id}/{channel}?changes=true")
    } else {
        format!("/brokerage/stream/accounts/{account_id}/{channel}")
    };
    let mut attempt = 0u32;
    loop {
        match api.open_stream(&path).await {
            Ok(response) => {
                attempt = 0;
                let mut bytes = response.bytes_stream(); let mut buffer = Vec::new();
                while let Some(Ok(chunk)) = bytes.next().await {
                    let values = match decode_stream_values(&mut buffer, &chunk) { Ok(values) => values, Err(_) => break };
                    for data in values {
                        if data.get("StreamStatus").is_some() { continue; }
                        let _ = app.emit("brokerage-update", BrokerageUpdateEvent { account_id: account_id.clone(), channel: channel.clone(), data });
                    }
                }
            }
            Err(error) => {
                let message = error.to_string();
                // Some TradeStation account/environment combinations do not permit
                // brokerage streams. The UI's snapshot polling remains authoritative.
                if message.contains("403") || message.to_ascii_lowercase().contains("forbidden") { break; }
                let _ = app.emit("brokerage-stream-error", message);
            }
        }
        attempt = attempt.saturating_add(1);
        tokio::time::sleep(std::time::Duration::from_secs((1u64 << attempt.min(5)).min(30))).await;
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn get_positions(account_id: String, state: State<'_, NativeState>) -> Result<Vec<Position>, AppError> {
    state.api.positions(&account_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_orders(account_id: String, state: State<'_, NativeState>) -> Result<Vec<OrderUpdate>, AppError> {
    state.api.orders(&account_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_balances(account_id: String, state: State<'_, NativeState>) -> Result<Vec<AccountBalance>, AppError> {
    state.api.balances(&account_id, false).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_bod_balances(account_id: String, state: State<'_, NativeState>) -> Result<Vec<AccountBalance>, AppError> {
    state.api.balances(&account_id, true).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_historical_orders(account_id: String, since: String, next_token: Option<String>, state: State<'_, NativeState>) -> Result<HistoricalOrderPage, AppError> {
    state.api.historical_orders(&account_id, &since, next_token.as_deref()).await
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

fn decode_stream_values(buffer: &mut Vec<u8>, chunk: &[u8]) -> Result<Vec<Value>, AppError> {
    buffer.extend_from_slice(chunk);
    let mut values = Vec::new();
    loop {
        let whitespace = buffer
            .iter()
            .position(|byte| !byte.is_ascii_whitespace())
            .unwrap_or(buffer.len());
        if whitespace > 0 {
            buffer.drain(..whitespace);
        }
        if buffer.is_empty() {
            break;
        }
        let mut stream = serde_json::Deserializer::from_slice(buffer).into_iter::<Value>();
        match stream.next() {
            Some(Ok(value)) => {
                let used = stream.byte_offset();
                buffer.drain(..used);
                values.push(value);
            }
            Some(Err(error)) if error.is_eof() => break,
            Some(Err(error)) => return Err(AppError::Json(error)),
            None => break,
        }
    }
    Ok(values)
}

fn emit_stream_state(
    app: &tauri::AppHandle,
    subscription_id: &str,
    environment: &TradingEnvironment,
    channel: &str,
    state: &str,
    message: Option<String>,
) {
    let _ = app.emit(
        "stream-state",
        StreamStateEvent {
            subscription_id: subscription_id.into(),
            environment: environment.clone(),
            channel: channel.into(),
            state: state.into(),
            message,
        },
    );
}

async fn run_bar_stream(
    app: tauri::AppHandle,
    api: TradeStation,
    db_path: PathBuf,
    subscription_id: String,
    environment: TradingEnvironment,
    symbol: String,
    timeframe: String,
) {
    let mut attempt = 0u32;
    loop {
        emit_stream_state(
            &app,
            &subscription_id,
            &environment,
            "bars",
            if attempt == 0 {
                "connecting"
            } else {
                "reconnecting"
            },
            None,
        );
        let path = match TradeStation::bar_stream_path(&symbol, &timeframe) {
            Ok(path) => path,
            Err(error) => {
                emit_stream_state(
                    &app,
                    &subscription_id,
                    &environment,
                    "bars",
                    "disconnected",
                    Some(error.to_string()),
                );
                return;
            }
        };
        match api.open_stream(&path).await {
            Ok(response) => {
                attempt = 0;
                emit_stream_state(
                    &app,
                    &subscription_id,
                    &environment,
                    "bars",
                    "streaming",
                    None,
                );
                let mut bytes = response.bytes_stream();
                let mut buffer = Vec::new();
                let mut snapshot = Vec::new();
                let mut snapshot_complete = false;
                let mut go_away = false;
                while let Some(chunk) = bytes.next().await {
                    let chunk = match chunk {
                        Ok(chunk) => chunk,
                        Err(_) => break,
                    };
                    let values = match decode_stream_values(&mut buffer, &chunk) {
                        Ok(values) => values,
                        Err(_) => break,
                    };
                    for value in values {
                        match value.get("StreamStatus").and_then(Value::as_str) {
                            Some("EndSnapshot") => {
                                snapshot.sort_by_key(|bar: &Bar| bar.time);
                                snapshot.dedup_by_key(|bar| bar.time);
                                let _ = storage::save_bars(
                                    &db_path,
                                    environment.key(),
                                    &symbol,
                                    &timeframe,
                                    &snapshot,
                                );
                                let _ = app.emit(
                                    "bar-snapshot",
                                    BarSnapshotEvent {
                                        subscription_id: subscription_id.clone(),
                                        environment: environment.clone(),
                                        symbol: symbol.clone(),
                                        timeframe: timeframe.clone(),
                                        bars: snapshot.clone(),
                                    },
                                );
                                snapshot_complete = true;
                            }
                            Some("GoAway") => {
                                go_away = true;
                                break;
                            }
                            Some("ERROR") => {
                                go_away = true;
                                break;
                            }
                            _ => {
                                if let Some(bar) = tradestation::bar_from_value(&value, &timeframe)
                                {
                                    if snapshot_complete {
                                        let _ = storage::save_bars(
                                            &db_path,
                                            environment.key(),
                                            &symbol,
                                            &timeframe,
                                            std::slice::from_ref(&bar),
                                        );
                                        let _ = app.emit(
                                            "bar-update",
                                            BarUpdateEvent {
                                                subscription_id: subscription_id.clone(),
                                                environment: environment.clone(),
                                                symbol: symbol.clone(),
                                                timeframe: timeframe.clone(),
                                                bar,
                                            },
                                        );
                                    } else {
                                        snapshot.push(bar);
                                        if value
                                            .get("IsEndOfHistory")
                                            .and_then(Value::as_bool)
                                            .unwrap_or(false)
                                        {
                                            snapshot.sort_by_key(|bar| bar.time);
                                            snapshot.dedup_by_key(|bar| bar.time);
                                            let _ = storage::save_bars(
                                                &db_path,
                                                environment.key(),
                                                &symbol,
                                                &timeframe,
                                                &snapshot,
                                            );
                                            let _ = app.emit(
                                                "bar-snapshot",
                                                BarSnapshotEvent {
                                                    subscription_id: subscription_id.clone(),
                                                    environment: environment.clone(),
                                                    symbol: symbol.clone(),
                                                    timeframe: timeframe.clone(),
                                                    bars: snapshot.clone(),
                                                },
                                            );
                                            snapshot_complete = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if go_away {
                        break;
                    }
                }
                if !snapshot_complete && !snapshot.is_empty() {
                    snapshot.sort_by_key(|bar| bar.time);
                    snapshot.dedup_by_key(|bar| bar.time);
                    let _ = storage::save_bars(
                        &db_path,
                        environment.key(),
                        &symbol,
                        &timeframe,
                        &snapshot,
                    );
                    let _ = app.emit(
                        "bar-snapshot",
                        BarSnapshotEvent {
                            subscription_id: subscription_id.clone(),
                            environment: environment.clone(),
                            symbol: symbol.clone(),
                            timeframe: timeframe.clone(),
                            bars: snapshot,
                        },
                    );
                }
            }
            Err(error) => emit_stream_state(
                &app,
                &subscription_id,
                &environment,
                "bars",
                if error.to_string().contains("429") {
                    "rate-limited"
                } else {
                    "reconnecting"
                },
                Some(error.to_string()),
            ),
        }
        attempt = attempt.saturating_add(1);
        tokio::time::sleep(std::time::Duration::from_secs(
            (1u64 << attempt.min(5)).min(30),
        ))
        .await;
    }
}

async fn run_quote_stream(
    app: tauri::AppHandle,
    api: TradeStation,
    subscription_id: String,
    environment: TradingEnvironment,
    symbols: Vec<String>,
) {
    let path = format!("/marketdata/stream/quotes/{}", symbols.join(","));
    let mut attempt = 0u32;
    loop {
        emit_stream_state(
            &app,
            &subscription_id,
            &environment,
            "quotes",
            if attempt == 0 {
                "connecting"
            } else {
                "reconnecting"
            },
            None,
        );
        match api.open_stream(&path).await {
            Ok(response) => {
                attempt = 0;
                emit_stream_state(
                    &app,
                    &subscription_id,
                    &environment,
                    "quotes",
                    "streaming",
                    None,
                );
                let mut bytes = response.bytes_stream();
                let mut buffer = Vec::new();
                let mut go_away = false;
                while let Some(Ok(chunk)) = bytes.next().await {
                    let values = match decode_stream_values(&mut buffer, &chunk) {
                        Ok(values) => values,
                        Err(_) => break,
                    };
                    for value in values {
                        if matches!(
                            value.get("StreamStatus").and_then(Value::as_str),
                            Some("GoAway" | "ERROR")
                        ) {
                            go_away = true;
                            break;
                        }
                        if let Some(quote) = tradestation::quote_from_value(&value) {
                            let _ = app.emit(
                                "quote-update",
                                QuoteUpdateEvent {
                                    subscription_id: subscription_id.clone(),
                                    environment: environment.clone(),
                                    quote,
                                },
                            );
                        }
                    }
                    if go_away {
                        break;
                    }
                }
            }
            Err(error) => emit_stream_state(
                &app,
                &subscription_id,
                &environment,
                "quotes",
                if error.to_string().contains("429") {
                    "rate-limited"
                } else {
                    "reconnecting"
                },
                Some(error.to_string()),
            ),
        }
        attempt = attempt.saturating_add(1);
        tokio::time::sleep(std::time::Duration::from_secs(
            (1u64 << attempt.min(5)).min(30),
        ))
        .await;
    }
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
                bar_streams: tokio::sync::Mutex::new(HashMap::new()),
                quote_stream: tokio::sync::Mutex::new(None),
                brokerage_streams: tokio::sync::Mutex::new(Vec::new()),
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
            load_cached_bars,
            get_older_bars,
            start_bar_stream,
            stop_bar_stream,
            start_quote_stream,
            stop_quote_stream,
            start_brokerage_stream,
            stop_brokerage_stream,
            get_positions,
            get_orders,
            get_balances,
            get_bod_balances,
            get_historical_orders,
            confirm_order,
            place_order,
            cancel_order,
            load_workspace,
            save_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running Northstar Trader");
}

#[cfg(test)]
mod stream_tests {
    use super::*;

    #[test]
    fn decoder_preserves_fragmented_objects_and_reads_concatenated_values() {
        let mut buffer = Vec::new();
        assert!(decode_stream_values(&mut buffer, br#"{"Symbol":"MES""#)
            .unwrap()
            .is_empty());
        let values =
            decode_stream_values(&mut buffer, br#"}{"StreamStatus":"EndSnapshot"}"#).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["Symbol"], "MES");
        assert_eq!(values[1]["StreamStatus"], "EndSnapshot");
        assert!(buffer.is_empty());
    }

    #[test]
    fn history_targets_respect_minute_ceiling() {
        for timeframe in ["1m", "5m", "15m", "30m", "1h", "4h"] {
            let (interval, unit, count) = tradestation::history_spec(timeframe).unwrap();
            assert_eq!(unit, "Minute");
            assert!(interval * count <= 500_000);
            assert!(count <= 57_600);
        }
    }
}
