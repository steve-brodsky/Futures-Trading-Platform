export const ENTRY_RULE_UNLOCK_STEPS = 3;
export const ENTRY_RULE_UNLOCK_CODE_LENGTH = 6;
export const ENTRY_RULE_UNLOCK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateEntryRuleUnlockCode(values?: Uint32Array): string {
  const randomValues = values ?? crypto.getRandomValues(new Uint32Array(ENTRY_RULE_UNLOCK_CODE_LENGTH));
  if (randomValues.length < ENTRY_RULE_UNLOCK_CODE_LENGTH) {
    throw new Error(`Unlock codes require ${ENTRY_RULE_UNLOCK_CODE_LENGTH} random values.`);
  }
  return Array.from(randomValues.slice(0, ENTRY_RULE_UNLOCK_CODE_LENGTH), (value) => (
    ENTRY_RULE_UNLOCK_ALPHABET[value % ENTRY_RULE_UNLOCK_ALPHABET.length]
  )).join("");
}
