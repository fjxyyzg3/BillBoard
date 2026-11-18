"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useBillReconciliationApplication } from "@/components/bill-analysis-provider";
import { ReconciliationManualReview } from "@/components/bill-reconciliation-manual-review";
import { ReconciliationRecordDetails } from "@/components/bill-reconciliation-record";
import { getMessages, type Locale } from "@/lib/i18n";
import { defaultReconciliationWorkspaceDraft, toggleReconciliationSelection, type ReconciliationWorkspaceDraft } from "@/lib/reports/bill-reconciliation-controller";
import { activeReconciliationRetentionGroups, buildReconciliationRetentionCandidates, defaultReconciliationRetentionGroups, reconciliationRetentionDecisionKey, reconciliationRetentionGroupKey } from "@/lib/reports/bill-reconciliation-grouping";
import { previewReconciliationSelection } from "@/lib/reports/bill-reconciliation-selection";
import type { BillReconciliationReportDto, ReconciliationManualSelectionGroup, ReconciliationPreview, ReconciliationRecord, ReconciliationRetentionGroup, ReconciliationSuggestion, ReconciliationTotals } from "@/lib/reports/bill-reconciliation-types";
import styles from "./bill-reconciliation-retention.module.css";

function money(value: number, locale: Locale, signed = false) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2,
    ...(signed ? { signDisplay: "exceptZero" as const } : {}) }).format(value / 100);
}
function count(value: number, locale: Locale, signed = false) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, ...(signed ? { signDisplay: "exceptZero" as const } : {}) }).format(value);
}
function date(value: string, locale: Locale, time = false) {
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00+08:00` : value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(locale, { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    ...(time ? { hour: "2-digit", minute: "2-digit" } as const : {}) }).format(parsed) : "—";
}

function TotalsPreview({ preview, locale }: { preview: ReconciliationPreview; locale: Locale }) {
  const labels = getMessages(locale).billReconciliation;
  const shared = getMessages(locale).billAnalysis;
  const fields = [["incomeFen", shared.income], ["expenseFen", shared.expense], ["netFen", labels.net], ["transactionCount", labels.count]] as const;
  return <dl className="divide-y divide-[var(--bb-warm-line)] rounded-xl bg-[var(--bb-warm-surface)] px-3">
    {fields.map(([key, label]) => <div className="py-3" key={key}>
      <dt className="text-xs font-semibold">{label}</dt>
      <dd className={`${styles.previewGrid} mt-2`}>
        {(["before", "after", "delta"] as const).map((period) => <div className={styles.previewMetric} key={period}>
          <p className="text-xs text-[var(--bb-muted)]">{labels[period]}</p>
          <p className="whitespace-nowrap text-sm font-medium tabular-nums">{key === "transactionCount" ? count(preview[period][key], locale, period === "delta") : money(preview[period][key], locale, period === "delta")}</p>
        </div>)}
      </dd>
    </div>)}
  </dl>;
}

function PeriodChanges({ points, locale, title, open = false }: { points: Array<{ key: string; delta: ReconciliationTotals }>; locale: Locale; title: string; open?: boolean }) {
  const labels = getMessages(locale).billReconciliation;
  const shared = getMessages(locale).billAnalysis;
  if (!points.length) return null;
  return <details className="border-t border-[var(--bb-warm-line)] pt-2" open={open}>
    <summary className="min-h-11 cursor-pointer text-xs font-medium">{title} · {count(points.length, locale)}</summary>
    <ul className="divide-y divide-[var(--bb-warm-line)]">
      {points.map((point) => <li className="space-y-2 py-3" key={point.key}>
        <p className="text-xs font-semibold tabular-nums">{point.key}</p>
        <dl className={styles.previewGrid}>
          {([["incomeFen", shared.income], ["expenseFen", shared.expense], ["netFen", labels.net], ["transactionCount", labels.count]] as const).map(([field, label]) => <div className={styles.previewMetric} key={field}>
            <dt className="text-xs text-[var(--bb-muted)]">{label}</dt><dd className="whitespace-nowrap text-xs tabular-nums">{field === "transactionCount" ? count(point.delta[field], locale, true) : money(point.delta[field], locale, true)}</dd>
          </div>)}
        </dl>
      </li>)}
    </ul>
  </details>;
}

function SuggestionRecords({ suggestion, records, locale }: { suggestion: ReconciliationSuggestion; records: Map<string, ReconciliationRecord>; locale: Locale }) {
  const labels = getMessages(locale).billReconciliation;
  return <ul className="space-y-3" aria-label={labels.original}>
    {suggestion.evidenceRefs.map((ref) => {
      const row = records.get(ref);
      if (!row) return null;
      const action = suggestion.actions.find((item) => item.ref === ref);
      return <li className="min-w-0 rounded-lg border border-[var(--bb-warm-line)] p-3 text-xs" key={ref}>
        <ReconciliationRecordDetails row={row} locale={locale} />
        {action ? <p className="mt-2 break-words font-medium leading-5">{action.action === "delete" ? labels.remove : action.action === "update" ? `${labels.update} → ${money(action.amountFen, locale)}` : labels.keep}</p> : null}
      </li>;
    })}
  </ul>;
}

export function BillReconciliationReportView({ report, locale, onRescan }: { report: BillReconciliationReportDto; locale: Locale; onRescan?: () => void }) {
  const labels = getMessages(locale).billReconciliation;
  const shared = getMessages(locale).billAnalysis;
  const application = useBillReconciliationApplication();
  const controller = application.controller;
  const [localDraft, setLocalDraft] = useState<ReconciliationWorkspaceDraft>(() => defaultReconciliationWorkspaceDraft(report));
  const [actionError, setActionError] = useState<string | null>(null);
  const draft = controller?.draftFor(report) ?? localDraft;
  const headingId = useId();
  const messageId = useId();
  useEffect(() => { controller?.activateReport(report); }, [controller, report]);
  const saveDraft = (next: ReconciliationWorkspaceDraft) => { setActionError(null); if (controller) controller.saveDraft(report, next); else setLocalDraft(next); };
  const matchingOutcome = application.outcome?.reportId === report.id && application.outcome.generation === report.generation ? application.outcome : null;
  const justApplied = new Set(matchingOutcome?.status === "success" ? [...(matchingOutcome.suggestionIds ?? []), ...(matchingOutcome.affectedSuggestionIds ?? [])] : []);
  const handled = controller?.handledRefsFor(report) ?? new Set(report.manualReview?.records.filter((row) => row.status === "handled").map((row) => row.ref));
  const unavailable = new Map<string, "handled" | "archived">(report.manualReview?.records.filter((row) => row.status !== "available").map((row) => [row.ref, row.status as "handled" | "archived"]));
  handled.forEach((ref) => unavailable.set(ref, "handled"));
  const eligible = report.suggestions.filter((item) => item.canApply && !item.applied && !justApplied.has(item.id) && !item.evidenceRefs.some((ref) => unavailable.has(ref)));
  const pendingHere = application.pending?.reportId === report.id && application.pending.generation === report.generation;
  const currentSelection = pendingHere ? application.selectionIds ?? [] : draft.suggestionIds;
  const selectedIds = pendingHere ? currentSelection : currentSelection.filter((id) => eligible.some((item) => item.id === id));
  const records = new Map(report.records.map((row) => [row.ref, row]));
  const candidates = buildReconciliationRetentionCandidates(report);
  const retentionGroups = draft.retentionGroups ?? defaultReconciliationRetentionGroups(report);
  const retentionByKey = new Map(retentionGroups.map((group) => [reconciliationRetentionGroupKey(group, records), group]));
  const completedGroups = controller?.completedRetentionGroupsFor(report) ?? [];
  const completedDecisions = new Set(completedGroups.map(reconciliationRetentionDecisionKey));
  const manualGroups: ReconciliationManualSelectionGroup[] = pendingHere ? application.manualGroups ?? [] : [...draft.manualGroups, ...activeReconciliationRetentionGroups(retentionGroups).filter((group) => !completedDecisions.has(reconciliationRetentionDecisionKey(group)))];
  const manualUnavailable = manualGroups.some((group) => group.refs.some((ref) => unavailable.has(ref)));
  const participantCounts = new Map<string, number>();
  for (const ref of [...manualGroups.flatMap((group) => group.refs), ...report.suggestions.filter((item) => selectedIds.includes(item.id)).flatMap((item) => item.evidenceRefs)]) participantCounts.set(ref, (participantCounts.get(ref) ?? 0) + 1);
  const conflicts = new Set([...participantCounts].filter(([, uses]) => uses > 1).map(([ref]) => ref));
  const requestBody = { operation: "apply", requestId: "00000000-0000-4000-8000-000000000000", reportId: report.id, generation: report.generation, suggestionIds: selectedIds,
    ...(manualGroups.length ? { version: manualGroups.some((group) => "keepRefs" in group) ? 3 : 2, manualGroups } : {}) };
  const requestBytes = controller ? controller.requestByteLength(requestBody) : new TextEncoder().encode(JSON.stringify(requestBody)).byteLength;
  const selectionTooLarge = manualGroups.length + selectedIds.length > 200 || participantCounts.size > 1000 || manualGroups.some((group) => group.refs.length > 500) || requestBytes > 16 * 1024;
  const selectedKey = JSON.stringify({ selectedIds, manualGroups });
  const preview = useMemo(() => {
    try { return !manualUnavailable && !selectionTooLarge && (selectedIds.length || manualGroups.length) ? previewReconciliationSelection(report.records, report.suggestions, { suggestionIds: selectedIds, manualGroups }) : null; }
    catch { return null; }
    // Selection contents own the preview, rather than arrays created during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, selectedKey, manualUnavailable, selectionTooLarge]);
  const stale = matchingOutcome?.status === "error" && matchingOutcome.error === "CONFLICT";
  const processing = report.manualReview?.processing === true;
  const locked = Boolean(application.pending) || processing;
  const suggestionSections = [
    { title: labels.selectable, items: report.suggestions.filter((item) => item.kind !== "notice" && eligible.includes(item) && item.confidence === "high") },
    { title: labels.review, items: report.suggestions.filter((item) => item.kind !== "notice" && eligible.includes(item) && item.confidence !== "high") },
    { title: labels.notice, items: report.suggestions.filter((item) => item.kind !== "notice" && !eligible.includes(item)) },
  ];
  function changeRetentionGroup(nextGroup: ReconciliationRetentionGroup) {
    const key = reconciliationRetentionGroupKey(nextGroup, records);
    saveDraft({ ...draft, retentionGroups: retentionGroups.map((group) => reconciliationRetentionGroupKey(group, records) === key ? nextGroup : group) });
  }
  function applySelection() {
    const result = controller?.apply(report, selectedIds, manualGroups) ?? "not-ready";
    setActionError(result === "invalid" ? labels.errors.INVALID : result === "busy" ? labels.errors.BUSY : result === "not-ready" ? shared.loading : null);
  }
  const selectionError = manualUnavailable ? labels.manualGroupUnavailable : conflicts.size ? labels.selectionConflict : selectionTooLarge ? labels.errors.TOO_LARGE : labels.errors.INVALID;
  const mobileActionNote = application.pending ? labels.retentionDockPending : processing ? labels.retentionDockProcessing : stale ? labels.rescanAction : !preview ? selectedIds.length || manualGroups.length ? labels.retentionDockBlocked : labels.retentionDockNoChanges : labels.retentionDockNote;
  return <article className={`min-w-0 space-y-5 ${candidates.length ? styles.hasRetention : ""}`} data-testid="bill-reconciliation-report" aria-labelledby={headingId} aria-busy={application.phase === "submitting"}>
    <header className="space-y-2">
      <h3 className="break-words text-base font-semibold" id={headingId}>{report.scope.period} · {report.scopeLabels.ledger} · {report.scopeLabels.member}</h3>
      <dl className="grid gap-x-5 gap-y-1 text-xs leading-5 text-[var(--bb-muted)] sm:grid-cols-2">
        <div><dt className="inline">{shared.generated} · </dt><dd className="inline tabular-nums">{date(report.generatedAt, locale, true)}</dd></div>
        <div><dt className="inline">{shared.snapshot} · </dt><dd className="inline tabular-nums">{date(report.snapshotAt, locale, true)}</dd></div>
        <div><dt className="inline">{shared.cutoff} · </dt><dd className="inline tabular-nums">{date(report.range.to, locale)}</dd></div>
        <div><dt className="inline">{shared.language} · </dt><dd className="inline">{shared.languageNames[report.locale]}</dd></div>
      </dl>
      <p className="text-xs leading-5 text-[var(--bb-muted)]">{shared.shared} {labels.originalLanguage}</p>
      {draft.generationReset ? <p className="text-sm leading-6" role="status">{labels.generationReset}</p> : null}
      {draft.dirty && !application.pending ? <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.unsavedDraft}</p> : null}
      {processing ? <p className="text-sm leading-6" role="status">{labels.manualProcessing}</p> : null}
    </header>
    {!report.suggestions.length ? <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.noFindings}</p> : null}
    <div className={styles.layout}>
      <div className={`${styles.review} space-y-5`}>
        {suggestionSections.filter((section) => section.items.length).map((section) => <section className="space-y-3" key={section.title}>
          <h4 className="text-sm font-semibold">{section.title}</h4>
          <ul className="space-y-4">{section.items.map((item) => {
            const applied = item.applied || justApplied.has(item.id) || item.evidenceRefs.some((ref) => handled.has(ref));
            const selectable = eligible.includes(item);
            const checkboxId = `${headingId}-${item.id}`;
            const conflict = item.evidenceRefs.some((ref) => conflicts.has(ref));
            const reason = conflict ? labels.selectionConflict : item.readOnlyReason ? labels.readOnlyReasons[item.readOnlyReason as keyof typeof labels.readOnlyReasons] ?? labels.readonly : null;
            return <li className="min-w-0 space-y-3 border-t border-[var(--bb-warm-line)] pt-3" key={item.id} data-testid={`reconciliation-suggestion-${item.id}`}>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <label className="flex min-h-11 min-w-0 items-center gap-3 text-sm font-semibold" htmlFor={checkboxId}>
                  <input className="h-4 w-4 shrink-0 accent-[var(--bb-primary)]" id={checkboxId} type="checkbox" checked={selectable && selectedIds.includes(item.id)} disabled={!selectable || locked}
                    aria-describedby={`${checkboxId}-reason`} onChange={() => saveDraft({ ...draft, suggestionIds: toggleReconciliationSelection(report.suggestions, selectedIds, item.id) })} />
                  <span className="break-words">{item.title}</span>
                </label>
                <span className="shrink-0 pt-3 text-xs text-[var(--bb-muted)]">{applied ? labels.applied : item.confidence === "high" && selectable ? labels.high : labels.kinds[item.kind]}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm leading-6" id={`${checkboxId}-reason`}>{item.reason}{reason ? ` ${reason}` : ""}</p>
              {!selectable && !applied && !reason ? <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.readonly}</p> : null}
              <SuggestionRecords suggestion={item} records={records} locale={locale} />
            </li>;
          })}</ul>
        </section>)}
        {candidates.length ? <section aria-label={labels.retentionTitle} data-testid="reconciliation-manual-groups">
          <div className={styles.reviewHeading}><h4 className="text-sm font-semibold">{labels.retentionTitle}</h4><span className="text-xs text-[var(--bb-muted)]">{labels.retentionOrder}</span></div>
          <p className={styles.help}>{labels.retentionHelp}</p>
          <div className={styles.groups}>{candidates.map((candidate, index) => {
            const group = retentionByKey.get(candidate.key);
            return <ReconciliationManualReview key={candidate.key} candidate={candidate} group={group} index={index} locale={locale} locked={locked} unavailable={unavailable} complete={Boolean(group && completedDecisions.has(reconciliationRetentionDecisionKey(group)))}
              conflict={Boolean(group && group.keepRefs.length !== group.refs.length && group.refs.some((ref) => conflicts.has(ref)))} onChange={changeRetentionGroup} />;
          })}</div>
          <p className={styles.evidence}>{labels.retentionEvidenceHelp}</p>
        </section> : null}
      </div>
      {report.suggestions.length ? <section className={styles.summary} aria-label={labels.delta}>
        <h4 className={styles.summaryTitle}>{labels.retentionSummary}</h4>
        <p className="mt-1 text-xs text-[var(--bb-muted)]">{labels.selected(selectedIds.length + manualGroups.length)}</p>
        {candidates.length ? <dl className={styles.summaryCounts}><div><dt>{labels.retentionKeep}</dt><dd>{preview ? count(preview.after.transactionCount, locale) : "—"}</dd></div><div><dt>{labels.retentionDelete}</dt><dd className={styles.deletedCount}>{preview ? count(-preview.delta.transactionCount, locale) : "—"}</dd></div></dl> : null}
        {preview ? <div className="mt-3 space-y-3"><TotalsPreview preview={preview} locale={locale} /><p className="text-xs leading-5 text-[var(--bb-muted)]">{manualGroups.length ? labels.manualHistoryEffect : labels.historyEffect}</p>
          {report.scope.mode === "year" ? <PeriodChanges points={preview.months} locale={locale} title={labels.monthChanges} open /> : null}
          <PeriodChanges points={preview.days} locale={locale} title={labels.dayChanges} open={report.scope.mode === "month"} /></div>
          : <p className={styles.summaryMessage} id={`${messageId}-selection`} role={selectedIds.length || manualGroups.length ? "alert" : undefined}>{selectedIds.length || manualGroups.length ? selectionError : candidates.length ? labels.retentionNoChanges : labels.noSelection}</p>}
        <div className={styles.summaryMessage} id={messageId} aria-live="polite">
          {application.pending ? <p>{application.phase === "submitting" ? labels.applying : labels.unknown} {labels.frozen}</p> : null}
          {stale ? <p className="text-[var(--bb-danger)]" role="alert">{labels.rescan}</p> : null}
          {matchingOutcome?.status === "error" && !stale && matchingOutcome.error ? <p className="text-[var(--bb-danger)]" role="alert">{labels.rejected} {labels.errors[matchingOutcome.error]}</p> : null}
          {matchingOutcome?.status === "success" ? <p>{labels.completed}</p> : null}
          {application.accessError ? <p>{labels.errors[application.accessError]}</p> : null}
          {!application.storageAvailable ? <p>{labels.storageUnavailable}</p> : null}
          {actionError ? <p className="text-[var(--bb-danger)]" role="alert">{actionError}</p> : null}
        </div>
        {candidates.length ? <p className={styles.applyNote} id={`${messageId}-notice`}>{labels.retentionApplyNote}</p> : null}
        <div className={candidates.length ? styles.mobileActions : undefined} data-testid={candidates.length ? "reconciliation-mobile-actions" : undefined}>
          {candidates.length ? <div className={styles.mobileActionStats}>
            <p className={styles.mobileActionCounts}>{labels.retentionDockCounts(preview ? count(preview.after.transactionCount, locale) : "—", preview ? count(-preview.delta.transactionCount, locale) : "—")}</p>
            <p className={styles.mobileActionNote}>{mobileActionNote}</p>
          </div> : null}
          <button className={styles.apply} type="button" data-testid="bill-reconciliation-apply" aria-describedby={`${messageId}${!preview ? ` ${messageId}-selection` : ""}${candidates.length ? ` ${messageId}-notice` : ""}`} disabled={!controller || !application.ready || !preview || locked || stale}
            onClick={applySelection}>{application.phase === "submitting" ? labels.applying : labels.apply}</button>
        </div>
        {application.pending ? <button className="mt-2 min-h-11 text-xs underline disabled:opacity-50" disabled={application.phase === "submitting" || application.phase === "querying"} type="button" onClick={() => { void controller?.confirm(); }}>{labels.query}</button> : null}
        {(stale || manualUnavailable) && onRescan ? <button className="mt-2 min-h-11 text-xs underline" onClick={onRescan} type="button">{labels.rescanAction}</button> : null}
      </section> : null}
    </div>
  </article>;
}
