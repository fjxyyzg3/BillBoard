import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillReconciliationReportView } from "@/components/bill-reconciliation-panel";
import { isBillReconciliationReport } from "@/lib/reports/bill-reconciliation-controller";
import type { BillReconciliationReportDto, ReconciliationRecord } from "@/lib/reports/bill-reconciliation-types";
import { getMessages } from "@/lib/i18n";

const row = (ref: string, occurredAt: string, type: "income" | "expense", amountFen: number): ReconciliationRecord => ({
  ref, occurredAt, date: occurredAt.slice(0, 10), type, amountFen, categoryName: type === "income" ? "Other income" : "Dining", memberLabel: "Owner", ledgerLabel: "Default",
  memberAlias: "m1", ledgerAlias: "l1", note: "Payment id abc123 <script>unsafe()</script>", source: null, timePrecision: "second", timeSupplemented: false, aggregated: false,
});
const report: BillReconciliationReportDto = {
  id: "report", purpose: "reconciliation", version: 1, generation: 1, locale: "zh-CN",
  scope: { mode: "year", period: "2026", ledgerId: null, actorMemberId: null }, scopeLabels: { ledger: "All ledgers", member: "All members" },
  generatedAt: "2026-11-05T00:00:00Z", snapshotAt: "2026-11-05T00:00:00Z", range: { from: "2026-01-01", to: "2026-11-05" },
  records: [row("r1", "2026-01-10T12:00:00+08:00", "expense", 10000), row("r2", "2026-02-10T12:00:00+08:00", "income", 3000)],
  suggestions: [{ id: "s1", kind: "reimbursement", title: "Expense and reimbursement", reason: "<a href='https://example.com'>same payment</a>",
    evidenceRefs: ["r1", "r2"], confidence: "high", defaultSelected: true, canApply: true, readOnlyReason: null,
    actions: [{ ref: "r1", action: "update", amountFen: 7000 }, { ref: "r2", action: "delete", amountFen: 3000 }] }],
};

describe("reconciliation preview presentation", () => {
  it.each(["zh-CN", "en-US"] as const)("shows original records, actions and both overall and monthly deltas in %s", (locale) => {
    const markup = renderToStaticMarkup(<BillReconciliationReportView report={report} locale={locale} />);
    const labels = getMessages(locale).billReconciliation;
    expect(markup).toContain("100.00");
    expect(markup).toContain("70.00");
    expect(markup).toContain("2026-01");
    expect(markup).toContain("2026-02");
    expect(markup).toContain(labels.monthChanges);
    expect(markup).toContain(labels.dayChanges);
    expect(markup).toContain(labels.historyEffect);
    expect(markup).toContain(labels.update);
    expect(markup).toContain(labels.remove);
    expect(markup).toContain("checked=\"\"");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<a href=");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&lt;a href=");
    expect(markup).not.toContain('data-testid="reconciliation-mobile-actions"');
    expect(markup).toMatch(/aria-describedby="[^"]+"/);
  });

  it("keeps uncertain, read-only and handled suggestions unselected", () => {
    const markup = renderToStaticMarkup(<BillReconciliationReportView report={{ ...report, suggestions: [
      { ...report.suggestions[0], confidence: "review", defaultSelected: false },
      { ...report.suggestions[0], id: "s2", canApply: false, readOnlyReason: "archived" },
      { ...report.suggestions[0], id: "s3", applied: true },
    ] }} locale="en-US" />);
    expect(markup).not.toContain("checked=\"\"");
    expect(markup).toContain("The ledger is archived");
    expect(markup).toContain("Already handled");
    expect(markup).toContain("Needs confirmation");
    expect(markup).toContain("For review only");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply selected changes<\/button>/);
  });

  it("explains day-only and unknown precision rather than presenting a filled timestamp as exact", () => {
    const markup = renderToStaticMarkup(<BillReconciliationReportView report={{ ...report, records: [
      { ...report.records[0], timePrecision: "day", timeSupplemented: true, source: "cmb" },
      { ...report.records[1], timePrecision: "unknown", aggregated: true },
    ] }} locale="en-US" />);
    expect(markup).toContain("date only");
    expect(markup).toContain("time precision cannot be verified");
    expect(markup).toContain("aggregated record");
  });

  it("rejects internal assertions and private record fields from the public report boundary", () => {
    expect(isBillReconciliationReport(report)).toBe(true);
    expect(isBillReconciliationReport({ ...report, assertions: {} })).toBe(false);
    expect(isBillReconciliationReport({ ...report, records: [{ ...report.records[0], sourceFingerprint: "private-fingerprint" }] })).toBe(false);
    expect(isBillReconciliationReport({ ...report, version: 2 })).toBe(false);
  });
});
