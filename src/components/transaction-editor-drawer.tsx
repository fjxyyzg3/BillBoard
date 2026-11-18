"use client";

import { appendEncryption } from "@/lib/encryption/client";

import { CalendarDays, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  submitRecordDelete,
  submitRecordUpdate,
  type RecordEditorActionState,
} from "@/app/(app)/records/actions";
import { BottomSheet } from "@/components/bottom-sheet";
import { IosSelect } from "@/components/ios-select";
import { CategoryPicker } from "@/components/category-picker";
import { registerImportReviewHistoryGuard } from "@/components/import-review-history-guard";
import { IosDateTimeInput } from "@/components/ios-datetime-input";
import styles from "./finance-b2.module.css";
import { getLedgerDisplayName, getMessages, getValidationMessage, type Locale, type Messages } from "@/lib/i18n";
import type { LedgerSummary } from "@/lib/ledgers/selection";
import { formatFen, getAmountExpressionPreviewFen, parseAmountInput } from "@/lib/money";
import type { EntryContext } from "@/lib/transactions/entry-context";

type CategoryOption = {
  id: string;
  name: string;
  type: "income" | "expense";
};

type HouseholdMemberOption = {
  id: string;
  memberName: string;
};

type EditableRecord = {
  id: string;
  amountFen: number;
  actorMemberId: string;
  categoryId: string;
  createdByLabel: string;
  note: string | null;
  occurredAtLocal: string;
  type: "income" | "expense";
};

type TransactionEditorDrawerProps = {
  categories: CategoryOption[];
  closeHref: string;
  householdMembers: HouseholdMemberOption[];
  context?: EntryContext;
  ledgers?: LedgerSummary[];
  readOnly?: boolean;
  labels: {
    common: Messages["common"];
    editor: Pick<
      Messages["editor"],
      "deleteConfirm" | "deleteRecord" | "deleting" | "saveChanges" | "title"
    >;
  };
  locale: Locale;
  record: EditableRecord;
  returnTo: string;
};

function getFirstCategoryId(
  categories: CategoryOption[],
  type: CategoryOption["type"],
  preferredCategoryId: string,
) {
  const preferredCategory = categories.find(
    (category) => category.id === preferredCategoryId && category.type === type,
  );

  return preferredCategory?.id ?? categories.find((category) => category.type === type)?.id ?? "";
}

const initialRecordEditorState = { status: "idle" as const };

export function TransactionEditorDrawer({
  categories,
  closeHref,
  householdMembers,
  context,
  ledgers = [],
  readOnly = false,
  labels,
  locale,
  record,
  returnTo,
}: TransactionEditorDrawerProps) {
  const router = useRouter();
  const messages = getMessages(locale);
  const formId = useId();
  const amountErrorId = useId();
  const amountRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(true);
  const [selectedType, setSelectedType] = useState<CategoryOption["type"]>(record.type);
  const initialCategoryId = getFirstCategoryId(categories, record.type, record.categoryId);
  const [selectedCategoryId, setSelectedCategoryId] = useState(initialCategoryId);
  const [amountInput, setAmountInput] = useState(formatFen(record.amountFen));
  const [amountError, setAmountError] = useState<string>();
  const [actorMemberId, setActorMemberId] = useState(record.actorMemberId);
  const [occurredAt, setOccurredAt] = useState(record.occurredAtLocal);
  const [note, setNote] = useState(record.note ?? "");
  const [targetLedgerId, setTargetLedgerId] = useState(context?.ledgerId ?? "");
  const [updateState, updateAction, isUpdating] = useActionState((previous: RecordEditorActionState, data: FormData) => submitRecordUpdate(previous, appendEncryption(data)), initialRecordEditorState);
  const [deleteState, deleteAction, isDeleting] = useActionState((previous: RecordEditorActionState, data: FormData) => submitRecordDelete(previous, appendEncryption(data)), initialRecordEditorState);
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const isBusy = isUpdating || isDeleting;
  const isDirty = selectedType !== record.type || selectedCategoryId !== initialCategoryId
    || amountInput !== formatFen(record.amountFen) || actorMemberId !== record.actorMemberId
    || occurredAt !== record.occurredAtLocal || note !== (record.note ?? "") || targetLedgerId !== (context?.ledgerId ?? "");
  const message = updateState.status === "error" ? updateState.message : deleteState.message;
  const amountPreviewFen = getAmountExpressionPreviewFen(amountInput);
  const discardConfirm = messages.editor.discardChangesConfirm;

  useEffect(() => { dirtyRef.current = isDirty; }, [isDirty]);
  useEffect(() => { pendingRef.current = isBusy; }, [isBusy]);

  useEffect(() => {
    const currentHref = window.location.href;
    const indexKey = "__billboardEditorHistoryIndex";
    const nativeIndex = () => (window as Window & {
      navigation?: { currentEntry?: { index: number } };
    }).navigation?.currentEntry?.index;
    const markedIndex = () => {
      const value: unknown = window.history.state?.[indexKey];
      return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
    };
    const historyIndex = () => nativeIndex() ?? markedIndex();
    let restoreHistoryMethods: (() => void) | undefined;
    let active = true;
    if (nativeIndex() === undefined) {
      History.prototype.replaceState.call(window.history, { ...window.history.state, [indexKey]: markedIndex() ?? 0 }, "");
      queueMicrotask(() => {
        if (!active) return;
        const originalPush = window.history.pushState;
        const originalReplace = window.history.replaceState;
        const push: History["pushState"] = (state, unused, url) => {
          originalPush.call(window.history, { ...state, [indexKey]: (markedIndex() ?? 0) + 1 }, unused, url);
        };
        const replace: History["replaceState"] = (state, unused, url) => {
          originalReplace.call(window.history, { ...state, [indexKey]: markedIndex() ?? 0 }, unused, url);
        };
        window.history.pushState = push;
        window.history.replaceState = replace;
        restoreHistoryMethods = () => {
          if (window.history.pushState === push) window.history.pushState = originalPush;
          if (window.history.replaceState === replace) window.history.replaceState = originalReplace;
        };
      });
    }
    const currentIndex = historyIndex();
    let restoring: { distance: number; untracked: boolean } | null = null;
    let replaying = false;
    // The root guard runs before Next's popstate listener, preserving the mounted form.
    const unregisterHistoryGuard = registerImportReviewHistoryGuard((event) => {
      if (replaying || (!restoring && !dirtyRef.current && !pendingRef.current)) return;
      event.stopImmediatePropagation();
      if (restoring) {
        if (window.location.href === currentHref && historyIndex() === currentIndex) {
          const distance = restoring.distance;
          restoring = null;
          if (!pendingRef.current && window.confirm(discardConfirm)) {
            replaying = true;
            window.history.go(-distance);
          }
        } else if (restoring.untracked) {
          restoring.distance += 1;
          window.history.forward();
        }
        return;
      }
      const targetIndex = historyIndex();
      const distance = currentIndex !== undefined && targetIndex !== undefined
        ? currentIndex - targetIndex : 1;
      if (distance === 0) return;
      restoring = { distance, untracked: targetIndex === undefined };
      window.history.go(distance);
    });
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current && !pendingRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      active = false;
      restoreHistoryMethods?.();
      unregisterHistoryGuard();
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, [discardConfirm]);

  function closeEditor() {
    if (isBusy || !open || (isDirty && !window.confirm(discardConfirm))) return;
    setOpen(false);
  }

  return (
    <BottomSheet
      closeLabel={labels.common.close}
      footer={
        <div className="space-y-3">
          {message ? <p className="text-sm text-[var(--bb-danger)]" role="alert">{message}</p> : null}
          <button
            className={`${styles.primaryButton} flex w-full items-center justify-center bg-[var(--bb-primary)] px-4 text-white transition hover:bg-[var(--bb-primary-hover)] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-500 motion-reduce:active:scale-100`}
            disabled={readOnly || isBusy || !open}
            form={formId}
            type="submit"
          >
            {isUpdating ? labels.common.saving : labels.editor.saveChanges}
          </button>
        </div>
      }
      onAfterClose={() => router.replace(closeHref, { scroll: false })}
      onClose={closeEditor}
      open={open}
      title={labels.editor.title}
    >
      <p className="mb-5 break-words text-xs leading-relaxed text-[var(--bb-muted)]">{record.createdByLabel}</p>
      {readOnly ? <p className="mb-4 text-sm text-[var(--bb-muted)]" role="status">{messages.ledgers.readOnly}</p> : null}
      <form action={updateAction} data-apk-update-blocked={isBusy || undefined} data-desktop-update-dirty={isDirty || undefined} id={formId}
        onSubmit={(event) => {
          try {
            parseAmountInput(amountInput);
          } catch (error) {
            event.preventDefault();
            setAmountError(getValidationMessage(error instanceof Error ? error.message : undefined, locale, "update"));
            amountRef.current?.focus();
          }
        }}>
        <input name="locale" type="hidden" value={locale} />
        <input name="transactionId" type="hidden" value={record.id} />
        {context ? <input name="context" type="hidden" value={JSON.stringify(context)} /> : null}
        <input name="returnTo" type="hidden" value={returnTo} />
        <fieldset className="min-w-0 space-y-5" disabled={readOnly || isBusy || !open}>
          {context && ledgers.length ? <label className="block space-y-2">
            <span className="text-sm font-semibold text-[var(--bb-ink)]">{messages.ledgers.moveTo}</span>
            <IosSelect name="targetLedgerId" onChange={(event) => setTargetLedgerId(event.target.value)} value={targetLedgerId}
              options={ledgers.filter((ledger) => ledger.archivedAt === null || ledger.id === context.ledgerId).map((ledger) => ({ value: ledger.id, label: getLedgerDisplayName(ledger.name, locale) }))} />
          </label> : null}
          <fieldset>
            <legend className="sr-only">{labels.common.type}</legend>
            <div className="bb-segmented grid grid-cols-2 rounded-2xl bg-[var(--bb-warm-surface)] p-1 [--bb-segment-radius:0.75rem]">
              {(["expense", "income"] as const).map((type) => (
                <label
                  className={`relative flex min-h-11 cursor-pointer items-center justify-center rounded-xl px-3 text-sm font-medium transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--bb-primary)] ${selectedType === type ? "text-[var(--bb-accent-ink)]" : "text-[var(--bb-muted)]"}`}
                  key={type}
                >
                  <input
                    checked={selectedType === type}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    name="type"
                    onChange={() => {
                      setSelectedType(type);
                      setSelectedCategoryId(getFirstCategoryId(categories, type, selectedCategoryId));
                    }}
                    type="radio"
                    value={type}
                  />
                  {type === "expense" ? labels.common.expense : labels.common.income}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block space-y-2">
            <span className="text-sm font-semibold text-[var(--bb-ink)]">{labels.common.amount}</span>
            <input
              aria-describedby={amountError ? amountErrorId : undefined}
              aria-invalid={Boolean(amountError) || undefined}
              aria-label={labels.common.amount}
              className={`${styles.amountInput} ios-field w-full tabular-nums`}
              inputMode="decimal"
              name="amount"
              onChange={(event) => { setAmountInput(event.target.value); setAmountError(undefined); }}
              ref={amountRef}
              required
              type="text"
              value={amountInput}
            />
            {amountError ? <span className="block text-sm text-[var(--bb-danger)]" id={amountErrorId} role="alert">{amountError}</span> : null}
            {amountPreviewFen !== null ? <span aria-live="polite" className="block text-sm tabular-nums text-[var(--bb-muted)]">= {formatFen(amountPreviewFen)}</span> : null}
          </label>
          <CategoryPicker
            categories={categories}
            label={labels.common.category}
            labels={labels.common}
            locale={locale}
            onSelect={setSelectedCategoryId}
            selectedCategoryId={selectedCategoryId}
            selectedType={selectedType}
          />
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-[var(--bb-ink)]">{labels.common.who}</legend>
            <div className="grid grid-cols-2 gap-2">
              {householdMembers.map((member) => (
                <label className={`relative flex min-h-11 min-w-0 cursor-pointer items-center justify-center rounded-xl border px-3 py-2 font-medium transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--bb-primary)] ${actorMemberId === member.id ? "border-[var(--bb-primary)] bg-[var(--bb-accent-soft)] text-[var(--bb-accent-ink)]" : "border-[var(--bb-warm-line)] text-[var(--bb-muted)]"}`} key={member.id}>
                  <input checked={actorMemberId === member.id} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" name="actorMemberId" onChange={() => setActorMemberId(member.id)} required type="radio" value={member.id} />
                  <span className="min-w-0 break-words">{member.memberName}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block space-y-2">
            <span className="text-sm font-semibold text-[var(--bb-ink)]">{labels.common.when}</span>
            <IosDateTimeInput leadingIcon={<CalendarDays size={17} />} name="occurredAt" onChange={(event) => setOccurredAt(event.target.value)} required value={occurredAt} />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-semibold text-[var(--bb-ink)]">{labels.common.note}</span>
            <textarea aria-label={labels.common.note} className="ios-field min-h-24 resize-y" name="note" onChange={(event) => setNote(event.target.value)} placeholder={labels.common.optional} rows={3} value={note} />
          </label>
        </fieldset>
      </form>
      <form
        action={deleteAction}
        className="mt-6 border-t border-[var(--bb-warm-line)] pt-4"
        onSubmit={(event) => {
          if (readOnly || isBusy || !window.confirm(labels.editor.deleteConfirm)) event.preventDefault();
        }}
      >
        <input name="locale" type="hidden" value={locale} />
        <input name="transactionId" type="hidden" value={record.id} />
        {context ? <input name="context" type="hidden" value={JSON.stringify(context)} /> : null}
        <input name="returnTo" type="hidden" value={returnTo} />
        <button className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm font-medium text-[var(--bb-danger)] transition hover:bg-red-50 disabled:opacity-50" disabled={readOnly || isBusy || !open} type="submit">
          <Trash2 aria-hidden="true" size={16} />
          {isDeleting ? labels.editor.deleting : labels.editor.deleteRecord}
        </button>
      </form>
    </BottomSheet>
  );
}
