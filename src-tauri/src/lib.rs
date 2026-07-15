mod journal;
mod models;
mod storage;
mod tradestation;

use chrono::Utc;
use futures_util::StreamExt;
use models::*;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, RwLock},
};
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
    #[error(
        "TradeStation temporarily paused {resource} requests; retry in {retry_after_secs} seconds"
    )]
    RateLimited {
        resource: String,
        retry_after_secs: u64,
        concurrent: bool,
    },
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
    bar_streams: Arc<tokio::sync::Mutex<BarStreamRegistry>>,
    quote_stream: tokio::sync::Mutex<Option<(String, tauri::async_runtime::JoinHandle<()>)>>,
    brokerage_streams: tokio::sync::Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Default)]
struct BarStreamRegistry {
    streams: HashMap<String, SharedBarStream>,
    subscription_keys: HashMap<String, String>,
    subscription_generations: HashMap<String, u64>,
}

#[derive(Debug, Clone)]
struct BarSubscriber {
    consumer: String,
    generation: u64,
}

#[derive(Debug, Clone)]
struct SharedBarStreamStatus {
    state: String,
    message: Option<String>,
}

struct SharedBarStream {
    subscribers: Arc<RwLock<HashMap<String, BarSubscriber>>>,
    status: Arc<RwLock<SharedBarStreamStatus>>,
    latest_bars: Arc<RwLock<Vec<Bar>>>,
    task: tauri::async_runtime::JoinHandle<()>,
    cleanup_generation: u64,
}

impl BarStreamRegistry {
    fn accept_generation(&mut self, subscription_id: &str, generation: u64) -> bool {
        if self
            .subscription_generations
            .get(subscription_id)
            .is_some_and(|latest| generation < *latest)
        {
            return false;
        }
        self.subscription_generations
            .insert(subscription_id.to_string(), generation);
        true
    }
}

fn bar_stream_key(environment: &TradingEnvironment, symbol: &str, timeframe: &str) -> String {
    format!("{}\0{symbol}\0{timeframe}", environment.key())
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

#[tauri::command(rename_all = "camelCase")]
async fn get_symbol_details(
    symbol: String,
    state: State<'_, NativeState>,
) -> Result<SymbolMeta, AppError> {
    state.api.symbol_details(symbol.trim()).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_future_contracts(
    root: String,
    state: State<'_, NativeState>,
) -> Result<Vec<SymbolMeta>, AppError> {
    state.api.future_contracts(root.trim()).await
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
async fn load_cached_bar_range(
    symbol: String,
    timeframe: String,
    first: i64,
    last: i64,
    state: State<'_, NativeState>,
) -> Result<Vec<Bar>, AppError> {
    if timeframe != "1m" || first >= last {
        return Err(AppError::Validation(
            "VWAP bar ranges require a valid one-minute interval".into(),
        ));
    }
    let environment = state.api.environment().await;
    storage::load_bars_range(
        &state.db_path,
        environment.key(),
        &symbol,
        &timeframe,
        first,
        last,
    )
}

#[tauri::command(rename_all = "camelCase")]
async fn get_bar_range(
    symbol: String,
    timeframe: String,
    first: i64,
    last: i64,
    state: State<'_, NativeState>,
) -> Result<Vec<Bar>, AppError> {
    if timeframe != "1m" || first >= last {
        return Err(AppError::Validation(
            "VWAP bar ranges require a valid one-minute interval".into(),
        ));
    }
    let environment = state.api.environment().await;
    let bars = state
        .api
        .bars_range(&symbol, &timeframe, first, last)
        .await?;
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
    consumer: String,
    generation: u64,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    TradeStation::bar_stream_path(&symbol, &timeframe)?;
    if !matches!(consumer.as_str(), "chart" | "ema-alert" | "vwap") {
        return Err(AppError::Validation("Invalid bar stream consumer".into()));
    }
    let environment = state.api.environment().await;
    let key = bar_stream_key(&environment, &symbol, &timeframe);
    let retained_limit = tradestation::history_spec(&timeframe)
        .map(|(_, _, bars_back)| bars_back)
        .unwrap_or(10_000);
    let cached_bars = storage::load_bars(
        &state.db_path,
        environment.key(),
        &symbol,
        &timeframe,
        retained_limit,
    )
    .unwrap_or_default();
    let registry_handle = state.bar_streams.clone();
    let mut cleanup_keys = Vec::new();
    let mut late_replay: Option<(Arc<RwLock<SharedBarStreamStatus>>, Arc<RwLock<Vec<Bar>>>)> = None;
    {
        let mut registry = registry_handle.lock().await;
        if !registry.accept_generation(&subscription_id, generation) {
            return Ok(());
        }
        if let Some(previous_key) = registry.subscription_keys.get(&subscription_id).cloned() {
            if previous_key != key {
                if let Some(previous) = registry.streams.get_mut(&previous_key) {
                    if let Ok(mut subscribers) = previous.subscribers.write() {
                        subscribers.remove(&subscription_id);
                    }
                    previous.cleanup_generation = previous.cleanup_generation.wrapping_add(1);
                    cleanup_keys.push((previous_key, previous.cleanup_generation));
                }
            }
        }
        registry
            .subscription_keys
            .insert(subscription_id.clone(), key.clone());
        if let Some(shared) = registry.streams.get_mut(&key) {
            if let Ok(mut subscribers) = shared.subscribers.write() {
                subscribers.insert(
                    subscription_id.clone(),
                    BarSubscriber {
                        consumer,
                        generation,
                    },
                );
            }
            shared.cleanup_generation = shared.cleanup_generation.wrapping_add(1);
            late_replay = Some((shared.status.clone(), shared.latest_bars.clone()));
        } else {
            let subscribers = Arc::new(RwLock::new(HashMap::from([(
                subscription_id.clone(),
                BarSubscriber {
                    consumer,
                    generation,
                },
            )])));
            let status = Arc::new(RwLock::new(SharedBarStreamStatus {
                state: "connecting".into(),
                message: None,
            }));
            let latest_bars = Arc::new(RwLock::new(cached_bars));
            let task = tauri::async_runtime::spawn(run_bar_stream(
                app.clone(),
                state.api.clone(),
                state.db_path.clone(),
                subscribers.clone(),
                status.clone(),
                latest_bars.clone(),
                retained_limit,
                environment.clone(),
                symbol.clone(),
                timeframe.clone(),
            ));
            registry.streams.insert(
                key,
                SharedBarStream {
                    subscribers,
                    status,
                    latest_bars,
                    task,
                    cleanup_generation: 0,
                },
            );
        }
    }
    for (cleanup_key, generation) in cleanup_keys {
        schedule_bar_stream_cleanup(registry_handle.clone(), cleanup_key, generation);
    }
    if let Some((status, bars)) = late_replay {
        if let Ok(bars) = bars.read() {
            // Live updates take the write lock before emitting, so holding
            // this read lock keeps the bootstrap snapshot ahead of them.
            if !bars.is_empty() {
                emit_bar_snapshot_to(
                    &app,
                    &subscription_id,
                    &environment,
                    &symbol,
                    &timeframe,
                    generation,
                    &bars,
                );
            }
        }
        if let Ok(status) = status.read() {
            // Holding the status read lock guarantees that a concurrent state
            // transition is emitted after this late-subscriber replay.
            emit_stream_state(
                &app,
                &subscription_id,
                &environment,
                "bars",
                &status.state,
                status.message.clone(),
                Some(&symbol),
                Some(&timeframe),
                Some(generation),
            );
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn stop_bar_stream(
    subscription_id: String,
    generation: u64,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let registry_handle = state.bar_streams.clone();
    let cleanup = {
        let mut registry = registry_handle.lock().await;
        if !registry.accept_generation(&subscription_id, generation) {
            return Ok(());
        }
        let Some(key) = registry.subscription_keys.remove(&subscription_id) else {
            return Ok(());
        };
        registry.streams.get_mut(&key).map(|shared| {
            if let Ok(mut subscribers) = shared.subscribers.write() {
                subscribers.remove(&subscription_id);
            }
            shared.cleanup_generation = shared.cleanup_generation.wrapping_add(1);
            (key, shared.cleanup_generation)
        })
    };
    if let Some((key, generation)) = cleanup {
        schedule_bar_stream_cleanup(registry_handle, key, generation);
    }
    Ok(())
}

fn schedule_bar_stream_cleanup(
    registry: Arc<tokio::sync::Mutex<BarStreamRegistry>>,
    key: String,
    generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let mut registry = registry.lock().await;
        let should_remove = registry.streams.get(&key).is_some_and(|shared| {
            shared.cleanup_generation == generation
                && shared
                    .subscribers
                    .read()
                    .map(|subscribers| subscribers.is_empty())
                    .unwrap_or(true)
        });
        if should_remove {
            if let Some(shared) = registry.streams.remove(&key) {
                shared.task.abort();
            }
        }
    });
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
        return Err(AppError::Validation(
            "A maximum of 100 streamed quote symbols is supported".into(),
        ));
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
async fn stop_quote_stream(
    subscription_id: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let mut current = state.quote_stream.lock().await;
    if current
        .as_ref()
        .is_some_and(|(id, _)| id == &subscription_id)
    {
        if let Some((_, task)) = current.take() {
            task.abort();
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn start_brokerage_stream(
    app: tauri::AppHandle,
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let environment = state.api.environment().await;
    state
        .api
        .reset_brokerage_cache(&environment, &account_id)
        .await;
    let mut tasks = state.brokerage_streams.lock().await;
    for task in tasks.drain(..) {
        task.abort();
    }
    for channel in ["positions", "orders"] {
        tasks.push(tauri::async_runtime::spawn(run_brokerage_stream(
            app.clone(),
            state.api.clone(),
            account_id.clone(),
            channel.to_string(),
            environment.clone(),
            state.db_path.clone(),
        )));
    }
    Ok(())
}

#[tauri::command]
async fn stop_brokerage_stream(state: State<'_, NativeState>) -> Result<(), AppError> {
    for task in state.brokerage_streams.lock().await.drain(..) {
        task.abort();
    }
    state.api.clear_brokerage_cache().await;
    Ok(())
}

async fn run_brokerage_stream(
    app: tauri::AppHandle,
    api: TradeStation,
    account_id: String,
    channel: String,
    environment: TradingEnvironment,
    db_path: PathBuf,
) {
    let path = if channel == "positions" {
        format!("/brokerage/stream/accounts/{account_id}/{channel}?changes=true")
    } else {
        format!("/brokerage/stream/accounts/{account_id}/{channel}")
    };
    if channel == "orders" && journal::auth_status(&db_path).is_ok_and(|status| status.configured) {
        if let Ok(status) = journal::sync_cloud(&db_path).await {
            let _ = app.emit(
                "journal-updated",
                serde_json::json!({"reason":"stream-start-cloud-sync","status":status}),
            );
        }
    }
    let mut attempt = 0u32;
    loop {
        let connecting_state = if attempt == 0 {
            "connecting"
        } else {
            "reconnecting"
        };
        api.set_brokerage_stream_state(&environment, &account_id, &channel, connecting_state)
            .await;
        emit_brokerage_stream_state(&app, &account_id, &channel, connecting_state, None);
        let connected_at = std::time::Instant::now();
        let mut retry_delay = None;
        match api
            .open_stream(&path, tradestation::RequestPriority::Realtime)
            .await
        {
            Ok(response) => {
                api.set_brokerage_stream_state(&environment, &account_id, &channel, "streaming")
                    .await;
                emit_brokerage_stream_state(&app, &account_id, &channel, "streaming", None);
                let mut bytes = response.bytes_stream();
                let mut buffer = Vec::new();
                let mut position_records = HashMap::<String, Value>::new();
                let mut order_records = HashMap::<String, Value>::new();
                let mut snapshot_complete = false;
                let mut go_away = false;
                while let Some(Ok(chunk)) = bytes.next().await {
                    let values = match decode_stream_values(&mut buffer, &chunk) {
                        Ok(values) => values,
                        Err(_) => break,
                    };
                    for data in values {
                        match data.get("StreamStatus").and_then(Value::as_str) {
                            Some("EndSnapshot") => {
                                if channel == "positions" {
                                    let positions: Vec<_> = position_records
                                        .values()
                                        .map(tradestation::position_from_value)
                                        .collect();
                                    api.apply_positions_snapshot(
                                        &environment,
                                        &account_id,
                                        &positions,
                                    )
                                    .await;
                                    let _ = app.emit(
                                        "positions-snapshot",
                                        PositionsSnapshotEvent {
                                            account_id: account_id.clone(),
                                            positions,
                                        },
                                    );
                                } else {
                                    let orders: Vec<_> = order_records
                                        .values()
                                        .map(|value| {
                                            let mut order = tradestation::order_from_value(value);
                                            order.account_id = Some(account_id.clone());
                                            order
                                        })
                                        .collect();
                                    api.apply_orders_snapshot(&environment, &account_id, &orders)
                                        .await;
                                    let _ = capture_journal_orders(
                                        &app,
                                        &api,
                                        &db_path,
                                        &environment,
                                        &orders,
                                        "broker-stream",
                                    )
                                    .await;
                                    let _ = app.emit(
                                        "orders-snapshot",
                                        OrdersSnapshotEvent {
                                            account_id: account_id.clone(),
                                            orders,
                                        },
                                    );
                                }
                                snapshot_complete = true;
                                continue;
                            }
                            Some("GoAway" | "ERROR") => {
                                go_away = true;
                                break;
                            }
                            Some(_) => continue,
                            None => {}
                        }
                        if channel == "positions" {
                            let position_id = data
                                .get("PositionID")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if position_id.is_empty() {
                                continue;
                            }
                            let record = position_records
                                .entry(position_id)
                                .or_insert_with(|| Value::Object(Default::default()));
                            merge_stream_record(record, &data);
                            if snapshot_complete {
                                let position = tradestation::position_from_value(record);
                                if position.symbol.is_empty() {
                                    continue;
                                }
                                api.apply_position_update(&environment, &account_id, &position)
                                    .await;
                                let _ = app.emit(
                                    "position-update",
                                    PositionUpdateEvent {
                                        account_id: account_id.clone(),
                                        position,
                                    },
                                );
                            }
                        } else {
                            let order_id = data
                                .get("OrderID")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if order_id.is_empty() {
                                continue;
                            }
                            let record = order_records
                                .entry(order_id)
                                .or_insert_with(|| Value::Object(Default::default()));
                            merge_stream_record(record, &data);
                            if snapshot_complete {
                                let mut order = tradestation::order_from_value(record);
                                order.account_id = Some(account_id.clone());
                                if order.symbol.is_empty() {
                                    continue;
                                }
                                api.apply_order_update(&environment, &account_id, &order)
                                    .await;
                                let _ = capture_journal_orders(
                                    &app,
                                    &api,
                                    &db_path,
                                    &environment,
                                    std::slice::from_ref(&order),
                                    "broker-stream",
                                )
                                .await;
                                if order.status == "Filled" {
                                    tracing::debug!(
                                        account = %account_id.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>(),
                                        order_id = %order.id,
                                        symbol = %order.symbol,
                                        "Received brokerage order fill"
                                    );
                                }
                                let _ = app.emit(
                                    "order-stream-update",
                                    OrderStreamUpdateEvent {
                                        account_id: account_id.clone(),
                                        order,
                                    },
                                );
                            }
                        }
                    }
                    if go_away {
                        break;
                    }
                }
                if !snapshot_complete {
                    if channel == "positions" && !position_records.is_empty() {
                        let positions: Vec<_> = position_records
                            .values()
                            .map(tradestation::position_from_value)
                            .filter(|position| !position.symbol.is_empty())
                            .collect();
                        api.apply_positions_snapshot(&environment, &account_id, &positions)
                            .await;
                        let _ = app.emit(
                            "positions-snapshot",
                            PositionsSnapshotEvent {
                                account_id: account_id.clone(),
                                positions,
                            },
                        );
                    } else if channel == "orders" && !order_records.is_empty() {
                        let orders: Vec<_> = order_records
                            .values()
                            .map(|value| {
                                let mut order = tradestation::order_from_value(value);
                                order.account_id = Some(account_id.clone());
                                order
                            })
                            .filter(|order| !order.symbol.is_empty())
                            .collect();
                        api.apply_orders_snapshot(&environment, &account_id, &orders)
                            .await;
                        let _ = capture_journal_orders(
                            &app,
                            &api,
                            &db_path,
                            &environment,
                            &orders,
                            "broker-stream",
                        )
                        .await;
                        let _ = app.emit(
                            "orders-snapshot",
                            OrdersSnapshotEvent {
                                account_id: account_id.clone(),
                                orders,
                            },
                        );
                    }
                }
                api.set_brokerage_stream_state(&environment, &account_id, &channel, "reconnecting")
                    .await;
                emit_brokerage_stream_state(
                    &app,
                    &account_id,
                    &channel,
                    "reconnecting",
                    Some("TradeStation ended the stream; reconnecting".into()),
                );
                if connected_at.elapsed() >= std::time::Duration::from_secs(30) {
                    attempt = 0;
                }
            }
            Err(error) => {
                let message = error.to_string();
                // Some TradeStation account/environment combinations do not permit
                // brokerage streams. The UI's snapshot polling remains authoritative.
                if message.contains("403") || message.to_ascii_lowercase().contains("forbidden") {
                    api.set_brokerage_stream_state(
                        &environment,
                        &account_id,
                        &channel,
                        "disconnected",
                    )
                    .await;
                    emit_brokerage_stream_state(
                        &app,
                        &account_id,
                        &channel,
                        "disconnected",
                        Some(message),
                    );
                    break;
                }
                let rate_limited = matches!(error, AppError::RateLimited { .. });
                if rate_limited {
                    retry_delay = Some(tradestation::rate_limit_delay(&error));
                }
                let recovery_state = if rate_limited {
                    "rate-limited"
                } else {
                    "reconnecting"
                };
                api.set_brokerage_stream_state(&environment, &account_id, &channel, recovery_state)
                    .await;
                emit_brokerage_stream_state(
                    &app,
                    &account_id,
                    &channel,
                    recovery_state,
                    Some(message),
                );
            }
        }
        attempt = attempt.saturating_add(1);
        let backoff = std::time::Duration::from_secs(
            (1u64 << attempt.min(5)).min(30) + u64::from(attempt % 3),
        );
        tokio::time::sleep(retry_delay.unwrap_or(backoff)).await;
    }
}

/// TradeStation position streams use sparse patches when `changes=true`.
/// Orders may also omit unchanged nested leg fields, so recursively retain the
/// last complete record before converting a stream value into a typed model.
fn merge_stream_record(current: &mut Value, incoming: &Value) {
    match (current, incoming) {
        (Value::Object(current), Value::Object(incoming)) => {
            for (key, value) in incoming {
                if let Some(existing) = current.get_mut(key) {
                    merge_stream_record(existing, value);
                } else {
                    current.insert(key.clone(), value.clone());
                }
            }
        }
        (Value::Array(current), Value::Array(incoming)) => {
            for (index, value) in incoming.iter().enumerate() {
                if let Some(existing) = current.get_mut(index) {
                    merge_stream_record(existing, value);
                } else {
                    current.push(value.clone());
                }
            }
        }
        (current, incoming) => *current = incoming.clone(),
    }
}

fn emit_brokerage_stream_state(
    app: &tauri::AppHandle,
    account_id: &str,
    channel: &str,
    state: &str,
    message: Option<String>,
) {
    let _ = app.emit(
        "brokerage-stream-state",
        BrokerageStreamStateEvent {
            account_id: account_id.into(),
            channel: channel.into(),
            state: state.into(),
            message,
        },
    );
}

#[tauri::command(rename_all = "camelCase")]
async fn get_positions(
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<Vec<Position>, AppError> {
    state.api.positions(&account_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_orders(
    account_id: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<Vec<OrderUpdate>, AppError> {
    let environment = state.api.environment().await;
    let mut orders = state.api.orders(&account_id).await?;
    for order in &mut orders {
        order.account_id = Some(account_id.clone());
    }
    capture_journal_orders(
        &app,
        &state.api,
        &state.db_path,
        &environment,
        &orders,
        "broker-stream",
    )
    .await?;
    Ok(orders)
}

#[tauri::command(rename_all = "camelCase")]
async fn get_balances(
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<Vec<AccountBalance>, AppError> {
    state.api.balances(&account_id, false).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_bod_balances(
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<Vec<AccountBalance>, AppError> {
    state.api.balances(&account_id, true).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_historical_orders(
    account_id: String,
    since: String,
    next_token: Option<String>,
    state: State<'_, NativeState>,
) -> Result<HistoricalOrderPage, AppError> {
    state
        .api
        .historical_orders(&account_id, &since, next_token.as_deref())
        .await
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
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<OrderUpdate, AppError> {
    let environment = state.api.environment().await;
    let meta = state.api.symbol_details(&order.symbol).await?;
    let intent = journal::start_entry_intent(&state.db_path, &environment, &order, &meta)?;
    match state.api.place_order(&order).await {
        Ok(update) => {
            journal::complete_entry_intent(&state.db_path, &intent, &update)?;
            let _ = app.emit(
                "journal-updated",
                serde_json::json!({"reason":"entry-intent"}),
            );
            schedule_journal_flush(app.clone(), state.db_path.clone());
            Ok(update)
        }
        Err(error) => {
            let _ = journal::fail_entry_intent(&state.db_path, &intent, &error.to_string());
            let _ = app.emit(
                "journal-updated",
                serde_json::json!({"reason":"entry-rejected"}),
            );
            schedule_journal_flush(app, state.db_path.clone());
            Err(error)
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn replace_order(
    account_id: String,
    order_id: String,
    new_price: f64,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<OrderUpdate, AppError> {
    let environment = state.api.environment().await;
    let original = state
        .api
        .orders(&account_id)
        .await
        .ok()
        .and_then(|orders| orders.into_iter().find(|order| order.id == order_id));
    let old_price = original
        .as_ref()
        .and_then(|order| order.price.or(order.stop_price));
    if let Some(order) = original.as_ref() {
        journal::record_order_move(
            &state.db_path,
            &environment,
            &account_id,
            order,
            old_price,
            new_price,
            "requested",
            Some("Protective replacement submitted"),
        )?;
    }
    match state
        .api
        .replace_order(&account_id, &order_id, new_price)
        .await
    {
        Ok(update) => {
            let confirmed_price = update.price.or(update.stop_price).unwrap_or(new_price);
            journal::record_order_move(
                &state.db_path,
                &environment,
                &account_id,
                &update,
                old_price,
                confirmed_price,
                "confirmed",
                None,
            )?;
            let _ = app.emit(
                "journal-updated",
                serde_json::json!({"reason":"protective-order-moved"}),
            );
            schedule_journal_flush(app.clone(), state.db_path.clone());
            Ok(update)
        }
        Err(error) => {
            if let Some(order) = original.as_ref() {
                let _ = journal::record_order_move(
                    &state.db_path,
                    &environment,
                    &account_id,
                    order,
                    old_price,
                    new_price,
                    "failed",
                    Some(&error.to_string()),
                );
            }
            let _ = app.emit(
                "journal-updated",
                serde_json::json!({"reason":"protective-order-move-failed"}),
            );
            schedule_journal_flush(app, state.db_path.clone());
            Err(error)
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn close_position(
    account_id: String,
    position_id: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<ClosePositionResult, AppError> {
    let environment = state.api.environment().await;
    let symbol = state
        .api
        .positions(&account_id)
        .await
        .ok()
        .and_then(|positions| {
            positions
                .into_iter()
                .find(|position| position.id == position_id)
        })
        .map(|position| position.symbol);
    if let Some(symbol) = symbol.as_deref() {
        let _ = journal::record_close_intent(
            &state.db_path,
            &environment,
            &account_id,
            symbol,
            "requested",
            None,
        );
    }
    let result = state.api.close_position(&account_id, &position_id).await;
    if let Ok(value) = result.as_ref() {
        let _ = journal::record_close_intent(
            &state.db_path,
            &environment,
            &account_id,
            &value.symbol,
            if value.error.is_some() {
                "failed"
            } else {
                "confirmed"
            },
            value.error.as_deref(),
        );
    }
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"close-position"}),
    );
    schedule_journal_flush(app, state.db_path.clone());
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn cancel_order(
    order_id: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let environment = state.api.environment().await;
    journal::record_cancel_intent(&state.db_path, &environment, &order_id, "requested", None)?;
    match state.api.cancel_order(&order_id).await {
        Ok(()) => {
            journal::record_cancel_intent(
                &state.db_path,
                &environment,
                &order_id,
                "confirmed",
                None,
            )?;
            let _ = app.emit(
                "journal-updated",
                serde_json::json!({"reason":"order-cancelled"}),
            );
            schedule_journal_flush(app, state.db_path.clone());
            Ok(())
        }
        Err(error) => {
            let _ = journal::record_cancel_intent(
                &state.db_path,
                &environment,
                &order_id,
                "failed",
                Some(&error.to_string()),
            );
            let _ = app.emit(
                "journal-updated",
                serde_json::json!({"reason":"order-cancel-failed"}),
            );
            schedule_journal_flush(app, state.db_path.clone());
            Err(error)
        }
    }
}

#[tauri::command]
fn load_workspace(state: State<'_, NativeState>) -> Result<Option<Value>, AppError> {
    storage::load_workspace(&state.db_path)
}

#[tauri::command]
fn save_workspace(workspace: Value, state: State<'_, NativeState>) -> Result<(), AppError> {
    storage::save_workspace(&state.db_path, &workspace)
}

fn schedule_journal_flush(app: tauri::AppHandle, path: PathBuf) {
    if !journal::auth_status(&path).is_ok_and(|status| status.configured) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        for attempt in 0..4u32 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(1u64 << attempt)).await;
            }
            match journal::sync_cloud(&path).await {
                Ok(status) if status.state == "syncing" => continue,
                Ok(status) => {
                    let _ = app.emit(
                        "journal-updated",
                        serde_json::json!({"reason":"outbox-flushed","status":status}),
                    );
                    return;
                }
                Err(error) if attempt == 3 => {
                    let _ = app.emit("journal-sync-error", error.to_string());
                }
                Err(_) => {}
            }
        }
    });
}

#[tauri::command]
fn journal_auth_status(
    state: State<'_, NativeState>,
) -> Result<journal::JournalAuthStatus, AppError> {
    journal::auth_status(&state.db_path)
}

#[tauri::command]
async fn configure_journal(
    input: journal::JournalConnectionInput,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<journal::JournalAuthStatus, AppError> {
    let result = journal::configure(&state.db_path, input).await?;
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"cloud-configured"}),
    );
    Ok(result)
}

#[tauri::command]
fn disconnect_journal(state: State<'_, NativeState>) -> Result<(), AppError> {
    journal::disconnect(&state.db_path)
}

#[tauri::command(rename_all = "camelCase")]
fn set_journal_backfill_start(
    backfill_start: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    journal::set_backfill(&state.db_path, &backfill_start)
}

#[tauri::command(rename_all = "camelCase")]
fn set_journal_commission(
    commission_per_contract_side: f64,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    journal::set_commission_per_contract_side(&state.db_path, commission_per_contract_side)?;
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"commission-updated"}),
    );
    schedule_journal_flush(app, state.db_path.clone());
    Ok(())
}

async fn ingest_orders_with_metadata(
    api: &TradeStation,
    db_path: &std::path::Path,
    environment: &TradingEnvironment,
    orders: &[OrderUpdate],
    source: &str,
) -> Result<journal::JournalIngestResult, AppError> {
    journal::repair_misclassified_close_campaigns(db_path, environment, orders)?;
    let symbols: std::collections::HashSet<_> = orders
        .iter()
        .map(|order| order.symbol.clone())
        .filter(|symbol| !symbol.is_empty())
        .collect();
    let mut point_values = HashMap::new();
    for symbol in symbols {
        if let Ok(meta) = api.symbol_details(&symbol).await {
            point_values.insert(symbol, meta.point_value);
        }
    }
    journal::ingest_orders(db_path, environment, orders, source, &point_values)
}

async fn reconcile_unmatched_closes(
    api: &TradeStation,
    db_path: &std::path::Path,
    environment: &TradingEnvironment,
    unmatched: &[OrderUpdate],
) -> Result<(), AppError> {
    if unmatched.is_empty() {
        return Ok(());
    }

    if journal::auth_status(db_path).is_ok_and(|status| status.configured) {
        let _ = journal::sync_cloud(db_path).await;
    }

    let mut needs_history: HashMap<String, Vec<OrderUpdate>> = HashMap::new();
    for order in unmatched {
        let account_id = order.account_id.clone().unwrap_or_default();
        if account_id.is_empty() {
            continue;
        }
        if journal::has_active_trade(db_path, environment, &account_id, &order.symbol)? {
            let _ = ingest_orders_with_metadata(
                api,
                db_path,
                environment,
                std::slice::from_ref(order),
                "broker-stream",
            )
            .await?;
        } else {
            needs_history
                .entry(account_id)
                .or_default()
                .push(order.clone());
        }
    }

    let configured_start = journal::auth_status(db_path)
        .ok()
        .and_then(|status| status.backfill_start);
    for (account_id, closing_orders) in needs_history {
        let since = configured_start.clone().unwrap_or_else(|| {
            (Utc::now() - chrono::Duration::days(90))
                .format("%Y-%m-%d")
                .to_string()
        });
        let mut token = None;
        let mut historical_orders = Vec::new();
        loop {
            let page = api
                .historical_orders(&account_id, &since, token.as_deref())
                .await?;
            let mut orders = page.orders;
            for order in &mut orders {
                order.account_id = Some(account_id.clone());
            }
            historical_orders.extend(orders);
            token = page.next_token;
            if token.is_none() {
                break;
            }
        }
        let _ = ingest_orders_with_metadata(
            api,
            db_path,
            environment,
            &historical_orders,
            "broker-history",
        )
        .await?;
        let _ = ingest_orders_with_metadata(
            api,
            db_path,
            environment,
            &closing_orders,
            "broker-stream",
        )
        .await?;
    }
    Ok(())
}

async fn capture_journal_orders(
    app: &tauri::AppHandle,
    api: &TradeStation,
    db_path: &std::path::Path,
    environment: &TradingEnvironment,
    orders: &[OrderUpdate],
    source: &str,
) -> Result<(), AppError> {
    if orders.is_empty() {
        return Ok(());
    }
    let result = ingest_orders_with_metadata(api, db_path, environment, orders, source).await?;
    let needs_reconciliation = !result.unmatched_closes.is_empty();
    if needs_reconciliation {
        reconcile_unmatched_closes(api, db_path, environment, &result.unmatched_closes).await?;
    }
    if result.fills > 0 || needs_reconciliation || source == "broker-stream" {
        let _ = app.emit(
            "journal-updated",
            serde_json::json!({"reason": if needs_reconciliation { "close-reconciled" } else if result.fills > 0 { "broker-fill" } else { "broker-order-observed" }}),
        );
        schedule_journal_flush(app.clone(), db_path.to_path_buf());
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn ingest_journal_orders(
    environment: TradingEnvironment,
    orders: Vec<OrderUpdate>,
    source: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    capture_journal_orders(
        &app,
        &state.api,
        &state.db_path,
        &environment,
        &orders,
        &source,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn sync_journal(
    scope: Option<journal::JournalScope>,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<journal::JournalSyncStatus, AppError> {
    let auth = journal::auth_status(&state.db_path)?;
    let backfill_start = auth
        .backfill_start
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());
    let environment = state.api.environment().await;
    let accounts = state.api.accounts().await?;
    for account in accounts.into_iter().filter(|account| {
        account.account_type.eq_ignore_ascii_case("futures")
            && scope.as_ref().is_none_or(|selected| {
                selected.account_id == account.id && selected.environment == environment
            })
    }) {
        let since = journal::reconciliation_since(
            &state.db_path,
            &environment,
            &account.id,
            &backfill_start,
        )?;
        let mut token = None;
        let mut historical_orders = Vec::new();
        loop {
            let mut page = state
                .api
                .historical_orders(&account.id, &since, token.as_deref())
                .await?;
            for order in &mut page.orders {
                order.account_id = Some(account.id.clone());
            }
            historical_orders.extend(page.orders);
            token = page.next_token;
            if token.is_none() {
                break;
            }
        }
        ingest_orders_with_metadata(
            &state.api,
            &state.db_path,
            &environment,
            &historical_orders,
            "broker-history",
        )
        .await?;
        journal::set_reconciliation_checkpoint(&state.db_path, &environment, &account.id)?;
    }
    let result = journal::sync_cloud(&state.db_path).await?;
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"cloud-sync"}),
    );
    Ok(result)
}

#[tauri::command]
fn get_journal_scopes(
    state: State<'_, NativeState>,
) -> Result<Vec<journal::JournalScope>, AppError> {
    journal::scopes(&state.db_path)
}

#[tauri::command(rename_all = "camelCase")]
fn get_journal_month(
    scope: journal::JournalScope,
    year: i32,
    month: u32,
    state: State<'_, NativeState>,
) -> Result<journal::JournalMonthSummary, AppError> {
    journal::month(&state.db_path, scope, year, month)
}

#[tauri::command(rename_all = "camelCase")]
fn get_journal_day(
    scope: journal::JournalScope,
    date: String,
    state: State<'_, NativeState>,
) -> Result<journal::JournalDaySummary, AppError> {
    journal::day(&state.db_path, scope, &date)
}

#[tauri::command(rename_all = "camelCase")]
fn get_journal_trade(
    trade_id: String,
    state: State<'_, NativeState>,
) -> Result<journal::JournalTrade, AppError> {
    journal::trade(&state.db_path, &trade_id)
}

#[tauri::command(rename_all = "camelCase")]
async fn update_journal_annotation(
    trade_id: String,
    notes: String,
    tags: Vec<String>,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    journal::update_annotation(&state.db_path, &trade_id, &notes, &tags)?;
    if journal::auth_status(&state.db_path)?.configured {
        schedule_journal_flush(app.clone(), state.db_path.clone());
    }
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"annotation"}),
    );
    Ok(())
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
    symbol: Option<&str>,
    timeframe: Option<&str>,
    generation: Option<u64>,
) {
    let _ = app.emit(
        "stream-state",
        StreamStateEvent {
            subscription_id: subscription_id.into(),
            environment: environment.clone(),
            channel: channel.into(),
            state: state.into(),
            message,
            symbol: symbol.map(str::to_owned),
            timeframe: timeframe.map(str::to_owned),
            generation,
        },
    );
}

fn bar_subscribers(
    subscribers: &Arc<RwLock<HashMap<String, BarSubscriber>>>,
) -> Vec<(String, BarSubscriber)> {
    subscribers
        .read()
        .map(|subscribers| {
            subscribers
                .iter()
                .map(|(id, subscriber)| (id.clone(), subscriber.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn bar_stream_priority(
    subscribers: &Arc<RwLock<HashMap<String, BarSubscriber>>>,
) -> tradestation::RequestPriority {
    if subscribers
        .read()
        .map(|subscribers| {
            subscribers
                .values()
                .any(|subscriber| subscriber.consumer == "chart")
        })
        .unwrap_or(false)
    {
        tradestation::RequestPriority::Realtime
    } else {
        tradestation::RequestPriority::Background
    }
}

fn emit_shared_stream_state(
    app: &tauri::AppHandle,
    subscribers: &Arc<RwLock<HashMap<String, BarSubscriber>>>,
    status: &Arc<RwLock<SharedBarStreamStatus>>,
    environment: &TradingEnvironment,
    symbol: &str,
    timeframe: &str,
    state: &str,
    message: Option<String>,
) {
    if let Ok(mut current) = status.write() {
        current.state = state.into();
        current.message = message.clone();
    }
    for (subscription_id, subscriber) in bar_subscribers(subscribers) {
        emit_stream_state(
            app,
            &subscription_id,
            environment,
            "bars",
            state,
            message.clone(),
            Some(symbol),
            Some(timeframe),
            Some(subscriber.generation),
        );
    }
}

fn emit_bar_snapshot(
    app: &tauri::AppHandle,
    subscribers: &Arc<RwLock<HashMap<String, BarSubscriber>>>,
    environment: &TradingEnvironment,
    symbol: &str,
    timeframe: &str,
    bars: &[Bar],
) {
    for (subscription_id, subscriber) in bar_subscribers(subscribers) {
        emit_bar_snapshot_to(
            app,
            &subscription_id,
            environment,
            symbol,
            timeframe,
            subscriber.generation,
            bars,
        );
    }
}

fn emit_bar_snapshot_to(
    app: &tauri::AppHandle,
    subscription_id: &str,
    environment: &TradingEnvironment,
    symbol: &str,
    timeframe: &str,
    generation: u64,
    bars: &[Bar],
) {
    let _ = app.emit(
        "bar-snapshot",
        BarSnapshotEvent {
            subscription_id: subscription_id.into(),
            environment: environment.clone(),
            symbol: symbol.into(),
            timeframe: timeframe.into(),
            generation,
            bars: bars.to_vec(),
        },
    );
}

fn merge_retained_bars(retained: &mut Vec<Bar>, incoming: &[Bar], limit: usize) {
    for bar in incoming {
        match retained.binary_search_by_key(&bar.time, |item| item.time) {
            Ok(index) => retained[index] = bar.clone(),
            Err(index) => retained.insert(index, bar.clone()),
        }
    }
    if retained.len() > limit {
        retained.drain(..retained.len() - limit);
    }
}

fn retain_bar_snapshot(
    latest_bars: &Arc<RwLock<Vec<Bar>>>,
    incoming: &[Bar],
    limit: usize,
) -> Vec<Bar> {
    latest_bars
        .write()
        .map(|mut retained| {
            merge_retained_bars(&mut retained, incoming, limit);
            retained.clone()
        })
        .unwrap_or_else(|_| incoming.to_vec())
}

fn emit_bar_update(
    app: &tauri::AppHandle,
    subscribers: &Arc<RwLock<HashMap<String, BarSubscriber>>>,
    environment: &TradingEnvironment,
    symbol: &str,
    timeframe: &str,
    bar: &Bar,
) {
    for (subscription_id, subscriber) in bar_subscribers(subscribers) {
        let _ = app.emit(
            "bar-update",
            BarUpdateEvent {
                subscription_id,
                environment: environment.clone(),
                symbol: symbol.into(),
                timeframe: timeframe.into(),
                generation: subscriber.generation,
                bar: bar.clone(),
            },
        );
    }
}

fn stream_bars_back(
    db_path: &std::path::Path,
    environment: &TradingEnvironment,
    symbol: &str,
    timeframe: &str,
) -> usize {
    let Ok((interval, unit, configured)) = tradestation::history_spec(timeframe) else {
        return 1;
    };
    let Ok(cached) = storage::load_bars(db_path, environment.key(), symbol, timeframe, configured)
    else {
        return configured;
    };
    if cached.len() < configured {
        return configured;
    }
    let Some(last) = cached.last() else {
        return configured;
    };
    let seconds = match unit {
        "Minute" => interval.saturating_mul(60),
        "Daily" => 86_400,
        "Weekly" => 7 * 86_400,
        "Monthly" => 28 * 86_400,
        _ => return configured,
    } as i64;
    if seconds <= 0 {
        return configured;
    }
    reconnect_bars_back(
        cached.len(),
        last.time,
        chrono::Utc::now().timestamp(),
        seconds,
        configured,
    )
}

fn reconnect_bars_back(
    cached_count: usize,
    last_time: i64,
    now: i64,
    interval_seconds: i64,
    configured: usize,
) -> usize {
    if cached_count < configured || interval_seconds <= 0 {
        return configured;
    }
    let gap = now.saturating_sub(last_time);
    let missing = gap
        .saturating_add(interval_seconds - 1)
        .checked_div(interval_seconds)
        .unwrap_or(configured as i64)
        .saturating_add(2);
    usize::try_from(missing)
        .unwrap_or(configured)
        .clamp(2, configured)
}

fn stream_provider_error(value: &Value) -> Option<String> {
    let error = value.get("Error").and_then(Value::as_str);
    let message = value.get("Message").and_then(Value::as_str);
    match (error, message) {
        (Some(error), Some(message)) => Some(format!("TradeStation {error}: {message}")),
        (Some(error), None) => Some(format!("TradeStation stream error: {error}")),
        (None, Some(message)) => Some(format!("TradeStation stream error: {message}")),
        (None, None) => None,
    }
}

async fn run_bar_stream(
    app: tauri::AppHandle,
    api: TradeStation,
    db_path: PathBuf,
    subscribers: Arc<RwLock<HashMap<String, BarSubscriber>>>,
    status: Arc<RwLock<SharedBarStreamStatus>>,
    latest_bars: Arc<RwLock<Vec<Bar>>>,
    retained_limit: usize,
    environment: TradingEnvironment,
    symbol: String,
    timeframe: String,
) {
    let mut attempt = 0u32;
    loop {
        emit_shared_stream_state(
            &app,
            &subscribers,
            &status,
            &environment,
            &symbol,
            &timeframe,
            if attempt == 0 {
                "connecting"
            } else {
                "reconnecting"
            },
            None,
        );
        let bars_back = stream_bars_back(&db_path, &environment, &symbol, &timeframe);
        let path =
            match TradeStation::bar_stream_path_with_bars_back(&symbol, &timeframe, bars_back) {
                Ok(path) => path,
                Err(error) => {
                    emit_shared_stream_state(
                        &app,
                        &subscribers,
                        &status,
                        &environment,
                        &symbol,
                        &timeframe,
                        "disconnected",
                        Some(error.to_string()),
                    );
                    return;
                }
            };
        let mut retry_delay = None;
        let connected_at = std::time::Instant::now();
        match api
            .open_stream(&path, bar_stream_priority(&subscribers))
            .await
        {
            Ok(response) => {
                emit_shared_stream_state(
                    &app,
                    &subscribers,
                    &status,
                    &environment,
                    &symbol,
                    &timeframe,
                    "streaming",
                    None,
                );
                let mut bytes = response.bytes_stream();
                let mut buffer = Vec::new();
                let mut snapshot = Vec::new();
                let mut snapshot_complete = false;
                let mut terminate_stream = false;
                let mut termination_message = None;
                while let Some(chunk) = bytes.next().await {
                    let chunk = match chunk {
                        Ok(chunk) => chunk,
                        Err(error) => {
                            termination_message =
                                Some(format!("TradeStation bar stream transport error: {error}"));
                            break;
                        }
                    };
                    let values = match decode_stream_values(&mut buffer, &chunk) {
                        Ok(values) => values,
                        Err(error) => {
                            termination_message = Some(format!(
                                "TradeStation bar stream returned invalid data: {error}"
                            ));
                            break;
                        }
                    };
                    for value in values {
                        if terminate_stream {
                            if let Some(message) = stream_provider_error(&value) {
                                termination_message = Some(message);
                            }
                            continue;
                        }
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
                                let retained =
                                    retain_bar_snapshot(&latest_bars, &snapshot, retained_limit);
                                emit_bar_snapshot(
                                    &app,
                                    &subscribers,
                                    &environment,
                                    &symbol,
                                    &timeframe,
                                    &retained,
                                );
                                snapshot_complete = true;
                            }
                            Some("GoAway") => {
                                terminate_stream = true;
                                termination_message = Some(
                                    "TradeStation requested a stream restart; reconnecting".into(),
                                );
                            }
                            Some("ERROR") => {
                                terminate_stream = true;
                                termination_message = stream_provider_error(&value).or_else(|| {
                                    Some(
                                        "TradeStation reported a bar stream error; reconnecting"
                                            .into(),
                                    )
                                });
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
                                        let _ = retain_bar_snapshot(
                                            &latest_bars,
                                            std::slice::from_ref(&bar),
                                            retained_limit,
                                        );
                                        emit_bar_update(
                                            &app,
                                            &subscribers,
                                            &environment,
                                            &symbol,
                                            &timeframe,
                                            &bar,
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
                                            let retained = retain_bar_snapshot(
                                                &latest_bars,
                                                &snapshot,
                                                retained_limit,
                                            );
                                            emit_bar_snapshot(
                                                &app,
                                                &subscribers,
                                                &environment,
                                                &symbol,
                                                &timeframe,
                                                &retained,
                                            );
                                            snapshot_complete = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if terminate_stream {
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
                    let retained = retain_bar_snapshot(&latest_bars, &snapshot, retained_limit);
                    emit_bar_snapshot(
                        &app,
                        &subscribers,
                        &environment,
                        &symbol,
                        &timeframe,
                        &retained,
                    );
                }
                emit_shared_stream_state(
                    &app,
                    &subscribers,
                    &status,
                    &environment,
                    &symbol,
                    &timeframe,
                    "reconnecting",
                    termination_message
                        .or_else(|| Some("TradeStation ended the bar stream; reconnecting".into())),
                );
                if connected_at.elapsed() >= std::time::Duration::from_secs(30) {
                    attempt = 0;
                }
            }
            Err(error) => {
                let rate_limited = matches!(error, AppError::RateLimited { .. });
                if rate_limited {
                    retry_delay = Some(tradestation::rate_limit_delay(&error));
                }
                emit_shared_stream_state(
                    &app,
                    &subscribers,
                    &status,
                    &environment,
                    &symbol,
                    &timeframe,
                    if rate_limited {
                        "rate-limited"
                    } else {
                        "reconnecting"
                    },
                    Some(error.to_string()),
                );
            }
        }
        attempt = attempt.saturating_add(1);
        let backoff = std::time::Duration::from_secs(
            (1u64 << attempt.min(5)).min(30) + u64::from(attempt % 3),
        );
        tokio::time::sleep(retry_delay.unwrap_or(backoff)).await;
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
    let mut quotes: HashMap<_, _> = api
        .quotes(&symbols)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|quote| (quote.symbol.clone(), quote))
        .collect();
    for quote in quotes.values() {
        let _ = app.emit(
            "quote-update",
            QuoteUpdateEvent {
                subscription_id: subscription_id.clone(),
                environment: environment.clone(),
                quote: quote.clone(),
            },
        );
    }
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
            None,
            None,
            None,
        );
        let connected_at = std::time::Instant::now();
        let mut retry_delay = None;
        match api
            .open_stream(&path, tradestation::RequestPriority::Realtime)
            .await
        {
            Ok(response) => {
                emit_stream_state(
                    &app,
                    &subscription_id,
                    &environment,
                    "quotes",
                    "streaming",
                    None,
                    None,
                    None,
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
                        if let Some(quote) = tradestation::merge_quote_update(&mut quotes, &value) {
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
                emit_stream_state(
                    &app,
                    &subscription_id,
                    &environment,
                    "quotes",
                    "reconnecting",
                    Some("TradeStation ended the stream; reconnecting".into()),
                    None,
                    None,
                    None,
                );
                if connected_at.elapsed() >= std::time::Duration::from_secs(30) {
                    attempt = 0;
                }
            }
            Err(error) => {
                let rate_limited = matches!(error, AppError::RateLimited { .. });
                if rate_limited {
                    retry_delay = Some(tradestation::rate_limit_delay(&error));
                }
                emit_stream_state(
                    &app,
                    &subscription_id,
                    &environment,
                    "quotes",
                    if rate_limited {
                        "rate-limited"
                    } else {
                        "reconnecting"
                    },
                    Some(error.to_string()),
                    None,
                    None,
                    None,
                );
            }
        }
        attempt = attempt.saturating_add(1);
        let backoff = std::time::Duration::from_secs(
            (1u64 << attempt.min(5)).min(30) + u64::from(attempt % 3),
        );
        tokio::time::sleep(retry_delay.unwrap_or(backoff)).await;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_dir)?;
            let api = TradeStation::new()?;
            journal::init(&app_dir.join("northstar.sqlite3"))?;
            app.manage(NativeState {
                api,
                db_path: app_dir.join("northstar.sqlite3"),
                bar_streams: Arc::new(tokio::sync::Mutex::new(BarStreamRegistry::default())),
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
            get_symbol_details,
            get_future_contracts,
            get_bars,
            get_quotes,
            load_cached_bars,
            load_cached_bar_range,
            get_older_bars,
            get_bar_range,
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
            replace_order,
            close_position,
            cancel_order,
            load_workspace,
            save_workspace,
            journal_auth_status,
            configure_journal,
            disconnect_journal,
            set_journal_backfill_start,
            set_journal_commission,
            sync_journal,
            get_journal_scopes,
            get_journal_month,
            get_journal_day,
            get_journal_trade,
            update_journal_annotation,
            ingest_journal_orders
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
    fn sparse_position_changes_retain_the_complete_stream_record() {
        let mut record = serde_json::json!({
            "PositionID": "p1",
            "Symbol": "MESU26",
            "LongShort": "Long",
            "Quantity": "1",
            "AveragePrice": "6250",
            "Last": "6251",
            "UnrealizedProfitLoss": "5"
        });
        merge_stream_record(
            &mut record,
            &serde_json::json!({
                "PositionID": "p1",
                "Last": "6252",
                "UnrealizedProfitLoss": "10"
            }),
        );
        let position = tradestation::position_from_value(&record);
        assert_eq!(position.symbol, "MESU26");
        assert_eq!(position.quantity, 1.0);
        assert_eq!(position.last, 6252.0);
        assert_eq!(position.unrealized_pnl, 10.0);
    }

    #[test]
    fn sparse_order_changes_retain_nested_leg_and_bracket_metadata() {
        let mut record = serde_json::json!({
            "OrderID": "o1",
            "Status": "ACK",
            "OrderType": "Limit",
            "LimitPrice": "6260",
            "GroupName": "OCO 123",
            "Legs": [{
                "Symbol": "MESU26",
                "BuyOrSell": "Sell",
                "OpenOrClose": "Close",
                "QuantityOrdered": "1",
                "QuantityRemaining": "1"
            }]
        });
        merge_stream_record(
            &mut record,
            &serde_json::json!({
                "OrderID": "o1",
                "Status": "FLL",
                "Legs": [{ "ExecQuantity": "1", "QuantityRemaining": "0" }]
            }),
        );
        let order = tradestation::order_from_value(&record);
        assert_eq!(order.symbol, "MESU26");
        assert_eq!(order.side, "Sell");
        assert_eq!(order.status, "Filled");
        assert_eq!(order.group_name.as_deref(), Some("OCO 123"));
        assert_eq!(order.open_or_close.as_deref(), Some("Close"));
        assert_eq!(order.filled_quantity, Some(1.0));
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

    #[test]
    fn bar_stream_identity_deduplicates_consumers() {
        let environment = TradingEnvironment::Sim;
        assert_eq!(
            bar_stream_key(&environment, "MESU26", "5m"),
            bar_stream_key(&environment, "MESU26", "5m")
        );
        assert_ne!(
            bar_stream_key(&environment, "MESU26", "5m"),
            bar_stream_key(&environment, "MESU26", "15m")
        );
        let subscribers = Arc::new(RwLock::new(HashMap::from([(
            "alert".into(),
            BarSubscriber {
                consumer: "ema-alert".into(),
                generation: 1,
            },
        )])));
        assert_eq!(
            bar_stream_priority(&subscribers),
            tradestation::RequestPriority::Background
        );
        subscribers.write().unwrap().insert(
            "chart".into(),
            BarSubscriber {
                consumer: "chart".into(),
                generation: 2,
            },
        );
        assert_eq!(
            bar_stream_priority(&subscribers),
            tradestation::RequestPriority::Realtime
        );
    }

    #[test]
    fn bar_subscription_generations_reject_out_of_order_commands() {
        let mut registry = BarStreamRegistry::default();
        assert!(registry.accept_generation("chart-1", 100));
        assert!(!registry.accept_generation("chart-1", 99));
        assert!(registry.accept_generation("chart-1", 101));
        assert_eq!(registry.subscription_generations["chart-1"], 101);

        // A late stop from the first selection and a late start from the
        // second selection cannot replace the final A -> B -> C choice.
        assert!(!registry.accept_generation("chart-1", 100));
        assert!(!registry.accept_generation("chart-1", 99));
    }

    #[test]
    fn retained_bar_snapshots_are_sorted_replaced_and_capped() {
        let bar = |time: i64, close: f64| Bar {
            time,
            open: close,
            high: close,
            low: close,
            close,
            volume: close,
            realtime: true,
        };
        let mut retained = vec![bar(100, 1.0), bar(200, 2.0)];
        merge_retained_bars(
            &mut retained,
            &[bar(200, 20.0), bar(300, 3.0), bar(50, 0.5)],
            3,
        );
        assert_eq!(
            retained.iter().map(|item| item.time).collect::<Vec<_>>(),
            vec![100, 200, 300]
        );
        assert_eq!(retained[1].close, 20.0);
    }

    #[test]
    fn provider_stream_errors_preserve_actionable_details() {
        assert_eq!(
            stream_provider_error(&serde_json::json!({
                "Error": "DualLogon",
                "Message": "Another market-data session is active"
            }))
            .as_deref(),
            Some("TradeStation DualLogon: Another market-data session is active")
        );
        assert_eq!(
            stream_provider_error(&serde_json::json!({ "Error": "TooManyRequests" })).as_deref(),
            Some("TradeStation stream error: TooManyRequests")
        );
    }

    #[test]
    fn reconnect_history_only_requests_the_cached_gap() {
        assert_eq!(reconnect_bars_back(10_000, 1_000, 1_120, 60, 10_000), 4);
        assert_eq!(reconnect_bars_back(50, 1_000, 1_120, 60, 10_000), 10_000);
        assert_eq!(
            reconnect_bars_back(10_000, 1_000, 9_000_000, 60, 10_000),
            10_000
        );
    }
}
