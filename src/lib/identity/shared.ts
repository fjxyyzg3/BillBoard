import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { Prisma } from "@prisma/client";
import type { AccountSessionUser } from "@/lib/auth/app-sessions";
import { loadValidAccountSessionUser } from "@/lib/auth/app-sessions";
import { runAdmittedPasswordWork, verifyLoginCredentials } from "@/lib/auth/login-admission";
import { db } from "@/lib/db";

export class IdentityError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "IdentityError";
  }
}

export function createIdentityToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashIdentityToken(token) };
}

export function hashIdentityToken(token: string) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new IdentityError("INVALID_TOKEN");
  }
  return createHash("sha256").update(token).digest("hex");
}

export async function lockIdentityUser(tx: Prisma.TransactionClient, userId: string) {
  const before = await tx.householdMember.findFirst({
    where: { userId, leftAt: null }, select: { id: true, householdId: true },
  });
  if (before) {
    await tx.$queryRaw`SELECT id FROM "Household" WHERE id = ${before.householdId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "HouseholdMember" WHERE id = ${before.id} FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  const after = await tx.householdMember.findFirst({
    where: { userId, leftAt: null }, select: { id: true, householdId: true },
  });
  // A concurrent join/leave must retry with the new household-first lock order.
  if ((before?.id ?? null) !== (after?.id ?? null)) throw new IdentityError("UNAUTHORIZED");
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "ACTIVE") throw new IdentityError("UNAUTHORIZED");
  return user;
}

export async function requireLockedAccount(tx: Prisma.TransactionClient, session: AccountSessionUser) {
  if (!session?.id || !session.appSessionId) throw new IdentityError("UNAUTHORIZED");
  const user = await lockIdentityUser(tx, session.id);
  await tx.$queryRaw`SELECT id FROM "AppSession" WHERE id = ${session.appSessionId} FOR SHARE`;
  const current = await tx.appSession.findFirst({
    where: { id: session.appSessionId, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    include: { member: { include: { household: true } } },
  });
  if (!current || current.memberId !== (session.memberId ?? null)
    || (current.member && (current.member.leftAt || current.member.household.closedAt || current.member.userId !== user.id))) {
    throw new IdentityError("UNAUTHORIZED");
  }
  return user;
}

export async function verifyIdentityPassword(session: AccountSessionUser, password: string) {
  if (typeof password !== "string" || password.length < 1) {
    throw new IdentityError("PASSWORD_INVALID");
  }
  const current = await loadValidAccountSessionUser(session.appSessionId);
  if (!current || current.id !== session.id) throw new IdentityError("UNAUTHORIZED");
  const result = await verifyLoginCredentials(current.email, password);
  if (result.status === "rate_limited" || result.status === "rejected") throw new IdentityError("RATE_LIMITED");
  if (result.status !== "authenticated" || result.user.id !== session.id) throw new IdentityError("PASSWORD_INVALID");
  return { passwordHash: result.user.passwordHash };
}

export async function hashIdentityPassword(password: string) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new IdentityError("PASSWORD_POLICY");
  }
  try {
    return await runAdmittedPasswordWork(() => argon2.hash(password));
  } catch {
    throw new IdentityError("RATE_LIMITED");
  }
}

export async function revokeAccountTokens(tx: Prisma.TransactionClient, userIds: string[], now: Date) {
  if (userIds.length === 0) return;
  await tx.accountToken.updateMany({
    where: { userId: { in: userIds }, consumedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
}

export async function takeIdentityRateLimit(scope: string, subject: string) {
  if (!/^[a-z-]{1,40}$/.test(scope) || !subject || subject.length > 512) throw new IdentityError("INVALID_INPUT");
  const id = `${scope}:${createHash("sha256").update(subject.trim().toLowerCase()).digest("hex")}`;
  const rule = scope === "mail" ? { count: 5, window: 3_600_000, gap: 60_000 }
    : scope === "invitation" ? { count: 20, window: 3_600_000, gap: 0 }
      : scope === "registration" ? { count: 3, window: 1_800_000, gap: 0 }
        : { count: scope === "token" ? 60 : 30, window: 900_000, gap: 0 };
  const allowed = await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "IdentityRateLimit" (id, window_started_at, last_attempt_at)
      VALUES ('global', clock_timestamp(), clock_timestamp()) ON CONFLICT (id) DO NOTHING
    `;
    await tx.$queryRaw`SELECT id FROM "IdentityRateLimit" WHERE id = 'global' FOR UPDATE`;
    const now = new Date();
    const global = (await tx.identityRateLimit.findUnique({ where: { id: "global" } }))!;
    const resetGlobal = now.getTime() - global.windowStartedAt.getTime() >= 900_000;
    const globalCount = resetGlobal ? 0 : global.attempts;
    if (globalCount >= 240) return false;
    await tx.identityRateLimit.update({ where: { id: "global" }, data: {
      attempts: globalCount + 1, lastAttemptAt: now, ...(resetGlobal ? { windowStartedAt: now } : {}),
    } });
    await tx.identityRateLimit.deleteMany({ where: {
      id: { not: "global" }, NOT: { id: { startsWith: "public-application:" } },
      lastAttemptAt: { lt: new Date(now.getTime() - 86_400_000) },
    } });
    // Pending registration details have no business-history role after expiry.
    await tx.$executeRaw`
      DELETE FROM "AccountToken" WHERE id IN (
        SELECT id FROM "AccountToken" WHERE purpose = 'REGISTER'
          AND expires_at < ${new Date(now.getTime() - 86_400_000)}
        ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
      )
    `;
    const previous = await tx.identityRateLimit.findUnique({ where: { id } });
    const reset = !previous || now.getTime() - previous.windowStartedAt.getTime() >= rule.window;
    if (!reset && (previous.attempts >= rule.count || now.getTime() - previous.lastAttemptAt.getTime() < rule.gap)) return false;
    const data = { attempts: reset ? 1 : previous!.attempts + 1, lastAttemptAt: now, windowStartedAt: reset ? now : previous!.windowStartedAt };
    await tx.identityRateLimit.upsert({ where: { id }, create: { id, ...data }, update: data });
    return true;
  }, { maxWait: 5_000, timeout: 10_000 });
  if (!allowed) throw new IdentityError("RATE_LIMITED");
}
