import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHouseholdCode, createKeyRing, encodeHouseholdCode, sealKeyRing } from "@/lib/encryption/crypto";
import { encryptRow } from "@/lib/encryption/protected-models";
import type { ResourceLease } from "@/lib/resources/admission";
import { wav } from "../fixtures/voice-wav";

process.loadEnvFile(".env.example");
let database: typeof import("@/lib/db").physicalDb;
let resources: typeof import("@/lib/resources/admission");
let voice: typeof import("@/lib/processing/voice-admission");
let loadSession: typeof import("@/lib/auth/app-sessions").loadValidAppSessionUser;
let activeSessionId: string | null = null;
const householdIds: string[] = [], userIds: string[] = [], leases: ResourceLease[] = [];
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://billboard.test", host: "billboard.test", "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" }) }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: async () => {
  const session = activeSessionId ? await loadSession(activeSessionId) : null;
  if (!session) throw new Error("Unauthorized");
  return session;
} }));

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Deferred resource tests require a local development/test database");
  }
  ({ physicalDb: database } = await import("@/lib/db"));
  resources = await import("@/lib/resources/admission");
  voice = await import("@/lib/processing/voice-admission");
  ({ loadValidAppSessionUser: loadSession } = await import("@/lib/auth/app-sessions"));
});

beforeEach(async () => {
  // Resource integration suites run serially; do not clear an actual running upload.
  if (await database.resourceLease.count({ where: { kind: "voice" } })) throw new Error("Deferred resource tests require idle voice workers");
  await database.resourceWindow.deleteMany({ where: { kind: "voice" } });
});

afterEach(async () => {
  activeSessionId = null;
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) await resources.releaseResourceLease(lease);
  await database.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await database.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await database.resourceWindow.deleteMany({ where: { kind: "voice" } });
});
afterAll(async () => { await database?.$disconnect(); });

async function fixture(encrypted = false) {
  const household = await database.household.create({ data: { name: "Deferred voice fixture" } }); householdIds.push(household.id);
  const user = await database.user.create({ data: { email: `deferred-voice-${randomUUID()}@example.test`, displayName: "Synthetic voice", passwordHash: "not-used", aiProcessingEnabled: true, voiceProcessingEnabled: true } }); userIds.push(user.id);
  const member = await database.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "Synthetic owner", role: "OWNER" } });
  const row = await database.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 600000) } });
  const ledger = await database.ledger.create({ data: { householdId: household.id, name: "Deferred voice ledger", isDefault: true } });
  const code = createHouseholdCode(household.id), ring = createKeyRing(code);
  if (encrypted) {
    const protectedLedger = await encryptRow("ledger", ledger, ring, household.id, "");
    await database.ledger.update({ where: { id: ledger.id }, data: { name: String(protectedLedger.name), encryptedPayload: String(protectedLedger.encryptedPayload), encryptionRevision: String(protectedLedger.encryptionRevision) } });
    await database.householdEncryption.create({ data: { householdId: household.id, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: code.keyVersion, sealedKeyRing: await sealKeyRing(code, ring) } });
  }
  const session = (await loadSession(row.id))!;
  const context = { householdId: household.id, memberId: member.id, ledgerId: ledger.id };
  return { session, context, code };
}

async function reserve(current: Awaited<ReturnType<typeof fixture>>, deferCharge = true) {
  const lease = await voice.reserveVoiceUpload(current.session, current.context, { deferCharge });
  leases.push(lease);
  return lease;
}
function quotaState() {
  return database.resourceWindow.findMany({ where: { kind: "voice" }, orderBy: { key: "asc" }, select: { key: true, startedAt: true, used: true } });
}
function charge(current: Awaited<ReturnType<typeof fixture>>, lease: ResourceLease) {
  return database.$transaction((tx) => resources.chargeResourceLease(tx, current.session, lease), { maxWait: 10000, timeout: 15000 });
}
async function expectUncharged(lease: ResourceLease) {
  expect(await database.resourceExecution.findUnique({ where: { token: lease.token } })).toMatchObject({ chargedAt: null });
  expect((await quotaState()).every((window) => window.used === 0)).toBe(true);
}

describe("deferred encrypted upload quota", () => {
  it.each(["missing", "wrong"] as const)("retains bounded upload occupancy without charging for %s household keys", async (kind) => {
    const current = await fixture(true);
    activeSessionId = current.session.appSessionId;
    const lease = await reserve(current);
    await expectUncharged(lease);
    const before = await quotaState();
    const { withHouseholdEncryption } = await import("@/lib/encryption/request");
    const wrongCode = createHouseholdCode(current.session.householdId, current.code.generation, current.code.keyVersion);
    let admitted = false;
    await expect(withHouseholdEncryption(kind === "missing" ? undefined : { code: encodeHouseholdCode(wrongCode), revision: 1 }, async () => {
      admitted = true;
      return voice.admitVoiceRequest(current.session, current.context, randomUUID(), wav(), lease);
    })).rejects.toMatchObject({ code: kind === "missing" ? "ENCRYPTION_REQUIRED" : "ENCRYPTION_INVALID" });
    expect(admitted).toBe(false);
    expect(await quotaState()).toEqual(before);
    expect(await database.resourceLease.findUnique({ where: { token: lease.token } })).not.toBeNull();
    await expect(reserve(current)).rejects.toMatchObject({ code: "BUSY" });
    expect(await database.voiceProcessingAdmission.count({ where: { householdId: current.session.householdId } })).toBe(0);
    await expectUncharged(lease);
  });

  it("charges a deferred upload in the same transaction as complete voice acceptance", async () => {
    const current = await fixture(), lease = await reserve(current), requestId = randomUUID();
    await expectUncharged(lease);
    const accepted = await voice.admitVoiceRequest(current.session, current.context, requestId, wav(), lease);
    expect(accepted.lease.token).toBe(lease.token);
    expect(await database.voiceProcessingAdmission.findUnique({ where: { id: accepted.admissionId } })).toMatchObject({ clientRequestId: requestId, appSessionId: current.session.appSessionId });
    expect(await database.resourceExecution.findUnique({ where: { token: lease.token } })).toMatchObject({ chargedAt: expect.any(Date) });
    expect((await quotaState()).map((window) => window.used)).toEqual([1, 1, 1]);
  });

  it("preserves ordinary WAV charging at upload reservation without charging acceptance twice", async () => {
    const current = await fixture(), lease = await reserve(current, false);
    expect(await database.resourceExecution.findUnique({ where: { token: lease.token } })).toMatchObject({ chargedAt: expect.any(Date) });
    const before = await quotaState();
    expect(before.map((window) => window.used)).toEqual([1, 1, 1]);
    await voice.admitVoiceRequest(current.session, current.context, randomUUID(), wav(), lease);
    expect(await quotaState()).toEqual(before);
  });

  it("charges a live execution at most once across concurrent transactions and retries", async () => {
    const current = await fixture(), lease = await reserve(current);
    await Promise.all([charge(current, lease), charge(current, lease)]);
    const before = await quotaState(), execution = await database.resourceExecution.findUniqueOrThrow({ where: { token: lease.token } });
    expect(before.map((window) => window.used)).toEqual([1, 1, 1]);
    expect(execution.chargedAt).toBeInstanceOf(Date);
    await charge(current, lease);
    expect(await quotaState()).toEqual(before);
    expect(await database.resourceExecution.findUniqueOrThrow({ where: { token: lease.token } })).toEqual(execution);
  });

  it("does not partially charge any window when a deferred upload exceeds the final member limit", async () => {
    const current = await fixture(), lease = await reserve(current);
    const [{ now }] = await database.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    await database.resourceWindow.updateMany({ where: { kind: "voice" }, data: { startedAt: now, used: 1 } });
    await database.resourceWindow.update({ where: { key: `voice:member:${current.session.memberId}` }, data: { used: resources.RESOURCE_POLICIES.voice.perMinute.member } });
    const before = await quotaState();
    await expect(charge(current, lease)).rejects.toMatchObject({ code: "BUSY" });
    expect(await quotaState()).toEqual(before);
    expect(await database.resourceExecution.findUnique({ where: { token: lease.token } })).toMatchObject({ chargedAt: null });
  });

  it.each(["audio", "consent", "uuid"] as const)("does not charge a deferred upload rejected by %s validation", async (kind) => {
    const current = await fixture(), lease = await reserve(current), requestId = randomUUID();
    if (kind === "consent") await database.user.update({ where: { id: current.session.id }, data: { voiceProcessingEnabled: false } });
    if (kind === "uuid") await database.voiceProcessingAdmission.create({ data: { householdId: current.session.householdId, memberId: current.session.memberId, userId: current.session.id, appSessionId: current.session.appSessionId, ledgerId: current.context.ledgerId, clientRequestId: requestId, audioHash: "synthetic-existing-hash", expiresAt: new Date(Date.now() + 60000) } });
    await expect(voice.admitVoiceRequest(current.session, current.context, requestId, kind === "audio" ? new Uint8Array([0]) : wav(), lease)).rejects.toThrow();
    await expectUncharged(lease);
    expect(await database.voiceProcessingAdmission.count({ where: { householdId: current.session.householdId } })).toBe(kind === "uuid" ? 1 : 0);
  });

  it.each(["identity", "expired", "execution"] as const)("rejects charging a lease with invalid %s without charging its windows", async (kind) => {
    const current = await fixture(), lease = await reserve(current);
    if (kind === "expired") await database.$executeRaw`UPDATE "ResourceLease" SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE token=${lease.token}`;
    if (kind === "execution") await database.resourceExecution.delete({ where: { token: lease.token } });
    const caller = kind === "identity" ? await fixture() : current;
    const before = await quotaState();
    await expect(charge(caller, lease)).rejects.toMatchObject({ code: "EXPIRED" });
    expect(await quotaState()).toEqual(before);
    expect((await database.resourceExecution.findUnique({ where: { token: lease.token } }))?.chargedAt ?? null).toBeNull();
  });
});
