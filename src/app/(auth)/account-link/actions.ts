"use server";

import { signOutCurrentAccount } from "@/lib/auth/sign-out";
import { requireAccountSession } from "@/lib/auth/session";
import { getAccountOverview, completeEmailVerification, resetAccountPassword } from "@/lib/identity/account";
import { acceptInvitation, completeInvitedRegistration, getInvitationPreview, startInvitedRegistration } from "@/lib/identity/invitations";
import { IdentityError } from "@/lib/identity/shared";
import { parseLocale } from "@/lib/i18n";
import type { IdentityAccount, IdentityFormResult, IdentityResult } from "@/components/identity-types";

type InvitationPreview = { purpose: "PLATFORM" | "HOUSEHOLD"; email: string; householdName: string | null; expiresAt: string };
function failure(error: unknown) {
  return { ok: false as const, code: error instanceof IdentityError ? error.code : error instanceof Error && error.message === "Unauthorized" ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE" };
}
function text(form: FormData, field: string) { return String(form.get(field) ?? ""); }

export async function previewInvitationAction(token: string): Promise<IdentityResult<InvitationPreview>> {
  try {
    const preview = await getInvitationPreview(token);
    return { ok: true, data: { purpose: preview.purpose, email: preview.email, householdName: preview.householdName ?? null, expiresAt: preview.expiresAt.toISOString() } };
  } catch (error) { return failure(error); }
}

export async function getLinkAccountAction(): Promise<IdentityResult<IdentityAccount | null>> {
  try {
    const session = await requireAccountSession();
    const account = await getAccountOverview(session);
    return { ok: true, data: { email: account.email, displayName: account.displayName, emailVerifiedAt: account.emailVerifiedAt?.toISOString() ?? null, hasHousehold: Boolean(session.householdId && session.memberId) } };
  } catch (error) {
    if (error instanceof Error && (error.message === "Unauthorized" || error instanceof IdentityError && error.code === "UNAUTHORIZED")) return { ok: true, data: null };
    return failure(error);
  }
}

export async function startInvitedRegistrationAction(token: string, form: FormData): Promise<IdentityFormResult> {
  try {
    if (text(form, "newPassword") !== text(form, "confirmPassword")) return { ok: false, code: "INVALID_INPUT" };
    await startInvitedRegistration(token, { displayName: text(form, "displayName"), memberName: text(form, "memberName"), householdName: text(form, "householdName") || undefined, password: text(form, "newPassword"), locale: parseLocale(form.get("locale")) });
    return { ok: true, data: { message: "sent" } };
  } catch (error) { return failure(error); }
}

export async function acceptInvitationAction(token: string, form: FormData): Promise<IdentityFormResult> {
  try {
    const session = await requireAccountSession();
    if (form.get("confirmed") !== "on") return { ok: false, code: "INVALID_INPUT" };
    await acceptInvitation(session, token, { memberName: text(form, "memberName"), householdName: text(form, "householdName") || undefined });
    return { ok: true, data: { reauthenticate: true } };
  } catch (error) { return failure(error); }
}

export async function completeIdentityLinkAction(kind: "verify" | "registration" | "reset", token: string, form: FormData): Promise<IdentityFormResult> {
  try {
    let reauthenticate = true;
    if (kind === "verify") reauthenticate = (await completeEmailVerification(token)).requiresReauthentication;
    else if (kind === "registration") await completeInvitedRegistration(token);
    else if (kind === "reset") {
      if (text(form, "newPassword") !== text(form, "confirmPassword")) return { ok: false, code: "INVALID_INPUT" };
      await resetAccountPassword(token, text(form, "newPassword"));
    } else return { ok: false, code: "INVALID_TOKEN" };
    return { ok: true, data: { reauthenticate, message: "saved" } };
  } catch (error) { return failure(error); }
}

export async function signOutLinkAccountAction() {
  await signOutCurrentAccount({ redirect: false });
  return { ok: true as const, data: null };
}
