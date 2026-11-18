import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getBillAnalysisOwner } from "@/lib/reports/bill-analysis-owner";
import type { BillAnalysisBody, BillAnalysisScope } from "@/lib/reports/bill-analysis-types";

it("registers household-bound report and request entities", () => {
  const names = Prisma.dmmf.datamodel.models.map((model) => model.name);
  expect(names).toContain("BillAnalysisReport");
  expect(names).toContain("BillAnalysisRequest");
});

describe("bill analysis request and latest report persistence", () => {
  let raw: PrismaClient;
  let acquireResourceLease: typeof import("@/lib/resources/admission").acquireResourceLease;
  let releaseResourceLease: typeof import("@/lib/resources/admission").releaseResourceLease;
  const ownedHouseholds: string[] = [];
  const ownedUsers: string[] = [];
  beforeAll(async () => {
    process.loadEnvFile(".env.example");
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
      throw new Error("Bill analysis tests require a local development database");
    }
    raw = new PrismaClient();
    ({ acquireResourceLease, releaseResourceLease } = await import("@/lib/resources/admission"));
  });
  afterEach(async () => {
    await raw.billAnalysisRequest.deleteMany({ where: { householdId: { in: ownedHouseholds } } });
    await raw.billAnalysisReport.deleteMany({ where: { householdId: { in: ownedHouseholds } } });
    await raw.household.deleteMany({ where: { id: { in: ownedHouseholds.splice(0) } } });
    await raw.user.deleteMany({ where: { id: { in: ownedUsers.splice(0) } } });
  });
  afterAll(async () => { await raw?.$disconnect(); });

  async function fixture() {
    const suffix = randomUUID();
    const household = await raw.household.create({ data: { name: "Synthetic analysis fixture" } });
    ownedHouseholds.push(household.id);
    const user = await raw.user.create({ data: { email: `analysis-${suffix}@example.com`, displayName: "Owner", passwordHash: "not-used", aiProcessingEnabled: true } });
    ownedUsers.push(user.id);
    const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, role: "OWNER", memberName: "Owner" } });
    await raw.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
    const session = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
    return { id: user.id, householdId: household.id, memberId: member.id, appSessionId: session.id };
  }

  const scope: BillAnalysisScope = { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null };
  const body: BillAnalysisBody = { overview: "Synthetic overview", observations: [{ title: "Dining", detail: "Review the recorded dining expense.", evidenceRefs: ["expense.current", "r1"] }], recommendations: [], limitations: ["Recorded data only"] };
  const metrics = [{ ref: "expense.current", label: "Expense", value: 12345, unit: "fen" as const }];
  const evidence = [{ ref: "r1", date: "2026-10-01", type: "expense" as const, amountFen: 12345, categoryName: "Dining", memberAlias: "m1", ledgerAlias: "l1" }, { ref: "r2", date: "2026-10-02", type: "expense" as const, amountFen: 100, categoryName: "Dining", memberAlias: "m1", ledgerAlias: "l1" }];
  async function prepare(session: Awaited<ReturnType<typeof fixture>>, selected = scope) {
    const store = await import("@/lib/reports/bill-analysis-store");
    const requestId = randomUUID();
    const claimed = await store.claimBillAnalysisRequest(session, { requestId, scope: selected, locale: "zh-CN", deadlineAt: new Date(Date.now() + 480_000), owner: getBillAnalysisOwner() }, (tx) => acquireResourceLease(tx, session, "ai", { profile: "bill-analysis", deferCharge: true }));
    expect(claimed.created).toBe(true);
    const lease = claimed.lease!;
    const admitted = await store.admitBillAnalysisRequest(session, requestId, { scope: selected, locale: "zh-CN", snapshotAt: new Date().toISOString(), range: { from: "2026-10-01", to: "2026-10-31" }, inputHash: "a".repeat(64) }, lease);
    return { store, requestId, lease, admitted };
  }

  it("makes a preparing request discoverable through its report slot", async () => {
    const store = await import("@/lib/reports/bill-analysis-store");
    const session = await fixture();
    const requestId = randomUUID();
    const claimed = await store.claimBillAnalysisRequest(session, {
      requestId, scope, locale: "zh-CN", deadlineAt: new Date(Date.now() + 480_000),
      owner: { id: randomUUID(), runtime: "synthetic", pid: 123, startedAt: new Date() },
    }, (tx) => acquireResourceLease(tx, session, "ai", { profile: "bill-analysis", deferCharge: true }));
    expect(claimed.created).toBe(true);
    const request = await raw.billAnalysisRequest.findFirstOrThrow({ where: { householdId: session.householdId, clientRequestId: requestId } });
    expect(request.reportId).not.toBeNull();
    const slot = await raw.billAnalysisReport.findFirstOrThrow({ where: { id: request.reportId!, householdId: session.householdId } });
    expect(slot).toMatchObject({ definition: { scope }, activeRequestId: request.id, content: null, generation: 0 });
    expect(await store.listBillAnalysisEntries(session)).toMatchObject({ entries: [{ id: slot.id, scope, report: null, task: { id: request.id, status: "processing", phase: "preparing", completedBatches: 0, totalBatches: 0, requestId, canCancel: true } }], active: { id: slot.id }, cursor: null });
    await releaseResourceLease(claimed.lease!);
  });

  it("does not turn query-before-submit into a second attempt", async () => {
    const store = await import("@/lib/reports/bill-analysis-store");
    const session = await fixture();
    const requestId = randomUUID();
    expect(await store.queryBillAnalysisRequest(session, requestId)).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
    let acquisitions = 0;
    const claimed = await store.claimBillAnalysisRequest(session, {
      requestId, scope: { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null }, locale: "zh-CN",
      deadlineAt: new Date(Date.now() + 480_000), owner: { id: randomUUID(), runtime: "synthetic", pid: 123, startedAt: new Date() },
    }, async () => { acquisitions++; throw new Error("An already closed request must not acquire resources"); });
    expect(claimed.created).toBe(false);
    expect(claimed.result).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
    expect(acquisitions).toBe(0);
    expect(await store.listBillAnalysisEntries(session)).toEqual({ entries: [], cursor: null, active: null });
  });

  it("saves only referenced evidence and keeps the previous report after a failed replacement", async () => {
    const session = await fixture();
    const first = await prepare(session);
    expect(await first.store.completeBillAnalysisRequest(session, first.requestId, { body, metrics, evidence }, first.lease)).toMatchObject({ status: "success", generation: 1 });
    await releaseResourceLease(first.lease);
    const saved = await first.store.readBillAnalysisReport(session, { scope });
    expect(saved).toMatchObject({ body, generation: 1 });
    if (!saved || !("evidence" in saved)) throw new Error("Legacy reports must retain their evidence format");
    expect(saved.evidence).toHaveLength(1);
    const second = await prepare(session);
    expect(await first.store.listBillAnalysisEntries(session)).toMatchObject({ entries: [{ id: saved!.id, report: { generation: 1 }, task: { status: "processing", requestId: second.requestId } }], active: { id: saved!.id } });
    await second.store.failBillAnalysisRequest(session, second.requestId, "UNAVAILABLE");
    expect(await second.store.readBillAnalysisReport(session, { scope })).toEqual(saved);
    expect(await first.store.listBillAnalysisEntries(session)).toMatchObject({ entries: [{ id: saved!.id, report: { generation: 1 }, task: { status: "error", error: "UNAVAILABLE", requestId: second.requestId, canCancel: false } }], active: null });
    expect(await second.store.queryBillAnalysisRequest(session, first.requestId)).toMatchObject({ status: "success", superseded: false });
    await releaseResourceLease(second.lease);
    const third = await prepare(session);
    expect(await third.store.completeBillAnalysisRequest(session, third.requestId, { body: { ...body, overview: "Updated" }, metrics, evidence }, third.lease)).toMatchObject({ status: "success", generation: 2 });
    expect(await third.store.queryBillAnalysisRequest(session, first.requestId)).toMatchObject({ status: "success", superseded: true });
    expect((await third.store.listBillAnalysisReports(session)).reports).toHaveLength(1);
  });

  it("serializes STOPPING before save and never removes the previous report", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    expect(await prepared.store.cancelBillAnalysisRequest(session, prepared.requestId)).toMatchObject({ status: "stopping" });
    await expect(prepared.store.completeBillAnalysisRequest(session, prepared.requestId, { body, metrics, evidence }, prepared.lease)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await prepared.store.readBillAnalysisReport(session, { scope })).toBeNull();
    expect(await prepared.store.failBillAnalysisRequest(session, prepared.requestId, "CANCELLED")).toMatchObject({ status: "error", error: "CANCELLED" });
  });

  it("returns completed when cancellation arrives after commit", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    await prepared.store.completeBillAnalysisRequest(session, prepared.requestId, { body, metrics, evidence }, prepared.lease);
    expect(await prepared.store.cancelBillAnalysisRequest(session, prepared.requestId)).toMatchObject({ status: "success" });
  });

  it("does not authorize an old UUID through another session or replacement input", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    const other = await raw.appSession.create({ data: { userId: session.id, memberId: session.memberId, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
    await expect(prepared.store.queryBillAnalysisRequest({ ...session, appSessionId: other.id }, prepared.requestId)).rejects.toMatchObject({ code: "CONFLICT" });
    const duplicate = await prepared.store.claimBillAnalysisRequest(session, { requestId: prepared.requestId, scope: { ...scope, period: "2026-09" }, locale: "zh-CN", deadlineAt: new Date(Date.now() + 480_000), owner: { id: randomUUID(), runtime: "synthetic", pid: 123, startedAt: new Date() } }, async () => { throw new Error("Duplicate UUID must not acquire resources"); });
    expect(duplicate).toMatchObject({ created: false, result: { status: "error", error: "CONFLICT" } });
  });

  it("blocks a revoked session and mode changes before final persistence", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    await raw.householdEncryption.create({ data: { householdId: session.householdId, mode: "UNENCRYPTED", revision: 1 } });
    await expect(prepared.store.completeBillAnalysisRequest(session, prepared.requestId, { body, metrics, evidence }, prepared.lease)).rejects.toMatchObject({ code: "ENCRYPTION_CHANGED" });
    await raw.appSession.update({ where: { id: session.appSessionId }, data: { revokedAt: new Date() } });
    await expect(prepared.store.queryBillAnalysisRequest(session, prepared.requestId)).rejects.toThrow("Unauthorized");
  });

  it("reads archived ledger and historical member reports through current household authorization", async () => {
    const session = await fixture();
    const archive = await raw.ledger.create({ data: { householdId: session.householdId, name: "Archive", archivedAt: new Date() } });
    const historicalUser = await raw.user.create({ data: { email: `former-${randomUUID()}@example.com`, displayName: "Former", passwordHash: "not-used" } });
    ownedUsers.push(historicalUser.id);
    const historical = await raw.householdMember.create({ data: { householdId: session.householdId, userId: historicalUser.id, role: "MEMBER", memberName: "Former", leftAt: new Date() } });
    const selected = { ...scope, ledgerId: archive.id, actorMemberId: historical.id };
    const prepared = await prepare(session, selected);
    await prepared.store.completeBillAnalysisRequest(session, prepared.requestId, { body, metrics, evidence }, prepared.lease);
    expect(await prepared.store.readBillAnalysisReport(session, { scope: selected })).toMatchObject({ scopeLabels: { ledger: "Archive" } });
    const other = await fixture();
    expect(await prepared.store.readBillAnalysisReport(other, { reportId: prepared.admitted.reportId })).toBeNull();
  });

  it("uses composite foreign keys for request reports and creators", async () => {
    const left = await fixture();
    const right = await fixture();
    const report = await raw.billAnalysisReport.create({ data: { householdId: left.householdId, createdByMemberId: left.memberId } });
    await expect(raw.billAnalysisRequest.create({ data: { householdId: right.householdId, createdByMemberId: right.memberId, originalAppSessionId: right.appSessionId, clientRequestId: randomUUID(), status: "FAILED", modeRevision: 0, configMode: "UNENCRYPTED", reportId: report.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(raw.billAnalysisReport.create({ data: { householdId: left.householdId, createdByMemberId: right.memberId } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("keeps same-household transaction references private and accepts a later soft delete", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    const ledger = await raw.ledger.findFirstOrThrow({ where: { householdId: session.householdId } });
    const category = await raw.category.findFirstOrThrow();
    const transaction = await raw.transaction.create({ data: { householdId: session.householdId, ledgerId: ledger.id, actorMemberId: session.memberId, createdByMemberId: session.memberId, categoryId: category.id, type: "EXPENSE", amountFen: 12345, occurredAt: new Date("2026-10-01T01:00:00Z"), deletedAt: new Date() } });
    await prepared.store.completeBillAnalysisRequest(session, prepared.requestId, { body, metrics, evidence, transactionRefs: { r1: transaction.id, r2: transaction.id } }, prepared.lease);
    const stored = await raw.billAnalysisReport.findUniqueOrThrow({ where: { id: prepared.admitted.reportId } });
    expect(stored.content).toMatchObject({ transactionRefs: { r1: transaction.id } });
    expect(JSON.stringify(stored.content)).not.toContain('"r2"');
    const publicReport = await prepared.store.readBillAnalysisReport(session, { scope });
    expect(publicReport).not.toHaveProperty("transactionRefs");
    expect(JSON.stringify(publicReport)).not.toContain(transaction.id);
    await raw.transaction.delete({ where: { id: transaction.id } });
  });

  it("rejects a transaction reference from another household", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    const other = await fixture();
    const ledger = await raw.ledger.findFirstOrThrow({ where: { householdId: other.householdId } });
    const category = await raw.category.findFirstOrThrow();
    const transaction = await raw.transaction.create({ data: { householdId: other.householdId, ledgerId: ledger.id, actorMemberId: other.memberId, createdByMemberId: other.memberId, categoryId: category.id, type: "EXPENSE", amountFen: 12345, occurredAt: new Date("2026-10-01T01:00:00Z") } });
    await expect(prepared.store.completeBillAnalysisRequest(session, prepared.requestId, { body, metrics, evidence, transactionRefs: { r1: transaction.id, r2: transaction.id } }, prepared.lease)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await prepared.store.readBillAnalysisReport(session, { scope })).toBeNull();
    await raw.transaction.delete({ where: { id: transaction.id } });
  });

  it("shares task state with current household sessions while keeping the original UUID private", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    const newAppSession = await raw.appSession.create({ data: { userId: session.id, memberId: session.memberId, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
    const newerSession = { ...session, appSessionId: newAppSession.id };
    const memberUser = await raw.user.create({ data: { email: `reader-${randomUUID()}@example.com`, displayName: "Reader", passwordHash: "not-used" } });
    ownedUsers.push(memberUser.id);
    const member = await raw.householdMember.create({ data: { householdId: session.householdId, userId: memberUser.id, role: "MEMBER", memberName: "Reader" } });
    const memberAppSession = await raw.appSession.create({ data: { userId: memberUser.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
    const readerSession = { id: memberUser.id, memberId: member.id, householdId: session.householdId, appSessionId: memberAppSession.id };
    for (const viewer of [newerSession, readerSession]) {
      const shared = await prepared.store.listBillAnalysisEntries(viewer);
      expect(shared.entries).toHaveLength(1);
      expect(shared.active?.task).toMatchObject({ status: "processing", canCancel: false });
      expect(shared.active?.task).not.toHaveProperty("requestId");
      const encoded = JSON.stringify(shared);
      for (const privateValue of [prepared.requestId, session.appSessionId, prepared.lease.token, getBillAnalysisOwner().id]) expect(encoded).not.toContain(privateValue);
      for (const privateField of ["ownerId", "originalAppSessionId", "leaseToken", "inputHash", "transactionRefs"]) expect(encoded).not.toContain(privateField);
    }
    await expect(prepared.store.cancelBillAnalysisRequest(newerSession, prepared.requestId)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await prepared.store.cancelBillAnalysisRequest(readerSession, prepared.requestId)).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
    expect(await prepared.store.queryBillAnalysisRequest(session, prepared.requestId)).toMatchObject({ status: "processing" });
    const other = await fixture();
    expect(await prepared.store.listBillAnalysisEntries(other)).toEqual({ entries: [], cursor: null, active: null });
    await raw.appSession.update({ where: { id: session.appSessionId }, data: { revokedAt: new Date() } });
    await expect(prepared.store.listBillAnalysisEntries(session)).rejects.toThrow("Unauthorized");
  });

  it("persists progress only for the original active owner and lease without moving the report slot", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    const slot = await raw.billAnalysisReport.findUniqueOrThrow({ where: { id: prepared.admitted.reportId } });
    const progress = { phase: "analyzing" as const, completedBatches: 1, totalBatches: 2 };
    await prepared.store.updateBillAnalysisProgress(session, prepared.requestId, progress, prepared.lease);
    expect(await prepared.store.queryBillAnalysisRequest(session, prepared.requestId)).toMatchObject({ status: "processing", ...progress });
    expect((await prepared.store.listBillAnalysisEntries(session)).active?.task).toMatchObject(progress);
    expect((await raw.billAnalysisReport.findUniqueOrThrow({ where: { id: slot.id } })).updatedAt).toEqual(slot.updatedAt);
    const request = await raw.billAnalysisRequest.findFirstOrThrow({ where: { householdId: session.householdId, clientRequestId: prepared.requestId } });
    expect(request.definition).toMatchObject({ progress });
    await expect(prepared.store.updateBillAnalysisProgress(session, prepared.requestId, progress, { ...prepared.lease, token: randomUUID() })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await raw.billAnalysisRequest.update({ where: { id: request.id }, data: { ownerId: randomUUID() } });
    await expect(prepared.store.updateBillAnalysisProgress(session, prepared.requestId, progress, prepared.lease)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await raw.billAnalysisRequest.update({ where: { id: request.id }, data: { ownerId: getBillAnalysisOwner().id } });
    await raw.billAnalysisReport.update({ where: { id: slot.id }, data: { activeRequestId: null } });
    await expect(prepared.store.updateBillAnalysisProgress(session, prepared.requestId, progress, prepared.lease)).rejects.toMatchObject({ code: "CONFLICT" });
    await raw.billAnalysisReport.update({ where: { id: slot.id }, data: { activeRequestId: request.id } });
    await expect(prepared.store.updateBillAnalysisProgress(session, prepared.requestId, { ...progress, completedBatches: 0 }, prepared.lease)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(prepared.store.updateBillAnalysisProgress(session, prepared.requestId, { ...progress, totalBatches: 3 }, prepared.lease)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(prepared.store.updateBillAnalysisProgress(session, prepared.requestId, { ...progress, completedBatches: 3 }, prepared.lease)).rejects.toThrow();
    await prepared.store.cancelBillAnalysisRequest(session, prepared.requestId);
    await expect(prepared.store.updateBillAnalysisProgress(session, prepared.requestId, progress, prepared.lease)).rejects.toMatchObject({ code: "CANCELLED" });
    await prepared.store.failBillAnalysisRequest(session, prepared.requestId, "CANCELLED");
    await expect(prepared.store.updateBillAnalysisProgress(session, prepared.requestId, progress, prepared.lease)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await prepared.store.queryBillAnalysisRequest(session, prepared.requestId)).toMatchObject({ status: "error", error: "CANCELLED", ...progress });
  });

  it("reads legacy definitions without inventing progress and does not attach old unassociated failures", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    const request = await raw.billAnalysisRequest.findFirstOrThrow({ where: { householdId: session.householdId, clientRequestId: prepared.requestId } });
    const { progress: _progress, ...definition } = request.definition as Record<string, Prisma.InputJsonValue>;
    void _progress;
    await raw.billAnalysisRequest.update({ where: { id: request.id }, data: { definition } });
    await raw.billAnalysisRequest.create({ data: { householdId: session.householdId, createdByMemberId: session.memberId, originalAppSessionId: session.appSessionId, clientRequestId: randomUUID(), status: "FAILED", errorCode: "UNAVAILABLE", modeRevision: 0, configMode: "UNENCRYPTED", definition: { scope: { ...scope, period: "2026-09" }, locale: "zh-CN" } } });
    const shared = await prepared.store.listBillAnalysisEntries(session);
    expect(shared.entries).toHaveLength(1);
    expect(shared.active?.task).toMatchObject({ phase: null, completedBatches: 0, totalBatches: 0 });
    expect(await prepared.store.queryBillAnalysisRequest(session, prepared.requestId)).not.toHaveProperty("phase");
    await prepared.store.updateBillAnalysisProgress(session, prepared.requestId, { phase: "waiting", completedBatches: 0, totalBatches: 2 }, prepared.lease);
    expect((await prepared.store.listBillAnalysisEntries(session)).active?.task?.phase).toBe("waiting");
  });

  it("paginates twenty slots by activity and ID while returning an active slot outside the page", async () => {
    const session = await fixture();
    const prepared = await prepare(session);
    const tiedAt = new Date("2026-10-15T00:00:00.000Z");
    const records = Array.from({ length: 23 }, (_, index) => ({ id: `synthetic-slot-${String(index).padStart(2, "0")}-${randomUUID()}`, householdId: session.householdId, createdByMemberId: session.memberId, definition: { scope: { ...scope, mode: "year", period: String(2000 + index) } }, updatedAt: tiedAt }));
    await raw.billAnalysisReport.createMany({ data: records });
    await raw.billAnalysisReport.update({ where: { id: prepared.admitted.reportId }, data: { updatedAt: new Date("2026-10-01T00:00:00.000Z") } });
    const expected = records.map((row) => row.id).sort().reverse();
    const first = await prepared.store.listBillAnalysisEntries(session);
    expect(first.entries.map((row) => row.id)).toEqual(expected.slice(0, 20));
    expect(first.active?.id).toBe(prepared.admitted.reportId);
    expect(first.cursor).toBeTypeOf("string");
    const second = await prepared.store.listBillAnalysisEntries(session, first.cursor!);
    expect(second.entries.map((row) => row.id)).toEqual([...expected.slice(20), prepared.admitted.reportId]);
    expect(second.cursor).toBeNull();
    expect(second.active?.id).toBe(prepared.admitted.reportId);
    expect(new Set([...first.entries, ...second.entries].map((row) => row.id)).size).toBe(24);
    await expect(prepared.store.listBillAnalysisEntries(session, "invalid!cursor")).rejects.toMatchObject({ code: "INVALID" });
    await prepared.store.failBillAnalysisRequest(session, prepared.requestId, "UNAVAILABLE");
    const refreshed = await prepared.store.listBillAnalysisEntries(session);
    expect(refreshed.entries[0]).toMatchObject({ id: prepared.admitted.reportId, task: { status: "error" } });
    expect(refreshed.active).toBeNull();
  });

  it("decrypts only the selected encrypted slots and their latest attempts", async () => {
    const [{ db }, store, { createHouseholdCode, createKeyRing, sealKeyRing }, { runEncryptionContext }] = await Promise.all([
      import("@/lib/db"), import("@/lib/reports/bill-analysis-store"), import("@/lib/encryption/crypto"), import("@/lib/encryption/request-context"),
    ]);
    const session = await fixture();
    await raw.ledger.deleteMany({ where: { householdId: session.householdId } });
    const code = createHouseholdCode(session.householdId);
    const ring = createKeyRing(code);
    await raw.householdEncryption.create({ data: { householdId: session.householdId, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: 1, sealedKeyRing: await sealKeyRing(code, ring) } });
    const tiedAt = new Date("2026-10-15T00:00:00.000Z");
    const slots = Array.from({ length: 23 }, (_, index) => ({ id: `encrypted-slot-${String(index).padStart(2, "0")}-${randomUUID()}`, requestRowId: randomUUID(), scope: { ...scope, mode: "year" as const, period: String(2000 + index) } }));
    await runEncryptionContext({ session: { ...session, role: "OWNER" }, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1, ring, expiresAt: Date.now() + 60_000, disposed: false, readOnly: false }, async () => {
      await db.ledger.create({ data: { householdId: session.householdId, name: "Encrypted default", isDefault: true } });
      await db.billAnalysisReport.createMany({ data: slots.map((slot) => ({ id: slot.id, householdId: session.householdId, createdByMemberId: session.memberId, definition: { scope: slot.scope }, updatedAt: tiedAt })) });
      await db.billAnalysisRequest.createMany({ data: slots.map((slot, index) => ({ id: slot.requestRowId, householdId: session.householdId, createdByMemberId: session.memberId, originalAppSessionId: session.appSessionId, clientRequestId: randomUUID(), reportId: slot.id, status: index === 1 ? "RUNNING" as const : "FAILED" as const, errorCode: index === 1 ? null : "UNAVAILABLE", modeRevision: 1, configMode: "ENCRYPTED", deadlineAt: new Date(Date.now() + 480_000), definition: { scope: slot.scope, locale: "zh-CN", progress: { phase: "analyzing", completedBatches: 1, totalBatches: 2 } } })) });
      await raw.billAnalysisReport.update({ where: { id: slots[1].id }, data: { activeRequestId: slots[1].requestRowId, updatedAt: tiedAt } });
      await raw.billAnalysisReport.update({ where: { id: slots[0].id }, data: { encryptedPayload: "synthetic-unselected-corrupt-report", updatedAt: tiedAt } });
      await raw.billAnalysisRequest.createMany({ data: Array.from({ length: 150 }, () => ({ householdId: session.householdId, createdByMemberId: session.memberId, originalAppSessionId: session.appSessionId, clientRequestId: randomUUID(), reportId: slots[22].id, status: "FAILED" as const, modeRevision: 1, configMode: "ENCRYPTED", encryptedPayload: "synthetic-unselected-corrupt-attempt", encryptionRevision: randomUUID(), createdAt: new Date("2020-01-01T00:00:00.000Z") })) });
      const result = await store.listBillAnalysisEntries(session);
      expect(result.entries.map((entry) => entry.id)).toEqual(slots.slice(3).map((slot) => slot.id).reverse());
      expect(result.entries.every((entry) => entry.task?.phase === "analyzing" && entry.task.error === "UNAVAILABLE")).toBe(true);
      expect(result.active).toMatchObject({ id: slots[1].id, task: { status: "processing", phase: "analyzing", completedBatches: 1, totalBatches: 2 } });
      expect(result.cursor).toBeTypeOf("string");
      expect(JSON.stringify(result)).not.toContain("encryptedPayload");
    });
    code.secret = "";
  });

  it("serializes a racing initial claim and no-receipt query on the same UUID", async () => {
    const store = await import("@/lib/reports/bill-analysis-store");
    const session = await fixture();
    const requestId = randomUUID();
    let acquisitions = 0;
    const [queried, claimed] = await Promise.all([
      store.queryBillAnalysisRequest(session, requestId),
      store.claimBillAnalysisRequest(session, { requestId, scope, locale: "zh-CN", deadlineAt: new Date(Date.now() + 480_000), owner: { id: randomUUID(), runtime: "synthetic", pid: 123, startedAt: new Date() } }, async (tx) => { acquisitions++; return acquireResourceLease(tx, session, "ai", { profile: "bill-analysis", deferCharge: true }); }),
    ]);
    expect(await raw.billAnalysisRequest.count({ where: { householdId: session.householdId, clientRequestId: requestId } })).toBe(1);
    if (claimed.created) { expect(queried.status).toBe("processing"); expect(acquisitions).toBe(1); }
    else { expect(queried).toMatchObject({ status: "error", error: "NOT_ACCEPTED" }); expect(claimed.result).toMatchObject({ status: "error", error: "NOT_ACCEPTED" }); expect(acquisitions).toBe(0); }
  });
});
