import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AppSessionUser } from "@/auth";
import { createHouseholdCode, createKeyRing, encodeHouseholdCode, exportRecoveryPackage, openKeyRing, openRecoveryPackage, sealKeyRing } from "@/lib/encryption/crypto";
import { runEncryptionContext } from "@/lib/encryption/request-context";
process.loadEnvFile(".env.example");
const raw = new PrismaClient();
const households: string[] = [], users: string[] = [];
let prepareEncryption: typeof import("@/lib/encryption/service").prepareEncryption;
let service: typeof import("@/lib/encryption/service");
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) throw new Error("A local development/test database is required");
  service = await import("@/lib/encryption/service");
  ({ prepareEncryption } = service);
});
afterAll(async () => {
  await raw.billAnalysisRequest.deleteMany({ where: { householdId: { in: households } } });
  await raw.billAnalysisReport.deleteMany({ where: { householdId: { in: households } } });
  await raw.household.deleteMany({ where: { id: { in: households } } });
  await raw.user.deleteMany({ where: { id: { in: users } } });
  await raw.$disconnect();
});

it("converts analysis reports and terminal receipts, reads them with the current key and preserves them after disabling", async () => {
  const f = await lifecycleFixture();
  const scope = { mode: "month" as const, period: "2026-10", ledgerId: null, actorMemberId: null };
  const content = { locale: "zh-CN", range: { from: "2026-10-01", to: "2026-10-31" }, snapshotAt: new Date().toISOString(), body: { overview: "PRIVATE_BILL_REPORT", observations: [], recommendations: [], limitations: [] }, metrics: [], evidence: [] };
  const report = await raw.billAnalysisReport.create({ data: { householdId: f.h.id, createdByMemberId: f.member.id, definition: { scope }, content, inputHash: "b".repeat(64), generation: 1, generatedAt: new Date() } });
  const request = await raw.billAnalysisRequest.create({ data: { householdId: f.h.id, createdByMemberId: f.member.id, originalAppSessionId: f.appSession.id, clientRequestId: randomUUID(), reportId: report.id, generation: 1, status: "SUCCEEDED", configMode: "UNENCRYPTED", modeRevision: 0, definition: { scope, locale: "zh-CN", inputHash: "b".repeat(64), snapshotAt: content.snapshotAt, range: content.range } } });
  const enabled = await complete(f, "ENABLE", 0, f.code, f.ring);
  const storedReport = await raw.billAnalysisReport.findUniqueOrThrow({ where: { id: report.id } });
  expect(storedReport.definition).toBeNull();
  expect(storedReport.content).toBeNull();
  expect(storedReport.inputHash).toBeNull();
  expect(JSON.stringify(storedReport)).not.toContain("PRIVATE_BILL_REPORT");
  expect((await raw.billAnalysisRequest.findUniqueOrThrow({ where: { id: request.id } })).definition).toBeNull();
  const nextCode = createHouseholdCode(f.h.id, f.code.generation, 2), nextRing = createKeyRing(nextCode, f.ring);
  const rotated = await complete(f, "ROTATE", enabled.result.status.revision, nextCode, nextRing, f.code);
  const store = await import("@/lib/reports/bill-analysis-store");
  const { db } = await import("@/lib/db");
  await expect(store.readBillAnalysisReport(f.session, { reportId: report.id })).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
  await runEncryptionContext({ session: f.session, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: rotated.result.status.revision, ring: structuredClone(nextRing), expiresAt: Date.now() + 60000, disposed: false, readOnly: true }, async () => {
    expect(await store.readBillAnalysisReport(f.session, { reportId: report.id })).toMatchObject(content);
    expect(await store.queryBillAnalysisRequest(f.session, request.clientRequestId)).toMatchObject({ status: "success", generation: 1 });
    expect(() => db.$queryRaw`SELECT content FROM "BillAnalysisReport" FOR SHARE`).toThrow("Financial SQL requires the encryption adapter");
  });
  await complete(f, "DISABLE", rotated.result.status.revision, nextCode, nextRing, nextCode);
  expect(await raw.billAnalysisReport.findUniqueOrThrow({ where: { id: report.id } })).toEqual(report);
  expect(await raw.billAnalysisRequest.findUniqueOrThrow({ where: { id: request.id } })).toEqual(request);
});
export async function lifecycleFixture() {
  const h = await raw.household.create({ data: { name: "Lifecycle fixture" } }); households.push(h.id);
  const user = await raw.user.create({ data: { email: `life-${randomUUID()}@example.com`, displayName: "Fixture", passwordHash: "fixture" } }); users.push(user.id);
  const member = await raw.householdMember.create({ data: { householdId: h.id, userId: user.id, role: "OWNER", memberName: "Fixture" } });
  const ledger = await raw.ledger.create({ data: { householdId: h.id, name: "PRIVATE_LIFECYCLE_LEDGER", isDefault: true } });
  const appSession = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 600000) } });
  const code = createHouseholdCode(h.id), ring = createKeyRing(code);
  const recovery = await exportRecoveryPackage(code, ring);
  const input = { id: randomUUID(), kind: "ENABLE", expectedRevision: 0, candidateKeyRing: await sealKeyRing(code, ring), candidateRecoveryPackage: recovery, recoveryDigest: createHash("sha256").update(recovery).digest("hex"), candidateBackedUp: true };
  const session = { id: user.id, householdId: h.id, memberId: member.id, appSessionId: appSession.id, role: "OWNER", name: "Fixture", email: user.email } as AppSessionUser;
  return { h, user, member, ledger, appSession, code, ring, input, session };
}
it("prepares a family barrier without receiving any master code and retains the original source", async () => {
  const f = await lifecycleFixture();
  const result = await prepareEncryption(f.session, f.input);
  expect(result.status.mode).toBe("ENABLING");
  expect(result.status.revision).toBe(1);
  expect(await raw.ledger.findUnique({ where: { id: f.ledger.id } })).toMatchObject({ name: "PRIVATE_LIFECYCLE_LEDGER" });
});

async function complete(f: Awaited<ReturnType<typeof lifecycleFixture>>, kind: string, revision: number, code: ReturnType<typeof createHouseholdCode>, ring: ReturnType<typeof createKeyRing>, previousCode?: ReturnType<typeof createHouseholdCode>) {
  const recovery = await exportRecoveryPackage(code, ring);
  const input = { id: randomUUID(), kind, expectedRevision: revision, candidateKeyRing: await sealKeyRing(code, ring), candidateRecoveryPackage: recovery, recoveryDigest: createHash("sha256").update(recovery).digest("hex"), candidateBackedUp: true };
  const receipt = await service.prepareEncryption(f.session, input);
  const material = { ...input, candidateCode: encodeHouseholdCode(code), ...(previousCode ? { encryption: { code: encodeHouseholdCode(previousCode), revision: receipt.status.revision } } : {}) };
  if (kind !== "ROTATE") {
    let done = false;
    for (let attempt = 0; attempt < 100 && !done; attempt++) done = (await service.batchEncryption(f.session, material)).done;
    expect(done).toBe(true);
  }
  const result = await service.commitEncryption(f.session, material);
  expect(result.operation?.status).toBe("COMMITTED");
  expect(await service.commitEncryption(f.session, material)).toEqual(result);
  return { result, input, material };
}

it("converts all history, independently rotates, restores old ciphertext with the current code, disables and starts a new cycle", async () => {
  const f = await lifecycleFixture();
  const category = await raw.category.findFirstOrThrow();
  const occurredAt = new Date("2026-10-02T03:04:05.678+08:00");
  const transaction = await raw.transaction.create({ data: { householdId: f.h.id, ledgerId: f.ledger.id, type: "INCOME", categoryId: category.id, actorMemberId: f.member.id, createdByMemberId: f.member.id, amountFen: 126756, occurredAt, note: "PRIVATE_FINANCE_HISTORY", source: "PRIVATE_SOURCE", sourceFingerprint: "PRIVATE_FINGERPRINT", deletedAt: new Date() } });
  const draft = await raw.importDraft.create({ data: { householdId: f.h.id, ledgerId: f.ledger.id, createdByMemberId: f.member.id, source: "PRIVATE_IMPORT_SOURCE", fileName: "PRIVATE_STATEMENT.xlsx", status: "COMPLETED", rows: { create: { rowNumber: 1, status: "INVALID", rawAmount: "PRIVATE_INVALID_AMOUNT", duplicateCandidates: { raw: "PRIVATE_ARBITRARY_JSON", nested: [1, null, { type: "Date", value: "not-a-date" }] }, refundSourceFingerprints: ["PRIVATE_REFUND"] } } }, include: { rows: true } });
  const nl = await raw.naturalLanguageRequest.create({ data: { householdId: f.h.id, ledgerId: f.ledger.id, createdByMemberId: f.member.id, clientRequestId: randomUUID(), inputHash: "PRIVATE_ORIGINAL_INPUT_HASH", status: "SUCCEEDED", result: { amountFen: 126756, note: "PRIVATE_RESULT" }, issues: { x: "PRIVATE_ISSUE" }, referenceAt: occurredAt } });
  const event = await raw.appEvent.create({ data: { householdId: f.h.id, memberId: f.member.id, eventType: "IMPORT_CONFIRMED", summary: "PRIVATE_EVENT_SUMMARY", metadata: { count: 126756, source: "PRIVATE_EVENT_SOURCE" } } });
  const authBefore = await raw.appSession.findUniqueOrThrow({ where: { id: f.appSession.id } });
  const enabled = await complete(f, "ENABLE", 0, f.code, f.ring);
  expect(await raw.appSession.findUniqueOrThrow({ where: { id: f.appSession.id } })).toEqual(authBefore);
  const savedCipher = await raw.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
  expect(JSON.stringify(savedCipher)).not.toContain("PRIVATE_");
  expect(savedCipher.amountFen).toBe(0);
  expect(JSON.stringify(await raw.importDraft.findUnique({ where: { id: draft.id }, include: { rows: true } }))).not.toContain("PRIVATE_");
  expect(JSON.stringify(await raw.naturalLanguageRequest.findUnique({ where: { id: nl.id } }))).not.toContain("PRIVATE_");
  expect(JSON.stringify(await raw.appEvent.findUnique({ where: { id: event.id } }))).not.toContain("PRIVATE_");
  const nextCode = createHouseholdCode(f.h.id, f.code.generation, 2), nextRing = createKeyRing(nextCode, f.ring);
  const rotated = await complete(f, "ROTATE", enabled.result.status.revision, nextCode, nextRing, f.code);
  expect(rotated.result.status.mode).toBe("ENCRYPTED");
  const current = await raw.householdEncryption.findUniqueOrThrow({ where: { householdId: f.h.id } });
  await expect(openKeyRing(f.code, current.sealedKeyRing!)).rejects.toThrow();
  const restored = await openRecoveryPackage(nextCode, await exportRecoveryPackage(nextCode, nextRing));
  const { decryptRow } = await import("@/lib/encryption/protected-models");
  expect(await decryptRow("transaction", savedCipher, restored, f.h.id)).toMatchObject({ amountFen: 126756, occurredAt, note: transaction.note, sourceFingerprint: transaction.sourceFingerprint });
  const { db } = await import("@/lib/db");
  await expect(db.transaction.findUnique({ where: { id: transaction.id } })).rejects.toMatchObject({ code: "ENCRYPTION_REQUIRED" });
  await runEncryptionContext({ session: f.session, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: current.revision, ring: structuredClone(nextRing), expiresAt: Date.now() + 60000, disposed: false, readOnly: true }, async () => {
    expect(await db.importDraftRow.findUniqueOrThrow({ where: { id: draft.rows[0].id } })).toMatchObject({ rawAmount: "PRIVATE_INVALID_AMOUNT", duplicateCandidates: draft.rows[0].duplicateCandidates, refundSourceFingerprints: ["PRIVATE_REFUND"] });
    expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: nl.id } })).toMatchObject({ inputHash: nl.inputHash, result: nl.result, referenceAt: nl.referenceAt });
  });
  const disabled = await complete(f, "DISABLE", current.revision, nextCode, nextRing, nextCode);
  expect(disabled.result.status.mode).toBe("UNENCRYPTED");
  expect(await raw.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).toEqual(transaction);
  expect(await raw.importDraft.findUniqueOrThrow({ where: { id: draft.id }, include: { rows: true } })).toEqual(draft);
  const newCode = createHouseholdCode(f.h.id), newRing = createKeyRing(newCode, nextRing);
  const reenabled = await complete(f, "ENABLE", disabled.result.status.revision, newCode, newRing, nextCode);
  expect(reenabled.result.status.generation).not.toBe(nextCode.generation);
  expect(await decryptRow("transaction", savedCipher, await openRecoveryPackage(newCode, await exportRecoveryPackage(newCode, newRing)), f.h.id)).toMatchObject({ note: transaction.note });
}, 120000);

it("keeps unknown receipts, makes cancellation terminal, fences old requests and refuses a new session publishing an old attempt", async () => {
  const f = await lifecycleFixture();
  const missing = randomUUID();
  expect(await service.queryEncryption(f.session, { id: missing })).toMatchObject({ operation: null, unknown: true });
  expect(await service.abortEncryption(f.session, { id: missing })).toMatchObject({ operation: { status: "ABORTED" } });
  await expect(service.prepareEncryption(f.session, { ...f.input, id: missing })).rejects.toMatchObject({ code: "ENCRYPTION_CHANGED" });
  await service.prepareEncryption(f.session, f.input);
  const another = await raw.appSession.create({ data: { userId: f.user.id, memberId: f.member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60000) } });
  const fresh = { ...f.session, appSessionId: another.id };
  expect(await service.queryEncryption(fresh, { id: f.input.id })).toMatchObject({ operation: { status: "PREPARED" } });
  await expect(service.commitEncryption(fresh, { ...f.input, candidateCode: encodeHouseholdCode(f.code) })).rejects.toMatchObject({ code: "ENCRYPTION_EXPIRED" });
  expect(await service.abortEncryption(fresh, { id: f.input.id })).toMatchObject({ operation: { status: "ABORTED" }, status: { mode: "UNENCRYPTED", revision: 2 } });
  expect(await service.commitEncryption(f.session, { id: f.input.id })).toMatchObject({ operation: { status: "ABORTED" } });
});
