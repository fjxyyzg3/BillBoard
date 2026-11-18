"use client";

import { useProcessingChoice } from "@/components/processing-provider";

import Link from "next/link";
import { lockPageScroll } from "@/lib/ui/page-scroll-lock";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Mic, X } from "lucide-react";
import { NaturalLanguageFeedback } from "@/components/natural-language-feedback";
import { VoiceTaskFeedback, VoiceTaskList } from "@/components/voice-task-feedback";
import { useNaturalLanguageEntry, useVoiceAccountingQueue } from "@/components/natural-language-provider";
import { useOptionalLedgerSelection } from "@/components/ledger-provider";
import type { EntryTarget } from "@/lib/transactions/entry-context";
import { buildEntryRecordsHref } from "@/lib/transactions/result-records-link";
import { getLedgerDisplayName, getMessages, type Locale } from "@/lib/i18n";
import { startVoiceRecording, type VoiceRecording } from "@/lib/voice/recorder";
import type { VoiceTask } from "@/lib/voice/accounting-queue";

type VoiceControls = { begin: () => void; finish: () => void; cancel: () => void; armCancel: (armed: boolean) => void; hint: string };
const VoiceContext = createContext<VoiceControls | null>(null);
type Operation = { token: symbol; abort: AbortController; route: string; recorder?: VoiceRecording; target?: EntryTarget };
type Stage = "idle" | "permission" | "recording" | "limit";
const source = "voice";

function recordingRoute(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  params.delete("ledger");
  params.delete("entryLedger");
  return `${pathname}?${params}`;
}

export function VoiceAccountingProvider({ children, locale, ledgerName }: { children: ReactNode; locale: Locale; ledgerName?: string }) {
  const processing = useProcessingChoice();
  const selection = useOptionalLedgerSelection();
  const entry = useNaturalLanguageEntry();
  const { controller, pending, feedback, phase } = entry;
  const { queue, tasks } = useVoiceAccountingQueue();
  const labels = getMessages(locale).add.voice;
  const natural = getMessages(locale).add.naturalLanguage;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const route = `${pathname}?${params.toString()}`;
  const [open, setOpen] = useState(false);
  const [visibleRequestId, setVisibleRequestId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showTaskList, setShowTaskList] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [armed, setArmed] = useState(false);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [recordingLedgerName, setRecordingLedgerName] = useState<string | null>(null);
  const opRef = useRef<Operation | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoredShown = useRef(false);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const ownFeedback = selectedTask ? selectedTask.feedback
    : feedback && (feedback.source === source || feedback.source === null || feedback.result.requestId === visibleRequestId) ? feedback : null;
  const ownPending = selectedTask ? null : pending;
  const backgroundActive = tasks.some((task) => task.phase !== "success" && task.phase !== "failed");

  const cancelOperation = useCallback(() => {
    const op = opRef.current;
    opRef.current = null;
    if (op) {
      op.abort.abort();
      op.recorder?.cancel();
      controller.release(op.token);
    }
  }, [controller]);

  const cancel = useCallback(() => {
    if (!opRef.current) return;
    cancelOperation();
    setStage("idle");
    setArmed(false);
    setNotice(labels.cancelled);
  }, [cancelOperation, labels.cancelled]);

  const begin = useCallback(() => {
    if (document.hidden) return;
    if (!processing.ensure("voice")) return;
    setOpen(true);
    setShowTaskList(false);
    setSelectedTaskId(null);
    const token = controller.reserve();
    if (!token) {
      const existing = controller.getSnapshot().pending;
      if (existing) setVisibleRequestId(existing.requestId);
      else setNotice(labels.busy);
      return;
    }
    setVisibleRequestId(null);
    controller.clearFeedback(source);
    controller.clearFeedback(null);
    const op: Operation = { token, abort: new AbortController(), route: recordingRoute(window.location.pathname, window.location.search),
      ...(selection ? { target: { context: { ...selection.context }, ledgerName: selection.ledgerName } } : {}) };
    opRef.current = op;
    setRecordingLedgerName(op.target?.ledgerName ?? ledgerName ?? null);
    setStage("permission");
    setNotice(null);
    setText("");
    setElapsed(0);
    setArmed(false);
    const fail = (error: unknown) => {
      if (opRef.current !== op) return;
      cancelOperation();
      const name = error instanceof Error ? error.name : "";
      const code = name === "NotAllowedError" ? "denied" : name === "NotSupportedError" ? "unsupported"
        : name === "DataError" ? "no_speech" : name === "AbortError" ? "cancelled" : "device";
      setStage("idle");
      setNotice(labels.errors[code]);
    };
    void startVoiceRecording({
      signal: op.abort.signal,
      onTime: (seconds) => { if (opRef.current === op) setElapsed(seconds); },
      onLimit: () => { if (opRef.current === op) setStage("limit"); },
      onError: fail,
    }).then((recorder) => {
      if (opRef.current !== op || op.abort.signal.aborted) { recorder.cancel(); return; }
      op.recorder = recorder;
      setStage("recording");
    }).catch(fail);
  }, [cancelOperation, controller, labels, selection, ledgerName, processing]);

  const finish = useCallback(() => {
    const op = opRef.current;
    if (!op) return;
    if (!op.recorder) {
      cancelOperation();
      setStage("idle");
      setNotice(labels.retryHold);
      return;
    }
    const audio = op.recorder.stop();
    opRef.current = null;
    controller.release(op.token);
    setStage("idle");
    try { queue.enqueue(audio, locale, op.target); }
    catch { setNotice(labels.busy); return; }
    setOpen(false);
    setNotice(null);
  }, [cancelOperation, controller, labels.retryHold, labels.busy, locale, queue]);

  const close = useCallback(() => {
    cancelOperation();
    setOpen(false);
    setStage("idle");
    setNotice(null);
    setSelectedTaskId(null);
    setShowTaskList(false);
    if (selectedTaskId) setText("");
    if (!pending && !selectedTaskId) {
      setText("");
      controller.clearFeedback(source);
      controller.clearFeedback(null);
      if (feedback?.result.requestId === visibleRequestId) controller.clearFeedback(feedback.source);
    }
  }, [cancelOperation, controller, feedback, pending, selectedTaskId, visibleRequestId]);

  const selectTask = (task: VoiceTask) => {
    setSelectedTaskId(task.id); setText(task.text ?? ""); setNotice(null);
    setStage("idle"); setShowTaskList(false); setOpen(true);
  };

  useEffect(() => {
    const op = opRef.current;
    if (op && op.route !== recordingRoute(window.location.pathname, window.location.search)) {
      cancelOperation();
      queueMicrotask(() => { setStage("idle"); setOpen(false); setText(""); });
    }
  }, [route, cancelOperation]);

  useEffect(() => {
    function interrupt() {
      if (opRef.current) cancel();
    }
    function visibility() { if (document.hidden) interrupt(); }
    function navigation(event: MouseEvent) {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (link.hasAttribute("data-voice-consumed")) return;
      if (link.origin === window.location.origin && recordingRoute(link.pathname, link.search) !== recordingRoute(window.location.pathname, window.location.search)) interrupt();
    }
    window.addEventListener("blur", interrupt);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("click", navigation, true);
    return () => {
      window.removeEventListener("blur", interrupt);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("click", navigation, true);
      cancelOperation();
    };
  }, [cancel, cancelOperation]);

  useEffect(() => {
    if (!restoredShown.current && ((pending && pending.source === null) || (feedback && feedback.source === null))) {
      restoredShown.current = true;
      queueMicrotask(() => setOpen(true));
    }
    if (feedback?.result.status === "success" && (feedback.source === source || feedback.source === null)) {
      queueMicrotask(() => setText(""));
      router.refresh();
    }
  }, [feedback, pending, router]);

  useEffect(() => {
    if (!open) return;
    return lockPageScroll();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      const target = previous instanceof HTMLElement && previous !== document.body && previous.isConnected ? previous
        : Array.from(document.querySelectorAll<HTMLElement>('a[aria-keyshortcuts="Space"]')).find((link) => link.getClientRects().length > 0);
      target?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    }
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, close]);

  useEffect(() => {
    if (open && dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
      dialogRef.current.focus({ preventScroll: true });
    }
  }, [open, stage, phase, ownFeedback, showTaskList, selectedTaskId, tasks]);

  const capturing = stage === "permission" || stage === "recording" || stage === "limit";
  const working = capturing || ownPending !== null;
  const selectedUnknown = selectedTask?.phase === "unknown" || selectedTask?.phase === "processing";
  const targetName = selectedTask?.target?.ledgerName ?? ownPending?.target?.ledgerName ?? (capturing ? recordingLedgerName : null)
    ?? ownFeedback?.target?.ledgerName ?? selection?.ledgerName ?? ledgerName;
  // Keep initialization's ready update from forcing streamed context consumers into client rendering before hydration.
  const controls = useMemo(() => ({ begin, finish, cancel, armCancel: setArmed, hint: labels.hint }),
    [begin, finish, cancel, labels.hint]);
  return <VoiceContext.Provider value={controls}>
    {children}
    {backgroundActive ? <span data-apk-update-blocked="true" hidden /> : null}
    <VoiceTaskFeedback locale={locale} paused={open} onSelect={selectTask} onOpenList={() => {
      setShowTaskList(true); setSelectedTaskId(null); setOpen(true);
    }} />
    {(pending || feedback) && !open ? <button data-bottom-actions className="fixed bottom-24 right-4 z-40 rounded-full bg-[var(--bb-primary)] px-4 py-3 text-sm text-white shadow-lg md:bottom-6"
      onClick={() => { setVisibleRequestId(pending?.requestId ?? feedback?.result.requestId ?? null); setOpen(true); }} type="button">{pending ? labels.resume : labels.result}</button> : null}
    {open ? <div className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/30 p-3 sm:items-center" data-testid="voice-overlay">
      <div aria-label={labels.title} aria-modal="true" className="ios-panel max-h-[85dvh] w-full max-w-lg overflow-y-auto overscroll-contain p-5 shadow-xl outline-none"
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),a[href]') ?? []);
            const first = elements[0]; const last = elements.at(-1);
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }} ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{labels.title}</h2>
          <button aria-label={labels.close} className="bb-tap flex h-11 w-11 items-center justify-center rounded-full" onClick={close} type="button"><X aria-hidden="true" className="h-5 w-5" /></button>
        </div>
        {showTaskList ? <VoiceTaskList tasks={tasks} locale={locale} onSelect={selectTask} onClose={close} /> : <>
        <p className="mt-2 text-xs leading-relaxed text-[var(--bb-muted)]">{labels.disclosure}</p>
        {targetName ? <p className="mt-2 text-xs text-[var(--bb-muted)]">{getMessages(locale).common.targetLedger} · {getLedgerDisplayName(targetName, locale)}</p> : null}
        {capturing ? <div className="space-y-3 py-7 text-center" role="status">
          <Mic aria-hidden="true" className={`mx-auto h-9 w-9 ${armed ? "text-red-600" : "text-[var(--bb-primary)]"}`} />
          <p className="font-semibold">{stage === "permission" ? labels.permission : stage === "limit" ? labels.limit : labels.recording}</p>
          <p className="text-2xl tabular-nums">{Math.floor(elapsed)} / 60 s</p>
          <p className={armed ? "text-red-700" : "text-[var(--bb-muted)]"}>{armed ? labels.cancelArmed : labels.release}</p>
        </div> : null}
        {ownPending ? <div className="space-y-3 py-4" role="status">
          <p>{phase === "submitting" ? labels.accounting : phase === "unknown" ? natural.unknownTitle : natural.stillProcessing}</p>
          <p className="text-sm text-[var(--bb-muted)]">{phase === "unknown" ? natural.unknownDescription : labels.pending}</p>
          {phase !== "submitting" ? <button className="min-h-11 rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60 w-full" onClick={() => { void controller.confirm(); }} type="button">{labels.confirm}</button> : null}
        </div> : null}
        {selectedUnknown ? <div className="space-y-3 py-4" role="status">
          <p>{selectedTask.phase === "unknown" ? natural.unknownTitle : natural.stillProcessing}</p>
          <p className="text-sm text-[var(--bb-muted)]">{labels.backgroundPending}</p>
          <button className="min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm" onClick={() => { void queue.confirm(selectedTask.id); }} type="button">{labels.confirm}</button>
        </div> : null}
        {selectedTask?.error ? <p className="my-4 text-sm text-amber-800" role="alert">
          {labels.errors[Object.hasOwn(labels.errors, selectedTask.error) ? selectedTask.error as keyof typeof labels.errors : "unavailable"]}
        </p> : null}
        {notice ? <p className="my-4 text-sm text-amber-800" role="alert">{notice}</p> : null}
        {!ownPending ? <div className="my-4"><NaturalLanguageFeedback feedback={ownFeedback} locale={locale} text={text} /></div> : null}
        {!working && (!selectedTask || selectedTask.phase === "failed") && text ? <form className="my-4 space-y-3" data-desktop-update-dirty={Boolean(text.trim()) || undefined} onSubmit={(event) => {
          event.preventDefault();
          if (!processing.ensure("ai")) return;
          if (selectedTask) {
            try { queue.enqueueText(selectedTask.id, text, locale); }
            catch { setNotice(labels.busy); return; }
            setSelectedTaskId(null); setText(""); setOpen(false);
            return;
          }
          const token = controller.reserve();
          if (!token) { setNotice(labels.busy); return; }
          const outcome = controller.submit(source, text, locale, token);
          setNotice(outcome === "storage-unavailable" ? labels.errors.storage : null);
        }}>
          <label className="block space-y-2 text-sm"><span>{labels.edit}</span><textarea className="ios-field min-h-28" value={text}
            onChange={(event) => { setText(event.target.value); controller.clearFeedback(source); }} /></label>
          <button className="min-h-11 rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60 w-full" type="submit">{labels.submit}</button>
        </form> : null}
        <div className="mt-4 flex flex-wrap gap-3">
          {selectedTask?.phase === "failed" ? <button className="min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm" onClick={() => { queue.dismiss(selectedTask.id); close(); }} type="button">{labels.dismiss}</button> : null}
          {capturing ? <>
            <button className="min-h-11 rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60 flex-1" disabled={stage === "permission"} onClick={finish} type="button">{labels.stop}</button>
            <button className="min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm font-medium" onClick={cancel} type="button">{labels.cancel}</button>
          </> : !working ? <button className="min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm font-medium flex-1" onClick={begin} type="button">{ownFeedback || notice || text ? labels.retry : labels.start}</button> : null}
          {ownFeedback?.result.status === "success" ? <Link className="min-h-11 rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60 flex-1 text-center" href={buildEntryRecordsHref(ownFeedback.target?.context ?? selectedTask?.target?.context)} onClick={close}>{labels.records}</Link> : null}
        </div>
        </>}
      </div>
    </div> : null}
  </VoiceContext.Provider>;
}

export function useVoiceAccounting() {
  const value = useContext(VoiceContext);
  if (!value) throw new Error("Voice entry requires its application provider");
  return value;
}
