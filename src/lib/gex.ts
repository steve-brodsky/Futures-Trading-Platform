import type {
  GexExpirationSelection,
  GexTabSettings,
  OptionContract,
  OptionExpiration,
} from "../types";

export interface GexLevel {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
}

export interface GexCalculation {
  levels: GexLevel[];
  excludedCount: number;
  netGex: number;
  callGex: number;
  putGex: number;
}

export const defaultGexSelection = (): GexExpirationSelection => ({ mode: "front", expirationDates: [] });
export const defaultGexTabSettings = (): GexTabSettings => ({ enabled: false, view: "net" });

export function normalizeGexTabSettings(value: unknown): GexTabSettings {
  const record = value && typeof value === "object" ? value as Partial<GexTabSettings> : {};
  return {
    enabled: record.enabled === true,
    view: record.view === "calls-puts" ? "calls-puts" : "net",
  };
}

export function normalizeGexSelection(value: unknown): GexExpirationSelection {
  const record = value && typeof value === "object" ? value as Partial<GexExpirationSelection> : {};
  const mode = ["front", "next-four", "all", "custom"].includes(record.mode ?? "")
    ? record.mode as GexExpirationSelection["mode"]
    : "front";
  const expirationDates = Array.isArray(record.expirationDates)
    ? [...new Set(record.expirationDates.filter((date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort()
    : [];
  return { mode, expirationDates };
}

export function resolveGexExpirations(
  expirations: OptionExpiration[],
  selection: GexExpirationSelection,
): string[] {
  const available = expirations
    .filter((item) => item.standard && item.daysToExpiration >= 0)
    .map((item) => item.expirationDate)
    .sort();
  if (!available.length) return [];
  if (selection.mode === "all") return available;
  if (selection.mode === "next-four") return available.slice(0, 4);
  if (selection.mode === "custom") {
    const selected = selection.expirationDates.filter((date) => available.includes(date));
    return selected.length ? selected : available.slice(0, 1);
  }
  return available.slice(0, 1);
}

export function rawOptionGex(contract: OptionContract, spot: number): number | null {
  if (contract.isMini || contract.isNonStandard || ![contract.gamma, contract.openInterest, contract.multiplier, contract.strikePrice, spot].every(Number.isFinite)) return null;
  if (contract.gamma < 0 || contract.openInterest <= 0 || contract.multiplier <= 0 || contract.strikePrice <= 0 || spot <= 0) return null;
  return contract.gamma * contract.openInterest * contract.multiplier * spot * spot * 0.01;
}

export function calculateGexLevels(
  contracts: OptionContract[],
  spot: number,
  expirationDates?: Iterable<string>,
  today = new Date().toISOString().slice(0, 10),
): GexCalculation {
  const selected = expirationDates ? new Set(expirationDates) : undefined;
  const byStrike = new Map<number, GexLevel>();
  let excludedCount = 0;
  for (const contract of contracts) {
    if (selected && !selected.has(contract.expirationDate)) continue;
    const raw = contract.expirationDate >= today ? rawOptionGex(contract, spot) : null;
    if (raw == null || (contract.putCall !== "CALL" && contract.putCall !== "PUT")) {
      excludedCount += 1;
      continue;
    }
    const level = byStrike.get(contract.strikePrice) ?? { strike: contract.strikePrice, callGex: 0, putGex: 0, netGex: 0 };
    if (contract.putCall === "CALL") level.callGex += raw;
    else level.putGex += raw;
    level.netGex = level.callGex - level.putGex;
    byStrike.set(contract.strikePrice, level);
  }
  const levels = [...byStrike.values()].sort((left, right) => left.strike - right.strike);
  const callGex = levels.reduce((total, level) => total + level.callGex, 0);
  const putGex = levels.reduce((total, level) => total + level.putGex, 0);
  return { levels, excludedCount, callGex, putGex, netGex: callGex - putGex };
}

function contractImpact(contract: OptionContract): number {
  if (contract.isMini || contract.isNonStandard) return 0;
  const value = contract.gamma * contract.openInterest * contract.multiplier;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function prioritizeOptionContracts(contracts: OptionContract[], budget: number): string[] {
  const limit = Math.max(0, Math.floor(budget));
  if (!limit) return [];
  const ranked = contracts
    .filter((contract) => contractImpact(contract) > 0)
    .sort((left, right) => contractImpact(right) - contractImpact(left) || left.symbol.localeCompare(right.symbol));
  const calls = ranked.filter((contract) => contract.putCall === "CALL");
  const puts = ranked.filter((contract) => contract.putCall === "PUT");
  const selected = [...calls.slice(0, Math.ceil(limit / 2)), ...puts.slice(0, Math.floor(limit / 2))];
  if (selected.length < limit) {
    const occupied = new Set(selected.map((contract) => contract.symbol));
    selected.push(...ranked.filter((contract) => !occupied.has(contract.symbol)).slice(0, limit - selected.length));
  }
  return selected
    .sort((left, right) => contractImpact(right) - contractImpact(left) || left.symbol.localeCompare(right.symbol))
    .map((contract) => contract.symbol);
}

export function allocateGexStreamBudgets(symbols: string[], activeSymbol: string | undefined, total = 100): Record<string, number> {
  const unique = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].sort();
  if (!unique.length || total <= 0) return {};
  const base = Math.floor(total / unique.length);
  let remainder = total - base * unique.length;
  const ordered = activeSymbol && unique.includes(activeSymbol.toUpperCase())
    ? [activeSymbol.toUpperCase(), ...unique.filter((symbol) => symbol !== activeSymbol.toUpperCase())]
    : unique;
  return Object.fromEntries(ordered.map((symbol) => [symbol, base + (remainder-- > 0 ? 1 : 0)]));
}

export function gexMagnitudeScale(value: number, magnitudes: number[]): number {
  const sorted = magnitudes.filter((item) => Number.isFinite(item) && item > 0).sort((left, right) => left - right);
  if (!Number.isFinite(value) || value === 0 || !sorted.length) return 0;
  const cap = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))];
  if (!(cap > 0)) return 0;
  return Math.min(1, Math.log1p(Math.abs(value)) / Math.log1p(cap));
}

export function formatGex(value: number): string {
  const absolute = Math.abs(value);
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  const unit = units.find(([threshold]) => absolute >= threshold);
  if (!unit) return `${value < 0 ? "-" : "+"}$${absolute.toFixed(0)}`;
  return `${value < 0 ? "-" : "+"}$${(absolute / unit[0]).toFixed(absolute / unit[0] >= 10 ? 1 : 2)}${unit[1]}`;
}
