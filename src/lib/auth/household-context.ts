import { type HouseholdRole, type Prisma, type PrismaClient } from "@prisma/client";

export type HouseholdSession = {
  householdId: string;
  memberId: string;
  id?: string;
  appSessionId?: string;
};

type Client = PrismaClient | Prisma.TransactionClient;

export async function resolveHouseholdContext(
  client: Client,
  session: HouseholdSession,
  options: { lock?: boolean; ledgerId?: string; metadataOnly?: boolean } = {},
): Promise<{ householdId: string; memberId: string; userId: string; role: HouseholdRole; ledgerId: string; ledgerName: string }> {
  if (!session?.householdId || !session.memberId) throw new Error("Unauthorized");

  if (options.lock) {
    // All household writes and future membership transitions use this lock order.
    // Locking the user/session also orders an in-flight write against OPS revocation.
    await client.$queryRaw`SELECT id FROM "Household" WHERE id = ${session.householdId} FOR UPDATE`;
    await client.$queryRaw`
      SELECT m.id FROM "HouseholdMember" m JOIN "User" u ON u.id = m.user_id
      WHERE m.id = ${session.memberId} AND m.household_id = ${session.householdId}
      FOR UPDATE OF m, u
    `;
    if (session.appSessionId) {
      await client.$queryRaw`SELECT id FROM "AppSession" WHERE id = ${session.appSessionId} FOR SHARE`;
    }
  }

  const member = await client.householdMember.findFirst({
    where: {
      id: session.memberId,
      householdId: session.householdId,
      ...(session.id ? { userId: session.id } : {}),
      leftAt: null,
      household: { closedAt: null },
      user: { status: "ACTIVE" },
    },
    select: { id: true, householdId: true, userId: true, role: true },
  });
  if (!member) throw new Error("Unauthorized");

  if (session.appSessionId && !await client.appSession.findFirst({
    where: {
      id: session.appSessionId,
      userId: member.userId,
      memberId: member.id,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  })) throw new Error("Unauthorized");

  if (options.lock) {
    if (options.ledgerId) {
      await client.$queryRaw`SELECT id FROM "Ledger" WHERE id = ${options.ledgerId} AND household_id = ${member.householdId} FOR UPDATE`;
    } else {
      await client.$queryRaw`SELECT id FROM "Ledger" WHERE household_id = ${member.householdId} AND is_default FOR UPDATE`;
    }
  }
  const ledger = await client.ledger.findFirst({
    where: {
      householdId: member.householdId,
      archivedAt: null,
      ...(options.ledgerId ? { id: options.ledgerId } : { isDefault: true }),
    },
    select: { id: true, ...(!options.metadataOnly ? { name: true } : {}) },
  });
  if (!ledger) throw new Error("Ledger is unavailable");

  return { householdId: member.householdId, memberId: member.id, userId: member.userId, role: member.role, ledgerId: ledger.id, ledgerName: ledger.name ?? "" };
}
