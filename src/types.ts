export type TradingEnvironment = "sim" | "live";
export type ConnectionState = "demo" | "connecting" | "live" | "stale" | "disconnected" | "auth-required";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "D" | "W" | "M";
export type ChartKind = "candles" | "line" | "area";
export type OrderType = "Market" | "Limit" | "StopMarket" | "StopLimit";
export type ChartTimezone = "exchange" | "local" | "UTC" | "America/New_York" | "America/Chicago" | "America/Denver" | "America/Los_Angeles" | "Europe/London" | "Asia/Tokyo";
export type StreamConnectionState = "connecting" | "streaming" | "stale" | "reconnecting" | "disconnected" | "rate-limited";

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
  receivedAt?: number;
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
  root?: string;
  underlying?: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: "Long" | "Short";
  quantity: number;
  averagePrice: number;
  last: number;
  unrealizedPnl: number;
  bid?: number;
  ask?: number;
  unrealizedPnlPercent?: number;
  unrealizedPnlQuantity?: number;
  initialRequirement?: number;
  maintenanceMargin?: number;
  marketValue?: number;
  timestamp?: string;
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
  accountId?: string;
  filledQuantity?: number;
  remainingQuantity?: number;
  averageFillPrice?: number;
  duration?: string;
  closedAt?: string;
  commission?: number;
  stopLoss?: number;
  takeProfit?: number;
  rawStatus?: string;
  statusDescription?: string;
  openOrClose?: "Open" | "Close";
  groupName?: string;
  relatedOrders?: Array<{ orderId: string; relationship: string }>;
}

export interface ClosePositionResult {
  positionId: string;
  symbol: string;
  cancelledOrderIds: string[];
  flattenOrder: OrderUpdate | null;
  error?: string;
}

export interface AccountBalance {
  accountId: string;
  accountType: string;
  currency: string;
  cashBalance?: number;
  buyingPower?: number;
  equity?: number;
  marketValue?: number;
  todaysProfitLoss?: number;
  unrealizedProfitLoss?: number;
  unclearedDeposit?: number;
  commission?: number;
  initialMargin?: number;
  maintenanceMargin?: number;
  openOrderMargin?: number;
}

export interface BodBalance extends AccountBalance {
  balanceDate?: string;
}

export interface HistoricalOrderPage { orders: OrderUpdate[]; nextToken?: string; }
export interface ActivityNotification { id: string; symbol?: string; time: string; title: string; text: string; level?: "info" | "success" | "warning" | "error"; }

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

export type EntryRuleSide = "long" | "short";

export type EntryRuleOperand =
  | { kind: "marketPrice" }
  | { kind: "movingAverage"; average: "EMA" | "SMA"; period: number };

export interface EntryRuleCondition {
  id: string;
  kind: "condition";
  left: EntryRuleOperand;
  operator: "above" | "below";
  right: EntryRuleOperand;
}

export interface EntryRuleGroup {
  id: string;
  kind: "group";
  combinator: "and" | "or";
  children: EntryRuleNode[];
}

export type EntryRuleNode = EntryRuleCondition | EntryRuleGroup;

export interface EntryRules {
  long: EntryRuleGroup;
  short: EntryRuleGroup;
}

export interface EntryRuleResult {
  allowed: boolean;
  status: "allowed" | "blocked" | "waiting";
  reason: string;
  nodeResults: Record<string, boolean | null>;
}

export interface Drawing {
  id: string;
  kind: "trend" | "horizontal" | "horizontal-ray" | "ray" | "rectangle" | "fibonacci" | "text";
  points: Array<{ time: number; price: number }>;
  text?: string;
  color: string;
  locked?: boolean;
  lineWidth?: 1 | 2 | 3 | 4;
}

export interface ChartTabState {
  id: string;
  symbol: SymbolMeta;
  timeframe: Timeframe;
  chartKind: ChartKind;
  indicators: IndicatorConfig[];
  chartTimezone: ChartTimezone;
  magnetEnabled: boolean;
  /** Concrete contract override for a continuous chart. Undefined means Auto. */
  tradeContract?: string;
}

export interface ChartWindowState {
  id: string;
  tabIds: string[];
  activeTabId: string;
  detached: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface WorkspaceState {
  revision: number;
  tabs: ChartTabState[];
  windows: ChartWindowState[];
  watchlist: string[];
  drawings: Record<string, Drawing[]>;
  rightTab: "order" | "watchlist";
  rightPanelOpen: boolean;
  bottomTab: "positions" | "orders" | "history" | "summary" | "notifications";
  bottomPanelOpen: boolean;
  bottomPanelHeight?: number;
  selectedAccountId?: string;
  confirmOrders: boolean;
  entryRules: EntryRules;
}

export interface BarSnapshotEvent {
  subscriptionId: string;
  environment: TradingEnvironment;
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
}

export interface BarUpdateEvent extends Omit<BarSnapshotEvent, "bars"> { bar: Bar; }
export interface QuoteUpdateEvent { subscriptionId: string; environment: TradingEnvironment; quote: Quote; }
export interface StreamStateEvent { subscriptionId: string; environment: TradingEnvironment; channel: "bars" | "quotes"; state: StreamConnectionState; message?: string; }
