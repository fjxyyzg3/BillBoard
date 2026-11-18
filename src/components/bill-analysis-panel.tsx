"use client";

import { useEffect, useMemo, useState } from "react";
import { useBillAnalysis } from "@/components/bill-analysis-provider";
import styles from "./finance-b2.module.css";
import { BillReconciliationReportView } from "@/components/bill-reconciliation-panel";
import { useOptionalLedgerSelection } from "@/components/ledger-provider";
import { useProcessingChoice } from "@/components/processing-provider";
import { getCategoryDisplayName, getLedgerDisplayName, getMessages, type Locale } from "@/lib/i18n";
import { BillAnalysisClientError, billAnalysisScopeKey, type BillAnalysisController } from "@/lib/reports/bill-analysis-controller";
import type { AnyBillReportDto, BillAnalysisEntryDto, BillAnalysisErrorCode, BillAnalysisFinding, BillAnalysisMetric, BillAnalysisReportDto, BillAnalysisScope } from "@/lib/reports/bill-analysis-types";

function displayDate(value: string, locale: Locale, time = false) {
  const date = new Date(value.length === 10 ? `${value}T00:00:00+08:00` : value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    ...(time ? { hour: "2-digit", minute: "2-digit" } as const : {}) }).format(date);
}

function metricValue(metric: BillAnalysisMetric, locale: Locale) {
  return new Intl.NumberFormat(locale, metric.unit === "fen" ? { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : metric.unit === "ratio" ? { style: "percent", maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }).format(metric.unit === "fen" ? metric.value / 100 : metric.value);
}

function errorCode(error: unknown): BillAnalysisErrorCode { return error instanceof BillAnalysisClientError ? error.code : "UNAVAILABLE"; }

function FindingList({ findings, report, locale, empty }: { findings: BillAnalysisFinding[]; report: BillAnalysisReportDto; locale: Locale; empty: string }) {
  const labels = getMessages(locale).billAnalysis;
  const metrics = new Map(report.metrics.map((metric) => [metric.ref, metric]));
  const evidence = new Map(report.evidence.map((row) => [row.ref, row]));
  if (!findings.length) return <p className="text-sm text-[var(--bb-muted)]">{empty}</p>;
  return <ol className="divide-y divide-[var(--bb-warm-line)]">
    {findings.map((finding, index) => <li className="space-y-2 py-4 first:pt-0 last:pb-0" key={index}>
      <h5 className="break-words text-sm font-semibold">{finding.title}</h5>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{finding.detail}</p>
      {finding.evidenceRefs.length ? <ul className="space-y-1 text-xs leading-5 text-[var(--bb-muted)]" aria-label={labels.evidence}>
        {finding.evidenceRefs.map((ref) => {
          const metric = metrics.get(ref);
          if (metric) return <li className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3" key={ref}><span className="break-words">{metric.label}</span><span className="tabular-nums">{metricValue(metric, locale)}</span></li>;
          const row = evidence.get(ref);
          return row ? <li className="break-words tabular-nums" key={ref}>{displayDate(row.date, locale)} · {getCategoryDisplayName(row.categoryName, locale)} · {labels[row.type]} {new Intl.NumberFormat(locale, { style: "currency", currency: "CNY" }).format(row.amountFen / 100)} · {row.memberAlias} / {row.ledgerAlias}</li> : null;
        })}
      </ul> : null}
    </li>)}
  </ol>;
}

export function BillAnalysisReportView({ report, locale }: { report: BillAnalysisReportDto; locale: Locale }) {
  const labels = getMessages(locale).billAnalysis;
  const headlineMetrics = report.metrics.filter((metric) => ["current.incomeFen", "current.expenseFen", "current.netFen"].includes(metric.ref));
  return <article className="min-w-0 space-y-5" data-testid="bill-analysis-report">
    <header className="space-y-2">
      <p className="text-xs leading-5 text-[var(--bb-muted)]">{getMessages(locale).billReconciliation.legacy}</p>
      <h3 className="break-words text-base font-semibold">{report.scope.period} · {report.scopeLabels.ledger} · {report.scopeLabels.member}</h3>
      <dl className="grid min-w-0 gap-x-5 gap-y-1 text-xs leading-5 text-[var(--bb-muted)] sm:grid-cols-2">
        <div><dt className="inline">{labels.generated} · </dt><dd className="inline tabular-nums">{displayDate(report.generatedAt, locale, true)}</dd></div>
        <div><dt className="inline">{labels.snapshot} · </dt><dd className="inline tabular-nums">{displayDate(report.snapshotAt, locale, true)}</dd></div>
        <div><dt className="inline">{labels.cutoff} · </dt><dd className="inline tabular-nums">{displayDate(report.range.to, locale)}</dd></div>
        <div><dt className="inline">{labels.language} · </dt><dd className="inline">{labels.languageNames[report.locale]}</dd></div>
      </dl>
      <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.shared}</p>
    </header>
    {headlineMetrics.length ? <dl className="divide-y divide-[var(--bb-warm-line)] rounded-xl bg-[var(--bb-warm-surface)] px-3 sm:grid sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-0">
      {headlineMetrics.map((metric) => <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 py-3 sm:block sm:px-3" key={metric.ref}>
        <dt className="text-xs text-[var(--bb-muted)]">{metric.label}</dt><dd className="break-words text-base font-semibold tabular-nums sm:mt-1">{metricValue(metric, locale)}</dd>
      </div>)}
    </dl> : null}
    <section className="space-y-2"><h4 className="text-sm font-semibold">{labels.overview}</h4><p className="whitespace-pre-wrap break-words text-sm leading-6">{report.body.overview}</p></section>
    <section className="space-y-3"><h4 className="text-sm font-semibold">{labels.observations}</h4><FindingList findings={report.body.observations} report={report} locale={locale} empty={labels.noObservations} /></section>
    <section className="space-y-3"><h4 className="text-sm font-semibold">{labels.recommendations}</h4><FindingList findings={report.body.recommendations} report={report} locale={locale} empty={labels.noRecommendations} /></section>
    {report.body.limitations.length ? <section className="space-y-2"><h4 className="text-sm font-semibold">{labels.limitations}</h4><ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-[var(--bb-muted)]">{report.body.limitations.map((limitation, index) => <li className="break-words" key={index}>{limitation}</li>)}</ul></section> : null}
    {report.metrics.length ? <details className="border-t border-[var(--bb-warm-line)] pt-3">
      <summary className="min-h-11 cursor-pointer text-xs font-medium">{labels.facts}</summary>
      <dl className="divide-y divide-[var(--bb-warm-line)] text-xs">
        {report.metrics.map((metric) => <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2" key={metric.ref}><dt className="break-words text-[var(--bb-muted)]">{metric.label}</dt><dd className="tabular-nums">{metricValue(metric, locale)}</dd></div>)}
      </dl>
    </details> : null}
    <p className="border-t border-[var(--bb-warm-line)] pt-3 text-xs leading-5 text-[var(--bb-muted)]">{labels.snapshotNote}</p>
  </article>;
}

export function BillAnalysisEntryList({ entries, locale, onViewReport, onCancel, unknown = false }: {
  entries: BillAnalysisEntryDto[];
  locale: Locale;
  onViewReport: (reportId: string) => void;
  onCancel?: () => void;
  unknown?: boolean;
}) {
  const labels = getMessages(locale).billAnalysis;
  return <ul className="divide-y divide-[var(--bb-warm-line)]">
    {entries.map((entry) => {
      const task = entry.task;
      const running = task?.status === "processing" || task?.status === "stopping";
      const status = unknown && running ? labels.phase.unknown : task?.status === "processing" ? labels.phase[task.phase ?? "processing"]
        : task?.status === "stopping" ? labels.phase.stopping : task?.status === "error" ? labels.taskStatus[task.error === "CANCELLED" ? "cancelled" : task.error === "INTERRUPTED" ? "interrupted" : "error"] : labels.taskStatus.success;
      return <li className="space-y-1 py-3" key={entry.id} data-testid="bill-analysis-entry">
        <p className="break-words text-sm font-medium">{entry.scope.period} · {entry.scopeLabels.ledger} · {entry.scopeLabels.member}</p>
        <p className="text-xs leading-5 text-[var(--bb-muted)]">{(entry.purpose ?? entry.report?.purpose) === "reconciliation" ? labels.title : getMessages(locale).billReconciliation.legacy}</p>
        <p className="text-xs leading-5">{labels.latestAttempt} · {status}</p>
        {task && task.totalBatches > 0 ? <p className="text-xs tabular-nums text-[var(--bb-muted)]">{labels.progress(task.completedBatches, task.totalBatches)}</p> : null}
        {task?.error ? <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.errors[task.error]}</p> : null}
        <p className="text-xs tabular-nums text-[var(--bb-muted)]">{labels.updated} {displayDate(task?.updatedAt ?? entry.updatedAt, locale, true)}</p>
        {entry.report ? <p className="text-xs tabular-nums text-[var(--bb-muted)]">{labels.generated} {displayDate(entry.report.generatedAt, locale, true)}</p> : null}
        <div className="flex flex-wrap items-center gap-x-4">
          {entry.report ? <button className="min-h-11 text-xs underline underline-offset-4" type="button" onClick={() => onViewReport(entry.report!.id)}>{task && task.status !== "success" ? labels.viewSavedReport : labels.viewReport}</button> : null}
          {running && task.canCancel && task.requestId && onCancel && !unknown ? <button className="min-h-11 text-xs underline underline-offset-4 disabled:opacity-50" disabled={task.status === "stopping"} type="button" onClick={onCancel}>{labels.cancel}</button> : null}
        </div>
      </li>;
    })}
  </ul>;
}

export function BillAnalysisPanel({ scope, locale, memberLabel, standalone = false }: { scope: BillAnalysisScope | null; locale: Locale; memberLabel?: string; standalone?: boolean }) {
  const state = useBillAnalysis();
  const { controller } = state;
  const selection = useOptionalLedgerSelection();
  const processing = useProcessingChoice();
  const labels = getMessages(locale).billAnalysis;
  const scopeKey = scope ? billAnalysisScopeKey(scope) : "none";
  const viewedId = state.focusedReport?.ownerScopeKey === scopeKey ? state.focusedReport.reportId : null;
  const [retry, setRetry] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reportState, setReportState] = useState<{ owner: BillAnalysisController | null; key: string; report: AnyBillReportDto | null; error: BillAnalysisErrorCode | null; loaded: boolean }>({ owner: null, key: "", report: null, error: null, loaded: false });
  const target = useMemo(() => viewedId ? { reportId: viewedId } : scope ? { scope: { ...scope } } : null,
    // Scope contents, rather than a changing object reference, own this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewedId, scopeKey]);
  const targetKey = viewedId ? `report:${viewedId}` : scopeKey;
  const saved = state.entries.find((entry) => viewedId ? entry.report?.id === viewedId : entry.purpose === "reconciliation" && billAnalysisScopeKey(entry.scope) === scopeKey)?.report;
  const completion = `${state.outcome?.status === "success" ? `${state.outcome.requestId}:${state.outcome.generation}` : ""}:${saved?.generation ?? ""}`;

  useEffect(() => {
    if (!controller || !state.ready || !target) return;
    let active = true;
    const abort = new AbortController();
    void controller.loadReport(target, abort.signal).then((report) => {
      if (active) setReportState({ owner: controller, key: targetKey, report, error: null, loaded: true });
    }).catch((error: unknown) => {
      if (active && !abort.signal.aborted) setReportState((value) => ({ owner: controller, key: targetKey,
        report: value.owner === controller && value.key === targetKey ? value.report : null, error: errorCode(error), loaded: true }));
    });
    return () => { active = false; abort.abort(); };
  }, [controller, state.ready, state.entries, target, targetKey, retry, completion, locale]);

  useEffect(() => {
    if (!controller || !state.ready || !historyOpen) return;
    void controller.discover();
  }, [controller, state.ready, historyOpen, locale]);

  const currentReport = state.ready && reportState.owner === controller && reportState.key === targetKey ? reportState.report : null;
  const currentError = state.ready && reportState.owner === controller && reportState.key === targetKey ? reportState.error : null;
  const reportLoaded = state.ready && reportState.owner === controller && reportState.key === targetKey && reportState.loaded;
  const ledger = scope?.ledgerId ? selection?.ledgers.find((item) => item.id === scope.ledgerId) : null;
  const scopeLabels = { ledger: ledger ? getLedgerDisplayName(ledger.name, locale) : labels.allLedgers,
    member: memberLabel ?? (scope?.actorMemberId ? labels.selectedMember : labels.allMembers) };
  const currentScopeLabel = scope ? `${scope.period} · ${scopeLabels.ledger} · ${scopeLabels.member}` : "";
  const pendingElsewhere = state.pending && (!state.pending.scope || scopeKey !== billAnalysisScopeKey(state.pending.scope));
  const resultError = state.outcome?.status === "error" ? state.outcome.error : null;

  return <section className={`${styles.workflow} ios-panel min-w-0 space-y-4 p-4 sm:p-5`} data-testid="bill-analysis-panel">
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">{!standalone ? <h2 className="text-lg font-semibold">{labels.title}</h2> : null}<p className="mt-1 text-xs leading-5 text-[var(--bb-muted)]">{labels.description}</p></div>
      <button className="min-h-11 text-xs underline underline-offset-4 disabled:opacity-50" disabled={!state.ready} onClick={() => setHistoryOpen((open) => !open)} type="button" aria-expanded={historyOpen}>{labels.history}</button>
    </header>
    {scope ? <div className="space-y-3">
      <p className="break-words text-sm font-medium" data-testid="bill-analysis-scope">{currentScopeLabel}</p>
      <div className="space-y-1 text-xs leading-5 text-[var(--bb-muted)]"><p>{labels.disclosure}</p><p>{labels.comparison}</p><p>{labels.latestOnly}</p></div>
      <button className={`${styles.primaryButton} w-full bg-[var(--bb-primary)] px-4 text-white transition hover:bg-[var(--bb-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto`} data-testid="bill-analysis-generate" disabled={!controller || !state.ready || !state.entriesReady || state.pending !== null}
        onClick={() => { if (processing.ensure("ai")) controller?.start(scope, locale, scopeLabels); }} type="button">{currentReport && billAnalysisScopeKey(currentReport.scope) === scopeKey ? labels.regenerate : labels.generate}</button>
      <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.background}</p>
    </div> : <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.monthlyOrYearly}</p>}
    {state.pending ? <div className="space-y-2 rounded-xl bg-[var(--bb-warm-surface)] p-3" aria-live="polite" data-testid="bill-analysis-pending">
      <p className="text-sm font-medium">{labels.phase[state.phase ?? "processing"]}</p>
      {pendingElsewhere ? <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.activeElsewhere}{state.pending.scope ? <> {state.pending.scope.period}{state.pending.scopeLabels ? ` · ${state.pending.scopeLabels.ledger} · ${state.pending.scopeLabels.member}` : ""}</> : null}</p> : null}
      {state.totalBatches > 0 ? <p className="text-xs tabular-nums text-[var(--bb-muted)]">{labels.progress(state.completedBatches, state.totalBatches)}</p> : null}
      {state.phase === "unknown" ? <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.unknown}</p> : null}
      {!state.pending.requestId ? <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.readOnlyTask}</p> : null}
      <div className="flex flex-wrap gap-x-4">{state.pending.canCancel && state.pending.requestId ? <button className="min-h-11 text-xs underline disabled:opacity-50" disabled={state.phase === "stopping"} onClick={() => { void controller?.cancel(); }} type="button">{labels.cancel}</button> : null}
        <button className="min-h-11 text-xs underline" onClick={() => { void controller?.observe(); }} type="button">{labels.confirm}</button></div>
    </div> : null}
    {resultError ? <p className="text-sm leading-6 text-[var(--bb-danger)]" role="alert" data-testid="bill-analysis-error">{labels.errors[resultError]}</p> : null}
    {historyOpen ? <section className="space-y-2 border-t border-[var(--bb-warm-line)] pt-3" data-testid="bill-analysis-history">
      <div className="flex flex-wrap items-center justify-between gap-x-4"><h3 className="text-sm font-semibold">{labels.history}</h3><button className="min-h-11 text-xs underline disabled:opacity-50" disabled={state.entriesLoading} onClick={() => { void controller?.observe(); }} type="button">{labels.refresh}</button></div>
      {!state.entriesReady ? <p className="text-xs text-[var(--bb-muted)]">{labels.loading}</p> : state.entries.length ? <BillAnalysisEntryList entries={state.entries} locale={locale}
        onViewReport={(reportId) => controller?.focusReport(reportId, scope)} onCancel={state.pending?.canCancel && state.pending.requestId ? () => { void controller?.cancel(); } : undefined} unknown={Boolean(state.entriesError)} />
        : state.entriesError ? null : <p className="text-xs text-[var(--bb-muted)]">{labels.historyEmpty}</p>}
      {state.entriesError ? <div className="space-y-1 text-xs" role="alert"><p className="text-[var(--bb-muted)]">{labels.statusUnavailable}</p><button className="min-h-11 underline" type="button" onClick={() => { void controller?.observe(); }}>{labels.retry}</button></div> : null}
      {state.entriesCursor ? <button className="min-h-11 text-xs underline disabled:opacity-50" disabled={state.entriesLoading} onClick={() => { void controller?.loadMoreEntries(); }} type="button">{labels.more}</button> : null}
    </section> : null}
    {target ? <div className="border-t border-[var(--bb-warm-line)] pt-4">
      {currentReport ? currentReport.purpose === "reconciliation" ? <BillReconciliationReportView key={`${currentReport.id}:${currentReport.generation}`} report={currentReport} locale={locale} onRescan={() => { if (!state.pending && processing.ensure("ai")) controller?.start(currentReport.scope, locale, currentReport.scopeLabels); }} /> : <BillAnalysisReportView report={currentReport} locale={locale} /> : currentError ? <div className="space-y-1 text-sm" role="alert"><p className="text-[var(--bb-danger)]">{labels.errors[currentError]}</p><button className="min-h-11 text-xs underline" onClick={() => setRetry((value) => value + 1)} type="button">{labels.retry}</button></div> : <p className="text-sm text-[var(--bb-muted)]">{reportLoaded ? labels.noReport : labels.loading}</p>}
      {viewedId && scope ? <button className="mt-3 inline-flex min-h-11 items-center text-xs underline" type="button" onClick={() => controller?.focusReport(null, scope)}>{currentScopeLabel}</button> : null}
    </div> : null}
  </section>;
}
