import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
let loadSession: typeof import("@/lib/auth/app-sessions").loadValidAppSessionUser;
let loadAccount: typeof import("@/lib/auth/app-sessions").loadValidAccountSessionUser;
let ensureSession: typeof import("@/lib/auth/app-sessions").ensureAppSessionForToken;
let resolveContext: typeof import("@/lib/auth/household-context").resolveHouseholdContext;
const households: string[] = [];
const users: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Household authorization tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  ({ loadValidAppSessionUser: loadSession } = await import("@/lib/auth/app-sessions"));
  ({ loadValidAccountSessionUser: loadAccount, ensureAppSessionForToken: ensureSession } = await import("@/lib/auth/app-sessions"));
  ({ resolveHouseholdContext: resolveContext } = await import("@/lib/auth/household-context"));
});

afterAll(async () => {
  if (!db) return;
  await db.ledgerAuditLog.deleteMany({ where: { householdId: { in: households } } });
  await db.appEvent.deleteMany({ where: { householdId: { in: households } } });
  await db.transaction.deleteMany({ where: { householdId: { in: households } } });
  await db.naturalLanguageRequest.deleteMany({ where: { householdId: { in: households } } });
  await db.importDraft.deleteMany({ where: { householdId: { in: households } } });
  await db.household.deleteMany({ where: { id: { in: households } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

async function fixture() {
  const household = await db.household.create({ data: { name: "Authorization fixture" } });
  households.push(household.id);
  const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const user = await db.user.create({ data: {
    email: `context-${randomUUID()}@example.com`, displayName: "Owner", passwordHash: "test-only",
  } });
  users.push(user.id);
  const member = await db.householdMember.create({ data: {
    householdId: household.id, userId: user.id, memberName: "Owner", role: "OWNER",
  } });
  const appSession = await db.appSession.create({ data: {
    sessionKey: randomUUID(), userId: user.id, memberId: member.id, expiresAt: new Date(Date.now() + 60_000),
  } });
  const session = { id: user.id, householdId: household.id, memberId: member.id, appSessionId: appSession.id };
  return { household, ledger, user, member, appSession, session };
}

describe("household authorization foundation", () => {
  it("returns the trusted effective role and server session identity", async () => {
    const current = await fixture();
    expect(await loadSession(current.appSession.id)).toMatchObject({
      id: current.user.id, householdId: current.household.id, memberId: current.member.id,
      role: "OWNER", appSessionId: current.appSession.id,
    });
    expect(await db.appSession.findUnique({ where: { id: current.appSession.id } })).toMatchObject({
      expiresAt: current.appSession.expiresAt, revokedAt: current.appSession.revokedAt, memberId: current.member.id,
    });
  });

  it("resolves only an effective member's available household ledger", async () => {
    const current = await fixture();
    const outside = await fixture();
    expect(await resolveContext(db, current.session)).toEqual({
      householdId: current.household.id, memberId: current.member.id, userId: current.user.id,
      role: "OWNER", ledgerId: current.ledger.id, ledgerName: "Default",
    });
    await expect(resolveContext(db, current.session, { ledgerId: outside.ledger.id })).rejects.toThrow("Ledger is unavailable");
    await expect(resolveContext(db, { ...current.session, memberId: outside.member.id })).rejects.toThrow("Unauthorized");
    const archived = await db.ledger.create({ data: { householdId: current.household.id, name: "Archived", archivedAt: new Date() } });
    await expect(resolveContext(db, current.session, { ledgerId: archived.id })).rejects.toThrow("Ledger is unavailable");
    await db.household.update({ where: { id: current.household.id }, data: { closedAt: new Date() } });
    await expect(resolveContext(db, current.session)).rejects.toThrow("Unauthorized");
    expect(await loadSession(current.appSession.id)).toBeNull();
  });

  it("refuses a missing default ledger without repairing the database", async () => {
    const current = await fixture();
    await db.ledger.delete({ where: { id: current.ledger.id } });
    await expect(resolveContext(db, current.session)).rejects.toThrow("Ledger is unavailable");
    expect(await db.ledger.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("preserves historical identities and never promotes old sessions or legacy JWTs after rejoining", async () => {
    const current = await fixture();
    await db.householdMember.update({ where: { id: current.member.id }, data: { leftAt: new Date() } });
    const rejoined = await db.householdMember.create({ data: {
      householdId: current.household.id, userId: current.user.id, memberName: current.member.memberName, role: "OWNER",
    } });
    expect(rejoined.id).not.toBe(current.member.id);
    expect(await loadSession(current.appSession.id)).toBeNull();
    await expect(resolveContext(db, current.session)).rejects.toThrow("Unauthorized");
    expect(await ensureSession({
      sub: current.user.id, memberId: current.member.id, householdId: current.household.id,
      jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + 60,
    }, null)).toBeNull();
    expect(await resolveContext(db, { id: current.user.id, householdId: current.household.id, memberId: rejoined.id })).toMatchObject({ memberId: rejoined.id });
    expect(await db.householdMember.count({ where: { userId: current.user.id } })).toBe(2);
  });

  it("lets an account-only session stay account-only when a new membership appears", async () => {
    const current = await fixture();
    const accountSession = await db.appSession.create({ data: { userId: current.user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    expect(await loadAccount(accountSession.id)).toMatchObject({ id: current.user.id, appSessionId: accountSession.id });
    expect((await loadAccount(accountSession.id))?.memberId).toBeUndefined();
    expect(await loadSession(accountSession.id)).toBeNull();
    await expect(resolveContext(db, { ...current.session, appSessionId: accountSession.id })).rejects.toThrow("Unauthorized");
  });

  it("recovers a valid legacy JWT without extending expiry or reviving a revoked session", async () => {
    const current = await fixture();
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);
    const token = { sub: current.user.id, householdId: current.household.id, memberId: current.member.id, jti: randomUUID(), iat: Math.floor(Date.now() / 1000) - 1, exp: expiresAt.getTime() / 1000 };
    const sessionId = await ensureSession(token, null);
    expect(sessionId).toBeTruthy();
    const recovered = await db.appSession.findUniqueOrThrow({ where: { id: sessionId! } });
    expect(recovered).toMatchObject({ memberId: current.member.id, expiresAt, revokedAt: null });
    await db.appSession.update({ where: { id: recovered.id }, data: { revokedAt: new Date() } });
    const replayId = await ensureSession({ ...token, appSessionId: undefined, exp: token.exp + 1000 }, null);
    expect(replayId).toBe(recovered.id);
    expect(await loadSession(recovered.id)).toBeNull();
    expect((await db.appSession.findUniqueOrThrow({ where: { id: recovered.id } })).expiresAt).toEqual(expiresAt);
  });

  it("enforces active account, nickname and owner uniqueness while permitting matching historical names", async () => {
    const current = await fixture();
    const outside = await fixture();
    await expect(db.householdMember.create({ data: { householdId: outside.household.id, userId: current.user.id, memberName: "Different", role: "MEMBER" } })).rejects.toThrow();
    const extra = await db.user.create({ data: { email: `extra-${randomUUID()}@example.com`, displayName: "Extra", passwordHash: "test-only" } });
    users.push(extra.id);
    await expect(db.householdMember.create({ data: { householdId: current.household.id, userId: extra.id, memberName: current.member.memberName, role: "MEMBER" } })).rejects.toThrow();
    await expect(db.householdMember.create({ data: { householdId: current.household.id, userId: extra.id, memberName: "Other", role: "OWNER" } })).rejects.toThrow();
    await expect(db.householdMember.create({ data: { householdId: current.household.id, userId: current.user.id, memberName: current.member.memberName, role: "OWNER", leftAt: new Date() } })).resolves.toMatchObject({ leftAt: expect.any(Date) });
    await expect(db.householdMember.update({ where: { id: current.member.id }, data: { householdId: outside.household.id } })).rejects.toThrow();
    await expect(db.ledger.update({ where: { id: current.ledger.id }, data: { archivedAt: new Date() } })).rejects.toThrow();
    await expect(db.ledger.create({ data: { householdId: current.household.id, name: "Second default", isDefault: true } })).rejects.toThrow();
  });

  it("rejects cross-household associations at the database boundary", async () => {
    const current = await fixture();
    const outside = await fixture();
    const category = await db.category.findFirstOrThrow();
    const transaction = { householdId: current.household.id, ledgerId: current.ledger.id, actorMemberId: current.member.id, createdByMemberId: current.member.id, amountFen: 100, categoryId: category.id, occurredAt: new Date(), type: "EXPENSE" as const };
    await expect(db.transaction.create({ data: { ...transaction, ledgerId: outside.ledger.id } })).rejects.toThrow();
    await expect(db.transaction.create({ data: { ...transaction, actorMemberId: outside.member.id } })).rejects.toThrow();
    await expect(db.transaction.create({ data: { ...transaction, createdByMemberId: outside.member.id } })).rejects.toThrow();
    await expect(db.naturalLanguageRequest.create({ data: { householdId: current.household.id, ledgerId: current.ledger.id, createdByMemberId: outside.member.id, clientRequestId: randomUUID(), status: "FAILED" } })).rejects.toThrow();
    await expect(db.importDraft.create({ data: { householdId: current.household.id, ledgerId: outside.ledger.id, createdByMemberId: current.member.id, source: "test", fileName: "test.xlsx" } })).rejects.toThrow();
    await expect(db.importMemberMapping.create({ data: { householdId: current.household.id, memberId: outside.member.id, source: "test", externalName: "Other" } })).rejects.toThrow();
    await expect(db.appEvent.create({ data: { householdId: current.household.id, memberId: outside.member.id, eventType: "PAGE_VIEW" } })).rejects.toThrow();
    await expect(db.appSession.create({ data: { userId: current.user.id, memberId: outside.member.id, sessionKey: randomUUID(), expiresAt: new Date() } })).rejects.toThrow();
    const draft = await db.importDraft.create({ data: { householdId: current.household.id, ledgerId: current.ledger.id, createdByMemberId: current.member.id, source: "test", fileName: "test.xlsx" } });
    await expect(db.importDraftRow.create({ data: { draftId: draft.id, rowNumber: 1, status: "READY", actorMemberId: outside.member.id } })).rejects.toThrow();
  });

  it("orders a final write before concurrent membership and session revocation", async () => {
    const current = await fixture();
    const category = await db.category.findFirstOrThrow();
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const writing = db.$transaction(async (tx) => {
      const context = await resolveContext(tx, current.session, { lock: true });
      acquired();
      await finish;
      return tx.transaction.create({ data: {
        householdId: context.householdId, ledgerId: context.ledgerId,
        actorMemberId: context.memberId, createdByMemberId: context.memberId,
        categoryId: category.id, type: "EXPENSE", amountFen: 100, occurredAt: new Date(),
      } });
    });
    await ready;
    try {
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
        await tx.householdMember.update({ where: { id: current.member.id }, data: { leftAt: new Date() } });
      })).rejects.toThrow();
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
        await tx.appSession.update({ where: { id: current.appSession.id }, data: { revokedAt: new Date() } });
      })).rejects.toThrow();
    } finally {
      release();
      await writing;
    }
    await db.appSession.update({ where: { id: current.appSession.id }, data: { revokedAt: new Date() } });
    await expect(db.$transaction((tx) => resolveContext(tx, current.session, { lock: true }))).rejects.toThrow("Unauthorized");
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(1);
  });

  it("does not delete historical membership or request outcomes when an account is deleted", async () => {
    const current = await fixture();
    await db.householdMember.update({ where: { id: current.member.id }, data: { leftAt: new Date() } });
    const request = await db.naturalLanguageRequest.create({ data: {
      householdId: current.household.id, ledgerId: current.ledger.id, createdByMemberId: current.member.id,
      clientRequestId: randomUUID(), status: "FAILED", errorCode: "NOT_ACCEPTED",
    } });
    await expect(db.user.delete({ where: { id: current.user.id } })).rejects.toThrow();
    expect(await db.householdMember.findUnique({ where: { id: current.member.id } })).toMatchObject({ userId: current.user.id });
    expect(await db.naturalLanguageRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: "FAILED", errorCode: "NOT_ACCEPTED" });
  });

  it("stores minimal ledger audit targets and rejects cross-household audit references", async () => {
    const [{ present }] = await db.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass('"LedgerAuditLog"') IS NOT NULL AS present`;
    expect(present).toBe(true);
    const current = await fixture();
    const outside = await fixture();
    const data = { householdId: current.household.id, memberId: current.member.id, ledgerId: current.ledger.id, action: "TRANSACTION_UPDATED" as const, targetId: randomUUID() };
    const audit = await db.ledgerAuditLog.create({ data });
    expect(audit).toMatchObject({ ...data, id: expect.any(String), createdAt: expect.any(Date) });
    expect(Object.keys(audit).sort()).toEqual(["action", "createdAt", "householdId", "id", "ledgerId", "memberId", "targetId"]);
    await expect(db.ledgerAuditLog.create({ data: { ...data, memberId: outside.member.id } })).rejects.toThrow();
    await expect(db.ledgerAuditLog.create({ data: { ...data, ledgerId: outside.ledger.id } })).rejects.toThrow();
    await db.ledgerAuditLog.deleteMany({ where: { householdId: current.household.id } });
  });
});
