use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, Notify, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::{models::Quote, schwab, schwab::Schwab, AppError};

const EQUITY_FIELDS: &str = "0,1,2,3,8,12,18,32,33,34,42";
const CHART_FIELDS: &str = "0,1,2,3,4,5,6,7,8";

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
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct DesiredSubscriptions {
    charts: BTreeSet<String>,
    quotes: BTreeSet<String>,
}

struct Inner {
    api: Schwab,
    desired: RwLock<DesiredSubscriptions>,
    connection_state: RwLock<SchwabConnectionState>,
    changed: Notify,
    events: broadcast::Sender<SchwabStreamEvent>,
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
                task: Mutex::new(None),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SchwabStreamEvent> {
        self.inner.events.subscribe()
    }

    pub async fn connection_state(&self) -> (String, Option<String>) {
        let current = self.inner.connection_state.read().await;
        (current.state.clone(), current.message.clone())
    }

    pub async fn set_chart_symbols(&self, symbols: impl IntoIterator<Item = String>) {
        let next = normalize_symbols(symbols);
        let mut desired = self.inner.desired.write().await;
        if desired.charts != next {
            desired.charts = next;
            drop(desired);
            self.ensure_running().await;
            self.inner.changed.notify_one();
        }
    }

    pub async fn set_quote_symbols(&self, symbols: impl IntoIterator<Item = String>) {
        let next = normalize_symbols(symbols);
        let mut desired = self.inner.desired.write().await;
        if desired.quotes != next {
            desired.quotes = next;
            drop(desired);
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

async fn publish_state(inner: &Inner, state: &str, message: Option<String>) {
    *inner.connection_state.write().await = SchwabConnectionState {
        state: state.into(),
        message: message.clone(),
    };
    let _ = inner.events.send(SchwabStreamEvent::State {
        state: state.into(),
        message,
    });
}

fn normalize_symbols(symbols: impl IntoIterator<Item = String>) -> BTreeSet<String> {
    symbols
        .into_iter()
        .map(|symbol| symbol.trim().to_uppercase())
        .filter(|symbol| !symbol.is_empty())
        .take(100)
        .collect()
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
    let (socket, _) = connect_async(&info.streamer_socket_url)
        .await
        .map_err(|error| AppError::Api(format!("Schwab Streamer connection failed: {error}")))?;
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
    loop {
        tokio::select! {
            _ = &mut timeout => return Err(AppError::Api("Schwab Streamer heartbeat timed out".into())),
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
                    Message::Text(text) => process_message(&inner, text.as_ref(), &mut quote_state)?,
                    Message::Ping(payload) => write.send(Message::Pong(payload)).await.map_err(|error| AppError::Api(error.to_string()))?,
                    Message::Close(_) => return Err(AppError::Api("Schwab Streamer closed".into())),
                    _ => {}
                }
            }
        }
    }
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
        write
            .send(Message::Text(
                request(
                    info,
                    *request_id,
                    "CHART_EQUITY",
                    command,
                    json!({"keys":keys.join(","),"fields":CHART_FIELDS}),
                )
                .to_string()
                .into(),
            ))
            .await
            .map_err(|error| AppError::Api(error.to_string()))?;
    }
    if previous.quotes != next.quotes {
        *request_id += 1;
        let (command, keys) = if next.quotes.is_empty() {
            (
                "UNSUBS",
                previous.quotes.iter().cloned().collect::<Vec<_>>(),
            )
        } else {
            ("SUBS", next.quotes.iter().cloned().collect::<Vec<_>>())
        };
        write
            .send(Message::Text(
                request(
                    info,
                    *request_id,
                    "LEVELONE_EQUITIES",
                    command,
                    json!({"keys":keys.join(","),"fields":EQUITY_FIELDS}),
                )
                .to_string()
                .into(),
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
) -> Result<(), AppError> {
    let value: Value = serde_json::from_str(text)?;
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
                    if let Some(quote) = merge_sparse_quote(quote_state, content) {
                        let _ = inner.events.send(SchwabStreamEvent::Quote(quote));
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
                        let _ = inner.events.send(SchwabStreamEvent::Chart { symbol, bar });
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn merge_sparse_quote(quote_state: &mut HashMap<String, Value>, content: &Value) -> Option<Quote> {
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
    schwab::streamed_quote_from_value(fields)
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
    json!({"requests":[{
        "service":service,
        "command":command,
        "requestid":id.to_string(),
        "SchwabClientCustomerId":info.schwab_client_customer_id,
        "SchwabClientCorrelId":info.schwab_client_correl_id,
        "parameters":parameters
    }]})
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let symbols = normalize_symbols([" aapl ".into(), "AAPL".into(), "spy".into()]);
        assert_eq!(symbols.into_iter().collect::<Vec<_>>(), vec!["AAPL", "SPY"]);
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
            &json!({"key":"AAPL","delayed":false,"1":210.0,"2":210.2,"3":210.1,"12":208.0}),
        )
        .unwrap();
        let update = merge_sparse_quote(
            &mut state,
            &json!({"key":"AAPL","1":210.05,"34":1_784_592_000_000_i64}),
        )
        .unwrap();
        assert_eq!(initial.ask, update.ask);
        assert_eq!(update.bid, 210.05);
        assert_eq!(update.last, 210.1);
    }
}
