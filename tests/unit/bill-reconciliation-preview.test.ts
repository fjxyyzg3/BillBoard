import { describe, expect, it } from "vitest";
import type { ReconciliationRecord, ReconciliationSuggestion } from "../../src/lib/reports/bill-reconciliation-types";

const records: ReconciliationRecord[] = [
  { ref: "r1", occurredAt: "2026-01-10T00:00:00.000Z", date: "2026-01-10", type: "expense", amountFen: 10_000, categoryName: "Travel", memberLabel: "Member", ledgerLabel: "Ledger", memberAlias: "m1", ledgerAlias: "l1", note: "Order ABC123", source: null, timePrecision: "second", timeSupplemented: false, aggregated: false },
  { ref: "r2", occurredAt: "2026-02-10T00:00:00.000Z", date: "2026-02-10", type: "income", amountFen: 3000, categoryName: "Reimbursement", memberLabel: "Member", ledgerLabel: "Ledger", memberAlias: "m1", ledgerAlias: "l1", note: "Reimbursement ABC123", source: null, timePrecision: "second", timeSupplemented: false, aggregated: false },
];
const suggestion: ReconciliationSuggestion = { id: "s1", kind: "reimbursement", title: "核对报销", reason: "原支出及对应报销", evidenceRefs: ["r1", "r2"], confidence: "high", defaultSelected: true, canApply: true, readOnlyReason: null,
  actions: [{ ref: "r1", action: "update", amountFen: 7000 }, { ref: "r2", action: "delete", amountFen: 3000 }] };

describe("reconciliation selection preview", () => {
  it("shows invariant whole-selection net and different monthly/day deltas", async () => {
    const { previewReconciliation } = await import("../../src/lib/reports/bill-reconciliation-preview");
    const preview = previewReconciliation(records, [suggestion], ["s1"]);
    expect(preview.before).toEqual({ incomeFen: 3000, expenseFen: 10_000, netFen: -7000, transactionCount: 2 });
    expect(preview.after).toEqual({ incomeFen: 0, expenseFen: 7000, netFen: -7000, transactionCount: 1 });
    expect(preview.delta).toEqual({ incomeFen: -3000, expenseFen: -3000, netFen: 0, transactionCount: -1 });
    expect(preview.months).toEqual([
      { key: "2026-01", delta: { incomeFen: 0, expenseFen: -3000, netFen: 3000, transactionCount: 0 } },
      { key: "2026-02", delta: { incomeFen: -3000, expenseFen: 0, netFen: -3000, transactionCount: -1 } },
    ]);
    expect(preview.days.map((point) => point.key)).toEqual(["2026-01-10", "2026-02-10"]);
  });

  it("rejects duplicate IDs, overlapping records, stale/read-only and unknown suggestions", async () => {
    const { previewReconciliation } = await import("../../src/lib/reports/bill-reconciliation-preview");
    expect(() => previewReconciliation(records, [suggestion], ["s1", "s1"])).toThrow();
    expect(() => previewReconciliation(records, [suggestion, { ...suggestion, id: "s2" }], ["s1", "s2"])).toThrow();
    expect(() => previewReconciliation(records, [{ ...suggestion, canApply: false }], ["s1"])).toThrow();
    expect(() => previewReconciliation(records, [{ ...suggestion, applied: true }], ["s1"])).toThrow();
    expect(() => previewReconciliation(records, [suggestion], ["unknown"])).toThrow();
    expect(previewReconciliation(records, [suggestion], []).delta).toEqual({ incomeFen: 0, expenseFen: 0, netFen: 0, transactionCount: 0 });
  });
});
