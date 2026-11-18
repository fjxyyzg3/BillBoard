import { getPageMetadata } from "@/lib/page-metadata";
import { IdentityField, IdentityForm } from "@/components/identity-form";
import { IdentitySection } from "@/components/identity-section";
import { IdentityInvitations } from "@/components/identity-invitations";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccountSession, requireAppSession } from "@/lib/auth/session";
import { getHouseholdManagement } from "@/lib/identity/households";
import { formatLocaleDateTime, getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { changeHouseholdMembershipAction, createHouseholdInvitationAction, revokeHouseholdInvitationAction } from "../actions";
import { EncryptionSettings } from "@/components/encryption-settings";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.identity.householdTitle);
}

export default async function HouseholdPage() {
  const account = await requireAccountSession().catch((error) => {
    if (error instanceof Error && error.message === "Unauthorized") redirect("/login?reason=session-expired");
    throw error;
  });
  const locale = await getServerLocale();
  const labels = getMessages(locale).identity;
  const lifecycle = getMessages(locale).safeguards.lifecycle;
  if (!account.householdId || !account.memberId) return <div className="space-y-3 py-6"><h1 className="text-2xl font-medium text-[var(--bb-ink)]">{labels.noHousehold}</h1><p className="max-w-lg text-sm leading-6 text-[var(--bb-muted)]">{labels.noHouseholdHelp}</p></div>;
  const context = await requireAppSession();
  const overview = await getHouseholdManagement(context);
  const encryptionStatus = await getHouseholdEncryptionStatus(context);
  const owner = overview.role === "OWNER";
  // Request-time display only; the service rechecks expiry when an invitation is used.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  return <>
    <header className="space-y-2 py-6"><h1 className="text-2xl font-medium text-[var(--bb-ink)]">{labels.householdTitle}</h1><p className="break-words text-sm text-[var(--bb-muted)]">{overview.household.name} · {owner ? labels.owner : labels.member}</p></header>
    <IdentitySection description={labels.householdDescription} title={labels.membersTitle}>
      <ul className="divide-y divide-[var(--bb-warm-line)]">{overview.members.map((member) => <li className="space-y-3 py-4 first:pt-0 last:pb-0" key={member.id}>
        <div className="flex items-baseline justify-between gap-3"><p className="min-w-0 break-words text-sm font-medium text-[var(--bb-ink)]">{member.memberName}{member.id === overview.currentMemberId ? ` · ${labels.you}` : ""}</p><span className="shrink-0 text-xs text-[var(--bb-muted)]">{member.leftAt ? labels.left : member.role === "OWNER" ? labels.owner : labels.member}</span></div>
        <p className="text-xs text-[var(--bb-muted)]">{labels.joinedAt} <time className="tabular-nums">{formatLocaleDateTime(member.joinedAt, locale)}</time></p>
        {owner && !member.leftAt && member.id !== overview.currentMemberId ? <div className="space-y-3">{(["transfer", "remove"] as const).map((operation) => <details key={operation}><summary className="min-h-11 cursor-pointer text-sm font-medium text-[var(--bb-ink)]">{labels[operation]} · {member.memberName}</summary><div className="space-y-4 pb-2"><p className="text-sm leading-6 text-[var(--bb-muted)]">{operation === "transfer" ? labels.transferHelp : labels.removeHelp}</p><IdentityForm action={changeHouseholdMembershipAction} confirmation={operation === "transfer" ? labels.transferConfirm : labels.removeConfirm} labels={labels} refresh submitLabel={`${labels[operation]} · ${member.memberName}`}><input name="operation" type="hidden" value={operation} /><input name="memberId" type="hidden" value={member.id} /><IdentityField autoComplete="current-password" label={labels.currentPassword} name="currentPassword" type="password" /></IdentityForm></div></details>)}</div> : null}
      </li>)}</ul>
    </IdentitySection>
    {owner ? <>
      <IdentitySection description={labels.inviteHelp} title={labels.inviteMember}><IdentityForm action={createHouseholdInvitationAction} labels={labels} refresh submitLabel={labels.sendInvitation}><input name="locale" type="hidden" value={locale} /><IdentityField autoComplete="email" label={labels.invitedEmail} maxLength={254} name="email" type="email" /></IdentityForm></IdentitySection>
      <IdentitySection description={labels.inviteHelp} title={labels.invitationsTitle}><IdentityInvitations action={revokeHouseholdInvitationAction} empty={labels.noInvitations} invitations={overview.invitations.map((entry) => ({ ...entry, expiresAt: entry.expiresAt.toISOString(), sentAt: entry.sentAt?.toISOString() ?? null, consumedAt: entry.consumedAt?.toISOString() ?? null, revokedAt: entry.revokedAt?.toISOString() ?? null }))} labels={labels} locale={locale} now={now} /></IdentitySection>
    </> : null}
    <EncryptionSettings identity={{ accountId: context.id, householdId: context.householdId, memberId: context.memberId }} locale={locale} status={encryptionStatus} />
    <IdentitySection description={labels.leaveHelp} title={labels.leave}>
      {owner ? <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.ownerLeaveHelp}</p> : <IdentityForm action={changeHouseholdMembershipAction} confirmation={labels.leaveConfirm} labels={labels} submitLabel={labels.leave}><input name="operation" type="hidden" value="leave" /><IdentityField autoComplete="current-password" label={labels.currentPassword} name="currentPassword" type="password" /></IdentityForm>}
    </IdentitySection>
    {owner ? <IdentitySection description={lifecycle.closeHelp} title={lifecycle.closeTitle}>
      <p className="mb-2 break-words text-sm font-medium text-[var(--bb-ink)]">{overview.household.name}</p>
      <Link className="mb-4 inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-ink)]" href="/records">{lifecycle.exportLink}</Link>
      <div className="[&_button]:text-[var(--ios-red)]"><IdentityForm action={changeHouseholdMembershipAction} confirmation={`${lifecycle.closeConfirm} · ${overview.household.name}`} labels={labels} submitLabel={lifecycle.closeSubmit}>
        <input name="operation" type="hidden" value="close" />
        <IdentityField autoComplete="current-password" label={labels.currentPassword} name="currentPassword" type="password" />
      </IdentityForm></div>
    </IdentitySection> : null}
  </>;
}
