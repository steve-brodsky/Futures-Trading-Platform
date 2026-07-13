use crate::{models::*, storage, AppError};
use chrono::{DateTime, Utc};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
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

    pub async fn environment(&self) -> TradingEnvironment {
        self.session.lock().await.environment.clone()
    }

    pub async fn open_stream(&self, path: &str) -> Result<reqwest::Response, AppError> {
        let token = self.token().await?;
        let url = format!("{}{}", self.base().await, path);
        let response = self.client.get(url).bearer_auth(token).send().await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.clear_token().await;
            return Err(AppError::AuthenticationRequired);
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
        let details = symbol_from_value(item);
        if details.point_value <= 0.0 {
            return Err(AppError::Api(format!(
                "TradeStation omitted point value for {symbol}"
            )));
        }
        Ok(details)
    }

    pub async fn bars(&self, symbol: &str, timeframe: &str) -> Result<Vec<Bar>, AppError> {
        let (interval, unit, bars_back) = history_spec(timeframe)?;
        let path = format!(
            "/marketdata/barcharts/{symbol}?interval={interval}&unit={unit}&barsback={bars_back}"
        );
        let body = self.send(Method::GET, &path, None).await?;
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

    pub fn bar_stream_path(symbol: &str, timeframe: &str) -> Result<String, AppError> {
        let (interval, unit, bars_back) = history_spec(timeframe)?;
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
                bid: optional_number(item, "Bid"),
                ask: optional_number(item, "Ask"),
                unrealized_pnl_percent: optional_number(item, "UnrealizedProfitLossPercent"),
                unrealized_pnl_quantity: optional_number(item, "UnrealizedProfitLossQty"),
                initial_requirement: optional_number(item, "InitialRequirement"),
                maintenance_margin: optional_number(item, "MaintenanceMargin"),
                market_value: optional_number(item, "MarketValue"),
                timestamp: optional_string(item, "Timestamp"),
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
        let body = self.send(Method::GET, &path, None).await?;
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
            .accounts()
            .await?
            .iter()
            .any(|account| account.id == account_id)
        {
            return Err(AppError::Validation(
                "Selected futures account is unavailable".into(),
            ));
        }
        let mut order = self
            .orders(account_id)
            .await?
            .into_iter()
            .find(|order| order.id == order_id)
            .ok_or_else(|| AppError::Validation("The order is no longer available".into()))?;
        if order.status != "Working" {
            return Err(AppError::Validation(
                "Only working orders can be repositioned".into(),
            ));
        }
        if order.open_or_close.as_deref() != Some("Close") || !is_bracket_order(&order) {
            return Err(AppError::Validation(
                "Only bracket take-profit and stop-loss orders can be repositioned".into(),
            ));
        }
        if !matches!(order.order_type.as_str(), "Limit" | "StopMarket") {
            return Err(AppError::Validation(
                "This order type cannot be repositioned on the chart".into(),
            ));
        }
        let meta = self.symbol_details(&order.symbol).await?;
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
        if !self
            .accounts()
            .await?
            .iter()
            .any(|account| account.id == account_id)
        {
            return Err(AppError::Validation(
                "Selected futures account is unavailable".into(),
            ));
        }
        let position = self
            .positions(account_id)
            .await?
            .into_iter()
            .find(|position| position.id == position_id)
            .ok_or_else(|| AppError::Validation("The position is no longer open".into()))?;
        let orders = self.orders(account_id).await?;
        let relevant = closing_orders_for_position(&orders, account_id, &position.symbol);
        if relevant.iter().any(|order| order.status == "Indeterminate") {
            return Ok(aborted_close(
                position_id,
                &position.symbol,
                vec![],
                "A closing order has an indeterminate status; the position was not flattened",
            ));
        }
        let active_ids: Vec<String> = relevant
            .iter()
            .filter(|order| order.status == "Working")
            .map(|order| order.id.clone())
            .collect();
        let mut cancellation_requests: Vec<String> = relevant
            .iter()
            .filter(|order| order.raw_status.as_deref() == Some("UCN"))
            .map(|order| order.id.clone())
            .collect();
        for order in relevant
            .iter()
            .filter(|order| order.status == "Working" && order.raw_status.as_deref() != Some("UCN"))
        {
            if let Err(error) = self.cancel_order(&order.id).await {
                return Ok(aborted_close(
                    position_id,
                    &position.symbol,
                    cancellation_requests,
                    format!(
                        "Cancellation failed for order {}: {error}. The position was not flattened",
                        order.id
                    ),
                ));
            }
            cancellation_requests.push(order.id.clone());
        }
        if !active_ids.is_empty() {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                let current = match self.orders(account_id).await {
                    Ok(current) => current,
                    Err(error) => {
                        return Ok(aborted_close(
                            position_id,
                            &position.symbol,
                            cancellation_requests,
                            format!(
                                "Could not verify exit cancellations: {error}. The position was not flattened"
                            ),
                        ))
                    }
                };
                let complete = match cancellation_poll_complete(
                    &active_ids,
                    &current,
                    tokio::time::Instant::now() >= deadline,
                ) {
                    Ok(complete) => complete,
                    Err(error) => {
                        return Ok(aborted_close(
                            position_id,
                            &position.symbol,
                            cancellation_requests,
                            error.to_string(),
                        ))
                    }
                };
                if complete {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        let cancelled_order_ids = active_ids;
        let current_positions = match self.positions(account_id).await {
            Ok(positions) => positions,
            Err(error) => {
                return Ok(aborted_close(
                    position_id,
                    &position.symbol,
                    cancelled_order_ids,
                    format!(
                        "Could not re-fetch the position after cancelling exits: {error}. No flatten order was submitted"
                    ),
                ))
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
        let flatten_order = match self.place_order(&draft).await {
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
        Ok(ClosePositionResult {
            position_id: position_id.into(),
            symbol: current_position.symbol,
            cancelled_order_ids,
            flatten_order: Some(flatten_order),
            error: None,
        })
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
    order
        .group_name
        .as_deref()
        .is_some_and(|name| name.to_ascii_uppercase().starts_with("OCO"))
        || order
            .related_orders
            .iter()
            .any(|related| related.relationship.eq_ignore_ascii_case("OCO"))
}

fn closing_orders_for_position<'a>(
    orders: &'a [OrderUpdate],
    account_id: &str,
    symbol: &str,
) -> Vec<&'a OrderUpdate> {
    orders
        .iter()
        .filter(|order| {
            order.account_id.as_deref() == Some(account_id)
                && order.symbol == symbol
                && order.open_or_close.as_deref() == Some("Close")
                && matches!(order.status.as_str(), "Working" | "Indeterminate")
        })
        .collect()
}

fn flatten_draft(account_id: &str, position: &Position) -> Result<OrderDraft, AppError> {
    let rounded = position.quantity.round();
    if position.quantity <= 0.0
        || (position.quantity - rounded).abs() > 1e-8
        || rounded > u32::MAX as f64
    {
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

fn cancellation_poll_complete(
    active_ids: &[String],
    current: &[OrderUpdate],
    timed_out: bool,
) -> Result<bool, AppError> {
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
            .any(|order| order.id == *id && order.status == "Working")
    });
    if unresolved && timed_out {
        return Err(AppError::Api(
            "Closing orders did not cancel within 10 seconds; the position was not flattened"
                .into(),
        ));
    }
    Ok(!unresolved)
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
        unrealized_profit_loss: optional_number(item, "UnrealizedProfitLoss"),
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
        let included = sample_order("1");
        let mut opening = sample_order("2");
        opening.open_or_close = Some("Open".into());
        let mut other_symbol = sample_order("3");
        other_symbol.symbol = "MNQU26".into();
        let mut other_account = sample_order("4");
        other_account.account_id = Some("account-2".into());
        let mut filled = sample_order("5");
        filled.status = "Filled".into();
        let orders = vec![included, opening, other_symbol, other_account, filled];
        assert_eq!(
            closing_orders_for_position(&orders, "account-1", "MESU26")
                .iter()
                .map(|order| order.id.as_str())
                .collect::<Vec<_>>(),
            vec!["1"]
        );
    }

    #[test]
    fn flatten_draft_uses_current_quantity_and_opposite_side() {
        let long = flatten_draft("account-1", &sample_position("Long", 2.0)).unwrap();
        assert_eq!((long.side.as_str(), long.quantity), ("Sell", 2));
        let reduced = flatten_draft("account-1", &sample_position("Short", 1.0)).unwrap();
        assert_eq!((reduced.side.as_str(), reduced.quantity), ("Buy", 1));
        assert!(flatten_draft("account-1", &sample_position("Long", 0.0)).is_err());
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
