export type TradingEnvironment = "sim" | "live";
export type MarketDataProvider = "tradestation" | "schwab";
export type ConnectionState = "demo" | "connecting" | "live" | "stale" | "disconnected" | "auth-required";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "D" | "W" | "M";
export type AlertSound = "chime" | "bell" | "pulse" | "siren";
export type AlertDurationSeconds = 1 | 3 | 5 | 10;
export type ChartKind = "candles" | "line" | "area" | "renko" | "point-and-figure";
export type ChartLayout = "single" | "two-columns" | "two-rows" | "three-columns" | "three-rows" | "four-grid";
export type ChartSplitRatios = Partial<Record<ChartLayout, number[]>>;
export type SyntheticPriceSource = "close" | "high-low";
export type OrderType = "Market" | "Limit" | "StopMarket" | "StopLimit";
export type ChartTimezone = "exchange" | "local" | "UTC" | "America/New_York" | "America/Chicago" | "America/Denver" | "America/Los_Angeles" | "Europe/London" | "Asia/Tokyo";
export type StreamConnectionState = "connecting" | "streaming" | "stale" | "reconnecting" | "disconnected" | "rate-limited";
export type BarStreamConsumer = "chart" | "ema-alert" | "vwap";

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
  provider: MarketDataProvider;
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

export interface OptionExpiration {
  expirationDate: string;
  daysToExpiration: number;
  expirationType: string;
  standard: boolean;
}

export interface OptionContract {
  symbol: string;
  underlying: string;
  putCall: "CALL" | "PUT";
  expirationDate: string;
  strikePrice: number;
  multiplier: number;
  gamma: number;
  openInterest: number;
  bidPrice: number;
  askPrice: number;
  markPrice: number;
  totalVolume: number;
  volatility: number;
  delta: number;
  underlyingPrice: number;
  quoteTime: number;
  delayed: boolean;
  isMini: boolean;
  isNonStandard: boolean;
}

export interface OptionChainSnapshot {
  symbol: string;
  underlyingPrice: number;
  delayed: boolean;
  fetchedAt: string;
  contracts: OptionContract[];
}

export type GexView = "net" | "calls-puts" | "open-interest";
export type GexExpirationDisplay = "aggregate" | "aggregate-strip";
export type GexExpirationMode = "front" | "next-four" | "all" | "custom";

export interface GexTabSettings {
  enabled: boolean;
  view: GexView;
  expirationDisplay: GexExpirationDisplay;
}

export interface GexExpirationSelection {
  mode: GexExpirationMode;
  expirationDates: string[];
}

export interface Account {
  id: string;
  displayId: string;
  accountType: string;
  status: string;
  currency: string;
}

export interface SymbolMeta {
  provider: MarketDataProvider;
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
  realizedProfitLoss?: number;
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
  kind: "SMA" | "EMA" | "VWAP";
  period: number;
  color: string;
  visible: boolean;
}

export interface TimeframeAlertConfig {
  enabled: boolean;
  sound: AlertSound;
  durationSeconds: AlertDurationSeconds;
}

export type Ema200AlertConfig = Record<Timeframe, TimeframeAlertConfig>;

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

export interface EntryRuleEmaCrossCondition {
  id: string;
  kind: "emaCross";
  direction: "above" | "below" | "either";
  period: number;
  lookback: number;
}

export interface EntryRuleGroup {
  id: string;
  kind: "group";
  combinator: "and" | "or";
  children: EntryRuleNode[];
}

export type EntryRuleNode = EntryRuleCondition | EntryRuleEmaCrossCondition | EntryRuleGroup;

export interface EntryRules {
  long: EntryRuleGroup;
  short: EntryRuleGroup;
}

export type EntryRuleAlertConfig = Record<EntryRuleSide, TimeframeAlertConfig>;

export interface EntryRuleResult {
  allowed: boolean;
  status: "allowed" | "blocked" | "waiting";
  reason: string;
  nodeResults: Record<string, boolean | null>;
}

export type ChartTool = "cursor" | "horizontal" | "horizontal-ray" | "long-position" | "short-position";

export interface LineDrawing {
  id: string;
  kind: "trend" | "horizontal" | "horizontal-ray" | "ray" | "rectangle" | "fibonacci" | "text";
  points: Array<{ time: number; price: number }>;
  text?: string;
  color: string;
  locked?: boolean;
  lineWidth?: 1 | 2 | 3 | 4;
}

export interface PositionDrawing {
  id: string;
  kind: "position";
  side: "long" | "short";
  startTime: number;
  endTime: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  quantity: number;
  locked?: boolean;
}

export type Drawing = LineDrawing | PositionDrawing;

export interface DrawingPatch {
  points?: Array<{ time: number; price: number }>;
  text?: string;
  color?: string;
  locked?: boolean;
  lineWidth?: 1 | 2 | 3 | 4;
  side?: "long" | "short";
  startTime?: number;
  endTime?: number;
  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  quantity?: number;
}

export interface ChartTabState {
  id: string;
  symbol: SymbolMeta;
  timeframe: Timeframe;
  chartKind: ChartKind;
  renkoSettings: RenkoSettings;
  pointAndFigureSettings: PointAndFigureSettings;
  indicators: IndicatorConfig[];
  ema200Alert: Ema200AlertConfig;
  chartTimezone: ChartTimezone;
  magnetEnabled: boolean;
  gex: GexTabSettings;
  /** Concrete contract override for a continuous chart. Undefined means Auto. */
  tradeContract?: string;
}

export interface ChartWindowState {
  id: string;
  tabIds: string[];
  activeTabId: string;
  detached: boolean;
  /** Visible chart tabs, ordered by their pane position. Legacy saves omit this. */
  visibleTabIds?: string[];
  /** Saved pane arrangement. Legacy saves omit this and normalize to a single chart. */
  chartLayout?: ChartLayout;
  /** Device-local divider positions, keyed by layout. */
  splitRatios?: ChartSplitRatios;
  maximized?: boolean;
  /** Legacy logical-pixel geometry retained for backward compatibility. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Exact desktop geometry used to restore windows across mixed-DPI monitors. */
  physicalX?: number;
  physicalY?: number;
  physicalWidth?: number;
  physicalHeight?: number;
}

export interface RenkoSettings {
  brickSizeTicks: number;
  priceSource: SyntheticPriceSource;
  reversalBricks: 1 | 2;
}

export interface PointAndFigureSettings {
  boxSizeTicks: number;
  priceSource: SyntheticPriceSource;
  reversalBoxes: number;
}

export interface ChartLabelSettings {
  showEma200TabDots: boolean;
  showDollarAmount: boolean;
  showRMultiple: boolean;
  fontSize: number;
}

export interface OrderTicketSettings {
  swingStopPivotBars: 2 | 3;
  swingStopOffsetTicks: number;
  sizingMode: "contracts" | "risk";
  riskSizingPolicy: "strict" | "minimum-one";
  riskAmount?: number;
}

export interface WorkspaceSettings {
  chartLabels: ChartLabelSettings;
  orderTicket: OrderTicketSettings;
  journal: {
    commissionPerContractSide: number;
  };
}

export interface WorkspaceState {
  revision: number;
  environment: TradingEnvironment;
  tabs: ChartTabState[];
  windows: ChartWindowState[];
  watchlist: SymbolMeta[];
  recentSymbols: SymbolMeta[];
  drawings: Record<string, Drawing[]>;
  gexSelections: Record<string, GexExpirationSelection>;
  rightPanelOpen: boolean;
  bottomTab: "positions" | "orders" | "history" | "summary" | "notifications";
  bottomPanelOpen: boolean;
  bottomPanelHeight?: number;
  selectedAccountId?: string;
  confirmOrders: boolean;
  entryRules: EntryRules;
  entryRuleAlerts: EntryRuleAlertConfig;
  settings: WorkspaceSettings;
}

export type CloudPreferenceCategory =
  | "chart_workspace"
  | "alerts"
  | "drawings"
  | "watchlist"
  | "chart_display"
  | "order_entry"
  | "journal_fees";

export interface CloudPreferenceProfile {
  schemaVersion: 1;
  categories: Record<CloudPreferenceCategory, Record<string, unknown>>;
}

export interface CloudPreferenceRecord {
  category: CloudPreferenceCategory;
  schemaVersion: 1;
  payload: Record<string, unknown>;
  revision: number;
  mutationId: string;
  deviceId: string;
  serverUpdatedAt: string;
}

export interface PreferenceSyncResult {
  state: "synced" | "offline" | "error";
  records: CloudPreferenceRecord[];
  replacedCategories: CloudPreferenceCategory[];
  conflictedCategories: CloudPreferenceCategory[];
  lastSyncedAt?: string;
  message?: string;
}

export interface PreferenceRealtimeStateEvent {
  state: "disabled" | "connecting" | "connected" | "reconnecting";
  message?: string;
}

export interface BarSnapshotEvent {
  subscriptionId: string;
  provider: MarketDataProvider;
  environment: TradingEnvironment;
  symbol: string;
  timeframe: Timeframe;
  generation: number;
  bars: Bar[];
}

export interface BarUpdateEvent extends Omit<BarSnapshotEvent, "bars"> { bar: Bar; }
export interface QuoteUpdateEvent { subscriptionId: string; provider: MarketDataProvider; environment: TradingEnvironment; quote: Quote; }
export interface OptionUpdateEvent { subscriptionId: string; contract: OptionContract; }
export interface OptionStreamStateEvent { subscriptionId: string; symbol: string; state: StreamConnectionState | "rest-only" | "error"; message?: string; }
export interface StreamStateEvent {
  subscriptionId: string;
  provider: MarketDataProvider;
  environment: TradingEnvironment;
  channel: "bars" | "quotes";
  state: StreamConnectionState;
  message?: string;
  symbol?: string;
  timeframe?: Timeframe;
  generation?: number;
}
export interface PositionsSnapshotEvent { accountId: string; positions: Position[]; }
export interface PositionUpdateEvent { accountId: string; position: Position; }
export interface OrdersSnapshotEvent { accountId: string; orders: OrderUpdate[]; }
export interface OrderStreamUpdateEvent { accountId: string; order: OrderUpdate; }
export interface BrokerageStreamStateEvent { accountId: string; channel: "positions" | "orders"; state: StreamConnectionState; message?: string; }

export type RiskProvenance = "exact" | "inferred" | "unknown";
export type JournalTradeStatus = "open" | "closed";
export type JournalEventType =
  | "entry-intent"
  | "risk-added"
  | "order-observed"
  | "fill"
  | "stop-move"
  | "target-move"
  | "close-intent"
  | "cancel-intent"
  | "unmatched-close"
  | "order-rejected";

export interface JournalScope {
  environment: TradingEnvironment;
  accountId: string;
  accountLabel: string;
}

export interface JournalAuthStatus {
  configured: boolean;
  authenticated: boolean;
  email?: string;
  projectUrl?: string;
  backfillStart?: string;
  recordFrom?: string;
  error?: string;
}

export interface JournalSyncStatus {
  state: "idle" | "syncing" | "synced" | "offline" | "error";
  pendingEvents: number;
  lastSyncedAt?: string;
  message?: string;
}

export interface JournalEvent {
  id: string;
  tradeId?: string;
  brokerOrderId?: string;
  eventType: JournalEventType;
  occurredAt: string;
  source: "northstar" | "broker-stream" | "broker-history";
  status?: "requested" | "confirmed" | "failed";
  oldPrice?: number;
  newPrice?: number;
  quantity?: number;
  price?: number;
  note?: string;
}

export interface JournalAnnotation {
  tradeId: string;
  notes: string;
  tags: string[];
  updatedAt?: string;
}

export interface JournalScreenshotMetadata {
  tradeId: string;
  capturedAt: string;
  width: number;
  height: number;
  contentType: "image/png";
}

export interface JournalScreenshotImage extends JournalScreenshotMetadata {
  dataUrl: string;
}

export interface JournalTrade {
  id: string;
  environment: TradingEnvironment;
  accountId: string;
  symbol: string;
  direction: "Long" | "Short";
  status: JournalTradeStatus;
  openedAt: string;
  closedAt?: string;
  entryQuantity: number;
  exitQuantity: number;
  averageEntry: number;
  averageExit?: number;
  originalStop?: number;
  originalTarget?: number;
  plannedRisk?: number;
  deployedRisk?: number;
  pointValue?: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  rMultiple?: number;
  riskProvenance: RiskProvenance;
  notes: string;
  tags: string[];
  events?: JournalEvent[];
  entryScreenshot?: JournalScreenshotMetadata;
}

export interface JournalSummaryMetrics {
  netPnl: number;
  grossPnl: number;
  fees: number;
  trades: number;
  closedTrades: number;
  winRate?: number;
  totalR?: number;
  averageTrade?: number;
  profitFactor?: number;
  longTrades: number;
  shortTrades: number;
}

export interface JournalCalendarDay {
  date: string;
  trades: number;
  closedTrades: number;
  netPnl: number;
  totalR?: number;
}

export interface JournalMonthSummary {
  scope: JournalScope;
  year: number;
  month: number;
  metrics: JournalSummaryMetrics;
  days: JournalCalendarDay[];
}

export interface JournalDaySummary {
  scope: JournalScope;
  date: string;
  metrics: JournalSummaryMetrics;
  trades: JournalTrade[];
}
