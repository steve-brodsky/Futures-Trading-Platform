use std::{collections::BTreeMap, sync::Arc, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc, Weekday};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use crate::{
    audit::AuditService,
    models::{
        Bar, MarketDataProvider, OptionChainSnapshot, OptionContract, OptionExpiration, Quote,
        SymbolMeta,
    },
    storage, AppError,
};

const TOKEN_URL: &str = "https://api.schwabapi.com/v1/oauth/token";
const MARKET_URL: &str = "https://api.schwabapi.com/marketdata/v1";
const TRADER_URL: &str = "https://api.schwabapi.com/trader/v1";
pub const AUTHORIZE_URL: &str = "https://api.schwabapi.com/v1/oauth/authorize";
pub const REDIRECT_URI: &str = "https://127.0.0.1:8182/callback";

#[derive(Clone, Debug)]
struct AccessToken {
    value: String,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct TokenPayload {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamerInfo {
    pub streamer_socket_url: String,
    pub schwab_client_customer_id: String,
    pub schwab_client_correl_id: String,
    pub schwab_client_channel: String,
    pub schwab_client_function_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserPreference {
    streamer_info: Vec<StreamerInfo>,
}

#[derive(Clone)]
pub struct Schwab {
    http: reqwest::Client,
    access_token: Arc<RwLock<Option<AccessToken>>>,
    refresh_lock: Arc<Mutex<()>>,
    audit: Option<AuditService>,
}

impl Schwab {
    pub fn new() -> Result<Self, AppError> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .user_agent("Northstar-Trader/0.1")
                .build()?,
            access_token: Arc::new(RwLock::new(None)),
            refresh_lock: Arc::new(Mutex::new(())),
            audit: None,
        })
    }

    pub fn with_audit(mut self, audit: AuditService) -> Self {
        self.audit = Some(audit);
        self
    }

    pub fn audit(&self) -> Option<&AuditService> {
        self.audit.as_ref()
    }

    pub async fn clear_access_token(&self) {
        *self.access_token.write().await = None;
    }

    pub async fn authenticated(&self) -> bool {
        if storage::schwab_refresh_token().ok().flatten().is_none() {
            return false;
        }
        self.access_token(false).await.is_ok()
    }

    async fn token_request(&self, fields: &[(&str, &str)]) -> Result<TokenPayload, AppError> {
        let (client_id, client_secret) =
            storage::schwab_client()?.ok_or(AppError::AuthenticationRequired)?;
        let span = self.audit.as_ref().map(|audit| {
            audit.begin_api(
                "schwab",
                "oauth-token",
                "POST",
                TOKEN_URL,
                Some(serde_json::json!({"grantType": fields.iter().find(|(key, _)| *key == "grant_type").map(|(_, value)| *value)})),
                Some(uuid::Uuid::new_v4().to_string()),
            )
        });
        let response = match self
            .http
            .post(TOKEN_URL)
            .header(
                "Authorization",
                format!(
                    "Basic {}",
                    STANDARD.encode(format!("{client_id}:{client_secret}"))
                ),
            )
            .header("Accept", "application/json")
            .form(fields)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                if let Some(span) = span {
                    span.error(None, error.to_string());
                }
                return Err(error.into());
            }
        };
        let status = response.status();
        if !status.is_success() {
            let detail = response.text().await.unwrap_or_default();
            if let Some(span) = span {
                span.error(Some(status.as_u16()), truncate(&detail));
            }
            return Err(AppError::Api(format!(
                "Schwab token request failed ({status}): {}",
                truncate(&detail)
            )));
        }
        let payload = response.json().await?;
        if let Some(span) = span {
            span.success(
                Some(status.as_u16()),
                Some(serde_json::json!({"tokenIssued": true})),
            );
        }
        Ok(payload)
    }

    pub async fn exchange_code(&self, code: &str) -> Result<(), AppError> {
        let payload = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", REDIRECT_URI),
            ])
            .await?;
        let refresh = payload
            .refresh_token
            .ok_or_else(|| AppError::Api("Schwab did not return a refresh token".into()))?;
        storage::save_schwab_refresh_token(&refresh)?;
        *self.access_token.write().await = Some(AccessToken {
            value: payload.access_token,
            expires_at: Utc::now().timestamp_millis() + payload.expires_in * 1_000,
        });
        Ok(())
    }

    pub async fn access_token(&self, force: bool) -> Result<String, AppError> {
        if !force {
            if let Some(token) = self.access_token.read().await.as_ref() {
                if token.expires_at > Utc::now().timestamp_millis() + 60_000 {
                    return Ok(token.value.clone());
                }
            }
        }
        let _guard = self.refresh_lock.lock().await;
        if !force {
            if let Some(token) = self.access_token.read().await.as_ref() {
                if token.expires_at > Utc::now().timestamp_millis() + 60_000 {
                    return Ok(token.value.clone());
                }
            }
        }
        let refresh = storage::schwab_refresh_token()?.ok_or(AppError::AuthenticationRequired)?;
        match self
            .token_request(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)])
            .await
        {
            Ok(payload) => {
                if let Some(rotated) = payload.refresh_token.as_deref() {
                    storage::save_schwab_refresh_token(rotated)?;
                }
                let value = payload.access_token.clone();
                *self.access_token.write().await = Some(AccessToken {
                    value: payload.access_token,
                    expires_at: Utc::now().timestamp_millis() + payload.expires_in * 1_000,
                });
                Ok(value)
            }
            Err(_error) => {
                storage::clear_schwab_refresh_token()?;
                *self.access_token.write().await = None;
                Err(AppError::AuthenticationRequired)
            }
        }
    }

    async fn get_json(&self, url: &str) -> Result<Value, AppError> {
        let mut token = self.access_token(false).await?;
        let correlation_id = uuid::Uuid::new_v4().to_string();
        for retry in 0..=1 {
            let span = self.audit.as_ref().map(|audit| {
                audit.begin_api(
                    "schwab",
                    "market-data",
                    "GET",
                    url,
                    None,
                    Some(correlation_id.clone()),
                )
            });
            let response = match self
                .http
                .get(url)
                .bearer_auth(&token)
                .header("Accept", "application/json")
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    if let Some(span) = span {
                        span.error(None, error.to_string());
                    }
                    return Err(error.into());
                }
            };
            if response.status() == StatusCode::UNAUTHORIZED && retry == 0 {
                if let Some(span) = span {
                    span.warning(
                        Some(response.status().as_u16()),
                        None,
                        "Access token expired; refreshing",
                    );
                }
                token = self.access_token(true).await?;
                continue;
            }
            let status = response.status();
            if !status.is_success() {
                let detail = response.text().await.unwrap_or_default();
                if let Some(span) = span {
                    span.error(Some(status.as_u16()), truncate(&detail));
                }
                return Err(AppError::Api(format!(
                    "Schwab request failed ({status}): {}",
                    truncate(&detail)
                )));
            }
            let value: Value = response.json().await?;
            if let Some(span) = span {
                span.success(Some(status.as_u16()), Some(value.clone()));
            }
            return Ok(value);
        }
        Err(AppError::AuthenticationRequired)
    }

    pub async fn search_symbols(&self, query: &str) -> Result<Vec<SymbolMeta>, AppError> {
        let url = instrument_search_url(query)?;
        let body = self.get_json(url.as_str()).await?;
        let mut result: Vec<_> = body
            .get("instruments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(instrument_from_value)
            .collect();
        result.sort_by(|left, right| {
            let left_exact = !left.symbol.eq_ignore_ascii_case(query);
            let right_exact = !right.symbol.eq_ignore_ascii_case(query);
            left_exact
                .cmp(&right_exact)
                .then_with(|| left.symbol.cmp(&right.symbol))
        });
        result.dedup_by(|left, right| left.symbol == right.symbol);
        Ok(result)
    }

    pub async fn symbol_details(&self, symbol: &str) -> Result<SymbolMeta, AppError> {
        self.search_symbols(symbol)
            .await?
            .into_iter()
            .find(|item| item.symbol.eq_ignore_ascii_case(symbol))
            .ok_or_else(|| AppError::Api(format!("Schwab market-data symbol not found: {symbol}")))
    }

    pub async fn quotes(&self, symbols: &[String]) -> Result<Vec<Quote>, AppError> {
        if symbols.is_empty() {
            return Ok(vec![]);
        }
        let mut url = url::Url::parse(&format!("{MARKET_URL}/quotes"))?;
        url.query_pairs_mut()
            .append_pair("symbols", &symbols.join(","))
            .append_pair("fields", "quote,reference,regular");
        let body = self.get_json(url.as_str()).await?;
        Ok(body
            .as_object()
            .into_iter()
            .flat_map(|items| items.iter())
            .filter_map(|(symbol, value)| quote_from_value(symbol, value))
            .collect())
    }

    pub async fn option_expirations(
        &self,
        symbol: &str,
    ) -> Result<Vec<OptionExpiration>, AppError> {
        let mut url = url::Url::parse(&format!("{MARKET_URL}/expirationchain"))?;
        url.query_pairs_mut().append_pair("symbol", symbol.trim());
        let body = self.get_json(url.as_str()).await?;
        Ok(option_expirations_from_value(&body))
    }

    pub async fn option_chain(
        &self,
        symbol: &str,
        expiration_dates: &[String],
        strike_count: Option<u32>,
    ) -> Result<OptionChainSnapshot, AppError> {
        if expiration_dates.is_empty() {
            return Err(AppError::Validation(
                "At least one option expiration is required".into(),
            ));
        }
        let mut dates = expiration_dates
            .iter()
            .map(|date| date.trim().to_string())
            .filter(|date| !date.is_empty())
            .collect::<Vec<_>>();
        dates.sort();
        dates.dedup();
        let mut url = url::Url::parse(&format!("{MARKET_URL}/chains"))?;
        url.query_pairs_mut()
            .append_pair("symbol", symbol.trim())
            .append_pair("contractType", "ALL")
            .append_pair("includeUnderlyingQuote", "true")
            .append_pair("strategy", "SINGLE")
            .append_pair("fromDate", &dates[0])
            .append_pair("toDate", dates.last().unwrap_or(&dates[0]));
        if let Some(strike_count) = strike_count.filter(|count| *count > 0) {
            url.query_pairs_mut().append_pair("strikeCount", &strike_count.min(100).to_string());
        }
        let body = self.get_json(url.as_str()).await?;
        Ok(option_chain_from_value(&body, symbol, &dates))
    }

    pub async fn streamer_info(&self) -> Result<StreamerInfo, AppError> {
        let value = self
            .get_json(&format!("{TRADER_URL}/userPreference"))
            .await?;
        let preference: UserPreference = serde_json::from_value(value)?;
        preference.streamer_info.into_iter().next().ok_or_else(|| {
            AppError::Api("Schwab User Preference returned no Streamer information".into())
        })
    }

    pub async fn bars(&self, symbol: &str, timeframe: &str) -> Result<Vec<Bar>, AppError> {
        self.bars_before(symbol, timeframe, None).await
    }

    pub async fn older_bars(
        &self,
        symbol: &str,
        timeframe: &str,
        before: i64,
    ) -> Result<Vec<Bar>, AppError> {
        let mut bars = self.bars_before(symbol, timeframe, Some(before)).await?;
        bars.retain(|bar| bar.time < before);
        Ok(bars)
    }

    async fn bars_before(
        &self,
        symbol: &str,
        timeframe: &str,
        before: Option<i64>,
    ) -> Result<Vec<Bar>, AppError> {
        if minute_interval(timeframe).is_some() {
            let source = self
                .price_history(symbol, "day", 10, "minute", 1, before, None)
                .await?;
            return Ok(aggregate_bars(&source, timeframe));
        }
        match timeframe {
            "D" | "W" | "M" => {
                let mut daily = self
                    .price_history(symbol, "year", 20, "daily", 1, before, None)
                    .await?;
                if before.is_none() {
                    let minutes = self
                        .price_history(symbol, "day", 10, "minute", 1, None, None)
                        .await?;
                    let recent_daily = aggregate_bars(&minutes, "D");
                    let mut by_time: BTreeMap<_, _> =
                        daily.into_iter().map(|bar| (bar.time, bar)).collect();
                    by_time.extend(recent_daily.into_iter().map(|bar| (bar.time, bar)));
                    daily = by_time.into_values().collect();
                }
                Ok(aggregate_bars(&daily, timeframe))
            }
            _ => Err(AppError::Validation("Unsupported Schwab timeframe".into())),
        }
    }

    pub async fn bars_range(
        &self,
        symbol: &str,
        first: i64,
        last: i64,
    ) -> Result<Vec<Bar>, AppError> {
        if first >= last {
            return Err(AppError::Validation("Invalid Schwab bar range".into()));
        }
        let mut bars = self
            .price_history(symbol, "day", 10, "minute", 1, None, Some((first, last)))
            .await?;
        bars.retain(|bar| bar.time >= first && bar.time < last);
        Ok(bars)
    }

    async fn price_history(
        &self,
        symbol: &str,
        period_type: &str,
        period: u32,
        frequency_type: &str,
        frequency: u32,
        before: Option<i64>,
        range: Option<(i64, i64)>,
    ) -> Result<Vec<Bar>, AppError> {
        let mut url = url::Url::parse(&format!("{MARKET_URL}/pricehistory"))?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("symbol", symbol)
                .append_pair("periodType", period_type)
                .append_pair("period", &period.to_string())
                .append_pair("frequencyType", frequency_type)
                .append_pair("frequency", &frequency.to_string())
                .append_pair("needExtendedHoursData", "true")
                .append_pair("needPreviousClose", "true");
            if let Some(before) = before {
                query.append_pair("endDate", &(before.saturating_mul(1_000) - 1).to_string());
            }
            if let Some((first, last)) = range {
                query
                    .append_pair("startDate", &first.saturating_mul(1_000).to_string())
                    .append_pair("endDate", &(last.saturating_mul(1_000) - 1).to_string());
            }
        }
        let body = self.get_json(url.as_str()).await?;
        let mut bars: Vec<_> = body
            .get("candles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(history_bar_from_value)
            .collect();
        bars.sort_by_key(|bar| bar.time);
        bars.dedup_by_key(|bar| bar.time);
        Ok(bars)
    }
}

fn instrument_search_url(query: &str) -> Result<url::Url, AppError> {
    let mut url = url::Url::parse(&format!("{MARKET_URL}/instruments"))?;
    url.query_pairs_mut()
        .append_pair("symbol", query.trim())
        .append_pair("projection", "search");
    Ok(url)
}

pub fn aggregate_bars(source: &[Bar], timeframe: &str) -> Vec<Bar> {
    let mut buckets: BTreeMap<i64, Bar> = BTreeMap::new();
    let source_by_minute: BTreeMap<i64, &Bar> = source.iter().map(|bar| (bar.time, bar)).collect();
    for bar in source_by_minute.into_values() {
        let Some(time) = bucket_start(bar.time, timeframe) else {
            continue;
        };
        buckets
            .entry(time)
            .and_modify(|bucket| {
                bucket.high = bucket.high.max(bar.high);
                bucket.low = bucket.low.min(bar.low);
                bucket.close = bar.close;
                bucket.volume += bar.volume;
                bucket.realtime |= bar.realtime;
            })
            .or_insert_with(|| Bar {
                time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
                realtime: bar.realtime,
            });
    }
    buckets.into_values().collect()
}

pub fn bucket_start(epoch: i64, timeframe: &str) -> Option<i64> {
    let interval = minute_interval(timeframe);
    if interval == Some(1) {
        return Some(epoch.div_euclid(60) * 60);
    }
    let local = new_york_local(epoch)?;
    let date = local.date();
    let naive = if let Some(minutes) = interval {
        let minute_of_day = local.hour() * 60 + local.minute();
        let minutes = u32::try_from(minutes).ok()?;
        let bucket = minute_of_day / minutes * minutes;
        date.and_hms_opt(bucket / 60, bucket % 60, 0)?
    } else {
        match timeframe {
            "D" => date.and_hms_opt(0, 0, 0)?,
            "W" => {
                let monday =
                    date - chrono::Duration::days(local.weekday().num_days_from_monday() as i64);
                monday.and_hms_opt(0, 0, 0)?
            }
            "M" => date.with_day(1)?.and_hms_opt(0, 0, 0)?,
            _ => return None,
        }
    };
    Some(new_york_epoch(naive))
}

fn minute_interval(timeframe: &str) -> Option<usize> {
    match timeframe {
        "1h" => return Some(60),
        "4h" => return Some(240),
        _ => {}
    }
    let value = timeframe.strip_suffix('m')?;
    if value.is_empty() || value.starts_with('0') {
        return None;
    }
    let minutes = value.parse::<usize>().ok()?;
    (1..=1_440).contains(&minutes).then_some(minutes)
}

pub fn current_new_york_day_range(now: i64) -> Option<(i64, i64)> {
    let date = new_york_local(now)?.date();
    let start = new_york_epoch(date.and_hms_opt(0, 0, 0)?);
    Some((start, now.saturating_add(1).max(start.saturating_add(1))))
}

fn new_york_local(epoch: i64) -> Option<NaiveDateTime> {
    let utc = Utc.timestamp_opt(epoch, 0).single()?.naive_utc();
    Some(utc + chrono::Duration::seconds(new_york_offset_at(epoch)))
}

fn new_york_epoch(local: NaiveDateTime) -> i64 {
    local.and_utc().timestamp() - i64::from(new_york_offset_for_date(local.date()))
}

fn new_york_offset_at(epoch: i64) -> i64 {
    let Some(utc) = Utc.timestamp_opt(epoch, 0).single() else {
        return -5 * 3_600;
    };
    let year = utc.year();
    let march = nth_weekday(year, 3, Weekday::Sun, 2)
        .and_hms_opt(7, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp();
    let november = nth_weekday(year, 11, Weekday::Sun, 1)
        .and_hms_opt(6, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp();
    if epoch >= march && epoch < november {
        -4 * 3_600
    } else {
        -5 * 3_600
    }
}

fn new_york_offset_for_date(date: NaiveDate) -> i32 {
    let start = nth_weekday(date.year(), 3, Weekday::Sun, 2);
    let end = nth_weekday(date.year(), 11, Weekday::Sun, 1);
    if date >= start && date < end {
        -4 * 3_600
    } else {
        -5 * 3_600
    }
}

fn nth_weekday(year: i32, month: u32, weekday: Weekday, nth: u32) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
    let offset = (7 + weekday.num_days_from_monday() as i64
        - first.weekday().num_days_from_monday() as i64)
        % 7;
    first + chrono::Duration::days(offset + i64::from((nth - 1) * 7))
}

pub fn chart_bar_from_value(value: &Value) -> Option<Bar> {
    let time = integer_field(value, 7)?.div_euclid(1_000);

    // Schwab production currently prefixes CHART_EQUITY OHLCV with the
    // sequence number (1=sequence, 2..6=OHLCV). Older contract copies list
    // OHLCV at 1..5. Accept both shapes, but only when the resulting candle
    // satisfies the basic OHLC invariants so a sequence can never become a
    // giant price wick.
    let current = stream_bar_candidate(value, time, 2, 3, 4, 5, 6);
    current.or_else(|| stream_bar_candidate(value, time, 1, 2, 3, 4, 5))
}

fn stream_bar_candidate(
    value: &Value,
    time: i64,
    open_field: u8,
    high_field: u8,
    low_field: u8,
    close_field: u8,
    volume_field: u8,
) -> Option<Bar> {
    let bar = Bar {
        time,
        open: numeric_field(value, open_field)?,
        high: numeric_field(value, high_field)?,
        low: numeric_field(value, low_field)?,
        close: numeric_field(value, close_field)?,
        volume: numeric_field(value, volume_field).unwrap_or(0.0),
        realtime: true,
    };
    valid_equity_bar(&bar).then_some(bar)
}

pub fn valid_equity_bar(bar: &Bar) -> bool {
    bar.time > 0
        && [bar.open, bar.high, bar.low, bar.close, bar.volume]
            .into_iter()
            .all(f64::is_finite)
        && bar.open > 0.0
        && bar.high > 0.0
        && bar.low > 0.0
        && bar.close > 0.0
        && bar.volume >= 0.0
        && bar.high >= bar.low
        && bar.high >= bar.open
        && bar.high >= bar.close
        && bar.low <= bar.open
        && bar.low <= bar.close
}

pub fn streamed_quote_from_value(value: &Value) -> Option<Quote> {
    let symbol = value
        .get("key")
        .or_else(|| value.get("0"))?
        .as_str()?
        .to_owned();
    let close = numeric_field(value, 12).unwrap_or(0.0);
    let last = numeric_field(value, 3).or_else(|| numeric_field(value, 33))?;
    let change = numeric_field(value, 18).unwrap_or(last - close);
    let change_pct = numeric_field(value, 42).unwrap_or_else(|| {
        if close == 0.0 {
            0.0
        } else {
            change / close * 100.0
        }
    });
    let timestamp_ms = integer_field(value, 34).unwrap_or_else(|| Utc::now().timestamp_millis());
    Some(Quote {
        provider: MarketDataProvider::Schwab,
        symbol,
        last,
        bid: numeric_field(value, 1).unwrap_or(last),
        ask: numeric_field(value, 2).unwrap_or(last),
        change,
        change_pct,
        delayed: value
            .get("delayed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        halted: value
            .get("32")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("Halted")),
        timestamp: chrono::DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
            .unwrap_or_else(Utc::now)
            .to_rfc3339(),
    })
}

fn instrument_from_value(value: &Value) -> Option<SymbolMeta> {
    let mut asset_type = text(value, "assetType");
    if asset_type.is_empty() {
        asset_type = text(value, "assetMainType");
    }
    if !["EQUITY", "ETF", "INDEX"]
        .iter()
        .any(|supported| asset_type.eq_ignore_ascii_case(supported))
    {
        return None;
    }
    let symbol = text(value, "symbol").trim().to_uppercase();
    if symbol.is_empty() {
        return None;
    }
    Some(SymbolMeta {
        provider: MarketDataProvider::Schwab,
        symbol,
        description: text(value, "description"),
        exchange: normalize_equity_exchange(&text(value, "exchange")),
        asset_type,
        min_move: 0.01,
        point_value: 1.0,
        expiration: None,
        root: None,
        underlying: None,
    })
}

fn normalize_equity_exchange(value: &str) -> String {
    match value.trim().to_uppercase().as_str() {
        "Q" => "NASDAQ".into(),
        "N" => "NYSE".into(),
        "A" => "AMEX".into(),
        "P" => "ARCA".into(),
        other => other.to_owned(),
    }
}

fn history_bar_from_value(value: &Value) -> Option<Bar> {
    Some(Bar {
        time: integer_named(value, "datetime")?.div_euclid(1_000),
        open: number_named(value, "open")?,
        high: number_named(value, "high")?,
        low: number_named(value, "low")?,
        close: number_named(value, "close")?,
        volume: number_named(value, "volume").unwrap_or(0.0),
        realtime: false,
    })
}

fn quote_from_value(symbol: &str, value: &Value) -> Option<Quote> {
    let quote = value.get("quote")?;
    let regular = value.get("regular").unwrap_or(&Value::Null);
    let last = number_named(quote, "lastPrice")
        .or_else(|| number_named(quote, "mark"))
        .or_else(|| number_named(regular, "regularMarketLastPrice"))?;
    let close = number_named(quote, "closePrice").unwrap_or(last);
    let change = number_named(quote, "netChange").unwrap_or(last - close);
    let timestamp_ms = integer_named(quote, "quoteTime")
        .or_else(|| integer_named(quote, "tradeTime"))
        .unwrap_or_else(|| Utc::now().timestamp_millis());
    Some(Quote {
        provider: MarketDataProvider::Schwab,
        symbol: symbol.to_uppercase(),
        last,
        bid: number_named(quote, "bidPrice").unwrap_or(last),
        ask: number_named(quote, "askPrice").unwrap_or(last),
        change,
        change_pct: number_named(quote, "netPercentChange").unwrap_or_else(|| {
            if close == 0.0 {
                0.0
            } else {
                change / close * 100.0
            }
        }),
        delayed: value.get("realtime").and_then(Value::as_bool) == Some(false),
        halted: quote
            .get("securityStatus")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("Halted")),
        timestamp: chrono::DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
            .unwrap_or_else(Utc::now)
            .to_rfc3339(),
    })
}

pub fn option_expirations_from_value(value: &Value) -> Vec<OptionExpiration> {
    let mut expirations = value
        .get("expirationList")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let expiration_date = item.get("expirationDate")?.as_str()?.to_string();
            Some(OptionExpiration {
                expiration_date,
                days_to_expiration: item
                    .get("daysToExpiration")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
                expiration_type: item
                    .get("expirationType")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                standard: item
                    .get("standard")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            })
        })
        .collect::<Vec<_>>();
    expirations.sort_by(|left, right| left.expiration_date.cmp(&right.expiration_date));
    expirations.dedup_by(|left, right| left.expiration_date == right.expiration_date);
    expirations
}

pub fn option_chain_from_value(
    value: &Value,
    requested_symbol: &str,
    expiration_dates: &[String],
) -> OptionChainSnapshot {
    let requested = expiration_dates
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let symbol = value
        .get("symbol")
        .and_then(Value::as_str)
        .unwrap_or(requested_symbol)
        .to_uppercase();
    let underlying_price = number_named(value, "underlyingPrice")
        .or_else(|| value.pointer("/underlying/mark").and_then(Value::as_f64))
        .or_else(|| value.pointer("/underlying/last").and_then(Value::as_f64))
        .unwrap_or_default();
    let delayed = value
        .get("isDelayed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut contracts = Vec::new();
    for (map_name, fallback_side) in [("callExpDateMap", "CALL"), ("putExpDateMap", "PUT")] {
        let Some(expirations) = value.get(map_name).and_then(Value::as_object) else {
            continue;
        };
        for (expiration_key, strikes) in expirations {
            let expiration_date = expiration_key.split(':').next().unwrap_or_default();
            if !requested.is_empty() && !requested.contains(expiration_date) {
                continue;
            }
            let Some(strikes) = strikes.as_object() else {
                continue;
            };
            for contract_value in strikes.values() {
                let values: Vec<&Value> = contract_value
                    .as_array()
                    .map(|items| items.iter().collect())
                    .unwrap_or_else(|| vec![contract_value]);
                for contract in values {
                    if let Some(contract) = option_contract_from_chain(
                        contract,
                        &symbol,
                        expiration_date,
                        fallback_side,
                        underlying_price,
                        delayed,
                    ) {
                        contracts.push(contract);
                    }
                }
            }
        }
    }
    contracts.sort_by(|left, right| {
        left.expiration_date
            .cmp(&right.expiration_date)
            .then_with(|| left.strike_price.total_cmp(&right.strike_price))
            .then_with(|| left.put_call.cmp(&right.put_call))
    });
    contracts.dedup_by(|left, right| left.symbol == right.symbol);
    OptionChainSnapshot {
        symbol,
        underlying_price,
        delayed,
        fetched_at: Utc::now().to_rfc3339(),
        contracts,
    }
}

fn option_contract_from_chain(
    value: &Value,
    underlying: &str,
    expiration_date: &str,
    fallback_side: &str,
    underlying_price: f64,
    delayed: bool,
) -> Option<OptionContract> {
    let symbol = value.get("symbol")?.as_str()?.to_string();
    let strike_price = number_named(value, "strikePrice")?;
    Some(OptionContract {
        symbol,
        underlying: underlying.to_string(),
        put_call: value
            .get("putCall")
            .and_then(Value::as_str)
            .unwrap_or(fallback_side)
            .to_uppercase(),
        expiration_date: value
            .get("expirationDate")
            .and_then(Value::as_str)
            .unwrap_or(expiration_date)
            .to_string(),
        strike_price,
        multiplier: number_named(value, "multiplier").unwrap_or_default(),
        gamma: number_named(value, "gamma").unwrap_or_default(),
        open_interest: number_named(value, "openInterest").unwrap_or_default(),
        bid_price: number_named(value, "bidPrice").unwrap_or_default(),
        ask_price: number_named(value, "askPrice").unwrap_or_default(),
        bid_size: number_named(value, "bidSize").unwrap_or_default(),
        ask_size: number_named(value, "askSize").unwrap_or_default(),
        mark_price: number_named(value, "markPrice").unwrap_or_default(),
        total_volume: number_named(value, "totalVolume").unwrap_or_default(),
        volatility: number_named(value, "volatility").unwrap_or_default(),
        delta: number_named(value, "delta").unwrap_or_default(),
        theta: number_named(value, "theta").unwrap_or_default(),
        vega: number_named(value, "vega").unwrap_or_default(),
        underlying_price,
        quote_time: integer_named(value, "quoteTimeInLong").unwrap_or_default(),
        delayed,
        is_mini: value
            .get("isMini")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_non_standard: value
            .get("isNonStandard")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub fn streamed_option_from_value(value: &Value) -> Option<OptionContract> {
    let symbol = value
        .get("key")
        .or_else(|| value.get("0"))?
        .as_str()?
        .to_string();
    let expiration_year = integer_field(value, 12)?;
    let expiration_month = integer_field(value, 23)?;
    let expiration_day = integer_field(value, 26)?;
    let put_call = match value.get("21").and_then(Value::as_str).unwrap_or_default() {
        "C" | "CALL" => "CALL",
        "P" | "PUT" => "PUT",
        other => other,
    };
    Some(OptionContract {
        symbol,
        underlying: value
            .get("22")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_uppercase(),
        put_call: put_call.to_string(),
        expiration_date: format!("{expiration_year:04}-{expiration_month:02}-{expiration_day:02}"),
        strike_price: numeric_field(value, 20)?,
        multiplier: numeric_field(value, 13).unwrap_or_default(),
        gamma: numeric_field(value, 29).unwrap_or_default(),
        open_interest: numeric_field(value, 9).unwrap_or_default(),
        bid_price: numeric_field(value, 2).unwrap_or_default(),
        ask_price: numeric_field(value, 3).unwrap_or_default(),
        bid_size: numeric_field(value, 16).unwrap_or_default(),
        ask_size: numeric_field(value, 17).unwrap_or_default(),
        mark_price: numeric_field(value, 37).unwrap_or_default(),
        total_volume: numeric_field(value, 8).unwrap_or_default(),
        volatility: numeric_field(value, 10).unwrap_or_default(),
        delta: numeric_field(value, 28).unwrap_or_default(),
        theta: numeric_field(value, 30).unwrap_or_default(),
        vega: numeric_field(value, 31).unwrap_or_default(),
        underlying_price: numeric_field(value, 35).unwrap_or_default(),
        quote_time: integer_field(value, 38).unwrap_or_default(),
        delayed: false,
        is_mini: false,
        is_non_standard: false,
    })
}

fn numeric_field(value: &Value, index: u8) -> Option<f64> {
    value
        .get(index.to_string())
        .and_then(|item| item.as_f64().or_else(|| item.as_i64().map(|v| v as f64)))
        .filter(|item| item.is_finite())
}

fn integer_field(value: &Value, index: u8) -> Option<i64> {
    value
        .get(index.to_string())
        .and_then(|item| item.as_i64().or_else(|| item.as_f64().map(|v| v as i64)))
}

fn number_named(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(|item| item.as_f64().or_else(|| item.as_i64().map(|v| v as f64)))
        .filter(|item| item.is_finite())
}

fn integer_named(value: &Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(|item| item.as_i64().or_else(|| item.as_f64().map(|v| v as i64)))
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn truncate(value: &str) -> String {
    value.chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbitrary_minute_intervals_align_to_new_york_midnight() {
        let source = new_york_epoch(
            NaiveDate::from_ymd_opt(2026, 7, 20)
                .unwrap()
                .and_hms_opt(9, 37, 0)
                .unwrap(),
        );
        let seven = new_york_local(bucket_start(source, "7m").unwrap()).unwrap();
        let forty_five = new_york_local(bucket_start(source, "45m").unwrap()).unwrap();
        let daily_minutes = new_york_local(bucket_start(source, "1440m").unwrap()).unwrap();
        assert_eq!((seven.hour(), seven.minute()), (9, 34));
        assert_eq!((forty_five.hour(), forty_five.minute()), (9, 0));
        assert_eq!((daily_minutes.hour(), daily_minutes.minute()), (0, 0));
        for value in ["0m", "01m", "1441m", "7.5m"] {
            assert!(
                minute_interval(value).is_none(),
                "{value} should be rejected"
            );
        }
    }

    #[test]
    fn arbitrary_minute_aggregation_preserves_ohlcv() {
        let start = new_york_epoch(
            NaiveDate::from_ymd_opt(2026, 7, 20)
                .unwrap()
                .and_hms_opt(9, 34, 0)
                .unwrap(),
        );
        let result = aggregate_bars(
            &[
                bar(start, 10.0, 11.0, 9.0, 10.5, 100.0),
                bar(start + 60, 10.5, 12.0, 10.0, 11.5, 125.0),
            ],
            "7m",
        );
        assert_eq!(result.len(), 1);
        assert_eq!(
            (
                result[0].open,
                result[0].high,
                result[0].low,
                result[0].close,
                result[0].volume
            ),
            (10.0, 12.0, 9.0, 11.5, 225.0)
        );
    }

    #[test]
    fn instrument_search_matches_symbols_and_descriptions() {
        let url = instrument_search_url(" Apple ").unwrap();
        assert_eq!(url.path(), "/marketdata/v1/instruments");
        let query = url.query_pairs().collect::<BTreeMap<_, _>>();
        assert_eq!(
            query.get("symbol").map(|value| value.as_ref()),
            Some("Apple")
        );
        assert_eq!(
            query.get("projection").map(|value| value.as_ref()),
            Some("search")
        );
    }

    #[test]
    fn parses_and_sorts_option_expirations() {
        let values = serde_json::json!({"expirationList":[
            {"expirationDate":"2026-08-21","daysToExpiration":30,"expirationType":"S","standard":true},
            {"expirationDate":"2026-07-24","daysToExpiration":2,"expirationType":"W","standard":true}
        ]});
        let expirations = option_expirations_from_value(&values);
        assert_eq!(expirations[0].expiration_date, "2026-07-24");
        assert_eq!(expirations[1].days_to_expiration, 30);
    }

    #[test]
    fn parses_nested_chain_and_filters_exact_expirations() {
        let contract = |symbol: &str, side: &str, expiration: &str| {
            serde_json::json!({
                "symbol":symbol,"putCall":side,"strikePrice":200.0,"expirationDate":expiration,
                "multiplier":100.0,"gamma":0.02,"theta":-0.11,"vega":0.24,"openInterest":1200,
                "bidPrice":5.0,"askPrice":5.2,"bidSize":14,"askSize":19,
                "markPrice":5.1,"isMini":false,"isNonStandard":false
            })
        };
        let values = serde_json::json!({
            "symbol":"AAPL","underlyingPrice":205.0,"isDelayed":false,
            "callExpDateMap":{
                "2026-07-24:2":{"200.0":[contract("AAPL  260724C00200000","CALL","2026-07-24")]},
                "2026-08-21:30":{"200.0":[contract("AAPL  260821C00200000","CALL","2026-08-21")]}
            },
            "putExpDateMap":{
                "2026-07-24:2":{"200.0":[contract("AAPL  260724P00200000","PUT","2026-07-24")]}
            }
        });
        let snapshot = option_chain_from_value(&values, "AAPL", &["2026-07-24".into()]);
        assert_eq!(snapshot.contracts.len(), 2);
        assert!(snapshot
            .contracts
            .iter()
            .all(|item| item.expiration_date == "2026-07-24"));
        assert_eq!(snapshot.contracts[0].underlying_price, 205.0);
        assert_eq!(snapshot.contracts[0].bid_size, 14.0);
        assert_eq!(snapshot.contracts[0].ask_size, 19.0);
        assert_eq!(snapshot.contracts[0].theta, -0.11);
        assert_eq!(snapshot.contracts[0].vega, 0.24);
    }

    fn bar(time: i64, open: f64, high: f64, low: f64, close: f64, volume: f64) -> Bar {
        Bar {
            time,
            open,
            high,
            low,
            close,
            volume,
            realtime: true,
        }
    }

    #[test]
    fn aggregates_intraday_bars_without_losing_volume() {
        let start = new_york_epoch(
            NaiveDate::from_ymd_opt(2026, 7, 20)
                .unwrap()
                .and_hms_opt(9, 30, 0)
                .unwrap(),
        );
        let result = aggregate_bars(
            &[
                bar(start, 10.0, 11.0, 9.0, 10.5, 100.0),
                bar(start + 60, 10.5, 12.0, 10.0, 11.5, 125.0),
            ],
            "5m",
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].open, 10.0);
        assert_eq!(result[0].high, 12.0);
        assert_eq!(result[0].low, 9.0);
        assert_eq!(result[0].close, 11.5);
        assert_eq!(result[0].volume, 225.0);
    }

    #[test]
    fn four_hour_buckets_follow_new_york_time_across_dst() {
        let winter = Utc
            .with_ymd_and_hms(2026, 1, 5, 14, 30, 0)
            .unwrap()
            .timestamp();
        let summer = Utc
            .with_ymd_and_hms(2026, 7, 20, 13, 30, 0)
            .unwrap()
            .timestamp();
        for time in [winter, summer] {
            let bucket = bucket_start(time, "4h").unwrap();
            let local = new_york_local(bucket).unwrap();
            assert_eq!((local.hour(), local.minute()), (8, 0));
        }
    }

    #[test]
    fn parses_sparse_stream_quote_fields() {
        let quote = streamed_quote_from_value(&serde_json::json!({
            "key":"AAPL", "delayed":false, "1":210.1, "2":210.2, "3":210.15,
            "12":208.0, "18":2.15, "32":"Normal", "34":1_784_592_000_000_i64,
            "42":1.03365
        }))
        .unwrap();
        assert_eq!(quote.provider, MarketDataProvider::Schwab);
        assert_eq!(quote.symbol, "AAPL");
        assert!(!quote.delayed);
        assert!(!quote.halted);
    }

    #[test]
    fn parses_index_rest_quotes_without_changing_the_api_symbol() {
        let quote = quote_from_value(
            "$VIX",
            &serde_json::json!({
                "assetMainType":"INDEX",
                "realtime":true,
                "quote":{
                    "lastPrice":17.25,
                    "bidPrice":17.24,
                    "askPrice":17.26,
                    "closePrice":16.75,
                    "netChange":0.5,
                    "netPercentChange":2.985,
                    "quoteTime":1_784_592_000_000_i64,
                    "securityStatus":"Normal"
                }
            }),
        )
        .unwrap();
        assert_eq!(quote.provider, MarketDataProvider::Schwab);
        assert_eq!(quote.symbol, "$VIX");
        assert_eq!(quote.last, 17.25);
        assert!(!quote.delayed);
        assert!(!quote.halted);
    }

    #[test]
    fn parses_production_chart_equity_sequence_before_ohlcv() {
        let bar = chart_bar_from_value(&serde_json::json!({
            "key":"AAPL", "1":779, "2":324.35, "3":324.50,
            "4":324.32, "5":324.50, "6":337,
            "7":1_784_678_340_000_i64, "8":20_260_721
        }))
        .unwrap();
        assert_eq!(bar.time, 1_784_678_340);
        assert_eq!(bar.open, 324.35);
        assert_eq!(bar.high, 324.50);
        assert_eq!(bar.low, 324.32);
        assert_eq!(bar.close, 324.50);
        assert_eq!(bar.volume, 337.0);
    }

    #[test]
    fn keeps_compatibility_with_documented_chart_equity_ohlcv_layout() {
        let bar = chart_bar_from_value(&serde_json::json!({
            "key":"AAPL", "1":324.35, "2":324.50, "3":324.32,
            "4":324.50, "5":337, "6":779,
            "7":1_784_678_340_000_i64, "8":20_260_721
        }))
        .unwrap();
        assert_eq!(bar.open, 324.35);
        assert_eq!(bar.high, 324.50);
        assert_eq!(bar.low, 324.32);
        assert_eq!(bar.close, 324.50);
        assert_eq!(bar.volume, 337.0);
    }

    #[test]
    fn accepts_equities_etfs_and_indexes_but_rejects_other_instruments() {
        let equity = instrument_from_value(&serde_json::json!({
            "symbol":"AAPL", "description":"Apple Inc", "assetType":"EQUITY", "exchange":"Q"
        }))
        .unwrap();
        let etf = instrument_from_value(&serde_json::json!({
            "symbol":"SPY", "description":"SPDR S&P 500 ETF", "assetType":"ETF", "exchange":"P"
        }))
        .unwrap();
        let index = instrument_from_value(&serde_json::json!({
            "symbol":"$VIX", "description":"CBOE Volatility Index", "assetType":"INDEX", "exchange":"CBOE"
        }))
        .unwrap();
        assert_eq!(equity.symbol, "AAPL");
        assert_eq!(etf.symbol, "SPY");
        assert_eq!(etf.asset_type, "ETF");
        assert_eq!(etf.exchange, "ARCA");
        assert_eq!(index.symbol, "$VIX");
        assert_eq!(index.asset_type, "INDEX");
        assert_eq!(index.exchange, "CBOE");
        assert!(instrument_from_value(&serde_json::json!({
            "symbol":"SPY  260821C00600000", "assetType":"OPTION"
        }))
        .is_none());
        assert!(instrument_from_value(&serde_json::json!({
            "symbol":"/VX", "assetType":"FUTURE"
        }))
        .is_none());
    }

    #[test]
    fn rejects_sequence_shifted_candles_from_cache() {
        assert!(!valid_equity_bar(&bar(
            1_784_678_340,
            779.0,
            324.35,
            324.50,
            324.32,
            324.50
        )));
    }

    #[test]
    fn out_of_order_minutes_and_replacements_are_normalized() {
        let start = new_york_epoch(
            NaiveDate::from_ymd_opt(2026, 7, 20)
                .unwrap()
                .and_hms_opt(9, 30, 0)
                .unwrap(),
        );
        let result = aggregate_bars(
            &[
                bar(start + 60, 11.0, 12.0, 10.0, 11.5, 125.0),
                bar(start, 10.0, 11.0, 9.0, 10.5, 100.0),
                bar(start + 60, 11.0, 12.5, 10.0, 12.0, 130.0),
            ],
            "5m",
        );
        assert_eq!(result[0].open, 10.0);
        assert_eq!(result[0].close, 12.0);
        assert_eq!(result[0].high, 12.5);
        assert_eq!(result[0].volume, 230.0);
    }

    #[test]
    fn calendar_buckets_roll_in_new_york_time() {
        let sunday = new_york_epoch(
            NaiveDate::from_ymd_opt(2026, 7, 19)
                .unwrap()
                .and_hms_opt(20, 0, 0)
                .unwrap(),
        );
        let monday = sunday + 12 * 3_600;
        assert_ne!(bucket_start(sunday, "W"), bucket_start(monday, "W"));
        let july = new_york_epoch(
            NaiveDate::from_ymd_opt(2026, 7, 31)
                .unwrap()
                .and_hms_opt(20, 0, 0)
                .unwrap(),
        );
        let august = july + 12 * 3_600;
        assert_ne!(bucket_start(july, "M"), bucket_start(august, "M"));
        assert_ne!(bucket_start(july, "D"), bucket_start(august, "D"));
    }

    #[test]
    fn current_day_range_starts_at_new_york_midnight() {
        for date in [
            NaiveDate::from_ymd_opt(2026, 1, 15).unwrap(),
            NaiveDate::from_ymd_opt(2026, 7, 22).unwrap(),
        ] {
            let midnight = new_york_epoch(date.and_hms_opt(0, 0, 0).unwrap());
            let now = new_york_epoch(date.and_hms_opt(14, 46, 0).unwrap());
            assert_eq!(current_new_york_day_range(now), Some((midnight, now + 1)));
        }
    }
}
