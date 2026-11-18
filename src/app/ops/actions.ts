"use server";

import argon2 from "argon2";
import { OpsAuditAction } from "@prisma/client";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getMessages, parseLocale } from "@/lib/i18n";
import { db } from "@/lib/db";
import {
  createOpsAdminSessionToken,
  opsAdminSessionCookieName,
  verifyOpsAdminSessionToken,
  verifyOpsAdminPassword,
} from "@/lib/ops/auth";
import { getOpsAdminConfig } from "@/lib/ops/config";
import { createPlatformInvitation, listPlatformInvitations, revokePlatformInvitation } from "@/lib/identity/invitations";
import { IdentityError, revokeAccountTokens } from "@/lib/identity/shared";
import { revalidatePath } from "next/cache";
import type { IdentityFormResult } from "@/components/identity-types";
import { decideAccessApplication, listAccessApplicationsForOps, retryAccessApplicationMail } from "@/lib/identity/access-applications";
import type { IdentityResult } from "@/components/identity-types";

export type OpsLoginActionState = { status: "idle" | "error"; message?: string };

const opsSessionMaxAgeSeconds = 8 * 60 * 60;

function getOpsSessionSecret(): string | null {
  if (process.env.AUTH_SECRET) {
    return process.env.AUTH_SECRET;
  }

  return process.env.NODE_ENV === "production" ? null : "development-auth-secret";
}

export async function loginOpsAdmin(
  _previousState: OpsLoginActionState,
  formData: FormData,
): Promise<OpsLoginActionState> {
  const locale = parseLocale(formData.get("locale"));
  const message = getMessages(locale).ops.invalidPassword;

  if (!getOpsAdminConfig().instance) {
    return { status: "error", message };
  }

  const password = String(formData.get("password") ?? "");
  const passwordIsValid = await verifyOpsAdminPassword(password);

  if (!passwordIsValid) {
    return { status: "error", message };
  }

  const sessionSecret = getOpsSessionSecret();

  if (!sessionSecret) {
    return { status: "error", message };
  }

  const cookieStore = await cookies();

  cookieStore.set(
    opsAdminSessionCookieName,
    createOpsAdminSessionToken(sessionSecret),
    {
      httpOnly: true,
      maxAge: opsSessionMaxAgeSeconds,
      path: "/ops",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  );

  redirect("/ops");
}

export async function submitOpsAdminLogin(formData: FormData): Promise<void> {
  await loginOpsAdmin({ status: "idle" }, formData);
}

async function requireOpsAdminSession() {
  const config = getOpsAdminConfig();
  const sessionSecret = getOpsSessionSecret();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(opsAdminSessionCookieName)?.value;
  const isAuthenticated =
    config.enabled &&
    config.hasPasswordHash &&
    config.instance &&
    Boolean(sessionSecret) &&
    verifyOpsAdminSessionToken(sessionToken, sessionSecret ?? "");

  if (!isAuthenticated) {
    redirect("/ops");
  }
}

export async function releaseLoginThrottle(formData: FormData): Promise<never> {
  await requireOpsAdminSession();

  const loginThrottleId = String(formData.get("loginThrottleId") ?? "");

  if (loginThrottleId) {
    await db.loginThrottle.delete({
      where: { id: loginThrottleId },
    }).catch(() => undefined);
  }

  redirect("/ops");
}

export async function resetUserPassword(formData: FormData): Promise<never> {
  await requireOpsAdminSession();

  const userId = String(formData.get("userId") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const confirmed = formData.get("confirmReset") === "on";

  if (
    !userId ||
    !confirmed ||
    newPassword.length < 8 ||
    newPassword !== confirmPassword
  ) {
    redirect("/ops");
  }

  const user = await db.user.findUnique({
    select: {
      householdMember: {
        where: { leftAt: null },
        select: {
          memberName: true,
        },
      },
      id: true,
      displayName: true,
    },
    where: {
      id: userId,
    },
  });

  if (!user) {
    redirect("/ops");
  }

  const memberName = user.householdMember[0]?.memberName ?? user.displayName;
  const passwordHash = await argon2.hash(newPassword);
  const now = new Date();

  await db.$transaction(async (tx) => {
    await tx.user.update({
      data: {
        passwordHash,
      },
      where: {
        id: user.id,
      },
    });

    const revoked = await tx.appSession.updateMany({
      data: {
        revokedAt: now,
      },
      where: {
        revokedAt: null,
        userId: user.id,
      },
    });

    await revokeAccountTokens(tx, [user.id], now);

    await tx.opsAuditLog.create({
      data: {
        action: OpsAuditAction.RESET_USER_PASSWORD,
        operator: "ops-admin",
        summary: `Reset password for ${memberName}`,
        targetUserId: user.id,
      },
    });

    if (revoked.count > 0) {
      await tx.opsAuditLog.create({
        data: {
          action: OpsAuditAction.REVOKE_USER_SESSIONS_AFTER_PASSWORD_RESET,
          operator: "ops-admin",
          summary: `Revoked ${revoked.count} session(s) after password reset`,
          targetUserId: user.id,
        },
      });
    }
  });

  redirect("/ops");
}

export async function revokeAppSession(formData: FormData): Promise<never> {
  await requireOpsAdminSession();

  const appSessionId = String(formData.get("appSessionId") ?? "");

  if (!appSessionId) {
    redirect("/ops");
  }

  const appSession = await db.appSession.findUnique({
    select: {
      id: true,
      user: {
        select: {
          householdMember: {
            where: { leftAt: null },
            select: {
              memberName: true,
            },
          },
          id: true,
          displayName: true,
        },
      },
    },
    where: {
      id: appSessionId,
    },
  });

  if (!appSession) {
    redirect("/ops");
  }

  const memberName = appSession.user.householdMember[0]?.memberName ?? appSession.user.displayName;
  const now = new Date();

  await db.$transaction(async (tx) => {
    const revoked = await tx.appSession.updateMany({
      data: {
        revokedAt: now,
      },
      where: {
        id: appSession.id,
        revokedAt: null,
      },
    });

    if (revoked.count > 0) {
      await tx.opsAuditLog.create({
        data: {
          action: OpsAuditAction.REVOKE_USER_SESSION,
          operator: "ops-admin",
          summary: `Revoked session for ${memberName}`,
          targetSessionId: appSession.id,
          targetUserId: appSession.user.id,
        },
      });
    }
  });

  redirect("/ops");
}

export async function logoutOpsAdmin(): Promise<never> {
  const cookieStore = await cookies();

  cookieStore.delete({ name: opsAdminSessionCookieName, path: "/ops" });

  redirect("/ops");
}

export async function getPlatformInvitationsForOps() {
  await requireOpsAdminSession();
  return listPlatformInvitations();
}

export async function createPlatformInvitationAction(form: FormData): Promise<IdentityFormResult> {
  await requireOpsAdminSession();
  try {
    await createPlatformInvitation({ email: String(form.get("email") ?? ""), locale: parseLocale(form.get("locale")) });
    revalidatePath("/ops");
    return { ok: true, data: { message: "sent" } };
  } catch (error) { return { ok: false, code: error instanceof IdentityError ? error.code : "SERVICE_UNAVAILABLE" }; }
}

export async function revokePlatformInvitationAction(form: FormData): Promise<IdentityFormResult> {
  await requireOpsAdminSession();
  try {
    await revokePlatformInvitation(String(form.get("invitationId") ?? ""));
    revalidatePath("/ops");
    return { ok: true, data: { message: "saved" } };
  } catch (error) { return { ok: false, code: error instanceof IdentityError ? error.code : "SERVICE_UNAVAILABLE" }; }
}

export async function getAccessApplicationsForOps(page = 1) {
  await requireOpsAdminSession();
  return listAccessApplicationsForOps(page);
}

export type AccessApplicationDecisionResult = IdentityResult<Awaited<ReturnType<typeof decideAccessApplication>>>;

export async function decideAccessApplicationAction(form: FormData): Promise<AccessApplicationDecisionResult> {
  await requireOpsAdminSession();
  const decision = form.get("decision");
  const id = String(form.get("applicationId") ?? "");
  if (!id || (decision !== "APPROVED" && decision !== "REJECTED")) return { ok: false, code: "INVALID_INPUT" };
  try {
    const result = await decideAccessApplication(id, decision);
    revalidatePath("/ops");
    return { ok: true, data: { status: result.status, mailStatus: result.mailStatus } };
  } catch (error) { return { ok: false, code: error instanceof IdentityError ? error.code : "SERVICE_UNAVAILABLE" }; }
}

export async function retryAccessApplicationMailAction(form: FormData): Promise<AccessApplicationDecisionResult> {
  await requireOpsAdminSession();
  const id = String(form.get("applicationId") ?? "");
  if (!id) return { ok: false, code: "INVALID_INPUT" };
  try {
    const result = await retryAccessApplicationMail(id);
    revalidatePath("/ops");
    return { ok: true, data: { status: result.status, mailStatus: result.mailStatus } };
  } catch (error) { return { ok: false, code: error instanceof IdentityError ? error.code : "SERVICE_UNAVAILABLE" }; }
}
