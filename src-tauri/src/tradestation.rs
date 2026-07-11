use crate::{models::*, storage, AppError};
use chrono::{DateTime, Utc};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

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
    pub session: Arc<Mutex<Session>>,
}

impl TradeStation {
    pub fn new() -> Result<Self, AppError> {
        let client = reqwest::Client::builder()
            .user_agent("NorthstarTrader/0.1")
            .connect_timeout(Duration::from_secs(12))
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            client,
            session: Arc::new(Mutex::new(Session::default())),
        })
    }

    pub async fn set_environment(&self, environment: TradingEnvironment) {
        self.session.lock().await.environment = environment;
    }

    pub async fn set_token(&self, value: String, expires_in: u64) {
        self.session.lock().await.token = Some(AccessToken {
            value,
            expires_at: Instant::now() + Duration::from_secs(expires_in.saturating_sub(45)),
        });
    }

    pub async fn clear_token(&self) {
        self.session.lock().await.token = None;
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

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let token = self.token().await?;
        let url = format!("{}{}", self.base().await, path);
        let mut request = self
            .client
            .request(method.clone(), &url)
            .bearer_auth(&token)
            .header("Accept", "application/json");
        if let Some(value) = body.clone() {
            request = request.json(&value);
        }
        let mut response = request.send().await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.clear_token().await;
            let token = self.refresh().await?;
            let mut retry = self
                .client
                .request(method, &url)
                .bearer_auth(token)
                .header("Accept", "application/json");
            if let Some(value) = body {
                retry = retry.json(&value);
            }
            response = retry.send().await?;
        }
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            let reset = response
                .headers()
                .get("x-ratelimit-reset")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("unknown");
            return Err(AppError::Api(format!(
                "TradeStation rate limit reached; reset in {reset} seconds"
            )));
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
        if text.trim().is_empty() {
            Ok(json!({}))
        } else {
            Ok(serde_json::from_str(&text)?)
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
        let body = self.send(Method::GET, "/brokerage/accounts", None).await?;
        Ok(body
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
            .collect())
    }

    pub async fn search_symbols(&self, query: &str) -> Result<Vec<SymbolMeta>, AppError> {
        let token = self.token().await?;
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
        let response = self.client.get(url).bearer_auth(token).send().await?;
        if !response.status().is_success() {
            return Err(AppError::Api(format!(
                "Symbol lookup returned HTTP {}",
                response.status()
            )));
        }
        let body: Value = response.json().await?;
        Ok(body
            .as_array()
            .into_iter()
            .flatten()
            .map(symbol_from_value)
            .collect())
    }

    pub async fn symbol_details(&self, symbol: &str) -> Result<SymbolMeta, AppError> {
        let path = format!("/marketdata/symbols/{symbol}");
        let body = self.send(Method::GET, &path, None).await?;
        let item = body
            .get("Symbols")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .ok_or_else(|| AppError::Api("Symbol details unavailable".into()))?;
        Ok(symbol_from_value(item))
    }

    pub async fn bars(&self, symbol: &str, timeframe: &str) -> Result<Vec<Bar>, AppError> {
        let (interval, unit, bars_back) = match timeframe {
            "1m" => (1, "Minute", 600),
            "5m" => (5, "Minute", 500),
            "15m" => (15, "Minute", 450),
            "30m" => (30, "Minute", 400),
            "1h" => (60, "Minute", 400),
            "4h" => (240, "Minute", 350),
            "D" => (1, "Daily", 500),
            "W" => (1, "Weekly", 400),
            "M" => (1, "Monthly", 240),
            _ => return Err(AppError::Validation("Unsupported timeframe".into())),
        };
        let path = format!(
            "/marketdata/barcharts/{symbol}?interval={interval}&unit={unit}&barsback={bars_back}"
        );
        let body = self.send(Method::GET, &path, None).await?;
        let mut result: Vec<Bar> = body
            .get("Bars")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                let time = item
                    .get("Epoch")
                    .and_then(number_i64)
                    .map(|v| v / 1000)
                    .or_else(|| {
                        item.get("TimeStamp")
                            .and_then(Value::as_str)
                            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                            .map(|v| v.timestamp())
                    })?;
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
            })
            .collect();
        result.sort_by_key(|bar| bar.time);
        result.dedup_by_key(|bar| bar.time);
        Ok(result)
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
            .map(|item| {
                let flags = item.get("MarketFlags").unwrap_or(&Value::Null);
                Quote {
                    symbol: string(item, "Symbol"),
                    last: number(item, "Last"),
                    bid: number(item, "Bid"),
                    ask: number(item, "Ask"),
                    change: number(item, "NetChange"),
                    change_pct: number(item, "NetChangePct"),
                    delayed: flags
                        .get("IsDelayed")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    halted: flags
                        .get("IsHalted")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    timestamp: string(item, "TradeTime"),
                }
            })
            .collect())
    }

    pub async fn positions(&self, account: &str) -> Result<Vec<Position>, AppError> {
        let body = self
            .send(
                Method::GET,
                &format!("/brokerage/accounts/{account}/positions"),
                None,
            )
            .await?;
        Ok(body
            .get("Positions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|item| Position {
                id: string(item, "PositionID"),
                symbol: string(item, "Symbol"),
                side: string(item, "LongShort"),
                quantity: number(item, "Quantity"),
                average_price: number(item, "AveragePrice"),
                last: number(item, "Last"),
                unrealized_pnl: number(item, "UnrealizedProfitLoss"),
            })
            .collect())
    }

    pub async fn orders(&self, account: &str) -> Result<Vec<OrderUpdate>, AppError> {
        let body = self
            .send(
                Method::GET,
                &format!("/brokerage/accounts/{account}/orders"),
                None,
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

    async fn validate_order(&self, draft: &OrderDraft) -> Result<(), AppError> {
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
        let accounts = self.accounts().await?;
        if !accounts.iter().any(|a| a.id == draft.account_id) {
            return Err(AppError::Validation(
                "Selected futures account is unavailable".into(),
            ));
        }
        let meta = self.symbol_details(&draft.symbol).await?;
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

fn order_from_value(item: &Value) -> OrderUpdate {
    let leg = item
        .get("Legs")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .unwrap_or(item);
    OrderUpdate {
        id: string(item, "OrderID"),
        symbol: string(leg, "Symbol"),
        side: string(leg, "BuyOrSell"),
        order_type: string(item, "OrderType"),
        quantity: number(leg, "QuantityOrdered") as u32,
        price: optional_number(item, "LimitPrice"),
        stop_price: optional_number(item, "StopPrice"),
        status: string(item, "Status"),
        timestamp: string(item, "OpenedDateTime"),
    }
}

fn symbol_from_value(item: &Value) -> SymbolMeta {
    SymbolMeta {
        symbol: string(item, "Name").or_else_empty(|| string(item, "Symbol")),
        description: string(item, "Description"),
        exchange: string(item, "Exchange"),
        asset_type: string(item, "Category").or_else_empty(|| string(item, "AssetType")),
        min_move: number(item, "MinMove").max(0.00000001),
        point_value: number(item, "PointValue"),
        expiration: item
            .get("ExpirationDate")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
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
    fn tick_alignment_is_decimal_safe_enough_for_validation() {
        assert!(aligned(6260.25, 0.25));
        assert!(!aligned(6260.10, 0.25));
    }
    #[test]
    fn masks_account_numbers() {
        assert_eq!(mask_account("123456789"), "•••6789");
    }
}
