import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.loadEnvFile(".env.example");
let db: typeof import("@/lib/db").db;
let shared: typeof import("@/lib/identity/shared");
let mailBudget: typeof import("@/lib/identity/mail-budget");
const ids: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) throw new Error("Identity tests require a local development/test database");
  ({ db } = await import("@/lib/db"));
  shared = await import("@/lib/identity/shared");
  mailBudget = await import("@/lib/identity/mail-budget");
});

beforeEach(async () => {
  // Each test exercises the real global budget without inheriting another suite's charges.
  const now = new Date();
  const data = { attempts: 0, windowStartedAt: now, lastAttemptAt: now };
  await db.identityRateLimit.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
});

afterEach(async () => {
  await db.identityRateLimit.deleteMany({ where: { id: { in: ["global", ...ids.splice(0)] } } });
});
afterAll(async () => {
  if (!db) return;
  await db.identityRateLimit.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

describe("shared identity safeguards", () => {
  it("generates unrelated high-entropy bearer values and persists only stable digests", () => {
    const first = shared.createIdentityToken();
    const second = shared.createIdentityToken();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tokenHash).toBe(shared.hashIdentityToken(first.token));
    expect(first.tokenHash).not.toContain(first.token);
    expect(first.token).not.toBe(second.token);
    expect(() => shared.hashIdentityToken("token?from=elsewhere")).toThrow("INVALID_TOKEN");
  });

  it("initializes the first global budget atomically for concurrent distinct subjects", async () => {
    const before = await db.identityRateLimit.findUnique({ where: { id: "global" } });
    const subjects = Array.from({ length: 8 }, () => `first-budget-${randomUUID()}`);
    const subjectIds = subjects.map((subject) => `first-budget:${createHash("sha256").update(subject).digest("hex")}`);
    try {
      await db.identityRateLimit.deleteMany({ where: { id: "global" } });
      const outcomes = await Promise.allSettled(subjects.map((subject) => shared.takeIdentityRateLimit("first-budget", subject)));
      expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      expect(await db.identityRateLimit.findUnique({ where: { id: "global" } })).toMatchObject({ attempts: subjects.length });
    } finally {
      await db.identityRateLimit.deleteMany({ where: { id: { in: ["global", ...subjectIds] } } });
      if (before) await db.identityRateLimit.create({ data: before });
    }
  });

  it("serializes concurrent registration attempts against one server-side subject", async () => {
    const subject = `shared-registration-${randomUUID()}`;
    const id = `registration:${createHash("sha256").update(subject).digest("hex")}`;
    ids.push(id);
    const results = await Promise.allSettled(Array.from({ length: 7 }, () => shared.takeIdentityRateLimit("registration", subject)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(4);
    const row = await db.identityRateLimit.findUnique({ where: { id } });
    expect(row).toBeDefined();
    expect(row!.id).not.toContain(subject);
  });

  it("does not allow a second immediate email delivery to the same recipient", async () => {
    const subject = `shared-mail-${randomUUID()}@example.com`;
    await shared.takeIdentityRateLimit("mail", subject);
    await expect(shared.takeIdentityRateLimit("mail", subject.toUpperCase())).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const id = `mail:${createHash("sha256").update(subject).digest("hex")}`;
    ids.push(id);
    await db.identityRateLimit.update({ where: { id }, data: { lastAttemptAt: new Date(Date.now() - 61_000) } });
    await shared.takeIdentityRateLimit("mail", subject);
  });

  it("limits a flood of distinct recipients with the same global database budget", async () => {
    const before = await db.identityRateLimit.findUniqueOrThrow({ where: { id: "global" } });
    const subjects = Array.from({ length: 2 }, () => `shared-global-${randomUUID()}@example.com`);
    ids.push(...subjects.map((subject) => `mail:${createHash("sha256").update(subject).digest("hex")}`));
    try {
      await db.identityRateLimit.update({ where: { id: "global" }, data: { attempts: 239, windowStartedAt: new Date() } });
      await shared.takeIdentityRateLimit("mail", subjects[0]);
      await expect(shared.takeIdentityRateLimit("mail", subjects[1])).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      await db.identityRateLimit.update({ where: { id: "global" }, data: { attempts: before.attempts, windowStartedAt: before.windowStartedAt, lastAttemptAt: before.lastAttemptAt } });
    }
  });

  it("releases an SMTP slot after a failed delivery and bounds concurrent work", async () => {
    await db.identityMailLease.deleteMany();
    await expect(mailBudget.withIdentityMailLease(async () => { throw new Error("Synthetic transport failure"); })).rejects.toThrow("Synthetic transport failure");
    expect(await db.identityMailLease.count()).toBe(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const first = mailBudget.withIdentityMailLease(async () => { started += 1; await gate; });
    const second = mailBudget.withIdentityMailLease(async () => { started += 1; await gate; });
    try {
      await expect(mailBudget.withIdentityMailLease(async () => "unexpected")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally { release(); await Promise.all([first, second]); }
    expect(started).toBe(2);
    expect(await db.identityMailLease.count()).toBe(0);
  });

  it("honors active SMTP leases held by other processes, and recovers expired ones", async () => {
    const tokens = [randomUUID(), randomUUID()];
    // Lease expiry is evaluated by PostgreSQL, whose clock can differ from the host.
    const [active] = await db.$queryRaw<Array<{ expiresAt: Date }>>`SELECT clock_timestamp() + INTERVAL '60 seconds' AS "expiresAt"`;
    await db.identityMailLease.createMany({ data: tokens.map((token, slot) => ({ slot, token, expiresAt: active.expiresAt })) });
    try {
      await expect(mailBudget.withIdentityMailLease(async () => "unexpected")).rejects.toMatchObject({ code: "RATE_LIMITED" });
      const [expired] = await db.$queryRaw<Array<{ expiresAt: Date }>>`SELECT clock_timestamp() - INTERVAL '1 second' AS "expiresAt"`;
      await db.identityMailLease.updateMany({ where: { token: { in: tokens } }, data: { expiresAt: expired.expiresAt } });
      expect(await mailBudget.withIdentityMailLease(async () => "delivered")).toBe("delivered");
      expect(await db.identityMailLease.count()).toBe(0);
    } finally { await db.identityMailLease.deleteMany({ where: { token: { in: tokens } } }); }
  });
});
