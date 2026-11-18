import { randomUUID } from "node:crypto";
import { CategoryType, HouseholdRole, TransactionType } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NaturalLanguageRequest, NaturalLanguageResponse } from "@/lib/transactions/natural-language-protocol";

process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
let loadSession: typeof import("@/lib/auth/app-sessions").loadValidAppSessionUser;
let sessionId: string | null = null;
const households: string[] = [];
const users: string[] = [];
const categories: string[] = [];
let modelCalls = 0;
let reply: (input: NaturalLanguageRequest) => Promise<NaturalLanguageResponse>;
vi.mock("@/lib/auth/session", () => ({ requireAppSession: async () => {
  const session = sessionId ? await loadSession(sessionId) : null;
  if (!session) throw new Error("Unauthorized");
  return session;
} }));
vi.mock("@/lib/transactions/natural-language-agent", async (original) => ({
  ...await original<typeof import("@/lib/transactions/natural-language-agent")>(),
  parseNaturalLanguageExpenses: async (input: NaturalLanguageRequest) => {
    modelCalls++;
    return reply(input);
  },
}));

type Route = { POST(request: Request): Promise<Response>; GET(request: Request): Promise<Response> };
async function invoke(method: keyof Route, request: Request) {
  const route = await import("@/app/api/voice/entry/route");
  return route[method](request);
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Voice entry integration tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  ({ loadValidAppSessionUser: loadSession } = await import("@/lib/auth/app-sessions"));
});

beforeEach(async () => {
  await db.resourceLease.deleteMany({ where: { kind: "ai" } });
  await db.resourceWindow.deleteMany({ where: { kind: "ai" } });
  sessionId = null;
  modelCalls = 0;
  reply = async (input) => ({
    schemaVersion: input.schemaVersion, outcome: "needs_correction", issues: [{ code: "unclear_expense", start: 0, end: input.text.length }],
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.appEvent.deleteMany({ where: { householdId: { in: households } } });
  await db.household.deleteMany({ where: { id: { in: households.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  await db.category.deleteMany({ where: { id: { in: categories.splice(0) } } });
});

afterAll(async () => { await db.$disconnect(); });

async function fixture() {
  const suffix = randomUUID();
  const household = await db.household.create({ data: { name: "Voice entry fixture", ledgers: { create: { name: "Default", isDefault: true } } } });
  households.push(household.id);
  const user = await db.user.create({ data: { email: `voice-entry-${suffix}@example.com`, displayName: "甲", passwordHash: "not-used", aiProcessingEnabled: true } });
  users.push(user.id);
  const member = await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "甲", role: HouseholdRole.MEMBER } });
  const category = await db.category.create({ data: { name: `Voice entry fixture ${suffix}`, type: CategoryType.EXPENSE, sortOrder: 999 } });
  categories.push(category.id);
  const session = await db.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) } });
  sessionId = session.id;
  const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: household.id, isDefault: true } });
  const input = { requestId: randomUUID(), text: "午饭35元", locale: "zh-CN", resultVersion: 2,
    context: { householdId: household.id, memberId: member.id, ledgerId: ledger.id } };
  return { household, user, member, category, session, input };
}

function post(input: unknown, options: { headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal; url?: string } = {}) {
  return new Request(options.url ?? "https://billboard.test/api/voice/entry", {
    method: "POST", headers: { host: "billboard.test", origin: "https://billboard.test", "sec-fetch-site": "same-origin", "content-type": "application/json", ...options.headers },
    body: options.body ?? JSON.stringify(input), signal: options.signal, ...("body" in options ? { duplex: "half" } : {}),
  } as RequestInit);
}

function query(requestId: string, options: { headers?: Record<string, string>; query?: string } = {}) {
  return new Request(`https://billboard.test/api/voice/entry?${options.query ?? new URLSearchParams({ requestId, resultVersion: "2" })}`, {
    headers: { host: "billboard.test", "sec-fetch-site": "same-origin", "X-Requested-With": "XMLHttpRequest", ...options.headers },
  });
}

function success(current: Awaited<ReturnType<typeof fixture>>, input: NaturalLanguageRequest): NaturalLanguageResponse {
  return { schemaVersion: input.schemaVersion, outcome: "success", transactions: [{
    type: TransactionType.EXPENSE, start: 0, end: input.text.length, amountFen: 3500, occurredAt: null,
    memberId: input.currentMemberId, categoryId: input.categories.find(({ name }) => name === current.category.name)!.id, note: "午饭",
  }] };
}

describe("voice entry HTTP route", () => {
  it("creates one entry, replays its result and records activity only once", async () => {
    const current = await fixture();
    reply = async (input) => success(current, input);
    const response = await invoke("POST", post(current.input, { headers: { "x-member-id": "other", "x-household-id": "other" } }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ status: "success", requestId: current.input.requestId, resultVersion: 2, count: 1, expenseAmountFen: 3500 });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await (await invoke("POST", post(current.input))).json()).toEqual(result);
    const queried = await invoke("GET", query(current.input.requestId));
    expect(queried.status).toBe(200);
    expect(queried.headers.get("Cache-Control")).toBe("no-store");
    expect(await queried.json()).toEqual(result);
    const records = await db.transaction.findMany({ where: { householdId: current.household.id } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ householdId: current.household.id, actorMemberId: current.member.id, createdByMemberId: current.member.id, amountFen: 3500 });
    expect(await db.appEvent.count({ where: { householdId: current.household.id } })).toBe(1);
    expect(modelCalls).toBe(1);
  });

  it.each(["missing", "expired", "revoked"])("rejects a %s session with fixed JSON before calling the model", async (kind) => {
    const current = await fixture();
    if (kind === "missing") sessionId = null;
    else await db.appSession.update({ where: { id: current.session.id }, data: kind === "expired" ? { expiresAt: new Date(0) } : { revokedAt: new Date() } });
    for (const [method, request] of [["POST", post(current.input)], ["GET", query(current.input.requestId)]] as const) {
      const response = await invoke(method, request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(modelCalls).toBe(0);
  });

  it.each<Record<string, string>>([
    { origin: "https://attacker.test" }, { origin: "null" }, { origin: "" },
    { origin: "http://billboard.test" }, { "sec-fetch-site": "cross-site" },
    { "x-forwarded-host": "attacker.test" }, { "x-forwarded-proto": "https,http" },
  ])("rejects cross-origin submissions %j", async (headers) => {
    const current = await fixture();
    const response = await invoke("POST", post(current.input, { headers }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(modelCalls).toBe(0);
    expect(await db.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it.each<Record<string, string>>([
    { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "none" }, { "X-Requested-With": "" }, { origin: "https://attacker.test" },
    { "x-forwarded-host": "attacker.test" },
  ])("rejects queries without same-origin fetch proof %j", async (headers) => {
    const current = await fixture();
    const response = await invoke("GET", query(current.input.requestId, { headers }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await db.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("accepts consistent forwarded HTTPS and a full 2000-character Chinese transcript", async () => {
    const current = await fixture();
    const response = await invoke("POST", post({ ...current.input, text: "饭".repeat(2000) }, {
      url: "http://localhost:3000/api/voice/entry", headers: { "x-forwarded-host": "billboard.test", "x-forwarded-proto": "https" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "error", code: "NEEDS_CORRECTION" });
    expect(modelCalls).toBe(1);
  });

  it.each<NonNullable<Parameters<typeof post>[1]>>([
    { headers: { "content-type": "text/plain" } }, { headers: { "content-encoding": "gzip" } },
    { headers: { "content-length": "not-a-number" } }, { body: "{" }, { body: "null" },
    { url: "https://billboard.test/api/voice/entry?text=private" },
  ])("rejects malformed uploads before accepting an entry %j", async (options) => {
    const current = await fixture();
    const response = await invoke("POST", post(current.input, options));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(modelCalls).toBe(0);
    expect(await db.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("bounds actual streaming bytes, cancels overflow and rejects an advertised oversized upload", async () => {
    const current = await fixture();
    const cancel = vi.fn();
    const response = await invoke("POST", post(current.input, { headers: { "content-length": "1" }, body: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 + 1)); }, cancel,
    }) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
    const advertised = await invoke("POST", post(current.input, { headers: { "content-length": "16385" } }));
    expect(advertised.status).toBe(413);
    expect(modelCalls).toBe(0);
  });

  it.each(["requestId=invalid&resultVersion=2", "resultVersion=2", "requestId=REQUEST_ID&resultVersion=2&text=private", "requestId=REQUEST_ID&requestId=REQUEST_ID&resultVersion=2"])("rejects invalid query parameters without creating state: %s", async (parameters) => {
    const current = await fixture();
    const response = await invoke("GET", query(current.input.requestId, { query: parameters.replaceAll("REQUEST_ID", current.input.requestId) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(await db.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("keeps incompatible protocol versions unknown without creating request state", async () => {
    const current = await fixture();
    for (const [method, request] of [["POST", post({ ...current.input, resultVersion: 1 })],
      ["GET", query(current.input.requestId, { query: `requestId=${current.input.requestId}&resultVersion=1` })]] as const) {
      const response = await invoke(method, request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "unknown", requestId: current.input.requestId });
    }
    expect(modelCalls).toBe(0);
    expect(await db.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("rejects supplied ownership fields without trusting them", async () => {
    const current = await fixture();
    const response = await invoke("POST", post({ ...current.input, householdId: "other", memberId: "other" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "error", code: "INVALID_REQUEST" });
    expect(modelCalls).toBe(0);
  });

  it("isolates status lookup by the authenticated household and member", async () => {
    const first = await fixture();
    reply = async (input) => success(first, input);
    const saved = await (await invoke("POST", post(first.input))).json();
    const second = await fixture();
    const hidden = await invoke("GET", query(first.input.requestId, { headers: { "X-Entry-Context": JSON.stringify(second.input.context) } }));
    expect(await hidden.json()).toEqual({ status: "error", requestId: first.input.requestId, code: "NOT_ACCEPTED" });
    expect(await db.transaction.count({ where: { householdId: second.household.id } })).toBe(0);
    sessionId = first.session.id;
    expect(await (await invoke("GET", query(first.input.requestId))).json()).toEqual(saved);
    expect(modelCalls).toBe(1);
  });

  it("does not accept an upload cancelled before accounting starts", async () => {
    const current = await fixture();
    const controller = new AbortController();
    controller.abort();
    const response = await invoke("POST", post(current.input, { signal: controller.signal }));
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "cancelled" });
    expect(modelCalls).toBe(0);
    expect(await db.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("rejects a session revoked during inference without writing transactions", async () => {
    const current = await fixture();
    reply = async (input) => {
      await db.appSession.update({ where: { id: current.session.id }, data: { revokedAt: new Date() } });
      return success(current, input);
    };
    const response = await invoke("POST", post(current.input));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });
});
