"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, X } from "lucide-react";
import { NaturalLanguageFeedback } from "@/components/natural-language-feedback";
import { useVoiceAccountingQueue } from "@/components/natural-language-provider";
import { getLedgerDisplayName, getMessages, type Locale } from "@/lib/i18n";
import { buildEntryRecordsHref } from "@/lib/transactions/result-records-link";
import type { VoiceTask } from "@/lib/voice/accounting-queue";

function taskLabel(task: VoiceTask, locale: Locale) {
  return getMessages(locale).add.voice.taskStates[task.phase];
}

export function VoiceTaskList({ tasks, locale, onSelect, onClose }: {
  tasks: VoiceTask[]; locale: Locale; onSelect: (task: VoiceTask) => void; onClose: () => void;
}) {
  const labels = getMessages(locale).add.voice;
  return <ul className="mt-4 space-y-2" data-testid="voice-task-list">
    {tasks.map((task, index) => <li className="rounded-xl bg-[var(--bb-warm-surface)] p-3" key={task.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-[var(--bb-muted)]">{labels.taskNumber(index + 1)}</p>
          <p className="text-sm font-medium" role="status">{taskLabel(task, locale)}</p>
          {task.target ? <p className="break-words text-xs text-[var(--bb-muted)]">{getLedgerDisplayName(task.target.ledgerName, locale)}</p> : null}
        </div>
        {task.phase === "failed" || task.phase === "unknown" || task.phase === "processing" ?
          <button className="bb-tap min-h-11 shrink-0 rounded-lg px-2 text-sm font-medium text-[var(--bb-primary)]" onClick={() => onSelect(task)} type="button">
            {task.phase === "failed" ? labels.handle : labels.viewStatus}
          </button> : task.phase === "success" ?
          <Link className="bb-tap flex min-h-11 shrink-0 items-center rounded-lg px-2 text-sm font-medium text-[var(--bb-primary)]" href={buildEntryRecordsHref(task.target?.context)} onClick={onClose}>{labels.records}</Link> : null}
      </div>
      {task.phase === "success" ? <div className="mt-2"><NaturalLanguageFeedback feedback={task.feedback} locale={locale} text="" /></div> : null}
    </li>)}
  </ul>;
}

export function VoiceTaskFeedback({ locale, paused, onOpenList, onSelect }: {
  locale: Locale; paused: boolean; onOpenList: () => void; onSelect: (task: VoiceTask) => void;
}) {
  const { queue, tasks } = useVoiceAccountingQueue();
  const labels = getMessages(locale).add.voice;
  const router = useRouter();
  const pathname = usePathname();
  const [visible, setVisible] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const active = tasks.filter((task) => task.phase !== "success" && task.phase !== "failed");
  const queued = active.filter((task) => task.phase === "queued").length;
  const attention = tasks.filter((task) => task.phase === "failed" || task.phase === "unknown" || task.phase === "processing");
  const current = active[0] ?? attention[0];
  const success = tasks.find((task) => task.phase === "success");
  const requestId = success?.id;
  const shown = visible && !paused && tasks.length > 0;

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    queueMicrotask(update);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (requestId) router.refresh();
  }, [requestId, router]);
  useEffect(() => {
    if (!requestId || !visible || paused) return;
    const timer = setTimeout(() => queue.dismiss(requestId), 5000);
    return () => clearTimeout(timer);
  }, [requestId, queue, visible, paused]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!shown || !panel) return;
    let frame = 0;
    const resize = new ResizeObserver(() => schedule());
    const update = () => {
      frame = 0;
      let top = window.innerHeight;
      for (const actions of document.querySelectorAll<HTMLElement>("[data-bottom-actions]")) {
        if (!actions.getClientRects().length || getComputedStyle(actions).position !== "fixed") continue;
        resize.observe(actions);
        const rect = actions.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < window.innerHeight) top = Math.min(top, rect.top);
      }
      const bottom = top < window.innerHeight ? `${Math.ceil(window.innerHeight - top + 12)}px` : "";
      if (panel.style.getPropertyValue("--bb-voice-bottom") !== bottom) {
        if (bottom) panel.style.setProperty("--bb-voice-bottom", bottom);
        else panel.style.removeProperty("--bb-voice-bottom");
      }
    };
    function schedule() { if (!frame) frame = requestAnimationFrame(update); }
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [shown, pathname]);

  return <>
    <div aria-atomic="true" className="sr-only" role="status">{shown && current ? [taskLabel(current, locale),
      current.target ? getLedgerDisplayName(current.target.ledgerName, locale) : "",
      active.length > 1 ? labels.taskSummary(active.length - queued, queued) : ""].filter(Boolean).join(" · ") : ""}</div>
    {shown ? <div className="fixed inset-x-4 bottom-[var(--bb-voice-bottom,calc(var(--bb-mobile-nav-height)+env(safe-area-inset-bottom)+0.75rem))] z-40 mx-auto max-w-lg rounded-2xl border border-[var(--bb-warm-line)] bg-[var(--bb-surface)] p-3 shadow-[var(--bb-shadow-md)] md:bottom-[var(--bb-voice-bottom,1.5rem)]" data-testid="voice-task-status" ref={panelRef}>
      {current ? <div className="flex items-center gap-3">
        {current.phase === "failed" ? <CircleAlert aria-hidden="true" className="h-5 w-5 shrink-0 text-amber-800" /> : <LoaderCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--bb-muted)] motion-safe:animate-spin" />}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold">{taskLabel(current, locale)}</p>
          {current.target ? <p className="break-words text-xs text-[var(--bb-muted)]">{getLedgerDisplayName(current.target.ledgerName, locale)}</p> : null}
          {active.length > 1 ? <p className="text-xs text-[var(--bb-muted)]">{labels.taskSummary(active.length - queued, queued)}</p> : null}
        </div>
        <button className="bb-tap min-h-11 shrink-0 rounded-lg px-2 text-sm font-medium text-[var(--bb-primary)]" onClick={onOpenList} type="button">{labels.viewStatus}</button>
      </div> : null}
      {attention.length ? <button className="bb-tap mt-1 min-h-11 w-full rounded-lg px-2 text-left text-sm font-medium text-amber-800" onClick={() => onSelect(attention[0])} type="button">{labels.attention(attention.length)}</button> : null}
      {success ? <div className={`flex items-start gap-3 ${current ? "mt-3 border-t border-[var(--bb-warm-line)] pt-3" : ""}`} data-testid="voice-success-notice">
        <CircleCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-[var(--bb-income-ink)]" />
        <div className="min-w-0 flex-1">
          <NaturalLanguageFeedback feedback={success.feedback} locale={locale} text="" />
          <Link className="bb-tap mt-1 inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-[var(--bb-primary)]" href={buildEntryRecordsHref(success.target?.context)} onClick={() => queue.dismiss(success.id)}>{labels.records}</Link>
          {!current && tasks.length > 1 ? <button className="bb-tap ml-3 min-h-11 rounded-lg text-sm font-medium text-[var(--bb-primary)]" onClick={onOpenList} type="button">{labels.viewStatus}</button> : null}
        </div>
        <button aria-label={labels.close} className="bb-tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full" onClick={() => queue.dismiss(success.id)} type="button"><X aria-hidden="true" className="h-4 w-4" /></button>
      </div> : null}
    </div> : null}
  </>;
}
