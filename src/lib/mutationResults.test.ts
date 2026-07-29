import { describe, expect, it } from "vitest";
import type { BrokerMutationResult } from "../types";
import { mutationPresentation } from "./mutationResults";

function result(patch: Partial<BrokerMutationResult>): BrokerMutationResult {
  return {
    mutationId: "m-1",
    brokerOutcome: "confirmed",
    localPersistence: "complete",
    reconciliationStatus: "not_required",
    warnings: [],
    brokerOrder: null,
    closeResult: null,
    retryBlocked: true,
    ...patch,
  };
}

describe("broker mutation presentation", () => {
  it("keeps confirmed broker success authoritative when local journal completion fails", () => {
    const view = mutationPresentation(result({
      localPersistence: "pending",
      reconciliationStatus: "required",
      warnings: ["Broker confirmed; journal completion failed"],
    }), "Order");
    expect(view.kind).toBe("confirmed-warning");
    expect(view.message).toContain("Broker confirmed");
    expect(view.allowNormalRetry).toBe(false);
  });

  it("distinguishes clear rejection from an unknown outcome", () => {
    expect(mutationPresentation(result({
      brokerOutcome: "rejected",
      rejectionReason: "Quantity exceeds native maximum",
      retryBlocked: false,
    }), "Order")).toMatchObject({ kind: "rejected", allowNormalRetry: true });
    expect(mutationPresentation(result({
      brokerOutcome: "unknown",
      reconciliationStatus: "reconciling",
      warnings: ["Timeout after transmission"],
    }), "Order")).toMatchObject({ kind: "unknown", allowNormalRetry: false });
  });
});
