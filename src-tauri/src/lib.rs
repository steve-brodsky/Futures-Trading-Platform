mod audit;
mod journal;
mod models;
mod safety;
mod schwab;
mod schwab_oauth;
mod schwab_streamer;
mod storage;
mod tradestation;
mod trading_today;
mod truth_social;

use chrono::{DateTime, TimeZone, Timelike, Utc};
use futures_util::{SinkExt, StreamExt};
use models::*;
use schwab::Schwab;
use schwab_streamer::{SchwabStreamEvent, SchwabStreamer};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
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
    #[error("{0}")]
    BrokerRejected(String),
    #[error("{0}")]
    AmbiguousBrokerOutcome(String),
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
    audit: audit::AuditService,
    api: TradeStation,
    schwab: Schwab,
    schwab_streamer: SchwabStreamer,
    db_path: PathBuf,
    safety: Arc<safety::SafetyService>,
    bar_streams: Arc<tokio::sync::Mutex<BarStreamRegistry>>,
    quote_streams: tokio::sync::Mutex<HashMap<String, QuoteStreamRegistration>>,
    quote_provider_tasks:
        tokio::sync::Mutex<HashMap<MarketDataProvider, tauri::async_runtime::JoinHandle<()>>>,
    option_streams: tokio::sync::Mutex<HashMap<String, OptionStreamRegistration>>,
    brokerage_streams: tokio::sync::Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    schwab_brokerage_stream: tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    selected_schwab_journal_account: tokio::sync::Mutex<Option<String>>,
    preference_realtime: tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

struct QuoteStreamRegistration {
    provider: MarketDataProvider,
    symbols: BTreeSet<String>,
}

struct OptionStreamRegistration {
    contracts: BTreeSet<String>,
    task: tauri::async_runtime::JoinHandle<()>,
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
    provider: MarketDataProvider,
    symbol: String,
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

fn bar_stream_key(
    provider: &MarketDataProvider,
    environment: &TradingEnvironment,
    symbol: &str,
    timeframe: &str,
) -> String {
    let namespace = match provider {
        MarketDataProvider::Tradestation => environment.key(),
        MarketDataProvider::Schwab => "schwab",
    };
    format!("{}\0{namespace}\0{symbol}\0{timeframe}", provider.key())
}

fn cache_namespace(
    provider: &MarketDataProvider,
    environment: &TradingEnvironment,
) -> &'static str {
    match provider {
        MarketDataProvider::Tradestation => environment.key(),
        MarketDataProvider::Schwab => "schwab",
    }
}

fn bar_retained_limit(provider: &MarketDataProvider, timeframe: &str) -> usize {
    if *provider == MarketDataProvider::Tradestation {
        return tradestation::history_spec(timeframe)
            .map(|(_, _, bars_back)| bars_back)
            .unwrap_or(10_000);
    }
    match timeframe {
        "1m" => 10_000,
        "5m" => 4_000,
        "15m" => 2_000,
        "30m" => 1_000,
        "1h" => 1_000,
        "4h" => 500,
        "D" => 5_000,
        "W" => 2_500,
        "M" => 1_000,
        _ => 10_000,
    }
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

#[tauri::command]
async fn schwab_auth_status(state: State<'_, NativeState>) -> Result<AuthStatus, AppError> {
    Ok(AuthStatus {
        configured: storage::schwab_client()?.is_some(),
        authenticated: state.schwab.authenticated().await,
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn save_schwab_credentials(
    client_id: String,
    client_secret: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let changed = storage::save_schwab_client(&client_id, &client_secret)?;
    if changed {
        state.schwab.clear_access_token().await;
        state.schwab_streamer.stop().await;
    }
    let mut record = audit::AuditRecord::completed(
        "record",
        "credential-vault",
        "save-schwab-credentials",
        "success",
        if changed {
            "Schwab credentials were updated"
        } else {
            "Schwab credentials were unchanged"
        },
    );
    record.entity_type = Some("credential-state".into());
    record.entity_id = Some("schwab".into());
    record.changes = Some(serde_json::json!({"configured": true, "changed": changed}));
    state.audit.record(record);
    Ok(())
}

#[tauri::command]
async fn begin_schwab_login(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let result = schwab_oauth::begin(app.clone(), state.schwab.clone()).await;
    match &result {
        Ok(()) => {
            let _ = app.emit(
                "schwab-auth-changed",
                serde_json::json!({"authenticated":true}),
            );
        }
        Err(error) => {
            let _ = app.emit("schwab-auth-error", error.to_string());
        }
    }
    result
}

#[tauri::command]
async fn logout_schwab(state: State<'_, NativeState>) -> Result<(), AppError> {
    let (_transition, _) = state.safety.lifecycle.begin_transition().await;
    shutdown_native_services(&state).await;
    state.schwab.clear_access_token().await;
    let result = storage::clear_schwab_refresh_token();
    state.safety.lifecycle.finish_transition();
    result?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn save_credentials(
    client_id: String,
    client_secret: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return Err(AppError::Validation(
            "Client ID and secret are required".into(),
        ));
    }
    storage::set_secret("client_id", client_id.trim())?;
    storage::set_secret("client_secret", client_secret.trim())?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "credential-vault",
        "save-tradestation-credentials",
        "success",
        "TradeStation credentials were updated",
    );
    record.entity_type = Some("credential-state".into());
    record.entity_id = Some("tradestation".into());
    record.changes = Some(serde_json::json!({"configured": true}));
    state.audit.record(record);
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
    let reconciliation_api = state.api.clone();
    let reconciliation_db = state.db_path.clone();
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
                reconcile_unresolved(reconciliation_api, reconciliation_db).await;
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
    let (_transition, _) = state.safety.lifecycle.begin_transition().await;
    shutdown_native_services(&state).await;
    state.api.clear_token().await;
    let result = storage::delete_secret("refresh_token");
    state.safety.lifecycle.finish_transition();
    result?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "credential-vault",
        "logout-tradestation",
        "success",
        "TradeStation session credentials were cleared",
    );
    record.entity_type = Some("credential-state".into());
    record.entity_id = Some("tradestation".into());
    record.changes = Some(serde_json::json!({"authenticated": false}));
    state.audit.record(record);
    Ok(())
}

#[tauri::command]
async fn set_environment(
    environment: TradingEnvironment,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let _transition = state.safety.lifecycle.lock_transition().await;
    if state.api.environment().await == environment {
        return Ok(());
    }
    let generation = state.safety.lifecycle.begin_locked_transition();
    shutdown_native_services(&state).await;
    let environment_key = environment.key().to_string();
    state.api.set_environment(environment).await;
    state.safety.lifecycle.finish_transition();
    let reconcile_api = state.api.clone();
    let reconcile_db = state.db_path.clone();
    tauri::async_runtime::spawn(async move {
        reconcile_unresolved(reconcile_api, reconcile_db).await;
    });
    let mut record = audit::AuditRecord::completed(
        "record",
        "workspace",
        "set-trading-environment",
        "success",
        format!(
            "Trading environment changed to {}",
            environment_key.to_uppercase()
        ),
    );
    record.entity_type = Some("trading-environment".into());
    record.entity_id = Some(environment_key);
    record.changes = Some(serde_json::json!({"generation": generation}));
    state.audit.record(record);
    Ok(())
}

async fn shutdown_native_services(state: &NativeState) {
    let mut handles = Vec::new();
    {
        let mut registry = state.bar_streams.lock().await;
        for (_, stream) in registry.streams.drain() {
            stream.task.abort();
            handles.push(stream.task);
        }
        registry.subscription_keys.clear();
        registry.subscription_generations.clear();
    }
    {
        let mut streams = state.quote_streams.lock().await;
        streams.clear();
    }
    {
        let mut streams = state.quote_provider_tasks.lock().await;
        for (_, task) in streams.drain() {
            task.abort();
            handles.push(task);
        }
    }
    {
        let mut streams = state.option_streams.lock().await;
        for (_, registration) in streams.drain() {
            registration.task.abort();
            handles.push(registration.task);
        }
    }
    {
        let mut streams = state.brokerage_streams.lock().await;
        for task in streams.drain(..) {
            task.abort();
            handles.push(task);
        }
    }
    if let Some(task) = state.schwab_brokerage_stream.lock().await.take() {
        task.abort();
        handles.push(task);
    }
    if let Some(task) = state.preference_realtime.lock().await.take() {
        task.abort();
        handles.push(task);
    }
    state.schwab_streamer.stop().await;
    state
        .schwab_streamer
        .set_quote_symbols(std::iter::empty())
        .await;
    state
        .schwab_streamer
        .set_option_symbols(std::iter::empty())
        .await;
    state
        .schwab_streamer
        .set_chart_symbols(std::iter::empty())
        .await;
    state.api.clear_brokerage_cache().await;
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        futures_util::future::join_all(handles),
    )
    .await;
}

#[tauri::command]
async fn get_accounts(state: State<'_, NativeState>) -> Result<Vec<Account>, AppError> {
    state.api.accounts().await
}

#[tauri::command]
async fn get_schwab_accounts(state: State<'_, NativeState>) -> Result<Vec<Account>, AppError> {
    state.schwab.accounts().await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_schwab_account_snapshot(
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<SchwabAccountSnapshot, AppError> {
    state.schwab.account_snapshot(&account_id).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_schwab_orders(
    account_id: String,
    from_entered_time: String,
    to_entered_time: String,
    state: State<'_, NativeState>,
) -> Result<HistoricalOrderPage, AppError> {
    state
        .schwab
        .orders(&account_id, &from_entered_time, &to_entered_time)
        .await
}

#[tauri::command]
async fn search_symbols(
    query: String,
    state: State<'_, NativeState>,
) -> Result<Vec<SymbolMeta>, AppError> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let tradestation = state.api.search_symbols(query.trim());
    let schwab = state.schwab.search_symbols(query.trim());
    let (tradestation, schwab) = tokio::join!(tradestation, schwab);
    combine_symbol_search_responses(tradestation, schwab, query.trim())
}

fn combine_symbol_search_responses(
    tradestation: Result<Vec<SymbolMeta>, AppError>,
    schwab: Result<Vec<SymbolMeta>, AppError>,
    query: &str,
) -> Result<Vec<SymbolMeta>, AppError> {
    match (tradestation, schwab) {
        (Ok(tradestation), Ok(schwab)) => {
            Ok(merge_symbol_search_results(tradestation, schwab, query))
        }
        (Ok(tradestation), Err(_)) => Ok(merge_symbol_search_results(tradestation, vec![], query)),
        (Err(_), Ok(schwab)) => Ok(merge_symbol_search_results(vec![], schwab, query)),
        (Err(tradestation), Err(schwab)) => Err(AppError::Api(format!(
            "Symbol search unavailable. TradeStation: {tradestation}. Schwab: {schwab}"
        ))),
    }
}

fn merge_symbol_search_results(
    tradestation: Vec<SymbolMeta>,
    schwab: Vec<SymbolMeta>,
    query: &str,
) -> Vec<SymbolMeta> {
    // The TradeStation request is already server-filtered to Category=Future.
    // Its v2 suggestion payload is inconsistent about category spelling and
    // sometimes omits it, so a second exact client-side filter can hide valid
    // futures returned by that endpoint.
    const MAX_RESULTS: usize = 20;
    let query = query.trim().to_uppercase();
    let mut results: Vec<_> = tradestation
        .into_iter()
        .chain(schwab)
        .filter_map(normalize_symbol_search_result)
        .collect();
    results.sort_by(|left, right| {
        symbol_search_rank(left, &query)
            .cmp(&symbol_search_rank(right, &query))
            .then_with(|| left.symbol.cmp(&right.symbol))
            .then_with(|| left.provider.key().cmp(right.provider.key()))
    });
    let mut seen = HashSet::new();
    results.retain(|item| seen.insert((item.provider.clone(), item.symbol.clone())));
    results.truncate(MAX_RESULTS);
    results
}

fn normalize_symbol_search_result(mut result: SymbolMeta) -> Option<SymbolMeta> {
    result.symbol = result.symbol.trim().to_uppercase();
    if result.symbol.is_empty() {
        return None;
    }
    result.description = result.description.trim().to_owned();
    result.exchange = result.exchange.trim().to_owned();
    result.asset_type = result.asset_type.trim().to_uppercase();
    Some(result)
}

fn symbol_search_rank(result: &SymbolMeta, query: &str) -> u8 {
    let symbol = result.symbol.to_uppercase();
    let description = result.description.to_uppercase();
    if symbol == query {
        0
    } else if symbol.starts_with(query) {
        1
    } else if symbol.contains(query) {
        2
    } else if description.starts_with(query) {
        3
    } else if description.contains(query) {
        4
    } else {
        5
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn get_symbol_details(
    provider: MarketDataProvider,
    symbol: String,
    state: State<'_, NativeState>,
) -> Result<SymbolMeta, AppError> {
    match provider {
        MarketDataProvider::Tradestation => state.api.symbol_details(symbol.trim()).await,
        MarketDataProvider::Schwab => state.schwab.symbol_details(symbol.trim()).await,
    }
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
    provider: MarketDataProvider,
    symbol: String,
    timeframe: String,
    state: State<'_, NativeState>,
) -> Result<Vec<Bar>, AppError> {
    match provider {
        MarketDataProvider::Tradestation => state.api.bars(&symbol, &timeframe).await,
        MarketDataProvider::Schwab => state.schwab.bars(&symbol, &timeframe).await,
    }
}

#[tauri::command]
async fn get_quotes(
    provider: MarketDataProvider,
    symbols: Vec<String>,
    state: State<'_, NativeState>,
) -> Result<Vec<Quote>, AppError> {
    match provider {
        MarketDataProvider::Tradestation => state.api.quotes(&symbols).await,
        MarketDataProvider::Schwab => state.schwab.quotes(&symbols).await,
    }
}

#[tauri::command]
async fn get_option_expirations(
    symbol: String,
    state: State<'_, NativeState>,
) -> Result<Vec<OptionExpiration>, AppError> {
    state.schwab.option_expirations(&symbol).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_option_chain(
    symbol: String,
    expiration_dates: Vec<String>,
    strike_count: Option<u32>,
    state: State<'_, NativeState>,
) -> Result<OptionChainSnapshot, AppError> {
    state
        .schwab
        .option_chain(&symbol, &expiration_dates, strike_count)
        .await
}

#[tauri::command(rename_all = "camelCase")]
async fn load_cached_bars(
    provider: MarketDataProvider,
    symbol: String,
    timeframe: String,
    state: State<'_, NativeState>,
) -> Result<Vec<Bar>, AppError> {
    let environment = state.api.environment().await;
    let mut bars = storage::load_bars(
        &state.db_path,
        cache_namespace(&provider, &environment),
        &symbol,
        &timeframe,
        10_000,
    )?;
    if provider == MarketDataProvider::Schwab {
        bars.retain(schwab::valid_equity_bar);
    }
    Ok(bars)
}

#[tauri::command(rename_all = "camelCase")]
async fn get_older_bars(
    provider: MarketDataProvider,
    symbol: String,
    timeframe: String,
    before: i64,
    state: State<'_, NativeState>,
) -> Result<Vec<Bar>, AppError> {
    let environment = state.api.environment().await;
    let bars = match provider {
        MarketDataProvider::Tradestation => {
            state.api.older_bars(&symbol, &timeframe, before).await?
        }
        MarketDataProvider::Schwab => state.schwab.older_bars(&symbol, &timeframe, before).await?,
    };
    storage::save_bars(
        &state.db_path,
        cache_namespace(&provider, &environment),
        &symbol,
        &timeframe,
        &bars,
    )?;
    Ok(bars)
}

#[tauri::command(rename_all = "camelCase")]
async fn load_cached_bar_range(
    provider: MarketDataProvider,
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
    let mut bars = storage::load_bars_range(
        &state.db_path,
        cache_namespace(&provider, &environment),
        &symbol,
        &timeframe,
        first,
        last,
    )?;
    if provider == MarketDataProvider::Schwab {
        bars.retain(schwab::valid_equity_bar);
    }
    Ok(bars)
}

#[tauri::command(rename_all = "camelCase")]
async fn get_bar_range(
    provider: MarketDataProvider,
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
    let bars = match provider {
        MarketDataProvider::Tradestation => {
            state
                .api
                .bars_range(&symbol, &timeframe, first, last)
                .await?
        }
        MarketDataProvider::Schwab => state.schwab.bars_range(&symbol, first, last).await?,
    };
    storage::save_bars(
        &state.db_path,
        cache_namespace(&provider, &environment),
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
    provider: MarketDataProvider,
    symbol: String,
    timeframe: String,
    consumer: String,
    generation: u64,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    if state.safety.lifecycle.is_transitioning() {
        return Err(AppError::Validation(
            "Services are changing environment; resubscribe when ready".into(),
        ));
    }
    let environment_generation = state.safety.lifecycle.generation();
    match provider {
        MarketDataProvider::Tradestation => {
            TradeStation::bar_stream_path(&symbol, &timeframe)?;
        }
        MarketDataProvider::Schwab => {
            schwab::bucket_start(Utc::now().timestamp(), &timeframe)
                .ok_or_else(|| AppError::Validation("Unsupported Schwab timeframe".into()))?;
        }
    }
    if !matches!(consumer.as_str(), "chart" | "ema-alert" | "vwap" | "truth-social-alert" | "swing-trail") {
        return Err(AppError::Validation("Invalid bar stream consumer".into()));
    }
    let environment = state.api.environment().await;
    let key = bar_stream_key(&provider, &environment, &symbol, &timeframe);
    let retained_limit = bar_retained_limit(&provider, &timeframe);
    let mut cached_bars = storage::load_bars(
        &state.db_path,
        cache_namespace(&provider, &environment),
        &symbol,
        &timeframe,
        retained_limit,
    )
    .unwrap_or_default();
    if provider == MarketDataProvider::Schwab {
        cached_bars.retain(schwab::valid_equity_bar);
    }
    if !state.safety.lifecycle.accepts(environment_generation) {
        return Err(AppError::Validation(
            "The environment changed while the stream was starting; resubscribe explicitly".into(),
        ));
    }
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
            let task = match provider {
                MarketDataProvider::Tradestation => tauri::async_runtime::spawn(run_bar_stream(
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
                    state.safety.lifecycle.clone(),
                    environment_generation,
                )),
                MarketDataProvider::Schwab => {
                    // Register the receiver before sync_schwab_chart_symbols can
                    // make an already-connected socket send its initial sequence.
                    let receiver = state.schwab_streamer.subscribe_chart();
                    tauri::async_runtime::spawn(run_schwab_bar_stream(
                        app.clone(),
                        state.schwab.clone(),
                        state.schwab_streamer.clone(),
                        receiver,
                        state.db_path.clone(),
                        subscribers.clone(),
                        status.clone(),
                        latest_bars.clone(),
                        retained_limit,
                        environment.clone(),
                        symbol.clone(),
                        timeframe.clone(),
                        state.safety.lifecycle.clone(),
                        environment_generation,
                    ))
                }
            };
            registry.streams.insert(
                key,
                SharedBarStream {
                    provider: provider.clone(),
                    symbol: symbol.clone(),
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
        schedule_bar_stream_cleanup(
            registry_handle.clone(),
            state.schwab_streamer.clone(),
            cleanup_key,
            generation,
        );
    }
    sync_schwab_chart_symbols(&registry_handle, &state.schwab_streamer).await;
    if let Some((status, bars)) = late_replay {
        if !state.safety.lifecycle.accepts(environment_generation) {
            return Ok(());
        }
        if let Ok(bars) = bars.read() {
            // Live updates take the write lock before emitting, so holding
            // this read lock keeps the bootstrap snapshot ahead of them.
            if !bars.is_empty() {
                emit_bar_snapshot_to(
                    &app,
                    &subscription_id,
                    &provider,
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
                &provider,
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
async fn refresh_bar_stream(
    app: tauri::AppHandle,
    provider: MarketDataProvider,
    symbol: String,
    timeframe: String,
    state: State<'_, NativeState>,
) -> Result<Vec<Bar>, AppError> {
    if state.safety.lifecycle.is_transitioning() {
        return Ok(Vec::new());
    }
    let environment_generation = state.safety.lifecycle.generation();
    let environment = state.api.environment().await;
    let key = bar_stream_key(&provider, &environment, &symbol, &timeframe);
    let retained_limit = bar_retained_limit(&provider, &timeframe);
    let registry_handle = state.bar_streams.clone();
    let shared_stream = {
        let registry = registry_handle.lock().await;
        registry
            .streams
            .get(&key)
            .map(|shared| (shared.subscribers.clone(), shared.latest_bars.clone()))
    };
    let bars = match provider {
        MarketDataProvider::Tradestation => state.api.recent_bars(&symbol, &timeframe, 4).await?,
        MarketDataProvider::Schwab => state.schwab.bars(&symbol, &timeframe).await?,
    };
    if !state.safety.lifecycle.accepts(environment_generation) {
        return Ok(Vec::new());
    }
    storage::save_bars(
        &state.db_path,
        cache_namespace(&provider, &environment),
        &symbol,
        &timeframe,
        &bars,
    )?;
    if let Some((subscribers, latest_bars)) = shared_stream {
        let retained = retain_bar_snapshot(&latest_bars, &bars, retained_limit);
        emit_bar_snapshot(
            &app,
            &subscribers,
            &provider,
            &environment,
            &symbol,
            &timeframe,
            &retained,
        );
    }
    Ok(bars)
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
        schedule_bar_stream_cleanup(
            registry_handle,
            state.schwab_streamer.clone(),
            key,
            generation,
        );
    }
    Ok(())
}

fn schedule_bar_stream_cleanup(
    registry: Arc<tokio::sync::Mutex<BarStreamRegistry>>,
    schwab_streamer: SchwabStreamer,
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
        let symbols = registry
            .streams
            .values()
            .filter(|shared| shared.provider == MarketDataProvider::Schwab)
            .map(|shared| shared.symbol.clone())
            .collect::<Vec<_>>();
        drop(registry);
        schwab_streamer.set_chart_symbols(symbols).await;
    });
}

async fn sync_schwab_chart_symbols(
    registry: &Arc<tokio::sync::Mutex<BarStreamRegistry>>,
    streamer: &SchwabStreamer,
) {
    let symbols = registry
        .lock()
        .await
        .streams
        .values()
        .filter(|shared| shared.provider == MarketDataProvider::Schwab)
        .map(|shared| shared.symbol.clone())
        .collect::<Vec<_>>();
    streamer.set_chart_symbols(symbols).await;
}

#[tauri::command(rename_all = "camelCase")]
async fn start_quote_stream(
    app: tauri::AppHandle,
    subscription_id: String,
    provider: MarketDataProvider,
    mut symbols: Vec<String>,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    if state.safety.lifecycle.is_transitioning() {
        return Err(AppError::Validation(
            "Services are changing environment; resubscribe when ready".into(),
        ));
    }
    symbols.sort();
    symbols.dedup();
    if symbols.len() > 100 {
        return Err(AppError::Validation(
            "A maximum of 100 streamed quote symbols is supported".into(),
        ));
    }
    let environment = state.api.environment().await;
    let symbol_set = symbols.iter().cloned().collect::<BTreeSet<_>>();
    let mut current = state.quote_streams.lock().await;
    let previous = current.insert(
        subscription_id.clone(),
        QuoteStreamRegistration {
            provider: provider.clone(),
            symbols: symbol_set,
        },
    );
    let union_count = current
        .values()
        .filter(|registration| registration.provider == provider)
        .flat_map(|registration| registration.symbols.iter().cloned())
        .collect::<BTreeSet<_>>()
        .len();
    if union_count > 100 {
        if let Some(previous) = previous {
            current.insert(subscription_id, previous);
        } else {
            current.remove(&subscription_id);
        }
        return Err(AppError::Validation(
            "The combined quote stream cannot exceed 100 symbols".into(),
        ));
    }
    drop(current);
    restart_quote_provider(app, &state, provider, environment).await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn stop_quote_stream(
    app: tauri::AppHandle,
    subscription_id: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let mut current = state.quote_streams.lock().await;
    let provider = current.remove(&subscription_id).map(|value| value.provider);
    drop(current);
    if let Some(provider) = provider {
        let environment = state.api.environment().await;
        restart_quote_provider(app, &state, provider, environment).await;
    }
    Ok(())
}

async fn restart_quote_provider(
    app: tauri::AppHandle,
    state: &NativeState,
    provider: MarketDataProvider,
    environment: TradingEnvironment,
) {
    if let Some(previous) = state.quote_provider_tasks.lock().await.remove(&provider) {
        previous.abort();
    }
    let subscriptions = state
        .quote_streams
        .lock()
        .await
        .iter()
        .filter(|(_, registration)| registration.provider == provider)
        .map(|(id, registration)| (id.clone(), registration.symbols.clone()))
        .collect::<Vec<_>>();
    let union = subscriptions
        .iter()
        .flat_map(|(_, symbols)| symbols.iter().cloned())
        .collect::<BTreeSet<_>>();
    if provider == MarketDataProvider::Schwab {
        state
            .schwab_streamer
            .set_quote_symbols(union.iter().cloned())
            .await;
    }
    if subscriptions.is_empty() {
        return;
    }
    let environment_generation = state.safety.lifecycle.generation();
    let task = match provider {
        MarketDataProvider::Tradestation => tauri::async_runtime::spawn(run_quote_stream(
            app,
            state.api.clone(),
            subscriptions,
            environment,
            union.into_iter().collect(),
            state.safety.lifecycle.clone(),
            environment_generation,
        )),
        MarketDataProvider::Schwab => tauri::async_runtime::spawn(run_schwab_quote_stream(
            app,
            state.schwab.clone(),
            state.schwab_streamer.clone(),
            subscriptions,
            environment,
            union.into_iter().collect(),
            state.safety.lifecycle.clone(),
            environment_generation,
        )),
    };
    state
        .quote_provider_tasks
        .lock()
        .await
        .insert(provider, task);
}

async fn sync_schwab_option_symbols(
    registrations: &tokio::sync::Mutex<HashMap<String, OptionStreamRegistration>>,
    streamer: &SchwabStreamer,
) {
    let symbols = registrations
        .lock()
        .await
        .values()
        .flat_map(|registration| registration.contracts.iter().cloned())
        .collect::<BTreeSet<_>>();
    streamer.set_option_symbols(symbols).await;
}

#[tauri::command(rename_all = "camelCase")]
async fn start_option_stream(
    app: tauri::AppHandle,
    subscription_id: String,
    symbol: String,
    mut contract_symbols: Vec<String>,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    if state.safety.lifecycle.is_transitioning() {
        return Err(AppError::Validation(
            "Services are changing environment; resubscribe when ready".into(),
        ));
    }
    let environment_generation = state.safety.lifecycle.generation();
    contract_symbols = contract_symbols
        .into_iter()
        .map(|contract| contract.trim().to_uppercase())
        .filter(|contract| !contract.is_empty())
        .collect();
    contract_symbols.sort();
    contract_symbols.dedup();
    if contract_symbols.len() > 100 {
        return Err(AppError::Validation(
            "A maximum of 100 streamed option contracts is supported".into(),
        ));
    }
    let contracts = contract_symbols.iter().cloned().collect::<BTreeSet<_>>();
    let desired = contracts.clone();
    let task = tauri::async_runtime::spawn(run_schwab_option_stream(
        app,
        state.schwab_streamer.clone(),
        subscription_id.clone(),
        symbol.to_uppercase(),
        desired,
        state.safety.lifecycle.clone(),
        environment_generation,
    ));
    let mut current = state.option_streams.lock().await;
    let mut union = current
        .iter()
        .filter(|(id, _)| *id != &subscription_id)
        .flat_map(|(_, registration)| registration.contracts.iter().cloned())
        .collect::<BTreeSet<_>>();
    union.extend(contracts.iter().cloned());
    if union.len() > 100 {
        task.abort();
        return Err(AppError::Validation(
            "The combined option stream cannot exceed 100 contracts".into(),
        ));
    }
    if let Some(previous) = current.insert(
        subscription_id,
        OptionStreamRegistration { contracts, task },
    ) {
        previous.task.abort();
    }
    drop(current);
    sync_schwab_option_symbols(&state.option_streams, &state.schwab_streamer).await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn stop_option_stream(
    subscription_id: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    if let Some(registration) = state.option_streams.lock().await.remove(&subscription_id) {
        registration.task.abort();
    }
    sync_schwab_option_symbols(&state.option_streams, &state.schwab_streamer).await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn start_brokerage_stream(
    app: tauri::AppHandle,
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    if state.safety.lifecycle.is_transitioning() {
        return Err(AppError::Validation(
            "Services are changing environment; resubscribe when ready".into(),
        ));
    }
    let environment = state.api.environment().await;
    let environment_generation = state.safety.lifecycle.generation();
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
            state.safety.lifecycle.clone(),
            environment_generation,
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

fn schwab_order_range_at(now: DateTime<Utc>) -> (String, String) {
    let local = now.with_timezone(&chrono_tz::America::New_York);
    let mut session_date = local.date_naive();
    if local.hour() < 4 {
        session_date = session_date.pred_opt().unwrap_or(session_date);
    }
    let start_local = chrono_tz::America::New_York
        .from_local_datetime(&session_date.and_hms_opt(4, 0, 0).unwrap())
        .earliest()
        .unwrap_or(local);
    (
        start_local.with_timezone(&Utc).to_rfc3339(),
        now.to_rfc3339(),
    )
}

fn schwab_current_order_range() -> (String, String) {
    schwab_order_range_at(Utc::now())
}

fn capture_schwab_journal_orders(
    app: &tauri::AppHandle,
    db_path: &std::path::Path,
    orders: &[OrderUpdate],
    source: &str,
) -> Result<(), AppError> {
    if orders.is_empty() {
        return Ok(());
    }
    let result = journal::ingest_schwab_strangles(db_path, orders, source)?;
    if result.fills > 0 || source == "broker-stream" {
        let _ = app.emit("journal-updated", serde_json::json!({"reason": if result.fills > 0 { "schwab-option-fill" } else { "schwab-order-observed" }}));
        schedule_journal_flush(app.clone(), db_path.to_path_buf());
    }
    Ok(())
}

async fn emit_schwab_brokerage_snapshot(
    app: &tauri::AppHandle,
    api: &Schwab,
    db_path: &std::path::Path,
    account_id: &str,
    environment_generation: u64,
) -> Result<(), AppError> {
    let snapshot = api.account_snapshot(account_id).await?;
    let (from, to) = schwab_current_order_range();
    let orders = api.orders(account_id, &from, &to).await?.orders;
    capture_schwab_journal_orders(app, db_path, &orders, "broker-stream")?;
    let _ = app.emit("schwab-account-snapshot", snapshot.clone());
    let _ = app.emit(
        "positions-snapshot",
        PositionsSnapshotEvent {
            provider: MarketDataProvider::Schwab,
            account_id: account_id.into(),
            environment_generation,
            positions: snapshot.positions,
        },
    );
    let _ = app.emit(
        "orders-snapshot",
        OrdersSnapshotEvent {
            provider: MarketDataProvider::Schwab,
            account_id: account_id.into(),
            environment_generation,
            orders,
        },
    );
    for channel in ["positions", "orders"] {
        let _ = app.emit(
            "brokerage-stream-state",
            BrokerageStreamStateEvent {
                provider: MarketDataProvider::Schwab,
                account_id: account_id.into(),
                environment_generation,
                channel: channel.into(),
                state: "streaming".into(),
                message: None,
            },
        );
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn start_schwab_brokerage_stream(
    app: tauri::AppHandle,
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    *state.selected_schwab_journal_account.lock().await = Some(account_id.clone());
    if let Some(task) = state.schwab_brokerage_stream.lock().await.take() {
        task.abort();
    }
    let _ = state.schwab.accounts().await?;
    state.schwab_streamer.set_account_activity(true).await;
    let api = state.schwab.clone();
    let streamer = state.schwab_streamer.clone();
    let generation = state.safety.lifecycle.generation();
    let db_path = state.db_path.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut receiver = streamer.subscribe();
        let mut watchdog = tokio::time::interval(std::time::Duration::from_secs(30));
        watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let debounce = tokio::time::sleep(std::time::Duration::from_secs(31_536_000));
        let settlement = tokio::time::sleep(std::time::Duration::from_secs(31_536_000));
        tokio::pin!(debounce, settlement);
        let mut debounce_pending = false;
        let mut settlement_pending = false;
        loop {
            tokio::select! {
                _ = watchdog.tick() => {
                    if let Err(error) = emit_schwab_brokerage_snapshot(&app, &api, &db_path, &account_id, generation).await {
                        for channel in ["positions", "orders"] {
                            let _ = app.emit("brokerage-stream-state", BrokerageStreamStateEvent {
                                provider: MarketDataProvider::Schwab,
                                account_id: account_id.clone(), environment_generation: generation,
                                channel: channel.into(), state: "stale".into(), message: Some(error.to_string()),
                            });
                        }
                        }
                    }
                _ = &mut debounce, if debounce_pending => {
                    debounce_pending = false;
                    if let Err(error) = emit_schwab_brokerage_snapshot(&app, &api, &db_path, &account_id, generation).await {
                        for channel in ["positions", "orders"] {
                            let _ = app.emit("brokerage-stream-state", BrokerageStreamStateEvent {
                                provider: MarketDataProvider::Schwab,
                                account_id: account_id.clone(), environment_generation: generation,
                                channel: channel.into(), state: "stale".into(), message: Some(error.to_string()),
                            });
                        }
                    }
                }
                _ = &mut settlement, if settlement_pending => {
                    settlement_pending = false;
                    let _ = emit_schwab_brokerage_snapshot(&app, &api, &db_path, &account_id, generation).await;
                }
                event = receiver.recv() => match event {
                    Ok(SchwabStreamEvent::AccountActivity { sequence, account_number, message_type, message_data }) => {
                        let _activity_metadata = (sequence, message_type.len(), message_data.len());
                        if api.account_hash_for_number(&account_number).await.as_deref() != Some(account_id.as_str()) { continue; }
                        debounce.as_mut().reset(tokio::time::Instant::now() + std::time::Duration::from_millis(350));
                        settlement.as_mut().reset(tokio::time::Instant::now() + std::time::Duration::from_millis(2_850));
                        debounce_pending = true;
                        settlement_pending = true;
                    }
                    Ok(SchwabStreamEvent::AccountActivityState { state, message }) => {
                        let mapped = if state == "rest-only" { "disconnected" } else { state.as_str() };
                        if state == "streaming" {
                            let _ = emit_schwab_brokerage_snapshot(&app, &api, &db_path, &account_id, generation).await;
                        }
                        for channel in ["positions", "orders"] {
                            let _ = app.emit("brokerage-stream-state", BrokerageStreamStateEvent {
                                provider: MarketDataProvider::Schwab,
                                account_id: account_id.clone(), environment_generation: generation,
                                channel: channel.into(), state: mapped.into(), message: message.clone(),
                            });
                        }
                    }
                    Ok(SchwabStreamEvent::State { state, message }) => {
                        let mapped = if state == "streaming" { "streaming" } else { state.as_str() };
                        if state == "streaming" {
                            let _ = emit_schwab_brokerage_snapshot(&app, &api, &db_path, &account_id, generation).await;
                        }
                        for channel in ["positions", "orders"] {
                            let _ = app.emit("brokerage-stream-state", BrokerageStreamStateEvent {
                                provider: MarketDataProvider::Schwab,
                                account_id: account_id.clone(), environment_generation: generation,
                                channel: channel.into(), state: mapped.into(), message: message.clone(),
                            });
                        }
                    }
                    Err(broadcast_error) => {
                        if matches!(broadcast_error, tokio::sync::broadcast::error::RecvError::Closed) { break; }
                    }
                    _ => {}
                }
            }
        }
    });
    *state.schwab_brokerage_stream.lock().await = Some(task);
    Ok(())
}

#[tauri::command]
async fn stop_schwab_brokerage_stream(state: State<'_, NativeState>) -> Result<(), AppError> {
    if let Some(task) = state.schwab_brokerage_stream.lock().await.take() {
        task.abort();
    }
    state.schwab_streamer.set_account_activity(false).await;
    *state.selected_schwab_journal_account.lock().await = None;
    Ok(())
}

async fn run_brokerage_stream(
    app: tauri::AppHandle,
    api: TradeStation,
    account_id: String,
    channel: String,
    environment: TradingEnvironment,
    db_path: PathBuf,
    lifecycle: Arc<safety::ServiceLifecycle>,
    environment_generation: u64,
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
        if !lifecycle.accepts(environment_generation) {
            return;
        }
        let connecting_state = if attempt == 0 {
            "connecting"
        } else {
            "reconnecting"
        };
        api.set_brokerage_stream_state(&environment, &account_id, &channel, connecting_state)
            .await;
        emit_brokerage_stream_state(
            &app,
            &account_id,
            &channel,
            connecting_state,
            None,
            environment_generation,
        );
        let connected_at = std::time::Instant::now();
        let mut retry_delay = None;
        match api
            .open_stream(&path, tradestation::RequestPriority::Realtime)
            .await
        {
            Ok(response) => {
                api.set_brokerage_stream_state(&environment, &account_id, &channel, "streaming")
                    .await;
                emit_brokerage_stream_state(
                    &app,
                    &account_id,
                    &channel,
                    "streaming",
                    None,
                    environment_generation,
                );
                let mut bytes = response.bytes_stream();
                let mut buffer = Vec::new();
                let mut position_records = HashMap::<String, Value>::new();
                let mut order_records = HashMap::<String, Value>::new();
                let mut snapshot_complete = false;
                let mut go_away = false;
                while let Some(Ok(chunk)) = bytes.next().await {
                    if !lifecycle.accepts(environment_generation) {
                        return;
                    }
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
                                            provider: MarketDataProvider::Tradestation,
                                            account_id: account_id.clone(),
                                            environment_generation,
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
                                            provider: MarketDataProvider::Tradestation,
                                            account_id: account_id.clone(),
                                            environment_generation,
                                            orders,
                                        },
                                    );
                                    reconcile_unresolved(api.clone(), db_path.clone()).await;
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
                                        provider: MarketDataProvider::Tradestation,
                                        account_id: account_id.clone(),
                                        environment_generation,
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
                                        provider: MarketDataProvider::Tradestation,
                                        account_id: account_id.clone(),
                                        environment_generation,
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
                                provider: MarketDataProvider::Tradestation,
                                account_id: account_id.clone(),
                                environment_generation,
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
                                provider: MarketDataProvider::Tradestation,
                                account_id: account_id.clone(),
                                environment_generation,
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
                    environment_generation,
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
                        environment_generation,
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
                    environment_generation,
                );
            }
        }
        attempt = attempt.saturating_add(1);
        let backoff = std::time::Duration::from_secs(
            (1u64 << attempt.min(5)).min(30) + u64::from(attempt % 3),
        );
        tokio::select! {
            _ = tokio::time::sleep(retry_delay.unwrap_or(backoff)) => {}
            _ = async {
                while lifecycle.accepts(environment_generation) {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            } => return,
        }
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
    environment_generation: u64,
) {
    let _ = app.emit(
        "brokerage-stream-state",
        BrokerageStreamStateEvent {
            provider: MarketDataProvider::Tradestation,
            account_id: account_id.into(),
            environment_generation,
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
    let environment = state.api.environment().await;
    let (decision, _) = native_order_risk(&state, &environment, &order).await?;
    if !decision.allowed {
        return Ok(OrderPreview {
            valid: false,
            summary: "Blocked by native risk policy".into(),
            estimated_commission: None,
            initial_margin: None,
            errors: decision.reasons,
        });
    }
    state.api.confirm_order(&order).await
}

#[tauri::command(rename_all = "camelCase")]
async fn place_order(
    order: OrderDraft,
    client_mutation_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<BrokerMutationResult, AppError> {
    let environment = state.api.environment().await;
    let mutation_id = mutation_id(client_mutation_id);
    let created = safety::create_intent(
        &state.db_path,
        safety::NewMutationIntent {
            id: mutation_id.clone(),
            environment: environment.clone(),
            account_id: order.account_id.clone(),
            kind: "place_order".into(),
            equivalence_key: place_equivalence_key(&order),
            symbol: Some(order.symbol.clone()),
            action: order.side.clone(),
            quantity: Some(order.quantity as f64),
            order_type: Some(order.order_type.clone()),
            limit_price: order.limit_price,
            stop_price: order.stop_price,
            take_profit: order.take_profit,
            stop_loss: order.stop_loss,
            target_id: None,
            request: serde_json::to_value(&order)?,
        },
    )?;
    match created {
        safety::CreateIntent::Existing(record) => return mutation_result_from_intent(&record),
        safety::CreateIntent::EquivalentBlocked(record) => {
            let mut result = mutation_result_from_intent(&record)?;
            result.warnings.push(format!(
                "Equivalent order is still {}; reconcile it before another submission",
                record.state.key()
            ));
            result.retry_blocked = true;
            return Ok(result);
        }
        safety::CreateIntent::Created => {}
    }
    if state.safety.lifecycle.is_transitioning() {
        return reject_before_submission(
            &state,
            &mutation_id,
            "Trading is unavailable during an environment transition",
        );
    }
    let _account_guard = state
        .safety
        .account_lock(&environment, &order.account_id)
        .await;
    let (decision, meta) = native_order_risk(&state, &environment, &order).await?;
    record_risk_decision(&state, &mutation_id, &decision);
    if !decision.allowed {
        return reject_before_submission(&state, &mutation_id, &decision.reasons.join("; "));
    }
    safety::update_intent(
        &state.db_path,
        &mutation_id,
        safety::MutationState::Submitting,
        None,
        None,
        "complete",
        "not_required",
        None,
        None,
        false,
    )?;
    let journal_intent = journal::start_entry_intent(&state.db_path, &environment, &order, &meta);
    match state.api.place_order(&order).await {
        Ok(update) => {
            let (broker_object, serialization_warning) =
                confirmed_broker_value(&update, "placed order");
            let journal_result = match &journal_intent {
                Ok(intent) => journal::complete_entry_intent(&state.db_path, intent, &update),
                Err(error) => Err(AppError::Api(error.to_string())),
            };
            let local_warning = combine_warnings([
                serialization_warning,
                journal_result.err().map(|error| {
                    format!(
                        "order {} local journal completion failed: {error}",
                        update.id
                    )
                }),
            ]);
            let persistence = safety::record_confirmed(
                &state.db_path,
                &mutation_id,
                Some(&update.id),
                &broker_object,
                local_warning,
            );
            let warnings = persistence.warnings;
            if !warnings.is_empty() {
                state.safety.enqueue_reconciliation(&mutation_id).await;
            }
            let mut record = audit::AuditRecord::completed(
                "record",
                "journal",
                "place-order",
                if warnings.is_empty() {
                    "success"
                } else {
                    "warning"
                },
                format!("Broker confirmed order {}", update.id),
            );
            record.entity_type = Some("order".into());
            record.entity_id = Some(update.id.clone());
            record.changes = Some(serde_json::json!({
                "mutationId": mutation_id,
                "brokerOutcome": "confirmed",
                "localPersistence": persistence.local_persistence
            }));
            state.audit.record(record);
            let _ = app.emit(
                "broker-mutation-updated",
                serde_json::json!({"mutationId":mutation_id,"state":"accepted"}),
            );
            let _ = app.emit(
                "journal-updated",
                serde_json::json!({"reason":"entry-intent"}),
            );
            schedule_journal_flush(app.clone(), state.db_path.clone());
            Ok(BrokerMutationResult {
                mutation_id,
                broker_outcome: BrokerOutcome::Confirmed,
                local_persistence: if warnings.is_empty() {
                    LocalPersistenceStatus::Complete
                } else {
                    LocalPersistenceStatus::Pending
                },
                reconciliation_status: if warnings.is_empty() {
                    ReconciliationStatus::NotRequired
                } else {
                    ReconciliationStatus::Required
                },
                warnings,
                broker_order: Some(update),
                close_result: None,
                rejection_reason: None,
                retry_blocked: true,
            })
        }
        Err(error) => {
            if let Ok(intent) = journal_intent {
                let _ = journal::fail_entry_intent(&state.db_path, &intent, &error.to_string());
            }
            mutation_error_result(&state, &app, &mutation_id, error).await
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn replace_order(
    account_id: String,
    order_id: String,
    new_price: f64,
    client_mutation_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<BrokerMutationResult, AppError> {
    let environment = state.api.environment().await;
    let mutation_id = mutation_id(client_mutation_id);
    match safety::create_intent(
        &state.db_path,
        safety::NewMutationIntent {
            id: mutation_id.clone(),
            environment: environment.clone(),
            account_id: account_id.clone(),
            kind: "replace_order".into(),
            equivalence_key: format!("replace|{order_id}|{new_price:.10}"),
            symbol: None,
            action: "Replace".into(),
            quantity: None,
            order_type: None,
            limit_price: Some(new_price),
            stop_price: Some(new_price),
            take_profit: None,
            stop_loss: None,
            target_id: Some(order_id.clone()),
            request: serde_json::json!({"orderId":order_id,"newPrice":new_price}),
        },
    )? {
        safety::CreateIntent::Existing(record) => return mutation_result_from_intent(&record),
        safety::CreateIntent::EquivalentBlocked(record) => {
            let mut result = mutation_result_from_intent(&record)?;
            result
                .warnings
                .push("An equivalent replacement is unresolved; normal retry is blocked".into());
            return Ok(result);
        }
        safety::CreateIntent::Created => {}
    }
    if state.safety.lifecycle.is_transitioning() {
        return reject_before_submission(
            &state,
            &mutation_id,
            "Trading is unavailable during an environment transition",
        );
    }
    let _account_guard = state.safety.account_lock(&environment, &account_id).await;
    let original = state
        .api
        .orders(&account_id)
        .await
        .ok()
        .and_then(|orders| orders.into_iter().find(|order| order.id == order_id));
    let old_price = original
        .as_ref()
        .and_then(|order| order.price.or(order.stop_price));
    let journal_requested_warning = if let Some(order) = original.as_ref() {
        journal::record_order_move(
            &state.db_path,
            &environment,
            &account_id,
            order,
            old_price,
            new_price,
            "requested",
            Some("Protective replacement submitted"),
        )
        .err()
        .map(|error| error.to_string())
    } else {
        None
    };
    safety::update_intent(
        &state.db_path,
        &mutation_id,
        safety::MutationState::Submitting,
        None,
        None,
        "complete",
        "not_required",
        None,
        None,
        false,
    )?;
    match state
        .api
        .replace_order(&account_id, &order_id, new_price)
        .await
    {
        Ok(update) => {
            let confirmed_price = update.price.or(update.stop_price).unwrap_or(new_price);
            let local = journal::record_order_move(
                &state.db_path,
                &environment,
                &account_id,
                &update,
                old_price,
                confirmed_price,
                "confirmed",
                None,
            );
            let local_warning = journal_requested_warning
                .or_else(|| local.err().map(|error| error.to_string()))
                .map(|error| {
                    format!(
                        "Broker confirmed replacement, but journal completion is pending: {error}"
                    )
                });
            confirmed_order_result(&state, &app, &mutation_id, update, local_warning).await
        }
        Err(error) => mutation_error_result(&state, &app, &mutation_id, error).await,
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn close_position(
    account_id: String,
    position_id: String,
    client_mutation_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<BrokerMutationResult, AppError> {
    let environment = state.api.environment().await;
    let mutation_id = mutation_id(client_mutation_id);
    match safety::create_intent(
        &state.db_path,
        safety::NewMutationIntent {
            id: mutation_id.clone(),
            environment: environment.clone(),
            account_id: account_id.clone(),
            kind: "close_position".into(),
            equivalence_key: format!("close|{position_id}"),
            symbol: None,
            action: "Close".into(),
            quantity: None,
            order_type: Some("Market".into()),
            limit_price: None,
            stop_price: None,
            take_profit: None,
            stop_loss: None,
            target_id: Some(position_id.clone()),
            request: serde_json::json!({"positionId":position_id}),
        },
    )? {
        safety::CreateIntent::Existing(record) => return mutation_result_from_intent(&record),
        safety::CreateIntent::EquivalentBlocked(record) => {
            let mut result = mutation_result_from_intent(&record)?;
            result.warnings.push(
                "This position already has an unresolved close; reconcile before retrying".into(),
            );
            return Ok(result);
        }
        safety::CreateIntent::Created => {}
    }
    let _account_guard = state.safety.account_lock(&environment, &account_id).await;
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
    let close_requested_warning = if let Some(symbol) = symbol.as_deref() {
        journal::record_close_intent(
            &state.db_path,
            &environment,
            &account_id,
            symbol,
            "requested",
            None,
        )
        .err()
        .map(|error| error.to_string())
    } else {
        None
    };
    safety::update_intent(
        &state.db_path,
        &mutation_id,
        safety::MutationState::Submitting,
        None,
        None,
        "complete",
        "not_required",
        None,
        None,
        false,
    )?;
    let result = state.api.close_position(&account_id, &position_id).await;
    if let Ok(value) = result.as_ref() {
        let local = journal::record_close_intent(
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
        )
        .err()
        .map(|error| error.to_string())
        .or(close_requested_warning)
        .map(|error| {
            format!(
                "Broker close result is authoritative, but journal completion is pending: {error}"
            )
        });
        let (broker_object, serialization_warning) =
            confirmed_broker_value(value, "position close result");
        let local = combine_warnings([local, serialization_warning]);
        if value.error.is_none() {
            let broker_id = value.flatten_order.as_ref().map(|order| order.id.as_str());
            let persistence = safety::record_confirmed(
                &state.db_path,
                &mutation_id,
                broker_id,
                &broker_object,
                local,
            );
            let warnings = persistence.warnings;
            if !warnings.is_empty() {
                state.safety.enqueue_reconciliation(&mutation_id).await;
            }
            return Ok(BrokerMutationResult {
                mutation_id,
                broker_outcome: BrokerOutcome::Confirmed,
                local_persistence: if warnings.is_empty() {
                    LocalPersistenceStatus::Complete
                } else {
                    LocalPersistenceStatus::Pending
                },
                reconciliation_status: if warnings.is_empty() {
                    ReconciliationStatus::NotRequired
                } else {
                    ReconciliationStatus::Required
                },
                warnings,
                broker_order: value.flatten_order.clone(),
                close_result: Some(value.clone()),
                rejection_reason: None,
                retry_blocked: true,
            });
        }
        let message = value
            .error
            .clone()
            .unwrap_or_else(|| "Position close requires reconciliation".into());
        let _ = safety::update_intent(
            &state.db_path,
            &mutation_id,
            safety::MutationState::Unknown,
            None,
            Some(&broker_object),
            if local.is_some() {
                "pending"
            } else {
                "complete"
            },
            "required",
            Some(&message),
            Some(&message),
            false,
        );
        state.safety.enqueue_reconciliation(&mutation_id).await;
        return Ok(BrokerMutationResult {
            mutation_id,
            broker_outcome: BrokerOutcome::Unknown,
            local_persistence: if local.is_some() {
                LocalPersistenceStatus::Pending
            } else {
                LocalPersistenceStatus::Complete
            },
            reconciliation_status: ReconciliationStatus::Required,
            warnings: vec![format!(
                "{message}. Do not submit another close until reconciled."
            )],
            broker_order: value.flatten_order.clone(),
            close_result: Some(value.clone()),
            rejection_reason: None,
            retry_blocked: true,
        });
    }
    mutation_error_result(&state, &app, &mutation_id, result.unwrap_err()).await
}

#[tauri::command(rename_all = "camelCase")]
async fn cancel_order(
    account_id: String,
    order_id: String,
    client_mutation_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<BrokerMutationResult, AppError> {
    let environment = state.api.environment().await;
    let mutation_id = mutation_id(client_mutation_id);
    match safety::create_intent(
        &state.db_path,
        safety::NewMutationIntent {
            id: mutation_id.clone(),
            environment: environment.clone(),
            account_id: account_id.clone(),
            kind: "cancel_order".into(),
            equivalence_key: format!("cancel|{order_id}"),
            symbol: None,
            action: "Cancel".into(),
            quantity: None,
            order_type: None,
            limit_price: None,
            stop_price: None,
            take_profit: None,
            stop_loss: None,
            target_id: Some(order_id.clone()),
            request: serde_json::json!({"orderId":order_id}),
        },
    )? {
        safety::CreateIntent::Existing(record) => return mutation_result_from_intent(&record),
        safety::CreateIntent::EquivalentBlocked(record) => {
            let mut result = mutation_result_from_intent(&record)?;
            result.warnings.push(
                "This cancellation is unresolved; verify broker state before another request"
                    .into(),
            );
            return Ok(result);
        }
        safety::CreateIntent::Created => {}
    }
    let _account_guard = state.safety.account_lock(&environment, &account_id).await;
    let journal_requested =
        journal::record_cancel_intent(&state.db_path, &environment, &order_id, "requested", None);
    safety::update_intent(
        &state.db_path,
        &mutation_id,
        safety::MutationState::Submitting,
        Some(&order_id),
        None,
        "complete",
        "not_required",
        None,
        None,
        false,
    )?;
    match state.api.cancel_order(&order_id).await {
        Ok(()) => {
            let local = journal::record_cancel_intent(
                &state.db_path,
                &environment,
                &order_id,
                "confirmed",
                None,
            );
            let warning = journal_requested
                .err()
                .or_else(|| local.err())
                .map(|error| {
                    format!(
                        "Broker confirmed cancellation, but journal completion is pending: {error}"
                    )
                });
            let broker_object = serde_json::json!({"id":order_id,"status":"Cancelled"});
            let persistence = safety::record_confirmed(
                &state.db_path,
                &mutation_id,
                Some(&order_id),
                &broker_object,
                warning,
            );
            let warnings = persistence.warnings;
            if !warnings.is_empty() {
                state.safety.enqueue_reconciliation(&mutation_id).await;
            }
            Ok(BrokerMutationResult {
                mutation_id,
                broker_outcome: BrokerOutcome::Confirmed,
                local_persistence: if warnings.is_empty() {
                    LocalPersistenceStatus::Complete
                } else {
                    LocalPersistenceStatus::Pending
                },
                reconciliation_status: if warnings.is_empty() {
                    ReconciliationStatus::NotRequired
                } else {
                    ReconciliationStatus::Required
                },
                warnings,
                broker_order: None,
                close_result: None,
                rejection_reason: None,
                retry_blocked: true,
            })
        }
        Err(error) => mutation_error_result(&state, &app, &mutation_id, error).await,
    }
}

fn mutation_id(value: Option<String>) -> String {
    value
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

fn place_equivalence_key(order: &OrderDraft) -> String {
    format!(
        "place|{}|{}|{}|{}|{:?}|{:?}|{:?}|{:?}",
        order.symbol,
        order.side,
        order.quantity,
        order.order_type,
        order.limit_price,
        order.stop_price,
        order.take_profit,
        order.stop_loss
    )
}

fn mutation_result_from_intent(
    intent: &safety::MutationIntent,
) -> Result<BrokerMutationResult, AppError> {
    let broker_order = intent
        .broker_object
        .clone()
        .and_then(|value| serde_json::from_value(value).ok());
    let close_result = intent
        .broker_object
        .clone()
        .and_then(|value| serde_json::from_value(value).ok());
    let broker_outcome = match intent.state {
        safety::MutationState::Accepted | safety::MutationState::Reconciled => {
            BrokerOutcome::Confirmed
        }
        safety::MutationState::Rejected => BrokerOutcome::Rejected,
        _ => BrokerOutcome::Unknown,
    };
    let local_persistence = match intent.local_persistence.as_str() {
        "complete" => LocalPersistenceStatus::Complete,
        "failed" => LocalPersistenceStatus::Failed,
        _ => LocalPersistenceStatus::Pending,
    };
    let reconciliation_status = if intent.manual_review_required {
        ReconciliationStatus::ManualReviewRequired
    } else {
        match intent.reconciliation_status.as_str() {
            "not_required" => ReconciliationStatus::NotRequired,
            "reconciling" => ReconciliationStatus::Reconciling,
            "reconciled" => ReconciliationStatus::Reconciled,
            "failed" => ReconciliationStatus::Failed,
            _ => ReconciliationStatus::Required,
        }
    };
    Ok(BrokerMutationResult {
        mutation_id: intent.id.clone(),
        retry_blocked: !matches!(broker_outcome, BrokerOutcome::Rejected)
            || intent.state.blocks_equivalent_retry(),
        broker_outcome,
        local_persistence,
        reconciliation_status,
        warnings: intent.warning.clone().into_iter().collect(),
        broker_order,
        close_result,
        rejection_reason: intent.error.clone(),
    })
}

fn reject_before_submission(
    state: &NativeState,
    mutation_id: &str,
    reason: &str,
) -> Result<BrokerMutationResult, AppError> {
    safety::update_intent(
        &state.db_path,
        mutation_id,
        safety::MutationState::Rejected,
        None,
        None,
        "complete",
        "not_required",
        None,
        Some(reason),
        false,
    )?;
    Ok(BrokerMutationResult {
        mutation_id: mutation_id.into(),
        broker_outcome: BrokerOutcome::Rejected,
        local_persistence: LocalPersistenceStatus::Complete,
        reconciliation_status: ReconciliationStatus::NotRequired,
        warnings: vec![],
        broker_order: None,
        close_result: None,
        rejection_reason: Some(reason.into()),
        retry_blocked: false,
    })
}

async fn confirmed_order_result(
    state: &NativeState,
    app: &tauri::AppHandle,
    mutation_id: &str,
    update: OrderUpdate,
    local_warning: Option<String>,
) -> Result<BrokerMutationResult, AppError> {
    let (broker_object, serialization_warning) = confirmed_broker_value(&update, "confirmed order");
    let local_warning = combine_warnings([local_warning, serialization_warning]);
    let persistence = safety::record_confirmed(
        &state.db_path,
        mutation_id,
        Some(&update.id),
        &broker_object,
        local_warning,
    );
    let warnings = persistence.warnings;
    if !warnings.is_empty() {
        state.safety.enqueue_reconciliation(mutation_id).await;
    }
    let _ = app.emit(
        "broker-mutation-updated",
        serde_json::json!({"mutationId":mutation_id,"state":"accepted"}),
    );
    Ok(BrokerMutationResult {
        mutation_id: mutation_id.into(),
        broker_outcome: BrokerOutcome::Confirmed,
        local_persistence: if warnings.is_empty() {
            LocalPersistenceStatus::Complete
        } else {
            LocalPersistenceStatus::Pending
        },
        reconciliation_status: if warnings.is_empty() {
            ReconciliationStatus::NotRequired
        } else {
            ReconciliationStatus::Required
        },
        warnings,
        broker_order: Some(update),
        close_result: None,
        rejection_reason: None,
        retry_blocked: true,
    })
}

fn confirmed_broker_value<T: serde::Serialize>(
    value: &T,
    description: &str,
) -> (Value, Option<String>) {
    match serde_json::to_value(value) {
        Ok(value) => (value, None),
        Err(error) => (
            Value::Null,
            Some(format!(
                "Broker confirmed the {description}, but its local durable representation could not be serialized: {error}"
            )),
        ),
    }
}

fn combine_warnings<const N: usize>(warnings: [Option<String>; N]) -> Option<String> {
    let warnings = warnings.into_iter().flatten().collect::<Vec<_>>();
    (!warnings.is_empty()).then(|| warnings.join("; "))
}

async fn mutation_error_result(
    state: &NativeState,
    app: &tauri::AppHandle,
    mutation_id: &str,
    error: AppError,
) -> Result<BrokerMutationResult, AppError> {
    let message = error.to_string();
    let clearly_rejected = matches!(
        error,
        AppError::BrokerRejected(_)
            | AppError::Validation(_)
            | AppError::AuthenticationRequired
            | AppError::RateLimited { .. }
            | AppError::Api(_)
    );
    if clearly_rejected {
        safety::update_intent(
            &state.db_path,
            mutation_id,
            safety::MutationState::Rejected,
            None,
            None,
            "complete",
            "not_required",
            None,
            Some(&message),
            false,
        )?;
        let _ = app.emit(
            "broker-mutation-updated",
            serde_json::json!({"mutationId":mutation_id,"state":"rejected"}),
        );
        return Ok(BrokerMutationResult {
            mutation_id: mutation_id.into(),
            broker_outcome: BrokerOutcome::Rejected,
            local_persistence: LocalPersistenceStatus::Complete,
            reconciliation_status: ReconciliationStatus::NotRequired,
            warnings: vec![],
            broker_order: None,
            close_result: None,
            rejection_reason: Some(message),
            retry_blocked: false,
        });
    }
    let warning = format!(
        "Broker outcome is unknown: {message}. Do not retry this action until reconciliation completes."
    );
    let _ = safety::update_intent(
        &state.db_path,
        mutation_id,
        safety::MutationState::Unknown,
        None,
        None,
        "complete",
        "required",
        Some(&warning),
        Some(&message),
        false,
    );
    state.safety.enqueue_reconciliation(mutation_id).await;
    let _ = app.emit(
        "broker-mutation-updated",
        serde_json::json!({"mutationId":mutation_id,"state":"reconciling"}),
    );
    match reconcile_intent(&state.api, &state.db_path, mutation_id, None).await {
        Ok(record) => mutation_result_from_intent(&record),
        Err(reconciliation_error) => {
            let detail =
                format!("{warning} Immediate reconciliation also failed: {reconciliation_error}");
            let _ = safety::update_intent(
                &state.db_path,
                mutation_id,
                safety::MutationState::ReconciliationFailed,
                None,
                None,
                "pending",
                "failed",
                Some(&detail),
                Some(&message),
                false,
            );
            Ok(BrokerMutationResult {
                mutation_id: mutation_id.into(),
                broker_outcome: BrokerOutcome::Unknown,
                local_persistence: LocalPersistenceStatus::Pending,
                reconciliation_status: ReconciliationStatus::Failed,
                warnings: vec![detail],
                broker_order: None,
                close_result: None,
                rejection_reason: None,
                retry_blocked: true,
            })
        }
    }
}

async fn native_order_risk(
    state: &NativeState,
    environment: &TradingEnvironment,
    order: &OrderDraft,
) -> Result<(safety::RiskDecision, SymbolMeta), AppError> {
    let policy = safety::load_policy(&state.db_path, environment, &order.account_id)?;
    let meta = state.api.symbol_details(&order.symbol).await?;
    let (positions, orders, balances, quotes) = tokio::join!(
        state.api.positions(&order.account_id),
        state.api.orders(&order.account_id),
        state.api.balances(&order.account_id, false),
        state.api.quotes(std::slice::from_ref(&order.symbol)),
    );
    let mut unavailable = Vec::new();
    let positions = positions.unwrap_or_else(|error| {
        unavailable.push(format!("fresh positions: {error}"));
        vec![]
    });
    let orders = orders.unwrap_or_else(|error| {
        unavailable.push(format!("fresh working orders: {error}"));
        vec![]
    });
    let balances = balances.unwrap_or_else(|error| {
        unavailable.push(format!("fresh account balances: {error}"));
        vec![]
    });
    let market_price = quotes
        .map(|quotes| {
            quotes
                .into_iter()
                .find(|quote| quote.symbol == order.symbol)
                .map(|quote| quote.last)
        })
        .unwrap_or_else(|error| {
            unavailable.push(format!("fresh quote: {error}"));
            None
        });
    let mut contract_metadata = HashMap::from([(order.symbol.clone(), meta.clone())]);
    let metadata_symbols = positions
        .iter()
        .map(|position| position.symbol.clone())
        .filter(|symbol| !contract_metadata.contains_key(symbol))
        .collect::<BTreeSet<_>>();
    for (symbol, result) in
        futures_util::future::join_all(metadata_symbols.into_iter().map(|symbol| {
            let api = state.api.clone();
            async move {
                let result = api.symbol_details(&symbol).await;
                (symbol, result)
            }
        }))
        .await
    {
        match result {
            Ok(meta) => {
                contract_metadata.insert(symbol, meta);
            }
            Err(error) => unavailable.push(format!("contract metadata for {symbol}: {error}")),
        }
    }
    let recent_count = if policy.order_rate.enabled {
        let protection_seconds = policy
            .order_rate
            .window_seconds
            .max(policy.order_rate.cooldown_seconds)
            .max(1);
        let since = Utc::now() - chrono::Duration::seconds(protection_seconds as i64);
        safety::recent_accepted_order_count(&state.db_path, environment, &order.account_id, since)
            .ok()
    } else {
        Some(0)
    };
    let consecutive_losses = if policy.consecutive_loss_cooldown.enabled {
        match safety::consecutive_losses(&state.db_path, environment, &order.account_id) {
            Ok(Some(value)) => Some(value),
            Ok(None) => Some((0, Utc::now())),
            Err(error) => {
                unavailable.push(format!("consecutive-loss history: {error}"));
                None
            }
        }
    } else {
        Some((0, Utc::now()))
    };
    let mut decision = safety::evaluate_risk(
        &policy,
        safety::RiskContext {
            draft: order,
            meta: &meta,
            contract_metadata: &contract_metadata,
            positions: &positions,
            orders: &orders,
            balances: &balances,
            market_price,
            recent_order_count: recent_count,
            consecutive_losses,
            now: Utc::now(),
        },
    );
    if decision.risk_increasing
        && matches!(environment, TradingEnvironment::Live)
        && !unavailable.is_empty()
    {
        decision.reasons.push(format!(
            "LIVE risk check failed closed because required brokerage data is unavailable ({})",
            unavailable.join(", ")
        ));
        decision.allowed = false;
    }
    Ok((decision, meta))
}

fn record_risk_decision(state: &NativeState, mutation_id: &str, decision: &safety::RiskDecision) {
    let mut record = audit::AuditRecord::completed(
        "record",
        "risk",
        "native-risk-decision",
        if decision.allowed { "success" } else { "error" },
        if decision.allowed {
            "Native risk policy allowed broker submission"
        } else {
            "Native risk policy blocked broker submission"
        },
    );
    record.entity_type = Some("broker-mutation".into());
    record.entity_id = Some(mutation_id.into());
    record.changes = Some(serde_json::json!({
        "allowed": decision.allowed,
        "riskIncreasing": decision.risk_increasing,
        "reasons": decision.reasons,
        "estimatedTradeRisk": decision.estimated_trade_risk,
        "estimatedAggregateRisk": decision.estimated_aggregate_risk
    }));
    state.audit.record(record);
}

async fn reconcile_intent(
    api: &TradeStation,
    db_path: &std::path::Path,
    mutation_id: &str,
    manual_broker_id: Option<&str>,
) -> Result<safety::MutationIntent, AppError> {
    let intent = safety::load_intent(db_path, mutation_id)?
        .ok_or_else(|| AppError::Validation("Mutation intent was not found".into()))?;
    if matches!(
        intent.state,
        safety::MutationState::Accepted | safety::MutationState::Reconciled
    ) && intent.local_persistence != "complete"
        && intent.broker_object.is_some()
    {
        safety::update_intent(
            db_path,
            mutation_id,
            intent.state.clone(),
            intent.broker_id.as_deref(),
            intent.broker_object.as_ref(),
            &intent.local_persistence,
            "reconciling",
            intent.warning.as_deref(),
            intent.error.as_deref(),
            false,
        )?;
        match repair_confirmed_local_persistence(api, db_path, &intent).await {
            Ok(()) => safety::update_intent(
                db_path,
                mutation_id,
                intent.state.clone(),
                intent.broker_id.as_deref(),
                intent.broker_object.as_ref(),
                "complete",
                "reconciled",
                None,
                None,
                false,
            )?,
            Err(error) => {
                let warning = format!(
                    "Broker remains confirmed, but local persistence repair failed: {error}"
                );
                safety::update_intent(
                    db_path,
                    mutation_id,
                    intent.state.clone(),
                    intent.broker_id.as_deref(),
                    intent.broker_object.as_ref(),
                    "pending",
                    "failed",
                    Some(&warning),
                    Some(&error.to_string()),
                    false,
                )?;
            }
        }
        return safety::load_intent(db_path, mutation_id)?
            .ok_or_else(|| AppError::Api("Reconciled intent disappeared".into()));
    }
    safety::update_intent(
        db_path,
        mutation_id,
        safety::MutationState::Reconciling,
        None,
        None,
        &intent.local_persistence,
        "reconciling",
        intent.warning.as_deref(),
        intent.error.as_deref(),
        false,
    )?;
    let orders = api.orders(&intent.account_id).await;
    let positions = if intent.kind == "close_position" {
        Some(api.positions(&intent.account_id).await)
    } else {
        None
    };
    let resolution: Option<Result<OrderUpdate, String>> = match intent.kind.as_str() {
        "place_order" => {
            let orders = orders?;
            let candidates = place_reconciliation_candidates(&intent, &orders, manual_broker_id);
            if candidates.len() == 1 {
                Some(Ok(candidates[0].clone()))
            } else if candidates.len() > 1 {
                Some(Err(
                    "Multiple broker orders match this intent; manual review is required".into(),
                ))
            } else {
                None
            }
        }
        "replace_order" => {
            let orders = orders?;
            orders
                .into_iter()
                .find(|order| {
                    intent.target_id.as_deref() == Some(order.id.as_str())
                        && order
                            .price
                            .or(order.stop_price)
                            .zip(intent.limit_price)
                            .is_some_and(|(actual, requested)| (actual - requested).abs() < 1e-7)
                })
                .map(Ok)
        }
        "cancel_order" => {
            let orders = orders?;
            orders
                .into_iter()
                .find(|order| intent.target_id.as_deref() == Some(order.id.as_str()))
                .and_then(|order| (order.status == "Cancelled").then_some(Ok(order)))
        }
        "close_position" => {
            let positions = positions.expect("close positions request")?;
            if positions
                .iter()
                .all(|position| intent.target_id.as_deref() != Some(position.id.as_str()))
            {
                let value = ClosePositionResult {
                    position_id: intent.target_id.clone().unwrap_or_default(),
                    symbol: intent.symbol.clone().unwrap_or_default(),
                    cancelled_order_ids: vec![],
                    flatten_order: None,
                    error: None,
                };
                safety::update_intent(
                    db_path,
                    mutation_id,
                    safety::MutationState::Reconciled,
                    None,
                    Some(&serde_json::to_value(value)?),
                    &intent.local_persistence,
                    "reconciled",
                    intent.warning.as_deref(),
                    None,
                    false,
                )?;
                return safety::load_intent(db_path, mutation_id)?
                    .ok_or_else(|| AppError::Api("Reconciled intent disappeared".into()));
            }
            None
        }
        _ => Some(Err(
            "Unsupported mutation type requires manual review".into()
        )),
    };
    match resolution {
        Some(Ok(order)) => {
            safety::update_intent(
                db_path,
                mutation_id,
                safety::MutationState::Reconciled,
                Some(&order.id),
                Some(&serde_json::to_value(&order)?),
                &intent.local_persistence,
                "reconciled",
                intent.warning.as_deref(),
                None,
                false,
            )?;
        }
        Some(Err(message)) => {
            safety::update_intent(
                db_path,
                mutation_id,
                safety::MutationState::ReconciliationFailed,
                None,
                None,
                &intent.local_persistence,
                "failed",
                Some(&message),
                Some(&message),
                true,
            )?;
        }
        None => {
            safety::update_intent(
                db_path,
                mutation_id,
                safety::MutationState::Unknown,
                None,
                None,
                &intent.local_persistence,
                "required",
                Some("No unambiguous broker match was found; normal retry remains blocked"),
                intent.error.as_deref(),
                false,
            )?;
        }
    }
    safety::load_intent(db_path, mutation_id)?
        .ok_or_else(|| AppError::Api("Reconciled intent disappeared".into()))
}

fn place_reconciliation_candidates(
    intent: &safety::MutationIntent,
    orders: &[OrderUpdate],
    manual_broker_id: Option<&str>,
) -> Vec<OrderUpdate> {
    let created = DateTime::parse_from_rfc3339(&intent.created_at)
        .ok()
        .map(|value| value.with_timezone(&Utc));
    orders
        .iter()
        .filter(|order| {
            let core_matches = intent.symbol.as_deref() == Some(order.symbol.as_str())
                && intent.action == order.side
                && intent.quantity == Some(order.quantity as f64)
                && intent.order_type.as_deref() == Some(order.order_type.as_str())
                && intent
                    .limit_price
                    .zip(order.price)
                    .map(|(expected, actual)| (expected - actual).abs() < 1e-7)
                    .unwrap_or(intent.limit_price.is_none())
                && intent
                    .stop_price
                    .zip(order.stop_price)
                    .map(|(expected, actual)| (expected - actual).abs() < 1e-7)
                    .unwrap_or(intent.stop_price.is_none())
                && intent
                    .request
                    .get("duration")
                    .and_then(Value::as_str)
                    .zip(order.duration.as_deref())
                    .map(|(expected, actual)| expected == actual)
                    .unwrap_or(true);
            core_matches
                && manual_broker_id
                    .map(|id| id == order.id)
                    .unwrap_or_else(|| {
                        created.is_some_and(|created| {
                            DateTime::parse_from_rfc3339(&order.timestamp)
                                .ok()
                                .map(|time| {
                                    (time.with_timezone(&Utc) - created).num_seconds().abs() <= 600
                                })
                                .unwrap_or(false)
                        })
                    })
        })
        .cloned()
        .collect()
}

async fn repair_confirmed_local_persistence(
    api: &TradeStation,
    db_path: &std::path::Path,
    intent: &safety::MutationIntent,
) -> Result<(), AppError> {
    match intent.kind.as_str() {
        "place_order" => {
            let draft: OrderDraft = serde_json::from_value(intent.request.clone())?;
            let order: OrderUpdate =
                serde_json::from_value(intent.broker_object.clone().ok_or_else(|| {
                    AppError::Validation("Confirmed order object is missing".into())
                })?)?;
            let meta = api.symbol_details(&draft.symbol).await?;
            let journal_intent =
                journal::start_entry_intent(db_path, &intent.environment, &draft, &meta)?;
            journal::complete_entry_intent(db_path, &journal_intent, &order)
        }
        "replace_order" => {
            let order: OrderUpdate =
                serde_json::from_value(intent.broker_object.clone().ok_or_else(|| {
                    AppError::Validation("Confirmed order object is missing".into())
                })?)?;
            let new_price = order
                .price
                .or(order.stop_price)
                .or(intent.limit_price)
                .ok_or_else(|| AppError::Validation("Replacement price is missing".into()))?;
            journal::record_order_move(
                db_path,
                &intent.environment,
                &intent.account_id,
                &order,
                None,
                new_price,
                "confirmed",
                Some("Recovered from durable broker mutation"),
            )
        }
        "cancel_order" => journal::record_cancel_intent(
            db_path,
            &intent.environment,
            intent
                .target_id
                .as_deref()
                .ok_or_else(|| AppError::Validation("Cancelled order ID is missing".into()))?,
            "confirmed",
            Some("Recovered from durable broker mutation"),
        ),
        "close_position" => {
            let close: ClosePositionResult =
                serde_json::from_value(intent.broker_object.clone().ok_or_else(|| {
                    AppError::Validation("Confirmed close object is missing".into())
                })?)?;
            journal::record_close_intent(
                db_path,
                &intent.environment,
                &intent.account_id,
                &close.symbol,
                "confirmed",
                Some("Recovered from durable broker mutation"),
            )
        }
        _ => Err(AppError::Validation(
            "This confirmed mutation type cannot be repaired automatically".into(),
        )),
    }
}

async fn reconcile_unresolved(api: TradeStation, db_path: PathBuf) {
    let Ok(intents) = safety::unresolved_intents(&db_path) else {
        return;
    };
    let environment = api.environment().await;
    for intent in intents {
        if intent.environment != environment {
            continue;
        }
        if let Err(error) = reconcile_intent(&api, &db_path, &intent.id, None).await {
            let warning = format!("Automatic reconciliation could not query broker state: {error}");
            let state = if matches!(
                intent.state,
                safety::MutationState::Accepted | safety::MutationState::Reconciled
            ) {
                intent.state.clone()
            } else {
                safety::MutationState::Unknown
            };
            let _ = safety::update_intent(
                &db_path,
                &intent.id,
                state,
                intent.broker_id.as_deref(),
                intent.broker_object.as_ref(),
                &intent.local_persistence,
                "failed",
                Some(&warning),
                Some(&error.to_string()),
                false,
            );
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn get_risk_policy(
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<safety::RiskPolicyStatus, AppError> {
    let environment = state.api.environment().await;
    let policy = safety::load_policy(&state.db_path, &environment, &account_id)?;
    Ok(state.safety.status(environment, account_id, policy))
}

#[tauri::command(rename_all = "camelCase")]
async fn save_risk_policy(
    account_id: String,
    policy: safety::RiskPolicy,
    state: State<'_, NativeState>,
) -> Result<safety::RiskPolicyStatus, AppError> {
    let environment = state.api.environment().await;
    safety::save_policy(&state.db_path, &environment, &account_id, &policy)?;
    Ok(state.safety.status(environment, account_id, policy))
}

#[tauri::command(rename_all = "camelCase")]
fn list_broker_mutations(
    environment: TradingEnvironment,
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<Vec<safety::MutationIntent>, AppError> {
    safety::list_intents(&state.db_path, &environment, &account_id)
}

#[tauri::command(rename_all = "camelCase")]
async fn reconcile_broker_mutation(
    mutation_id: String,
    broker_order_id: Option<String>,
    confirmation: String,
    state: State<'_, NativeState>,
) -> Result<BrokerMutationResult, AppError> {
    if broker_order_id.is_some() && confirmation.trim() != format!("RECONCILE {mutation_id}") {
        return Err(AppError::Validation(format!(
            "Type RECONCILE {mutation_id} to apply a manual broker match"
        )));
    }
    let intent = safety::load_intent(&state.db_path, &mutation_id)?
        .ok_or_else(|| AppError::Validation("Mutation intent was not found".into()))?;
    if intent.environment != state.api.environment().await {
        return Err(AppError::Validation(
            "Switch to the mutation's original environment before reconciling it".into(),
        ));
    }
    let _guard = state
        .safety
        .account_lock(&intent.environment, &intent.account_id)
        .await;
    let record = reconcile_intent(
        &state.api,
        &state.db_path,
        &mutation_id,
        broker_order_id.as_deref(),
    )
    .await?;
    mutation_result_from_intent(&record)
}

#[tauri::command(rename_all = "camelCase")]
async fn kill_switch(
    account_id: String,
    confirmation: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<KillSwitchResult, AppError> {
    let environment = state.api.environment().await;
    if matches!(environment, TradingEnvironment::Live)
        && confirmation.trim() != format!("FLATTEN LIVE {account_id}")
    {
        return Err(AppError::Validation(format!(
            "Type FLATTEN LIVE {account_id} to use the LIVE kill switch"
        )));
    }
    let _guard = state.safety.account_lock(&environment, &account_id).await;
    let (orders, positions) = tokio::join!(
        state.api.orders(&account_id),
        state.api.positions(&account_id)
    );
    let orders = orders?;
    let positions = positions?;
    let mut cancelled_orders = Vec::new();
    for order in orders
        .into_iter()
        .filter(|order| matches!(order.status.as_str(), "Working" | "Pending"))
    {
        let mutation_id = uuid::Uuid::new_v4().to_string();
        let created = safety::create_intent_with_recent_confirmed_guard(
            &state.db_path,
            safety::NewMutationIntent {
                id: mutation_id.clone(),
                environment: environment.clone(),
                account_id: account_id.clone(),
                kind: "cancel_order".into(),
                equivalence_key: format!("cancel|{}", order.id),
                symbol: Some(order.symbol.clone()),
                action: "Cancel".into(),
                quantity: Some(order.quantity as f64),
                order_type: Some(order.order_type.clone()),
                limit_price: order.price,
                stop_price: order.stop_price,
                take_profit: None,
                stop_loss: None,
                target_id: Some(order.id.clone()),
                request: serde_json::json!({"killSwitch":true,"orderId":order.id}),
            },
            Some(15 * 60),
        )?;
        let result = match created {
            safety::CreateIntent::EquivalentBlocked(record)
            | safety::CreateIntent::Existing(record) => mutation_result_from_intent(&record)?,
            safety::CreateIntent::Created => {
                safety::update_intent(
                    &state.db_path,
                    &mutation_id,
                    safety::MutationState::Submitting,
                    Some(&order.id),
                    None,
                    "complete",
                    "not_required",
                    None,
                    None,
                    false,
                )?;
                match state.api.cancel_order(&order.id).await {
                    Ok(()) => {
                        let broker_object = serde_json::json!({"id":order.id,"status":"Cancelled"});
                        let persistence = safety::record_confirmed(
                            &state.db_path,
                            &mutation_id,
                            Some(&order.id),
                            &broker_object,
                            None,
                        );
                        let warnings = persistence.warnings;
                        if !warnings.is_empty() {
                            state.safety.enqueue_reconciliation(&mutation_id).await;
                        }
                        BrokerMutationResult {
                            mutation_id: mutation_id.clone(),
                            broker_outcome: BrokerOutcome::Confirmed,
                            local_persistence: if warnings.is_empty() {
                                LocalPersistenceStatus::Complete
                            } else {
                                LocalPersistenceStatus::Pending
                            },
                            reconciliation_status: if warnings.is_empty() {
                                ReconciliationStatus::NotRequired
                            } else {
                                ReconciliationStatus::Required
                            },
                            warnings,
                            broker_order: None,
                            close_result: None,
                            rejection_reason: None,
                            retry_blocked: true,
                        }
                    }
                    Err(error) => mutation_error_result(&state, &app, &mutation_id, error).await?,
                }
            }
        };
        cancelled_orders.push(KillSwitchItemResult {
            item_type: "order".into(),
            item_id: order.id,
            symbol: Some(order.symbol),
            result,
        });
    }
    let mut flattened_positions = Vec::new();
    for position in positions {
        let mutation_id = uuid::Uuid::new_v4().to_string();
        let equivalence_key = format!(
            "close|{}|{:.10}|{:.10}",
            position.id,
            position.quantity.abs(),
            position.average_price
        );
        let created = safety::create_intent_with_recent_confirmed_guard(
            &state.db_path,
            safety::NewMutationIntent {
                id: mutation_id.clone(),
                environment: environment.clone(),
                account_id: account_id.clone(),
                kind: "close_position".into(),
                equivalence_key,
                symbol: Some(position.symbol.clone()),
                action: "Close".into(),
                quantity: Some(position.quantity.abs()),
                order_type: Some("Market".into()),
                limit_price: None,
                stop_price: None,
                take_profit: None,
                stop_loss: None,
                target_id: Some(position.id.clone()),
                request: serde_json::json!({"killSwitch":true,"positionId":position.id}),
            },
            Some(15 * 60),
        )?;
        let result = match created {
            safety::CreateIntent::EquivalentBlocked(record)
            | safety::CreateIntent::Existing(record) => mutation_result_from_intent(&record)?,
            safety::CreateIntent::Created => {
                safety::update_intent(
                    &state.db_path,
                    &mutation_id,
                    safety::MutationState::Submitting,
                    None,
                    None,
                    "complete",
                    "not_required",
                    None,
                    None,
                    false,
                )?;
                match state.api.close_position(&account_id, &position.id).await {
                    Ok(close) if close.error.is_none() => {
                        let broker_order = close.flatten_order.clone();
                        let (broker_object, serialization_warning) =
                            confirmed_broker_value(&close, "kill-switch close result");
                        let persistence = safety::record_confirmed(
                            &state.db_path,
                            &mutation_id,
                            broker_order.as_ref().map(|order| order.id.as_str()),
                            &broker_object,
                            serialization_warning,
                        );
                        let warnings = persistence.warnings;
                        if !warnings.is_empty() {
                            state.safety.enqueue_reconciliation(&mutation_id).await;
                        }
                        BrokerMutationResult {
                            mutation_id: mutation_id.clone(),
                            broker_outcome: BrokerOutcome::Confirmed,
                            local_persistence: if warnings.is_empty() {
                                LocalPersistenceStatus::Complete
                            } else {
                                LocalPersistenceStatus::Pending
                            },
                            reconciliation_status: if warnings.is_empty() {
                                ReconciliationStatus::NotRequired
                            } else {
                                ReconciliationStatus::Required
                            },
                            warnings,
                            broker_order,
                            close_result: Some(close),
                            rejection_reason: None,
                            retry_blocked: true,
                        }
                    }
                    Ok(close) => {
                        let message = close.error.clone().unwrap_or_default();
                        let broker_object = serde_json::to_value(&close).unwrap_or(Value::Null);
                        let _ = safety::update_intent(
                            &state.db_path,
                            &mutation_id,
                            safety::MutationState::Unknown,
                            None,
                            Some(&broker_object),
                            "complete",
                            "required",
                            Some(&message),
                            Some(&message),
                            false,
                        );
                        BrokerMutationResult {
                            mutation_id: mutation_id.clone(),
                            broker_outcome: BrokerOutcome::Unknown,
                            local_persistence: LocalPersistenceStatus::Complete,
                            reconciliation_status: ReconciliationStatus::Required,
                            warnings: vec![message],
                            broker_order: close.flatten_order.clone(),
                            close_result: Some(close),
                            rejection_reason: None,
                            retry_blocked: true,
                        }
                    }
                    Err(error) => mutation_error_result(&state, &app, &mutation_id, error).await?,
                }
            }
        };
        flattened_positions.push(KillSwitchItemResult {
            item_type: "position".into(),
            item_id: position.id,
            symbol: Some(position.symbol),
            result,
        });
    }
    Ok(KillSwitchResult {
        environment,
        account_id,
        already_flat: cancelled_orders.is_empty() && flattened_positions.is_empty(),
        cancelled_orders,
        flattened_positions,
    })
}

#[tauri::command]
fn load_workspace(state: State<'_, NativeState>) -> Result<Option<Value>, AppError> {
    storage::load_workspace(&state.db_path)
}

#[tauri::command(rename_all = "camelCase")]
fn save_workspace(
    workspace: Value,
    cloud_profile: Option<Value>,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let previous = storage::load_workspace(&state.db_path)?;
    storage::save_workspace(&state.db_path, &workspace, cloud_profile.as_ref())?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "sqlite",
        "save-workspace",
        "success",
        "Workspace and local preference records were saved",
    );
    record.entity_type = Some("workspace".into());
    record.entity_id = Some("primary".into());
    record.changes = Some(serde_json::json!({"before": previous, "after": workspace}));
    state.audit.record(record);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn get_audit_events(
    filters: audit::AuditFilters,
    cursor: Option<String>,
    limit: Option<usize>,
    state: State<'_, NativeState>,
) -> Result<audit::AuditPage, AppError> {
    audit::query(
        &state.db_path,
        &filters,
        cursor.as_deref(),
        limit.unwrap_or(100),
        state.audit.health(),
    )
}

#[tauri::command]
fn get_audit_health(state: State<'_, NativeState>) -> audit::AuditHealth {
    state.audit.health()
}

#[tauri::command(rename_all = "camelCase")]
fn export_audit_events(
    filters: audit::AuditFilters,
    state: State<'_, NativeState>,
) -> Result<String, AppError> {
    audit::export_json(&state.db_path, &filters, state.audit.health())
}

#[tauri::command]
fn record_client_audit(event: Value, state: State<'_, NativeState>) {
    let operation = event
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let status = event
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("success");
    let category = event
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or("api");
    let mut record = audit::AuditRecord::completed(
        category,
        "app-bridge",
        operation,
        status,
        format!(
            "{} {}",
            operation,
            if status == "error" {
                "failed"
            } else {
                "completed"
            }
        ),
    );
    record.duration_ms = event.get("durationMs").and_then(Value::as_i64);
    record.request = event.get("request").cloned();
    record.response = event.get("response").cloned();
    record.error = event
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_owned);
    state.audit.record(record);
}

#[tauri::command]
fn get_trading_today_cache(
    date: String,
    state: State<'_, NativeState>,
) -> Result<Option<trading_today::TradingTodaySnapshot>, AppError> {
    trading_today::get_cache(&state.db_path, &date)
}

#[tauri::command]
async fn refresh_trading_today(
    date: String,
    state: State<'_, NativeState>,
) -> Result<trading_today::TradingTodaySnapshot, AppError> {
    let span = state.audit.begin_api(
        "trading-economics",
        "refresh-calendar",
        "GET",
        trading_today::source_url("calendar")?,
        Some(serde_json::json!({"date": date})),
        Some(uuid::Uuid::new_v4().to_string()),
    );
    match trading_today::refresh(&state.db_path, &date).await {
        Ok(snapshot) => {
            span.success(Some(200), Some(serde_json::to_value(&snapshot)?));
            let mut record = audit::AuditRecord::completed(
                "record",
                "sqlite",
                "save-trading-calendar-cache",
                "success",
                format!("Cached the Trading Today snapshot for {date}"),
            );
            record.entity_type = Some("trading-calendar-cache".into());
            record.entity_id = Some(date);
            record.record_count = Some(snapshot.events.len() as i64);
            state.audit.record(record);
            Ok(snapshot)
        }
        Err(error) => {
            span.error(None, error.to_string());
            Err(error)
        }
    }
}

#[tauri::command]
fn open_trading_today_source(source: String) -> Result<(), AppError> {
    let url = trading_today::source_url(&source)?;
    open::that(url)
        .map_err(|error| AppError::Api(format!("Could not open Trading Today source: {error}")))
}

#[tauri::command]
async fn fetch_truth_social_posts(
    state: State<'_, NativeState>,
) -> Result<Vec<truth_social::TruthSocialPost>, AppError> {
    let span = state.audit.begin_api(
        "roll-call",
        "fetch-truth-social-posts",
        "GET",
        truth_social::FEED_URL,
        None,
        Some(uuid::Uuid::new_v4().to_string()),
    );
    match truth_social::fetch_latest().await {
        Ok(posts) => {
            span.success(Some(200), Some(serde_json::json!({ "postCount": posts.len() })));
            Ok(posts)
        }
        Err(error) => {
            span.error(None, error.to_string());
            Err(error)
        }
    }
}

#[tauri::command]
fn open_truth_social_post(url: String) -> Result<(), AppError> {
    let url = truth_social::validate_post_url(&url)?;
    open::that(url.as_str())
        .map_err(|error| AppError::Api(format!("Could not open Truth Social post: {error}")))
}

#[tauri::command(rename_all = "camelCase")]
async fn sync_app_preferences(
    cloud_profile: Value,
    state: State<'_, NativeState>,
) -> Result<journal::PreferenceSyncResult, AppError> {
    journal::sync_app_preferences(&state.db_path, &cloud_profile).await
}

fn emit_preference_realtime_state(app: &tauri::AppHandle, state: &str, message: Option<String>) {
    let _ = app.emit(
        "app-preferences-realtime-state",
        serde_json::json!({"state":state,"message":message}),
    );
}

fn preference_realtime_url(project_url: &str, publishable_key: &str) -> Result<url::Url, AppError> {
    let mut url = url::Url::parse(project_url)?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => {
            return Err(AppError::Validation(format!(
                "Unsupported Supabase URL scheme: {other}"
            )))
        }
    };
    url.set_scheme(scheme)
        .map_err(|_| AppError::Validation("Invalid Supabase Realtime URL".into()))?;
    url.set_path("/realtime/v1/websocket");
    url.set_query(None);
    url.query_pairs_mut()
        .append_pair("apikey", publishable_key)
        .append_pair("vsn", "1.0.0");
    Ok(url)
}

fn realtime_preference_record(payload: &Value) -> Option<&Value> {
    payload
        .pointer("/data/record")
        .or_else(|| payload.pointer("/data/new"))
        .or_else(|| payload.get("record"))
}

async fn run_preference_realtime_session(
    app: &tauri::AppHandle,
    credentials: &journal::PreferenceRealtimeCredentials,
) -> Result<(), AppError> {
    let url = preference_realtime_url(&credentials.project_url, &credentials.publishable_key)?;
    let (socket, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .map_err(|error| AppError::Api(format!("Supabase Realtime connection failed: {error}")))?;
    let (mut writer, mut reader) = socket.split();
    let topic = format!("realtime:app-preferences-{}", credentials.user_id);
    let join_ref = "1";
    let join = serde_json::json!({
        "topic": topic,
        "event": "phx_join",
        "payload": {
            "config": {
                "broadcast": {"ack": false, "self": false},
                "presence": {"enabled": false},
                "postgres_changes": [{
                    "event": "*",
                    "schema": "public",
                    "table": "app_preferences",
                    "filter": format!("user_id=eq.{}", credentials.user_id)
                }],
                "private": false
            },
            "access_token": credentials.access_token
        },
        "ref": join_ref,
        "join_ref": join_ref
    });
    writer
        .send(tokio_tungstenite::tungstenite::Message::Text(
            join.to_string().into(),
        ))
        .await
        .map_err(|error| AppError::Api(format!("Supabase Realtime join failed: {error}")))?;

    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(25));
    heartbeat.tick().await;
    let refresh = tokio::time::sleep(credentials.refresh_after);
    tokio::pin!(refresh);
    let mut heartbeat_ref = 1u64;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                heartbeat_ref = heartbeat_ref.wrapping_add(1);
                let message = serde_json::json!({
                    "topic":"phoenix",
                    "event":"heartbeat",
                    "payload":{},
                    "ref":heartbeat_ref.to_string()
                });
                writer.send(tokio_tungstenite::tungstenite::Message::Text(message.to_string().into()))
                    .await
                    .map_err(|error| AppError::Api(format!("Supabase Realtime heartbeat failed: {error}")))?;
            }
            _ = &mut refresh => return Ok(()),
            incoming = reader.next() => {
                let Some(incoming) = incoming else {
                    return Err(AppError::Api("Supabase Realtime connection ended".into()));
                };
                let message = incoming
                    .map_err(|error| AppError::Api(format!("Supabase Realtime read failed: {error}")))?;
                match message {
                    tokio_tungstenite::tungstenite::Message::Text(text) => {
                        let value: Value = serde_json::from_str(text.as_ref())?;
                        let event = value.get("event").and_then(Value::as_str).unwrap_or_default();
                        if event == "phx_reply" && value.get("ref").and_then(Value::as_str) == Some(join_ref) {
                            let status = value.pointer("/payload/status").and_then(Value::as_str).unwrap_or("error");
                            if status != "ok" {
                                let reason = value.pointer("/payload/response/reason").and_then(Value::as_str).unwrap_or("subscription rejected");
                                return Err(AppError::Api(format!("Supabase Realtime join failed: {reason}. Apply the latest Supabase migration")));
                            }
                            emit_preference_realtime_state(app, "connected", None);
                        } else if event == "postgres_changes" {
                            if let Some(record) = realtime_preference_record(value.get("payload").unwrap_or(&Value::Null)) {
                                let device_id = record.get("device_id").and_then(Value::as_str).unwrap_or_default();
                                if device_id != credentials.device_id {
                                    let _ = app.emit(
                                        "app-preferences-changed",
                                        serde_json::json!({
                                            "category":record.get("category").and_then(Value::as_str),
                                            "revision":record.get("revision").and_then(Value::as_i64)
                                        }),
                                    );
                                }
                            }
                        } else if matches!(event, "phx_error" | "phx_close") {
                            return Err(AppError::Api(format!("Supabase Realtime channel closed ({event})")));
                        }
                    }
                    tokio_tungstenite::tungstenite::Message::Ping(bytes) => {
                        writer.send(tokio_tungstenite::tungstenite::Message::Pong(bytes))
                            .await
                            .map_err(|error| AppError::Api(format!("Supabase Realtime pong failed: {error}")))?;
                    }
                    tokio_tungstenite::tungstenite::Message::Close(_) => {
                        return Err(AppError::Api("Supabase Realtime connection closed".into()));
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn run_preference_realtime(app: tauri::AppHandle, path: PathBuf) {
    let mut attempt = 0u32;
    loop {
        emit_preference_realtime_state(
            &app,
            if attempt == 0 {
                "connecting"
            } else {
                "reconnecting"
            },
            None,
        );
        let result = match journal::preference_realtime_credentials(&path).await {
            Ok(credentials) => run_preference_realtime_session(&app, &credentials).await,
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => attempt = 0,
            Err(error) => {
                emit_preference_realtime_state(&app, "reconnecting", Some(error.to_string()));
                attempt = attempt.saturating_add(1);
            }
        }
        let delay = (1u64 << attempt.min(5)).min(30);
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
    }
}

async fn replace_preference_realtime_task(app: tauri::AppHandle, state: &NativeState) {
    let task = tauri::async_runtime::spawn(run_preference_realtime(app, state.db_path.clone()));
    let mut current = state.preference_realtime.lock().await;
    if let Some(previous) = current.replace(task) {
        previous.abort();
    }
}

#[tauri::command]
async fn start_preference_realtime(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    replace_preference_realtime_task(app, &state).await;
    Ok(())
}

#[tauri::command]
async fn stop_preference_realtime(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    if let Some(task) = state.preference_realtime.lock().await.take() {
        task.abort();
    }
    emit_preference_realtime_state(&app, "disabled", None);
    Ok(())
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
    let mut record = audit::AuditRecord::completed(
        "record",
        "supabase",
        "configure-journal",
        "success",
        "Supabase journal configuration was saved",
    );
    record.entity_type = Some("cloud-configuration".into());
    record.entity_id = Some("journal".into());
    record.changes = Some(serde_json::json!({
        "configured": result.configured,
        "authenticated": result.authenticated,
        "backfillStart": result.backfill_start,
    }));
    state.audit.record(record);
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"cloud-configured"}),
    );
    replace_preference_realtime_task(app, &state).await;
    Ok(result)
}

#[tauri::command]
async fn disconnect_journal(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    if let Some(task) = state.preference_realtime.lock().await.take() {
        task.abort();
    }
    journal::disconnect(&state.db_path)?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "supabase",
        "disconnect-journal",
        "success",
        "Supabase journal configuration was disconnected",
    );
    record.entity_type = Some("cloud-configuration".into());
    record.entity_id = Some("journal".into());
    record.changes = Some(serde_json::json!({"configured": false, "authenticated": false}));
    state.audit.record(record);
    emit_preference_realtime_state(&app, "disabled", None);
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"cloud-disconnected"}),
    );
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn set_journal_backfill_start(
    backfill_start: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    journal::set_backfill(&state.db_path, &backfill_start)?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "journal",
        "set-backfill-start",
        "success",
        format!("Journal backfill start changed to {backfill_start}"),
    );
    record.entity_type = Some("journal-setting".into());
    record.entity_id = Some("backfill-start".into());
    record.changes = Some(serde_json::json!({"after": backfill_start}));
    state.audit.record(record);
    Ok(())
}

#[tauri::command]
async fn reset_journal_now(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<journal::JournalAuthStatus, AppError> {
    let status = journal::reset_now(&state.db_path).await?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "journal",
        "reset-journal",
        "warning",
        "Journal history was reset and cloud tombstones were synchronized",
    );
    record.entity_type = Some("journal".into());
    record.entity_id = Some("primary".into());
    record.changes = Some(serde_json::json!({"reset": true, "configured": status.configured}));
    state.audit.record(record);
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"journal-reset-now"}),
    );
    Ok(status)
}

#[tauri::command(rename_all = "camelCase")]
fn set_journal_commission(
    commission_per_contract_side: f64,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    journal::set_commission_per_contract_side(&state.db_path, commission_per_contract_side)?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "journal",
        "set-commission",
        "success",
        "Journal commission setting was saved",
    );
    record.entity_type = Some("journal-setting".into());
    record.entity_id = Some("commission-per-contract-side".into());
    record.changes = Some(serde_json::json!({"after": commission_per_contract_side}));
    state.audit.record(record);
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"commission-updated"}),
    );
    schedule_journal_flush(app, state.db_path.clone());
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn set_schwab_option_fee(
    schwab_option_fee_per_contract_side: f64,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    journal::set_schwab_option_fee_per_contract_side(
        &state.db_path,
        schwab_option_fee_per_contract_side,
    )?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "journal",
        "set-schwab-option-fee",
        "success",
        "Schwab option journal fee setting was saved",
    );
    record.entity_type = Some("journal-setting".into());
    record.entity_id = Some("schwab-option-fee-per-contract-side".into());
    record.changes = Some(serde_json::json!({"after": schwab_option_fee_per_contract_side}));
    state.audit.record(record);
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
    .await?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "journal",
        "ingest-orders",
        "success",
        format!(
            "Ingested {} broker order record{}",
            orders.len(),
            if orders.len() == 1 { "" } else { "s" }
        ),
    );
    record.entity_type = Some("journal-order-batch".into());
    record.entity_id = Some(source);
    record.record_count = Some(orders.len() as i64);
    record.changes = Some(serde_json::json!({"orders": orders}));
    state.audit.record(record);
    Ok(())
}

async fn complete_journal_cloud_sync(
    path: &std::path::Path,
) -> Result<journal::JournalSyncStatus, AppError> {
    for attempt in 0..40 {
        let status = journal::sync_cloud(path).await?;
        if status.state != "syncing" {
            return Ok(status);
        }
        if attempt < 39 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
    Err(AppError::Api(
        "Another journal cloud sync is still running; retry Sync when it finishes".into(),
    ))
}

async fn schwab_journal_history(
    api: &Schwab,
    account_id: &str,
    backfill_start: &str,
) -> Result<Vec<OrderUpdate>, AppError> {
    let mut cursor = DateTime::parse_from_rfc3339(&format!("{backfill_start}T00:00:00Z"))
        .map_err(|_| AppError::Validation("Journal backfill date must use YYYY-MM-DD".into()))?
        .with_timezone(&Utc);
    let end = Utc::now();
    let mut orders = Vec::new();
    while cursor < end {
        let window_end = (cursor + chrono::Duration::days(30)).min(end);
        let page = api
            .orders(account_id, &cursor.to_rfc3339(), &window_end.to_rfc3339())
            .await?;
        orders.extend(page.orders);
        cursor = window_end;
    }
    Ok(orders)
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
    let selected_schwab_account = if scope
        .as_ref()
        .is_some_and(|selected| selected.provider == MarketDataProvider::Schwab)
    {
        scope.as_ref().map(|selected| selected.account_id.clone())
    } else if scope.is_none() {
        state.selected_schwab_journal_account.lock().await.clone()
    } else {
        None
    };
    let accounts = state.api.accounts().await?;
    let mut account_histories = Vec::new();
    for account in accounts.into_iter().filter(|account| {
        account.account_type.eq_ignore_ascii_case("futures")
            && scope.as_ref().is_none_or(|selected| {
                selected.provider == MarketDataProvider::Tradestation
                    && selected.account_id == account.id
                    && selected.environment == environment
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
        journal::repair_misclassified_close_campaigns(
            &state.db_path,
            &environment,
            &historical_orders,
        )?;
        account_histories.push((account.id, historical_orders));
    }
    let schwab_history = if let Some(account_id) = selected_schwab_account {
        Some((
            account_id.clone(),
            schwab_journal_history(&state.schwab, &account_id, &backfill_start).await?,
        ))
    } else {
        None
    };

    complete_journal_cloud_sync(&state.db_path).await?;

    let history_record_count = account_histories
        .iter()
        .map(|(_, orders)| orders.len())
        .sum::<usize>()
        + schwab_history
            .as_ref()
            .map_or(0, |(_, orders)| orders.len());
    for (account_id, historical_orders) in account_histories {
        journal::repair_misclassified_close_campaigns(
            &state.db_path,
            &environment,
            &historical_orders,
        )?;
        ingest_orders_with_metadata(
            &state.api,
            &state.db_path,
            &environment,
            &historical_orders,
            "broker-history",
        )
        .await?;
        journal::set_reconciliation_checkpoint(&state.db_path, &environment, &account_id)?;
    }
    if let Some((account_id, orders)) = schwab_history {
        capture_schwab_journal_orders(&app, &state.db_path, &orders, "broker-history")?;
        journal::set_reconciliation_checkpoint(
            &state.db_path,
            &TradingEnvironment::Live,
            &format!("schwab:{account_id}"),
        )?;
    }
    let result = complete_journal_cloud_sync(&state.db_path).await?;
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"cloud-sync"}),
    );
    let mut record = audit::AuditRecord::completed(
        "record",
        "supabase",
        "sync-journal",
        if result.state == "error" {
            "error"
        } else {
            "success"
        },
        result
            .message
            .clone()
            .unwrap_or_else(|| "Journal cloud synchronization completed".into()),
    );
    record.entity_type = Some("journal-sync".into());
    record.entity_id = Some(environment.key().into());
    record.record_count = Some(history_record_count as i64);
    record.response = Some(serde_json::to_value(&result)?);
    state.audit.record(record);
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
fn get_journal_stats_trades(
    scope: journal::JournalScope,
    start_date: Option<String>,
    end_date: Option<String>,
    state: State<'_, NativeState>,
) -> Result<journal::JournalStatsRange, AppError> {
    journal::stats_range(&state.db_path, scope, start_date, end_date)
}

#[tauri::command(rename_all = "camelCase")]
fn get_journal_trade(
    trade_id: String,
    state: State<'_, NativeState>,
) -> Result<journal::JournalTrade, AppError> {
    journal::trade(&state.db_path, &trade_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_active_journal_risk_baselines(
    environment: TradingEnvironment,
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<Vec<journal::JournalRiskBaseline>, AppError> {
    journal::active_risk_baselines(&state.db_path, &environment, &account_id)
}

#[tauri::command]
async fn save_journal_entry_screenshot(
    input: journal::JournalScreenshotInput,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<journal::JournalScreenshotMetadata, AppError> {
    let result = journal::save_entry_screenshot(&state.db_path, input).await?;
    let mut record = audit::AuditRecord::completed(
        "record",
        "supabase",
        "save-entry-screenshot",
        "success",
        format!(
            "Entry screenshot metadata was saved for trade {}",
            result.trade_id
        ),
    );
    record.entity_type = Some("journal-screenshot".into());
    record.entity_id = Some(result.trade_id.clone());
    record.changes = Some(serde_json::to_value(&result)?);
    state.audit.record(record);
    let _ = app.emit(
        "journal-updated",
        serde_json::json!({"reason":"entry-screenshot"}),
    );
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
async fn get_journal_entry_screenshot(
    trade_id: String,
    state: State<'_, NativeState>,
) -> Result<journal::JournalScreenshotImage, AppError> {
    journal::entry_screenshot(&state.db_path, &trade_id).await
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
    let mut record = audit::AuditRecord::completed(
        "record",
        "journal",
        "update-annotation",
        "success",
        format!("Journal annotation was updated for trade {trade_id}"),
    );
    record.entity_type = Some("journal-annotation".into());
    record.entity_id = Some(trade_id.clone());
    record.changes = Some(serde_json::json!({"notes": notes, "tags": tags}));
    state.audit.record(record);
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
    provider: &MarketDataProvider,
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
            provider: provider.clone(),
            environment: environment.clone(),
            environment_generation: 0,
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
    provider: &MarketDataProvider,
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
            provider,
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
    provider: &MarketDataProvider,
    environment: &TradingEnvironment,
    symbol: &str,
    timeframe: &str,
    bars: &[Bar],
) {
    for (subscription_id, subscriber) in bar_subscribers(subscribers) {
        emit_bar_snapshot_to(
            app,
            &subscription_id,
            provider,
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
    provider: &MarketDataProvider,
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
            provider: provider.clone(),
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

fn retain_schwab_bootstrap_snapshot(
    latest_bars: &Arc<RwLock<Vec<Bar>>>,
    incoming: &[Bar],
    limit: usize,
) -> Vec<Bar> {
    latest_bars
        .write()
        .map(|mut retained| {
            if let Some(first) = incoming.iter().map(|bar| bar.time).min() {
                // The bootstrap snapshot has already reconciled REST minutes
                // with every live minute received while it was loading. Drop
                // the covered cached/live tail so stale Sunday bars and an
                // incomplete timeframe-level fragment cannot survive.
                retained.retain(|bar| bar.time < first);
            }
            merge_retained_bars(&mut retained, incoming, limit);
            retained.clone()
        })
        .unwrap_or_else(|_| incoming.to_vec())
}

fn emit_bar_update(
    app: &tauri::AppHandle,
    subscribers: &Arc<RwLock<HashMap<String, BarSubscriber>>>,
    provider: &MarketDataProvider,
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
                provider: provider.clone(),
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

fn provisional_minute_from_equity_tick(
    live_minutes: &BTreeMap<i64, Bar>,
    last_tick: &mut Option<(i64, f64)>,
    price: f64,
    cumulative_volume: f64,
    time: i64,
) -> Option<Bar> {
    if !price.is_finite()
        || price <= 0.0
        || !cumulative_volume.is_finite()
        || cumulative_volume < 0.0
        || time <= 0
    {
        return None;
    }
    if last_tick.is_some_and(|(previous_time, _)| time < previous_time) {
        return None;
    }
    let minute_time = schwab::bucket_start(time, "1m")?;
    let volume_delta = last_tick
        .filter(|(previous_time, previous_volume)| {
            time.saturating_sub(*previous_time) <= 120 && cumulative_volume >= *previous_volume
        })
        .map(|(_, previous_volume)| cumulative_volume - previous_volume)
        .unwrap_or_default();
    *last_tick = Some((time, cumulative_volume));
    let mut minute = live_minutes.get(&minute_time).cloned().unwrap_or(Bar {
        time: minute_time,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0.0,
        realtime: true,
    });
    minute.high = minute.high.max(price);
    minute.low = minute.low.min(price);
    minute.close = price;
    minute.volume = (minute.volume + volume_delta).max(0.0);
    minute.realtime = true;
    Some(minute)
}

fn reconcile_schwab_bootstrap_minutes(
    live_minutes: &mut BTreeMap<i64, Bar>,
    historical_minutes: &[Bar],
) -> Vec<Bar> {
    historical_minutes.iter().for_each(|bar| {
        // A streamed minute is newer than the REST snapshot only for this
        // exact minute; the complete set is aggregated after reconciliation.
        live_minutes.entry(bar.time).or_insert_with(|| bar.clone());
    });
    live_minutes.values().cloned().collect()
}

fn aggregate_schwab_live_minute(
    live_minutes: &mut BTreeMap<i64, Bar>,
    minute: Bar,
    timeframe: &str,
) -> Option<(Bar, Option<Bar>)> {
    if matches!(timeframe, "D" | "W" | "M") && !schwab::is_regular_session_minute(minute.time) {
        return None;
    }
    let previous = live_minutes.insert(minute.time, minute.clone());
    let bucket_time = schwab::bucket_start(minute.time, timeframe)?;
    // CHART_EQUITY can close the preceding minute after a LEVELONE_EQUITIES
    // trade has already opened the next one. Keep those newer provisional
    // minutes so an authoritative close cannot roll the live chart backward.
    live_minutes.retain(|time, _| {
        *time > minute.time || schwab::bucket_start(*time, timeframe) == Some(bucket_time)
    });
    let mut update = schwab::aggregate_session_minutes(
        &live_minutes.values().cloned().collect::<Vec<_>>(),
        timeframe,
    )
    .into_iter()
    .find(|item| item.time == bucket_time)?;
    update.realtime = true;
    Some((update, previous))
}

async fn run_schwab_bar_stream(
    app: tauri::AppHandle,
    api: Schwab,
    streamer: SchwabStreamer,
    mut receiver: tokio::sync::broadcast::Receiver<SchwabStreamEvent>,
    db_path: PathBuf,
    subscribers: Arc<RwLock<HashMap<String, BarSubscriber>>>,
    status: Arc<RwLock<SharedBarStreamStatus>>,
    latest_bars: Arc<RwLock<Vec<Bar>>>,
    retained_limit: usize,
    environment: TradingEnvironment,
    symbol: String,
    timeframe: String,
    lifecycle: Arc<safety::ServiceLifecycle>,
    environment_generation: u64,
) {
    if !lifecycle.accepts(environment_generation) {
        return;
    }
    let (current_state, current_message) = streamer.connection_state().await;
    let initial_state = if current_state == "disconnected" {
        "connecting"
    } else {
        &current_state
    };
    emit_shared_stream_state(
        &app,
        &subscribers,
        &status,
        &MarketDataProvider::Schwab,
        &environment,
        &symbol,
        &timeframe,
        initial_state,
        current_message,
    );
    let bootstrap_api = api.clone();
    let bootstrap_symbol = symbol.clone();
    let bootstrap_timeframe = timeframe.clone();
    let bootstrap = async move {
        let history = bootstrap_api
            .bars(&bootstrap_symbol, &bootstrap_timeframe)
            .await;
        let mut source_minutes = if bootstrap_timeframe == "1m" {
            history
                .as_ref()
                .map(|bars| bars.clone())
                .unwrap_or_default()
        } else {
            bootstrap_api
                .bars(&bootstrap_symbol, "1m")
                .await
                .unwrap_or_default()
        };
        let session_error = if let Some((first, last)) =
            schwab::current_new_york_day_range(Utc::now().timestamp())
        {
            match bootstrap_api
                .bars_range(&bootstrap_symbol, first, last)
                .await
            {
                Ok(current_day) => {
                    let mut by_time = source_minutes
                        .into_iter()
                        .map(|bar| (bar.time, bar))
                        .collect::<BTreeMap<_, _>>();
                    by_time.extend(current_day.into_iter().map(|bar| (bar.time, bar)));
                    source_minutes = by_time.into_values().collect();
                    None
                }
                Err(error) => Some(format!("Schwab current-session history failed: {error}")),
            }
        } else {
            Some("Could not determine the current New York trading day".into())
        };
        (history, source_minutes, session_error)
    };
    tokio::pin!(bootstrap);
    let mut bootstrap_pending = true;
    let mut live_minutes = BTreeMap::new();
    let mut last_equity_tick = None;
    loop {
        if !lifecycle.accepts(environment_generation) {
            return;
        }
        tokio::select! {
            result = &mut bootstrap, if bootstrap_pending => {
                bootstrap_pending = false;
                let (history, source_minutes, session_error) = result;
                let mut snapshot = Vec::new();
                match history {
                    Ok(history) => {
                        snapshot = history;
                    }
                    Err(error) => emit_shared_stream_state(
                        &app,
                        &subscribers,
                        &status,
                        &MarketDataProvider::Schwab,
                        &environment,
                        &symbol,
                        &timeframe,
                        "stale",
                        Some(format!("Schwab history refresh failed; live updates will continue: {error}")),
                    ),
                }
                let reconciled_minutes = reconcile_schwab_bootstrap_minutes(
                    &mut live_minutes,
                    &source_minutes,
                );
                if !reconciled_minutes.is_empty() {
                    if timeframe != "1m" {
                        let _ = storage::replace_bar_tail(
                            &db_path,
                            "schwab",
                            &symbol,
                            "1m",
                            &reconciled_minutes,
                        );
                    }
                    snapshot = {
                        let mut combined = snapshot;
                        merge_retained_bars(
                            &mut combined,
                            &schwab::aggregate_session_minutes(&reconciled_minutes, &timeframe),
                            retained_limit,
                        );
                        combined
                    };
                }
                if !snapshot.is_empty() {
                    let _ = storage::replace_bar_tail(
                        &db_path,
                        "schwab",
                        &symbol,
                        &timeframe,
                        &snapshot,
                    );
                    let retained = retain_schwab_bootstrap_snapshot(&latest_bars, &snapshot, retained_limit);
                    emit_bar_snapshot(
                        &app,
                        &subscribers,
                        &MarketDataProvider::Schwab,
                        &environment,
                        &symbol,
                        &timeframe,
                        &retained,
                    );
                }
                if let Some(message) = session_error {
                    emit_shared_stream_state(
                        &app,
                        &subscribers,
                        &status,
                        &MarketDataProvider::Schwab,
                        &environment,
                        &symbol,
                        &timeframe,
                        "stale",
                        Some(message),
                    );
                }
            }
            received = receiver.recv() => match received {
            Ok(SchwabStreamEvent::State { state, message }) => emit_shared_stream_state(
                &app,
                &subscribers,
                &status,
                &MarketDataProvider::Schwab,
                &environment,
                &symbol,
                &timeframe,
                &state,
                message,
            ),
            Ok(SchwabStreamEvent::Chart {
                symbol: event_symbol,
                bar,
            }) if event_symbol.eq_ignore_ascii_case(&symbol) => {
                let needs_streaming_state = status
                    .read()
                    .map(|current| current.state != "streaming")
                    .unwrap_or(true);
                if needs_streaming_state {
                    emit_shared_stream_state(
                        &app,
                        &subscribers,
                        &status,
                        &MarketDataProvider::Schwab,
                        &environment,
                        &symbol,
                        &timeframe,
                        "streaming",
                        None,
                    );
                }
                let chart_minute = bar.time;
                if last_equity_tick.is_some_and(|(tick_time, _)| {
                    schwab::bucket_start(tick_time, "1m")
                        .is_some_and(|tick_minute| tick_minute <= chart_minute)
                }) {
                    last_equity_tick = None;
                }
                let Some((mut update, previous)) =
                    aggregate_schwab_live_minute(&mut live_minutes, bar.clone(), &timeframe)
                else {
                    continue;
                };
                if timeframe == "M" {
                    if let Ok(retained) = latest_bars.read() {
                        if let Some(existing) =
                            retained.iter().find(|item| item.time == update.time)
                        {
                            update.open = existing.open;
                            update.high = existing.high.max(update.high);
                            update.low = existing.low.min(update.low);
                            let previous_volume = previous.map(|item| item.volume).unwrap_or(0.0);
                            update.volume =
                                (existing.volume + bar.volume - previous_volume).max(0.0);
                        }
                    }
                }
                update.realtime = true;
                let _ = storage::save_bars(
                    &db_path,
                    "schwab",
                    &symbol,
                    &timeframe,
                    std::slice::from_ref(&update),
                );
                let _ = retain_bar_snapshot(
                    &latest_bars,
                    std::slice::from_ref(&update),
                    retained_limit,
                );
                emit_bar_update(
                    &app,
                    &subscribers,
                    &MarketDataProvider::Schwab,
                    &environment,
                    &symbol,
                    &timeframe,
                    &update,
                );
            }
            Ok(SchwabStreamEvent::EquityTick {
                symbol: event_symbol,
                price,
                cumulative_volume,
                time,
            }) if event_symbol.eq_ignore_ascii_case(&symbol) => {
                let Some(minute) = provisional_minute_from_equity_tick(
                    &live_minutes,
                    &mut last_equity_tick,
                    price,
                    cumulative_volume,
                    time,
                ) else {
                    continue;
                };
                let _ = storage::save_bars(
                    &db_path,
                    "schwab",
                    &symbol,
                    "1m",
                    std::slice::from_ref(&minute),
                );
                let source = minute.clone();
                let Some((mut update, previous)) =
                    aggregate_schwab_live_minute(&mut live_minutes, minute, &timeframe)
                else {
                    continue;
                };
                if timeframe == "M" {
                    if let Ok(retained) = latest_bars.read() {
                        if let Some(existing) = retained.iter().find(|item| item.time == update.time)
                        {
                            update.open = existing.open;
                            update.high = existing.high.max(update.high);
                            update.low = existing.low.min(update.low);
                            let previous_volume = previous.map(|item| item.volume).unwrap_or(0.0);
                            update.volume =
                                (existing.volume + source.volume - previous_volume).max(0.0);
                        }
                    }
                }
                let needs_streaming_state = status
                    .read()
                    .map(|current| current.state != "streaming")
                    .unwrap_or(true);
                if needs_streaming_state {
                    emit_shared_stream_state(
                        &app,
                        &subscribers,
                        &status,
                        &MarketDataProvider::Schwab,
                        &environment,
                        &symbol,
                        &timeframe,
                        "streaming",
                        None,
                    );
                }
                let _ = storage::save_bars(
                    &db_path,
                    "schwab",
                    &symbol,
                    &timeframe,
                    std::slice::from_ref(&update),
                );
                let _ = retain_bar_snapshot(
                    &latest_bars,
                    std::slice::from_ref(&update),
                    retained_limit,
                );
                emit_bar_update(
                    &app,
                    &subscribers,
                    &MarketDataProvider::Schwab,
                    &environment,
                    &symbol,
                    &timeframe,
                    &update,
                );
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                emit_shared_stream_state(
                    &app,
                    &subscribers,
                    &status,
                    &MarketDataProvider::Schwab,
                    &environment,
                    &symbol,
                    &timeframe,
                    "stale",
                    Some(format!("Schwab chart consumer skipped {skipped} shared updates; waiting for the next chart candle")),
                );
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
}

fn quote_consumers(subscriptions: &[(String, BTreeSet<String>)], symbol: &str) -> Vec<String> {
    subscriptions
        .iter()
        .filter(|(_, symbols)| symbols.contains(symbol))
        .map(|(id, _)| id.clone())
        .collect()
}

async fn run_schwab_quote_stream(
    app: tauri::AppHandle,
    api: Schwab,
    streamer: SchwabStreamer,
    subscriptions: Vec<(String, BTreeSet<String>)>,
    environment: TradingEnvironment,
    symbols: Vec<String>,
    lifecycle: Arc<safety::ServiceLifecycle>,
    environment_generation: u64,
) {
    let desired = symbols
        .iter()
        .map(|symbol| symbol.to_uppercase())
        .collect::<std::collections::HashSet<_>>();
    if let Ok(quotes) = api.quotes(&symbols).await {
        for quote in quotes {
            if !lifecycle.accepts(environment_generation) {
                return;
            }
            for subscription_id in quote_consumers(&subscriptions, &quote.symbol) {
                let _ = app.emit(
                    "quote-update",
                    QuoteUpdateEvent {
                        subscription_id,
                        provider: MarketDataProvider::Schwab,
                        environment: environment.clone(),
                        environment_generation,
                        quote: quote.clone(),
                    },
                );
            }
        }
    }
    let mut receiver = streamer.subscribe();
    let (current_state, current_message) = streamer.connection_state().await;
    for (subscription_id, _) in &subscriptions {
        emit_stream_state(
            &app,
            subscription_id,
            &MarketDataProvider::Schwab,
            &environment,
            "quotes",
            if current_state == "disconnected" {
                "connecting"
            } else {
                &current_state
            },
            current_message.clone(),
            None,
            None,
            None,
        );
    }
    loop {
        if !lifecycle.accepts(environment_generation) {
            return;
        }
        match receiver.recv().await {
            Ok(SchwabStreamEvent::State { state, message }) => {
                for (subscription_id, _) in &subscriptions {
                    emit_stream_state(
                        &app,
                        subscription_id,
                        &MarketDataProvider::Schwab,
                        &environment,
                        "quotes",
                        &state,
                        message.clone(),
                        None,
                        None,
                        None,
                    );
                }
            }
            Ok(SchwabStreamEvent::Quote(quote)) if desired.contains(&quote.symbol) => {
                for subscription_id in quote_consumers(&subscriptions, &quote.symbol) {
                    let _ = app.emit(
                        "quote-update",
                        QuoteUpdateEvent {
                            subscription_id,
                            provider: MarketDataProvider::Schwab,
                            environment: environment.clone(),
                            environment_generation,
                            quote: quote.clone(),
                        },
                    );
                }
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn run_schwab_option_stream(
    app: tauri::AppHandle,
    streamer: SchwabStreamer,
    subscription_id: String,
    symbol: String,
    desired: BTreeSet<String>,
    lifecycle: Arc<safety::ServiceLifecycle>,
    environment_generation: u64,
) {
    let mut receiver = streamer.subscribe();
    let (current_state, current_message) = streamer.connection_state().await;
    let _ = app.emit(
        "option-stream-state",
        OptionStreamStateEvent {
            subscription_id: subscription_id.clone(),
            symbol: symbol.clone(),
            environment_generation,
            state: if current_state == "streaming" {
                "connecting".into()
            } else {
                current_state
            },
            message: current_message,
        },
    );
    loop {
        if !lifecycle.accepts(environment_generation) {
            return;
        }
        match receiver.recv().await {
            Ok(SchwabStreamEvent::State { state, message }) => {
                let _ = app.emit(
                    "option-stream-state",
                    OptionStreamStateEvent {
                        subscription_id: subscription_id.clone(),
                        symbol: symbol.clone(),
                        environment_generation,
                        state,
                        message,
                    },
                );
            }
            Ok(SchwabStreamEvent::OptionState { state, message }) => {
                let _ = app.emit(
                    "option-stream-state",
                    OptionStreamStateEvent {
                        subscription_id: subscription_id.clone(),
                        symbol: symbol.clone(),
                        environment_generation,
                        state,
                        message,
                    },
                );
            }
            Ok(SchwabStreamEvent::Option(contract)) if desired.contains(&contract.symbol) => {
                let _ = app.emit(
                    "option-update",
                    OptionUpdateEvent {
                        subscription_id: subscription_id.clone(),
                        environment_generation,
                        contract,
                    },
                );
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                let _ = app.emit(
                    "option-stream-state",
                    OptionStreamStateEvent {
                        subscription_id: subscription_id.clone(),
                        symbol: symbol.clone(),
                        environment_generation,
                        state: "stale".into(),
                        message: Some(format!("Option stream skipped {skipped} updates")),
                    },
                );
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
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
    lifecycle: Arc<safety::ServiceLifecycle>,
    environment_generation: u64,
) {
    let mut attempt = 0u32;
    loop {
        if !lifecycle.accepts(environment_generation) {
            return;
        }
        emit_shared_stream_state(
            &app,
            &subscribers,
            &status,
            &MarketDataProvider::Tradestation,
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
                        &MarketDataProvider::Tradestation,
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
                    &MarketDataProvider::Tradestation,
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
                    if !lifecycle.accepts(environment_generation) {
                        return;
                    }
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
                                    &MarketDataProvider::Tradestation,
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
                                            &MarketDataProvider::Tradestation,
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
                                                &MarketDataProvider::Tradestation,
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
                        &MarketDataProvider::Tradestation,
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
                    &MarketDataProvider::Tradestation,
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
                    &MarketDataProvider::Tradestation,
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
        tokio::select! {
            _ = tokio::time::sleep(retry_delay.unwrap_or(backoff)) => {}
            _ = async {
                while lifecycle.accepts(environment_generation) {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            } => return,
        }
    }
}

async fn run_quote_stream(
    app: tauri::AppHandle,
    api: TradeStation,
    subscriptions: Vec<(String, BTreeSet<String>)>,
    environment: TradingEnvironment,
    symbols: Vec<String>,
    lifecycle: Arc<safety::ServiceLifecycle>,
    environment_generation: u64,
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
        if !lifecycle.accepts(environment_generation) {
            return;
        }
        for subscription_id in quote_consumers(&subscriptions, &quote.symbol) {
            let _ = app.emit(
                "quote-update",
                QuoteUpdateEvent {
                    subscription_id,
                    provider: MarketDataProvider::Tradestation,
                    environment: environment.clone(),
                    environment_generation,
                    quote: quote.clone(),
                },
            );
        }
    }
    loop {
        if !lifecycle.accepts(environment_generation) {
            return;
        }
        for (subscription_id, _) in &subscriptions {
            emit_stream_state(
                &app,
                subscription_id,
                &MarketDataProvider::Tradestation,
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
        }
        let connected_at = std::time::Instant::now();
        let mut retry_delay = None;
        match api
            .open_stream(&path, tradestation::RequestPriority::Realtime)
            .await
        {
            Ok(response) => {
                for (subscription_id, _) in &subscriptions {
                    emit_stream_state(
                        &app,
                        subscription_id,
                        &MarketDataProvider::Tradestation,
                        &environment,
                        "quotes",
                        "streaming",
                        None,
                        None,
                        None,
                        None,
                    );
                }
                let mut bytes = response.bytes_stream();
                let mut buffer = Vec::new();
                let mut go_away = false;
                while let Some(Ok(chunk)) = bytes.next().await {
                    if !lifecycle.accepts(environment_generation) {
                        return;
                    }
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
                            for subscription_id in quote_consumers(&subscriptions, &quote.symbol) {
                                let _ = app.emit(
                                    "quote-update",
                                    QuoteUpdateEvent {
                                        subscription_id,
                                        provider: MarketDataProvider::Tradestation,
                                        environment: environment.clone(),
                                        environment_generation,
                                        quote: quote.clone(),
                                    },
                                );
                            }
                        }
                    }
                    if go_away {
                        break;
                    }
                }
                for (subscription_id, _) in &subscriptions {
                    emit_stream_state(
                        &app,
                        subscription_id,
                        &MarketDataProvider::Tradestation,
                        &environment,
                        "quotes",
                        "reconnecting",
                        Some("TradeStation ended the stream; reconnecting".into()),
                        None,
                        None,
                        None,
                    );
                }
                if connected_at.elapsed() >= std::time::Duration::from_secs(30) {
                    attempt = 0;
                }
            }
            Err(error) => {
                let rate_limited = matches!(error, AppError::RateLimited { .. });
                if rate_limited {
                    retry_delay = Some(tradestation::rate_limit_delay(&error));
                }
                for (subscription_id, _) in &subscriptions {
                    emit_stream_state(
                        &app,
                        subscription_id,
                        &MarketDataProvider::Tradestation,
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
        }
        attempt = attempt.saturating_add(1);
        let backoff = std::time::Duration::from_secs(
            (1u64 << attempt.min(5)).min(30) + u64::from(attempt % 3),
        );
        tokio::select! {
            _ = tokio::time::sleep(retry_delay.unwrap_or(backoff)) => {}
            _ = async {
                while lifecycle.accepts(environment_generation) {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            } => return,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_dir)?;
            let db_path = app_dir.join("northstar.sqlite3");
            journal::init(&db_path)?;
            safety::init(&db_path)?;
            if let Err(error) = audit::init(&db_path) {
                tracing::error!(%error, "Could not initialize the audit log");
            }
            let audit = audit::AuditService::new(db_path.clone(), app.handle().clone());
            let api = TradeStation::new()?.with_audit(audit.clone());
            let schwab = Schwab::new()?.with_audit(audit.clone());
            let schwab_streamer = SchwabStreamer::new(schwab.clone());
            let safety = Arc::new(safety::SafetyService::new(db_path.clone()));
            let startup_api = api.clone();
            let startup_db = db_path.clone();
            app.manage(NativeState {
                audit,
                api,
                schwab,
                schwab_streamer,
                db_path,
                safety,
                bar_streams: Arc::new(tokio::sync::Mutex::new(BarStreamRegistry::default())),
                quote_streams: tokio::sync::Mutex::new(HashMap::new()),
                quote_provider_tasks: tokio::sync::Mutex::new(HashMap::new()),
                option_streams: tokio::sync::Mutex::new(HashMap::new()),
                brokerage_streams: tokio::sync::Mutex::new(Vec::new()),
                schwab_brokerage_stream: tokio::sync::Mutex::new(None),
                selected_schwab_journal_account: tokio::sync::Mutex::new(None),
                preference_realtime: tokio::sync::Mutex::new(None),
            });
            tauri::async_runtime::spawn(async move {
                if startup_api.token().await.is_ok() {
                    reconcile_unresolved(startup_api, startup_db).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            schwab_auth_status,
            save_credentials,
            save_schwab_credentials,
            begin_login,
            begin_schwab_login,
            logout,
            logout_schwab,
            set_environment,
            get_accounts,
            get_schwab_accounts,
            get_schwab_account_snapshot,
            get_schwab_orders,
            search_symbols,
            get_symbol_details,
            get_future_contracts,
            get_bars,
            get_quotes,
            get_option_expirations,
            get_option_chain,
            load_cached_bars,
            load_cached_bar_range,
            get_older_bars,
            get_bar_range,
            start_bar_stream,
            refresh_bar_stream,
            stop_bar_stream,
            start_quote_stream,
            stop_quote_stream,
            start_option_stream,
            stop_option_stream,
            start_brokerage_stream,
            stop_brokerage_stream,
            start_schwab_brokerage_stream,
            stop_schwab_brokerage_stream,
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
            get_risk_policy,
            save_risk_policy,
            list_broker_mutations,
            reconcile_broker_mutation,
            kill_switch,
            load_workspace,
            save_workspace,
            get_trading_today_cache,
            refresh_trading_today,
            open_trading_today_source,
            fetch_truth_social_posts,
            open_truth_social_post,
            sync_app_preferences,
            start_preference_realtime,
            stop_preference_realtime,
            journal_auth_status,
            configure_journal,
            disconnect_journal,
            set_journal_backfill_start,
            reset_journal_now,
            set_journal_commission,
            set_schwab_option_fee,
            sync_journal,
            get_journal_scopes,
            get_journal_month,
            get_journal_day,
            get_journal_stats_trades,
            get_journal_trade,
            get_active_journal_risk_baselines,
            save_journal_entry_screenshot,
            get_journal_entry_screenshot,
            update_journal_annotation,
            ingest_journal_orders,
            get_audit_events,
            get_audit_health,
            export_audit_events,
            record_client_audit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Northstar Trader");
}

#[cfg(test)]
mod stream_tests {
    use super::*;

    #[test]
    fn schwab_order_range_keeps_the_prior_session_after_new_york_midnight() {
        let now = Utc.with_ymd_and_hms(2026, 8, 4, 4, 3, 0).single().unwrap();
        let (from, to) = schwab_order_range_at(now);
        assert_eq!(from, "2026-08-03T08:00:00+00:00");
        assert_eq!(to, "2026-08-04T04:03:00+00:00");
    }

    #[test]
    fn schwab_order_range_rolls_at_four_new_york_time() {
        let now = Utc.with_ymd_and_hms(2026, 8, 4, 13, 0, 0).single().unwrap();
        let (from, to) = schwab_order_range_at(now);
        assert_eq!(from, "2026-08-04T08:00:00+00:00");
        assert_eq!(to, "2026-08-04T13:00:00+00:00");
    }

    fn search_symbol(provider: MarketDataProvider, symbol: &str, asset_type: &str) -> SymbolMeta {
        SymbolMeta {
            provider,
            symbol: symbol.into(),
            description: symbol.into(),
            exchange: String::new(),
            asset_type: asset_type.into(),
            min_move: 0.25,
            point_value: 1.0,
            expiration: None,
            root: None,
            underlying: None,
        }
    }

    #[test]
    fn combined_search_preserves_server_filtered_futures_with_missing_category() {
        let future = search_symbol(MarketDataProvider::Tradestation, "@MES", "");
        let equity = search_symbol(MarketDataProvider::Schwab, "META", "EQUITY");
        let results = merge_symbol_search_results(vec![future], vec![equity], "MES");
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|item| {
            item.provider == MarketDataProvider::Tradestation && item.symbol == "@MES"
        }));
    }

    #[test]
    fn combined_search_normalizes_ranks_deduplicates_and_limits_results() {
        let exact = search_symbol(MarketDataProvider::Schwab, " aapl ", " equity ");
        let mut description_match = search_symbol(MarketDataProvider::Schwab, "APC", "EQUITY");
        description_match.description = "Apple supplier".into();
        let prefix = search_symbol(MarketDataProvider::Schwab, "AAPLX", "EQUITY");
        let duplicate = search_symbol(MarketDataProvider::Schwab, "AAPLX", "EQUITY");
        let same_symbol_other_provider =
            search_symbol(MarketDataProvider::Tradestation, "AAPLX", "FUTURE");
        let extras = (0..24)
            .map(|index| {
                search_symbol(
                    MarketDataProvider::Schwab,
                    &format!("ZZ{index:02}"),
                    "EQUITY",
                )
            })
            .collect();

        let results = merge_symbol_search_results(
            vec![same_symbol_other_provider],
            [vec![description_match, prefix, duplicate, exact], extras].concat(),
            "aapl",
        );

        assert_eq!(results.len(), 20);
        assert_eq!(results[0].symbol, "AAPL");
        assert_eq!(results[0].asset_type, "EQUITY");
        assert_eq!(results[1].symbol, "AAPLX");
        assert_eq!(results[2].symbol, "AAPLX");
        assert_ne!(results[1].provider, results[2].provider);
        assert_eq!(results[3].symbol, "APC");
    }

    #[test]
    fn combined_search_uses_partial_results_and_errors_only_when_both_providers_fail() {
        let future = search_symbol(MarketDataProvider::Tradestation, "MES", "FUTURE");
        let partial = combine_symbol_search_responses(
            Ok(vec![future]),
            Err(AppError::AuthenticationRequired),
            "MES",
        )
        .unwrap();
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0].symbol, "MES");

        let unavailable = combine_symbol_search_responses(
            Err(AppError::Api("TradeStation offline".into())),
            Err(AppError::AuthenticationRequired),
            "MES",
        )
        .unwrap_err();
        assert!(unavailable
            .to_string()
            .contains("Symbol search unavailable"));
    }

    #[test]
    fn preference_realtime_url_uses_websocket_protocol_without_changing_the_host() {
        let url =
            preference_realtime_url("https://project.supabase.co", "sb_publishable_test").unwrap();
        assert_eq!(url.scheme(), "wss");
        assert_eq!(url.host_str(), Some("project.supabase.co"));
        assert_eq!(url.path(), "/realtime/v1/websocket");
        let query = url.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            query.get("apikey").map(|value| value.as_ref()),
            Some("sb_publishable_test")
        );
        assert_eq!(query.get("vsn").map(|value| value.as_ref()), Some("1.0.0"));
    }

    #[test]
    fn preference_realtime_payload_extracts_the_changed_record() {
        let payload = serde_json::json!({
            "data": {"record": {"category":"watchlist","revision":8}}
        });
        let record = realtime_preference_record(&payload).unwrap();
        assert_eq!(record["category"], "watchlist");
        assert_eq!(record["revision"], 8);
    }

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
            bar_stream_key(
                &MarketDataProvider::Tradestation,
                &environment,
                "MESU26",
                "5m"
            ),
            bar_stream_key(
                &MarketDataProvider::Tradestation,
                &environment,
                "MESU26",
                "5m"
            )
        );
        assert_ne!(
            bar_stream_key(
                &MarketDataProvider::Tradestation,
                &environment,
                "MESU26",
                "5m"
            ),
            bar_stream_key(
                &MarketDataProvider::Tradestation,
                &environment,
                "MESU26",
                "15m"
            )
        );
        assert_ne!(
            bar_stream_key(
                &MarketDataProvider::Tradestation,
                &environment,
                "AAPL",
                "1m"
            ),
            bar_stream_key(&MarketDataProvider::Schwab, &environment, "AAPL", "1m")
        );
        assert_eq!(
            cache_namespace(&MarketDataProvider::Schwab, &TradingEnvironment::Sim),
            cache_namespace(&MarketDataProvider::Schwab, &TradingEnvironment::Live)
        );
        assert_ne!(
            cache_namespace(&MarketDataProvider::Tradestation, &TradingEnvironment::Sim),
            cache_namespace(&MarketDataProvider::Schwab, &TradingEnvironment::Sim)
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
    fn quote_consumers_receive_union_without_one_consumer_clearing_another() {
        let mut subscriptions = vec![
            ("chart".into(), BTreeSet::from(["MES".into(), "MNQ".into()])),
            (
                "watchlist".into(),
                BTreeSet::from(["MNQ".into(), "MCL".into()]),
            ),
        ];
        assert_eq!(
            quote_consumers(&subscriptions, "MNQ"),
            vec!["chart".to_string(), "watchlist".to_string()]
        );
        subscriptions.retain(|(id, _)| id != "chart");
        assert_eq!(
            quote_consumers(&subscriptions, "MNQ"),
            vec!["watchlist".to_string()]
        );
        assert_eq!(
            quote_consumers(&subscriptions, "MCL"),
            vec!["watchlist".to_string()]
        );
    }

    #[test]
    fn restart_reconciliation_finds_one_strong_match_without_resubmission() {
        let path = std::env::temp_dir().join(format!(
            "northstar-restart-reconcile-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        safety::init(&path).unwrap();
        let created_at = Utc::now().to_rfc3339();
        assert!(matches!(
            safety::create_intent(
                &path,
                safety::NewMutationIntent {
                    id: "restart-1".into(),
                    environment: TradingEnvironment::Sim,
                    account_id: "SIM-1".into(),
                    kind: "place_order".into(),
                    equivalence_key: "place|MESZ26|Buy|1|Limit".into(),
                    symbol: Some("MESZ26".into()),
                    action: "Buy".into(),
                    quantity: Some(1.0),
                    order_type: Some("Limit".into()),
                    limit_price: Some(6000.0),
                    stop_price: None,
                    take_profit: Some(6002.0),
                    stop_loss: Some(5998.0),
                    target_id: None,
                    request: serde_json::json!({"duration":"DAY"}),
                },
            )
            .unwrap(),
            safety::CreateIntent::Created
        ));
        safety::update_intent(
            &path,
            "restart-1",
            safety::MutationState::Unknown,
            None,
            None,
            "complete",
            "required",
            None,
            Some("timeout after transmission"),
            false,
        )
        .unwrap();
        let intent = safety::load_intent(&path, "restart-1").unwrap().unwrap();
        let broker_order = OrderUpdate {
            provider: MarketDataProvider::Tradestation,
            id: "91234".into(),
            symbol: "MESZ26".into(),
            side: "Buy".into(),
            order_type: "Limit".into(),
            quantity: 1,
            price: Some(6000.0),
            stop_price: None,
            status: "Working".into(),
            timestamp: created_at,
            account_id: Some("SIM-1".into()),
            filled_quantity: Some(0.0),
            remaining_quantity: Some(1.0),
            average_fill_price: None,
            duration: Some("DAY".into()),
            closed_at: None,
            commission: None,
            stop_loss: Some(5998.0),
            take_profit: Some(6002.0),
            raw_status: None,
            status_description: None,
            open_or_close: Some("Open".into()),
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
        };
        let submit_calls = 0;
        let candidates = place_reconciliation_candidates(&intent, &[broker_order.clone()], None);
        assert_eq!(
            candidates
                .iter()
                .map(|order| order.id.as_str())
                .collect::<Vec<_>>(),
            vec![broker_order.id.as_str()]
        );
        assert_eq!(submit_calls, 0);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn ambiguous_reconciliation_candidates_require_manual_review() {
        let intent = safety::MutationIntent {
            id: "m1".into(),
            environment: TradingEnvironment::Sim,
            account_id: "SIM-1".into(),
            kind: "place_order".into(),
            equivalence_key: "same".into(),
            symbol: Some("MESZ26".into()),
            action: "Buy".into(),
            quantity: Some(1.0),
            order_type: Some("Market".into()),
            limit_price: None,
            stop_price: None,
            take_profit: None,
            stop_loss: None,
            target_id: None,
            broker_id: None,
            state: safety::MutationState::Unknown,
            local_persistence: "complete".into(),
            reconciliation_status: "required".into(),
            manual_review_required: false,
            warning: None,
            error: None,
            request: serde_json::json!({"duration":"DAY"}),
            broker_object: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let order = |id: &str| OrderUpdate {
            provider: MarketDataProvider::Tradestation,
            id: id.into(),
            symbol: "MESZ26".into(),
            side: "Buy".into(),
            order_type: "Market".into(),
            quantity: 1,
            price: None,
            stop_price: None,
            status: "Pending".into(),
            timestamp: Utc::now().to_rfc3339(),
            account_id: Some("SIM-1".into()),
            filled_quantity: Some(0.0),
            remaining_quantity: Some(1.0),
            average_fill_price: None,
            duration: Some("DAY".into()),
            closed_at: None,
            commission: None,
            stop_loss: None,
            take_profit: None,
            raw_status: None,
            status_description: None,
            open_or_close: Some("Open".into()),
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
        };
        assert_eq!(
            place_reconciliation_candidates(&intent, &[order("1"), order("2")], None).len(),
            2
        );
        assert_eq!(
            place_reconciliation_candidates(&intent, &[order("1"), order("2")], Some("2"))
                .iter()
                .map(|order| order.id.as_str())
                .collect::<Vec<_>>(),
            vec!["2"]
        );
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
    fn schwab_reconciled_bootstrap_replaces_an_incomplete_live_fragment() {
        let bar = |time: i64, close: f64, realtime: bool| Bar {
            time,
            open: close,
            high: close,
            low: close,
            close,
            volume: close,
            realtime,
        };
        let latest = Arc::new(RwLock::new(vec![
            bar(100, 1.0, false),
            bar(300, 30.0, true),
        ]));
        let retained = retain_schwab_bootstrap_snapshot(
            &latest,
            &[bar(200, 2.0, false), bar(300, 3.0, false)],
            10,
        );
        assert_eq!(
            retained.iter().map(|item| item.time).collect::<Vec<_>>(),
            vec![100, 200, 300]
        );
        assert_eq!(retained[2].close, 3.0);
        assert!(!retained[2].realtime);
    }

    #[test]
    fn schwab_daily_bootstrap_rebuilds_the_full_session_before_retention() {
        let epoch = |value: &str| DateTime::parse_from_rfc3339(value).unwrap().timestamp();
        let open = Bar {
            time: epoch("2026-08-03T09:30:00-04:00"),
            open: 751.11,
            high: 753.0,
            low: 750.9,
            close: 752.5,
            volume: 1_000.0,
            realtime: false,
        };
        let close = Bar {
            time: epoch("2026-08-03T15:59:00-04:00"),
            open: 757.8,
            high: 758.58,
            low: 757.7,
            close: 758.33,
            volume: 2_000.0,
            realtime: true,
        };
        let day = schwab::bucket_start(open.time, "D").unwrap();
        let latest = Arc::new(RwLock::new(vec![Bar {
            time: day,
            open: 758.28,
            high: 758.33,
            low: 758.25,
            close: 758.33,
            volume: 5_347.0,
            realtime: true,
        }]));
        let rebuilt = schwab::aggregate_session_minutes(&[open, close], "D");
        let retained = retain_schwab_bootstrap_snapshot(&latest, &rebuilt, 10);

        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].time, day);
        assert_eq!(
            (
                retained[0].open,
                retained[0].high,
                retained[0].low,
                retained[0].close,
                retained[0].volume,
            ),
            (751.11, 758.58, 750.9, 758.33, 3_000.0)
        );
        assert!(retained[0].realtime);
    }

    #[test]
    fn schwab_bootstrap_live_minute_wins_only_its_exact_timestamp() {
        let bar = |time: i64, close: f64, realtime: bool| Bar {
            time,
            open: close,
            high: close,
            low: close,
            close,
            volume: 1.0,
            realtime,
        };
        let mut live = BTreeMap::from([(200, bar(200, 20.0, true))]);
        let reconciled = reconcile_schwab_bootstrap_minutes(
            &mut live,
            &[
                bar(100, 1.0, false),
                bar(200, 2.0, false),
                bar(300, 3.0, false),
            ],
        );
        assert_eq!(
            reconciled
                .iter()
                .map(|item| (item.time, item.close, item.realtime))
                .collect::<Vec<_>>(),
            vec![(100, 1.0, false), (200, 20.0, true), (300, 3.0, false)]
        );
    }

    #[test]
    fn schwab_after_hours_ticks_do_not_mutate_calendar_bars() {
        let after_hours = Bar {
            time: DateTime::parse_from_rfc3339("2026-08-03T19:59:00-04:00")
                .unwrap()
                .timestamp(),
            open: 758.28,
            high: 758.33,
            low: 758.25,
            close: 758.33,
            volume: 5_347.0,
            realtime: true,
        };
        let mut live_minutes = BTreeMap::new();
        assert!(aggregate_schwab_live_minute(&mut live_minutes, after_hours, "D").is_none());
        assert!(live_minutes.is_empty());
    }

    #[test]
    fn schwab_equity_ticks_build_the_open_minute_before_chart_close() {
        let minute_start = 1_784_762_460;
        let mut live_minutes = BTreeMap::new();
        let mut last_tick = None;
        let first = provisional_minute_from_equity_tick(
            &live_minutes,
            &mut last_tick,
            748.10,
            1_000_000.0,
            minute_start + 5,
        )
        .unwrap();
        assert_eq!(
            (first.open, first.high, first.low, first.close, first.volume),
            (748.10, 748.10, 748.10, 748.10, 0.0)
        );
        live_minutes.insert(first.time, first);

        let higher = provisional_minute_from_equity_tick(
            &live_minutes,
            &mut last_tick,
            748.25,
            1_000_025.0,
            minute_start + 15,
        )
        .unwrap();
        live_minutes.insert(higher.time, higher);
        let lower = provisional_minute_from_equity_tick(
            &live_minutes,
            &mut last_tick,
            748.00,
            1_000_030.0,
            minute_start + 25,
        )
        .unwrap();
        assert_eq!(lower.open, 748.10);
        assert_eq!(lower.high, 748.25);
        assert_eq!(lower.low, 748.00);
        assert_eq!(lower.close, 748.00);
        assert_eq!(lower.volume, 30.0);
        assert!(lower.realtime);
    }

    #[test]
    fn schwab_closed_chart_minute_replaces_the_provisional_source() {
        let provisional = Bar {
            time: 1_784_762_460,
            open: 748.1,
            high: 748.2,
            low: 748.0,
            close: 748.15,
            volume: 20.0,
            realtime: true,
        };
        let closed = Bar {
            time: provisional.time,
            open: 748.08,
            high: 748.3,
            low: 747.95,
            close: 748.22,
            volume: 1500.0,
            realtime: true,
        };
        let mut live_minutes = BTreeMap::from([(provisional.time, provisional)]);
        let (update, previous) =
            aggregate_schwab_live_minute(&mut live_minutes, closed.clone(), "1m").unwrap();
        assert!(previous.is_some());
        assert_eq!(
            (
                update.open,
                update.high,
                update.low,
                update.close,
                update.volume
            ),
            (
                closed.open,
                closed.high,
                closed.low,
                closed.close,
                closed.volume
            )
        );
        assert_eq!(live_minutes[&closed.time].close, closed.close);
        assert_eq!(live_minutes[&closed.time].volume, closed.volume);
    }

    #[test]
    fn schwab_late_chart_close_preserves_the_newer_live_minute() {
        let closed = Bar {
            time: 1_784_762_460,
            open: 748.1,
            high: 748.2,
            low: 748.0,
            close: 748.15,
            volume: 1500.0,
            realtime: true,
        };
        let current = Bar {
            time: closed.time + 60,
            open: 748.16,
            high: 748.19,
            low: 748.14,
            close: 748.18,
            volume: 12.0,
            realtime: true,
        };
        let mut live_minutes = BTreeMap::from([(current.time, current.clone())]);

        let (update, _) =
            aggregate_schwab_live_minute(&mut live_minutes, closed.clone(), "1m").unwrap();

        assert_eq!(update.time, closed.time);
        assert_eq!(live_minutes[&current.time].close, current.close);
        assert_eq!(live_minutes[&closed.time].close, closed.close);
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
