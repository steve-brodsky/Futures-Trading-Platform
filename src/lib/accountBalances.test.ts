import { describe, expect, it } from "vitest";
import type { AccountBalance } from "../types";
import { balanceForAccount } from "./accountBalances";

const balances: AccountBalance[] = [
  { accountId: "123456789", accountType: "Cash", currency: "USD", todaysProfitLoss: 4.9376 },
  { accountId: "123456782", accountType: "Margin", currency: "USD", todaysProfitLoss: 982.8001 },
  { accountId: "123456781", accountType: "Futures", currency: "USD", todaysProfitLoss: -549.999999 },
];

describe("balanceForAccount", () => {
  it("selects the requested account regardless of response order", () => {
    expect(balanceForAccount(balances, "123456781")?.todaysProfitLoss).toBe(-549.999999);
    expect(balanceForAccount([...balances].reverse(), "123456781")?.todaysProfitLoss).toBe(-549.999999);
  });

  it("does not fall back to another account", () => {
    expect(balanceForAccount(balances, "missing-account")).toBeUndefined();
    expect(balanceForAccount(balances)).toBeUndefined();
  });
});
