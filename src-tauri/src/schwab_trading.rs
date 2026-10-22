//! Equity order lifecycle. Only explicit desktop commands can perform writes.
use crate::{models::*, safety, schwab::Schwab, AppError, NativeState};
use chrono::{DateTime, Utc};
use reqwest::Method;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};
use tauri::{Emitter, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityState {
    session_open: bool,
    session_message: String,
    positions: Vec<Position>,
    orders: Vec<OrderUpdate>,
    risk_baselines: Vec<Value>,
    issues: Vec<String>,
    warnings: Vec<String>,
    mutations: Vec<safety::MutationIntent>,
}

pub fn init(path: &Path) -> Result<(), AppError> {
    Connection::open(path)?.execute_batch(
        "CREATE TABLE IF NOT EXISTS schwab_equity_brackets (
        account_id TEXT NOT NULL, root_id TEXT NOT NULL, draft_json TEXT NOT NULL,
        order_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(account_id,root_id));",
    )?;
    Ok(())
}

fn save_bracket(
    path: &Path,
    account: &str,
    id: &str,
    draft: &Value,
    order: &Value,
) -> Result<(), AppError> {
    fn redact_accounts(value: &Value) -> Value {
        match value {
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .filter(|(key, _)| !key.to_ascii_lowercase().contains("accountnumber"))
                    .map(|(key, value)| (key.clone(), redact_accounts(value)))
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.iter().map(redact_accounts).collect()),
            _ => value.clone(),
        }
    }
    let order = redact_accounts(order);
    Connection::open(path)?.execute("INSERT INTO schwab_equity_brackets VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(account_id,root_id) DO UPDATE SET order_json=excluded.order_json,updated_at=excluded.updated_at",
        params![account,id,draft.to_string(),order.to_string(),Utc::now().to_rfc3339()])?;
    Ok(())
}

fn brackets(path: &Path, account: &str) -> Result<Vec<(String, Value, Value)>, AppError> {
    let db = Connection::open(path)?;
    let mut query = db.prepare(
        "SELECT root_id,draft_json,order_json FROM schwab_equity_brackets WHERE account_id=?1",
    )?;
    let rows = query
        .query_map([account], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, draft, order)| {
            Ok((
                id,
                serde_json::from_str(&draft)?,
                serde_json::from_str(&order)?,
            ))
        })
        .collect()
}

fn save_prepared(
    path: &Path,
    mutation: &str,
    request: &Value,
    prepared: &Value,
) -> Result<(), AppError> {
    let mut request = request.clone();
    request["_prepared"] = prepared.clone();
    Connection::open(path)?.execute(
        "UPDATE broker_mutations SET request_json=?2 WHERE id=?1",
        params![mutation, request.to_string()],
    )?;
    Ok(())
}

pub fn equity(asset: Option<&str>) -> bool {
    matches!(
        asset.unwrap_or("").to_ascii_uppercase().as_str(),
        "EQUITY" | "ETF" | "COLLECTIVE_INVESTMENT"
    )
}
fn active(order: &OrderUpdate) -> bool {
    matches!(
        order.status.as_str(),
        "Working" | "Pending" | "Indeterminate"
    )
}
fn flatten(raw: &Value, account: &str) -> Vec<OrderUpdate> {
    crate::schwab::equity_order_rows(raw, account)
}

pub fn session_open(value: &Value, now: DateTime<Utc>) -> bool {
    fn visit(value: &Value, now: DateTime<Utc>) -> bool {
        if value.get("isOpen").and_then(Value::as_bool) == Some(true) {
            if let Some(hours) = value
                .pointer("/sessionHours/regularMarket")
                .and_then(Value::as_array)
            {
                return hours.iter().any(|range| {
                    let start = range
                        .get("start")
                        .and_then(Value::as_str)
                        .and_then(|v| DateTime::parse_from_rfc3339(v).ok());
                    let end = range
                        .get("end")
                        .and_then(Value::as_str)
                        .and_then(|v| DateTime::parse_from_rfc3339(v).ok());
                    start
                        .zip(end)
                        .is_some_and(|(start, end)| now >= start && now < end)
                });
            }
        }
        value
            .as_object()
            .is_some_and(|object| object.values().any(|v| visit(v, now)))
    }
    visit(value, now)
}

pub fn placement_payload(draft: &SchwabEquityOrderDraft) -> Value {
    let (entry, exit) = if draft.direction == "Long" {
        ("BUY", "SELL")
    } else {
        ("SELL_SHORT", "BUY_TO_COVER")
    };
    let leg = |instruction: &str| {
        json!([{"instruction":instruction,"quantity":draft.quantity,
        "instrument":{"symbol":draft.symbol,"assetType":"EQUITY"}}])
    };
    let exit_duration = schwab_duration(&draft.exit_duration);
    json!({"session":"NORMAL","duration":"DAY","orderType":"MARKET","orderStrategyType":"TRIGGER",
        "orderLegCollection":leg(entry),"childOrderStrategies":[{"orderStrategyType":"OCO","childOrderStrategies":[
            {"session":"NORMAL","duration":exit_duration,"orderType":"LIMIT","price":draft.take_profit,
             "orderStrategyType":"SINGLE","orderLegCollection":leg(exit)},
            {"session":"NORMAL","duration":exit_duration,"orderType":"STOP","stopPrice":draft.stop_loss,
             "orderStrategyType":"SINGLE","orderLegCollection":leg(exit)}]}]})
}

// The ticket uses GTC; Schwab's order API uses the full duration enum value.
fn schwab_duration(value: &str) -> &str {
    match value {
        "GTC" => "GOOD_TILL_CANCEL",
        value => value,
    }
}

/// previewOrder accepts an order request, including the full bracket tree.
/// orderStrategy/orderLegs describes its RESPONSE, not the request envelope.
/// Keep a separate adapter only to normalize legacy persisted durations.
pub fn preview_payload(order: &Value) -> Value {
    fn strategy(order: &Value) -> Value {
        let mut result = order.clone();
        if let Some(object) = result.as_object_mut() {
            if let Some(duration) = object.get("duration").and_then(Value::as_str) {
                object.insert("duration".into(), json!(schwab_duration(duration)));
            }
            if let Some(children) = object
                .get_mut("childOrderStrategies")
                .and_then(Value::as_array_mut)
            {
                for child in children {
                    *child = strategy(child);
                }
            }
        }
        result
    }
    strategy(order)
}

pub fn parse_preview(value: &Value) -> OrderPreview {
    let validation = value.get("orderValidationResult");
    let mut errors = Vec::new();
    // Empty validation categories are often omitted in broker responses.
    // An accepts-only response is recognized; an absent/malformed result is not.
    let categories = ["alerts", "accepts", "rejects", "reviews", "warns"];
    let recognized = validation.is_some_and(|result| {
        result.is_object()
            && categories
                .iter()
                .any(|key| result.get(key).is_some_and(Value::is_array))
            && categories
                .iter()
                .all(|key| result.get(key).is_none_or(|v| v.is_null() || v.is_array()))
    });
    if !recognized {
        errors.push(
            "Schwab did not return a recognized order validation result; submission is disabled"
                .into(),
        );
    }
    for key in ["rejects", "reviews"] {
        for message in validation
            .and_then(|v| v.get(key))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            errors.push(
                message
                    .get("message")
                    .or_else(|| message.get("activityMessage"))
                    .and_then(Value::as_str)
                    .unwrap_or("Schwab order requires review")
                    .to_string(),
            );
        }
    }
    if value
        .pointer("/orderStrategy/status")
        .and_then(Value::as_str)
        == Some("REJECTED")
        && errors.is_empty()
    {
        errors.push(
            "Schwab rejected the preview without a validation message; submission is disabled".into(),
        );
    }
    OrderPreview {
        valid: errors.is_empty(),
        summary: "SCHWAB LIVE · Market entry with broker-held OCO stop and target".into(),
        estimated_commission: value
            .pointer("/orderStrategy/orderBalance/projectedCommission")
            .map(Value::to_string),
        initial_margin: value
            .pointer("/orderStrategy/orderBalance/projectedBuyingPower")
            .map(Value::to_string),
        errors,
    }
}

pub fn validate_quote(symbol: &str, quote: &Quote) -> Result<(), AppError> {
    let fail = |text: &str| AppError::Validation(text.into());
    if quote.provider != MarketDataProvider::Schwab
        || !quote.symbol.eq_ignore_ascii_case(symbol)
        || quote.delayed
        || quote.halted
        || ![quote.bid, quote.ask]
            .iter()
            .all(|p| p.is_finite() && *p > 0.0)
        || quote.ask < quote.bid
    {
        return Err(fail("Live Schwab bid and ask are required"));
    }
    let timestamp = DateTime::parse_from_rfc3339(&quote.timestamp)
        .map_err(|_| fail("Quote timestamp unavailable"))?;
    let age = Utc::now()
        .signed_duration_since(timestamp)
        .num_milliseconds();
    if !(-1_000..=5_000).contains(&age) {
        return Err(fail("Schwab quote is stale; refresh before submitting"));
    }
    Ok(())
}

pub fn validate_draft(draft: &SchwabEquityOrderDraft, quote: &Quote) -> Result<(), AppError> {
    let fail = |text: &str| AppError::Validation(text.into());
    if !matches!(draft.direction.as_str(), "Long" | "Short")
        || !matches!(draft.sizing_mode.as_str(), "risk" | "shares")
        || !matches!(draft.exit_duration.as_str(), "DAY" | "GTC")
        || draft.quantity == 0
    {
        return Err(fail(
            "Invalid equity direction, sizing, quantity, or duration",
        ));
    }
    validate_quote(&draft.symbol, quote)?;
    if ![draft.stop_loss, draft.take_profit, draft.reference_entry]
        .iter()
        .all(|p| p.is_finite() && *p > 0.0)
    {
        return Err(fail("Entry, stop and target must be positive prices"));
    }
    // The current symbol metadata advertises penny order increments. Reject
    // unsupported precision rather than changing a submitted exit price.
    for price in [draft.stop_loss, draft.take_profit] {
        if (price * 100.0 - (price * 100.0).round()).abs() > 0.000001 {
            return Err(fail("Equity exit prices must use penny increments"));
        }
    }
    let entry = if draft.direction == "Long" {
        quote.ask
    } else {
        quote.bid
    };
    if !(if draft.direction == "Long" {
        draft.stop_loss < entry && draft.take_profit > entry
    } else {
        draft.stop_loss > entry && draft.take_profit < entry
    }) {
        return Err(fail(
            "Stop or target is on the wrong side of the current entry price",
        ));
    }
    if draft.sizing_mode == "risk" {
        let budget = draft
            .risk_budget
            .filter(|v| v.is_finite() && *v > 0.0)
            .ok_or_else(|| fail("Enter a positive risk budget"))?;
        if (entry - draft.stop_loss).abs() * draft.quantity as f64 > budget + 0.0000001 {
            return Err(fail(
                "Price moved: the reviewed quantity exceeds your risk budget. Refresh the ticket",
            ));
        }
    }
    Ok(())
}

pub async fn broker_orders(
    api: &Schwab,
    path: &Path,
    account: &str,
) -> Result<Vec<OrderUpdate>, AppError> {
    let mut rows: BTreeMap<String, OrderUpdate> = api
        .open_equity_orders(account)
        .await?
        .into_iter()
        .map(|o| (o.id.clone(), o))
        .collect();
    let now = Utc::now();
    let today = api
        .orders(
            account,
            &(now - chrono::Duration::days(1)).to_rfc3339(),
            &now.to_rfc3339(),
        )
        .await?;
    for order in today.orders {
        rows.insert(order.id.clone(), order);
    }
    for (id, draft, cached) in brackets(path, account)? {
        // Terminal historical trees need no polling. Active trees always use a
        // direct lookup, independently of order-list entry-date windows.
        if !flatten(&cached, account).iter().any(active) {
            continue;
        }
        let raw = api.equity_order(account, &id).await?;
        save_bracket(path, account, &id, &draft, &raw)?;
        for order in flatten(&raw, account) {
            rows.insert(order.id.clone(), order);
        }
    }
    Ok(rows.into_values().collect())
}

fn protection_issues(positions: &[Position], orders: &[OrderUpdate]) -> Vec<String> {
    let mut issues = Vec::new();
    for position in positions
        .iter()
        .filter(|p| equity(p.asset_type.as_deref()) && p.quantity.abs() > 0.0)
    {
        let closing = if position.side == "Long" {
            "SELL"
        } else {
            "BUY_TO_COVER"
        };
        let exits: Vec<_> = orders
            .iter()
            .filter(|o| {
                o.symbol == position.symbol
                    && active(o)
                    && o.schwab.as_ref().is_some_and(|s| {
                        s.instruction == closing && !s.contingent && s.oco_order_id.is_some()
                    })
            })
            .collect();
        let protected = exits.iter().any(|stop| {
            stop.order_type == "StopMarket"
                && stop.remaining_quantity.unwrap_or(stop.quantity as f64)
                    >= position.quantity.abs()
                && exits.iter().any(|target| {
                    target.order_type == "Limit"
                        && target.remaining_quantity.unwrap_or(target.quantity as f64)
                            >= position.quantity.abs()
                        && target.schwab.as_ref().unwrap().oco_order_id
                            == stop.schwab.as_ref().unwrap().oco_order_id
                })
        });
        if !protected {
            issues.push(format!(
                "{}: broker has not confirmed a complete active stop/target bracket for {} shares",
                position.symbol,
                position.quantity.abs()
            ));
        }
        if exits.iter().any(|o| {
            (o.remaining_quantity.unwrap_or(o.quantity as f64) - position.quantity.abs()).abs()
                > 0.000001
        }) {
            issues.push(format!(
                "{}: protective quantity differs from the current position; review linked orders",
                position.symbol
            ));
        }
    }
    for order in orders.iter().filter(|o| {
        o.status == "Rejected"
            && o.schwab
                .as_ref()
                .is_some_and(|s| s.parent_order_id.is_some())
    }) {
        if positions
            .iter()
            .any(|p| p.symbol == order.symbol && p.quantity.abs() > 0.0)
        {
            issues.push(format!(
                "{}: protective order rejected: {}",
                order.symbol,
                order
                    .status_description
                    .as_deref()
                    .unwrap_or("Review Schwab order status")
            ));
        }
    }
    issues.sort();
    issues.dedup();
    issues
}

fn managed_positions(
    path: &Path,
    account: &str,
    positions: &[Position],
) -> Result<Vec<Position>, AppError> {
    let symbols = brackets(path, account)?
        .into_iter()
        .filter_map(|(_, draft, _)| draft["symbol"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    Ok(positions
        .iter()
        .filter(|p| symbols.contains(&p.symbol))
        .cloned()
        .collect())
}

async fn preflight(
    api: &Schwab,
    path: &Path,
    draft: &SchwabEquityOrderDraft,
) -> Result<Value, AppError> {
    // Independent reads can overlap. The final quote is fetched after these
    // checks so sizing is still validated immediately before submission.
    let (accounts, meta, hours, snapshot, orders) = tokio::try_join!(
        api.accounts(),
        api.symbol_details(&draft.symbol),
        api.equity_market_hours(),
        api.account_snapshot(&draft.account_id),
        broker_orders(api, path, &draft.account_id),
    )?;
    if !accounts.iter().any(|a| a.id == draft.account_id) {
        return Err(AppError::Validation(
            "Select an authorized Schwab account".into(),
        ));
    }
    if !equity(Some(&meta.asset_type)) {
        return Err(AppError::Validation(
            "Only Schwab equities and ETFs can be traded".into(),
        ));
    }
    validate_entry_state(api, path, draft, &hours, &snapshot.positions, &orders).await?;
    Ok(hours)
}

async fn revalidate_entry(
    api: &Schwab,
    path: &Path,
    draft: &SchwabEquityOrderDraft,
    hours: &Value,
) -> Result<(), AppError> {
    // Authorization and instrument metadata were checked in this same locked
    // submission. Refresh mutable broker state, then fetch the final quote.
    let (snapshot, orders) = tokio::try_join!(
        api.account_snapshot(&draft.account_id),
        broker_orders(api, path, &draft.account_id),
    )?;
    validate_entry_state(api, path, draft, hours, &snapshot.positions, &orders).await
}

async fn validate_entry_state(
    api: &Schwab,
    path: &Path,
    draft: &SchwabEquityOrderDraft,
    hours: &Value,
    positions: &[Position],
    orders: &[OrderUpdate],
) -> Result<(), AppError> {
    if !session_open(hours, Utc::now()) {
        return Err(AppError::Validation(
            "Schwab regular equity session is closed".into(),
        ));
    }
    if positions.iter().any(|p| {
        equity(p.asset_type.as_deref()) && p.symbol == draft.symbol && p.quantity.abs() > 0.0
    }) || orders
        .iter()
        .any(|o| equity(o.asset_type.as_deref()) && o.symbol == draft.symbol && active(o))
    {
        return Err(AppError::Validation(
            "This account already has shares or a pending equity order in this stock".into(),
        ));
    }
    if !protection_issues(
        &managed_positions(path, &draft.account_id, positions)?,
        orders,
    )
    .is_empty()
    {
        return Err(AppError::Validation(
            "Resolve Schwab equity protection alerts before opening another trade".into(),
        ));
    }
    let quote = api
        .quotes(&[draft.symbol.clone()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Validation("Schwab quote unavailable".into()))?;
    validate_draft(draft, &quote)?;
    // The final quote request may cross a closing boundary.
    if !session_open(hours, Utc::now()) {
        return Err(AppError::Validation("Schwab regular equity session is closed".into()));
    }
    Ok(())
}

async fn preview(api: &Schwab, payload: &Value) -> Result<OrderPreview, AppError> {
    let (value, _) = api
        .trading_request(
            Method::POST,
            &format!(
                "/accounts/{}/previewOrder",
                payload["account"].as_str().unwrap_or_default()
            ),
            Some(&preview_payload(&payload["order"])),
        )
        .await?;
    Ok(parse_preview(&value))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn preview_schwab_equity_order(
    order: SchwabEquityOrderDraft,
    state: State<'_, NativeState>,
) -> Result<OrderPreview, AppError> {
    let _session = state.schwab_trading_lifecycle.read().await;
    let _guard = state
        .safety
        .provider_account_lock("schwab", &order.account_id)
        .await;
    preflight(&state.schwab, &state.db_path, &order).await?;
    preview(
        &state.schwab,
        &json!({"account":order.account_id,"order":placement_payload(&order)}),
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_schwab_equity_state(
    account_id: String,
    state: State<'_, NativeState>,
) -> Result<EquityState, AppError> {
    let _session = state.schwab_trading_lifecycle.read().await;
    let _guard = state
        .safety
        .provider_account_lock("schwab", &account_id)
        .await;
    reconcile_account(&state.schwab, &state.db_path, &account_id).await?;
    let (snapshot, orders, hours) = tokio::join!(
        state.schwab.account_snapshot(&account_id),
        broker_orders(&state.schwab, &state.db_path, &account_id),
        state.schwab.equity_market_hours(),
    );
    let snapshot = snapshot?;
    let orders = orders?;
    let (session_open, session_message) = match hours {
        Ok(value) if session_open(&value, Utc::now()) => {
            (true, "Regular equity session open".into())
        }
        Ok(_) => (false, "Regular equity session closed".into()),
        Err(_) => (false, "Equity session status unavailable".into()),
    };
    let mut risk_baselines = Vec::new();
    let mut issues = protection_issues(
        &managed_positions(&state.db_path, &account_id, &snapshot.positions)?,
        &orders,
    );
    let mut warnings = Vec::new();
    let mut seen = HashSet::new();
    let mut tracked = brackets(&state.db_path, &account_id)?;
    tracked.sort_by(|a, b| {
        b.2["enteredTime"]
            .as_str()
            .cmp(&a.2["enteredTime"].as_str())
            .then_with(|| {
                b.0.parse::<u64>()
                    .unwrap_or(0)
                    .cmp(&a.0.parse::<u64>().unwrap_or(0))
            })
    });
    for (id, draft, raw) in tracked {
        let Ok(draft) = serde_json::from_value::<SchwabEquityOrderDraft>(draft) else {
            continue;
        };
        let root = flatten(&raw, &account_id)
            .into_iter()
            .find(|o| o.broker_order_id.as_deref() == Some(id.as_str()));
        if let Some(position) = snapshot.positions.iter().find(|p| {
            p.symbol == draft.symbol && p.side == draft.direction && equity(p.asset_type.as_deref())
        }) {
            if let Some(root) = root.filter(|o| {
                o.filled_quantity.unwrap_or(0.0) > 0.0
                    && o.order_type == "Market"
                    && o.schwab
                        .as_ref()
                        .is_some_and(|s| s.instruction == "BUY" || s.instruction == "SELL_SHORT")
            }) {
                if !seen.insert((draft.symbol.clone(), draft.direction.clone())) {
                    continue;
                }
                let filled = root.filled_quantity.unwrap();
                let entry = root.average_fill_price.unwrap_or(position.average_price);
                risk_baselines.push(json!({"symbol":draft.symbol,"direction":draft.direction,"originalStop":draft.stop_loss,
                    "originalTarget":draft.take_profit,"deployedRisk":(entry-draft.stop_loss).abs()*filled,"tradeId":format!("schwab:{account_id}:{id}"),"riskProvenance":"exact"}));
                if (position.quantity.abs() - filled).abs() > 0.000001
                    && !orders.iter().any(|o| {
                        o.symbol == draft.symbol
                            && o.filled_quantity.unwrap_or(0.0) > 0.0
                            && o.schwab.as_ref().is_some_and(|s| s.oco_order_id.is_some())
                    })
                {
                    issues.push(format!("{}: position quantity changed outside its tracked bracket; review protection",draft.symbol));
                }
                if draft.sizing_mode == "risk"
                    && draft.risk_budget.is_some_and(|budget| {
                        (entry - draft.stop_loss).abs() * filled > budget + 0.005
                    })
                {
                    warnings.push(format!(
                        "{}: initial fill risk is ${:.2}, above the ${:.2} budget due to slippage",
                        draft.symbol,
                        (entry - draft.stop_loss).abs() * filled,
                        draft.risk_budget.unwrap()
                    ));
                }
            }
        }
    }
    let mutations = safety::list_provider_intents(&state.db_path, "schwab", &account_id)?;
    for intent in mutations
        .iter()
        .filter(|i| i.state.blocks_equivalent_retry() || i.manual_review_required)
    {
        issues.push(format!(
            "Schwab {}: {}",
            intent.symbol.as_deref().unwrap_or("order"),
            intent
                .warning
                .as_deref()
                .unwrap_or("Order outcome unresolved; do not retry")
        ));
    }
    Ok(EquityState {
        session_open,
        session_message,
        positions: snapshot.positions,
        orders,
        risk_baselines,
        issues,
        warnings,
        mutations,
    })
}

fn location_id(location: Option<String>) -> Result<String, AppError> {
    let id = location
        .and_then(|v| {
            v.trim_end_matches('/')
                .rsplit('/')
                .next()
                .map(str::to_owned)
        })
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()));
    id.ok_or_else(|| {
        AppError::AmbiguousBrokerOutcome(
            "Schwab accepted the request without an order Location; reconcile before retrying"
                .into(),
        )
    })
}

async fn submit(
    api: &Schwab,
    account: &str,
    payload: &Value,
    replace: Option<&str>,
) -> Result<(String, Value), AppError> {
    let path = match replace {
        Some(id) => format!("/accounts/{account}/orders/{id}"),
        None => format!("/accounts/{account}/orders"),
    };
    let (_, location) = api
        .trading_request(
            if replace.is_some() {
                Method::PUT
            } else {
                Method::POST
            },
            &path,
            Some(payload),
        )
        .await?;
    let id = location_id(location)?;
    // Keep an accepted broker ID durable even if its immediate GET is delayed.
    Ok((id.clone(), json!({"orderId":id,"pendingFetch":true})))
}

fn intent_result(intent: &safety::MutationIntent) -> Result<BrokerMutationResult, AppError> {
    crate::mutation_result_from_intent(intent)
}

async fn mutate(
    state: &NativeState,
    app: &tauri::AppHandle,
    account: &str,
    mutation_id: String,
    kind: &str,
    symbol: &str,
    request: Value,
) -> Result<BrokerMutationResult, AppError> {
    if mutation_id.trim().is_empty() {
        return Err(AppError::Validation(
            "A stable mutation ID is required".into(),
        ));
    }
    let _session = state.schwab_trading_lifecycle.read().await;
    let _guard = state.safety.provider_account_lock("schwab", account).await;
    // Entry authorization is part of preflight below. Management actions also
    // need this check because they do not use the entry preflight.
    if kind != "schwab_place" && !state
        .schwab
        .accounts()
        .await?
        .iter()
        .any(|a| a.id == account)
    {
        return Err(AppError::Validation(
            "Select an authorized Schwab account".into(),
        ));
    }
    // Any unresolved account write blocks new writes, including a close which
    // might otherwise race an accepted-but-unobserved protective replacement.
    reconcile_account(&state.schwab, &state.db_path, account).await?;
    for existing in safety::list_provider_intents(&state.db_path, "schwab", account)? {
        if existing.id == mutation_id {
            return intent_result(&existing);
        }
        if existing.state.blocks_equivalent_retry() || existing.manual_review_required {
            return Err(AppError::Validation(
                "Schwab has an unresolved mutation; reconcile it before another action".into(),
            ));
        }
    }
    let target = request
        .get("orderId")
        .or_else(|| request.get("positionId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let created = safety::create_intent(
        &state.db_path,
        safety::NewMutationIntent {
            provider: MarketDataProvider::Schwab,
            id: mutation_id.clone(),
            environment: TradingEnvironment::Live,
            account_id: account.into(),
            kind: kind.into(),
            equivalence_key: format!(
                "schwab|{kind}|{symbol}|{}",
                target.as_deref().unwrap_or("entry")
            ),
            symbol: Some(symbol.into()),
            action: kind.into(),
            quantity: request.get("quantity").and_then(Value::as_f64),
            order_type: Some("Market".into()),
            limit_price: None,
            stop_price: None,
            take_profit: request.get("takeProfit").and_then(Value::as_f64),
            stop_loss: request.get("stopLoss").and_then(Value::as_f64),
            target_id: target,
            request: request.clone(),
        },
    )?;
    match created {
        safety::CreateIntent::Existing(i) | safety::CreateIntent::EquivalentBlocked(i) => {
            return intent_result(&i)
        }
        _ => {}
    }
    // Preflight is read-only. Failures here definitively mean no order was sent.
    let preparation = prepare(&state.schwab, &state.db_path, account, kind, &request).await;
    let prepared = match preparation {
        Ok(value) => value,
        Err(error) => {
            safety::update_intent(
                &state.db_path,
                &mutation_id,
                safety::MutationState::Rejected,
                None,
                None,
                "complete",
                "not_required",
                None,
                Some(&error.to_string()),
                false,
            )?;
            return intent_result(&safety::load_intent(&state.db_path, &mutation_id)?.unwrap());
        }
    };
    save_prepared(&state.db_path, &mutation_id, &request, &prepared)?;
    safety::update_intent(
        &state.db_path,
        &mutation_id,
        safety::MutationState::Submitting,
        None,
        None,
        "complete",
        "required",
        None,
        None,
        false,
    )?;
    let outcome = execute(
        &state.schwab,
        &state.db_path,
        account,
        kind,
        &request,
        &prepared,
        &mutation_id,
    )
    .await;
    match outcome {
        Ok((order, local_warning, confirmed_orders)) => {
            let object = serde_json::to_value(&order)?;
            let persistence = safety::record_confirmed(
                &state.db_path,
                &mutation_id,
                order.broker_order_id.as_deref(),
                &object,
                local_warning,
            );
            // Publish the broker's entire returned tree immediately. Waiting for
            // the next account snapshot hides working OCO children after a fill.
            for confirmed in confirmed_orders {
                let _ = app.emit("order-stream-update", OrderStreamUpdateEvent {
                    provider: MarketDataProvider::Schwab,
                    account_id: account.into(),
                    environment_generation: state.safety.lifecycle.generation(),
                    order: confirmed,
                });
            }
            let _ = app.emit(
                "broker-mutation-updated",
                json!({"provider":"schwab","accountId":account,"mutationId":mutation_id}),
            );
            return Ok(BrokerMutationResult {
                mutation_id,
                broker_outcome: BrokerOutcome::Confirmed,
                local_persistence: if persistence.warnings.is_empty() {
                    LocalPersistenceStatus::Complete
                } else {
                    LocalPersistenceStatus::Pending
                },
                reconciliation_status: if persistence.warnings.is_empty() {
                    ReconciliationStatus::NotRequired
                } else {
                    ReconciliationStatus::Required
                },
                warnings: persistence.warnings,
                broker_order: Some(order),
                close_result: None,
                rejection_reason: None,
                retry_blocked: true,
            });
        }
        Err(AppError::BrokerRejected(message)) => {
            safety::update_intent(
                &state.db_path,
                &mutation_id,
                safety::MutationState::Rejected,
                None,
                None,
                "complete",
                "not_required",
                None,
                Some(&message),
                false,
            )?;
        }
        Err(error) => {
            let warning = format!(
                "Schwab outcome unknown: {error}. Do not retry; awaiting broker reconciliation"
            );
            safety::update_intent(
                &state.db_path,
                &mutation_id,
                safety::MutationState::Unknown,
                None,
                None,
                "complete",
                "required",
                Some(&warning),
                Some(&error.to_string()),
                true,
            )?;
        }
    }
    let _ = app.emit(
        "broker-mutation-updated",
        json!({"provider":"schwab","accountId":account,"mutationId":mutation_id}),
    );
    intent_result(&safety::load_intent(&state.db_path, &mutation_id)?.unwrap())
}

async fn prepare(
    api: &Schwab,
    path: &Path,
    account: &str,
    kind: &str,
    request: &Value,
) -> Result<Value, AppError> {
    if kind == "schwab_place" {
        let draft: SchwabEquityOrderDraft = serde_json::from_value(request.clone())?;
        let hours = preflight(api, path, &draft).await?;
        let payload = placement_payload(&draft);
        let result = preview(api, &json!({"account":account,"order":payload})).await?;
        if !result.valid {
            return Err(AppError::Validation(result.errors.join("; ")));
        }
        // Preview can invalidate quotes or holdings. Recheck those immediately
        // before writing, using the session boundaries fetched this attempt.
        revalidate_entry(api, path, &draft, &hours).await?;
        return Ok(payload);
    }
    let orders = broker_orders(api, path, account).await?;
    if kind == "schwab_close" {
        if !session_open(&api.equity_market_hours().await?, Utc::now()) {
            return Err(AppError::Validation(
                "Market closes are available during regular equity hours".into(),
            ));
        }
        let snapshot = api.account_snapshot(account).await?;
        let id = request["positionId"].as_str().unwrap_or_default();
        let position = snapshot
            .positions
            .into_iter()
            .find(|p| p.id == id && equity(p.asset_type.as_deref()) && p.quantity.abs() > 0.0)
            .ok_or_else(|| AppError::Validation("Equity position is no longer open".into()))?;
        if position.quantity.fract().abs() > 0.000001 {
            return Err(AppError::Validation(
                "Fractional equity positions must be closed through Schwab".into(),
            ));
        }
        let targets: HashSet<_> = orders
            .iter()
            .filter(|o| o.symbol == position.symbol && equity(o.asset_type.as_deref()) && active(o))
            .filter_map(|o| {
                o.schwab.as_ref().map(|s| {
                    s.oco_order_id
                        .clone()
                        .unwrap_or_else(|| s.root_order_id.clone())
                })
            })
            .collect();
        return Ok(
            json!({"symbol":position.symbol,"cancelIds":targets,"positionId":position.id,"quantity":position.quantity.abs(),"side":position.side,"fills":orders.iter().filter(|o| o.symbol == position.symbol).map(|o| (o.id.clone(),json!(o.filled_quantity.unwrap_or(0.0)))).collect::<BTreeMap<_,_>>()}),
        );
    }
    let id = request["orderId"].as_str().unwrap_or_default();
    let order = orders
        .iter()
        .find(|o| {
            o.id == id
                && request["symbol"].as_str() == Some(o.symbol.as_str())
                && equity(o.asset_type.as_deref())
                && active(o)
        })
        .ok_or_else(|| AppError::Validation("Active Schwab equity order was not found".into()))?;
    let details = order
        .schwab
        .as_ref()
        .ok_or_else(|| AppError::Validation("Schwab order relationships unavailable".into()))?;
    if !details.cancelable {
        return Err(AppError::Validation(
            "Schwab order cannot currently be canceled or replaced".into(),
        ));
    }
    let target = details
        .oco_order_id
        .as_ref()
        .unwrap_or(&details.root_order_id);
    if kind == "schwab_cancel" {
        let target = if details.contingent {
            &details.root_order_id
        } else {
            target
        };
        return Ok(json!({"cancelId":target,"rootId":details.root_order_id}));
    }
    if !details.editable || details.contingent || details.oco_order_id.is_none() {
        return Err(AppError::Validation(
            "Only active editable OCO exits can be moved".into(),
        ));
    }
    let price = request["newPrice"]
        .as_f64()
        .filter(|p| p.is_finite() && *p > 0.0 && (p * 100.0 - (p * 100.0).round()).abs() < 0.000001)
        .ok_or_else(|| AppError::Validation("Invalid equity exit price".into()))?;
    let raw = api.equity_order(account, target).await?;
    let mut payload = replacement_payload(
        &raw,
        order.broker_order_id.as_deref().unwrap_or_default(),
        price,
    )?;
    let snapshot = api.account_snapshot(account).await?;
    let position = snapshot
        .positions
        .iter()
        .find(|p| {
            p.symbol == order.symbol && equity(p.asset_type.as_deref()) && p.quantity.abs() > 0.0
        })
        .ok_or_else(|| AppError::Validation("Position no longer open".into()))?;
    let quote = api
        .quotes(&[order.symbol.clone()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Validation("Quote unavailable".into()))?;
    validate_quote(&order.symbol, &quote)?;
    let reference = if position.side == "Long" {
        quote.bid
    } else {
        quote.ask
    };
    if reference <= 0.0
        || quote.delayed
        || quote.halted
        || (order.order_type == "StopMarket"
            && (if position.side == "Long" {
                price >= reference
            } else {
                price <= reference
            }))
        || (order.order_type == "Limit"
            && (if position.side == "Long" {
                price <= reference
            } else {
                price >= reference
            }))
    {
        return Err(AppError::Validation(
            "Exit price must remain on its protective/profit side of the market".into(),
        ));
    }
    if let Some(children) = payload["childOrderStrategies"].as_array_mut() {
        for child in children {
            for leg in child["orderLegCollection"]
                .as_array_mut()
                .into_iter()
                .flatten()
            {
                leg["quantity"] = json!(position.quantity.abs());
            }
        }
    }
    Ok(
        json!({"replaceId":target,"rootId":details.root_order_id,"order":payload,"type":order.order_type,"symbol":order.symbol}),
    )
}

pub fn replacement_payload(raw: &Value, selected: &str, price: f64) -> Result<Value, AppError> {
    if raw["orderStrategyType"] != "OCO" {
        return Err(AppError::Validation(
            "Schwab did not return the linked OCO group; replacement blocked".into(),
        ));
    }
    let children = raw["childOrderStrategies"]
        .as_array()
        .filter(|c| c.len() == 2)
        .ok_or_else(|| AppError::Validation("Incomplete OCO group".into()))?;
    let mut found = false;
    let children: Vec<_> = children.iter().map(|child| {
        let mut order=json!({"session":child["session"],"duration":schwab_duration(child["duration"].as_str().unwrap_or_default()),"orderType":child["orderType"],"orderStrategyType":"SINGLE",
            "orderLegCollection":child["orderLegCollection"].as_array().into_iter().flatten().map(|leg|json!({"instruction":leg["instruction"],"quantity":leg["quantity"],"instrument":{"symbol":leg["instrument"]["symbol"],"assetType":"EQUITY"}})).collect::<Vec<_>>()});
        let is_selected = child["orderId"].as_u64().map(|id| id.to_string()).or_else(||child["orderId"].as_str().map(str::to_owned)).as_deref()==Some(selected);
        if is_selected {found=true;}
        let field=if child["orderType"]=="STOP" {"stopPrice"} else {"price"};
        order[field]=if is_selected {json!(price)} else {child[field].clone()}; order
    }).collect();
    if !found {
        return Err(AppError::Validation(
            "Selected exit is no longer in the OCO group".into(),
        ));
    }
    Ok(json!({"orderStrategyType":"OCO","childOrderStrategies":children}))
}

async fn cancel_confirmed(api: &Schwab, account: &str, id: &str) -> Result<(), AppError> {
    let before = api.equity_order(account, id).await.map_err(|_| {
        AppError::BrokerRejected(
            "Could not inspect linked orders; cancellation was not sent".into(),
        )
    })?;
    if !flatten(&before, account).iter().any(active) {
        return Ok(());
    }
    api.trading_request(
        Method::DELETE,
        &format!("/accounts/{account}/orders/{id}"),
        None,
    )
    .await?;
    for _ in 0..10 {
        let raw = api.equity_order(account, id).await?;
        if !flatten(&raw, account).iter().any(active) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err(AppError::AmbiguousBrokerOutcome(
        "Cancellation not yet terminal; no closing order was submitted".into(),
    ))
}

fn pending_order(payload: &Value, id: &str, account: &str) -> Result<OrderUpdate, AppError> {
    let mut raw = payload.clone();
    raw["orderId"] = json!(id);
    raw["status"] = json!("PENDING_ACKNOWLEDGEMENT");
    raw["enteredTime"] = json!(Utc::now().to_rfc3339());
    // Only a broker-confirmed tree can supply actionable child order IDs.
    if let Some(object) = raw.as_object_mut() {
        object.remove("childOrderStrategies");
    }
    flatten(&raw, account).into_iter().next().ok_or_else(|| {
        AppError::AmbiguousBrokerOutcome("Accepted group is awaiting broker order details".into())
    })
}

async fn execute(
    api: &Schwab,
    path: &Path,
    account: &str,
    kind: &str,
    request: &Value,
    prepared: &Value,
    mutation: &str,
) -> Result<(OrderUpdate, Option<String>, Vec<OrderUpdate>), AppError> {
    if kind == "schwab_cancel" {
        let id = prepared["cancelId"].as_str().unwrap();
        safety::update_intent(
            path,
            mutation,
            safety::MutationState::Submitting,
            Some(id),
            None,
            "complete",
            "required",
            None,
            None,
            false,
        )?;
        cancel_confirmed(api, account, id).await?;
        let rows = flatten(&api.equity_order(account, id).await?, account);
        return rows.first().cloned()
            .map(|order| (order, None, rows))
            .ok_or_else(|| {
                AppError::AmbiguousBrokerOutcome("Canceled group has no order legs".into())
            });
    }
    let mut payload = prepared.clone();
    let mut replace = None;
    if kind == "schwab_close" {
        for id in prepared["cancelIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            cancel_confirmed(api, account, id).await?;
        }
        let orders = broker_orders(api, path, account).await?;
        let snapshot = api.account_snapshot(account).await?;
        let position = snapshot
            .positions
            .into_iter()
            .find(|p| {
                Some(p.id.as_str()) == prepared["positionId"].as_str() && p.quantity.abs() > 0.0
            })
            .ok_or_else(|| {
                AppError::BrokerRejected(
                    "Position was closed by a protective exit; no additional close submitted"
                        .into(),
                )
            })?;
        if orders
            .iter()
            .any(|o| o.symbol == position.symbol && equity(o.asset_type.as_deref()) && active(o))
        {
            return Err(AppError::AmbiguousBrokerOutcome(
                "Equity orders remain active; close paused".into(),
            ));
        }
        if orders
            .iter()
            .filter(|o| o.symbol == position.symbol)
            .any(|o| {
                prepared["fills"][&o.id].as_f64().unwrap_or(0.0) != o.filled_quantity.unwrap_or(0.0)
            })
            || Some(position.quantity.abs()) != prepared["quantity"].as_f64()
            || Some(position.side.as_str()) != prepared["side"].as_str()
        {
            return Err(AppError::BrokerRejected("Position or fills changed during cancellation; refresh and review the remaining shares before closing".into()));
        }
        if position.quantity.fract().abs() > 0.000001 {
            return Err(AppError::BrokerRejected(
                "Position now has fractional shares; use Schwab to close".into(),
            ));
        }
        if !session_open(&api.equity_market_hours().await?, Utc::now()) {
            return Err(AppError::BrokerRejected(
                "Regular session ended; no market close submitted".into(),
            ));
        }
        payload = json!({"session":"NORMAL","duration":"DAY","orderType":"MARKET","orderStrategyType":"SINGLE","orderLegCollection":[{
            "instruction":if position.side=="Long" {"SELL"} else {"BUY_TO_COVER"},"quantity":position.quantity.abs(),"instrument":{"symbol":position.symbol,"assetType":"EQUITY"}}]});
    } else if kind == "schwab_replace" {
        payload = prepared["order"].clone();
        replace = prepared["replaceId"].as_str();
    }
    let mut durable_request = request.clone();
    durable_request["_submissionStarted"] = json!(true);
    save_prepared(path, mutation, &durable_request, prepared)?;
    let (id, pending) = submit(api, account, &payload, replace).await?;
    let mut warnings = Vec::new();
    if let Err(error) = safety::update_intent(
        path,
        mutation,
        safety::MutationState::Submitting,
        Some(&id),
        Some(&pending),
        "complete",
        "required",
        None,
        None,
        false,
    ) {
        warnings.push(format!(
            "Accepted order {id}; broker ID persistence pending: {error}"
        ));
    }
    let raw = match api.equity_order(account, &id).await {
        Ok(raw) => raw,
        Err(_) => {
            warnings.push(format!("Order {id} accepted; waiting for broker details"));
            let mut raw = payload.clone();
            raw["orderId"] = json!(id);
            raw["status"] = json!("PENDING_ACKNOWLEDGEMENT");
            raw["enteredTime"] = json!(Utc::now().to_rfc3339());
            if let Some(object) = raw.as_object_mut() {
                object.remove("childOrderStrategies");
            }
            raw
        }
    };
    if kind == "schwab_place" {
        if let Err(error) = save_bracket(path, account, &id, request, &raw) {
            warnings.push(format!("Bracket tracking pending: {error}"));
        }
    }
    if kind == "schwab_replace" {
        match brackets(path, account) {
            Ok(records) => {
                for (root, draft, _) in records {
                    if Some(root.as_str()) == prepared["rootId"].as_str() {
                        if let Err(error) = save_bracket(path, account, &id, &draft, &raw) {
                            warnings.push(format!("Replacement tracking pending: {error}"));
                        }
                    }
                }
            }
            Err(error) => warnings.push(format!("Replacement tracking pending: {error}")),
        }
    }
    let rows = flatten(&raw, account);
    let order = rows.iter().cloned()
        .find(|o| {
            kind != "schwab_replace" || Some(o.order_type.as_str()) == prepared["type"].as_str()
        })
        .or_else(|| {
            pending_order(
                if kind == "schwab_replace" {
                    &payload["childOrderStrategies"][0]
                } else {
                    &payload
                },
                &id,
                account,
            )
            .ok()
        })
        .ok_or_else(|| {
            AppError::AmbiguousBrokerOutcome(format!("Accepted group {id} awaiting order details"))
        })?;
    Ok((
        order,
        if warnings.is_empty() {
            None
        } else {
            Some(warnings.join("; "))
        },
        rows,
    ))
}

pub async fn reconcile_account(api: &Schwab, path: &Path, account: &str) -> Result<(), AppError> {
    for intent in safety::list_provider_intents(path, "schwab", account)?
        .into_iter()
        .filter(|i| {
            matches!(
                i.state,
                safety::MutationState::Requested
                    | safety::MutationState::Submitting
                    | safety::MutationState::Unknown
                    | safety::MutationState::Reconciling
                    | safety::MutationState::ReconciliationFailed
            ) || i.local_persistence != "complete"
        })
    {
        if intent.state == safety::MutationState::Requested {
            safety::update_intent(
                path,
                &intent.id,
                safety::MutationState::Rejected,
                None,
                None,
                "complete",
                "not_required",
                None,
                Some("Interrupted before any broker write was attempted"),
                false,
            )?;
            continue;
        }
        if let Some(id) = intent.broker_id.as_deref() {
            let raw = api.equity_order(account, id).await?;
            let rows = flatten(&raw, account);
            if intent.kind == "schwab_cancel" && rows.iter().any(active) {
                continue;
            }
            if let Some(order) = rows.into_iter().next() {
                if intent.kind == "schwab_place" {
                    save_bracket(path, account, id, &intent.request, &raw)?;
                }
                if intent.kind == "schwab_replace" {
                    for (root, draft, _) in brackets(path, account)? {
                        if Some(root.as_str())
                            == intent
                                .request
                                .pointer("/_prepared/rootId")
                                .and_then(Value::as_str)
                        {
                            save_bracket(path, account, id, &draft, &raw)?;
                        }
                    }
                }
                safety::update_intent(
                    path,
                    &intent.id,
                    safety::MutationState::Reconciled,
                    Some(id),
                    Some(&serde_json::to_value(order)?),
                    "complete",
                    "reconciled",
                    None,
                    None,
                    false,
                )?;
            }
        } else if intent.kind == "schwab_close"
            && intent
                .request
                .get("_submissionStarted")
                .and_then(Value::as_bool)
                != Some(true)
        {
            // No market close POST was attempted. Complete canceled exits first;
            // then permit the user to review a new close against current holdings.
            let mut terminal = true;
            for id in intent
                .request
                .pointer("/_prepared/cancelIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if flatten(&api.equity_order(account, id).await?, account)
                    .iter()
                    .any(active)
                {
                    terminal = false;
                }
            }
            if terminal {
                safety::update_intent(path,&intent.id,safety::MutationState::Rejected,None,None,"complete","reconciled",None,Some("No market close was submitted. Cancellations settled; review the remaining position"),false)?;
            }
        } else if intent.state == safety::MutationState::Submitting {
            safety::update_intent(
                path,
                &intent.id,
                safety::MutationState::Unknown,
                None,
                None,
                "complete",
                "required",
                Some("Interrupted Schwab write requires a broker order match; do not retry"),
                None,
                true,
            )?;
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn reconcile_schwab_equity_mutation(
    account_id: String,
    mutation_id: String,
    broker_order_id: String,
    state: State<'_, NativeState>,
) -> Result<(), AppError> {
    let _session = state.schwab_trading_lifecycle.read().await;
    let _guard = state
        .safety
        .provider_account_lock("schwab", &account_id)
        .await;
    let intent = safety::load_intent(&state.db_path, &mutation_id)?
        .filter(|i| i.provider == MarketDataProvider::Schwab && i.account_id == account_id)
        .ok_or_else(|| AppError::Validation("Schwab mutation not found for this account".into()))?;
    if !(intent.state.blocks_equivalent_retry() || intent.manual_review_required) {
        return Err(AppError::Validation(
            "Mutation does not require recovery".into(),
        ));
    }
    let raw = state
        .schwab
        .equity_order(&account_id, &broker_order_id)
        .await?;
    let rows = flatten(&raw, &account_id);
    let candidate = rows
        .iter()
        .find(|o| {
            Some(o.symbol.as_str()) == intent.symbol.as_deref() && equity(o.asset_type.as_deref())
        })
        .ok_or_else(|| {
            AppError::Validation("Broker order does not match the requested equity symbol".into())
        })?;
    let start = DateTime::parse_from_rfc3339(&intent.created_at)
        .map_err(|_| AppError::Validation("Mutation time unavailable".into()))?;
    let entered = DateTime::parse_from_rfc3339(&candidate.timestamp)
        .map_err(|_| AppError::Validation("Broker order time unavailable".into()))?;
    if (entered - start).num_seconds().abs() > 600 {
        return Err(AppError::Validation(
            "Broker order entry time does not match this request".into(),
        ));
    }
    if intent.kind == "schwab_place" {
        let draft: SchwabEquityOrderDraft = serde_json::from_value(intent.request.clone())?;
        let expected = if draft.direction == "Long" {
            "BUY"
        } else {
            "SELL_SHORT"
        };
        if candidate.quantity != draft.quantity
            || !candidate
                .schwab
                .as_ref()
                .is_some_and(|s| s.instruction == expected)
        {
            return Err(AppError::Validation(
                "Broker order direction or quantity does not match the entry".into(),
            ));
        }
    } else if intent.kind == "schwab_replace" {
        let expected = intent.request["newPrice"].as_f64();
        if !rows.iter().any(|o| {
            o.price.or(o.stop_price) == expected
                && o.schwab.as_ref().is_some_and(|s| s.oco_order_id.is_some())
        }) {
            return Err(AppError::Validation(
                "Replacement price or OCO relationship does not match".into(),
            ));
        }
    } else if intent.kind == "schwab_cancel" {
        if Some(broker_order_id.as_str())
            != intent
                .request
                .pointer("/_prepared/cancelId")
                .and_then(Value::as_str)
            || rows.iter().any(active)
        {
            return Err(AppError::Validation(
                "The original canceled group is not terminal".into(),
            ));
        }
    } else if intent.kind == "schwab_close"
        && !candidate
            .schwab
            .as_ref()
            .is_some_and(|s| s.instruction == "SELL" || s.instruction == "BUY_TO_COVER")
    {
        return Err(AppError::Validation(
            "Broker order is not a closing equity order".into(),
        ));
    }
    safety::update_intent(
        &state.db_path,
        &mutation_id,
        safety::MutationState::Reconciling,
        Some(&broker_order_id),
        None,
        "complete",
        "required",
        None,
        None,
        false,
    )?;
    reconcile_account(&state.schwab, &state.db_path, &account_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn place_schwab_equity_order(
    order: SchwabEquityOrderDraft,
    client_mutation_id: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<BrokerMutationResult, AppError> {
    mutate(
        &state,
        &app,
        &order.account_id,
        client_mutation_id,
        "schwab_place",
        &order.symbol,
        serde_json::to_value(&order)?,
    )
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn replace_schwab_equity_order(
    account_id: String,
    order_id: String,
    symbol: String,
    new_price: f64,
    client_mutation_id: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<BrokerMutationResult, AppError> {
    mutate(
        &state,
        &app,
        &account_id,
        client_mutation_id,
        "schwab_replace",
        &symbol,
        json!({"orderId":order_id,"symbol":symbol,"newPrice":new_price}),
    )
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_schwab_equity_order(
    account_id: String,
    order_id: String,
    symbol: String,
    client_mutation_id: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<BrokerMutationResult, AppError> {
    mutate(
        &state,
        &app,
        &account_id,
        client_mutation_id,
        "schwab_cancel",
        &symbol,
        json!({"orderId":order_id,"symbol":symbol}),
    )
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn close_schwab_equity_position(
    account_id: String,
    position_id: String,
    symbol: String,
    client_mutation_id: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<BrokerMutationResult, AppError> {
    mutate(
        &state,
        &app,
        &account_id,
        client_mutation_id,
        "schwab_close",
        &symbol,
        json!({"positionId":position_id,"symbol":symbol}),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn database() -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("schwab-equity-{}.sqlite", uuid::Uuid::new_v4()));
        safety::init(&path).unwrap();
        init(&path).unwrap();
        path
    }

    #[test]
    fn filled_etf_brackets_retain_actionable_exits_and_protection_checks() {
        let raw: Value = serde_json::from_str(include_str!("../tests/fixtures/schwab_filled_etf_bracket.json")).unwrap();
        let rows = flatten(&raw, "hash");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].average_fill_price, Some(765.0));
        for exit in &rows[1..] {
            assert!(equity(exit.asset_type.as_deref()));
            assert_eq!(exit.status, "Working");
            assert_eq!(exit.open_or_close.as_deref(), Some("Close"));
            let details = exit.schwab.as_ref().unwrap();
            assert_eq!(details.root_order_id, "100");
            assert_eq!(details.oco_order_id.as_deref(), Some("101"));
            assert!(details.editable && details.cancelable && !details.contingent);
        }
        let position: Position = serde_json::from_value(json!({"provider":"schwab","accountId":"hash","id":"p","symbol":"SPY","side":"Long","quantity":1,"averagePrice":765,"last":765,"unrealizedPnl":0,"assetType":"COLLECTIVE_INVESTMENT"})).unwrap();
        assert!(protection_issues(&[position.clone()], &rows).is_empty());
        assert!(!protection_issues(&[Position { quantity: 2.0, ..position }], &rows).is_empty());
        let replacement = replacement_payload(&raw["childOrderStrategies"][0], "102", 764.0).unwrap();
        assert_eq!(replacement["childOrderStrategies"][0]["orderLegCollection"][0]["instrument"]["assetType"], "EQUITY");
    }

    #[tokio::test]
    async fn accepted_etf_entry_returns_all_confirmed_children_without_history_scan() {
        let path = database();
        let raw: Value = serde_json::from_str(include_str!("../tests/fixtures/schwab_filled_etf_bracket.json")).unwrap();
        let mut draft = draft();
        draft.symbol = "SPY".into();
        draft.quantity = 1;
        draft.stop_loss = 763.25;
        draft.take_profit = 767.58;
        let request = serde_json::to_value(&draft).unwrap();
        mutation(&path, "place", "schwab_place", request.clone(), None);
        let (api, requests, task) = server(vec![
            (201, Value::Null, Some("/orders/100")), (200, raw, None),
        ]).await;
        let (order, warning, rows) = execute(&api, &path, "hash", "schwab_place", &request, &placement_payload(&draft), "place").await.unwrap();
        assert_eq!(order.status, "Filled");
        assert!(warning.is_none());
        assert_eq!(rows.len(), 3);
        assert_eq!(rows.iter().filter(|o| active(o)).count(), 2);
        task.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
        std::fs::remove_file(path).ok();
    }

    #[tokio::test]
    async fn restart_refresh_recovers_older_gtc_orders_by_persisted_root() {
        let path = database();
        let mut raw = order_tree("WORKING");
        raw["enteredTime"] = json!((Utc::now() - chrono::Duration::days(90)).to_rfc3339());
        save_bracket(
            &path,
            "hash",
            "123",
            &serde_json::to_value(draft()).unwrap(),
            &raw,
        )
        .unwrap();
        // A new client represents a restart. No order appears in the list query;
        // persisted roots still get an authoritative individual-order lookup.
        let mut replies = vec![(200, json!([]), None); 2];
        replies.push((200, raw, None));
        let (api, requests, task) = server(replies).await;
        let rows = broker_orders(&api, &path, "hash").await.unwrap();
        assert!(rows
            .iter()
            .any(|o| o.broker_order_id.as_deref() == Some("126") && o.status == "Working"));
        task.await.unwrap();
        assert!(requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .starts_with("GET /accounts/hash/orders/123 "));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn existing_unmanaged_holdings_do_not_require_brackets_for_new_symbols() {
        let path = database();
        let p:Position=serde_json::from_value(json!({"provider":"schwab","accountId":"hash","id":"p","symbol":"AAPL","side":"Long","quantity":20,"averagePrice":200,"last":200,"unrealizedPnl":0,"assetType":"EQUITY"})).unwrap();
        assert!(managed_positions(&path, "hash", &[p.clone()])
            .unwrap()
            .is_empty());
        save_bracket(
            &path,
            "hash",
            "123",
            &serde_json::to_value(draft()).unwrap(),
            &order_tree("WORKING"),
        )
        .unwrap();
        assert_eq!(managed_positions(&path, "hash", &[p]).unwrap().len(), 1);
        std::fs::remove_file(path).ok();
    }
    fn mutation(path: &Path, id: &str, kind: &str, request: Value, broker: Option<&str>) {
        safety::create_intent(
            path,
            safety::NewMutationIntent {
                provider: MarketDataProvider::Schwab,
                id: id.into(),
                environment: TradingEnvironment::Live,
                account_id: "hash".into(),
                kind: kind.into(),
                equivalence_key: id.into(),
                symbol: Some("AAPL".into()),
                action: kind.into(),
                quantity: Some(50.0),
                order_type: Some("Market".into()),
                limit_price: None,
                stop_price: None,
                take_profit: Some(203.0),
                stop_loss: Some(198.0),
                target_id: None,
                request,
            },
        )
        .unwrap();
        safety::update_intent(
            path,
            id,
            safety::MutationState::Unknown,
            broker,
            None,
            "complete",
            "required",
            Some("fixture uncertainty"),
            None,
            true,
        )
        .unwrap();
    }
    fn order_tree(status: &str) -> Value {
        json!({"orderId":123,"orderStrategyType":"TRIGGER","orderType":"MARKET","status":"FILLED","quantity":50,"filledQuantity":50,
            "orderLegCollection":[{"legId":1,"instruction":"BUY","quantity":50,"instrument":{"symbol":"AAPL","assetType":"EQUITY"}}],
            "childOrderStrategies":[{"orderId":124,"orderStrategyType":"OCO","childOrderStrategies":[
                {"orderId":125,"orderStrategyType":"SINGLE","orderType":"LIMIT","session":"NORMAL","duration":"GOOD_TILL_CANCEL","price":203,"status":status,"cancelable":true,"editable":true,
                    "orderLegCollection":[{"legId":1,"instruction":"SELL","quantity":50,"instrument":{"symbol":"AAPL","assetType":"EQUITY"}}]},
                {"orderId":126,"orderStrategyType":"SINGLE","orderType":"STOP","session":"NORMAL","duration":"GOOD_TILL_CANCEL","stopPrice":198,"status":status,"cancelable":true,"editable":true,
                    "orderLegCollection":[{"legId":1,"instruction":"SELL","quantity":50,"instrument":{"symbol":"AAPL","assetType":"EQUITY"}}]}]}]})
    }
    async fn server(
        replies: Vec<(u16, Value, Option<&str>)>,
    ) -> (Schwab, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let count = replies.len();
        let mut replies = replies
            .into_iter()
            .map(|(s, b, l)| (s, b, l.map(str::to_owned)))
            .collect::<Vec<_>>().into_iter();
        routed_server(count, move |_| replies.next().unwrap()).await
    }

    async fn routed_server(
        count: usize,
        mut reply: impl FnMut(&str) -> (u16, Value, Option<String>) + Send + 'static,
    ) -> (Schwab, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            for _ in 0..count {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut data = Vec::new();
                let mut buffer = [0u8; 8192];
                loop {
                    let count = stream.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    data.extend_from_slice(&buffer[..count]);
                    if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&data[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|l| {
                                l.strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if data.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&data).into_owned();
                let (status, body, location) = reply(&request);
                captured
                    .lock()
                    .unwrap()
                    .push(request);
                let body = if body.is_null() {
                    String::new()
                } else {
                    body.to_string()
                };
                let location = location
                    .map(|v| format!("Location: {v}\r\n"))
                    .unwrap_or_default();
                let response=format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{location}Connection: close\r\n\r\n{body}",body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (
            Schwab::test_client(format!("http://{address}")).await,
            requests,
            task,
        )
    }

    #[tokio::test]
    async fn empty_created_response_is_accepted_without_retry() {
        let (api, requests, task) =
            server(vec![(201, Value::Null, Some("/accounts/hash/orders/123"))]).await;
        let (id, _) = submit(&api, "hash", &placement_payload(&draft()), None)
            .await
            .unwrap();
        assert_eq!(id, "123");
        task.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn entry_preparation_reuses_metadata_and_rechecks_mutable_state_after_preview() {
        for scenario in ["ok", "risk", "position", "pending"] {
            let path = database();
            let mut previewed = false;
            let (api, requests, task) = routed_server(100, move |request| {
                let route = request.split_whitespace().nth(1).unwrap();
                let body = if route == "/accounts/accountNumbers" {
                    json!([{"accountNumber":"fixture-number","hashValue":"hash"}])
                } else if route == "/accounts" {
                    json!([{"securitiesAccount":{"accountNumber":"fixture-number","type":"MARGIN"}}])
                } else if route.starts_with("/instruments?") {
                    json!({"instruments":[{"symbol":"AAPL","assetType":"EQUITY"}]})
                } else if route.starts_with("/markets/equity?") {
                    json!({"isOpen":true,"sessionHours":{"regularMarket":[{
                        "start":(Utc::now()-chrono::Duration::hours(1)).to_rfc3339(),
                        "end":(Utc::now()+chrono::Duration::hours(1)).to_rfc3339()}]}})
                } else if route.starts_with("/accounts/hash?") {
                    let positions = if previewed && scenario == "position" {
                        json!([{"longQuantity":1,"averagePrice":200,"instrument":{"symbol":"AAPL","assetType":"COLLECTIVE_INVESTMENT"}}])
                    } else { json!([]) };
                    json!({"securitiesAccount":{"accountNumber":"fixture-number","positions":positions}})
                } else if route.starts_with("/accounts/hash/orders?") {
                    if previewed && scenario == "pending" {
                        json!([{"orderId":99,"orderType":"MARKET","status":"WORKING","orderLegCollection":[{
                            "instruction":"BUY","quantity":1,"instrument":{"symbol":"AAPL","assetType":"EQUITY"}}]}])
                    } else { json!([]) }
                } else if route.starts_with("/quotes?") {
                    let ask = if previewed && scenario == "risk" { 200.05 } else { 200.0 };
                    json!({"AAPL":{"realtime":true,"quote":{"lastPrice":200,"bidPrice":199.99,"askPrice":ask,"quoteTime":Utc::now().timestamp_millis()}}})
                } else if route == "/accounts/hash/previewOrder" {
                    assert!(request.starts_with("POST "));
                    previewed = true;
                    json!({"orderValidationResult":{"accepts":[]}})
                } else { panic!("Unexpected fixture request: {route}") };
                (200, body, None)
            }).await;
            let request = serde_json::to_value(draft()).unwrap();
            let result = prepare(&api, &path, "hash", "schwab_place", &request).await;
            task.abort();
            let _ = task.await;
            let requests = requests.lock().unwrap();
            if scenario == "ok" {
                assert_eq!(result.unwrap(), placement_payload(&draft()));
                assert_eq!(requests.len(), 12);
            } else {
                let message = result.unwrap_err().to_string();
                assert!(message.contains(if scenario == "risk" { "risk budget" } else { "already has shares" }), "{scenario}: {message}");
            }
            for route in ["/accounts/accountNumbers", "/accounts ", "/instruments?", "/markets/equity?"] {
                assert_eq!(requests.iter().filter(|r| r.contains(route)).count(), 1, "Repeated metadata lookup: {route}");
            }
            assert_eq!(requests.iter().filter(|r| r.contains("/accounts/hash?fields=positions")).count(), 2);
            assert_eq!(requests.iter().filter(|r| r.contains("/previewOrder ")).count(), 1);
            assert!(requests.iter().all(|r| r.starts_with("GET ") || r.starts_with("POST /accounts/hash/previewOrder ")));
            std::fs::remove_file(path).ok();
        }
    }
    #[tokio::test]
    async fn server_failure_is_unknown_and_never_resubmitted() {
        let (api, requests, task) =
            server(vec![(500, json!({"message":"server error"}), None)]).await;
        assert!(matches!(
            submit(&api, "hash", &placement_payload(&draft()), None).await,
            Err(AppError::AmbiguousBrokerOutcome(_))
        ));
        task.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn definitive_rejection_is_not_an_unknown_write() {
        let (api, _, task) = server(vec![(
            400,
            json!({"message":"Insufficient buying power"}),
            None,
        )])
        .await;
        let error = submit(&api, "hash", &placement_payload(&draft()), None)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BrokerRejected(_)));
        assert!(error.to_string().contains("buying power"));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn preview_rejection_reports_endpoint_and_field_validation() {
        let (api, requests, task) = server(vec![(
            400,
            json!({"message":"A validation error occurred while processing the request.",
                "errors":["orderStrategy.duration: unsupported value"]}),
            None,
        )])
        .await;
        let error = preview(
            &api,
            &json!({"account":"hash","order":placement_payload(&draft())}),
        )
        .await
        .unwrap_err();
        let message = error.to_string();
        assert!(matches!(error, AppError::BrokerRejected(_)));
        assert!(message.contains("Schwab order preview rejected"));
        assert!(message.contains("orderStrategy.duration: unsupported value"));
        task.await.unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /accounts/hash/previewOrder "));
        let body: Value =
            serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["duration"], "DAY");
        assert!(body.get("orderStrategy").is_none());
        let children = &body["childOrderStrategies"][0]["childOrderStrategies"];
        assert_eq!(children[0]["duration"], "GOOD_TILL_CANCEL");
        assert_eq!(children[1]["duration"], "GOOD_TILL_CANCEL");
        assert!(!body.to_string().contains("\"GTC\""));
    }
    #[tokio::test]
    async fn preview_posts_the_full_order_request_and_parses_response_only_fields() {
        // The request is an order dictionary, as passed to Client.preview_order:
        // https://github.com/tylerebowers/Schwabdev/blob/main/schwabdev/client.py
        // orderStrategy/orderLegs belong to the returned preview, not this body.
        let expected: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/schwab_preview_bracket_request.json"
        ))
        .unwrap();
        let response = json!({
            "orderStrategy": {
                "orderStrategyType":"TRIGGER", "advancedOrderType":"OTOCO", "status":"ACCEPTED",
                "orderBalance":{"projectedCommission":0,"projectedBuyingPower":764.03},
                "orderLegs":[{"finalSymbol":"SPY","assetType":"EQUITY","instruction":"BUY"}]
            },
            "orderValidationResult":{"accepts":[{"activityMessage":"Order accepted","originalSeverity":"ACCEPT"}]}
        });
        let (api, requests, task) = server(vec![(200, response, None)]).await;
        let mut d = draft();
        d.symbol = "SPY".into();
        d.quantity = 1;
        d.reference_entry = 764.03;
        d.stop_loss = 762.11;
        d.take_profit = 766.91;
        let checked = preview(&api, &json!({"account":"hash","order":placement_payload(&d)}))
            .await
            .unwrap();
        assert!(checked.valid, "{:?}", checked.errors);
        assert_eq!(checked.initial_margin.as_deref(), Some("764.03"));
        task.await.unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1); // preview only; no placement or fallback
        assert!(requests[0].starts_with("POST /accounts/hash/previewOrder "));
        let actual: Value =
            serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(actual, expected);
        assert!(actual.get("orderStrategy").is_none());
        assert!(actual.get("orderLegs").is_none());
    }
    #[tokio::test]
    async fn delayed_get_keeps_acceptance_and_durable_broker_id() {
        let path = database();
        let request = serde_json::to_value(draft()).unwrap();
        mutation(&path, "place", "schwab_place", request.clone(), None);
        let (api, requests, task) = server(vec![
            (201, Value::Null, Some("/orders/123")),
            (404, json!({"message":"Not yet visible"}), None),
        ])
        .await;
        let (order, warning, _) = execute(
            &api,
            &path,
            "hash",
            "schwab_place",
            &request,
            &placement_payload(&draft()),
            "place",
        )
        .await
        .unwrap();
        assert_eq!(order.broker_order_id.as_deref(), Some("123"));
        assert_eq!(order.status, "Pending");
        assert!(warning.is_some());
        assert_eq!(
            safety::load_intent(&path, "place")
                .unwrap()
                .unwrap()
                .broker_id
                .as_deref(),
            Some("123")
        );
        assert_eq!(brackets(&path, "hash").unwrap().len(), 1);
        task.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
        std::fs::remove_file(path).ok();
    }
    #[tokio::test]
    async fn cancellation_waits_for_children_even_after_entry_filled() {
        let (api, requests, task) = server(vec![
            (200, order_tree("WORKING"), None),
            (204, Value::Null, None),
            (200, order_tree("WORKING"), None),
            (200, order_tree("CANCELED"), None),
        ])
        .await;
        let result = cancel_confirmed(&api, "hash", "124").await;
        assert!(
            result.is_ok(),
            "{result:?}; requests: {:?}",
            requests.lock().unwrap()
        );
        task.await.unwrap();
        let requests = requests.lock().unwrap();
        assert!(requests[1].starts_with("DELETE "));
        assert_eq!(requests.len(), 4);
    }

    #[tokio::test]
    async fn already_terminal_groups_are_not_canceled_twice() {
        let (api, requests, task) = server(vec![(200, order_tree("CANCELED"), None)]).await;
        cancel_confirmed(&api, "hash", "124").await.unwrap();
        task.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert!(requests.lock().unwrap()[0].starts_with("GET "));
    }

    #[test]
    fn durable_brackets_exclude_plaintext_account_numbers() {
        let path = database();
        let mut raw = order_tree("WORKING");
        raw["accountNumber"] = json!("12345678");
        raw["childOrderStrategies"][0]["accountNumber"] = json!("12345678");
        save_bracket(
            &path,
            "hash",
            "123",
            &serde_json::to_value(draft()).unwrap(),
            &raw,
        )
        .unwrap();
        let saved = brackets(&path, "hash").unwrap().remove(0).2.to_string();
        assert!(!saved.contains("12345678"));
        assert!(saved.contains("childOrderStrategies"));
        std::fs::remove_file(path).ok();
    }
    #[tokio::test]
    async fn cancellation_recovery_does_not_confirm_a_still_working_group() {
        let path = database();
        mutation(&path, "cancel", "schwab_cancel", json!({}), Some("124"));
        let (api, _, task) = server(vec![(200, order_tree("WORKING"), None)]).await;
        reconcile_account(&api, &path, "hash").await.unwrap();
        task.await.unwrap();
        assert_eq!(
            safety::load_intent(&path, "cancel").unwrap().unwrap().state,
            safety::MutationState::Unknown
        );
        std::fs::remove_file(path).ok();
    }
    #[test]
    fn oco_relationships_survive_single_child_strategies_and_replacement() {
        let raw = order_tree("WORKING");
        let rows = flatten(&raw, "hash");
        assert_eq!(rows[1].group_name.as_deref(), Some("OCO"));
        assert_eq!(rows[1].open_or_close.as_deref(), Some("Close"));
        let details = rows[1].schwab.as_ref().unwrap();
        assert_eq!(details.root_order_id, "123");
        assert_eq!(details.oco_order_id.as_deref(), Some("124"));
        let replacement =
            replacement_payload(&raw["childOrderStrategies"][0], "126", 199.0).unwrap();
        assert_eq!(replacement["orderStrategyType"], "OCO");
        assert_eq!(replacement["childOrderStrategies"][0]["price"], 203);
        assert_eq!(replacement["childOrderStrategies"][1]["stopPrice"], 199.0);
        assert!(replacement["childOrderStrategies"][1]
            .get("orderId")
            .is_none());
        assert!(replacement_payload(&raw, "126", 199.0).is_err());
    }
    #[test]
    fn partial_entry_without_active_children_is_a_protection_gap() {
        let mut raw = order_tree("AWAITING_PARENT_ORDER");
        raw["status"] = json!("WORKING");
        raw["filledQuantity"] = json!(20);
        let mut p:Position=serde_json::from_value(json!({"provider":"schwab","accountId":"hash","id":"p","symbol":"AAPL","side":"Long","quantity":20,"averagePrice":200,"last":200,"unrealizedPnl":0,"assetType":"EQUITY"})).unwrap();
        assert!(!protection_issues(&[p.clone()], &flatten(&raw, "hash")).is_empty());
        p.quantity = 50.0;
        assert!(
            protection_issues(&[p.clone()], &flatten(&order_tree("WORKING"), "hash")).is_empty()
        );
        p.quantity = 20.0;
        assert!(!protection_issues(&[p], &flatten(&order_tree("WORKING"), "hash")).is_empty());
    }
    #[test]
    fn reviewed_risk_is_revalidated_without_resizing_or_moving_exits() {
        let mut q = Quote {
            provider: MarketDataProvider::Schwab,
            symbol: "AAPL".into(),
            last: 200.0,
            bid: 199.99,
            ask: 200.0,
            change: 0.0,
            change_pct: 0.0,
            delayed: false,
            halted: false,
            timestamp: Utc::now().to_rfc3339(),
        };
        let d = draft();
        assert!(validate_draft(&d, &q).is_ok());
        q.ask = 200.01;
        assert!(validate_draft(&d, &q)
            .unwrap_err()
            .to_string()
            .contains("risk budget"));
        q.ask = 200.0;
        q.bid = 0.0;
        assert!(validate_draft(&d, &q).is_err());
        q.bid = 199.99;
        q.timestamp = (Utc::now() - chrono::Duration::seconds(6)).to_rfc3339();
        assert!(validate_draft(&d, &q).is_err());
        let mut short = d.clone();
        short.direction = "Short".into();
        short.stop_loss = 202.0;
        short.take_profit = 197.0;
        q.bid = 200.0;
        q.timestamp = Utc::now().to_rfc3339();
        assert!(validate_draft(&short, &q).is_ok());
        assert_eq!(d.quantity, 50);
        assert_eq!(d.take_profit, 203.0);
    }
    fn draft() -> SchwabEquityOrderDraft {
        SchwabEquityOrderDraft {
            account_id: "hash".into(),
            symbol: "AAPL".into(),
            direction: "Long".into(),
            sizing_mode: "risk".into(),
            risk_budget: Some(100.0),
            quantity: 50,
            reference_entry: 200.0,
            stop_loss: 198.0,
            take_profit: 203.0,
            r_multiple: Some(1.5),
            exit_duration: "GTC".into(),
        }
    }
    #[test]
    fn brackets_preserve_short_instructions_and_duration() {
        let mut d = draft();
        let long = placement_payload(&d);
        assert_eq!(long["orderLegCollection"][0]["instruction"], "BUY");
        assert_eq!(long["duration"], "DAY");
        d.direction = "Short".into();
        let short = placement_payload(&d);
        assert_eq!(short["orderLegCollection"][0]["instruction"], "SELL_SHORT");
        assert_eq!(
            short["childOrderStrategies"][0]["childOrderStrategies"][1]["orderLegCollection"][0]
                ["instruction"],
            "BUY_TO_COVER"
        );
        assert_eq!(
            short["childOrderStrategies"][0]["childOrderStrategies"][1]["duration"],
            "GOOD_TILL_CANCEL"
        );
    }
    #[test]
    fn day_and_gtc_brackets_use_schwab_duration_values_at_every_exit() {
        for direction in ["Long", "Short"] {
            for (ticket, wire) in [("DAY", "DAY"), ("GTC", "GOOD_TILL_CANCEL")] {
                let mut d = draft();
                d.direction = direction.into();
                d.exit_duration = ticket.into();
                let placed = placement_payload(&d);
                let preview = preview_payload(&placed);
                for root in [&placed, &preview] {
                    assert_eq!(root["duration"], "DAY");
                    let exits = root["childOrderStrategies"][0]["childOrderStrategies"]
                        .as_array()
                        .unwrap();
                    assert_eq!(exits.len(), 2);
                    for exit in exits {
                        assert_eq!(exit["duration"], wire);
                        assert_eq!(exit["session"], "NORMAL");
                    }
                }
            }
        }
    }
    #[test]
    fn replacement_normalizes_legacy_gtc_without_changing_oco_or_sibling_price() {
        let mut raw = json!({"orderStrategyType":"OCO","childOrderStrategies":[
            {"orderId":1,"orderType":"LIMIT","session":"NORMAL","duration":"GTC","price":203,
                "orderLegCollection":[{"instruction":"SELL","quantity":50,"instrument":{"symbol":"AAPL","assetType":"EQUITY"}}]},
            {"orderId":2,"orderType":"STOP","session":"NORMAL","duration":"GOOD_TILL_CANCEL","stopPrice":198,
                "orderLegCollection":[{"instruction":"SELL","quantity":50,"instrument":{"symbol":"AAPL","assetType":"EQUITY"}}]}
        ]});
        let replaced = replacement_payload(&raw, "2", 199.0).unwrap();
        assert_eq!(replaced["orderStrategyType"], "OCO");
        assert_eq!(replaced["childOrderStrategies"][0]["price"], 203);
        assert_eq!(replaced["childOrderStrategies"][1]["stopPrice"], 199.0);
        for exit in replaced["childOrderStrategies"].as_array().unwrap() {
            assert_eq!(exit["duration"], "GOOD_TILL_CANCEL");
        }
        // The preview adapter also handles older persisted payloads directly.
        raw["childOrderStrategies"][1]["duration"] = json!("GTC");
        let preview = preview_payload(&raw);
        assert!(!preview.to_string().contains("\"GTC\""));
    }
    #[test]
    fn preview_preserves_request_shape_and_unknown_response_contract_blocks() {
        let p = preview_payload(&placement_payload(&draft()));
        assert_eq!(p["orderLegCollection"][0]["instrument"]["symbol"], "AAPL");
        assert_eq!(p, placement_payload(&draft()));
        assert!(!parse_preview(&json!({})).valid);
        assert!(
            !parse_preview(
                &json!({"orderValidationResult":{"rejects":[{"message":"not shortable"}]}})
            )
            .valid
        );
        assert!(parse_preview(&json!({"orderValidationResult":{"rejects":[],"reviews":[]}})).valid);
    }
    #[test]
    fn preview_accepts_optional_empty_categories_but_rejects_malformed_or_rejected_results() {
        assert!(parse_preview(&json!({"orderValidationResult":{"accepts":[{"activityMessage":"Accepted"}]}})).valid);
        for value in [
            json!({}),
            json!({"orderValidationResult":{}}),
            json!({"orderValidationResult":{"rejects":"invalid"}}),
            json!({"orderValidationResult":{"accepts":[],"reviews":{}}}),
            json!({"orderStrategy":{"status":"REJECTED"},"orderValidationResult":{"accepts":[]}}),
            json!({"orderValidationResult":{"rejects":[{"activityMessage":"Buying power unavailable"}]}}),
            json!({"orderValidationResult":{"reviews":[{"activityMessage":"Short sale requires review"}]}}),
        ] {
            assert!(!parse_preview(&value).valid, "Unexpected approval for {value}");
        }
    }
    #[test]
    fn early_close_and_holiday_fail_closed() {
        let v = json!({"equity":{"EQ":{"isOpen":true,"sessionHours":{"regularMarket":[{"start":"2026-11-27T09:30:00-05:00","end":"2026-11-27T13:00:00-05:00"}]}}}});
        assert!(session_open(&v, "2026-11-27T17:59:00Z".parse().unwrap()));
        assert!(!session_open(&v, "2026-11-27T18:00:00Z".parse().unwrap()));
        assert!(!session_open(
            &json!({"equity":{"isOpen":false}}),
            Utc::now()
        ));
    }
    #[test]
    fn accepted_without_location_is_ambiguous() {
        assert!(matches!(
            location_id(None),
            Err(AppError::AmbiguousBrokerOutcome(_))
        ));
        assert_eq!(
            location_id(Some(
                "https://api.schwabapi.com/trader/v1/accounts/hash/orders/123".into()
            ))
            .unwrap(),
            "123"
        );
    }
}
