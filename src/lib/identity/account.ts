import { Prisma, type AccountToken } from "@prisma/client";
import { z } from "zod";
import { describeSessionDevice, type AccountSessionUser } from "@/lib/auth/app-sessions";
import { db } from "@/lib/db";
import type { Locale } from "@/lib/i18n";
import { sendIdentityEmail } from "@/lib/identity/mail";
import { revokeIssuedInvitations } from "@/lib/identity/households";
import {
  createIdentityToken, hashIdentityPassword, hashIdentityToken, IdentityError, lockIdentityUser,
  requireLockedAccount, revokeAccountTokens, takeIdentityRateLimit, verifyIdentityPassword,
} from "@/lib/identity/shared";

const tokenLifetimeMs = 30 * 60_000;
const transactionOptions = { maxWait: 5_000, timeout: 10_000 };
const emailSchema = z.email().max(254);

export type AccountOverview = {
  email: string;
  displayName: string;
  emailVerifiedAt: Date | null;
  sessions: Array<{ id: string; deviceLabel: string; loginAt: Date; lastSeenAt: Date; expiresAt: Date; isCurrent: boolean }>;
};

export type PreparedEmailVerification = {
  kind: "verify-current" | "change-email";
  deliver: () => Promise<{ accepted: true }>;
};

type EmailVerificationInput = { email?: string; currentPassword?: string; locale?: Locale };
type EmailVerificationDelivery = {
  session: AccountSessionUser;
  originalEmail: string;
  email: string;
  expectedPasswordHash: string;
  changingEmail: boolean;
  alreadyVerified: boolean;
  locale?: Locale;
};

export async function prepareEmailVerification(
  session: AccountSessionUser,
  input: EmailVerificationInput,
): Promise<PreparedEmailVerification> {
  const current = await db.$transaction((tx) => requireLockedAccount(tx, session), transactionOptions);
  const email = input.email ? normalizeEmail(input.email) : current.email;
  const changingEmail = email.toLowerCase() !== current.email.toLowerCase();
  await takeIdentityRateLimit("email-verify", current.id);
  const verified = changingEmail ? await verifyIdentityPassword(session, input.currentPassword ?? "") : null;
  const context: EmailVerificationDelivery = {
    session: { ...session }, originalEmail: current.email, email, changingEmail,
    expectedPasswordHash: verified?.passwordHash ?? current.passwordHash,
    alreadyVerified: !!current.emailVerifiedAt, locale: input.locale,
  };
  // Only this server-side closure retains the credential snapshot, never a client DTO.
  let delivery: Promise<{ accepted: true }> | undefined;
  return {
    kind: changingEmail ? "change-email" : "verify-current",
    deliver: () => delivery ??= deliverPreparedEmailVerification(context),
  };
}

export async function getAccountOverview(session: AccountSessionUser): Promise<AccountOverview> {
  return db.$transaction(async (tx) => {
    const user = await requireLockedAccount(tx, session);
    const sessions = await tx.appSession.findMany({
      where: {
        userId: user.id, revokedAt: null, expiresAt: { gt: new Date() },
        OR: [{ memberId: null }, { member: { leftAt: null, household: { closedAt: null } } }],
      },
      select: { id: true, userAgent: true, loginAt: true, lastSeenAt: true, expiresAt: true },
      orderBy: [{ loginAt: "desc" }, { id: "asc" }],
    });
    return {
      email: user.email, displayName: user.displayName, emailVerifiedAt: user.emailVerifiedAt,
      sessions: sessions.map(({ userAgent, ...current }) => ({
        ...current, deviceLabel: describeSessionDevice(userAgent), isCurrent: current.id === session.appSessionId,
      })),
    };
  }, transactionOptions);
}

export async function requestEmailVerification(
  session: AccountSessionUser,
  input: EmailVerificationInput,
): Promise<{ accepted: true }> {
  return (await prepareEmailVerification(session, input)).deliver();
}

async function deliverPreparedEmailVerification(context: EmailVerificationDelivery): Promise<{ accepted: true }> {
  const { session, email, changingEmail, originalEmail, expectedPasswordHash, alreadyVerified, locale } = context;
  if (!changingEmail && alreadyVerified) return { accepted: true };

  const credential = createIdentityToken();
  const token = await db.$transaction(async (tx) => {
    const user = await requireLockedAccount(tx, session);
    if (user.email !== originalEmail) throw new IdentityError("UNAUTHORIZED");
    if (user.passwordHash !== expectedPasswordHash) throw new IdentityError("PASSWORD_INVALID");
    if (!changingEmail && user.emailVerifiedAt) return null;
    if (changingEmail && await mailboxBelongsToAnotherAccount(tx, email, user.id)) return null;
    return tx.accountToken.create({ data: {
      userId: user.id, email, passwordHash: user.passwordHash, tokenHash: credential.tokenHash,
      purpose: changingEmail ? "CHANGE_EMAIL" : "VERIFY_EMAIL", expiresAt: new Date(Date.now() + tokenLifetimeMs),
    } });
  }, transactionOptions);
  if (!token) return { accepted: true };

  try {
    await sendIdentityEmail({ to: token.email, kind: "verify", token: credential.token, locale });
  } catch (error) {
    await revokeUndeliveredToken(token.id);
    // The replacement address may belong to another account; delivery outcomes must not reveal that.
    if (changingEmail) return { accepted: true };
    if (error instanceof IdentityError && error.code === "RATE_LIMITED") throw error;
    throw new IdentityError("EMAIL_DELIVERY_FAILED");
  }
  try {
    await db.$transaction(async (tx) => {
      const user = await requireLockedAccount(tx, session);
      if (user.passwordHash !== token.passwordHash || user.email !== originalEmail) throw new IdentityError("UNAUTHORIZED");
      await markDeliveredToken(tx, token, ["VERIFY_EMAIL", "CHANGE_EMAIL"]);
    }, transactionOptions);
  } catch (error) {
    await revokeUndeliveredToken(token.id);
    throw error;
  }
  return { accepted: true };
}

export async function completeEmailVerification(token: string): Promise<{ requiresReauthentication: boolean }> {
  const tokenHash = hashIdentityToken(token);
  await takeIdentityRateLimit("token", tokenHash);
  const initial = await db.accountToken.findUnique({ where: { tokenHash } });
  if (!isUsableToken(initial, ["VERIFY_EMAIL", "CHANGE_EMAIL"])) throw new IdentityError("INVALID_TOKEN");
  try {
    return await db.$transaction(async (tx) => {
      const user = await lockIdentityUser(tx, initial.userId!);
      const credential = await lockUsableToken(tx, initial, ["VERIFY_EMAIL", "CHANGE_EMAIL"]);
      if (credential.passwordHash !== user.passwordHash) throw new IdentityError("INVALID_TOKEN");
      const changingEmail = credential.purpose === "CHANGE_EMAIL";
      if ((!changingEmail && credential.email !== user.email)
        || (changingEmail && (credential.email === user.email || await mailboxBelongsToAnotherAccount(tx, credential.email, user.id)))) {
        throw new IdentityError("INVALID_TOKEN");
      }
      const now = new Date();
      await tx.user.update({ where: { id: user.id }, data: { email: credential.email, emailVerifiedAt: now } });
      await tx.accountToken.update({ where: { id: credential.id }, data: { consumedAt: now } });
      await revokeAccountTokens(tx, [user.id], now);
      if (changingEmail) await revokeAccountSessions(tx, user.id, now);
      await tx.identityAuditLog.create({ data: {
        action: changingEmail ? "EMAIL_CHANGED" : "EMAIL_VERIFIED", actorUserId: user.id, targetId: user.id,
      } });
      return { requiresReauthentication: changingEmail };
    }, transactionOptions);
  } catch (error) {
    throwTokenError(error);
  }
}

export async function changeAccountPassword(
  session: AccountSessionUser,
  input: { currentPassword: string; newPassword: string },
): Promise<{ requiresReauthentication: true }> {
  validatePassword(input.newPassword);
  await takeIdentityRateLimit("password-change", session.id);
  const verified = await verifyIdentityPassword(session, input.currentPassword);
  const passwordHash = await hashIdentityPassword(input.newPassword);
  return db.$transaction(async (tx) => {
    const user = await requireLockedAccount(tx, session);
    if (user.passwordHash !== verified.passwordHash) throw new IdentityError("PASSWORD_INVALID");
    const now = new Date();
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    await revokeAccountSessions(tx, user.id, now);
    await revokeAccountTokens(tx, [user.id], now);
    await tx.identityAuditLog.create({ data: { action: "PASSWORD_CHANGED", actorUserId: user.id, targetId: user.id } });
    return { requiresReauthentication: true };
  }, transactionOptions);
}

export async function requestPasswordReset(email: string, locale?: Locale): Promise<{ accepted: true }> {
  const normalizedEmail = normalizeEmail(email);
  try {
    await takeIdentityRateLimit("password-reset", normalizedEmail);
  } catch (error) {
    if (error instanceof IdentityError && error.code === "RATE_LIMITED") return { accepted: true };
    throw error;
  }
  const candidate = await db.user.findFirst({
    where: { email: { equals: normalizedEmail, mode: "insensitive" }, status: "ACTIVE", emailVerifiedAt: { not: null } },
    select: { id: true },
  });
  if (!candidate) return { accepted: true };
  const credential = createIdentityToken();
  let token: AccountToken;
  try {
    token = await db.$transaction(async (tx) => {
      const user = await lockIdentityUser(tx, candidate.id);
      if (!user.emailVerifiedAt || user.email.toLowerCase() !== normalizedEmail) throw new IdentityError("INVALID_TOKEN");
      return tx.accountToken.create({ data: {
        userId: user.id, email: user.email, passwordHash: user.passwordHash, tokenHash: credential.tokenHash,
        purpose: "RESET_PASSWORD", expiresAt: new Date(Date.now() + tokenLifetimeMs),
      } });
    }, transactionOptions);
  } catch (error) {
    if (isUnavailableAccount(error)) return { accepted: true };
    throw error;
  }
  try {
    await sendIdentityEmail({ to: token.email, kind: "reset", token: credential.token, locale });
  } catch {
    await revokeUndeliveredToken(token.id);
    return { accepted: true };
  }
  try {
    await db.$transaction(async (tx) => {
      const user = await lockIdentityUser(tx, candidate.id);
      if (!user.emailVerifiedAt || user.email !== token.email || user.passwordHash !== token.passwordHash) throw new IdentityError("INVALID_TOKEN");
      await markDeliveredToken(tx, token, ["RESET_PASSWORD"]);
    }, transactionOptions);
  } catch (error) {
    await revokeUndeliveredToken(token.id);
    if (!isUnavailableAccount(error)) throw error;
  }
  return { accepted: true };
}

export async function resetAccountPassword(token: string, newPassword: string): Promise<{ requiresReauthentication: true }> {
  validatePassword(newPassword);
  const tokenHash = hashIdentityToken(token);
  await takeIdentityRateLimit("token", tokenHash);
  const initial = await db.accountToken.findUnique({ where: { tokenHash } });
  if (!isUsableToken(initial, ["RESET_PASSWORD"])) throw new IdentityError("INVALID_TOKEN");
  const candidate = await db.user.findUnique({ where: { id: initial.userId! } });
  if (!candidate || candidate.status !== "ACTIVE" || !candidate.emailVerifiedAt
    || candidate.email !== initial.email || candidate.passwordHash !== initial.passwordHash) throw new IdentityError("INVALID_TOKEN");
  const passwordHash = await hashIdentityPassword(newPassword);
  try {
    return await db.$transaction(async (tx) => {
      const user = await lockIdentityUser(tx, initial.userId!);
      const credential = await lockUsableToken(tx, initial, ["RESET_PASSWORD"]);
      if (!user.emailVerifiedAt || user.email !== credential.email || user.passwordHash !== credential.passwordHash) throw new IdentityError("INVALID_TOKEN");
      const now = new Date();
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.accountToken.update({ where: { id: credential.id }, data: { consumedAt: now } });
      await revokeAccountSessions(tx, user.id, now);
      await revokeAccountTokens(tx, [user.id], now);
      await tx.identityAuditLog.create({ data: { action: "PASSWORD_RESET", actorUserId: user.id, targetId: user.id } });
      return { requiresReauthentication: true };
    }, transactionOptions);
  } catch (error) {
    throwTokenError(error);
  }
}

export async function revokeOwnSession(
  session: AccountSessionUser,
  targetSessionId: string,
): Promise<{ revoked: true; requiresReauthentication: boolean }> {
  if (typeof targetSessionId !== "string" || !targetSessionId || targetSessionId.length > 128) throw new IdentityError("INVALID_SESSION");
  await takeIdentityRateLimit("session-revoke", session.id);
  return db.$transaction(async (tx) => {
    const user = await requireLockedAccount(tx, session);
    const target = await tx.appSession.findFirst({ where: { id: targetSessionId, userId: user.id }, select: { id: true, revokedAt: true } });
    if (!target) throw new IdentityError("INVALID_SESSION");
    if (!target.revokedAt) {
      await tx.appSession.update({ where: { id: target.id }, data: { revokedAt: new Date() } });
      await tx.identityAuditLog.create({ data: { action: "SESSION_REVOKED", actorUserId: user.id, targetId: target.id } });
    }
    return { revoked: true, requiresReauthentication: target.id === session.appSessionId };
  }, transactionOptions);
}

export async function revokeCurrentAccountSession(session: AccountSessionUser): Promise<void> {
  await db.$transaction(async (tx) => {
    const user = await requireLockedAccount(tx, session);
    await tx.appSession.update({ where: { id: session.appSessionId }, data: { revokedAt: new Date() } });
    await tx.identityAuditLog.create({ data: {
      action: "SESSION_REVOKED", actorUserId: user.id, targetId: session.appSessionId,
    } });
  }, transactionOptions);
}

export async function deactivateOwnAccount(
  session: AccountSessionUser,
  input: { currentPassword: string; confirmed: boolean },
): Promise<{ requiresReauthentication: true }> {
  if (input?.confirmed !== true) throw new IdentityError("INVALID_INPUT");
  await takeIdentityRateLimit("account-deactivate", session.id);
  const verified = await verifyIdentityPassword(session, input.currentPassword);
  return db.$transaction(async (tx) => {
    const user = await requireLockedAccount(tx, session);
    if (user.passwordHash !== verified.passwordHash) throw new IdentityError("PASSWORD_INVALID");
    // Account-only sessions also obey the account's actual current owner obligations.
    const member = await tx.householdMember.findFirst({
      where: { userId: user.id, leftAt: null },
      select: { id: true, householdId: true, role: true, household: { select: { closedAt: true } } },
    });
    if (member?.role === "OWNER" && !member.household.closedAt) {
      const others = await tx.householdMember.count({
        where: { householdId: member.householdId, id: { not: member.id }, leftAt: null, user: { status: "ACTIVE" } },
      });
      throw new IdentityError(others > 0 ? "OWNER_TRANSFER_REQUIRED" : "OWNER_CLOSE_REQUIRED");
    }
    const now = new Date();
    if (member) {
      await tx.householdMember.update({ where: { id: member.id }, data: { leftAt: now } });
      await revokeIssuedInvitations(tx, member.id, now);
    }
    await tx.user.update({ where: { id: user.id }, data: { status: "DEACTIVATED" } });
    await revokeAccountSessions(tx, user.id, now);
    await revokeAccountTokens(tx, [user.id], now);
    await tx.identityAuditLog.create({ data: {
      action: "ACCOUNT_DEACTIVATED", actorUserId: user.id, actorMemberId: member?.id,
      householdId: member?.householdId, targetId: user.id,
    } });
    return { requiresReauthentication: true };
  }, transactionOptions);
}

function normalizeEmail(email: string) {
  if (typeof email !== "string") throw new IdentityError("INVALID_INPUT");
  const result = emailSchema.safeParse(email.trim().toLowerCase());
  if (!result.success) throw new IdentityError("INVALID_INPUT");
  return result.data;
}

function validatePassword(password: string) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) throw new IdentityError("PASSWORD_POLICY");
}

async function mailboxBelongsToAnotherAccount(tx: Prisma.TransactionClient, email: string, userId: string) {
  return !!await tx.user.findFirst({ where: { id: { not: userId }, email: { equals: email, mode: "insensitive" } }, select: { id: true } });
}

function isUsableToken(token: AccountToken | null, purposes: AccountToken["purpose"][]): token is AccountToken {
  return !!token?.userId && !!token.passwordHash && purposes.includes(token.purpose)
    && !!token.sentAt && !token.revokedAt && !token.consumedAt && token.expiresAt.getTime() > Date.now();
}

async function lockUsableToken(tx: Prisma.TransactionClient, initial: AccountToken, purposes: AccountToken["purpose"][]) {
  await tx.$queryRaw`SELECT id FROM "AccountToken" WHERE id = ${initial.id} FOR UPDATE`;
  const token = await tx.accountToken.findUnique({ where: { id: initial.id } });
  if (!isUsableToken(token, purposes) || token.userId !== initial.userId || token.tokenHash !== initial.tokenHash) throw new IdentityError("INVALID_TOKEN");
  return token;
}

async function markDeliveredToken(tx: Prisma.TransactionClient, token: AccountToken, purposes: AccountToken["purpose"][]) {
  await tx.$queryRaw`SELECT id FROM "AccountToken" WHERE id = ${token.id} FOR UPDATE`;
  const current = await tx.accountToken.findUnique({ where: { id: token.id } });
  if (!current || current.revokedAt || current.consumedAt || current.expiresAt.getTime() <= Date.now()) throw new IdentityError("INVALID_TOKEN");
  const now = new Date();
  await tx.accountToken.update({ where: { id: token.id }, data: { sentAt: now } });
  await tx.accountToken.updateMany({
    where: { userId: token.userId, id: { not: token.id }, purpose: { in: purposes }, consumedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
}

async function revokeUndeliveredToken(tokenId: string) {
  await db.accountToken.updateMany({ where: { id: tokenId, sentAt: null, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
}

async function revokeAccountSessions(tx: Prisma.TransactionClient, userId: string, now: Date) {
  await tx.appSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
}

function isUnavailableAccount(error: unknown) {
  return error instanceof IdentityError && ["UNAUTHORIZED", "INVALID_TOKEN"].includes(error.code);
}

function throwTokenError(error: unknown): never {
  if (isUnavailableAccount(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
    throw new IdentityError("INVALID_TOKEN");
  }
  throw error;
}
