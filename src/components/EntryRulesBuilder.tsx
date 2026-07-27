import { useMemo, useState } from "react";
import { AlertCircle, Check, Clock3, GitBranch, Plus, Trash2 } from "lucide-react";
import type {
  AlertDurationSeconds, AlertSound, Bar, EntryRuleAlertConfig, EntryRuleCondition, EntryRuleEmaCrossCondition,
  EntryRuleGroup, EntryRuleNode, EntryRuleOperand, EntryRules, EntryRuleSide, EntryRuleTimeWindowCondition,
  EntryRuleTimezone, EntryRuleWeekday, Quote,
} from "../types";
import { playAlertSound, prepareAlertAudio } from "../lib/alertAudio";
import { ALERT_DURATIONS, ALERT_SOUNDS } from "../lib/emaAlerts";
import {
  ALL_ENTRY_RULE_WEEKDAYS, emptyEntryRuleGroup, ENTRY_RULE_WEEKDAY_LABELS, evaluateEntryRules,
  formatEntryRuleCurrentTime, MAX_ENTRY_RULE_DEPTH, MAX_ENTRY_RULE_NODES,
  MAX_EMA_CROSS_LOOKBACK, MAX_EMA_CROSS_PERIOD, MAX_MOVING_AVERAGE_PERIOD,
  MIN_EMA_CROSS_LOOKBACK, MIN_EMA_CROSS_PERIOD, MIN_MOVING_AVERAGE_PERIOD, sameEntryRuleOperand,
  validEntryRuleTime, validEntryRuleTimezone,
} from "../lib/entryRules";
import { entryRuleTimezoneOptions } from "../lib/timezone";

interface Props {
  rules: EntryRules;
  alerts: EntryRuleAlertConfig;
  bars: Bar[];
  quote: Quote;
  evaluatedAt: number;
  onSave: (rules: EntryRules, alerts: EntryRuleAlertConfig) => void;
  onClose: () => void;
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function newCondition(): EntryRuleCondition {
  return {
    id: id("condition"), kind: "condition", left: { kind: "marketPrice" }, operator: "above",
    right: { kind: "movingAverage", average: "EMA", period: 20 },
  };
}

function newEmaCrossCondition(): EntryRuleEmaCrossCondition {
  return { id: id("ema-cross"), kind: "emaCross", direction: "above", period: 20, lookback: 5 };
}

function newTimeWindowCondition(): EntryRuleTimeWindowCondition {
  return {
    id: id("time-window"),
    kind: "timeWindow",
    startTime: "09:30",
    endTime: "16:00",
    weekdays: [...ALL_ENTRY_RULE_WEEKDAYS],
    timezone: "",
  };
}

function newGroup(combinator: "and" | "or"): EntryRuleGroup {
  return { id: id("group"), kind: "group", combinator, children: [newCondition()] };
}

function updateNode(group: EntryRuleGroup, nodeId: string, update: (node: EntryRuleNode) => EntryRuleNode): EntryRuleGroup {
  if (group.id === nodeId) return update(group) as EntryRuleGroup;
  return {
    ...group,
    children: group.children.map((child) => {
      if (child.id === nodeId) return update(child);
      return child.kind === "group" ? updateNode(child, nodeId, update) : child;
    }),
  };
}

function removeNode(group: EntryRuleGroup, nodeId: string): EntryRuleGroup {
  return {
    ...group,
    children: group.children
      .filter((child) => child.id !== nodeId)
      .map((child) => child.kind === "group" ? removeNode(child, nodeId) : child),
  };
}

function countNodes(node: EntryRuleNode): number {
  return 1 + (node.kind === "group" ? node.children.reduce((total, child) => total + countNodes(child), 0) : 0);
}

function validationError(group: EntryRuleGroup, depth = 1, root = true): string | null {
  if (depth > MAX_ENTRY_RULE_DEPTH) return `Groups can be nested up to ${MAX_ENTRY_RULE_DEPTH} levels.`;
  if (!root && group.children.length === 0) return "Nested groups need at least one condition.";
  for (const child of group.children) {
    if (child.kind === "group") {
      const error = validationError(child, depth + 1, false);
      if (error) return error;
    } else if (child.kind === "emaCross") {
      if (!Number.isInteger(child.period) || child.period < MIN_EMA_CROSS_PERIOD || child.period > MAX_EMA_CROSS_PERIOD
        || !Number.isInteger(child.lookback) || child.lookback < MIN_EMA_CROSS_LOOKBACK || child.lookback > MAX_EMA_CROSS_LOOKBACK) {
        return `EMA cross conditions need an EMA period from ${MIN_EMA_CROSS_PERIOD} to ${MAX_EMA_CROSS_PERIOD} and a lookback from ${MIN_EMA_CROSS_LOOKBACK} to ${MAX_EMA_CROSS_LOOKBACK}.`;
      }
    } else if (child.kind === "timeWindow") {
      if (!validEntryRuleTime(child.startTime) || !validEntryRuleTime(child.endTime)) {
        return "Time windows need valid start and end times.";
      }
      if (child.startTime === child.endTime) return "Time window start and end must be different.";
      if (!child.weekdays.length) return "Time windows need at least one session start day.";
      if (!validEntryRuleTimezone(child.timezone)) return "Choose a timezone for every time window.";
    } else if (!Number.isInteger(child.left.kind === "movingAverage" ? child.left.period : 1)
      || !Number.isInteger(child.right.kind === "movingAverage" ? child.right.period : 1)
      || sameEntryRuleOperand(child.left, child.right)) {
      return "Each condition must compare two different, valid operands.";
    }
  }
  return null;
}

function TimeWindowEditor({
  value,
  evaluatedAt,
  nodeResult,
  onChange,
  onRemove,
}: {
  value: EntryRuleTimeWindowCondition;
  evaluatedAt: number;
  nodeResult: boolean | null;
  onChange: (value: EntryRuleTimeWindowCondition) => void;
  onRemove: () => void;
}) {
  const toggleWeekday = (weekday: EntryRuleWeekday) => {
    const weekdays = value.weekdays.includes(weekday)
      ? value.weekdays.filter((item) => item !== weekday)
      : [...value.weekdays, weekday].sort((left, right) => left - right);
    onChange({ ...value, weekdays });
  };
  return <div className={`entry-rule-condition entry-rule-time-window ${nodeResult == null ? "waiting" : nodeResult ? "passing" : "failing"}`}>
    <span className="entry-rule-condition-state">{nodeResult == null ? <Clock3 size={13} /> : nodeResult ? <Check size={13} /> : <AlertCircle size={13} />}</span>
    <div className="entry-rule-time-editor">
      <div className="entry-rule-time-primary">
        <span>Entries from</span>
        <input type="time" step={60} aria-label="Time window start" value={value.startTime} onChange={(event) => onChange({ ...value, startTime: event.target.value })} />
        <span>to</span>
        <input type="time" step={60} aria-label="Time window end" value={value.endTime} onChange={(event) => onChange({ ...value, endTime: event.target.value })} />
        <span>in</span>
        <select aria-label="Time window timezone" value={value.timezone} onChange={(event) => onChange({ ...value, timezone: event.target.value as EntryRuleTimezone | "" })}>
          <option value="">Select timezone</option>
          {entryRuleTimezoneOptions.map((option) => <option key={option.value} value={option.value}>{option.label} · {option.value}</option>)}
        </select>
      </div>
      <div className="entry-rule-weekdays" aria-label="Session start days">
        <span>Starts</span>
        {ALL_ENTRY_RULE_WEEKDAYS.map((weekday) => <button
          type="button"
          key={weekday}
          aria-label={`${value.weekdays.includes(weekday) ? "Remove" : "Add"} ${ENTRY_RULE_WEEKDAY_LABELS[weekday]}`}
          aria-pressed={value.weekdays.includes(weekday)}
          title={`${ENTRY_RULE_WEEKDAY_LABELS[weekday]} session start`}
          onClick={() => toggleWeekday(weekday)}
        >{ENTRY_RULE_WEEKDAY_LABELS[weekday].slice(0, 1)}</button>)}
        <small>{validEntryRuleTimezone(value.timezone)
          ? `Now ${formatEntryRuleCurrentTime(evaluatedAt, value.timezone)}`
          : "Timezone required"}</small>
      </div>
    </div>
    <button className="entry-rule-icon danger" aria-label="Remove time window" title="Remove time window" onClick={onRemove}><Trash2 size={13} /></button>
  </div>;
}

function OperandEditor({ value, onChange }: { value: EntryRuleOperand; onChange: (operand: EntryRuleOperand) => void }) {
  const key = value.kind === "marketPrice" ? "price" : value.average;
  return <div className="entry-rule-operand">
    <select value={key} aria-label="Rule operand" onChange={(event) => {
      if (event.target.value === "price") onChange({ kind: "marketPrice" });
      else onChange({ kind: "movingAverage", average: event.target.value as "EMA" | "SMA", period: value.kind === "movingAverage" ? value.period : 20 });
    }}>
      <option value="price">Market price</option>
      <option value="EMA">EMA</option>
      <option value="SMA">SMA</option>
    </select>
    {value.kind === "movingAverage" && <input
      type="number" aria-label={`${value.average} period`} min={MIN_MOVING_AVERAGE_PERIOD} max={MAX_MOVING_AVERAGE_PERIOD}
      value={value.period} onChange={(event) => onChange({ ...value, period: Math.max(MIN_MOVING_AVERAGE_PERIOD, Math.min(MAX_MOVING_AVERAGE_PERIOD, Number(event.target.value) || 1)) })}
    />}
  </div>;
}

interface GroupEditorProps {
  group: EntryRuleGroup;
  root: EntryRuleGroup;
  depth: number;
  nodeResults: Record<string, boolean | null>;
  evaluatedAt: number;
  onChange: (group: EntryRuleGroup) => void;
  onRemove?: () => void;
}

function GroupEditor({ group, root, depth, nodeResults, evaluatedAt, onChange, onRemove }: GroupEditorProps) {
  const nodeCount = countNodes(root);
  const atNodeLimit = nodeCount >= MAX_ENTRY_RULE_NODES;
  const patchNode = (nodeId: string, update: (node: EntryRuleNode) => EntryRuleNode) => onChange(updateNode(root, nodeId, update));
  return <div className={`entry-rule-group depth-${depth}`}>
    <div className="entry-rule-group-head">
      <GitBranch size={13} />
      <span>Match</span>
      <select value={group.combinator} aria-label="Group logic" onChange={(event) => patchNode(group.id, (node) => ({ ...node as EntryRuleGroup, combinator: event.target.value as "and" | "or" }))}>
        <option value="and">all conditions</option>
        <option value="or">any condition</option>
      </select>
      {onRemove && <button className="entry-rule-icon danger" aria-label="Remove group" title="Remove group" onClick={onRemove}><Trash2 size={13} /></button>}
    </div>
    <div className="entry-rule-children">
      {group.children.map((child) => child.kind === "group"
        ? <GroupEditor key={child.id} group={child} root={root} depth={depth + 1} nodeResults={nodeResults} evaluatedAt={evaluatedAt} onChange={onChange} onRemove={() => onChange(removeNode(root, child.id))} />
        : child.kind === "emaCross"
          ? <div key={child.id} className={`entry-rule-condition entry-rule-ema-cross ${nodeResults[child.id] == null ? "waiting" : nodeResults[child.id] ? "passing" : "failing"}`}>
            <span className="entry-rule-condition-state">{nodeResults[child.id] == null ? <AlertCircle size={13} /> : nodeResults[child.id] ? <Check size={13} /> : <AlertCircle size={13} />}</span>
            <div className="entry-rule-ema-cross-editor">
              <span>Closed candle crossed</span>
              <select aria-label="EMA cross direction" value={child.direction} onChange={(event) => patchNode(child.id, (node) => ({ ...node as EntryRuleEmaCrossCondition, direction: event.target.value as EntryRuleEmaCrossCondition["direction"] }))}>
                <option value="above">above</option>
                <option value="below">below</option>
                <option value="either">either way across</option>
              </select>
              <span>EMA</span>
              <input type="number" aria-label="EMA cross period" min={MIN_EMA_CROSS_PERIOD} max={MAX_EMA_CROSS_PERIOD} value={child.period} onChange={(event) => patchNode(child.id, (node) => ({ ...node as EntryRuleEmaCrossCondition, period: Math.max(MIN_EMA_CROSS_PERIOD, Math.min(MAX_EMA_CROSS_PERIOD, Math.round(Number(event.target.value) || MIN_EMA_CROSS_PERIOD))) }))} />
              <span>within</span>
              <input type="number" aria-label="EMA cross lookback" min={MIN_EMA_CROSS_LOOKBACK} max={MAX_EMA_CROSS_LOOKBACK} value={child.lookback} onChange={(event) => patchNode(child.id, (node) => ({ ...node as EntryRuleEmaCrossCondition, lookback: Math.max(MIN_EMA_CROSS_LOOKBACK, Math.min(MAX_EMA_CROSS_LOOKBACK, Math.round(Number(event.target.value) || MIN_EMA_CROSS_LOOKBACK))) }))} />
              <span>closed candles</span>
            </div>
            <button className="entry-rule-icon danger" aria-label="Remove EMA cross condition" title="Remove EMA cross condition" onClick={() => onChange(removeNode(root, child.id))}><Trash2 size={13} /></button>
          </div>
        : child.kind === "timeWindow"
          ? <TimeWindowEditor
            key={child.id}
            value={child}
            evaluatedAt={evaluatedAt}
            nodeResult={nodeResults[child.id]}
            onChange={(value) => patchNode(child.id, () => value)}
            onRemove={() => onChange(removeNode(root, child.id))}
          />
        : <div key={child.id} className={`entry-rule-condition ${nodeResults[child.id] == null ? "waiting" : nodeResults[child.id] ? "passing" : "failing"}`}>
          <span className="entry-rule-condition-state">{nodeResults[child.id] == null ? <AlertCircle size={13} /> : nodeResults[child.id] ? <Check size={13} /> : <AlertCircle size={13} />}</span>
          <OperandEditor value={child.left} onChange={(left) => patchNode(child.id, (node) => ({ ...node as EntryRuleCondition, left }))} />
          <select className="entry-rule-operator" aria-label="Comparison" value={child.operator} onChange={(event) => patchNode(child.id, (node) => ({ ...node as EntryRuleCondition, operator: event.target.value as "above" | "below" }))}>
            <option value="above">is above</option>
            <option value="below">is below</option>
          </select>
          <OperandEditor value={child.right} onChange={(right) => patchNode(child.id, (node) => ({ ...node as EntryRuleCondition, right }))} />
          <button className="entry-rule-icon danger" aria-label="Remove condition" title="Remove condition" onClick={() => onChange(removeNode(root, child.id))}><Trash2 size={13} /></button>
        </div>)}
      {!group.children.length && <p className="entry-rule-empty">No conditions. This direction is unrestricted.</p>}
    </div>
    <div className="entry-rule-add-row">
      <button disabled={atNodeLimit} onClick={() => patchNode(group.id, (node) => ({ ...node as EntryRuleGroup, children: [...(node as EntryRuleGroup).children, newCondition()] }))}><Plus size={12} />Condition</button>
      <button disabled={atNodeLimit} onClick={() => patchNode(group.id, (node) => ({ ...node as EntryRuleGroup, children: [...(node as EntryRuleGroup).children, newEmaCrossCondition()] }))}><Plus size={12} />EMA cross</button>
      <button disabled={atNodeLimit} onClick={() => patchNode(group.id, (node) => ({ ...node as EntryRuleGroup, children: [...(node as EntryRuleGroup).children, newTimeWindowCondition()] }))}><Plus size={12} />Time window</button>
      <button disabled={nodeCount > MAX_ENTRY_RULE_NODES - 2 || depth >= MAX_ENTRY_RULE_DEPTH} onClick={() => patchNode(group.id, (node) => ({ ...node as EntryRuleGroup, children: [...(node as EntryRuleGroup).children, newGroup("and")] }))}><Plus size={12} />AND group</button>
      <button disabled={nodeCount > MAX_ENTRY_RULE_NODES - 2 || depth >= MAX_ENTRY_RULE_DEPTH} onClick={() => patchNode(group.id, (node) => ({ ...node as EntryRuleGroup, children: [...(node as EntryRuleGroup).children, newGroup("or")] }))}><Plus size={12} />OR group</button>
    </div>
  </div>;
}

export function EntryRulesBuilder({ rules, alerts, bars, quote, evaluatedAt, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<EntryRules>(() => structuredClone(rules));
  const [draftAlerts, setDraftAlerts] = useState<EntryRuleAlertConfig>(() => structuredClone(alerts));
  const evaluation = useMemo(() => evaluateEntryRules(draft, bars, quote, evaluatedAt), [draft, bars, quote, evaluatedAt]);
  const error = validationError(draft.long) ?? validationError(draft.short)
    ?? (countNodes(draft.long) > MAX_ENTRY_RULE_NODES || countNodes(draft.short) > MAX_ENTRY_RULE_NODES ? `A direction can contain up to ${MAX_ENTRY_RULE_NODES} nodes.` : null);

  const setSide = (side: EntryRuleSide, group: EntryRuleGroup) => {
    setDraft((current) => ({ ...current, [side]: group }));
    if (!group.children.length) setDraftAlerts((current) => ({
      ...current,
      [side]: { ...current[side], enabled: false },
    }));
  };
  const setAlert = (side: EntryRuleSide, patch: Partial<EntryRuleAlertConfig[EntryRuleSide]>) => {
    setDraftAlerts((current) => ({ ...current, [side]: { ...current[side], ...patch } }));
  };
  return <div className="entry-rules-builder">
    <p className="entry-rules-intro">Market rules use each open chart's timeframe and live ask for Long or bid for Short. Time windows use their selected timezone. Empty directions stay unrestricted.</p>
    {(["long", "short"] as const).map((side) => {
      const result = evaluation[side];
      return <section className={`entry-rule-side ${side}`} key={side}>
        <header>
          <div><strong>{side === "long" ? "Long entry" : "Short entry"}</strong><small>{side === "long" ? "Controls Buy market orders" : "Controls Sell market orders"}</small></div>
          <span className={`entry-rule-status ${result.status}`}>{result.status === "allowed" ? "Allowed" : result.status === "waiting" ? "Waiting" : "Blocked"}</span>
          <button className="entry-rule-clear" onClick={() => setSide(side, emptyEntryRuleGroup(side))}>Clear</button>
        </header>
        <p className="entry-rule-reason">{result.reason}</p>
        <div className={`entry-rule-alert-controls ${draftAlerts[side].enabled ? "enabled" : ""}`}>
          <button type="button" className="entry-rule-alert-toggle" disabled={!draft[side].children.length} aria-pressed={draftAlerts[side].enabled} onClick={() => {
            prepareAlertAudio();
            setAlert(side, { enabled: !draftAlerts[side].enabled });
          }}><span><strong>Alert when allowed</strong><small>{draft[side].children.length ? `Monitor ${side === "long" ? "Long" : "Short"} across every open chart` : "Add a rule condition to enable alerts"}</small></span><span className={`toggle ${draftAlerts[side].enabled ? "on" : ""}`} /></button>
          <label><span>Sound</span><select aria-label={`${side} entry alert sound`} disabled={!draftAlerts[side].enabled} value={draftAlerts[side].sound} onChange={(event) => setAlert(side, { sound: event.target.value as AlertSound })}>{ALERT_SOUNDS.map((sound) => <option key={sound.value} value={sound.value}>{sound.label}</option>)}</select></label>
          <label><span>Duration</span><select aria-label={`${side} entry alert duration`} disabled={!draftAlerts[side].enabled} value={draftAlerts[side].durationSeconds} onChange={(event) => setAlert(side, { durationSeconds: Number(event.target.value) as AlertDurationSeconds })}>{ALERT_DURATIONS.map((duration) => <option key={duration} value={duration}>{duration}s</option>)}</select></label>
          <button type="button" className="entry-rule-alert-preview" disabled={!draftAlerts[side].enabled} onClick={() => playAlertSound(draftAlerts[side].sound, draftAlerts[side].durationSeconds)}>Preview</button>
        </div>
        <GroupEditor group={draft[side]} root={draft[side]} depth={1} nodeResults={result.nodeResults} evaluatedAt={evaluatedAt} onChange={(group) => setSide(side, group)} />
      </section>;
    })}
    {error && <p className="entry-rule-validation"><AlertCircle size={14} />{error}</p>}
    <div className="entry-rule-actions">
      <button className="secondary-button" onClick={onClose}>Cancel</button>
      <button className="primary-button" disabled={Boolean(error)} onClick={() => onSave(structuredClone(draft), structuredClone(draftAlerts))}>Save rules</button>
    </div>
  </div>;
}
