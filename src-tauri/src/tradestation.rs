use crate::{models::*, storage, AppError};
use chrono::{DateTime, Utc};
use reqwest::{header::HeaderMap, Method, StatusCode};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch, Mutex};

const HISTORY_CREDIT_CAPACITY: f64 = 200.0;
const HISTORY_CREDITS_PER_SECOND: f64 = 200.0 / 60.0;
const BACKGROUND_RESERVE_RATIO: f64 = 0.10;
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const REST_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HttpClientPolicy {
    total_timeout: Option<Duration>,
}

const REST_CLIENT_POLICY: HttpClientPolicy = HttpClientPolicy {
    total_timeout: Some(REST_REQUEST_TIMEOUT),
};
const STREAM_CLIENT_POLICY: HttpClientPolicy = HttpClientPolicy {
    // TradeStation streams are intentionally open-ended. A total request
    // timeout would terminate every healthy stream at a fixed interval.
    total_timeout: None,
};

fn build_http_client(policy: HttpClientPolicy) -> Result<reqwest::Client, reqwest::Error> {
    let mut builder = reqwest::Client::builder()
        .user_agent("NorthstarTrader/0.1")
        .connect_timeout(HTTP_CONNECT_TIMEOUT);
    if let Some(timeout) = policy.total_timeout {
        builder = builder.timeout(timeout);
    }
    builder.build()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RequestPriority {
    Background,
    User,
    Realtime,
    Trading,
}

#[derive(Debug, Clone)]
struct QuotaBucket {
    capacity: f64,
    available: f64,
    refill_per_second: f64,
    updated_at: Instant,
    reset_at: Option<Instant>,
}

impl QuotaBucket {
    fn new(capacity: u64, period_secs: u64) -> Self {
        let capacity = capacity.max(1) as f64;
        Self {
            capacity,
            available: capacity,
            refill_per_second: capacity / period_secs.max(1) as f64,
            updated_at: Instant::now(),
            reset_at: None,
        }
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.updated_at).as_secs_f64();
        self.available = (self.available + elapsed * self.refill_per_second).min(self.capacity);
        self.updated_at = now;
        if self.reset_at.is_some_and(|reset| reset <= now) {
            self.reset_at = None;
        }
    }

    fn wait_for(&self, amount: f64) -> Duration {
        if self.available >= amount {
            return Duration::ZERO;
        }
        let token_wait = Duration::from_secs_f64(
            ((amount - self.available) / self.refill_per_second.max(f64::EPSILON)).max(0.01),
        );
        self.reset_at
            .map(|reset| reset.saturating_duration_since(Instant::now()))
            .filter(|reset| !reset.is_zero())
            .map_or(token_wait, |reset| token_wait.min(reset))
    }
}

#[derive(Debug)]
struct QuotaState {
    buckets: HashMap<String, QuotaBucket>,
    aliases: HashMap<String, String>,
    history_available: f64,
    history_updated_at: Instant,
}

impl Default for QuotaState {
    fn default() -> Self {
        Self {
            buckets: HashMap::new(),
            aliases: HashMap::new(),
            history_available: HISTORY_CREDIT_CAPACITY,
            history_updated_at: Instant::now(),
        }
    }
}

#[derive(Clone, Default)]
struct QuotaCoordinator {
    state: Arc<Mutex<QuotaState>>,
}

impl QuotaCoordinator {
    async fn acquire(
        &self,
        hint: &str,
        priority: RequestPriority,
        history_credits: f64,
        max_wait: Option<Duration>,
    ) -> Result<(), AppError> {
        let started = Instant::now();
        loop {
            let (wait, resource) = {
                let mut state = self.state.lock().await;
                let now = Instant::now();
                let elapsed = now
                    .saturating_duration_since(state.history_updated_at)
                    .as_secs_f64();
                state.history_available = (state.history_available
                    + elapsed * HISTORY_CREDITS_PER_SECOND)
                    .min(HISTORY_CREDIT_CAPACITY);
                state.history_updated_at = now;

                let resource = state
                    .aliases
                    .get(hint)
                    .cloned()
                    .unwrap_or_else(|| hint.to_string());
                let history_available = state.history_available;
                let history_wait = if history_credits <= history_available {
                    Duration::ZERO
                } else {
                    Duration::from_secs_f64(
                        ((history_credits - history_available) / HISTORY_CREDITS_PER_SECOND)
                            .max(0.01),
                    )
                };
                let (capacity, period) = default_quota(hint);
                let request_wait = {
                    let bucket = state
                        .buckets
                        .entry(resource.clone())
                        .or_insert_with(|| QuotaBucket::new(capacity, period));
                    bucket.refill(now);
                    let reserve_ratio = match priority {
                        RequestPriority::Background => BACKGROUND_RESERVE_RATIO,
                        RequestPriority::User => 0.05,
                        RequestPriority::Realtime => 0.02,
                        RequestPriority::Trading => 0.0,
                    };
                    let reserve = (bucket.capacity * reserve_ratio).ceil();
                    bucket.wait_for(1.0 + reserve)
                };
                let wait = request_wait.max(history_wait);
                if wait.is_zero() {
                    if let Some(bucket) = state.buckets.get_mut(&resource) {
                        bucket.available = (bucket.available - 1.0).max(0.0);
                    }
                    state.history_available = (state.history_available - history_credits).max(0.0);
                }
                (wait, resource)
            };
            if wait.is_zero() {
                let queued = started.elapsed();
                if queued >= Duration::from_millis(50) {
                    tracing::debug!(resource = %resource, wait_ms = queued.as_millis(), "TradeStation request released from quota queue");
                }
                return Ok(());
            }
            if max_wait.is_some_and(|limit| started.elapsed().saturating_add(wait) > limit) {
                return Err(AppError::RateLimited {
                    resource,
                    retry_after_secs: wait.as_secs().max(1),
                    concurrent: false,
                });
            }
            tokio::time::sleep(wait.max(Duration::from_millis(25))).await;
        }
    }

    async fn observe(&self, hint: &str, headers: &HeaderMap) {
        let Some(resource) = header_string(headers, "x-ratelimit-resource") else {
            return;
        };
        let limit = header_u64(headers, "x-ratelimit-limit");
        let period = header_u64(headers, "x-ratelimit-period");
        let remaining = header_u64(headers, "x-ratelimit-remaining");
        let reset = header_u64(headers, "x-ratelimit-reset");
        let mut state = self.state.lock().await;
        state.aliases.insert(hint.to_string(), resource.clone());
        let defaults = default_quota(hint);
        let bucket = state.buckets.entry(resource.clone()).or_insert_with(|| {
            QuotaBucket::new(limit.unwrap_or(defaults.0), period.unwrap_or(defaults.1))
        });
        let now = Instant::now();
        bucket.refill(now);
        if let Some(limit) = limit {
            bucket.capacity = limit.max(1) as f64;
        }
        if let Some(period) = period {
            bucket.refill_per_second = bucket.capacity / period.max(1) as f64;
        }
        if let Some(remaining) = remaining {
            bucket.available = (remaining as f64).min(bucket.capacity);
        }
        bucket.updated_at = now;
        bucket.reset_at = reset.map(|seconds| now + Duration::from_secs(seconds));
        tracing::debug!(
            resource = %resource,
            remaining = bucket.available,
            capacity = bucket.capacity,
            reset_seconds = reset,
            "Observed TradeStation quota headers"
        );
    }
}

#[derive(Default)]
struct ClientCache {
    accounts: Option<(Instant, Vec<Account>)>,
    symbols: HashMap<String, (Instant, SymbolMeta)>,
}

fn default_quota(resource: &str) -> (u64, u64) {
    match resource {
        "quote-stream" | "barcharts" | "quote-snapshot" => (500, 300),
        "symbols" => (90, 60),
        "accounts" | "order-details" | "balances" | "positions" => (320, 300),
        // Unknown/custom categories are calibrated from the first response.
        _ => (320, 300),
    }
}

fn default_priority(path: &str) -> RequestPriority {
    if path.contains("/positions") || path.contains("/orders") || path.contains("balances") {
        RequestPriority::Background
    } else {
        RequestPriority::User
    }
}

fn request_profile(path: &str) -> (&'static str, f64) {
    if path.contains("/marketdata/stream/barcharts/") || path.contains("/marketdata/barcharts/") {
        return ("barcharts", historical_credits(path));
    }
    if path.contains("/marketdata/stream/quotes/") {
        return ("quote-stream", 0.0);
    }
    if path.contains("/marketdata/quotes/") {
        return ("quote-snapshot", 0.0);
    }
    if path.contains("/brokerage/stream/") && path.contains("/positions") {
        return ("positions-stream", 0.0);
    }
    if path.contains("/brokerage/stream/") && path.contains("/orders") {
        return ("order-stream", 0.0);
    }
    if path.contains("/positions") {
        return ("positions", 0.0);
    }
    if path.contains("/orderexecution/") {
        return ("order-execution", 0.0);
    }
    if path.contains("historicalorders") || path.contains("/orders") {
        return ("order-details", 0.0);
    }
    if path.contains("balances") {
        return ("balances", 0.0);
    }
    if path.contains("/brokerage/accounts") {
        return ("accounts", 0.0);
    }
    if path.contains("/symbols") || path.contains("/data/symbols") {
        return ("symbols", 0.0);
    }
    ("other", 0.0)
}

fn query_value(path: &str, key: &str) -> Option<String> {
    let url = url::Url::parse(&format!("https://quota.invalid{path}")).ok()?;
    url.query_pairs()
        .find_map(|(name, value)| (name.eq_ignore_ascii_case(key)).then(|| value.into_owned()))
}

fn truncate_hundredths(value: f64) -> f64 {
    (value.max(0.0) * 100.0).floor() / 100.0
}

pub fn historical_credits(path: &str) -> f64 {
    if !query_value(path, "unit").is_some_and(|unit| unit.eq_ignore_ascii_case("minute")) {
        return 0.0;
    }
    let credits = if let Some(bars_back) =
        query_value(path, "barsback").and_then(|value| value.parse::<f64>().ok())
    {
        let interval = query_value(path, "interval")
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(1.0);
        truncate_hundredths(bars_back * interval / 100_000.0)
    } else if let Some(first) =
        query_value(path, "firstdate").and_then(|value| parse_query_date(&value))
    {
        let last = query_value(path, "lastdate")
            .and_then(|value| parse_query_date(&value))
            .unwrap_or_else(|| Utc::now().date_naive());
        let inclusive_days = (last - first).num_days().max(0) + 1;
        truncate_hundredths(inclusive_days as f64 / 365.0)
    } else {
        0.0
    };
    if credits <= 0.25 {
        0.0
    } else {
        credits
    }
}

fn parse_query_date(value: &str) -> Option<chrono::NaiveDate> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.date_naive())
        .or_else(|| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name)?.to_str().ok().map(str::to_owned)
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    header_string(headers, name)?.parse().ok()
}

fn rate_limit_error(headers: &HeaderMap, fallback_resource: &str) -> AppError {
    let concurrency_remaining = header_u64(headers, "x-concurrency-remaining");
    let rate_remaining = header_u64(headers, "x-ratelimit-remaining");
    let concurrent = match (concurrency_remaining, rate_remaining) {
        (Some(0), _) => true,
        (_, Some(0)) => false,
        (None, None) => header_string(headers, "x-concurrency-resource").is_some(),
        _ => false,
    };
    let resource = if concurrent {
        header_string(headers, "x-concurrency-resource")
    } else {
        header_string(headers, "x-ratelimit-resource")
    }
    .unwrap_or_else(|| fallback_resource.to_string());
    let retry_after_secs = header_u64(headers, "x-ratelimit-reset")
        .or_else(|| header_u64(headers, "retry-after"))
        .unwrap_or(if concurrent { 30 } else { 60 })
        .max(1);
    AppError::RateLimited {
        resource,
        retry_after_secs,
        concurrent,
    }
}

pub fn rate_limit_delay(error: &AppError) -> Duration {
    match error {
        AppError::RateLimited {
            retry_after_secs, ..
        } => Duration::from_secs(*retry_after_secs),
        _ => Duration::from_secs(2),
    }
}

#[derive(Clone)]
pub struct AccessToken {
    pub value: String,
    pub expires_at: Instant,
}

#[derive(Default)]
pub struct Session {
    pub environment: TradingEnvironment,
    pub token: Option<AccessToken>,
}

#[derive(Clone)]
pub struct TradeStation {
    pub client: reqwest::Client,
    stream_client: reqwest::Client,
    pub session: Arc<Mutex<Session>>,
    quota: QuotaCoordinator,
    cache: Arc<Mutex<ClientCache>>,
    inflight_gets: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<Result<Value, String>>>>>>,
    brokerage_cache: Arc<Mutex<BrokerageCache>>,
    brokerage_revision: watch::Sender<u64>,
}

#[derive(Default)]
struct BrokerageCache {
    revision: u64,
    accounts: HashMap<String, BrokerageAccountCache>,
}

#[derive(Default)]
struct BrokerageAccountCache {
    positions: HashMap<String, Position>,
    orders: HashMap<String, OrderUpdate>,
    positions_snapshot_complete: bool,
    orders_snapshot_complete: bool,
    positions_streaming: bool,
    orders_streaming: bool,
}

#[derive(Clone)]
struct BrokerageSnapshot {
    positions: Vec<Position>,
    orders: Vec<OrderUpdate>,
    positions_ready: bool,
    orders_ready: bool,
}

impl TradeStation {
    pub fn new() -> Result<Self, AppError> {
        let client = build_http_client(REST_CLIENT_POLICY)?;
        let stream_client = build_http_client(STREAM_CLIENT_POLICY)?;
        let (brokerage_revision, _) = watch::channel(0);
        Ok(Self {
            client,
            stream_client,
            session: Arc::new(Mutex::new(Session::default())),
            quota: QuotaCoordinator::default(),
            cache: Arc::new(Mutex::new(ClientCache::default())),
            inflight_gets: Arc::new(Mutex::new(HashMap::new())),
            brokerage_cache: Arc::new(Mutex::new(BrokerageCache::default())),
            brokerage_revision,
        })
    }

    pub async fn set_environment(&self, environment: TradingEnvironment) {
        self.session.lock().await.environment = environment;
        *self.cache.lock().await = ClientCache::default();
        self.clear_brokerage_cache().await;
    }

    pub async fn set_token(&self, value: String, expires_in: u64) {
        self.session.lock().await.token = Some(AccessToken {
            value,
            expires_at: Instant::now() + Duration::from_secs(expires_in.saturating_sub(45)),
        });
    }

    pub async fn clear_token(&self) {
        self.session.lock().await.token = None;
        *self.cache.lock().await = ClientCache::default();
        self.clear_brokerage_cache().await;
    }

    fn brokerage_key(environment: &TradingEnvironment, account_id: &str) -> String {
        format!("{}\0{account_id}", environment.key())
    }

    fn publish_brokerage_revision(&self, cache: &mut BrokerageCache) {
        cache.revision = cache.revision.wrapping_add(1);
        self.brokerage_revision.send_replace(cache.revision);
    }

    pub(crate) async fn clear_brokerage_cache(&self) {
        let mut cache = self.brokerage_cache.lock().await;
        cache.accounts.clear();
        self.publish_brokerage_revision(&mut cache);
    }

    pub(crate) async fn reset_brokerage_cache(
        &self,
        environment: &TradingEnvironment,
        account_id: &str,
    ) {
        let mut cache = self.brokerage_cache.lock().await;
        cache.accounts.insert(
            Self::brokerage_key(environment, account_id),
            BrokerageAccountCache::default(),
        );
        self.publish_brokerage_revision(&mut cache);
    }

    pub(crate) async fn set_brokerage_stream_state(
        &self,
        environment: &TradingEnvironment,
        account_id: &str,
        channel: &str,
        state: &str,
    ) {
        let mut cache = self.brokerage_cache.lock().await;
        let account = cache
            .accounts
            .entry(Self::brokerage_key(environment, account_id))
            .or_default();
        let streaming = state == "streaming";
        if channel == "positions" {
            account.positions_streaming = streaming;
            if !streaming {
                account.positions_snapshot_complete = false;
            }
        } else {
            account.orders_streaming = streaming;
            if !streaming {
                account.orders_snapshot_complete = false;
            }
        }
        self.publish_brokerage_revision(&mut cache);
    }

    pub(crate) async fn apply_positions_snapshot(
        &self,
        environment: &TradingEnvironment,
        account_id: &str,
        positions: &[Position],
    ) {
        let mut cache = self.brokerage_cache.lock().await;
        let account = cache
            .accounts
            .entry(Self::brokerage_key(environment, account_id))
            .or_default();
        account.positions = positions
            .iter()
            .filter(|position| position.quantity != 0.0)
            .map(|position| (position.id.clone(), position.clone()))
            .collect();
        account.positions_snapshot_complete = true;
        self.publish_brokerage_revision(&mut cache);
    }

    pub(crate) async fn apply_position_update(
        &self,
        environment: &TradingEnvironment,
        account_id: &str,
        position: &Position,
    ) {
        let mut cache = self.brokerage_cache.lock().await;
        let account = cache
            .accounts
            .entry(Self::brokerage_key(environment, account_id))
            .or_default();
        if position.quantity == 0.0 {
            account.positions.remove(&position.id);
        } else {
            account
                .positions
                .insert(position.id.clone(), position.clone());
        }
        self.publish_brokerage_revision(&mut cache);
    }

    pub(crate) async fn apply_orders_snapshot(
        &self,
        environment: &TradingEnvironment,
        account_id: &str,
        orders: &[OrderUpdate],
    ) {
        let mut cache = self.brokerage_cache.lock().await;
        let account = cache
            .accounts
            .entry(Self::brokerage_key(environment, account_id))
            .or_default();
        account.orders = orders
            .iter()
            .map(|order| (order.id.clone(), order.clone()))
            .collect();
        account.orders_snapshot_complete = true;
        self.publish_brokerage_revision(&mut cache);
    }

    pub(crate) async fn apply_order_update(
        &self,
        environment: &TradingEnvironment,
        account_id: &str,
        order: &OrderUpdate,
    ) {
        let mut cache = self.brokerage_cache.lock().await;
        let account = cache
            .accounts
            .entry(Self::brokerage_key(environment, account_id))
            .or_default();
        account.orders.insert(order.id.clone(), order.clone());
        self.publish_brokerage_revision(&mut cache);
    }

    async fn brokerage_snapshot(
        &self,
        environment: &TradingEnvironment,
        account_id: &str,
    ) -> Option<BrokerageSnapshot> {
        let cache = self.brokerage_cache.lock().await;
        cache
            .accounts
            .get(&Self::brokerage_key(environment, account_id))
            .map(|account| BrokerageSnapshot {
                positions: account.positions.values().cloned().collect(),
                orders: account.orders.values().cloned().collect(),
                positions_ready: account.positions_streaming && account.positions_snapshot_complete,
                orders_ready: account.orders_streaming && account.orders_snapshot_complete,
            })
    }

    async fn refresh(&self) -> Result<String, AppError> {
        let client_id =
            storage::get_secret("client_id")?.ok_or(AppError::AuthenticationRequired)?;
        let client_secret =
            storage::get_secret("client_secret")?.ok_or(AppError::AuthenticationRequired)?;
        let refresh_token =
            storage::get_secret("refresh_token")?.ok_or(AppError::AuthenticationRequired)?;
        let response = self
            .client
            .post("https://signin.tradestation.com/oauth/token")
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("refresh_token", refresh_token.as_str()),
            ])
            .send()
            .await?;
        if !response.status().is_success() {
            self.clear_token().await;
            return Err(AppError::AuthenticationRequired);
        }
        let body: Value = response.json().await?;
        let access = body
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Api("Token response omitted access_token".into()))?
            .to_string();
        if let Some(rotated) = body.get("refresh_token").and_then(Value::as_str) {
            storage::set_secret("refresh_token", rotated)?;
        }
        let expires = body
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(1200);
        self.set_token(access.clone(), expires).await;
        Ok(access)
    }

    pub async fn token(&self) -> Result<String, AppError> {
        if let Some(token) = self.session.lock().await.token.clone() {
            if token.expires_at > Instant::now() {
                return Ok(token.value);
            }
        }
        self.refresh().await
    }

    async fn base(&self) -> String {
        self.session.lock().await.environment.base_url().to_string()
    }

    pub async fn environment(&self) -> TradingEnvironment {
        self.session.lock().await.environment.clone()
    }

    pub async fn open_stream(
        &self,
        path: &str,
        priority: RequestPriority,
    ) -> Result<reqwest::Response, AppError> {
        let (resource, history_credits) = request_profile(path);
        self.quota
            .acquire(resource, priority, history_credits, None)
            .await?;
        let token = self.token().await?;
        let url = format!("{}{}", self.base().await, path);
        let response = self
            .stream_client
            .get(url)
            .bearer_auth(token)
            .send()
            .await?;
        self.quota.observe(resource, response.headers()).await;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.clear_token().await;
            return Err(AppError::AuthenticationRequired);
        }
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err(rate_limit_error(response.headers(), resource));
        }
        if !response.status().is_success() {
            return Err(AppError::Api(format!(
                "TradeStation stream returned HTTP {}",
                response.status()
            )));
        }
        Ok(response)
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let priority = if method == Method::GET {
            default_priority(path)
        } else {
            RequestPriority::Trading
        };
        self.send_with_priority(method, path, body, priority).await
    }

    async fn send_with_priority(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        priority: RequestPriority,
    ) -> Result<Value, AppError> {
        if method != Method::GET {
            return self.send_request(method, path, body, priority).await;
        }
        let key = format!("{}{}", self.base().await, path);
        let receiver = {
            let mut inflight = self.inflight_gets.lock().await;
            if let Some(waiters) = inflight.get_mut(&key) {
                let (sender, receiver) = oneshot::channel();
                waiters.push(sender);
                Some(receiver)
            } else {
                inflight.insert(key.clone(), Vec::new());
                None
            }
        };
        if let Some(receiver) = receiver {
            return receiver
                .await
                .map_err(|_| AppError::Api("A shared TradeStation request was cancelled".into()))?
                .map_err(AppError::Api);
        }
        let result = self.send_request(method, path, body, priority).await;
        let shared = result
            .as_ref()
            .map(Clone::clone)
            .map_err(ToString::to_string);
        if let Some(waiters) = self.inflight_gets.lock().await.remove(&key) {
            for waiter in waiters {
                let _ = waiter.send(shared.clone());
            }
        }
        result
    }

    async fn send_request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        priority: RequestPriority,
    ) -> Result<Value, AppError> {
        let (resource, history_credits) = request_profile(path);
        let max_wait = (method != Method::GET || priority == RequestPriority::Trading)
            .then_some(Duration::from_secs(2));
        let retryable = method == Method::GET;
        let url = format!("{}{}", self.base().await, path);
        let mut rate_retries = 0u8;
        let mut auth_retry = false;
        loop {
            self.quota
                .acquire(resource, priority, history_credits, max_wait)
                .await?;
            let token = self.token().await?;
            let mut request = self
                .client
                .request(method.clone(), &url)
                .bearer_auth(token)
                .header("Accept", "application/json");
            if let Some(value) = body.as_ref() {
                request = request.json(value);
            }
            let response = request.send().await?;
            self.quota.observe(resource, response.headers()).await;
            if response.status() == StatusCode::UNAUTHORIZED && !auth_retry {
                auth_retry = true;
                self.clear_token().await;
                self.refresh().await?;
                continue;
            }
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                let error = rate_limit_error(response.headers(), resource);
                if retryable && priority != RequestPriority::Trading && rate_retries < 2 {
                    rate_retries += 1;
                    let delay = rate_limit_delay(&error);
                    tracing::debug!(
                        resource,
                        retry_seconds = delay.as_secs(),
                        "Waiting for TradeStation rate-limit reset"
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Err(error);
            }
            let status = response.status();
            let text = response.text().await?;
            if !status.is_success() {
                let safe_message = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("Message")
                            .or_else(|| v.get("message"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| format!("TradeStation returned HTTP {status}"));
                return Err(AppError::Api(safe_message));
            }
            return if text.trim().is_empty() {
                Ok(json!({}))
            } else {
                Ok(serde_json::from_str(&text)?)
            };
        }
    }

    async fn get_absolute(&self, url: &str, resource: &str) -> Result<Value, AppError> {
        let mut retries = 0u8;
        loop {
            self.quota
                .acquire(resource, RequestPriority::User, 0.0, None)
                .await?;
            let response = self
                .client
                .get(url)
                .bearer_auth(self.token().await?)
                .header("Accept", "application/json")
                .send()
                .await?;
            self.quota.observe(resource, response.headers()).await;
            if response.status() == StatusCode::UNAUTHORIZED {
                self.clear_token().await;
                return Err(AppError::AuthenticationRequired);
            }
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                let error = rate_limit_error(response.headers(), resource);
                if retries < 2 {
                    retries += 1;
                    tokio::time::sleep(rate_limit_delay(&error)).await;
                    continue;
                }
                return Err(error);
            }
            let status = response.status();
            let text = response.text().await?;
            if !status.is_success() {
                return Err(AppError::Api(format!(
                    "TradeStation lookup returned HTTP {status}"
                )));
            }
            return Ok(serde_json::from_str(&text)?);
        }
    }

    pub async fn exchange_code(&self, code: &str) -> Result<(), AppError> {
        let client_id =
            storage::get_secret("client_id")?.ok_or(AppError::AuthenticationRequired)?;
        let client_secret =
            storage::get_secret("client_secret")?.ok_or(AppError::AuthenticationRequired)?;
        let response = self
            .client
            .post("https://signin.tradestation.com/oauth/token")
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("code", code),
                ("redirect_uri", "http://localhost:8080"),
            ])
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(AppError::Api(
                "TradeStation authorization-code exchange failed".into(),
            ));
        }
        let body: Value = response.json().await?;
        let access = required_string(&body, "access_token")?;
        let refresh = required_string(&body, "refresh_token")?;
        storage::set_secret("refresh_token", &refresh)?;
        self.set_token(
            access,
            body.get("expires_in")
                .and_then(Value::as_u64)
                .unwrap_or(1200),
        )
        .await;
        Ok(())
    }

    pub async fn accounts(&self) -> Result<Vec<Account>, AppError> {
        self.accounts_with_priority(RequestPriority::User).await
    }

    async fn accounts_with_priority(
        &self,
        priority: RequestPriority,
    ) -> Result<Vec<Account>, AppError> {
        if let Some((cached_at, accounts)) = self.cache.lock().await.accounts.as_ref() {
            if cached_at.elapsed() < Duration::from_secs(30) {
                return Ok(accounts.clone());
            }
        }
        let body = self
            .send_with_priority(Method::GET, "/brokerage/accounts", None, priority)
            .await?;
        let accounts: Vec<_> = body
            .get("Accounts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|item| {
                let id = string(item, "AccountID");
                Account {
                    display_id: mask_account(&id),
                    id,
                    account_type: string(item, "AccountType"),
                    status: string(item, "Status"),
                    currency: string(item, "Currency"),
                }
            })
            .filter(|account| account.account_type.eq_ignore_ascii_case("Futures"))
            .collect();
        self.cache.lock().await.accounts = Some((Instant::now(), accounts.clone()));
        Ok(accounts)
    }

    pub async fn search_symbols(&self, query: &str) -> Result<Vec<SymbolMeta>, AppError> {
        let live = matches!(
            self.session.lock().await.environment,
            TradingEnvironment::Live
        );
        let host = if live {
            "https://api.tradestation.com/v2"
        } else {
            "https://sim-api.tradestation.com/v2"
        };
        let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
        let url = format!(
            "{host}/data/symbols/suggest/{encoded}?$top=20&$filter=Category%20eq%20%27Future%27"
        );
        let body = self.get_absolute(&url, "symbols").await?;
        Ok(body
            .as_array()
            .into_iter()
            .flatten()
            .map(symbol_from_value)
            .collect())
    }

    pub async fn future_contracts(&self, root: &str) -> Result<Vec<SymbolMeta>, AppError> {
        let root = root.trim().to_ascii_uppercase();
        if root.is_empty() || root.len() > 16 || !root.chars().all(|ch| ch.is_ascii_alphanumeric())
        {
            return Err(AppError::Validation("Invalid futures root".into()));
        }
        let live = matches!(
            self.session.lock().await.environment,
            TradingEnvironment::Live
        );
        let host = if live {
            "https://api.tradestation.com/v2"
        } else {
            "https://sim-api.tradestation.com/v2"
        };
        let criteria = format!("R={root}&C=Future&FT=Electronic&Exp=false");
        let url = format!("{host}/data/symbols/search/{criteria}");
        let body = self.get_absolute(&url, "symbols").await?;
        Ok(filter_future_contracts(
            &root,
            body.as_array().into_iter().flatten(),
        ))
    }

    pub async fn symbol_details(&self, symbol: &str) -> Result<SymbolMeta, AppError> {
        self.symbol_details_with_priority(symbol, RequestPriority::User)
            .await
    }

    async fn symbol_details_with_priority(
        &self,
        symbol: &str,
        priority: RequestPriority,
    ) -> Result<SymbolMeta, AppError> {
        let environment = self.environment().await;
        let cache_key = format!("{}:{symbol}", environment.key());
        if let Some((cached_at, details)) = self.cache.lock().await.symbols.get(&cache_key) {
            if cached_at.elapsed() < Duration::from_secs(15 * 60) {
                return Ok(details.clone());
            }
        }
        let path = format!("/marketdata/symbols/{symbol}");
        let body = self
            .send_with_priority(Method::GET, &path, None, priority)
            .await?;
        let item = body
            .get("Symbols")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .ok_or_else(|| AppError::Api("Symbol details unavailable".into()))?;
        let details = symbol_from_value(item);
        if details.point_value <= 0.0 {
            return Err(AppError::Api(format!(
                "TradeStation omitted point value for {symbol}"
            )));
        }
        self.cache
            .lock()
            .await
            .symbols
            .insert(cache_key, (Instant::now(), details.clone()));
        Ok(details)
    }

    pub async fn bars(&self, symbol: &str, timeframe: &str) -> Result<Vec<Bar>, AppError> {
        let (interval, unit, bars_back) = history_spec(timeframe)?;
        validate_bars_back(interval, unit, bars_back)?;
        let path = format!(
            "/marketdata/barcharts/{symbol}?interval={interval}&unit={unit}&barsback={bars_back}"
        );
        let body = self
            .send_with_priority(Method::GET, &path, None, RequestPriority::User)
            .await?;
        let mut result: Vec<Bar> = body
            .get("Bars")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| bar_from_value(item, timeframe))
            .collect();
        result.sort_by_key(|bar| bar.time);
        result.dedup_by_key(|bar| bar.time);
        Ok(result)
    }

    pub async fn older_bars(
        &self,
        symbol: &str,
        timeframe: &str,
        before: i64,
    ) -> Result<Vec<Bar>, AppError> {
        let (interval, unit, target) = history_spec(timeframe)?;
        let chunk = target.min(if unit == "Minute" {
            (450_000 / interval).max(1)
        } else {
            5_000
        });
        validate_bars_back(interval, unit, chunk)?;
        // Minute bars arrive timestamped at their closing boundary. `before` is
        // stored as the candle-open time, so using it as lastdate asks for the
        // immediately preceding bar without skipping one interval.
        let api_before = if unit == "Minute" {
            before
        } else {
            before.saturating_sub(1)
        };
        let last = DateTime::<Utc>::from_timestamp(api_before, 0)
            .ok_or_else(|| AppError::Validation("Invalid history timestamp".into()))?
            .to_rfc3339();
        let encoded: String = url::form_urlencoded::byte_serialize(last.as_bytes()).collect();
        let path = format!("/marketdata/barcharts/{symbol}?interval={interval}&unit={unit}&barsback={chunk}&lastdate={encoded}");
        let body = self.send(Method::GET, &path, None).await?;
        let mut bars: Vec<_> = body
            .get("Bars")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| bar_from_value(item, timeframe))
            .collect();
        bars.retain(|bar| bar.time < before);
        bars.sort_by_key(|bar| bar.time);
        bars.dedup_by_key(|bar| bar.time);
        Ok(bars)
    }

    pub async fn bars_range(
        &self,
        symbol: &str,
        timeframe: &str,
        first: i64,
        last: i64,
    ) -> Result<Vec<Bar>, AppError> {
        let path = bar_range_path(symbol, timeframe, first, last)?;
        let body = self.send(Method::GET, &path, None).await?;
        let mut bars: Vec<_> = body
            .get("Bars")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| bar_from_value(item, timeframe))
            .filter(|bar| bar.time >= first && bar.time < last)
            .collect();
        bars.sort_by_key(|bar| bar.time);
        bars.dedup_by_key(|bar| bar.time);
        Ok(bars)
    }

    pub fn bar_stream_path(symbol: &str, timeframe: &str) -> Result<String, AppError> {
        let (_, _, bars_back) = history_spec(timeframe)?;
        Self::bar_stream_path_with_bars_back(symbol, timeframe, bars_back)
    }

    pub fn bar_stream_path_with_bars_back(
        symbol: &str,
        timeframe: &str,
        bars_back: usize,
    ) -> Result<String, AppError> {
        let (interval, unit, configured) = history_spec(timeframe)?;
        let bars_back = bars_back.clamp(1, configured);
        validate_bars_back(interval, unit, bars_back)?;
        Ok(format!("/marketdata/stream/barcharts/{symbol}?interval={interval}&unit={unit}&barsback={bars_back}"))
    }

    pub async fn quotes(&self, symbols: &[String]) -> Result<Vec<Quote>, AppError> {
        if symbols.is_empty() {
            return Ok(vec![]);
        }
        if symbols.len() > 100 {
            return Err(AppError::Validation(
                "A maximum of 100 quote symbols is supported".into(),
            ));
        }
        let path = format!("/marketdata/quotes/{}", symbols.join(","));
        let body = self.send(Method::GET, &path, None).await?;
        Ok(body
            .get("Quotes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(quote_from_value)
            .collect())
    }

    pub async fn positions(&self, account: &str) -> Result<Vec<Position>, AppError> {
        self.positions_with_priority(account, RequestPriority::Background)
            .await
    }

    async fn positions_with_priority(
        &self,
        account: &str,
        priority: RequestPriority,
    ) -> Result<Vec<Position>, AppError> {
        let body = self
            .send_with_priority(
                Method::GET,
                &format!("/brokerage/accounts/{account}/positions"),
                None,
                priority,
            )
            .await?;
        Ok(body
            .get("Positions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(position_from_value)
            .collect())
    }

    pub async fn orders(&self, account: &str) -> Result<Vec<OrderUpdate>, AppError> {
        self.orders_with_priority(account, RequestPriority::Background)
            .await
    }

    async fn orders_with_priority(
        &self,
        account: &str,
        priority: RequestPriority,
    ) -> Result<Vec<OrderUpdate>, AppError> {
        let body = self
            .send_with_priority(
                Method::GET,
                &format!("/brokerage/accounts/{account}/orders"),
                None,
                priority,
            )
            .await?;
        Ok(body
            .get("Orders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(order_from_value)
            .collect())
    }

    pub async fn balances(
        &self,
        account: &str,
        bod: bool,
    ) -> Result<Vec<AccountBalance>, AppError> {
        let resource = if bod { "bodbalances" } else { "balances" };
        let body = self
            .send(
                Method::GET,
                &format!("/brokerage/accounts/{account}/{resource}"),
                None,
            )
            .await?;
        let key = if bod { "BODBalances" } else { "Balances" };
        Ok(body
            .get(key)
            .or_else(|| body.get("Balances"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(balance_from_value)
            .collect())
    }

    pub async fn historical_orders(
        &self,
        account: &str,
        since: &str,
        next_token: Option<&str>,
    ) -> Result<HistoricalOrderPage, AppError> {
        let mut path =
            format!("/brokerage/accounts/{account}/historicalorders?since={since}&pageSize=100");
        if let Some(token) = next_token.filter(|value| !value.is_empty()) {
            let encoded: String = url::form_urlencoded::byte_serialize(token.as_bytes()).collect();
            path.push_str("&nextToken=");
            path.push_str(&encoded);
        }
        let body = self
            .send_with_priority(Method::GET, &path, None, RequestPriority::User)
            .await?;
        Ok(HistoricalOrderPage {
            orders: body
                .get("Orders")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(order_from_value)
                .collect(),
            next_token: optional_string(&body, "NextToken"),
        })
    }

    pub async fn confirm_order(&self, draft: &OrderDraft) -> Result<OrderPreview, AppError> {
        self.validate_order(draft).await?;
        let payload = order_payload(draft);
        let body = self
            .send(Method::POST, "/orderexecution/orderconfirm", Some(payload))
            .await?;
        let confirmation = body
            .get("Confirmations")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .unwrap_or(&body);
        Ok(OrderPreview {
            valid: true,
            summary: confirmation
                .get("SummaryMessage")
                .and_then(Value::as_str)
                .unwrap_or("Order passed TradeStation confirmation")
                .to_string(),
            estimated_commission: display_string(confirmation, "EstimatedCommissionDisplay")
                .or_else(|| display_string(confirmation, "EstimatedCommission")),
            initial_margin: display_string(confirmation, "InitialMarginDisplay"),
            errors: vec![],
        })
    }

    pub async fn place_order(&self, draft: &OrderDraft) -> Result<OrderUpdate, AppError> {
        self.validate_order(draft).await?;
        self.submit_order(draft).await
    }

    async fn submit_order(&self, draft: &OrderDraft) -> Result<OrderUpdate, AppError> {
        let body = self
            .send(
                Method::POST,
                "/orderexecution/orders",
                Some(order_payload(draft)),
            )
            .await?;
        let response = body
            .get("Orders")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .unwrap_or(&body);
        let id = string(response, "OrderID");
        if id.is_empty() {
            return Err(AppError::Api(
                response
                    .get("Message")
                    .and_then(Value::as_str)
                    .unwrap_or("Order response was indeterminate")
                    .into(),
            ));
        }
        Ok(OrderUpdate {
            id,
            symbol: draft.symbol.clone(),
            side: draft.side.clone(),
            order_type: draft.order_type.clone(),
            quantity: draft.quantity,
            price: draft.limit_price,
            stop_price: draft.stop_price,
            status: "Pending".into(),
            timestamp: Utc::now().to_rfc3339(),
            account_id: Some(draft.account_id.clone()),
            filled_quantity: Some(0.0),
            remaining_quantity: Some(draft.quantity as f64),
            average_fill_price: None,
            duration: Some(draft.duration.clone()),
            closed_at: None,
            commission: None,
            stop_loss: draft.stop_loss,
            take_profit: draft.take_profit,
            raw_status: None,
            status_description: None,
            open_or_close: None,
            group_name: None,
            related_orders: vec![],
        })
    }

    pub async fn cancel_order(&self, order_id: &str) -> Result<(), AppError> {
        if order_id.is_empty() || !order_id.chars().all(|c| c.is_ascii_digit()) {
            return Err(AppError::Validation("Invalid order ID".into()));
        }
        self.send(
            Method::DELETE,
            &format!("/orderexecution/orders/{order_id}"),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn replace_order(
        &self,
        account_id: &str,
        order_id: &str,
        new_price: f64,
    ) -> Result<OrderUpdate, AppError> {
        validate_order_id(order_id)?;
        if !self
            .accounts_with_priority(RequestPriority::Trading)
            .await?
            .iter()
            .any(|account| account.id == account_id)
        {
            return Err(AppError::Validation(
                "Selected futures account is unavailable".into(),
            ));
        }
        let mut order = self
            .orders_with_priority(account_id, RequestPriority::Trading)
            .await?
            .into_iter()
            .find(|order| order.id == order_id)
            .ok_or_else(|| AppError::Validation("The order is no longer available".into()))?;
        if order.status != "Working" {
            return Err(AppError::Validation(
                "Only working orders can be repositioned".into(),
            ));
        }
        let positions = self
            .positions_with_priority(account_id, RequestPriority::Trading)
            .await?;
        let position = positions
            .iter()
            .find(|position| position.symbol == order.symbol);
        if !is_protective_order(&order, position) {
            return Err(AppError::Validation(
                "Only bracket take-profit and stop-loss orders can be repositioned".into(),
            ));
        }
        if !matches!(order.order_type.as_str(), "Limit" | "StopMarket") {
            return Err(AppError::Validation(
                "This order type cannot be repositioned on the chart".into(),
            ));
        }
        let meta = self
            .symbol_details_with_priority(&order.symbol, RequestPriority::Trading)
            .await?;
        if new_price <= 0.0 || !aligned(new_price, meta.min_move) {
            return Err(AppError::Validation(format!(
                "Price {new_price} is not aligned to the {} tick",
                meta.min_move
            )));
        }
        let payload = replacement_payload(&order, new_price)?;
        if order.order_type == "Limit" {
            order.price = Some(new_price);
        } else {
            order.stop_price = Some(new_price);
        }
        self.send(
            Method::PUT,
            &format!("/orderexecution/orders/{order_id}"),
            Some(payload),
        )
        .await?;
        order.raw_status = Some("ReplacePending".into());
        order.status_description = Some("Cancel/replace request sent".into());
        Ok(order)
    }

    pub async fn close_position(
        &self,
        account_id: &str,
        position_id: &str,
    ) -> Result<ClosePositionResult, AppError> {
        let started_at = Instant::now();
        let environment = self.environment().await;
        let cached = self.brokerage_snapshot(&environment, account_id).await;
        let (positions, orders, used_stream_cache) = if let Some(snapshot) =
            cached.filter(|snapshot| snapshot.positions_ready && snapshot.orders_ready)
        {
            (snapshot.positions, snapshot.orders, true)
        } else {
            let (positions, orders) = tokio::join!(
                self.positions_with_priority(account_id, RequestPriority::Trading),
                self.orders_with_priority(account_id, RequestPriority::Trading),
            );
            (positions?, orders?, false)
        };
        tracing::debug!(
            account = %mask_account(account_id),
            position_id,
            used_stream_cache,
            elapsed_ms = started_at.elapsed().as_millis(),
            "Resolved close-position preflight"
        );
        let position = positions
            .into_iter()
            .find(|position| position.id == position_id)
            .ok_or_else(|| AppError::Validation("The position is no longer open".into()))?;
        let relevant = closing_orders_for_position(&orders, account_id, &position);
        if relevant.iter().any(|order| order.status == "Indeterminate") {
            return Ok(aborted_close(
                position_id,
                &position.symbol,
                vec![],
                "A closing order has an indeterminate status; the position was not flattened",
            ));
        }

        // The lowest-latency safe close is to convert one existing protective
        // order to Market. Because it remains in the TradeStation OCO/BRK
        // group, its sibling is cancelled by the broker when the converted
        // order executes. Never follow a submitted replacement with an
        // independent market order: an ambiguous replacement response could
        // otherwise reverse the position.
        if let Some(protective) = market_replace_candidate(&relevant, &position) {
            let sibling_ids: Vec<String> = relevant
                .iter()
                .filter(|order| {
                    order.id != protective.id
                        && matches!(order.status.as_str(), "Working" | "Pending")
                })
                .map(|order| order.id.clone())
                .collect();
            let payload = match market_replacement_payload(protective, &position) {
                Ok(payload) => payload,
                Err(error) => {
                    return Ok(aborted_close(
                        position_id,
                        &position.symbol,
                        vec![],
                        error.to_string(),
                    ))
                }
            };
            let replacement_started = Instant::now();
            match self
                .send(
                    Method::PUT,
                    &format!("/orderexecution/orders/{}", protective.id),
                    Some(payload),
                )
                .await
            {
                Ok(_) => {
                    let converted = market_replacement_update(protective, &position);
                    self.apply_order_update(&environment, account_id, &converted)
                        .await;
                    tracing::debug!(
                        account = %mask_account(account_id),
                        position_id,
                        order_id = %protective.id,
                        linked_exits = sibling_ids.len(),
                        elapsed_ms = replacement_started.elapsed().as_millis(),
                        total_elapsed_ms = started_at.elapsed().as_millis(),
                        "Converted protective order to market for position close"
                    );
                    return Ok(ClosePositionResult {
                        position_id: position_id.into(),
                        symbol: position.symbol,
                        cancelled_order_ids: sibling_ids,
                        flatten_order: Some(converted),
                        error: None,
                    });
                }
                Err(error) => {
                    tracing::warn!(
                        account = %mask_account(account_id),
                        position_id,
                        order_id = %protective.id,
                        elapsed_ms = replacement_started.elapsed().as_millis(),
                        error = %error,
                        "Protective-order market conversion was not confirmed"
                    );
                    return Ok(aborted_close(
                        position_id,
                        &position.symbol,
                        vec![],
                        format!(
                            "TradeStation did not confirm the protective-order market conversion: {error}. No second market order was submitted; verify the live position before trying again"
                        ),
                    ));
                }
            }
        }

        let active_ids: Vec<String> = relevant
            .iter()
            .filter(|order| matches!(order.status.as_str(), "Working" | "Pending"))
            .map(|order| order.id.clone())
            .collect();
        let cancel_ids: Vec<String> = relevant
            .iter()
            .filter(|order| {
                matches!(order.status.as_str(), "Working" | "Pending")
                    && order.raw_status.as_deref() != Some("UCN")
            })
            .map(|order| order.id.clone())
            .collect();
        let mut revision = self.brokerage_revision.subscribe();
        let cancellation_started = Instant::now();
        let cancel_results = futures_util::future::join_all(cancel_ids.iter().map(|order_id| {
            let order_id = order_id.clone();
            async move { (order_id.clone(), self.cancel_order(&order_id).await) }
        }))
        .await;
        let cancellation_errors: Vec<String> = cancel_results
            .into_iter()
            .filter_map(|(order_id, result)| {
                result
                    .err()
                    .map(|error| format!("order {order_id}: {error}"))
            })
            .collect();
        tracing::debug!(
            account = %mask_account(account_id),
            position_id,
            cancellations = cancel_ids.len(),
            elapsed_ms = cancellation_started.elapsed().as_millis(),
            "Submitted protective-order cancellations"
        );

        let mut exit_filled = false;
        let mut refresh_position = false;
        if !active_ids.is_empty() {
            let confirmation_started = Instant::now();
            let fallback_offsets = [250u64, 750, 1_750];
            let mut fallback_index = 0usize;
            'confirmation: loop {
                if let Some(snapshot) = self.brokerage_snapshot(&environment, account_id).await {
                    if snapshot.orders_ready {
                        match cancellation_resolution(&active_ids, &snapshot.orders, false) {
                            Ok(resolution) if resolution.complete => {
                                exit_filled |= resolution.exit_filled;
                                refresh_position |= resolution.position_refresh_required;
                                break;
                            }
                            Ok(resolution) => {
                                exit_filled |= resolution.exit_filled;
                                refresh_position |= resolution.position_refresh_required
                            }
                            Err(error) => {
                                return Ok(aborted_close(
                                    position_id,
                                    &position.symbol,
                                    active_ids,
                                    error.to_string(),
                                ));
                            }
                        }
                    }
                }

                let elapsed = confirmation_started.elapsed();
                if elapsed >= Duration::from_secs(3) {
                    let detail = cancellation_errors
                        .first()
                        .map(|error| format!(" ({error})"))
                        .unwrap_or_default();
                    return Ok(aborted_close(
                        position_id,
                        &position.symbol,
                        active_ids,
                        format!(
                            "Protective orders were not confirmed inactive within 3 seconds{detail}; the position was not flattened"
                        ),
                    ));
                }

                let fallback_at = fallback_offsets
                    .get(fallback_index)
                    .map(|offset| Duration::from_millis(*offset))
                    .unwrap_or(Duration::from_secs(3));
                let wait = fallback_at.saturating_sub(elapsed);
                tokio::select! {
                    changed = revision.changed() => {
                        if changed.is_err() {
                            tokio::time::sleep(wait).await;
                        }
                    }
                    _ = tokio::time::sleep(wait) => {
                        if fallback_index >= fallback_offsets.len() {
                            continue;
                        }
                        fallback_index += 1;
                        let rest_request = self.orders_with_priority(account_id, RequestPriority::Trading);
                        tokio::pin!(rest_request);
                        let current = loop {
                            tokio::select! {
                                changed = revision.changed() => {
                                    if changed.is_err() {
                                        break rest_request.await;
                                    }
                                    if let Some(snapshot) = self.brokerage_snapshot(&environment, account_id).await {
                                        if snapshot.orders_ready {
                                            match cancellation_resolution(&active_ids, &snapshot.orders, false) {
                                                Ok(resolution) if resolution.complete => {
                                                    exit_filled |= resolution.exit_filled;
                                                    refresh_position |= resolution.position_refresh_required;
                                                    break 'confirmation;
                                                }
                                                Ok(resolution) => {
                                                    exit_filled |= resolution.exit_filled;
                                                    refresh_position |= resolution.position_refresh_required;
                                                }
                                                Err(error) => {
                                                    return Ok(aborted_close(
                                                        position_id,
                                                        &position.symbol,
                                                        active_ids,
                                                        error.to_string(),
                                                    ));
                                                }
                                            }
                                        }
                                    }
                                }
                                result = &mut rest_request => break result,
                            }
                        };
                        match current {
                            Ok(current) => match cancellation_resolution(&active_ids, &current, false) {
                                Ok(resolution) if resolution.complete => {
                                    exit_filled |= resolution.exit_filled;
                                    refresh_position |= resolution.position_refresh_required;
                                    break;
                                }
                                Ok(resolution) => {
                                    exit_filled |= resolution.exit_filled;
                                    refresh_position |= resolution.position_refresh_required;
                                }
                                Err(error) => {
                                    return Ok(aborted_close(
                                        position_id,
                                        &position.symbol,
                                        active_ids,
                                        error.to_string(),
                                    ));
                                }
                            },
                            Err(error) if fallback_index >= fallback_offsets.len() => {
                                tracing::debug!(
                                    account = %mask_account(account_id),
                                    position_id,
                                    error = %error,
                                    "Final cancellation fallback request failed"
                                );
                            }
                            Err(_) => {}
                        }
                    }
                }
            }
            tracing::debug!(
                account = %mask_account(account_id),
                position_id,
                exit_filled,
                refresh_position,
                elapsed_ms = confirmation_started.elapsed().as_millis(),
                "Confirmed protective orders inactive"
            );
        }
        let cancelled_order_ids = active_ids;
        let cached_after = self.brokerage_snapshot(&environment, account_id).await;
        let current_positions = if !refresh_position
            && cached_after
                .as_ref()
                .is_some_and(|snapshot| snapshot.positions_ready)
        {
            cached_after.unwrap().positions
        } else {
            match self
                .positions_with_priority(account_id, RequestPriority::Trading)
                .await
            {
                Ok(positions) => positions,
                Err(error) => {
                    return Ok(aborted_close(
                        position_id,
                        &position.symbol,
                        cancelled_order_ids,
                        format!(
                            "Could not verify the remaining position after cancelling exits: {error}. No flatten order was submitted"
                        ),
                    ))
                }
            }
        };
        let Some(current_position) = current_positions
            .into_iter()
            .find(|position| position.id == position_id)
        else {
            return Ok(ClosePositionResult {
                position_id: position_id.into(),
                symbol: position.symbol,
                cancelled_order_ids,
                flatten_order: None,
                error: None,
            });
        };
        let draft = match flatten_draft(account_id, &current_position) {
            Ok(draft) => draft,
            Err(error) => {
                return Ok(aborted_close(
                    position_id,
                    &current_position.symbol,
                    cancelled_order_ids,
                    error.to_string(),
                ))
            }
        };
        let flatten_started = Instant::now();
        let flatten_order = match self.submit_order(&draft).await {
            Ok(order) => order,
            Err(error) => {
                return Ok(aborted_close(
                    position_id,
                    &current_position.symbol,
                    cancelled_order_ids,
                    format!("Exit orders were cancelled, but the flatten order failed: {error}"),
                ))
            }
        };
        tracing::debug!(
            account = %mask_account(account_id),
            position_id,
            elapsed_ms = flatten_started.elapsed().as_millis(),
            total_elapsed_ms = started_at.elapsed().as_millis(),
            "Submitted position-flatten market order"
        );
        Ok(ClosePositionResult {
            position_id: position_id.into(),
            symbol: current_position.symbol,
            cancelled_order_ids,
            flatten_order: Some(flatten_order),
            error: None,
        })
    }

    async fn validate_order(&self, draft: &OrderDraft) -> Result<(), AppError> {
        validate_tradable_symbol(&draft.symbol)?;
        if draft.quantity == 0 {
            return Err(AppError::Validation("Quantity must be at least one".into()));
        }
        if !matches!(draft.side.as_str(), "Buy" | "Sell") {
            return Err(AppError::Validation("Invalid trade side".into()));
        }
        if !matches!(
            draft.order_type.as_str(),
            "Market" | "Limit" | "StopMarket" | "StopLimit"
        ) {
            return Err(AppError::Validation("Unsupported order type".into()));
        }
        let accounts = self
            .accounts_with_priority(RequestPriority::Trading)
            .await?;
        if !accounts.iter().any(|a| a.id == draft.account_id) {
            return Err(AppError::Validation(
                "Selected futures account is unavailable".into(),
            ));
        }
        let meta = self
            .symbol_details_with_priority(&draft.symbol, RequestPriority::Trading)
            .await?;
        for price in [
            draft.limit_price,
            draft.stop_price,
            draft.take_profit,
            draft.stop_loss,
        ]
        .into_iter()
        .flatten()
        {
            if price <= 0.0 || !aligned(price, meta.min_move) {
                return Err(AppError::Validation(format!(
                    "Price {price} is not aligned to the {} tick",
                    meta.min_move
                )));
            }
        }
        if matches!(draft.order_type.as_str(), "Limit" | "StopLimit") && draft.limit_price.is_none()
        {
            return Err(AppError::Validation("Limit price is required".into()));
        }
        if matches!(draft.order_type.as_str(), "StopMarket" | "StopLimit")
            && draft.stop_price.is_none()
        {
            return Err(AppError::Validation("Stop price is required".into()));
        }
        Ok(())
    }
}

fn order_payload(draft: &OrderDraft) -> Value {
    let mut payload = json!({
        "AccountID": draft.account_id, "Symbol": draft.symbol, "Quantity": draft.quantity.to_string(),
        "OrderType": draft.order_type, "TradeAction": draft.side, "Route": "Intelligent", "TimeInForce": { "Duration": draft.duration }
    });
    if let Some(price) = draft.limit_price {
        payload["LimitPrice"] = json!(format_price(price));
    }
    if let Some(price) = draft.stop_price {
        payload["StopPrice"] = json!(format_price(price));
    }
    if draft.take_profit.is_some() || draft.stop_loss.is_some() {
        let exit_side = if draft.side == "Buy" { "Sell" } else { "Buy" };
        let mut exits = vec![];
        if let Some(price) = draft.take_profit {
            exits.push(json!({ "AccountID": draft.account_id, "Symbol": draft.symbol, "Quantity": draft.quantity.to_string(), "OrderType": "Limit", "LimitPrice": format_price(price), "TradeAction": exit_side, "Route": "Intelligent", "TimeInForce": { "Duration": draft.duration } }));
        }
        if let Some(price) = draft.stop_loss {
            exits.push(json!({ "AccountID": draft.account_id, "Symbol": draft.symbol, "Quantity": draft.quantity.to_string(), "OrderType": "StopMarket", "StopPrice": format_price(price), "TradeAction": exit_side, "Route": "Intelligent", "TimeInForce": { "Duration": draft.duration } }));
        }
        payload["OSOs"] =
            json!([{ "Type": if exits.len() > 1 { "OCO" } else { "NORMAL" }, "Orders": exits }]);
    }
    payload
}

pub(crate) fn order_from_value(item: &Value) -> OrderUpdate {
    let leg = item
        .get("Legs")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .unwrap_or(item);
    let raw_status = string(item, "Status");
    let related_orders = item
        .get("ConditionalOrders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|related| {
            let order_id = string(related, "OrderID");
            if order_id.is_empty() {
                return None;
            }
            Some(RelatedOrder {
                order_id,
                relationship: string(related, "Relationship"),
            })
        })
        .collect();
    OrderUpdate {
        id: string(item, "OrderID"),
        symbol: string(leg, "Symbol"),
        side: string(leg, "BuyOrSell"),
        order_type: string(item, "OrderType"),
        quantity: number(leg, "QuantityOrdered") as u32,
        price: optional_number(item, "LimitPrice"),
        stop_price: optional_number(item, "StopPrice"),
        status: normalize_order_status(&raw_status).into(),
        timestamp: string(item, "OpenedDateTime"),
        account_id: optional_string(item, "AccountID"),
        filled_quantity: optional_number(leg, "ExecQuantity"),
        remaining_quantity: optional_number(leg, "QuantityRemaining"),
        average_fill_price: optional_number(leg, "ExecutionPrice"),
        duration: optional_string(item, "Duration"),
        closed_at: optional_string(item, "ClosedDateTime"),
        commission: optional_number(item, "CommissionFee"),
        stop_loss: None,
        take_profit: None,
        raw_status: if raw_status.is_empty() {
            None
        } else {
            Some(raw_status)
        },
        status_description: optional_string(item, "StatusDescription"),
        open_or_close: optional_string(leg, "OpenOrClose"),
        group_name: optional_string(item, "GroupName"),
        related_orders,
    }
}

fn normalize_order_status(status: &str) -> &'static str {
    match status.to_ascii_uppercase().as_str() {
        "OPN" | "ACK" | "UCN" | "FPR" | "DON" | "WORKING" => "Working",
        "FLL" | "FLP" | "FILLED" => "Filled",
        "OUT" | "CAN" | "EXP" | "CANCELLED" | "CANCELED" => "Cancelled",
        "REJ" | "REJECTED" => "Rejected",
        "PENDING" => "Pending",
        _ => "Indeterminate",
    }
}

fn is_bracket_order(order: &OrderUpdate) -> bool {
    order.group_name.as_deref().is_some_and(|name| {
        let name = name.to_ascii_uppercase();
        name.starts_with("OCO") || name.starts_with("BRK")
    }) || order.related_orders.iter().any(|related| {
        matches!(
            related.relationship.to_ascii_uppercase().as_str(),
            "OCO" | "BRK" | "BRACKET"
        )
    })
}

fn is_close_order(order: &OrderUpdate) -> bool {
    order
        .open_or_close
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("Close"))
}

fn is_opposite_position_side(order: &OrderUpdate, position: &Position) -> bool {
    let closing_side = if position.side.eq_ignore_ascii_case("Long") {
        "Sell"
    } else if position.side.eq_ignore_ascii_case("Short") {
        "Buy"
    } else {
        return false;
    };
    order.side.eq_ignore_ascii_case(closing_side)
}

fn is_protective_order(order: &OrderUpdate, position: Option<&Position>) -> bool {
    let inferred_from_position =
        position.is_some_and(|position| is_opposite_position_side(order, position));
    matches!(order.order_type.as_str(), "Limit" | "StopMarket")
        && (is_close_order(order) || inferred_from_position)
        && (is_bracket_order(order) || inferred_from_position)
}

fn closing_orders_for_position<'a>(
    orders: &'a [OrderUpdate],
    account_id: &str,
    position: &Position,
) -> Vec<&'a OrderUpdate> {
    orders
        .iter()
        .filter(|order| {
            order
                .account_id
                .as_deref()
                .is_none_or(|value| value == account_id)
                && order.symbol == position.symbol
                && (is_close_order(order) || is_opposite_position_side(order, position))
                && matches!(
                    order.status.as_str(),
                    "Working" | "Pending" | "Indeterminate"
                )
        })
        .collect()
}

fn flatten_draft(account_id: &str, position: &Position) -> Result<OrderDraft, AppError> {
    let quantity = position.quantity.abs();
    let rounded = quantity.round();
    if quantity <= 0.0 || (quantity - rounded).abs() > 1e-8 || rounded > u32::MAX as f64 {
        return Err(AppError::Validation(
            "Position quantity cannot be flattened as a futures order".into(),
        ));
    }
    let side = match position.side.as_str() {
        "Long" => "Sell",
        "Short" => "Buy",
        _ => return Err(AppError::Validation("Position side is invalid".into())),
    };
    Ok(OrderDraft {
        account_id: account_id.into(),
        symbol: position.symbol.clone(),
        side: side.into(),
        order_type: "Market".into(),
        quantity: rounded as u32,
        limit_price: None,
        stop_price: None,
        duration: "DAY".into(),
        take_profit: None,
        stop_loss: None,
    })
}

fn remaining_futures_quantity(order: &OrderUpdate) -> Option<u32> {
    let quantity = order.remaining_quantity.unwrap_or(order.quantity as f64);
    let rounded = quantity.round();
    (quantity > 0.0 && (quantity - rounded).abs() <= 1e-8 && rounded <= u32::MAX as f64)
        .then_some(rounded as u32)
}

fn oco_relationship(value: &str) -> bool {
    matches!(
        value.to_ascii_uppercase().as_str(),
        "OCO" | "BRK" | "BRACKET"
    )
}

fn explicitly_linked_oco(left: &OrderUpdate, right: &OrderUpdate) -> bool {
    let linked = |source: &OrderUpdate, target: &OrderUpdate| {
        source
            .related_orders
            .iter()
            .any(|related| related.order_id == target.id && oco_relationship(&related.relationship))
    };
    if linked(left, right) || linked(right, left) {
        return true;
    }
    left.group_name
        .as_deref()
        .zip(right.group_name.as_deref())
        .is_some_and(|(left_group, right_group)| {
            left_group.eq_ignore_ascii_case(right_group) && {
                let group = left_group.to_ascii_uppercase();
                group.starts_with("OCO") || group.starts_with("BRK")
            }
        })
}

fn market_replace_candidate<'a>(
    relevant: &[&'a OrderUpdate],
    position: &Position,
) -> Option<&'a OrderUpdate> {
    let active: Vec<&OrderUpdate> = relevant
        .iter()
        .copied()
        .filter(|order| matches!(order.status.as_str(), "Working" | "Pending"))
        .collect();
    if active.is_empty()
        || active
            .iter()
            .any(|order| order.status != "Working" || order.raw_status.as_deref() == Some("UCN"))
    {
        return None;
    }
    let position_quantity = position.quantity.abs().round() as u32;
    let mut eligible: Vec<&OrderUpdate> = active
        .iter()
        .copied()
        .filter(|order| {
            matches!(order.order_type.as_str(), "Limit" | "StopMarket")
                && is_protective_order(order, Some(position))
                && remaining_futures_quantity(order) == Some(position_quantity)
        })
        .collect();
    // Prefer converting the take-profit leg so the stop remains protective
    // until TradeStation accepts the cancel/replace request.
    eligible.sort_by_key(|order| (order.order_type != "Limit", order.id.as_str()));
    eligible.into_iter().find(|candidate| {
        active.len() == 1
            || active
                .iter()
                .all(|other| other.id == candidate.id || explicitly_linked_oco(candidate, other))
    })
}

fn market_replacement_payload(order: &OrderUpdate, position: &Position) -> Result<Value, AppError> {
    let quantity = remaining_futures_quantity(order).ok_or_else(|| {
        AppError::Validation("The protective order has no replaceable quantity".into())
    })?;
    if (quantity as f64 - position.quantity.abs()).abs() > 1e-8 {
        return Err(AppError::Validation(
            "The protective order does not cover the complete remaining position".into(),
        ));
    }
    Ok(json!({
        "OrderType": "Market",
        "Quantity": quantity.to_string()
    }))
}

fn market_replacement_update(order: &OrderUpdate, position: &Position) -> OrderUpdate {
    let mut converted = order.clone();
    let quantity = position.quantity.abs().round() as u32;
    converted.order_type = "Market".into();
    converted.quantity = quantity;
    converted.price = None;
    converted.stop_price = None;
    converted.status = "Pending".into();
    converted.timestamp = Utc::now().to_rfc3339();
    converted.filled_quantity = Some(0.0);
    converted.remaining_quantity = Some(quantity as f64);
    converted.raw_status = Some("ReplacePending".into());
    converted.status_description = Some("Protective exit conversion sent".into());
    converted
}

pub(crate) fn position_from_value(item: &Value) -> Position {
    Position {
        id: string(item, "PositionID"),
        symbol: string(item, "Symbol"),
        side: string(item, "LongShort"),
        // LongShort is authoritative for direction. Normalize signed quantities
        // to an absolute futures contract count for display and flattening.
        quantity: number(item, "Quantity").abs(),
        average_price: number(item, "AveragePrice"),
        last: number(item, "Last"),
        unrealized_pnl: number(item, "UnrealizedProfitLoss"),
        bid: optional_number(item, "Bid"),
        ask: optional_number(item, "Ask"),
        unrealized_pnl_percent: optional_number(item, "UnrealizedProfitLossPercent"),
        unrealized_pnl_quantity: optional_number(item, "UnrealizedProfitLossQty"),
        initial_requirement: optional_number(item, "InitialRequirement"),
        maintenance_margin: optional_number(item, "MaintenanceMargin"),
        market_value: optional_number(item, "MarketValue"),
        timestamp: optional_string(item, "Timestamp"),
    }
}

fn replacement_payload(order: &OrderUpdate, new_price: f64) -> Result<Value, AppError> {
    let quantity = order.remaining_quantity.unwrap_or(order.quantity as f64);
    if quantity <= 0.0 {
        return Err(AppError::Validation(
            "The order has no remaining quantity".into(),
        ));
    }
    let mut payload = json!({ "Quantity": format_price(quantity) });
    match order.order_type.as_str() {
        "Limit" => payload["LimitPrice"] = json!(format_price(new_price)),
        "StopMarket" => payload["StopPrice"] = json!(format_price(new_price)),
        _ => {
            return Err(AppError::Validation(
                "This order type cannot be repositioned on the chart".into(),
            ))
        }
    }
    Ok(payload)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CancellationResolution {
    complete: bool,
    exit_filled: bool,
    position_refresh_required: bool,
}

fn cancellation_resolution(
    active_ids: &[String],
    current: &[OrderUpdate],
    timed_out: bool,
) -> Result<CancellationResolution, AppError> {
    if active_ids.iter().any(|id| {
        current
            .iter()
            .any(|order| order.id == *id && order.status == "Indeterminate")
    }) {
        return Err(AppError::Api(
            "A closing order became indeterminate; the position was not flattened".into(),
        ));
    }
    let unresolved = active_ids.iter().any(|id| {
        current
            .iter()
            .any(|order| order.id == *id && matches!(order.status.as_str(), "Working" | "Pending"))
    });
    if unresolved && timed_out {
        return Err(AppError::Api(
            "Closing orders did not cancel within 10 seconds; the position was not flattened"
                .into(),
        ));
    }
    let exit_filled = active_ids.iter().any(|id| {
        current
            .iter()
            .any(|order| order.id == *id && order.status == "Filled")
    });
    let missing_order = active_ids
        .iter()
        .any(|id| !current.iter().any(|order| order.id == *id));
    Ok(CancellationResolution {
        complete: !unresolved,
        exit_filled,
        position_refresh_required: exit_filled || missing_order,
    })
}

#[cfg(test)]
fn cancellation_poll_complete(
    active_ids: &[String],
    current: &[OrderUpdate],
    timed_out: bool,
) -> Result<bool, AppError> {
    Ok(cancellation_resolution(active_ids, current, timed_out)?.complete)
}

fn aborted_close(
    position_id: &str,
    symbol: &str,
    cancelled_order_ids: Vec<String>,
    error: impl Into<String>,
) -> ClosePositionResult {
    ClosePositionResult {
        position_id: position_id.into(),
        symbol: symbol.into(),
        cancelled_order_ids,
        flatten_order: None,
        error: Some(error.into()),
    }
}

fn validate_order_id(order_id: &str) -> Result<(), AppError> {
    if order_id.is_empty() || !order_id.chars().all(|character| character.is_ascii_digit()) {
        return Err(AppError::Validation("Invalid order ID".into()));
    }
    Ok(())
}

fn balance_from_value(item: &Value) -> AccountBalance {
    let detail = item.get("BalanceDetail").unwrap_or(item);
    AccountBalance {
        account_id: string(item, "AccountID"),
        account_type: string(item, "AccountType"),
        currency: string(item, "Currency"),
        cash_balance: optional_number(item, "CashBalance"),
        buying_power: optional_number(item, "BuyingPower"),
        equity: optional_number(item, "Equity"),
        market_value: optional_number(item, "MarketValue"),
        todays_profit_loss: optional_number(item, "TodaysProfitLoss"),
        realized_profit_loss: optional_number(detail, "RealizedProfitLoss"),
        unrealized_profit_loss: optional_number(detail, "UnrealizedProfitLoss"),
        uncleared_deposit: optional_number(item, "UnclearedDeposit"),
        commission: optional_number(item, "Commission")
            .or_else(|| optional_number(detail, "Commission")),
        initial_margin: optional_number(detail, "InitialMargin"),
        maintenance_margin: optional_number(detail, "MaintenanceMargin"),
        open_order_margin: optional_number(detail, "OpenOrderMargin"),
        balance_date: optional_string(item, "BalanceDate"),
    }
}

pub fn history_spec(timeframe: &str) -> Result<(usize, &'static str, usize), AppError> {
    match timeframe {
        "1m" => Ok((1, "Minute", 10_000)),
        "5m" => Ok((5, "Minute", 10_000)),
        "15m" => Ok((15, "Minute", 10_000)),
        "30m" => Ok((30, "Minute", 10_000)),
        "1h" => Ok((60, "Minute", 8_000)),
        "4h" => Ok((240, "Minute", 2_000)),
        "D" => Ok((1, "Daily", 5_000)),
        "W" => Ok((1, "Weekly", 2_500)),
        "M" => Ok((1, "Monthly", 1_000)),
        _ => Err(AppError::Validation("Unsupported timeframe".into())),
    }
}

fn validate_bars_back(interval: usize, unit: &str, bars_back: usize) -> Result<(), AppError> {
    if bars_back > 57_600 {
        return Err(AppError::Validation(
            "Historical bar requests cannot exceed 57,600 bars".into(),
        ));
    }
    if unit.eq_ignore_ascii_case("minute") && bars_back.saturating_mul(interval) > 500_000 {
        return Err(AppError::Validation(
            "Historical bars-back requests cannot exceed 500,000 minutes".into(),
        ));
    }
    Ok(())
}

fn bar_range_path(
    symbol: &str,
    timeframe: &str,
    first: i64,
    last: i64,
) -> Result<String, AppError> {
    if first >= last {
        return Err(AppError::Validation("Invalid bar range".into()));
    }
    let (interval, unit, _) = history_spec(timeframe)?;
    if unit == "Minute" && last.saturating_sub(first) > 31 * 24 * 60 * 60 {
        return Err(AppError::Validation(
            "Minute bar ranges cannot exceed 31 days".into(),
        ));
    }
    let first_date = DateTime::<Utc>::from_timestamp(first, 0)
        .ok_or_else(|| AppError::Validation("Invalid first bar timestamp".into()))?
        .to_rfc3339();
    let last_date = DateTime::<Utc>::from_timestamp(last, 0)
        .ok_or_else(|| AppError::Validation("Invalid last bar timestamp".into()))?
        .to_rfc3339();
    let encoded_first: String =
        url::form_urlencoded::byte_serialize(first_date.as_bytes()).collect();
    let encoded_last: String = url::form_urlencoded::byte_serialize(last_date.as_bytes()).collect();
    Ok(format!("/marketdata/barcharts/{symbol}?interval={interval}&unit={unit}&firstdate={encoded_first}&lastdate={encoded_last}"))
}

pub fn bar_from_value(item: &Value, timeframe: &str) -> Option<Bar> {
    let closing_time = item
        .get("Epoch")
        .and_then(number_i64)
        .map(|v| v / 1000)
        .or_else(|| {
            item.get("TimeStamp")
                .and_then(Value::as_str)
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.timestamp())
        })?;
    // TradeStation labels intraday bars with the end of their interval, while
    // Lightweight Charts labels candles with the beginning. Normalize once at
    // the API boundary so history, streams, cache keys, and drawings agree.
    let interval_seconds = history_spec(timeframe)
        .ok()
        .filter(|(_, unit, _)| *unit == "Minute")
        .and_then(|(interval, _, _)| i64::try_from(interval).ok()?.checked_mul(60))
        .unwrap_or(0);
    let time = closing_time.checked_sub(interval_seconds)?;
    Some(Bar {
        time,
        open: number(item, "Open"),
        high: number(item, "High"),
        low: number(item, "Low"),
        close: number(item, "Close"),
        volume: number(item, "TotalVolume"),
        realtime: item
            .get("IsRealtime")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub fn quote_from_value(item: &Value) -> Option<Quote> {
    quote_from_value_with_previous(item, None)
}

pub fn merge_quote_update(quotes: &mut HashMap<String, Quote>, item: &Value) -> Option<Quote> {
    let symbol = string(item, "Symbol");
    if symbol.is_empty() {
        return None;
    }
    let quote = quote_from_value_with_previous(item, quotes.get(&symbol))?;
    quotes.insert(symbol, quote.clone());
    Some(quote)
}

fn quote_from_value_with_previous(item: &Value, previous: Option<&Quote>) -> Option<Quote> {
    let symbol = string(item, "Symbol");
    if symbol.is_empty() {
        return None;
    }
    let flags = item.get("MarketFlags").unwrap_or(&Value::Null);
    Some(Quote {
        symbol,
        last: optional_number(item, "Last")
            .or_else(|| previous.map(|quote| quote.last))
            .unwrap_or_default(),
        bid: optional_number(item, "Bid")
            .or_else(|| previous.map(|quote| quote.bid))
            .unwrap_or_default(),
        ask: optional_number(item, "Ask")
            .or_else(|| previous.map(|quote| quote.ask))
            .unwrap_or_default(),
        change: optional_number(item, "NetChange")
            .or_else(|| previous.map(|quote| quote.change))
            .unwrap_or_default(),
        change_pct: optional_number(item, "NetChangePct")
            .or_else(|| previous.map(|quote| quote.change_pct))
            .unwrap_or_default(),
        delayed: flags
            .get("IsDelayed")
            .and_then(Value::as_bool)
            .or_else(|| previous.map(|quote| quote.delayed))
            .unwrap_or(true),
        halted: flags
            .get("IsHalted")
            .and_then(Value::as_bool)
            .or_else(|| previous.map(|quote| quote.halted))
            .unwrap_or(false),
        timestamp: optional_string(item, "TradeTime")
            .or_else(|| previous.map(|quote| quote.timestamp.clone()))
            .unwrap_or_default(),
    })
}

fn symbol_from_value(item: &Value) -> SymbolMeta {
    let price_format = item.get("PriceFormat").unwrap_or(&Value::Null);
    SymbolMeta {
        symbol: string(item, "Name").or_else_empty(|| string(item, "Symbol")),
        description: string(item, "Description"),
        exchange: string(item, "Exchange"),
        asset_type: string(item, "Category").or_else_empty(|| string(item, "AssetType")),
        // v3 symbol details carries the compatible price increment and point
        // value together under PriceFormat. v2 suggestions use a different
        // scale, so never combine one endpoint's MinMove with the other's value.
        min_move: optional_number(price_format, "Increment")
            .or_else(|| optional_number(item, "MinMove"))
            .unwrap_or(0.0)
            .max(0.00000001),
        point_value: optional_number(price_format, "PointValue")
            .or_else(|| optional_number(item, "PointValue"))
            .unwrap_or(0.0),
        expiration: item
            .get("ExpirationDate")
            .and_then(Value::as_str)
            .map(str::to_owned),
        root: optional_string(item, "Root"),
        underlying: optional_string(item, "Underlying"),
    }
}

fn filter_future_contracts<'a>(
    root: &str,
    items: impl Iterator<Item = &'a Value>,
) -> Vec<SymbolMeta> {
    let mut contracts: Vec<_> = items
        .map(symbol_from_value)
        .filter(|symbol| {
            !symbol.symbol.starts_with('@')
                && symbol
                    .expiration
                    .as_deref()
                    .is_some_and(|value| !value.is_empty())
                && symbol
                    .root
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(root))
                && symbol.asset_type.eq_ignore_ascii_case("Future")
        })
        .collect();
    contracts.sort_by(|left, right| {
        left.expiration
            .cmp(&right.expiration)
            .then_with(|| left.symbol.cmp(&right.symbol))
    });
    contracts.dedup_by(|left, right| left.symbol == right.symbol);
    contracts
}

fn validate_tradable_symbol(symbol: &str) -> Result<(), AppError> {
    let symbol = symbol.trim();
    if symbol.is_empty() {
        return Err(AppError::Validation("Order symbol is required".into()));
    }
    if symbol.starts_with('@') {
        return Err(AppError::Validation(
            "Continuous futures symbols cannot be traded; select a concrete contract".into(),
        ));
    }
    Ok(())
}

trait EmptyFallback {
    fn or_else_empty(self, f: impl FnOnce() -> String) -> String;
}
impl EmptyFallback for String {
    fn or_else_empty(self, f: impl FnOnce() -> String) -> String {
        if self.is_empty() {
            f()
        } else {
            self
        }
    }
}
fn required_string(value: &Value, key: &str) -> Result<String, AppError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| AppError::Api(format!("Response omitted {key}")))
}
fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .or_else(|| v.as_i64().map(|n| n.to_string()))
        })
        .unwrap_or_default()
}
fn optional_number(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))
}
fn optional_string(value: &Value, key: &str) -> Option<String> {
    let value = string(value, key);
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}
fn number(value: &Value, key: &str) -> f64 {
    optional_number(value, key).unwrap_or(0.0)
}
fn number_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}
fn display_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| {
        v.as_str()
            .map(str::to_owned)
            .or_else(|| v.as_f64().map(|n| format!("${n:.2}")))
    })
}
fn format_price(value: f64) -> String {
    format!("{value:.10}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}
fn aligned(price: f64, tick: f64) -> bool {
    tick > 0.0 && ((price / tick) - (price / tick).round()).abs() < 1e-8
}
fn mask_account(value: &str) -> String {
    let suffix: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("•••{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_client_has_no_total_request_timeout() {
        assert_eq!(
            REST_CLIENT_POLICY.total_timeout,
            Some(Duration::from_secs(30))
        );
        assert_eq!(STREAM_CLIENT_POLICY.total_timeout, None);
        assert!(build_http_client(REST_CLIENT_POLICY).is_ok());
        assert!(build_http_client(STREAM_CLIENT_POLICY).is_ok());
    }

    #[test]
    fn historical_credit_calculation_matches_tradestation_rules() {
        assert_eq!(
            historical_credits("/marketdata/barcharts/MES?unit=Minute&interval=1&barsback=25000"),
            0.0
        );
        assert_eq!(
            historical_credits("/marketdata/barcharts/MES?unit=Minute&interval=1&barsback=26000"),
            0.26
        );
        assert_eq!(
            historical_credits(
                "/marketdata/stream/barcharts/MES?unit=Minute&interval=60&barsback=2000"
            ),
            1.2
        );
        assert_eq!(
            historical_credits("/marketdata/barcharts/MES?unit=Minute&interval=30&firstdate=2023-01-01&lastdate=2024-06-30"),
            1.49
        );
        assert_eq!(
            historical_credits("/marketdata/barcharts/MES?unit=Daily&interval=1&barsback=5000"),
            0.0
        );
    }

    #[test]
    fn configured_bar_history_respects_per_request_limits() {
        for timeframe in ["1m", "5m", "15m", "30m", "1h", "4h", "D", "W", "M"] {
            let (interval, unit, bars_back) = history_spec(timeframe).unwrap();
            validate_bars_back(interval, unit, bars_back).unwrap();
            assert!(bars_back <= 57_600);
            if unit == "Minute" {
                assert!(bars_back * interval <= 500_000);
            }
        }
    }

    #[test]
    fn quota_bucket_replenishes_continuously_without_exceeding_capacity() {
        let mut bucket = QuotaBucket::new(10, 10);
        bucket.available = 0.0;
        bucket.updated_at = Instant::now() - Duration::from_secs(5);
        bucket.refill(Instant::now());
        assert!((bucket.available - 5.0).abs() < 0.05);
        bucket.updated_at = Instant::now() - Duration::from_secs(20);
        bucket.refill(Instant::now());
        assert_eq!(bucket.available, 10.0);
    }

    #[tokio::test]
    async fn response_headers_reconcile_the_resource_bucket() {
        let coordinator = QuotaCoordinator::default();
        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-resource", "custom-positions".parse().unwrap());
        headers.insert("x-ratelimit-limit", "42".parse().unwrap());
        headers.insert("x-ratelimit-period", "60".parse().unwrap());
        headers.insert("x-ratelimit-remaining", "17".parse().unwrap());
        headers.insert("x-ratelimit-reset", "30".parse().unwrap());
        coordinator.observe("positions", &headers).await;
        let state = coordinator.state.lock().await;
        assert_eq!(state.aliases["positions"], "custom-positions");
        let bucket = &state.buckets["custom-positions"];
        assert_eq!(bucket.capacity, 42.0);
        assert_eq!(bucket.available, 17.0);
    }

    #[test]
    fn rate_limit_errors_distinguish_request_and_concurrency_exhaustion() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-concurrency-resource",
            "streaming-positions".parse().unwrap(),
        );
        headers.insert("x-concurrency-remaining", "5".parse().unwrap());
        headers.insert(
            "x-ratelimit-resource",
            "streaming-positions".parse().unwrap(),
        );
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        assert!(matches!(
            rate_limit_error(&headers, "positions-stream"),
            AppError::RateLimited {
                concurrent: false,
                ..
            }
        ));
        headers.insert("x-concurrency-remaining", "0".parse().unwrap());
        headers.insert("x-ratelimit-remaining", "25".parse().unwrap());
        assert!(matches!(
            rate_limit_error(&headers, "positions-stream"),
            AppError::RateLimited {
                concurrent: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn background_work_cannot_consume_the_trading_reserve() {
        let coordinator = QuotaCoordinator::default();
        {
            let mut state = coordinator.state.lock().await;
            state.buckets.insert(
                "positions".into(),
                QuotaBucket {
                    capacity: 100.0,
                    available: 10.0,
                    refill_per_second: 0.01,
                    updated_at: Instant::now(),
                    reset_at: None,
                },
            );
        }
        assert!(matches!(
            coordinator
                .acquire(
                    "positions",
                    RequestPriority::Background,
                    0.0,
                    Some(Duration::ZERO)
                )
                .await,
            Err(AppError::RateLimited { .. })
        ));
        coordinator
            .acquire(
                "positions",
                RequestPriority::Trading,
                0.0,
                Some(Duration::ZERO),
            )
            .await
            .unwrap();
    }

    fn sample_order(id: &str) -> OrderUpdate {
        OrderUpdate {
            id: id.into(),
            symbol: "MESU26".into(),
            side: "Sell".into(),
            order_type: "Limit".into(),
            quantity: 2,
            price: Some(6260.0),
            stop_price: None,
            status: "Working".into(),
            timestamp: String::new(),
            account_id: Some("account-1".into()),
            filled_quantity: Some(0.0),
            remaining_quantity: Some(2.0),
            average_fill_price: None,
            duration: Some("DAY".into()),
            closed_at: None,
            commission: None,
            stop_loss: None,
            take_profit: None,
            raw_status: Some("ACK".into()),
            status_description: Some("Received".into()),
            open_or_close: Some("Close".into()),
            group_name: Some("OCO bracket".into()),
            related_orders: vec![],
        }
    }

    fn sample_position(side: &str, quantity: f64) -> Position {
        Position {
            id: "position-1".into(),
            symbol: "MESU26".into(),
            side: side.into(),
            quantity,
            average_price: 6250.0,
            last: 6251.0,
            unrealized_pnl: 10.0,
            bid: None,
            ask: None,
            unrealized_pnl_percent: None,
            unrealized_pnl_quantity: None,
            initial_requirement: None,
            maintenance_margin: None,
            market_value: None,
            timestamp: None,
        }
    }

    #[test]
    fn tick_alignment_is_decimal_safe_enough_for_validation() {
        assert!(aligned(6260.25, 0.25));
        assert!(!aligned(6260.10, 0.25));
    }

    #[test]
    fn normalizes_tradestation_order_status_codes() {
        for code in ["OPN", "ACK", "UCN", "FPR", "DON"] {
            assert_eq!(normalize_order_status(code), "Working");
        }
        for code in ["FLL", "FLP"] {
            assert_eq!(normalize_order_status(code), "Filled");
        }
        for code in ["OUT", "CAN", "EXP"] {
            assert_eq!(normalize_order_status(code), "Cancelled");
        }
        assert_eq!(normalize_order_status("REJ"), "Rejected");
        for code in ["TSC", "BRO", "LAT", "future-code"] {
            assert_eq!(normalize_order_status(code), "Indeterminate");
        }
    }

    #[test]
    fn parses_bracket_metadata_and_preserves_raw_status() {
        let order = order_from_value(&json!({
            "OrderID": "123", "AccountID": "account-1", "Status": "ACK",
            "StatusDescription": "Received", "OrderType": "Limit", "LimitPrice": "6260",
            "GroupName": "OCO bracket", "OpenedDateTime": "2026-07-13T20:00:00Z",
            "Legs": [{ "Symbol": "MESU26", "BuyOrSell": "Sell", "OpenOrClose": "Close", "QuantityOrdered": "2", "QuantityRemaining": "2" }],
            "ConditionalOrders": [{ "OrderID": "124", "Relationship": "OCO" }]
        }));
        assert_eq!(order.status, "Working");
        assert_eq!(order.raw_status.as_deref(), Some("ACK"));
        assert_eq!(order.status_description.as_deref(), Some("Received"));
        assert_eq!(order.open_or_close.as_deref(), Some("Close"));
        assert_eq!(order.group_name.as_deref(), Some("OCO bracket"));
        assert!(is_bracket_order(&order));
        assert_eq!(order.related_orders[0].order_id, "124");
    }

    #[test]
    fn recognizes_brk_groups_and_case_insensitive_close_metadata() {
        let mut order = sample_order("1");
        order.group_name = Some("BRK 123".into());
        order.open_or_close = Some("CLOSE".into());
        assert!(is_bracket_order(&order));
        assert!(is_close_order(&order));
    }

    #[test]
    fn replacement_payload_uses_the_protective_order_price_field() {
        let limit = sample_order("1");
        assert_eq!(
            replacement_payload(&limit, 6261.25).unwrap(),
            json!({
                "Quantity": "2", "LimitPrice": "6261.25"
            })
        );
        let mut stop = sample_order("2");
        stop.order_type = "StopMarket".into();
        stop.price = None;
        stop.stop_price = Some(6240.0);
        stop.remaining_quantity = Some(1.0);
        assert_eq!(
            replacement_payload(&stop, 6239.75).unwrap(),
            json!({
                "Quantity": "1", "StopPrice": "6239.75"
            })
        );
        stop.remaining_quantity = Some(0.0);
        assert!(replacement_payload(&stop, 6239.5).is_err());
    }

    #[test]
    fn close_order_selection_is_scoped_to_account_symbol_and_close_side() {
        let position = sample_position("Long", 2.0);
        let included = sample_order("1");
        let mut opening = sample_order("2");
        opening.open_or_close = Some("Open".into());
        opening.side = "Buy".into();
        let mut other_symbol = sample_order("3");
        other_symbol.symbol = "MNQU26".into();
        let mut other_account = sample_order("4");
        other_account.account_id = Some("account-2".into());
        let mut filled = sample_order("5");
        filled.status = "Filled".into();
        let orders = vec![included, opening, other_symbol, other_account, filled];
        assert_eq!(
            closing_orders_for_position(&orders, "account-1", &position)
                .iter()
                .map(|order| order.id.as_str())
                .collect::<Vec<_>>(),
            vec!["1"]
        );
    }

    #[test]
    fn infers_unlabeled_exits_from_the_position_side() {
        let position = sample_position("Short", 1.0);
        let mut take_profit = sample_order("1");
        take_profit.side = "Buy".into();
        take_profit.open_or_close = None;
        take_profit.group_name = None;
        let mut stop_loss = take_profit.clone();
        stop_loss.id = "2".into();
        stop_loss.order_type = "StopMarket".into();
        stop_loss.price = None;
        stop_loss.stop_price = Some(6259.0);
        let orders = vec![take_profit, stop_loss];
        assert!(orders
            .iter()
            .all(|order| is_protective_order(order, Some(&position))));
        assert_eq!(
            closing_orders_for_position(&orders, "account-1", &position)
                .iter()
                .map(|order| order.id.as_str())
                .collect::<Vec<_>>(),
            vec!["1", "2"]
        );
    }

    #[test]
    fn flatten_draft_uses_current_quantity_and_opposite_side() {
        let long = flatten_draft("account-1", &sample_position("Long", 2.0)).unwrap();
        assert_eq!((long.side.as_str(), long.quantity), ("Sell", 2));
        let reduced = flatten_draft("account-1", &sample_position("Short", -1.0)).unwrap();
        assert_eq!((reduced.side.as_str(), reduced.quantity), ("Buy", 1));
        assert!(flatten_draft("account-1", &sample_position("Long", 0.0)).is_err());
    }

    #[test]
    fn market_close_converts_one_complete_oco_leg() {
        let position = sample_position("Long", 2.0);
        let take_profit = sample_order("1");
        let mut stop_loss = sample_order("2");
        stop_loss.order_type = "StopMarket".into();
        stop_loss.price = None;
        stop_loss.stop_price = Some(6240.0);
        let orders = vec![take_profit, stop_loss];
        let relevant = closing_orders_for_position(&orders, "account-1", &position);

        let selected = market_replace_candidate(&relevant, &position).unwrap();
        assert_eq!(selected.id, "1", "the limit leg should be preferred");
        assert_eq!(
            market_replacement_payload(selected, &position).unwrap(),
            json!({ "OrderType": "Market", "Quantity": "2" })
        );

        let update = market_replacement_update(selected, &position);
        assert_eq!(update.id, selected.id);
        assert_eq!(update.order_type, "Market");
        assert_eq!(update.status, "Pending");
        assert_eq!(update.raw_status.as_deref(), Some("ReplacePending"));
        assert_eq!(update.remaining_quantity, Some(2.0));
        assert_eq!(update.price, None);
    }

    #[test]
    fn market_close_allows_one_standalone_protective_exit() {
        let position = sample_position("Long", 2.0);
        let mut exit = sample_order("1");
        exit.group_name = None;
        exit.related_orders.clear();
        let orders = vec![exit];
        let relevant = closing_orders_for_position(&orders, "account-1", &position);
        assert_eq!(
            market_replace_candidate(&relevant, &position).map(|order| order.id.as_str()),
            Some("1")
        );
    }

    #[test]
    fn market_close_rejects_quantity_mismatch_unlinked_exits_and_pending_state() {
        let position = sample_position("Long", 2.0);
        let mut partial = sample_order("1");
        partial.remaining_quantity = Some(1.0);
        let partial_orders = vec![partial];
        let relevant = closing_orders_for_position(&partial_orders, "account-1", &position);
        assert!(market_replace_candidate(&relevant, &position).is_none());

        let first = sample_order("1");
        let mut unrelated = sample_order("2");
        unrelated.group_name = Some("OCO 999".into());
        let unrelated_orders = vec![first, unrelated];
        let relevant = closing_orders_for_position(&unrelated_orders, "account-1", &position);
        assert!(market_replace_candidate(&relevant, &position).is_none());

        let mut pending = sample_order("1");
        pending.status = "Pending".into();
        let pending_orders = vec![pending];
        let relevant = closing_orders_for_position(&pending_orders, "account-1", &position);
        assert!(market_replace_candidate(&relevant, &position).is_none());

        let mut cancel_pending = sample_order("1");
        cancel_pending.raw_status = Some("UCN".into());
        let cancel_pending_orders = vec![cancel_pending];
        let relevant = closing_orders_for_position(&cancel_pending_orders, "account-1", &position);
        assert!(market_replace_candidate(&relevant, &position).is_none());
    }

    #[test]
    fn position_parser_normalizes_signed_futures_quantities() {
        let position = position_from_value(&json!({
            "PositionID": "p1", "Symbol": "MESU26", "LongShort": "Short",
            "Quantity": "-2", "AveragePrice": "6250"
        }));
        assert_eq!(position.side, "Short");
        assert_eq!(position.quantity, 2.0);
    }

    #[test]
    fn balance_parser_reads_todays_profit_loss_numeric_strings() {
        let negative = balance_from_value(&json!({
            "AccountID": "123456781", "AccountType": "Futures",
            "TodaysProfitLoss": "-549.999999",
            "BalanceDetail": {
                "RealizedProfitLoss": "125.25",
                "UnrealizedProfitLoss": "-599.999999"
            }
        }));
        let positive = balance_from_value(&json!({
            "AccountID": "123456782", "AccountType": "Margin",
            "TodaysProfitLoss": "982.8001"
        }));

        assert_eq!(negative.todays_profit_loss, Some(-549.999999));
        assert_eq!(negative.realized_profit_loss, Some(125.25));
        assert_eq!(negative.unrealized_profit_loss, Some(-599.999999));
        assert_eq!(positive.todays_profit_loss, Some(982.8001));
    }

    #[test]
    fn cancellation_poll_blocks_indeterminate_and_timed_out_orders() {
        let ids = vec!["1".into()];
        let working = vec![sample_order("1")];
        assert!(!cancellation_poll_complete(&ids, &working, false).unwrap());
        assert!(cancellation_poll_complete(&ids, &working, true).is_err());
        let mut indeterminate = sample_order("1");
        indeterminate.status = "Indeterminate".into();
        assert!(cancellation_poll_complete(&ids, &[indeterminate], false).is_err());
        let mut cancelled = sample_order("1");
        cancelled.status = "Cancelled".into();
        assert!(cancellation_poll_complete(&ids, &[cancelled], false).unwrap());
    }

    #[test]
    fn cancellation_resolution_detects_fills_and_ambiguous_missing_orders() {
        let ids = vec!["1".into(), "2".into()];
        let mut cancelled = sample_order("1");
        cancelled.status = "Cancelled".into();
        let mut filled = sample_order("2");
        filled.status = "Filled".into();
        let resolution =
            cancellation_resolution(&ids, &[cancelled.clone(), filled], false).unwrap();
        assert!(resolution.complete);
        assert!(resolution.exit_filled);
        assert!(resolution.position_refresh_required);

        let missing = cancellation_resolution(&ids, &[cancelled], false).unwrap();
        assert!(missing.complete);
        assert!(!missing.exit_filled);
        assert!(missing.position_refresh_required);
    }

    #[tokio::test]
    async fn brokerage_cache_wakes_waiters_immediately_and_tracks_complete_snapshots() {
        let api = TradeStation::new().unwrap();
        let environment = TradingEnvironment::Sim;
        api.reset_brokerage_cache(&environment, "account-1").await;
        api.set_brokerage_stream_state(&environment, "account-1", "positions", "streaming")
            .await;
        api.set_brokerage_stream_state(&environment, "account-1", "orders", "streaming")
            .await;
        api.apply_positions_snapshot(&environment, "account-1", &[sample_position("Long", 1.0)])
            .await;
        api.apply_orders_snapshot(&environment, "account-1", &[sample_order("1")])
            .await;
        let snapshot = api
            .brokerage_snapshot(&environment, "account-1")
            .await
            .unwrap();
        assert!(snapshot.positions_ready && snapshot.orders_ready);
        assert_eq!(snapshot.positions.len(), 1);
        assert_eq!(snapshot.orders.len(), 1);

        let mut revision = api.brokerage_revision.subscribe();
        let mut cancelled = sample_order("1");
        cancelled.status = "Cancelled".into();
        let started = Instant::now();
        api.apply_order_update(&environment, "account-1", &cancelled)
            .await;
        tokio::time::timeout(Duration::from_millis(100), revision.changed())
            .await
            .expect("stream cache revision should wake without a polling interval")
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(100));
        let snapshot = api
            .brokerage_snapshot(&environment, "account-1")
            .await
            .unwrap();
        assert_eq!(snapshot.orders[0].status, "Cancelled");
    }

    #[test]
    fn mes_uses_v3_price_format_for_tick_value() {
        let value = json!({
            "AssetType": "FUTURE",
            "Symbol": "MESU26",
            "PriceFormat": {
                "Increment": "0.25",
                "PointValue": "5"
            },
            "MinMove": 25,
            "PointValue": 500
        });
        let symbol = symbol_from_value(&value);
        assert_eq!(symbol.min_move, 0.25);
        assert_eq!(symbol.point_value, 5.0);
        assert_eq!(symbol.min_move * symbol.point_value, 1.25);
    }

    #[test]
    fn parses_continuous_root_and_underlying() {
        let symbol = symbol_from_value(&json!({
            "AssetType": "FUTURE", "Symbol": "@MES", "Root": "MES", "Underlying": "MESU26",
            "PriceFormat": { "Increment": "0.25", "PointValue": "5" }
        }));
        assert_eq!(symbol.root.as_deref(), Some("MES"));
        assert_eq!(symbol.underlying.as_deref(), Some("MESU26"));
    }

    #[test]
    fn future_contract_search_filters_and_sorts_concrete_expirations() {
        let values = json!([
            { "Name": "MESZ26", "Root": "MES", "Category": "Future", "ExpirationDate": "2026-12-18" },
            { "Name": "@MES", "Root": "MES", "Category": "Future", "ExpirationDate": "2026-09-18" },
            { "Name": "MNQU26", "Root": "MNQ", "Category": "Future", "ExpirationDate": "2026-09-18" },
            { "Name": "MESH27", "Root": "MES", "Category": "Future", "ExpirationDate": "2027-03-19" },
            { "Name": "MESU26", "Root": "MES", "Category": "Future", "ExpirationDate": "2026-09-18" },
            { "Name": "MESOLD", "Root": "MES", "Category": "Future" }
        ]);
        let contracts = filter_future_contracts("MES", values.as_array().unwrap().iter());
        assert_eq!(
            contracts
                .iter()
                .map(|symbol| symbol.symbol.as_str())
                .collect::<Vec<_>>(),
            vec!["MESU26", "MESZ26", "MESH27"]
        );
    }

    #[test]
    fn continuous_symbols_are_rejected_for_orders() {
        assert!(validate_tradable_symbol("MESU26").is_ok());
        assert!(validate_tradable_symbol("@MES").is_err());
        assert!(validate_tradable_symbol("").is_err());
    }

    #[test]
    fn intraday_bars_use_the_candle_open_time() {
        let value = json!({
            "Epoch": 61_200_000,
            "Open": "1", "High": "2", "Low": "0.5", "Close": "1.5",
            "TotalVolume": "10"
        });
        assert_eq!(
            bar_from_value(&value, "1m").unwrap().time,
            (16 * 60 + 59) * 60
        );
        assert_eq!(
            bar_from_value(&value, "5m").unwrap().time,
            (16 * 60 + 55) * 60
        );
        assert_eq!(bar_from_value(&value, "1h").unwrap().time, 16 * 60 * 60);
    }

    #[test]
    fn calendar_bars_keep_their_trading_date_timestamp() {
        let value = json!({
            "Epoch": 86_400_000,
            "Open": "1", "High": "2", "Low": "0.5", "Close": "1.5",
            "TotalVolume": "10"
        });
        assert_eq!(bar_from_value(&value, "D").unwrap().time, 86_400);
    }

    #[test]
    fn minute_bar_range_path_uses_dates_and_enforces_safe_chunks() {
        let path = bar_range_path("@MES", "1m", 0, 30 * 86_400).unwrap();
        assert!(path.contains("interval=1&unit=Minute"));
        assert!(path.contains("firstdate=1970-01-01T00%3A00%3A00%2B00%3A00"));
        assert!(path.contains("lastdate=1970-01-31T00%3A00%3A00%2B00%3A00"));
        assert!(bar_range_path("@MES", "1m", 20, 10).is_err());
        assert!(bar_range_path("@MES", "1m", 0, 32 * 86_400).is_err());
    }

    fn full_quote(symbol: &str, bid: f64, ask: f64) -> Value {
        json!({
            "Symbol": symbol,
            "Last": (bid + ask) / 2.0,
            "Bid": bid,
            "Ask": ask,
            "NetChange": 12.5,
            "NetChangePct": 0.2,
            "MarketFlags": { "IsDelayed": false, "IsHalted": false },
            "TradeTime": "2026-07-13T20:00:00Z"
        })
    }

    #[test]
    fn full_quote_snapshot_initializes_every_supported_field() {
        let quote = quote_from_value(&full_quote("MESU26", 6250.0, 6250.25)).unwrap();
        assert_eq!(quote.symbol, "MESU26");
        assert_eq!(quote.last, 6250.125);
        assert_eq!(quote.bid, 6250.0);
        assert_eq!(quote.ask, 6250.25);
        assert_eq!(quote.change, 12.5);
        assert_eq!(quote.change_pct, 0.2);
        assert!(!quote.delayed);
        assert!(!quote.halted);
        assert_eq!(quote.timestamp, "2026-07-13T20:00:00Z");
    }

    #[test]
    fn sparse_price_updates_preserve_the_opposite_side_and_unrelated_fields() {
        let mut quotes = HashMap::new();
        merge_quote_update(&mut quotes, &full_quote("MESU26", 6250.0, 6250.25)).unwrap();

        let bid_update = merge_quote_update(
            &mut quotes,
            &json!({ "Symbol": "MESU26", "Bid": "6250.25" }),
        )
        .unwrap();
        assert_eq!(bid_update.bid, 6250.25);
        assert_eq!(bid_update.ask, 6250.25);
        assert_eq!(bid_update.last, 6250.125);
        assert_eq!(bid_update.change, 12.5);
        assert!(!bid_update.delayed);
        assert_eq!(bid_update.timestamp, "2026-07-13T20:00:00Z");

        let ask_update = merge_quote_update(
            &mut quotes,
            &json!({ "Symbol": "MESU26", "Ask": "6250.50" }),
        )
        .unwrap();
        assert_eq!(ask_update.bid, 6250.25);
        assert_eq!(ask_update.ask, 6250.5);
    }

    #[test]
    fn sparse_market_flags_preserve_missing_flags_and_honor_explicit_values() {
        let mut quotes = HashMap::new();
        merge_quote_update(&mut quotes, &full_quote("MESU26", 6250.0, 6250.25)).unwrap();

        let halted = merge_quote_update(
            &mut quotes,
            &json!({ "Symbol": "MESU26", "MarketFlags": { "IsHalted": true } }),
        )
        .unwrap();
        assert!(!halted.delayed);
        assert!(halted.halted);

        let delayed = merge_quote_update(
            &mut quotes,
            &json!({ "Symbol": "MESU26", "MarketFlags": { "IsDelayed": true } }),
        )
        .unwrap();
        assert!(delayed.delayed);
        assert!(delayed.halted);

        let cleared = merge_quote_update(
            &mut quotes,
            &json!({
                "Symbol": "MESU26",
                "Bid": 0,
                "Ask": 0,
                "MarketFlags": { "IsDelayed": false, "IsHalted": false }
            }),
        )
        .unwrap();
        assert_eq!(cleared.bid, 0.0);
        assert_eq!(cleared.ask, 0.0);
        assert!(!cleared.delayed);
        assert!(!cleared.halted);
    }

    #[test]
    fn quote_accumulator_keeps_symbols_independent() {
        let mut quotes = HashMap::new();
        merge_quote_update(&mut quotes, &full_quote("MESU26", 6250.0, 6250.25)).unwrap();
        merge_quote_update(&mut quotes, &full_quote("MNQU26", 23000.0, 23000.5)).unwrap();
        merge_quote_update(&mut quotes, &json!({ "Symbol": "MESU26", "Bid": 6251.0 })).unwrap();

        assert_eq!(quotes["MESU26"].bid, 6251.0);
        assert_eq!(quotes["MESU26"].ask, 6250.25);
        assert_eq!(quotes["MNQU26"].bid, 23000.0);
        assert_eq!(quotes["MNQU26"].ask, 23000.5);
    }

    #[test]
    fn masks_account_numbers() {
        assert_eq!(mask_account("123456789"), "•••6789");
    }
}
