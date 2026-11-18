import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("manual reconciliation", () => {
  let raw: PrismaClient;
  const households: string[] = [], users: string[] = [];
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) throw new Error("Manual reconciliation requires a local development database");
    raw = new PrismaClient();
  });
  afterEach(async () => {
    await raw.billReconciliationApplication.deleteMany({ where: { householdId: { in: households } } });
    await raw.billAnalysisRequest.deleteMany({ where: { householdId: { in: households } } });
    await raw.billAnalysisReport.deleteMany({ where: { householdId: { in: households } } });
    await raw.household.deleteMany({ where: { id: { in: households.splice(0) } } });
    await raw.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  });
  afterAll(async () => { await raw?.$disconnect(); });

  async function fixture(count = 4) {
    const household = await raw.household.create({ data: { name: "Synthetic manual reconciliation" } });
    households.push(household.id);
    const user = await raw.user.create({ data: { email: `manual-${randomUUID()}@example.com`, displayName: "Owner", passwordHash: "not-used" } });
    users.push(user.id);
    const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, role: "OWNER", memberName: "Owner" } });
    const ledger = await raw.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
    const appSession = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
    const category = await raw.category.findFirstOrThrow({ where: { type: "EXPENSE", isActive: true } });
    const rows = await raw.transaction.createManyAndReturn({ data: Array.from({ length: count }, (_, index) => ({
      householdId: household.id, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: category.id,
      type: "EXPENSE" as const, amountFen: 1200, occurredAt: new Date(Date.parse("2026-01-01T04:00:00.000Z") + index * 86_400_000), note: `Synthetic purchase ${index + 1}`, clientRequestId: randomUUID(),
    })) });
    const session = { id: user.id, householdId: household.id, memberId: member.id, appSessionId: appSession.id };
    const { db } = await import("@/lib/db");
    const { loadReconciliationRows } = await import("@/lib/reports/bill-reconciliation-snapshot");
    const loaded = await db.$transaction((tx) => loadReconciliationRows(tx, household.id, rows.map((row) => row.id)));
    const { prepareBillReconciliation, buildBillReconciliationContent } = await import("@/lib/reports/bill-reconciliation-prepare");
    const { BILL_RECONCILIATION_SCHEMA_VERSION } = await import("@/lib/reports/bill-reconciliation-protocol");
    const prepared = prepareBillReconciliation({ scope: { mode: "year", period: "2026", ledgerId: ledger.id, actorMemberId: null }, locale: "en-US", range: { from: "2026-01-01", to: "2026-12-31" }, snapshotAt: new Date().toISOString(), rows: loaded });
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: BILL_RECONCILIATION_SCHEMA_VERSION, batchId: batch.batchId,
      groups: [{ kind: "notice", title: "Synthetic duplicate clue", reason: "Dates cannot prove that these are the same purchase", evidenceRefs: batch.rows.map((row) => row.ref), confidence: "review", duplicateGroups: [], offset: null }] })));
    const { parseBillReconciliationContent } = await import("@/lib/reports/bill-reconciliation-protocol");
    expect(parseBillReconciliationContent(content)).toEqual(content);
    const report = await raw.billAnalysisReport.create({ data: { householdId: household.id, createdByMemberId: member.id, generation: 1, generatedAt: new Date(),
      definition: { purpose: "reconciliation", version: 1, scope: { mode: "year", period: "2026", ledgerId: ledger.id, actorMemberId: null } }, content: JSON.parse(JSON.stringify(content)) } });
    const input = { version: 2 as const, requestId: randomUUID(), reportId: report.id, generation: 1, suggestionIds: [] as string[], manualGroups: [{ noticeId: "s1", refs: ["r1", "r2"], keepRef: "r2" }] };
    return { session, report, input, rows, ledger, content };
  }

  async function refresh(f: Awaited<ReturnType<typeof fixture>>) {
    const { db } = await import("@/lib/db");
    const { loadReconciliationRows } = await import("@/lib/reports/bill-reconciliation-snapshot");
    const latest = await db.$transaction((tx) => loadReconciliationRows(tx, f.session.householdId, Object.values(f.content.assertions).map((row) => row.id)));
    for (const record of f.content.records) {
      const source = latest.find((row) => row.id === f.content.assertions[record.ref].id)!;
      f.content.assertions[record.ref] = source;
      Object.assign(record, { amountFen: source.amountFen, type: source.type.toLowerCase(), note: source.note, source: source.source, memberLabel: source.memberLabel, ledgerLabel: source.ledgerLabel, categoryName: source.categoryName });
    }
    for (const suggestion of f.content.suggestions) if (suggestion.kind === "notice") suggestion.actions = suggestion.evidenceRefs.map((ref) => ({ ref, action: "keep", amountFen: f.content.assertions[ref].amountFen }));
    const { parseBillReconciliationContent } = await import("@/lib/reports/bill-reconciliation-protocol");
    parseBillReconciliationContent(f.content);
    await raw.billAnalysisReport.update({ where: { id: f.report.id }, data: { content: JSON.parse(JSON.stringify(f.content)) } });
  }

  async function mixedFixture() {
    const f = await fixture();
    const income = await raw.category.findFirstOrThrow({ where: { type: "INCOME", isActive: true } });
    await raw.transaction.update({ where: { id: f.rows[2].id }, data: { note: "Order SYNTHETIC-MIXED-1" } });
    await raw.transaction.update({ where: { id: f.rows[3].id }, data: { type: "INCOME", categoryId: income.id, amountFen: 300, note: "Order SYNTHETIC-MIXED-1 refund" } });
    await refresh(f);
    f.content.suggestions.push({ id: "s2", kind: "refund", title: "Synthetic refund", reason: "Matching synthetic order", evidenceRefs: ["r3", "r4"], confidence: "review", defaultSelected: false, canApply: true, readOnlyReason: null,
      relations: { duplicateGroups: [], offset: { expenseRef: "r3", incomeRefs: ["r4"], kind: "refund" } }, actions: [{ ref: "r3", action: "update", amountFen: 900 }, { ref: "r4", action: "delete", amountFen: 300 }] });
    await refresh(f);
    f.input.suggestionIds = ["s2"];
    return f;
  }

  async function archiveLedger(f: Awaited<ReturnType<typeof fixture>>) {
    await raw.$transaction(async (tx) => {
      await tx.ledger.update({ where: { id: f.ledger.id }, data: { isDefault: false } });
      await tx.ledger.create({ data: { householdId: f.session.householdId, name: "Current default", isDefault: true } });
      await tx.ledger.update({ where: { id: f.ledger.id }, data: { archivedAt: new Date() } });
    });
  }

  function retentionInput(f: Awaited<ReturnType<typeof fixture>>, refs = ["r1", "r2", "r3"], keepRefs = ["r1", "r3"]) {
    return { ...f.input, version: 3 as const, manualGroups: [{ noticeId: "s1", refs, keepRefs }] };
  }

  it("preserves a validated v3 selection through the real same-origin HTTP and database boundary", async () => {
    const f = await fixture();
    vi.doMock("@/lib/auth/session", () => ({ requireAppSession: async () => ({ ...f.session, role: "OWNER" }) }));
    vi.doMock("@/lib/i18n-server", () => ({ getServerLocale: async () => "en-US" }));
    try {
      const { POST } = await import("@/app/api/reports/reconcile/route");
      const input = retentionInput(f);
      const response = await POST(new Request("http://127.0.0.1:2500/api/reports/reconcile", {
        method: "POST", headers: { origin: "http://127.0.0.1:2500", host: "127.0.0.1:2500", "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ operation: "apply", ...input }),
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ result: { status: "success", version: 3, manualGroups: input.manualGroups } });
      expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(3);
    } finally {
      vi.doUnmock("@/lib/auth/session");
      vi.doUnmock("@/lib/i18n-server");
    }
  });

  it("retains several explicit v3 records unchanged and projects every submitted participant", async () => {
    const f = await fixture(5), input = retentionInput(f);
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    const { readBillAnalysisReport } = await import("@/lib/reports/bill-analysis-store");
    const result = await applyBillReconciliation(f.session, input);
    expect(result).toMatchObject({ status: "success", version: 3, manualGroups: input.manualGroups,
      preview: { delta: { incomeFen: 0, expenseFen: -1200, netFen: 1200, transactionCount: -1 } } });
    expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[0].id } })).toEqual(f.rows[0]);
    expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[2].id } })).toEqual(f.rows[2]);
    expect((await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[1].id } })).deletedAt).not.toBeNull();
    const receipt = await raw.billReconciliationApplication.findFirstOrThrow({ where: { householdId: f.session.householdId } });
    expect(receipt.definition).toMatchObject({ version: 3, consumedIncomeIds: [], manualGroups: [{
      keepTransactionIds: [f.rows[0].id, f.rows[2].id], deletedTransactionIds: [f.rows[1].id],
    }] });
    const report = await readBillAnalysisReport(f.session, { reportId: f.report.id });
    expect(report).toMatchObject({ manualReview: { records: [
      { ref: "r1", status: "handled" }, { ref: "r2", status: "handled" }, { ref: "r3", status: "handled" },
      { ref: "r4", status: "available" }, { ref: "r5", status: "available" },
    ] } });
    expect(JSON.stringify(report)).not.toContain(f.rows[0].id);
    expect(await applyBillReconciliation(f.session, { ...input, requestId: randomUUID(), manualGroups: [{ noticeId: "s1", refs: ["r3", "r4"], keepRefs: ["r3"] }] }))
      .toMatchObject({ status: "error", error: "CONFLICT" });
    expect(await applyBillReconciliation(f.session, { ...input, requestId: randomUUID(), manualGroups: [{ noticeId: "s1", refs: ["r4", "r5"], keepRefs: ["r4"] }] }))
      .toMatchObject({ status: "success" });
  });

  it("keeps the v3 UUID stable under reordered sets and later historical keeper changes", async () => {
    const f = await fixture(), input = retentionInput(f);
    const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
    const result = await applyBillReconciliation(f.session, input);
    expect(result.status).toBe("success");
    const before = await raw.billReconciliationApplication.findFirstOrThrow({ where: { householdId: f.session.householdId } });
    const reordered = { ...input, manualGroups: [{ noticeId: "s1", refs: ["r3", "r2", "r1"], keepRefs: ["r3", "r1"] }] };
    expect(await applyBillReconciliation(f.session, reordered)).toEqual(result);
    expect(await applyBillReconciliation(f.session, { ...input, manualGroups: [{ ...input.manualGroups[0], keepRefs: ["r1"] }] }))
      .toMatchObject({ status: "error", error: "CONFLICT" });
    await raw.transaction.update({ where: { id: f.rows[2].id }, data: { note: "Retained record edited later", amountFen: 2500 } });
    await archiveLedger(f);
    await raw.billAnalysisReport.update({ where: { id: f.report.id }, data: { generation: 2 } });
    expect(await queryBillReconciliationApplication(f.session, input.requestId)).toEqual(result);
    expect(await applyBillReconciliation(f.session, reordered)).toEqual(result);
    expect(await raw.billReconciliationApplication.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
  });

  it("serializes competing v3 UUIDs before either can reuse a retained participant", async () => {
    const f = await fixture(), input = retentionInput(f);
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    const outcomes = await Promise.all([applyBillReconciliation(f.session, input), applyBillReconciliation(f.session, { ...input, requestId: randomUUID() })]);
    expect(outcomes.map((value) => value.status).sort()).toEqual(["error", "success"]);
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(3);
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(1);
    expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[0].id } })).toEqual(f.rows[0]);
    expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[2].id } })).toEqual(f.rows[2]);
  });

  it("never classifies a v3 manual income deletion as consumed refund evidence", async () => {
    const f = await fixture();
    const income = await raw.category.findFirstOrThrow({ where: { type: "INCOME", isActive: true } });
    await raw.transaction.updateMany({ where: { householdId: f.session.householdId }, data: { type: "INCOME", categoryId: income.id } });
    await refresh(f);
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, retentionInput(f))).toMatchObject({ status: "success", version: 3,
      preview: { delta: { incomeFen: -1200, expenseFen: 0, netFen: -1200, transactionCount: -1 } } });
    expect((await raw.billReconciliationApplication.findFirstOrThrow({ where: { householdId: f.session.householdId } })).definition)
      .toMatchObject({ version: 3, consumedIncomeIds: [] });
  });

  it.each([false, true])("commits v3 with real AI offset atomically, or rejects a changed participant (changed=%s)", async (changed) => {
    const f = await fixture(6);
    const income = await raw.category.findFirstOrThrow({ where: { type: "INCOME", isActive: true } });
    await raw.transaction.update({ where: { id: f.rows[3].id }, data: { note: "Order SYNTHETIC-V3-MIXED-1" } });
    await raw.transaction.update({ where: { id: f.rows[4].id }, data: { type: "INCOME", categoryId: income.id, amountFen: 300, note: "Order SYNTHETIC-V3-MIXED-1 refund" } });
    await refresh(f);
    f.content.suggestions.push({ id: "s2", kind: "refund", title: "Synthetic v3 refund", reason: "Matching synthetic order", evidenceRefs: ["r4", "r5"], confidence: "review", defaultSelected: false, canApply: true, readOnlyReason: null,
      relations: { duplicateGroups: [], offset: { expenseRef: "r4", incomeRefs: ["r5"], kind: "refund" } }, actions: [{ ref: "r4", action: "update", amountFen: 900 }, { ref: "r5", action: "delete", amountFen: 300 }] });
    await refresh(f);
    if (changed) await raw.transaction.update({ where: { id: f.rows[4].id }, data: { note: "Changed after snapshot" } });
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    const result = await applyBillReconciliation(f.session, { ...retentionInput(f), suggestionIds: ["s2"] });
    if (changed) {
      expect(result).toMatchObject({ status: "error", error: "CONFLICT" });
      expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(6);
      expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
    } else {
      expect(result).toMatchObject({ status: "success", version: 3, preview: { delta: { incomeFen: -300, expenseFen: -1500, netFen: 1200, transactionCount: -2 } } });
      expect((await raw.billReconciliationApplication.findFirstOrThrow({ where: { householdId: f.session.householdId } })).definition)
        .toMatchObject({ version: 3, consumedIncomeIds: [f.rows[4].id] });
      expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(3);
    }
  });

  it.each([[], ["r1", "r2", "r3"], ["r1", "r1"], ["r4"]].map((keepRefs) => ({ keepRefs })))("rejects a v3 empty, no-op or forged keep set $keepRefs without writes", async ({ keepRefs }) => {
    const f = await fixture();
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, retentionInput(f, ["r1", "r2", "r3"], keepRefs)))
      .toMatchObject({ status: "unknown", error: "INVALID" });
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(4);
    expect(await raw.billReconciliationApplication.count({ where: { householdId: f.session.householdId } })).toBe(0);
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
  });

  it("keeps the explicit record unchanged and soft deletes only the selected duplicate", async () => {
    const f = await fixture();
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    const result = await applyBillReconciliation(f.session, f.input);
    expect(result).toMatchObject({ status: "success", suggestionIds: [], manualGroups: f.input.manualGroups, preview: { delta: { incomeFen: 0, expenseFen: -1200, netFen: 1200, transactionCount: -1 } } });
    expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[1].id } })).toEqual(f.rows[1]);
    expect((await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[0].id } })).deletedAt).not.toBeNull();
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(3);
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(1);
  });

  it("records only the processed subset and allows the untouched subset after unrelated edits", async () => {
    const f = await fixture();
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    const { readBillAnalysisReport } = await import("@/lib/reports/bill-analysis-store");
    expect(await applyBillReconciliation(f.session, f.input)).toMatchObject({ status: "success" });
    await raw.transaction.update({ where: { id: f.rows[0].id }, data: { note: "Historical deleted record changed for read verification" } });
    const report = await readBillAnalysisReport(f.session, { reportId: f.report.id });
    expect(report).toMatchObject({ manualReview: { processing: false, records: [{ ref: "r1", status: "handled" }, { ref: "r2", status: "handled" }, { ref: "r3", status: "available" }, { ref: "r4", status: "available" }] } });
    expect(report && "suggestions" in report && report.suggestions[0].applied).not.toBe(true);
    expect(JSON.stringify(report)).not.toContain(f.rows[0].id);
    expect(await applyBillReconciliation(f.session, { ...f.input, requestId: randomUUID(), manualGroups: [{ noticeId: "s1", refs: ["r2", "r3"], keepRef: "r2" }] })).toMatchObject({ status: "error", error: "CONFLICT" });
    expect(await applyBillReconciliation(f.session, { ...f.input, requestId: randomUUID(), manualGroups: [{ noticeId: "s1", refs: ["r3", "r4"], keepRef: "r3" }] })).toMatchObject({ status: "success" });
  });

  it("commits AI and manual changes together and records only actual refund consumption", async () => {
    const f = await mixedFixture();
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, f.input)).toMatchObject({ status: "success", suggestionIds: ["s2"], preview: { delta: { incomeFen: -300, expenseFen: -1500, netFen: 1200, transactionCount: -2 } } });
    const receipt = await raw.billReconciliationApplication.findFirstOrThrow({ where: { householdId: f.session.householdId, clientRequestId: f.input.requestId } });
    expect(receipt.definition).toMatchObject({ version: 2, consumedIncomeIds: [f.rows[3].id], manualGroups: [{ keepTransactionId: f.rows[1].id, deletedTransactionIds: [f.rows[0].id] }] });
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(3);
  });

  it("rolls back the entire mixed batch when one AI participant changed", async () => {
    const f = await mixedFixture();
    await raw.transaction.update({ where: { id: f.rows[3].id }, data: { note: "Changed after the report" } });
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, f.input)).toMatchObject({ status: "error", error: "CONFLICT" });
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(4);
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
  });

  it("refuses an AI suggestion that overlaps the manual keeper", async () => {
    const f = await mixedFixture();
    await raw.transaction.update({ where: { id: f.rows[1].id }, data: { note: "Order SYNTHETIC-MIXED-1" } });
    Object.assign(f.content.suggestions[1], { evidenceRefs: ["r2", "r4"], relations: { duplicateGroups: [], offset: { expenseRef: "r2", incomeRefs: ["r4"], kind: "refund" } }, actions: [{ ref: "r2", action: "update", amountFen: 900 }, { ref: "r4", action: "delete", amountFen: 300 }] });
    await refresh(f);
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, f.input)).toMatchObject({ status: "error", error: "CONFLICT" });
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
  });

  it("does not turn a manual income duplicate into consumed refund evidence", async () => {
    const f = await fixture();
    const income = await raw.category.findFirstOrThrow({ where: { type: "INCOME", isActive: true } });
    await raw.transaction.updateMany({ where: { householdId: f.session.householdId }, data: { type: "INCOME", categoryId: income.id } });
    await refresh(f);
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, f.input)).toMatchObject({ status: "success", preview: { delta: { incomeFen: -1200, expenseFen: 0, netFen: -1200, transactionCount: -1 } } });
    expect((await raw.billReconciliationApplication.findFirstOrThrow({ where: { householdId: f.session.householdId } })).definition).toMatchObject({ version: 2, consumedIncomeIds: [] });
  });

  it("serializes two different UUIDs and preserves the original keeper on replay", async () => {
    const f = await fixture();
    const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
    const other = { ...f.input, requestId: randomUUID() };
    const outcomes = await Promise.all([applyBillReconciliation(f.session, f.input), applyBillReconciliation(f.session, other)]);
    const success = outcomes.find((value) => value.status === "success")!;
    expect(outcomes.map((value) => value.status).sort()).toEqual(["error", "success"]);
    const accepted = success.requestId === f.input.requestId ? f.input : other;
    const receiptBefore = await raw.billReconciliationApplication.findFirstOrThrow({ where: { householdId: f.session.householdId, clientRequestId: accepted.requestId } });
    expect(await applyBillReconciliation(f.session, { ...accepted, manualGroups: [{ ...accepted.manualGroups[0], keepRef: "r1" }] })).toMatchObject({ status: "error", error: "CONFLICT" });
    await raw.transaction.update({ where: { id: f.rows[1].id }, data: { note: "Keeper edited later", amountFen: 2500 } });
    await archiveLedger(f);
    await raw.billAnalysisReport.update({ where: { id: f.report.id }, data: { generation: 2 } });
    expect(await applyBillReconciliation(f.session, accepted)).toEqual(success);
    expect(await queryBillReconciliationApplication(f.session, accepted.requestId)).toEqual(success);
    expect(await raw.billReconciliationApplication.findUniqueOrThrow({ where: { id: receiptBefore.id } })).toEqual(receiptBefore);
  });

  it("closes an unaccepted manual UUID before delayed application", async () => {
    const f = await fixture();
    const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
    const closed = await queryBillReconciliationApplication(f.session, f.input.requestId);
    expect(closed).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
    expect(await applyBillReconciliation(f.session, f.input)).toEqual(closed);
    expect(await applyBillReconciliation(f.session, retentionInput(f))).toEqual(closed);
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(4);
  });

  it.each(["ledger", "amount", "actorMemberId", "direction"])("checks real %s equality independently of public aliases", async (field) => {
    const f = await fixture();
    if (field === "ledger") {
      const ledger = await raw.ledger.create({ data: { householdId: f.session.householdId, name: "Other" } });
      await raw.transaction.update({ where: { id: f.rows[1].id }, data: { ledgerId: ledger.id } });
    } else if (field === "actorMemberId") {
      const user = await raw.user.create({ data: { email: `manual-actor-${randomUUID()}@example.com`, displayName: "Other member", passwordHash: "not-used" } });
      users.push(user.id);
      const member = await raw.householdMember.create({ data: { householdId: f.session.householdId, userId: user.id, role: "MEMBER", memberName: "Other member" } });
      await raw.transaction.update({ where: { id: f.rows[1].id }, data: { actorMemberId: member.id } });
    } else if (field === "direction") {
      const income = await raw.category.findFirstOrThrow({ where: { type: "INCOME", isActive: true } });
      await raw.transaction.update({ where: { id: f.rows[1].id }, data: { type: "INCOME", categoryId: income.id } });
    } else await raw.transaction.update({ where: { id: f.rows[1].id }, data: { amountFen: 1500 } });
    await refresh(f);
    if (field === "actorMemberId") {
      expect(f.content.records[0].memberAlias).toBe(f.content.records[1].memberAlias);
      expect(f.content.assertions.r1.actorMemberId).not.toBe(f.content.assertions.r2.actorMemberId);
      const { deriveManualReconciliationActions } = await import("@/lib/reports/bill-reconciliation-selection");
      expect(deriveManualReconciliationActions(f.content.records, f.content.suggestions, f.input.manualGroups)).toHaveLength(2);
    }
    const before = await raw.transaction.findMany({ where: { householdId: f.session.householdId }, orderBy: { id: "asc" } });
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, f.input)).toMatchObject({ status: "error", error: "CONFLICT" });
    expect(await applyBillReconciliation(f.session, { ...retentionInput(f), requestId: randomUUID() })).toMatchObject({ status: "error", error: "CONFLICT" });
    expect(await raw.transaction.findMany({ where: { householdId: f.session.householdId }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
  });

  it.each(["archived", "processing", "revoked", "encryption"])("refuses manual changes when %s", async (state) => {
    const f = await fixture();
    if (state === "archived") await archiveLedger(f);
    if (state === "processing") await raw.billAnalysisReport.update({ where: { id: f.report.id }, data: { activeRequestId: "synthetic-scan" } });
    if (state === "revoked") await raw.appSession.update({ where: { id: f.session.appSessionId }, data: { revokedAt: new Date() } });
    if (state === "encryption") await raw.householdEncryption.create({ data: { householdId: f.session.householdId, mode: "ENCRYPTED", revision: 1 } });
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect((await applyBillReconciliation(f.session, f.input)).status).not.toBe("success");
    expect((await applyBillReconciliation(f.session, { ...retentionInput(f), requestId: randomUUID() })).status).not.toBe("success");
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(4);
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
  });

  it("processes every disjoint group of a legally generated report without losing readability", async () => {
    const f = await fixture(60);
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    const { readBillAnalysisReport } = await import("@/lib/reports/bill-analysis-store");
    expect(Buffer.byteLength(JSON.stringify({ ...f.content, assertions: undefined }))).toBeLessThan(64 * 1024);
    for (let index = 1; index <= 60; index += 2) {
      expect(await applyBillReconciliation(f.session, { ...f.input, requestId: randomUUID(), manualGroups: [{ noticeId: "s1", refs: [`r${index}`, `r${index + 1}`], keepRef: `r${index + 1}` }] })).toMatchObject({ status: "success" });
      expect(await readBillAnalysisReport(f.session, { reportId: f.report.id })).not.toBeNull();
    }
    const report = await readBillAnalysisReport(f.session, { reportId: f.report.id });
    expect(report && "manualReview" in report && report.manualReview?.records.every((row) => row.status === "handled")).toBe(true);
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(30);
  }, 30_000);

  it("rolls back manual writes and audits if the terminal receipt cannot be saved", async () => {
    const f = await fixture();
    const suffix = randomUUID().replaceAll("-", ""), trigger = `bb_manual_fault_${suffix}`, fn = `bb_manual_fault_fn_${suffix}`;
    if (!/^cm[a-z0-9]+$/.test(f.session.householdId) || !/^bb_manual_fault_[a-f0-9]{32}$/.test(trigger)) throw new Error("Receipt fault requires owned fixture identifiers");
    await raw.$executeRawUnsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $fault$ BEGIN IF NEW.household_id = '${f.session.householdId}' THEN RAISE EXCEPTION 'Synthetic manual receipt failure'; END IF; RETURN NEW; END $fault$`);
    try {
      await raw.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "BillReconciliationApplication" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
      const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
      expect(await applyBillReconciliation(f.session, f.input)).toEqual({ requestId: f.input.requestId, status: "unknown" });
      expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(4);
      expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
      await raw.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "BillReconciliationApplication"`);
      expect(await queryBillReconciliationApplication(f.session, f.input.requestId)).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
      expect(await applyBillReconciliation(f.session, f.input)).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
    } finally {
      await raw.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "BillReconciliationApplication"`);
      await raw.$executeRawUnsafe(`DROP FUNCTION "${fn}"()`);
    }
  });

  it("applies manual groups while encrypted and bounds receipt ciphertext before opening it", async () => {
    const f = await fixture();
    const { createHouseholdCode, createKeyRing, sealKeyRing, openKeyRing } = await import("@/lib/encryption/crypto");
    const { encryptRow, protectedFields } = await import("@/lib/encryption/protected-models");
    const { runEncryptionContext } = await import("@/lib/encryption/request-context");
    const code = createHouseholdCode(f.session.householdId), ring = createKeyRing(code), sealedKeyRing = await sealKeyRing(code, ring);
    for (const model of ["transaction", "ledger", "billAnalysisReport"] as const) {
      const rows = await (raw[model].findMany as (args: unknown) => Promise<Array<Record<string, unknown>>>)({ where: { householdId: f.session.householdId } });
      for (const row of rows) {
        const encoded = await encryptRow(model, row, ring, f.session.householdId, f.rows[0].categoryId);
        const data = Object.fromEntries([...protectedFields[model], "encryptedPayload", "encryptionRevision", "updatedAt"].map((field) => [field, encoded[field]]));
        if (model === "billAnalysisReport") { data.definition = Prisma.DbNull; data.content = Prisma.DbNull; }
        await (raw[model].update as (args: unknown) => Promise<unknown>)({ where: { id: row.id }, data });
      }
    }
    await raw.householdEncryption.create({ data: { householdId: f.session.householdId, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: code.keyVersion, sealedKeyRing } });
    const run = async <T>(work: () => Promise<T>) => runEncryptionContext({ session: { ...f.session, role: "OWNER" }, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1,
      ring: await openKeyRing(code, sealedKeyRing), expiresAt: Date.now() + 60_000, disposed: false, readOnly: false }, work);
    try {
      const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
      const { readBillAnalysisReport } = await import("@/lib/reports/bill-analysis-store");
      const outcome = await run(() => applyBillReconciliation(f.session, f.input));
      expect(outcome).toMatchObject({ status: "success", version: 2 });
      expect(await run(() => queryBillReconciliationApplication(f.session, f.input.requestId))).toEqual(outcome);
      expect(await run(() => readBillAnalysisReport(f.session, { reportId: f.report.id }))).toMatchObject({ manualReview: { records: [{ ref: "r1", status: "handled" }, { ref: "r2", status: "handled" }, { ref: "r3", status: "available" }, { ref: "r4", status: "available" }] } });
      const receipt = await raw.billReconciliationApplication.findFirstOrThrow({ where: { householdId: f.session.householdId } });
      expect(receipt.definition).toBeNull();
      expect(receipt.encryptedPayload).toMatch(/^BBE1\./);
      await raw.billReconciliationApplication.update({ where: { id: receipt.id }, data: { encryptedPayload: "x".repeat(4 * 1024 * 1024) } });
      await expect(run(() => readBillAnalysisReport(f.session, { reportId: f.report.id }))).rejects.toMatchObject({ code: "TOO_LARGE" });
    } finally { code.secret = ""; for (const key of ring.keys) key.secret = ""; }
  });

  it("does not resurrect a manually removed imported transaction on reimport", async () => {
    const f = await fixture(1);
    const drafts = await import("@/lib/imports/drafts");
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("支出");
    sheet.addRow(["交易类型", "日期", "一级分类", "二级分类", "账户币种", "金额", "成员", "记账人", "备注"]);
    sheet.addRow(["支出", "2026-01-01 12:00:00", "Synthetic primary", "Synthetic secondary", "CNY", "12.00", "Owner", "Owner", "Synthetic imported purchase"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const context = { householdId: f.session.householdId, ledgerId: f.ledger.id, memberId: f.session.memberId };
    const first = await drafts.createSuiShouJiImportDraft({ buffer, fileName: "synthetic-import.xlsx", context, sessionUser: f.session });
    const summary = await drafts.getImportDraftSummary(first.id, f.session);
    await drafts.saveImportDraftMemberMappings(first.id, [{ externalName: "Owner", memberId: f.session.memberId }], f.session);
    await drafts.saveImportDraftMappings(first.id, [{ categoryId: f.rows[0].categoryId, mappingKey: summary.rows[0].mappingKey! }], f.session);
    await drafts.setImportDraftRowDecision(first.id, summary.rows[0].id, "KEEP", f.session);
    expect(await drafts.confirmImportDraft(first.id, f.session)).toMatchObject({ createdCount: 1 });
    const imported = await raw.transaction.findFirstOrThrow({ where: { householdId: f.session.householdId, source: "sui_shou_ji", deletedAt: null } });
    const { queryBillReconciliationSnapshot } = await import("@/lib/reports/bill-reconciliation-snapshot");
    const { prepareBillReconciliation, buildBillReconciliationContent } = await import("@/lib/reports/bill-reconciliation-prepare");
    const { BILL_RECONCILIATION_SCHEMA_VERSION } = await import("@/lib/reports/bill-reconciliation-protocol");
    const prepared = prepareBillReconciliation(await queryBillReconciliationSnapshot(f.session, { mode: "year", period: "2026", ledgerId: f.ledger.id, actorMemberId: null }, "en-US"));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: BILL_RECONCILIATION_SCHEMA_VERSION, batchId: batch.batchId, groups: [{ kind: "notice", title: "Synthetic cross-source duplicate", reason: "Manual review required", confidence: "review", evidenceRefs: batch.rows.map((row) => row.ref), duplicateGroups: [], offset: null }] })));
    await raw.billAnalysisReport.update({ where: { id: f.report.id }, data: { content: JSON.parse(JSON.stringify(content)) } });
    const keepRef = Object.entries(content.assertions).find(([, row]) => row.id === f.rows[0].id)![0];
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, { ...f.input, manualGroups: [{ noticeId: "s1", refs: content.records.map((row) => row.ref), keepRef }] })).toMatchObject({ status: "success" });
    expect((await raw.transaction.findUniqueOrThrow({ where: { id: imported.id } })).deletedAt).not.toBeNull();
    const next = await drafts.createSuiShouJiImportDraft({ buffer, fileName: "synthetic-reimport.xlsx", context, sessionUser: f.session });
    expect((await drafts.getImportDraftSummary(next.id, f.session)).rows[0]).toMatchObject({ status: "SOURCE_DUPLICATE" });
    expect(await drafts.confirmImportDraft(next.id, f.session)).toMatchObject({ createdCount: 0, sourceDuplicateCount: 1 });
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, source: "sui_shou_ji" } })).toBe(1);
  });
});
