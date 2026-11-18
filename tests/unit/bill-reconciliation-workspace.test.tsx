import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as analysisProvider from "@/components/bill-analysis-provider";
import { billAnalysisScopeHref } from "@/components/bill-analysis-provider";
import { BillReconciliationReportView } from "@/components/bill-reconciliation-panel";
import { ReconciliationManualReview } from "@/components/bill-reconciliation-manual-review";
import type { BillReconciliationReportDto, ReconciliationRecord } from "@/lib/reports/bill-reconciliation-types";
import { ReconciliationApplicationController } from "@/lib/reports/bill-reconciliation-controller";
import { buildReconciliationRetentionCandidates } from "@/lib/reports/bill-reconciliation-grouping";

const row = (ref: string, amountFen: number): ReconciliationRecord => ({
  ref, occurredAt: "2026-10-20T00:00:00+08:00", date: "2026-10-20", type: "expense", amountFen,
  categoryName: "Dining", memberLabel: "Owner", ledgerLabel: "Default", memberAlias: "m1", ledgerAlias: "l1",
  note: null, source: null, timePrecision: "unknown", timeSupplemented: false, aggregated: false,
});
const report: BillReconciliationReportDto = {
  id: "report", purpose: "reconciliation", version: 1, generation: 1, locale: "zh-CN",
  scope: { mode: "month", period: "2026-10", ledgerId: "ledger-a", actorMemberId: "member-a" },
  scopeLabels: { ledger: "Default", member: "Owner" }, generatedAt: "2026-11-05T00:00:00Z", snapshotAt: "2026-11-05T00:00:00Z",
  range: { from: "2026-10-01", to: "2026-10-31" }, records: [row("r1", 7775), row("r2", 1390), row("r3", 7775), row("r4", 1390)],
  suggestions: [{ id: "notice", kind: "notice", title: "Adjacent cross-source records", reason: "Review these records manually.",
    evidenceRefs: ["r1", "r2", "r3", "r4"], confidence: "review", defaultSelected: false, canApply: false, readOnlyReason: "unsupported", actions: [] }],
};

describe("AI reconciliation workspace", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("links background results to the dedicated route with their original scope", () => {
    expect(billAnalysisScopeHref(report.scope)).toBe("/records/reconcile?mode=month&month=2026-10&ledger=ledger-a&member=member-a");
  });

  it("groups a notice by amount and preselects the earliest retained record without a manual editor", () => {
    const markup = renderToStaticMarkup(<BillReconciliationReportView report={report} locale="zh-CN" />);
    expect(markup.match(/data-testid="reconciliation-retention-group"/g)).toHaveLength(2);
    expect(markup.match(/type="checkbox"/g)).toHaveLength(4);
    expect(markup.match(/checked=""/g)).toHaveLength(2);
    expect(markup).toContain("未调整的组也将按默认选择处理");
    expect(markup).not.toContain(">人工核对</button>");
    expect(markup).not.toContain('type="radio"');
  });

  it.each(["zh-CN", "en-US"] as const)("uses a single mobile action with live selection counts and the default-processing reminder in %s", (locale) => {
    const markup = renderToStaticMarkup(<BillReconciliationReportView report={report} locale={locale} />);
    expect(markup).toContain('data-testid="reconciliation-mobile-actions"');
    expect(markup.match(/data-testid="bill-reconciliation-apply"/g)).toHaveLength(1);
    expect(markup).toContain(locale === "zh-CN" ? "保留 2 · 待删除 2" : "Keep 2 · Delete 2");
    expect(markup).toContain(locale === "zh-CN" ? "未调整组按默认处理" : "Defaults also apply");
  });

  it("previews the retained and deleted records directly without a secondary keeper choice", () => {
    const candidate = buildReconciliationRetentionCandidates(report).find((item) => item.group.refs.includes("r1"))!;
    const markup = renderToStaticMarkup(<ReconciliationManualReview candidate={candidate} group={candidate.group} index={0} locale="zh-CN" locked={false} conflict={false} unavailable={new Map()} onChange={() => {}} />);
    expect(markup).toMatch(/data-testid="manual-action-r1">保留此笔<\/span>/);
    expect(markup).toMatch(/data-testid="manual-action-r3">待删除<\/span>/);
    expect(markup).not.toContain('data-testid="manual-action-r2"');
    expect(markup).not.toContain('data-testid="manual-action-r4"');
    expect(markup).toContain('data-testid="retention-keep-all"');
    expect(markup).not.toContain('type="radio"');
    expect(markup).not.toContain("加入待应用选集");
  });

  it("does not assign the current deletion decision to previously handled evidence outside the applied group", () => {
    const value = { ...report, records: report.records.map((record) => ({ ...record, amountFen: 7775 })) };
    const candidate = buildReconciliationRetentionCandidates(value)[0];
    const group = { noticeId: "notice", refs: ["r3", "r4"], keepRefs: ["r3"] };
    const unavailable = new Map(value.records.map((record) => [record.ref, "handled" as const]));
    const markup = renderToStaticMarkup(<ReconciliationManualReview candidate={candidate} group={group} index={0} locale="zh-CN" locked={false} conflict={false} unavailable={unavailable} complete onChange={() => {}} />);
    expect(markup).toMatch(/data-testid="manual-action-r1">已处理<\/span>/);
    expect(markup).toMatch(/data-testid="manual-action-r2">已处理<\/span>/);
    expect(markup).toMatch(/data-testid="manual-action-r3">已处理 · 保留此笔<\/span>/);
    expect(markup).toMatch(/data-testid="manual-action-r4">已处理 · 待删除<\/span>/);
  });

  it("explains a stale manual group after another member handles its records and keeps removal available", async () => {
    const controller = new ReconciliationApplicationController({ identity: "account:household:member", uuid: () => "00000000-0000-4000-8000-000000000001", storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }), request: async () => { throw new Error("Rendering must not submit"); } });
    await controller.initialize();
    controller.saveDraft(report, { suggestionIds: [], manualGroups: [], retentionGroups: [{ noticeId: "notice", refs: ["r1", "r3"], keepRefs: ["r1"] }], editor: null });
    vi.spyOn(analysisProvider, "useBillReconciliationApplication").mockImplementation(() => ({ ...controller.getSnapshot(), controller }));
    const fresh: BillReconciliationReportDto = { ...report, manualReview: { processing: false, records: report.records.map((row) => ({ ref: row.ref, status: row.ref === "r1" || row.ref === "r3" ? "handled" : "available" })) } };
    const markup = renderToStaticMarkup(<BillReconciliationReportView report={fresh} locale="zh-CN" />);
    expect(markup).toContain("人工分组中的记录已处理或账本已归档。选择全部保留以跳过该组，或重新核对可用记录。");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>一键应用所选修改<\/button>/);
    expect(markup).toMatch(/<button(?![^>]*\sdisabled=)[^>]*data-testid="retention-keep-all"[^>]*>全部保留<\/button>/);
  });

  it.each(["subset", "different keeper"] as const)("does not replace a larger or differently retained draft with a %s receipt from the same grouping bucket", async (variant) => {
    const value = { ...report, records: report.records.map((record) => ({ ...record, amountFen: 7775 })) };
    const subset = variant === "subset" ? { noticeId: "notice", refs: ["r1", "r2"], keepRefs: ["r1"] } : { noticeId: "notice", refs: ["r1", "r2", "r3", "r4"], keepRefs: ["r2"] };
    const controller = new ReconciliationApplicationController({ identity: "account:household:member", uuid: () => "00000000-0000-4000-8000-000000000001", storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }), request: async (body) => Response.json({ result: { requestId: body.requestId, status: "success", reportId: value.id, generation: value.generation, version: 3, suggestionIds: [], manualGroups: [subset] } }) });
    await controller.initialize();
    controller.saveDraft(value, controller.draftFor(value));
    expect(controller.apply(value, [], [subset])).toBe("started");
    await vi.waitFor(() => expect(controller.getSnapshot().outcome?.status).toBe("success"));
    vi.spyOn(analysisProvider, "useBillReconciliationApplication").mockImplementation(() => ({ ...controller.getSnapshot(), controller }));
    const markup = renderToStaticMarkup(<BillReconciliationReportView report={value} locale="zh-CN" />);
    expect(markup.match(/type="checkbox"/g)).toHaveLength(4);
    expect(markup).toContain("人工分组中的记录已处理或账本已归档。选择全部保留以跳过该组");
    expect(markup).toMatch(/<button(?![^>]*\sdisabled=)[^>]*data-testid="retention-keep-all"/);
  });
});
