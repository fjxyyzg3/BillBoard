import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.loadEnvFile(".env.example");
let db: typeof import("@/lib/db").db;
let budget: typeof import("@/lib/identity/access-application-budget") | undefined;
const prefix = "public-application:";
const minuteMs = 60_000;
const hourMs = 3_600_000;
const dayMs = 86_400_000;
const base = new Date("2027-02-01T01:00:05+08:00");
const run = promisify(execFile);

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Application budget tests require a local development/test database");
  }
  // Exercise concurrent callers without opening a CPU-sized pool of database connections.
  url.searchParams.set("connection_limit", "8");
  process.env.DATABASE_URL = url.href;
  ({ db } = await import("@/lib/db"));
  const modulePath = "../../src/lib/identity/access-application-budget.ts";
  budget = await import(modulePath).catch(() => undefined);
});

beforeEach(async () => {
  await db.identityRateLimit.deleteMany({ where: { id: { startsWith: prefix } } });
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  const remaining = minuteMs - now.getTime() % minuteMs;
  if (remaining < 2_000) await new Promise((resolve) => setTimeout(resolve, remaining + 50));
});
afterEach(async () => { await db.identityRateLimit.deleteMany({ where: { id: { startsWith: prefix } } }); });
afterAll(async () => { await db?.$disconnect(); });

function mailbox() { return `application-budget-${randomUUID()}@example.com`; }
function at(offsetMs: number) { return new Date(base.getTime() + offsetMs); }
function mail(email: string, now: Date) {
  return db.$transaction((tx) => budget!.takeAccessApplicationMailLimit(tx, email, now));
}
function rows() { return db.identityRateLimit.findMany({ where: { id: { startsWith: prefix } }, orderBy: { id: "asc" } }); }

async function seed(id: string, attempts: number, startedAt: Date, lastAttemptAt = startedAt) {
  await db.identityRateLimit.create({ data: { id, attempts, windowStartedAt: startedAt, lastAttemptAt } });
}

describe("public application request admission", () => {
  it("admits at most thirty concurrent submissions without taking the normal identity budget", async () => {
    const identityBefore = await db.identityRateLimit.findUnique({ where: { id: "global" } });
    const results = await Promise.allSettled(Array.from({ length: 31 }, async () => budget?.takeAccessApplicationRequestLimit("request")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(30);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "RATE_LIMITED" } }]);
    expect(await db.identityRateLimit.findUnique({ where: { id: "global" } })).toEqual(identityBefore);
  });

  it("gives confirmation attempts a separate sixty-per-minute budget", async () => {
    const requests = await Promise.allSettled(Array.from({ length: 30 }, () => budget!.takeAccessApplicationRequestLimit("request")));
    expect(requests.every((result) => result.status === "fulfilled")).toBe(true);
    const confirmations = await Promise.allSettled(Array.from({ length: 61 }, () => budget!.takeAccessApplicationRequestLimit("confirmation")));
    expect(confirmations.filter((result) => result.status === "fulfilled")).toHaveLength(60);
    expect(confirmations.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "RATE_LIMITED" } }]);
    expect(await rows()).toHaveLength(4);
  });

  it.each([["request", 120], ["confirmation", 240]] as const)("enforces the %s quarter-hour cap without partially charging its minute", async (kind, maximum) => {
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    const startedAt = new Date(Math.floor(now.getTime() / (15 * minuteMs)) * 15 * minuteMs);
    await seed(`${prefix}${kind}:quarter-hour`, maximum - 1, startedAt);
    await budget!.takeAccessApplicationRequestLimit(kind);
    const admitted = await rows();
    await expect(budget!.takeAccessApplicationRequestLimit(kind)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await rows()).toEqual(admitted);
  });

  it("reopens expired fixed request windows", async () => {
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    await seed(`${prefix}request:minute`, 30, new Date(Math.floor(now.getTime() / minuteMs) * minuteMs - minuteMs));
    await seed(`${prefix}request:quarter-hour`, 120, new Date(Math.floor(now.getTime() / (15 * minuteMs)) * 15 * minuteMs - 15 * minuteMs));
    const secondImport = await import("@/lib/identity/access-application-budget");
    await secondImport.takeAccessApplicationRequestLimit("request");
    expect((await rows()).map((row) => row.attempts)).toEqual([1, 1]);
  });

  it("keeps an exhausted request budget in a separate Node process", async () => {
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    const quarter = new Date(Math.floor(now.getTime() / (15 * minuteMs)) * 15 * minuteMs);
    await seed(`${prefix}request:quarter-hour`, 120, quarter);
    const script = `
      const { takeAccessApplicationRequestLimit } = await import("./src/lib/identity/access-application-budget.ts");
      const { db } = await import("./src/lib/db.ts");
      try {
        await takeAccessApplicationRequestLimit("request");
        process.stdout.write("allowed");
      } catch (error) {
        process.stdout.write(error.code ?? "unexpected");
      } finally { await db.$disconnect(); }
    `;
    const child = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: process.env, windowsHide: true, maxBuffer: 64 * 1024,
    });
    expect(child.stdout).toBe("RATE_LIMITED");
    expect(await rows()).toHaveLength(1);
  });
});

describe("public application confirmation mail admission", () => {
  it("enforces a sixty-second mailbox cooldown and three attempts per hour atomically", async () => {
    const email = mailbox();
    await mail(email, base);
    const first = await rows();
    await expect(mail(` ${email.toUpperCase()} `, at(59_999))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await rows()).toEqual(first);
    await mail(email, at(minuteMs));
    await mail(email, at(2 * minuteMs));
    const third = await rows();
    await db.$transaction(async (tx) => {
      // A caller catching a business rejection must not commit a partial charge.
      await expect(budget!.takeAccessApplicationMailLimit(tx, email, at(3 * minuteMs))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    });
    expect(await rows()).toEqual(third);
    expect(JSON.stringify(third)).not.toContain(email);
  });

  it("keeps mailbox cooldowns across hour and Shanghai-day boundaries", async () => {
    const email = mailbox();
    const beforeMidnight = new Date("2027-02-01T23:59:40+08:00");
    await mail(email, beforeMidnight);
    const before = await rows();
    await expect(mail(email, new Date("2027-02-02T00:00:10+08:00"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await rows()).toEqual(before);
    await mail(email, new Date("2027-02-02T00:00:40+08:00"));
    const globalDay = await db.identityRateLimit.findUniqueOrThrow({ where: { id: `${prefix}mail:global:day` } });
    expect(globalDay.windowStartedAt.toISOString()).toBe("2027-02-01T16:00:00.000Z");
    expect(globalDay.attempts).toBe(1);
  });

  it("limits one mailbox to five attempts per Shanghai day and reopens the next day", async () => {
    const email = mailbox();
    for (const offset of [0, minuteMs, 2 * minuteMs, hourMs, hourMs + minuteMs]) await mail(email, at(offset));
    const fifth = await rows();
    await expect(mail(email, at(2 * hourMs))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await rows()).toEqual(fifth);
    await mail(email, new Date("2027-02-02T00:00:00+08:00"));
  });

  it("allows only one of many same-mailbox attempts, including different casing", async () => {
    const email = mailbox();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => mail(index % 2 ? email.toUpperCase() : email, base)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(11);
    expect((await rows()).map((row) => row.attempts)).toEqual([1, 1, 1, 1, 1]);
  });

  it("allows at most two different mailboxes in one minute without creating denied mailbox keys", async () => {
    const emails = [mailbox(), mailbox(), mailbox()];
    const results = await Promise.allSettled(emails.map((email) => mail(email, base)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "RATE_LIMITED" } }]);
    const denied = emails[results.findIndex((result) => result.status === "rejected")];
    const hash = createHash("sha256").update(denied).digest("hex");
    expect(await db.identityRateLimit.count({ where: { id: { startsWith: `${prefix}mail:mailbox:${hash}` } } })).toBe(0);
    expect(await rows()).toHaveLength(7);
  });

  it("enforces the global twenty-per-hour cap across different mailbox identities", async () => {
    for (let index = 0; index < 20; index += 1) await mail(mailbox(), at(index * minuteMs));
    const twentieth = await rows();
    await expect(mail(mailbox(), at(20 * minuteMs))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await rows()).toEqual(twentieth);
  });

  it("preserves the global Shanghai-day budget through new hours and process-independent transactions", async () => {
    const startedAt = new Date("2027-02-01T00:00:00+08:00");
    await seed(`${prefix}mail:global:day`, 99, startedAt);
    await mail(mailbox(), base);
    const hundredth = await rows();
    await expect(mail(mailbox(), at(hourMs))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await rows()).toEqual(hundredth);
    await mail(mailbox(), new Date("2027-02-02T00:00:00+08:00"));
  });

  it("never takes the normal global or same-recipient identity mail budget", async () => {
    const email = mailbox();
    const identityKey = `mail:${createHash("sha256").update(email).digest("hex")}`;
    const before = await db.identityRateLimit.findUnique({ where: { id: "global" } });
    await mail(email, base);
    await expect(mail(email, at(1))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await db.identityRateLimit.findUnique({ where: { id: "global" } })).toEqual(before);
    expect(await db.identityRateLimit.findUnique({ where: { id: identityKey } })).toBeNull();
  });

  it("rolls back all send charges when a later caller admission check fails", async () => {
    await expect(db.$transaction(async (tx) => {
      await budget!.takeAccessApplicationMailLimit(tx, mailbox(), base);
      throw new Error("Synthetic later capacity rejection");
    })).rejects.toThrow("Synthetic later capacity rejection");
    expect(await rows()).toEqual([]);
  });

  it("collects at most one hundred expired own keys while retaining an active Shanghai day", async () => {
    const stale = new Date(base.getTime() - 2 * dayMs);
    await db.identityRateLimit.createMany({ data: Array.from({ length: 105 }, (_, index) => ({
      id: `${prefix}stale-fixture:${index}`, attempts: 1, windowStartedAt: stale, lastAttemptAt: stale,
    })) });
    const late = new Date("2027-02-01T23:59:00+08:00");
    const dayStart = new Date("2027-02-01T00:00:00+08:00");
    await seed(`${prefix}mail:global:day`, 99, dayStart);
    await mail(mailbox(), late);
    expect(await db.identityRateLimit.count({ where: { id: { startsWith: `${prefix}stale-fixture:` } } })).toBe(5);
    expect(await db.identityRateLimit.findUnique({ where: { id: `${prefix}mail:global:day` } })).toMatchObject({ attempts: 100, windowStartedAt: dayStart });
  });
});
