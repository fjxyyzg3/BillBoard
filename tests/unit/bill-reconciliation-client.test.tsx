import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BillAnalysisPanel } from "@/components/bill-analysis-panel";
import { BillAnalysisController } from "@/lib/reports/bill-analysis-controller";
import type { BillReconciliationReportDto } from "@/lib/reports/bill-reconciliation-types";

vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));

const report: BillReconciliationReportDto = {
  id: "reconciliation-report", purpose: "reconciliation", version: 1,
  scope: { mode: "year", period: "2026", ledgerId: null, actorMemberId: null },
  scopeLabels: { ledger: "All ledgers", member: "All members" }, locale: "en-US",
  generatedAt: "2026-11-05T00:00:00.000Z", snapshotAt: "2026-11-05T00:00:00.000Z",
  range: { from: "2026-01-01", to: "2026-11-05" }, generation: 1, records: [], suggestions: [],
};

describe("bill reconciliation client report boundary", () => {
  it("opens a versioned reconciliation report without requiring the legacy prose body", async () => {
    const controller = new BillAnalysisController({ identity: "household:member", uuid: () => "00000000-0000-4000-8000-000000000001",
      storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
      request: async () => Response.json({ report }),
    });
    await expect(controller.loadReport({ reportId: report.id })).resolves.toEqual(report);
  });

  it("presents the existing monthly and annual entry as AI reconciliation", () => {
    const markup = renderToStaticMarkup(<BillAnalysisPanel scope={report.scope} locale="zh-CN" />);
    expect(markup).toContain("AI 对账");
    expect(markup).toContain("退款");
    expect(markup).not.toContain("比较期统计摘要");
  });
});
