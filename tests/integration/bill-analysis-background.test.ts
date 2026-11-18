import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSessionUser } from "@/lib/auth/app-sessions";
import { createHouseholdCode, createKeyRing, encodeHouseholdCode, sealKeyRing } from "@/lib/encryption/crypto";
import { encryptRow } from "@/lib/encryption/protected-models";
import { getEncryptionContext, type EncryptionRequestContext } from "@/lib/encryption/request-context";
import { BILL_ANALYSIS_SCHEMA_VERSION, BILL_ANALYSIS_TOTAL_TIMEOUT_MS, validateBillAnalysisRequest, type BillAnalysisAgentRequest } from "@/lib/reports/bill-analysis-protocol";
import type { BillAnalysisScope } from "@/lib/reports/bill-analysis-types";

let activeSessionId: string | null = null;
let loadSession: typeof import("@/lib/auth/app-sessions").loadValidAppSessionUser;
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "http://127.0.0.1:2511", host: "127.0.0.1:2511", "sec-fetch-site": "same-origin" }) }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: async () => {
  const session = activeSessionId ? await loadSession(activeSessionId) : null;
  if (!session) throw new Error("Unauthorized");
  return session;
} }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type AgentHandler = (input: BillAnalysisAgentRequest, response: ServerResponse) => Promise<void>;

describe("background bill analysis with real encryption, PostgreSQL and HTTP", () => {
  let raw: PrismaClient;
  let database: typeof import("@/lib/db").db;
  let encryption: typeof import("@/lib/encryption/request");
  let taskContexts: typeof import("@/lib/reports/bill-analysis-task-context");
  let runtime: typeof import("@/lib/reports/bill-analysis-runtime");
  let owner: typeof import("@/lib/reports/bill-analysis-owner");
  let store: typeof import("@/lib/reports/bill-analysis-store");
  let server: Server;
  let categoryId: string;
  let handler: AgentHandler = async () => undefined;
  const captures: BillAnalysisAgentRequest[] = [];
  const handlerErrors: Error[] = [];
  const householdIds: string[] = [], userIds: string[] = [], memberIds: string[] = [];
  const runs: Array<{ session: AppSessionUser; requestId: string; completion: Promise<void> }> = [];
  const gates: Array<ReturnType<typeof deferred>> = [];
  const previousEnvironment = { url: process.env.IMPORT_AGENT_URL, token: process.env.IMPORT_AGENT_TOKEN };
  const scope: BillAnalysisScope = { mode: "month", period: "2021-07", ledgerId: null, actorMemberId: null };
  let overview: string;

  beforeAll(async () => {
    process.loadEnvFile(".env.example");
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
      throw new Error("Background analysis tests require a local development/test database");
    }
    raw = new PrismaClient();
    ({ db: database } = await import("@/lib/db"));
    ({ loadValidAppSessionUser: loadSession } = await import("@/lib/auth/app-sessions"));
    encryption = await import("@/lib/encryption/request");
    taskContexts = await import("@/lib/reports/bill-analysis-task-context");
    runtime = await import("@/lib/reports/bill-analysis-runtime");
    owner = await import("@/lib/reports/bill-analysis-owner");
    store = await import("@/lib/reports/bill-analysis-store");
    categoryId = (await raw.category.create({ data: { name: `Synthetic background category ${randomUUID()}`, type: "EXPENSE", sortOrder: 9999 } })).id;
    const token = randomBytes(32).toString("hex");
    server = createServer(async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== "/analyze-bill" || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const value of request) {
          const chunk = Buffer.from(value);
          bytes += chunk.length;
          if (bytes > 256 * 1024) throw new Error("The synthetic Agent input exceeded its bound");
          chunks.push(chunk);
        }
        const input = validateBillAnalysisRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        captures.push(input);
        await handler(input, response);
        if (response.destroyed || response.writableEnded) return;
        const evidence = input.stage === "batch" ? input.rows[0]?.ref : input.evidence[0]?.ref;
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, batchId: input.batchId,
          body: { overview, observations: [{ title: "Recorded expense", detail: "Review this synthetic recorded expense.", evidenceRefs: ["current.expenseFen", ...(evidence ? [evidence] : [])] }], recommendations: [], limitations: ["Synthetic recorded transactions only"] },
        }));
      } catch (error) {
        handlerErrors.push(error as Error);
        if (!response.destroyed && !response.writableEnded) response.writeHead(503).end();
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The synthetic Agent did not bind loopback");
    process.env.IMPORT_AGENT_URL = `http://127.0.0.1:${address.port}`;
    process.env.IMPORT_AGENT_TOKEN = token;
  });

  beforeEach(async () => {
    if (await raw.resourceLease.count({ where: { kind: "ai" } })) throw new Error("Background analysis tests require idle AI workers");
    await raw.resourceWindow.deleteMany({ where: { kind: "ai" } });
    handler = async () => undefined;
    captures.length = 0;
    handlerErrors.length = 0;
    overview = `Synthetic encrypted review ${randomUUID()}`;
  });

  afterEach(async () => {
    activeSessionId = null;
    for (const run of runs) owner.abortBillAnalysisExecution(run.session, run.requestId);
    for (const gate of gates.splice(0)) gate.resolve();
    await Promise.all(runs.splice(0).map((run) => run.completion));
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
    if (server) await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    if (categoryId) await raw.category.delete({ where: { id: categoryId } });
    await raw?.$disconnect();
  });

  async function fixture() {
    const household = await raw.household.create({ data: { name: "Synthetic encrypted background family" } }); householdIds.push(household.id);
    const user = await raw.user.create({ data: { email: `background-analysis-${randomUUID()}@example.test`, displayName: "Synthetic owner", passwordHash: "not-used", aiProcessingEnabled: true } }); userIds.push(user.id);
    const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, role: "OWNER", memberName: "Synthetic owner" } }); memberIds.push(member.id);
    const ledger = await raw.ledger.create({ data: { householdId: household.id, name: "Synthetic encrypted ledger", isDefault: true } });
    const appSession = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 1_800_000) } });
    const code = createHouseholdCode(household.id), ring = createKeyRing(code);
    const sealed = await sealKeyRing(code, ring);
    const protectedLedger = await encryptRow("ledger", ledger, ring, household.id, "");
    await raw.ledger.update({ where: { id: ledger.id }, data: { name: String(protectedLedger.name), encryptedPayload: String(protectedLedger.encryptedPayload), encryptionRevision: String(protectedLedger.encryptionRevision) } });
    await raw.householdEncryption.create({ data: { householdId: household.id, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: code.keyVersion, sealedKeyRing: sealed } });
    for (const key of ring.keys) key.secret = "";
    const session = await loadSession(appSession.id);
    if (!session) throw new Error("Synthetic original session is invalid");
    activeSessionId = session.appSessionId;
    const input = { code: encodeHouseholdCode(code), revision: 1 };
    const note = `Synthetic private note ${randomUUID()}`;
    await encryption.withHouseholdEncryption(input, async () => database.transaction.create({ data: {
      householdId: household.id, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id,
      categoryId, type: "EXPENSE", amountFen: 12345, occurredAt: new Date("2021-07-05T12:00:00+08:00"), note,
    } }));
    return { session, input, note, codeSecret: code.secret };
  }

  function submit(session: AppSessionUser, context: EncryptionRequestContext, startedAt = Date.now(), requestId = randomUUID()) {
    let completion!: Promise<void>;
    const receipt = runtime.submitBillAnalysisTask(session, { requestId, scope, locale: "zh-CN" }, context, startedAt, (tracked) => { completion = tracked; });
    runs.push({ session, requestId, completion });
    return { requestId, receipt, completion };
  }

  async function expectReleased(session: AppSessionUser) {
    expect(await raw.resourceLease.count({ where: { householdId: session.householdId } })).toBe(0);
    expect(await raw.resourceExecution.count({ where: { lease: { householdId: session.householdId } } })).toBe(0);
    expect(await raw.billAnalysisReport.count({ where: { householdId: session.householdId, activeRequestId: { not: null } } })).toBe(0);
  }

  it("finishes after submission and another encrypted request end, then destroys its exclusive key ring", async () => {
    const f = await fixture();
    const startedAt = Date.now();
    let submissionContext!: EncryptionRequestContext;
    let submissionKeys!: NonNullable<EncryptionRequestContext["ring"]>["keys"];
    const context = await encryption.withHouseholdEncryption(f.input, async () => {
      submissionContext = getEncryptionContext()!;
      submissionKeys = [...submissionContext.ring!.keys];
      return taskContexts.createBillAnalysisTaskContext(f.session, f.input, startedAt);
    });
    const taskRing = context.ring!;
    const taskKeys = [...taskRing.keys];
    const secrets = taskKeys.map((key) => key.secret);
    expect(submissionContext).toMatchObject({ disposed: true, ring: null });
    expect(submissionKeys.every((key) => key.secret === "")).toBe(true);
    expect(taskKeys.every((key) => key.secret.length > 0)).toBe(true);
    expect(context.expiresAt).toBe(startedAt + 10 * 60_000);

    const entered = deferred(), release = deferred(); gates.push(release);
    handler = async (input, response) => {
      if (input.stage !== "batch") return;
      entered.resolve();
      await Promise.race([release.promise, new Promise<void>((resolve) => response.once("close", resolve))]);
    };
    const run = submit(f.session, context, startedAt);
    expect(await run.receipt).toMatchObject({ requestId: run.requestId, status: "processing" });
    await entered.promise;
    const running = await raw.billAnalysisRequest.findFirstOrThrow({ where: { householdId: f.session.householdId, clientRequestId: run.requestId } });
    expect(running).toMatchObject({ status: "RUNNING", originalAppSessionId: f.session.appSessionId, deadlineAt: new Date(startedAt + BILL_ANALYSIS_TOTAL_TIMEOUT_MS) });
    expect(await raw.resourceExecution.findUniqueOrThrow({ where: { token: running.leaseToken! } })).toMatchObject({ chargedCalls: 1 });

    let otherContext!: EncryptionRequestContext;
    let otherKeys!: NonNullable<EncryptionRequestContext["ring"]>["keys"];
    await encryption.withHouseholdEncryption(f.input, async (session) => {
      otherContext = getEncryptionContext()!;
      otherKeys = [...otherContext.ring!.keys];
      expect(otherContext.ring).not.toBe(taskRing);
      expect(otherKeys[0]).not.toBe(taskKeys[0]);
      const entries = await store.listBillAnalysisEntries(session);
      expect(entries.active?.task).toMatchObject({ requestId: run.requestId, canCancel: true, status: "processing", phase: "analyzing", completedBatches: 0, totalBatches: 1 });
      expect(await database.transaction.findFirst({ where: { householdId: session.householdId, deletedAt: null }, select: { note: true } })).toEqual({ note: f.note });
    }, { readOnly: true });
    expect(otherContext).toMatchObject({ disposed: true, ring: null });
    expect(otherKeys.every((key) => key.secret === "")).toBe(true);
    expect(context.disposed).toBe(false);
    expect(taskKeys.map((key) => key.secret)).toEqual(secrets);

    const duplicate = await taskContexts.createBillAnalysisTaskContext(f.session, f.input, startedAt);
    const duplicateKeys = [...duplicate.ring!.keys];
    expect(await runtime.submitBillAnalysisTask(f.session, { requestId: run.requestId, scope, locale: "zh-CN" }, duplicate, Date.now(), () => { throw new Error("A duplicate must not register another task"); })).toMatchObject({ requestId: run.requestId, status: "processing" });
    expect(duplicate).toMatchObject({ disposed: true, ring: null });
    expect(duplicateKeys.every((key) => key.secret === "")).toBe(true);
    expect(captures.map((input) => input.stage)).toEqual(["batch"]);
    release.resolve();
    await run.completion;

    expect(context).toMatchObject({ disposed: true, ring: null });
    expect(taskKeys.every((key) => key.secret === "")).toBe(true);
    expect(captures.map((input) => input.stage)).toEqual(["batch", "summary"]);
    await encryption.withHouseholdEncryption(f.input, async (session) => {
      expect(await store.queryBillAnalysisRequest(session, run.requestId)).toMatchObject({ status: "success", generation: 1 });
      expect(await store.readBillAnalysisReport(session, { scope })).toMatchObject({ body: { overview } });
      const request = await database.billAnalysisRequest.findUniqueOrThrow({ where: { id: running.id } });
      expect(Object.keys(request.definition as object).sort()).toEqual(["inputHash", "locale", "progress", "range", "scope", "snapshotAt"]);
      expect(JSON.stringify(request.definition)).not.toContain(f.note);
    });
    const persisted = JSON.stringify(await Promise.all([
      raw.billAnalysisRequest.findMany({ where: { householdId: f.session.householdId } }),
      raw.billAnalysisReport.findMany({ where: { householdId: f.session.householdId } }),
      raw.transaction.findMany({ where: { householdId: f.session.householdId } }),
      raw.householdEncryption.findMany({ where: { householdId: f.session.householdId } }),
    ]));
    for (const secret of [f.note, overview, f.input.code, f.codeSecret, ...secrets]) expect(persisted).not.toContain(secret);
    await expect(taskContexts.createBillAnalysisTaskContext(f.session, f.input, Date.now() - 10 * 60_000)).rejects.toMatchObject({ code: "ENCRYPTION_EXPIRED" });
    await expectReleased(f.session);
  }, 20_000);

  it("stops a detached HTTP request after the original session is revoked and clears task keys", async () => {
    const f = await fixture();
    const context = await taskContexts.createBillAnalysisTaskContext(f.session, f.input, Date.now());
    const keys = [...context.ring!.keys];
    const entered = deferred(), closed = deferred();
    handler = async (_input, response) => { response.once("close", closed.resolve); entered.resolve(); await closed.promise; };
    const run = submit(f.session, context);
    expect(await run.receipt).toMatchObject({ status: "processing" });
    await entered.promise;
    await raw.appSession.update({ where: { id: f.session.appSessionId }, data: { revokedAt: new Date() } });
    await run.completion;
    await closed.promise;
    expect(await raw.billAnalysisRequest.findFirstOrThrow({ where: { householdId: f.session.householdId, clientRequestId: run.requestId } })).toMatchObject({ status: "FAILED" });
    expect(await raw.billAnalysisReport.count({ where: { householdId: f.session.householdId, generatedAt: { not: null } } })).toBe(0);
    expect(captures.map((input) => input.stage)).toEqual(["batch"]);
    expect(context).toMatchObject({ disposed: true, ring: null });
    expect(keys.every((key) => key.secret === "")).toBe(true);
    await expectReleased(f.session);
  }, 20_000);

  it("rejects an expired original total budget before registering a replacement task", async () => {
    const f = await fixture();
    const startedAt = Date.now() - BILL_ANALYSIS_TOTAL_TIMEOUT_MS - 1;
    const context = await taskContexts.createBillAnalysisTaskContext(f.session, f.input, startedAt);
    const keys = [...context.ring!.keys];
    const run = submit(f.session, context, startedAt);
    expect(await run.receipt).toMatchObject({ requestId: run.requestId, status: "error", error: "TIMEOUT" });
    await run.completion;
    expect(await raw.billAnalysisRequest.count({ where: { householdId: f.session.householdId, clientRequestId: run.requestId } })).toBe(0);
    expect(captures).toHaveLength(0);
    expect(context).toMatchObject({ disposed: true, ring: null });
    expect(keys.every((key) => key.secret === "")).toBe(true);
    await expectReleased(f.session);
  }, 20_000);
});
