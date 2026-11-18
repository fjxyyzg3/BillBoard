import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CategoryType, HouseholdRole, NaturalLanguageRequestStatus, TransactionType } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NaturalLanguageRequest } from "@/lib/transactions/natural-language-protocol";
import { normalizeNaturalLanguageText } from "@/lib/transactions/natural-language-protocol";

process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
let createEntry: typeof import("@/lib/transactions/natural-language-entry").createNaturalLanguageEntry;
let queryEntry: typeof import("@/lib/transactions/natural-language-entry").getNaturalLanguageEntry;
let loadSession: typeof import("@/lib/auth/app-sessions").loadValidAppSessionUser;
let submitAction: typeof import("@/app/(app)/add/natural-language-actions").submitNaturalLanguageEntry;
let queryAction: typeof import("@/app/(app)/add/natural-language-actions").queryNaturalLanguageEntry;
let resolveActionSession: () => Promise<import("@/lib/auth/app-sessions").AppSessionUser>;
vi.mock("@/lib/auth/session", () => ({ requireAppSession: () => resolveActionSession() }));
let server: Server;
let endpoint: string;
let token: string;
let requests: NaturalLanguageRequest[] = [];
let reply: (input: NaturalLanguageRequest) => Promise<{ status?: number; body: unknown }> | { status?: number; body: unknown };
const households: string[] = [];
const users: string[] = [];
const categories: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Natural-language integration tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  ({ createNaturalLanguageEntry: createEntry, getNaturalLanguageEntry: queryEntry } = await import("@/lib/transactions/natural-language-entry"));
  ({ loadValidAppSessionUser: loadSession } = await import("@/lib/auth/app-sessions"));
  ({ submitNaturalLanguageEntry: submitAction, queryNaturalLanguageEntry: queryAction } = await import("@/app/(app)/add/natural-language-actions"));
  token = randomBytes(32).toString("hex");
  server = createServer(async (request, response) => {
    if (request.url !== "/parse-expenses" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as NaturalLanguageRequest;
      requests.push(input);
      const result = await reply(input);
      response.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
      response.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await db.resourceLease.deleteMany();
  await db.resourceWindow.deleteMany();
  vi.stubEnv("IMPORT_AGENT_URL", endpoint);
  vi.stubEnv("IMPORT_AGENT_TOKEN", token);
  requests = [];
  reply = (input) => ({ body: {
    schemaVersion: input.schemaVersion, outcome: "needs_correction", issues: [{ code: "unclear_expense", start: 0, end: input.text.length }],
  } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.appEvent.deleteMany({ where: { householdId: { in: households } } });
  await db.household.deleteMany({ where: { id: { in: households.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  await db.category.deleteMany({ where: { id: { in: categories.splice(0) } } });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.$disconnect();
});

async function fixture() {
  const suffix = randomUUID();
  const household = await db.household.create({ data: { name: "Natural language fixture", ledgers: { create: { name: "Default", isDefault: true } } } });
  const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: household.id, isDefault: true } });
  households.push(household.id);
  const members: Array<{ id: string; userId: string; memberName: string }> = [];
  for (const name of ["甲", "乙"]) {
    const user = await db.user.create({ data: { email: `natural-${suffix}-${members.length}@example.com`, displayName: name, passwordHash: "not-used", aiProcessingEnabled: true } });
    users.push(user.id);
    members.push(await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: name, role: HouseholdRole.MEMBER } }));
  }
  const category = await db.category.create({ data: { name: `Natural fixture ${suffix}`, type: CategoryType.EXPENSE, sortOrder: 999 } });
  const incomeCategory = await db.category.create({ data: { name: category.name, type: CategoryType.INCOME, sortOrder: 999 } });
  const refundCategory = await db.category.create({ data: { name: `Refund fixture ${suffix}`, type: CategoryType.INCOME, sortOrder: 999 } });
  categories.push(category.id, incomeCategory.id, refundCategory.id);
  const appSession = await db.appSession.create({ data: { userId: members[0].userId, memberId: members[0].id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) } });
  const session = (await loadSession(appSession.id))!;
  const recheck = async () => {
    const current = await loadSession(appSession.id);
    if (!current) throw new Error("Unauthorized");
    return current;
  };
  const input = { requestId: randomUUID(), text: "甲午饭35元，乙打车22元", locale: "zh-CN" as const, resultVersion: 2 as const,
    context: { householdId: household.id, memberId: session.memberId, ledgerId: ledger.id } };
  return { household, ledger, members, category, incomeCategory, refundCategory, appSession, session, recheck, input };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function success(current: Fixture, input: NaturalLanguageRequest) {
  const categoryId = input.categories.find(({ name, type }) => name === current.category.name && type === CategoryType.EXPENSE)!.id;
  const firstMember = input.members.find(({ displayName }) => displayName === "甲")!.id;
  const secondMember = input.members.find(({ displayName }) => displayName === "乙")!.id;
  const split = input.text.indexOf("，");
  return { schemaVersion: input.schemaVersion, outcome: "success" as const, transactions: [
    { type: TransactionType.EXPENSE, start: 0, end: split, amountFen: 3500, occurredAt: null, memberId: firstMember, categoryId, note: "午饭" },
    { type: TransactionType.EXPENSE, start: split + 1, end: input.text.length, amountFen: 2200, occurredAt: "2026-10-12T00:00", memberId: secondMember, categoryId, note: "打车" },
  ] };
}

function mixedSuccess(current: Fixture, input: NaturalLanguageRequest) {
  const split = input.text.indexOf("，");
  return { schemaVersion: input.schemaVersion, outcome: "success" as const, transactions: [
    { type: TransactionType.INCOME, start: 0, end: split, amountFen: 800000, occurredAt: null,
      memberId: input.members.find(({ displayName }) => displayName === "乙")!.id,
      categoryId: input.categories.find(({ name, type }) => name === current.incomeCategory.name && type === CategoryType.INCOME)!.id, note: "工资" },
    { type: TransactionType.EXPENSE, start: split + 1, end: input.text.length, amountFen: 3500, occurredAt: null,
      memberId: input.currentMemberId, categoryId: input.categories.find(({ name, type }) => name === current.category.name && type === CategoryType.EXPENSE)!.id, note: "午饭" },
  ] };
}

function rowWhere(current: Fixture) {
  return { householdId: current.session.householdId, createdByMemberId: current.session.memberId, clientRequestId: current.input.requestId };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("natural-language entry", () => {
  it("requires explicit AI choice before accepting a new request", async () => {
    const current = await fixture();
    await db.user.update({ where: { id: current.session.id }, data: { aiProcessingEnabled: false } });
    const result = await createEntry(current.input, current.session, current.recheck);
    expect(result.result).toMatchObject({ status: "error", code: "CONSENT_REQUIRED" });
    expect(requests).toHaveLength(0);
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("requires explicit context for a new request and never sends its text to inference", async () => {
    const current = await fixture();
    const { context: _context, ...legacyInput } = current.input;
    expect(await createEntry(legacyInput, current.session, current.recheck)).toEqual({
      result: { status: "error", requestId: current.input.requestId, code: "CONTEXT_REQUIRED" }, wasCreated: false,
    });
    expect(await queryEntry(current.input.requestId, current.session)).toEqual({
      status: "error", requestId: current.input.requestId, code: "CONTEXT_REQUIRED",
    });
    expect(requests).toHaveLength(0);
    expect(await db.naturalLanguageRequest.count({ where: rowWhere(current) })).toBe(0);
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("confirms a legacy UUID after its original target is archived and its records move", async () => {
    const current = await fixture();
    reply = (input) => ({ body: success(current, input) });
    const result = await createEntry(current.input, current.session, current.recheck);
    const state = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    const alternate = await db.ledger.create({ data: { householdId: current.household.id, name: "Moved target" } });
    await db.transaction.updateMany({ where: { householdId: current.household.id }, data: { ledgerId: alternate.id } });
    await db.ledger.update({ where: { id: current.ledger.id }, data: { isDefault: false } });
    await db.ledger.update({ where: { id: alternate.id }, data: { isDefault: true } });
    await db.ledger.update({ where: { id: current.ledger.id }, data: { archivedAt: new Date() } });
    const { context: _context, ...legacyInput } = current.input;

    expect(await createEntry(legacyInput, current.session, current.recheck)).toEqual({ result: result.result, wasCreated: false });
    expect(await queryEntry(current.input.requestId, current.session)).toEqual(result.result);
    expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: state.id } })).toEqual(state);
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(2);
    expect(requests).toHaveLength(1);
  });

  it("pins ledger ownership without rewriting a completed request or rerunning inference", async () => {
    const current = await fixture();
    const alternate = await db.ledger.create({ data: { householdId: current.household.id, name: "Alternate fixture" } });
    const context = { householdId: current.household.id, memberId: current.session.memberId, ledgerId: alternate.id };
    reply = (input) => ({ body: success(current, input) });
    const result = await createEntry({ ...current.input, context }, current.session, current.recheck);
    expect(result.result.status).toBe("success");
    const state = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    expect(state.ledgerId).toBe(alternate.id);
    expect(state.inputHash).toBe(createHash("sha256").update(normalizeNaturalLanguageText(current.input.text)).digest("hex"));
    expect(await db.transaction.count({ where: { householdId: current.household.id, ledgerId: alternate.id } })).toBe(2);
    const audits = await db.ledgerAuditLog.findMany({ where: { householdId: current.household.id } });
    expect(audits).toHaveLength(2);
    for (const audit of audits) expect(audit).toMatchObject({ memberId: current.session.memberId, ledgerId: alternate.id, action: "TRANSACTION_CREATED" });
    await db.ledger.update({ where: { id: alternate.id }, data: { archivedAt: new Date() } });
    expect(await createEntry({ ...current.input, context }, current.session, current.recheck)).toEqual({ result: result.result, wasCreated: false });
    expect(await queryEntry(current.input.requestId, current.session, context)).toEqual(result.result);
    expect((await createEntry({ ...current.input, context: { ...context, ledgerId: current.ledger.id } }, current.session, current.recheck)).result).toMatchObject({ status: "error", code: "CONFLICT" });
    expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: state.id } })).toEqual(state);
    expect(requests).toHaveLength(1);
    expect(await db.ledgerAuditLog.count({ where: { householdId: current.household.id } })).toBe(2);
  });

  it("rejects a departed original identity during inference and never gives its task to a rejoined identity", async () => {
    const current = await fixture();
    reply = async (input) => {
      await db.householdMember.update({ where: { id: current.session.memberId }, data: { leftAt: new Date() } });
      return { body: success(current, input) };
    };
    await expect(createEntry(current.input, current.session, current.recheck)).rejects.toThrow("Unauthorized");
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
    expect(await db.ledgerAuditLog.count({ where: { householdId: current.household.id } })).toBe(0);
    expect(await loadSession(current.appSession.id)).toBeNull();
    const rejoined = await db.householdMember.create({ data: { householdId: current.household.id, userId: current.session.id, memberName: current.members[0].memberName, role: HouseholdRole.MEMBER } });
    await expect(queryEntry(current.input.requestId, current.session, current.input.context)).rejects.toThrow("Unauthorized");
    expect(await queryEntry(current.input.requestId, { id: current.session.id, householdId: current.household.id, memberId: rejoined.id }, { ...current.input.context, memberId: rejoined.id })).toMatchObject({ status: "error", code: "NOT_ACCEPTED" });
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("excludes historical members from new inference candidates", async () => {
    const current = await fixture();
    await db.householdMember.update({ where: { id: current.members[1].id }, data: { leftAt: new Date() } });
    await createEntry(current.input, current.session, current.recheck);
    expect(requests).toHaveLength(1);
    expect(requests[0].members.map(({ displayName }) => displayName)).toEqual([current.members[0].memberName]);
  });

  it("atomically records mixed income and expense with separate totals", async () => {
    const current = await fixture();
    current.input.text = "乙收到工资8000元，甲午饭35元";
    reply = (input) => ({ body: mixedSuccess(current, input) });
    const result = await createEntry(current.input, current.session, current.recheck);
    expect(result.result).toEqual({ status: "success", requestId: current.input.requestId, resultVersion: 2,
      count: 2, incomeCount: 1, expenseCount: 1, incomeAmountFen: 800000, expenseAmountFen: 3500 });
    expect(result.wasCreated).toBe(true);
    const records = await db.transaction.findMany({ where: { householdId: current.household.id, deletedAt: null }, orderBy: { amountFen: "desc" } });
    expect(records).toHaveLength(2);
    expect(records.map(({ type, amountFen, actorMemberId, categoryId }) => [type, amountFen, actorMemberId, categoryId])).toEqual([
      [TransactionType.INCOME, 800000, current.members[1].id, current.incomeCategory.id],
      [TransactionType.EXPENSE, 3500, current.members[0].id, current.category.id],
    ]);
    for (const row of records) expect(row).toMatchObject({ createdByMemberId: current.session.memberId, source: null, sourceFingerprint: null, sourceImportedAt: null });
    const stored = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    expect(stored.result).toEqual({ resultVersion: 2, count: 2, incomeCount: 1, expenseCount: 1, incomeAmountFen: 800000,
      expenseAmountFen: 3500, transactionIds: expect.arrayContaining(records.map(({ id }) => id)) });
    expect(await queryEntry(current.input.requestId, current.session, current.input.context)).toEqual(result.result);
  });

  it("persists and replays one net expense with a concise note and its original payer and date", async () => {
    const current = await fixture();
    current.input.text = "乙昨天电动车充电花了一块钱，退回了 2 毛 8";
    reply = (input) => ({ body: { schemaVersion: input.schemaVersion, outcome: "success", transactions: [
      { type: TransactionType.EXPENSE, start: 0, end: input.text.length, amountFen: 72, occurredAt: "2026-10-12T00:00",
        memberId: input.members.find(({ displayName }) => displayName === "乙")!.id,
        categoryId: input.categories.find(({ name, type }) => name === current.category.name && type === CategoryType.EXPENSE)!.id,
        note: "电动车充电" },
    ] } });
    const result = await createEntry(current.input, current.session, current.recheck);
    expect(result.wasCreated).toBe(true);
    expect(result.result).toEqual({ status: "success", requestId: current.input.requestId, resultVersion: 2,
      count: 1, incomeCount: 0, expenseCount: 1, incomeAmountFen: 0, expenseAmountFen: 72 });
    const records = await db.transaction.findMany({ where: { householdId: current.household.id, deletedAt: null } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: TransactionType.EXPENSE, amountFen: 72, actorMemberId: current.members[1].id,
      createdByMemberId: current.session.memberId, categoryId: current.category.id,
      note: "电动车充电", source: null, sourceFingerprint: null, sourceImportedAt: null });
    expect(records[0].occurredAt.toISOString()).toBe("2026-10-11T16:00:00.000Z");
    expect(await queryEntry(current.input.requestId, current.session, current.input.context)).toEqual(result.result);
    expect(await createEntry(current.input, current.session, current.recheck)).toEqual({ result: result.result, wasCreated: false });
    expect(requests).toHaveLength(1);
    expect(await db.transaction.count({ where: { householdId: current.household.id, deletedAt: null } })).toBe(1);
  });

  it("records a refund as income without changing any original expense", async () => {
    const current = await fixture();
    const original = await db.transaction.create({ data: { householdId: current.household.id, ledgerId: current.ledger.id, actorMemberId: current.members[1].id,
      createdByMemberId: current.members[0].id, categoryId: current.category.id, type: TransactionType.EXPENSE,
      amountFen: 9000, occurredAt: new Date("2026-10-12T00:00:00.000Z"), note: "原购物" } });
    current.input.text = "昨天收到购物退款25.50元";
    reply = (input) => ({ body: { schemaVersion: input.schemaVersion, outcome: "success", transactions: [
      { type: TransactionType.INCOME, start: 0, end: input.text.length, amountFen: 2550, occurredAt: "2026-10-12T00:00",
        memberId: input.currentMemberId, categoryId: input.categories.find(({ name }) => name === current.refundCategory.name)!.id, note: "购物退款" },
    ] } });
    const result = await createEntry(current.input, current.session, current.recheck);
    expect(result.result).toMatchObject({ status: "success", resultVersion: 2, count: 1, incomeCount: 1, expenseCount: 0, incomeAmountFen: 2550, expenseAmountFen: 0 });
    expect(await db.transaction.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    const income = await db.transaction.findFirstOrThrow({ where: { householdId: current.household.id, type: TransactionType.INCOME, deletedAt: null } });
    expect(income).toMatchObject({ actorMemberId: current.session.memberId, createdByMemberId: current.session.memberId,
      categoryId: current.refundCategory.id, amountFen: 2550, source: null, sourceFingerprint: null, sourceImportedAt: null });
    expect(income.occurredAt.toISOString()).toBe("2026-10-11T16:00:00.000Z");
  });

  it("records one minimal activity per actual type only on the first mixed success", async () => {
    const current = await fixture();
    resolveActionSession = current.recheck;
    current.input.text = "乙收到工资8000元，甲午饭35元";
    reply = (input) => ({ body: mixedSuccess(current, input) });
    const first = await submitAction(current.input);
    expect(first.status).toBe("success");
    expect(await submitAction(current.input)).toEqual(first);
    expect(await queryAction(current.input.requestId, 2)).toEqual(first);
    const events = await db.appEvent.findMany({ where: { householdId: current.household.id }, orderBy: { summary: "asc" } });
    expect(events).toHaveLength(2);
    expect(events.map(({ metadata }) => metadata)).toEqual(expect.arrayContaining([
      { count: 1, transactionType: "income" }, { count: 1, transactionType: "expense" },
    ]));
    expect(JSON.stringify(events)).not.toContain(current.input.text);
    expect(JSON.stringify(events)).not.toContain("800000");
  });

  it("keeps old Actions unknown without creating, closing or replacing requests", async () => {
    const current = await fixture();
    resolveActionSession = current.recheck;
    reply = (input) => ({ body: success(current, input) });
    const legacyInput = { requestId: current.input.requestId, text: current.input.text, locale: current.input.locale };
    expect(await submitAction(legacyInput)).toEqual({ status: "unknown", requestId: current.input.requestId });
    expect(await queryAction(current.input.requestId)).toEqual({ status: "unknown", requestId: current.input.requestId });
    expect(await queryAction(current.input.requestId, 1)).toEqual({ status: "unknown", requestId: current.input.requestId });
    expect(requests).toHaveLength(0);
    expect(await db.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
    const saved = await submitAction(current.input);
    expect(saved.status).toBe("success");
    const state = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    expect(await submitAction(legacyInput)).toEqual({ status: "unknown", requestId: current.input.requestId });
    expect(await queryAction(current.input.requestId)).toEqual({ status: "unknown", requestId: current.input.requestId });
    expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: state.id } })).toEqual(state);
    expect(await queryAction(current.input.requestId, 2)).toEqual(saved);
    expect(requests).toHaveLength(1);
  });

  it("virtually replays an unversioned expense snapshot after edits without updating it", async () => {
    const current = await fixture();
    reply = (input) => ({ body: success(current, input) });
    await createEntry(current.input, current.session, current.recheck);
    const records = await db.transaction.findMany({ where: { householdId: current.household.id, deletedAt: null }, orderBy: { amountFen: "desc" } });
    const legacy = { count: 2, totalAmountFen: 5700, transactionIds: records.map(({ id }) => id) };
    await db.naturalLanguageRequest.updateMany({ where: rowWhere(current), data: { result: legacy } });
    const state = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    await db.transaction.update({ where: { id: records[0].id }, data: { type: TransactionType.INCOME, categoryId: current.incomeCategory.id, amountFen: 9900 } });
    await db.transaction.update({ where: { id: records[1].id }, data: { deletedAt: new Date() } });
    const expected = { status: "success", requestId: current.input.requestId, resultVersion: 2, count: 2,
      incomeCount: 0, expenseCount: 2, incomeAmountFen: 0, expenseAmountFen: 5700 };
    expect(await queryEntry(current.input.requestId, current.session, current.input.context)).toEqual(expected);
    expect(await createEntry(current.input, current.session, current.recheck)).toEqual({ result: expected, wasCreated: false });
    expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: state.id } })).toEqual(state);
    expect(requests).toHaveLength(1);
  });

  it.each(["NEEDS_CORRECTION", "INVALID_RESPONSE", "NOT_ACCEPTED", "EXPIRED"])("never reopens an old terminal %s request under v2", async (code) => {
    const current = await fixture();
    current.input.text = "购物退款25元";
    const issues = [{ code: "unsupported_transaction", start: 0, end: current.input.text.length }];
    const state = await db.naturalLanguageRequest.create({ data: { ...rowWhere(current), ledgerId: current.ledger.id, status: NaturalLanguageRequestStatus.FAILED,
      inputHash: code === "NOT_ACCEPTED" ? null : createHash("sha256").update(current.input.text).digest("hex"),
      errorCode: code, ...(code === "NEEDS_CORRECTION" ? { issues } : {}) } });
    const expected = { status: "error", requestId: current.input.requestId, code, ...(code === "NEEDS_CORRECTION" ? { issues } : {}) };
    expect(await queryEntry(current.input.requestId, current.session, current.input.context)).toEqual(expected);
    expect(await createEntry(current.input, current.session, current.recheck)).toEqual({ result: expected, wasCreated: false });
    expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: state.id } })).toEqual(state);
    expect(requests).toHaveLength(0);
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it.each(["count mismatch", "ids mismatch", "duplicate ids", "zero count amount", "negative amount", "fractional amount", "overflow amount", "extra field", "unknown version", "legacy mismatch"])("keeps malformed stored %s results unknown and immutable", async (kind) => {
    const current = await fixture();
    const result: Record<string, unknown> = { resultVersion: 2, count: 2, incomeCount: 1, expenseCount: 1,
      incomeAmountFen: 800000, expenseAmountFen: 3500, transactionIds: [randomUUID(), randomUUID()] };
    if (kind === "count mismatch") result.count = 3;
    if (kind === "ids mismatch") result.transactionIds = [randomUUID()];
    if (kind === "duplicate ids") result.transactionIds = [current.input.requestId, current.input.requestId];
    if (kind === "zero count amount") { result.incomeCount = 0; result.expenseCount = 2; }
    if (kind === "negative amount") result.incomeAmountFen = -1;
    if (kind === "fractional amount") result.incomeAmountFen = 0.5;
    if (kind === "overflow amount") result.incomeAmountFen = 2147483648;
    if (kind === "extra field") result.totalAmountFen = 803500;
    if (kind === "unknown version") result.resultVersion = 3;
    const storedResult = kind === "legacy mismatch" ? { count: 2, totalAmountFen: 1, transactionIds: [randomUUID(), randomUUID()] } : result;
    const state = await db.naturalLanguageRequest.create({ data: { ...rowWhere(current), ledgerId: current.ledger.id, status: NaturalLanguageRequestStatus.SUCCEEDED,
      inputHash: createHash("sha256").update(current.input.text).digest("hex"), result: storedResult as import("@prisma/client").Prisma.InputJsonObject } });
    const unknown = { status: "unknown", requestId: current.input.requestId };
    expect(await queryEntry(current.input.requestId, current.session, current.input.context)).toEqual(unknown);
    expect(await createEntry(current.input, current.session, current.recheck)).toEqual({ result: unknown, wasCreated: false });
    expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: state.id } })).toEqual(state);
    expect(requests).toHaveLength(0);
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("atomically records two expenses with correct actors, integer amounts and empty source metadata", async () => {
    const current = await fixture();
    reply = (input) => ({ body: success(current, input) });
    const result = await createEntry(current.input, current.session, current.recheck);
    expect(result.result).toEqual({ status: "success", requestId: current.input.requestId, resultVersion: 2, count: 2,
      incomeCount: 0, expenseCount: 2, incomeAmountFen: 0, expenseAmountFen: 5700 });
    expect(result.wasCreated).toBe(true);
    const records = await db.transaction.findMany({ where: { householdId: current.household.id, deletedAt: null }, orderBy: { amountFen: "desc" } });
    expect(records).toHaveLength(2);
    expect(records.map(({ amountFen, actorMemberId }) => [amountFen, actorMemberId])).toEqual([[3500, current.members[0].id], [2200, current.members[1].id]]);
    for (const row of records) expect(row).toMatchObject({ type: TransactionType.EXPENSE, createdByMemberId: current.session.memberId, source: null, sourceFingerprint: null, sourceImportedAt: null });
    const state = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    expect(records[0].occurredAt).toEqual(state.referenceAt);
    expect(records[1].occurredAt.toISOString()).toBe("2026-10-11T16:00:00.000Z");
    expect(await queryEntry(current.input.requestId, current.session, current.input.context)).toEqual(result.result);
  });

  it("returns committed Action success even outside a cache context and records activity only once", async () => {
    const current = await fixture();
    resolveActionSession = current.recheck;
    reply = (input) => ({ body: success(current, input) });
    const result = await submitAction(current.input);
    expect(result).toMatchObject({ status: "success", resultVersion: 2, count: 2, incomeCount: 0, expenseCount: 2, incomeAmountFen: 0, expenseAmountFen: 5700 });
    expect(await submitAction(current.input)).toEqual(result);
    expect(await queryAction(current.input.requestId, 2)).toEqual(result);
    const events = await db.appEvent.findMany({ where: { householdId: current.household.id } });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({ count: 2, transactionType: "expense" });
    expect(JSON.stringify(events)).not.toContain(current.input.text);
  });

  it("redirects an unauthenticated Action without calling AI or creating a request", async () => {
    const current = await fixture();
    resolveActionSession = async () => { throw new Error("Unauthorized"); };
    await expect(submitAction(current.input)).rejects.toThrow("NEXT_REDIRECT");
    await expect(queryAction(current.input.requestId)).rejects.toThrow("NEXT_REDIRECT");
    expect(requests).toHaveLength(0);
    expect(await db.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("sends only anonymous candidates, current text and the fixed date reference", async () => {
    const current = await fixture();
    reply = (input) => ({ body: success(current, input) });
    await createEntry(current.input, current.session, current.recheck);
    expect(Object.keys(requests[0]).sort()).toEqual(["categories", "currentMemberId", "members", "referenceDateTime", "schemaVersion", "text"]);
    const outbound = JSON.stringify(requests[0]);
    for (const value of [current.household.id, current.session.memberId, current.session.id, current.members[1].id, current.category.id, current.appSession.id, current.appSession.sessionKey]) expect(outbound).not.toContain(value);
    expect(requests[0].text).toBe(current.input.text);
    expect(requests[0].members.map(({ id }) => id)).toEqual(["m0", "m1"]);
    expect(requests[0].schemaVersion).toBe("natural-language-entry.v2");
    expect(requests[0].categories.map(({ type }) => type)).toEqual(expect.arrayContaining([CategoryType.INCOME, CategoryType.EXPENSE]));
    expect(outbound).not.toContain("resultVersion");
  });

  it("replays success after soft delete and permits a genuinely new request with identical text", async () => {
    const current = await fixture();
    reply = (input) => ({ body: success(current, input) });
    const first = await createEntry(current.input, current.session, current.recheck);
    await db.transaction.updateMany({ where: { householdId: current.household.id }, data: { deletedAt: new Date() } });
    const repeated = await createEntry(current.input, current.session, current.recheck);
    expect(repeated).toEqual({ result: first.result, wasCreated: false });
    expect(requests).toHaveLength(1);
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(2);
    expect((await createEntry({ ...current.input, requestId: randomUUID() }, current.session, current.recheck)).result.status).toBe("success");
    expect(await db.transaction.count({ where: { householdId: current.household.id, deletedAt: null } })).toBe(2);
  });

  it("rejects changed input for an accepted UUID without rerunning the model", async () => {
    const current = await fixture();
    reply = (input) => ({ body: success(current, input) });
    await createEntry(current.input, current.session, current.recheck);
    const conflict = await createEntry({ ...current.input, text: "咖啡18元" }, current.session, current.recheck);
    expect(conflict.result).toMatchObject({ status: "error", code: "CONFLICT" });
    expect(requests).toHaveLength(1);
  });

  it("deduplicates concurrent retries while the model is still processing", async () => {
    const current = await fixture();
    const entered = deferred();
    const release = deferred();
    reply = async (input) => { entered.resolve(); await release.promise; return { body: success(current, input) }; };
    const first = createEntry(current.input, current.session, current.recheck);
    await entered.promise;
    try {
      expect((await createEntry(current.input, current.session, current.recheck)).result).toEqual({ status: "processing", requestId: current.input.requestId });
      expect(requests).toHaveLength(1);
    } finally { release.resolve(); }
    expect((await first).result.status).toBe("success");
    expect(await db.transaction.count({ where: { householdId: current.household.id, deletedAt: null } })).toBe(2);
  });

  it("closes an unregistered UUID permanently and refuses any late initial text", async () => {
    const current = await fixture();
    expect(await queryEntry(current.input.requestId, current.session, current.input.context)).toEqual({ status: "error", requestId: current.input.requestId, code: "NOT_ACCEPTED" });
    for (const text of [current.input.text, "不同的文本18元"]) {
      expect((await createEntry({ ...current.input, text }, current.session, current.recheck)).result).toMatchObject({ status: "error", code: "NOT_ACCEPTED" });
    }
    const state = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    expect(state).toMatchObject({ status: NaturalLanguageRequestStatus.FAILED, inputHash: null, referenceAt: null, attemptId: null });
    expect(requests).toHaveLength(0);
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("serializes query closure and initial acceptance so an announced failure can never write", async () => {
    const current = await fixture();
    reply = (input) => ({ body: success(current, input) });
    const [query, submit] = await Promise.all([
      queryEntry(current.input.requestId, current.session, current.input.context),
      createEntry(current.input, current.session, current.recheck),
    ]);
    const count = await db.transaction.count({ where: { householdId: current.household.id } });
    if (query.status === "error") {
      expect(query.code).toBe("NOT_ACCEPTED");
      expect(submit.result).toMatchObject({ status: "error", code: "NOT_ACCEPTED" });
      expect(count).toBe(0);
    } else {
      expect(["processing", "success"]).toContain(query.status);
      expect(submit.result.status).toBe("success");
      expect(count).toBe(2);
    }
  });

  it("replays bounded correction positions without persisting text or restarting inference", async () => {
    const current = await fixture();
    current.input.text = "午饭35元，打车忘了多少钱";
    const issues = [{ code: "missing_amount" as const, start: 6, end: current.input.text.length }];
    reply = (input) => ({ body: { schemaVersion: input.schemaVersion, outcome: "needs_correction", issues } });
    const first = await createEntry(current.input, current.session, current.recheck);
    expect(first.result).toEqual({ status: "error", requestId: current.input.requestId, code: "NEEDS_CORRECTION", issues });
    expect(await queryEntry(current.input.requestId, current.session, current.input.context)).toEqual(first.result);
    expect((await createEntry(current.input, current.session, current.recheck)).result).toEqual(first.result);
    expect(requests).toHaveLength(1);
    const state = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    expect(JSON.stringify(state)).not.toContain(current.input.text);
    expect(state.issues).toEqual(issues);
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it.each(["unknown category", "fractional fen", "invalid date", "invalid span", "invalid issues", "extra field"])("rejects %s without any partial transaction", async (kind) => {
    const current = await fixture();
    reply = (input) => {
      const body = success(current, input);
      if (kind === "unknown category") body.transactions[1].categoryId = "c999";
      if (kind === "fractional fen") body.transactions[1].amountFen = 0.5;
      if (kind === "invalid date") body.transactions[1].occurredAt = "2026-02-30T00:00";
      if (kind === "invalid span") body.transactions[1].end = input.text.length + 1;
      if (kind === "invalid issues") return { body: { schemaVersion: input.schemaVersion, outcome: "needs_correction", issues: [{ code: "missing_amount", start: 0, end: 999999 }] } };
      return { body: kind === "extra field" ? { ...body, householdId: current.household.id } : body };
    };
    expect((await createEntry(current.input, current.session, current.recheck)).result).toMatchObject({ status: "error", code: "INVALID_RESPONSE" });
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
    const state = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    expect(state.issues).toBeNull();
  });

  it("rejects session revocation during inference", async () => {
    const current = await fixture();
    reply = async (input) => {
      await db.appSession.update({ where: { id: current.appSession.id }, data: { revokedAt: new Date() } });
      return { body: success(current, input) };
    };
    await expect(createEntry(current.input, current.session, current.recheck)).rejects.toThrow("Unauthorized");
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("rechecks category availability after inference", async () => {
    const current = await fixture();
    reply = async (input) => {
      await db.category.update({ where: { id: current.category.id }, data: { isActive: false } });
      return { body: success(current, input) };
    };
    expect((await createEntry(current.input, current.session, current.recheck)).result).toMatchObject({ status: "error", code: "STALE" });
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("rejects an entire mixed batch if an income category changes type during inference", async () => {
    const current = await fixture();
    current.input.text = "乙收到工资8000元，甲午饭35元";
    reply = async (input) => {
      const body = mixedSuccess(current, input);
      body.transactions[0].categoryId = input.categories.find(({ name }) => name === current.refundCategory.name)!.id;
      await db.category.update({ where: { id: current.refundCategory.id }, data: { type: CategoryType.EXPENSE } });
      return { body };
    };
    expect((await createEntry(current.input, current.session, current.recheck)).result).toMatchObject({ status: "error", code: "STALE" });
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
    const state = await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) });
    expect(state).toMatchObject({ status: NaturalLanguageRequestStatus.FAILED, result: null });
  });

  it("prevents a terminated old attempt from writing after a new operation", async () => {
    const current = await fixture();
    const entered = deferred();
    const release = deferred();
    reply = async (input) => { entered.resolve(); await release.promise; return { body: success(current, input) }; };
    const old = createEntry(current.input, current.session, current.recheck);
    await entered.promise;
    await db.naturalLanguageRequest.updateMany({ where: rowWhere(current), data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect(await queryEntry(current.input.requestId, current.session, current.input.context)).toMatchObject({ status: "error", code: "EXPIRED" });
    release.resolve();
    expect((await old).result).toMatchObject({ status: "error", code: "EXPIRED" });
    expect((await createEntry(current.input, current.session, current.recheck)).result).toMatchObject({ status: "error", code: "EXPIRED" });
    expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("recovers an expired nonterminal attempt using its original date reference", async () => {
    const current = await fixture();
    const referenceAt = new Date("2026-10-12T15:59:00.000Z");
    await db.naturalLanguageRequest.create({ data: {
      ...rowWhere(current), ledgerId: current.ledger.id, inputHash: createHash("sha256").update(normalizeNaturalLanguageText(current.input.text)).digest("hex"),
      referenceAt, status: NaturalLanguageRequestStatus.PROCESSING, attemptId: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1000),
    } });
    reply = (input) => ({ body: success(current, input) });
    expect((await createEntry(current.input, current.session, current.recheck)).result.status).toBe("success");
    expect(requests[0].referenceDateTime).toBe("2026-10-12T23:59");
    expect((await db.transaction.findFirstOrThrow({ where: { householdId: current.household.id, amountFen: 3500 } })).occurredAt).toEqual(referenceAt);
  });

  it("does not expose another household's result for the same UUID", async () => {
    const current = await fixture();
    reply = (input) => ({ body: success(current, input) });
    await createEntry(current.input, current.session, current.recheck);
    const outside = await fixture();
    expect(await queryEntry(current.input.requestId, outside.session, outside.input.context)).toMatchObject({ status: "error", code: "NOT_ACCEPTED" });
    expect((await queryEntry(current.input.requestId, current.session, current.input.context)).status).toBe("success");
    await expect(queryEntry(current.input.requestId, { ...outside.session, memberId: current.session.memberId })).rejects.toThrow("Unauthorized");
  });

  it.each(["expense", "mixed"])("rolls back the entire %s batch if the second database insert fails", async (kind) => {
    const current = await fixture();
    if (kind === "mixed") current.input.text = "乙收到工资8000元，甲午饭35元";
    const functionName = `natural_entry_fail_${randomBytes(8).toString("hex")}`;
    // Identifiers and the household ID are generated by this local-only fixture.
    await db.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.household_id = '${current.household.id}' AND NEW.note = 'trigger-failure' THEN RAISE EXCEPTION 'Fixture batch write failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${functionName}" BEFORE INSERT ON "Transaction" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
    try {
      reply = (input) => {
        const body = kind === "mixed" ? mixedSuccess(current, input) : success(current, input);
        body.transactions[1].note = "trigger-failure";
        return { body };
      };
      expect((await createEntry(current.input, current.session, current.recheck)).result.status).toBe("error");
      expect(await db.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
      expect((await db.naturalLanguageRequest.findFirstOrThrow({ where: rowWhere(current) })).status).toBe(NaturalLanguageRequestStatus.FAILED);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER "${functionName}" ON "Transaction"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
    }
  });
});

vi.mock("@/lib/encryption/request", () => ({
  withHouseholdEncryption: async (_input: unknown, work: () => Promise<unknown>) => work(),
  extractEncryption: (form: FormData) => { form.delete("__householdEncryption"); return undefined; },
}));
