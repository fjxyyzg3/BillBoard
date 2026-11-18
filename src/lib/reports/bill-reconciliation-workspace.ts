import type { ReportRangeSelection } from "./report-range";

export function buildReconciliationWorkspaceHref(selection: ReportRangeSelection, ledgerId?: string, actorMemberId?: string) {
  const params = new URLSearchParams({ ledger: ledgerId ?? "all" });
  if (selection.mode === "month" || selection.mode === "year") {
    params.set("mode", selection.mode);
    params.set(selection.mode, selection.mode === "month" ? selection.month : selection.year);
  } else {
    params.set("rangeReset", "1");
  }
  if (actorMemberId) params.set("member", actorMemberId);
  return `/records/reconcile?${params}`;
}
