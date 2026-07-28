import { describe, expect, it } from "vitest";
import {
  auditedDemoCall,
  demoAuditExport,
  demoAuditPage,
  instrumentDemoApi,
  redactAuditValue,
} from "./audit";
import type { AuditFilters } from "../types";

const emptyFilters = (): AuditFilters => ({
  search: "",
  categories: [],
  sources: [],
  statuses: [],
});

describe("audit diagnostics", () => {
  it("redacts nested secrets and summarizes large collections", () => {
    const redacted = redactAuditValue({
      authorization: "Bearer abc",
      nested: { clientSecret: "secret", symbol: "MES" },
      dataUrl: "data:image/png;base64,abc",
      records: Array.from({ length: 150 }, (_, index) => index),
    }) as Record<string, any>;
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.nested.clientSecret).toBe("[REDACTED]");
    expect(redacted.nested.symbol).toBe("MES");
    expect(redacted.dataUrl).toBe("[REDACTED]");
    expect(redacted.records.recordCount).toBe(150);
  });

  it("records pending calls, completes them in place, and applies filters", async () => {
    const operation = `test-operation-${Date.now()}`;
    await auditedDemoCall(operation, [{ password: "do-not-store", symbol: "MES" }], async () => ({ ok: true }));
    const page = demoAuditPage({ ...emptyFilters(), search: operation });
    expect(page.total).toBe(1);
    expect(page.events[0]).toMatchObject({
      operation,
      status: "success",
      source: "browser-demo",
    });
    expect((page.events[0].request as any)[0].password).toBe("[REDACTED]");
    expect(demoAuditPage({ ...emptyFilters(), search: operation, statuses: ["error"] }).total).toBe(0);
  });

  it("treats successful void operations as successful audit events", async () => {
    const operation = `void-operation-${Date.now()}`;
    await auditedDemoCall(operation, [], async () => undefined);
    const page = demoAuditPage({ ...emptyFilters(), search: operation });
    expect(page.events[0].status).toBe("success");
    expect(page.events[0].error).toBeUndefined();
  });

  it("keeps wrapped browser methods stable and exports chronological JSON", async () => {
    const raw = {
      isNative: false,
      async quotes(symbols: string[]) { return symbols.map((symbol) => ({ symbol })); },
      async auditHealth() { return { healthy: true }; },
    };
    const wrapped = instrumentDemoApi(raw, new Set(["auditHealth"]));
    expect(wrapped.quotes).toBe(wrapped.quotes);
    await wrapped.quotes(["AUDIT_TEST"]);
    const exported = JSON.parse(demoAuditExport({ ...emptyFilters(), search: "quotes" }));
    expect(exported.retention).toEqual({ days: 7, maximumEvents: 10_000 });
    expect(exported.events.some((event: { operation: string }) => event.operation === "quotes")).toBe(true);
  });
});
