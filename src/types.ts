export type TradingEnvironment = "sim" | "live";
export type ConnectionState = "demo" | "connecting" | "live" | "stale" | "disconnected" | "auth-required";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "D" | "W" | "M";
export type ChartKind = "candles" | "line" | "area";
export type OrderType = "Market" | "Limit" | "StopMarket" | "StopLimit";

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  realtime?: boolean;
}

export interface Quote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  change: number;
  changePct: number;
  delayed: boolean;
  halted: boolean;
  timestamp: string;
}

export interface Account {
  id: string;
  displayId: string;
  accountType: string;
  status: string;
  currency: string;
}

export interface SymbolMeta {
  symbol: string;
  description: string;
  exchange: string;
  assetType: string;
  minMove: number;
  pointValue: number;
  expiration?: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: "Long" | "Short";
  quantity: number;
  averagePrice: number;
  last: number;
  unrealizedPnl: number;
}

export interface OrderUpdate {
  id: string;
  symbol: string;
  side: "Buy" | "Sell";
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  status: "Working" | "Filled" | "Cancelled" | "Rejected" | "Pending" | "Indeterminate";
  timestamp: string;
}

export interface OrderDraft {
  accountId: string;
  symbol: string;
  side: "Buy" | "Sell";
  type: OrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  duration: "DAY" | "GTC";
  takeProfit?: number;
  stopLoss?: number;
}

export interface OrderPreview {
  valid: boolean;
  summary: string;
  estimatedCommission?: string;
  initialMargin?: string;
  errors: string[];
}

export interface IndicatorConfig {
  id: string;
  kind: "SMA" | "EMA" | "VWAP" | "RSI" | "MACD";
  period: number;
  color: string;
  visible: boolean;
}

export interface Drawing {
  id: string;
  kind: "trend" | "horizontal" | "ray" | "rectangle" | "fibonacci" | "text";
  points: Array<{ time: number; price: number }>;
  text?: string;
  color: string;
}

export interface WorkspaceState {
  symbol: SymbolMeta;
  timeframe: Timeframe;
  chartKind: ChartKind;
  indicators: IndicatorConfig[];
  watchlist: string[];
  rightTab: "order" | "watchlist";
  bottomTab: "positions" | "orders" | "history" | "fills" | "balances";
}
