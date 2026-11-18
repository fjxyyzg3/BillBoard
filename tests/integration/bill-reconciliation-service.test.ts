import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { BILL_RECONCILIATION_SCHEMA_VERSION, validateBillReconciliationRequest, type BillReconciliationAgentRequest, type BillReconciliationProposal } from "@/lib/reports/bill-reconciliation-protocol";

let raw: PrismaClient, server: Server;
let generateBillAnalysis: typeof import("@/lib/reports/bill-analysis-service").generateBillAnalysis;
let readBillAnalysisReport: typeof import("@/lib/reports/bill-analysis-store").readBillAnalysisReport;
let queryBillReconciliationSnapshot: typeof import("@/lib/reports/bill-reconciliation-snapshot").queryBillReconciliationSnapshot;
let applyBillReconciliation: typeof import("@/lib/reports/bill-reconciliation-application").applyBillReconciliation;
const households: string[] = [], users: string[] = [];
const calls: BillReconciliationAgentRequest[] = [], requestBytes: number[] = [];
const previous = { url: process.env.IMPORT_AGENT_URL, token: process.env.IMPORT_AGENT_TOKEN };
beforeAll(async () => {
  process.loadEnvFile(".env.example");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) throw new Error("Local development database required");
  raw = new PrismaClient();
  ({ generateBillAnalysis } = await import("@/lib/reports/bill-analysis-service"));
  ({ readBillAnalysisReport } = await import("@/lib/reports/bill-analysis-store"));
  ({ queryBillReconciliationSnapshot } = await import("@/lib/reports/bill-reconciliation-snapshot"));
  ({ applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application"));
  const token = randomUUID();
  server = createServer(async (request, response) => {
    if (request.url !== "/reconcile-bill" || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = validateBillReconciliationRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      calls.push(input);
      requestBytes.push(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      const expenses = input.rows.filter((row) => row.type === "expense"), incomes = input.rows.filter((row) => row.type === "income");
      const groups: BillReconciliationProposal[] = expenses.length === 2 && incomes.length === 1
        ? [{ kind: "combined", title: "Synthetic reconciliation", reason: "Payment id SERVICE-001", confidence: "high", evidenceRefs: input.rows.map((row) => row.ref), duplicateGroups: [expenses.map((row) => row.ref)], offset: { expenseRef: expenses[0].ref, incomeRefs: [incomes[0].ref], kind: "refund" } }]
        : expenses.length === 2 && incomes.length === 0 && expenses.every((row) => row.note?.includes("IMPORT-VERIFY001"))
          ? [{ kind: "duplicate", title: "Synthetic imported duplicate", reason: "Payment id IMPORT-VERIFY001", confidence: "high", evidenceRefs: expenses.map((row) => row.ref), duplicateGroups: [expenses.map((row) => row.ref)], offset: null }]
          : [];
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ schemaVersion: BILL_RECONCILIATION_SCHEMA_VERSION, batchId: input.batchId, groups }));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind");
  process.env.IMPORT_AGENT_URL = `http://127.0.0.1:${address.port}`;
  process.env.IMPORT_AGENT_TOKEN = token;
});
beforeEach(async () => { calls.length = 0; requestBytes.length = 0; await raw.resourceWindow.deleteMany({}); });
afterEach(async () => {
  await raw.billReconciliationApplication.deleteMany({ where: { householdId: { in: households } } });
  await raw.billAnalysisRequest.deleteMany({ where: { householdId: { in: households } } });
  await raw.billAnalysisReport.deleteMany({ where: { householdId: { in: households } } });
  await raw.household.deleteMany({ where: { id: { in: households.splice(0) } } });
  await raw.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await raw?.$disconnect();
  if (previous.url === undefined) delete process.env.IMPORT_AGENT_URL; else process.env.IMPORT_AGENT_URL = previous.url;
  if (previous.token === undefined) delete process.env.IMPORT_AGENT_TOKEN; else process.env.IMPORT_AGENT_TOKEN = previous.token;
});

async function fixture() {
  const household = await raw.household.create({ data: { name: "Synthetic reconciliation service" } }); households.push(household.id);
  const user = await raw.user.create({ data: { email: `reconcile-service-${randomUUID()}@example.com`, displayName: "Owner", passwordHash: "not-used", aiProcessingEnabled: true } }); users.push(user.id);
  const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, role: "OWNER", memberName: "Owner" } });
  const ledger = await raw.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const appSession = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
  const expense = await raw.category.findFirstOrThrow({ where: { type: "EXPENSE", isActive: true } }), income = await raw.category.findFirstOrThrow({ where: { type: "INCOME", isActive: true } });
  await raw.transaction.createMany({ data: [
    ...[0, 1].map(() => ({ householdId: household.id, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: expense.id, type: "EXPENSE" as const, amountFen: 10000, occurredAt: new Date("2026-01-01T04:00:00Z"), note: "Payment id SERVICE-001" })),
    { householdId: household.id, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: income.id, type: "INCOME", amountFen: 3000, occurredAt: new Date("2026-02-01T04:00:00Z"), note: "Refund payment id SERVICE-001" },
  ] });
  return { session: { id: user.id, householdId: household.id, memberId: member.id, appSessionId: appSession.id }, ledger, member, expense };
}
const scope = { mode: "year" as const, period: "2026", ledgerId: null, actorMemberId: null };

it("generates a versioned private reconciliation and atomically applies the same net preview", async () => {
  const { session } = await fixture();
  const requestId = randomUUID();
  const result = await generateBillAnalysis(session, { requestId, scope, locale: "zh-CN", purpose: "reconciliation" }, new AbortController().signal, () => undefined);
  expect(result).toMatchObject({ status: "success", generation: 1 });
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain(session.householdId);
  expect(JSON.stringify(calls)).not.toContain("sourceFingerprint");
  const report = await readBillAnalysisReport(session, { scope, purpose: "reconciliation" });
  if (!report || !("purpose" in report) || report.purpose !== "reconciliation") throw new Error("Expected reconciliation report");
  expect(report.suggestions).toHaveLength(1);
  expect(report.suggestions[0]).toMatchObject({ kind: "combined", canApply: true, defaultSelected: true });
  expect(report).not.toHaveProperty("assertions");
  const application = await applyBillReconciliation(session, { requestId: randomUUID(), reportId: report.id, generation: report.generation, suggestionIds: [report.suggestions[0].id] });
  expect(application).toMatchObject({ status: "success", preview: { after: { expenseFen: 7000, incomeFen: 0, netFen: -7000, transactionCount: 1 } } });
  const visible = await raw.transaction.findMany({ where: { householdId: session.householdId, deletedAt: null } });
  expect(visible).toHaveLength(1); expect(visible[0]).toMatchObject({ amountFen: 7000, note: "Payment id SERVICE-001" });
  const refreshed = await readBillAnalysisReport(session, { reportId: report.id });
  expect(refreshed).toMatchObject({ suggestions: [{ applied: true, canApply: false, defaultSelected: false }] });
});

it("retains daily bank precision, declines unproven import offsets, and excludes other scopes", async () => {
  const { session, ledger, member, expense } = await fixture();
  const bank = await raw.transaction.create({ data: { householdId: session.householdId, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: expense.id, type: "EXPENSE", amountFen: 1000, occurredAt: new Date("2026-03-01T16:00:00Z"), source: "cmb", sourceFingerprint: "a".repeat(64), sourceImportedAt: new Date(), note: "Synthetic bank counterparty" } });
  const outside = await raw.transaction.create({ data: { householdId: session.householdId, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: expense.id, type: "EXPENSE", amountFen: 900, occurredAt: new Date("2025-12-01T04:00:00Z"), note: "Outside selected year" } });
  const snapshot = await queryBillReconciliationSnapshot(session, scope, "zh-CN");
  expect(snapshot.rows.find((row) => row.id === bank.id)).toMatchObject({ timePrecision: "day", timeSupplemented: true, offsetEvidence: "unknown" });
  expect(snapshot.rows.some((row) => row.id === outside.id)).toBe(false);
  expect(calls).toHaveLength(0);
});

it("completes 10,000 records and four full bridge groups through the bounded loopback Agent", async () => {
  const { session, ledger, member, expense } = await fixture();
  await raw.transaction.deleteMany({ where: { householdId: session.householdId } });
  for (let start = 0; start < 10_000; start += 500) {
    await raw.transaction.createMany({ data: Array.from({ length: 500 }, (_, offset) => {
      const index = start + offset;
      return { householdId: session.householdId, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id,
        categoryId: expense.id, type: "EXPENSE" as const, amountFen: index < 2000 ? 6000 + index % 4 : 10_000 + index,
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        note: index < 2000 ? `Receipt PAY-GROUP${index % 4}` : `Independent purchase ${index}` };
    }) });
  }
  const startedAt = Date.now();
  const result = await generateBillAnalysis(session, { requestId: randomUUID(), scope, locale: "en-US", purpose: "reconciliation" }, new AbortController().signal, () => undefined);
  expect(result).toMatchObject({ status: "success", generation: 1 });
  const contexts = calls.filter((call) => call.stage === "context"), candidates = calls.filter((call) => call.stage === "candidate");
  expect(contexts).toHaveLength(20);
  expect(candidates).toHaveLength(4);
  expect(calls).toHaveLength(24);
  expect(calls.map((call) => call.batchId)).toEqual(Array.from({ length: 24 }, (_, index) => `b${index + 1}`));
  expect(calls.every((call) => call.batchCount === 24 && call.rows.length === 500)).toBe(true);
  const covered = contexts.flatMap((call) => call.rows.map((row) => row.ref));
  expect(covered).toHaveLength(10_000);
  expect(new Set(covered).size).toBe(10_000);
  expect(candidates.every((call) => new Set(call.rows.map((row) => row.note)).size === 1)).toBe(true);
  expect(requestBytes.every((bytes) => bytes <= 256 * 1024)).toBe(true);
  const inputBytes = requestBytes.reduce((sum, bytes) => sum + bytes, 0);
  expect(inputBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(await raw.transaction.count({ where: { householdId: session.householdId, deletedAt: null } })).toBe(10_000);
  const report = await readBillAnalysisReport(session, { scope, purpose: "reconciliation" });
  expect(report).toMatchObject({ purpose: "reconciliation", generation: 1, records: [], suggestions: [] });
  console.info(JSON.stringify({ fixture: "loopback-structured-empty-findings", records: 10_000, inputBytes,
    contextBatches: contexts.length, candidateBatches: candidates.length, calls: calls.length, elapsedMs: Date.now() - startedAt, completed: true }));
}, 210_000);

it("preserves imported identities after applying a duplicate and blocks both source files from reviving it", async () => {
  const { session, expense } = await fixture();
  const ledger = await raw.ledger.findFirstOrThrow({ where: { householdId: session.householdId } });
  await raw.transaction.deleteMany({ where: { householdId: session.householdId } });
  const services = await import("@/lib/imports/drafts");
  const sessionUser = { ...session, ledgerId: ledger.id };
  const context = { householdId: session.householdId, memberId: session.memberId, ledgerId: ledger.id };
  const workbook = async (rows: unknown[][]) => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Sheet1").addRows(rows);
    return Buffer.from(await book.xlsx.writeBuffer());
  };
  const suiBook = new ExcelJS.Workbook();
  suiBook.addWorksheet("支出").addRows([
    ["交易类型", "日期", "一级分类", "二级分类", "账户1", "账户币种", "金额", "成员", "商家", "记账人", "备注"],
    ["支出", "2026-05-06 13:23:02", "餐饮", "三餐", "现金", "CNY", "176", "Owner", "Synthetic store", "Owner", "Payment id IMPORT-VERIFY001"],
  ]);
  const suiBuffer = Buffer.from(await suiBook.xlsx.writeBuffer());
  const wechatBuffer = await workbook([
    ["微信支付账单明细"], ["微信昵称：[Owner]"], [],
    ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"],
    ["2026-05-06 13:23:02", "扫二维码付款", "Synthetic store", "Payment id IMPORT-VERIFY001", "支出", "176", "零钱", "支付成功", "IMPORT-VERIFY001", "merchant-IMPORT-VERIFY001", "/"],
  ]);
  const importers = [
    { create: services.createSuiShouJiImportDraft, buffer: suiBuffer, source: "sui_shou_ji" },
    { create: services.createWechatPayImportDraft, buffer: wechatBuffer, source: "wechat_pay" },
  ];
  for (const importer of importers) {
    const draft = await importer.create({ context, buffer: importer.buffer, fileName: "synthetic.xlsx", sessionUser });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);
    await services.saveImportDraftMappings(draft.id, summary.missingMappings.map((mapping) => ({ mappingKey: mapping.mappingKey, categoryId: expense.id })), sessionUser);
    if (importer.source === "wechat_pay") await services.saveWechatPayDraftOwnerMember(draft.id, session.memberId, sessionUser);
    else await services.saveImportDraftMemberMappings(draft.id, [{ externalName: "Owner", memberId: session.memberId }], sessionUser);
    await services.setImportDraftRowDecision(draft.id, summary.rows[0].id, "KEEP", sessionUser);
    expect(await services.confirmImportDraft(draft.id, sessionUser)).toMatchObject({ createdCount: 1 });
  }
  // Sui Shou Ji does not retain raw notes; model an explicit user-added payment reference.
  await raw.transaction.updateMany({ where: { householdId: session.householdId, source: "sui_shou_ji" }, data: { note: "Payment id IMPORT-VERIFY001" } });
  const originals = await raw.transaction.findMany({ where: { householdId: session.householdId }, orderBy: { id: "asc" } });
  expect(originals).toHaveLength(2);
  const immutable = (row: typeof originals[number]) => ({ id: row.id, clientRequestId: row.clientRequestId, source: row.source, sourceFingerprint: row.sourceFingerprint,
    sourceImportedAt: row.sourceImportedAt, occurredAt: row.occurredAt, categoryId: row.categoryId, actorMemberId: row.actorMemberId, createdByMemberId: row.createdByMemberId, note: row.note });
  expect(await generateBillAnalysis(session, { requestId: randomUUID(), scope, locale: "en-US", purpose: "reconciliation" }, new AbortController().signal, () => undefined)).toMatchObject({ status: "success" });
  const report = await readBillAnalysisReport(session, { scope, purpose: "reconciliation" });
  if (!report || !("purpose" in report) || report.purpose !== "reconciliation") throw new Error("Expected imported reconciliation");
  expect(report.suggestions).toHaveLength(1);
  expect(report.suggestions[0]).toMatchObject({ kind: "duplicate", canApply: true });
  expect(await applyBillReconciliation(session, { requestId: randomUUID(), reportId: report.id, generation: report.generation, suggestionIds: [report.suggestions[0].id] })).toMatchObject({ status: "success" });
  const after = await raw.transaction.findMany({ where: { householdId: session.householdId }, orderBy: { id: "asc" } });
  expect(after.map(immutable)).toEqual(originals.map(immutable));
  expect(after.filter((row) => row.deletedAt !== null)).toHaveLength(1);
  expect(after.find((row) => row.source === "sui_shou_ji")?.deletedAt).not.toBeNull();
  for (const importer of importers) {
    const draft = await importer.create({ context, buffer: importer.buffer, fileName: "synthetic-again.xlsx", sessionUser });
    expect((await services.getImportDraftSummary(draft.id, sessionUser)).counts.sourceDuplicate).toBe(1);
    expect(await services.confirmImportDraft(draft.id, sessionUser)).toMatchObject({ createdCount: 0, sourceDuplicateCount: 1 });
  }
  expect(await raw.transaction.count({ where: { householdId: session.householdId } })).toBe(2);
  expect(await raw.transaction.count({ where: { householdId: session.householdId, deletedAt: null } })).toBe(1);
}, 30_000);
