"use server";

import { signOutCurrentAccount } from "@/lib/auth/sign-out";
import { revalidatePath } from "next/cache";
import { requireAccountSession, requireAppSession } from "@/lib/auth/session";
import { changeAccountPassword, deactivateOwnAccount, prepareEmailVerification, requestEmailVerification, revokeOwnSession } from "@/lib/identity/account";
import { after } from "next/server";
import { createHouseholdInvitation, revokeHouseholdInvitation } from "@/lib/identity/invitations";
import { closeHousehold, leaveHousehold, removeHouseholdMember, transferHouseholdOwnership } from "@/lib/identity/households";
import { IdentityError } from "@/lib/identity/shared";
import { parseLocale } from "@/lib/i18n";
import type { IdentityFormResult } from "@/components/identity-types";

function text(form: FormData, field: string) { return String(form.get(field) ?? ""); }
function failure(error: unknown): IdentityFormResult {
  return { ok: false, code: error instanceof IdentityError ? error.code : error instanceof Error && error.message === "Unauthorized" ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE" };
}
async function reauthenticate(): Promise<IdentityFormResult> {
  // Mutations have already revoked their sessions. Cookie changes here would
  // re-render this protected page before the client can finish identity cleanup.
  return { ok: true, data: { reauthenticate: true } };
}

export async function finishReauthenticationAction() {
  await signOutCurrentAccount({ redirectTo: "/login?reason=account-updated" });
}

export async function verifyOwnEmailAction(form: FormData): Promise<IdentityFormResult> {
  try {
    const session = await requireAccountSession();
    await requestEmailVerification(session, { locale: parseLocale(form.get("locale")) });
    return { ok: true, data: { message: "accepted" } };
  } catch (error) { return failure(error); }
}

export async function changeOwnEmailAction(form: FormData): Promise<IdentityFormResult> {
  try {
    const session = await requireAccountSession();
    const prepared = await prepareEmailVerification(session, { email: text(form, "email"), currentPassword: text(form, "currentPassword"), locale: parseLocale(form.get("locale")) });
    if (prepared.kind === "change-email") after(async () => {
      try { await prepared.deliver(); }
      catch { /* Acceptance is independent of the destination mailbox and provider. */ }
    });
    else await prepared.deliver();
    return { ok: true, data: { message: "accepted" } };
  } catch (error) { return failure(error); }
}

export async function changeOwnPasswordAction(form: FormData): Promise<IdentityFormResult> {
  try {
    const session = await requireAccountSession();
    if (text(form, "newPassword") !== text(form, "confirmPassword")) return { ok: false, code: "INVALID_INPUT" };
    await changeAccountPassword(session, { currentPassword: text(form, "currentPassword"), newPassword: text(form, "newPassword") });
    return await reauthenticate();
  } catch (error) { return failure(error); }
}

export async function revokeOwnSessionAction(form: FormData): Promise<IdentityFormResult> {
  try {
    const session = await requireAccountSession();
    const result = await revokeOwnSession(session, text(form, "sessionId"));
    if (result.requiresReauthentication) return await reauthenticate();
    revalidatePath("/account");
    return { ok: true, data: { message: "saved" } };
  } catch (error) { return failure(error); }
}

export async function deactivateOwnAccountAction(form: FormData): Promise<IdentityFormResult> {
  try {
    const session = await requireAccountSession();
    await deactivateOwnAccount(session, { currentPassword: text(form, "currentPassword"), confirmed: form.get("confirmed") === "on" });
    return await reauthenticate();
  } catch (error) { return failure(error); }
}

export async function createHouseholdInvitationAction(form: FormData): Promise<IdentityFormResult> {
  try {
    const session = await requireAppSession();
    await createHouseholdInvitation(session, { email: text(form, "email"), locale: parseLocale(form.get("locale")) });
    revalidatePath("/account/household");
    return { ok: true, data: { message: "sent" } };
  } catch (error) { return failure(error); }
}

export async function revokeHouseholdInvitationAction(form: FormData): Promise<IdentityFormResult> {
  try {
    const session = await requireAppSession();
    await revokeHouseholdInvitation(session, text(form, "invitationId"));
    revalidatePath("/account/household");
    return { ok: true, data: { message: "saved" } };
  } catch (error) { return failure(error); }
}

export async function changeHouseholdMembershipAction(form: FormData): Promise<IdentityFormResult> {
  try {
    const session = await requireAppSession();
    if (form.get("confirmed") !== "on") return { ok: false, code: "INVALID_INPUT" };
    const operation = text(form, "operation");
    const password = text(form, "currentPassword");
    if (operation === "leave") {
      await leaveHousehold(session, password);
      return await reauthenticate();
    }
    if (operation === "close") {
      await closeHousehold(session, { currentPassword: password, confirmed: true });
      return await reauthenticate();
    }
    if (operation === "remove") await removeHouseholdMember(session, text(form, "memberId"), password);
    else if (operation === "transfer") await transferHouseholdOwnership(session, text(form, "memberId"), password);
    else return { ok: false, code: "INVALID_INPUT" };
    revalidatePath("/account/household");
    return { ok: true, data: { message: "saved" } };
  } catch (error) { return failure(error); }
}

export async function signOutAccountAction() { await signOutCurrentAccount({ redirectTo: "/login" }); }
