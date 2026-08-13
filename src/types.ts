export type TradingEnvironment = "sim" | "live";
export type MarketDataProvider = "tradestation" | "schwab";
export type ConnectionState = "demo" | "connecting" | "live" | "stale" | "disconnected" | "auth-required";
export type MinuteTimeframe = `${number}m`;
export type Timeframe = MinuteTimeframe | "1h" | "4h" | "D" | "W" | "M";
export type AlertTimeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "D" | "W" | "M";
export type AlertSound = "chime" | "bell" | "pulse" | "siren";
export type AlertDurationSeconds = 1 | 3 | 5 | 10;
export type DrawingAlertDirection = "either" | "above" | "below";
export type DrawingAlertFrequency = "once" | "recurring";
export type ChartKind = "candles" | "line" | "area" | "renko" | "point-and-figure";
export type ChartLayout = "single" | "two-columns" | "two-rows" | "three-columns" | "three-rows" | "four-grid";
export type ChartSplitRatios = Partial<Record<ChartLayout, number[]>>;
export type SyntheticPriceSource = "close" | "high-low";
export type OrderType = "Market" | "Limit" | "StopMarket" | "StopLimit";
export type ChartTimezone = "exchange" | "local" | "UTC" | "America/New_York" | "America/Chicago" | "America/Denver" | "America/Los_Angeles" | "Europe/London" | "Asia/Tokyo";
export type StreamConnectionState = "connecting" | "streaming" | "stale" | "reconnecting" | "disconnected" | "rate-limited";
export type BarStreamConsumer = "chart" | "ema-alert" | "vwap" | "truth-social-alert" | "swing-trail";

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

export interface TruthSocialAlertSettings {
  enabled: boolean;
}

export interface TruthSocialPost {
  id: string;
  publishedAt: string;
  text: string;
  imageUrl?: string;
  postUrl: string;
  handle: string;
  platform: "Truth Social";
  deleted: boolean;
  isRepost: boolean;
}

export interface RapidMarketMove {
  provider: MarketDataProvider;
  symbol: string;
  direction: "up" | "down";
  startedAt: number;
  occurredAt: number;
  startPrice: number;
  endPrice: number;
  changePct: number;
  volatilityMultiple: number;
}

export type TradingTodaySnapshotStatus = "live" | "cache" | "demo";
export type EconomicEventImportance = 1 | 2 | 3 | null;
export type MarketHolidayVenue = "NYSE" | "CME";
export type MarketHolidayStatus = "closed" | "early-close" | "modified-hours";

export interface EconomicEvent {
  id: string;
  occursAt: string;
  title: string;
  reference?: string;
  importance: EconomicEventImportance;
  actual?: string;
  consensus?: string;
  previous?: string;
  forecast?: string;
  url?: string;
}

export interface MarketHolidayVenueStatus {
  venue: MarketHolidayVenue;
  status: MarketHolidayStatus;
  detail: string;
  sourceUrl: string;
}

export interface MarketHoliday {
  date: string;
  name: string;
  venues: MarketHolidayVenueStatus[];
}

export interface TradingTodaySnapshot {
  date: string;
  timezone: "America/New_York";
  fetchedAt: string;
  status: TradingTodaySnapshotStatus;
  events: EconomicEvent[];
  holidays: MarketHoliday[];
  sourceUrl: string;
  holidayVerifiedThrough: string;
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
  bidSize: number;
  askSize: number;
  markPrice: number;
  totalVolume: number;
  volatility: number;
  delta: number;
  theta: number;
  vega: number;
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
  provider: MarketDataProvider;
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
  provider?: MarketDataProvider;
  accountId?: string;
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
  assetType?: string;
  currentDayPnl?: number;
  multiplier?: number;
  underlying?: string;
  expirationDate?: string;
  strikePrice?: number;
  putCall?: "CALL" | "PUT";
}

export interface OrderUpdate {
  provider?: MarketDataProvider;
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
  brokerOrderId?: string;
  legId?: string;
  assetType?: string;
  underlying?: string;
  expirationDate?: string;
  strikePrice?: number;
  putCall?: "CALL" | "PUT";
  multiplier?: number;
}

export interface ClosePositionResult {
  positionId: string;
  symbol: string;
  cancelledOrderIds: string[];
  flattenOrder: OrderUpdate | null;
  error?: string;
}

export interface AccountBalance {
  provider?: MarketDataProvider;
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
export interface ActivityNotification { provider?: MarketDataProvider; id: string; symbol?: string; time: string; title: string; text: string; level?: "info" | "success" | "warning" | "error"; }

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
  /** Required for a risk-increasing order in a rolled U.S. equity-index contract. */
  rolloverAcknowledged?: boolean;
}

export interface OrderPreview {
  valid: boolean;
  summary: string;
  estimatedCommission?: string;
  initialMargin?: string;
  errors: string[];
}

export interface PriceOverlayIndicatorConfig {
  id: string;
  kind: "SMA" | "EMA" | "VWAP";
  period: number;
  color: string;
  visible: boolean;
}

export type FailedBreakoutPairMode = "consecutive" | "latest-matching";

export interface FailedBreakoutIndicatorConfig {
  id: string;
  kind: "FAILED_BREAKOUT";
  visible: boolean;
  pivotBars: 1 | 2 | 3;
  toleranceTicks: number;
  reclaimBars: number;
  pairMode: FailedBreakoutPairMode;
}

export type IndicatorConfig = PriceOverlayIndicatorConfig | FailedBreakoutIndicatorConfig;

export interface TimeframeAlertConfig {
  enabled: boolean;
  sound: AlertSound;
  durationSeconds: AlertDurationSeconds;
}

export type Ema200AlertConfig = Record<AlertTimeframe, TimeframeAlertConfig>;

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

export type OptionDraftAction = "BUY" | "SELL";
export type OptionDraftOrderType = "LIMIT" | "MARKET";
export type OptionDraftTimeInForce = "DAY" | "GTC";
export type OptionDraftPriceEffect = "DEBIT" | "CREDIT";

export interface OptionDraftLeg {
  contractSymbol: string;
  action: OptionDraftAction;
  ratio: number;
  putCall: "CALL" | "PUT";
  expirationDate: string;
  strikePrice: number;
  multiplier: number;
  bidPrice: number;
  askPrice: number;
}

export interface OptionOrderDraft {
  underlying: string;
  legs: OptionDraftLeg[];
  quantity: number;
  orderType: OptionDraftOrderType;
  timeInForce: OptionDraftTimeInForce;
  priceEffect: OptionDraftPriceEffect;
  limitAmount: number;
}

export interface OptionChainPreferences {
  symbol: string;
  expirationDate?: string;
  strikeCount: 5 | 10 | 15 | 20 | 24;
}

export interface EntryRuleCandleCloseCondition {
  id: string;
  kind: "candleCloseWindow";
  windowSeconds: number;
}

export type BrokerOutcome = "confirmed" | "rejected" | "unknown";
export type LocalPersistenceStatus = "complete" | "pending" | "failed";
export type ReconciliationStatus = "not_required" | "required" | "reconciling" | "reconciled" | "manual_review_required" | "failed";

export interface BrokerMutationResult {
  mutationId: string;
  brokerOutcome: BrokerOutcome;
  localPersistence: LocalPersistenceStatus;
  reconciliationStatus: ReconciliationStatus;
  warnings: string[];
  brokerOrder: OrderUpdate | null;
  closeResult: ClosePositionResult | null;
  rejectionReason?: string;
  retryBlocked: boolean;
}

export type MutationState = "requested" | "submitting" | "accepted" | "rejected" | "unknown" | "reconciling" | "reconciled" | "reconciliation_failed";

export interface BrokerMutationIntent {
  id: string;
  environment: TradingEnvironment;
  accountId: string;
  kind: string;
  equivalenceKey: string;
  symbol?: string;
  action: string;
  quantity?: number;
  orderType?: string;
  limitPrice?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  targetId?: string;
  brokerId?: string;
  state: MutationState;
  localPersistence: LocalPersistenceStatus;
  reconciliationStatus: string;
  manualReviewRequired: boolean;
  warning?: string;
  error?: string;
  request: unknown;
  brokerObject?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface EnabledU32Limit { enabled: boolean; value: number; }
export interface EnabledF64Limit { enabled: boolean; value: number; }
export interface TradingSessionPolicy { enabled: boolean; timezone: string; start: string; end: string; weekdays: number[]; }
export interface CooldownPolicy { enabled: boolean; threshold: number; cooldownMinutes: number; }
export interface OrderRatePolicy { enabled: boolean; maxOrders: number; windowSeconds: number; cooldownSeconds: number; }

export interface RiskPolicy {
  maxQuantityPerOrder: EnabledU32Limit;
  maxTotalOpenContracts: EnabledU32Limit;
  maxRiskPerTrade: EnabledF64Limit;
  maxAggregateOpenRisk: EnabledF64Limit;
  maxRealizedDailyLoss: EnabledF64Limit;
  requiredProtectiveStop: boolean;
  allowedSession: TradingSessionPolicy;
  consecutiveLossCooldown: CooldownPolicy;
  orderRate: OrderRatePolicy;
}

export interface RiskPolicyStatus {
  environment: TradingEnvironment;
  accountId: string;
  policy: RiskPolicy;
}

export interface KillSwitchItemResult {
  itemType: "order" | "position";
  itemId: string;
  symbol?: string;
  result: BrokerMutationResult;
}

export interface KillSwitchResult {
  environment: TradingEnvironment;
  accountId: string;
  cancelledOrders: KillSwitchItemResult[];
  flattenedPositions: KillSwitchItemResult[];
  alreadyFlat: boolean;
}

export type EntryRuleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type EntryRuleTimezone = Exclude<ChartTimezone, "exchange" | "local">;

export interface EntryRuleTimeWindowCondition {
  id: string;
  kind: "timeWindow";
  startTime: string;
  endTime: string;
  weekdays: EntryRuleWeekday[];
  timezone: EntryRuleTimezone | "";
}

export interface EntryRuleGroup {
  id: string;
  kind: "group";
  combinator: "and" | "or";
  children: EntryRuleNode[];
}

export type EntryRuleNode = EntryRuleCondition | EntryRuleEmaCrossCondition | EntryRuleCandleCloseCondition | EntryRuleTimeWindowCondition | EntryRuleGroup;

export interface EntryRules {
  allowEntries: Record<EntryRuleSide, boolean>;
  long: EntryRuleGroup;
  short: EntryRuleGroup;
}

export type EntryRuleAlertConfig = Record<EntryRuleSide, TimeframeAlertConfig>;

export interface EntryRuleLockState {
  enabled: boolean;
  lockedAt?: string;
}

export interface EntryRuleResult {
  allowed: boolean;
  status: "allowed" | "blocked" | "waiting";
  reason: string;
  nodeResults: Record<string, boolean | null>;
}

export type ChartTool = "cursor" | "horizontal" | "horizontal-ray" | "long-position" | "short-position";

export interface DrawingAlertConfig {
  enabled: boolean;
  direction: DrawingAlertDirection;
  frequency: DrawingAlertFrequency;
  sound: AlertSound;
  durationSeconds: AlertDurationSeconds;
  provider: MarketDataProvider;
  symbol: string;
  lastTriggeredAt?: string;
}

export interface LineDrawing {
  id: string;
  kind: "trend" | "horizontal" | "horizontal-ray" | "ray" | "rectangle" | "fibonacci" | "text";
  points: Array<{ time: number; price: number }>;
  text?: string;
  color: string;
  locked?: boolean;
  lineWidth?: 1 | 2 | 3 | 4;
  alert?: DrawingAlertConfig;
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
  alert?: DrawingAlertConfig | null;
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

export interface ChartSessionSettings {
  colorMode: "uniform" | "by-session";
  overnightColor: string;
  asiaColor: string;
  londonColor: string;
}

export type EconomicEventImpact = "high" | "medium" | "low" | "unrated";

export interface ChartEconomicEventSettings {
  enabled: boolean;
  impactVisibility: Record<EconomicEventImpact, boolean>;
}

export interface OrderTicketSettings {
  swingStopPivotBars: 2 | 3;
  swingStopOffsetTicks: number;
  sizingMode: "contracts" | "risk";
  riskSizingPolicy: "strict" | "minimum-one";
  timeInForce: "DAY" | "GTC";
  riskAmount?: number;
}

export interface TrailStopSettings {
  timeframe: Timeframe;
  pivotBars: number;
  offsetTicks: number;
}

export type ContractRollPhase = "clear" | "approaching" | "roll-due";

export interface ContractRollStatus {
  phase: ContractRollPhase;
  symbol: string;
  root: string;
  expirationDate: string;
  warningStartDate: string;
  rollDate: string;
  sessionsUntilRoll: number;
  nextContract?: SymbolMeta;
}

export interface ContractRollAlertSettings {
  audioEnabled: boolean;
  sound: AlertSound;
  durationSeconds: AlertDurationSeconds;
}

export interface WorkspaceSettings {
  crosshairSyncEnabled: boolean;
  chartLabels: ChartLabelSettings;
  chartSessions: ChartSessionSettings;
  chartEconomicEvents: ChartEconomicEventSettings;
  orderTicket: OrderTicketSettings;
  trailStop: TrailStopSettings;
  contractRollAlerts: ContractRollAlertSettings;
  truthSocialAlerts: TruthSocialAlertSettings;
  journal: {
    commissionPerContractSide: number;
    schwabOptionFeePerContractSide: number;
  };
}

export type AutoBreakEvenRuleStatus = "armed" | "triggering" | "attention";

export interface AutoBreakEvenRule {
  environment: TradingEnvironment;
  accountId: string;
  positionId: string;
  symbol: string;
  thresholdR: number;
  status: AutoBreakEvenRuleStatus;
  clientMutationId: string;
  message?: string;
}

export type AutoTrailStopRuleStatus = "armed" | "triggering" | "attention";

export interface AutoTrailStopRule {
  environment: TradingEnvironment;
  accountId: string;
  positionId: string;
  symbol: string;
  status: AutoTrailStopRuleStatus;
  clientMutationId: string;
  lastAppliedPrice?: number;
  message?: string;
}

export interface WorkspaceState {
  revision: number;
  environment: TradingEnvironment;
  customMinuteTimeframes: number[];
  tabs: ChartTabState[];
  windows: ChartWindowState[];
  watchlist: SymbolMeta[];
  recentSymbols: SymbolMeta[];
  drawings: Record<string, Drawing[]>;
  gexSelections: Record<string, GexExpirationSelection>;
  activeWorkspace: "charts" | "options";
  optionChain: OptionChainPreferences;
  rightPanelOpen: boolean;
  rightPanelMode: "order-entry" | "trade-management";
  autoBreakEvenRules: Record<string, AutoBreakEvenRule>;
  autoTrailStopRules: Record<string, AutoTrailStopRule>;
  bottomTab: "positions" | "orders" | "history" | "summary" | "notifications";
  bottomBrokerPanel: "combined" | "tradestation" | "schwab";
  bottomPanelOpen: boolean;
  bottomPanelHeight?: number;
  selectedAccountId?: string;
  selectedSchwabAccountId?: string;
  confirmOrders: boolean;
  entryRules: EntryRules;
  entryRuleAlerts: EntryRuleAlertConfig;
  entryRuleLock: EntryRuleLockState;
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
export interface QuoteUpdateEvent { subscriptionId: string; provider: MarketDataProvider; environment: TradingEnvironment; environmentGeneration: number; quote: Quote; }
export interface OptionUpdateEvent { subscriptionId: string; environmentGeneration: number; contract: OptionContract; }
export interface OptionStreamStateEvent { subscriptionId: string; symbol: string; environmentGeneration: number; state: StreamConnectionState | "rest-only" | "error"; message?: string; }
export interface StreamStateEvent {
  subscriptionId: string;
  provider: MarketDataProvider;
  environment: TradingEnvironment;
  environmentGeneration?: number;
  channel: "bars" | "quotes";
  state: StreamConnectionState;
  message?: string;
  symbol?: string;
  timeframe?: Timeframe;
  generation?: number;
}
export interface PositionsSnapshotEvent { provider?: MarketDataProvider; accountId: string; environmentGeneration: number; positions: Position[]; }
export interface PositionUpdateEvent { provider?: MarketDataProvider; accountId: string; environmentGeneration: number; position: Position; }
export interface OrdersSnapshotEvent { provider?: MarketDataProvider; accountId: string; environmentGeneration: number; orders: OrderUpdate[]; }
export interface OrderStreamUpdateEvent { provider?: MarketDataProvider; accountId: string; environmentGeneration: number; order: OrderUpdate; }
export interface BrokerageStreamStateEvent { provider?: MarketDataProvider; accountId: string; environmentGeneration: number; channel: "positions" | "orders"; state: StreamConnectionState; message?: string; }

export interface SchwabAccountSnapshot {
  account: Account;
  positions: Position[];
  balances: AccountBalance[];
  beginningOfDayBalances: AccountBalance[];
  fetchedAt: string;
  freshness: "fresh" | "stale";
  connectionState: StreamConnectionState;
  error?: string;
}

export type RiskProvenance = "exact" | "inferred" | "unknown";

export interface JournalRiskBaseline {
  tradeId: string;
  symbol: string;
  direction: "Long" | "Short";
  originalStop?: number;
  deployedRisk?: number;
  riskProvenance: RiskProvenance;
}

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
  provider?: MarketDataProvider;
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
  pendingScreenshots: number;
  screenshotAttention: number;
  lastSyncedAt?: string;
  message?: string;
}

export interface JournalEvent {
  id: string;
  tradeId?: string;
  brokerOrderId?: string;
  provider?: MarketDataProvider;
  optionSymbol?: string;
  brokerLegId?: string;
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

export interface JournalOptionLeg {
  id: string;
  tradeId: string;
  optionSymbol: string;
  underlying: string;
  expirationDate: string;
  strikePrice: number;
  putCall: "CALL" | "PUT";
  openingSide: "Buy" | "Sell";
  openedQuantity: number;
  closedQuantity: number;
  averageEntry: number;
  averageExit?: number;
  multiplier: number;
  grossPnl: number;
  fees: number;
  status: JournalTradeStatus;
  replacesLegId?: string;
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

export interface JournalScreenshotSaveResult {
  state: "queued" | "uploaded";
  tradeId?: string;
  pendingScreenshots: number;
}

export interface JournalScreenshotImage extends JournalScreenshotMetadata {
  dataUrl: string;
}

export interface JournalTrade {
  id: string;
  provider?: MarketDataProvider;
  environment: TradingEnvironment;
  accountId: string;
  symbol: string;
  direction: "Long" | "Short";
  assetClass?: "futures" | "option";
  strategy?: "futures-directional" | "long-strangle" | "short-strangle";
  underlying?: string;
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
  legs?: JournalOptionLeg[];
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

export interface JournalStatsTrade {
  id: string;
  provider?: MarketDataProvider;
  symbol: string;
  direction: "Long" | "Short";
  assetClass?: "futures" | "option";
  strategy?: "futures-directional" | "long-strangle" | "short-strangle";
  underlying?: string;
  status: JournalTradeStatus;
  openedAt: string;
  closedAt?: string;
  grossPnl: number;
  fees: number;
  netPnl: number;
  rMultiple?: number;
  tags: string[];
}

export interface JournalStatsRange {
  scope: JournalScope;
  startDate?: string;
  endDate?: string;
  trades: JournalStatsTrade[];
}

export interface JournalStatsDay {
  date: string;
  trades: number;
  netPnl: number;
  totalR?: number;
  cumulativePnl: number;
  cumulativeR?: number;
  drawdownPnl: number;
  drawdownR?: number;
}

export interface JournalStatsBreakdown {
  key: string;
  label: string;
  trades: number;
  netPnl: number;
  totalR?: number;
  winRate?: number;
  averageTrade?: number;
}

export interface JournalStatsMetrics {
  closedTrades: number;
  openTrades: number;
  netPnl: number;
  grossPnl: number;
  fees: number;
  totalR?: number;
  rTrades: number;
  winRate?: number;
  profitFactor?: number;
  expectancy?: number;
  averageWin?: number;
  averageLoss?: number;
  payoffRatio?: number;
  averageHoldMinutes?: number;
  longestWinStreak: number;
  longestLossStreak: number;
  maxDrawdown: number;
  maxDrawdownR?: number;
  largestWin?: JournalStatsTrade;
  largestLoss?: JournalStatsTrade;
}

export interface JournalStatsResult {
  metrics: JournalStatsMetrics;
  days: JournalStatsDay[];
  symbols: JournalStatsBreakdown[];
  directions: JournalStatsBreakdown[];
  tags: JournalStatsBreakdown[];
  entryHours: JournalStatsBreakdown[];
}

export type AuditEventCategory = "api" | "record" | "stream" | "system";
export type AuditEventStatus = "pending" | "success" | "warning" | "error";

export interface AuditEvent {
  sequence: number;
  id: string;
  startedAt: string;
  completedAt?: string;
  category: AuditEventCategory;
  source: string;
  operation: string;
  status: AuditEventStatus;
  summary: string;
  method?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  correlationId?: string;
  entityType?: string;
  entityId?: string;
  recordCount?: number;
  request?: unknown;
  response?: unknown;
  changes?: unknown;
  error?: string;
}

export interface AuditFilters {
  search: string;
  categories: AuditEventCategory[];
  sources: string[];
  statuses: AuditEventStatus[];
  startAt?: string;
  endAt?: string;
}

export interface AuditHealth {
  healthy: boolean;
  droppedEvents: number;
  lastError?: string;
  lastRecoveredAt?: string;
  sessionOnly: boolean;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor?: string;
  total: number;
  health: AuditHealth;
}
