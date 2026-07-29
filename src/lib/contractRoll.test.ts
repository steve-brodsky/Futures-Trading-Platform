import { describe, expect, it } from "vitest";
import type { SymbolMeta } from "../types";
import {
  chicagoDateKey,
  contractRollAlertReceiptKey,
  contractRollDate,
  contractRollStatus,
  equityIndexContractRoot,
  nextEquityIndexContract,
  normalizeContractRollAlertSettings,
  parseContractExpirationDate,
} from "./contractRoll";

const contract = (symbol: string, expiration: string, root = symbol.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, "")): SymbolMeta => ({
  provider: "tradestation",
  symbol,
  root,
  description: symbol,
  exchange: "CME",
  assetType: "FUTURE",
  minMove: 0.25,
  pointValue: 5,
  expiration,
});

describe("CME equity-index contract roll", () => {
  it("derives the Monday of the expiration week for normal and holiday-shifted expirations", () => {
    expect(contractRollDate("2026-09-18")).toBe("2026-09-14");
    expect(contractRollDate("2026-06-18")).toBe("2026-06-15");
  });

  it("supports ISO and TradeStation Microsoft expiration dates", () => {
    expect(parseContractExpirationDate("2026-09-18T00:00:00Z")).toBe("2026-09-18");
    expect(parseContractExpirationDate("/Date(1789704000000-0700)/")).toBe("2026-09-18");
    expect(parseContractExpirationDate("not-a-date")).toBeUndefined();
  });

  it("covers only the selected U.S. equity-index roots", () => {
    expect(equityIndexContractRoot(contract("MESU26", "2026-09-18"))).toBe("MES");
    expect(equityIndexContractRoot(contract("M2KU26", "2026-09-18", "M2K"))).toBe("M2K");
    expect(equityIndexContractRoot(contract("MCLU26", "2026-08-20", "MCL"))).toBeUndefined();
  });

  it("transitions from clear to approaching on the prior Monday and roll-due on roll Monday", () => {
    const selected = contract("MESU26", "2026-09-18");
    expect(contractRollStatus(selected, [], "2026-09-06T12:00:00-05:00")?.phase).toBe("clear");
    expect(contractRollStatus(selected, [], "2026-09-07T12:00:00-05:00")).toMatchObject({
      phase: "approaching",
      warningStartDate: "2026-09-07",
      rollDate: "2026-09-14",
      sessionsUntilRoll: 5,
    });
    expect(contractRollStatus(selected, [], "2026-09-14T00:01:00-05:00")?.phase).toBe("roll-due");
  });

  it("uses the Chicago calendar date across UTC boundaries", () => {
    expect(chicagoDateKey("2026-09-14T04:30:00Z")).toBe("2026-09-13");
    expect(chicagoDateKey("2026-09-14T05:30:00Z")).toBe("2026-09-14");
  });

  it("finds the nearest later contract regardless of input order", () => {
    const selected = contract("MESU26", "2026-09-18");
    const next = contract("MESZ26", "2026-12-18");
    expect(nextEquityIndexContract(selected, [
      contract("MESH27", "2027-03-19"),
      next,
      contract("MNQZ26", "2026-12-18", "MNQ"),
    ])).toBe(next);
    expect(contractRollStatus(selected, [next], "2026-09-10T12:00:00-05:00")?.nextContract).toBe(next);
  });

  it("normalizes alert settings and creates phase-sensitive daily receipts", () => {
    expect(normalizeContractRollAlertSettings({ audioEnabled: false, sound: "bell", durationSeconds: 3 }))
      .toEqual({ audioEnabled: false, sound: "bell", durationSeconds: 3 });
    expect(normalizeContractRollAlertSettings({ sound: "invalid", durationSeconds: 8 }))
      .toEqual({ audioEnabled: true, sound: "chime", durationSeconds: 1 });
    const status = contractRollStatus(contract("MESU26", "2026-09-18"), [], "2026-09-14T12:00:00-05:00")!;
    expect(contractRollAlertReceiptKey(status, "2026-09-14")).toBe("2026-09-14:MESU26:roll-due");
  });
});
