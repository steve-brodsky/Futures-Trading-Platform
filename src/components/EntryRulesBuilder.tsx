import { useMemo, useState } from "react";
import { AlertCircle, Check, GitBranch, Plus, Trash2 } from "lucide-react";
import type {
  Bar, EntryRuleCondition, EntryRuleGroup, EntryRuleNode, EntryRuleOperand,
  EntryRules, EntryRuleSide, Quote,
} from "../types";
import {
  emptyEntryRuleGroup, evaluateEntryRules, MAX_ENTRY_RULE_DEPTH, MAX_ENTRY_RULE_NODES,
  MAX_MOVING_AVERAGE_PERIOD, MIN_MOVING_AVERAGE_PERIOD, sameEntryRuleOperand,
} from "../lib/entryRules";

interface Props {
  rules: EntryRules;
  bars: Bar[];
  quote: Quote;
  onSave: (rules: EntryRules) => void;
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
    } else if (!Number.isInteger(child.left.kind === "movingAverage" ? child.left.period : 1)
      || !Number.isInteger(child.right.kind === "movingAverage" ? child.right.period : 1)
      || sameEntryRuleOperand(child.left, child.right)) {
      return "Each condition must compare two different, valid operands.";
    }
  }
  return null;
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
  onChange: (group: EntryRuleGroup) => void;
  onRemove?: () => void;
}

function GroupEditor({ group, root, depth, nodeResults, onChange, onRemove }: GroupEditorProps) {
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
        ? <GroupEditor key={child.id} group={child} root={root} depth={depth + 1} nodeResults={nodeResults} onChange={onChange} onRemove={() => onChange(removeNode(root, child.id))} />
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
      <button disabled={nodeCount > MAX_ENTRY_RULE_NODES - 2 || depth >= MAX_ENTRY_RULE_DEPTH} onClick={() => patchNode(group.id, (node) => ({ ...node as EntryRuleGroup, children: [...(node as EntryRuleGroup).children, newGroup("and")] }))}><Plus size={12} />AND group</button>
      <button disabled={nodeCount > MAX_ENTRY_RULE_NODES - 2 || depth >= MAX_ENTRY_RULE_DEPTH} onClick={() => patchNode(group.id, (node) => ({ ...node as EntryRuleGroup, children: [...(node as EntryRuleGroup).children, newGroup("or")] }))}><Plus size={12} />OR group</button>
    </div>
  </div>;
}

export function EntryRulesBuilder({ rules, bars, quote, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<EntryRules>(() => structuredClone(rules));
  const evaluation = useMemo(() => evaluateEntryRules(draft, bars, quote), [draft, bars, quote]);
  const error = validationError(draft.long) ?? validationError(draft.short)
    ?? (countNodes(draft.long) > MAX_ENTRY_RULE_NODES || countNodes(draft.short) > MAX_ENTRY_RULE_NODES ? `A direction can contain up to ${MAX_ENTRY_RULE_NODES} nodes.` : null);

  const setSide = (side: EntryRuleSide, group: EntryRuleGroup) => setDraft((current) => ({ ...current, [side]: group }));
  return <div className="entry-rules-builder">
    <p className="entry-rules-intro">Rules use the active chart timeframe and live ask for Long or bid for Short. Empty directions stay unrestricted.</p>
    {(["long", "short"] as const).map((side) => {
      const result = evaluation[side];
      return <section className={`entry-rule-side ${side}`} key={side}>
        <header>
          <div><strong>{side === "long" ? "Long entry" : "Short entry"}</strong><small>{side === "long" ? "Controls Buy market orders" : "Controls Sell market orders"}</small></div>
          <span className={`entry-rule-status ${result.status}`}>{result.status === "allowed" ? "Allowed" : result.status === "waiting" ? "Waiting" : "Blocked"}</span>
          <button className="entry-rule-clear" onClick={() => setSide(side, emptyEntryRuleGroup(side))}>Clear</button>
        </header>
        <p className="entry-rule-reason">{result.reason}</p>
        <GroupEditor group={draft[side]} root={draft[side]} depth={1} nodeResults={result.nodeResults} onChange={(group) => setSide(side, group)} />
      </section>;
    })}
    {error && <p className="entry-rule-validation"><AlertCircle size={14} />{error}</p>}
    <div className="entry-rule-actions">
      <button className="secondary-button" onClick={onClose}>Cancel</button>
      <button className="primary-button" disabled={Boolean(error)} onClick={() => onSave(structuredClone(draft))}>Save rules</button>
    </div>
  </div>;
}
