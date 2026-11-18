import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BILL_ANALYSIS_SCHEMA_VERSION, validateBillAnalysisRequest, type BillAnalysisAgentRequest } from "@/lib/reports/bill-analysis-protocol";
import type { BillAnalysisEvent, BillAnalysisOutcome, BillAnalysisScope } from "@/lib/reports/bill-analysis-types";
import type { BillAnalysisSession } from "@/lib/reports/bill-analysis-store";

type AgentHandler = (input: BillAnalysisAgentRequest, response: ServerResponse) => Promise<void>;
const emptyHandler: AgentHandler = async () => undefined;
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe("bill analysis service with PostgreSQL and a real HTTP Agent", () => {
  let raw: PrismaClient;
  let server: Server;
  let handler: AgentHandler = emptyHandler;
  let categoryId: string;
  let generate: typeof import("@/lib/reports/bill-analysis-service").generateBillAnalysis;
  let store: typeof import("@/lib/reports/bill-analysis-store");
  const captures: BillAnalysisAgentRequest[] = [];
  const handlerErrors: Error[] = [];
  const householdIds: string[] = [], userIds: string[] = [], memberIds: string[] = [];
  const previousEnvironment = { url: process.env.IMPORT_AGENT_URL, token: process.env.IMPORT_AGENT_TOKEN };
  let defaultScope: BillAnalysisScope;
  let previousMonth: string;
  let yearAgoMonth: string;

  beforeAll(async () => {
    process.loadEnvFile(".env.example");
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) throw new Error("Analysis service tests require a local development database");
    raw = new PrismaClient();
    ({ generateBillAnalysis: generate } = await import("@/lib/reports/bill-analysis-service"));
    store = await import("@/lib/reports/bill-analysis-store");
    categoryId = (await raw.category.create({ data: { type: "EXPENSE", name: `Synthetic analysis category ${randomUUID()}`, sortOrder: 9999 } })).id;
    const now = new Date(Date.now() + 8 * 3_600_000);
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const format = (value: Date) => value.toISOString().slice(0, 7);
    defaultScope = { mode: "month", period: format(month), ledgerId: null, actorMemberId: null };
    previousMonth = format(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)));
    yearAgoMonth = format(new Date(Date.UTC(month.getUTCFullYear() - 1, month.getUTCMonth(), 1)));
    const token = randomBytes(32).toString("hex");
    server = createServer(async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== "/analyze-bill" || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const value of request) { const chunk = Buffer.from(value); bytes += chunk.length; if (bytes > 256 * 1024) throw new Error("The client exceeded its Agent protocol budget"); chunks.push(chunk); }
        const input = validateBillAnalysisRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        captures.push(input);
        await handler(input, response);
        if (response.destroyed || response.writableEnded) return;
        const rowRef = input.stage === "batch" ? input.rows[0]?.ref : input.evidence[0]?.ref;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, batchId: input.batchId, body: { overview: "Synthetic recorded spending review", observations: [{ title: "Recorded expenses", detail: "Review the recorded expense pattern.", evidenceRefs: ["current.expenseFen", ...(rowRef ? [rowRef] : [])] }], recommendations: [], limitations: ["Recorded transactions only"] } }));
      } catch (error) { handlerErrors.push(error as Error); if (!response.destroyed && !response.writableEnded) { response.writeHead(503); response.end(); } }
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic HTTP Agent did not bind loopback");
    process.env.IMPORT_AGENT_URL = `http://127.0.0.1:${address.port}`;
    process.env.IMPORT_AGENT_TOKEN = token;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    captures.length = 0; handlerErrors.length = 0; handler = emptyHandler;
    await raw.resourceWindow.deleteMany({ where: { kind: "ai" } });
  });

  afterEach(async () => {
    const owned = { householdId: { in: householdIds } };
    await raw.billAnalysisRequest.deleteMany({ where: owned });
    await raw.billAnalysisReport.deleteMany({ where: owned });
    await raw.resourceLease.deleteMany({ where: owned });
    await raw.resourceWindow.deleteMany({ where: { kind: "ai", OR: [{ scope: "global" }, { subjectId: { in: [...householdIds, ...memberIds] } }] } });
    await raw.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
    await raw.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
    memberIds.length = 0;
    expect(handlerErrors).toEqual([]);
  });

  afterAll(async () => {
    if (previousEnvironment.url === undefined) delete process.env.IMPORT_AGENT_URL; else process.env.IMPORT_AGENT_URL = previousEnvironment.url;
    if (previousEnvironment.token === undefined) delete process.env.IMPORT_AGENT_TOKEN; else process.env.IMPORT_AGENT_TOKEN = previousEnvironment.token;
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await raw.category.delete({ where: { id: categoryId } });
    await raw.$disconnect();
  });

  async function fixture(ai = true) {
    const household = await raw.household.create({ data: { name: "Synthetic service family" } }); householdIds.push(household.id);
    const user = await raw.user.create({ data: { email: `service-analysis-${randomUUID()}@example.com`, displayName: "Owner", passwordHash: "not-used", aiProcessingEnabled: ai } }); userIds.push(user.id);
    const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, role: "OWNER", memberName: "Owner" } }); memberIds.push(member.id);
    const ledger = await raw.ledger.create({ data: { householdId: household.id, name: "Default service ledger", isDefault: true } });
    const session = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 1_800_000) } });
    const identity: BillAnalysisSession = { id: user.id, householdId: household.id, memberId: member.id, appSessionId: session.id };
    return { session: identity, ledgerId: ledger.id };
  }
  async function transaction(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<{ id: string; ledgerId: string; actorMemberId: string; amountFen: number; note: string; occurredAt: Date; deletedAt: Date }> = {}) {
    return raw.transaction.create({ data: { id: randomUUID(), householdId: f.session.householdId, ledgerId: f.ledgerId, actorMemberId: f.session.memberId, createdByMemberId: f.session.memberId, type: "EXPENSE", amountFen: 12345, categoryId, occurredAt: new Date(`${defaultScope.period}-05T01:00:00+08:00`), note: "SYNTHETIC_CURRENT_NOTE", ...overrides } });
  }
  function run(session: BillAnalysisSession, options: { requestId?: string; scope?: BillAnalysisScope; signal?: AbortSignal; events?: BillAnalysisEvent[]; onSubmitted?: (result: BillAnalysisOutcome) => void } = {}) {
    const requestId = options.requestId ?? randomUUID();
    return generate(session, { requestId, scope: options.scope ?? defaultScope, locale: "zh-CN" }, options.signal ?? new AbortController().signal, (event) => options.events?.push(event), undefined, options.onSubmitted);
  }
  async function expectReleased(session: BillAnalysisSession) {
    expect(await raw.resourceLease.count({ where: { householdId: session.householdId } })).toBe(0);
    expect(await raw.resourceExecution.count({ where: { lease: { householdId: session.householdId } } })).toBe(0);
    expect(await raw.billAnalysisReport.count({ where: { householdId: session.householdId, activeRequestId: { not: null } } })).toBe(0);
  }

  it("performs batch and summary over HTTP, saves private transaction references and reuses the original UUID", async () => {
    const f = await fixture(); const row = await transaction(f); const requestId = randomUUID(); const events: BillAnalysisEvent[] = [];
    const result = await run(f.session, { requestId, events });
    expect(result).toMatchObject({ status: "success", generation: 1 });
    expect(captures.map(({ stage }) => stage)).toEqual(["batch", "summary"]);
    expect(events.some((event) => event.type === "progress" && event.phase === "saving")).toBe(true);
    const report = await store.readBillAnalysisReport(f.session, { scope: defaultScope });
    expect(report).toMatchObject({ body: { overview: "Synthetic recorded spending review" } });
    const saved = await raw.billAnalysisReport.findUniqueOrThrow({ where: { id: result.reportId! } });
    expect(saved.content).toMatchObject({ transactionRefs: { r1: row.id } });
    expect(JSON.stringify(report)).not.toContain(row.id);
    expect(await run(f.session, { requestId })).toMatchObject({ status: "success", reportId: result.reportId });
    expect(captures).toHaveLength(2);
    await expectReleased(f.session);
  });

  it("applies archived ledger and historical member filters to current details and comparison summaries", async () => {
    const f = await fixture();
    const formerUser = await raw.user.create({ data: { email: `service-former-${randomUUID()}@example.com`, displayName: "Former", passwordHash: "not-used" } }); userIds.push(formerUser.id);
    const former = await raw.householdMember.create({ data: { householdId: f.session.householdId, userId: formerUser.id, role: "MEMBER", memberName: "Former", leftAt: new Date() } }); memberIds.push(former.id);
    const archive = await raw.ledger.create({ data: { householdId: f.session.householdId, name: "Archived", archivedAt: new Date() } });
    const selected = await transaction(f, { ledgerId: archive.id, actorMemberId: former.id, note: "SELECTED_CURRENT", amountFen: 1000 });
    const previous = await transaction(f, { ledgerId: archive.id, actorMemberId: former.id, amountFen: 2000, occurredAt: new Date(`${previousMonth}-05T01:00:00+08:00`), note: "PRIVATE_PREVIOUS_NOTE" });
    const yearAgo = await transaction(f, { ledgerId: archive.id, actorMemberId: former.id, amountFen: 3000, occurredAt: new Date(`${yearAgoMonth}-05T01:00:00+08:00`), note: "PRIVATE_YEAR_AGO_NOTE" });
    await transaction(f, { ledgerId: archive.id, actorMemberId: former.id, deletedAt: new Date(), note: "DELETED_EXCLUDED" });
    await transaction(f, { note: "OTHER_LEDGER_EXCLUDED" });
    await transaction(f, { ledgerId: archive.id, note: "OTHER_MEMBER_EXCLUDED" });
    const result = await run(f.session, { scope: { ...defaultScope, ledgerId: archive.id, actorMemberId: former.id } });
    expect(result.status).toBe("success");
    const batch = captures[0]; if (batch.stage !== "batch") throw new Error("The first Agent call must be a batch");
    expect(batch.rows).toHaveLength(1); expect(batch.rows[0].note).toBe("SELECTED_CURRENT");
    expect(batch.comparisons.map((comparison) => comparison.metrics.find((metric) => metric.ref.endsWith(".expenseFen"))?.value)).toEqual([2000, 3000]);
    const encoded = JSON.stringify(captures);
    for (const secret of [selected.id, previous.id, yearAgo.id, f.session.id, former.id, archive.id, "PRIVATE_PREVIOUS_NOTE", "PRIVATE_YEAR_AGO_NOTE", "DELETED_EXCLUDED", "OTHER_LEDGER_EXCLUDED", "OTHER_MEMBER_EXCLUDED"]) expect(encoded).not.toContain(secret);
    await expectReleased(f.session);
  });

  it("keeps a fixed 501-row snapshot when a new transaction is inserted during the first HTTP batch", async () => {
    const f = await fixture();
    await raw.transaction.createMany({ data: Array.from({ length: 501 }, (_, index) => ({ householdId: f.session.householdId, ledgerId: f.ledgerId, actorMemberId: f.session.memberId, createdByMemberId: f.session.memberId, type: "EXPENSE" as const, amountFen: 100 + index, categoryId, occurredAt: new Date(`${defaultScope.period}-05T01:00:00+08:00`), note: `ROW_${index}` })) });
    let inserted = false;
    handler = async (input) => {
      if (input.stage === "batch" && !inserted) {
        inserted = true;
        // This independent write must not wait for a transaction spanning model HTTP work.
        await transaction(f, { note: "LATE_INSERT_MUST_NOT_REENTER_SNAPSHOT" });
      }
    };
    expect((await run(f.session)).status).toBe("success");
    const batches = captures.filter((input) => input.stage === "batch");
    expect(batches.map((batch) => batch.rows.length)).toEqual([500, 1]);
    expect(new Set(batches.flatMap((batch) => batch.rows.map((row) => row.ref))).size).toBe(501);
    expect(JSON.stringify(captures)).not.toContain("LATE_INSERT_MUST_NOT_REENTER_SNAPSHOT");
    expect(captures).toHaveLength(3);
    await expectReleased(f.session);
  });

  it("keeps the previous report when summary HTTP fails and does not retry", async () => {
    const f = await fixture(); await transaction(f);
    expect((await run(f.session)).status).toBe("success");
    const previous = await store.readBillAnalysisReport(f.session, { scope: defaultScope }); captures.length = 0;
    handler = async (input, response) => { if (input.stage === "summary") { response.writeHead(503); response.end(); } };
    expect(await run(f.session)).toMatchObject({ status: "error", error: "UNAVAILABLE" });
    expect(captures.map(({ stage }) => stage)).toEqual(["batch", "summary"]);
    expect(await store.readBillAnalysisReport(f.session, { scope: defaultScope })).toEqual(previous);
    await expectReleased(f.session);
  });

  it("closes a never-accepted UUID without a supplier call", async () => {
    const f = await fixture(); await transaction(f); const requestId = randomUUID();
    expect(await store.queryBillAnalysisRequest(f.session, requestId)).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
    expect(await run(f.session, { requestId })).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
    expect(captures).toHaveLength(0); await expectReleased(f.session);
  });

  it("does not call the supplier for disabled AI or an empty period", async () => {
    const disabled = await fixture(false); await transaction(disabled);
    expect(await run(disabled.session)).toMatchObject({ status: "error", error: "CONSENT_REQUIRED" });
    const empty = await fixture();
    expect(await run(empty.session)).toMatchObject({ status: "error", error: "NO_DATA" });
    expect(captures).toHaveLength(0);
    await expectReleased(disabled.session); await expectReleased(empty.session);
  });

  it("cleans a committed preparation whose dispatch callback fails before any model call", async () => {
    const f = await fixture(); await transaction(f); const requestId = randomUUID();
    expect(await run(f.session, { requestId, onSubmitted: () => { throw new Error("Synthetic dispatch failure"); } })).toMatchObject({ status: "error", error: "UNAVAILABLE" });
    expect(captures).toHaveLength(0);
    expect(await store.queryBillAnalysisRequest(f.session, requestId)).toMatchObject({ status: "error", error: "UNAVAILABLE" });
    await expectReleased(f.session);
  });

  it("releases a committed preparation when activation registration fails", async () => {
    const f = await fixture(); await transaction(f); const requestId = randomUUID();
    const owners = await import("@/lib/reports/bill-analysis-owner");
    const fault = vi.spyOn(owners, "registerBillAnalysisExecution").mockImplementationOnce(() => { throw new Error("Synthetic activation registration failure"); });
    let result: BillAnalysisOutcome | null = null;
    try { result = await run(f.session, { requestId }).catch(() => null); }
    finally { fault.mockRestore(); }
    expect(await raw.resourceLease.count({ where: { householdId: f.session.householdId } })).toBe(0);
    expect(result).toMatchObject({ status: "error", error: "UNAVAILABLE" });
    expect(captures).toHaveLength(0);
    await expectReleased(f.session);
  });

  it("reconciles a committed claim with a lost acknowledgement before invoking the model", async () => {
    const f = await fixture(); await transaction(f); const requestId = randomUUID();
    const original = store.claimBillAnalysisRequest;
    const fault = vi.spyOn(store, "claimBillAnalysisRequest").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("Synthetic claim result unknown");
    });
    try { await expect(run(f.session, { requestId })).rejects.toThrow("Synthetic claim result unknown"); }
    finally { fault.mockRestore(); }
    expect(captures).toHaveLength(0);
    expect(await store.queryBillAnalysisRequest(f.session, requestId)).toMatchObject({ status: "error", error: "INTERRUPTED" });
    await expectReleased(f.session);
  });

  it.each(["dom", "next"] as const)("cancels an in-flight HTTP call for an explicit %s execution abort, records a terminal UUID and releases its lease", async (reason) => {
    const f = await fixture(); await transaction(f); const requestId = randomUUID();
    const entered = deferred(), closed = deferred(); const controller = new AbortController();
    handler = async (_input, response) => { response.once("close", closed.resolve); entered.resolve(); await closed.promise; };
    const pending = run(f.session, { requestId, signal: controller.signal });
    await entered.promise;
    const { ResponseAborted } = createRequire(join(process.cwd(), "package.json"))("next/dist/server/web/spec-extension/adapters/next-request") as { ResponseAborted: new () => Error };
    controller.abort(reason === "next" ? new ResponseAborted() : new DOMException("Synthetic cancellation", "AbortError"));
    expect(await pending).toMatchObject({ status: "error", error: "CANCELLED" });
    await closed.promise;
    expect(await store.queryBillAnalysisRequest(f.session, requestId)).toMatchObject({ status: "error", error: "CANCELLED" });
    expect(captures).toHaveLength(1); await expectReleased(f.session);
  });

  it.each(["session", "mode"] as const)("refuses final persistence after the original %s changes at the provider boundary", async (change) => {
    const f = await fixture(); await transaction(f); const requestId = randomUUID();
    handler = async (input) => {
      if (input.stage !== "batch") return;
      if (change === "session") await raw.appSession.update({ where: { id: f.session.appSessionId }, data: { revokedAt: new Date() } });
      else await raw.householdEncryption.create({ data: { householdId: f.session.householdId, mode: "UNENCRYPTED", revision: 1 } });
    };
    expect((await run(f.session, { requestId })).status).not.toBe("success");
    expect(captures).toHaveLength(1);
    expect(await raw.billAnalysisReport.count({ where: { householdId: f.session.householdId, generatedAt: { not: null } } })).toBe(0);
    expect(await raw.billAnalysisRequest.findFirstOrThrow({ where: { householdId: f.session.householdId, clientRequestId: requestId } })).toMatchObject({ status: "FAILED" });
    await expectReleased(f.session);
  });
});
