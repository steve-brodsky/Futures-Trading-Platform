use crate::{schwab::Schwab, storage, AppError};
use chrono::{DateTime, Duration, Utc};
use chrono_tz::America::New_York;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, path::Path};

pub const SYMBOLS: [&str; 5] = ["SPXL", "UPRO", "SSO", "SPUU", "TQQQ"];
const EPSILON: f64 = 0.00000001;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EtfTrackerRow {
    pub symbol: String,
    pub quantity: f64,
    pub last_closed_date: Option<String>,
    pub availability_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EtfTrackerSnapshot {
    pub account_id: String,
    pub fetched_at: String,
    pub coverage_start: String,
    pub coverage_end: String,
    pub status: String,
    pub rows: Vec<EtfTrackerRow>,
}

fn cache_key(account: &str) -> String {
    format!("etf_tracker_v1:{account}")
}

pub fn get_cache(path: &Path, account: &str) -> Result<Option<EtfTrackerSnapshot>, AppError> {
    let Some(value) = storage::load_json_setting(path, &cache_key(account))? else {
        return Ok(None);
    };
    let mut snapshot: EtfTrackerSnapshot = serde_json::from_value(value)?;
    if snapshot.account_id != account {
        return Ok(None);
    }
    snapshot.status = "cache".into();
    Ok(Some(snapshot))
}

pub async fn refresh(
    path: &Path,
    api: &Schwab,
    account: &str,
) -> Result<EtfTrackerSnapshot, AppError> {
    let end = Utc::now();
    let start = end - Duration::days(365);
    let before = api.etf_share_quantities(account).await?;
    let mut activities = Vec::new();
    // Separate documented type values avoid assuming support for a comma-separated filter.
    // Cash-only dividend/journal entries are ignored; share adjustments must be included.
    for kind in [
        "TRADE",
        "RECEIVE_AND_DELIVER",
        "JOURNAL",
        "MEMORANDUM",
        "DIVIDEND_OR_INTEREST",
    ] {
        activities.extend(api.etf_transactions(account, kind, start, end).await?);
    }
    let quantities = api.etf_share_quantities(account).await?;
    if before
        .iter()
        .zip(quantities.iter())
        .any(|(a, b)| (a - b).abs() > EPSILON)
    {
        return Err(AppError::Api(
            "Schwab holdings changed during the ETF refresh; retry for a consistent snapshot"
                .into(),
        ));
    }
    let snapshot = EtfTrackerSnapshot {
        account_id: account.into(),
        fetched_at: Utc::now().to_rfc3339(),
        coverage_start: start.with_timezone(&New_York).date_naive().to_string(),
        coverage_end: end.with_timezone(&New_York).date_naive().to_string(),
        status: "live".into(),
        rows: SYMBOLS
            .iter()
            .zip(quantities)
            .map(|(symbol, quantity)| reconstruct(symbol, quantity, &activities, start, end))
            .collect(),
    };
    storage::save_json_setting(path, &cache_key(account), &serde_json::to_value(&snapshot)?)?;
    Ok(snapshot)
}

#[derive(Debug)]
struct Movement {
    at: DateTime<Utc>,
    recorded_at: DateTime<Utc>,
    date: String,
    delta: f64,
    trade: bool,
    effect: String,
}

fn timestamp(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.get(key)?.as_str()?)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

fn reconstruct(
    symbol: &str,
    quantity: f64,
    activities: &[Value],
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> EtfTrackerRow {
    let mut result = EtfTrackerRow {
        symbol: symbol.into(),
        quantity,
        last_closed_date: None,
        availability_reason: None,
    };
    let fail = |mut row: EtfTrackerRow, reason: &str| {
        row.last_closed_date = None;
        row.availability_reason = Some(reason.into());
        row
    };
    let mut seen = HashMap::new();
    let mut movements = Vec::new();
    for activity in activities {
        let Some(items) = activity.get("transferItems").and_then(Value::as_array) else {
            return fail(result, "Transaction is missing share details");
        };
        let matching: Vec<_> = items
            .iter()
            .filter(|item| {
                item.pointer("/instrument/symbol")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.eq_ignore_ascii_case(symbol))
                    && !item
                        .pointer("/instrument/type")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .contains("OPTION")
            })
            .collect();
        if matching.is_empty() {
            continue;
        }
        let status = activity.get("status").and_then(Value::as_str).unwrap_or("");
        let Some(id) = activity
            .get("activityId")
            .filter(|id| id.is_string() || id.is_u64())
        else {
            return fail(result, "Share activity has no reliable activity ID");
        };
        if let Some(previous) = seen.insert(id.to_string(), activity) {
            if previous != activity {
                return fail(result, "Conflicting versions of share activity");
            }
            continue;
        }
        if matches!(status, "CANCELED" | "CANCELLED") {
            continue;
        }
        if status != "VALID" {
            return fail(result, "Share activity is not yet final");
        }
        if activity
            .get("activityType")
            .and_then(Value::as_str)
            .is_some_and(|s| s.contains("CORRECTION"))
        {
            return fail(result, "Corrected share activity requires reconciliation");
        }
        let trade = activity.get("type").and_then(Value::as_str) == Some("TRADE");
        let Some(trade_at) = timestamp(activity, "tradeDate")
            .or_else(|| (!trade).then(|| timestamp(activity, "time")).flatten())
        else {
            return fail(result, "Share activity is missing its trade date");
        };
        // Prefer execution chronology over posting chronology. Some broker trade
        // dates share one timestamp; recorded time can then disambiguate them.
        let recorded_at = timestamp(activity, "time").unwrap_or(trade_at);
        if recorded_at < start || recorded_at > end || trade_at > end {
            return fail(result, "Share activity falls outside verified history");
        }
        let mut delta = 0.0;
        let mut effect = None;
        let mut direction = 0.0_f64;
        for item in matching {
            if item
                .get("feeType")
                .and_then(Value::as_str)
                .is_some_and(|fee| fee != "NONE")
            {
                continue;
            }
            let Some(amount) = item
                .get("amount")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
            else {
                return fail(result, "Share adjustment has no reliable quantity");
            };
            if amount.abs() <= EPSILON {
                continue;
            }
            if direction != 0.0 && direction != amount.signum() {
                return fail(result, "Mixed share directions in one activity");
            }
            direction = amount.signum();
            let item_effect = item
                .get("positionEffect")
                .and_then(Value::as_str)
                .unwrap_or("");
            if effect.is_some_and(|previous| previous != item_effect) {
                return fail(result, "Mixed position effects in one activity");
            }
            effect = Some(item_effect);
            delta += amount;
        }
        if delta.abs() <= EPSILON {
            continue;
        }
        movements.push(Movement {
            at: trade_at,
            recorded_at,
            date: trade_at.with_timezone(&New_York).date_naive().to_string(),
            delta,
            trade,
            effect: effect.unwrap_or("").into(),
        });
    }
    movements.sort_by(|a, b| b.at.cmp(&a.at).then(b.recorded_at.cmp(&a.recorded_at)));
    // Activity IDs are identities, not execution ordering. Tied opposite directions
    // can hide an intraday flatten/reopen, so do not guess their order.
    for pair in movements.windows(2) {
        if pair[0].at == pair[1].at
            && pair[0].recorded_at == pair[1].recorded_at
            && pair[0].delta.signum() != pair[1].delta.signum()
        {
            return fail(result, "Share activity order is ambiguous");
        }
    }
    let mut after = quantity;
    for movement in movements {
        let mut before = after - movement.delta;
        if before.abs() <= EPSILON {
            before = 0.0;
        }
        if movement.trade {
            let crossing = before.abs() > EPSILON
                && after.abs() > EPSILON
                && before.signum() != after.signum();
            let closing = before.abs() > after.abs() + EPSILON;
            if crossing
                || !matches!(movement.effect.as_str(), "OPENING" | "CLOSING")
                || (movement.effect == "CLOSING" && !closing)
                || (movement.effect == "OPENING" && closing)
            {
                return fail(
                    result,
                    "Transactions do not reconcile with current holdings",
                );
            }
            if after.abs() <= EPSILON && before.abs() > EPSILON && result.last_closed_date.is_none()
            {
                result.last_closed_date = Some(movement.date);
            }
        }
        after = before;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn at(day: u32) -> DateTime<Utc> {
        format!("2026-09-{day:02}T16:00:00Z").parse().unwrap()
    }
    fn trade(id: u64, day: u32, amount: f64, effect: &str) -> Value {
        json!({"activityId":id,"time":at(day).to_rfc3339(),"tradeDate":at(day).to_rfc3339(),"type":"TRADE","status":"VALID","transferItems":[{"instrument":{"symbol":"SPXL","type":"EQUITY"},"amount":amount,"positionEffect":effect}]})
    }
    fn row(quantity: f64, rows: Vec<Value>) -> EtfTrackerRow {
        reconstruct("SPXL", quantity, &rows, at(1), at(30))
    }

    #[test]
    fn partial_and_fractional_exits_only_count_when_flat() {
        let rows = vec![
            trade(1, 2, 10.5, "OPENING"),
            trade(2, 3, 2.25, "OPENING"),
            trade(3, 4, -10.5, "CLOSING"),
        ];
        assert_eq!(row(2.25, rows.clone()).last_closed_date, None);
        let mut rows = rows;
        rows.push(trade(4, 5, -2.25, "CLOSING"));
        let result = row(0.0, rows);
        assert_eq!(result.last_closed_date.as_deref(), Some("2026-09-05"));
        assert_eq!(result.availability_reason, None);
    }

    #[test]
    fn preserves_previous_close_when_reopened_and_uses_latest_exit() {
        let mut rows = vec![
            trade(1, 2, 10.0, "OPENING"),
            trade(2, 3, -10.0, "CLOSING"),
            trade(3, 4, 5.0, "OPENING"),
        ];
        assert_eq!(
            row(5.0, rows.clone()).last_closed_date.as_deref(),
            Some("2026-09-03")
        );
        rows.push(trade(4, 5, -5.0, "CLOSING"));
        assert_eq!(
            row(0.0, rows).last_closed_date.as_deref(),
            Some("2026-09-05")
        );
    }

    #[test]
    fn deduplicates_and_rejects_conflicting_or_corrected_activity() {
        let buy = trade(1, 2, 10.0, "OPENING");
        let sell = trade(2, 3, -10.0, "CLOSING");
        assert_eq!(
            row(0.0, vec![buy.clone(), sell.clone(), sell.clone()])
                .last_closed_date
                .as_deref(),
            Some("2026-09-03")
        );
        assert!(row(0.0, vec![sell.clone(), trade(2, 3, -5.0, "CLOSING")])
            .availability_reason
            .is_some());
        let mut correction = sell;
        correction["activityType"] = json!("ACTIVITY_CORRECTION");
        assert!(row(0.0, vec![buy, correction])
            .availability_reason
            .is_some());
    }

    #[test]
    fn transfers_and_splits_affect_holdings_but_do_not_count_as_trade_exits() {
        let mut split = trade(2, 3, 10.0, "");
        split["type"] = json!("JOURNAL");
        let rows = vec![
            trade(1, 2, 10.0, "OPENING"),
            split,
            trade(3, 4, -20.0, "CLOSING"),
        ];
        assert_eq!(
            row(0.0, rows).last_closed_date.as_deref(),
            Some("2026-09-04")
        );
        let mut transfer = trade(2, 3, -10.0, "");
        transfer["type"] = json!("RECEIVE_AND_DELIVER");
        assert_eq!(
            row(0.0, vec![trade(1, 2, 10.0, "OPENING"), transfer]).last_closed_date,
            None
        );
    }

    #[test]
    fn detects_missing_pending_and_ambiguous_history() {
        assert!(row(0.0, vec![trade(1, 2, 10.0, "OPENING")])
            .availability_reason
            .is_some());
        assert!(row(
            0.0,
            vec![trade(1, 2, 10.0, "OPENING"), trade(2, 2, -10.0, "CLOSING")]
        )
        .availability_reason
        .is_some());
        let mut pending = trade(1, 2, -10.0, "CLOSING");
        pending["status"] = json!("PENDING");
        assert!(row(0.0, vec![pending]).availability_reason.is_some());
        assert_eq!(row(0.0, vec![]).last_closed_date, None);
    }

    #[test]
    fn uses_new_york_trade_date_instead_of_settlement_or_posting_date() {
        let mut sell = trade(1, 3, -10.0, "CLOSING");
        sell["tradeDate"] = json!("2026-09-03T01:00:00Z");
        sell["settlementDate"] = json!("2026-09-04T16:00:00Z");
        assert_eq!(
            row(0.0, vec![sell]).last_closed_date.as_deref(),
            Some("2026-09-02")
        );
    }

    #[test]
    fn posting_order_does_not_override_execution_order() {
        let mut buy = trade(1, 2, 10.0, "OPENING");
        let mut sell = trade(2, 3, -10.0, "CLOSING");
        buy["time"] = json!(at(5).to_rfc3339());
        sell["time"] = json!(at(4).to_rfc3339());
        let result = row(0.0, vec![buy, sell]);
        assert_eq!(result.last_closed_date.as_deref(), Some("2026-09-03"));
        assert_eq!(result.availability_reason, None);
    }

    #[test]
    fn cancellation_conflicting_with_valid_activity_is_unavailable() {
        let valid = trade(1, 2, -10.0, "CLOSING");
        let mut cancelled = valid.clone();
        cancelled["status"] = json!("CANCELED");
        assert!(row(0.0, vec![valid.clone(), cancelled.clone()])
            .availability_reason
            .is_some());
        assert!(row(0.0, vec![cancelled.clone(), valid])
            .availability_reason
            .is_some());
        assert_eq!(row(0.0, vec![cancelled]).last_closed_date, None);
    }

    #[test]
    fn cache_is_account_scoped_and_does_not_store_raw_activity() {
        let path = std::env::temp_dir().join(format!("etf-{}.sqlite", uuid::Uuid::new_v4()));
        let snapshot = EtfTrackerSnapshot {
            account_id: "hash-a".into(),
            fetched_at: at(30).to_rfc3339(),
            coverage_start: "2025-09-30".into(),
            coverage_end: "2026-09-30".into(),
            status: "live".into(),
            rows: vec![row(0.0, vec![])],
        };
        storage::save_json_setting(
            &path,
            &cache_key("hash-a"),
            &serde_json::to_value(snapshot).unwrap(),
        )
        .unwrap();
        assert_eq!(get_cache(&path, "hash-a").unwrap().unwrap().status, "cache");
        assert!(get_cache(&path, "hash-b").unwrap().is_none());
        std::fs::remove_file(path).unwrap();
    }

    async fn server(replies: Vec<(u16, Value)>) -> (Schwab, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, body) in replies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    bytes.extend_from_slice(&buffer[..count]);
                    if count == 0 || bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(
                    String::from_utf8(bytes)
                        .unwrap()
                        .lines()
                        .next()
                        .unwrap()
                        .to_string(),
                );
                let body = body.to_string();
                stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        (Schwab::test_client(format!("http://{address}")).await, task)
    }

    #[tokio::test]
    async fn transaction_cap_splits_windows_with_inclusive_boundaries() {
        let full = Value::Array(vec![json!({"activityId":1}); 3_000]);
        let (api, server) = server(vec![
            (200, full),
            (200, json!([{"activityId":1}])),
            (200, json!([{"activityId":1},{"activityId":2}])),
        ])
        .await;
        let rows = api
            .etf_transactions("encrypted", "TRADE", at(1), at(3))
            .await
            .unwrap();
        assert_eq!(rows.len(), 3); // Overlapping activity IDs are reconciled by reconstruct().
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 3);
        let queries: Vec<_> = requests
            .iter()
            .map(|r| {
                url::Url::parse(&format!(
                    "http://fixture{}",
                    r.split_whitespace().nth(1).unwrap()
                ))
                .unwrap()
            })
            .collect();
        let param = |i: usize, name: &str| {
            queries[i]
                .query_pairs()
                .find(|(key, _)| key == name)
                .unwrap()
                .1
                .to_string()
        };
        assert_eq!(param(1, "endDate"), param(2, "startDate"));
        assert_eq!(param(0, "startDate"), param(1, "startDate"));
        assert_eq!(param(0, "endDate"), param(2, "endDate"));
        assert!(requests
            .iter()
            .all(|r| r.contains("/accounts/encrypted/transactions?") && r.contains("types=TRADE")));
    }

    #[tokio::test]
    async fn refuses_unresolvable_cap_and_invalid_or_rejected_history() {
        let (api, task) = server(vec![(200, Value::Array(vec![json!({}); 3_000]))]).await;
        assert!(api
            .etf_transactions("hash", "TRADE", at(1), at(1) + Duration::milliseconds(1))
            .await
            .unwrap_err()
            .to_string()
            .contains("limit"));
        task.await.unwrap();
        for (status, body) in [
            (200, json!({"unexpected":true})),
            (403, json!({"message":"not allowed"})),
        ] {
            let (api, task) = server(vec![(status, body)]).await;
            assert!(api
                .etf_transactions("hash", "TRADE", at(1), at(2))
                .await
                .is_err());
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn refresh_reconciles_live_positions_and_saves_only_verified_snapshot() {
        let flat = json!({"securitiesAccount":{"positions":[]}});
        let sell_date = Utc::now() - Duration::days(40);
        let mut sell = trade(1, 3, -10.0, "CLOSING");
        sell["time"] = json!(sell_date.to_rfc3339());
        sell["tradeDate"] = json!(sell_date.to_rfc3339());
        let replies = vec![
            (200, flat.clone()),
            (200, json!([sell])),
            (200, json!([])),
            (200, json!([])),
            (200, json!([])),
            (200, json!([])),
            (200, flat),
        ];
        let (api, task) = server(replies).await;
        let path = std::env::temp_dir().join(format!("etf-live-{}.sqlite", uuid::Uuid::new_v4()));
        let snapshot = refresh(&path, &api, "hash").await.unwrap();
        assert_eq!(snapshot.rows.len(), 5);
        assert_eq!(
            snapshot.rows[0].last_closed_date,
            Some(sell_date.with_timezone(&New_York).date_naive().to_string())
        );
        assert_eq!(
            get_cache(&path, "hash").unwrap().unwrap().rows,
            snapshot.rows
        );
        assert_eq!(task.await.unwrap().len(), 7);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn holdings_changed_during_refresh_do_not_overwrite_cache() {
        let flat = json!({"securitiesAccount":{"positions":[]}});
        let open = json!({"securitiesAccount":{"positions":[{"instrument":{"symbol":"SPXL","assetType":"EQUITY"},"longQuantity":10,"shortQuantity":0}]}});
        let (api, task) = server(vec![
            (200, flat),
            (200, json!([])),
            (200, json!([])),
            (200, json!([])),
            (200, json!([])),
            (200, json!([])),
            (200, open),
        ])
        .await;
        let path = std::env::temp_dir().join(format!("etf-race-{}.sqlite", uuid::Uuid::new_v4()));
        assert!(refresh(&path, &api, "hash")
            .await
            .unwrap_err()
            .to_string()
            .contains("holdings changed"));
        assert!(get_cache(&path, "hash").unwrap().is_none());
        task.await.unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
