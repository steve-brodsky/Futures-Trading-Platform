use crate::{
    models::{AccountBalance, OrderDraft, OrderUpdate, Position, SymbolMeta, TradingEnvironment},
    AppError,
};
use chrono::{DateTime, Datelike, Timelike, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::{Mutex, OwnedMutexGuard};

const ACTIVE_STATES: &[&str] = &["requested", "submitting", "unknown", "reconciling"];
const UNRESOLVED_STATES: &[&str] = &[
    "submitting",
    "unknown",
    "reconciling",
    "reconciliation_failed",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MutationState {
    Requested,
    Submitting,
    Accepted,
    Rejected,
    Unknown,
    Reconciling,
    Reconciled,
    ReconciliationFailed,
}

impl MutationState {
    pub fn key(&self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::Submitting => "submitting",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Unknown => "unknown",
            Self::Reconciling => "reconciling",
            Self::Reconciled => "reconciled",
            Self::ReconciliationFailed => "reconciliation_failed",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "requested" => Self::Requested,
            "submitting" => Self::Submitting,
            "accepted" => Self::Accepted,
            "rejected" => Self::Rejected,
            "reconciling" => Self::Reconciling,
            "reconciled" => Self::Reconciled,
            "reconciliation_failed" => Self::ReconciliationFailed,
            _ => Self::Unknown,
        }
    }

    pub fn blocks_equivalent_retry(&self) -> bool {
        matches!(
            self,
            Self::Requested | Self::Submitting | Self::Unknown | Self::Reconciling
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationIntent {
    pub id: String,
    pub environment: TradingEnvironment,
    pub account_id: String,
    pub kind: String,
    pub equivalence_key: String,
    pub symbol: Option<String>,
    pub action: String,
    pub quantity: Option<f64>,
    pub order_type: Option<String>,
    pub limit_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub take_profit: Option<f64>,
    pub stop_loss: Option<f64>,
    pub target_id: Option<String>,
    pub broker_id: Option<String>,
    pub state: MutationState,
    pub local_persistence: String,
    pub reconciliation_status: String,
    pub manual_review_required: bool,
    pub warning: Option<String>,
    pub error: Option<String>,
    pub request: Value,
    pub broker_object: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewMutationIntent {
    pub id: String,
    pub environment: TradingEnvironment,
    pub account_id: String,
    pub kind: String,
    pub equivalence_key: String,
    pub symbol: Option<String>,
    pub action: String,
    pub quantity: Option<f64>,
    pub order_type: Option<String>,
    pub limit_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub take_profit: Option<f64>,
    pub stop_loss: Option<f64>,
    pub target_id: Option<String>,
    pub request: Value,
}

#[derive(Debug, Clone)]
pub enum CreateIntent {
    Created,
    Existing(MutationIntent),
    EquivalentBlocked(MutationIntent),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmedPersistence {
    pub local_persistence: String,
    pub reconciliation_status: String,
    pub warnings: Vec<String>,
}

pub fn record_confirmed(
    path: &Path,
    id: &str,
    broker_id: Option<&str>,
    broker_object: &Value,
    local_failure: Option<String>,
) -> ConfirmedPersistence {
    let mut warnings = local_failure
        .map(|error| {
            format!("Broker confirmed the mutation, but local completion is pending: {error}")
        })
        .into_iter()
        .collect::<Vec<_>>();
    let local_persistence = if warnings.is_empty() {
        "complete"
    } else {
        "pending"
    };
    let reconciliation_status = if warnings.is_empty() {
        "not_required"
    } else {
        "required"
    };
    if let Err(error) = update_intent(
        path,
        id,
        MutationState::Accepted,
        broker_id,
        Some(broker_object),
        local_persistence,
        reconciliation_status,
        warnings.first().map(String::as_str),
        None,
        false,
    ) {
        warnings.push(format!(
            "Broker confirmation remains authoritative; durable completion update failed: {error}"
        ));
    }
    ConfirmedPersistence {
        local_persistence: if warnings.is_empty() {
            "complete".into()
        } else {
            "pending".into()
        },
        reconciliation_status: if warnings.is_empty() {
            "not_required".into()
        } else {
            "required".into()
        },
        warnings,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledU32Limit {
    pub enabled: bool,
    pub value: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledF64Limit {
    pub enabled: bool,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradingSessionPolicy {
    pub enabled: bool,
    pub timezone: String,
    pub start: String,
    pub end: String,
    pub weekdays: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CooldownPolicy {
    pub enabled: bool,
    pub threshold: u32,
    pub cooldown_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRatePolicy {
    pub enabled: bool,
    pub max_orders: u32,
    pub window_seconds: u32,
    pub cooldown_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskPolicy {
    pub max_quantity_per_order: EnabledU32Limit,
    pub max_total_open_contracts: EnabledU32Limit,
    pub max_risk_per_trade: EnabledF64Limit,
    pub max_aggregate_open_risk: EnabledF64Limit,
    pub max_realized_daily_loss: EnabledF64Limit,
    pub required_protective_stop: bool,
    pub allowed_session: TradingSessionPolicy,
    pub consecutive_loss_cooldown: CooldownPolicy,
    pub order_rate: OrderRatePolicy,
}

impl Default for RiskPolicy {
    fn default() -> Self {
        Self {
            max_quantity_per_order: EnabledU32Limit {
                enabled: false,
                value: 1,
            },
            max_total_open_contracts: EnabledU32Limit {
                enabled: false,
                value: 1,
            },
            max_risk_per_trade: EnabledF64Limit {
                enabled: false,
                value: 100.0,
            },
            max_aggregate_open_risk: EnabledF64Limit {
                enabled: false,
                value: 500.0,
            },
            max_realized_daily_loss: EnabledF64Limit {
                enabled: false,
                value: 500.0,
            },
            required_protective_stop: false,
            allowed_session: TradingSessionPolicy {
                enabled: false,
                timezone: "America/Chicago".into(),
                start: "08:30".into(),
                end: "15:00".into(),
                weekdays: vec![1, 2, 3, 4, 5],
            },
            consecutive_loss_cooldown: CooldownPolicy {
                enabled: false,
                threshold: 3,
                cooldown_minutes: 30,
            },
            order_rate: OrderRatePolicy {
                enabled: false,
                max_orders: 5,
                window_seconds: 60,
                cooldown_seconds: 60,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskPolicyStatus {
    pub environment: TradingEnvironment,
    pub account_id: String,
    pub policy: RiskPolicy,
    pub live_armed: bool,
    pub session_id: String,
}

#[derive(Debug, Clone)]
pub struct RiskContext<'a> {
    pub environment: &'a TradingEnvironment,
    pub draft: &'a OrderDraft,
    pub meta: &'a SymbolMeta,
    pub contract_metadata: &'a HashMap<String, SymbolMeta>,
    pub positions: &'a [Position],
    pub orders: &'a [OrderUpdate],
    pub balances: &'a [AccountBalance],
    pub market_price: Option<f64>,
    pub live_armed: bool,
    pub recent_order_count: Option<u32>,
    pub consecutive_losses: Option<(u32, DateTime<Utc>)>,
    pub now: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskDecision {
    pub allowed: bool,
    pub risk_increasing: bool,
    pub reasons: Vec<String>,
    pub estimated_trade_risk: Option<f64>,
    pub estimated_aggregate_risk: Option<f64>,
}

pub struct ServiceLifecycle {
    generation: AtomicU64,
    transitioning: AtomicBool,
    transition_lock: Arc<Mutex<()>>,
}

impl Default for ServiceLifecycle {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(1),
            transitioning: AtomicBool::new(false),
            transition_lock: Arc::new(Mutex::new(())),
        }
    }
}

impl ServiceLifecycle {
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn accepts(&self, generation: u64) -> bool {
        !self.transitioning.load(Ordering::SeqCst) && self.generation() == generation
    }

    pub fn is_transitioning(&self) -> bool {
        self.transitioning.load(Ordering::SeqCst)
    }

    pub async fn begin_transition(&self) -> (OwnedMutexGuard<()>, u64) {
        let guard = self.transition_lock.clone().lock_owned().await;
        self.transitioning.store(true, Ordering::SeqCst);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        (guard, generation)
    }

    pub fn finish_transition(&self) {
        self.transitioning.store(false, Ordering::SeqCst);
    }
}

pub struct SafetyService {
    account_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    live_armed: Mutex<HashSet<String>>,
    pending_reconciliation: Mutex<HashSet<String>>,
    pub lifecycle: Arc<ServiceLifecycle>,
    session_id: String,
}

impl SafetyService {
    pub fn new(_db_path: PathBuf) -> Self {
        Self {
            account_locks: Mutex::new(HashMap::new()),
            live_armed: Mutex::new(HashSet::new()),
            pending_reconciliation: Mutex::new(HashSet::new()),
            lifecycle: Arc::new(ServiceLifecycle::default()),
            session_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub async fn account_lock(
        &self,
        environment: &TradingEnvironment,
        account_id: &str,
    ) -> OwnedMutexGuard<()> {
        let key = account_key(environment, account_id);
        let lock = self
            .account_locks
            .lock()
            .await
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        lock.lock_owned().await
    }

    pub async fn set_live_armed(
        &self,
        environment: &TradingEnvironment,
        account_id: &str,
        armed: bool,
    ) {
        let key = account_key(environment, account_id);
        let mut values = self.live_armed.lock().await;
        if armed && matches!(environment, TradingEnvironment::Live) {
            values.insert(key);
        } else {
            values.remove(&key);
        }
    }

    pub async fn is_live_armed(&self, environment: &TradingEnvironment, account_id: &str) -> bool {
        matches!(environment, TradingEnvironment::Live)
            && self
                .live_armed
                .lock()
                .await
                .contains(&account_key(environment, account_id))
    }

    pub async fn disarm_all(&self) {
        self.live_armed.lock().await.clear();
    }

    pub async fn enqueue_reconciliation(&self, mutation_id: &str) {
        self.pending_reconciliation
            .lock()
            .await
            .insert(mutation_id.to_string());
    }

    pub fn status(
        &self,
        environment: TradingEnvironment,
        account_id: String,
        policy: RiskPolicy,
        armed: bool,
    ) -> RiskPolicyStatus {
        RiskPolicyStatus {
            environment,
            account_id,
            policy,
            live_armed: armed,
            session_id: self.session_id.clone(),
        }
    }
}

fn account_key(environment: &TradingEnvironment, account_id: &str) -> String {
    format!("{}\0{}", environment.key(), account_id)
}

pub fn init(path: &Path) -> Result<(), AppError> {
    let db = Connection::open(path)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS broker_mutations (
            id TEXT PRIMARY KEY,
            environment TEXT NOT NULL,
            account_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            equivalence_key TEXT NOT NULL,
            symbol TEXT,
            action TEXT NOT NULL,
            quantity REAL,
            order_type TEXT,
            limit_price REAL,
            stop_price REAL,
            take_profit REAL,
            stop_loss REAL,
            target_id TEXT,
            broker_id TEXT,
            state TEXT NOT NULL,
            local_persistence TEXT NOT NULL DEFAULT 'complete',
            reconciliation_status TEXT NOT NULL DEFAULT 'not_required',
            manual_review_required INTEGER NOT NULL DEFAULT 0,
            warning TEXT,
            error TEXT,
            request_json TEXT NOT NULL,
            broker_object_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS broker_mutations_unresolved
          ON broker_mutations(environment,account_id,state,updated_at);
        CREATE INDEX IF NOT EXISTS broker_mutations_equivalent
          ON broker_mutations(environment,account_id,equivalence_key,state);
        CREATE TABLE IF NOT EXISTS risk_policies (
            environment TEXT NOT NULL,
            account_id TEXT NOT NULL,
            policy_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(environment,account_id)
        );",
    )?;
    Ok(())
}

pub fn create_intent(path: &Path, input: NewMutationIntent) -> Result<CreateIntent, AppError> {
    create_intent_with_recent_confirmed_guard(path, input, None)
}

pub fn create_intent_with_recent_confirmed_guard(
    path: &Path,
    input: NewMutationIntent,
    confirmed_guard_seconds: Option<i64>,
) -> Result<CreateIntent, AppError> {
    if input.id.trim().is_empty() {
        return Err(AppError::Validation(
            "A stable client mutation ID is required".into(),
        ));
    }
    let mut db = Connection::open(path)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(existing) = load_intent_from(&tx, &input.id)? {
        tx.commit()?;
        return Ok(CreateIntent::Existing(existing));
    }
    let placeholders = ACTIVE_STATES
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id FROM broker_mutations
         WHERE environment=?1 AND account_id=?2 AND equivalence_key=?3
           AND state IN ({placeholders})
         ORDER BY created_at DESC LIMIT 1"
    );
    let environment_key = input.environment.key();
    let mut values: Vec<&dyn rusqlite::ToSql> =
        vec![&environment_key, &input.account_id, &input.equivalence_key];
    values.extend(
        ACTIVE_STATES
            .iter()
            .map(|value| value as &dyn rusqlite::ToSql),
    );
    let equivalent_id = tx
        .query_row(&sql, values.as_slice(), |row| row.get::<_, String>(0))
        .optional()?;
    if let Some(equivalent_id) = equivalent_id {
        let existing = load_intent_from(&tx, &equivalent_id)?
            .ok_or_else(|| AppError::Api("Equivalent mutation disappeared".into()))?;
        tx.commit()?;
        return Ok(CreateIntent::EquivalentBlocked(existing));
    }
    if let Some(seconds) = confirmed_guard_seconds.filter(|seconds| *seconds > 0) {
        let cutoff = (Utc::now() - chrono::Duration::seconds(seconds)).to_rfc3339();
        let confirmed_id = tx
            .query_row(
                "SELECT id FROM broker_mutations
                 WHERE environment=?1 AND account_id=?2 AND equivalence_key=?3
                   AND state IN ('accepted','reconciled') AND updated_at>=?4
                 ORDER BY updated_at DESC LIMIT 1",
                params![
                    environment_key,
                    input.account_id,
                    input.equivalence_key,
                    cutoff
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(confirmed_id) = confirmed_id {
            let existing = load_intent_from(&tx, &confirmed_id)?
                .ok_or_else(|| AppError::Api("Confirmed mutation disappeared".into()))?;
            tx.commit()?;
            return Ok(CreateIntent::EquivalentBlocked(existing));
        }
    }
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO broker_mutations(
          id,environment,account_id,kind,equivalence_key,symbol,action,quantity,order_type,
          limit_price,stop_price,take_profit,stop_loss,target_id,state,request_json,created_at,updated_at
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'requested',?15,?16,?16)",
        params![
            input.id,
            input.environment.key(),
            input.account_id,
            input.kind,
            input.equivalence_key,
            input.symbol,
            input.action,
            input.quantity,
            input.order_type,
            input.limit_price,
            input.stop_price,
            input.take_profit,
            input.stop_loss,
            input.target_id,
            serde_json::to_string(&input.request)?,
            now
        ],
    )?;
    load_intent_from(&tx, &input.id)?
        .ok_or_else(|| AppError::Api("Persisted mutation intent could not be read".into()))?;
    tx.commit()?;
    Ok(CreateIntent::Created)
}

pub fn update_intent(
    path: &Path,
    id: &str,
    state: MutationState,
    broker_id: Option<&str>,
    broker_object: Option<&Value>,
    local_persistence: &str,
    reconciliation_status: &str,
    warning: Option<&str>,
    error: Option<&str>,
    manual_review_required: bool,
) -> Result<(), AppError> {
    let changed = Connection::open(path)?.execute(
        "UPDATE broker_mutations SET state=?2,broker_id=COALESCE(?3,broker_id),
         broker_object_json=COALESCE(?4,broker_object_json),local_persistence=?5,
         reconciliation_status=?6,warning=?7,error=?8,manual_review_required=?9,updated_at=?10
         WHERE id=?1",
        params![
            id,
            state.key(),
            broker_id,
            broker_object.map(serde_json::to_string).transpose()?,
            local_persistence,
            reconciliation_status,
            warning,
            error,
            i64::from(manual_review_required),
            Utc::now().to_rfc3339()
        ],
    )?;
    if changed != 1 {
        return Err(AppError::Validation("Mutation intent was not found".into()));
    }
    Ok(())
}

pub fn load_intent(path: &Path, id: &str) -> Result<Option<MutationIntent>, AppError> {
    load_intent_from(&Connection::open(path)?, id)
}

fn load_intent_from(db: &Connection, id: &str) -> Result<Option<MutationIntent>, AppError> {
    db.query_row(
        "SELECT id,environment,account_id,kind,equivalence_key,symbol,action,quantity,
         order_type,limit_price,stop_price,take_profit,stop_loss,target_id,broker_id,state,
         local_persistence,reconciliation_status,manual_review_required,warning,error,
         request_json,broker_object_json,created_at,updated_at
         FROM broker_mutations WHERE id=?1",
        params![id],
        intent_from_row,
    )
    .optional()
    .map_err(AppError::from)
}

fn intent_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MutationIntent> {
    let environment: String = row.get(1)?;
    let request_json: String = row.get(21)?;
    let broker_json: Option<String> = row.get(22)?;
    Ok(MutationIntent {
        id: row.get(0)?,
        environment: if environment == "live" {
            TradingEnvironment::Live
        } else {
            TradingEnvironment::Sim
        },
        account_id: row.get(2)?,
        kind: row.get(3)?,
        equivalence_key: row.get(4)?,
        symbol: row.get(5)?,
        action: row.get(6)?,
        quantity: row.get(7)?,
        order_type: row.get(8)?,
        limit_price: row.get(9)?,
        stop_price: row.get(10)?,
        take_profit: row.get(11)?,
        stop_loss: row.get(12)?,
        target_id: row.get(13)?,
        broker_id: row.get(14)?,
        state: MutationState::parse(&row.get::<_, String>(15)?),
        local_persistence: row.get(16)?,
        reconciliation_status: row.get(17)?,
        manual_review_required: row.get::<_, i64>(18)? != 0,
        warning: row.get(19)?,
        error: row.get(20)?,
        request: serde_json::from_str(&request_json).unwrap_or(Value::Null),
        broker_object: broker_json
            .as_deref()
            .and_then(|value| serde_json::from_str(value).ok()),
        created_at: row.get(23)?,
        updated_at: row.get(24)?,
    })
}

pub fn unresolved_intents(path: &Path) -> Result<Vec<MutationIntent>, AppError> {
    let db = Connection::open(path)?;
    let placeholders = UNRESOLVED_STATES
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id FROM broker_mutations
         WHERE state IN ({placeholders}) OR local_persistence!='complete'
         ORDER BY created_at"
    );
    let values = UNRESOLVED_STATES
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect::<Vec<_>>();
    let ids = db
        .prepare(&sql)?
        .query_map(values.as_slice(), |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            load_intent_from(&db, &id)?
                .ok_or_else(|| AppError::Api("Unresolved mutation disappeared".into()))
        })
        .collect()
}

pub fn list_intents(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
) -> Result<Vec<MutationIntent>, AppError> {
    let db = Connection::open(path)?;
    let ids = db
        .prepare(
            "SELECT id FROM broker_mutations WHERE environment=?1 AND account_id=?2
             ORDER BY created_at DESC LIMIT 250",
        )?
        .query_map(params![environment.key(), account_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            load_intent_from(&db, &id)?.ok_or_else(|| AppError::Api("Mutation disappeared".into()))
        })
        .collect()
}

pub fn recent_accepted_order_count(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
    since: DateTime<Utc>,
) -> Result<u32, AppError> {
    let count = Connection::open(path)?.query_row(
        "SELECT COUNT(*) FROM broker_mutations
         WHERE environment=?1 AND account_id=?2 AND kind='place_order'
           AND state IN ('accepted','reconciled') AND created_at>=?3",
        params![environment.key(), account_id, since.to_rfc3339()],
        |row| row.get::<_, u32>(0),
    )?;
    Ok(count)
}

pub fn load_policy(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
) -> Result<RiskPolicy, AppError> {
    let value = Connection::open(path)?
        .query_row(
            "SELECT policy_json FROM risk_policies WHERE environment=?1 AND account_id=?2",
            params![environment.key(), account_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    value
        .map(|json| serde_json::from_str(&json).map_err(AppError::from))
        .unwrap_or_else(|| Ok(RiskPolicy::default()))
}

pub fn save_policy(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
    policy: &RiskPolicy,
) -> Result<(), AppError> {
    validate_policy(policy)?;
    Connection::open(path)?.execute(
        "INSERT INTO risk_policies(environment,account_id,policy_json,updated_at)
         VALUES(?1,?2,?3,?4)
         ON CONFLICT(environment,account_id) DO UPDATE SET
         policy_json=excluded.policy_json,updated_at=excluded.updated_at",
        params![
            environment.key(),
            account_id,
            serde_json::to_string(policy)?,
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

fn validate_policy(policy: &RiskPolicy) -> Result<(), AppError> {
    for (name, enabled, value) in [
        (
            "maximum quantity",
            policy.max_quantity_per_order.enabled,
            policy.max_quantity_per_order.value as f64,
        ),
        (
            "maximum open contracts",
            policy.max_total_open_contracts.enabled,
            policy.max_total_open_contracts.value as f64,
        ),
        (
            "maximum trade risk",
            policy.max_risk_per_trade.enabled,
            policy.max_risk_per_trade.value,
        ),
        (
            "maximum aggregate risk",
            policy.max_aggregate_open_risk.enabled,
            policy.max_aggregate_open_risk.value,
        ),
        (
            "maximum daily loss",
            policy.max_realized_daily_loss.enabled,
            policy.max_realized_daily_loss.value,
        ),
    ] {
        if enabled && (!value.is_finite() || value <= 0.0) {
            return Err(AppError::Validation(format!(
                "Enabled {name} must be positive"
            )));
        }
    }
    if policy.allowed_session.enabled {
        policy
            .allowed_session
            .timezone
            .parse::<Tz>()
            .map_err(|_| AppError::Validation("Trading-session timezone is invalid".into()))?;
        parse_clock(&policy.allowed_session.start)?;
        parse_clock(&policy.allowed_session.end)?;
        if policy
            .allowed_session
            .weekdays
            .iter()
            .any(|day| !(1..=7).contains(day))
        {
            return Err(AppError::Validation(
                "Trading-session weekdays must be ISO values 1 through 7".into(),
            ));
        }
    }
    Ok(())
}

pub fn evaluate_risk(policy: &RiskPolicy, context: RiskContext<'_>) -> RiskDecision {
    let draft = context.draft;
    let mut reasons = Vec::new();
    let position = context
        .positions
        .iter()
        .find(|position| position.symbol == draft.symbol);
    let reducing_quantity = position
        .filter(|position| {
            (position.side == "Long" && draft.side == "Sell")
                || (position.side == "Short" && draft.side == "Buy")
        })
        .map(|position| position.quantity.abs())
        .unwrap_or(0.0);
    let risk_increasing = reducing_quantity < draft.quantity as f64;

    validate_prices_and_geometry(draft, context.meta, context.market_price, &mut reasons);
    if !risk_increasing {
        return RiskDecision {
            allowed: reasons.is_empty(),
            risk_increasing,
            reasons,
            estimated_trade_risk: None,
            estimated_aggregate_risk: None,
        };
    }

    if matches!(context.environment, TradingEnvironment::Live) && !context.live_armed {
        reasons.push("LIVE trading is not armed for this account and application session".into());
    }
    if policy.max_quantity_per_order.enabled && draft.quantity > policy.max_quantity_per_order.value
    {
        reasons.push(format!(
            "Quantity {} exceeds the configured per-order maximum of {}",
            draft.quantity, policy.max_quantity_per_order.value
        ));
    }
    if policy.required_protective_stop && draft.stop_loss.is_none() {
        reasons.push("A protective stop is required by the native risk policy".into());
    }

    let working_open: f64 = context
        .orders
        .iter()
        .filter(|order| {
            matches!(order.status.as_str(), "Working" | "Pending")
                && order.open_or_close.as_deref() != Some("Close")
        })
        .map(|order| order.remaining_quantity.unwrap_or(order.quantity as f64))
        .sum();
    let open_contracts: f64 = context
        .positions
        .iter()
        .map(|position| position.quantity.abs())
        .sum::<f64>()
        + working_open
        + draft.quantity as f64;
    if policy.max_total_open_contracts.enabled
        && open_contracts > policy.max_total_open_contracts.value as f64
    {
        reasons.push(format!(
            "Projected open contracts {open_contracts:.0} exceed the configured maximum of {}",
            policy.max_total_open_contracts.value
        ));
    }

    let entry = draft
        .limit_price
        .or(draft.stop_price)
        .or(context.market_price);
    let trade_risk = entry.zip(draft.stop_loss).and_then(|(entry, stop)| {
        let value = (entry - stop).abs() * context.meta.point_value * draft.quantity as f64;
        value.is_finite().then_some(value)
    });
    if policy.max_risk_per_trade.enabled {
        match trade_risk {
            Some(value) if value > policy.max_risk_per_trade.value => reasons.push(format!(
                "Estimated trade risk ${value:.2} exceeds the configured maximum of ${:.2}",
                policy.max_risk_per_trade.value
            )),
            Some(_) => {}
            None => reasons.push(
                "Maximum trade risk is enabled, but fresh entry/stop contract risk could not be calculated"
                    .into(),
            ),
        }
    }

    let current_open_risk =
        aggregate_open_risk(context.positions, context.orders, context.contract_metadata);
    let aggregate_risk = current_open_risk
        .zip(trade_risk)
        .map(|(open, trade)| open + trade);
    if policy.max_aggregate_open_risk.enabled {
        match aggregate_risk {
            Some(value) if value > policy.max_aggregate_open_risk.value => reasons.push(format!(
                "Projected aggregate open risk ${value:.2} exceeds the configured maximum of ${:.2}",
                policy.max_aggregate_open_risk.value
            )),
            Some(_) => {}
            None => reasons.push(
                "Maximum aggregate risk is enabled, but fresh protective-order risk could not be calculated"
                    .into(),
            ),
        }
    }

    if policy.max_realized_daily_loss.enabled {
        let realized = context
            .balances
            .iter()
            .find(|balance| balance.account_id == draft.account_id)
            .and_then(|balance| balance.realized_profit_loss.or(balance.todays_profit_loss));
        match realized {
            Some(value) if value <= -policy.max_realized_daily_loss.value => reasons.push(format!(
                "Realized daily loss ${:.2} has reached the configured ${:.2} limit",
                value.abs(),
                policy.max_realized_daily_loss.value
            )),
            Some(_) => {}
            None => reasons.push(
                "Daily-loss protection is enabled, but fresh realized P&L is unavailable".into(),
            ),
        }
    }

    if policy.allowed_session.enabled && !inside_session(&policy.allowed_session, context.now) {
        reasons.push("Current time is outside the configured native trading session".into());
    }
    if policy.consecutive_loss_cooldown.enabled {
        match context.consecutive_losses {
            Some((losses, last_loss))
                if losses >= policy.consecutive_loss_cooldown.threshold
                    && context.now - last_loss
                        < chrono::Duration::minutes(
                            policy.consecutive_loss_cooldown.cooldown_minutes as i64,
                        ) =>
            {
                reasons.push(format!(
                    "Consecutive-loss cooldown is active after {losses} losses"
                ));
            }
            Some(_) => {}
            None => reasons.push(
                "Consecutive-loss cooldown is enabled, but current loss history is unavailable"
                    .into(),
            ),
        }
    }
    if policy.order_rate.enabled {
        match context.recent_order_count {
            Some(count) if count >= policy.order_rate.max_orders => {
                let protection_seconds = policy
                    .order_rate
                    .window_seconds
                    .max(policy.order_rate.cooldown_seconds);
                reasons.push(format!(
                    "Order-rate/cooldown protection allows {} orders per {} seconds",
                    policy.order_rate.max_orders, protection_seconds
                ));
            }
            Some(_) => {}
            None => reasons.push(
                "Order-rate protection is enabled, but recent durable order history is unavailable"
                    .into(),
            ),
        }
    }

    RiskDecision {
        allowed: reasons.is_empty(),
        risk_increasing,
        reasons,
        estimated_trade_risk: trade_risk,
        estimated_aggregate_risk: aggregate_risk,
    }
}

fn validate_prices_and_geometry(
    draft: &OrderDraft,
    meta: &SymbolMeta,
    market_price: Option<f64>,
    reasons: &mut Vec<String>,
) {
    for (name, price) in [
        ("limit", draft.limit_price),
        ("stop trigger", draft.stop_price),
        ("take profit", draft.take_profit),
        ("protective stop", draft.stop_loss),
    ] {
        if let Some(price) = price {
            if !price.is_finite() || price <= 0.0 {
                reasons.push(format!("{name} price must be finite and positive"));
            } else if !tick_aligned(price, meta.min_move) {
                reasons.push(format!(
                    "{name} price {price} is not aligned to the {} tick",
                    meta.min_move
                ));
            }
        }
    }
    let entry = draft.limit_price.or(draft.stop_price).or(market_price);
    if let Some(stop) = draft.stop_loss {
        match entry {
            Some(entry) if draft.side == "Buy" && stop >= entry => {
                reasons.push("A long protective stop must be below the entry price".into())
            }
            Some(entry) if draft.side == "Sell" && stop <= entry => {
                reasons.push("A short protective stop must be above the entry price".into())
            }
            None => reasons.push(
                "Protective-stop geometry requires a fresh or explicitly priced entry".into(),
            ),
            _ => {}
        }
    }
    if let Some(target) = draft.take_profit {
        match entry {
            Some(entry) if draft.side == "Buy" && target <= entry => {
                reasons.push("A long target must be above the entry price".into())
            }
            Some(entry) if draft.side == "Sell" && target >= entry => {
                reasons.push("A short target must be below the entry price".into())
            }
            None => {
                reasons.push("Target geometry requires a fresh or explicitly priced entry".into())
            }
            _ => {}
        }
    }
}

fn tick_aligned(price: f64, tick: f64) -> bool {
    tick.is_finite() && tick > 0.0 && ((price / tick) - (price / tick).round()).abs() < 1e-7
}

fn aggregate_open_risk(
    positions: &[Position],
    orders: &[OrderUpdate],
    contract_metadata: &HashMap<String, SymbolMeta>,
) -> Option<f64> {
    let mut total = 0.0;
    for position in positions {
        let stop = orders.iter().find(|order| {
            order.symbol == position.symbol
                && matches!(order.status.as_str(), "Working" | "Pending")
                && matches!(order.order_type.as_str(), "StopMarket" | "StopLimit")
                && ((position.side == "Long" && order.side == "Sell")
                    || (position.side == "Short" && order.side == "Buy"))
        })?;
        let stop_price = stop.stop_price.or(stop.price)?;
        let meta = contract_metadata.get(&position.symbol)?;
        total += (position.average_price - stop_price).abs()
            * meta.point_value
            * position.quantity.abs();
    }
    Some(total)
}

pub fn consecutive_losses(
    path: &Path,
    environment: &TradingEnvironment,
    account_id: &str,
) -> Result<Option<(u32, DateTime<Utc>)>, AppError> {
    let db = Connection::open(path)?;
    let mut statement = db.prepare(
        "SELECT net_pnl,closed_at FROM journal_trades
         WHERE environment=?1 AND account_id=?2 AND status='closed' AND closed_at IS NOT NULL
         ORDER BY closed_at DESC LIMIT 100",
    )?;
    let rows = statement
        .query_map(params![environment.key(), account_id], |row| {
            Ok((row.get::<_, f64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut count = 0u32;
    let mut last = None;
    for (pnl, closed_at) in rows {
        if pnl >= 0.0 {
            break;
        }
        count += 1;
        if last.is_none() {
            last = DateTime::parse_from_rfc3339(&closed_at)
                .ok()
                .map(|value| value.with_timezone(&Utc));
        }
    }
    Ok(last.map(|last| (count, last)))
}

fn parse_clock(value: &str) -> Result<(u32, u32), AppError> {
    let (hour, minute) = value
        .split_once(':')
        .ok_or_else(|| AppError::Validation("Session time must use HH:MM".into()))?;
    let hour = hour
        .parse::<u32>()
        .map_err(|_| AppError::Validation("Session hour is invalid".into()))?;
    let minute = minute
        .parse::<u32>()
        .map_err(|_| AppError::Validation("Session minute is invalid".into()))?;
    if hour > 23 || minute > 59 {
        return Err(AppError::Validation("Session time is invalid".into()));
    }
    Ok((hour, minute))
}

fn inside_session(policy: &TradingSessionPolicy, now: DateTime<Utc>) -> bool {
    let Ok(timezone) = policy.timezone.parse::<Tz>() else {
        return false;
    };
    let Ok((start_hour, start_minute)) = parse_clock(&policy.start) else {
        return false;
    };
    let Ok((end_hour, end_minute)) = parse_clock(&policy.end) else {
        return false;
    };
    let local = now.with_timezone(&timezone);
    if !policy
        .weekdays
        .contains(&local.weekday().number_from_monday())
    {
        return false;
    }
    let current = local.hour() * 60 + local.minute();
    let start = start_hour * 60 + start_minute;
    let end = end_hour * 60 + end_minute;
    if start <= end {
        current >= start && current < end
    } else {
        current >= start || current < end
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_db(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "northstar-safety-{name}-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        init(&path).unwrap();
        path
    }

    fn draft() -> OrderDraft {
        OrderDraft {
            account_id: "SIM-1".into(),
            symbol: "MESZ26".into(),
            side: "Buy".into(),
            order_type: "Limit".into(),
            quantity: 1,
            limit_price: Some(6000.0),
            stop_price: None,
            duration: "DAY".into(),
            take_profit: Some(6002.0),
            stop_loss: Some(5998.0),
        }
    }

    fn meta() -> SymbolMeta {
        SymbolMeta {
            provider: Default::default(),
            symbol: "MESZ26".into(),
            description: String::new(),
            exchange: "CME".into(),
            asset_type: "FUTURE".into(),
            min_move: 0.25,
            point_value: 5.0,
            expiration: None,
            root: Some("MES".into()),
            underlying: None,
        }
    }

    #[test]
    fn durable_intent_blocks_duplicate_active_mutations_across_restart() {
        let path = temp_db("duplicate");
        let input = NewMutationIntent {
            id: "client-1".into(),
            environment: TradingEnvironment::Sim,
            account_id: "SIM-1".into(),
            kind: "place_order".into(),
            equivalence_key: "place|MESZ26|Buy|1|Limit|6000".into(),
            symbol: Some("MESZ26".into()),
            action: "Buy".into(),
            quantity: Some(1.0),
            order_type: Some("Limit".into()),
            limit_price: Some(6000.0),
            stop_price: None,
            take_profit: Some(6002.0),
            stop_loss: Some(5998.0),
            target_id: None,
            request: serde_json::json!({"safe":true}),
        };
        assert!(matches!(
            create_intent(&path, input.clone()).unwrap(),
            CreateIntent::Created
        ));
        update_intent(
            &path,
            "client-1",
            MutationState::Unknown,
            None,
            None,
            "pending",
            "required",
            None,
            Some("timeout"),
            false,
        )
        .unwrap();
        let mut retry = input;
        retry.id = "client-2".into();
        assert!(matches!(
            create_intent(&path, retry).unwrap(),
            CreateIntent::EquivalentBlocked(_)
        ));
        assert_eq!(unresolved_intents(&path).unwrap().len(), 1);
        fs::remove_file(path).ok();
    }

    #[test]
    fn recent_confirmed_kill_switch_flatten_blocks_a_stale_snapshot_repeat() {
        let path = temp_db("kill-repeat");
        let first = NewMutationIntent {
            id: "flatten-1".into(),
            environment: TradingEnvironment::Sim,
            account_id: "SIM-1".into(),
            kind: "close_position".into(),
            equivalence_key: "close|position-1|1|6000".into(),
            symbol: Some("MESZ26".into()),
            action: "Close".into(),
            quantity: Some(1.0),
            order_type: Some("Market".into()),
            limit_price: None,
            stop_price: None,
            take_profit: None,
            stop_loss: None,
            target_id: Some("position-1".into()),
            request: serde_json::json!({"killSwitch":true}),
        };
        assert!(matches!(
            create_intent_with_recent_confirmed_guard(&path, first.clone(), Some(900)).unwrap(),
            CreateIntent::Created
        ));
        update_intent(
            &path,
            "flatten-1",
            MutationState::Accepted,
            Some("broker-order-1"),
            Some(&serde_json::json!({"id":"broker-order-1"})),
            "complete",
            "not_required",
            None,
            None,
            false,
        )
        .unwrap();

        let mut repeated = first;
        repeated.id = "flatten-2".into();
        let result = create_intent_with_recent_confirmed_guard(&path, repeated, Some(900)).unwrap();
        let CreateIntent::EquivalentBlocked(existing) = result else {
            panic!("stale repeated position snapshot must not create another flatten intent");
        };
        assert_eq!(existing.id, "flatten-1");
        assert!(load_intent(&path, "flatten-2").unwrap().is_none());
        fs::remove_file(path).ok();
    }

    #[test]
    fn confirmed_broker_object_survives_a_later_local_warning() {
        let path = temp_db("confirmed");
        let input = NewMutationIntent {
            id: "client-1".into(),
            environment: TradingEnvironment::Sim,
            account_id: "SIM-1".into(),
            kind: "cancel_order".into(),
            equivalence_key: "cancel|123".into(),
            symbol: None,
            action: "Cancel".into(),
            quantity: None,
            order_type: None,
            limit_price: None,
            stop_price: None,
            take_profit: None,
            stop_loss: None,
            target_id: Some("123".into()),
            request: serde_json::json!({"orderId":"123"}),
        };
        create_intent(&path, input).unwrap();
        update_intent(
            &path,
            "client-1",
            MutationState::Accepted,
            Some("123"),
            Some(&serde_json::json!({"id":"123","status":"Cancelled"})),
            "pending",
            "required",
            Some("Broker confirmed; journal completion is pending"),
            None,
            false,
        )
        .unwrap();
        let record = load_intent(&path, "client-1").unwrap().unwrap();
        assert_eq!(record.state, MutationState::Accepted);
        assert_eq!(record.local_persistence, "pending");
        assert!(record.broker_object.is_some());
        fs::remove_file(path).ok();
    }

    #[test]
    fn confirmed_place_replace_and_cancel_never_become_rejected_on_local_faults() {
        for kind in ["place_order", "replace_order", "cancel_order"] {
            let path = temp_db(kind);
            let id = format!("{kind}-1");
            create_intent(
                &path,
                NewMutationIntent {
                    id: id.clone(),
                    environment: TradingEnvironment::Sim,
                    account_id: "SIM-1".into(),
                    kind: kind.into(),
                    equivalence_key: format!("{kind}|target"),
                    symbol: Some("MESZ26".into()),
                    action: kind.into(),
                    quantity: Some(1.0),
                    order_type: Some("Market".into()),
                    limit_price: None,
                    stop_price: None,
                    take_profit: None,
                    stop_loss: None,
                    target_id: Some("123".into()),
                    request: serde_json::json!({"kind":kind}),
                },
            )
            .unwrap();
            let completion = record_confirmed(
                &path,
                &id,
                Some("123"),
                &serde_json::json!({"id":"123"}),
                Some("injected journal failure".into()),
            );
            assert_eq!(completion.local_persistence, "pending");
            assert_eq!(completion.reconciliation_status, "required");
            assert!(!completion.warnings.is_empty());
            let record = load_intent(&path, &id).unwrap().unwrap();
            assert_eq!(record.state, MutationState::Accepted);
            fs::remove_file(path).ok();
        }
    }

    #[test]
    fn post_broker_database_failure_still_returns_confirmed_persistence_warning() {
        let missing_parent = std::env::temp_dir()
            .join(format!("northstar-missing-{}", uuid::Uuid::new_v4()))
            .join("northstar.sqlite");
        let completion = record_confirmed(
            &missing_parent,
            "accepted-at-broker",
            Some("123"),
            &serde_json::json!({"id":"123"}),
            None,
        );
        assert_eq!(completion.local_persistence, "pending");
        assert!(completion
            .warnings
            .iter()
            .any(|warning| warning.contains("Broker confirmation remains authoritative")));
    }

    #[test]
    fn risk_limits_and_geometry_fail_closed_but_reducing_orders_remain_available() {
        let mut policy = RiskPolicy::default();
        policy.max_quantity_per_order = EnabledU32Limit {
            enabled: true,
            value: 1,
        };
        policy.max_risk_per_trade = EnabledF64Limit {
            enabled: true,
            value: 5.0,
        };
        let draft = draft();
        let decision = evaluate_risk(
            &policy,
            RiskContext {
                environment: &TradingEnvironment::Live,
                draft: &draft,
                meta: &meta(),
                contract_metadata: &HashMap::from([("MESZ26".into(), meta())]),
                positions: &[],
                orders: &[],
                balances: &[],
                market_price: Some(6000.0),
                live_armed: true,
                recent_order_count: Some(0),
                consecutive_losses: Some((0, Utc::now())),
                now: Utc::now(),
            },
        );
        assert!(!decision.allowed);
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("trade risk")));

        let position = Position {
            id: "p1".into(),
            symbol: draft.symbol.clone(),
            side: "Long".into(),
            quantity: 1.0,
            average_price: 6000.0,
            last: 6000.0,
            unrealized_pnl: 0.0,
            bid: None,
            ask: None,
            unrealized_pnl_percent: None,
            unrealized_pnl_quantity: None,
            initial_requirement: None,
            maintenance_margin: None,
            market_value: None,
            timestamp: None,
        };
        let mut close = draft;
        close.side = "Sell".into();
        close.order_type = "Market".into();
        close.limit_price = None;
        close.stop_loss = None;
        close.take_profit = None;
        let reducing = evaluate_risk(
            &policy,
            RiskContext {
                environment: &TradingEnvironment::Live,
                draft: &close,
                meta: &meta(),
                contract_metadata: &HashMap::from([("MESZ26".into(), meta())]),
                positions: &[position],
                orders: &[],
                balances: &[],
                market_price: Some(6000.0),
                live_armed: false,
                recent_order_count: None,
                consecutive_losses: None,
                now: Utc::now(),
            },
        );
        assert!(reducing.allowed);
        assert!(!reducing.risk_increasing);
    }

    #[tokio::test]
    async fn account_scoped_lock_serializes_check_and_submit() {
        let path = temp_db("locks");
        let safety = Arc::new(SafetyService::new(path.clone()));
        let first = safety.account_lock(&TradingEnvironment::Sim, "SIM-1").await;
        let second_service = safety.clone();
        let second = tokio::spawn(async move {
            let _guard = second_service
                .account_lock(&TradingEnvironment::Sim, "SIM-1")
                .await;
            true
        });
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        drop(first);
        assert!(second.await.unwrap());
        fs::remove_file(path).ok();
    }

    #[tokio::test]
    async fn lifecycle_generation_rejects_old_events_and_marks_transitions() {
        let lifecycle = ServiceLifecycle::default();
        let old = lifecycle.generation();
        assert!(lifecycle.accepts(old));
        let (_guard, next) = lifecycle.begin_transition().await;
        assert!(lifecycle.is_transitioning());
        assert!(!lifecycle.accepts(old));
        assert!(!lifecycle.accepts(next));
        lifecycle.finish_transition();
        assert!(!lifecycle.accepts(old));
        assert!(lifecycle.accepts(next));
    }

    #[test]
    fn every_configurable_risk_rule_and_bracket_geometry_is_enforced() {
        let mut policy = RiskPolicy::default();
        policy.max_quantity_per_order = EnabledU32Limit {
            enabled: true,
            value: 1,
        };
        policy.max_total_open_contracts = EnabledU32Limit {
            enabled: true,
            value: 1,
        };
        policy.max_risk_per_trade = EnabledF64Limit {
            enabled: true,
            value: 1.0,
        };
        policy.max_aggregate_open_risk = EnabledF64Limit {
            enabled: true,
            value: 1.0,
        };
        policy.max_realized_daily_loss = EnabledF64Limit {
            enabled: true,
            value: 100.0,
        };
        policy.required_protective_stop = true;
        policy.allowed_session = TradingSessionPolicy {
            enabled: true,
            timezone: "UTC".into(),
            start: "00:00".into(),
            end: "00:00".into(),
            weekdays: vec![1, 2, 3, 4, 5, 6, 7],
        };
        policy.consecutive_loss_cooldown = CooldownPolicy {
            enabled: true,
            threshold: 2,
            cooldown_minutes: 60,
        };
        policy.order_rate = OrderRatePolicy {
            enabled: true,
            max_orders: 1,
            window_seconds: 60,
            cooldown_seconds: 60,
        };
        let mut order = draft();
        order.quantity = 2;
        order.stop_loss = None;
        order.take_profit = Some(5999.0);
        let balance = AccountBalance {
            account_id: "SIM-1".into(),
            account_type: "Futures".into(),
            currency: "USD".into(),
            cash_balance: None,
            buying_power: None,
            equity: None,
            market_value: None,
            todays_profit_loss: None,
            realized_profit_loss: Some(-150.0),
            unrealized_profit_loss: None,
            uncleared_deposit: None,
            commission: None,
            initial_margin: None,
            maintenance_margin: None,
            open_order_margin: None,
            balance_date: None,
        };
        let metadata = HashMap::from([("MESZ26".into(), meta())]);
        let decision = evaluate_risk(
            &policy,
            RiskContext {
                environment: &TradingEnvironment::Live,
                draft: &order,
                meta: &meta(),
                contract_metadata: &metadata,
                positions: &[],
                orders: &[],
                balances: &[balance],
                market_price: Some(6000.0),
                live_armed: true,
                recent_order_count: Some(1),
                consecutive_losses: Some((2, Utc::now())),
                now: Utc::now(),
            },
        );
        for expected in [
            "target must be above",
            "Quantity",
            "protective stop",
            "open contracts",
            "trade risk",
            "aggregate",
            "daily loss",
            "outside",
            "cooldown",
            "Order-rate",
        ] {
            assert!(
                decision
                    .reasons
                    .iter()
                    .any(|reason| reason.contains(expected)),
                "missing {expected:?} in {:?}",
                decision.reasons
            );
        }
    }

    #[test]
    fn subscription_union_retains_other_consumers() {
        let mut requested = HashMap::from([
            ("chart".to_string(), HashSet::from(["ES".to_string()])),
            (
                "watchlist".to_string(),
                HashSet::from(["NQ".to_string(), "ES".to_string()]),
            ),
        ]);
        let union = |values: &HashMap<String, HashSet<String>>| {
            values
                .values()
                .flat_map(|symbols| symbols.iter().cloned())
                .collect::<HashSet<_>>()
        };
        assert_eq!(union(&requested).len(), 2);
        requested.remove("chart");
        assert_eq!(union(&requested), HashSet::from(["ES".into(), "NQ".into()]));
    }
}
