import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BillReconciliationContent, ReconciliationSourceRow } from "@/lib/reports/bill-reconciliation-types";

it("registers a household-bound terminal application receipt", () => {
  expect(Prisma.dmmf.datamodel.models.map((model) => model.name)).toContain("BillReconciliationApplication");
});

describe("reconciliation atomic application", () => {
  let raw: PrismaClient;
  const households: string[] = [];
  const users: string[] = [];
  beforeAll(() => {
    process.loadEnvFile(".env.example");
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
      throw new Error("Reconciliation tests require a local development database");
    }
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

  async function fixture() {
    const household = await raw.household.create({ data: { name: "Synthetic reconciliation fixture" } });
    households.push(household.id);
    const user = await raw.user.create({ data: { email: `reconcile-${randomUUID()}@example.com`, displayName: "Owner", passwordHash: "not-used" } });
    users.push(user.id);
    const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, role: "OWNER", memberName: "Owner" } });
    const ledger = await raw.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
    const appSession = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
    const expense = await raw.category.findFirstOrThrow({ where: { type: "EXPENSE", isActive: true } });
    const income = await raw.category.findFirstOrThrow({ where: { type: "INCOME", isActive: true } });
    const rows = await raw.transaction.createManyAndReturn({ data: [
      { householdId: household.id, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: expense.id, type: "EXPENSE", amountFen: 10000, occurredAt: new Date("2026-01-01T04:00:00.000Z"), note: "Order SYNTHETIC-1", clientRequestId: randomUUID() },
      { householdId: household.id, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: income.id, type: "INCOME", amountFen: 3000, occurredAt: new Date("2026-02-02T04:00:00.000Z"), note: "Order SYNTHETIC-1 refund", clientRequestId: randomUUID() },
    ] });
    const session = { id: user.id, householdId: household.id, memberId: member.id, appSessionId: appSession.id };
    const { db } = await import("@/lib/db");
    const { loadReconciliationRows } = await import("@/lib/reports/bill-reconciliation-snapshot");
    const loaded = await db.$transaction((tx) => loadReconciliationRows(tx, household.id, rows.map((row) => row.id)));
    const assertions: Record<string, ReconciliationSourceRow> = {};
    const records = rows.map((row, index) => {
      const ref = `r${index + 1}`, source = loaded.find((value) => value.id === row.id)!;
      assertions[ref] = source;
      return { ref, occurredAt: row.occurredAt.toISOString(), date: index === 0 ? "2026-01-01" : "2026-02-02", type: row.type === "EXPENSE" ? "expense" as const : "income" as const,
        amountFen: row.amountFen, categoryName: index === 0 ? expense.name : income.name, memberLabel: "Owner", ledgerLabel: "Default", memberAlias: "m1", ledgerAlias: "l1", note: row.note,
        source: null, timePrecision: "unknown" as const, timeSupplemented: false, aggregated: false };
    });
    const content: BillReconciliationContent = {
      purpose: "reconciliation", version: 1, locale: "zh-CN", range: { from: "2026-01-01", to: "2026-12-31" }, snapshotAt: new Date().toISOString(), records, assertions,
      suggestions: [{ id: "s1", kind: "refund", title: "Synthetic refund", reason: "The refund names the original order", evidenceRefs: ["r1", "r2"], confidence: "review", defaultSelected: false, canApply: true, readOnlyReason: null,
        relations: { duplicateGroups: [], offset: { expenseRef: "r1", incomeRefs: ["r2"], kind: "refund" } },
        actions: [{ ref: "r1", action: "update", amountFen: 7000 }, { ref: "r2", action: "delete", amountFen: 3000 }] }],
    };
    const report = await raw.billAnalysisReport.create({ data: { householdId: household.id, createdByMemberId: member.id, generation: 1, generatedAt: new Date(),
      definition: { purpose: "reconciliation", version: 1, scope: { mode: "year", period: "2026", ledgerId: ledger.id, actorMemberId: null } }, content: JSON.parse(JSON.stringify(content)) } });
    const input = { requestId: randomUUID(), reportId: report.id, generation: 1, suggestionIds: ["s1"] };
    return { session, report, input, rows, ledger, content };
  }

  it("nets a refund and commits its immutable receipt and minimal audit exactly once", async () => {
    const f = await fixture();
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    const first = await applyBillReconciliation(f.session, f.input);
    expect(first).toMatchObject({ status: "success", preview: { delta: { incomeFen: -3000, expenseFen: -3000, netFen: 0, transactionCount: -1 } } });
    expect(await applyBillReconciliation(f.session, f.input)).toEqual(first);
    const expense = await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[0].id } });
    const refund = await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[1].id } });
    expect(expense).toMatchObject({ amountFen: 7000, deletedAt: null, clientRequestId: f.rows[0].clientRequestId, actorMemberId: f.rows[0].actorMemberId, createdByMemberId: f.rows[0].createdByMemberId, note: f.rows[0].note, occurredAt: f.rows[0].occurredAt });
    expect(refund.deletedAt).not.toBeNull();
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(2);
    expect(first.preview?.months).toEqual([
      { key: "2026-01", delta: { incomeFen: 0, expenseFen: -3000, netFen: 3000, transactionCount: 0 } },
      { key: "2026-02", delta: { incomeFen: -3000, expenseFen: 0, netFen: -3000, transactionCount: -1 } },
    ]);
    expect(await raw.$queryRaw<Array<{ month: string; amountFen: bigint; count: bigint }>>`
      SELECT to_char(occurred_at + interval '8 hours','YYYY-MM') AS month, SUM(amount_fen)::bigint AS "amountFen", COUNT(*)::bigint AS count
      FROM "Transaction" WHERE household_id=${f.session.householdId} AND deleted_at IS NULL GROUP BY month ORDER BY month
    `).toEqual([{ month: "2026-01", amountFen: 7000n, count: 1n }]);
  });

  it("soft deletes a fully reimbursed expense without zeroing or replacing its identity", async () => {
    const f = await fixture();
    await raw.transaction.update({ where: { id: f.rows[1].id }, data: { amountFen: 10000 } });
    const { db } = await import("@/lib/db");
    const { loadReconciliationRows } = await import("@/lib/reports/bill-reconciliation-snapshot");
    const updated = await db.$transaction((tx) => loadReconciliationRows(tx, f.session.householdId, f.rows.map((row) => row.id)));
    f.content.assertions.r2 = updated.find((row) => row.id === f.rows[1].id)!;
    f.content.records[1].amountFen = 10000;
    f.content.suggestions[0].actions = [{ ref: "r1", action: "delete", amountFen: 10000 }, { ref: "r2", action: "delete", amountFen: 10000 }];
    await raw.billAnalysisReport.update({ where: { id: f.report.id }, data: { content: JSON.parse(JSON.stringify(f.content)) } });
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, f.input)).toMatchObject({ status: "success", preview: { delta: { incomeFen: -10000, expenseFen: -10000, netFen: 0, transactionCount: -2 } } });
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, deletedAt: null } })).toBe(0);
    expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[0].id } })).toMatchObject({ amountFen: 10000, clientRequestId: f.rows[0].clientRequestId });
  });

  it("rejects the complete selection when one underlying record changed", async () => {
    const f = await fixture();
    await raw.transaction.update({ where: { id: f.rows[1].id }, data: { note: "Changed after scan" } });
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, f.input)).toMatchObject({ status: "error", error: "CONFLICT" });
    expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[0].id } })).toMatchObject({ amountFen: 10000, deletedAt: null });
    expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[1].id } })).toMatchObject({ deletedAt: null });
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
  });

  it("keeps a rescanning rejection terminal after the scan fails and a duplicate request arrives", async () => {
    const f = await fixture();
    await raw.billAnalysisReport.update({ where: { id: f.report.id }, data: { activeRequestId: "synthetic-active-scan" } });
    const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
    const rejected = await applyBillReconciliation(f.session, f.input);
    expect(rejected).toMatchObject({ status: "error", error: "CONFLICT" });
    await raw.billAnalysisReport.update({ where: { id: f.report.id }, data: { activeRequestId: null } });
    expect(await applyBillReconciliation(f.session, f.input)).toEqual(rejected);
    expect(await queryBillReconciliationApplication(f.session, f.input.requestId)).toEqual(rejected);
    expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[0].id } })).toMatchObject({ amountFen: 10000 });
  });

  it("closes an unaccepted UUID before a delayed application can write", async () => {
    const f = await fixture();
    const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
    const closed = await queryBillReconciliationApplication(f.session, f.input.requestId);
    expect(closed).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
    expect(await applyBillReconciliation(f.session, f.input)).toEqual(closed);
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
  });

  it("serializes concurrent applications and rejects a changed UUID selection", async () => {
    const f = await fixture();
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    const outcomes = await Promise.all([applyBillReconciliation(f.session, f.input), applyBillReconciliation(f.session, f.input)]);
    expect(outcomes[0]).toMatchObject({ status: "success" });
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(await applyBillReconciliation(f.session, { ...f.input, generation: 2 })).toMatchObject({ status: "error", error: "CONFLICT" });
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(2);
  });

  it("allows household sharing but only one member's competing application can modify the records", async () => {
    const f = await fixture();
    const user = await raw.user.create({ data: { email: `reconcile-member-${randomUUID()}@example.com`, displayName: "Member", passwordHash: "not-used" } });
    users.push(user.id);
    const member = await raw.householdMember.create({ data: { householdId: f.session.householdId, userId: user.id, memberName: "Member", role: "MEMBER" } });
    const appSession = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
    const second = { id: user.id, memberId: member.id, householdId: f.session.householdId, appSessionId: appSession.id };
    const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
    const otherInput = { ...f.input, requestId: randomUUID() };
    const outcomes = await Promise.all([applyBillReconciliation(f.session, f.input), applyBillReconciliation(second, otherInput)]);
    expect(outcomes.filter((result) => result.status === "success")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "error" && result.error === "CONFLICT")).toHaveLength(1);
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(2);
    expect(await queryBillReconciliationApplication(second, f.input.requestId)).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
  });

  it("rolls back every financial write and returns unknown when the database cannot save a terminal receipt", async () => {
    const f = await fixture();
    const suffix = randomUUID().replaceAll("-", "");
    const trigger = `bb_reconcile_fault_${suffix}`, fn = `bb_reconcile_fault_fn_${suffix}`;
    if (!/^cm[a-z0-9]+$/.test(f.session.householdId) || !/^bb_reconcile_fault_[a-f0-9]{32}$/.test(trigger)) throw new Error("Synthetic receipt fault requires its own fixture identifiers");
    await raw.$executeRawUnsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $fault$ BEGIN IF NEW.household_id = '${f.session.householdId}' THEN RAISE EXCEPTION 'Synthetic reconciliation receipt failure'; END IF; RETURN NEW; END $fault$`);
    try {
      await raw.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "BillReconciliationApplication" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
      const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
      expect(await applyBillReconciliation(f.session, f.input)).toEqual({ requestId: f.input.requestId, status: "unknown" });
      expect(await queryBillReconciliationApplication(f.session, f.input.requestId)).toEqual({ requestId: f.input.requestId, status: "unknown" });
      expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[0].id } })).toMatchObject({ amountFen: 10000, deletedAt: null });
      expect(await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[1].id } })).toMatchObject({ deletedAt: null });
      expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
      await raw.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "BillReconciliationApplication"`);
      expect(await queryBillReconciliationApplication(f.session, f.input.requestId)).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
    } finally {
      await raw.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "BillReconciliationApplication"`);
      await raw.$executeRawUnsafe(`DROP FUNCTION "${fn}"()`);
    }
  });

  it("bounds encrypted completed-import evidence before decryption and skips pending draft payloads", async () => {
    const f = await fixture();
    const fingerprint = "b".repeat(64);
    await raw.transaction.update({ where: { id: f.rows[0].id }, data: { source: "cmb", sourceFingerprint: fingerprint, sourceImportedAt: new Date() } });
    const completed = await raw.importDraft.create({ data: { householdId: f.session.householdId, ledgerId: f.ledger.id, createdByMemberId: f.session.memberId, source: "cmb", fileName: "synthetic-completed.pdf", status: "COMPLETED", completedAt: new Date(), rows: { create: { rowNumber: 1, status: "READY", amountFen: 10000, transactionType: "EXPENSE", sourceFingerprint: fingerprint } } }, include: { rows: true } });
    const pending = await raw.importDraft.create({ data: { householdId: f.session.householdId, ledgerId: f.ledger.id, createdByMemberId: f.session.memberId, source: "cmb", fileName: "synthetic-pending.pdf", rows: { create: { rowNumber: 1, status: "INVALID" } } }, include: { rows: true } });
    const { createHouseholdCode, createKeyRing, sealKeyRing, openKeyRing } = await import("@/lib/encryption/crypto");
    const { encryptRow, protectedFields } = await import("@/lib/encryption/protected-models");
    const { runEncryptionContext } = await import("@/lib/encryption/request-context");
    const code = createHouseholdCode(f.session.householdId), ring = createKeyRing(code), sealedKeyRing = await sealKeyRing(code, ring);
    const category = await raw.category.findFirstOrThrow({ orderBy: { id: "asc" } });
    for (const model of ["transaction", "ledger", "billAnalysisReport", "importDraft", "importDraftRow"] as const) {
      const rows = await (raw[model].findMany as (args: unknown) => Promise<Array<Record<string, unknown>>>)({ where: model === "importDraftRow" ? { draft: { householdId: f.session.householdId } } : { householdId: f.session.householdId } });
      for (const row of rows) {
        const encoded = await encryptRow(model, row, ring, f.session.householdId, category.id, model === "importDraftRow" ? f.ledger.id : undefined);
        const data = Object.fromEntries([...protectedFields[model], "encryptedPayload", "encryptionRevision", "updatedAt"].map((field) => [field, encoded[field]]));
        if (model === "billAnalysisReport") { data.definition = Prisma.DbNull; data.content = Prisma.DbNull; }
        if (model === "importDraftRow") data.duplicateCandidates = Prisma.DbNull;
        await (raw[model].update as (args: unknown) => Promise<unknown>)({ where: { id: row.id }, data });
      }
    }
    await raw.householdEncryption.create({ data: { householdId: f.session.householdId, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: code.keyVersion, sealedKeyRing } });
    await raw.importDraftRow.update({ where: { id: pending.rows[0].id }, data: { encryptedPayload: "synthetic-invalid-pending-payload" } });
    const run = async <T>(work: () => Promise<T>) => runEncryptionContext({ session: { ...f.session, role: "OWNER" }, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1, ring: await openKeyRing(code, sealedKeyRing), expiresAt: Date.now() + 60_000, disposed: false, readOnly: false }, work);
    const { queryBillReconciliationSnapshot } = await import("@/lib/reports/bill-reconciliation-snapshot");
    const snapshot = await run(() => queryBillReconciliationSnapshot(f.session, { mode: "year", period: "2026", ledgerId: null, actorMemberId: null }, "en-US"));
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows.find((row) => row.id === f.rows[0].id)).toMatchObject({ source: "cmb", timePrecision: "day", timeSupplemented: true });
    await raw.importDraftRow.update({ where: { id: completed.rows[0].id }, data: { encryptedPayload: "x".repeat(8 * 1024 * 1024 + 1) } });
    await expect(run(() => queryBillReconciliationSnapshot(f.session, { mode: "year", period: "2026", ledgerId: null, actorMemberId: null }, "en-US"))).rejects.toMatchObject({ code: "TOO_LARGE" });
    for (const key of ring.keys) key.secret = "";
    code.secret = "";
  });

  it("applies and recovers encrypted receipts without leaving financial values in plaintext storage", async () => {
    const f = await fixture();
    const { createHouseholdCode, createKeyRing, sealKeyRing, openKeyRing } = await import("@/lib/encryption/crypto");
    const { encryptRow, protectedFields } = await import("@/lib/encryption/protected-models");
    const { runEncryptionContext } = await import("@/lib/encryption/request-context");
    const code = createHouseholdCode(f.session.householdId), ring = createKeyRing(code);
    const sealedKeyRing = await sealKeyRing(code, ring);
    const category = await raw.category.findFirstOrThrow({ orderBy: { id: "asc" } });
    for (const model of ["transaction", "ledger", "billAnalysisReport"] as const) {
      const rows = await (raw[model].findMany as (args: unknown) => Promise<Array<Record<string, unknown>>>)({ where: { householdId: f.session.householdId } });
      for (const row of rows) {
        const encoded = await encryptRow(model, row, ring, f.session.householdId, category.id);
        const data = Object.fromEntries([...protectedFields[model], "encryptedPayload", "encryptionRevision", "updatedAt"].map((field) => [field, encoded[field]]));
        if (model === "billAnalysisReport") { data.definition = Prisma.DbNull; data.content = Prisma.DbNull; }
        await (raw[model].update as (args: unknown) => Promise<unknown>)({ where: { id: row.id }, data });
      }
    }
    await raw.householdEncryption.create({ data: { householdId: f.session.householdId, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: code.keyVersion, sealedKeyRing } });
    const { applyBillReconciliation, queryBillReconciliationApplication } = await import("@/lib/reports/bill-reconciliation-application");
    const run = async <T>(work: () => Promise<T>) => runEncryptionContext({ session: { ...f.session, role: "OWNER" }, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1,
      ring: await openKeyRing(code, sealedKeyRing), expiresAt: Date.now() + 60_000, disposed: false, readOnly: false }, work);
    const applied = await run(() => applyBillReconciliation(f.session, f.input));
    expect(applied).toMatchObject({ status: "success" });
    expect(await run(() => queryBillReconciliationApplication(f.session, f.input.requestId))).toEqual(applied);
    const receipt = await raw.billReconciliationApplication.findFirstOrThrow({ where: { householdId: f.session.householdId } });
    expect(receipt.definition).toBeNull();
    expect(receipt.encryptedPayload).toBeTypeOf("string");
    expect(JSON.stringify(receipt)).not.toContain("incomeFen");
    const physical = await raw.transaction.findUniqueOrThrow({ where: { id: f.rows[0].id } });
    expect(physical).toMatchObject({ amountFen: 0, source: "encrypted", note: null });
    for (const key of ring.keys) key.secret = "";
    code.secret = "";
  });

  it("rejects a foreign report, an archived ledger and a revoked session", async () => {
    const f = await fixture();
    const { applyBillReconciliation } = await import("@/lib/reports/bill-reconciliation-application");
    expect(await applyBillReconciliation(f.session, { ...f.input, reportId: "foreign-report" })).toMatchObject({ status: "error", error: "CONFLICT" });
    await raw.$transaction(async (tx) => {
      await tx.ledger.update({ where: { id: f.ledger.id }, data: { isDefault: false } });
      await tx.ledger.create({ data: { householdId: f.session.householdId, name: "Replacement default", isDefault: true } });
      await tx.ledger.update({ where: { id: f.ledger.id }, data: { archivedAt: new Date() } });
    });
    expect(await applyBillReconciliation(f.session, { ...f.input, requestId: randomUUID() })).toMatchObject({ status: "error", error: "CONFLICT" });
    await raw.appSession.update({ where: { id: f.session.appSessionId }, data: { revokedAt: new Date() } });
    expect(await applyBillReconciliation(f.session, { ...f.input, requestId: randomUUID() })).toMatchObject({ status: "unknown", error: "UNAUTHORIZED" });
    expect(await raw.ledgerAuditLog.count({ where: { householdId: f.session.householdId } })).toBe(0);
  });
});
