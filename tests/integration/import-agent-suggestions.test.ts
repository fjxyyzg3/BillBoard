import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { CategoryType, HouseholdRole, ImportDraftRowStatus, ImportDraftStatus, ImportRowDecision, type Prisma, TransactionType, UserStatus } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportAgentRequest } from "@/lib/imports/agent-protocol";
import type { ImportSource } from "@/lib/imports/types";

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

type SessionUser = { householdId: string; memberId: string };
type AgentReply = { status?: number; body: unknown };

let db: typeof import("@/lib/db").db;
let recommend: typeof import("@/lib/imports/agent-suggestions").getImportAgentSuggestions;
let server: Server;
let agentUrl: string;
let agentReply: (request: ImportAgentRequest) => AgentReply | Promise<AgentReply>;
let requests: ImportAgentRequest[] = [];
let requestHeaders: Array<{ authorization?: string; url?: string }> = [];
const householdIds: string[] = [];
const userIds: string[] = [];
const categoryIds: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Refusing to run agent suggestion tests against a non-local dev/test database");
  }
  ({ db } = await import("@/lib/db"));
  ({ getImportAgentSuggestions: recommend } = await import("@/lib/imports/agent-suggestions"));
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ImportAgentRequest;
      requests.push(payload);
      requestHeaders.push({ authorization: request.headers.authorization, url: request.url });
      const reply = await agentReply(payload);
      response.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await db.resourceLease.deleteMany();
  await db.resourceWindow.deleteMany();
  vi.stubEnv("IMPORT_AGENT_URL", agentUrl);
  vi.stubEnv("IMPORT_AGENT_TOKEN", "test-import-agent-token");
  requests = [];
  requestHeaders = [];
  agentReply = () => ({ body: { schemaVersion: "import-category-agent.v1", suggestions: [] } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds.splice(0) } } });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.$disconnect();
});

async function fixture(source: ImportSource = "wechat_pay") {
  const suffix = randomUUID();
  const household = await db.household.create({ data: { name: `Agent suggestions ${suffix}` } });
  householdIds.push(household.id);
  const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const user = await db.user.create({ data: {
    displayName: "Agent test member", email: `agent-suggestions-${suffix}@example.com`, passwordHash: "not-used",
    aiProcessingEnabled: true,
  } });
  userIds.push(user.id);
  const member = await db.householdMember.create({ data: {
    householdId: household.id, userId: user.id, memberName: "Agent test member", role: HouseholdRole.OWNER,
  } });
  const [expense, income] = await Promise.all([
    db.category.create({ data: { name: `Agent expense ${suffix}`, type: CategoryType.EXPENSE, sortOrder: 999 } }),
    db.category.create({ data: { name: `Agent income ${suffix}`, type: CategoryType.INCOME, sortOrder: 999 } }),
  ]);
  categoryIds.push(expense.id, income.id);
  const draft = await db.importDraft.create({ data: {
    householdId: household.id, ledgerId: ledger.id, createdByMemberId: member.id, source, fileName: "private-statement-fixture.xlsx",
  } });
  const sessionUser = { householdId: household.id, memberId: member.id } satisfies SessionUser;
  return { source, user, draft, sessionUser, expense, income };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function addRow(current: Fixture, overrides: Partial<Prisma.ImportDraftRowUncheckedCreateInput> = {}) {
  const primaryCategory = overrides.primaryCategory ?? "餐饮美食";
  const secondaryCategory = overrides.secondaryCategory ?? "示例商户";
  const transactionType = overrides.transactionType ?? TransactionType.EXPENSE;
  const mappingKey = `${current.source}|${transactionType}|${primaryCategory}|${current.source === "alipay" ? "" : secondaryCategory}`;
  return db.importDraftRow.create({ data: {
    draftId: current.draft.id, rowNumber: 1, status: ImportDraftRowStatus.NEEDS_MAPPING,
    userDecision: ImportRowDecision.KEEP, transactionType, primaryCategory, secondaryCategory, mappingKey,
    amountFen: 1234567, occurredAt: new Date("2026-04-05T01:02:03.000Z"), occurredDate: "2026-04-05",
    actorMemberId: current.sessionUser.memberId, createdByMemberId: current.sessionUser.memberId,
    rawAmount: "private-raw-amount", rawMember: "private-raw-member", rawCreatedBy: "private-raw-creator",
    sourceFingerprint: `private-fingerprint-${randomUUID()}`,
    note: "交易对方：示例商户；商品：咖啡；备注：private-raw-note；订单号：private-order",
    ...overrides,
  } });
}

function mapReply(current: Fixture, request: ImportAgentRequest) {
  const category = request.categories.find(({ name }) => name === current.expense.name)!;
  return { body: { schemaVersion: "import-category-agent.v1", suggestions: request.groups.map(({ id }) => ({
    groupId: id, action: "map", categoryId: category.id,
  })) } };
}

async function snapshot(current: Fixture) {
  return {
    drafts: await db.importDraft.findMany({ where: { householdId: current.sessionUser.householdId }, orderBy: { id: "asc" } }),
    rows: await db.importDraftRow.findMany({ where: { draft: { householdId: current.sessionUser.householdId } }, orderBy: { id: "asc" } }),
    rules: await db.importCategoryMapping.findMany({ where: { householdId: current.sessionUser.householdId }, orderBy: { id: "asc" } }),
    transactions: await db.transaction.findMany({ where: { householdId: current.sessionUser.householdId }, orderBy: { id: "asc" } }),
  };
}

describe("import agent suggestions", () => {
  it("requires this account's AI choice before sending a new recommendation batch", async () => {
    const current = await fixture();
    const row = await addRow(current);
    await db.user.update({ where: { id: current.user.id }, data: { aiProcessingEnabled: false } });
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "CONSENT_REQUIRED" });
    expect(requests).toHaveLength(0);
    expect(await db.resourceLease.count()).toBe(0);
    expect(await db.resourceWindow.count()).toBe(0);
  });

  it("finishes an admitted batch after the account closes its choice and rejects the next batch", async () => {
    const current = await fixture();
    const row = await addRow(current);
    agentReply = async (request) => {
      await db.user.update({ where: { id: current.user.id }, data: { aiProcessingEnabled: false } });
      return mapReply(current, request);
    };
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toMatchObject({ success: true, suggestions: [{ mappingKey: row.mappingKey, categoryId: current.expense.id }] });
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "CONSENT_REQUIRED" });
    expect(requests).toHaveLength(1);
    expect(await db.resourceLease.count()).toBe(0);
    expect(await db.resourceWindow.findUnique({ where: { key: "ai:global:global" } })).toMatchObject({ used: 1 });
  });

  it("discards late recommendations when their shared lease has expired", async () => {
    const current = await fixture();
    const row = await addRow(current);
    agentReply = async (request) => {
      await db.$executeRaw`UPDATE "ResourceLease" SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE household_id = ${current.sessionUser.householdId} AND kind = 'ai'`;
      return mapReply(current, request);
    };
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "STALE" });
    expect(requests).toHaveLength(1);
    expect(await db.resourceLease.count()).toBe(0);
  });

  it.each(["sui_shou_ji", "wechat_pay", "alipay", "cmb"] as const)(
    "recommends %s mappings through an anonymous allowlisted payload without business writes", async (source) => {
      const current = await fixture(source);
      const row = await addRow(current);
      const before = await snapshot(current);
      agentReply = (request) => mapReply(current, request);

      const result = await recommend(current.draft.id, [row.mappingKey!], current.sessionUser);

      expect(result).toEqual({ success: true, suggestions: [{ mappingKey: row.mappingKey, categoryId: current.expense.id }], unresolvedCount: 0 });
      expect(await snapshot(current)).toEqual(before);
      expect(requestHeaders).toEqual([{ authorization: "Bearer test-import-agent-token", url: "/suggest" }]);
      expect(requests[0]).toEqual({
        schemaVersion: "import-category-agent.v1",
        groups: [{ id: "g0", source, transactionType: "EXPENSE", primaryCategory: "餐饮美食",
          secondaryCategory: source === "alipay" ? "" : "示例商户",
          products: source === "wechat_pay" || source === "alipay" ? ["咖啡"] : [] }],
        categories: expect.arrayContaining([{ id: expect.stringMatching(/^c\d+$/), name: current.expense.name,
          displayName: current.expense.name, type: "EXPENSE" }]),
      });
      for (const category of requests[0].categories) {
        expect(Object.keys(category).sort()).toEqual(["displayName", "id", "name", "type"]);
      }
      const wire = JSON.stringify(requests[0]);
      for (const value of [current.draft.id, current.sessionUser.householdId, current.sessionUser.memberId,
        current.expense.id, row.sourceFingerprint!, "private-raw-note", "private-raw-amount", "private-raw-member",
        "private-raw-creator", "private-order", "1234567", "2026-04-05", row.mappingKey!]) {
        expect(wire).not.toContain(value);
      }
    },
  );

  it("distinguishes explicit ignore from uncertain and missing suggestions", async () => {
    const current = await fixture();
    const rows = await Promise.all(["mapped", "ignored", "uncertain", "missing"].map((primaryCategory) => addRow(current, { primaryCategory })));
    agentReply = (request) => ({ body: { schemaVersion: "import-category-agent.v1", suggestions: [
      { groupId: request.groups[0].id, action: "map", categoryId: request.categories.find(({ name }) => name === current.expense.name)!.id },
      { groupId: request.groups[1].id, action: "ignore" },
      { groupId: request.groups[2].id, action: "uncertain" },
    ] } });
    expect(await recommend(current.draft.id, rows.map(({ mappingKey }) => mappingKey!), current.sessionUser)).toEqual({
      success: true, suggestions: [
        { mappingKey: rows[0].mappingKey, categoryId: current.expense.id },
        { mappingKey: rows[1].mappingKey, categoryId: null },
      ], unresolvedCount: 2,
    });
  });

  it("skips saved category and ignore rules while keeping another household's rules isolated", async () => {
    const current = await fixture();
    const outside = await fixture();
    const rows = await Promise.all(["saved", "ignored", "outside"].map((primaryCategory) => addRow(current, { primaryCategory })));
    await db.importCategoryMapping.createMany({ data: [
      { householdId: current.sessionUser.householdId, source: current.source, transactionType: TransactionType.EXPENSE,
        primaryCategory: "saved", secondaryCategory: "示例商户", categoryId: current.expense.id },
      { householdId: current.sessionUser.householdId, source: current.source, transactionType: TransactionType.EXPENSE,
        primaryCategory: "ignored", secondaryCategory: "示例商户", categoryId: null },
      { householdId: outside.sessionUser.householdId, source: current.source, transactionType: TransactionType.EXPENSE,
        primaryCategory: "outside", secondaryCategory: "示例商户", categoryId: null },
    ] });
    agentReply = (request) => mapReply(current, request);
    const before = await snapshot(current);
    const result = await recommend(current.draft.id, rows.map(({ mappingKey }) => mappingKey!), current.sessionUser);
    expect(result).toEqual({ success: true, suggestions: [{ mappingKey: rows[2].mappingKey, categoryId: current.expense.id }], unresolvedCount: 2 });
    expect(requests[0].groups.map(({ primaryCategory }) => primaryCategory)).toEqual(["outside"]);
    expect(await snapshot(current)).toEqual(before);
  });

  it("never recommends mapped, skipped, duplicate, invalid, or non-KEEP rows", async () => {
    const current = await fixture();
    const rows = await Promise.all([
      addRow(current, { primaryCategory: "ready", status: ImportDraftRowStatus.READY, categoryId: current.expense.id }),
      addRow(current, { primaryCategory: "skipped", status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP }),
      addRow(current, { primaryCategory: "duplicate", status: ImportDraftRowStatus.SOURCE_DUPLICATE }),
      addRow(current, { primaryCategory: "possible", status: ImportDraftRowStatus.POSSIBLE_DUPLICATE }),
      addRow(current, { primaryCategory: "invalid", status: ImportDraftRowStatus.INVALID }),
      addRow(current, { primaryCategory: "not-kept", userDecision: ImportRowDecision.SKIP }),
    ]);
    expect(await recommend(current.draft.id, rows.map(({ mappingKey }) => mappingKey!), current.sessionUser)).toEqual({
      success: true, suggestions: [], unresolvedCount: rows.length,
    });
    expect(requests).toEqual([]);
  });

  it.each(["missing-member", "wrong-member", "outside-draft", "locked-member"])("rejects %s without contacting the agent", async (kind) => {
    const current = await fixture();
    const outside = await fixture();
    const row = await addRow(current);
    const sessionUser = kind === "missing-member" ? { ...current.sessionUser, memberId: "missing" } :
      kind === "wrong-member" ? { ...current.sessionUser, memberId: outside.sessionUser.memberId } :
        kind === "outside-draft" ? outside.sessionUser : current.sessionUser;
    if (kind === "locked-member") await db.user.update({ where: { id: current.user.id }, data: { status: UserStatus.LOCKED } });
    expect(await recommend(current.draft.id, [row.mappingKey!], sessionUser)).toEqual({ success: false, error: "INVALID" });
    expect(requests).toEqual([]);
  });

  it("rejects unknown groups, repeated groups and oversized batches before making a request", async () => {
    const current = await fixture();
    const row = await addRow(current);
    for (const keys of [["wechat_pay|EXPENSE|missing|"], [row.mappingKey!, row.mappingKey!],
      Array.from({ length: 26 }, (_, index) => `wechat_pay|EXPENSE|${index}|`), []]) {
      expect(await recommend(current.draft.id, keys, current.sessionUser)).toEqual({ success: false, error: "INVALID" });
    }
    expect(requests).toEqual([]);
  });

  it("bounds descriptions to three distinct products and 200 characters without treating arbitrary notes as products", async () => {
    const current = await fixture("alipay");
    const product = "长".repeat(250);
    const rows = await Promise.all([product, product, "第二件", "第三件", "第四件"].map((value, index) => addRow(current, {
      rowNumber: index + 1, note: `交易对方：示例商户；商品：${value}；备注：private-note`,
    })));
    await addRow(current, { rowNumber: 9, note: "备注：private-note contains 商品：private-note-product" });
    await recommend(current.draft.id, [rows[0].mappingKey!], current.sessionUser);
    expect(requests[0].groups[0].products).toEqual(["长".repeat(200), "第二件", "第三件"]);
  });

  it("bounds source category text while returning the original saved mapping key", async () => {
    const current = await fixture();
    const row = await addRow(current, { primaryCategory: "主".repeat(250), secondaryCategory: "次".repeat(250) });
    agentReply = (request) => mapReply(current, request);
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({
      success: true, suggestions: [{ mappingKey: row.mappingKey, categoryId: current.expense.id }], unresolvedCount: 0,
    });
    expect(requests[0].groups[0]).toMatchObject({ primaryCategory: "主".repeat(200), secondaryCategory: "次".repeat(200) });
  });

  it("rejects inconsistent source or transaction type stored on a requested group", async () => {
    const current = await fixture();
    const row = await addRow(current, { mappingKey: "alipay|INCOME|餐饮美食|" });
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "INVALID" });
    expect(requests).toEqual([]);
  });

  it("does not fall back to any part of an unlabelled note", async () => {
    const current = await fixture();
    const row = await addRow(current, { note: "备注：private-note contains 商品：private-note-product" });
    await recommend(current.draft.id, [row.mappingKey!], current.sessionUser);
    expect(requests[0].groups[0].products).toEqual([]);
    expect(JSON.stringify(requests)).not.toContain("private-note");
  });

  it("includes Chinese category labels and excludes disabled categories", async () => {
    const current = await fixture();
    const row = await addRow(current);
    await db.category.update({ where: { id: current.income.id }, data: { isActive: false } });
    await recommend(current.draft.id, [row.mappingKey!], current.sessionUser);
    expect(requests[0].categories).toContainEqual({ id: expect.any(String), name: "Dining", displayName: "餐饮", type: "EXPENSE" });
    expect(requests[0].categories.some(({ name }) => name === current.income.name)).toBe(false);
  });

  it.each(["draft-completed", "member-locked"])("rejects %s during agent processing", async (kind) => {
    const current = await fixture();
    const row = await addRow(current);
    agentReply = async (request) => {
      if (kind === "draft-completed") await db.importDraft.update({ where: { id: current.draft.id }, data: { status: ImportDraftStatus.COMPLETED } });
      else await db.user.update({ where: { id: current.user.id }, data: { status: UserStatus.LOCKED } });
      return mapReply(current, request);
    };
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "STALE" });
  });

  it.each(["rule-saved", "row-mapped", "row-skipped", "category-disabled", "category-type-changed"])(
    "filters late suggestions when %s", async (kind) => {
      const current = await fixture();
      const row = await addRow(current);
      agentReply = async (request) => {
        if (kind === "rule-saved") await db.importCategoryMapping.create({ data: {
          householdId: current.sessionUser.householdId, source: current.source, transactionType: TransactionType.EXPENSE,
          primaryCategory: "餐饮美食", secondaryCategory: "示例商户", categoryId: null,
        } });
        if (kind === "row-mapped") await db.importDraftRow.update({ where: { id: row.id }, data: { categoryId: current.expense.id, status: ImportDraftRowStatus.READY } });
        if (kind === "row-skipped") await db.importDraftRow.update({ where: { id: row.id }, data: { userDecision: ImportRowDecision.SKIP } });
        if (kind === "category-disabled") await db.category.update({ where: { id: current.expense.id }, data: { isActive: false } });
        if (kind === "category-type-changed") await db.category.update({ where: { id: current.expense.id }, data: { type: CategoryType.INCOME } });
        return mapReply(current, request);
      };
      expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: true, suggestions: [], unresolvedCount: 1 });
    },
  );

  it("rejects already completed drafts without agent requests", async () => {
    const current = await fixture();
    const row = await addRow(current);
    await db.importDraft.update({ where: { id: current.draft.id }, data: { status: ImportDraftStatus.COMPLETED } });
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "STALE" });
    expect(requests).toEqual([]);
  });

  it.each(["unknown-group", "unknown-category", "wrong-type", "duplicate", "null-category", "extra-field", "malformed-json", "oversized"])(
    "rejects the whole batch for %s results without writes", async (kind) => {
      const current = await fixture();
      const row = await addRow(current);
      const before = await snapshot(current);
      agentReply = (request) => {
        const expenseId = request.categories.find(({ name }) => name === current.expense.name)!.id;
        const incomeId = request.categories.find(({ name }) => name === current.income.name)!.id;
        const map = { groupId: request.groups[0].id, action: "map", categoryId: expenseId };
        const suggestions = kind === "unknown-group" ? [{ ...map, groupId: "g999" }] :
          kind === "unknown-category" ? [{ ...map, categoryId: current.expense.id }] :
            kind === "wrong-type" ? [{ ...map, categoryId: incomeId }] :
              kind === "duplicate" ? [map, map] :
                kind === "null-category" ? [{ ...map, categoryId: null }] :
                  kind === "extra-field" ? [{ ...map, explanation: "private-model-output" }] : [map];
        return { body: kind === "malformed-json" ? "private-model-output" : kind === "oversized" ? "x".repeat(70_000) :
          { schemaVersion: "import-category-agent.v1", suggestions } };
      };
      expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "FAILED" });
      expect(await snapshot(current)).toEqual(before);
    },
  );

  it.each([[429, "BUSY"], [503, "UNAVAILABLE"], [401, "UNAVAILABLE"], [500, "FAILED"]] as const)(
    "turns HTTP %s into fixed error %s", async (status, error) => {
      const current = await fixture();
      const row = await addRow(current);
      agentReply = () => ({ status, body: { raw: "private-agent-output" } });
      expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error });
    },
  );

  it("recognizes an explicit busy response independently of the service status", async () => {
    const current = await fixture();
    const row = await addRow(current);
    agentReply = () => ({ status: 503, body: { error: "busy" } });
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "BUSY" });
  });

  it("fails closed when configuration is missing and keeps network exceptions private", async () => {
    const current = await fixture();
    const row = await addRow(current);
    vi.stubEnv("IMPORT_AGENT_TOKEN", "");
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "UNAVAILABLE" });
    expect(requests).toEqual([]);
    vi.stubEnv("IMPORT_AGENT_TOKEN", "test-import-agent-token");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("private-network-error", "TimeoutError"));
    expect(await recommend(current.draft.id, [row.mappingKey!], current.sessionUser)).toEqual({ success: false, error: "FAILED" });
  });
});
