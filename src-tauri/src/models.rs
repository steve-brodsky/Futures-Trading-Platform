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
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthStatus {
    pub configured: bool,
    pub authenticated: bool,
}
