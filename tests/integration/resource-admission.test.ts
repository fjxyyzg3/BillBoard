import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HouseholdSession } from "@/lib/auth/household-context";
import type { ResourceKind } from "@/lib/resources/policy";

process.loadEnvFile(".env.example");
let db: typeof import("@/lib/db").db;
let admission: typeof import("@/lib/resources/admission");
let anotherInstance: typeof admission;
const householdIds: string[] = [];
const userIds: string[] = [];
const categoryIds: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Resource admission tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  admission = await import("@/lib/resources/admission");
  vi.resetModules();
  anotherInstance = await import("@/lib/resources/admission");
});

beforeEach(async () => {
  await db.resourceLease.deleteMany();
  await db.resourceWindow.deleteMany();
});

afterAll(async () => {
  if (!db) return;
  vi.useRealTimers();
  await db.resourceLease.deleteMany();
  await db.resourceWindow.deleteMany();
  await db.household.deleteMany({ where: { id: { in: householdIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds } } });
  await db.$disconnect();
});

async function fixture(householdId?: string) {
  const household = householdId ? { id: householdId } : await db.household.create({ data: { name: "Resource fixture" } });
  if (!householdId) {
    householdIds.push(household.id);
    await db.ledger.create({ data: { householdId: household.id, name: "Daily", isDefault: true } });
  }
  const user = await db.user.create({ data: { email: `resources-${randomUUID()}@example.com`, displayName: "Example", passwordHash: "test-only" } });
  userIds.push(user.id);
  const member = await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: randomUUID(), role: householdId ? "MEMBER" : "OWNER" } });
  const session = await db.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60 * 60_000) } });
  return { id: user.id, householdId: household.id, memberId: member.id, appSessionId: session.id };
}

function acquire(session: HouseholdSession, kind: ResourceKind = "import", instance = admission) {
  return db.$transaction((tx) => instance.acquireResourceLease(tx, session, kind), { maxWait: 10_000, timeout: 15_000 });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function leaseProcess(session: HouseholdSession) {
  const script = `
    import { createInterface } from 'node:readline';
    const database = await import('./src/lib/db.ts');
    const resources = await import('./src/lib/resources/admission.ts');
    const { db } = database.default ?? database;
    const { acquireResourceLease, releaseResourceLease } = resources.default ?? resources;
    const lines = createInterface({ input: process.stdin });
    const iterator = lines[Symbol.asyncIterator]();
    const session = JSON.parse((await iterator.next()).value);
    let lease;
    try {
      lease = await db.$transaction((tx) => acquireResourceLease(tx, session, 'import'));
      process.stdout.write('admitted\\n');
      await iterator.next();
    } catch (error) { process.stdout.write(error.code === 'BUSY' ? 'busy\\n' : 'failed\\n'); }
    finally { if (lease) await releaseResourceLease(lease); lines.close(); await db.$disconnect(); }
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    env: { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "test", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  child.stdin.on("error", () => undefined);
  let ready = false;
  let output = "";
  const finished = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const status = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Resource worker did not respond")); }, 10_000);
    const stop = () => clearTimeout(timer);
    child.once("error", () => { stop(); reject(new Error("Resource worker could not start")); });
    child.once("close", () => { stop(); if (!ready) reject(new Error("Resource worker exited before admission")); });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!ready && output.includes("\n")) {
        stop(); ready = true; resolve(output.split("\n")[0]);
      }
    });
    child.stdin.write(`${JSON.stringify(session)}\n`);
  });
  return { status, finish: async () => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed) child.stdin.end("release\n");
      await finished;
    } finally { clearTimeout(timer); }
  } };
}

describe("shared resource admission", () => {
  it("prunes hour-old quota windows while retaining current, recent, active and other-kind state", async () => {
    const current = await fixture();
    const stale = await fixture();
    const recent = await fixture();
    const active = await fixture();
    const activeLease = await acquire(active);
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    const old = new Date(now.getTime() - 2 * 60 * 60_000);
    const pair = (session: HouseholdSession, kind: string, startedAt: Date) => [
      { key: `${kind}:household:${session.householdId}`, kind, scope: "household", subjectId: session.householdId, startedAt, used: 1 },
      { key: `${kind}:member:${session.memberId}`, kind, scope: "member", subjectId: session.memberId, startedAt, used: 1 },
    ];
    await db.resourceWindow.createMany({ data: [
      ...pair(stale, "import", old), ...pair(recent, "import", new Date(now.getTime() - 5 * 60_000)),
      ...pair(stale, "ai", old),
    ] });
    await db.resourceWindow.updateMany({ where: { kind: "import", subjectId: { in: [active.householdId, active.memberId] } }, data: { startedAt: old } });
    const retained = await db.resourceWindow.findMany({ where: { NOT: { kind: "import", subjectId: { in: [stale.householdId, stale.memberId] } } }, select: { key: true } });
    const category = await db.category.create({ data: { type: "EXPENSE", name: `Resource retention ${randomUUID()}`, sortOrder: 9999 } });
    categoryIds.push(category.id);
    const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: stale.householdId, isDefault: true } });
    await db.transaction.create({ data: {
      householdId: stale.householdId, ledgerId: ledger.id, actorMemberId: stale.memberId, createdByMemberId: stale.memberId,
      type: "EXPENSE", amountFen: 789, categoryId: category.id, occurredAt: new Date("2026-10-21T04:00:00.000Z"),
    } });
    let currentLease: Awaited<ReturnType<typeof acquire>> | undefined;
    try {
      currentLease = await acquire(current);
      expect(await db.resourceWindow.count({ where: { kind: "import", subjectId: { in: [stale.householdId, stale.memberId] } } })).toBe(0);
      expect((await db.resourceWindow.findMany({ select: { key: true } })).map(({ key }) => key).sort()).toEqual([
        ...retained.map(({ key }) => key), `import:household:${current.householdId}`, `import:member:${current.memberId}`,
      ].sort());
      expect(await db.resourceLease.count()).toBe(2);
      expect(await db.transaction.aggregate({ where: { householdId: stale.householdId, deletedAt: null }, _count: true, _sum: { amountFen: true } })).toMatchObject({ _count: 1, _sum: { amountFen: 789 } });
    } finally {
      await admission.releaseResourceLease(activeLease);
      if (currentLease) await admission.releaseResourceLease(currentLease);
    }
  });

  it("shares occupancy and recovery between separate operating-system processes", async () => {
    const first = await fixture();
    const outside = await fixture();
    const third = await fixture();
    const workers: Array<Awaited<ReturnType<typeof leaseProcess>>> = [];
    try {
      workers.push(await leaseProcess(first));
      expect(workers[0].status).toBe("admitted");
      await expect(acquire(first)).rejects.toMatchObject({ code: "BUSY" });
      workers.push(await leaseProcess(outside));
      expect(workers[1].status).toBe("admitted");
      await expect(acquire(third)).rejects.toMatchObject({ code: "BUSY" });
      expect(await db.resourceLease.count()).toBe(2);
      const category = await db.category.create({ data: { type: "EXPENSE", name: `Resource check ${randomUUID()}`, sortOrder: 9999 } });
      categoryIds.push(category.id);
      const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: third.householdId, isDefault: true } });
      const { createTransaction } = await import("@/lib/transactions/create-transaction");
      expect(await createTransaction({
        clientRequestId: randomUUID(), context: { householdId: third.householdId, memberId: third.memberId, ledgerId: ledger.id },
        type: "expense", amount: "1.23", actorMemberId: third.memberId, categoryId: category.id, occurredAt: "2026-10-21T12:00",
      }, third)).toMatchObject({ amountFen: 123, wasCreated: true });
      expect(await db.transaction.count({ where: { householdId: third.householdId, deletedAt: null } })).toBe(1);
    } finally { await Promise.all(workers.map((worker) => worker.finish())); }
    expect(await db.resourceLease.count()).toBe(0);
    await admission.releaseResourceLease(await acquire(third));
  }, 30_000);

  it("serializes household admission across independent modules and preserves another household's slot", async () => {
    const first = await fixture();
    const second = await fixture(first.householdId);
    const outside = await fixture();
    const third = await fixture();
    const outcomes = await Promise.allSettled([acquire(first), acquire(second, "import", anotherInstance)]);
    const accepted = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
    expect(accepted).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const outsideLease = await acquire(outside, "import", anotherInstance);
    try {
      await expect(acquire(third)).rejects.toMatchObject({ code: "BUSY" });
      expect(await db.resourceLease.count()).toBe(2);
      expect(await db.resourceWindow.findUnique({ where: { key: "import:global:global" } })).toMatchObject({ used: 2 });
      expect(await db.resourceWindow.count({ where: { subjectId: third.memberId } })).toBe(0);
    } finally {
      await Promise.all([...accepted, outsideLease].map((lease) => admission.releaseResourceLease(lease)));
    }
  });

  it("does not multiply member capacity through another session, ledger, or application process", async () => {
    const session = await fixture();
    const ledger = await db.ledger.create({ data: { householdId: session.householdId, name: "Travel" } });
    const secondSession = await db.appSession.create({ data: { userId: session.id, memberId: session.memberId, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    const lease = await acquire(session, "voice");
    try {
      await expect(db.$transaction((tx) => anotherInstance.acquireResourceLease(tx, { ...session, appSessionId: secondSession.id }, "voice", { ledgerId: ledger.id }))).rejects.toMatchObject({ code: "BUSY" });
      expect(await db.resourceWindow.findUnique({ where: { key: `voice:member:${session.memberId}` } })).toMatchObject({ used: 1 });
    } finally { await admission.releaseResourceLease(lease); }
  });

  it("enforces the member window and does not partially charge rejected attempts", async () => {
    const session = await fixture();
    const limit = admission.RESOURCE_POLICIES.import.perMinute.member;
    for (let index = 0; index < limit; index += 1) await admission.releaseResourceLease(await acquire(session));
    const before = await db.resourceWindow.findMany({ orderBy: { key: "asc" } });
    await expect(acquire(session, "import", anotherInstance)).rejects.toMatchObject({ code: "BUSY", retryAfterSeconds: expect.any(Number) });
    expect(await db.resourceWindow.findMany({ orderBy: { key: "asc" } })).toEqual(before);
    expect(await db.resourceLease.count()).toBe(0);
  });

  it("rolls back admission and every charged window when the same-transaction consent check fails", async () => {
    const session = await fixture();
    const work = vi.fn();
    await expect(admission.withResourceLease(session, "ai", work, { admit: async () => { throw new Error("CONSENT_REQUIRED"); } })).rejects.toThrow("CONSENT_REQUIRED");
    expect(work).not.toHaveBeenCalled();
    expect(await db.resourceLease.count()).toBe(0);
    expect(await db.resourceWindow.count()).toBe(0);
  });

  it("reclaims expired leases after worker stop is confirmed and rejects old tokens after new admission", async () => {
    const session = await fixture();
    const old = await acquire(session);
    await db.$executeRaw`UPDATE "ResourceLease" SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE token = ${old.token}`;
    // Represent explicit confirmation that this synthetic worker has stopped.
    await db.resourceExecution.delete({ where: { token: old.token } });
    const current = await acquire(session, "import", anotherInstance);
    try {
      await expect(db.$transaction((tx) => admission.assertResourceLease(tx, old))).rejects.toMatchObject({ code: "EXPIRED" });
      await db.$transaction((tx) => admission.assertResourceLease(tx, current));
      expect(await db.resourceLease.count()).toBe(1);
      await expect(db.$transaction((tx) => admission.assertResourceLease(tx, { ...current, householdId: randomUUID() }))).rejects.toMatchObject({ code: "EXPIRED" });
    } finally { await admission.releaseResourceLease(current); }
  });

  it("keeps occupancy after cancellation until the running work has actually settled", async () => {
    const session = await fixture();
    const began = deferred();
    const finish = deferred();
    const controller = new AbortController();
    const pending = admission.withResourceLease(session, "import", async (lease) => {
      began.resolve();
      await finish.promise;
      if (lease.signal.aborted) throw new Error("cancelled");
    }, { signal: controller.signal }).catch((error: Error) => error.message);
    try {
      await began.promise;
      controller.abort();
      expect(await db.resourceLease.count()).toBe(1);
      await expect(acquire(session, "import", anotherInstance)).rejects.toMatchObject({ code: "BUSY" });
    } finally { finish.resolve(); }
    expect(await pending).toBe("cancelled");
    expect(await db.resourceLease.count()).toBe(0);
    await expect(admission.withResourceLease(session, "import", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(await db.resourceLease.count()).toBe(0);
  });

  it("uses the database clock for quota windows despite an application clock skew", async () => {
    const session = await fixture();
    const identity = { householdId: session.householdId, memberId: session.memberId };
    const first = await acquire(identity);
    await admission.releaseResourceLease(first);
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now.getTime() + 24 * 60 * 60_000));
    try {
      const second = await acquire(identity);
      try {
        expect(second.expiresAt.getTime()).toBeLessThan(now.getTime() + 200_000);
        expect(await db.resourceWindow.findUnique({ where: { key: "import:global:global" } })).toMatchObject({ used: 2 });
      } finally { await admission.releaseResourceLease(second); }
    } finally { vi.useRealTimers(); }
  });

  it("rejects stale sessions before charging and allows archived export reads without allowing import writes", async () => {
    const session = await fixture();
    const archived = await db.ledger.create({ data: { householdId: session.householdId, name: "Archive", archivedAt: new Date() } });
    await expect(db.$transaction((tx) => admission.acquireResourceLease(tx, session, "import", { ledgerId: archived.id }))).rejects.toThrow("Ledger is unavailable");
    const lease = await db.$transaction((tx) => admission.acquireResourceLease(tx, session, "export", { ledgerId: archived.id }));
    await admission.releaseResourceLease(lease);
    await db.appSession.update({ where: { id: session.appSessionId }, data: { revokedAt: new Date() } });
    const before = await db.resourceWindow.findMany({ orderBy: { key: "asc" } });
    await expect(acquire(session)).rejects.toThrow("Unauthorized");
    expect(await db.resourceWindow.findMany({ orderBy: { key: "asc" } })).toEqual(before);
  });
});
