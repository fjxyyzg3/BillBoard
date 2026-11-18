import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

const { config, verify, recordEvent } = vi.hoisted(() => ({
  config: {} as { authorize?: (credentials: Record<string, string>) => Promise<unknown> },
  verify: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock("argon2", () => ({ default: { verify } }));
vi.mock("next-auth", async () => ({
  CredentialsSignin: (await import("@auth/core/errors")).CredentialsSignin,
  default: (options: { providers: Array<{ authorize: typeof config.authorize }> }) => {
    config.authorize = options.providers[0].authorize;
    return {};
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));
vi.mock("@/lib/ops/record-event", () => ({ recordAppEvent: recordEvent }));

let db: typeof import("@/lib/db").db;
let verifyCredentials: typeof import("@/lib/auth/login-admission").verifyLoginCredentials;
let anotherInstance: typeof verifyCredentials;
let userId: string;
let householdId: string;
const email = `login-admission-${randomUUID()}@example.com`;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "http://invalid");

  if (process.env.NODE_ENV === "production" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !/(?:dev|test)/i.test(url.pathname)) {
    throw new Error("Login admission tests require a local development or test database");
  }

  ({ db } = await import("@/lib/db"));
  ({ verifyLoginCredentials: verifyCredentials } = await import("@/lib/auth/login-admission"));
  vi.resetModules();
  ({ verifyLoginCredentials: anotherInstance } = await import("@/lib/auth/login-admission"));
  await import("@/auth");
  const household = await db.household.create({ data: { name: "Login admission test" } });
  householdId = household.id;
  const user = await db.user.create({
    data: {
      email,
      displayName: "Login admission test",
      passwordHash: "test-only-hash",
      householdMember: {
        create: { householdId, memberName: "Test", role: "OWNER" },
      },
    },
  });
  userId = user.id;
});

beforeEach(async () => {
  vi.clearAllMocks();
  verify.mockResolvedValue(false);
  recordEvent.mockResolvedValue(undefined);
  await db.loginAttemptLease.deleteMany();
  await db.loginThrottle.deleteMany({ where: { email } });
  await resetBudget();
});

afterAll(async () => {
  vi.useRealTimers();

  if (db) {
    await db.loginAttemptLease.deleteMany();
    await db.loginBudget.update({ where: { id: 1 }, data: { tokens: 10, refilledAt: new Date() } });
    await db.loginThrottle.deleteMany({ where: { email } });
    if (householdId) await db.household.delete({ where: { id: householdId } });
    if (userId) await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  }
});

async function resetBudget(tokens = 10) {
  // Keep refill outside the test interval so burst assertions do not depend on machine speed.
  await db.$executeRaw`
    UPDATE "LoginBudget" SET "tokens" = ${tokens},
      "refilled_at" = clock_timestamp() + INTERVAL '1 minute'
    WHERE "id" = 1
  `;
}

function deferredVerification() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  verify.mockImplementation(async () => { await pending; return false; });
  return release;
}

function attempt(target = email) {
  return config.authorize!({ email: target, password: "wrong-password" })
    .catch((error: unknown) => error);
}

describe("credentials admission against PostgreSQL", () => {
  it("does not let a parallel burst for one account all reach password verification", async () => {
    const release = deferredVerification();
    let settled = 0;
    const attempts = Array.from({ length: 20 }, () => attempt().finally(() => { settled += 1; }));

    try {
      await vi.waitFor(() => expect(settled).toBe(19));
      expect(verify).toHaveBeenCalledTimes(1);
      expect(await db.loginAttemptLease.count()).toBe(1);
    } finally {
      release();
      await Promise.all(attempts);
    }

    expect(await db.loginThrottle.findUnique({ where: { email } })).toMatchObject({ attemptCount: 1 });
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it("bounds password verification and event writes for repeated unknown emails without unbounded keys", async () => {
    const results = [];

    for (let index = 0; index < 20; index += 1) {
      results.push(await attempt(`unknown-${randomUUID()}@example.com`));
    }

    expect(verify).toHaveBeenCalledTimes(10);
    expect(recordEvent).toHaveBeenCalledTimes(10);
    expect(results.slice(0, 10)).toEqual(Array(10).fill(null));
    for (const error of results.slice(10)) {
      expect(error).toMatchObject({ type: "CredentialsSignin", code: "rate_limited" });
      expect(String(error)).not.toContain("unknown-");
    }
    expect(await db.loginThrottle.count({ where: { email: { startsWith: "unknown-" } } })).toBe(0);
    expect(await db.loginBudget.count()).toBe(1);
    expect(await db.loginAttemptLease.count()).toBe(0);
  });

  it("shares the two-verification limit between independent application module instances", async () => {
    const release = deferredVerification();
    let settled = 0;
    const pending = [verifyCredentials, verifyCredentials, anotherInstance, anotherInstance]
      .map((login, index) => login(`parallel-${index}@example.com`, "wrong")
        .finally(() => { settled += 1; }));

    try {
      await vi.waitFor(() => expect(settled).toBe(2));
      expect(verify).toHaveBeenCalledTimes(2);
      expect(await db.loginAttemptLease.count()).toBe(2);
    } finally {
      release();
    }

    const results = await Promise.all(pending);
    expect(results.filter((result) => result.status === "rate_limited")).toHaveLength(2);
    expect(results.filter((result) => result.status === "invalid")).toHaveLength(2);
    expect(await db.loginAttemptLease.count()).toBe(0);
  });

  it("locks the account after five completed failures for fifteen minutes and keeps a generic error", async () => {
    for (let index = 0; index < 5; index += 1) expect(await attempt()).toBeNull();
    const throttle = await db.loginThrottle.findUniqueOrThrow({ where: { email } });

    expect(throttle.attemptCount).toBe(5);
    // Both persisted values belong to the same decision; the Docker wall clock can step between queries.
    expect(throttle.lockedUntil!.getTime() - throttle.updatedAt.getTime()).toBe(15 * 60_000);
    verify.mockResolvedValue(true);
    expect(await attempt()).toBeNull();
    expect(verify).toHaveBeenCalledTimes(5);
    expect(recordEvent).toHaveBeenCalledTimes(5);
  });

  it("allows a successful login after lock expiry and clears previous failed attempts", async () => {
    await db.loginThrottle.create({ data: {
      email, attemptCount: 5,
    } });
    await db.$executeRaw`
      UPDATE "LoginThrottle" SET "locked_until" = clock_timestamp() - INTERVAL '1 second'
      WHERE "email" = ${email}
    `;
    verify.mockResolvedValue(true);

    expect(await attempt()).toMatchObject({ id: userId, householdId, email });
    expect(await db.loginThrottle.findUnique({ where: { email } })).toBeNull();
    expect(await db.loginAttemptLease.count()).toBe(0);
  });

  it("uses the database clock for failure timestamps even when the application clock is skewed", async () => {
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    await db.loginThrottle.create({ data: { email, attemptCount: 4, updatedAt: now } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now.getTime() + 24 * 60 * 60_000));

    try {
      expect(await attempt()).toBeNull();
      const throttle = await db.loginThrottle.findUniqueOrThrow({ where: { email } });
      expect(throttle.attemptCount).toBe(5);
      expect(throttle.updatedAt.getTime()).toBe(throttle.lockedUntil!.getTime() - 15 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases admission after a verifier error and does not leak the failure details", async () => {
    verify.mockRejectedValueOnce(new Error("private password hash detail"));
    expect(await attempt()).toBeNull();
    expect(await db.loginAttemptLease.count()).toBe(0);
    expect(await db.loginThrottle.findUnique({ where: { email } })).toMatchObject({ attemptCount: 1 });
    verify.mockResolvedValue(true);
    expect(await attempt()).toMatchObject({ id: userId });
  });

  it("fails closed when shared admission state is unavailable and recovers without leaking capacity", async () => {
    await db.loginBudget.delete({ where: { id: 1 } });

    try {
      const rejected = await Promise.all([attempt(), attempt(), attempt()]);
      for (const result of rejected) {
        expect(result).toMatchObject({ type: "CredentialsSignin", code: "rate_limited" });
        expect(String(result)).not.toContain("Login admission is unavailable");
      }
      expect(verify).not.toHaveBeenCalled();
      expect(recordEvent).not.toHaveBeenCalled();
    } finally {
      await db.loginBudget.create({ data: { id: 1, tokens: 10, refilledAt: new Date() } });
    }

    verify.mockResolvedValue(true);
    expect(await attempt()).toMatchObject({ id: userId });
    expect(await db.loginAttemptLease.count()).toBe(0);
  });

  it("refills the shared rate budget using database time", async () => {
    await db.$executeRaw`
      UPDATE "LoginBudget" SET "tokens" = 0,
        "refilled_at" = clock_timestamp() - INTERVAL '3.1 seconds'
      WHERE "id" = 1
    `;

    expect(await verifyCredentials("refill@example.com", "wrong")).toEqual({ status: "invalid" });
    expect(await verifyCredentials("refill@example.com", "wrong")).toEqual({ status: "rate_limited" });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("reclaims expired leases and prevents a late attempt from clearing the replacement lease", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    verify.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      releaseFirst = () => resolve(false);
    })).mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      releaseSecond = () => resolve(false);
    }));
    const first = verifyCredentials(email, "wrong");
    let second: ReturnType<typeof anotherInstance> | undefined;

    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
      const firstLease = await db.loginAttemptLease.findFirstOrThrow();
      await db.$executeRaw`
        UPDATE "LoginAttemptLease" SET "expires_at" = clock_timestamp() - INTERVAL '1 second'
        WHERE "token" = ${firstLease.token}
      `;
      second = anotherInstance(email, "wrong");
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
      releaseFirst!();
      expect(await first).toEqual({ status: "rate_limited" });
      const replacement = await db.loginAttemptLease.findFirstOrThrow();
      expect(replacement.token).not.toBe(firstLease.token);
      expect(await db.loginThrottle.findUnique({ where: { email } })).toBeNull();
    } finally {
      releaseFirst?.();
      releaseSecond?.();
      await Promise.all([first, second]);
    }

    expect(await db.loginThrottle.findUnique({ where: { email } })).toMatchObject({ attemptCount: 1 });
    expect(await db.loginAttemptLease.count()).toBe(0);
  });

  it("keeps leases while a verifier is still running and renews them without releasing capacity", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const release = deferredVerification();
    const pending = [verifyCredentials("slow-one@example.com", "wrong"),
      verifyCredentials("slow-two@example.com", "wrong")];

    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
      await db.$executeRaw`
        UPDATE "LoginAttemptLease" SET "expires_at" = clock_timestamp() + INTERVAL '10 seconds'
      `;
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => {
        const leases = await db.loginAttemptLease.findMany();
        const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
        expect(leases).toHaveLength(2);
        expect(leases.every((lease) => lease.expiresAt.getTime() > now.getTime() + 30_000)).toBe(true);
      });
      expect(await anotherInstance("waiting@example.com", "wrong")).toEqual({ status: "rate_limited" });
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await Promise.all(pending);
      vi.useRealTimers();
    }

    expect(await db.loginAttemptLease.count()).toBe(0);
  });
});
