"use client";

import { getEncryptionInput } from "@/lib/encryption/client";
import { beginDesktopOperation } from "@/lib/desktop-updater";
import { saveIosExport } from "@/lib/ios-export";

import { Download } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { BottomSheet } from "@/components/bottom-sheet";
import { IosSelect } from "@/components/ios-select";
import styles from "./finance-b2.module.css";
import { getMessages, type Locale } from "@/lib/i18n";
import { isValidReportDate } from "@/lib/reports/report-range";

type Props = {
  ledgerId?: string;
  actorMemberId?: string;
  members?: Array<{ id: string; label: string }>;
  scopeName: string;
  from: string;
  to: string;
  locale: Locale;
};

export function RecordExport({ ledgerId, actorMemberId: currentActorMemberId, members = [], scopeName, from: currentFrom, to: currentTo, locale }: Props) {
  const labels = getMessages(locale).safeguards.exports;
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(currentFrom);
  const [to, setTo] = useState(currentTo);
  const [actorMemberId, setActorMemberId] = useState(currentActorMemberId ?? "");
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const formId = useId();
  const mounted = useRef(true);
  const currentRange = useRef({ from: currentFrom, to: currentTo });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  function show() {
    if (currentRange.current.from !== currentFrom || currentRange.current.to !== currentTo) {
      setFrom(currentFrom);
      setTo(currentTo);
      currentRange.current = { from: currentFrom, to: currentTo };
    }
    setStatus("");
    setOpen(true);
  }

  function close() {
    controller.current?.abort();
    setOpen(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    if (!isValidReportDate(from) || !isValidReportDate(to) || from > to) {
      setStatus(labels.invalid);
      return;
    }
    const finishDesktopOperation = beginDesktopOperation();
    if (!finishDesktopOperation) return;
    const pending = new AbortController();
    controller.current = pending;
    setWorking(true);
    setStatus("");
    try {
      const response = await fetch("/api/records/export", {
        method: "POST", cache: "no-store", credentials: "same-origin", signal: pending.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ledgerId, actorMemberId: actorMemberId || undefined, from, to, locale, encryption: getEncryptionInput() }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => undefined) as { error?: string } | undefined;
        const code = result?.error;
        if (mounted.current && !pending.signal.aborted) setStatus(code === "unauthorized" ? labels.unauthorized : code === "busy" ? labels.busy : code === "too_large" ? labels.tooLarge : code === "invalid_input" ? labels.invalid : labels.failed);
        return;
      }
      if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") throw new Error("invalid_response");
      const blob = await response.blob();
      if (!mounted.current || pending.signal.aborted) return;
      const filename = `billboard-records_${from}_${to}.xlsx`;
      const nativeResult = await saveIosExport(blob, filename, pending.signal);
      if (!mounted.current || pending.signal.aborted) return;
      if (nativeResult) {
        setStatus(nativeResult === "saved" ? labels.complete : "");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(labels.complete);
    } catch {
      if (mounted.current && !pending.signal.aborted) setStatus(labels.failed);
    } finally {
      finishDesktopOperation();
      if (mounted.current && controller.current === pending) {
        controller.current = undefined;
        setWorking(false);
      }
    }
  }

  return <>
    <span data-desktop-update-blocked={working || undefined} hidden />
    <button
      className={`${styles.toolbarAction} inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border transition hover:bg-[var(--bb-accent-soft)] active:scale-[0.97] motion-reduce:active:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ios-blue)]`}
      data-testid="records-export-button" onClick={show} ref={trigger} type="button"
    >
      <Download aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} /><span>{labels.open}</span>
    </button>
    <BottomSheet closeLabel={labels.cancel} initialFocusRef={firstField} onClose={close} open={open} returnFocusRef={trigger} title={labels.title}
      footer={<button className={`${styles.primaryButton} bb-tap w-full bg-[var(--bb-primary)] px-4 text-white disabled:opacity-60`} disabled={working} form={formId} type="submit">{working ? labels.working : labels.submit}</button>}
    >
      <form className="space-y-4" id={formId} onSubmit={submit}>
        <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.description}</p>
        <div><p className="text-sm text-[var(--bb-muted)]">{labels.scope}</p><p className="mt-1 break-words font-semibold text-[var(--bb-ink)]">{scopeName}</p></div>
        <label className="block min-w-0 space-y-2 text-sm font-medium text-[var(--bb-ink)]">{labels.memberLabel}
          <IosSelect disabled={working} onChange={(event) => setActorMemberId(event.target.value)} value={actorMemberId}
            options={[{ value: "", label: labels.allMembers }, ...members.map((member) => ({ value: member.id, label: member.label }))]} />
        </label>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="block min-w-0 space-y-2 text-sm font-medium text-[var(--bb-ink)]">{labels.from}<input className="ios-field min-h-12 w-full min-w-0" disabled={working} onChange={(event) => setFrom(event.target.value)} ref={firstField} required type="date" value={from} /></label>
          <label className="block min-w-0 space-y-2 text-sm font-medium text-[var(--bb-ink)]">{labels.to}<input className="ios-field min-h-12 w-full min-w-0" disabled={working} onChange={(event) => setTo(event.target.value)} required type="date" value={to} /></label>
        </div>
        <p aria-live="polite" className="text-sm leading-6 text-[var(--bb-ink)]" role="status">{status}</p>
      </form>
    </BottomSheet>
  </>;
}
