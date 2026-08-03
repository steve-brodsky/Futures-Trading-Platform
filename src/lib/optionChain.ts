import type {
  OptionChainPreferences,
  OptionContract,
  OptionDraftAction,
  OptionDraftLeg,
  OptionDraftPriceEffect,
  OptionOrderDraft,
} from "../types";

export const OPTION_STRIKE_COUNTS = [5, 10, 15, 20, 24] as const;
export const MAX_OPTION_DRAFT_LEGS = 4;

export interface OptionChainRow {
  strikePrice: number;
  call?: OptionContract;
  put?: OptionContract;
  callInTheMoney: boolean;
  putInTheMoney: boolean;
  atTheMoney: boolean;
}

export interface PairedOptionChain {
  rows: OptionChainRow[];
  excludedCount: number;
  atTheMoneyStrike?: number;
}

export interface OptionDraftNatural {
  signedPrice: number;
  effect: OptionDraftPriceEffect;
  amount: number;
  estimatedValue: number;
}

export function normalizeOptionChainPreferences(value: unknown): OptionChainPreferences {
  const record = value && typeof value === "object" ? value as Partial<OptionChainPreferences> : {};
  const strikeCount = OPTION_STRIKE_COUNTS.includes(record.strikeCount as typeof OPTION_STRIKE_COUNTS[number])
    ? record.strikeCount as OptionChainPreferences["strikeCount"]
    : 20;
  return {
    symbol: typeof record.symbol === "string" && record.symbol.trim() ? record.symbol.trim().toUpperCase() : "SPY",
    expirationDate: typeof record.expirationDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.expirationDate)
      ? record.expirationDate
      : undefined,
    strikeCount,
  };
}

export function pairOptionContracts(contracts: OptionContract[], spot: number): PairedOptionChain {
  const eligible = contracts.filter((contract) => !contract.isMini && !contract.isNonStandard);
  const excludedCount = contracts.length - eligible.length;
  const byStrike = new Map<number, { call?: OptionContract; put?: OptionContract }>();
  eligible.forEach((contract) => {
    if (!Number.isFinite(contract.strikePrice) || contract.strikePrice <= 0) return;
    const row = byStrike.get(contract.strikePrice) ?? {};
    if (contract.putCall === "CALL") row.call = contract;
    if (contract.putCall === "PUT") row.put = contract;
    byStrike.set(contract.strikePrice, row);
  });
  const strikes = [...byStrike.keys()].sort((left, right) => left - right);
  const atTheMoneyStrike = Number.isFinite(spot) && strikes.length
    ? strikes.reduce((best, strike) => Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best, strikes[0])
    : undefined;
  return {
    excludedCount,
    atTheMoneyStrike,
    rows: strikes.map((strikePrice) => ({
      strikePrice,
      ...byStrike.get(strikePrice),
      callInTheMoney: Number.isFinite(spot) && strikePrice < spot,
      putInTheMoney: Number.isFinite(spot) && strikePrice > spot,
      atTheMoney: strikePrice === atTheMoneyStrike,
    })),
  };
}

export function defaultOptionOrderDraft(underlying: string): OptionOrderDraft {
  return {
    underlying: underlying.trim().toUpperCase(),
    legs: [],
    quantity: 1,
    orderType: "LIMIT",
    timeInForce: "DAY",
    priceEffect: "DEBIT",
    limitAmount: 0,
  };
}

function legFromContract(contract: OptionContract, action: OptionDraftAction): OptionDraftLeg {
  return {
    contractSymbol: contract.symbol,
    action,
    ratio: 1,
    putCall: contract.putCall,
    expirationDate: contract.expirationDate,
    strikePrice: contract.strikePrice,
    multiplier: contract.multiplier || 100,
    bidPrice: contract.bidPrice,
    askPrice: contract.askPrice,
  };
}

export function optionDraftNatural(draft: Pick<OptionOrderDraft, "legs" | "quantity">): OptionDraftNatural {
  const signedPrice = draft.legs.reduce((sum, leg) => (
    sum + (leg.action === "BUY" ? leg.askPrice : -leg.bidPrice) * Math.max(1, leg.ratio)
  ), 0);
  const amount = Math.abs(signedPrice);
  const multiplier = draft.legs[0]?.multiplier || 100;
  return {
    signedPrice,
    effect: signedPrice < 0 ? "CREDIT" : "DEBIT",
    amount,
    estimatedValue: amount * multiplier * Math.max(1, draft.quantity),
  };
}

function withNaturalLimit(draft: OptionOrderDraft): OptionOrderDraft {
  const natural = optionDraftNatural(draft);
  return { ...draft, priceEffect: natural.effect, limitAmount: Number(natural.amount.toFixed(4)) };
}

export function toggleOptionDraftLeg(
  draft: OptionOrderDraft,
  contract: OptionContract,
  action: OptionDraftAction,
): { draft: OptionOrderDraft; error?: string } {
  const index = draft.legs.findIndex((leg) => leg.contractSymbol === contract.symbol);
  if (index >= 0) {
    const current = draft.legs[index];
    const legs = current.action === action
      ? draft.legs.filter((_leg, legIndex) => legIndex !== index)
      : draft.legs.map((leg, legIndex) => legIndex === index ? legFromContract(contract, action) : leg);
    return { draft: withNaturalLimit({ ...draft, legs }) };
  }
  if (draft.legs.length >= MAX_OPTION_DRAFT_LEGS) return { draft, error: "Option drafts support up to four legs." };
  const underlying = contract.underlying.trim().toUpperCase();
  if (draft.legs.length && draft.underlying !== underlying) return { draft, error: "All option legs must use the same underlying." };
  return { draft: withNaturalLimit({ ...draft, underlying, legs: [...draft.legs, legFromContract(contract, action)] }) };
}

export function refreshOptionDraftPrices(draft: OptionOrderDraft, contracts: Iterable<OptionContract>): OptionOrderDraft {
  const bySymbol = new Map([...contracts].map((contract) => [contract.symbol, contract]));
  const legs = draft.legs.map((leg) => {
    const contract = bySymbol.get(leg.contractSymbol);
    return contract ? { ...leg, bidPrice: contract.bidPrice, askPrice: contract.askPrice, multiplier: contract.multiplier || leg.multiplier } : leg;
  });
  return { ...draft, legs };
}

export function classifyOptionDraft(legs: OptionDraftLeg[]): string {
  if (!legs.length) return "No strategy";
  if (legs.length === 1) return "Single";
  const expirations = new Set(legs.map((leg) => leg.expirationDate));
  const types = new Set(legs.map((leg) => leg.putCall));
  const strikes = new Set(legs.map((leg) => leg.strikePrice));
  if (legs.length === 2) {
    if (types.size === 1 && expirations.size === 1 && strikes.size === 2) return "Vertical";
    if (types.size === 1 && expirations.size === 2 && strikes.size === 1) return "Calendar";
    if (types.size === 1 && expirations.size === 2 && strikes.size === 2) return "Diagonal";
    if (types.size === 2 && expirations.size === 1 && strikes.size === 1) return "Straddle";
    if (types.size === 2 && expirations.size === 1 && strikes.size === 2) return "Strangle";
  }
  if (legs.length === 3 && types.size === 1 && expirations.size === 1 && strikes.size === 3) {
    const ratios = [...legs].sort((a, b) => a.strikePrice - b.strikePrice).map((leg) => leg.ratio);
    if (ratios[0] === ratios[2] && ratios[1] === ratios[0] * 2) return "Butterfly";
  }
  if (legs.length === 4 && types.size === 1 && expirations.size === 1 && strikes.size === 4) return "Condor";
  return "Custom";
}

export function optionStreamBudget(chainContracts: number, total = 100): { chain: number; gex: number } {
  const chain = Math.max(0, Math.min(Math.floor(chainContracts), Math.max(0, Math.floor(total))));
  return { chain, gex: Math.max(0, Math.floor(total) - chain) };
}

export function formatOptionPrice(value: number | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(value >= 100 ? 2 : value >= 10 ? 2 : 3).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatOptionGreek(value: number | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(3).replace(/^(-?)0\./, "$1.");
}

export function formatOptionCount(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(Math.abs(value));
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}m`;
  if (rounded >= 10_000) return `${(rounded / 1_000).toFixed(1)}k`;
  return rounded.toLocaleString("en-US");
}
