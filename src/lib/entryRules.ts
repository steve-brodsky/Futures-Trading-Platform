import type {
  Bar, EntryRuleCondition, EntryRuleEmaCrossCondition, EntryRuleGroup, EntryRuleNode, EntryRuleOperand,
  EntryRuleResult, EntryRules, EntryRuleSide, Quote,
} from "../types";
import { ema, sma } from "./indicators";

export const MAX_ENTRY_RULE_DEPTH = 4;
export const MAX_ENTRY_RULE_NODES = 100;
export const MIN_MOVING_AVERAGE_PERIOD = 1;
export const MAX_MOVING_AVERAGE_PERIOD = 1000;
export const MIN_EMA_CROSS_PERIOD = 2;
export const MAX_EMA_CROSS_PERIOD = 1000;
export const MIN_EMA_CROSS_LOOKBACK = 1;
export const MAX_EMA_CROSS_LOOKBACK = 1000;

export function emptyEntryRuleGroup(side: EntryRuleSide): EntryRuleGroup {
  return { id: `${side}-root`, kind: "group", combinator: "and", children: [] };
}

export function defaultEntryRules(): EntryRules {
  return { long: emptyEntryRuleGroup("long"), short: emptyEntryRuleGroup("short") };
}

export function sameEntryRuleOperand(left: EntryRuleOperand, right: EntryRuleOperand): boolean {
  return left.kind === right.kind && (left.kind === "marketPrice"
    || (right.kind === "movingAverage" && left.average === right.average && left.period === right.period));
}

function normalizeOperand(value: unknown): EntryRuleOperand | null {
  if (!value || typeof value !== "object") return null;
  const operand = value as { kind?: unknown; average?: unknown; period?: unknown };
  if (operand.kind === "marketPrice") return { kind: "marketPrice" };
  if (operand.kind !== "movingAverage" || !["EMA", "SMA"].includes(String(operand.average))
    || !Number.isInteger(operand.period) || Number(operand.period) < MIN_MOVING_AVERAGE_PERIOD
    || Number(operand.period) > MAX_MOVING_AVERAGE_PERIOD) return null;
  return { kind: "movingAverage", average: operand.average as "EMA" | "SMA", period: Number(operand.period) };
}

function normalizeSide(value: unknown, side: EntryRuleSide): EntryRuleGroup {
  const ids = new Set<string>();
  let nodeCount = 0;
  let invalid = false;

  function visit(raw: unknown, groupDepth: number, root = false): EntryRuleNode | null {
    if (!raw || typeof raw !== "object" || invalid) { invalid = true; return null; }
    const node = raw as Record<string, unknown>;
    if (typeof node.id !== "string" || !node.id.trim() || ids.has(node.id)) { invalid = true; return null; }
    ids.add(node.id);
    nodeCount += 1;
    if (nodeCount > MAX_ENTRY_RULE_NODES) { invalid = true; return null; }

    if (node.kind === "condition") {
      const left = normalizeOperand(node.left);
      const right = normalizeOperand(node.right);
      if (!left || !right || !["above", "below"].includes(String(node.operator)) || sameEntryRuleOperand(left, right)) {
        invalid = true;
        return null;
      }
      return { id: node.id, kind: "condition", left, operator: node.operator as "above" | "below", right };
    }

    if (node.kind === "emaCross") {
      if (!["above", "below", "either"].includes(String(node.direction))
        || !Number.isInteger(node.period) || Number(node.period) < MIN_EMA_CROSS_PERIOD
        || Number(node.period) > MAX_EMA_CROSS_PERIOD
        || !Number.isInteger(node.lookback) || Number(node.lookback) < MIN_EMA_CROSS_LOOKBACK
        || Number(node.lookback) > MAX_EMA_CROSS_LOOKBACK) {
        invalid = true;
        return null;
      }
      return {
        id: node.id,
        kind: "emaCross",
        direction: node.direction as EntryRuleEmaCrossCondition["direction"],
        period: Number(node.period),
        lookback: Number(node.lookback),
      };
    }

    if (node.kind !== "group" || !["and", "or"].includes(String(node.combinator))
      || !Array.isArray(node.children) || groupDepth > MAX_ENTRY_RULE_DEPTH || (!root && node.children.length === 0)) {
      invalid = true;
      return null;
    }
    const children = node.children.map((child) => {
      const isGroup = child && typeof child === "object" && (child as { kind?: unknown }).kind === "group";
      return visit(child, groupDepth + (isGroup ? 1 : 0));
    });
    if (invalid || children.some((child) => child == null)) return null;
    return { id: node.id, kind: "group", combinator: node.combinator as "and" | "or", children: children as EntryRuleNode[] };
  }

  const normalized = visit(value, 1, true);
  return !invalid && normalized?.kind === "group" ? normalized : emptyEntryRuleGroup(side);
}

export function normalizeEntryRules(value: unknown): EntryRules {
  const rules = value && typeof value === "object" ? value as Partial<EntryRules> : {};
  return { long: normalizeSide(rules.long, "long"), short: normalizeSide(rules.short, "short") };
}

export function hasConfiguredEntryRules(rules: EntryRules): boolean {
  return rules.long.children.length > 0 || rules.short.children.length > 0;
}

function operandLabel(operand: EntryRuleOperand, side: EntryRuleSide): string {
  if (operand.kind === "marketPrice") return side === "long" ? "Ask" : "Bid";
  return `${operand.average} ${operand.period}`;
}

interface OperandValue { value: number | null; reason?: string }
interface NodeEvaluation { status: EntryRuleResult["status"]; reason: string }

function evaluateSide(root: EntryRuleGroup, side: EntryRuleSide, bars: Bar[], quote: Quote): EntryRuleResult {
  const nodeResults: Record<string, boolean | null> = {};
  const closes = bars.map((bar) => bar.close);
  const closedCloses = bars.filter((bar) => bar.realtime !== true).map((bar) => bar.close);
  const averages = new Map<string, number | null>();
  const closedEmaValues = new Map<number, Array<number | null>>();

  function operandValue(operand: EntryRuleOperand): OperandValue {
    if (operand.kind === "marketPrice") {
      const value = side === "long" ? quote.ask : quote.bid;
      return Number.isFinite(value) && value > 0 ? { value } : { value: null, reason: `Waiting for a valid ${side === "long" ? "ask" : "bid"} price.` };
    }
    const key = `${operand.average}:${operand.period}`;
    if (!averages.has(key)) {
      const values = operand.average === "EMA" ? ema(closes, operand.period) : sma(closes, operand.period);
      averages.set(key, values.at(-1) ?? null);
    }
    const value = averages.get(key) ?? null;
    return value == null
      ? { value: null, reason: `Waiting for ${operand.average} ${operand.period} (${bars.length}/${operand.period} bars).` }
      : { value };
  }

  function condition(node: EntryRuleCondition): NodeEvaluation {
    const left = operandValue(node.left);
    const right = operandValue(node.right);
    if (left.value == null || right.value == null) {
      nodeResults[node.id] = null;
      return { status: "waiting", reason: left.reason ?? right.reason ?? "Waiting for market data." };
    }
    const passed = node.operator === "above" ? left.value > right.value : left.value < right.value;
    nodeResults[node.id] = passed;
    const comparison = `${operandLabel(node.left, side)} ${node.operator} ${operandLabel(node.right, side)}`;
    return passed
      ? { status: "allowed", reason: `${comparison} passes.` }
      : { status: "blocked", reason: `${comparison} is false (${left.value.toFixed(4)} vs ${right.value.toFixed(4)}).` };
  }

  function emaCross(node: EntryRuleEmaCrossCondition): NodeEvaluation {
    if (!closedEmaValues.has(node.period)) closedEmaValues.set(node.period, ema(closedCloses, node.period));
    const values = closedEmaValues.get(node.period)!;
    const firstCandidate = Math.max(1, closedCloses.length - node.lookback);

    for (let index = closedCloses.length - 1; index >= firstCandidate; index -= 1) {
      const previousAverage = values[index - 1];
      const currentAverage = values[index];
      if (previousAverage == null || currentAverage == null) continue;
      const crossedAbove = closedCloses[index - 1] <= previousAverage && closedCloses[index] > currentAverage;
      const crossedBelow = closedCloses[index - 1] >= previousAverage && closedCloses[index] < currentAverage;
      const direction = crossedAbove ? "above" : crossedBelow ? "below" : null;
      if (!direction || (node.direction !== "either" && direction !== node.direction)) continue;

      nodeResults[node.id] = true;
      const candlesAgo = closedCloses.length - 1 - index;
      const timing = candlesAgo === 0 ? "on the most recent closed candle"
        : `${candlesAgo} closed candle${candlesAgo === 1 ? "" : "s"} ago`;
      return { status: "allowed", reason: `EMA ${node.period} crossed ${direction} ${timing}.` };
    }

    const requiredBars = node.period + node.lookback;
    if (closedCloses.length < requiredBars) {
      nodeResults[node.id] = null;
      return {
        status: "waiting",
        reason: `Waiting for EMA ${node.period} crossover history (${closedCloses.length}/${requiredBars} closed candles).`,
      };
    }

    nodeResults[node.id] = false;
    const direction = node.direction === "either" ? "in either direction" : node.direction;
    return {
      status: "blocked",
      reason: `EMA ${node.period} did not cross ${direction} within the last ${node.lookback} closed candle${node.lookback === 1 ? "" : "s"}.`,
    };
  }

  function group(node: EntryRuleGroup, rootGroup = false): NodeEvaluation {
    if (rootGroup && node.children.length === 0) {
      nodeResults[node.id] = true;
      return { status: "allowed", reason: `No ${side === "long" ? "Long" : "Short"} entry rules configured.` };
    }
    const results = node.children.map((child) => child.kind === "group" ? group(child)
      : child.kind === "emaCross" ? emaCross(child) : condition(child));
    let status: EntryRuleResult["status"];
    if (node.combinator === "and") {
      status = results.some((result) => result.status === "blocked") ? "blocked"
        : results.some((result) => result.status === "waiting") ? "waiting" : "allowed";
    } else {
      status = results.some((result) => result.status === "allowed") ? "allowed"
        : results.some((result) => result.status === "waiting") ? "waiting" : "blocked";
    }
    nodeResults[node.id] = status === "waiting" ? null : status === "allowed";
    const decisive = status === "allowed"
      ? results.find((result) => result.status === "allowed")
      : results.find((result) => result.status === "blocked") ?? results.find((result) => result.status === "waiting");
    return { status, reason: decisive?.reason ?? "Rule group has no valid conditions." };
  }

  const result = group(root, true);
  return { allowed: result.status === "allowed", status: result.status, reason: result.reason, nodeResults };
}

export function evaluateEntryRules(rules: EntryRules, bars: Bar[], quote: Quote): Record<EntryRuleSide, EntryRuleResult> {
  return {
    long: evaluateSide(rules.long, "long", bars, quote),
    short: evaluateSide(rules.short, "short", bars, quote),
  };
}
