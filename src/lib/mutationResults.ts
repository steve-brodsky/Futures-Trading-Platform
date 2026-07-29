import type { BrokerMutationResult } from "../types";

export interface MutationPresentation {
  kind: "confirmed" | "confirmed-warning" | "rejected" | "unknown";
  message: string;
  allowNormalRetry: boolean;
}

export function mutationPresentation(result: BrokerMutationResult, label: string): MutationPresentation {
  if (result.brokerOutcome === "rejected") {
    return {
      kind: "rejected",
      message: `${label} rejected: ${result.rejectionReason ?? "Broker or native risk policy rejected the request"}`,
      allowNormalRetry: !result.retryBlocked,
    };
  }
  if (result.brokerOutcome === "unknown") {
    return {
      kind: "unknown",
      message: result.warnings[0] ?? `${label} outcome is unknown. Reconciliation is required; do not retry.`,
      allowNormalRetry: false,
    };
  }
  if (result.localPersistence !== "complete" || result.warnings.length > 0) {
    return {
      kind: "confirmed-warning",
      message: result.warnings[0] ?? `${label} was confirmed by the broker, but local persistence needs reconciliation.`,
      allowNormalRetry: false,
    };
  }
  return {
    kind: "confirmed",
    message: `${label} confirmed by the broker.`,
    allowNormalRetry: false,
  };
}
