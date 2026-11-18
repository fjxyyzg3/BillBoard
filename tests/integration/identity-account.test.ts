import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSessionUser } from "@/lib/auth/app-sessions";

process.loadEnvFile(".env.example");

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/identity/mail", () => ({ sendIdentityEmail: sendEmail }));

let db: typeof import("@/lib/db").db;
let account: typeof import("@/lib/identity/account");
let shared: typeof import("@/lib/identity/shared");
const users: string[] = [];
let passwordHash: string;
const originalPassword = "account-test-original-password";
const newPassword = "account-test-replacement-password";

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Account identity tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  account = await import("@/lib/identity/account");
  shared = await import("@/lib/identity/shared");
  passwordHash = await argon2.hash(originalPassword);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue(undefined);
  // Password-cost admission is exercised for real; isolate this suite's budget.
  await db.loginBudget.upsert({ where: { id: 1 }, create: { id: 1, tokens: 10, refilledAt: new Date() }, update: { tokens: 10, refilledAt: new Date() } });
  // The shared development/test database must not carry another test's global identity budget.
  await db.identityRateLimit.deleteMany({ where: { id: "global" } });
});

afterEach(async () => {
  await db.identityRateLimit.deleteMany({ where: { id: "global" } });
});

afterAll(async () => {
  if (!db) return;
  await db.identityAuditLog.deleteMany({ where: { actorUserId: { in: users } } });
  await db.accountToken.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

async function fixture(options: { verified?: boolean; status?: "ACTIVE" | "LOCKED" } = {}) {
  const user = await db.user.create({ data: {
    email: `account-${randomUUID()}@example.com`, displayName: "Account fixture", passwordHash,
    ...(options.verified ? { emailVerifiedAt: new Date() } : {}), ...(options.status ? { status: options.status } : {}),
  } });
  users.push(user.id);
  const appSession = await db.appSession.create({ data: {
    sessionKey: randomUUID(), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000),
    userAgent: "Mozilla/5.0 (iPhone) Version/18.0 Mobile/15E148 Safari/604.1",
  } });
  const session: AccountSessionUser = { id: user.id, email: user.email, name: user.displayName, appSessionId: appSession.id };
  return { user, appSession, session };
}

function sentToken() {
  const token = sendEmail.mock.calls.at(-1)?.[0]?.token;
  expect(token).toEqual(expect.any(String));
  return token as string;
}

async function tokenFor(user: Awaited<ReturnType<typeof fixture>>["user"], purpose: "VERIFY_EMAIL" | "CHANGE_EMAIL" | "RESET_PASSWORD", extra: Record<string, unknown> = {}) {
  const credential = shared.createIdentityToken();
  const token = await db.accountToken.create({ data: {
    tokenHash: credential.tokenHash, purpose, userId: user.id, email: user.email, passwordHash: user.passwordHash,
    expiresAt: new Date(Date.now() + 60_000), sentAt: new Date(), ...extra,
  } });
  return { ...credential, record: token };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("account self-service", () => {
  it("retains compatibility with an existing password longer than the new password policy", async () => {
    const current = await fixture();
    const legacyPassword = "Existing-password-".repeat(20);
    await db.user.update({ where: { id: current.user.id }, data: { passwordHash: await argon2.hash(legacyPassword) } });
    await account.changeAccountPassword(current.session, { currentPassword: legacyPassword, newPassword });
    const changed = await db.user.findUniqueOrThrow({ where: { id: current.user.id } });
    expect(await argon2.verify(changed.passwordHash, newPassword)).toBe(true);
    expect((await db.appSession.findUniqueOrThrow({ where: { id: current.appSession.id } })).revokedAt).toBeInstanceOf(Date);
  });

  it("returns only the authenticated account and safe active session summaries", async () => {
    const current = await fixture();
    const outside = await fixture();
    const revoked = await db.appSession.create({ data: { userId: current.user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() } });
    const expired = await db.appSession.create({ data: { userId: current.user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() - 60_000) } });
    const overview = await account.getAccountOverview({ ...current.session, email: outside.user.email });
    expect(overview).toEqual({
      email: current.user.email, displayName: "Account fixture", emailVerifiedAt: null,
      sessions: [{ id: current.appSession.id, deviceLabel: "Safari on iPhone", loginAt: current.appSession.loginAt,
        lastSeenAt: current.appSession.lastSeenAt, expiresAt: current.appSession.expiresAt, isCurrent: true }],
    });
    expect(JSON.stringify(overview)).not.toContain(passwordHash);
    expect(JSON.stringify(overview)).not.toContain(current.appSession.sessionKey);
    expect(JSON.stringify(overview)).not.toContain(current.appSession.userAgent);
    expect(overview.sessions.map(({ id }) => id)).not.toEqual(expect.arrayContaining([outside.appSession.id, revoked.id, expired.id]));
  });

  it("rejects revoked, expired, locked and forged account sessions", async () => {
    const current = await fixture();
    const outside = await fixture();
    await expectCode(account.getAccountOverview({ ...current.session, appSessionId: outside.appSession.id }), "UNAUTHORIZED");
    await db.appSession.update({ where: { id: current.appSession.id }, data: { revokedAt: new Date() } });
    await expectCode(account.getAccountOverview(current.session), "UNAUTHORIZED");
    await db.appSession.update({ where: { id: current.appSession.id }, data: { revokedAt: null, expiresAt: new Date(Date.now() - 1_000) } });
    await expectCode(account.getAccountOverview(current.session), "UNAUTHORIZED");
    const locked = await fixture({ status: "LOCKED" });
    await expectCode(account.getAccountOverview(locked.session), "UNAUTHORIZED");
  });

  it("revokes only an owned session and identifies revoking the current one", async () => {
    const current = await fixture();
    const outside = await fixture();
    const another = await db.appSession.create({ data: { userId: current.user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    await expectCode(account.revokeOwnSession(current.session, outside.appSession.id), "INVALID_SESSION");
    await expectCode(account.revokeOwnSession(current.session, randomUUID()), "INVALID_SESSION");
    expect((await db.appSession.findUniqueOrThrow({ where: { id: outside.appSession.id } })).revokedAt).toBeNull();
    expect(await account.revokeOwnSession(current.session, another.id)).toEqual({ revoked: true, requiresReauthentication: false });
    expect((await db.appSession.findUniqueOrThrow({ where: { id: another.id } })).revokedAt).toBeInstanceOf(Date);
    expect(await account.revokeOwnSession(current.session, current.appSession.id)).toEqual({ revoked: true, requiresReauthentication: true });
    await expectCode(account.getAccountOverview(current.session), "UNAUTHORIZED");
  });

  it("signs out only the current server session without consuming identity-operation quotas", async () => {
    const current = await fixture();
    const outside = await fixture();
    const another = await db.appSession.create({ data: { userId: current.user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    const beforeLimits = await db.identityRateLimit.findMany({ orderBy: { id: "asc" } });
    await account.revokeCurrentAccountSession(current.session);
    const { loadValidAccountSessionUser } = await import("@/lib/auth/app-sessions");
    expect(await loadValidAccountSessionUser(current.appSession.id)).toBeNull();
    expect(await loadValidAccountSessionUser(another.id)).toMatchObject({ id: current.user.id, appSessionId: another.id });
    expect(await loadValidAccountSessionUser(outside.appSession.id)).toMatchObject({ id: outside.user.id });
    await expectCode(account.getAccountOverview(current.session), "UNAUTHORIZED");
    expect(await db.identityRateLimit.findMany({ orderBy: { id: "asc" } })).toEqual(beforeLimits);
    expect(await db.identityAuditLog.findMany({ where: { actorUserId: current.user.id }, select: { action: true, targetId: true } }))
      .toEqual([{ action: "SESSION_REVOKED", targetId: current.appSession.id }]);
  });

  it("fences a previously resolved household session at the final accounting write after sign-out", async () => {
    const current = await fixture();
    const household = await db.household.create({ data: {
      name: "Sign-out write-fence fixture",
      members: { create: { userId: current.user.id, memberName: "Owner", role: "OWNER" } },
      ledgers: { create: { name: "Default", isDefault: true } },
    }, include: { members: true, ledgers: true } });
    try {
      const member = household.members[0];
      const ledger = household.ledgers[0];
      await db.appSession.update({ where: { id: current.appSession.id }, data: { memberId: member.id } });
      const another = await db.appSession.create({ data: {
        userId: current.user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
      } });
      const staleSession = { ...current.session, householdId: household.id, memberId: member.id, role: "OWNER" as const };
      const category = await db.category.findFirstOrThrow({ where: { type: "EXPENSE", isActive: true } });
      const input = {
        context: { householdId: household.id, memberId: member.id, ledgerId: ledger.id },
        type: "expense", amount: "12.34", actorMemberId: member.id, categoryId: category.id,
        clientRequestId: randomUUID(), occurredAt: "2026-10-22T12:00", note: "Sign-out write fence",
      };
      const { createTransaction } = await import("@/lib/transactions/create-transaction");
      await account.revokeCurrentAccountSession(staleSession);
      await expect(createTransaction(input, staleSession)).rejects.toThrow("Unauthorized");
      expect(await db.transaction.count({ where: { householdId: household.id } })).toBe(0);
      await createTransaction(input, { ...staleSession, appSessionId: another.id });
      expect(await db.transaction.findMany({ where: { householdId: household.id }, select: { ledgerId: true, amountFen: true } }))
        .toEqual([{ ledgerId: ledger.id, amountFen: 1234 }]);
    } finally { await db.household.delete({ where: { id: household.id } }); }
  });


  it("requires the current password without changing credentials on failure", async () => {
    const current = await fixture({ verified: true });
    await expectCode(account.changeAccountPassword(current.session, { currentPassword: "incorrect-password", newPassword }), "PASSWORD_INVALID");
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).passwordHash).toBe(passwordHash);
    expect((await db.appSession.findUniqueOrThrow({ where: { id: current.appSession.id } })).revokedAt).toBeNull();
  });

  it("changes a password atomically and invalidates every old session and account token", async () => {
    const current = await fixture({ verified: true });
    await tokenFor(current.user, "RESET_PASSWORD");
    await tokenFor(current.user, "CHANGE_EMAIL", { email: `replacement-${randomUUID()}@example.com` });
    const secondSession = await db.appSession.create({ data: { userId: current.user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    expect(await account.changeAccountPassword(current.session, { currentPassword: originalPassword, newPassword })).toEqual({ requiresReauthentication: true });
    const updated = await db.user.findUniqueOrThrow({ where: { id: current.user.id } });
    expect(await argon2.verify(updated.passwordHash, newPassword)).toBe(true);
    expect(await argon2.verify(updated.passwordHash, originalPassword)).toBe(false);
    expect(updated).toMatchObject({ status: current.user.status, email: current.user.email, emailVerifiedAt: current.user.emailVerifiedAt });
    expect(await db.appSession.count({ where: { id: { in: [current.appSession.id, secondSession.id] }, revokedAt: null } })).toBe(0);
    expect(await db.accountToken.count({ where: { userId: current.user.id, consumedAt: null, revokedAt: null } })).toBe(0);
    const audit = await db.identityAuditLog.findMany({ where: { actorUserId: current.user.id } });
    expect(audit).toHaveLength(1);
    const serialized = JSON.stringify(audit);
    for (const secret of [passwordHash, updated.passwordHash, originalPassword, newPassword, current.user.email]) expect(serialized).not.toContain(secret);
  });

  it("rechecks the session after password hashing before committing a change", async () => {
    const current = await fixture({ verified: true });
    const preparedHash = await argon2.hash(newPassword);
    let begin!: () => void;
    let release!: () => void;
    const begun = new Promise<void>((resolve) => { begin = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(shared, "hashIdentityPassword").mockImplementationOnce(async () => { begin(); await paused; return preparedHash; });
    const changing = account.changeAccountPassword(current.session, { currentPassword: originalPassword, newPassword });
    try {
      await Promise.race([begun, changing]);
      await db.appSession.update({ where: { id: current.appSession.id }, data: { revokedAt: new Date() } });
    } finally { release(); }
    await expectCode(changing, "UNAUTHORIZED");
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).passwordHash).toBe(passwordHash);
  });

  it("rechecks the old password hash after hashing before committing a change", async () => {
    const current = await fixture({ verified: true });
    const preparedHash = await argon2.hash(newPassword);
    const concurrentHash = await argon2.hash("concurrent-password-change");
    let begin!: () => void;
    let release!: () => void;
    const begun = new Promise<void>((resolve) => { begin = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(shared, "hashIdentityPassword").mockImplementationOnce(async () => { begin(); await paused; return preparedHash; });
    const changing = account.changeAccountPassword(current.session, { currentPassword: originalPassword, newPassword });
    try {
      await Promise.race([begun, changing]);
      await db.user.update({ where: { id: current.user.id }, data: { passwordHash: concurrentHash } });
    } finally { release(); }
    await expectCode(changing, "PASSWORD_INVALID");
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).passwordHash).toBe(concurrentHash);
  });

  it("verifies the server-owned current mailbox with a hashed one-use credential", async () => {
    const current = await fixture();
    expect(await account.requestEmailVerification({ ...current.session, email: "forged@example.com" }, { locale: "en-US" })).toEqual({ accepted: true });
    const token = sentToken();
    expect(sendEmail).toHaveBeenLastCalledWith(expect.objectContaining({ to: current.user.email, kind: "verify", token, locale: "en-US" }));
    const stored = await db.accountToken.findUniqueOrThrow({ where: { tokenHash: shared.hashIdentityToken(token) } });
    expect(stored).toMatchObject({ userId: current.user.id, email: current.user.email, purpose: "VERIFY_EMAIL", consumedAt: null, revokedAt: null });
    expect(stored.sentAt).toBeInstanceOf(Date);
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeLessThanOrEqual(30 * 60_000);
    expect(await account.completeEmailVerification(token)).toEqual({ requiresReauthentication: false });
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).emailVerifiedAt).toBeInstanceOf(Date);
    expect((await db.appSession.findUniqueOrThrow({ where: { id: current.appSession.id } })).revokedAt).toBeNull();
    await expectCode(account.completeEmailVerification(token), "INVALID_TOKEN");
  });

  it("requires the current password and verified new mailbox before rebinding email", async () => {
    const current = await fixture({ verified: true });
    const replacement = `replacement-${randomUUID()}@example.com`;
    const oldRecovery = await tokenFor(current.user, "RESET_PASSWORD");
    await expectCode(account.requestEmailVerification(current.session, { email: replacement }), "PASSWORD_INVALID");
    expect(await account.requestEmailVerification(current.session, { email: `  ${replacement.toUpperCase()}  `, currentPassword: originalPassword })).toEqual({ accepted: true });
    const token = sentToken();
    expect(sendEmail).toHaveBeenLastCalledWith(expect.objectContaining({ to: replacement, kind: "verify" }));
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).email).toBe(current.user.email);
    expect((await db.accountToken.findUniqueOrThrow({ where: { id: oldRecovery.record.id } })).revokedAt).toBeNull();
    expect(await account.completeEmailVerification(token)).toEqual({ requiresReauthentication: true });
    expect(await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).toMatchObject({ email: replacement, passwordHash, status: "ACTIVE", emailVerifiedAt: expect.any(Date) });
    expect((await db.appSession.findUniqueOrThrow({ where: { id: current.appSession.id } })).revokedAt).toBeInstanceOf(Date);
    await expectCode(account.resetAccountPassword(oldRecovery.token, newPassword), "INVALID_TOKEN");
    await expectCode(account.completeEmailVerification(token), "INVALID_TOKEN");
  });

  it("does not disclose whether a requested replacement mailbox belongs to another account", async () => {
    const current = await fixture();
    const outside = await fixture({ verified: true });
    expect(await account.requestEmailVerification(current.session, { email: outside.user.email, currentPassword: originalPassword })).toEqual({ accepted: true });
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).email).toBe(current.user.email);
  });

  it("keeps replacement-mail responses conditional even if delivery fails", async () => {
    const current = await fixture();
    const outside = await fixture();
    const older = await tokenFor(current.user, "VERIFY_EMAIL");
    sendEmail.mockRejectedValueOnce(new Error("Synthetic mail delivery failure"));
    const replacement = `unowned-${randomUUID()}@example.com`;
    const unavailable = await account.requestEmailVerification(current.session, { email: replacement, currentPassword: originalPassword });
    const alreadyOwned = await account.requestEmailVerification(current.session, { email: outside.user.email, currentPassword: originalPassword });
    expect(unavailable).toEqual({ accepted: true });
    expect(alreadyOwned).toEqual(unavailable);
    expect((await db.accountToken.findUniqueOrThrow({ where: { id: older.record.id } })).revokedAt).toBeNull();
    expect(await db.accountToken.count({ where: { userId: current.user.id, purpose: "CHANGE_EMAIL", sentAt: null, revokedAt: { not: null } } })).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).email).toBe(current.user.email);
  });

  it("accepts unknown, unverified and locked recovery requests without sending mail", async () => {
    const unverified = await fixture();
    const locked = await fixture({ verified: true, status: "LOCKED" });
    for (const email of [`unknown-${randomUUID()}@example.com`, unverified.user.email, locked.user.email]) {
      expect(await account.requestPasswordReset(email, "zh-CN")).toEqual({ accepted: true });
    }
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await db.accountToken.count({ where: { userId: { in: [unverified.user.id, locked.user.id] } } })).toBe(0);
  });

  it("recovers only a verified account and invalidates old sessions and credentials", async () => {
    const current = await fixture({ verified: true });
    const oldVerification = await tokenFor(current.user, "VERIFY_EMAIL");
    expect(await account.requestPasswordReset(` ${current.user.email.toUpperCase()} `, "en-US")).toEqual({ accepted: true });
    const token = sentToken();
    expect(sendEmail).toHaveBeenLastCalledWith(expect.objectContaining({ to: current.user.email, kind: "reset", locale: "en-US" }));
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).passwordHash).toBe(passwordHash);
    expect(await account.resetAccountPassword(token, newPassword)).toEqual({ requiresReauthentication: true });
    const updated = await db.user.findUniqueOrThrow({ where: { id: current.user.id } });
    expect(await argon2.verify(updated.passwordHash, newPassword)).toBe(true);
    expect(updated).toMatchObject({ email: current.user.email, emailVerifiedAt: current.user.emailVerifiedAt, status: "ACTIVE" });
    expect((await db.appSession.findUniqueOrThrow({ where: { id: current.appSession.id } })).revokedAt).toBeInstanceOf(Date);
    await expectCode(account.resetAccountPassword(token, "another-test-password"), "INVALID_TOKEN");
    await expectCode(account.completeEmailVerification(oldVerification.token), "INVALID_TOKEN");
  });

  it("rejects wrong-purpose, expired, unsent and revoked recovery credentials", async () => {
    const current = await fixture({ verified: true });
    const credentials = [
      await tokenFor(current.user, "VERIFY_EMAIL"),
      await tokenFor(current.user, "RESET_PASSWORD", { expiresAt: new Date(Date.now() - 1_000) }),
      await tokenFor(current.user, "RESET_PASSWORD", { sentAt: null }),
      await tokenFor(current.user, "RESET_PASSWORD", { revokedAt: new Date() }),
    ];
    for (const credential of credentials) await expectCode(account.resetAccountPassword(credential.token, newPassword), "INVALID_TOKEN");
    await expectCode(account.completeEmailVerification(credentials[1].token), "INVALID_TOKEN");
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).passwordHash).toBe(passwordHash);
  });

  it("preserves an older recovery credential and password when a resend fails", async () => {
    const current = await fixture({ verified: true });
    await account.requestPasswordReset(current.user.email);
    const oldToken = sentToken();
    sendEmail.mockRejectedValueOnce(new Error("Synthetic mail delivery failure"));
    expect(await account.requestPasswordReset(current.user.email)).toEqual({ accepted: true });
    const failedToken = sentToken();
    expect((await db.accountToken.findUniqueOrThrow({ where: { tokenHash: shared.hashIdentityToken(failedToken) } })).revokedAt).toBeInstanceOf(Date);
    expect((await db.accountToken.findUniqueOrThrow({ where: { tokenHash: shared.hashIdentityToken(oldToken) } })).revokedAt).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).passwordHash).toBe(passwordHash);
    expect(await account.resetAccountPassword(oldToken, newPassword)).toEqual({ requiresReauthentication: true });
  });

  it("preserves an older verification credential when a resend fails", async () => {
    const current = await fixture();
    await account.requestEmailVerification(current.session, {});
    const oldToken = sentToken();
    sendEmail.mockRejectedValueOnce(new Error("Synthetic mail delivery failure"));
    await expectCode(account.requestEmailVerification(current.session, {}), "EMAIL_DELIVERY_FAILED");
    expect((await db.accountToken.findUniqueOrThrow({ where: { tokenHash: shared.hashIdentityToken(oldToken) } })).revokedAt).toBeNull();
    expect(await account.completeEmailVerification(oldToken)).toEqual({ requiresReauthentication: false });
  });

  it("allows only one concurrent recovery to consume the same credential", async () => {
    const current = await fixture({ verified: true });
    const credential = await tokenFor(current.user, "RESET_PASSWORD");
    const results = await Promise.allSettled([
      account.resetAccountPassword(credential.token, newPassword),
      account.resetAccountPassword(credential.token, "different-replacement-password"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await db.identityAuditLog.count({ where: { actorUserId: current.user.id, action: "PASSWORD_RESET" } })).toBe(1);
  });

  it("allows only one concurrent verification to consume the same credential", async () => {
    const current = await fixture();
    const credential = await tokenFor(current.user, "VERIFY_EMAIL");
    const results = await Promise.allSettled([
      account.completeEmailVerification(credential.token), account.completeEmailVerification(credential.token),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await db.identityAuditLog.count({ where: { actorUserId: current.user.id, action: "EMAIL_VERIFIED" } })).toBe(1);
  });

  it("rechecks the recovery password binding after password hashing", async () => {
    const current = await fixture({ verified: true });
    const credential = await tokenFor(current.user, "RESET_PASSWORD");
    const preparedHash = await argon2.hash(newPassword);
    const concurrentHash = await argon2.hash("concurrent-password-change");
    let begin!: () => void;
    let release!: () => void;
    const begun = new Promise<void>((resolve) => { begin = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(shared, "hashIdentityPassword").mockImplementationOnce(async () => { begin(); await paused; return preparedHash; });
    const recovering = account.resetAccountPassword(credential.token, newPassword);
    try {
      await Promise.race([begun, recovering]);
      await db.user.update({ where: { id: current.user.id }, data: { passwordHash: concurrentHash } });
    } finally { release(); }
    await expectCode(recovering, "INVALID_TOKEN");
    expect((await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).passwordHash).toBe(concurrentHash);
    expect((await db.accountToken.findUniqueOrThrow({ where: { id: credential.record.id } })).consumedAt).toBeNull();
  });

  it("does not recover an account locked after its recovery email was sent", async () => {
    const current = await fixture({ verified: true });
    const credential = await tokenFor(current.user, "RESET_PASSWORD");
    await db.user.update({ where: { id: current.user.id }, data: { status: "LOCKED" } });
    await expectCode(account.resetAccountPassword(credential.token, newPassword), "INVALID_TOKEN");
    expect(await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).toMatchObject({ status: "LOCKED", passwordHash });
  });
});
