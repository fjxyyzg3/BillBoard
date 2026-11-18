"use client";

import { EncryptionLogoutForm, forgetEncryptionIdentity } from "@/components/encryption-lifecycle";
import { useEffect, useState } from "react";
import Link from "next/link";
import { clearEntryBrowserState } from "@/lib/transactions/entry-context";
import { getEncryptionMessages, type Locale, type Messages } from "@/lib/i18n";

export function AccountAccessState({ labels, signOut, locale = "zh-CN" }: { labels: Messages["accountAccess"]; signOut: () => Promise<void>; locale?: Locale }) {
  const [clearFailed, setClearFailed] = useState(false);
  useEffect(() => {
    void forgetEncryptionIdentity().catch(() => setClearFailed(true));
    try {
      clearEntryBrowserState(window.sessionStorage);
      window.sessionStorage.removeItem("billboard:active-entry-context:v1");
    } catch { /* No household data or old request result is loaded into this screen. */ }
  }, []);

  return <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 py-12">
    <h1 className="bb-section-title">{labels.title}</h1>
    <p className="text-sm leading-relaxed text-[var(--bb-muted)]">{labels.description}</p>
    <p className="text-sm text-[var(--bb-muted)]">{labels.availability}</p>
    {clearFailed ? <p className="text-sm leading-6 text-[var(--bb-danger)]" role="alert">{getEncryptionMessages(locale).forgetFailed}</p> : null}
    <Link className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--bb-warm-line)] bg-white px-4 py-3 text-sm font-medium" href="/account">{labels.account}</Link>
    <EncryptionLogoutForm action={signOut} locale={locale}>
      <button className="min-h-11 w-full rounded-xl bg-[var(--bb-primary)] px-4 py-3 font-semibold text-white" type="submit">{labels.logout}</button>
    </EncryptionLogoutForm>
  </main>;
}
