import { Prisma, type Invitation, type User } from "@prisma/client";

import type { AccountSessionUser, AppSessionUser } from "@/lib/auth/app-sessions";
import { resolveHouseholdContext } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { lockHouseholdMemberships } from "./households";
import { sendIdentityEmail } from "./mail";
import {
  IdentityError, createIdentityToken, hashIdentityToken, hashIdentityPassword,
  requireLockedAccount, takeIdentityRateLimit,
} from "./shared";

type Locale = "zh-CN" | "en-US";
type Transaction = Prisma.TransactionClient;
type Client = Transaction | typeof db;
type InvitationPurpose = "PLATFORM" | "HOUSEHOLD";
export const invitationTtlMs = 7 * 24 * 60 * 60 * 1000;
const registrationTtlMs = 30 * 60 * 1000;
const transactionOptions = { maxWait: 10_000, timeout: 15_000 };
const invitationSelection = {
  id: true, purpose: true, email: true, householdId: true, expiresAt: true,
  createdAt: true, sentAt: true, consumedAt: true, revokedAt: true,
  household: { select: { name: true } },
} satisfies Prisma.InvitationSelect;

function normalizedEmail(value: string) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new IdentityError("INVALID_INPUT");
  return email;
}

function name(value: string | undefined, maxLength = 80) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maxLength) throw new IdentityError("INVALID_INPUT");
  return result;
}

function tokenHash(token: string, code: string) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) throw new IdentityError(code);
  try {
    return hashIdentityToken(token);
  } catch {
    throw new IdentityError(code);
  }
}

function summary(row: Prisma.InvitationGetPayload<{ select: typeof invitationSelection }>) {
  const { household, ...invitation } = row;
  return { ...invitation, householdName: household?.name ?? null };
}

async function loadInvitation(client: Client, hash: string, code = "INVITATION_INVALID", allowUnsent = false) {
  const invitation = await client.invitation.findUnique({
    where: { tokenHash: hash },
    include: {
      household: { select: { id: true, name: true, closedAt: true } },
      createdByMember: { select: { householdId: true, role: true, leftAt: true, user: { select: { status: true } } } },
    },
  });
  if (!invitation || (!allowUnsent && !invitation.sentAt) || invitation.revokedAt || invitation.consumedAt || invitation.expiresAt <= new Date()) {
    throw new IdentityError(code);
  }
  if (invitation.purpose === "PLATFORM") {
    if (invitation.householdId || invitation.createdByMemberId) throw new IdentityError(code);
  } else if (!invitation.household || invitation.household.closedAt || !invitation.createdByMember ||
    invitation.createdByMember.householdId !== invitation.householdId || invitation.createdByMember.leftAt ||
    invitation.createdByMember.role !== "OWNER" || invitation.createdByMember.user.status !== "ACTIVE") {
    throw new IdentityError(code);
  }
  return invitation;
}

async function lockInvitation(
  transaction: Transaction, hash: string, code: string, session?: AccountSessionUser, allowUnsent = false,
): Promise<{ invitation: Awaited<ReturnType<typeof loadInvitation>>; user: User | null }> {
  if (session) {
    if (!session.id || !session.appSessionId) throw new IdentityError("UNAUTHORIZED");
    if (await transaction.householdMember.findFirst({ where: { userId: session.id, leftAt: null }, select: { id: true } })) {
      throw new IdentityError("HOUSEHOLD_MEMBERSHIP_EXISTS");
    }
  }
  const hint = await transaction.invitation.findUnique({ where: { tokenHash: hash }, select: { householdId: true } });
  if (!hint) throw new IdentityError(code);
  if (hint.householdId) await lockHouseholdMemberships(transaction, hint.householdId);
  if (session) {
    // A competing join may have completed while the target household was locked.
    // Reject it before requireLockedAccount could lock that other household.
    await transaction.$queryRaw`SELECT id FROM "User" WHERE id = ${session.id} FOR UPDATE`;
    if (await transaction.householdMember.findFirst({ where: { userId: session.id, leftAt: null }, select: { id: true } })) {
      throw new IdentityError("HOUSEHOLD_MEMBERSHIP_EXISTS");
    }
  }
  const user = session ? await requireLockedAccount(transaction, session) : null;
  await transaction.$queryRaw`SELECT id FROM "Invitation" WHERE token_hash = ${hash} FOR UPDATE`;
  return { invitation: await loadInvitation(transaction, hash, code, allowUnsent), user };
}

async function deliverInvitation(invitation: Invitation, token: string, locale?: Locale, householdName?: string) {
  try {
    await sendIdentityEmail({ to: invitation.email, kind: "invite", token, locale, householdName, invitationPurpose: invitation.purpose });
  } catch (error) {
    await db.invitation.updateMany({ where: { id: invitation.id, consumedAt: null }, data: { revokedAt: new Date() } });
    throw error;
  }
  try {
    return await db.$transaction(async (transaction) => {
      const { invitation: current } = await lockInvitation(transaction, invitation.tokenHash, "INVITATION_INVALID", undefined, true);
      await transaction.invitation.update({ where: { id: current.id }, data: { sentAt: new Date() } });
      return summary(await transaction.invitation.findUniqueOrThrow({ where: { id: current.id }, select: invitationSelection }));
    }, transactionOptions);
  } catch (error) {
    await db.invitation.updateMany({ where: { id: invitation.id, consumedAt: null }, data: { revokedAt: new Date() } });
    throw error;
  }
}

export async function createPlatformInvitation(input: { email: string; locale?: Locale }) {
  const email = normalizedEmail(input.email);
  await takeIdentityRateLimit("invitation", "ops-admin");
  const credential = createIdentityToken();
  const invitation = await db.$transaction(async (transaction) => {
    const row = await transaction.invitation.create({ data: {
      purpose: "PLATFORM", email, tokenHash: credential.tokenHash, expiresAt: new Date(Date.now() + invitationTtlMs),
    } });
    await transaction.identityAuditLog.create({ data: { action: "PLATFORM_INVITATION_CREATED", targetId: row.id } });
    return row;
  });
  return deliverInvitation(invitation, credential.token, input.locale);
}

export async function listPlatformInvitations() {
  const rows = await db.invitation.findMany({
    where: { purpose: "PLATFORM" }, select: invitationSelection,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
  });
  return rows.map(summary);
}

export async function createHouseholdInvitation(session: AppSessionUser, input: { email: string; locale?: Locale }) {
  const email = normalizedEmail(input.email);
  await takeIdentityRateLimit("invitation", session.memberId);
  const credential = createIdentityToken();
  const created = await db.$transaction(async (transaction) => {
    await lockHouseholdMemberships(transaction, session.householdId);
    const context = await resolveHouseholdContext(transaction, session, { lock: true, metadataOnly: true });
    if (context.role !== "OWNER") throw new IdentityError("FORBIDDEN");
    const household = await transaction.household.findUniqueOrThrow({ where: { id: context.householdId }, select: { name: true } });
    const row = await transaction.invitation.create({ data: {
      purpose: "HOUSEHOLD", email, householdId: context.householdId, createdByMemberId: context.memberId,
      tokenHash: credential.tokenHash, expiresAt: new Date(Date.now() + invitationTtlMs),
    } });
    await transaction.identityAuditLog.create({ data: {
      action: "HOUSEHOLD_INVITATION_CREATED", actorUserId: context.userId,
      actorMemberId: context.memberId, householdId: context.householdId, targetId: row.id,
    } });
    return { row, householdName: household.name };
  }, transactionOptions);
  return deliverInvitation(created.row, credential.token, input.locale, created.householdName);
}

async function revokeInvitation(transaction: Transaction, invitationId: string, purpose: InvitationPurpose, householdId?: string, actor?: { userId: string; memberId: string }) {
  await transaction.$queryRaw`
    SELECT id FROM "Invitation" WHERE id = ${invitationId} AND purpose::text = ${purpose}
      AND household_id IS NOT DISTINCT FROM ${householdId ?? null} FOR UPDATE
  `;
  const invitation = await transaction.invitation.findFirst({
    where: { id: invitationId, purpose, ...(householdId ? { householdId } : {}) }, select: invitationSelection,
  });
  if (!invitation || invitation.consumedAt) throw new IdentityError("INVITATION_INVALID");
  if (!invitation.revokedAt) {
    const now = new Date();
    await transaction.invitation.update({ where: { id: invitation.id }, data: { revokedAt: now } });
    await transaction.accountToken.updateMany({
      where: { invitationId: invitation.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now },
    });
    await transaction.identityAuditLog.create({ data: {
      action: "INVITATION_REVOKED", householdId, targetId: invitation.id,
      actorUserId: actor?.userId, actorMemberId: actor?.memberId,
    } });
  }
  return { status: "completed" as const };
}

export async function revokePlatformInvitation(id: string) {
  return db.$transaction((transaction) => revokeInvitation(transaction, id, "PLATFORM"), transactionOptions);
}

export async function revokeHouseholdInvitation(session: AppSessionUser, id: string) {
  return db.$transaction(async (transaction) => {
    await lockHouseholdMemberships(transaction, session.householdId);
    const context = await resolveHouseholdContext(transaction, session, { lock: true, metadataOnly: true });
    if (context.role !== "OWNER") throw new IdentityError("FORBIDDEN");
    return revokeInvitation(transaction, id, "HOUSEHOLD", context.householdId, context);
  }, transactionOptions);
}

export async function getInvitationPreview(token: string) {
  const hash = tokenHash(token, "INVITATION_INVALID");
  await takeIdentityRateLimit("token", hash);
  const invitation = await loadInvitation(db, hash);
  return { purpose: invitation.purpose, email: invitation.email,
    householdName: invitation.household?.name ?? null, expiresAt: invitation.expiresAt };
}

type RegistrationInput = { displayName: string; memberName: string; householdName?: string; password: string; locale?: Locale };

export async function startInvitedRegistration(token: string, input: RegistrationInput) {
  const hash = tokenHash(token, "INVITATION_INVALID");
  const displayName = name(input.displayName);
  const memberName = name(input.memberName);
  await takeIdentityRateLimit("registration", hash);
  const invitation = await loadInvitation(db, hash);
  const householdName = invitation.purpose === "PLATFORM" ? name(input.householdName, 100) : null;
  const passwordHash = await hashIdentityPassword(input.password);
  const credential = createIdentityToken();
  const pending = await db.$transaction(async (transaction) => {
    const { invitation: current } = await lockInvitation(transaction, hash, "INVITATION_INVALID");
    if (await transaction.user.findUnique({ where: { email: current.email }, select: { id: true } })) {
      throw new IdentityError("ACCOUNT_EXISTS");
    }
    const now = new Date();
    const recent = await transaction.accountToken.count({ where: {
      invitationId: current.id, purpose: "REGISTER", createdAt: { gt: new Date(now.getTime() - registrationTtlMs) },
    } });
    if (recent >= 3) throw new IdentityError("RATE_LIMITED");
    const row = await transaction.accountToken.create({ data: {
      purpose: "REGISTER", tokenHash: credential.tokenHash, email: current.email, invitationId: current.id,
      passwordHash, displayName, memberName, householdName,
      expiresAt: new Date(Math.min(current.expiresAt.getTime(), now.getTime() + registrationTtlMs)),
    } });
    return { row, householdName: current.household?.name };
  }, transactionOptions);
  try {
    await sendIdentityEmail({ to: pending.row.email, kind: "registration", token: credential.token,
      locale: input.locale, householdName: pending.householdName, invitationPurpose: invitation.purpose });
  } catch (error) {
    await db.accountToken.updateMany({ where: { id: pending.row.id, consumedAt: null }, data: { revokedAt: new Date() } });
    throw error;
  }
  try {
    await db.$transaction(async (transaction) => {
      const { invitation: current } = await lockInvitation(transaction, hash, "REGISTRATION_INVALID");
      await transaction.$queryRaw`SELECT id FROM "AccountToken" WHERE id = ${pending.row.id} FOR UPDATE`;
      const currentToken = await transaction.accountToken.findUnique({ where: { id: pending.row.id } });
      if (!currentToken || currentToken.invitationId !== current.id || currentToken.revokedAt || currentToken.consumedAt ||
        currentToken.expiresAt <= new Date()) throw new IdentityError("REGISTRATION_INVALID");
      const now = new Date();
      await transaction.accountToken.updateMany({
        where: { invitationId: current.id, purpose: "REGISTER", id: { not: currentToken.id }, consumedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      await transaction.accountToken.update({ where: { id: currentToken.id }, data: { sentAt: now } });
    }, transactionOptions);
  } catch (error) {
    await db.accountToken.updateMany({ where: { id: pending.row.id, consumedAt: null }, data: { revokedAt: new Date() } });
    throw error;
  }
  return { status: "sent" as const };
}

async function createMembership(transaction: Transaction, invitation: Awaited<ReturnType<typeof loadInvitation>>, userId: string, memberName: string, householdName?: string | null) {
  if (await transaction.householdMember.findFirst({ where: { userId, leftAt: null }, select: { id: true } })) {
    throw new IdentityError("HOUSEHOLD_MEMBERSHIP_EXISTS");
  }
  let householdId = invitation.householdId;
  if (invitation.purpose === "PLATFORM") {
    const household = await transaction.household.create({ data: { name: name(householdName ?? undefined, 100) } });
    householdId = household.id;
    await transaction.ledger.create({ data: { householdId, name: "Default", isDefault: true } });
  }
  if (!householdId) throw new IdentityError("INVITATION_INVALID");
  if (await transaction.householdMember.findFirst({ where: { householdId, memberName, leftAt: null }, select: { id: true } })) {
    throw new IdentityError("MEMBER_NAME_TAKEN");
  }
  const member = await transaction.householdMember.create({ data: {
    householdId, userId, memberName, role: invitation.purpose === "PLATFORM" ? "OWNER" : "MEMBER",
  } });
  const now = new Date();
  await transaction.invitation.update({ where: { id: invitation.id }, data: { consumedAt: now } });
  await transaction.accountToken.updateMany({
    where: { invitationId: invitation.id, purpose: "REGISTER", consumedAt: null, revokedAt: null }, data: { revokedAt: now },
  });
  await transaction.appSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await transaction.identityAuditLog.create({ data: {
    action: "INVITATION_ACCEPTED", actorUserId: userId, actorMemberId: member.id, householdId, targetId: invitation.id,
  } });
  return { status: "completed" as const, householdId, memberId: member.id };
}

export async function completeInvitedRegistration(registrationToken: string) {
  const hash = tokenHash(registrationToken, "REGISTRATION_INVALID");
  await takeIdentityRateLimit("token", hash);
  const hint = await db.accountToken.findUnique({ where: { tokenHash: hash }, select: { invitationId: true, purpose: true } });
  if (!hint?.invitationId || hint.purpose !== "REGISTER") throw new IdentityError("REGISTRATION_INVALID");
  const target = await db.invitation.findUnique({ where: { id: hint.invitationId }, select: { tokenHash: true } });
  if (!target) throw new IdentityError("REGISTRATION_INVALID");
  return db.$transaction(async (transaction) => {
    const { invitation } = await lockInvitation(transaction, target.tokenHash, "REGISTRATION_INVALID");
    await transaction.$queryRaw`SELECT id FROM "AccountToken" WHERE token_hash = ${hash} FOR UPDATE`;
    const pending = await transaction.accountToken.findUnique({ where: { tokenHash: hash } });
    if (!pending || pending.purpose !== "REGISTER" || pending.invitationId !== invitation.id ||
      pending.email !== invitation.email || !pending.sentAt || pending.revokedAt || pending.consumedAt ||
      pending.expiresAt <= new Date() || !pending.passwordHash || !pending.displayName || !pending.memberName) {
      throw new IdentityError("REGISTRATION_INVALID");
    }
    if (await transaction.user.findUnique({ where: { email: pending.email }, select: { id: true } })) throw new IdentityError("ACCOUNT_EXISTS");
    const user = await transaction.user.create({ data: {
      email: pending.email, displayName: pending.displayName, passwordHash: pending.passwordHash, emailVerifiedAt: new Date(),
    } });
    const result = await createMembership(transaction, invitation, user.id, pending.memberName, pending.householdName);
    await transaction.accountToken.update({ where: { id: pending.id }, data: { consumedAt: new Date(), revokedAt: null } });
    return result;
  }, transactionOptions);
}

export async function acceptInvitation(session: AccountSessionUser, token: string, input: { memberName: string; householdName?: string }) {
  const hash = tokenHash(token, "INVITATION_INVALID");
  const memberName = name(input.memberName);
  await takeIdentityRateLimit("token", hash);
  return db.$transaction(async (transaction) => {
    const { invitation, user } = await lockInvitation(transaction, hash, "INVITATION_INVALID", session);
    if (!user || !user.emailVerifiedAt) throw new IdentityError("EMAIL_NOT_VERIFIED");
    if (user.email !== invitation.email) throw new IdentityError("INVITATION_INVALID");
    return createMembership(transaction, invitation, user.id, memberName, input.householdName);
  }, transactionOptions);
}
