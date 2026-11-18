import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HouseholdSession } from "@/lib/auth/household-context";
import type { ResourceLease } from "@/lib/resources/admission";

process.loadEnvFile(".env.example");
let db: typeof import("@/lib/db").db;
let admission: typeof import("@/lib/resources/admission");
const households: string[] = [];
const users: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Bill analysis resource tests require a local development database");
  }
  ({ db } = await import("@/lib/db"));
  admission = await import("@/lib/resources/admission");
});

beforeEach(async () => { await db.resourceLease.deleteMany(); await db.resourceWindow.deleteMany(); });
afterAll(async () => {
  await db?.resourceLease.deleteMany();
  await db?.resourceWindow.deleteMany();
  await db?.household.deleteMany({ where: { id: { in: households } } });
  await db?.user.deleteMany({ where: { id: { in: users } } });
  await db?.$disconnect();
});

async function fixture(): Promise<HouseholdSession> {
  const household = await db.household.create({ data: { name: "Bill analysis resource test" } });
  households.push(household.id);
  await db.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const user = await db.user.create({ data: { email: `bill-resource-${randomUUID()}@example.com`, displayName: "Test", passwordHash: "test-only" } });
  users.push(user.id);
  const member = await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "Test", role: "OWNER" } });
  const session = await db.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { id: user.id, householdId: household.id, memberId: member.id, appSessionId: session.id };
}

function acquire(session: HouseholdSession, analysis = true) {
  return db.$transaction((tx) => admission.acquireResourceLease(tx, session, "ai", analysis
    ? { profile: "bill-analysis", deferCharge: true, taskKey: `bill-analysis:${randomUUID()}` }
    : {}));
}

describe("bill analysis shares bounded AI admission", () => {
  it("uses a nine-minute deferred analysis lease while preserving normal AI defaults and global occupancy", async () => {
    const session = await fixture();
    const before = Date.now();
    const lease = await acquire(session);
    try {
      expect(lease.expiresAt.getTime() - before).toBeGreaterThan(535_000);
      expect(lease.expiresAt.getTime() - before).toBeLessThan(545_000);
      expect((await db.resourceWindow.findMany()).every((window) => window.used === 0)).toBe(true);
      await expect(acquire(await fixture(), false)).rejects.toMatchObject({ code: "BUSY" });
    } finally { await admission.releaseResourceLease(lease); }
    const normal = await acquire(session, false);
    try {
      const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      expect(normal.expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(75_000);
      expect(normal.expiresAt.getTime() - now.getTime()).toBeGreaterThan(73_000);
    }
    finally { await admission.releaseResourceLease(normal); }
  });

  it("charges each provider attempt once and rejects an exhausted window without partial charges", async () => {
    expect(admission.chargeResourceAttempt).toBeTypeOf("function");
    const session = await fixture();
    const lease = await acquire(session);
    const charge = (attempt: number) => db.$transaction((tx) => admission.chargeResourceAttempt(tx, session, lease, attempt));
    try {
      for (let attempt = 1; attempt <= 10; attempt++) await charge(attempt);
      await charge(10);
      const before = await db.resourceWindow.findMany({ orderBy: { key: "asc" } });
      expect(before.map((window) => window.used)).toEqual([10, 10, 10]);
      await expect(charge(11)).rejects.toMatchObject({ code: "BUSY" });
      expect(await db.resourceWindow.findMany({ orderBy: { key: "asc" } })).toEqual(before);
      expect(await db.resourceExecution.findUniqueOrThrow({ where: { token: lease.token } })).toMatchObject({ chargedCalls: 10 });
    } finally { await admission.releaseResourceLease(lease); }
  });

  it("waits within the original lease for an eleventh attempt and can cancel without another charge", async () => {
    const resources = await import("@/lib/resources/bill-analysis-resources");
    const session = await fixture();
    const lease = await acquire(session);
    let waiting = 0;
    const charge = (attempt: number) => db.$transaction((tx) => admission.chargeResourceAttempt(tx, session, lease, attempt));
    try {
      for (let attempt = 1; attempt <= 10; attempt++) await charge(attempt);
      const controller = new AbortController();
      await expect(resources.waitForBillAnalysisWindow(session, lease, 11, {
        deadlineAt: new Date(Date.now() + 70_000), signal: controller.signal,
        assertActive: async () => undefined,
        onWaiting: () => { waiting++; controller.abort(); },
      })).rejects.toBeDefined();
      expect(waiting).toBe(1);
      expect(await db.resourceExecution.findUniqueOrThrow({ where: { token: lease.token } })).toMatchObject({ chargedCalls: 10 });
      expect(await db.resourceLease.count({ where: { token: lease.token } })).toBe(1);
      const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      await db.resourceWindow.updateMany({ where: { kind: "ai" }, data: { startedAt: new Date(now.getTime() - 59_500) } });
      await resources.waitForBillAnalysisWindow(session, lease, 11, {
        deadlineAt: new Date(Date.now() + 5_000), signal: new AbortController().signal,
        assertActive: async () => undefined,
        onWaiting: async () => {
          await db.resourceWindow.updateMany({ where: { kind: "ai" }, data: { startedAt: new Date(0) } });
        },
      });
      expect(await db.resourceExecution.findUniqueOrThrow({ where: { token: lease.token } })).toMatchObject({ chargedCalls: 11 });
      expect(await db.resourceLease.count()).toBe(1);
    } finally { await admission.releaseResourceLease(lease); }
  });

  it("rejects stale sessions and expired leases before charging", async () => {
    expect(admission.chargeResourceAttempt).toBeTypeOf("function");
    const session = await fixture();
    const lease: ResourceLease = await acquire(session);
    try {
      await db.appSession.update({ where: { id: session.appSessionId! }, data: { revokedAt: new Date() } });
      await expect(db.$transaction((tx) => admission.chargeResourceAttempt(tx, session, lease, 1))).rejects.toThrow("Unauthorized");
      expect((await db.resourceWindow.findMany()).every((window) => window.used === 0)).toBe(true);
    } finally { await admission.releaseResourceLease(lease); }
    const another = await fixture();
    const expired = await acquire(another);
    try {
      await db.$executeRaw`UPDATE "ResourceLease" SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE token=${expired.token}`;
      await expect(db.$transaction((tx) => admission.chargeResourceAttempt(tx, another, expired, 1))).rejects.toMatchObject({ code: "EXPIRED" });
      expect(await db.resourceExecution.findUniqueOrThrow({ where: { token: expired.token } })).toMatchObject({ chargedCalls: 0 });
    } finally { await admission.releaseResourceLease(expired); }
  });
});
