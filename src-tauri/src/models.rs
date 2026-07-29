use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum MarketDataProvider {
    #[default]
    Tradestation,
    Schwab,
}

impl MarketDataProvider {
    pub fn key(&self) -> &'static str {
        match self {
            Self::Tradestation => "tradestation",
            Self::Schwab => "schwab",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TradingEnvironment {
    #[default]
    Sim,
    Live,
}

impl TradingEnvironment {
    pub fn base_url(&self) -> &'static str {
        match self {
            Self::Sim => "https://sim-api.tradestation.com/v3",
            Self::Live => "https://api.tradestation.com/v3",
        }
    }

    pub fn key(&self) -> &'static str {
        match self {
            Self::Sim => "sim",
            Self::Live => "live",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub display_id: String,
    pub account_type: String,
    pub status: String,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMeta {
    #[serde(default)]
    pub provider: MarketDataProvider,
    pub symbol: String,
    pub description: String,
    pub exchange: String,
    pub asset_type: String,
    pub min_move: f64,
    pub point_value: f64,
    pub expiration: Option<String>,
    pub root: Option<String>,
    pub underlying: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bar {
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub realtime: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    #[serde(default)]
    pub provider: MarketDataProvider,
    pub symbol: String,
    pub last: f64,
    pub bid: f64,
    pub ask: f64,
    pub change: f64,
    pub change_pct: f64,
    pub delayed: bool,
    pub halted: bool,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptionExpiration {
    pub expiration_date: String,
    pub days_to_expiration: i64,
    pub expiration_type: String,
    pub standard: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptionContract {
    pub symbol: String,
    pub underlying: String,
    pub put_call: String,
    pub expiration_date: String,
    pub strike_price: f64,
    pub multiplier: f64,
    pub gamma: f64,
    pub open_interest: f64,
    pub bid_price: f64,
    pub ask_price: f64,
    pub mark_price: f64,
    pub total_volume: f64,
    pub volatility: f64,
    pub delta: f64,
    pub underlying_price: f64,
    pub quote_time: i64,
    pub delayed: bool,
    pub is_mini: bool,
    pub is_non_standard: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptionChainSnapshot {
    pub symbol: String,
    pub underlying_price: f64,
    pub delayed: bool,
    pub fetched_at: String,
    pub contracts: Vec<OptionContract>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub id: String,
    pub symbol: String,
    pub side: String,
    pub quantity: f64,
    pub average_price: f64,
    pub last: f64,
    pub unrealized_pnl: f64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub unrealized_pnl_percent: Option<f64>,
    pub unrealized_pnl_quantity: Option<f64>,
    pub initial_requirement: Option<f64>,
    pub maintenance_margin: Option<f64>,
    pub market_value: Option<f64>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDraft {
    pub account_id: String,
    pub symbol: String,
    pub side: String,
    #[serde(rename = "type")]
    pub order_type: String,
    pub quantity: u32,
    pub limit_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub duration: String,
    pub take_profit: Option<f64>,
    pub stop_loss: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderPreview {
    pub valid: bool,
    pub summary: String,
    pub estimated_commission: Option<String>,
    pub initial_margin: Option<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderUpdate {
    pub id: String,
    pub symbol: String,
    pub side: String,
    #[serde(rename = "type")]
    pub order_type: String,
    pub quantity: u32,
    pub price: Option<f64>,
    pub stop_price: Option<f64>,
    pub status: String,
    pub timestamp: String,
    pub account_id: Option<String>,
    pub filled_quantity: Option<f64>,
    pub remaining_quantity: Option<f64>,
    pub average_fill_price: Option<f64>,
    pub duration: Option<String>,
    pub closed_at: Option<String>,
    pub commission: Option<f64>,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub raw_status: Option<String>,
    pub status_description: Option<String>,
    pub open_or_close: Option<String>,
    pub group_name: Option<String>,
    pub related_orders: Vec<RelatedOrder>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedOrder {
    pub order_id: String,
    pub relationship: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosePositionResult {
    pub position_id: String,
    pub symbol: String,
    pub cancelled_order_ids: Vec<String>,
    pub flatten_order: Option<OrderUpdate>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerOutcome {
    Confirmed,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalPersistenceStatus {
    Complete,
    Pending,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationStatus {
    NotRequired,
    Required,
    Reconciling,
    Reconciled,
    ManualReviewRequired,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerMutationResult {
    pub mutation_id: String,
    pub broker_outcome: BrokerOutcome,
    pub local_persistence: LocalPersistenceStatus,
    pub reconciliation_status: ReconciliationStatus,
    pub warnings: Vec<String>,
    pub broker_order: Option<OrderUpdate>,
    pub close_result: Option<ClosePositionResult>,
    pub rejection_reason: Option<String>,
    pub retry_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillSwitchItemResult {
    pub item_type: String,
    pub item_id: String,
    pub symbol: Option<String>,
    pub result: BrokerMutationResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillSwitchResult {
    pub environment: TradingEnvironment,
    pub account_id: String,
    pub cancelled_orders: Vec<KillSwitchItemResult>,
    pub flattened_positions: Vec<KillSwitchItemResult>,
    pub already_flat: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBalance {
    pub account_id: String,
    pub account_type: String,
    pub currency: String,
    pub cash_balance: Option<f64>,
    pub buying_power: Option<f64>,
    pub equity: Option<f64>,
    pub market_value: Option<f64>,
    pub todays_profit_loss: Option<f64>,
    pub realized_profit_loss: Option<f64>,
    pub unrealized_profit_loss: Option<f64>,
    pub uncleared_deposit: Option<f64>,
    pub commission: Option<f64>,
    pub initial_margin: Option<f64>,
    pub maintenance_margin: Option<f64>,
    pub open_order_margin: Option<f64>,
    pub balance_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalOrderPage {
    pub orders: Vec<OrderUpdate>,
    pub next_token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthStatus {
    pub configured: bool,
    pub authenticated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarSnapshotEvent {
    pub subscription_id: String,
    pub provider: MarketDataProvider,
    pub environment: TradingEnvironment,
    pub symbol: String,
    pub timeframe: String,
    pub generation: u64,
    pub bars: Vec<Bar>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarUpdateEvent {
    pub subscription_id: String,
    pub provider: MarketDataProvider,
    pub environment: TradingEnvironment,
    pub symbol: String,
    pub timeframe: String,
    pub generation: u64,
    pub bar: Bar,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteUpdateEvent {
    pub subscription_id: String,
    pub provider: MarketDataProvider,
    pub environment: TradingEnvironment,
    pub environment_generation: u64,
    pub quote: Quote,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionUpdateEvent {
    pub subscription_id: String,
    pub environment_generation: u64,
    pub contract: OptionContract,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionStreamStateEvent {
    pub subscription_id: String,
    pub symbol: String,
    pub environment_generation: u64,
    pub state: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStateEvent {
    pub subscription_id: String,
    pub provider: MarketDataProvider,
    pub environment: TradingEnvironment,
    pub environment_generation: u64,
    pub channel: String,
    pub state: String,
    pub message: Option<String>,
    pub symbol: Option<String>,
    pub timeframe: Option<String>,
    pub generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionsSnapshotEvent {
    pub account_id: String,
    pub environment_generation: u64,
    pub positions: Vec<Position>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionUpdateEvent {
    pub account_id: String,
    pub environment_generation: u64,
    pub position: Position,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdersSnapshotEvent {
    pub account_id: String,
    pub environment_generation: u64,
    pub orders: Vec<OrderUpdate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStreamUpdateEvent {
    pub account_id: String,
    pub environment_generation: u64,
    pub order: OrderUpdate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerageStreamStateEvent {
    pub account_id: String,
    pub environment_generation: u64,
    pub channel: String,
    pub state: String,
    pub message: Option<String>,
}
