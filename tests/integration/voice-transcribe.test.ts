import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { wav } from "../fixtures/voice-wav";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});

process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
let loadSession: typeof import("@/lib/auth/app-sessions").loadValidAppSessionUser;
let post: typeof import("@/app/api/voice/transcribe/route").POST;
let readAudio: typeof import("@/lib/voice/audio-store").readVoiceAudioLease;
let sessionId: string | null = null;
let entryContext: { householdId: string; memberId: string; ledgerId: string } | undefined;
vi.mock("@/lib/auth/session", () => ({ requireAppSession: async () => {
  const session = sessionId ? await loadSession(sessionId) : null;
  if (!session) throw new Error("Unauthorized");
  return session;
} }));

const realFetch = globalThis.fetch;
let server: Server;
let endpoint: string;
let providerCalls = 0;
let providerBodies: unknown[] = [];
let providerAudio: Uint8Array[] = [];
let providerQueries = 0;
const submittedTasks = new Map<string, string>();
let reply: () => Promise<{ code?: string; body?: unknown }>;
const householdIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Voice integration tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  ({ loadValidAppSessionUser: loadSession } = await import("@/lib/auth/app-sessions"));
  ({ POST: post } = await import("@/app/api/voice/transcribe/route"));
  ({ readVoiceAudioLease: readAudio } = await import("@/lib/voice/audio-store"));
  server = createServer(async (request, response) => {
    const requested = new URL(request.url ?? "/", "https://billboard.test");
    if (request.method === "GET" && requested.pathname === "/api/voice/audio") {
      const audio = await readAudio(requested.searchParams.get("token") ?? "");
      response.writeHead(audio ? 200 : 404, { "Content-Type": "audio/wav" });
      response.end(audio ? Buffer.from(audio) : undefined);
      return;
    }
    if (!["/api/v3/auc/bigmodel/submit", "/api/v3/auc/bigmodel/query"].includes(requested.pathname)
      || request.headers["x-api-key"] !== "voice-fixture-key" || request.headers["x-api-resource-id"] !== "volc.seedasr.auc") {
      response.writeHead(401).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const taskId = String(request.headers["x-api-request-id"]);
      if (requested.pathname.endsWith("/submit")) {
        providerCalls++;
        providerBodies.push(body);
        const audioUrl = new URL(body.audio.url);
        if (audioUrl.origin !== "https://billboard.test" || body.audio.data || request.headers["x-api-sequence"] !== "-1") {
          response.writeHead(400).end();
          return;
        }
        const download = await realFetch(`${endpoint}${audioUrl.pathname}${audioUrl.search}`);
        if (!download.ok) { response.writeHead(400).end(); return; }
        providerAudio.push(new Uint8Array(await download.arrayBuffer()));
        submittedTasks.set(taskId, audioUrl.searchParams.get("token") ?? "");
        response.writeHead(200, { "X-Api-Status-Code": "20000000" }).end();
        return;
      }
      if (!submittedTasks.has(taskId) || JSON.stringify(body) !== "{}") { response.writeHead(400).end(); return; }
      providerQueries++;
      const result = await reply();
      response.writeHead(200, { "Content-Type": "application/json", "X-Api-Status-Code": result.code ?? "20000000" });
      response.end(JSON.stringify(result.body ?? { result: { text: "午饭35元" } }));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await db.resourceLease.deleteMany({ where: { kind: "voice" } });
  await db.resourceWindow.deleteMany({ where: { kind: "voice" } });
  vi.stubEnv("VOLCENGINE_ASR_API_KEY", "voice-fixture-key");
  vi.stubEnv("VOICE_AUDIO_PUBLIC_ORIGIN", "https://billboard.test");
  providerCalls = 0;
  providerBodies = [];
  providerAudio = [];
  providerQueries = 0;
  submittedTasks.clear();
  sessionId = null;
  entryContext = undefined;
  reply = async () => ({});
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    expect(input).toMatch(/^https:\/\/openspeech\.bytedance\.com\/api\/v3\/auc\/bigmodel\/(submit|query)$/);
    return realFetch(`${endpoint}${new URL(String(input)).pathname}`, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.$disconnect();
});

async function fixture() {
  const household = await db.household.create({ data: { name: "Voice fixture", ledgers: { create: { name: "Default", isDefault: true } } } });
  const user = await db.user.create({ data: { email: `voice-${randomUUID()}@example.com`, displayName: "Voice fixture", passwordHash: "not-used", aiProcessingEnabled: true, voiceProcessingEnabled: true } });
  householdIds.push(household.id);
  userIds.push(user.id);
  const member = await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "甲", role: "MEMBER" } });
  const session = await db.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) } });
  sessionId = session.id;
  const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: household.id, isDefault: true } });
  entryContext = { householdId: household.id, memberId: member.id, ledgerId: ledger.id };
  return { household, user, member, session };
}

function request(options: { headers?: Record<string, string>; body?: Uint8Array | ReadableStream<Uint8Array>; signal?: AbortSignal; url?: string } = {}) {
  return new Request(options.url ?? "https://billboard.test/api/voice/transcribe", {
    method: "POST",
    body: options.body ?? new Uint8Array(wav()),
    headers: { origin: "https://billboard.test", host: "billboard.test", "content-type": "audio/wav", "X-Voice-Request-Id": randomUUID(),
      ...(entryContext ? { "X-Entry-Context": JSON.stringify(entryContext) } : {}), ...options.headers },
    signal: options.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("voice transcription route", () => {
  it("requires an explicit ledger before consuming audio or calling ASR", async () => {
    await fixture();
    const result = await post(request({ headers: { "X-Entry-Context": "" } }));
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "context_required" });
    expect(providerCalls).toBe(0);
  });

  it("returns only the transcript for a valid session without creating accounting state", async () => {
    const current = await fixture();
    const result = await post(request());
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const body = await result.json();
    expect(body).toEqual({ text: "午饭35元", voiceAdmissionId: expect.any(String) });
    expect(await db.voiceProcessingAdmission.findUnique({ where: { id: body.voiceAdmissionId } })).toMatchObject({
      appSessionId: current.session.id, householdId: current.household.id, memberId: current.member.id,
    });
    expect(providerCalls).toBe(1);
    expect(providerQueries).toBe(1);
    expect(Buffer.from(providerAudio[0])).toEqual(wav());
    expect(await readAudio([...submittedTasks.values()][0])).toBeNull();
    expect(JSON.stringify(providerBodies)).not.toContain(current.member.id);
    expect(JSON.stringify(providerBodies)).not.toContain(current.household.id);
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
    expect(await db.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it.each(["missing", "expired", "revoked"])("rejects a %s session before calling ASR", async (kind) => {
    if (kind !== "missing") {
      const current = await fixture();
      await db.appSession.update({ where: { id: current.session.id }, data: kind === "expired" ? { expiresAt: new Date(0) } : { revokedAt: new Date() } });
    }
    const result = await post(request());
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "unauthorized" });
    expect(providerCalls).toBe(0);
  });

  it.each<Record<string, string>>([
    { origin: "https://attacker.test" }, { origin: "null" }, { origin: "" },
    { origin: "http://billboard.test" }, { "sec-fetch-site": "cross-site" },
    { "x-forwarded-host": "attacker.test" },
  ])("rejects cross-origin requests %j", async (headers) => {
    await fixture();
    const result = await post(request({ headers }));
    expect(result.status).toBe(403);
    expect(providerCalls).toBe(0);
  });

  it("accepts a consistent HTTPS forwarded origin", async () => {
    await fixture();
    const result = await post(request({ url: "http://localhost:3000/api/voice/transcribe", headers: {
      "x-forwarded-host": "billboard.test", "x-forwarded-proto": "https",
    } }));
    expect(result.status).toBe(200);
  });

  it.each([
    { headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"url":"https://attacker.test/audio"}') },
    { headers: { "content-type": "audio/wav" }, body: new TextEncoder().encode("C:/private/audio.wav") },
    { headers: { "content-type": "audio/wav" }, body: new TextEncoder().encode("not a WAV file") },
    { url: "https://billboard.test/api/voice/transcribe?householdId=other&memberId=other" },
  ])("rejects malformed or identity-bearing input without ASR", async (input) => {
    await fixture();
    const result = await post(request(input));
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "invalid_audio" });
    expect(providerCalls).toBe(0);
  });

  it("limits actual streaming upload bytes and cancels the oversized reader", async () => {
    await fixture();
    const cancel = vi.fn();
    const result = await post(request({ headers: { "content-length": "44" }, body: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel,
    }) }));
    expect(result.status).toBe(413);
    expect(await result.json()).toEqual({ error: "audio_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(providerCalls).toBe(0);
  });

  it("does not return transcription after session revocation during ASR", async () => {
    const current = await fixture();
    reply = async () => {
      await db.appSession.update({ where: { id: current.session.id }, data: { revokedAt: new Date() } });
      return {};
    };
    const result = await post(request());
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "unauthorized" });
    expect(providerCalls).toBe(1);
    expect(await readAudio([...submittedTasks.values()][0])).toBeNull();
  });

  it("rejects concurrent calls even with forged member headers and releases occupancy afterwards", async () => {
    await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    reply = async () => { await gate; return {}; };
    const first = post(request());
    try {
      await vi.waitFor(() => expect(providerCalls).toBe(1));
      const second = await post(request({ headers: { "x-member-id": "other", "x-household-id": "other" } }));
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: "rate_limited" });
    } finally { release(); }
    expect((await first).status).toBe(200);
    expect((await post(request())).status).toBe(200);
  });

  it("polls the submitted task until processing finishes while its audio lease stays available", async () => {
    await fixture();
    reply = async () => {
      const audio = await readAudio([...submittedTasks.values()][0]);
      expect(Buffer.from(audio!)).toEqual(wav());
      return providerQueries === 1 ? { code: "20000001", body: {} } : {};
    };
    const result = await post(request());
    expect(result.status).toBe(200);
    expect(providerCalls).toBe(1);
    expect(providerQueries).toBe(2);
    expect(await readAudio([...submittedTasks.values()][0])).toBeNull();
  });

  it("limits repeated calls by the authenticated member", async () => {
    await fixture();
    for (let count = 0; count < 6; count++) expect((await post(request())).status).toBe(200);
    const result = await post(request());
    expect(result.status).toBe(429);
    expect(providerCalls).toBe(6);
    await fixture();
    expect((await post(request())).status).toBe(200);
  });

  it("cancels a request in ASR without returning text or retaining occupancy", async () => {
    await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    reply = async () => { await gate; return {}; };
    const controller = new AbortController();
    const pending = post(request({ signal: controller.signal }));
    try {
      await vi.waitFor(() => expect(providerCalls).toBe(1));
      controller.abort();
      const result = await pending;
      expect(result.status).toBe(499);
      expect(await result.json()).toEqual({ error: "cancelled" });
      expect(await readAudio([...submittedTasks.values()][0])).toBeNull();
    } finally { release(); }
    reply = async () => ({});
    expect((await post(request())).status).toBe(200);
  });

  it("holds the shared voice lease until a cancelled audio write and private-file cleanup actually finish", async () => {
    await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let releaseWrite!: () => void;
    let releaseCleanup!: () => void;
    let opened!: () => void;
    let removing!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const writeStarted = new Promise<void>((resolve) => { opened = resolve; });
    const cleanupStarted = new Promise<void>((resolve) => { removing = resolve; });
    let filename: Parameters<typeof fs.open>[0] | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      filename = args[0];
      const handle = await actual.open(...args);
      opened();
      await writeGate;
      return handle;
    });
    vi.mocked(fs.unlink).mockImplementationOnce(async (...args) => {
      removing();
      await cleanupGate;
      return actual.unlink(...args);
    });
    const controller = new AbortController();
    let settled = false;
    const pending = post(request({ signal: controller.signal })).then((response) => { settled = true; return response; });
    try {
      await writeStarted;
      controller.abort();
      expect(await db.resourceLease.count({ where: { kind: "voice" } })).toBe(1);
      expect(settled).toBe(false);
      expect((await post(request())).status).toBe(429);
      expect(providerCalls).toBe(0);
      releaseWrite();
      await cleanupStarted;
      expect(await db.resourceLease.count({ where: { kind: "voice" } })).toBe(1);
      expect(settled).toBe(false);
      expect(providerCalls).toBe(0);
      releaseCleanup();
      const response = await pending;
      expect(response.status).toBe(499);
      expect(await response.json()).toEqual({ error: "cancelled" });
      expect(await db.resourceLease.count({ where: { kind: "voice" } })).toBe(0);
      expect(providerCalls).toBe(0);
      await expect(fs.stat(filename!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseWrite();
      releaseCleanup();
      await pending;
      vi.mocked(fs.open).mockImplementation(actual.open);
      vi.mocked(fs.unlink).mockImplementation(actual.unlink);
    }
  });

  it("maps provider silence and errors without exposing response details", async () => {
    await fixture();
    reply = async () => ({ code: "20000003", body: { message: "private provider details", result: { text: "must not escape" } } });
    const result = await post(request());
    expect(result.status).toBe(422);
    expect(await result.json()).toEqual({ error: "no_speech" });
    expect(await readAudio([...submittedTasks.values()][0])).toBeNull();
  });
});
