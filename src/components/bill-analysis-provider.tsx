"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptionalEncryption } from "@/components/encryption-provider";
import { useOptionalLedgerSelection } from "@/components/ledger-provider";
import { getEncryptionInput } from "@/lib/encryption/client";
import { getLedgerDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type { LedgerIdentity } from "@/lib/ledgers/selection";
import { BillAnalysisController, type BillAnalysisClientSnapshot } from "@/lib/reports/bill-analysis-controller";
import type { BillAnalysisScope } from "@/lib/reports/bill-analysis-types";
import { emptyReconciliationApplication, ReconciliationApplicationController } from "@/lib/reports/bill-reconciliation-controller";

const Context = createContext<BillAnalysisController | null>(null);
const ApplicationContext = createContext<ReconciliationApplicationController | null>(null);
const FeedbackSlotContext = createContext<((container: HTMLDivElement | null) => void) | null>(null);
const empty: BillAnalysisClientSnapshot = {
  ready: false, storageAvailable: true, pending: null, phase: null,
  completedBatches: 0, totalBatches: 0, outcome: null, completedScope: null, completedLabels: null, focusedReport: null,
  entries: [], entriesCursor: null, entriesReady: false, entriesLoading: false, entriesError: null, activeEntry: null,
};
const noSubscribe = () => () => {};
const emptySnapshot = () => empty;
const emptyApplicationSnapshot = () => emptyReconciliationApplication;

function serializeReportRequest(body: Record<string, unknown>) {
  return JSON.stringify({ ...body, encryption: getEncryptionInput() });
}

function reportRequestByteLength(body: Record<string, unknown>) {
  return new TextEncoder().encode(serializeReportRequest(body)).byteLength;
}

function reportRequest(body: Record<string, unknown>, signal?: AbortSignal) {
  return fetch("/api/reports/reconcile", {
    method: "POST", cache: "no-store", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" },
    body: serializeReportRequest(body),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
  });
}

export function billAnalysisScopeHref(scope: BillAnalysisScope): string {
  const params = new URLSearchParams({ mode: scope.mode, [scope.mode]: scope.period, ledger: scope.ledgerId ?? "all" });
  if (scope.actorMemberId) params.set("member", scope.actorMemberId);
  return `/records/reconcile?${params}`;
}

export function warnBeforeLosingReconciliationDrafts(application: ReconciliationApplicationController, event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">) {
  if (!application.hasUnsavedDrafts()) return;
  event.preventDefault();
  event.returnValue = "";
}

export function BillAnalysisProvider({ children, identity, locale }: { children: ReactNode; identity: LedgerIdentity; locale: Locale }) {
  const [feedbackContainer, setFeedbackContainer] = useState<HTMLDivElement | null>(null);
  const encryption = useOptionalEncryption();
  const identityKey = `${encryption?.identity.accountId ?? ""}:${identity.householdId}:${identity.memberId}`;
  const ready = !encryption || (encryption.ready && (encryption.status.mode === "UNENCRYPTED" || Boolean(encryption.code)));
  const revision = encryption?.status.revision;
  const controller = useMemo(() => new BillAnalysisController({
    identity: identityKey,
    uuid: () => window.crypto.randomUUID(),
    storage: () => window.sessionStorage,
    request: reportRequest,
  }), [identityKey]);
  const application = useMemo(() => new ReconciliationApplicationController({ identity: identityKey,
    uuid: () => window.crypto.randomUUID(), storage: () => window.localStorage, request: reportRequest, requestByteLength: reportRequestByteLength }), [identityKey]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => warnBeforeLosingReconciliationDrafts(application, event);
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [application]);

  useEffect(() => {
    controller.setLocale(locale);
    if (ready && controller.getSnapshot().ready) void controller.discover();
  }, [controller, locale, ready]);

  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let observing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && !observing && document.visibilityState === "visible" && controller.getSnapshot().pending) timer = setTimeout(refresh, 3000);
    };
    const refresh = async () => {
      if (stopped || observing || document.visibilityState !== "visible") return;
      observing = true;
      await controller.observe();
      observing = false;
      schedule();
    };
    const interrupt = () => { clearTimeout(timer); controller.interrupt(); };
    const focus = () => { void refresh(); };
    const visibility = () => { if (document.visibilityState === "hidden") interrupt(); else focus(); };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) focus(); };
    const unsubscribe = controller.subscribe(schedule);
    observing = true;
    void controller.initialize().then(() => { observing = false; schedule(); });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", interrupt);
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", pageshow);
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", interrupt);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", pageshow);
      controller.dispose(true);
    };
  }, [controller, ready, revision]);

  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && application.getSnapshot().pending && document.visibilityState === "visible") timer = setTimeout(refresh, 3000);
    };
    const refresh = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      await application.confirm();
      schedule();
    };
    const interrupt = () => { clearTimeout(timer); application.interrupt(); };
    const visible = () => { if (document.visibilityState === "hidden") interrupt(); else void refresh(); };
    const focus = () => { void refresh(); };
    const unsubscribe = application.subscribe(schedule);
    void application.initialize().then(schedule);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", interrupt);
    window.addEventListener("focus", focus);
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", interrupt);
      window.removeEventListener("focus", focus);
      application.dispose(true);
    };
  }, [application, ready, revision]);

  return <Context.Provider value={controller}><ApplicationContext.Provider value={application}><FeedbackSlotContext.Provider value={setFeedbackContainer}>{children}<BillAnalysisFeedback controller={controller} locale={locale} container={feedbackContainer} /><ReconciliationApplicationFeedback controller={application} scanController={controller} locale={locale} container={feedbackContainer} /></FeedbackSlotContext.Provider></ApplicationContext.Provider></Context.Provider>;
}

export function BillAnalysisFeedbackSlot() {
  const register = useContext(FeedbackSlotContext);
  return <div className="space-y-3 empty:hidden" ref={register} />;
}

export function useBillAnalysis() {
  const controller = useContext(Context);
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? emptySnapshot, controller?.getServerSnapshot ?? emptySnapshot);
  return { controller, ...state };
}

export function useBillReconciliationApplication() {
  const controller = useContext(ApplicationContext);
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? emptyApplicationSnapshot, controller?.getServerSnapshot ?? emptyApplicationSnapshot);
  return { controller, ...state };
}

function ReconciliationApplicationFeedback({ controller, scanController, locale, container }: { controller: ReconciliationApplicationController; scanController: BillAnalysisController; locale: Locale; container: HTMLDivElement | null }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  return state.ready ? <ReadyApplicationFeedback controller={controller} scanController={scanController} locale={locale} container={container} /> : null;
}

function ReadyApplicationFeedback({ controller, scanController, locale, container }: { controller: ReconciliationApplicationController; scanController: BillAnalysisController; locale: Locale; container: HTMLDivElement | null }) {
  const router = useRouter();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const refreshed = useRef<string | null>(null);
  const labels = getMessages(locale).billReconciliation;
  useEffect(() => {
    if (state.outcome?.status === "success" && refreshed.current !== state.outcome.requestId) {
      refreshed.current = state.outcome.requestId;
      router.refresh();
      void scanController.discover();
    }
  }, [router, scanController, state.outcome]);
  useEffect(() => {
    if (state.accessError === "UNAUTHORIZED") window.location.replace("/login?reason=session-expired");
  }, [state.accessError]);
  if (!state.pending && !state.noticeVisible) return null;
  const feedback = <aside className={`${container ? "" : "fixed inset-x-4 bottom-[calc(var(--bb-mobile-nav-height)+0.75rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-xl shadow-sm md:bottom-5 "}rounded-2xl border border-[var(--bb-warm-line)] bg-[var(--bb-surface)] px-4 py-3 text-sm`} data-testid="bill-reconciliation-feedback" aria-live="polite">
    <p className="font-medium">{state.pending ? state.phase === "submitting" ? labels.applying : state.phase === "querying" ? labels.querying : labels.unknown : state.outcome?.status === "success" ? labels.completed : labels.rejected}</p>
    {state.accessError ? <p className="mt-1 text-xs leading-5">{labels.errors[state.accessError]}</p> : null}
    {state.outcome?.error ? <p className="mt-1 text-xs leading-5">{labels.errors[state.outcome.error]}</p> : null}
    {state.pending ? <button className="min-h-11 text-xs underline underline-offset-4 disabled:opacity-50" disabled={state.phase === "submitting" || state.phase === "querying"} onClick={() => { void controller.confirm(); }} type="button">{labels.query}</button>
      : state.outcome?.status === "success" ? <button className="min-h-11 text-xs underline underline-offset-4" onClick={controller.dismiss} type="button">{labels.dismissed}</button> : null}
  </aside>;
  return container ? createPortal(feedback, container) : feedback;
}

function BillAnalysisFeedback({ controller, locale, container }: { controller: BillAnalysisController; locale: Locale; container: HTMLDivElement | null }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const selection = useOptionalLedgerSelection();
  const labels = getMessages(locale).billAnalysis;
  const application = useBillReconciliationApplication();
  const [resolvedScope, setResolvedScope] = useState<{ requestId: string; scope: BillAnalysisScope; labels: { ledger: string; member: string } } | null>(null);
  const queryAgain = state.phase === "unknown" || state.phase === "processing" || state.phase === "stopping";

  useEffect(() => {
    if (state.outcome?.error === "UNAUTHORIZED" || state.entriesError === "UNAUTHORIZED") window.location.replace("/login?reason=session-expired");
  }, [state.outcome, state.entriesError]);

  useEffect(() => {
    const result = state.outcome;
    if (state.completedScope || result?.status !== "success" || !result.reportId) return;
    let active = true;
    const abort = new AbortController();
    void controller.loadReport({ reportId: result.reportId }, abort.signal).then((report) => {
      if (active && report) setResolvedScope({ requestId: result.requestId, scope: report.scope, labels: report.scopeLabels });
    }).catch(() => { /* Shared history remains available if the original report was replaced. */ });
    return () => { active = false; abort.abort(); };
  }, [controller, state.outcome, state.completedScope]);

  const recovered = resolvedScope && resolvedScope.requestId === state.outcome?.requestId ? resolvedScope : null;
  const scope = state.pending?.scope ?? state.completedScope ?? recovered?.scope ?? null;
  const scopeLabels = state.pending?.scopeLabels ?? state.completedLabels ?? recovered?.labels ?? null;
  const ledger = scope?.ledgerId ? selection?.ledgers.find((item) => item.id === scope.ledgerId) : null;
  const rangeLabel = scope ? `${scope.period} · ${scopeLabels?.ledger ?? (ledger ? getLedgerDisplayName(ledger.name, locale) : labels.allLedgers)} · ${scopeLabels?.member ?? (scope.actorMemberId ? labels.selectedMember : labels.allMembers)}` : labels.originalTask;
  if (application.pending || application.noticeVisible || !state.pending && state.outcome?.status !== "success") return null;
  const feedback = <aside className={`${container ? "" : "fixed inset-x-4 bottom-[calc(var(--bb-mobile-nav-height)+0.75rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-xl shadow-sm md:bottom-5 "}rounded-2xl border border-[var(--bb-warm-line)] bg-[var(--bb-surface)] px-4 py-3 text-sm`} data-testid="bill-analysis-feedback" aria-live="polite">
    <p className="break-words text-xs text-[var(--bb-muted)]">{rangeLabel}</p>
    <p className="mt-1 font-medium">{state.pending ? labels.phase[state.phase ?? "processing"] : state.outcome?.superseded ? labels.superseded : labels.success}</p>
    {state.pending && state.totalBatches > 0 ? <p className="mt-1 text-xs tabular-nums text-[var(--bb-muted)]">{labels.progress(state.completedBatches, state.totalBatches)}</p> : null}
    <div className="mt-1 flex flex-wrap items-center gap-x-4">
      {state.pending ? <>
        {state.pending.canCancel && state.pending.requestId ? <button className="min-h-11 text-xs underline underline-offset-4 disabled:opacity-50" disabled={state.phase === "stopping"} onClick={() => { void controller.cancel(); }} type="button">{labels.cancel}</button> : null}
        {queryAgain ? <button className="min-h-11 text-xs underline underline-offset-4" onClick={() => { void controller.observe(); }} type="button">{labels.confirm}</button> : null}
      </> : <>
        <Link className="inline-flex min-h-11 items-center text-xs underline underline-offset-4" href={scope ? billAnalysisScopeHref(scope) : "/records/reconcile"} onClick={() => { if (scope && state.outcome?.reportId) controller.focusReport(state.outcome.reportId, scope); }}>{labels.viewReport}</Link>
        <button className="min-h-11 text-xs text-[var(--bb-muted)]" onClick={controller.dismiss} type="button">{labels.close}</button>
      </>}
    </div>
  </aside>;
  return container ? createPortal(feedback, container) : feedback;
}
