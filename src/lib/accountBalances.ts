import type { AccountBalance } from "../types";

export function balanceForAccount(
  balances: AccountBalance[],
  accountId?: string,
): AccountBalance | undefined {
  if (!accountId) return undefined;
  return balances.find((balance) => balance.accountId === accountId);
}
