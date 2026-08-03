import { describe, expect, it } from "vitest";
import type { OptionContract } from "../types";
import {
  classifyOptionDraft,
  defaultOptionOrderDraft,
  normalizeOptionChainPreferences,
  optionDraftNatural,
  optionStreamBudget,
  pairOptionContracts,
  toggleOptionDraftLeg,
} from "./optionChain";

const contract = (symbol: string, putCall: "CALL" | "PUT", strikePrice: number, patch: Partial<OptionContract> = {}): OptionContract => ({
  symbol, underlying: "SPY", putCall, expirationDate: "2026-08-07", strikePrice, multiplier: 100,
  gamma: .02, openInterest: 1200, bidPrice: 1, askPrice: 1.1, bidSize: 10, askSize: 12,
  markPrice: 1.05, totalVolume: 500, volatility: .2, delta: putCall === "CALL" ? .5 : -.5,
  theta: -.08, vega: .15, underlyingPrice: 500, quoteTime: 1, delayed: false, isMini: false, isNonStandard: false,
  ...patch,
});

describe("option chain workspace helpers", () => {
  it("pairs standard calls and puts, excludes adjusted contracts, and finds ATM", () => {
    const paired = pairOptionContracts([
      contract("C495", "CALL", 495), contract("P495", "PUT", 495),
      contract("C500", "CALL", 500), contract("P500", "PUT", 500),
      contract("ADJ", "CALL", 505, { isNonStandard: true }),
    ], 499);
    expect(paired.rows).toHaveLength(2);
    expect(paired.atTheMoneyStrike).toBe(500);
    expect(paired.rows[0]).toMatchObject({ callInTheMoney: true, putInTheMoney: false });
    expect(paired.excludedCount).toBe(1);
  });

  it("adds, changes, and toggles a draft leg", () => {
    const initial = defaultOptionOrderDraft("SPY");
    const bought = toggleOptionDraftLeg(initial, contract("C500", "CALL", 500), "BUY").draft;
    expect(bought.legs[0].action).toBe("BUY");
    expect(toggleOptionDraftLeg(bought, contract("C500", "CALL", 500), "SELL").draft.legs[0].action).toBe("SELL");
    expect(toggleOptionDraftLeg(bought, contract("C500", "CALL", 500), "BUY").draft.legs).toHaveLength(0);
  });

  it("rejects a fifth leg", () => {
    let draft = defaultOptionOrderDraft("SPY");
    for (let index = 0; index < 4; index += 1) draft = toggleOptionDraftLeg(draft, contract(`C${index}`, "CALL", 490 + index), "BUY").draft;
    expect(toggleOptionDraftLeg(draft, contract("C5", "CALL", 505), "BUY").error).toMatch(/four legs/i);
  });

  it("calculates natural debit and credit values", () => {
    let debit = defaultOptionOrderDraft("SPY");
    debit = toggleOptionDraftLeg(debit, contract("C500", "CALL", 500, { askPrice: 2.2 }), "BUY").draft;
    debit = toggleOptionDraftLeg(debit, contract("C505", "CALL", 505, { bidPrice: .9 }), "SELL").draft;
    const natural = optionDraftNatural(debit);
    expect(natural.effect).toBe("DEBIT");
    expect(natural.signedPrice).toBeCloseTo(1.3);
    expect(natural.estimatedValue).toBeCloseTo(130);
    let credit = defaultOptionOrderDraft("SPY");
    credit = toggleOptionDraftLeg(credit, contract("C500", "CALL", 500, { bidPrice: 2.1 }), "SELL").draft;
    credit = toggleOptionDraftLeg(credit, contract("C505", "CALL", 505, { askPrice: .8 }), "BUY").draft;
    expect(optionDraftNatural(credit).effect).toBe("CREDIT");
  });

  it("recognizes common strategies", () => {
    const leg = (symbol: string, putCall: "CALL" | "PUT", strike: number, expiration = "2026-08-07") => toggleOptionDraftLeg(defaultOptionOrderDraft("SPY"), contract(symbol, putCall, strike, { expirationDate: expiration }), "BUY").draft.legs[0];
    expect(classifyOptionDraft([leg("C1", "CALL", 500), leg("P1", "PUT", 500)])).toBe("Straddle");
    expect(classifyOptionDraft([leg("C1", "CALL", 500), leg("C2", "CALL", 505)])).toBe("Vertical");
    expect(classifyOptionDraft([leg("C1", "CALL", 500), leg("C2", "CALL", 500, "2026-09-18")])).toBe("Calendar");
  });

  it("normalizes preferences and gives chain contracts first budget priority", () => {
    expect(normalizeOptionChainPreferences({ symbol: " spy ", strikeCount: 24 })).toMatchObject({ symbol: "SPY", strikeCount: 24 });
    expect(normalizeOptionChainPreferences({ strikeCount: 999 })).toMatchObject({ symbol: "SPY", strikeCount: 20 });
    expect(optionStreamBudget(82)).toEqual({ chain: 82, gex: 18 });
    expect(optionStreamBudget(120)).toEqual({ chain: 100, gex: 0 });
  });
});
