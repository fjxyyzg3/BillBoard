import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSessionUser } from "@/lib/auth/app-sessions";
import type { ResourceLease } from "@/lib/resources/admission";
import type { EntryContext } from "@/lib/transactions/entry-context";
import { normalizeNaturalLanguageText, type NaturalLanguageRequest } from "@/lib/transactions/natural-language-protocol";
import { wav } from "../fixtures/voice-wav";

if (existsSync(".env")) process.loadEnvFile(".env");
process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
let admit: typeof import("@/lib/processing/voice-admission").admitVoiceRequest;
let bind: typeof import("@/lib/processing/voice-admission").bindVoiceInput;
let preferences: typeof import("@/lib/processing/preferences").setProcessingPreferences;
let createEntry: typeof import("@/lib/transactions/natural-language-entry").createNaturalLanguageEntry;
let queryEntry: typeof import("@/lib/transactions/natural-language-entry").getNaturalLanguageEntry;
let loadSession: typeof import("@/lib/auth/app-sessions").loadValidAppSessionUser;
let release: typeof import("@/lib/resources/admission").releaseResourceLease;
let transcribeRoute: typeof import("@/app/api/voice/transcribe/route").POST;
let voiceProvider: typeof import("@/lib/voice/transcribe");
let routeSessionId: string | null = null;
vi.mock("@/lib/auth/session", () => ({ requireAppSession: async () => {
  const session = routeSessionId ? await loadSession(routeSessionId) : null;
  if (!session) throw new Error("Unauthorized");
  return session;
} }));
let server: Server;
let endpoint: string;
let token: string;
let requests: NaturalLanguageRequest[] = [];
let beforeReply: (input: NaturalLanguageRequest) => Promise<void> = async () => undefined;
const households: string[] = [];
const users: string[] = [];
const leases: ResourceLease[] = [];
const audio = wav();
const transcript = "  甲午饭35元\r\n  ";
const text = normalizeNaturalLanguageText(transcript);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function member(householdId: string, ledgerId: string, name: string, role: "OWNER" | "MEMBER") {
  const user = await db.user.create({ data: { email: `voice-admission-${randomUUID()}@example.test`, displayName: name, passwordHash: "not-used" } });
  users.push(user.id);
  const identity = await db.householdMember.create({ data: { householdId, userId: user.id, memberName: name, role } });
  const appSession = await db.appSession.create({ data: { userId: user.id, memberId: identity.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) } });
  const session = (await loadSession(appSession.id))!;
  const context = { householdId, memberId: identity.id, ledgerId };
  return { session, context };
}

async function fixture() {
  const household = await db.household.create({ data: { name: "Voice admission fixture", ledgers: { create: [{ name: "Default", isDefault: true }, { name: "Voice target" }] } } });
  households.push(household.id);
  const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: household.id, isDefault: false } });
  return member(household.id, ledger.id, "甲", "OWNER");
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function input(current: Fixture, requestId: string, admissionId?: string, overrides: Record<string, unknown> = {}) {
  return { requestId, text, locale: "zh-CN" as const, resultVersion: 2 as const, context: current.context, ...(admissionId ? { voiceAdmissionId: admissionId } : {}), ...overrides };
}

function recheck(session: AppSessionUser) {
  return async () => {
    const current = await loadSession(session.appSessionId);
    if (!current) throw new Error("Unauthorized");
    return current;
  };
}

async function prepare(current: Fixture, closeBeforeTranscript = false) {
  await preferences(current.session, { ai: true, voice: true });
  const requestId = randomUUID();
  const accepted = await admit(current.session, current.context, requestId, audio);
  leases.push(accepted.lease);
  await bind(current.session, accepted.admissionId, audio, accepted.lease);
  if (closeBeforeTranscript) await preferences(current.session, { ai: false, voice: false });
  await bind(current.session, accepted.admissionId, audio, accepted.lease, transcript);
  await release(accepted.lease);
  return { ...accepted, requestId };
}

async function quotaState() {
  return db.resourceWindow.findMany({ where: { kind: { in: ["ai", "voice"] } }, orderBy: { key: "asc" }, select: { key: true, used: true, startedAt: true } });
}

async function noNewWork(current: Fixture, requestId: string) {
  expect(requests).toHaveLength(0);
  expect(await db.naturalLanguageRequest.count({ where: { householdId: current.session.householdId, clientRequestId: requestId } })).toBe(0);
  expect(await db.transaction.count({ where: { householdId: current.session.householdId } })).toBe(0);
  expect(await db.resourceLease.count({ where: { kind: "ai" } })).toBe(0);
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/dev|test/i.test(url.pathname)) throw new Error("Voice admission tests require a local dev/test database");
  ({ db } = await import("@/lib/db"));
  ({ admitVoiceRequest: admit, bindVoiceInput: bind } = await import("@/lib/processing/voice-admission"));
  ({ setProcessingPreferences: preferences } = await import("@/lib/processing/preferences"));
  ({ createNaturalLanguageEntry: createEntry, getNaturalLanguageEntry: queryEntry } = await import("@/lib/transactions/natural-language-entry"));
  ({ loadValidAppSessionUser: loadSession } = await import("@/lib/auth/app-sessions"));
  ({ releaseResourceLease: release } = await import("@/lib/resources/admission"));
  ({ POST: transcribeRoute } = await import("@/app/api/voice/transcribe/route"));
  voiceProvider = await import("@/lib/voice/transcribe");
  token = randomBytes(32).toString("hex");
  server = createServer(async (request, response) => {
    if (request.url !== "/parse-expenses" || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as NaturalLanguageRequest;
      requests.push(value);
      await beforeReply(value);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: value.schemaVersion, outcome: "success", transactions: [{
        type: "EXPENSE", start: 0, end: value.text.length, amountFen: 3500, occurredAt: null,
        memberId: value.currentMemberId, categoryId: value.categories.find((category) => category.name === "Dining" && category.type === "EXPENSE")!.id, note: "午饭",
      }] }));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await db.resourceLease.deleteMany({ where: { kind: { in: ["ai", "voice"] } } });
  await db.resourceWindow.deleteMany({ where: { kind: { in: ["ai", "voice"] } } });
  vi.stubEnv("IMPORT_AGENT_URL", endpoint);
  vi.stubEnv("IMPORT_AGENT_TOKEN", token);
  requests = [];
  routeSessionId = null;
  beforeReply = async () => undefined;
});

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => release(lease)));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.resourceLease.deleteMany({ where: { kind: { in: ["ai", "voice"] } } });
  await db.resourceWindow.deleteMany({ where: { kind: { in: ["ai", "voice"] } } });
  await db.ledgerAuditLog.deleteMany({ where: { householdId: { in: households } } });
  await db.voiceProcessingAdmission.deleteMany({ where: { householdId: { in: households } } });
  await db.naturalLanguageRequest.deleteMany({ where: { householdId: { in: households } } });
  await db.transaction.deleteMany({ where: { householdId: { in: households } } });
  await db.identityAuditLog.deleteMany({ where: { actorUserId: { in: users } } });
  await db.appSession.deleteMany({ where: { userId: { in: users } } });
  await db.householdMember.deleteMany({ where: { householdId: { in: households } } });
  await db.household.deleteMany({ where: { id: { in: households.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db?.$disconnect();
});

describe("bounded voice processing acceptance", () => {
  it("does not grandfather headers or an unfinished audio upload across a later choice closure", async () => {
    const current = await fixture();
    await preferences(current.session, { ai: true, voice: true });
    routeSessionId = current.session.appSessionId;
    const asr = vi.spyOn(voiceProvider, "transcribeVoiceAudio").mockResolvedValue(text);
    let upload!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { upload = controller; } });
    const request = new Request("https://billboard.test/api/voice/transcribe", {
      method: "POST", body, duplex: "half",
      headers: { origin: "https://billboard.test", host: "billboard.test", "content-type": "audio/wav",
        "X-Entry-Context": JSON.stringify(current.context), "X-Voice-Request-Id": randomUUID() },
    } as RequestInit & { duplex: "half" });
    const pending = transcribeRoute(request);
    let settled = false;
    const result = pending.finally(() => { settled = true; });
    try {
      await vi.waitFor(async () => {
        expect(await db.resourceLease.count({ where: { kind: "voice", householdId: current.session.householdId } })).toBe(1);
      }, { timeout: 5_000, interval: 20 });
      const grantsBeforeAudio = await db.voiceProcessingAdmission.count({ where: { householdId: current.session.householdId } });
      expect(settled).toBe(false);
      await preferences(current.session, { ai: false, voice: false });
      upload.enqueue(new Uint8Array(audio));
      upload.close();
      const response = await result;
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "consent_required" });
      expect(grantsBeforeAudio).toBe(0);
      expect(await db.voiceProcessingAdmission.count({ where: { householdId: current.session.householdId } })).toBe(0);
      expect(await db.resourceLease.count({ where: { kind: "voice", householdId: current.session.householdId } })).toBe(0);
      expect(asr).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    } finally {
      try { upload.close(); } catch { /* The request may already have consumed or cancelled its input. */ }
      await result.catch(() => undefined);
    }
  }, 15_000);

  it("does not create an accepted continuation for an invalid completed WAV upload", async () => {
    const current = await fixture();
    await preferences(current.session, { ai: true, voice: true });
    routeSessionId = current.session.appSessionId;
    const asr = vi.spyOn(voiceProvider, "transcribeVoiceAudio").mockResolvedValue(text);
    const response = await transcribeRoute(new Request("https://billboard.test/api/voice/transcribe", {
      method: "POST", body: new Uint8Array([1, 2, 3, 4]),
      headers: { origin: "https://billboard.test", host: "billboard.test", "content-type": "audio/wav",
        "X-Entry-Context": JSON.stringify(current.context), "X-Voice-Request-Id": randomUUID() },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_audio" });
    expect(await db.voiceProcessingAdmission.count({ where: { householdId: current.session.householdId } })).toBe(0);
    expect(await db.resourceLease.count({ where: { kind: "voice", householdId: current.session.householdId } })).toBe(0);
    expect(asr).not.toHaveBeenCalled();
  });

  it.each([{ ai: false, voice: false }, { ai: true, voice: false }, { ai: false, voice: true }])("requires both explicit choices before accepting a new recording: %j", async (choices) => {
    const current = await fixture();
    await preferences(current.session, choices);
    const before = await quotaState();
    await expect(admit(current.session, current.context, randomUUID(), audio)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(await quotaState()).toEqual(before);
    expect(await db.voiceProcessingAdmission.count({ where: { householdId: current.session.householdId } })).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it.each([false, true])("finishes only the accepted original recording after closing both choices (closed before transcript: %s)", async (closeEarly) => {
    const current = await fixture();
    const accepted = await prepare(current, closeEarly);
    await preferences(current.session, { ai: false, voice: false });
    const stored = await db.voiceProcessingAdmission.findUniqueOrThrow({ where: { id: accepted.admissionId } });
    expect(stored).toMatchObject({ audioHash: digest(audio), textHash: digest(text), consumedAt: null });
    expect(Object.keys(stored).sort()).toEqual(["appSessionId", "audioHash", "clientRequestId", "consumedAt", "createdAt", "expiresAt", "householdId", "id", "ledgerId", "memberId", "textHash", "userId"].sort());
    expect(JSON.stringify(stored)).not.toContain(text);
    expect(JSON.stringify(stored)).not.toContain(audio.toString("base64"));
    const result = await createEntry(input(current, accepted.requestId, accepted.admissionId), current.session, recheck(current.session));
    expect(result.result).toMatchObject({ status: "success", requestId: accepted.requestId, count: 1, expenseAmountFen: 3500 });
    expect(result.wasCreated).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].text).toBe(text);
    expect(await db.transaction.count({ where: { householdId: current.session.householdId } })).toBe(1);
    expect((await db.voiceProcessingAdmission.findUniqueOrThrow({ where: { id: accepted.admissionId } })).consumedAt).not.toBeNull();
    const requestRow = await db.naturalLanguageRequest.findFirstOrThrow({ where: { clientRequestId: accepted.requestId, householdId: current.session.householdId } });
    expect(requestRow.inputHash).toBe(digest(text));
    expect(JSON.stringify(requestRow)).not.toContain(text);
    const charged = await quotaState();
    expect(await queryEntry(accepted.requestId, current.session, current.context)).toEqual(result.result);
    expect(await createEntry(input(current, accepted.requestId, accepted.admissionId), current.session, recheck(current.session))).toEqual({ result: result.result, wasCreated: false });
    expect(await createEntry(input(current, accepted.requestId), current.session, recheck(current.session))).toEqual({ result: result.result, wasCreated: false });
    await expect(admit(current.session, current.context, randomUUID(), audio)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    const denied = await createEntry(input(current, randomUUID()), current.session, recheck(current.session));
    expect(denied.result).toMatchObject({ status: "error", code: "CONSENT_REQUIRED" });
    const replay = await createEntry(input(current, randomUUID(), accepted.admissionId), current.session, recheck(current.session));
    expect(replay.result).toMatchObject({ status: "error", code: "CONFLICT" });
    expect(await quotaState()).toEqual(charged);
    expect(requests).toHaveLength(1);
    expect(await db.transaction.count({ where: { householdId: current.session.householdId } })).toBe(1);
    expect(await db.resourceLease.count({ where: { kind: { in: ["ai", "voice"] } } })).toBe(0);
  });

  it.each(["text", "ledger", "member", "household", "session", "uuid"] as const)("cannot turn an accepted recording into a different %s task", async (changed) => {
    const current = await fixture();
    const accepted = await prepare(current);
    await preferences(current.session, { ai: false, voice: false });
    let actor = current;
    let requestId = accepted.requestId;
    let context: EntryContext = current.context;
    if (changed === "member") actor = await member(current.session.householdId, current.context.ledgerId, "乙", "MEMBER");
    if (changed === "household") actor = await fixture();
    if (changed === "session") {
      const next = await db.appSession.create({ data: { userId: current.session.id, memberId: current.session.memberId, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
      actor = { ...current, session: (await loadSession(next.id))! };
    }
    if (changed === "ledger") context = { ...context, ledgerId: (await db.ledger.findFirstOrThrow({ where: { householdId: current.session.householdId, isDefault: true } })).id };
    else context = actor.context;
    if (changed === "uuid") requestId = randomUUID();
    const before = await quotaState();
    const result = await createEntry(input(actor, requestId, accepted.admissionId, { context, ...(changed === "text" ? { text: `${text}，再买一杯水` } : {}) }), actor.session, recheck(actor.session));
    expect(result.result).toMatchObject({ status: "error", code: "CONFLICT" });
    await noNewWork(actor, requestId);
    expect(await quotaState()).toEqual(before);
    expect((await db.voiceProcessingAdmission.findUniqueOrThrow({ where: { id: accepted.admissionId } })).consumedAt).toBeNull();
    expect((await createEntry(input(current, accepted.requestId, accepted.admissionId), current.session, recheck(current.session))).result.status).toBe("success");
    expect(requests).toHaveLength(1);
  });

  it("rejects an expired continuation without consuming or charging a replacement AI task", async () => {
    const current = await fixture();
    const accepted = await prepare(current);
    await preferences(current.session, { ai: false, voice: false });
    await db.voiceProcessingAdmission.update({ where: { id: accepted.admissionId }, data: { expiresAt: new Date(0) } });
    const before = await quotaState();
    expect((await createEntry(input(current, accepted.requestId, accepted.admissionId), current.session, recheck(current.session))).result).toMatchObject({ status: "error", code: "EXPIRED" });
    await noNewWork(current, accepted.requestId);
    expect(await quotaState()).toEqual(before);
  });

  it("admits the same continuation concurrently only once and charges one AI attempt", async () => {
    const current = await fixture();
    const accepted = await prepare(current);
    await preferences(current.session, { ai: false, voice: false });
    let entered!: () => void;
    let finish!: () => void;
    const enteredModel = new Promise<void>((resolve) => { entered = resolve; });
    const finishModel = new Promise<void>((resolve) => { finish = resolve; });
    beforeReply = async () => { entered(); await finishModel; };
    const value = input(current, accepted.requestId, accepted.admissionId);
    const first = createEntry(value, current.session, recheck(current.session));
    try {
      await Promise.race([enteredModel, first.then(() => { throw new Error("The original task ended before reaching the model fixture"); })]);
      expect(await createEntry(value, current.session, recheck(current.session))).toEqual({ result: { status: "processing", requestId: accepted.requestId }, wasCreated: false });
    } finally { finish(); }
    expect((await first).result.status).toBe("success");
    expect((await quotaState()).filter((window) => window.key.startsWith("ai:")).map((window) => window.used)).toEqual([1, 1, 1]);
    expect(requests).toHaveLength(1);
    expect(await db.transaction.count({ where: { householdId: current.session.householdId } })).toBe(1);
  });

  it("requires the exact bound audio and normalized transcript, with an active resource lease", async () => {
    const current = await fixture();
    await preferences(current.session, { ai: true, voice: true });
    const requestId = randomUUID();
    const accepted = await admit(current.session, current.context, requestId, audio);
    leases.push(accepted.lease);
    expect((await db.voiceProcessingAdmission.findUniqueOrThrow({ where: { id: accepted.admissionId } })).audioHash).toBe(digest(audio));
    await bind(current.session, accepted.admissionId, audio, accepted.lease);
    await expect(bind(current.session, accepted.admissionId, wav(16000, 3000), accepted.lease, transcript)).rejects.toMatchObject({ code: "CONFLICT" });
    await preferences(current.session, { ai: false, voice: false });
    expect((await createEntry(input(current, requestId, accepted.admissionId), current.session, recheck(current.session))).result).toMatchObject({ status: "error", code: "CONFLICT" });
    await bind(current.session, accepted.admissionId, audio, accepted.lease, transcript);
    await expect(bind(current.session, accepted.admissionId, audio, accepted.lease, `${transcript}追加正文`)).rejects.toMatchObject({ code: "CONFLICT" });
    await db.resourceLease.update({ where: { token: accepted.lease.token }, data: { expiresAt: new Date(0) } });
    await expect(bind(current.session, accepted.admissionId, audio, accepted.lease, transcript)).rejects.toMatchObject({ code: "EXPIRED" });
    await noNewWork(current, requestId);
  });

  it.each(["revoke", "leave", "deactivate", "close", "archive"] as const)("refuses a late model result after %s despite the original acceptance", async (changed) => {
    const current = await fixture();
    const accepted = await prepare(current);
    await preferences(current.session, { ai: false, voice: false });
    beforeReply = async () => {
      if (changed === "revoke") await db.appSession.update({ where: { id: current.session.appSessionId }, data: { revokedAt: new Date() } });
      if (changed === "leave") await db.householdMember.update({ where: { id: current.session.memberId }, data: { leftAt: new Date() } });
      if (changed === "deactivate") await db.user.update({ where: { id: current.session.id }, data: { status: "DEACTIVATED" } });
      if (changed === "close") await db.household.update({ where: { id: current.session.householdId }, data: { closedAt: new Date() } });
      if (changed === "archive") await db.ledger.update({ where: { id: current.context.ledgerId }, data: { archivedAt: new Date() } });
    };
    const pending = createEntry(input(current, accepted.requestId, accepted.admissionId), current.session, recheck(current.session));
    if (changed === "archive") expect((await pending).result).toMatchObject({ status: "error", code: "STALE" });
    else await expect(pending).rejects.toThrow("Unauthorized");
    expect(requests).toHaveLength(1);
    expect(await db.transaction.count({ where: { householdId: current.session.householdId } })).toBe(0);
    expect(await db.ledgerAuditLog.count({ where: { householdId: current.session.householdId } })).toBe(0);
    expect(await db.resourceLease.count({ where: { kind: { in: ["ai", "voice"] } } })).toBe(0);
  });

  it("returns the original successful terminal result after closing choices and archiving its target", async () => {
    const current = await fixture();
    const accepted = await prepare(current);
    const result = await createEntry(input(current, accepted.requestId, accepted.admissionId), current.session, recheck(current.session));
    expect(result.result.status).toBe("success");
    await preferences(current.session, { ai: false, voice: false });
    await db.ledger.update({ where: { id: current.context.ledgerId }, data: { archivedAt: new Date() } });
    const before = await quotaState();
    expect(await queryEntry(accepted.requestId, current.session, current.context)).toEqual(result.result);
    expect(await createEntry(input(current, accepted.requestId, accepted.admissionId), current.session, recheck(current.session))).toEqual({ result: result.result, wasCreated: false });
    expect(await quotaState()).toEqual(before);
    expect(requests).toHaveLength(1);
    expect(await db.transaction.count({ where: { householdId: current.session.householdId } })).toBe(1);
  });
});
