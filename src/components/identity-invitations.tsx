import type { Locale, Messages } from "@/lib/i18n";
import { formatLocaleDateTime } from "@/lib/i18n";
import { IdentityForm } from "./identity-form";
import type { IdentityFormResult, IdentityInvitation } from "./identity-types";

export function IdentityInvitations({ invitations, labels, locale, action, empty, now }: {
  invitations: IdentityInvitation[];
  labels: Messages["identity"];
  locale: Locale;
  action: (form: FormData) => Promise<IdentityFormResult>;
  empty: string;
  now: number;
}) {
  if (!invitations.length) return <p className="text-sm text-[var(--bb-muted)]">{empty}</p>;
  return <ul className="divide-y divide-[var(--bb-warm-line)]">{invitations.map((invitation) => {
    const expired = new Date(invitation.expiresAt).getTime() <= now;
    const active = !invitation.consumedAt && !invitation.revokedAt && !expired;
    const state = invitation.consumedAt ? labels.invitationConsumed : invitation.revokedAt ? labels.invitationRevoked : expired ? labels.invitationExpired : invitation.sentAt ? labels.invitationPending : labels.invitationSending;
    return <li className="space-y-3 py-4 first:pt-0 last:pb-0" key={invitation.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="min-w-0 break-all text-sm font-medium text-[var(--bb-ink)]">{invitation.email}</p><span className="rounded-lg bg-[var(--bb-warm-surface)] px-2 py-1 text-xs text-[var(--bb-muted)]">{state}</span></div>
      <p className="text-xs text-[var(--bb-muted)]">{labels.expiresAt} <time className="tabular-nums">{formatLocaleDateTime(new Date(invitation.expiresAt), locale)}</time></p>
      {active ? <IdentityForm action={action} labels={labels} refresh submitLabel={labels.revokeInvitation}><input name="invitationId" type="hidden" value={invitation.id} /></IdentityForm> : null}
    </li>;
  })}</ul>;
}
