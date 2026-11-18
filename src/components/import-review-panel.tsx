"use client";

import { invokeEncryptedAction } from "@/lib/encryption/client";

import { ImportDraftRowStatus, ImportRowDecision } from "@prisma/client";
import { ArrowRight, Check, ChevronDown, CircleAlert, CircleCheck, CircleMinus, Copy, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { confirmImportReviewDraft, getImportCandidateDetail, saveImportReviewDecisions } from "@/app/(app)/records/import/actions";
import { BottomSheet } from "@/components/bottom-sheet";
import { IosSelect } from "@/components/ios-select";
import styles from "./finance-b2.module.css";
import { confirmImportMappingNavigation, registerImportReviewHistoryGuard } from "@/components/import-review-history-guard";
import { getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type { ImportDraftRowSummary } from "@/lib/imports/drafts";
import { buildImportReviewHref, canDecideImportRow, importReviewStatuses, isLockedImportRefund, type ImportReviewStatus } from "@/lib/imports/review";
import { ALIPAY_FULLY_REFUNDED, ALIPAY_SOURCE, CMB_FULLY_REFUNDED, CMB_SOURCE, SUI_SHOU_JI_SOURCE, WECHAT_FULLY_REFUNDED, WECHAT_PAY_SOURCE } from "@/lib/imports/types";
import { formatFen } from "@/lib/money";

type ReviewRow = Omit<ImportDraftRowSummary, "occurredAt"> & { occurredAt: string | null };
type OriginalRecord = Extract<Awaited<ReturnType<typeof getImportCandidateDetail>>, { success: true }> ["record"];
type Props = {
  draftId: string;
  locale: Locale;
  source: string;
  rows: ReviewRow[];
  members: Array<{ id: string; memberName: string }>;
  status: ImportReviewStatus;
  page: number;
  pageCount: number;
  total: number;
  needsMapping: boolean;
  needsMemberMapping: boolean;
};

export function ImportReviewPanel({ draftId, locale, source, rows, members, status, page, pageCount, total, needsMapping, needsMemberMapping }: Props) {
  const router = useRouter();
  const messages = getMessages(locale);
  const labels = messages.import;
  const formRef = useRef<HTMLFormElement>(null);
  const dirtyRef = useRef<Record<string, ImportRowDecision>>({});
  const busyRef = useRef(false);
  const [choices, setChoices] = useState<Record<string, ImportRowDecision>>({});
  const [hasUnsavedChoices, setHasUnsavedChoices] = useState(false);
  const [saving, setBusy] = useState(false);
  const [navigationPending, startNavigation] = useTransition();
  const busy = saving || navigationPending;
  const [feedback, setFeedback] = useState<"saved" | "failed" | "confirmFailed" | "confirmBusy" | null>(null);
  const [original, setOriginal] = useState<{ loading: boolean; record: OriginalRecord | null } | null>(null);
  const [originalOpen, setOriginalOpen] = useState(false);
  const originalRequest = useRef(0);
  const originalTriggerRef = useRef<HTMLButtonElement>(null);
  const memberNames = new Map(members.map((member) => [member.id, member.memberName]));

  const saveChanges = useCallback(async () => {
    const decisions = Object.entries(dirtyRef.current).map(([rowId, decision]) => ({ rowId, decision }));
    if (decisions.length === 0) return true;
    try {
      const result = await invokeEncryptedAction(saveImportReviewDecisions, draftId, decisions);
      if (!result.success) throw new Error("Import decisions could not be saved");
      dirtyRef.current = {};
      setHasUnsavedChoices(false);
      setFeedback("saved");
      return true;
    } catch {
      setFeedback("failed");
      return false;
    }
  }, [draftId]);

  const runAfterSave = useCallback(async (next: () => void | Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      if (await saveChanges()) await next();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [saveChanges]);

  useEffect(() => {
    const currentHref = window.location.href;
    const reviewIndexKey = "__billboardImportReviewIndex";
    const reviewHistoryIndex = () => {
      const index: unknown = window.history.state?.[reviewIndexKey];
      return typeof index === "number" && Number.isSafeInteger(index) ? index : undefined;
    };
    const nativeHistoryIndex = () => (window as Window & {
      navigation?: { currentEntry?: { index: number } };
    }).navigation?.currentEntry?.index;
    const historyIndex = () => nativeHistoryIndex() ?? reviewHistoryIndex();
    let restoreHistoryMethods: (() => void) | undefined;
    let active = true;
    if (nativeHistoryIndex() === undefined) {
      History.prototype.replaceState.call(window.history, { ...window.history.state, [reviewIndexKey]: reviewHistoryIndex() ?? 0 }, "");
      // Wait until the app router has installed its history methods.
      queueMicrotask(() => {
        if (!active) return;
        const originalPushState = window.history.pushState;
        const originalReplaceState = window.history.replaceState;
        const pushState: History["pushState"] = (data, unused, url) => {
          const index = (reviewHistoryIndex() ?? 0) + 1;
          originalPushState.call(window.history, { ...data, [reviewIndexKey]: index }, unused, url);
        };
        const replaceState: History["replaceState"] = (data, unused, url) => {
          originalReplaceState.call(window.history, { ...data, [reviewIndexKey]: reviewHistoryIndex() ?? 0 }, unused, url);
        };
        window.history.pushState = pushState;
        window.history.replaceState = replaceState;
        restoreHistoryMethods = () => {
          if (window.history.pushState === pushState) window.history.pushState = originalPushState;
          if (window.history.replaceState === replaceState) window.history.replaceState = originalReplaceState;
        };
      });
    }
    const currentHistoryIndex = historyIndex();
    let resumeAfterRestore: ((distance: number) => void) | null = null;
    let restoreDistance = 0;
    let restoringUntrackedEntry = false;
    const saveBeforeHistoryNavigation = (event: PopStateEvent) => {
      if (resumeAfterRestore) {
        event.stopImmediatePropagation();
        if (window.location.href === currentHref && historyIndex() === currentHistoryIndex) {
          const resume = resumeAfterRestore;
          resumeAfterRestore = null;
          resume(restoreDistance);
        } else if (restoringUntrackedEntry) {
          restoreDistance += 1;
          window.history.forward();
        }
        return;
      }
      if (Object.keys(dirtyRef.current).length === 0) {
        // History can restore a cached page from before these choices were saved.
        setTimeout(() => startNavigation(() => router.refresh()), 0);
        return;
      }
      event.stopImmediatePropagation();
      const targetIndex = historyIndex();
      if (currentHistoryIndex !== undefined) {
        // Entries from before this review session are reached by going back.
        const delta = targetIndex === undefined ? 1 : currentHistoryIndex - targetIndex;
        if (delta === 0) return;
        restoreDistance = delta;
        restoringUntrackedEntry = targetIndex === undefined;
        resumeAfterRestore = (distance) => void runAfterSave(() => window.history.go(-distance));
        window.history.go(delta);
      }
    };
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.keys(dirtyRef.current).length > 0) event.preventDefault();
    };
    const saveBeforeOtherSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || form === formRef.current || !form.closest("[data-import-draft]") || Object.keys(dirtyRef.current).length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const submitter = event.submitter;
      void runAfterSave(() => form.requestSubmit(submitter ?? undefined));
    };
    const saveBeforeLeaving = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || Object.keys(dirtyRef.current).length === 0) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      const target = new URL(anchor.href);
      if (target.origin !== window.location.origin) return;
      const staysOnPage = target.pathname === window.location.pathname && target.search === window.location.search;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (staysOnPage && !confirmImportMappingNavigation()) return;
      void runAfterSave(() => startNavigation(() => {
        router.push(`${target.pathname}${target.search}${target.hash}`);
        if (staysOnPage) {
          router.refresh();
        }
      }));
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("submit", saveBeforeOtherSubmit, true);
    document.addEventListener("click", saveBeforeLeaving, true);
    const removeHistoryGuard = registerImportReviewHistoryGuard(saveBeforeHistoryNavigation);
    return () => {
      active = false;
      restoreHistoryMethods?.();
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("submit", saveBeforeOtherSubmit, true);
      document.removeEventListener("click", saveBeforeLeaving, true);
      removeHistoryGuard();
    };
  }, [router, runAfterSave]);

  function closeOriginal() {
    originalRequest.current += 1;
    setOriginalOpen(false);
  }

  async function showOriginal(rowId: string, candidateId: string, trigger: HTMLButtonElement) {
    const request = ++originalRequest.current;
    originalTriggerRef.current = trigger;
    setOriginal({ loading: true, record: null });
    setOriginalOpen(true);
    try {
      const result = await invokeEncryptedAction(getImportCandidateDetail, draftId, rowId, candidateId);
      if (request === originalRequest.current) setOriginal({ loading: false, record: result.success ? result.record : null });
    } catch {
      if (request === originalRequest.current) setOriginal({ loading: false, record: null });
    }
  }

  function statusLabel(value: ImportDraftRowStatus) {
    if (value === ImportDraftRowStatus.NEEDS_MAPPING) return labels.rowStatus.needsMapping;
    if (value === ImportDraftRowStatus.POSSIBLE_DUPLICATE) return labels.rowStatus.possibleDuplicate;
    if (value === ImportDraftRowStatus.USER_SKIPPED) return labels.rowStatus.userSkipped;
    if (value === ImportDraftRowStatus.SOURCE_DUPLICATE) return labels.sourceDuplicateRows;
    if (value === ImportDraftRowStatus.INVALID) return labels.invalidRows;
    return labels.rowStatus.ready;
  }

  function sourceLabel(value: string | null) {
    if (value === SUI_SHOU_JI_SOURCE) return labels.sources.suiShouJi;
    if (value === WECHAT_PAY_SOURCE) return labels.sources.wechatPay;
    if (value === ALIPAY_SOURCE) return labels.sources.alipay;
    if (value === CMB_SOURCE) return labels.sources.cmb;
    return value || labels.manualSource;
  }

  function rowReason(row: ReviewRow) {
    if (isLockedImportRefund(row)) {
      if (row.skipReason === ALIPAY_FULLY_REFUNDED || row.skipReason === WECHAT_FULLY_REFUNDED || row.skipReason === CMB_FULLY_REFUNDED) return labels.refundReasons.fullyRefunded;
      return row.skipReason && row.skipReason in labels.skipReasons
        ? labels.skipReasons[row.skipReason as keyof typeof labels.skipReasons]
        : labels.refundReasons.manualAdjustment;
    }
    if (row.status === ImportDraftRowStatus.SOURCE_DUPLICATE) return labels.sourceDuplicateReason;
    return row.skipReason && row.skipReason in labels.skipReasons
      ? labels.skipReasons[row.skipReason as keyof typeof labels.skipReasons]
      : row.skipReason;
  }

  function navigate(nextStatus: ImportReviewStatus, nextPage: number) {
    if (!confirmImportMappingNavigation()) return;
    void runAfterSave(() => startNavigation(() => router.push(buildImportReviewHref(draftId, nextStatus, nextPage))));
  }

  function reviewDate(value: string) {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(value));
  }

  const paging = (
    <nav aria-label={labels.reviewTitle} className="flex flex-wrap items-center justify-between gap-3">
      <button className="min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-4 py-2 text-sm disabled:opacity-40" disabled={busy || page <= 1} onClick={() => navigate(status, page - 1)} type="button">{labels.previousPage}</button>
      <p className="text-xs text-stone-500">{labels.reviewPage(page, pageCount, total)}</p>
      <button className="min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-4 py-2 text-sm disabled:opacity-40" disabled={busy || page >= pageCount} onClick={() => navigate(status, page + 1)} type="button">{labels.nextPage}</button>
    </nav>
  );

  return (
    <>
      <form ref={formRef} className={`${styles.workflow} ios-panel scroll-mt-4 space-y-4 p-4 sm:p-5`} data-apk-update-blocked={busy || undefined} data-desktop-update-dirty={hasUnsavedChoices || undefined} data-testid="import-review-form" id="import-review" onSubmit={(event) => {
        event.preventDefault();
        void runAfterSave(() => startNavigation(() => router.refresh()));
      }}>
        <input name="draftId" type="hidden" value={draftId} />
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{labels.reviewTitle}</h2>
          <p className="text-sm text-stone-500">{labels.reviewDescription}</p>
          {source === CMB_SOURCE ? <>
            <p className="text-sm text-amber-700">{labels.cmbDefaultSkipDescription}</p>
            <p className="text-sm text-stone-500">{labels.cmbRefundDescription}</p>
          </> : null}
        </div>
        <label className="block space-y-2 text-sm font-medium text-stone-700">
          <span>{labels.statusFilter}</span>
          <IosSelect disabled={busy} onChange={(event) => navigate(event.target.value as ImportReviewStatus, 1)} value={status}
            options={[{ value: "all", label: labels.allStatuses }, ...importReviewStatuses.map((value) => ({ value, label: statusLabel(value) }))]} />
        </label>
        {paging}
        {rows.length === 0 ? <p className="rounded-2xl bg-stone-50 p-4 text-sm text-stone-500">{labels.emptyReview}</p> : null}
        <fieldset className="min-w-0 space-y-3" disabled={busy}>
          {rows.map((row) => {
            const editable = canDecideImportRow(row);
            const decision = choices[row.id] ?? row.userDecision;
            const reason = rowReason(row);
            const StatusIcon = row.status === ImportDraftRowStatus.NEEDS_MAPPING || row.status === ImportDraftRowStatus.INVALID
              ? CircleAlert
              : row.status === ImportDraftRowStatus.POSSIBLE_DUPLICATE || row.status === ImportDraftRowStatus.SOURCE_DUPLICATE
                ? Copy
                : row.status === ImportDraftRowStatus.USER_SKIPPED
                  ? CircleMinus
                  : CircleCheck;
            const statusTone = row.status === ImportDraftRowStatus.NEEDS_MAPPING || row.status === ImportDraftRowStatus.POSSIBLE_DUPLICATE
              ? "bg-amber-50 text-amber-900"
              : row.status === ImportDraftRowStatus.INVALID
                ? "bg-red-50 text-red-700"
                : row.status === ImportDraftRowStatus.READY
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-stone-100 text-stone-600";
            const candidate = (item: ReviewRow["duplicateCandidates"][number]) => (
              <div className="space-y-1 rounded-xl bg-white p-3 text-xs text-stone-600" key={item.id}>
                <p className="font-medium text-stone-800">{labels.duplicateCandidate}</p>
                <p>{reviewDate(item.occurredAt)} · {formatFen(item.amountFen)} · {item.type === "INCOME" ? messages.common.income : messages.common.expense} · {sourceLabel(item.source)}</p>
                <button className="min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-3 py-2 font-medium text-[var(--bb-ink)]" onClick={(event) => void showOriginal(row.id, item.id, event.currentTarget)} type="button">{labels.viewOriginalRecord}</button>
              </div>
            );
            return (
              <div className={`${styles.reviewCard} min-w-0 space-y-3 border p-3 sm:p-4`} data-row-id={row.id} data-testid="import-review-row" key={row.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 break-words text-sm font-semibold leading-relaxed text-[var(--bb-ink)]">{row.note || row.secondaryCategory || row.primaryCategory || messages.common.noNote}</p>
                    <p className="mt-1 break-words text-xs leading-relaxed text-[var(--bb-muted)]">{row.occurredAt ? reviewDate(row.occurredAt) : "-"}</p>
                  </div>
                  <div className="min-w-0 max-w-[50%] shrink-0 text-right">
                    <p className={`break-all text-base font-medium tabular-nums ${row.transactionType === "INCOME" ? "text-[var(--bb-income-ink)]" : "text-[var(--bb-ink)]"}`}>{row.amountFen === null ? "-" : formatFen(row.amountFen)}</p>
                    <p className="mt-1 text-xs text-[var(--bb-muted)]">{row.transactionType === "INCOME" ? messages.common.income : row.transactionType === "EXPENSE" ? messages.common.expense : "-"}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 font-medium ${statusTone}`}>
                    <StatusIcon aria-hidden="true" size={13} />{statusLabel(row.status)}
                  </span>
                  <span className="text-[var(--bb-muted)]">{labels.rowDetail} #{row.rowNumber}</span>
                </div>
                <div className="space-y-1 break-words text-xs leading-relaxed text-[var(--bb-muted)]">
                  {source === CMB_SOURCE && !isLockedImportRefund(row) && row.refundOriginalAmountFen != null && row.amountFen !== null && row.refundOriginalAmountFen > row.amountFen ? <p className="text-stone-800">
                    {labels.refundNetAmount(formatFen(row.refundOriginalAmountFen), formatFen(row.refundOriginalAmountFen - row.amountFen), formatFen(row.amountFen))}
                  </p> : null}
                  {reason ? <p className="text-amber-800">{reason}</p> : null}
                </div>
                {editable ? <div className="grid grid-cols-2 gap-2">
                  {[ImportRowDecision.KEEP, ImportRowDecision.SKIP].map((value) => <label className={`relative flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--bb-primary)] ${decision === value ? value === ImportRowDecision.KEEP ? "border-[var(--bb-primary)] bg-[var(--bb-accent-soft)] text-[var(--bb-accent-ink)]" : "border-stone-500 bg-stone-200 text-stone-900" : "border-[var(--bb-warm-line)] bg-white text-[var(--bb-muted)]"}`} key={value}>
                    <input checked={decision === value} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" name={`decision:${row.id}`} onChange={() => {
                      setChoices((previous) => ({ ...previous, [row.id]: value }));
                      if (value === row.userDecision) delete dirtyRef.current[row.id];
                      else dirtyRef.current[row.id] = value;
                      setHasUnsavedChoices(Object.keys(dirtyRef.current).length > 0);
                      setFeedback(null);
                    }} type="radio" value={value} />
                    {value === ImportRowDecision.KEEP ? labels.keep : labels.skip}
                    {decision === value ? <Check aria-hidden="true" size={15} /> : null}
                  </label>)}
                </div> : null}
                <details className="group border-t border-[var(--bb-warm-line)]" data-testid="import-row-details">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 py-2 text-xs font-medium text-[var(--bb-muted)]">
                    <span>{labels.reviewDetails}{row.duplicateCandidates.length > 0 ? ` · ${row.duplicateCandidates.length}` : ""}</span>
                    <ChevronDown aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" size={16} />
                  </summary>
                  <div className="space-y-2 break-words pb-1 text-xs leading-relaxed text-[var(--bb-muted)]">
                    <p>{messages.common.category}: {row.primaryCategory || "-"}{row.secondaryCategory ? ` / ${row.secondaryCategory}` : ""}</p>
                    <p>{messages.common.who}: {memberNames.get(row.actorMemberId || "") || row.actorExternalName || row.rawMember || "-"} · {messages.common.createdBy}: {memberNames.get(row.createdByMemberId || "") || row.creatorExternalName || row.rawCreatedBy || "-"}</p>
                    <p>{labels.source}: {sourceLabel(source)}</p>
                    <p className="whitespace-pre-wrap">{messages.common.note}: {row.note || messages.common.noNote}</p>
                    {row.duplicateCandidates.length > 0 ? <div className="space-y-2">
                      {row.duplicateCandidates.slice(0, 3).map(candidate)}
                      {row.duplicateCandidates.length > 3 ? <details className="space-y-2">
                        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-[var(--bb-ink)]">{labels.showMoreCandidates(row.duplicateCandidates.length - 3)}</summary>
                        {row.duplicateCandidates.slice(3).map(candidate)}
                      </details> : null}
                    </div> : null}
                  </div>
                </details>
              </div>
            );
          })}
        </fieldset>
        {paging}
        <div data-bottom-actions className="fixed inset-x-3 bottom-[calc(var(--bb-mobile-nav-height)+env(safe-area-inset-bottom)+0.5rem)] z-30 mx-auto max-w-xl space-y-2 rounded-2xl border border-[var(--bb-warm-line)] bg-white/95 p-3 shadow-[var(--bb-shadow-lg)] backdrop-blur-lg md:static md:max-w-none md:rounded-none md:border-x-0 md:border-b-0 md:bg-white md:p-0 md:pt-4 md:shadow-none" data-testid="import-review-actions">
          <p className={`flex items-start gap-2 text-xs leading-5 ${feedback === "failed" || feedback === "confirmFailed" ? "text-red-700" : feedback === "confirmBusy" || hasUnsavedChoices ? "text-amber-800" : "text-[var(--bb-muted)]"}`} role="status">
            {busy ? <LoaderCircle aria-hidden="true" className="mt-0.5 shrink-0 motion-safe:animate-spin" size={15} /> : feedback === "failed" || feedback === "confirmFailed" || feedback === "confirmBusy" || hasUnsavedChoices ? <CircleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={15} /> : <CircleCheck aria-hidden="true" className="mt-0.5 shrink-0" size={15} />}
            <span>{busy ? labels.savingDecisions : feedback === "failed" ? labels.decisionsSaveFailed : feedback === "confirmFailed" ? labels.confirmImportFailed : feedback === "confirmBusy" ? labels.confirmImportBusy : hasUnsavedChoices ? messages.ui.importUnsavedDecisions : labels.decisionsSaved}</span>
          </p>
          {needsMapping ? <a className="flex min-h-11 items-center justify-between gap-2 text-xs font-medium text-amber-800" href="#import-mappings"><span>{labels.confirmDisabled}</span><ArrowRight aria-hidden="true" className="shrink-0" size={15} /></a> : null}
          {needsMemberMapping ? <a className="flex min-h-11 items-center justify-between gap-2 text-xs font-medium text-amber-800" href="#import-members"><span>{labels.confirmDisabledByMemberMappings}</span><ArrowRight aria-hidden="true" className="shrink-0" size={15} /></a> : null}
          <div className="grid grid-cols-2 gap-2">
            <button className="min-h-12 rounded-xl border border-[var(--bb-line-strong)] bg-white px-3 py-3 text-sm font-semibold text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)] disabled:opacity-40" disabled={busy || !hasUnsavedChoices} type="submit">{labels.saveDecisions}</button>
            <button className={`${styles.primaryButton} bg-[var(--bb-primary)] px-3 text-white transition hover:bg-[var(--bb-primary-hover)] disabled:bg-stone-200 disabled:text-stone-500`} disabled={busy || needsMapping || needsMemberMapping} onClick={() => {
              if (!confirmImportMappingNavigation()) return;
              void runAfterSave(async () => {
                try {
                  const result = await invokeEncryptedAction(confirmImportReviewDraft, draftId);
                  if (!result.success) {
                    if (result.error === "BUSY") { setFeedback("confirmBusy"); return; }
                    throw new Error("Import could not be confirmed");
                  }
                  const href = `${buildImportReviewHref(draftId, "all", 1)}&${result.requiresReview ? "notice=IMPORT_DRAFT_CHANGED" : "completed=1"}`;
                  startNavigation(() => router.push(href));
                }
                catch {
                  setFeedback("confirmFailed");
                  startNavigation(() => router.refresh());
                }
              });
            }} type="button">{labels.confirmImport}</button>
          </div>
        </div>
      </form>
      <BottomSheet closeLabel={messages.common.close} onAfterClose={() => setOriginal(null)} onClose={closeOriginal} open={originalOpen} returnFocusRef={originalTriggerRef} title={labels.originalRecordTitle}>
          {original?.loading ? <p role="status">{labels.loadingOriginalRecord}</p> : original?.record ? <div className="space-y-3 break-words text-sm text-[var(--bb-ink)]">
            <p>{reviewDate(original.record.occurredAt)} · {formatFen(original.record.amountFen)} · {original.record.type === "INCOME" ? messages.common.income : messages.common.expense}</p>
            <p>{messages.common.category}: {getCategoryDisplayName(original.record.categoryName, locale)}</p>
            <p>{messages.common.who}: {original.record.actorMemberName}</p>
            <p>{messages.common.createdBy}: {original.record.createdByMemberName}</p>
            <p>{labels.source}: {sourceLabel(original.record.source)}</p>
            <p className="whitespace-pre-wrap">{messages.common.note}: {original.record.note || messages.common.noNote}</p>
          </div> : <p role="status" className="text-sm text-stone-600">{labels.originalRecordUnavailable}</p>}
      </BottomSheet>
    </>
  );
}
