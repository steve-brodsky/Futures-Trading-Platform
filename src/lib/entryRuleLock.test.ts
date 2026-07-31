import { describe, expect, it } from "vitest";
import {
  ENTRY_RULE_UNLOCK_ALPHABET, ENTRY_RULE_UNLOCK_CODE_LENGTH, generateEntryRuleUnlockCode,
} from "./entryRuleLock";

describe("entry rule unlock codes", () => {
  it("creates six-character codes from the unambiguous uppercase alphabet", () => {
    const code = generateEntryRuleUnlockCode(new Uint32Array([0, 1, 2, 3, 4, 5]));
    expect(code).toHaveLength(ENTRY_RULE_UNLOCK_CODE_LENGTH);
    expect([...code].every((character) => ENTRY_RULE_UNLOCK_ALPHABET.includes(character))).toBe(true);
    expect(code).not.toMatch(/[01IO]/);
  });

  it("uses every supplied random value and rejects incomplete entropy", () => {
    expect(generateEntryRuleUnlockCode(new Uint32Array([0, 1, 2, 3, 4, 5])))
      .not.toBe(generateEntryRuleUnlockCode(new Uint32Array([0, 1, 2, 3, 4, 6])));
    expect(() => generateEntryRuleUnlockCode(new Uint32Array([1, 2]))).toThrow("require 6 random values");
  });
});
