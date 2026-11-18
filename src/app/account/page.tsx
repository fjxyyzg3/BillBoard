import { getPageMetadata } from "@/lib/page-metadata";
import Link from "next/link";
import { redirect } from "next/navigation";
import { IdentityField, IdentityForm } from "@/components/identity-form";
import { IdentitySection } from "@/components/identity-section";
import { ProcessingPreferencesForm } from "@/components/processing-preferences-form";
import { requireAccountSession } from "@/lib/auth/session";
import { getAccountOverview } from "@/lib/identity/account";
import { IdentityError } from "@/lib/identity/shared";
import { formatLocaleDateTime, getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { changeOwnEmailAction, changeOwnPasswordAction, deactivateOwnAccountAction, revokeOwnSessionAction, verifyOwnEmailAction } from "./actions";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.identity.accountTitle);
}

export default async function AccountPage() {
  const session = await requireAccountSession().catch((error) => {
    if (error instanceof Error && error.message === "Unauthorized") redirect("/login?reason=session-expired");
    throw error;
  });
  const [overview, locale] = await Promise.all([getAccountOverview(session).catch((error) => {
    if (error instanceof IdentityError && error.code === "UNAUTHORIZED") redirect("/login?reason=session-expired");
    throw error;
  }), getServerLocale()]);
  const labels = getMessages(locale).identity;
  const lifecycle = getMessages(locale).safeguards.lifecycle;
  return <>
    <header className="space-y-2 py-6"><h1 className="text-2xl font-medium text-[var(--bb-ink)]">{labels.accountTitle}</h1><p className="text-sm text-[var(--bb-muted)]">{labels.accountDescription}</p></header>
    <IdentitySection description={labels.verificationHelp} title={labels.email}>
      <p className="break-all text-base font-medium text-[var(--bb-ink)]">{overview.email}</p><p className="mb-4 mt-2 text-sm text-[var(--bb-muted)]">{overview.emailVerifiedAt ? labels.verified : labels.unverified}</p>
      {!overview.emailVerifiedAt ? <IdentityForm action={verifyOwnEmailAction} labels={labels} submitLabel={labels.verifyEmail}><input name="locale" type="hidden" value={locale} /></IdentityForm> : null}
      <details className="mt-5 border-t border-[var(--bb-warm-line)] pt-4"><summary className="min-h-11 cursor-pointer text-sm font-medium text-[var(--bb-ink)]">{labels.emailChange}</summary><p className="mb-4 text-sm leading-6 text-[var(--bb-muted)]">{labels.emailChangeHelp}</p><IdentityForm action={changeOwnEmailAction} labels={labels} submitLabel={labels.submit}><input name="locale" type="hidden" value={locale} /><IdentityField autoComplete="email" label={labels.newEmail} maxLength={254} name="email" type="email" /><IdentityField autoComplete="current-password" label={labels.currentPassword} name="currentPassword" type="password" /></IdentityForm></details>
    </IdentitySection>
    <IdentitySection description={labels.passwordHelp} title={labels.passwordTitle}>
      <IdentityForm action={changeOwnPasswordAction} comparePasswords labels={labels} submitLabel={labels.changePassword}>
        <IdentityField autoComplete="current-password" label={labels.currentPassword} name="currentPassword" type="password" />
        <IdentityField autoComplete="new-password" label={labels.newPassword} minLength={8} name="newPassword" type="password" />
        <IdentityField autoComplete="new-password" label={labels.confirmPassword} minLength={8} name="confirmPassword" type="password" />
        <p className="text-xs text-[var(--bb-muted)]">{labels.passwordHint}</p>
      </IdentityForm>
    </IdentitySection>
    <IdentitySection description={labels.sessionsHelp} title={labels.sessionsTitle}>
      {overview.sessions.length === 0 ? <p className="text-sm text-[var(--bb-muted)]">{labels.noSessions}</p> : <ul className="divide-y divide-[var(--bb-warm-line)]">{overview.sessions.map((entry) => <li className="space-y-3 py-4 first:pt-0 last:pb-0" key={entry.id}>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-[var(--bb-ink)]">{entry.deviceLabel}</p>{entry.isCurrent ? <span className="rounded-full bg-stone-100 px-2 py-1 text-xs text-[var(--bb-muted)]">{labels.currentSession}</span> : null}</div>
        <dl className="space-y-1 text-xs text-[var(--bb-muted)]">{[[labels.loginAt, entry.loginAt], [labels.lastSeenAt, entry.lastSeenAt], [labels.expiresAt, entry.expiresAt]].map(([title, date]) => <div className="flex justify-between gap-3" key={String(title)}><dt>{String(title)}</dt><dd className="text-right tabular-nums">{formatLocaleDateTime(date as Date, locale)}</dd></div>)}</dl>
        <IdentityForm action={revokeOwnSessionAction} labels={labels} refresh submitLabel={entry.isCurrent ? labels.revokeCurrentSession : labels.revokeSession}><input name="sessionId" type="hidden" value={entry.id} /></IdentityForm>
      </li>)}</ul>}
    </IdentitySection>
    <ProcessingPreferencesForm locale={locale} />
    <IdentitySection description={lifecycle.deactivateHelp} title={lifecycle.deactivateTitle}>
      <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2">
        {session.householdId && session.memberId ? <Link className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-ink)]" href="/records">{lifecycle.exportLink}</Link> : null}
        <Link className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-ink)]" href="/account/privacy">{lifecycle.privacyLink}</Link>
      </div>
      <div className="[&_button]:text-[var(--ios-red)]"><IdentityForm action={deactivateOwnAccountAction} confirmation={lifecycle.deactivateConfirm} labels={labels} submitLabel={lifecycle.deactivateSubmit}>
        <IdentityField autoComplete="current-password" label={labels.currentPassword} name="currentPassword" type="password" />
      </IdentityForm></div>
    </IdentitySection>
    <Link className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-muted)]" href="/home">{labels.backToLedger}</Link>
  </>;
}
