import { randomUUID } from "node:crypto";
import { OpsAuditAction } from "@prisma/client";
import { hash } from "argon2";
import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.loadEnvFile(".env.example");

type AuthOptions = {
  providers: Array<{ authorize: (credentials: Record<string, string>, request: Request) => Promise<unknown> }>;
  callbacks: {
    jwt: (input: { token: JWT; user?: unknown }) => Promise<JWT | null>;
    session: (input: { session: Session; token: JWT }) => Promise<Session>;
  };
};
const harness = vi.hoisted(() => ({ options: null as AuthOptions | null, record: vi.fn() }));
vi.mock("next-auth", async () => ({
  CredentialsSignin: (await import("@auth/core/errors")).CredentialsSignin,
  default: (options: AuthOptions) => { harness.options = options; return {}; },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));
vi.mock("@/lib/ops/record-event", () => ({ recordAppEvent: harness.record }));
vi.mock("@/lib/identity/mail", () => ({ sendIdentityEmail: vi.fn().mockResolvedValue(undefined) }));

let db: typeof import("@/lib/db").db;
let account: typeof import("@/lib/identity/account");
let sessions: typeof import("@/lib/auth/app-sessions");
let shared: typeof import("@/lib/identity/shared");
let verifyCredentials: typeof import("@/lib/auth/login-admission").verifyLoginCredentials;
let passwordHash: string;
const password = "Historical-current-password-" + "x".repeat(140);
const replacementPassword = "Synthetic-replacement-password-42";
const households: string[] = [];
const users: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Auth session race tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  sessions = await import("@/lib/auth/app-sessions");
  shared = await import("@/lib/identity/shared");
  account = await import("@/lib/identity/account");
  ({ verifyLoginCredentials: verifyCredentials } = await import("@/lib/auth/login-admission"));
  await import("@/auth");
  passwordHash = await hash(password);
});

beforeEach(async () => {
  vi.clearAllMocks();
  harness.record.mockResolvedValue(undefined);
  await db.loginBudget.upsert({ where: { id: 1 }, create: { id: 1, tokens: 10, refilledAt: new Date() }, update: { tokens: 10, refilledAt: new Date() } });
});

afterEach(async () => {
  await db.accountToken.deleteMany({ where: { userId: { in: users } } });
  await db.identityAuditLog.deleteMany({ where: { actorUserId: { in: users } } });
  await db.opsAuditLog.deleteMany({ where: { targetUserId: { in: users } } });
  await db.loginAttemptLease.deleteMany({ where: { userId: { in: users } } });
  const accounts = await db.user.findMany({ where: { id: { in: users } }, select: { email: true } });
  await db.loginThrottle.deleteMany({ where: { email: { in: accounts.map(({ email }) => email) } } });
  await db.household.deleteMany({ where: { id: { in: households.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(async () => { await db?.$disconnect(); });

async function fixture() {
  const household = await db.household.create({ data: { name: "Credential race fixture" } });
  households.push(household.id);
  await db.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const user = await db.user.create({ data: {
    email: `credential-race-${randomUUID()}@example.com`, displayName: "Credential race", passwordHash, emailVerifiedAt: new Date(),
  } });
  users.push(user.id);
  const member = await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "Owner", role: "OWNER" } });
  const appSession = await db.appSession.create({ data: {
    userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
  } });
  return { household, member, user, appSession, session: {
    id: user.id, email: user.email, name: user.displayName, appSessionId: appSession.id,
    householdId: household.id, memberId: member.id, role: "OWNER" as const,
  } };
}

async function tokenFor(current: Awaited<ReturnType<typeof fixture>>, purpose: "RESET_PASSWORD" | "CHANGE_EMAIL") {
  const credential = shared.createIdentityToken();
  await db.accountToken.create({ data: {
    userId: current.user.id, purpose, tokenHash: credential.tokenHash, passwordHash: current.user.passwordHash,
    email: purpose === "CHANGE_EMAIL" ? `replacement-${randomUUID()}@example.com` : current.user.email,
    expiresAt: new Date(Date.now() + 60_000), sentAt: new Date(),
  } });
  return credential.token;
}

describe("credential transitions and in-flight login sessions", () => {
  it.each(["password-change", "password-reset", "email-change"] as const)(
    "does not create a surviving old-credential session after concurrent %s", async (operation) => {
      const current = await fixture();
      const token = operation === "password-change" ? null : await tokenFor(current, operation === "password-reset" ? "RESET_PASSWORD" : "CHANGE_EMAIL");
      let acquired!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { acquired = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      harness.record.mockImplementation(async (event: { eventType: string }) => {
        if (event.eventType === "LOGIN_SUCCESS") { acquired(); await hold; }
      });
      const loggingIn = harness.options!.providers[0]!.authorize({ email: current.user.email, password }, new Request("http://127.0.0.1/api/auth/callback/credentials"));
      await ready;
      try {
        if (operation === "password-change") await account.changeAccountPassword(current.session, { currentPassword: password, newPassword: replacementPassword });
        else if (operation === "password-reset") await account.resetAccountPassword(token!, replacementPassword);
        else await account.completeEmailVerification(token!);
      } finally {
        release();
      }
      const authorized = await loggingIn;
      const jwt = await harness.options!.callbacks.jwt({ token: {}, user: authorized });
      const session = await harness.options!.callbacks.session({
        token: jwt!, session: { user: { email: current.user.email, name: current.user.displayName }, expires: new Date(Date.now() + 60_000).toISOString() },
      });
      expect(session.user).toBeUndefined();
      expect(await db.appSession.count({ where: { userId: current.user.id, revokedAt: null } })).toBe(0);
      expect(JSON.stringify(authorized)).not.toContain(current.user.passwordHash);
      expect(JSON.stringify(jwt)).not.toContain(current.user.passwordHash);
    },
  );

  it.each(["email", "password", "status", "member"] as const)("waits for a concurrent %s change and rejects its old verified snapshot", async (field) => {
    const current = await fixture();
    const verified = await verifyCredentials(current.user.email, password);
    expect(verified.status).toBe("authenticated");
    if (verified.status !== "authenticated") throw new Error("The fixture credentials must verify");
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const changing = db.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM "Household" WHERE id = ${current.household.id} FOR UPDATE`;
      if (field === "member") {
        await transaction.householdMember.update({ where: { id: current.member.id }, data: { leftAt: new Date() } });
        await transaction.householdMember.create({ data: {
          userId: current.user.id, householdId: current.household.id, role: "OWNER", memberName: "Owner",
        } });
      } else await transaction.user.update({ where: { id: current.user.id }, data: {
        ...(field === "email" ? { email: `changed-${randomUUID()}@example.com` } : {}),
        ...(field === "password" ? { passwordHash: "a-different-server-password-hash" } : {}),
        ...(field === "status" ? { status: "LOCKED" } : {}),
      } });
      await transaction.appSession.updateMany({ where: { userId: current.user.id }, data: { revokedAt: new Date() } });
      acquired();
      await hold;
    }, { timeout: 5_000 });
    await ready;
    const creating = sessions.ensureAppSessionForToken({}, {
      id: verified.user.id, email: verified.user.email, passwordHash: verified.user.passwordHash,
      householdId: current.household.id, memberId: current.member.id,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([
        creating.then(() => "returned"), new Promise<string>((resolve) => { timer = setTimeout(() => resolve("waiting"), 250); }),
      ])).toBe("waiting");
    } finally {
      clearTimeout(timer);
      release();
      await changing;
    }
    expect(await creating).toBeNull();
    expect(await db.appSession.count({ where: { userId: current.user.id, revokedAt: null } })).toBe(0);
  });

  it("creates an account-only session without a family and refuses to upgrade its old login snapshot after joining", async () => {
    const current = await fixture();
    const user = await db.user.create({ data: {
      email: `account-only-race-${randomUUID()}@example.com`, displayName: "Account only", passwordHash, emailVerifiedAt: new Date(),
    } });
    users.push(user.id);
    const verified = await verifyCredentials(user.email, password);
    expect(verified.status).toBe("authenticated");
    if (verified.status !== "authenticated") throw new Error("The account-only fixture credentials must verify");
    const proof = { id: verified.user.id, email: verified.user.email, passwordHash: verified.user.passwordHash };
    const sessionId = await sessions.ensureAppSessionForToken({}, proof);
    expect(sessionId).toBeTruthy();
    expect(await sessions.loadValidAccountSessionUser(sessionId!)).toMatchObject({ id: user.id, appSessionId: sessionId });
    expect(await sessions.loadValidAppSessionUser(sessionId!)).toBeNull();
    await db.householdMember.create({ data: { userId: user.id, householdId: current.household.id, memberName: "Joined", role: "MEMBER" } });
    expect(await sessions.ensureAppSessionForToken({}, proof)).toBeNull();
    expect(await sessions.loadValidAppSessionUser(sessionId!)).toBeNull();
    expect(await db.appSession.count({ where: { userId: user.id } })).toBe(1);
  });
});

function legacyToken(current: Awaited<ReturnType<typeof fixture>>) {
  const issuedAt = Math.floor(Date.now() / 1000) - 120;
  return {
    sub: current.user.id, householdId: current.household.id, memberId: current.member.id,
    jti: randomUUID(), iat: issuedAt, exp: issuedAt + 180,
  };
}

describe("first recovery of legacy JWT sessions", () => {
  it.each(["PASSWORD_CHANGED", "PASSWORD_RESET", "EMAIL_CHANGED"] as const)(
    "rejects an unmapped legacy token after the account's %s", async (action) => {
      const current = await fixture();
      const legacy = legacyToken(current);
      if (action === "PASSWORD_CHANGED") await account.changeAccountPassword(current.session, { currentPassword: password, newPassword: replacementPassword });
      else if (action === "PASSWORD_RESET") await account.resetAccountPassword(await tokenFor(current, "RESET_PASSWORD"), replacementPassword);
      else await account.completeEmailVerification(await tokenFor(current, "CHANGE_EMAIL"));
      expect(await sessions.ensureAppSessionForToken(legacy, null)).toBeNull();
      expect(await db.appSession.count({ where: { userId: current.user.id, revokedAt: null } })).toBe(0);
    },
  );

  it.each([OpsAuditAction.RESET_USER_PASSWORD, OpsAuditAction.REVOKE_USER_SESSIONS_AFTER_PASSWORD_RESET])(
    "rejects an unmapped legacy token after the account-wide OPS action %s", async (action) => {
      const current = await fixture();
      const legacy = legacyToken(current);
      await db.$transaction(async (transaction) => {
        await shared.requireLockedAccount(transaction, current.session);
        await transaction.appSession.updateMany({ where: { userId: current.user.id }, data: { revokedAt: new Date() } });
        await transaction.opsAuditLog.create({ data: { action, targetUserId: current.user.id } });
      });
      expect(await sessions.ensureAppSessionForToken(legacy, null)).toBeNull();
      expect(await db.appSession.count({ where: { userId: current.user.id, revokedAt: null } })).toBe(0);
    },
  );

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Math.floor(Date.now() / 1000) + 120])(
    "rejects a legacy token with missing or invalid issued-at %s", async (issuedAt) => {
      const current = await fixture();
      expect(await sessions.ensureAppSessionForToken({ ...legacyToken(current), iat: issuedAt }, null)).toBeNull();
      expect(await db.appSession.count({ where: { userId: current.user.id } })).toBe(1);
    },
  );

  it("preserves an unchanged legacy token's original identity, key and expiry despite unrelated or single-session audit entries", async () => {
    const current = await fixture();
    const outside = await fixture();
    const legacy = legacyToken(current);
    await db.identityAuditLog.createMany({ data: [
      { action: "PASSWORD_RESET", actorUserId: outside.user.id, targetId: outside.user.id },
      { action: "EMAIL_VERIFIED", actorUserId: current.user.id, targetId: current.user.id },
      { action: "SESSION_REVOKED", actorUserId: current.user.id, targetId: current.appSession.id },
      { action: "PASSWORD_CHANGED", actorUserId: current.user.id, targetId: current.user.id, createdAt: new Date((legacy.iat - 1) * 1000) },
    ] });
    await db.opsAuditLog.create({ data: { action: OpsAuditAction.REVOKE_USER_SESSION, targetUserId: current.user.id, targetSessionId: current.appSession.id } });
    const recoveredId = await sessions.ensureAppSessionForToken(legacy, null);
    expect(recoveredId).toBeTruthy();
    expect(await db.appSession.findUniqueOrThrow({ where: { id: recoveredId! } })).toMatchObject({
      userId: current.user.id, memberId: current.member.id, sessionKey: legacy.jti, expiresAt: new Date(legacy.exp * 1000),
    });
    await db.appSession.update({ where: { id: recoveredId! }, data: { revokedAt: new Date() } });
    expect(await sessions.ensureAppSessionForToken({ ...legacy, appSessionId: undefined }, null)).toBe(recoveredId);
    expect(await sessions.loadValidAccountSessionUser(recoveredId!)).toBeNull();
  });

  it("checks credential-revocation audit only after the same user lock as the concurrent change", async () => {
    const current = await fixture();
    const legacy = legacyToken(current);
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const changing = db.$transaction(async (transaction) => {
      await shared.requireLockedAccount(transaction, current.session);
      await transaction.appSession.updateMany({ where: { userId: current.user.id }, data: { revokedAt: new Date() } });
      await transaction.identityAuditLog.create({ data: { action: "PASSWORD_CHANGED", actorUserId: current.user.id, targetId: current.user.id } });
      acquired();
      await hold;
    }, { timeout: 5_000 });
    await ready;
    const recovering = sessions.ensureAppSessionForToken(legacy, null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([
        recovering.then(() => "returned"), new Promise<string>((resolve) => { timer = setTimeout(() => resolve("waiting"), 250); }),
      ])).toBe("waiting");
    } finally {
      clearTimeout(timer);
      release();
      await changing;
    }
    expect(await recovering).toBeNull();
    expect(await db.appSession.count({ where: { userId: current.user.id, revokedAt: null } })).toBe(0);
  });
});
