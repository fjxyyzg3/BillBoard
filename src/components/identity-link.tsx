"use client";

import { forgetEncryptionIdentity } from "@/components/encryption-lifecycle";

import Link from "next/link";
import { SessionProvider, signIn } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { acceptInvitationAction, completeIdentityLinkAction, getLinkAccountAction, previewInvitationAction, signOutLinkAccountAction, startInvitedRegistrationAction } from "@/app/(auth)/account-link/actions";
import { confirmAccessApplicationAction } from "@/app/help/actions";
import { formatLocaleDateTime, getMessages, type Locale, type Messages } from "@/lib/i18n";
import { LanguageToggle } from "./language-toggle";
import { IdentityField, IdentityForm, identityButtonClass, identityErrorMessage } from "./identity-form";
import { parseIdentityLinkFragment, type IdentityLinkToken } from "./identity-link-token";
import type { IdentityAccount, IdentityFormResult, IdentityResult } from "./identity-types";

type Preview = Extract<Awaited<ReturnType<typeof previewInvitationAction>>, { ok: true }>["data"];

export function IdentityLink({ labels, locale, authBasePath }: { labels: Messages["identity"]; locale: Locale; authBasePath: string }) {
  const [link, setLink] = useState<IdentityLinkToken | null | undefined>(undefined);
  const captured = useRef<IdentityLinkToken | null | undefined>(undefined);
  const [preview, setPreview] = useState<IdentityResult<Preview> | null>(null);
  const [account, setAccount] = useState<IdentityAccount | null>(null);
  const [accountReady, setAccountReady] = useState(false);
  const [mode, setMode] = useState<"register" | "login">("register");
  const [done, setDone] = useState<IdentityLinkToken["kind"] | null>(null);

  useEffect(() => {
    let active = true;
    let version = 0;
    function load(newFragment = false) {
      const requestVersion = ++version;
      const browser = window as Window & { __bbIdentityLinkFragment?: string };
      if (newFragment || captured.current === undefined) {
        const fragment = newFragment ? window.location.hash : browser.__bbIdentityLinkFragment ?? window.location.hash;
        delete browser.__bbIdentityLinkFragment;
        history.replaceState(history.state, "", window.location.pathname);
        captured.current = parseIdentityLinkFragment(fragment);
      }
      const initial = captured.current;
      void Promise.resolve().then(async () => {
        if (!active || requestVersion !== version) return;
        setLink(initial);
        setDone(null);
        setPreview(null);
        setAccountReady(false);
        if (initial?.kind !== "invite") return;
        const [invitationResult, accountResult] = await Promise.all([previewInvitationAction(initial.token), getLinkAccountAction()]);
        if (!active || requestVersion !== version) return;
        setPreview(invitationResult);
        if (accountResult.ok) setAccount(accountResult.data);
        setAccountReady(true);
      }).catch(() => {
        if (active && requestVersion === version) { setPreview({ ok: false, code: "SERVICE_UNAVAILABLE" }); setAccountReady(true); }
      });
    }
    const onHashChange = () => load(true);
    load();
    window.addEventListener("hashchange", onHashChange);
    return () => { active = false; window.removeEventListener("hashchange", onHashChange); };
  }, []);

  async function refreshAccount(): Promise<IdentityFormResult> {
    const result = await getLinkAccountAction();
    if (!result.ok) return result;
    setAccount(result.data);
    return { ok: true, data: { message: "saved" } };
  }

  const invitation = preview?.ok ? preview.data : null;
  const platform = invitation?.purpose === "PLATFORM";
  const applicationLabels = getMessages(locale).accessApplication;
  const isApplication = link?.kind === "application" || done === "application";
  const title = isApplication ? applicationLabels.confirmTitle : link?.kind === "invite" ? labels.inviteTitle : link?.kind === "reset" ? labels.resetPassword : link?.kind === "registration" ? labels.confirmRegistration : labels.linkTitle;
  return <SessionProvider basePath={authBasePath} session={null}>
    <main className="mx-auto min-h-dvh w-full max-w-lg space-y-5 px-5 py-8 sm:py-12">
      <div className="flex items-center justify-between gap-3"><p className="text-base font-medium text-[var(--bb-primary)]">BillBoard</p><LanguageToggle labels={getMessages(locale).language} locale={locale} /></div>
      <header className="space-y-2"><h1 className="text-2xl font-medium text-[var(--bb-ink)]">{title}</h1><p className="text-sm leading-6 text-[var(--bb-muted)]">{isApplication ? applicationLabels.confirmDescription : labels.linkDescription}</p></header>
      {done ? <div className="space-y-4 ios-panel p-5"><p role="status">{isApplication ? applicationLabels.pending : labels.saved}</p><Link className={identityButtonClass} href={isApplication ? "/help" : "/account"}>{isApplication ? applicationLabels.back : labels.openAccount}</Link></div> : link === undefined ? <p className="text-sm text-[var(--bb-muted)]" role="status">{labels.working}</p> : !link ? <div className="space-y-3"><p className="text-sm text-[var(--bb-muted)]" role="alert">{labels.linkInvalid}</p><p className="text-sm text-[var(--bb-muted)]">{labels.linkReload}</p></div> : link.kind === "application" ? <section className="space-y-4 ios-panel p-5">
        <IdentityForm action={() => confirmAccessApplicationAction(link.token)} labels={labels} onSuccess={() => { captured.current = null; setLink(null); setDone("application"); }} submitLabel={applicationLabels.confirm} />
      </section> : link.kind === "invite" ? <>
        {!preview || !accountReady ? <p className="text-sm text-[var(--bb-muted)]" role="status">{labels.working}</p> : !preview.ok ? <div className="space-y-3"><p className="text-sm text-[var(--ios-red)]" role="alert">{identityErrorMessage(preview.code, labels)}</p><IdentityForm action={async () => { const result = await previewInvitationAction(link.token); setPreview(result); return result.ok ? { ok: true, data: { message: "saved" } } : result; }} labels={labels} submitLabel={labels.retry} /></div> : invitation ? <>
          <section className="space-y-3 ios-panel p-5"><h2 className="text-base font-medium">{platform ? labels.platformTarget : labels.householdTarget}</h2><p className="text-sm leading-6 text-[var(--bb-muted)]">{platform ? labels.platformDescription : labels.householdInviteDescription}</p><dl className="space-y-3 text-sm"><div><dt className="text-[var(--bb-muted)]">{labels.invitedEmail}</dt><dd className="mt-1 break-all font-medium">{invitation.email}</dd></div>{!platform ? <div><dt className="text-[var(--bb-muted)]">{labels.targetHousehold}</dt><dd className="mt-1 break-words font-medium">{invitation.householdName}</dd></div> : null}<div><dt className="text-[var(--bb-muted)]">{labels.invitationExpires}</dt><dd className="mt-1 tabular-nums">{formatLocaleDateTime(new Date(invitation.expiresAt), locale)}</dd></div></dl></section>
          <section className="space-y-4 ios-panel p-5">
            {account ? <>
              <p className="break-all text-sm text-[var(--bb-muted)]">{labels.signedInAs}: <span className="font-medium text-[var(--bb-ink)]">{account.email}</span></p>
              {account.hasHousehold ? <p className="text-sm leading-6" role="alert">{labels.membershipExists}</p> : account.email.toLowerCase() !== invitation.email.toLowerCase() ? <p className="text-sm leading-6" role="alert">{labels.invitationEmailMismatch}</p> : !account.emailVerifiedAt ? <><p className="text-sm leading-6">{labels.verifyBeforeAccept}</p><Link className={identityButtonClass} href="/account" rel="noopener noreferrer" target="_blank">{labels.openAccount}</Link><IdentityForm action={refreshAccount} labels={labels} submitLabel={labels.refreshAccount} /></> : <IdentityForm action={(form) => acceptInvitationAction(link.token, form)} confirmation={platform ? labels.platformDescription : labels.householdInviteDescription} labels={labels} submitLabel={labels.acceptInvitation}><IdentityField autoComplete="nickname" defaultValue={account.displayName} label={labels.memberName} maxLength={50} name="memberName" />{platform ? <IdentityField label={labels.householdName} maxLength={80} name="householdName" /> : null}</IdentityForm>}
              <IdentityForm action={async () => { await forgetEncryptionIdentity(); await signOutLinkAccountAction(); setAccount(null); setMode("login"); return { ok: true, data: { message: "saved" } }; }} labels={labels} submitLabel={labels.switchAccount} />
            </> : <>
              <div aria-label={labels.account} className="bb-segmented bb-segmented--spaced bb-segmented--neutral grid grid-cols-2 gap-1 rounded-xl bg-[var(--bb-warm-surface)] p-1" role="tablist">{(["register", "login"] as const).map((value) => <button aria-selected={mode === value} className={`min-h-11 rounded-lg px-3 text-sm transition-colors ${mode === value ? "font-medium text-[var(--bb-primary)]" : "text-[var(--bb-muted)]"}`} key={value} onClick={() => setMode(value)} role="tab" type="button">{value === "register" ? labels.register : labels.existingAccount}</button>)}</div>
              {mode === "register" ? <><p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.registrationHelp}</p><IdentityForm action={(form) => startInvitedRegistrationAction(link.token, form)} comparePasswords labels={labels} submitLabel={labels.registerAndVerify}><input name="locale" type="hidden" value={locale} /><IdentityField autoComplete="name" label={labels.displayName} maxLength={80} name="displayName" /><IdentityField autoComplete="nickname" label={labels.memberName} maxLength={50} name="memberName" />{platform ? <IdentityField label={labels.householdName} maxLength={80} name="householdName" /> : null}<IdentityField autoComplete="new-password" label={labels.newPassword} minLength={8} name="newPassword" type="password" /><IdentityField autoComplete="new-password" label={labels.confirmPassword} minLength={8} name="confirmPassword" type="password" /><p className="text-xs text-[var(--bb-muted)]">{labels.passwordHint}</p></IdentityForm></> : <IdentityForm action={async (form) => {
                const login = () => signIn("credentials", { email: invitation.email, password: form.get("password"), redirect: false });
                let result = await login();
                if (result?.error === "MissingCSRF") result = await login();
                if (result?.error) return { ok: false, code: result.code === "rate_limited" ? "RATE_LIMITED" : "CREDENTIALS_INVALID" };
                return refreshAccount();
              }} labels={labels} submitLabel={labels.signInHere}><IdentityField autoComplete="current-password" label={labels.currentPassword} name="password" type="password" /></IdentityForm>}
            </>}
          </section>
        </> : null}
      </> : <section className="space-y-4 ios-panel p-5">
        {link.kind === "reset" ? <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.resetHelp}</p> : null}
        <IdentityForm action={(form) => completeIdentityLinkAction(link.kind as "verify" | "registration" | "reset", link.token, form)} comparePasswords={link.kind === "reset"} labels={labels} onSuccess={() => { captured.current = null; setLink(null); setDone(link.kind); }} submitLabel={link.kind === "reset" ? labels.resetPassword : link.kind === "registration" ? labels.confirmRegistration : labels.confirmVerification}>
          {link.kind === "reset" ? <><IdentityField autoComplete="new-password" label={labels.newPassword} minLength={8} name="newPassword" type="password" /><IdentityField autoComplete="new-password" label={labels.confirmPassword} minLength={8} name="confirmPassword" type="password" /><p className="text-xs text-[var(--bb-muted)]">{labels.passwordHint}</p></> : null}
        </IdentityForm>
      </section>}
      {done !== "application" ? <Link className="inline-flex min-h-11 items-center text-sm text-[var(--bb-muted)]" href={isApplication ? "/help" : "/login"}>{isApplication ? applicationLabels.back : labels.backToLogin}</Link> : null}
    </main>
  </SessionProvider>;
}
