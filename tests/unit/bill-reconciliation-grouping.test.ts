import { describe, expect, it } from "vitest";
import { activeReconciliationRetentionGroups, buildReconciliationRetentionCandidates, defaultReconciliationRetentionGroups, reconciliationRetentionDecisionKey, reconciliationRetentionGroupKey } from "@/lib/reports/bill-reconciliation-grouping";
import { ReconciliationApplicationController } from "@/lib/reports/bill-reconciliation-controller";
import type { BillReconciliationReportDto, ReconciliationRecord, ReconciliationSuggestion } from "@/lib/reports/bill-reconciliation-types";

const row = (ref: string, changes: Partial<ReconciliationRecord> = {}): ReconciliationRecord => ({
  ref, occurredAt: "2026-11-03T12:00:00+08:00", date: "2026-11-03", type: "expense", amountFen: 2000, categoryName: "Dining", memberLabel: "Member", ledgerLabel: "Ledger", memberAlias: "m1", ledgerAlias: "l1",
  note: null, source: null, timePrecision: "unknown", timeSupplemented: false, aggregated: false, ...changes,
});
const notice = (id: string, refs: string[]): ReconciliationSuggestion => ({ id, kind: "notice", title: "Review", reason: "Possible cross-source duplicates", evidenceRefs: refs, confidence: "review", defaultSelected: false, canApply: false, readOnlyReason: "unsupported", actions: [] });
const report = (rows: ReconciliationRecord[], notices = [notice("n1", rows.map((record) => record.ref))]): BillReconciliationReportDto => ({
  id: "report", generation: 1, purpose: "reconciliation", version: 1, locale: "zh-CN", scope: { mode: "month", period: "2026-11", ledgerId: null, actorMemberId: null }, scopeLabels: { ledger: "Ledger", member: "Member" },
  generatedAt: "2026-11-05T00:00:00Z", snapshotAt: "2026-11-05T00:00:00Z", range: { from: "2026-11-01", to: "2026-11-05" }, records: rows, suggestions: notices,
});

describe("grouped reconciliation retention", () => {
  it("sorts within groups by time and numeric ref and groups by the earliest timestamp", () => {
    const value = report([row("r10"), row("r2"), row("r1", { amountFen: 500, occurredAt: "2026-11-02T23:59:59+08:00" }), row("r11", { amountFen: 500 })]);
    expect(defaultReconciliationRetentionGroups(value)).toEqual([
      { noticeId: "n1", refs: ["r1", "r11"], keepRefs: ["r1"] },
      { noticeId: "n1", refs: ["r2", "r10"], keepRefs: ["r2"] },
    ]);
  });

  it("orders equal-time groups by numeric ref before notice and bucket identity", () => {
    const rows = [row("r10", { amountFen: 1000 }), row("r11", { amountFen: 1000 }), row("r2", { amountFen: 9000 }), row("r3", { amountFen: 9000 })];
    expect(defaultReconciliationRetentionGroups(report(rows)).map((group) => group.refs)).toEqual([["r2", "r3"], ["r10", "r11"]]);
    const separate = report(rows, [notice("a", ["r10", "r11"]), notice("z", ["r2", "r3"])]);
    expect(defaultReconciliationRetentionGroups(separate).map((group) => group.noticeId)).toEqual(["z", "a"]);
  });

  it("splits only by ledger, original member, direction and amount within each notice", () => {
    const value = report([row("r1"), row("r2", { categoryName: "Shopping", source: "cmb", note: "Different text", timePrecision: "day", timeSupplemented: true }),
      row("r3", { memberAlias: "m2" }), row("r4", { ledgerAlias: "l2" }), row("r5", { type: "income" }), row("r6", { amountFen: 3000 })]);
    expect(buildReconciliationRetentionCandidates(value)).toHaveLength(5);
    expect(defaultReconciliationRetentionGroups(value)).toEqual([{ noticeId: "n1", refs: ["r1", "r2"], keepRefs: ["r1"] }]);
    expect(value.records[1]).toMatchObject({ timePrecision: "day", timeSupplemented: true });
  });

  it("keeps identical candidates in separate notices rather than merging their meaning", () => {
    const value = report([row("r1"), row("r2")], [notice("n2", ["r1", "r2"]), notice("n1", ["r1", "r2"])]);
    expect(defaultReconciliationRetentionGroups(value).map((group) => group.noticeId)).toEqual(["n1", "n2"]);
  });

  it("initializes from available records, retaining unavailable records as evidence", () => {
    const value = { ...report([row("r1"), row("r2"), row("r3")]), manualReview: { processing: false, records: [{ ref: "r1", status: "handled" as const }, { ref: "r2", status: "archived" as const }, { ref: "r3", status: "available" as const }] } };
    expect(defaultReconciliationRetentionGroups(value)).toEqual([]);
    expect(buildReconciliationRetentionCandidates(value)[0].records).toHaveLength(3);
  });

  it("does not overwrite a captured selection when availability changes in the same generation", () => {
    const value = report([row("r1"), row("r2"), row("r3")]);
    const controller = new ReconciliationApplicationController({ identity: "household:member", uuid: () => "00000000-0000-4000-8000-000000000001", storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }), request: async () => { throw new Error("Must not submit"); } });
    const draft = controller.draftFor(value);
    controller.saveDraft(value, { ...draft, retentionGroups: [{ noticeId: "n1", refs: ["r1", "r2", "r3"], keepRefs: ["r1", "r3"] }] });
    const fresh = { ...value, manualReview: { processing: false, records: [{ ref: "r1", status: "handled" as const }] } };
    controller.activateReport(fresh);
    expect(controller.draftFor(fresh).retentionGroups).toEqual([{ noticeId: "n1", refs: ["r1", "r2", "r3"], keepRefs: ["r1", "r3"] }]);
  });

  it("uses a stable group identity independent of selection and ref ordering", () => {
    const rows = [row("r1"), row("r2")];
    const records = new Map(rows.map((record) => [record.ref, record]));
    expect(reconciliationRetentionGroupKey({ noticeId: "n1", refs: ["r1", "r2"], keepRefs: ["r1"] }, records)).toBe(
      reconciliationRetentionGroupKey({ noticeId: "n1", refs: ["r2", "r1"], keepRefs: ["r2"] }, records),
    );
  });

  it("matches completed decisions by exact reference and retention sets rather than the grouping bucket", () => {
    const decision = { noticeId: "n1", refs: ["r1", "r2", "r3"], keepRefs: ["r1", "r3"] };
    expect(reconciliationRetentionDecisionKey(decision)).toBe(reconciliationRetentionDecisionKey({ ...decision, refs: ["r3", "r2", "r1"], keepRefs: ["r3", "r1"] }));
    expect(reconciliationRetentionDecisionKey(decision)).not.toBe(reconciliationRetentionDecisionKey({ ...decision, refs: ["r1", "r2"] }));
    expect(reconciliationRetentionDecisionKey(decision)).not.toBe(reconciliationRetentionDecisionKey({ ...decision, keepRefs: ["r2"] }));
  });

  it("skips all-kept groups but leaves zero-kept groups available for validation", () => {
    const full = { noticeId: "n1", refs: ["r1", "r2"], keepRefs: ["r1", "r2"] };
    const empty = { noticeId: "n2", refs: ["r3", "r4"], keepRefs: [] };
    expect(activeReconciliationRetentionGroups([full, empty])).toEqual([empty]);
  });

  it("does not silently truncate an oversized group", () => {
    const rows = Array.from({ length: 501 }, (_, index) => row(`r${index + 1}`));
    expect(defaultReconciliationRetentionGroups(report(rows))[0].refs).toHaveLength(501);
  });
});
