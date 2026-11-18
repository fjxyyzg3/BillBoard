import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSessionUser, AppSessionUser } from "@/lib/auth/app-sessions";
import type { ResourceLease } from "@/lib/resources/admission";

process.loadEnvFile(".env.example");
const { accountSession } = vi.hoisted(() => ({ accountSession: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAccountSession: accountSession }));

let db: typeof import("@/lib/db").db;
let preferences: typeof import("@/lib/processing/preferences");
let admission: typeof import("@/lib/resources/admission");
let shared: typeof import("@/lib/identity/shared");
let resolveContext: typeof import("@/lib/auth/household-context").resolveHouseholdContext;
let api: typeof import("@/app/api/account/processing/route");
const householdIds: string[] = [];
const userIds: string[] = [];
const origin = "https://app.example.com";

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Processing preference tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  preferences = await import("@/lib/processing/preferences");
  admission = await import("@/lib/resources/admission");
  shared = await import("@/lib/identity/shared");
  ({ resolveHouseholdContext: resolveContext } = await import("@/lib/auth/household-context"));
  api = await import("@/app/api/account/processing/route");
});

beforeEach(async () => {
  accountSession.mockReset();
  // Integration suites run serially against the isolated development/test database.
  await db.resourceLease.deleteMany();
  await db.resourceWindow.deleteMany();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.resourceLease.deleteMany({ where: { householdId: { in: householdIds } } });
  await db.resourceWindow.deleteMany();
  await db.identityAuditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await db.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});
afterAll(async () => { await db?.$disconnect(); });

async function fixture(options: { householdId?: string; withoutHousehold?: boolean } = {}) {
  let householdId = options.householdId;
  if (!options.withoutHousehold && !householdId) {
    const household = await db.household.create({ data: { name: "Processing preferences fixture" } });
    householdId = household.id;
    householdIds.push(householdId);
    await db.ledger.create({ data: { householdId, name: "Default", isDefault: true } });
  }
  const user = await db.user.create({ data: {
    email: `processing-${randomUUID()}@example.com`, displayName: "Preference owner", passwordHash: "synthetic-unused-hash",
  } });
  userIds.push(user.id);
  const member = householdId ? await db.householdMember.create({ data: {
    userId: user.id, householdId, memberName: randomUUID(), role: options.householdId ? "MEMBER" : "OWNER",
  } }) : null;
  const appSession = await db.appSession.create({ data: {
    userId: user.id, memberId: member?.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000),
  } });
  const session: AccountSessionUser = {
    id: user.id, email: user.email, name: user.displayName, appSessionId: appSession.id,
    ...(member ? { householdId: member.householdId, memberId: member.id, role: member.role } : {}),
  };
  return { user, member, appSession, session };
}

function householdSession(current: Awaited<ReturnType<typeof fixture>>): AppSessionUser {
  if (!current.member) throw new Error("A household fixture is required");
  return { ...current.session, householdId: current.member.householdId, memberId: current.member.id, role: current.member.role };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(await Promise.race([
      promise.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("waiting"), 150); }),
    ])).toBe("waiting");
  } finally { clearTimeout(timer); }
}

function post(value: unknown, options: { headers?: Record<string, string | null | undefined>; body?: BodyInit | null; url?: string; signal?: AbortSignal } = {}) {
  const headers = new Headers({ origin, "content-type": "application/json" });
  for (const [key, entry] of Object.entries(options.headers ?? {})) {
    if (entry === undefined) continue;
    if (entry === null) headers.delete(key); else headers.set(key, entry);
  }
  const body = options.body !== undefined ? options.body : JSON.stringify(value);
  const init: RequestInit & { duplex?: "half" } = { method: "POST", headers, body, signal: options.signal };
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request(options.url ?? `${origin}/api/account/processing`, init);
}

async function finalTaskResult(session: AppSessionUser, lease: ResourceLease, requestId: string) {
  return db.$transaction(async (tx) => {
    await resolveContext(tx, session, { lock: true });
    await admission.assertResourceLease(tx, lease);
    return tx.naturalLanguageRequest.update({ where: { id: requestId }, data: { status: "SUCCEEDED", result: { completed: true } } });
  });
}

describe("account-scoped processing choices", () => {
  it("starts with neither capability enabled and returns only the authenticated person's choices and safe service metadata", async () => {
    const current = await fixture();
    const outside = await fixture();
    await preferences.setProcessingPreferences(outside.session, { ai: true, voice: true });
    const value = await preferences.getProcessingPreferences(current.session);
    expect(value).toEqual({ ai: false, voice: false, services: preferences.processingServices() });
    expect(Object.keys(value).sort()).toEqual(["ai", "services", "voice"]);
    const serialized = JSON.stringify(value);
    for (const privateValue of [current.user.id, current.user.email, current.user.passwordHash, outside.user.id, outside.user.email]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("allows an account without a household to select each capability independently", async () => {
    const current = await fixture({ withoutHousehold: true });
    expect(await preferences.setProcessingPreferences(current.session, { ai: true, voice: false })).toMatchObject({ ai: true, voice: false });
    expect(await preferences.setProcessingPreferences(current.session, { ai: false, voice: true })).toMatchObject({ ai: false, voice: true });
    expect(await preferences.getProcessingPreferences(current.session)).toMatchObject({ ai: false, voice: true });
    expect(await db.householdMember.count({ where: { userId: current.user.id } })).toBe(0);
  });

  it("shares the person's latest choices across devices without changing another household member", async () => {
    const current = await fixture();
    const partner = await fixture({ householdId: current.member!.householdId });
    const secondSession = await db.appSession.create({ data: {
      userId: current.user.id, memberId: current.member!.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
    } });
    const secondDevice = { ...current.session, appSessionId: secondSession.id };
    await preferences.setProcessingPreferences(current.session, { ai: true, voice: false });
    expect(await preferences.getProcessingPreferences(secondDevice)).toMatchObject({ ai: true, voice: false });
    await preferences.setProcessingPreferences(secondDevice, { ai: false, voice: true });
    expect(await preferences.getProcessingPreferences(current.session)).toMatchObject({ ai: false, voice: true });
    expect(await preferences.getProcessingPreferences(partner.session)).toMatchObject({ ai: false, voice: false });
  });

  it("does not let an owner select another person's account or read a forged account session", async () => {
    const owner = await fixture();
    const partner = await fixture({ householdId: owner.member!.householdId });
    const outside = await fixture();
    await expect(preferences.setProcessingPreferences(owner.session, { ai: true, voice: true, userId: partner.user.id })).rejects.toThrow();
    for (const target of [partner, outside]) {
      const forged = { ...owner.session, id: target.user.id };
      await expect(preferences.getProcessingPreferences(forged)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(preferences.setProcessingPreferences(forged, { ai: true, voice: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(await preferences.getProcessingPreferences(target.session)).toMatchObject({ ai: false, voice: false });
    }
    expect(await preferences.getProcessingPreferences(owner.session)).toMatchObject({ ai: false, voice: false });
  });

  it.each([null, {}, { ai: true }, { ai: "true", voice: false }, { ai: false, voice: 1 }, { ai: true, voice: false, householdId: "forged" }])(
    "rejects malformed choices %j without changing the account",
    async (input) => {
      const current = await fixture();
      await expect(preferences.setProcessingPreferences(current.session, input)).rejects.toThrow();
      expect(await preferences.getProcessingPreferences(current.session)).toMatchObject({ ai: false, voice: false });
      expect(await db.identityAuditLog.count({ where: { actorUserId: current.user.id } })).toBe(0);
    },
  );

  it("records only changed capabilities in minimal account audits and does not audit identical saves", async () => {
    const current = await fixture();
    await preferences.setProcessingPreferences(current.session, { ai: false, voice: false });
    expect(await db.identityAuditLog.count({ where: { actorUserId: current.user.id } })).toBe(0);
    await preferences.setProcessingPreferences(current.session, { ai: true, voice: false });
    await preferences.setProcessingPreferences(current.session, { ai: true, voice: true });
    await preferences.setProcessingPreferences(current.session, { ai: true, voice: true });
    await preferences.setProcessingPreferences(current.session, { ai: false, voice: true });
    const audits = await db.identityAuditLog.findMany({ where: { actorUserId: current.user.id } });
    expect(audits.map(({ action }) => action).sort()).toEqual(["AI_PROCESSING_DISABLED", "AI_PROCESSING_ENABLED", "VOICE_PROCESSING_ENABLED"]);
    for (const entry of audits) {
      expect(entry).toMatchObject({ actorUserId: current.user.id, targetId: current.user.id, actorMemberId: null, householdId: null });
      expect(Object.keys(entry).sort()).toEqual(["action", "actorMemberId", "actorUserId", "createdAt", "householdId", "id", "targetId"]);
      expect(JSON.stringify(entry)).not.toContain(current.user.email);
      expect(JSON.stringify(entry)).not.toContain(current.user.passwordHash);
    }
  });

  it.each(["revoked", "expired", "locked", "deactivated", "left", "closed"] as const)(
    "does not read or change choices through a %s identity",
    async (state) => {
      const current = await fixture();
      if (state === "revoked") await db.appSession.update({ where: { id: current.appSession.id }, data: { revokedAt: new Date() } });
      if (state === "expired") await db.appSession.update({ where: { id: current.appSession.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
      if (state === "locked" || state === "deactivated") await db.user.update({ where: { id: current.user.id }, data: { status: state === "locked" ? "LOCKED" : "DEACTIVATED" } });
      if (state === "left") await db.householdMember.update({ where: { id: current.member!.id }, data: { leftAt: new Date() } });
      if (state === "closed") await db.household.update({ where: { id: current.member!.householdId }, data: { closedAt: new Date() } });
      await expect(preferences.getProcessingPreferences(current.session)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(preferences.setProcessingPreferences(current.session, { ai: true, voice: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).toMatchObject({ aiProcessingEnabled: false, voiceProcessingEnabled: false });
    },
  );

  it("requires AI for text and both choices for speech without treating an old page as consent", async () => {
    const current = await fixture();
    const session = householdSession(current);
    const requireConsent = (voice = false) => db.$transaction((tx) => preferences.requireProcessingConsent(tx, session, { ai: true, ...(voice ? { voice: true } : {}) }));
    await expect(requireConsent()).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    await preferences.setProcessingPreferences(current.session, { ai: true, voice: false });
    await expect(requireConsent()).resolves.toBeUndefined();
    await expect(requireConsent(true)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    await preferences.setProcessingPreferences(current.session, { ai: false, voice: true });
    await expect(requireConsent()).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    await expect(requireConsent(true)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    await preferences.setProcessingPreferences(current.session, { ai: true, voice: true });
    await expect(requireConsent(true)).resolves.toBeUndefined();
  });
});

describe("preference changes ordered against resource admission", () => {
  it("rejects new work without charging a lease when the actual preference change wins the household lock", async () => {
    const current = await fixture();
    const session = householdSession(current);
    await preferences.setProcessingPreferences(current.session, { ai: true, voice: true });
    const locked = deferred();
    const finish = deferred();
    const lockAccount = shared.requireLockedAccount;
    // The real authorization and database locks run unchanged; only their scheduling is controlled.
    vi.spyOn(shared, "requireLockedAccount").mockImplementationOnce(async (...args) => {
      const user = await lockAccount(...args);
      locked.resolve();
      await finish.promise;
      return user;
    });
    const closing = preferences.setProcessingPreferences(current.session, { ai: false, voice: false });
    await locked.promise;
    let ran = false;
    const accepting = admission.withResourceLease(session, "ai", async () => { ran = true; }, {
      admit: async (tx) => { await preferences.requireProcessingConsent(tx, session, { ai: true }); },
    });
    const outcome = accepting.then(() => ({ accepted: true, error: null }), (error: Error) => ({ accepted: false, error }));
    try {
      await expectPending(outcome);
      expect(await db.resourceLease.count()).toBe(0);
    } finally { finish.resolve(); }
    await closing;
    expect(await outcome).toMatchObject({ accepted: false, error: { code: "CONSENT_REQUIRED" } });
    expect(ran).toBe(false);
    expect(await db.resourceLease.count()).toBe(0);
    expect(await db.resourceWindow.count()).toBe(0);
  });

  it("completes only the original admitted task after closing choices and does not charge rejected new work", async () => {
    const current = await fixture();
    const session = householdSession(current);
    await preferences.setProcessingPreferences(current.session, { ai: true, voice: true });
    const admitted = deferred();
    const commit = deferred();
    const began = deferred();
    const finish = deferred();
    const clientRequestId = randomUUID();
    let requestId = "";
    const pending = admission.withResourceLease(session, "ai", async (lease) => {
      began.resolve();
      await finish.promise;
      return finalTaskResult(session, lease, requestId);
    }, { admit: async (tx, lease) => {
      await preferences.requireProcessingConsent(tx, session, { ai: true });
      const context = await resolveContext(tx, session, { lock: true });
      const request = await tx.naturalLanguageRequest.create({ data: {
        householdId: context.householdId, ledgerId: context.ledgerId, createdByMemberId: context.memberId,
        clientRequestId, inputHash: "1".repeat(64), status: "PROCESSING", leaseExpiresAt: lease.expiresAt,
      } });
      requestId = request.id;
      admitted.resolve();
      await commit.promise;
    } });
    const result = pending.then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
    await admitted.promise;
    const closing = preferences.setProcessingPreferences(current.session, { ai: false, voice: false });
    try { await expectPending(closing); }
    finally { commit.resolve(); }
    try {
      await began.promise;
      await closing;
      expect(await preferences.getProcessingPreferences(current.session)).toMatchObject({ ai: false, voice: false });
      expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: "PROCESSING", clientRequestId });
      expect(await db.resourceLease.count()).toBe(1);
    } finally { finish.resolve(); }
    expect(await result).toMatchObject({ error: null, value: { status: "SUCCEEDED", clientRequestId, inputHash: "1".repeat(64), result: { completed: true } } });
    await expect(admission.withResourceLease(session, "ai", async () => "must not run", {
      admit: async (tx) => { await preferences.requireProcessingConsent(tx, session, { ai: true }); },
    })).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(await db.naturalLanguageRequest.count({ where: { householdId: session.householdId, clientRequestId } })).toBe(1);
    expect(await db.resourceWindow.findUniqueOrThrow({ where: { key: `ai:member:${session.memberId}` } })).toMatchObject({ used: 1 });
    expect(await db.resourceLease.count()).toBe(0);
  });

  it.each(["revoked-session", "expired-lease"] as const)("does not let a formerly admitted task finish through a %s", async (condition) => {
    const current = await fixture();
    const session = householdSession(current);
    await preferences.setProcessingPreferences(current.session, { ai: true, voice: true });
    const began = deferred();
    const finish = deferred();
    let acceptedLease: ResourceLease | undefined;
    let requestId = "";
    const pending = admission.withResourceLease(session, "ai", async (lease) => {
      acceptedLease = lease;
      began.resolve();
      await finish.promise;
      return finalTaskResult(session, lease, requestId);
    }, { admit: async (tx, lease) => {
      await preferences.requireProcessingConsent(tx, session, { ai: true });
      const context = await resolveContext(tx, session, { lock: true });
      const request = await tx.naturalLanguageRequest.create({ data: {
        householdId: context.householdId, ledgerId: context.ledgerId, createdByMemberId: context.memberId,
        clientRequestId: randomUUID(), status: "PROCESSING", leaseExpiresAt: lease.expiresAt,
      } });
      requestId = request.id;
    } });
    const result = pending.catch((error: Error) => error);
    try {
      await began.promise;
      await preferences.setProcessingPreferences(current.session, { ai: false, voice: false });
      if (condition === "revoked-session") await db.appSession.update({ where: { id: current.appSession.id }, data: { revokedAt: new Date() } });
      else await db.$executeRaw`UPDATE "ResourceLease" SET expires_at=clock_timestamp() - interval '1 second' WHERE token=${acceptedLease!.token}`;
    } finally { finish.resolve(); }
    expect(await result).toMatchObject(condition === "revoked-session" ? { message: "Unauthorized" } : { code: "EXPIRED" });
    expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: "PROCESSING", result: null });
    expect(await db.resourceLease.count()).toBe(0);
  });
});

describe("processing preference HTTP boundaries with real account rows", () => {
  it("supports no-store reads and strict saves without returning account identifiers", async () => {
    const current = await fixture({ withoutHousehold: true });
    accountSession.mockResolvedValue(current.session);
    const read = await api.GET(new Request(`${origin}/api/account/processing`));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await read.json()).toEqual({ ai: false, voice: false, services: preferences.processingServices() });
    const saved = await api.POST(post({ ai: true, voice: false }));
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(await saved.json()).toEqual({ ai: true, voice: false, services: preferences.processingServices() });
    expect(await preferences.getProcessingPreferences(current.session)).toMatchObject({ ai: true, voice: false });
  });

  it.each([
    { origin: null }, { origin: "https://other.example.com" }, { "sec-fetch-site": "cross-site" },
    { "x-forwarded-host": "other.example.com" }, { "x-forwarded-proto": "http" },
  ])("rejects cross-origin or inconsistent proxy headers %j before any preference change", async (headers) => {
    const current = await fixture();
    accountSession.mockResolvedValue(current.session);
    const response = await api.POST(post({ ai: true, voice: true }, { headers }));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await preferences.getProcessingPreferences(current.session)).toMatchObject({ ai: false, voice: false });
  });

  it("accepts a consistent HTTPS forwarding origin without exposing forwarding details", async () => {
    const current = await fixture();
    accountSession.mockResolvedValue(current.session);
    const response = await api.POST(post({ ai: false, voice: true }, { url: "http://127.0.0.1:3000/api/account/processing", headers: {
      host: "app.example.com", "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https", "sec-fetch-site": "same-origin",
    } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ai: false, voice: true, services: preferences.processingServices() });
  });

  it("rejects forged target fields, query targets, malformed JSON and a body exceeding the actual byte limit", async () => {
    const current = await fixture();
    const outside = await fixture();
    accountSession.mockResolvedValue(current.session);
    const extra = await api.POST(post({ ai: true, voice: true, userId: outside.user.id }));
    expect(extra.status).toBe(400);
    const wrongType = await api.POST(post({ ai: true, voice: true }, { headers: { "content-type": "text/plain" } }));
    expect(wrongType.status).toBe(400);
    const malformed = await api.POST(post(null, { body: "{" }));
    expect(malformed.status).toBe(400);
    const oversized = await api.POST(post(null, { body: "x".repeat(1025), headers: { "content-length": "1" } }));
    expect(oversized.status).toBe(413);
    const readQuery = await api.GET(new Request(`${origin}/api/account/processing?userId=${outside.user.id}`));
    expect(readQuery.status).toBe(400);
    const writeQuery = await api.POST(post({ ai: true, voice: true }, { url: `${origin}/api/account/processing?userId=${outside.user.id}` }));
    expect(writeQuery.status).toBe(403);
    for (const person of [current, outside]) expect(await preferences.getProcessingPreferences(person.session)).toMatchObject({ ai: false, voice: false });
  });

  it("requires valid account authentication for either operation and hides unexpected authentication details", async () => {
    accountSession.mockRejectedValueOnce(new Error("Unauthorized"));
    const read = await api.GET(new Request(`${origin}/api/account/processing`));
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: "unauthorized" });
    accountSession.mockRejectedValueOnce(new Error("Unauthorized"));
    const saved = await api.POST(post({ ai: true, voice: true }));
    expect(saved.status).toBe(401);
    accountSession.mockRejectedValueOnce(new Error("synthetic-private-auth-detail"));
    const unexpected = await api.GET(new Request(`${origin}/api/account/processing`));
    expect(await unexpected.json()).toEqual({ error: "unauthorized" });
  });

  it("returns unauthorized if the real session is revoked after the outer authentication read", async () => {
    const current = await fixture();
    accountSession.mockResolvedValue(current.session);
    await db.appSession.update({ where: { id: current.appSession.id }, data: { revokedAt: new Date() } });
    const read = await api.GET(new Request(`${origin}/api/account/processing`));
    expect(read.status).toBe(401);
    const saved = await api.POST(post({ ai: true, voice: true }));
    expect(saved.status).toBe(401);
    expect(await saved.json()).toEqual({ error: "unauthorized" });
    expect(await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).toMatchObject({ aiProcessingEnabled: false, voiceProcessingEnabled: false });
  });

  it("rejects a timed-out body even if the received prefix is complete valid JSON", async () => {
    const current = await fixture();
    accountSession.mockResolvedValue(current.session);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ai: true, voice: true }))); },
      cancel() { cancelled = true; },
    });
    const response = await api.POST(post(null, { body }));
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "timeout" });
    expect(cancelled).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await db.user.findUniqueOrThrow({ where: { id: current.user.id } })).toMatchObject({ aiProcessingEnabled: false, voiceProcessingEnabled: false });
    expect(await db.identityAuditLog.count({ where: { actorUserId: current.user.id } })).toBe(0);
  }, 10_000);

  it("does not save a complete body from a request that was already cancelled", async () => {
    const current = await fixture();
    accountSession.mockResolvedValue(current.session);
    const controller = new AbortController();
    controller.abort();
    const response = await api.POST(post({ ai: true, voice: true }, { signal: controller.signal }));
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "cancelled" });
    expect(await preferences.getProcessingPreferences(current.session)).toMatchObject({ ai: false, voice: false });
    expect(await db.identityAuditLog.count({ where: { actorUserId: current.user.id } })).toBe(0);
  });

  it("cancels an in-progress stream without interpreting its complete JSON prefix as a save", async () => {
    const current = await fixture();
    accountSession.mockResolvedValue(current.session);
    const reading = deferred();
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify({ ai: true, voice: true }))); },
      pull() { reading.resolve(); },
      cancel() { cancelled = true; },
    });
    const pending = api.POST(post(null, { body, signal: controller.signal }));
    await reading.promise;
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "cancelled" });
    expect(cancelled).toBe(true);
    expect(await preferences.getProcessingPreferences(current.session)).toMatchObject({ ai: false, voice: false });
    expect(await db.identityAuditLog.count({ where: { actorUserId: current.user.id } })).toBe(0);
  });

  it("rolls back a cancelled save that was waiting for its authenticated account transaction", async () => {
    const current = await fixture();
    accountSession.mockResolvedValue(current.session);
    const locked = deferred();
    const finish = deferred();
    const lockAccount = shared.requireLockedAccount;
    vi.spyOn(shared, "requireLockedAccount").mockImplementationOnce(async (...args) => {
      const user = await lockAccount(...args);
      locked.resolve();
      await finish.promise;
      return user;
    });
    const controller = new AbortController();
    const pending = api.POST(post({ ai: true, voice: true }, { signal: controller.signal }));
    try { await locked.promise; controller.abort(); }
    finally { finish.resolve(); }
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "cancelled" });
    expect(await preferences.getProcessingPreferences(current.session)).toMatchObject({ ai: false, voice: false });
    expect(await db.identityAuditLog.count({ where: { actorUserId: current.user.id } })).toBe(0);
  });
});
