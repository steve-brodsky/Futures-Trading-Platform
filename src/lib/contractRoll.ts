import type {
  AlertDurationSeconds,
  AlertSound,
  ContractRollAlertSettings,
  ContractRollStatus,
  SymbolMeta,
} from "../types";

export const EQUITY_INDEX_ROLL_ROOTS = new Set(["ES", "MES", "NQ", "MNQ", "YM", "MYM", "RTY", "M2K"]);

export const DEFAULT_CONTRACT_ROLL_ALERT_SETTINGS: ContractRollAlertSettings = {
  audioEnabled: true,
  sound: "chime",
  durationSeconds: 1,
};

const chicagoDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateKeyFromParts(parts: Intl.DateTimeFormatPart[]): string {
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function chicagoDateKey(value: Date | number | string = new Date()): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateKeyFromParts(chicagoDateFormatter.formatToParts(date));
}

export function parseContractExpirationDate(expiration?: string): string | undefined {
  const value = expiration?.trim();
  if (!value) return undefined;
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
  const microsoftDate = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  const date = microsoftDate ? new Date(Number(microsoftDate[1])) : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function parseDateKey(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return date.toISOString().slice(0, 10) === value ? date : undefined;
}

function moveDate(value: string, days: number): string {
  const date = parseDateKey(value);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function equityIndexContractRoot(meta: Pick<SymbolMeta, "symbol" | "root">): string | undefined {
  const supplied = meta.root?.trim().toUpperCase().replace(/^@/, "");
  const parsed = /^(.+?)[FGHJKMNQUVXZ]\d{1,2}$/.exec(meta.symbol.trim().toUpperCase())?.[1];
  const root = supplied || parsed;
  return root && EQUITY_INDEX_ROLL_ROOTS.has(root) ? root : undefined;
}

export function contractRollDate(expiration?: string): string | undefined {
  const expirationDate = parseContractExpirationDate(expiration);
  const date = expirationDate ? parseDateKey(expirationDate) : undefined;
  if (!date) return undefined;
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function sessionsUntil(currentDate: string, rollDate: string): number {
  let cursor = currentDate;
  let sessions = 0;
  while (cursor < rollDate) {
    cursor = moveDate(cursor, 1);
    const date = parseDateKey(cursor);
    if (!date) break;
    const day = date.getUTCDay();
    if (day >= 1 && day <= 5) sessions += 1;
  }
  return sessions;
}

export function nextEquityIndexContract(
  selected: SymbolMeta,
  contracts: SymbolMeta[],
): SymbolMeta | undefined {
  const root = equityIndexContractRoot(selected);
  const expirationDate = parseContractExpirationDate(selected.expiration);
  if (!root || !expirationDate) return undefined;
  return contracts
    .filter((contract) => equityIndexContractRoot(contract) === root)
    .flatMap((contract) => {
      const expiration = parseContractExpirationDate(contract.expiration);
      return expiration && expiration > expirationDate ? [{ contract, expiration }] : [];
    })
    .sort((left, right) => left.expiration.localeCompare(right.expiration)
      || left.contract.symbol.localeCompare(right.contract.symbol))[0]?.contract;
}

export function contractRollStatus(
  meta: SymbolMeta | undefined,
  contracts: SymbolMeta[] = [],
  now: Date | number | string = new Date(),
): ContractRollStatus | undefined {
  if (!meta || meta.provider !== "tradestation" || !meta.assetType.toUpperCase().includes("FUTURE")) return undefined;
  const root = equityIndexContractRoot(meta);
  const expirationDate = parseContractExpirationDate(meta.expiration);
  const rollDate = contractRollDate(meta.expiration);
  const currentDate = chicagoDateKey(now);
  if (!root || !expirationDate || !rollDate || !currentDate) return undefined;
  const warningStartDate = moveDate(rollDate, -7);
  const phase = currentDate < warningStartDate ? "clear"
    : currentDate < rollDate ? "approaching"
      : "roll-due";
  return {
    phase,
    symbol: meta.symbol.trim().toUpperCase(),
    root,
    expirationDate,
    warningStartDate,
    rollDate,
    sessionsUntilRoll: phase === "approaching" ? sessionsUntil(currentDate, rollDate) : 0,
    nextContract: nextEquityIndexContract(meta, contracts),
  };
}

export function normalizeContractRollAlertSettings(value: unknown): ContractRollAlertSettings {
  const record = value != null && typeof value === "object" ? value as Partial<ContractRollAlertSettings> : {};
  const sounds: AlertSound[] = ["chime", "bell", "pulse", "siren"];
  const durations: AlertDurationSeconds[] = [1, 3, 5, 10];
  return {
    audioEnabled: typeof record.audioEnabled === "boolean"
      ? record.audioEnabled
      : DEFAULT_CONTRACT_ROLL_ALERT_SETTINGS.audioEnabled,
    sound: sounds.includes(record.sound as AlertSound)
      ? record.sound as AlertSound
      : DEFAULT_CONTRACT_ROLL_ALERT_SETTINGS.sound,
    durationSeconds: durations.includes(record.durationSeconds as AlertDurationSeconds)
      ? record.durationSeconds as AlertDurationSeconds
      : DEFAULT_CONTRACT_ROLL_ALERT_SETTINGS.durationSeconds,
  };
}

export function contractRollAlertReceiptKey(status: ContractRollStatus, date: string): string {
  return `${date}:${status.symbol}:${status.phase}`;
}
