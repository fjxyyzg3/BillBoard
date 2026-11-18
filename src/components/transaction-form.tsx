"use client";

import { appendEncryption, clearClientDraft, encryptionClientGeneration, getClientEncryption, readClientDraft, writeClientDraft } from "@/lib/encryption/client";

import { CalendarDays, ChevronDown, ChevronUp, FileText, UserRound } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  submitTransaction,
  type CreateTransactionActionState,
} from "@/app/(app)/add/actions";
import {
  CategoryPicker,
  type TransactionCategory,
} from "@/components/category-picker";
import { IosDateTimeInput } from "@/components/ios-datetime-input";
import styles from "./finance-b2.module.css";
import { getEncryptionMessages, getMessages, getValidationMessage, type Locale, type Messages } from "@/lib/i18n";
import { formatFen, getAmountExpressionPreviewFen, parseAmountInput } from "@/lib/money";
import type { DefaultCategoryIds } from "@/lib/transactions/category-preferences";
import { getCurrentShanghaiDateTimeLocal } from "@/lib/transactions/datetime";
import {
  getTransactionDraftStorageKey,
  parseTransactionDraft,
  serializeTransactionDraft,
  type TransactionDraft,
} from "@/lib/transactions/draft";
import type { EntryContext } from "@/lib/transactions/entry-context";
import { buildEntryRecordsHref } from "@/lib/transactions/result-records-link";

type HouseholdMemberOption = {
  id: string;
  memberName: string;
};

type TransactionFormProps = {
  categories: TransactionCategory[];
  defaultCategoryIds: DefaultCategoryIds;
  householdMembers: HouseholdMemberOption[];
  currentMemberId: string;
  context?: EntryContext;
  legacyDefaultLedgerId?: string;
  labels: {
    add: Pick<
      Messages["add"],
      | "checkRecords"
      | "retryConfirmation"
      | "save"
      | "slowSaving"
      | "successMessage"
      | "unknownDescription"
      | "unknownTitle"
    >;
    common: Messages["common"];
  };
  locale: Locale;
};

type FormPhase = "editing" | "submitting" | "unknown";
type TransactionPayload = TransactionDraft["payload"];
type SuccessState = Extract<CreateTransactionActionState, { status: "success" }>;

const initialCreateTransactionState: CreateTransactionActionState = {
  status: "idle",
};

const checkDrawEase = [0.22, 1, 0.36, 1] as const;

function CheckCircleIcon({ animated }: { animated: boolean }) {
  if (!animated) {
    return (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="2" />
        <path
          d="M8 12.4l2.6 2.6L16.2 9.4"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    );
  }

  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <motion.circle
        animate={{ pathLength: 1 }}
        cx="12"
        cy="12"
        initial={{ pathLength: 0 }}
        r="9.5"
        stroke="currentColor"
        strokeWidth="2"
        transition={{ duration: 0.3, ease: [...checkDrawEase] }}
      />
      <motion.path
        animate={{ pathLength: 1 }}
        d="M8 12.4l2.6 2.6L16.2 9.4"
        initial={{ pathLength: 0 }}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        transition={{ delay: 0.15, duration: 0.3, ease: [...checkDrawEase] }}
      />
    </svg>
  );
}

function SuccessToast({ detail, message }: { detail?: string; message: string }) {
  const [isVisible, setIsVisible] = useState(true);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setIsVisible(false);
    }, 2500);

    return () => window.clearTimeout(timeoutId);
  }, []);

  return (
    <AnimatePresence>
      {isVisible ? (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          aria-live="polite"
          className="fixed left-4 right-4 top-[calc(env(safe-area-inset-top)+1rem)] z-50 mx-auto flex max-w-md items-start gap-3 rounded-2xl border bg-white/95 px-4 py-3 text-sm text-[var(--bb-income-ink)] shadow-[var(--bb-shadow-lg)] backdrop-blur"
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -16 }}
          key="success-toast"
          role="status"
          style={{
            borderColor: "color-mix(in srgb, var(--bb-income) 30%, transparent)",
          }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { damping: 30, stiffness: 400, type: "spring" }
          }
        >
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--bb-income)]">
            <CheckCircleIcon animated={!reduceMotion} />
          </span>
          <span className="min-w-0">
            <p className="font-semibold">{message}</p>
            {detail ? <p className="opacity-80">{detail}</p> : null}
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SlowSavingNotice({ message }: { message: string }) {
  return (
    <p
      aria-live="polite"
      className="text-sm text-amber-700"
      data-testid="slow-saving-notice"
      role="status"
      style={{ visibility: "hidden" }}
    >
      {message}
    </p>
  );
}

async function writeDraft(storageKey: string, draft: TransactionDraft) {
  return writeClientDraft(storageKey, serializeTransactionDraft(draft));
}

function clearDraft(storageKey: string) {
  clearClientDraft(storageKey);
}

function buildActionFormData(draft: TransactionDraft, locale: Locale) {
  const formData = new FormData();

  formData.set("locale", locale);
  formData.set("type", draft.payload.type);
  formData.set("amount", draft.payload.amount);
  formData.set("categoryId", draft.payload.categoryId);
  formData.set("actorMemberId", draft.payload.actorMemberId);
  formData.set("occurredAt", draft.payload.occurredAt);
  formData.set("note", draft.payload.note);
  formData.set("clientRequestId", draft.clientRequestId ?? "");
  if (draft.version === 2) formData.set("context", JSON.stringify(draft.context));

  return formData;
}

function formatSuccessDetail(
  result: SuccessState,
  locale: Locale,
  labels: TransactionFormProps["labels"],
) {
  const typeLabel =
    result.type === "expense" ? labels.common.expense : labels.common.income;
  const amount = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(result.amountFen / 100);

  return getMessages(locale).add.successDetail(typeLabel, amount);
}

export function TransactionForm({
  categories,
  defaultCategoryIds,
  householdMembers,
  currentMemberId,
  context,
  legacyDefaultLedgerId,
  labels,
  locale,
}: TransactionFormProps) {
  const [initialOccurredAt, setInitialOccurredAt] = useState(() => getCurrentShanghaiDateTimeLocal());
  const [payload, setPayload] = useState<TransactionPayload>(() => ({
    type: "expense",
    amount: "",
    categoryId: defaultCategoryIds.expense,
    actorMemberId: currentMemberId,
    occurredAt: initialOccurredAt,
    note: "",
  }));
  const [phase, setPhase] = useState<FormPhase>("editing");
  const [submissionDraft, setSubmissionDraft] = useState<TransactionDraft | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [amountError, setAmountError] = useState<string>();
  const [successResult, setSuccessResult] = useState<SuccessState>();
  const [formResetKey, setFormResetKey] = useState(0);
  const [isNoteExpanded, setIsNoteExpanded] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const reduceMotion = useReducedMotion();
  const noteId = useId();
  const amountErrorId = useId();
  const amountRef = useRef<HTMLInputElement>(null);
  const restoredRef = useRef(false);
  const mountedRef = useRef(false);
  const requestGeneration = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const storageKey = getTransactionDraftStorageKey(currentMemberId, context);
  const recordsHref = buildEntryRecordsHref(submissionDraft?.version === 2 ? submissionDraft.context
    : legacyDefaultLedgerId ? { ledgerId: legacyDefaultLedgerId } : context);
  const amountPreviewFen = getAmountExpressionPreviewFen(payload.amount);
  const isFrozen = !isReady || phase !== "editing";
  const ui = getMessages(locale).ui;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const form = formRef.current;

    if (!viewport || !form) {
      return;
    }

    function updateKeyboardInset() {
      if (!viewport || !form) {
        return;
      }

      // A software keyboard may shrink only the visual viewport on mobile.
      const inset = viewport.scale === 1
        ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        : 0;

      form.style.setProperty("--bb-keyboard-inset", `${Math.round(inset)}px`);
    }

    updateKeyboardInset();
    viewport.addEventListener("resize", updateKeyboardInset);
    viewport.addEventListener("scroll", updateKeyboardInset);
    window.addEventListener("resize", updateKeyboardInset);

    return () => {
      viewport.removeEventListener("resize", updateKeyboardInset);
      viewport.removeEventListener("scroll", updateKeyboardInset);
      window.removeEventListener("resize", updateKeyboardInset);
      form.style.removeProperty("--bb-keyboard-inset");
    };
  }, []);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      const generation = encryptionClientGeneration();
      let blocked = false;
      try {
        const legacyKey = getTransactionDraftStorageKey(currentMemberId);
        const serialized = await readClientDraft(storageKey) ?? (context ? await readClientDraft(legacyKey) : null);
        if (!mountedRef.current || generation !== encryptionClientGeneration()) return;
        if (!serialized) return;
        const restored = parseTransactionDraft(serialized, {
          currentMemberId, context, legacyDefaultLedgerId, categories, defaultCategoryIds,
          fallbackOccurredAt: initialOccurredAt,
          householdMemberIds: householdMembers.map((member) => member.id),
        });
        if (!restored) { clearDraft(storageKey); return; }
        const persisted = await writeDraft(storageKey, restored);
        if (persisted && context) clearClientDraft(legacyKey);
        if (!mountedRef.current) return;
        setPayload(restored.payload);
        setIsNoteExpanded(restored.payload.note.length > 0);
        if (restored.status === "awaiting-confirmation") {
          setSubmissionDraft(restored);
          setPhase("unknown");
        }
      } catch (error) {
        // Preserve an unreadable draft and its UUID until protected storage is available.
        if ((error instanceof Error && error.message === "PROTECTED_DRAFT_UNAVAILABLE") || getClientEncryption()?.status.mode !== "UNENCRYPTED") {
          blocked = true;
          if (mountedRef.current) setActionError(getEncryptionMessages(locale).pendingStorageUnavailable);
        }
      } finally {
        if (mountedRef.current) setIsReady(!blocked);
      }
    })();
  }, [categories, currentMemberId, context, defaultCategoryIds, legacyDefaultLedgerId,
    householdMembers, initialOccurredAt, locale, storageKey]);

  function persistEditablePayload(nextPayload: TransactionPayload) {
    const nextDraft: TransactionDraft = {
      ...(context ? { version: 2 as const, context } : { version: 1 as const }),
      memberId: currentMemberId,
      payload: nextPayload,
      clientRequestId: null,
      status: "draft",
      savedAt: new Date().toISOString(),
    };

    void writeDraft(storageKey, nextDraft);
  }

  function updatePayload(nextPayload: TransactionPayload) {
    setPayload(nextPayload);
    setActionError(undefined);
    persistEditablePayload(nextPayload);
  }

  function updatePayloadField<Field extends keyof TransactionPayload>(
    field: Field,
    value: TransactionPayload[Field],
  ) {
    if (field === "amount") setAmountError(undefined);
    updatePayload({ ...payload, [field]: value });
  }

  function handleTypeChange(type: TransactionCategory["type"]) {
    const categoryStillMatches = categories.some(
      (category) => category.id === payload.categoryId && category.type === type,
    );

    updatePayload({
      ...payload,
      type,
      categoryId: categoryStillMatches ? payload.categoryId : defaultCategoryIds[type],
    });
  }

  function resetAfterSuccess(result: SuccessState) {
    clearDraft(storageKey);
    const occurredAt = getCurrentShanghaiDateTimeLocal();
    setInitialOccurredAt(occurredAt);
    setPayload({
      type: "expense",
      amount: "",
      categoryId: defaultCategoryIds.expense,
      actorMemberId: currentMemberId,
      occurredAt,
      note: "",
    });
    setSubmissionDraft(null);
    setActionError(undefined);
    setAmountError(undefined);
    setSuccessResult(result);
    setFormResetKey((current) => current + 1);
    setIsNoteExpanded(false);
    setPhase("editing");
  }

  function sendDraft(draft: TransactionDraft) {
    const generation = ++requestGeneration.current;
    const ownsResponse = () => mountedRef.current && requestGeneration.current === generation;
    setSubmissionDraft(draft);
    setActionError(undefined);
    setPhase("submitting");
    const slowTimer = window.setTimeout(() => {
      formRef.current
        ?.querySelector<HTMLElement>("[data-testid='slow-saving-notice']")
        ?.style.setProperty("visibility", "visible");
    }, 3000);

    void (async () => {
      try {
        const persisted = await writeDraft(storageKey, draft);
        if (getClientEncryption()?.status.mode !== undefined && getClientEncryption()?.status.mode !== "UNENCRYPTED" && !persisted) {
          setActionError(getMessages(locale).actions.couldNotSave);
          setPhase("unknown");
          return;
        }
        if (!ownsResponse()) return;
        const result = await submitTransaction(
          initialCreateTransactionState,
          appendEncryption(buildActionFormData(draft, locale)),
        );
        if (!ownsResponse()) return;

        if (result.status === "success") {
          if (result.clientRequestId !== draft.clientRequestId) {
            setPhase("unknown");
            return;
          }

          resetAfterSuccess(result);
          return;
        }

        if (result.status !== "error") {
          setPhase("unknown");
          return;
        }
        if (result.conflict) {
          setActionError(result.message);
          setPhase("unknown");
          return;
        }

        const editableDraft: TransactionDraft = {
          ...draft,
          clientRequestId: null,
          status: "draft",
          savedAt: new Date().toISOString(),
        };

        writeDraft(storageKey, editableDraft);
        setSubmissionDraft(null);
        setActionError(result.message);
        setPhase("editing");
      } catch {
        if (ownsResponse()) setPhase("unknown");
      } finally {
        window.clearTimeout(slowTimer);
      }
    })();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isFrozen) {
      return;
    }

    try {
      parseAmountInput(payload.amount);
    } catch (error) {
      setAmountError(getValidationMessage(error instanceof Error ? error.message : undefined, locale, "save"));
      amountRef.current?.focus();
      return;
    }

    const draft: TransactionDraft = {
      ...(context ? { version: 2 as const, context } : { version: 1 as const }),
      memberId: currentMemberId,
      payload,
      clientRequestId: window.crypto.randomUUID(),
      status: "awaiting-confirmation",
      savedAt: new Date().toISOString(),
    };

    sendDraft(draft);
  }

  return (
    <form
      data-apk-update-blocked={!isReady || phase !== "editing" || undefined}
      data-desktop-update-dirty={Boolean(payload.amount || payload.note || payload.type !== "expense"
        || payload.categoryId !== defaultCategoryIds.expense || payload.actorMemberId !== currentMemberId || payload.occurredAt !== initialOccurredAt) || undefined}
      aria-busy={!isReady || phase === "submitting" || undefined}
      className={`${styles.entryForm} ios-panel p-4 sm:px-5 sm:pt-5 ${phase === "unknown" ? "pb-80 md:pb-5" : "pb-28 md:pb-5"}`}
      onSubmit={handleSubmit}
      ref={formRef}
    >
      <fieldset className="min-w-0 space-y-4" disabled={isFrozen}>
        <fieldset>
          <legend className="sr-only">
            {labels.common.type}
          </legend>
          <div className="bb-segmented bb-segmented--income grid grid-cols-2 rounded-xl bg-[var(--bb-warm-surface)] p-1 text-sm">
            {(["expense", "income"] as const).map((type) => {
              const isActive = payload.type === type;

              return (
                <label
                  className={`bb-tap relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg px-3 py-2 text-center font-medium ${
                    isActive
                      ? type === "expense"
                        ? "text-[var(--bb-accent-ink)]"
                        : "text-[var(--bb-income-ink)]"
                      : "text-[var(--bb-muted)] hover:text-[var(--bb-ink)]"
                  }`}
                  key={type}
                >
                  <input
                    checked={isActive}
                    className="peer sr-only"
                    name="type"
                    onChange={() => handleTypeChange(type)}
                    type="radio"
                    value={type}
                  />
                  <span className="relative rounded-full peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-[var(--bb-primary)]">
                    {type === "expense" ? labels.common.expense : labels.common.income}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <label className="block space-y-2">
          <span className="text-xs font-medium text-[var(--bb-muted)]">
            {labels.common.amount}
          </span>
          <div className={`${styles.amountRow} flex min-w-0 gap-1 border-b`}>
            <span aria-hidden="true" className="text-[1.375rem] font-normal text-[var(--bb-ink)]">¥</span>
            <input
              aria-describedby={amountError ? amountErrorId : undefined}
              aria-invalid={Boolean(amountError) || undefined}
              aria-label={labels.common.amount}
              className={`${styles.amountInput} w-full min-w-0 rounded-lg bg-transparent py-2 tabular-nums outline-offset-2 placeholder:text-[var(--bb-faint)]`}
              inputMode="decimal"
              name="amount"
              onChange={(event) => updatePayloadField("amount", event.target.value)}
              placeholder="0.00"
              ref={amountRef}
              required
              type="text"
              value={payload.amount}
            />
          </div>
          {amountError ? <span className="block text-sm text-[var(--bb-danger)]" id={amountErrorId} role="alert">{amountError}</span> : null}
          {amountPreviewFen !== null ? (
            <p aria-live="polite" className="text-sm text-[var(--bb-muted)]">
              = {formatFen(amountPreviewFen)}
            </p>
          ) : null}
          <span className="block text-xs text-[var(--bb-muted)]">{ui.amountExpressionHint}</span>
        </label>

        <CategoryPicker
          categories={categories}
          key={`${formResetKey}-${payload.type}`}
          label={labels.common.category}
          labels={{ collapse: labels.common.collapse, more: labels.common.more }}
          locale={locale}
          onSelect={(categoryId) => updatePayloadField("categoryId", categoryId)}
          selectedCategoryId={payload.categoryId}
          selectedType={payload.type}
        />

        <fieldset className="space-y-2 border-t border-[var(--bb-warm-line)] pt-4">
          <legend className="float-left mb-2 w-full text-sm font-medium text-[var(--bb-ink)]">
            {labels.common.who}
          </legend>
          <div className="grid clear-both grid-cols-2 gap-2">
            {householdMembers.map((member) => (
              <label className="relative block min-w-0 cursor-pointer" key={member.id}>
                <input
                  checked={payload.actorMemberId === member.id}
                  className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  name="actorMemberId"
                  onChange={() => updatePayloadField("actorMemberId", member.id)}
                  required
                  type="radio"
                  value={member.id}
                />
                <span className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--bb-warm-line)] bg-white px-3 py-2 text-sm font-normal text-[var(--bb-muted)] transition-colors peer-checked:border-[var(--bb-primary)]/40 peer-checked:bg-[var(--bb-accent-soft)] peer-checked:text-[var(--bb-accent-ink)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--bb-primary)] peer-disabled:cursor-not-allowed peer-disabled:opacity-60">
                  <UserRound aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.6} />
                  <span className="truncate">{member.memberName}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm font-normal text-[var(--bb-muted)]">
            {labels.common.when}
          </span>
          <IosDateTimeInput
            className="text-base shadow-none md:text-sm"
            leadingIcon={<CalendarDays className="h-4 w-4" strokeWidth={1.6} />}
            name="occurredAt"
            onChange={(event) => updatePayloadField("occurredAt", event.target.value)}
            required
            value={payload.occurredAt}
          />
        </label>

        <div className="space-y-2">
          <button
            aria-controls={isNoteExpanded ? noteId : undefined}
            aria-expanded={isNoteExpanded}
            className="flex min-h-11 w-full items-center gap-2 rounded-xl px-1 text-left text-sm font-medium text-[var(--bb-muted)] hover:text-[var(--bb-ink)] disabled:cursor-not-allowed"
            onClick={() => setIsNoteExpanded((current) => !current)}
            type="button"
          >
            <FileText aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.6} />
            <span>{isNoteExpanded ? ui.hideNote : ui.addNote}</span>
            {isNoteExpanded ? (
              <ChevronUp aria-hidden="true" className="ml-auto h-4 w-4" />
            ) : (
              <ChevronDown aria-hidden="true" className="ml-auto h-4 w-4" />
            )}
          </button>
          <AnimatePresence initial={false}>
            {isNoteExpanded ? (
              <motion.label
                animate={{ height: "auto", opacity: 1 }}
                className="block overflow-hidden"
                exit={{ height: 0, opacity: 0 }}
                id={noteId}
                initial={{ height: 0, opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.18 }}
              >
                <span className="sr-only">{labels.common.note}</span>
                <input
                  className="ios-field text-base md:text-sm"
                  name="note"
                  onChange={(event) => updatePayloadField("note", event.target.value)}
                  placeholder={labels.common.optional}
                  type="text"
                  value={payload.note}
                />
              </motion.label>
            ) : null}
          </AnimatePresence>
        </div>
      </fieldset>

      <div data-bottom-actions className={`${styles.bottomActions} fixed inset-x-0 bottom-[max(calc(var(--bb-mobile-nav-height)+env(safe-area-inset-bottom)),var(--bb-keyboard-inset,0px))] z-20 space-y-2 border-t px-4 py-3 md:static md:mt-4 md:border-0 md:p-0 md:pt-2`}>
        {phase === "submitting" ? <SlowSavingNotice message={labels.add.slowSaving} /> : null}
        {phase === "unknown" && submissionDraft ? (
          <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4" role="alert">
            <div className="space-y-1">
              <p className="font-semibold text-amber-900">{labels.add.unknownTitle}</p>
              <p className="text-sm text-amber-800">{labels.add.unknownDescription}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                className="min-h-11 rounded-xl bg-amber-700 px-3 py-2 text-sm font-semibold text-white"
                onClick={() => sendDraft(submissionDraft)}
                type="button"
              >
                {labels.add.retryConfirmation}
              </button>
              <Link
                className="flex min-h-11 items-center justify-center rounded-xl border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-900"
                href={recordsHref}
              >
                {labels.add.checkRecords}
              </Link>
            </div>
          </div>
        ) : (
          <button
            className={`${styles.primaryButton} w-full bg-[var(--bb-primary)] px-4 text-white transition hover:bg-[var(--bb-primary-hover)] active:scale-[0.98] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-70 disabled:active:scale-100`}
            disabled={isFrozen}
            type="submit"
          >
            {phase !== "editing" ? labels.common.saving : labels.add.save}
          </button>
        )}
        {actionError ? <p className="text-sm text-[var(--bb-danger)]" role="alert">{actionError}</p> : null}
      </div>

      {successResult ? (
        <SuccessToast
          detail={formatSuccessDetail(successResult, locale, labels)}
          key={successResult.transactionId}
          message={labels.add.successMessage}
        />
      ) : null}
    </form>
  );
}
