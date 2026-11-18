import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BillAnalysisPanel } from "@/components/bill-analysis-panel";
import { BillAnalysisFeedbackSlot } from "@/components/bill-analysis-provider";
import { MemberFilter } from "@/components/member-filter";
import { ReportRangeControls } from "@/components/report-range-controls";
import styles from "@/components/finance-b2.module.css";
import { getMessages } from "@/lib/i18n";
import { buildMemberFilterOptions } from "@/lib/records/member-filter";
import type { loadReconciliationPage } from "./loader";

export function ReconciliationView({ data }: { data: Awaited<ReturnType<typeof loadReconciliationPage>> }) {
  const { locale, householdMembers, ledgerId, actorMemberId, rangeOptions, selectedRange, rangeReset } = data;
  const messages = getMessages(locale);
  const labels = messages.billReconciliation;
  const members = buildMemberFilterOptions(householdMembers, locale);
  const mode = selectedRange.mode === "year" ? "year" : "month";
  const params = new URLSearchParams({ mode, [mode]: mode === "year" ? selectedRange.year : selectedRange.month, ledger: ledgerId ?? "all" });
  if (actorMemberId) params.set("member", actorMemberId);
  return <section className={`${styles.workflow} min-w-0 space-y-4`} data-testid="reconciliation-workspace">
    <header className="space-y-3">
      <Link className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-[var(--bb-accent-ink)]" href={`/records?${params}`}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />{labels.backToRecords}
      </Link>
      <h1 className="bb-section-title">{messages.billAnalysis.title}</h1>
      <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.scopeOnly}</p>
      {rangeReset ? <p className="text-sm leading-6" role="status">{labels.rangeReset}</p> : null}
      <div className={styles.compactFilters}>
        <ReportRangeControls allowedModes={["month", "year"]} className="w-full" closeLabel={messages.common.close} labels={messages.home.range} locale={locale} rangeOptions={rangeOptions} selection={selectedRange} />
        <MemberFilter compact members={members} actorMemberId={actorMemberId} locale={locale} />
      </div>
    </header>
    <BillAnalysisFeedbackSlot />
    <BillAnalysisPanel standalone locale={locale} scope={{ mode, period: mode === "year" ? selectedRange.year : selectedRange.month, ledgerId: ledgerId ?? null, actorMemberId: actorMemberId ?? null }} memberLabel={members.find((member) => member.id === actorMemberId)?.label} />
  </section>;
}
