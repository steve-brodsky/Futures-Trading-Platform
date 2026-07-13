use serde::{Deserialize, Serialize};

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
    pub environment: TradingEnvironment,
    pub symbol: String,
    pub timeframe: String,
    pub bars: Vec<Bar>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarUpdateEvent {
    pub subscription_id: String,
    pub environment: TradingEnvironment,
    pub symbol: String,
    pub timeframe: String,
    pub bar: Bar,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteUpdateEvent {
    pub subscription_id: String,
    pub environment: TradingEnvironment,
    pub quote: Quote,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStateEvent {
    pub subscription_id: String,
    pub environment: TradingEnvironment,
    pub channel: String,
    pub state: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerageUpdateEvent {
    pub account_id: String,
    pub channel: String,
    pub data: serde_json::Value,
}
