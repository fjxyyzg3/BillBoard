import { randomUUID } from "node:crypto";
import { AppEventType, type Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHouseholdCode, createKeyRing, sealKeyRing } from "@/lib/encryption/crypto";
import { decryptRow } from "@/lib/encryption/protected-models";
import { runEncryptionContext, type EncryptionRequestContext } from "@/lib/encryption/request-context";

let database: typeof import("@/lib/db").physicalDb;
let queryDashboard: typeof import("@/lib/ops/dashboard").queryOpsDashboard;
let recordEvent: typeof import("@/lib/ops/record-event").recordAppEvent;
let householdId: string;
let memberId: string;
let userId: string;
let appSessionId: string;
let ring: ReturnType<typeof createKeyRing>;

beforeAll(async () => {
  process.loadEnvFile(".env.example");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname)
    || !/(?:dev|test)/i.test(url.pathname)) throw new Error("Encryption event tests require a local development or test database");
  ({ physicalDb: database } = await import("@/lib/db"));
  ({ queryOpsDashboard: queryDashboard } = await import("@/lib/ops/dashboard"));
  ({ recordAppEvent: recordEvent } = await import("@/lib/ops/record-event"));
});

beforeEach(async () => {
  const household = await database.household.create({ data: { name: "Encryption event fixture" } });
  householdId = household.id;
  const user = await database.user.create({ data: { email: `encryption-events-${randomUUID()}@example.com`, displayName: "Fixture owner", passwordHash: "not-used" } });
  userId = user.id;
  const member = await database.householdMember.create({ data: { householdId, userId, memberName: "Fixture owner", role: "OWNER" } });
  memberId = member.id;
  const session = await database.appSession.create({ data: { userId, memberId, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 600000) } });
  appSessionId = session.id;
  const code = createHouseholdCode(householdId);
  ring = createKeyRing(code);
  await database.householdEncryption.create({ data: { householdId, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: code.keyVersion, sealedKeyRing: await sealKeyRing(code, ring) } });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await database.appEvent.deleteMany({ where: { householdId } });
  await database.household.delete({ where: { id: householdId } });
  await database.user.delete({ where: { id: userId } });
});

afterAll(async () => { await database?.$disconnect(); });

function requestContext(overrides: Partial<EncryptionRequestContext> = {}): EncryptionRequestContext {
  return {
    session: { id: userId, householdId, memberId, appSessionId, role: "OWNER" },
    mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1, ring: structuredClone(ring),
    expiresAt: Date.now() + 600000, disposed: false, readOnly: false,
    ...overrides,
  };
}

async function writeBusinessEvent() {
  await recordEvent({ householdId, memberId, eventType: AppEventType.IMPORT_CONFIRMED,
    metadata: { count: 12345, source: "alipay", transactionType: "income" }, summary: "确认导入 12345 笔", path: "/records/import?draft=private-value" });
  return database.appEvent.findFirst({ where: { householdId }, orderBy: { createdAt: "desc" } });
}

function expectGeneric(event: Awaited<ReturnType<typeof writeBusinessEvent>>) {
  expect(event).not.toBeNull();
  expect(event).toMatchObject({ summary: null, metadata: null, encryptedPayload: null, encryptionRevision: null, path: "/records/import" });
}

// Keep real SQL and encryption; expire the session at an awaited boundary in the same transaction.
function expireSessionDuringEvent(phase: "crypto" | "retention") {
  const transaction = database.$transaction.bind(database);
  let activeTransaction: Prisma.TransactionClient | undefined;
  let expired = false;
  const expire = async (tx: Prisma.TransactionClient) => {
    if (expired) return;
    await tx.$executeRaw`UPDATE "AppSession" SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=${appSessionId}`;
    expired = true;
  };
  const intercepted = (work: unknown, options?: Parameters<typeof database.$transaction>[1]) => {
    if (typeof work !== "function") throw new Error("Event expiry injection requires a callback transaction");
    return transaction(async (tx) => {
      activeTransaction = tx;
      const watched = phase === "crypto" ? tx : new Proxy(tx, {
        get(target, property) {
          const original = Reflect.get(target, property);
          if (property !== "appEvent") return typeof original === "function" ? original.bind(target) : original;
          return new Proxy(original as object, {
            get(delegate, method) {
              const call = Reflect.get(delegate, method);
              if (method !== "deleteMany") return typeof call === "function" ? call.bind(delegate) : call;
              return async (args: unknown) => {
                const value = await (call as (args: unknown) => Promise<unknown>).call(delegate, args);
                await expire(tx);
                return value;
              };
            },
          });
        },
      });
      return (work as (client: Prisma.TransactionClient) => Promise<unknown>)(watched);
    }, options);
  };
  vi.spyOn(database, "$transaction").mockImplementation(intercepted as typeof database.$transaction);
  if (phase === "crypto") {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      const value = await encrypt(...args);
      if (!activeTransaction) throw new Error("Event encryption must run inside its actual transaction");
      await expire(activeTransaction);
      return value;
    });
  }
  return () => expired;
}

describe("encrypted business events", () => {
  it("shows encrypted families with generic event labels and row counts without opening business summaries", async () => {
    const now = new Date();
    await database.appEvent.create({ data: { householdId, memberId, createdAt: now, eventType: AppEventType.IMPORT_CONFIRMED,
      path: "/records/import", summary: "确认导入 98765 笔", metadata: { count: 98765, source: "alipay", transactionType: "income" } } });
    const dashboard = await queryDashboard({ now, version: "1.55.3" });
    expect(dashboard.database).toEqual({ ok: true });
    expect(dashboard.recentEvents).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: AppEventType.IMPORT_CONFIRMED, path: "/records/import", summary: null })]));
    expect(JSON.stringify(dashboard.recentEvents)).not.toContain("98765");
    expect(dashboard.today.importConfirmed).toBeGreaterThanOrEqual(1);
    expect(dashboard.today.importConfirmed).toBeLessThan(98765);
  });

  it("preserves the exact sanitized business payload only inside the household ciphertext", async () => {
    const event = await runEncryptionContext(requestContext(), writeBusinessEvent);
    expect(event).not.toBeNull();
    expect(event).toMatchObject({ summary: null, metadata: null, householdId, memberId, path: "/records/import" });
    expect(event!.encryptedPayload).toMatch(/^BBE1\./);
    expect(JSON.stringify(event)).not.toContain("确认导入 12345 笔");
    expect(JSON.stringify(event)).not.toContain('"count":12345');
    expect(JSON.stringify(event)).not.toContain('"source":"alipay"');
    const opened = await decryptRow("appEvent", event!, ring, householdId);
    expect(opened.summary).toBe("确认导入 12345 笔");
    expect(opened.metadata).toEqual({ count: 12345, source: "alipay", transactionType: "income" });
    await expect(decryptRow("appEvent", { ...event!, memberId: "changed-member" }, ring, householdId)).rejects.toThrow();
  });

  it("records a minimal event without a key instead of dropping it or persisting business values", async () => {
    expectGeneric(await writeBusinessEvent());
  });

  it.each([
    { revision: 0 }, { mode: "UNENCRYPTED" as const, ring: null }, { ring: null },
  ])("records only minimal metadata for a mismatched context %j", async (override) => {
    expectGeneric(await runEncryptionContext(requestContext(override), writeBusinessEvent));
  });

  it("does not borrow a key after a context is disposed, even if the family is now unencrypted", async () => {
    let resume!: () => void;
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    let lateEvent!: ReturnType<typeof writeBusinessEvent>;
    await runEncryptionContext(requestContext(), async () => {
      lateEvent = pending.then(writeBusinessEvent);
    });
    await database.householdEncryption.update({ where: { householdId }, data: { mode: "UNENCRYPTED", revision: 2 } });
    resume();
    expectGeneric(await lateEvent);
  });

  it.each(["ENABLING", "DISABLING", "ENCRYPTED"])("keeps late events generic while %s has an active operation", async (mode) => {
    await database.householdEncryption.update({ where: { householdId }, data: { mode, activeOperationId: randomUUID() } });
    expectGeneric(await runEncryptionContext(requestContext({ configMode: mode as EncryptionRequestContext["configMode"] }), writeBusinessEvent));
  });

  it("rechecks the original session and member before encrypting an event", async () => {
    await database.appSession.update({ where: { id: appSessionId }, data: { revokedAt: new Date() } });
    expectGeneric(await runEncryptionContext(requestContext(), writeBusinessEvent));
    await database.appEvent.deleteMany({ where: { householdId } });
    await database.householdMember.update({ where: { id: memberId }, data: { leftAt: new Date() } });
    expectGeneric(await runEncryptionContext(requestContext(), writeBusinessEvent));
  });

  it.each(["UNENCRYPTED", "ENCRYPTED"] as const)("keeps a %s event generic when PG has expired the session despite a behind application clock", async (mode) => {
    if (mode === "UNENCRYPTED") await database.householdEncryption.update({ where: { householdId }, data: { mode } });
    const [{ now }] = await database.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    await database.$executeRaw`UPDATE "AppSession" SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=${appSessionId}`;
    vi.setSystemTime(new Date(now.getTime() - 60000));
    expectGeneric(await runEncryptionContext(requestContext({ mode, configMode: mode, ring: mode === "ENCRYPTED" ? structuredClone(ring) : null }), writeBusinessEvent));
    expect(await database.appEvent.count({ where: { householdId } })).toBe(1);
  });

  it.each(["crypto", "retention"] as const)("clears business ciphertext when the original session expires during actual %s work", async (phase) => {
    const [{ now }] = await database.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    vi.setSystemTime(new Date(now.getTime() - 60000));
    const expired = expireSessionDuringEvent(phase);
    expectGeneric(await runEncryptionContext(requestContext(), writeBusinessEvent));
    expect(expired()).toBe(true);
    expect(await database.appEvent.count({ where: { householdId } })).toBe(1);
  });

  it("clears plaintext business values when the original session expires after actual retention SQL", async () => {
    await database.householdEncryption.update({ where: { householdId }, data: { mode: "UNENCRYPTED" } });
    const [{ now }] = await database.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    vi.setSystemTime(new Date(now.getTime() - 60000));
    const expired = expireSessionDuringEvent("retention");
    expectGeneric(await runEncryptionContext(requestContext({ mode: "UNENCRYPTED", configMode: "UNENCRYPTED", ring: null }), writeBusinessEvent));
    expect(expired()).toBe(true);
    expect(await database.appEvent.count({ where: { householdId } })).toBe(1);
  });

  it("preserves stable unencrypted behavior and rejects unknown metadata", async () => {
    await database.householdEncryption.update({ where: { householdId }, data: { mode: "UNENCRYPTED", revision: 2 } });
    const event = await writeBusinessEvent();
    expect(event).toMatchObject({ summary: "确认导入 12345 笔", metadata: { count: 12345, source: "alipay", transactionType: "income" }, encryptedPayload: null });
    await recordEvent({ householdId, memberId, eventType: AppEventType.PAGE_VIEW, metadata: { count: 1, raw: "private-value" } as never });
    expect(await database.appEvent.count({ where: { householdId } })).toBe(1);
    const dashboard = await queryDashboard({ version: "1.55.3" });
    expect(dashboard.recentEvents).toEqual(expect.arrayContaining([expect.objectContaining({ summary: "确认导入 12345 笔" })]));
  });

  it("defers 90-day cleanup while the family has a conversion and resumes after it ends", async () => {
    const old = await database.appEvent.create({ data: { householdId, memberId, eventType: AppEventType.PAGE_VIEW, createdAt: new Date(Date.now() - 91 * 86400000) } });
    await database.householdEncryption.update({ where: { householdId }, data: { mode: "ENABLING", activeOperationId: randomUUID() } });
    await writeBusinessEvent();
    expect(await database.appEvent.findUnique({ where: { id: old.id } })).not.toBeNull();
    await database.householdEncryption.update({ where: { householdId }, data: { mode: "ENCRYPTED", activeOperationId: null } });
    await writeBusinessEvent();
    expect(await database.appEvent.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it("does not throw or modify a completed business result when audit persistence fails", async () => {
    vi.spyOn(database, "$transaction").mockRejectedValueOnce(new Error("synthetic database outage"));
    await expect(recordEvent({ householdId, memberId, eventType: AppEventType.TRANSACTION_CREATED,
      summary: "新增收入记录", metadata: { transactionType: "income" } })).resolves.toBeUndefined();
    expect(await database.appEvent.count({ where: { householdId } })).toBe(0);
  });
});
