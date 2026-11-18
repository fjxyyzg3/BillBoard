import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BillAnalysisEntryList, BillAnalysisPanel, BillAnalysisReportView } from "@/components/bill-analysis-panel";
import { BillAnalysisProvider } from "@/components/bill-analysis-provider";
import type { BillAnalysisEntryDto, BillAnalysisReportDto } from "@/lib/reports/bill-analysis-types";
import { getMessages } from "@/lib/i18n";

vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));

const report: BillAnalysisReportDto = {
  id: "report", scope: { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null },
  scopeLabels: { ledger: "全部账本", member: "全部成员" }, locale: "zh-CN",
  generatedAt: "2026-11-01T01:00:00.000Z", snapshotAt: "2026-11-01T00:50:00.000Z",
  range: { from: "2026-10-01", to: "2026-10-31" }, generation: 1,
  body: {
    overview: "本期收支复盘",
    observations: [{ title: "餐饮记录较集中", detail: "请核对是否包含聚餐。", evidenceRefs: ["current.expenseFen", "r1"] }],
    recommendations: [{ title: "先核对账目", detail: "<script>unsafe()</script><a href='https://example.com'>外部指令</a>", evidenceRefs: ["r1"] }],
    limitations: ["只代表已记录账目。"],
  },
  metrics: [{ ref: "current.incomeFen", label: "本期收入", value: 120000, unit: "fen" },
    { ref: "current.expenseFen", label: "本期支出", value: 35000, unit: "fen" },
    { ref: "current.netFen", label: "本期结余", value: 85000, unit: "fen" }],
  evidence: [{ ref: "r1", date: "2026-10-03", type: "expense", amountFen: 35000, categoryName: "Dining", memberAlias: "m1", ledgerAlias: "l1" }],
};

describe("bill analysis report presentation", () => {
  it("renders the application provider before any browser identity or outcome has been initialized", () => {
    const markup = renderToStaticMarkup(<BillAnalysisProvider identity={{ householdId: "household", memberId: "member" }} locale="zh-CN"><BillAnalysisPanel scope={report.scope} locale="zh-CN" /></BillAnalysisProvider>);
    expect(markup).toContain("AI 对账");
    expect(markup).not.toContain("bill-analysis-feedback");
  });
  it("renders server facts, original report language and snapshot boundaries separately from advice", () => {
    const markup = renderToStaticMarkup(<BillAnalysisReportView report={report} locale="zh-CN" />);
    expect(markup).toContain("收支复盘");
    expect(markup).toContain("值得关注");
    expect(markup).toContain("改进建议");
    expect(markup).toContain("1,200.00");
    expect(markup).toContain("350.00");
    expect(markup).toContain("餐饮");
    expect(markup).toContain("统计截止");
    expect(markup).toContain("后续补录、修改或删除不会自动更新");
    expect(markup).toContain("报告语言");
    expect(markup).toContain("中文");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<a href=");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("can read a saved report in English without changing its original body or claiming retranslation", () => {
    const markup = renderToStaticMarkup(<BillAnalysisReportView report={report} locale="en-US" />);
    expect(markup).toContain("Suggested improvements");
    expect(markup).toContain("Report language");
    expect(markup).toContain("Chinese");
    expect(markup).toContain("本期收支复盘");
    expect(markup).toContain("Recorded through");
  });

  it.each(["zh-CN", "en-US"] as const)("offers existing reports while the current range cannot generate in %s", (locale) => {
    const labels = getMessages(locale).billAnalysis;
    const markup = renderToStaticMarkup(<BillAnalysisPanel scope={null} locale={locale} />);
    expect(markup).toContain(labels.monthlyOrYearly);
    expect(markup).toContain(labels.history);
    expect(markup).not.toContain(`>${labels.generate}</button>`);
  });

  it("discloses original notes and source types before scanning while server hydration is pending", () => {
    const markup = renderToStaticMarkup(<BillAnalysisPanel scope={report.scope} locale="zh-CN" />);
    expect(markup).toContain("原文备注");
    expect(markup).toContain("来源类型");
    expect(markup).toContain("生成建议不会自动改账");
    expect(markup).not.toContain("比较期统计摘要");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>扫描账目<\/button>/);
    expect(markup).toContain("锁屏、刷新或关闭应用仍会继续生成");
  });

  it.each(["zh-CN", "en-US"] as const)("keeps the previous report readable alongside the latest failed or cancelled attempt in %s", (locale) => {
    const labels = getMessages(locale).billAnalysis;
    const entries: BillAnalysisEntryDto[] = ["CANCELLED", "UNAVAILABLE"].map((error, index) => ({
      id: `slot-${index}`, scope: report.scope, scopeLabels: report.scopeLabels, report,
      updatedAt: "2026-11-02T00:00:00.000Z", task: { id: `task-${index}`, status: "error", phase: null, completedBatches: 2, totalBatches: 3,
        error: error as "CANCELLED" | "UNAVAILABLE", canCancel: false, startedAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:01:00.000Z" },
    }));
    const markup = renderToStaticMarkup(<BillAnalysisEntryList entries={entries} locale={locale} onViewReport={() => {}} />);
    expect(markup).toContain(labels.taskStatus.cancelled);
    expect(markup).toContain(labels.taskStatus.error);
    expect(markup.match(new RegExp(labels.viewSavedReport, "g"))).toHaveLength(2);
    expect(markup).toContain(labels.generated);
    expect(markup).not.toContain(labels.cancel + "</button>");
  });

  it("shows real batch progress but no cancellation control in another session", () => {
    const labels = getMessages("en-US").billAnalysis;
    const entry: BillAnalysisEntryDto = { id: "slot", scope: report.scope, scopeLabels: report.scopeLabels, report,
      updatedAt: "2026-11-02T00:00:00.000Z", task: { id: "task", status: "processing", phase: "analyzing", completedBatches: 2, totalBatches: 3,
        canCancel: false, startedAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:01:00.000Z" } };
    const markup = renderToStaticMarkup(<BillAnalysisEntryList entries={[entry]} locale="en-US" onViewReport={() => {}} onCancel={() => {}} />);
    expect(markup).toContain(labels.phase.analyzing);
    expect(markup).toContain(labels.progress(2, 3));
    expect(markup).toContain(labels.viewSavedReport);
    expect(markup).not.toContain(labels.cancel + "</button>");
    const owned = { ...entry, task: { ...entry.task!, canCancel: true, requestId: "00000000-0000-4000-8000-000000000001" } };
    expect(renderToStaticMarkup(<BillAnalysisEntryList entries={[owned]} locale="en-US" onViewReport={() => {}} onCancel={() => {}} />)).toContain(labels.cancel + "</button>");
    const unknown = renderToStaticMarkup(<BillAnalysisEntryList entries={[owned]} locale="en-US" onViewReport={() => {}} onCancel={() => {}} unknown />);
    expect(unknown).toContain(labels.phase.unknown);
    expect(unknown).not.toContain(labels.phase.analyzing);
    expect(unknown).not.toContain(labels.cancel + "</button>");
  });
});
