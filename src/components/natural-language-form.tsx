"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { NaturalLanguageFeedback } from "@/components/natural-language-feedback";
import { useProcessingChoice } from "@/components/processing-provider";
import { useNaturalLanguageEntry } from "@/components/natural-language-provider";
import { useOptionalLedgerSelection } from "@/components/ledger-provider";
import { matchesEntryContext } from "@/lib/transactions/entry-context";
import { getLedgerDisplayName, getMessages, type Locale } from "@/lib/i18n";
import styles from "./finance-b2.module.css";

type NaturalLanguageFormProps = {
  locale: Locale;
  onFrozenChange?: (frozen: boolean) => void;
};

export function NaturalLanguageForm({ locale, onFrozenChange }: NaturalLanguageFormProps) {
  const processing = useProcessingChoice();
  const [text, setText] = useState("");
  const selection = useOptionalLedgerSelection();
  const { controller, ready: isReady, phase, reservation, pending, feedback: sharedFeedback } = useNaturalLanguageEntry();
  const source = controller.textDraftSource(selection?.context);
  const feedback = sharedFeedback?.source === source ? sharedFeedback : null;
  const error = feedback?.result.status === "error" ? feedback.result : null;
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const labels = getMessages(locale).add.naturalLanguage;
  const isFrozen = !isReady || pending !== null || reservation !== null;
  const needsCorrection = error?.code === "NEEDS_CORRECTION" || error?.code === "INPUT_TOO_LONG";

  useEffect(() => {
    const input = inputRef.current;
    if (needsCorrection && !isFrozen && input?.getClientRects().length) {
      input.focus({ preventScroll: true });
    }
  }, [feedback, isFrozen, needsCorrection]);

  useEffect(() => {
    const restored = controller.getTextDraft(selection?.context);
    queueMicrotask(() => setText(restored));
  }, [controller, source, selection?.context]);

  useEffect(() => { onFrozenChange?.(isFrozen); }, [isFrozen, onFrozenChange]);
  useEffect(() => {
    if (sharedFeedback?.result.status !== "success") return;
    if (selection) {
      if (!sharedFeedback.target || !matchesEntryContext(sharedFeedback.target.context, selection.context)) return;
      if (controller.getTextDraft(selection.context)) return;
    } else if (sharedFeedback.source !== source) return;
    queueMicrotask(() => setText(""));
  }, [controller, sharedFeedback, selection, source]);

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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) { void controller.confirm(); return; }
    if (!processing.ensure("ai")) return;
    controller.submit(source, text, locale);
  }

  return (
    <form
      data-desktop-update-dirty={Boolean(text.trim()) || undefined}
      aria-busy={!isReady || phase === "submitting" || undefined}
      className={`${styles.entryForm} ios-panel space-y-4 p-4 pb-28 sm:px-5 sm:pt-5 md:pb-5`}
      method="post"
      onSubmit={handleSubmit}
      ref={formRef}
    >
      {selection || pending?.target ? <p className="text-xs text-[var(--bb-muted)]">
        {getMessages(locale).ledgers.target} · {getLedgerDisplayName(pending?.target?.ledgerName ?? selection!.ledgerName, locale)}
      </p> : null}
      <label className="block space-y-2" htmlFor={inputId}>
        <span className="text-sm font-medium text-[var(--bb-ink)]">{labels.label}</span>
        <textarea
          aria-describedby={error ? `${helpId} ${errorId}` : helpId}
          aria-invalid={needsCorrection || undefined}
          className="ios-field min-h-44 resize-y text-base leading-relaxed md:text-sm"
          disabled={isFrozen}
          id={inputId}
          name="description"
          onChange={(event) => {
            const value = event.target.value;
            setText(value);
            controller.setTextDraft(value, selection?.context);
            controller.clearFeedback(source);
          }}
          placeholder={labels.placeholder}
          ref={inputRef}
          rows={7}
          value={text}
        />
      </label>
      <p className="text-xs leading-relaxed text-[var(--bb-muted)]" id={helpId}>{labels.help}</p>
      {phase === "submitting" ? (
        <p className="text-sm text-[var(--bb-muted)]" role="status">{labels.processing}</p>
      ) : null}
      {phase === "processing" ? (
        <p className="text-sm text-amber-800" role="status">{labels.stillProcessing}</p>
      ) : null}
      {phase === "unknown" ? (
        <div className="space-y-1 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" role="alert">
          <p className="font-semibold">{labels.unknownTitle}</p>
          <p>{labels.unknownDescription}</p>
        </div>
      ) : null}
      <NaturalLanguageFeedback feedback={feedback} id={errorId} text={text} locale={locale} />
      <div data-bottom-actions className={`${styles.bottomActions} fixed inset-x-0 bottom-[max(calc(var(--bb-mobile-nav-height)+env(safe-area-inset-bottom)),var(--bb-keyboard-inset,0px))] z-20 border-t px-4 py-3 md:static md:mt-4 md:border-0 md:p-0 md:pt-2`}>
        <button
          className={`${styles.primaryButton} w-full bg-[var(--bb-primary)] px-4 text-white transition hover:bg-[var(--bb-primary-hover)] active:scale-[0.98] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-70 disabled:active:scale-100`}
          disabled={!isReady || phase === "submitting" || reservation !== null}
          type="submit"
        >
          {phase === "submitting" ? labels.processing : phase === "editing" ? labels.import : labels.confirm}
        </button>
      </div>
    </form>
  );
}
