import { describe, expect, it, vi } from "vitest";
import { warnBeforeLosingReconciliationDrafts } from "@/components/bill-analysis-provider";
import { ReconciliationApplicationController } from "@/lib/reports/bill-reconciliation-controller";
import type { BillReconciliationReportDto, ReconciliationRecord } from "@/lib/reports/bill-reconciliation-types";

const report = { id: "report", generation: 1, suggestions: [] } as unknown as BillReconciliationReportDto;
function setup() {
  const saved = new Map<string, string>();
  const bodies: Record<string, unknown>[] = [];
  const controller = new ReconciliationApplicationController({ identity: "account:household:member", uuid: () => "00000000-0000-4000-8000-000000000001",
    storage: () => ({ getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: (key) => { saved.delete(key); } }),
    request: async (body) => { bodies.push(body); return Response.json({ result: { requestId: body.requestId, status: "unknown" } }); },
  });
  return { controller, saved, bodies };
}

function actionableReport(id: string): BillReconciliationReportDto {
  return { ...report, id, suggestions: [{ id: "s1", kind: "duplicate", title: "Duplicate", reason: "Same payment", evidenceRefs: ["r1", "r3"], confidence: "high", defaultSelected: true, canApply: true, readOnlyReason: null, actions: [{ ref: "r1", action: "keep", amountFen: 7775 }, { ref: "r3", action: "delete", amountFen: 7775 }] }] };
}

describe("in-memory reconciliation workspace drafts", () => {
  it("keeps an unfinished keeper choice when leaving and returning to the same report generation", () => {
    const { controller, saved } = setup();
    controller.saveDraft(report, { suggestionIds: [], manualGroups: [], editor: { noticeId: "notice", refs: ["r1", "r3"], keepRef: "r1", confirmed: false, editingGroupKey: null } });
    controller.activateReport({ ...report, id: "other-report" });
    controller.activateReport(report);
    expect(controller.draftFor(report).editor).toEqual({ noticeId: "notice", refs: ["r1", "r3"], keepRef: "r1", confirmed: false, editingGroupKey: null });
    expect(controller.hasUnsavedDrafts()).toBe(true);
    expect(saved.size).toBe(0);
  });

  it("invalidates a previous generation instead of reinterpreting its row refs", () => {
    const { controller } = setup();
    controller.saveDraft(report, { suggestionIds: [], manualGroups: [{ noticeId: "notice", refs: ["r1", "r3"], keepRef: "r1" }], editor: null });
    const replacement = { ...report, generation: 2 };
    controller.activateReport(replacement);
    expect(controller.draftFor(replacement).manualGroups).toEqual([]);
    expect(controller.draftFor(replacement).generationReset).toBe(true);
    expect(controller.draftFor(report).manualGroups).toEqual([]);
  });

  it("excludes the current pending report's already submitted selection from the unsaved warning", async () => {
    const { controller } = setup();
    const submitted = actionableReport("report-b");
    await controller.initialize();
    controller.saveDraft(submitted, { suggestionIds: ["s1"], manualGroups: [], editor: null });
    expect(controller.apply(submitted, ["s1"])).toBe("started");
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    expect(controller.hasUnsavedDrafts()).toBe(false);
    const event = { preventDefault: vi.fn(), returnValue: "unchanged" };
    warnBeforeLosingReconciliationDrafts(controller, event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.returnValue).toBe("unchanged");
  });

  it("warns for report A's unfinished manual choice while report B waits for its original result", async () => {
    const { controller } = setup();
    const submitted = actionableReport("report-b");
    await controller.initialize();
    controller.saveDraft(report, { suggestionIds: [], manualGroups: [], editor: { noticeId: "notice", refs: ["r1", "r3"], keepRef: "r1", confirmed: false, editingGroupKey: null } });
    controller.saveDraft(submitted, { suggestionIds: ["s1"], manualGroups: [], editor: null });
    expect(controller.apply(submitted, ["s1"])).toBe("started");
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    expect(controller.hasUnsavedDrafts()).toBe(true);
    const event = { preventDefault: vi.fn(), returnValue: "unchanged" };
    warnBeforeLosingReconciliationDrafts(controller, event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe("");
    expect(controller.draftFor(report).editor?.keepRef).toBe("r1");
    expect(controller.getSnapshot().pending?.reportId).toBe("report-b");
  });

  it("freezes manual input in memory, persists only the old pointer and recovers by query alone", async () => {
    const { controller, saved, bodies } = setup();
    const row = (ref: string): ReconciliationRecord => ({ ref, occurredAt: "2026-10-20T00:00:00+08:00", date: "2026-10-20", type: "expense", amountFen: 7775, categoryName: "Dining", memberAlias: "m1", ledgerAlias: "l1", memberLabel: "Owner", ledgerLabel: "Default", source: null, note: null, timePrecision: "unknown", timeSupplemented: false, aggregated: false });
    const manualReport: BillReconciliationReportDto = { ...report, records: [row("r1"), row("r3")], suggestions: [{ id: "notice", kind: "notice", title: "Review", reason: "Unknown source precision", evidenceRefs: ["r1", "r3"], confidence: "review", defaultSelected: false, canApply: false, readOnlyReason: "unproven", actions: [] }] };
    await controller.initialize();
    const group = { noticeId: "notice", refs: ["r1", "r3"], keepRef: "r1" };
    expect(controller.apply(manualReport, [], [group])).toBe("started");
    group.refs.push("r8"); group.keepRef = "r3";
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    expect(bodies[0]).toMatchObject({ operation: "apply", version: 2, suggestionIds: [], manualGroups: [{ noticeId: "notice", refs: ["r1", "r3"], keepRef: "r1" }] });
    expect(controller.getSnapshot().manualGroups).toEqual([{ noticeId: "notice", refs: ["r1", "r3"], keepRef: "r1" }]);
    const pointer = JSON.parse([...saved.values()][0]);
    expect(Object.keys(pointer).sort()).toEqual(["generation", "identity", "reportId", "requestId", "version"]);
    expect(JSON.stringify([...saved.values()])).not.toMatch(/manualGroups|keepRef|notice|7775|r1/);
    controller.dispose(true);
    const recoveredBodies: Record<string, unknown>[] = [];
    const reopened = new ReconciliationApplicationController({ identity: "account:household:member", uuid: () => { throw new Error("Must not allocate a replacement UUID"); }, storage: () => ({ get length() { return saved.size; }, key: (index) => [...saved.keys()][index] ?? null, getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: (key) => { saved.delete(key); } }), request: async (body) => { recoveredBodies.push(body); return Response.json({ result: { status: "unknown", requestId: body.requestId } }); } });
    await reopened.initialize();
    expect(recoveredBodies).toEqual([{ operation: "query-application", requestId: pointer.requestId }]);
    expect(reopened.getSnapshot().manualGroups).toBeNull();
  });

  it("freezes a v3 multi-retention selection and keeps all financial choices out of its recovery pointer", async () => {
    const { controller, saved, bodies } = setup();
    const row = (ref: string): ReconciliationRecord => ({ ref, occurredAt: "2026-10-20T00:00:00+08:00", date: "2026-10-20", type: "expense", amountFen: 2000, categoryName: "Dining", memberAlias: "m1", ledgerAlias: "l1", memberLabel: "Owner", ledgerLabel: "Default", source: null, note: null, timePrecision: "unknown", timeSupplemented: false, aggregated: false });
    const value: BillReconciliationReportDto = { ...report, records: [row("r1"), row("r2"), row("r3")], suggestions: [{ id: "notice", kind: "notice", title: "Review", reason: "Check", evidenceRefs: ["r1", "r2", "r3"], confidence: "review", defaultSelected: false, canApply: false, readOnlyReason: "unproven", actions: [] }] };
    await controller.initialize();
    const group = { noticeId: "notice", refs: ["r1", "r2", "r3"], keepRefs: ["r1", "r3"] };
    expect(controller.apply(value, [], [group])).toBe("started");
    group.keepRefs.pop();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    expect(bodies[0]).toMatchObject({ version: 3, manualGroups: [{ noticeId: "notice", refs: ["r1", "r2", "r3"], keepRefs: ["r1", "r3"] }] });
    expect(controller.getSnapshot().manualGroups).toEqual([{ noticeId: "notice", refs: ["r1", "r2", "r3"], keepRefs: ["r1", "r3"] }]);
    expect(JSON.stringify([...saved.values()])).not.toMatch(/manualGroups|keepRefs|notice|2000|r1/);
  });

  it("keeps the successful retention decision intact while distinguishing it from another member's handled rows", async () => {
    const row = (ref: string): ReconciliationRecord => ({ ref, occurredAt: "2026-10-20T00:00:00+08:00", date: "2026-10-20", type: "expense", amountFen: 2000, categoryName: "Dining", memberAlias: "m1", ledgerAlias: "l1", memberLabel: "Owner", ledgerLabel: "Default", source: null, note: null, timePrecision: "unknown", timeSupplemented: false, aggregated: false });
    const value: BillReconciliationReportDto = { ...report, records: [row("r1"), row("r2"), row("r3")], suggestions: [{ id: "notice", kind: "notice", title: "Review", reason: "Check", evidenceRefs: ["r1", "r2", "r3"], confidence: "review", defaultSelected: false, canApply: false, readOnlyReason: "unproven", actions: [] }] };
    const group = { noticeId: "notice", refs: ["r1", "r2", "r3"], keepRefs: ["r1", "r3"] };
    const controller = new ReconciliationApplicationController({ identity: "account:household:member", uuid: () => "00000000-0000-4000-8000-000000000001", storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }), request: async (body) => Response.json({ result: { status: "success", requestId: body.requestId, reportId: value.id, generation: value.generation, version: 3, suggestionIds: [], manualGroups: [group] } }) });
    await controller.initialize();
    controller.saveDraft(value, { ...controller.draftFor(value), retentionGroups: [group] });
    expect(controller.apply(value, [], [group])).toBe("started");
    await vi.waitFor(() => expect(controller.getSnapshot().outcome?.status).toBe("success"));
    expect(controller.draftFor(value).retentionGroups).toEqual([group]);
    expect(controller.completedRetentionGroupsFor(value)).toEqual([group]);
    const other = { ...value, id: "other-report", manualReview: { processing: false, records: [{ ref: "r1", status: "handled" as const }] } };
    expect(controller.handledRefsFor(other).has("r1")).toBe(true);
    expect(controller.completedRetentionGroupsFor(other)).toEqual([]);
  });
});
