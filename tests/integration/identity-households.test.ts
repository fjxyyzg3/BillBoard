import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
let households: typeof import("@/lib/identity/households");
let shared: typeof import("@/lib/identity/shared");
let passwordHash: string;
const password = "Synthetic-household-password-42";
const householdIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Household identity tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  households = await import("@/lib/identity/households");
  shared = await import("@/lib/identity/shared");
  passwordHash = await hash(password);
});

beforeEach(async () => {
  await db.loginBudget.upsert({ where: { id: 1 }, create: { id: 1, tokens: 10, refilledAt: new Date() }, update: { tokens: 10, refilledAt: new Date() } });
});

afterEach(async () => {
  const invitations = await db.invitation.findMany({ where: { householdId: { in: householdIds } }, select: { id: true } });
  await db.accountToken.deleteMany({ where: { OR: [
    { userId: { in: userIds } }, { invitationId: { in: invitations.map(({ id }) => id) } },
  ] } });
  await db.invitation.deleteMany({ where: { householdId: { in: householdIds } } });
  await db.identityAuditLog.deleteMany({ where: { householdId: { in: householdIds } } });
  await db.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});
afterAll(async () => { await db?.$disconnect(); });

async function fixture() {
  const household = await db.household.create({ data: { name: "Household identity fixture" } });
  householdIds.push(household.id);
  const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const people = [];
  for (const role of ["OWNER", "MEMBER"] as const) {
    const user = await db.user.create({ data: {
      email: `household-${randomUUID()}@example.com`, displayName: role, passwordHash, emailVerifiedAt: new Date(),
    } });
    userIds.push(user.id);
    const member = await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: role, role } });
    const appSession = await db.appSession.create({ data: {
      userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 120_000),
    } });
    people.push({ user, member, appSession, session: {
      id: user.id, email: user.email, name: user.displayName, householdId: household.id, memberId: member.id, appSessionId: appSession.id, role,
    } });
  }
  return { household, ledger, owner: people[0]!, partner: people[1]! };
}

async function pendingInvitation(current: Awaited<ReturnType<typeof fixture>>) {
  const credential = shared.createIdentityToken();
  const invitation = await db.invitation.create({ data: {
    purpose: "HOUSEHOLD", email: `pending-${randomUUID()}@example.com`, tokenHash: credential.tokenHash,
    householdId: current.household.id, createdByMemberId: current.owner.member.id,
    expiresAt: new Date(Date.now() + 120_000), sentAt: new Date(),
  } });
  const registration = await db.accountToken.create({ data: {
    purpose: "REGISTER", email: invitation.email, invitationId: invitation.id, tokenHash: shared.createIdentityToken().tokenHash,
    passwordHash, displayName: "Pending", memberName: "Pending", expiresAt: invitation.expiresAt, sentAt: new Date(),
  } });
  return { invitation, registration };
}

describe("household membership lifecycle", () => {
  it("shows shared membership history without another member's email or account security data", async () => {
    const current = await fixture();
    const outside = await fixture();
    const result = await households.getHouseholdManagement(current.owner.session);
    expect(result.members.map(({ id }) => id).sort()).toEqual([current.owner.member.id, current.partner.member.id].sort());
    expect(JSON.stringify(result.members)).not.toContain(current.partner.user.email);
    expect(JSON.stringify(result)).not.toContain(outside.household.id);
    expect(Object.keys(result.members[0]!).sort()).toEqual(["id", "joinedAt", "leftAt", "memberName", "role"]);
  });

  it("blocks the current owner from leaving or removing themself before ownership is transferred", async () => {
    const current = await fixture();
    await expect(households.leaveHousehold(current.owner.session, password)).rejects.toMatchObject({ code: "OWNER_TRANSFER_REQUIRED" });
    await expect(households.removeHouseholdMember(current.owner.session, current.owner.member.id, password))
      .rejects.toMatchObject({ code: "OWNER_TRANSFER_REQUIRED" });
    expect((await db.householdMember.findUniqueOrThrow({ where: { id: current.owner.member.id } })).leftAt).toBeNull();
  });

  it("prevents ordinary members from removing people or transferring ownership", async () => {
    const current = await fixture();
    await expect(households.removeHouseholdMember(current.partner.session, current.owner.member.id, password)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(households.transferHouseholdOwnership(current.partner.session, current.owner.member.id, password)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ends a member identity and credentials while retaining its original financial references", async () => {
    const current = await fixture();
    const category = await db.category.findFirstOrThrow({ where: { type: "EXPENSE", isActive: true } });
    const record = await db.transaction.create({ data: {
      householdId: current.household.id, ledgerId: current.ledger.id, actorMemberId: current.partner.member.id,
      createdByMemberId: current.partner.member.id, categoryId: category.id, type: "EXPENSE", amountFen: 1234, occurredAt: new Date(),
    } });
    const token = await db.accountToken.create({ data: {
      purpose: "RESET_PASSWORD", userId: current.partner.user.id, email: current.partner.user.email,
      passwordHash, tokenHash: shared.createIdentityToken().tokenHash, expiresAt: new Date(Date.now() + 60_000),
    } });
    await households.removeHouseholdMember(current.owner.session, current.partner.member.id, password);
    expect(await db.householdMember.findUniqueOrThrow({ where: { id: current.partner.member.id } })).toMatchObject({ leftAt: expect.any(Date) });
    expect(await db.appSession.findUniqueOrThrow({ where: { id: current.partner.appSession.id } })).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await db.accountToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await db.transaction.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      householdId: current.household.id, actorMemberId: current.partner.member.id, createdByMemberId: current.partner.member.id, amountFen: 1234,
    });
    await expect(households.getHouseholdManagement(current.partner.session)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("transfers ownership atomically and revokes the old owner's unconsumed invitations", async () => {
    const current = await fixture();
    const pending = await pendingInvitation(current);
    await households.transferHouseholdOwnership(current.owner.session, current.partner.member.id, password);
    expect(await db.householdMember.findUniqueOrThrow({ where: { id: current.owner.member.id } })).toMatchObject({ role: "MEMBER", leftAt: null });
    expect(await db.householdMember.findUniqueOrThrow({ where: { id: current.partner.member.id } })).toMatchObject({ role: "OWNER", leftAt: null });
    expect(await db.invitation.findUniqueOrThrow({ where: { id: pending.invitation.id } })).toMatchObject({ revokedAt: expect.any(Date), consumedAt: null });
    expect(await db.accountToken.findUniqueOrThrow({ where: { id: pending.registration.id } })).toMatchObject({ revokedAt: expect.any(Date) });
    await households.leaveHousehold(current.owner.session, password);
    expect(await db.householdMember.count({ where: { householdId: current.household.id, role: "OWNER", leftAt: null } })).toBe(1);
  });

  it("rejects foreign targets and incorrect current passwords without changing the household", async () => {
    const current = await fixture();
    const outside = await fixture();
    await expect(households.removeHouseholdMember(current.owner.session, outside.partner.member.id, password)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    await expect(households.transferHouseholdOwnership(current.owner.session, current.partner.member.id, "Incorrect-password"))
      .rejects.toMatchObject({ code: "PASSWORD_INVALID" });
    expect(await db.householdMember.count({ where: { householdId: current.household.id, leftAt: null } })).toBe(2);
  });

  it("waits for ownership changes before deciding whether management can show invitation recipients", async () => {
    const current = await fixture();
    await pendingInvitation(current);
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const transferring = db.$transaction(async (transaction) => {
      await households.lockHouseholdMemberships(transaction, current.household.id);
      await transaction.householdMember.update({ where: { id: current.owner.member.id }, data: { role: "MEMBER" } });
      await transaction.householdMember.update({ where: { id: current.partner.member.id }, data: { role: "OWNER" } });
      acquired();
      await hold;
    }, { timeout: 5_000 });
    await ready;
    const reading = households.getHouseholdManagement(current.owner.session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reading.then(() => "returned"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("waiting"), 300); }),
      ]);
      expect(result).toBe("waiting");
    } finally {
      clearTimeout(timer);
      release();
      await transferring;
    }
    const result = await reading;
    expect(result.role).toBe("MEMBER");
    expect(result.invitations).toEqual([]);
  });
});
