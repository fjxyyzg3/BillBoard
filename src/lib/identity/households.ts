import type { Prisma } from "@prisma/client";

import type { AppSessionUser } from "@/lib/auth/app-sessions";
import { resolveHouseholdContext } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { IdentityError, revokeAccountTokens, verifyIdentityPassword } from "./shared";

export async function lockHouseholdMemberships(transaction: Prisma.TransactionClient, householdId: string) {
  await transaction.$queryRaw`SELECT id FROM "Household" WHERE id = ${householdId} FOR UPDATE`;
  // Historical users may now belong to another household; only lock current identities.
  await transaction.$queryRaw`
    SELECT m.id FROM "HouseholdMember" m JOIN "User" u ON u.id = m.user_id
    WHERE m.household_id = ${householdId} AND m.left_at IS NULL
    ORDER BY m.id, u.id FOR UPDATE OF m, u
  `;
}

async function householdContext(transaction: Prisma.TransactionClient, session: AppSessionUser) {
  await lockHouseholdMemberships(transaction, session.householdId);
  try {
    return await resolveHouseholdContext(transaction, session, { lock: true, metadataOnly: true });
  } catch {
    throw new IdentityError("UNAUTHORIZED");
  }
}

async function recheckPassword(
  transaction: Prisma.TransactionClient,
  userId: string,
  passwordHash: string,
) {
  const user = await transaction.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user || user.passwordHash !== passwordHash) throw new IdentityError("UNAUTHORIZED");
}

export async function revokeIssuedInvitations(transaction: Prisma.TransactionClient, memberId: string, now: Date) {
  const invitations = await transaction.invitation.findMany({
    where: { createdByMemberId: memberId, consumedAt: null, revokedAt: null }, select: { id: true },
  });
  const ids = invitations.map(({ id }) => id);
  if (ids.length === 0) return;
  await transaction.invitation.updateMany({ where: { id: { in: ids } }, data: { revokedAt: now } });
  await transaction.accountToken.updateMany({
    where: { invitationId: { in: ids }, consumedAt: null, revokedAt: null }, data: { revokedAt: now },
  });
}

export async function getHouseholdManagement(session: AppSessionUser) {
  return db.$transaction(async (transaction) => {
    const context = await householdContext(transaction, session);
    const [household, members, invitations] = await Promise.all([
      transaction.household.findUniqueOrThrow({ where: { id: context.householdId }, select: { id: true, name: true } }),
      transaction.householdMember.findMany({
        where: { householdId: context.householdId }, orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        select: { id: true, memberName: true, role: true, joinedAt: true, leftAt: true },
      }),
      context.role === "OWNER" ? transaction.invitation.findMany({
        where: { householdId: context.householdId, purpose: "HOUSEHOLD" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
        select: { id: true, purpose: true, email: true, householdId: true, expiresAt: true,
          createdAt: true, sentAt: true, consumedAt: true, revokedAt: true },
      }) : [],
    ]);
    return {
      household, currentMemberId: context.memberId, role: context.role, members,
      invitations: invitations.map((invitation) => ({ ...invitation, householdName: household.name })),
    };
  }, { maxWait: 10_000, timeout: 15_000 });
}

export async function removeHouseholdMember(session: AppSessionUser, targetMemberId: string, currentPassword: string) {
  const verified = await verifyIdentityPassword(session, currentPassword);
  return db.$transaction(async (transaction) => {
    const context = await householdContext(transaction, session);
    await recheckPassword(transaction, context.userId, verified.passwordHash);
    if (context.role !== "OWNER") throw new IdentityError("FORBIDDEN");
    const target = await transaction.householdMember.findFirst({
      where: { id: targetMemberId, householdId: context.householdId, leftAt: null },
      select: { id: true, userId: true, role: true },
    });
    if (!target) throw new IdentityError("MEMBER_NOT_FOUND");
    if (target.role === "OWNER") throw new IdentityError("OWNER_TRANSFER_REQUIRED");
    const now = new Date();
    await transaction.householdMember.update({ where: { id: target.id }, data: { leftAt: now } });
    await transaction.appSession.updateMany({ where: { userId: target.userId, revokedAt: null }, data: { revokedAt: now } });
    await revokeAccountTokens(transaction, [target.userId], now);
    await revokeIssuedInvitations(transaction, target.id, now);
    await transaction.identityAuditLog.create({ data: {
      action: "HOUSEHOLD_MEMBER_REMOVED", actorUserId: context.userId, actorMemberId: context.memberId,
      householdId: context.householdId, targetId: target.id,
    } });
    return { status: "completed" as const };
  }, { maxWait: 10_000, timeout: 15_000 });
}

export async function leaveHousehold(session: AppSessionUser, currentPassword: string) {
  const verified = await verifyIdentityPassword(session, currentPassword);
  return db.$transaction(async (transaction) => {
    const context = await householdContext(transaction, session);
    await recheckPassword(transaction, context.userId, verified.passwordHash);
    if (context.role === "OWNER") throw new IdentityError("OWNER_TRANSFER_REQUIRED");
    const now = new Date();
    await transaction.householdMember.update({ where: { id: context.memberId }, data: { leftAt: now } });
    await transaction.appSession.updateMany({ where: { userId: context.userId, revokedAt: null }, data: { revokedAt: now } });
    await revokeAccountTokens(transaction, [context.userId], now);
    await revokeIssuedInvitations(transaction, context.memberId, now);
    await transaction.identityAuditLog.create({ data: {
      action: "HOUSEHOLD_LEFT", actorUserId: context.userId, actorMemberId: context.memberId,
      householdId: context.householdId, targetId: context.memberId,
    } });
    return { status: "completed" as const };
  }, { maxWait: 10_000, timeout: 15_000 });
}

export async function transferHouseholdOwnership(session: AppSessionUser, targetMemberId: string, currentPassword: string) {
  const verified = await verifyIdentityPassword(session, currentPassword);
  return db.$transaction(async (transaction) => {
    const context = await householdContext(transaction, session);
    await recheckPassword(transaction, context.userId, verified.passwordHash);
    if (context.role !== "OWNER") throw new IdentityError("FORBIDDEN");
    if (targetMemberId === context.memberId) throw new IdentityError("INVALID_INPUT");
    const target = await transaction.householdMember.findFirst({
      where: { id: targetMemberId, householdId: context.householdId, leftAt: null, user: { status: "ACTIVE" } },
      select: { id: true },
    });
    if (!target) throw new IdentityError("MEMBER_NOT_FOUND");
    await transaction.householdMember.update({ where: { id: context.memberId }, data: { role: "MEMBER" } });
    await transaction.householdMember.update({ where: { id: target.id }, data: { role: "OWNER" } });
    await revokeIssuedInvitations(transaction, context.memberId, new Date());
    await transaction.identityAuditLog.create({ data: {
      action: "HOUSEHOLD_OWNERSHIP_TRANSFERRED", actorUserId: context.userId, actorMemberId: context.memberId,
      householdId: context.householdId, targetId: target.id,
    } });
    return { status: "completed" as const };
  }, { maxWait: 10_000, timeout: 15_000 });
}

export async function closeHousehold(
  session: AppSessionUser,
  input: { currentPassword: string; confirmed: boolean },
): Promise<{ requiresReauthentication: true }> {
  if (input?.confirmed !== true) throw new IdentityError("INVALID_INPUT");
  const verified = await verifyIdentityPassword(session, input.currentPassword);
  return db.$transaction(async (transaction) => {
    const context = await householdContext(transaction, session);
    await recheckPassword(transaction, context.userId, verified.passwordHash);
    if (context.role !== "OWNER") throw new IdentityError("FORBIDDEN");
    // Former members may have joined another household. Their new credentials stay intact.
    const members = await transaction.householdMember.findMany({
      where: { householdId: context.householdId, leftAt: null }, select: { userId: true },
    });
    const userIds = members.map(({ userId }) => userId);
    const invitations = await transaction.invitation.findMany({
      where: { householdId: context.householdId, consumedAt: null, revokedAt: null }, select: { id: true },
    });
    const now = new Date();
    await transaction.household.update({ where: { id: context.householdId }, data: { closedAt: now } });
    await transaction.householdMember.updateMany({
      where: { householdId: context.householdId, leftAt: null }, data: { leftAt: now },
    });
    await transaction.appSession.updateMany({ where: { userId: { in: userIds }, revokedAt: null }, data: { revokedAt: now } });
    await revokeAccountTokens(transaction, userIds, now);
    const invitationIds = invitations.map(({ id }) => id);
    if (invitationIds.length > 0) {
      await transaction.invitation.updateMany({ where: { id: { in: invitationIds } }, data: { revokedAt: now } });
      await transaction.accountToken.updateMany({
        where: { invitationId: { in: invitationIds }, consumedAt: null, revokedAt: null }, data: { revokedAt: now },
      });
    }
    await transaction.identityAuditLog.create({ data: {
      action: "HOUSEHOLD_CLOSED", actorUserId: context.userId, actorMemberId: context.memberId,
      householdId: context.householdId, targetId: context.householdId,
    } });
    return { requiresReauthentication: true };
  }, { maxWait: 10_000, timeout: 15_000 });
}
