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
  callOpenInterest: number;
  putOpenInterest: number;
  expirations: GexExpirationContribution[];
}

export interface GexExpirationContribution {
  expirationDate: string;
  callGex: number;
  putGex: number;
  netGex: number;
  callOpenInterest: number;
  putOpenInterest: number;
}

export interface GexExpirationDisplayGroup {
  key: string;
  label: string;
  dates: string[];
  color: string;
}

export interface GexCalculation {
  levels: GexLevel[];
  excludedCount: number;
  netGex: number;
  callGex: number;
  putGex: number;
}

export const defaultGexSelection = (): GexExpirationSelection => ({ mode: "front", expirationDates: [] });
export const defaultGexTabSettings = (): GexTabSettings => ({ enabled: false, view: "net", expirationDisplay: "aggregate" });

export function normalizeGexTabSettings(value: unknown): GexTabSettings {
  const record = value && typeof value === "object" ? value as Partial<GexTabSettings> : {};
  return {
    enabled: record.enabled === true,
    view: record.view === "calls-puts" || record.view === "open-interest" ? record.view : "net",
    expirationDisplay: record.expirationDisplay === "aggregate-strip" ? "aggregate-strip" : "aggregate",
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
    const baseEligible = contract.expirationDate >= today
      && !contract.isMini
      && !contract.isNonStandard
      && Number.isFinite(contract.strikePrice)
      && contract.strikePrice > 0
      && (contract.putCall === "CALL" || contract.putCall === "PUT");
    if (!baseEligible) {
      excludedCount += 1;
      continue;
    }
    const raw = rawOptionGex(contract, spot);
    const openInterest = Number.isFinite(contract.openInterest) && contract.openInterest >= 0
      ? contract.openInterest
      : null;
    if (raw == null) excludedCount += 1;
    if (raw == null && openInterest == null) continue;
    const level = byStrike.get(contract.strikePrice) ?? {
      strike: contract.strikePrice,
      callGex: 0,
      putGex: 0,
      netGex: 0,
      callOpenInterest: 0,
      putOpenInterest: 0,
      expirations: [],
    };
    let expiration = level.expirations.find((item) => item.expirationDate === contract.expirationDate);
    if (!expiration) {
      expiration = { expirationDate: contract.expirationDate, callGex: 0, putGex: 0, netGex: 0, callOpenInterest: 0, putOpenInterest: 0 };
      level.expirations.push(expiration);
    }
    if (contract.putCall === "CALL") {
      if (raw != null) level.callGex += raw;
      if (openInterest != null) level.callOpenInterest += openInterest;
      if (raw != null) expiration.callGex += raw;
      if (openInterest != null) expiration.callOpenInterest += openInterest;
    } else {
      if (raw != null) level.putGex += raw;
      if (openInterest != null) level.putOpenInterest += openInterest;
      if (raw != null) expiration.putGex += raw;
      if (openInterest != null) expiration.putOpenInterest += openInterest;
    }
    level.netGex = level.callGex - level.putGex;
    expiration.netGex = expiration.callGex - expiration.putGex;
    byStrike.set(contract.strikePrice, level);
  }
  const levels = [...byStrike.values()]
    .map((level) => ({ ...level, expirations: level.expirations.sort((left, right) => left.expirationDate.localeCompare(right.expirationDate)) }))
    .sort((left, right) => left.strike - right.strike);
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
  return Math.sqrt(Math.min(1, Math.abs(value) / cap));
}

const EXPIRATION_COLORS = ["#36c5f0", "#a879ff", "#ffb84d", "#f06ea9", "#6fd08c", "#5f8cff", "#e8794f", "#c8d36a"];
const LATER_EXPIRATION_COLOR = "#8995a5";

export function gexExpirationDisplayGroups(expirationDates: Iterable<string>): GexExpirationDisplayGroup[] {
  const dates = [...new Set(expirationDates)].sort();
  if (dates.length <= 8) return dates.map((date, index) => ({ key: date, label: date, dates: [date], color: EXPIRATION_COLORS[index] }));
  return [
    ...dates.slice(0, 7).map((date, index) => ({ key: date, label: date, dates: [date], color: EXPIRATION_COLORS[index] })),
    { key: "later", label: `Later (${dates.length - 7})`, dates: dates.slice(7), color: LATER_EXPIRATION_COLOR },
  ];
}

export function formatGex(value: number): string {
  const absolute = Math.abs(value);
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  const unit = units.find(([threshold]) => absolute >= threshold);
  if (!unit) return `${value < 0 ? "-" : "+"}$${absolute.toFixed(0)}`;
  return `${value < 0 ? "-" : "+"}$${(absolute / unit[0]).toFixed(absolute / unit[0] >= 10 ? 1 : 2)}${unit[1]}`;
}

export function formatOpenInterest(value: number): string {
  const absolute = Math.abs(value);
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  const unit = units.find(([threshold]) => absolute >= threshold);
  if (!unit) return Math.round(absolute).toLocaleString("en-US");
  const scaled = absolute / unit[0];
  return `${scaled.toFixed(scaled >= 10 ? 1 : 2)}${unit[1]}`;
}
