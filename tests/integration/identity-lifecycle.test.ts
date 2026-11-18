import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSessionUser, AppSessionUser } from "@/lib/auth/app-sessions";

process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
let account: typeof import("@/lib/identity/account");
let households: typeof import("@/lib/identity/households");
let shared: typeof import("@/lib/identity/shared");
let sessions: typeof import("@/lib/auth/app-sessions");
let createTransaction: typeof import("@/lib/transactions/create-transaction").createTransaction;
let queryHomeReport: typeof import("@/lib/reports/query-home-report").queryHomeReport;
let resolveContext: typeof import("@/lib/auth/household-context").resolveHouseholdContext;
let passwordHash: string;
const password = "Synthetic-lifecycle-password-42";
const householdIds: string[] = [];
const userIds: string[] = [];
const confirmed = { currentPassword: password, confirmed: true };

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Lifecycle tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  account = await import("@/lib/identity/account");
  households = await import("@/lib/identity/households");
  shared = await import("@/lib/identity/shared");
  sessions = await import("@/lib/auth/app-sessions");
  ({ createTransaction } = await import("@/lib/transactions/create-transaction"));
  ({ queryHomeReport } = await import("@/lib/reports/query-home-report"));
  ({ resolveHouseholdContext: resolveContext } = await import("@/lib/auth/household-context"));
  passwordHash = await hash(password);
});

beforeEach(async () => {
  await db.loginBudget.upsert({ where: { id: 1 }, create: { id: 1, tokens: 10, refilledAt: new Date() }, update: { tokens: 10, refilledAt: new Date() } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  const invitations = await db.invitation.findMany({ where: { householdId: { in: householdIds } }, select: { id: true } });
  await db.accountToken.deleteMany({ where: { OR: [
    { userId: { in: userIds } }, { invitationId: { in: invitations.map(({ id }) => id) } },
  ] } });
  await db.invitation.deleteMany({ where: { householdId: { in: householdIds } } });
  await db.identityAuditLog.deleteMany({ where: { OR: [{ householdId: { in: householdIds } }, { actorUserId: { in: userIds } }] } });
  await db.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});
afterAll(async () => { await db?.$disconnect(); });

async function createAccount(label: string) {
  const user = await db.user.create({ data: {
    email: `lifecycle-${randomUUID()}@example.com`, displayName: label, passwordHash, emailVerifiedAt: new Date(),
  } });
  userIds.push(user.id);
  return user;
}

async function fixture(memberCount = 2) {
  const household = await db.household.create({ data: { name: "Lifecycle fixture" } });
  householdIds.push(household.id);
  const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const people = [];
  for (let index = 0; index < memberCount; index++) {
    const role = index === 0 ? "OWNER" : "MEMBER";
    const user = await createAccount(`${role}-${index}`);
    const member = await db.householdMember.create({ data: {
      householdId: household.id, userId: user.id, memberName: user.displayName, role,
    } });
    const appSession = await db.appSession.create({ data: {
      userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const session: AppSessionUser = {
      id: user.id, email: user.email, name: user.displayName, householdId: household.id, memberId: member.id,
      appSessionId: appSession.id, role,
    };
    people.push({ user, member, appSession, session });
  }
  return { household, ledger, owner: people[0]!, partner: people[1]!, people };
}

async function recoveryToken(user: Awaited<ReturnType<typeof createAccount>>) {
  const credential = shared.createIdentityToken();
  const record = await db.accountToken.create({ data: {
    purpose: "RESET_PASSWORD", userId: user.id, email: user.email, passwordHash: user.passwordHash,
    tokenHash: credential.tokenHash, expiresAt: new Date(Date.now() + 60_000), sentAt: new Date(),
  } });
  return { ...credential, record };
}

async function pendingInvitation(current: Awaited<ReturnType<typeof fixture>>) {
  const invitation = await db.invitation.create({ data: {
    purpose: "HOUSEHOLD", email: `lifecycle-pending-${randomUUID()}@example.com`, tokenHash: shared.createIdentityToken().tokenHash,
    householdId: current.household.id, createdByMemberId: current.owner.member.id,
    expiresAt: new Date(Date.now() + 120_000), sentAt: new Date(),
  } });
  const registration = await db.accountToken.create({ data: {
    purpose: "REGISTER", email: invitation.email, invitationId: invitation.id, tokenHash: shared.createIdentityToken().tokenHash,
    passwordHash, displayName: "Pending", memberName: "Pending", expiresAt: invitation.expiresAt, sentAt: new Date(),
  } });
  return { invitation, registration };
}

async function retainedHistory(current: Awaited<ReturnType<typeof fixture>>) {
  const member = current.partner ?? current.owner;
  const category = await db.category.findFirstOrThrow({ where: { type: "EXPENSE", isActive: true } });
  const transaction = await db.transaction.create({ data: {
    householdId: current.household.id, ledgerId: current.ledger.id, actorMemberId: member.member.id,
    createdByMemberId: member.member.id, categoryId: category.id, type: "EXPENSE", amountFen: 1234,
    occurredAt: new Date("2026-10-15T04:00:00Z"), source: "wechat", sourceFingerprint: randomUUID(), sourceImportedAt: new Date(),
  } });
  const draft = await db.importDraft.create({ data: {
    householdId: current.household.id, ledgerId: current.ledger.id, createdByMemberId: member.member.id,
    source: "wechat", fileName: "synthetic.xlsx", status: "COMPLETED", completedAt: new Date(),
    rows: { create: { rowNumber: 1, status: "READY", transactionType: "EXPENSE", amountFen: 1234,
      actorMemberId: member.member.id, createdByMemberId: member.member.id, sourceFingerprint: transaction.sourceFingerprint } },
  }, include: { rows: true } });
  const mapping = await db.importCategoryMapping.create({ data: {
    householdId: current.household.id, source: "wechat", transactionType: "EXPENSE", primaryCategory: "Food",
    secondaryCategory: "Dining", categoryId: category.id,
  } });
  const request = await db.naturalLanguageRequest.create({ data: {
    householdId: current.household.id, ledgerId: current.ledger.id, createdByMemberId: member.member.id,
    clientRequestId: randomUUID(), status: "SUCCEEDED", result: { ids: [transaction.id] },
  } });
  return { transaction, draft, mapping, request, category };
}

async function expectHistoryUnchanged(history: Awaited<ReturnType<typeof retainedHistory>>) {
  expect(await db.transaction.findUniqueOrThrow({ where: { id: history.transaction.id } })).toEqual(history.transaction);
  expect(await db.importDraft.findUniqueOrThrow({ where: { id: history.draft.id }, include: { rows: true } })).toEqual(history.draft);
  expect(await db.importCategoryMapping.findUniqueOrThrow({ where: { id: history.mapping.id } })).toEqual(history.mapping);
  expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: history.request.id } })).toEqual(history.request);
}

describe("account deactivation and household closure", () => {
  it("requires explicit confirmation and the current password without partially changing state", async () => {
    const current = await fixture();
    await expect(account.deactivateOwnAccount(current.partner.session, { ...confirmed, confirmed: false })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(households.closeHousehold(current.owner.session, { ...confirmed, confirmed: false })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(account.deactivateOwnAccount(current.partner.session, { ...confirmed, currentPassword: "incorrect" })).rejects.toMatchObject({ code: "PASSWORD_INVALID" });
    await expect(households.closeHousehold(current.owner.session, { ...confirmed, currentPassword: "incorrect" })).rejects.toMatchObject({ code: "PASSWORD_INVALID" });
    expect(await db.household.findUniqueOrThrow({ where: { id: current.household.id } })).toMatchObject({ closedAt: null });
    expect(await db.householdMember.count({ where: { householdId: current.household.id, leftAt: null } })).toBe(2);
    expect(await db.user.findUniqueOrThrow({ where: { id: current.partner.user.id } })).toMatchObject({ status: "ACTIVE" });
    expect(await db.appSession.count({ where: { memberId: { in: current.people.map(({ member }) => member.id) }, revokedAt: null } })).toBe(2);
  });

  it("deactivates an ordinary member while preserving financial history, totals and everyone else's access", async () => {
    const current = await fixture();
    const outside = await fixture();
    const history = await retainedHistory(current);
    const token = await recoveryToken(current.partner.user);
    const second = await db.appSession.create({ data: {
      userId: current.partner.user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
    } });
    const reportInput = { householdId: current.household.id, currentMemberId: current.owner.member.id,
      range: { mode: "month" as const, month: "2026-10", year: "2026" }, now: new Date("2026-10-21T04:00:00Z") };
    const before = await queryHomeReport(reportInput);
    expect(await account.deactivateOwnAccount(current.partner.session, confirmed)).toEqual({ requiresReauthentication: true });
    expect(await db.user.findUniqueOrThrow({ where: { id: current.partner.user.id } })).toMatchObject({ status: "DEACTIVATED", passwordHash });
    expect(await db.householdMember.findUniqueOrThrow({ where: { id: current.partner.member.id } })).toMatchObject({ leftAt: expect.any(Date) });
    for (const id of [current.partner.appSession.id, second.id]) expect(await sessions.loadValidAccountSessionUser(id)).toBeNull();
    expect(await db.accountToken.findUniqueOrThrow({ where: { id: token.record.id } })).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await sessions.loadValidAppSessionUser(current.owner.appSession.id)).toMatchObject({ id: current.owner.user.id });
    expect(await sessions.loadValidAppSessionUser(outside.owner.appSession.id)).toMatchObject({ id: outside.owner.user.id });
    expect((await queryHomeReport(reportInput)).summary).toEqual(before.summary);
    await expectHistoryUnchanged(history);
    expect(await db.identityAuditLog.count({ where: { action: "ACCOUNT_DEACTIVATED", actorUserId: current.partner.user.id,
      actorMemberId: current.partner.member.id, householdId: current.household.id, targetId: current.partner.user.id } })).toBe(1);
    await expect(account.resetAccountPassword(token.token, "Another-synthetic-password")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    expect(await db.user.findUniqueOrThrow({ where: { id: current.partner.user.id } })).toMatchObject({ status: "DEACTIVATED", passwordHash });
  });

  it("allows a person without a household to deactivate only their own account", async () => {
    const user = await createAccount("No household");
    const appSession = await db.appSession.create({ data: { userId: user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    const session: AccountSessionUser = { id: user.id, email: user.email, name: user.displayName, appSessionId: appSession.id };
    expect(await account.deactivateOwnAccount(session, confirmed)).toEqual({ requiresReauthentication: true });
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ status: "DEACTIVATED" });
    expect(await sessions.loadValidAccountSessionUser(appSession.id)).toBeNull();
    expect(await db.householdMember.count({ where: { userId: user.id } })).toBe(0);
  });

  it("never interprets an owner's deactivation as household closure, including account-only sessions", async () => {
    const current = await fixture();
    await expect(account.deactivateOwnAccount(current.owner.session, confirmed)).rejects.toMatchObject({ code: "OWNER_TRANSFER_REQUIRED" });
    const accountOnly = await db.appSession.create({ data: { userId: current.owner.user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    await expect(account.deactivateOwnAccount({ id: current.owner.user.id, email: current.owner.user.email,
      name: current.owner.user.displayName, appSessionId: accountOnly.id }, confirmed)).rejects.toMatchObject({ code: "OWNER_TRANSFER_REQUIRED" });
    await households.removeHouseholdMember(current.owner.session, current.partner.member.id, password);
    await expect(account.deactivateOwnAccount(current.owner.session, confirmed)).rejects.toMatchObject({ code: "OWNER_CLOSE_REQUIRED" });
    expect(await db.household.findUniqueOrThrow({ where: { id: current.household.id } })).toMatchObject({ closedAt: null });
    expect(await db.user.findUniqueOrThrow({ where: { id: current.owner.user.id } })).toMatchObject({ status: "ACTIVE" });
  });

  it("allows the former owner to deactivate after a valid ownership transfer", async () => {
    const current = await fixture();
    await households.transferHouseholdOwnership(current.owner.session, current.partner.member.id, password);
    await account.deactivateOwnAccount(current.owner.session, confirmed);
    expect(await db.householdMember.findUniqueOrThrow({ where: { id: current.partner.member.id } })).toMatchObject({ role: "OWNER", leftAt: null });
    expect(await sessions.loadValidAppSessionUser(current.partner.appSession.id)).toMatchObject({ role: "OWNER" });
    expect(await db.household.findUniqueOrThrow({ where: { id: current.household.id } })).toMatchObject({ closedAt: null });
  });

  it("limits closure to the current owner and rejects a forged household without leaking its data", async () => {
    const current = await fixture();
    const outside = await fixture();
    await expect(households.closeHousehold(current.partner.session, confirmed)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(households.closeHousehold({ ...current.owner.session, householdId: outside.household.id, memberId: outside.owner.member.id }, confirmed))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await db.household.count({ where: { id: { in: [current.household.id, outside.household.id] }, closedAt: null } })).toBe(2);
  });

  it("closes all current household identities, sessions and pending credentials while keeping the accounts and history", async () => {
    const current = await fixture();
    const outside = await fixture();
    const history = await retainedHistory(current);
    const pending = await pendingInvitation(current);
    const tokens = await Promise.all(current.people.map(({ user }) => recoveryToken(user)));
    expect(await households.closeHousehold(current.owner.session, confirmed)).toEqual({ requiresReauthentication: true });
    expect(await db.household.findUniqueOrThrow({ where: { id: current.household.id } })).toMatchObject({ closedAt: expect.any(Date) });
    expect(await db.householdMember.count({ where: { householdId: current.household.id, leftAt: null } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: current.people.map(({ user }) => user.id) }, status: "ACTIVE" } })).toBe(2);
    for (const person of current.people) expect(await sessions.loadValidAccountSessionUser(person.appSession.id)).toBeNull();
    for (const token of tokens) expect(await db.accountToken.findUniqueOrThrow({ where: { id: token.record.id } })).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await db.invitation.findUniqueOrThrow({ where: { id: pending.invitation.id } })).toMatchObject({ revokedAt: expect.any(Date), consumedAt: null });
    expect(await db.accountToken.findUniqueOrThrow({ where: { id: pending.registration.id } })).toMatchObject({ revokedAt: expect.any(Date), consumedAt: null });
    expect(await sessions.loadValidAppSessionUser(outside.owner.appSession.id)).toMatchObject({ householdId: outside.household.id });
    await expectHistoryUnchanged(history);
    expect(await db.identityAuditLog.count({ where: { action: "HOUSEHOLD_CLOSED", actorUserId: current.owner.user.id,
      actorMemberId: current.owner.member.id, householdId: current.household.id, targetId: current.household.id } })).toBe(1);
  });

  it("does not revoke a former member's new household membership, session or recovery token", async () => {
    const original = await fixture();
    const outside = await fixture(1);
    await households.leaveHousehold(original.partner.session, password);
    const newMember = await db.householdMember.create({ data: {
      userId: original.partner.user.id, householdId: outside.household.id, memberName: "Rejoined elsewhere", role: "MEMBER",
    } });
    const newSession = await db.appSession.create({ data: {
      userId: original.partner.user.id, memberId: newMember.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
    } });
    const token = await recoveryToken(original.partner.user);
    await households.closeHousehold(original.owner.session, confirmed);
    expect(await db.householdMember.findUniqueOrThrow({ where: { id: newMember.id } })).toMatchObject({ leftAt: null });
    expect(await sessions.loadValidAppSessionUser(newSession.id)).toMatchObject({ householdId: outside.household.id, memberId: newMember.id });
    expect(await db.accountToken.findUniqueOrThrow({ where: { id: token.record.id } })).toMatchObject({ revokedAt: null });
  });

  it("allows a fresh account-only login after closure and then explicit account deactivation", async () => {
    const current = await fixture(1);
    await households.closeHousehold(current.owner.session, confirmed);
    const appSessionId = await sessions.ensureAppSessionForToken({}, current.owner.user);
    expect(appSessionId).toEqual(expect.any(String));
    const session = await sessions.loadValidAccountSessionUser(appSessionId!);
    expect(session).toMatchObject({ id: current.owner.user.id });
    expect(session?.memberId).toBeUndefined();
    expect(session?.householdId).toBeUndefined();
    expect(await account.deactivateOwnAccount(session!, confirmed)).toEqual({ requiresReauthentication: true });
    expect(await sessions.loadValidAccountSessionUser(appSessionId!)).toBeNull();
  });

  it("rechecks the original password binding before an in-flight deactivation can commit", async () => {
    const current = await fixture();
    const verifyPassword = shared.verifyIdentityPassword;
    let begin!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { begin = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(shared, "verifyIdentityPassword").mockImplementationOnce(async (...args) => {
      const verified = await verifyPassword(...args);
      begin();
      await hold;
      return verified;
    });
    const changing = account.deactivateOwnAccount(current.partner.session, confirmed);
    try {
      await ready;
      await db.user.update({ where: { id: current.partner.user.id }, data: { passwordHash: await hash("A-new-synthetic-password") } });
    } finally { release(); }
    await expect(changing).rejects.toMatchObject({ code: "PASSWORD_INVALID" });
    expect(await db.user.findUniqueOrThrow({ where: { id: current.partner.user.id } })).toMatchObject({ status: "ACTIVE" });
    expect(await db.householdMember.findUniqueOrThrow({ where: { id: current.partner.member.id } })).toMatchObject({ leftAt: null });
  });

  it("orders a final write before closure and rejects a late write after access has ended", async () => {
    const current = await fixture();
    const category = await db.category.findFirstOrThrow({ where: { type: "EXPENSE", isActive: true } });
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const writing = db.$transaction(async (tx) => {
      const context = await resolveContext(tx, current.partner.session, { lock: true });
      acquired();
      await hold;
      return tx.transaction.create({ data: {
        householdId: context.householdId, ledgerId: context.ledgerId, actorMemberId: context.memberId,
        createdByMemberId: context.memberId, categoryId: category.id, type: "EXPENSE", amountFen: 100, occurredAt: new Date(),
      } });
    }, { timeout: 10_000 });
    await ready;
    const closing = households.closeHousehold(current.owner.session, confirmed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([closing.then(() => "closed"), new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("waiting"), 300);
      })])).toBe("waiting");
    } finally { clearTimeout(timer); release(); }
    const written = await writing;
    await closing;
    await expect(createTransaction({
      context: { householdId: current.household.id, memberId: current.partner.member.id, ledgerId: current.ledger.id },
      type: "expense", amount: "2.00", categoryId: category.id, actorMemberId: current.partner.member.id,
      occurredAt: "2026-10-21T12:00", clientRequestId: randomUUID(),
    }, current.partner.session)).rejects.toThrow("Unauthorized");
    expect(await db.transaction.findUniqueOrThrow({ where: { id: written.id } })).toMatchObject({ amountFen: 100 });
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(1);
  });
});
