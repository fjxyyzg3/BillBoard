import { describe, expect, it } from "vitest";
import { validateBillReconciliationRequest, validateBillReconciliationResponse } from "../../src/lib/reports/bill-reconciliation-protocol";

const base = { schemaVersion: "bill-reconciliation.v1", stage: "context", batchId: "b1", batchCount: 1, locale: "zh-CN",
  range: { from: "2026-01-01", to: "2026-12-31" }, snapshotAt: "2026-11-05T00:00:00.000Z",
  rows: [1, 2].map((index) => ({ ref: `r${index}`, occurredAt: "2026-01-01T08:00:00+08:00", date: "2026-01-01", type: "expense", amountFen: 1000,
    categoryName: "Dining", memberAlias: "m1", ledgerAlias: "l1", note: "Receipt PAY-ABC123", source: null,
    timePrecision: "unknown", timeSupplemented: false, aggregated: false, sourceIdentityAlias: null, offsetEvidence: "unconsumed" })),
};
const group = { kind: "duplicate", title: "核对", reason: "同笔支付", confidence: "high", evidenceRefs: ["r1", "r2"], duplicateGroups: [["r1", "r2"]], offset: null };

describe("bounded and untrusted reconciliation protocol", () => {
  it("accepts only complete batch-bound relation proposals, never transaction patches", () => {
    const request = validateBillReconciliationRequest(base);
    const response = { schemaVersion: request.schemaVersion, batchId: request.batchId, groups: [group] };
    expect(validateBillReconciliationResponse(request, response)).toEqual(response);
    expect(() => validateBillReconciliationResponse(request, { ...response, groups: [{ ...group, amountFen: 1 }] })).toThrow();
    expect(() => validateBillReconciliationResponse(request, { ...response, batchId: "b2" })).toThrow();
    expect(() => validateBillReconciliationResponse(request, { ...response, groups: [{ ...group, evidenceRefs: ["r1", "r999"] }] })).toThrow();
    expect(() => validateBillReconciliationResponse(request, { ...response, groups: [{ ...group, evidenceRefs: ["r1"], duplicateGroups: [["r1", "r2"]] }] })).toThrow();
    expect(() => validateBillReconciliationResponse(request, { ...response, groups: [{ ...group, reason: "秘".repeat(1500) }] })).toThrow();
  });

  it("rejects internal fields, impossible dates, duplicate refs and unsupported protocol versions", () => {
    expect(() => validateBillReconciliationRequest({ ...base, householdId: "private-id" })).toThrow();
    expect(() => validateBillReconciliationRequest({ ...base, rows: base.rows.map((item) => ({ ...item, sourceFingerprint: "private-fingerprint" })) })).toThrow();
    expect(() => validateBillReconciliationRequest({ ...base, schemaVersion: "bill-analysis.v1" })).toThrow();
    expect(() => validateBillReconciliationRequest({ ...base, rows: [base.rows[0], base.rows[0]] })).toThrow();
    expect(() => validateBillReconciliationRequest({ ...base, rows: base.rows.map((item) => ({ ...item, date: "2026-02-31" })) })).toThrow();
    expect(() => validateBillReconciliationRequest({ ...base, rows: [{ ...base.rows[0], amountFen: 1.01 }] })).toThrow();
    expect(() => validateBillReconciliationRequest({ ...base, rows: [{ ...base.rows[0], amountFen: 2_147_483_648 }] })).toThrow();
  });
});
