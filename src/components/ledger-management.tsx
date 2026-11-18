"use client";

import { appendEncryption } from "@/lib/encryption/client";

import Link from "next/link";
import { BookOpen } from "lucide-react";
import { useId, useState, useTransition, type FormEvent } from "react";
import { manageLedgerAction, type LedgerActionResult } from "@/app/(app)/ledgers/actions";
import { getLedgerDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type { LedgerSummary } from "@/lib/ledgers/selection";

const secondary = "min-h-11 rounded-xl border border-[var(--bb-line-strong)] px-3 py-2 text-sm font-medium hover:bg-[var(--bb-warm-surface)] disabled:cursor-wait disabled:opacity-60";

export function LedgerManagement({ ledgers, role, locale }: { ledgers: LedgerSummary[]; role: "OWNER" | "MEMBER"; locale: Locale }) {
  const labels = getMessages(locale).ledgers;
  const nameId = useId();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<LedgerActionResult | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form);
    setResult(null);
    startTransition(async () => {
      let outcome: LedgerActionResult;
      try { outcome = await manageLedgerAction(appendEncryption(input)); }
      catch { outcome = { ok: false, code: "FAILED" }; }
      setResult(outcome);
      if (outcome.ok) { form.reset(); setEditing(null); setConfirmArchive(null); }
    });
  }

  return <div className="space-y-6" aria-busy={pending || undefined}>
    <section className="grid gap-4 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]" aria-labelledby={`${nameId}-create`}>
      <div className="space-y-2 lg:pt-4">
        <h2 className="text-base font-semibold" id={`${nameId}-create`}>{labels.create}</h2>
        <p className="text-sm leading-relaxed text-[var(--bb-muted)]">{labels.createDescription}</p>
      </div>
      <form className="ios-panel p-5" onSubmit={submit}>
        <input name="operation" type="hidden" value="create" />
        <label className="block space-y-2 text-sm font-medium" htmlFor={nameId}><span>{labels.newName}</span>
          <input className="ios-field" disabled={pending} id={nameId} maxLength={80} name="name" required />
        </label>
        <button className="mt-4 min-h-11 rounded-xl bg-[var(--bb-primary)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--bb-primary-hover)] disabled:opacity-60" disabled={pending} type="submit">{pending ? labels.working : labels.create}</button>
      </form>
    </section>
    {result ? <p className={`text-sm ${result.ok ? "text-[var(--bb-income-ink)]" : "text-[var(--bb-danger)]"}`} role={result.ok ? "status" : "alert"}>
      {result.ok ? labels.saved : labels.errors[result.code]}
    </p> : null}
    <section className="grid gap-4 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]" aria-labelledby={`${nameId}-list`}>
      <div className="space-y-2 lg:pt-4">
        <h2 className="text-base font-semibold" id={`${nameId}-list`}>{labels.list}</h2>
        <p className="text-sm leading-relaxed text-[var(--bb-muted)]">{labels.listDescription}</p>
        {role !== "OWNER" ? <p className="text-xs leading-relaxed text-[var(--bb-muted)]">{labels.ownerNotice}</p> : null}
      </div>
      <div className="ios-panel divide-y divide-[var(--bb-warm-line)]">
        {ledgers.map((ledger) => <div className="min-w-0 space-y-3 p-5" key={ledger.id}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span aria-hidden="true" className={`mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ledger.archivedAt ? "bg-[var(--bb-warm-surface)] text-[var(--bb-muted)]" : "bg-[var(--bb-accent-soft)] text-[var(--bb-accent)]"}`}><BookOpen className="h-[18px] w-[18px]" strokeWidth={1.6} /></span>
            <Link className="min-w-0 max-w-full break-words text-[15px] font-medium" href={`/records?ledger=${encodeURIComponent(ledger.id)}`}>{getLedgerDisplayName(ledger.name, locale)}</Link>
            {ledger.isDefault || ledger.archivedAt ? <span className="shrink-0 rounded-md bg-[var(--bb-warm-surface)] px-2 py-1 text-xs text-[var(--bb-muted)]">{ledger.archivedAt ? labels.archived : labels.default}</span> : null}
          </div>
          {editing === ledger.id ? <form className="space-y-3" onSubmit={submit}>
            <input name="operation" type="hidden" value="rename" /><input name="ledgerId" type="hidden" value={ledger.id} />
            <label className="block space-y-2 text-sm font-medium"><span>{labels.name}</span><input className="ios-field" defaultValue={ledger.name} disabled={pending} maxLength={80} name="name" required /></label>
            <div className="flex flex-wrap gap-2"><button className={secondary} disabled={pending} type="submit">{labels.save}</button><button className={secondary} disabled={pending} onClick={() => setEditing(null)} type="button">{labels.cancel}</button></div>
          </form> : <div className="flex flex-wrap gap-2">
            {!ledger.archivedAt ? <button className={secondary} disabled={pending} onClick={() => setEditing(ledger.id)} type="button">{labels.rename}</button> : null}
            {role === "OWNER" && !ledger.archivedAt && !ledger.isDefault ? <form onSubmit={submit}><input name="operation" type="hidden" value="default" /><input name="ledgerId" type="hidden" value={ledger.id} /><button className={secondary} disabled={pending} type="submit">{labels.setDefault}</button></form> : null}
            {role === "OWNER" && ledger.archivedAt ? <form onSubmit={submit}><input name="operation" type="hidden" value="restore" /><input name="ledgerId" type="hidden" value={ledger.id} /><button className={secondary} disabled={pending} type="submit">{labels.restore}</button></form> : null}
            {role === "OWNER" && !ledger.archivedAt && !ledger.isDefault && confirmArchive !== ledger.id ? <button className={secondary} disabled={pending} onClick={() => setConfirmArchive(ledger.id)} type="button">{labels.archive}</button> : null}
          </div>}
          {confirmArchive === ledger.id ? <form className="space-y-3 rounded-xl bg-[var(--bb-warm-surface)] p-3" onSubmit={submit}>
            <p className="text-sm leading-relaxed">{labels.archiveNotice(getLedgerDisplayName(ledger.name, locale))}</p>
            <input name="operation" type="hidden" value="archive" /><input name="ledgerId" type="hidden" value={ledger.id} />
            <div className="flex flex-wrap gap-2"><button className={`${secondary} text-[var(--bb-danger)]`} disabled={pending} type="submit">{labels.confirmArchive}</button><button className={secondary} disabled={pending} onClick={() => setConfirmArchive(null)} type="button">{labels.cancel}</button></div>
          </form> : null}
          {ledger.isDefault && role === "OWNER" ? <p className="text-xs leading-relaxed text-[var(--bb-muted)]">{labels.defaultNotice}</p> : null}
        </div>)}
      </div>
    </section>
  </div>;
}
