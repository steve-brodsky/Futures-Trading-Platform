use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, Notify, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::{
    audit::AuditRecord,
    models::{OptionContract, Quote},
    schwab,
    schwab::Schwab,
    AppError,
};

const EQUITY_FIELDS: &str = "0,1,2,3,8,12,18,32,33,34,35,42";
const CHART_FIELDS: &str = "0,1,2,3,4,5,6,7,8";
const OPTION_FIELDS: &str = "0,2,3,8,9,10,12,13,20,21,22,23,26,27,28,29,33,35,37,38,39";

#[derive(Clone, Debug)]
pub enum SchwabStreamEvent {
    State {
        state: String,
        message: Option<String>,
    },
    Quote(Quote),
    Chart {
        symbol: String,
        bar: crate::models::Bar,
    },
    EquityTick {
        symbol: String,
        price: f64,
        cumulative_volume: f64,
        time: i64,
    },
    Option(OptionContract),
    OptionState {
        state: String,
        message: Option<String>,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct DesiredSubscriptions {
    charts: BTreeSet<String>,
    quotes: BTreeSet<String>,
    options: BTreeSet<String>,
}

struct Inner {
    api: Schwab,
    desired: RwLock<DesiredSubscriptions>,
    connection_state: RwLock<SchwabConnectionState>,
    changed: Notify,
    events: broadcast::Sender<SchwabStreamEvent>,
    chart_events: broadcast::Sender<SchwabStreamEvent>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SchwabConnectionState {
    state: String,
    message: Option<String>,
}

#[derive(Clone)]
pub struct SchwabStreamer {
    inner: Arc<Inner>,
}

impl SchwabStreamer {
    pub fn new(api: Schwab) -> Self {
        let (events, _) = broadcast::channel(2_048);
        let (chart_events, _) = broadcast::channel(2_048);
        Self {
            inner: Arc::new(Inner {
                api,
                desired: RwLock::new(DesiredSubscriptions::default()),
                connection_state: RwLock::new(SchwabConnectionState {
                    state: "disconnected".into(),
                    message: None,
                }),
                changed: Notify::new(),
                events,
                chart_events,
                task: Mutex::new(None),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SchwabStreamEvent> {
        self.inner.events.subscribe()
    }

    pub fn subscribe_chart(&self) -> broadcast::Receiver<SchwabStreamEvent> {
        self.inner.chart_events.subscribe()
    }

    pub async fn connection_state(&self) -> (String, Option<String>) {
        let current = self.inner.connection_state.read().await;
        (current.state.clone(), current.message.clone())
    }

    pub async fn set_chart_symbols(&self, symbols: impl IntoIterator<Item = String>) {
        let next = normalize_symbols(symbols);
        let mut desired = self.inner.desired.write().await;
        if desired.charts != next {
            desired.charts = next.clone();
            drop(desired);
            record_subscription(&self.inner, "charts", &next);
            self.ensure_running().await;
            self.inner.changed.notify_one();
        }
    }

    pub async fn set_quote_symbols(&self, symbols: impl IntoIterator<Item = String>) {
        let next = normalize_symbols(symbols);
        let mut desired = self.inner.desired.write().await;
        if desired.quotes != next {
            desired.quotes = next.clone();
            drop(desired);
            record_subscription(&self.inner, "quotes", &next);
            self.ensure_running().await;
            self.inner.changed.notify_one();
        }
    }

    pub async fn set_option_symbols(&self, symbols: impl IntoIterator<Item = String>) {
        let next = normalize_symbols(symbols);
        let mut desired = self.inner.desired.write().await;
        if desired.options != next {
            desired.options = next.clone();
            drop(desired);
            record_subscription(&self.inner, "options", &next);
            self.ensure_running().await;
            self.inner.changed.notify_one();
        }
    }

    pub async fn stop(&self) {
        if let Some(task) = self.inner.task.lock().await.take() {
            task.abort();
        }
        *self.inner.desired.write().await = DesiredSubscriptions::default();
        publish_state(
            &self.inner,
            "disconnected",
            Some("Schwab disconnected".into()),
        )
        .await;
    }

    async fn ensure_running(&self) {
        let mut task = self.inner.task.lock().await;
        if task.is_some() {
            return;
        }
        let inner = self.inner.clone();
        *task = Some(tauri::async_runtime::spawn(async move {
            run(inner).await;
        }));
    }
}

fn record_subscription(inner: &Inner, kind: &str, symbols: &BTreeSet<String>) {
    if let Some(audit) = inner.api.audit() {
        let mut record = AuditRecord::completed(
            "stream",
            "schwab",
            "update-subscription",
            "success",
            format!(
                "Schwab {kind} subscription now tracks {} symbol{}",
                symbols.len(),
                if symbols.len() == 1 { "" } else { "s" }
            ),
        );
        record.entity_type = Some("stream-subscription".into());
        record.entity_id = Some(kind.into());
        record.record_count = Some(symbols.len() as i64);
        record.changes = Some(json!({"symbols": symbols}));
        audit.record(record);
    }
}

async fn publish_state(inner: &Inner, state: &str, message: Option<String>) {
    let previous = inner.connection_state.read().await.clone();
    *inner.connection_state.write().await = SchwabConnectionState {
        state: state.into(),
        message: message.clone(),
    };
    if previous.state != state || previous.message != message {
        if let Some(audit) = inner.api.audit() {
            let mut record = AuditRecord::completed(
                "stream",
                "schwab",
                "stream-state",
                if state == "reconnecting" || state == "disconnected" && message.is_some() {
                    "warning"
                } else {
                    "success"
                },
                message
                    .clone()
                    .unwrap_or_else(|| format!("Schwab stream is {state}")),
            );
            record.entity_type = Some("market-stream".into());
            record.entity_id = Some("schwab-shared".into());
            record.changes = Some(json!({"before": previous.state, "after": state}));
            audit.record(record);
        }
    }
    let event = SchwabStreamEvent::State {
        state: state.into(),
        message,
    };
    let _ = inner.events.send(event.clone());
    let _ = inner.chart_events.send(event);
}

fn normalize_symbols(symbols: impl IntoIterator<Item = String>) -> BTreeSet<String> {
    symbols
        .into_iter()
        .map(|symbol| symbol.trim().to_uppercase())
        .filter(|symbol| !symbol.is_empty())
        .take(100)
        .collect()
}

fn equity_subscription_symbols(desired: &DesiredSubscriptions) -> BTreeSet<String> {
    desired.quotes.union(&desired.charts).cloned().collect()
}

async fn run(inner: Arc<Inner>) {
    let mut retry = 0_u32;
    loop {
        if *inner.desired.read().await == DesiredSubscriptions::default() {
            publish_state(&inner, "disconnected", None).await;
            inner.changed.notified().await;
            retry = 0;
            continue;
        }
        let state = if retry == 0 {
            "connecting"
        } else {
            "reconnecting"
        };
        publish_state(&inner, state, None).await;
        match connect_once(inner.clone()).await {
            Ok(()) => retry = 0,
            Err(error) => {
                let reconnect_required = matches!(error, AppError::AuthenticationRequired);
                publish_state(
                    &inner,
                    if reconnect_required {
                        "disconnected"
                    } else {
                        "reconnecting"
                    },
                    Some(if reconnect_required {
                        "Schwab authorization expired. Reconnect Schwab in Settings.".into()
                    } else {
                        error.to_string()
                    }),
                )
                .await;
                retry = retry.saturating_add(1);
                let jitter = rand::random::<u16>() as u64 % 750;
                let delay = (1_000_u64 * 2_u64.pow(retry.min(5))).min(30_000) + jitter;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(delay)) => {},
                    _ = inner.changed.notified() => {},
                }
            }
        }
    }
}

async fn connect_once(inner: Arc<Inner>) -> Result<(), AppError> {
    let info = inner.api.streamer_info().await?;
    let token = inner.api.access_token(false).await?;
    let span = inner.api.audit().map(|audit| {
        audit.begin_api(
            "schwab",
            "stream-connect",
            "WEBSOCKET",
            &info.streamer_socket_url,
            None,
            Some(uuid::Uuid::new_v4().to_string()),
        )
    });
    let (socket, _) = match connect_async(&info.streamer_socket_url).await {
        Ok(socket) => {
            if let Some(span) = span {
                span.success(Some(101), None);
            }
            socket
        }
        Err(error) => {
            if let Some(span) = span {
                span.error(None, error.to_string());
            }
            return Err(AppError::Api(format!(
                "Schwab Streamer connection failed: {error}"
            )));
        }
    };
    let (mut write, mut read) = socket.split();
    let mut request_id = 1_u64;
    write
        .send(Message::Text(
            request(
                &info,
                request_id,
                "ADMIN",
                "LOGIN",
                json!({
                    "Authorization": token,
                    "SchwabClientChannel": info.schwab_client_channel,
                    "SchwabClientFunctionId": info.schwab_client_function_id,
                }),
            )
            .to_string()
            .into(),
        ))
        .await
        .map_err(|error| AppError::Api(error.to_string()))?;

    loop {
        let next = tokio::time::timeout(Duration::from_secs(60), read.next())
            .await
            .map_err(|_| AppError::Api("Schwab Streamer login timed out".into()))?;
        let message = next.ok_or_else(|| AppError::Api("Schwab Streamer closed".into()))?;
        match message.map_err(|error| AppError::Api(error.to_string()))? {
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_ref())?;
                if login_succeeded(&value)? {
                    break;
                }
            }
            Message::Ping(payload) => write
                .send(Message::Pong(payload))
                .await
                .map_err(|error| AppError::Api(error.to_string()))?,
            Message::Close(_) => return Err(AppError::Api("Schwab Streamer closed".into())),
            _ => {}
        }
    }

    let mut subscribed = DesiredSubscriptions::default();
    let desired = inner.desired.read().await.clone();
    update_subscriptions(&mut write, &info, &mut request_id, &subscribed, &desired).await?;
    subscribed = desired;
    publish_state(&inner, "streaming", None).await;

    let timeout = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(timeout);
    let mut quote_state = HashMap::new();
    let mut option_state = HashMap::new();
    let mut counts = StreamCounts::default();
    let mut summary_tick = tokio::time::interval(Duration::from_secs(60));
    summary_tick.tick().await;
    loop {
        tokio::select! {
            _ = &mut timeout => return Err(AppError::Api("Schwab Streamer heartbeat timed out".into())),
            _ = summary_tick.tick() => {
                let total = counts.quotes + counts.charts + counts.options;
                if total > 0 {
                    if let Some(audit) = inner.api.audit() {
                        let mut record = AuditRecord::completed(
                            "stream",
                            "schwab",
                            "market-update-batch",
                            "success",
                            format!("Received {total} Schwab market updates"),
                        );
                        record.entity_type = Some("market-update-batch".into());
                        record.entity_id = Some("schwab-shared".into());
                        record.record_count = Some(total as i64);
                        record.response = Some(json!({
                            "quotes": counts.quotes,
                            "bars": counts.charts,
                            "options": counts.options,
                        }));
                        audit.record(record);
                    }
                    counts = StreamCounts::default();
                }
            }
            _ = inner.changed.notified() => {
                let desired = inner.desired.read().await.clone();
                update_subscriptions(&mut write, &info, &mut request_id, &subscribed, &desired).await?;
                subscribed = desired;
            }
            next = read.next() => {
                let message = next.ok_or_else(|| AppError::Api("Schwab Streamer closed".into()))?
                    .map_err(|error| AppError::Api(format!("Schwab Streamer error: {error}")))?;
                timeout.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(60));
                match message {
                    Message::Text(text) => process_message(&inner, text.as_ref(), &mut quote_state, &mut option_state, &mut counts)?,
                    Message::Ping(payload) => write.send(Message::Pong(payload)).await.map_err(|error| AppError::Api(error.to_string()))?,
                    Message::Close(_) => return Err(AppError::Api("Schwab Streamer closed".into())),
                    _ => {}
                }
            }
        }
    }
}

#[derive(Default)]
struct StreamCounts {
    quotes: usize,
    charts: usize,
    options: usize,
}

async fn update_subscriptions<S>(
    write: &mut S,
    info: &schwab::StreamerInfo,
    request_id: &mut u64,
    previous: &DesiredSubscriptions,
    next: &DesiredSubscriptions,
) -> Result<(), AppError>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let mut requests = Vec::new();
    if previous.charts != next.charts {
        *request_id += 1;
        let (command, keys) = if next.charts.is_empty() {
            (
                "UNSUBS",
                previous.charts.iter().cloned().collect::<Vec<_>>(),
            )
        } else {
            ("SUBS", next.charts.iter().cloned().collect::<Vec<_>>())
        };
        requests.push(request_entry(
            info,
            *request_id,
            "CHART_EQUITY",
            command,
            json!({"keys":keys.join(","),"fields":CHART_FIELDS}),
        ));
    }
    let previous_equities = equity_subscription_symbols(previous);
    let next_equities = equity_subscription_symbols(next);
    if previous_equities != next_equities {
        *request_id += 1;
        let (command, keys) = if next_equities.is_empty() {
            ("UNSUBS", previous_equities.into_iter().collect::<Vec<_>>())
        } else {
            ("SUBS", next_equities.into_iter().collect::<Vec<_>>())
        };
        requests.push(request_entry(
            info,
            *request_id,
            "LEVELONE_EQUITIES",
            command,
            json!({"keys":keys.join(","),"fields":EQUITY_FIELDS}),
        ));
    }
    if previous.options != next.options {
        *request_id += 1;
        let (command, keys) = if next.options.is_empty() {
            (
                "UNSUBS",
                previous.options.iter().cloned().collect::<Vec<_>>(),
            )
        } else {
            ("SUBS", next.options.iter().cloned().collect::<Vec<_>>())
        };
        requests.push(request_entry(
            info,
            *request_id,
            "LEVELONE_OPTIONS",
            command,
            json!({"keys":keys.join(","),"fields":OPTION_FIELDS}),
        ));
    }
    if !requests.is_empty() {
        write
            .send(Message::Text(
                json!({"requests": requests}).to_string().into(),
            ))
            .await
            .map_err(|error| AppError::Api(error.to_string()))?;
    }
    Ok(())
}

fn process_message(
    inner: &Inner,
    text: &str,
    quote_state: &mut HashMap<String, Value>,
    option_state: &mut HashMap<String, Value>,
    counts: &mut StreamCounts,
) -> Result<(), AppError> {
    let value: Value = serde_json::from_str(text)?;
    for response in value
        .get("response")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if response.get("service").and_then(Value::as_str) != Some("LEVELONE_OPTIONS") {
            continue;
        }
        let code = response
            .pointer("/content/code")
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        let message = response
            .pointer("/content/msg")
            .and_then(Value::as_str)
            .map(str::to_string);
        let _ = inner.events.send(SchwabStreamEvent::OptionState {
            state: if code == 0 {
                "streaming"
            } else if code == 19 {
                "rest-only"
            } else {
                "error"
            }
            .into(),
            message,
        });
    }
    for data in value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let service = data
            .get("service")
            .and_then(Value::as_str)
            .unwrap_or_default();
        for content in data
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match service {
                "LEVELONE_EQUITIES" => {
                    if let Some(update) = merge_sparse_quote(quote_state, content) {
                        counts.quotes += 1;
                        let _ = inner.events.send(SchwabStreamEvent::Quote(update.quote));
                        if let Some((price, cumulative_volume, time)) = update.tick {
                            let _ = inner.chart_events.send(SchwabStreamEvent::EquityTick {
                                symbol: update.symbol,
                                price,
                                cumulative_volume,
                                time,
                            });
                        }
                    }
                }
                "CHART_EQUITY" => {
                    let symbol = content
                        .get("key")
                        .or_else(|| content.get("0"))
                        .and_then(Value::as_str)
                        .map(str::to_uppercase);
                    if let (Some(symbol), Some(bar)) =
                        (symbol, schwab::chart_bar_from_value(content))
                    {
                        counts.charts += 1;
                        let _ = inner
                            .chart_events
                            .send(SchwabStreamEvent::Chart { symbol, bar });
                    }
                }
                "LEVELONE_OPTIONS" => {
                    if let Some(option) = merge_sparse_option(option_state, content) {
                        counts.options += 1;
                        let _ = inner.events.send(SchwabStreamEvent::Option(option));
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn merge_sparse_option(
    option_state: &mut HashMap<String, Value>,
    content: &Value,
) -> Option<OptionContract> {
    let symbol = content
        .get("key")
        .or_else(|| content.get("0"))?
        .as_str()?
        .to_uppercase();
    let fields = option_state
        .entry(symbol.clone())
        .or_insert_with(|| json!({"key": symbol}));
    let target = fields.as_object_mut()?;
    for (key, value) in content.as_object()? {
        target.insert(key.clone(), value.clone());
    }
    schwab::streamed_option_from_value(fields)
}

struct MergedEquityUpdate {
    symbol: String,
    quote: Quote,
    tick: Option<(f64, f64, i64)>,
}

fn merge_sparse_quote(
    quote_state: &mut HashMap<String, Value>,
    content: &Value,
) -> Option<MergedEquityUpdate> {
    let symbol = content
        .get("key")
        .or_else(|| content.get("0"))?
        .as_str()?
        .to_uppercase();
    let fields = quote_state
        .entry(symbol.clone())
        .or_insert_with(|| json!({"key": symbol}));
    let target = fields.as_object_mut()?;
    for (key, value) in content.as_object()? {
        target.insert(key.clone(), value.clone());
    }
    let quote = schwab::streamed_quote_from_value(fields)?;
    let trade_changed = ["3", "8", "35"]
        .into_iter()
        .any(|field| content.get(field).is_some());
    let tick = trade_changed
        .then(|| {
            let price = fields.get("3")?.as_f64()?;
            let cumulative_volume = fields.get("8").and_then(Value::as_f64).unwrap_or_default();
            let time_ms = fields
                .get("35")
                .or_else(|| fields.get("34"))
                .and_then(Value::as_i64)
                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
            Some((price, cumulative_volume, time_ms.div_euclid(1_000)))
        })
        .flatten();
    Some(MergedEquityUpdate {
        symbol,
        quote,
        tick,
    })
}

fn login_succeeded(value: &Value) -> Result<bool, AppError> {
    for response in value
        .get("response")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if response.get("service").and_then(Value::as_str) == Some("ADMIN")
            && response.get("command").and_then(Value::as_str) == Some("LOGIN")
        {
            let code = response
                .pointer("/content/code")
                .and_then(Value::as_i64)
                .unwrap_or(-1);
            if code == 0 {
                return Ok(true);
            }
            return Err(AppError::Api(
                response
                    .pointer("/content/msg")
                    .and_then(Value::as_str)
                    .unwrap_or("Schwab Streamer login denied")
                    .into(),
            ));
        }
    }
    Ok(false)
}

fn request(
    info: &schwab::StreamerInfo,
    id: u64,
    service: &str,
    command: &str,
    parameters: Value,
) -> Value {
    json!({"requests":[request_entry(info, id, service, command, parameters)]})
}

fn request_entry(
    info: &schwab::StreamerInfo,
    id: u64,
    service: &str,
    command: &str,
    parameters: Value,
) -> Value {
    json!({
        "service":service,
        "command":command,
        "requestid":id.to_string(),
        "SchwabClientCustomerId":info.schwab_client_customer_id,
        "SchwabClientCorrelId":info.schwab_client_correl_id,
        "parameters":parameters
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    #[derive(Default)]
    struct CaptureSink(Vec<Message>);

    impl futures_util::Sink<Message> for CaptureSink {
        type Error = std::convert::Infallible;

        fn poll_ready(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(mut self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.0.push(item);
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn login_must_succeed_before_streaming() {
        assert!(!login_succeeded(&json!({"notify":[{"heartbeat":1}]})).unwrap());
        assert!(login_succeeded(
            &json!({"response":[{"service":"ADMIN","command":"LOGIN","content":{"code":0}}]})
        )
        .unwrap());
        assert!(login_succeeded(&json!({"response":[{"service":"ADMIN","command":"LOGIN","content":{"code":3,"msg":"denied"}}]})).is_err());
    }

    #[test]
    fn desired_symbols_are_uppercase_and_deduplicated() {
        let symbols =
            normalize_symbols([" aapl ".into(), "AAPL".into(), "spy".into(), "$vix".into()]);
        assert_eq!(
            symbols.into_iter().collect::<Vec<_>>(),
            vec!["$VIX", "AAPL", "SPY"]
        );
    }

    #[test]
    fn chart_symbols_are_always_included_in_level_one_equities() {
        let desired = DesiredSubscriptions {
            charts: BTreeSet::from(["$VIX".into(), "SPY".into(), "QQQ".into()]),
            quotes: BTreeSet::from(["AAPL".into(), "SPY".into()]),
            options: BTreeSet::new(),
        };
        assert_eq!(
            equity_subscription_symbols(&desired)
                .into_iter()
                .collect::<Vec<_>>(),
            vec!["$VIX", "AAPL", "QQQ", "SPY"],
        );
    }

    #[tokio::test]
    async fn changed_services_are_batched_into_one_subscription_message() {
        let info = schwab::StreamerInfo {
            streamer_socket_url: "wss://example.test".into(),
            schwab_client_customer_id: "customer".into(),
            schwab_client_correl_id: "correlation".into(),
            schwab_client_channel: "channel".into(),
            schwab_client_function_id: "function".into(),
        };
        let previous = DesiredSubscriptions::default();
        let next = DesiredSubscriptions {
            charts: BTreeSet::from(["$VIX".into(), "SPY".into()]),
            quotes: BTreeSet::from(["AAPL".into()]),
            options: BTreeSet::from(["SPY   260724C00750000".into()]),
        };
        let mut sink = CaptureSink::default();
        let mut request_id = 1;
        update_subscriptions(&mut sink, &info, &mut request_id, &previous, &next)
            .await
            .unwrap();
        assert_eq!(sink.0.len(), 1);
        let Message::Text(text) = &sink.0[0] else {
            panic!("expected text subscription request")
        };
        let payload: Value = serde_json::from_str(text.as_ref()).unwrap();
        let requests = payload["requests"].as_array().unwrap();
        assert_eq!(requests.len(), 3);
        let equities = requests
            .iter()
            .find(|item| item["service"] == "LEVELONE_EQUITIES")
            .unwrap();
        assert_eq!(equities["parameters"]["keys"], "$VIX,AAPL,SPY");
        assert!(equities["parameters"]["fields"]
            .as_str()
            .unwrap()
            .split(',')
            .any(|field| field == "35"));
    }

    #[test]
    fn sparse_option_updates_merge_into_a_complete_contract() {
        let mut state = HashMap::new();
        assert!(merge_sparse_option(
            &mut state,
            &json!({
                "key":"AAPL  260821C00200000","12":2026,"23":8,"26":21,"20":200.0,
                "21":"C","22":"AAPL","13":100.0,"29":0.02,"9":1200,"35":205.0
            })
        )
        .is_some());
        let option = merge_sparse_option(
            &mut state,
            &json!({
                "key":"AAPL  260821C00200000","29":0.025,"38":123456
            }),
        )
        .unwrap();
        assert_eq!(option.underlying, "AAPL");
        assert_eq!(option.gamma, 0.025);
        assert_eq!(option.open_interest, 1200.0);
        assert_eq!(option.expiration_date, "2026-08-21");
    }

    #[test]
    fn chart_consumers_are_isolated_from_option_traffic() {
        let streamer = SchwabStreamer::new(Schwab::new().unwrap());
        let mut general = streamer.subscribe();
        let mut charts = streamer.subscribe_chart();
        process_message(
            &streamer.inner,
            r#"{"data":[
                {"service":"LEVELONE_OPTIONS","content":[{"key":"AAPL  260821C00200000","12":2026,"23":8,"26":21,"20":200.0,"21":"C","22":"AAPL","13":100.0,"29":0.02,"9":1200,"35":205.0}]},
                {"service":"CHART_EQUITY","content":[{"key":"AAPL","1":205.0,"2":205.2,"3":204.9,"4":205.1,"5":1000,"6":1,"7":1784678340000,"8":20260721}]}
            ]}"#,
            &mut HashMap::new(),
            &mut HashMap::new(),
            &mut StreamCounts::default(),
        )
        .unwrap();
        assert!(matches!(
            general.try_recv(),
            Ok(SchwabStreamEvent::Option(_))
        ));
        assert!(
            matches!(charts.try_recv(), Ok(SchwabStreamEvent::Chart { symbol, .. }) if symbol == "AAPL")
        );
        assert!(matches!(
            charts.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn option_limit_rejection_downgrades_only_options_to_rest_only() {
        let streamer = SchwabStreamer::new(Schwab::new().unwrap());
        let mut receiver = streamer.subscribe();
        process_message(
            &streamer.inner,
            r#"{"response":[{"service":"LEVELONE_OPTIONS","command":"SUBS","content":{"code":19,"msg":"subscription limit exceeded"}}]}"#,
            &mut HashMap::new(),
            &mut HashMap::new(),
            &mut StreamCounts::default(),
        )
        .unwrap();
        match receiver.recv().await.unwrap() {
            SchwabStreamEvent::OptionState { state, message } => {
                assert_eq!(state, "rest-only");
                assert_eq!(message.as_deref(), Some("subscription limit exceeded"));
            }
            event => panic!("unexpected event: {event:?}"),
        }
    }

    #[tokio::test]
    async fn connection_state_replays_latest_status_to_late_consumers() {
        let streamer = SchwabStreamer::new(Schwab::new().unwrap());
        publish_state(&streamer.inner, "streaming", None).await;

        // A broadcast receiver created now cannot see the earlier event, so
        // new chart/quote tasks bootstrap from the retained state instead.
        let _late_receiver = streamer.subscribe();
        assert_eq!(
            streamer.connection_state().await,
            ("streaming".into(), None)
        );
    }

    #[test]
    fn sparse_quote_updates_replace_only_supplied_fields() {
        let mut state = HashMap::new();
        let initial = merge_sparse_quote(
            &mut state,
            &json!({"key":"AAPL","delayed":false,"1":210.0,"2":210.2,"3":210.1,"8":1000,"12":208.0,"35":1_784_592_000_000_i64}),
        )
        .unwrap();
        let update = merge_sparse_quote(
            &mut state,
            &json!({"key":"AAPL","1":210.05,"34":1_784_592_000_000_i64}),
        )
        .unwrap();
        assert_eq!(initial.quote.ask, update.quote.ask);
        assert_eq!(update.quote.bid, 210.05);
        assert_eq!(update.quote.last, 210.1);
        assert_eq!(initial.tick, Some((210.1, 1000.0, 1_784_592_000)));
        assert_eq!(update.tick, None);
    }

    #[test]
    fn trade_only_sparse_updates_emit_chart_ticks_from_merged_fields() {
        let streamer = SchwabStreamer::new(Schwab::new().unwrap());
        let mut charts = streamer.subscribe_chart();
        process_message(
            &streamer.inner,
            r#"{"data":[{"service":"LEVELONE_EQUITIES","content":[{"key":"SPY","3":748.1,"8":1000000,"12":745.0,"35":1784762475000}]}]}"#,
            &mut HashMap::new(),
            &mut HashMap::new(),
            &mut StreamCounts::default(),
        )
        .unwrap();
        assert!(matches!(
            charts.try_recv(),
            Ok(SchwabStreamEvent::EquityTick { symbol, price, cumulative_volume, time })
                if symbol == "SPY" && price == 748.1 && cumulative_volume == 1_000_000.0 && time == 1_784_762_475
        ));
    }
}
