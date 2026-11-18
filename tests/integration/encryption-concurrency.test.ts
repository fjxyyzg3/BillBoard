import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSessionUser } from "@/auth";
import type { Prisma } from "@prisma/client";
import { createHouseholdCode, createKeyRing, encodeHouseholdCode, exportRecoveryPackage, sealKeyRing } from "@/lib/encryption/crypto";
import { runEncryptionContext } from "@/lib/encryption/request-context";

let raw: typeof import("@/lib/db").physicalDb;
let db: typeof import("@/lib/db").db;
let service: typeof import("@/lib/encryption/service");
const householdIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  process.loadEnvFile(".env.example");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname)
    || !/(?:dev|test)/i.test(url.pathname)) throw new Error("Encryption concurrency tests require a local development or test database");
  ({ physicalDb: raw, db } = await import("@/lib/db"));
  service = await import("@/lib/encryption/service");
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await raw.appEvent.deleteMany({ where: { householdId: { in: householdIds } } });
  await raw.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await raw.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

afterAll(async () => { await raw?.$disconnect(); });

async function fixture() {
  const household = await raw.household.create({ data: { name: "Concurrency fixture" } });
  householdIds.push(household.id);
  const user = await raw.user.create({ data: { email: `encryption-concurrency-${randomUUID()}@example.com`, displayName: "Synthetic owner", passwordHash: "not-used" } });
  userIds.push(user.id);
  const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "Synthetic owner", role: "OWNER" } });
  const ledger = await raw.ledger.create({ data: { householdId: household.id, name: "CONCURRENCY_PRIVATE_SOURCE", isDefault: true } });
  const sessionRow = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
  const session = { id: user.id, householdId: household.id, memberId: member.id, appSessionId: sessionRow.id, role: "OWNER", name: "Synthetic owner", email: user.email } as AppSessionUser;
  const code = createHouseholdCode(household.id);
  const ring = createKeyRing(code);
  const recovery = await exportRecoveryPackage(code, ring);
  const input = { id: randomUUID(), kind: "ENABLE", expectedRevision: 0, candidateBackedUp: true,
    candidateKeyRing: await sealKeyRing(code, ring), candidateRecoveryPackage: recovery,
    recoveryDigest: createHash("sha256").update(recovery).digest("hex") };
  const material = { ...input, candidateCode: encodeHouseholdCode(code) };
  return { household, user, member, ledger, sessionRow, session, code, ring, input, material };
}

async function verified(f: Awaited<ReturnType<typeof fixture>>) {
  await service.prepareEncryption(f.session, f.input);
  const batch = await service.batchEncryption(f.session, f.material);
  expect(batch).toMatchObject({ done: true, operation: { status: "VERIFIED" } });
}

// Keep the real cryptographic operation and database work; control only provider latency.
function pauseFirstCrypto(method: "decrypt" | "encrypt") {
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const operation = crypto.subtle[method].bind(crypto.subtle);
  let first = true;
  vi.spyOn(crypto.subtle, method).mockImplementation(async (...args) => {
    if (first) { first = false; entered(); await pending; }
    return operation(...args);
  });
  return { release, reached };
}

// Execute the real final SQL, then inject an authorization change inside that same transaction.
function afterFinalWrite(model: "householdEncryption" | "encryptionOperation", inject: (tx: Prisma.TransactionClient) => Promise<void>) {
  const transaction = raw.$transaction.bind(raw);
  let injected = false;
  const intercepted = (work: unknown, options?: Parameters<typeof raw.$transaction>[1]) => {
    if (typeof work !== "function") throw new Error("Authorization injection requires a callback transaction");
    return transaction(async (tx) => {
      const watched = new Proxy(tx, {
        get(target, property) {
          const original = Reflect.get(target, property);
          if (property !== model) return typeof original === "function" ? original.bind(target) : original;
          return new Proxy(original as object, {
            get(delegate, method) {
              const call = Reflect.get(delegate, method);
              if (method !== "update") return typeof call === "function" ? call.bind(delegate) : call;
              return async (args: unknown) => {
                const value = await (call as (args: unknown) => Promise<unknown>).call(delegate, args);
                if (!injected) { injected = true; await inject(tx); }
                return value;
              };
            },
          });
        },
      });
      return (work as (client: Prisma.TransactionClient) => Promise<unknown>)(watched);
    }, options);
  };
  vi.spyOn(raw, "$transaction").mockImplementation(intercepted as typeof raw.$transaction);
  return () => injected;
}

describe("encryption conversion authorization and recovery", () => {
  it("uses the current database role even if a member forges an OWNER session field", async () => {
    const f = await fixture();
    const user = await raw.user.create({ data: { email: `encryption-member-${randomUUID()}@example.com`, displayName: "Synthetic member", passwordHash: "not-used" } });
    userIds.push(user.id);
    const member = await raw.householdMember.create({ data: { householdId: f.household.id, userId: user.id, memberName: "Synthetic member", role: "MEMBER" } });
    const session = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 600000) } });
    const forged = { ...f.session, id: user.id, memberId: member.id, appSessionId: session.id };
    await expect(service.prepareEncryption(forged, f.input)).rejects.toThrow("Forbidden");
    expect(await raw.encryptionOperation.count({ where: { householdId: f.household.id } })).toBe(0);
    expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name, encryptedPayload: null });
  });

  it("requires backup confirmation and matching recovery bytes before creating a barrier", async () => {
    const f = await fixture();
    for (const invalid of [{ ...f.input, candidateBackedUp: false }, { ...f.input, recoveryDigest: "0".repeat(64) }, { ...f.input, candidateCode: encodeHouseholdCode(f.code) }]) {
      await expect(service.prepareEncryption(f.session, invalid)).rejects.toMatchObject({ code: "ENCRYPTION_INVALID" });
    }
    expect(await raw.encryptionOperation.count({ where: { householdId: f.household.id } })).toBe(0);
    expect(await raw.encryptionStaging.count({ where: { operation: { householdId: f.household.id } } })).toBe(0);
  });

  it("serializes competing operations and treats an identical preparation as the original receipt", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      service.prepareEncryption(f.session, f.input), service.prepareEncryption(f.session, { ...f.input, id: randomUUID() }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await raw.encryptionOperation.count({ where: { householdId: f.household.id } })).toBe(1);
    const op = await raw.encryptionOperation.findFirstOrThrow({ where: { householdId: f.household.id } });
    const receipt = await service.prepareEncryption(f.session, { ...f.input, id: op.id });
    expect(receipt).toMatchObject({ operation: { id: op.id, status: "PREPARED" }, status: { revision: 1, mode: "ENABLING" } });
  });

  it("never reuses materials from an earlier request when a batch omits them", async () => {
    const f = await fixture();
    await service.prepareEncryption(f.session, f.input);
    await expect(service.batchEncryption(f.session, { id: f.input.id })).rejects.toThrow();
    expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(0);
    expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name, encryptedPayload: null });
  });

  it("opens and compares the recovery key contents instead of accepting only a matching file digest", async () => {
    const f = await fixture();
    const incompleteRecovery = await exportRecoveryPackage(f.code, createKeyRing(f.code));
    const input = { ...f.input, candidateRecoveryPackage: incompleteRecovery, recoveryDigest: createHash("sha256").update(incompleteRecovery).digest("hex") };
    await service.prepareEncryption(f.session, input);
    await expect(service.batchEncryption(f.session, { ...input, candidateCode: encodeHouseholdCode(f.code) })).rejects.toMatchObject({ code: "ENCRYPTION_INVALID" });
    expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(0);
    expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name, encryptedPayload: null });
  });

  it("rejects another family's correct code without creating a partial target", async () => {
    const f = await fixture();
    await service.prepareEncryption(f.session, f.input);
    const otherCode = createHouseholdCode("another-household");
    await expect(service.batchEncryption(f.session, { ...f.material, candidateCode: encodeHouseholdCode(otherCode) })).rejects.toMatchObject({ code: "ENCRYPTION_INVALID" });
    expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(0);
  });

  it("resumes an interrupted multi-batch conversion with the same candidate and includes late generic events", async () => {
    const f = await fixture();
    await raw.ledger.createMany({ data: Array.from({ length: 255 }, (_, index) => ({ householdId: f.household.id, name: `CONCURRENCY_HISTORY_${index}` })) });
    await service.prepareEncryption(f.session, f.input);
    expect(await service.batchEncryption(f.session, f.material)).toMatchObject({ done: false });
    const first = await raw.encryptionStaging.findFirstOrThrow({ where: { operationId: f.input.id }, orderBy: { entityId: "asc" } });
    expect(await raw.ledger.findMany({ where: { householdId: f.household.id, encryptedPayload: { not: null } } })).toHaveLength(0);
    await expect(service.batchEncryption(f.session, { id: f.input.id })).rejects.toThrow();
    const { recordAppEvent } = await import("@/lib/ops/record-event");
    await recordAppEvent({ householdId: f.household.id, memberId: f.member.id, eventType: "PAGE_VIEW", path: "/home", summary: "访问 首页" });
    let complete = false;
    for (let attempt = 0; attempt < 5 && !complete; attempt++) complete = (await service.batchEncryption(f.session, f.material)).done;
    expect(complete).toBe(true);
    expect(await raw.encryptionStaging.findUnique({ where: { operationId_model_entityId: { operationId: first.operationId, model: first.model, entityId: first.entityId } } })).toEqual(first);
    await service.commitEncryption(f.session, f.material);
    expect(await raw.ledger.count({ where: { householdId: f.household.id } })).toBe(256);
    expect(await raw.appEvent.count({ where: { householdId: f.household.id } })).toBe(1);
    expect(await raw.householdEncryption.findUnique({ where: { householdId: f.household.id } })).toMatchObject({ mode: "ENCRYPTED", activeOperationId: null });
  }, 20000);

  it("refuses publication after a verified source changes and preserves that source on cancellation", async () => {
    const f = await fixture();
    await verified(f);
    await raw.ledger.update({ where: { id: f.ledger.id }, data: { name: "CONCURRENCY_LATER_SOURCE" } });
    await expect(service.commitEncryption(f.session, f.material)).rejects.toMatchObject({ code: "ENCRYPTION_CHANGED" });
    expect(await raw.householdEncryption.findUnique({ where: { householdId: f.household.id } })).toMatchObject({ mode: "ENABLING", activeOperationId: f.input.id });
    await service.abortEncryption(f.session, { id: f.input.id });
    expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: "CONCURRENCY_LATER_SOURCE", encryptedPayload: null });
    expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(0);
  });

  it("fences an already admitted old context when the family enters conversion", async () => {
    const f = await fixture();
    await runEncryptionContext({ session: f.session, mode: "UNENCRYPTED", configMode: "UNENCRYPTED", revision: 0, ring: null,
      expiresAt: Date.now() + 600000, disposed: false, readOnly: false }, async () => {
      await service.prepareEncryption(f.session, f.input);
      await expect(db.ledger.update({ where: { id: f.ledger.id }, data: { name: "CONCURRENCY_STALE_WRITE" } })).rejects.toMatchObject({ code: "ENCRYPTION_CHANGED" });
    });
    expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name });
  });

  it("rolls back real plaintext SQL when its admitted context expires before the transaction returns", async () => {
    const f = await fixture();
    const context = { session: f.session, mode: "UNENCRYPTED" as const, configMode: "UNENCRYPTED" as const, revision: 0, ring: null,
      expiresAt: Date.now() + 600000, disposed: false, readOnly: false };
    let executed = false;
    const traced = raw.$extends({ query: { ledger: { async update({ args, query }) {
      const result = await query(args);
      executed = true; context.expiresAt = Date.now() - 1;
      return result;
    } } } });
    const { encryptionDatabase } = await import("@/lib/encryption/database");
    const facade = encryptionDatabase(traced as unknown as typeof raw);
    await expect(runEncryptionContext(context, () => facade.ledger.update({ where: { id: f.ledger.id }, data: { name: "CONCURRENCY_EXPIRED_PLAINTEXT_SQL" } }))).rejects.toMatchObject({ code: "ENCRYPTION_EXPIRED" });
    expect(executed).toBe(true);
    expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name, encryptedPayload: null });
  });

  it.each(["prepare", "abort"] as const)("rejects %s when the database session has expired despite a behind application clock", async (phase) => {
    const f = await fixture();
    if (phase === "abort") await verified(f);
    const [{ now }] = await raw.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    await raw.appSession.update({ where: { id: f.sessionRow.id }, data: { expiresAt: new Date(now.getTime() - 1000) } });
    vi.setSystemTime(new Date(now.getTime() - 60000));
    await expect(phase === "prepare" ? service.prepareEncryption(f.session, f.input) : service.abortEncryption(f.session, { id: f.input.id })).rejects.toThrow("Unauthorized");
    if (phase === "prepare") {
      expect(await raw.encryptionOperation.count({ where: { householdId: f.household.id } })).toBe(0);
      expect(await raw.householdEncryption.findUnique({ where: { householdId: f.household.id } })).toBeNull();
    } else {
      expect(await raw.encryptionOperation.findUnique({ where: { id: f.input.id } })).toMatchObject({ status: "VERIFIED" });
      expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(1);
      expect(await raw.householdEncryption.findUnique({ where: { householdId: f.household.id } })).toMatchObject({ mode: "ENABLING", activeOperationId: f.input.id });
    }
  });

  it.each(["expires", "revokes"] as const)("rolls back preparation when the original session %s after the actual barrier SQL", async (change) => {
    const f = await fixture();
    const injected = afterFinalWrite("householdEncryption", async (tx) => {
      if (change === "expires") await tx.$executeRaw`UPDATE "AppSession" SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=${f.sessionRow.id}`;
      else await tx.$executeRaw`UPDATE "AppSession" SET revoked_at=clock_timestamp() WHERE id=${f.sessionRow.id}`;
    });
    await expect(service.prepareEncryption(f.session, f.input)).rejects.toThrow("Unauthorized");
    expect(injected()).toBe(true);
    expect(await raw.encryptionOperation.count({ where: { householdId: f.household.id } })).toBe(0);
    expect(await raw.householdEncryption.findUnique({ where: { householdId: f.household.id } })).toBeNull();
    expect(await raw.appSession.findUnique({ where: { id: f.sessionRow.id } })).toMatchObject({ expiresAt: f.sessionRow.expiresAt, revokedAt: null });
  });

  it.each(["expires", "revokes"] as const)("rolls back cancellation when the original session %s after its actual final receipt SQL", async (change) => {
    const f = await fixture();
    await verified(f);
    const injected = afterFinalWrite("encryptionOperation", async (tx) => {
      if (change === "expires") await tx.$executeRaw`UPDATE "AppSession" SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=${f.sessionRow.id}`;
      else await tx.$executeRaw`UPDATE "AppSession" SET revoked_at=clock_timestamp() WHERE id=${f.sessionRow.id}`;
    });
    await expect(service.abortEncryption(f.session, { id: f.input.id })).rejects.toThrow("Unauthorized");
    expect(injected()).toBe(true);
    expect(await raw.encryptionOperation.findUnique({ where: { id: f.input.id } })).toMatchObject({ status: "VERIFIED" });
    expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(1);
    expect(await raw.householdEncryption.findUnique({ where: { householdId: f.household.id } })).toMatchObject({ mode: "ENABLING", activeOperationId: f.input.id });
    expect(await raw.appSession.findUnique({ where: { id: f.sessionRow.id } })).toMatchObject({ expiresAt: f.sessionRow.expiresAt, revokedAt: null });
  });

  it("does not return a plaintext callback result after PG session expiry while the application clock lags", async () => {
    const f = await fixture();
    const [{ now }] = await raw.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    vi.setSystemTime(new Date(now.getTime() - 60000));
    vi.doMock("@/lib/auth/session", () => ({ requireAppSession: async () => f.session }));
    let completed = false;
    try {
      const { withHouseholdEncryption } = await import("@/lib/encryption/request");
      await expect(withHouseholdEncryption(undefined, async () => {
        await raw.$executeRaw`UPDATE "AppSession" SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=${f.sessionRow.id}`;
        completed = true;
        return "PRIVATE_CALLBACK_RESULT_MUST_NOT_RETURN";
      })).rejects.toThrow("Unauthorized");
      expect(completed).toBe(true);
    } finally { vi.doUnmock("@/lib/auth/session"); }
  });

  it("waits for an expired lease row to be actually released before copying or publishing", async () => {
    const f = await fixture();
    const token = randomUUID();
    await raw.resourceLease.create({ data: { token, kind: "import", householdId: f.household.id, memberId: f.member.id, expiresAt: new Date(Date.now() - 60000) } });
    await service.prepareEncryption(f.session, f.input);
    expect(await service.batchEncryption(f.session, f.material)).toMatchObject({ done: false, waiting: true });
    expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(0);
    await expect(service.commitEncryption(f.session, f.material)).rejects.toMatchObject({ code: "ENCRYPTION_BUSY" });
    await raw.resourceLease.delete({ where: { token } });
    expect(await service.batchEncryption(f.session, f.material)).toMatchObject({ done: true });
    expect(await service.commitEncryption(f.session, f.material)).toMatchObject({ operation: { status: "COMMITTED" } });
  });

  it("does not let another family's admission prune an expired execution before conversion", async () => {
    const f = await fixture(), outside = await fixture(), third = await fixture();
    const admission = await import("@/lib/resources/admission");
    const acquire = (target: typeof f) => raw.$transaction((tx) => admission.acquireResourceLease(tx, target.session, "import", { ledgerId: target.ledger.id }));
    const active = await acquire(f);
    let external: typeof active | undefined;
    try {
      await raw.$executeRaw`UPDATE "ResourceLease" SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE token = ${active.token}`;
      await service.prepareEncryption(f.session, f.input);
      external = await acquire(outside);
      expect(await raw.resourceLease.findUnique({ where: { token: active.token } })).not.toBeNull();
      expect(await raw.resourceExecution.findUnique({ where: { token: active.token } })).not.toBeNull();
      await expect(acquire(third)).rejects.toMatchObject({ code: "BUSY" });
      expect(await service.batchEncryption(f.session, f.material)).toMatchObject({ done: false, waiting: true });
      expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(0);
      await admission.releaseResourceLease(active);
      expect(await raw.resourceExecution.findUnique({ where: { token: active.token } })).toBeNull();
      expect(await service.batchEncryption(f.session, f.material)).toMatchObject({ done: true });
      expect(await service.commitEncryption(f.session, f.material)).toMatchObject({ operation: { status: "COMMITTED" } });
    } finally {
      await admission.releaseResourceLease(active);
      if (external) await admission.releaseResourceLease(external);
    }
  });

  it("allows a new session to query an expired attempt without granting it the old publishing authority", async () => {
    const f = await fixture();
    await service.prepareEncryption(f.session, f.input);
    await raw.appSession.update({ where: { id: f.sessionRow.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const next = await raw.appSession.create({ data: { userId: f.user.id, memberId: f.member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 600000) } });
    const fresh = { ...f.session, appSessionId: next.id };
    expect(await service.queryEncryption(fresh, { id: f.input.id })).toMatchObject({ operation: { status: "PREPARED" } });
    await expect(service.batchEncryption(fresh, f.material)).rejects.toMatchObject({ code: "ENCRYPTION_EXPIRED" });
    await expect(service.commitEncryption(fresh, f.material)).rejects.toMatchObject({ code: "ENCRYPTION_EXPIRED" });
    await expect(service.commitEncryption(f.session, f.material)).rejects.toThrow("Unauthorized");
    expect(await service.abortEncryption(fresh, { id: f.input.id })).toMatchObject({ operation: { status: "ABORTED" } });
  });

  it("allows the current owner to cancel a predecessor's attempt without inheriting publishing authority", async () => {
    const f = await fixture();
    await verified(f);
    const nextUser = await raw.user.create({ data: { email: `encryption-next-owner-${randomUUID()}@example.com`, displayName: "Synthetic next owner", passwordHash: "not-used" } });
    userIds.push(nextUser.id);
    const nextMember = await raw.$transaction(async (tx) => {
      await tx.householdMember.update({ where: { id: f.member.id }, data: { role: "MEMBER" } });
      return tx.householdMember.create({ data: { householdId: f.household.id, userId: nextUser.id, memberName: "Synthetic next owner", role: "OWNER" } });
    });
    const nextSession = await raw.appSession.create({ data: { userId: nextUser.id, memberId: nextMember.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 600000) } });
    const currentOwner = { ...f.session, id: nextUser.id, memberId: nextMember.id, appSessionId: nextSession.id };
    await expect(service.batchEncryption(currentOwner, f.material)).rejects.toMatchObject({ code: "ENCRYPTION_CHANGED" });
    await expect(service.commitEncryption(currentOwner, f.material)).rejects.toMatchObject({ code: "ENCRYPTION_CHANGED" });
    await expect(service.commitEncryption(f.session, f.material)).rejects.toThrow("Forbidden");
    const otherFamily = await fixture();
    await expect(service.abortEncryption(otherFamily.session, { id: f.input.id })).rejects.toThrow("Forbidden");
    expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(1);
    expect(await service.abortEncryption(currentOwner, { id: f.input.id })).toMatchObject({ operation: { status: "ABORTED" }, status: { mode: "UNENCRYPTED", operation: null } });
    expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(0);
    expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name, encryptedPayload: null });
  });

  it("makes a missing UUID cancellation a durable tombstone against a late preparation", async () => {
    const f = await fixture();
    expect(await service.queryEncryption(f.session, { id: f.input.id })).toMatchObject({ operation: null, unknown: true });
    await service.abortEncryption(f.session, { id: f.input.id });
    await expect(service.prepareEncryption(f.session, f.input)).rejects.toMatchObject({ code: "ENCRYPTION_CHANGED" });
    expect(await service.commitEncryption(f.session, { id: f.input.id })).toMatchObject({ operation: { status: "ABORTED" } });
    expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name, encryptedPayload: null });
  });

  it("does not stage data after the original session expires during real key decryption", async () => {
    const f = await fixture();
    await service.prepareEncryption(f.session, f.input);
    const expiry = new Date(Date.now() + 60000);
    await raw.appSession.update({ where: { id: f.sessionRow.id }, data: { expiresAt: expiry } });
    const barrier = pauseFirstCrypto("decrypt");
    const pending = service.batchEncryption(f.session, f.material);
    try {
      await barrier.reached;
      vi.setSystemTime(new Date(expiry.getTime() + 1));
      barrier.release();
      await expect(pending).rejects.toThrow("Unauthorized");
      expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(0);
    } finally { barrier.release(); await pending.catch(() => undefined); }
  });

  it("uses the database clock to reject an expired original session when the application clock is behind", async () => {
    const f = await fixture();
    await verified(f);
    const [{ now }] = await raw.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    await raw.appSession.update({ where: { id: f.sessionRow.id }, data: { expiresAt: new Date(now.getTime() - 1000) } });
    vi.setSystemTime(new Date(now.getTime() - 60000));
    await expect(service.commitEncryption(f.session, f.material)).rejects.toThrow("Unauthorized");
    expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name, encryptedPayload: null });
    expect(await raw.householdEncryption.findUnique({ where: { householdId: f.household.id } })).toMatchObject({ mode: "ENABLING", activeOperationId: f.input.id });
  });

  it("does not commit after the operation deadline expires during real key decryption", async () => {
    const f = await fixture();
    await verified(f);
    const op = await raw.encryptionOperation.findUniqueOrThrow({ where: { id: f.input.id } });
    const barrier = pauseFirstCrypto("decrypt");
    const pending = service.commitEncryption(f.session, f.material);
    try {
      await barrier.reached;
      vi.setSystemTime(new Date(op.expiresAt.getTime() + 1));
      barrier.release();
      await expect(pending).rejects.toMatchObject({ code: "ENCRYPTION_EXPIRED" });
      expect(await raw.householdEncryption.findUnique({ where: { householdId: f.household.id } })).toMatchObject({ mode: "ENABLING", activeOperationId: f.input.id });
      expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name, encryptedPayload: null });
    } finally { barrier.release(); await pending.catch(() => undefined); }
  });

  it("rolls back a batch when its session expires during actual entity encryption", async () => {
    const f = await fixture();
    await service.prepareEncryption(f.session, f.input);
    const expiry = new Date(Date.now() + 60000);
    await raw.appSession.update({ where: { id: f.sessionRow.id }, data: { expiresAt: expiry } });
    const barrier = pauseFirstCrypto("encrypt");
    const pending = service.batchEncryption(f.session, f.material);
    try {
      await barrier.reached;
      vi.setSystemTime(new Date(expiry.getTime() + 1));
      barrier.release();
      await expect(pending).rejects.toThrow("Unauthorized");
      expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(0);
    } finally { barrier.release(); await pending.catch(() => undefined); }
  });

  it("rolls back actual publication SQL when the operation expires before the final mode switch", async () => {
    const f = await fixture();
    await verified(f);
    const op = await raw.encryptionOperation.findUniqueOrThrow({ where: { id: f.input.id } });
    const databaseModule = await import("@/lib/encryption/database");
    const replace = databaseModule.bulkReplace;
    let release!: () => void;
    let entered!: () => void;
    const suspended = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let first = true;
    vi.spyOn(databaseModule, "bulkReplace").mockImplementation(async (...args) => {
      await replace(...args);
      if (first) { first = false; entered(); await suspended; }
    });
    const pending = service.commitEncryption(f.session, f.material);
    try {
      await reached;
      vi.setSystemTime(new Date(op.expiresAt.getTime() + 1));
      release();
      await expect(pending).rejects.toMatchObject({ code: "ENCRYPTION_EXPIRED" });
      expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: f.ledger.name, encryptedPayload: null });
      expect(await raw.encryptionStaging.count({ where: { operationId: f.input.id } })).toBe(1);
      expect(await raw.householdEncryption.findUnique({ where: { householdId: f.household.id } })).toMatchObject({ mode: "ENABLING" });
    } finally { release(); await pending.catch(() => undefined); }
  });
});
