"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { getMessages, type Locale } from "@/lib/i18n";
import type { ProcessingChoices } from "@/lib/processing/types";
import { identityButtonClass } from "@/components/identity-form";
import styles from "./processing-preferences-form.module.css";

export function ProcessingPreferencesForm({ locale, onSaved, embedded = false }: { locale: Locale; onSaved?: (choices: ProcessingChoices) => void; embedded?: boolean }) {
  const labels = getMessages(locale).safeguards.processing;
  const [choices, setChoices] = useState<ProcessingChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"error" | "saved" | null>(null);
  const load = useCallback(async () => {
    setStatus(null);
    try {
      const response = await fetch("/api/account/processing", { cache: "no-store" });
      if (!response.ok) throw new Error("Unavailable");
      setChoices(await response.json());
    } catch { setStatus("error"); }
  }, []);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!choices || busy) return;
    setBusy(true); setStatus(null);
    try {
      const response = await fetch("/api/account/processing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ai: choices.ai, voice: choices.voice }) });
      if (!response.ok) throw new Error("Unavailable");
      const saved: ProcessingChoices = await response.json();
      setChoices(saved); setStatus("saved"); onSaved?.(saved);
      window.dispatchEvent(new Event("billboard-processing-change"));
    } catch { setStatus("error"); }
    finally { setBusy(false); }
  }
  return <section className={embedded ? "space-y-4 py-4" : "ios-panel my-4 space-y-4 p-5 md:p-6"}>
    {!embedded ? <h2 className="text-[15px] font-medium text-[var(--bb-ink)]">{labels.title}</h2> : null}
    <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.description}</p>
    {!choices ? <div className="space-y-2"><p className="text-sm" role="status">{status === "error" ? labels.failed : labels.loading}</p>{status === "error" ? <button className={identityButtonClass} onClick={() => void load()} type="button">{labels.retry}</button> : null}</div> : <form className="space-y-5" onSubmit={save}>
      <p className="text-xs leading-6 text-[var(--bb-muted)]">{labels.services} · {labels[choices.services.primary]} · {choices.services.speechConfigured ? labels.doubao : labels.notConfigured}</p>
      {(["ai", "voice"] as const).map((capability) => <label className={styles.choiceRow} key={capability}>
        <input checked={choices[capability]} className={styles.choice} disabled={busy} onChange={(event) => setChoices({ ...choices, [capability]: event.currentTarget.checked })} type="checkbox" />
        <span className="min-w-0 space-y-1"><span className="block text-sm font-medium">{labels[capability]}</span><span className="block text-sm leading-6 text-[var(--bb-muted)]">{capability === "ai" ? labels.aiHelp : labels.voiceHelp}</span></span>
      </label>)}
      <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.continuation}</p>
      <div className="flex flex-wrap items-center gap-4"><button className={identityButtonClass} disabled={busy} type="submit">{busy ? labels.saving : labels.save}</button><Link className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href="/account/privacy">{labels.privacy}</Link></div>
      {status ? <p className="text-sm" role={status === "error" ? "alert" : "status"}>{status === "error" ? labels.failed : labels.saved}</p> : null}
    </form>}
  </section>;
}
