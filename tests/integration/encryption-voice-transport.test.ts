import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHouseholdCode, createKeyRing, encodeHouseholdCode, exportRecoveryPackage, parseHouseholdCode, sealKeyRing } from "@/lib/encryption/crypto";
import { encryptRow } from "@/lib/encryption/protected-models";
import { runEncryptionContext } from "@/lib/encryption/request-context";
import type { NaturalLanguageRequest } from "@/lib/transactions/natural-language-protocol";
import { wav } from "../fixtures/voice-wav";

process.loadEnvFile(".env.example");
const { transcribe, parse, requestHeaders } = vi.hoisted(() => ({
  transcribe: vi.fn(), parse: vi.fn(),
  requestHeaders: new Headers({ origin: "https://billboard.test", host: "billboard.test", "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" }),
}));
let raw: typeof import("@/lib/db").physicalDb;
let db: typeof import("@/lib/db").db;
let loadSession: typeof import("@/lib/auth/app-sessions").loadValidAppSessionUser;
let sessionId: string | null = null;
const householdIds: string[] = [], userIds: string[] = [];
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: async () => {
  const session = sessionId ? await loadSession(sessionId) : null;
  if (!session) throw new Error("Unauthorized");
  return session;
} }));
vi.mock("@/lib/voice/transcribe", async (original) => ({ ...await original<typeof import("@/lib/voice/transcribe")>(), transcribeVoiceAudio: transcribe }));
vi.mock("@/lib/transactions/natural-language-agent", async (original) => ({ ...await original<typeof import("@/lib/transactions/natural-language-agent")>(), parseNaturalLanguageExpenses: parse }));

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) throw new Error("Encrypted voice tests require a local development/test database");
  ({ physicalDb: raw, db } = await import("@/lib/db"));
  ({ loadValidAppSessionUser: loadSession } = await import("@/lib/auth/app-sessions"));
});
beforeEach(() => {
  vi.clearAllMocks();
  transcribe.mockResolvedValue("午饭35元");
  parse.mockImplementation(async (input: NaturalLanguageRequest) => ({ schemaVersion: input.schemaVersion, outcome: "needs_correction", issues: [{ code: "unclear_expense", start: 0, end: input.text.length }] }));
});
afterEach(async () => {
  sessionId = null;
  await raw.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await raw.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  vi.restoreAllMocks();
});
afterAll(async () => { await raw.$disconnect(); });

async function fixture() {
  const household = await raw.household.create({ data: { name: "Synthetic encrypted voice" } }); householdIds.push(household.id);
  const user = await raw.user.create({ data: { email: `encrypted-voice-${randomUUID()}@example.com`, displayName: "Synthetic voice", passwordHash: "not-used", aiProcessingEnabled: true, voiceProcessingEnabled: true } }); userIds.push(user.id);
  const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "甲", role: "OWNER" } });
  const session = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 600000) } }); sessionId = session.id;
  const ledger = await raw.ledger.create({ data: { householdId: household.id, name: "PRIVATE_VOICE_LEDGER", isDefault: true } });
  const code = createHouseholdCode(household.id), ring = createKeyRing(code), encoded = encodeHouseholdCode(code);
  const protectedLedger = await encryptRow("ledger", ledger, ring, household.id, "");
  await raw.ledger.update({ where: { id: ledger.id }, data: { name: String(protectedLedger.name), encryptedPayload: String(protectedLedger.encryptedPayload), encryptionRevision: String(protectedLedger.encryptionRevision) } });
  await raw.householdEncryption.create({ data: { householdId: household.id, mode: "ENCRYPTED", revision: 2, generation: code.generation, keyVersion: 1, sealedKeyRing: await sealKeyRing(code, ring) } });
  const category = await raw.category.findFirstOrThrow({ where: { type: "EXPENSE", isActive: true } });
  const history = { id: randomUUID(), householdId: household.id, ledgerId: ledger.id, type: "EXPENSE", categoryId: category.id, actorMemberId: member.id, createdByMemberId: member.id, amountFen: 1234567, occurredAt: new Date(), note: "PRIVATE_HISTORICAL_VOICE_FINANCE", source: null, sourceFingerprint: null, sourceImportedAt: null };
  await raw.transaction.create({ data: await encryptRow("transaction", history, ring, household.id, category.id) as unknown as Prisma.TransactionUncheckedCreateInput });
  const context = { householdId: household.id, memberId: member.id, ledgerId: ledger.id };
  const encryption = { code: encoded, revision: 2 };
  return { household, member, session, context, encryption, ring, history };
}
function multipart(f: Awaited<ReturnType<typeof fixture>>, options: { encryption?: unknown; extra?: boolean } = {}) {
  const form = new FormData();
  form.set("audio", new File([new Uint8Array(wav())], "voice.wav", { type: "audio/wav" }));
  form.set("locale", "zh-CN"); form.set("requestId", randomUUID()); form.set("context", JSON.stringify(f.context));
  if (options.encryption !== null) form.set("__householdEncryption", JSON.stringify(options.encryption ?? f.encryption));
  if (options.extra) form.set("history", "must-not-be-forwarded");
  return new Request("https://billboard.test/api/voice/transcribe", { method: "POST", headers: { origin: "https://billboard.test", host: "billboard.test", "sec-fetch-site": "same-origin" }, body: form });
}
function entry(input: unknown) {
  return new Request("https://billboard.test/api/voice/entry", { method: "POST", headers: { origin: "https://billboard.test", host: "billboard.test", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(input) });
}

it("strips body keys before ASR and AI, encrypts continuation hashes and queries only the original UUID", async () => {
  const f = await fixture();
  const { POST: transcribeRoute } = await import("@/app/api/voice/transcribe/route");
  const response = await transcribeRoute(multipart(f));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const admitted = await response.json();
  expect(admitted).toEqual({ text: "午饭35元", voiceAdmissionId: expect.any(String) });
  expect(transcribe).toHaveBeenCalledExactlyOnceWith(new Uint8Array(wav()), expect.any(AbortSignal));
  const stored = await raw.voiceProcessingAdmission.findUniqueOrThrow({ where: { id: admitted.voiceAdmissionId } });
  expect(stored).toMatchObject({ audioHash: "encrypted", textHash: null, encryptedPayload: expect.stringMatching(/^BBE1\./) });
  expect(JSON.stringify(stored)).not.toContain(createHash("sha256").update(admitted.text).digest("hex"));
  const input = { requestId: stored.clientRequestId, text: admitted.text, voiceAdmissionId: admitted.voiceAdmissionId, locale: "zh-CN", resultVersion: 2, context: f.context, encryption: f.encryption };
  const { POST, GET } = await import("@/app/api/voice/entry/route");
  const submitted = await POST(entry(input));
  expect(submitted.status).toBe(200);
  const result = await submitted.json();
  expect(result).toMatchObject({ requestId: input.requestId, status: "error", code: "NEEDS_CORRECTION" });
  expect(parse).toHaveBeenCalledTimes(1);
  const provider = JSON.stringify(parse.mock.calls);
  expect(provider).not.toContain(f.encryption.code);
  expect(provider).not.toContain(f.ring.keys[0].secret);
  expect(provider).not.toContain(f.history.note);
  expect(provider).not.toContain(String(f.history.amountFen));
  const queried = await POST(entry({ operation: "query", requestId: input.requestId, resultVersion: 2, context: f.context, encryption: f.encryption }));
  expect(queried.status).toBe(200); expect(await queried.json()).toEqual(result);
  expect(parse).toHaveBeenCalledTimes(1);
  const oldGet = await GET(new Request(`https://billboard.test/api/voice/entry?requestId=${input.requestId}&resultVersion=2`, { headers: { host: "billboard.test", "sec-fetch-site": "same-origin", "x-requested-with": "XMLHttpRequest", "x-entry-context": JSON.stringify(f.context) } }));
  expect(oldGet.status).toBe(400);
  expect(await raw.transaction.count({ where: { householdId: f.household.id } })).toBe(1);
  expect(await raw.resourceLease.count({ where: { householdId: f.household.id } })).toBe(0);
  const authorized = await loadSession(f.session.id);
  await runEncryptionContext({ session: authorized!, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 2, ring: structuredClone(f.ring), expiresAt: Date.now() + 60000, disposed: false, readOnly: true }, async () => {
    expect(await db.voiceProcessingAdmission.findUniqueOrThrow({ where: { id: admitted.voiceAdmissionId } })).toMatchObject({ audioHash: createHash("sha256").update(wav()).digest("hex"), consumedAt: expect.any(Date) });
  });
});

it.each(["missing", "wrong", "extra"])("rejects %s encrypted upload material without ASR, continuation or leaked occupancy", async (kind) => {
  const f = await fixture();
  const windowKeys = [`voice:global:global`, `voice:household:${f.household.id}`, `voice:member:${f.member.id}`];
  const before = new Map((await raw.resourceWindow.findMany({ where: { key: { in: windowKeys } }, select: { key: true, used: true, startedAt: true } })).map((row) => [row.key, row]));
  const request = multipart(f, kind === "missing" ? { encryption: null } : kind === "wrong" ? { encryption: { code: encodeHouseholdCode(createHouseholdCode(f.household.id)), revision: 2 } } : { extra: true });
  const { POST } = await import("@/app/api/voice/transcribe/route");
  const response = await POST(request);
  expect(response.ok).toBe(false);
  expect(JSON.stringify(await response.json())).not.toContain(f.encryption.code);
  expect(transcribe).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
  expect(await raw.voiceProcessingAdmission.count({ where: { householdId: f.household.id } })).toBe(0);
  expect(await raw.resourceLease.count({ where: { householdId: f.household.id } })).toBe(0);
  const after = new Map((await raw.resourceWindow.findMany({ where: { key: { in: windowKeys } }, select: { key: true, used: true, startedAt: true } })).map((row) => [row.key, row]));
  for (const key of windowKeys) expect(after.get(key) ?? { key, used: 0, startedAt: new Date(0) }).toEqual(before.get(key) ?? { key, used: 0, startedAt: new Date(0) });
});

it("persists an encrypted NOT_ACCEPTED receipt before a late original submission and never invokes AI for that UUID", async () => {
  const f = await fixture(), requestId = randomUUID();
  const { POST } = await import("@/app/api/voice/entry/route");
  const queried = await POST(entry({ operation: "query", requestId, resultVersion: 2, context: f.context, encryption: f.encryption }));
  expect(queried.status).toBe(200);
  expect(await queried.json()).toEqual({ status: "error", requestId, code: "NOT_ACCEPTED" });
  const receipt = await raw.naturalLanguageRequest.findFirstOrThrow({ where: { householdId: f.household.id, clientRequestId: requestId } });
  expect(receipt).toMatchObject({ status: "FAILED", errorCode: null, encryptedPayload: expect.stringMatching(/^BBE1\./) });
  const late = await POST(entry({ requestId, text: "午饭35元", resultVersion: 2, locale: "zh-CN", context: f.context, encryption: f.encryption }));
  expect(late.status).toBe(200);
  expect(await late.json()).toEqual({ status: "error", requestId, code: "NOT_ACCEPTED" });
  expect(parse).not.toHaveBeenCalled();
  expect(await raw.naturalLanguageRequest.count({ where: { householdId: f.household.id } })).toBe(1);
  expect(await raw.transaction.count({ where: { householdId: f.household.id } })).toBe(1);
});

it("reads a known original receipt during rotation but keeps an absent UUID unknown without writing through the source barrier", async () => {
  const f = await fixture(), requestId = randomUUID();
  const { POST } = await import("@/app/api/voice/entry/route");
  expect(await (await POST(entry({ operation: "query", requestId, resultVersion: 2, context: f.context, encryption: f.encryption }))).json()).toEqual({ status: "error", requestId, code: "NOT_ACCEPTED" });
  const source = parseHouseholdCode(f.encryption.code), candidate = createHouseholdCode(f.household.id, source.generation, 2), ring = createKeyRing(candidate, f.ring);
  const recovery = await exportRecoveryPackage(candidate, ring), session = await loadSession(f.session.id);
  const { prepareEncryption } = await import("@/lib/encryption/service");
  await prepareEncryption(session!, { id: randomUUID(), kind: "ROTATE", expectedRevision: 2, candidateBackedUp: true, candidateKeyRing: await sealKeyRing(candidate, ring), candidateRecoveryPackage: recovery, recoveryDigest: createHash("sha256").update(recovery).digest("hex") });
  const encryption = { ...f.encryption, revision: 3 };
  const known = await POST(entry({ operation: "query", requestId, resultVersion: 2, context: f.context, encryption }));
  expect(known.status).toBe(200); expect(await known.json()).toEqual({ status: "error", requestId, code: "NOT_ACCEPTED" });
  const absent = randomUUID(), missing = await POST(entry({ operation: "query", requestId: absent, resultVersion: 2, context: f.context, encryption }));
  expect(missing.status).toBe(200); expect(await missing.json()).toEqual({ status: "unknown", requestId: absent });
  expect(await raw.naturalLanguageRequest.count({ where: { householdId: f.household.id } })).toBe(1);
  expect(parse).not.toHaveBeenCalled();
});

it("rechecks the original AppSession after encrypted ASR and refuses to bind or return a transcript after revocation", async () => {
  const f = await fixture();
  transcribe.mockImplementationOnce(async () => { await raw.appSession.update({ where: { id: f.session.id }, data: { revokedAt: new Date() } }); return "must-not-return"; });
  const { POST } = await import("@/app/api/voice/transcribe/route");
  const response = await POST(multipart(f));
  expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "unauthorized" });
  const admission = await raw.voiceProcessingAdmission.findFirstOrThrow({ where: { householdId: f.household.id } });
  expect(admission).toMatchObject({ textHash: null, consumedAt: null });
  expect(await raw.resourceLease.count({ where: { householdId: f.household.id } })).toBe(0);
  expect(parse).not.toHaveBeenCalled();
});

it("holds an uncharged multipart upload until oversized-body cancellation has actually finished", async () => {
  const f = await fixture();
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  const cancel = vi.fn(async () => { await stopped; });
  const request = new Request("https://billboard.test/api/voice/transcribe", {
    method: "POST", headers: { host: "billboard.test", origin: "https://billboard.test", "content-type": "multipart/form-data; boundary=synthetic-boundary", "content-length": String(3 * 1024 * 1024) },
    body: new ReadableStream<Uint8Array>({ cancel }), duplex: "half",
  } as RequestInit);
  const { POST } = await import("@/app/api/voice/transcribe/route");
  let settled = false;
  const pending = POST(request).finally(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    const lease = await raw.resourceLease.findFirstOrThrow({ where: { householdId: f.household.id } });
    expect(await raw.resourceExecution.findUniqueOrThrow({ where: { token: lease.token } })).toMatchObject({ chargedAt: null });
    expect(transcribe).not.toHaveBeenCalled();
  } finally { release(); }
  const response = await pending;
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "audio_too_large" });
  expect(await raw.resourceLease.count({ where: { householdId: f.household.id } })).toBe(0);
});
