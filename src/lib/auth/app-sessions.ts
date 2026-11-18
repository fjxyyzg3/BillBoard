import { randomUUID } from "node:crypto";
import { type HouseholdRole, OpsAuditAction, UserStatus } from "@prisma/client";
import type { JWT } from "next-auth/jwt";
import { db } from "@/lib/db";

export const appSessionLastSeenRefreshMs = 5 * 60 * 1000;
const appSessionDefaultMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
const maxStoredUserAgentLength = 512;

export type AccountSessionUser = {
  email: string;
  id: string;
  name: string;
  appSessionId: string;
  householdId?: string;
  memberId?: string;
  role?: HouseholdRole;
};

export type AppSessionUser = AccountSessionUser & { householdId: string; memberId: string; role: HouseholdRole };

type AppSessionToken = JWT & {
  appSessionId?: string;
  appSessionKey?: string;
  householdId?: string;
  memberId?: string;
};

type AppSessionLoginUser = {
  appSessionUserAgent?: string | null;
  id: string;
  email: string;
  passwordHash: string;
  householdId?: string;
  memberId?: string;
};

export function describeSessionDevice(userAgent: string | null | undefined) {
  const normalized = userAgent?.trim();

  if (!normalized) {
    return "Unknown";
  }

  return `${describeBrowser(normalized)} on ${describeOperatingSystem(normalized)}`;
}

export function shouldRefreshAppSessionLastSeen(lastSeenAt: Date, now = new Date()) {
  return now.getTime() - lastSeenAt.getTime() >= appSessionLastSeenRefreshMs;
}

export async function ensureAppSessionForToken(
  token: JWT,
  user: AppSessionLoginUser | null,
  now = new Date(),
) {
  const appToken = token as AppSessionToken;

  if (typeof appToken.appSessionId === "string" && appToken.appSessionId) {
    return appToken.appSessionId;
  }

  const userId = user?.id ?? (typeof appToken.sub === "string" ? appToken.sub : "");

  if (!userId) {
    return null;
  }

  const sessionKey = getOrCreateSessionKey(appToken);
  // A legacy JWT may only recover its original membership, never the account's new one.
  const memberId = user ? user.memberId : appToken.memberId;
  const householdId = user ? user.householdId : appToken.householdId;
  if (!user && (!memberId || !householdId || typeof appToken.exp !== "number" || !Number.isFinite(appToken.exp)
    || appToken.exp * 1000 <= now.getTime() || typeof appToken.iat !== "number" || !Number.isSafeInteger(appToken.iat)
    || appToken.iat < 0 || appToken.iat * 1000 > now.getTime() || appToken.iat >= appToken.exp)) return null;
  if (Boolean(memberId) !== Boolean(householdId)) return null;
  const appSession = await db.$transaction(async (transaction) => {
    // Credential changes and membership transitions use this same household-first order.
    // Never follow a changed membership into a different household while holding its User lock.
    if (memberId && householdId) {
      await transaction.$queryRaw`SELECT id FROM "Household" WHERE id = ${householdId} FOR UPDATE`;
      await transaction.$queryRaw`
        SELECT id FROM "HouseholdMember" WHERE id = ${memberId} AND household_id = ${householdId} FOR UPDATE
      `;
    }
    await transaction.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const current = await transaction.user.findUnique({
      where: { id: userId }, select: { status: true, email: true, passwordHash: true },
    });
    if (!current || current.status !== UserStatus.ACTIVE ||
      (user && (current.email !== user.email || current.passwordHash !== user.passwordHash))) return null;
    const member = await transaction.householdMember.findFirst({
      where: { userId, leftAt: null, household: { closedAt: null } },
      select: { id: true, householdId: true },
    });
    if ((member?.id ?? null) !== (memberId ?? null) || (member?.householdId ?? null) !== (householdId ?? null)) return null;
    if (!user) {
      // Legacy JWTs have no credential snapshot. Retained revocation audits close
      // their first-use window without invalidating unchanged original identities.
      const issuedAt = new Date(appToken.iat! * 1000);
      const [accountRevocation, opsRevocation] = await Promise.all([
        transaction.identityAuditLog.findFirst({
          where: { actorUserId: userId, createdAt: { gte: issuedAt }, action: { in: ["PASSWORD_CHANGED", "PASSWORD_RESET", "EMAIL_CHANGED"] } },
          select: { id: true },
        }),
        transaction.opsAuditLog.findFirst({
          where: { targetUserId: userId, createdAt: { gte: issuedAt }, action: { in: [OpsAuditAction.RESET_USER_PASSWORD, OpsAuditAction.REVOKE_USER_SESSIONS_AFTER_PASSWORD_RESET] } },
          select: { id: true },
        }),
      ]);
      if (accountRevocation || opsRevocation) return null;
    }
    return transaction.appSession.upsert({
      create: {
        expiresAt: getAppSessionExpiresAt(appToken.exp, now),
        lastSeenAt: now,
        loginAt: now,
        sessionKey,
        userAgent: normalizeUserAgent(user?.appSessionUserAgent),
        userId,
        memberId: memberId ?? null,
      },
      select: { id: true },
      update: {},
      where: { sessionKey },
    });
  }, { maxWait: 10_000, timeout: 15_000 });
  if (!appSession) return null;

  appToken.appSessionId = appSession.id;

  return appSession.id;
}

export async function loadValidAppSessionUser(
  appSessionId: string,
  now = new Date(),
): Promise<AppSessionUser | null> {
  const user = await loadValidAccountSessionUser(appSessionId, now);
  return user?.householdId && user.memberId && user.role ? user as AppSessionUser : null;
}

export async function loadValidAccountSessionUser(
  appSessionId: string,
  now = new Date(),
): Promise<AccountSessionUser | null> {
  const appSession = await db.appSession.findFirst({
    include: {
      user: true,
      member: { include: { household: true } },
    },
    where: {
      expiresAt: {
        gt: now,
      },
      id: appSessionId,
      revokedAt: null,
    },
  });

  const member = appSession?.member;

  if (!appSession || appSession.user.status !== UserStatus.ACTIVE) {
    return null;
  }
  if (appSession.memberId && (!member || member.leftAt || member.household.closedAt || member.userId !== appSession.userId)) return null;

  if (shouldRefreshAppSessionLastSeen(appSession.lastSeenAt, now)) {
    await db.appSession.updateMany({
      data: {
        lastSeenAt: now,
      },
      where: {
        id: appSession.id,
        revokedAt: null,
      },
    });
  }

  return {
    email: appSession.user.email,
    appSessionId: appSession.id,
    ...(member ? { householdId: member.householdId, memberId: member.id, role: member.role } : {}),
    id: appSession.user.id,
    name: appSession.user.displayName,
  };
}

function getOrCreateSessionKey(token: AppSessionToken) {
  if (typeof token.appSessionKey === "string" && token.appSessionKey) {
    return token.appSessionKey;
  }

  if (typeof token.jti === "string" && token.jti) {
    token.appSessionKey = token.jti;
    return token.jti;
  }

  const sessionKey = randomUUID();

  token.appSessionKey = sessionKey;

  return sessionKey;
}

function getAppSessionExpiresAt(exp: unknown, now: Date) {
  if (typeof exp === "number" && Number.isFinite(exp)) {
    const expiresAt = new Date(exp * 1000);

    if (expiresAt > now) {
      return expiresAt;
    }
  }

  return new Date(now.getTime() + appSessionDefaultMaxAgeMs);
}

function normalizeUserAgent(userAgent: string | null | undefined) {
  const normalized = userAgent?.trim();

  return normalized ? normalized.slice(0, maxStoredUserAgentLength) : null;
}

function describeBrowser(userAgent: string) {
  if (/\bEdg\//.test(userAgent)) {
    return "Edge";
  }

  if (/\bFirefox\//.test(userAgent) || /\bFxiOS\//.test(userAgent)) {
    return "Firefox";
  }

  if (/\bChrome\//.test(userAgent) || /\bCriOS\//.test(userAgent)) {
    return "Chrome";
  }

  if (/\bSafari\//.test(userAgent) && /\bVersion\//.test(userAgent)) {
    return "Safari";
  }

  return "Unknown browser";
}

function describeOperatingSystem(userAgent: string) {
  if (/iPhone/.test(userAgent)) {
    return "iPhone";
  }

  if (/iPad/.test(userAgent)) {
    return "iPad";
  }

  if (/Android/.test(userAgent)) {
    return "Android";
  }

  if (/Mac OS X/.test(userAgent)) {
    return "macOS";
  }

  if (/Windows NT/.test(userAgent)) {
    return "Windows";
  }

  if (/Linux/.test(userAgent)) {
    return "Linux";
  }

  return "Unknown OS";
}
