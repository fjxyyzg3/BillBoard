import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { createHouseholdCode, createKeyRing, encodeHouseholdCode, exportRecoveryPackage, openRecoveryPackage, parseHouseholdCode, sealKeyRing } from "@/lib/encryption/crypto";
import { decryptRow, modelInfo, protectedFields, protectedModels, rowFromJson, rowToJson, type DataRow, type ProtectedModel } from "@/lib/encryption/protected-models";
import { encryptRow } from "@/lib/encryption/protected-models";
import { canonicalJson } from "@/lib/encryption/codec";
import { captureFinancialSnapshot, inspectRecoveryFoundation, restoreFinancialSnapshot, verifyFinancialSnapshot,
  type FinancialRecoveryBundle, type RecoveryCheckpoint, type RecoveryMaterial } from "@/lib/encryption/recovery";
import type { ReconciliationApplyInput, ReconciliationApplyOutcome } from "@/lib/reports/bill-reconciliation-types";

type Delegate = { findMany(args?: DataRow): Promise<DataRow[]>; update(args: DataRow): Promise<unknown>; deleteMany(args?: DataRow): Promise<unknown>; count(): Promise<number> };
const delegate = (client: PrismaClient, model: ProtectedModel) => (client as unknown as Record<string, Delegate>)[model];

it("rejects authentication tables in a financial recovery snapshot before connecting to a target", async () => {
  await expect(verifyFinancialSnapshot({ snapshot: { v: 1, tables: { appSession: [{ sessionKey: "SYNTHETIC_FORBIDDEN_SESSION" }] } } }, {
    expectedManifestDigest: "0".repeat(64),
  })).rejects.toMatchObject({ code: "RECOVERY_INVALID" });
});

describe("independent household recovery into migrated empty PostgreSQL databases", () => {
  let admin: PrismaClient, source: PrismaClient, target: PrismaClient;
  let encrypted: Required<FinancialRecoveryBundle>, plaintext: Required<FinancialRecoveryBundle>, material: RecoveryMaterial, currentSealed: string;
  const ownedDatabases = new Set<string>();
  const sourceDatabase = `bb_recovery_source_${randomUUID().replaceAll("-", "")}_test`;
  const targetDatabase = `bb_recovery_target_${randomUUID().replaceAll("-", "")}_test`;
  const ids = Object.fromEntries(["household", "ownerUser", "formerUser", "currentUser", "ownerMember", "formerMember", "currentMember", "oldSession", "currentSession", "expense", "income", "ledger", "archive", "transaction", "deletedTransaction", "incomeTransaction", "pendingDraft", "completedDraft", "pendingRow", "completedRow", "categoryMapping", "memberMapping", "request", "requestUuid", "voice", "voiceUuid", "event", "billReport", "billRequest", "billUuid", "application", "applicationUuid"].map((key) => [key, randomUUID()]));
  const historicalDate = new Date("2026-01-01T00:00:00.123Z");
  const latestLeftAt = new Date("2026-10-21T01:02:03.456Z");

  function databaseName(name: string, requireOwnership = true) {
    if (!/^bb_recovery_(?:source|target)_[0-9a-f]{32}_test$/.test(name) || (requireOwnership && !ownedDatabases.has(name))) throw new Error("Unowned recovery database");
    return `"${name}"`;
  }
  async function migrate(url: string) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npx-cli.js"), "--offline", "--no-install", "prisma", "migrate", "deploy", "--schema", path.resolve("prisma/schema.prisma")], {
        cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
        env: { DATABASE_URL: url, NODE_ENV: "test", PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
      });
      let diagnostic = "";
      child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-16384); });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated recovery migration timed out")); }, 60_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Isolated recovery migration could not start")); });
      child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Isolated recovery migration failed (${diagnostic.match(/\b(?:P\d{4}|ENOENT|EACCES|ENOTFOUND)\b/)?.[0] ?? "CLI"})`)); });
    });
  }
  async function applicationWorker<T>(url: string, input: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.resolve("tests/integration/bill-reconciliation-recovery-worker.ts")], {
        cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { DATABASE_URL: url, NODE_ENV: "test", PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
      });
      let output = "", diagnostic = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (Buffer.byteLength(output) > 32 * 1024) child.kill(); });
      child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4096); });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated application worker timed out")); }, 45_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Isolated application worker could not start")); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`Isolated application worker failed (${diagnostic.match(/\b(?:Error|TypeError|ZodError|PrismaClientKnownRequestError|PrismaClientValidationError)\b/)?.[0] ?? "process"})`));
        try { resolve(JSON.parse(output) as T); } catch { reject(new Error("Isolated application worker returned invalid JSON")); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
  async function createCategories(client: PrismaClient) {
    await client.category.createMany({ data: [{ id: ids.expense, type: "EXPENSE", name: "Dining", sortOrder: 1 }, { id: ids.income, type: "INCOME", name: "Salary", sortOrder: 2 }] });
  }
  async function sourceFixture() {
    await source.household.create({ data: { id: ids.household, name: "Synthetic recovery source" } });
    await source.user.createMany({ data: [{ id: ids.ownerUser, email: "source-owner@example.com", displayName: "Old owner", passwordHash: "SYNTHETIC_HASH_NEVER_BACKED_UP" }, { id: ids.formerUser, email: "source-former@example.com", displayName: "Historical member", passwordHash: "SYNTHETIC_HASH_NEVER_BACKED_UP" }] });
    await source.householdMember.createMany({ data: [{ id: ids.ownerMember, householdId: ids.household, userId: ids.ownerUser, memberName: "Original owner", role: "OWNER" }, { id: ids.formerMember, householdId: ids.household, userId: ids.formerUser, memberName: "Historical member", role: "MEMBER", leftAt: historicalDate }] });
    await source.appSession.create({ data: { id: ids.oldSession, userId: ids.ownerUser, memberId: ids.ownerMember, sessionKey: "SYNTHETIC_SESSION_NEVER_BACKED_UP", expiresAt: new Date(Date.now() + 86400000) } });
    await createCategories(source);
    await source.ledger.createMany({ data: [{ id: ids.ledger, householdId: ids.household, name: "PRIVATE_RECOVERY_LEDGER", isDefault: true, acceptsLegacyDrafts: true }, { id: ids.archive, householdId: ids.household, name: "PRIVATE_RECOVERY_ARCHIVE", archivedAt: historicalDate }] });
    await source.transaction.createMany({ data: [
      { id: ids.transaction, householdId: ids.household, ledgerId: ids.ledger, actorMemberId: ids.formerMember, createdByMemberId: ids.ownerMember, clientRequestId: randomUUID(), type: "EXPENSE", amountFen: 12345, categoryId: ids.expense, occurredAt: new Date("2026-09-30T16:00:00.789Z"), note: "PRIVATE_RECOVERY_NOTE", source: "wechat_pay", sourceFingerprint: "ORIGINAL_SOURCE_FINGERPRINT", sourceImportedAt: historicalDate },
      { id: ids.deletedTransaction, householdId: ids.household, ledgerId: ids.archive, actorMemberId: ids.ownerMember, createdByMemberId: ids.ownerMember, type: "EXPENSE", amountFen: 1000, categoryId: ids.expense, occurredAt: new Date("2026-01-01T00:00:00.123Z"), deletedAt: historicalDate, note: "SOFT_DELETED_RECOVERY_NOTE" },
      { id: ids.incomeTransaction, householdId: ids.household, ledgerId: ids.ledger, actorMemberId: ids.ownerMember, createdByMemberId: ids.ownerMember, type: "INCOME", amountFen: 89012, categoryId: ids.income, occurredAt: new Date("2026-10-01T01:02:03.456Z") },
    ] });
    await source.importDraft.createMany({ data: [{ id: ids.pendingDraft, householdId: ids.household, ledgerId: ids.ledger, createdByMemberId: ids.ownerMember, source: "wechat_pay", fileName: "PRIVATE_PENDING_FILE.xlsx" }, { id: ids.completedDraft, householdId: ids.household, ledgerId: ids.archive, createdByMemberId: ids.ownerMember, source: "alipay", fileName: "PRIVATE_COMPLETED_FILE.csv", status: "COMPLETED", completedAt: historicalDate }] });
    await source.importDraftRow.createMany({ data: [
      { id: ids.pendingRow, draftId: ids.pendingDraft, rowNumber: 1, transactionType: "EXPENSE", occurredAt: new Date("2026-10-01T00:00:00.123Z"), occurredDate: "2026-10-01", amountFen: 12345, actorMemberId: ids.formerMember, createdByMemberId: ids.ownerMember, actorExternalName: "PRIVATE_EXTERNAL_NAME", categoryId: ids.expense, primaryCategory: "餐饮", secondaryCategory: "三餐", mappingKey: "ORIGINAL_MAPPING_KEY", note: "PRIVATE_DRAFT_NOTE", sourceFingerprint: "ORIGINAL_DRAFT_FINGERPRINT", refundOriginalAmountFen: 15000, refundSourceFingerprints: ["REFUND_RELATION_A", "REFUND_RELATION_B"], status: "READY", rawTransactionType: "支出", rawDate: "2026-10-01", rawAmount: "123.45", rawMember: "PRIVATE_EXTERNAL_NAME", rawCreatedBy: "Original owner", rawCurrency: "CNY", duplicateCandidates: [{ id: ids.transaction, amountFen: 12345 }] },
      { id: ids.completedRow, draftId: ids.completedDraft, rowNumber: 2, transactionType: "EXPENSE", amountFen: 1000, actorMemberId: ids.ownerMember, createdByMemberId: ids.ownerMember, status: "USER_SKIPPED", userDecision: "SKIP", skipReason: "original user choice", refundSourceFingerprints: [] },
    ] });
    await source.importCategoryMapping.create({ data: { id: ids.categoryMapping, householdId: ids.household, source: "wechat_pay", transactionType: "EXPENSE", primaryCategory: "餐饮", secondaryCategory: "三餐", categoryId: ids.expense } });
    await source.importMemberMapping.create({ data: { id: ids.memberMapping, householdId: ids.household, source: "wechat_pay", externalName: "PRIVATE_EXTERNAL_NAME", memberId: ids.formerMember } });
    await source.naturalLanguageRequest.create({ data: { id: ids.request, householdId: ids.household, ledgerId: ids.ledger, createdByMemberId: ids.ownerMember, clientRequestId: ids.requestUuid, inputHash: "ORIGINAL_INPUT_HASH", referenceAt: historicalDate, status: "SUCCEEDED", result: { requestId: ids.requestUuid, resultVersion: 7, rows: [{ id: ids.transaction, amountFen: 12345, note: "PRIVATE_OLD_AI_RESULT" }] }, issues: [{ code: "ORIGINAL_ISSUE" }] } });
    await source.voiceProcessingAdmission.create({ data: { id: ids.voice, householdId: ids.household, userId: ids.ownerUser, memberId: ids.ownerMember, ledgerId: ids.ledger, appSessionId: ids.oldSession, clientRequestId: ids.voiceUuid, audioHash: "ORIGINAL_AUDIO_HASH", textHash: "ORIGINAL_TEXT_HASH", expiresAt: historicalDate, consumedAt: historicalDate } });
    await source.appEvent.create({ data: { id: ids.event, householdId: ids.household, memberId: ids.ownerMember, eventType: "TRANSACTION_CREATED", path: "/add", summary: "PRIVATE_RECOVERY_EVENT", metadata: { amountFen: 12345, original: { untouched: "PRIVATE_EVENT_PAYLOAD" }, count: 7 } } });
    const billScope = { mode: "month", period: "2026-10", ledgerId: ids.archive, actorMemberId: ids.formerMember };
    await source.billAnalysisReport.create({ data: { id: ids.billReport, householdId: ids.household, createdByMemberId: ids.ownerMember, generation: 1, generatedAt: historicalDate, definition: { scope: billScope }, inputHash: "f".repeat(64), content: { locale: "zh-CN", range: { from: "2026-10-01", to: "2026-10-31" }, snapshotAt: historicalDate.toISOString(), body: { overview: "PRIVATE_BILL_REPORT", observations: [], recommendations: [], limitations: [] }, metrics: [], evidence: [] } } });
    await source.billAnalysisRequest.create({ data: { id: ids.billRequest, householdId: ids.household, createdByMemberId: ids.ownerMember, originalAppSessionId: ids.oldSession, clientRequestId: ids.billUuid, status: "SUCCEEDED", reportId: ids.billReport, generation: 1, modeRevision: 0, configMode: "UNENCRYPTED", definition: { scope: billScope, locale: "zh-CN", inputHash: "f".repeat(64), snapshotAt: historicalDate.toISOString(), range: { from: "2026-10-01", to: "2026-10-31" } } } });
    await source.billReconciliationApplication.create({ data: { id: ids.application, householdId: ids.household, createdByMemberId: ids.ownerMember, clientRequestId: ids.applicationUuid, status: "REJECTED", reportId: ids.billReport, generation: 1,
      definition: { inputHash: "e".repeat(64), outcome: { requestId: ids.applicationUuid, status: "error", error: "CONFLICT", affectedSuggestionIds: ["s1"] } } } });
  }

  beforeAll(async () => {
    process.loadEnvFile(".env.example");
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) throw new Error("Recovery tests require a local development or test database");
    url.searchParams.set("schema", "public");
    admin = new PrismaClient({ datasourceUrl: url.toString() });
    const [{ version }] = await admin.$queryRaw<Array<{ version: string }>>`SELECT current_setting('server_version_num') AS version`;
    if (Number(version) < 170000 || Number(version) >= 180000) throw new Error("Recovery drills require PostgreSQL 17");
    const [{ allowed }] = await admin.$queryRaw<Array<{ allowed: boolean }>>`SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname=current_user`;
    if (!allowed) throw new Error("Isolated recovery requires local CREATE DATABASE permission");
    for (const database of [sourceDatabase, targetDatabase]) {
      await admin.$executeRawUnsafe(`CREATE DATABASE ${databaseName(database, false)} TEMPLATE template0`);
      ownedDatabases.add(database);
      const scoped = new URL(url); scoped.pathname = `/${database}`;
      await migrate(scoped.toString());
      const client = new PrismaClient({ datasourceUrl: scoped.toString() });
      const [{ name }] = await client.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      if (name !== database) throw new Error("Recovery client did not select its isolated database");
      if (database === sourceDatabase) source = client; else target = client;
    }
    await sourceFixture();
    plaintext = await captureFinancialSnapshot(source, ids.household);
    const oldCode = createHouseholdCode(ids.household), oldRing = createKeyRing(oldCode);
    const oldPackage = await exportRecoveryPackage(oldCode, oldRing);
    for (const model of protectedModels) for (const serialized of plaintext.snapshot.tables[model]) {
      const row = rowFromJson(model, serialized), parent = plaintext.snapshot.tables.importDraft.find((draft) => draft.id === row.draftId);
      const encoded = await encryptRow(model, row, oldRing, ids.household, ids.expense, parent ? String(parent.ledgerId) : undefined);
      const fields = [...protectedFields[model], "encryptedPayload", "encryptionRevision"];
      const data = Object.fromEntries(fields.map((field) => [field, encoded[field]]));
      if (model === "appEvent") data.metadata = Prisma.DbNull;
      if (model === "naturalLanguageRequest") { data.result = Prisma.DbNull; data.issues = Prisma.DbNull; }
      if (model === "importDraftRow") data.duplicateCandidates = Prisma.DbNull;
      if (model === "billAnalysisReport") { data.definition = Prisma.DbNull; data.content = Prisma.DbNull; }
      if (model === "billAnalysisRequest" || model === "billReconciliationApplication") data.definition = Prisma.DbNull;
      await delegate(source, model).update({ where: { id: row.id }, data });
    }
    await source.householdEncryption.create({ data: { householdId: ids.household, mode: "ENCRYPTED", revision: 2, generation: oldCode.generation, keyVersion: 1, sealedKeyRing: await sealKeyRing(oldCode, oldRing), recoveryDigest: createHash("sha256").update(oldPackage).digest("hex") } });
    encrypted = await captureFinancialSnapshot(source, ids.household, { code: encodeHouseholdCode(oldCode), recoveryPackage: oldPackage });
    const rotatedCode = createHouseholdCode(ids.household, oldCode.generation, 2), rotatedRing = createKeyRing(rotatedCode, oldRing);
    const currentCode = createHouseholdCode(ids.household), currentRing = createKeyRing(currentCode, rotatedRing);
    material = { code: encodeHouseholdCode(currentCode), recoveryPackage: await exportRecoveryPackage(currentCode, currentRing) };
    currentSealed = await sealKeyRing(currentCode, currentRing);
    for (const ring of [oldRing, rotatedRing, currentRing]) for (const key of ring.keys) key.secret = "";
    oldCode.secret = ""; rotatedCode.secret = ""; currentCode.secret = "";
    await source.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE ${databaseName(sourceDatabase)}`);
    ownedDatabases.delete(sourceDatabase);
  }, 120000);

  beforeEach(async () => {
    const [{ name }] = await target.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (name !== targetDatabase || !ownedDatabases.has(name)) throw new Error("Recovery cleanup requires its owned isolated target database");
    // These clients can clear only this drill's verified random database, never the development foundation.
    for (const model of ["billReconciliationApplication", "billAnalysisRequest", "billAnalysisReport", "appEvent", "voiceProcessingAdmission", "naturalLanguageRequest", "importCategoryMapping", "importMemberMapping", "importDraftRow", "importDraft", "transaction", "ledger"] as ProtectedModel[]) await delegate(target, model).deleteMany();
    await target.appSession.deleteMany();
    await target.householdMember.deleteMany();
    await target.household.deleteMany();
    await target.user.deleteMany();
    await target.category.deleteMany();
    await target.household.create({ data: { id: ids.household, name: "Current trusted foundation" } });
    await target.user.createMany({ data: [
      { id: ids.ownerUser, email: "latest-former-owner@example.com", displayName: "Deactivated old owner", passwordHash: "LATEST_SYNTHETIC_HASH", status: "DEACTIVATED" },
      { id: ids.formerUser, email: "latest-former-member@example.com", displayName: "Historical member", passwordHash: "LATEST_SYNTHETIC_HASH", status: "LOCKED" },
      { id: ids.currentUser, email: "latest-owner@example.com", displayName: "Current owner", passwordHash: "LATEST_SYNTHETIC_HASH" },
    ] });
    await target.householdMember.createMany({ data: [
      { id: ids.ownerMember, householdId: ids.household, userId: ids.ownerUser, memberName: "Former owner", role: "MEMBER", leftAt: latestLeftAt },
      { id: ids.formerMember, householdId: ids.household, userId: ids.formerUser, memberName: "Historical member", role: "MEMBER", leftAt: historicalDate },
      { id: ids.currentMember, householdId: ids.household, userId: ids.currentUser, memberName: "Current owner", role: "OWNER" },
    ] });
    await target.appSession.createMany({ data: [
      { id: ids.oldSession, userId: ids.ownerUser, memberId: ids.ownerMember, sessionKey: "CURRENT_REVOKED_SESSION", revokedAt: latestLeftAt, expiresAt: historicalDate },
      { id: ids.currentSession, userId: ids.currentUser, memberId: ids.currentMember, sessionKey: "CURRENT_TRUSTED_SESSION", expiresAt: new Date(Date.now() + 600000) },
    ] });
    await createCategories(target);
    const code = parseHouseholdCode(material.code);
    await target.householdEncryption.create({ data: { householdId: ids.household, mode: "ENCRYPTED", revision: 10, generation: code.generation, keyVersion: code.keyVersion, sealedKeyRing: currentSealed, recoveryDigest: createHash("sha256").update(material.recoveryPackage).digest("hex") } });
    code.secret = "";
  });

  afterAll(async () => {
    await source?.$disconnect(); await target?.$disconnect();
    if (admin) {
      for (const database of ownedDatabases) await admin.$executeRawUnsafe(`DROP DATABASE ${databaseName(database)}`);
      await admin.$disconnect();
    }
    if (material) material.code = "";
  });
  async function checkpoint(): Promise<RecoveryCheckpoint> {
    const checked = await inspectRecoveryFoundation(target, ids.household);
    const [{ now }] = await target.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return { v: 3, householdId: ids.household, checkedAt: now.toISOString(), authorizationDigest: checked.authorizationDigest,
      confirmedDeletedIds: { transaction: [], ledger: [], importDraft: [], importDraftRow: [], importCategoryMapping: [], importMemberMapping: [], naturalLanguageRequest: [], voiceProcessingAdmission: [], appEvent: [], billAnalysisReport: [], billAnalysisRequest: [], billReconciliationApplication: [] },
      transactionTombstones: [{ id: ids.deletedTransaction, deletedAt: historicalDate.toISOString() }] };
  }
  async function restore(bundle = encrypted, additions: Partial<Parameters<typeof restoreFinancialSnapshot>[2]> = {}) {
    return restoreFinancialSnapshot(target, bundle, { material, expectedManifestDigest: bundle.manifestDigest, checkpoint: await checkpoint(), ...additions });
  }
  function editedPlaintext(edit: (tables: FinancialRecoveryBundle["snapshot"]["tables"]) => void): Required<FinancialRecoveryBundle> {
    const bundle = structuredClone(plaintext);
    edit(bundle.snapshot.tables);
    const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value, 512 * 1024 * 1024)).digest("hex");
    const { proof, ...previous } = bundle.manifest;
    if (proof.kind !== "PLAINTEXT") throw new Error("The edited fixture must be plaintext");
    const base = { ...previous, snapshotDigest: hash(bundle.snapshot) };
    const logical = Object.fromEntries(protectedModels.map((model) => [model, bundle.snapshot.tables[model].map(({ encryptedPayload: _payload, encryptionRevision: _revision, ...row }) => { void _payload; void _revision; return row; })]));
    bundle.manifest = { ...base, proof: { kind: "PLAINTEXT", payload: { ...proof.payload, baseDigest: hash(base), contentDigest: hash(logical) } } };
    bundle.manifestDigest = hash(bundle.manifest);
    return bundle;
  }
  async function expectEmpty() {
    for (const model of protectedModels) expect(await delegate(target, model).count()).toBe(0);
  }
  async function chooseUnencryptedTarget(withHistory = true) {
    await target.householdEncryption.update({ where: { householdId: ids.household }, data: {
      mode: "UNENCRYPTED", revision: 11, sealedKeyRing: null,
      ...(!withHistory ? { generation: null, keyVersion: 0, recoveryDigest: null } : {}),
    } });
  }
  async function expectPlaintextTarget(bundle: FinancialRecoveryBundle) {
    const code = bundle.snapshot.source.mode === "ENCRYPTED" ? parseHouseholdCode(material.code) : null;
    const ring = code ? await openRecoveryPackage(code, material.recoveryPackage) : null;
    try {
      for (const model of protectedModels) {
        const expected: DataRow[] = [];
        for (const serialized of bundle.snapshot.tables[model]) {
          const row = rowFromJson(model, serialized), parent = bundle.snapshot.tables.importDraft.find((draft) => draft.id === row.draftId);
          const plain = ring ? await decryptRow(model, row, ring, ids.household, parent ? String(parent.ledgerId) : undefined) : row;
          expected.push({ ...rowToJson(model, plain), encryptedPayload: null, encryptionRevision: null });
        }
        const actual = (await delegate(target, model).findMany({ orderBy: { id: "asc" } })).map((row) => rowToJson(model, row));
        expect(actual).toEqual(expected.sort((a, b) => String(a.id).localeCompare(String(b.id))));
      }
      const recaptured = await captureFinancialSnapshot(target, ids.household);
      expect(recaptured.snapshot.source.mode).toBe("UNENCRYPTED");
      expect(await verifyFinancialSnapshot(recaptured, { expectedManifestDigest: recaptured.manifestDigest })).toMatchObject({ verified: true, counts: bundle.manifest.counts, groupCount: 3 });
    } finally { if (ring) for (const key of ring.keys) key.secret = ""; if (code) code.secret = ""; }
  }

  it("authenticates an old-cycle backup after the online database and every cached ring are gone", async () => {
    expect(await admin.$queryRaw<Array<{ present: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=${sourceDatabase}) AS present`).toEqual([{ present: false }]);
    expect(encrypted.snapshot.source.generation).not.toBe(parseHouseholdCode(material.code).generation);
    expect(JSON.stringify(encrypted)).not.toContain("SYNTHETIC_SESSION_NEVER_BACKED_UP");
    expect(JSON.stringify(encrypted)).not.toContain("SYNTHETIC_HASH_NEVER_BACKED_UP");
    expect(JSON.stringify(encrypted)).not.toContain("PRIVATE_RECOVERY_NOTE");
    expect(JSON.stringify(encrypted)).not.toContain("PRIVATE_BILL_REPORT");
    expect(await verifyFinancialSnapshot(encrypted, { material, expectedManifestDigest: encrypted.manifestDigest })).toMatchObject({ verified: true, groupCount: 3, counts: { transaction: 3, ledger: 2, importDraft: 2, importDraftRow: 2, appEvent: 1 } });
  });

  it("restores an original v1 package and v1 checkpoint without manufacturing new-entity proof", async () => {
    await chooseUnencryptedTarget(false);
    const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value, 512 * 1024 * 1024)).digest("hex");
    const models = protectedModels.filter((model) => model !== "billAnalysisReport" && model !== "billAnalysisRequest" && model !== "billReconciliationApplication");
    const tables = Object.fromEntries(models.map((model) => [model, structuredClone(plaintext.snapshot.tables[model])]));
    const snapshot = { ...structuredClone(plaintext.snapshot), v: 1, tables };
    const base = { v: 1, snapshotId: snapshot.id, householdId: snapshot.householdId, source: snapshot.source, snapshotDigest: hash(snapshot), counts: Object.fromEntries(models.map((model) => [model, tables[model].length])), requiredKeys: [] };
    const oldProof = plaintext.manifest.proof;
    if (oldProof.kind !== "PLAINTEXT") throw new Error("The historical fixture must be plaintext");
    const logical = Object.fromEntries(models.map((model) => [model, tables[model].map(({ encryptedPayload: _payload, encryptionRevision: _revision, ...row }) => { void _payload; void _revision; return row; })]));
    const manifest = { ...base, proof: { kind: "PLAINTEXT", payload: { ...oldProof.payload, baseDigest: hash(base), contentDigest: hash(logical) } } };
    const manifestDigest = hash(manifest);
    const checked = await checkpoint();
    const oldCheckpoint: RecoveryCheckpoint = { ...checked, v: 1, confirmedDeletedIds: Object.fromEntries<string[]>(models.map((model) => [model, []])) as Extract<RecoveryCheckpoint, { v: 1 }>["confirmedDeletedIds"] };
    expect(await restoreFinancialSnapshot(target, { snapshot, manifest, manifestDigest }, { expectedManifestDigest: manifestDigest, checkpoint: oldCheckpoint })).toMatchObject({ verified: true, groupCount: 3 });
    expect(await target.billAnalysisReport.count()).toBe(0);
    expect(await target.billAnalysisRequest.count()).toBe(0);
    expect(await target.transaction.count()).toBe(3);
  });

  it("requires an entity-complete checkpoint to restore a v3 package", async () => {
    const checked = await checkpoint();
    const { billAnalysisReport: _reports, billAnalysisRequest: _requests, billReconciliationApplication: _applications, ...oldDeleted } = checked.confirmedDeletedIds as Extract<RecoveryCheckpoint, { v: 3 }>["confirmedDeletedIds"];
    void _reports; void _requests; void _applications;
    const old: RecoveryCheckpoint = { ...checked, v: 1, confirmedDeletedIds: oldDeleted };
    await expect(restoreFinancialSnapshot(target, encrypted, { material, expectedManifestDigest: encrypted.manifestDigest, checkpoint: old })).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
    await expectEmpty();
  });

  it("restores a fixed v2 package without inventing proof for the new receipt entity", async () => {
    await chooseUnencryptedTarget(false);
    const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value, 512 * 1024 * 1024)).digest("hex");
    const models = protectedModels.filter((model) => model !== "billReconciliationApplication");
    const tables = Object.fromEntries(models.map((model) => [model, structuredClone(plaintext.snapshot.tables[model])]));
    const snapshot = { ...structuredClone(plaintext.snapshot), v: 2, tables };
    const base = { v: 2, snapshotId: snapshot.id, householdId: snapshot.householdId, source: snapshot.source, snapshotDigest: hash(snapshot), counts: Object.fromEntries(models.map((model) => [model, tables[model].length])), requiredKeys: [] };
    const proof = plaintext.manifest.proof;
    if (proof.kind !== "PLAINTEXT") throw new Error("The historical fixture must be plaintext");
    const logical = Object.fromEntries(models.map((model) => [model, tables[model].map(({ encryptedPayload: _payload, encryptionRevision: _revision, ...row }) => { void _payload; void _revision; return row; })]));
    const manifest = { ...base, proof: { kind: "PLAINTEXT", payload: { ...proof.payload, baseDigest: hash(base), contentDigest: hash(logical) } } };
    const digest = hash(manifest), checked = await checkpoint();
    const { billReconciliationApplication: _newReceipt, ...oldDeleted } = (checked as Extract<RecoveryCheckpoint, { v: 3 }>).confirmedDeletedIds;
    void _newReceipt;
    const oldCheckpoint: RecoveryCheckpoint = { ...checked, v: 2, confirmedDeletedIds: oldDeleted };
    expect(await restoreFinancialSnapshot(target, { snapshot, manifest, manifestDigest: digest }, { expectedManifestDigest: digest, checkpoint: oldCheckpoint })).toMatchObject({ verified: true });
    expect(await target.billReconciliationApplication.count()).toBe(0);
    expect(await target.billAnalysisReport.count()).toBe(1);
  });

  it("restores v3 rejection receipts and honors their latest confirmed deletion", async () => {
    await chooseUnencryptedTarget(false);
    expect(await restore(plaintext)).toMatchObject({ verified: true, counts: { billReconciliationApplication: 1 } });
    expect(await target.billReconciliationApplication.findUniqueOrThrow({ where: { id: ids.application } })).toMatchObject({ status: "REJECTED", clientRequestId: ids.applicationUuid, definition: { inputHash: "e".repeat(64), outcome: { status: "error", error: "CONFLICT" } } });
    await target.billReconciliationApplication.deleteMany();
    await target.billAnalysisRequest.deleteMany();
    await target.billAnalysisReport.deleteMany();
    for (const model of ["appEvent", "voiceProcessingAdmission", "naturalLanguageRequest", "importCategoryMapping", "importMemberMapping", "importDraftRow", "importDraft", "transaction", "ledger"] as ProtectedModel[]) await delegate(target, model).deleteMany();
    const checked = await checkpoint();
    (checked as Extract<RecoveryCheckpoint, { v: 3 }>).confirmedDeletedIds.billReconciliationApplication.push(ids.application);
    await expect(restore(plaintext, { checkpoint: checked })).rejects.toMatchObject({ code: "RECOVERY_DELETED" });
    await expectEmpty();
  });

  it.each(["legacy", "manual", "retention"] as const)("restores %s applications into an empty isolated target and only returns original terminal results", async (mode) => {
    const manual = mode !== "legacy", retention = mode === "retention";
    const isolatedName = `bb_recovery_source_${randomUUID().replaceAll("-", "")}_test`;
    const sourceUrl = new URL(process.env.DATABASE_URL!); sourceUrl.pathname = `/${isolatedName}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE ${databaseName(isolatedName, false)} TEMPLATE template0`);
    ownedDatabases.add(isolatedName);
    let applicationSource: PrismaClient | undefined;
    try {
      await migrate(sourceUrl.toString());
      applicationSource = new PrismaClient({ datasourceUrl: sourceUrl.toString() });
      const [{ sourceName }] = await applicationSource.$queryRaw<Array<{ sourceName: string }>>`SELECT current_database() AS "sourceName"`;
      if (sourceName !== isolatedName || !ownedDatabases.has(sourceName)) throw new Error("Successful recovery fixture requires its owned isolated source");
      expect(await applicationSource.transaction.count()).toBe(0);
      await applicationSource.household.create({ data: { id: ids.household, name: "Successful application source" } });
      await applicationSource.user.create({ data: { id: ids.currentUser, email: "source-current-owner@example.com", displayName: "Current owner", passwordHash: "SYNTHETIC_SOURCE_HASH" } });
      await applicationSource.householdMember.create({ data: { id: ids.currentMember, householdId: ids.household, userId: ids.currentUser, memberName: "Current owner", role: "OWNER" } });
      const sourceSessionId = randomUUID(), expenseId = randomUUID(), incomeId = randomUUID(), duplicateId = randomUUID(), applicationUuid = randomUUID();
      await applicationSource.appSession.create({ data: { id: sourceSessionId, userId: ids.currentUser, memberId: ids.currentMember, sessionKey: "SOURCE_SUCCESS_SESSION_NEVER_RESTORED", expiresAt: new Date(Date.now() + 600_000) } });
      await createCategories(applicationSource);
      await applicationSource.ledger.create({ data: { id: ids.ledger, householdId: ids.household, name: "Synthetic successful ledger", isDefault: true } });
      await applicationSource.transaction.createMany({ data: [
        { id: expenseId, householdId: ids.household, ledgerId: ids.ledger, actorMemberId: ids.currentMember, createdByMemberId: ids.currentMember, clientRequestId: randomUUID(), categoryId: ids.expense, type: "EXPENSE", amountFen: 10000, occurredAt: new Date("2026-01-01T04:00:00.000Z"), note: "Order SYNTHETIC-RECOVERY-1" },
        { id: incomeId, householdId: ids.household, ledgerId: ids.ledger, actorMemberId: ids.currentMember, createdByMemberId: ids.currentMember, clientRequestId: randomUUID(), categoryId: manual ? ids.expense : ids.income, type: manual ? "EXPENSE" : "INCOME", amountFen: manual ? 10000 : 3000, occurredAt: new Date("2026-02-02T04:00:00.000Z"), note: "Order SYNTHETIC-RECOVERY-1 refund" },
        ...(retention ? [{ id: duplicateId, householdId: ids.household, ledgerId: ids.ledger, actorMemberId: ids.currentMember, createdByMemberId: ids.currentMember, clientRequestId: randomUUID(), categoryId: ids.expense, type: "EXPENSE" as const, amountFen: 10000, occurredAt: new Date("2026-03-03T04:00:00.000Z"), note: "Third synthetic recovery record" }] : []),
      ] });
      const originalTransactions = await applicationSource.transaction.findMany({ orderBy: { id: "asc" } });
      const applied = await applicationWorker<{ input: ReconciliationApplyInput; outcome: ReconciliationApplyOutcome; rejectedInput?: ReconciliationApplyInput; rejected?: ReconciliationApplyOutcome; closedInput?: ReconciliationApplyInput; closed?: ReconciliationApplyOutcome; receiptStatus: string; auditCount: number }>(sourceUrl.toString(), {
        operation: retention ? "apply-retention" : manual ? "apply-manual" : "apply", database: isolatedName, session: { id: ids.currentUser, householdId: ids.household, memberId: ids.currentMember, appSessionId: sourceSessionId }, ledgerId: ids.ledger, expenseId, incomeId, ...(retention ? { duplicateId } : {}), requestId: applicationUuid,
      });
      expect(applied).toMatchObject({ outcome: { status: "success", preview: { delta: manual ? { incomeFen: 0, expenseFen: -10000, netFen: 10000, transactionCount: -1 } : { incomeFen: -3000, expenseFen: -3000, netFen: 0, transactionCount: -1 } } }, receiptStatus: "SUCCEEDED", auditCount: manual ? 1 : 2 });
      let successfulRows = await applicationSource.transaction.findMany({ orderBy: { id: "asc" } });
      expect(successfulRows.find((row) => row.id === (manual ? incomeId : expenseId))).toMatchObject({ amountFen: manual ? 10000 : 7000, deletedAt: null });
      expect(successfulRows.find((row) => row.id === (retention ? duplicateId : manual ? expenseId : incomeId))?.deletedAt).not.toBeNull();
      if (retention) {
        expect(successfulRows.find((row) => row.id === expenseId)).toMatchObject({ amountFen: 10000, deletedAt: null });
        expect(applied.closed).toMatchObject({ status: "error", error: "NOT_ACCEPTED" });
      }
      expect(successfulRows.map((row) => row.id)).toEqual(originalTransactions.map((row) => row.id));
      if (manual) {
        expect(applied.rejected).toMatchObject({ status: "error", error: "CONFLICT" });
        await applicationSource.ledger.create({ data: { id: ids.archive, householdId: ids.household, name: "Later archive" } });
        await applicationSource.transaction.update({ where: { id: incomeId }, data: { amountFen: 8750, note: "Keeper edited after application", ledgerId: ids.archive } });
        await applicationSource.ledger.update({ where: { id: ids.archive }, data: { archivedAt: new Date() } });
        await applicationSource.billAnalysisReport.update({ where: { id: applied.input.reportId }, data: { generation: 2 } });
        successfulRows = await applicationSource.transaction.findMany({ orderBy: { id: "asc" } });
      }

      const plainSuccess = await captureFinancialSnapshot(applicationSource, ids.household);
      if (retention) {
        await applicationSource.transaction.update({ where: { id: duplicateId }, data: { deletedAt: null } });
        try {
          const invalid = await captureFinancialSnapshot(applicationSource, ids.household);
          await expect(restore(invalid)).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
        } finally {
          await applicationSource.transaction.update({ where: { id: duplicateId }, data: { deletedAt: successfulRows.find((row) => row.id === duplicateId)!.deletedAt } });
        }
        await expectEmpty();
      }
      let recoveryMaterial = material, recoverySealed = currentSealed;
      const code = parseHouseholdCode(material.code), ring = await openRecoveryPackage(code, material.recoveryPackage);
      try {
        for (const model of protectedModels) for (const serialized of plainSuccess.snapshot.tables[model]) {
          const row = rowFromJson(model, serialized), encoded = await encryptRow(model, row, ring, ids.household, ids.expense);
          const data = Object.fromEntries([...protectedFields[model], "encryptedPayload", "encryptionRevision", "updatedAt"].filter((field) => encoded[field] !== undefined).map((field) => [field, encoded[field]]));
          for (const field of modelInfo.get(model)!.fields) if (field.type === "Json" && data[field.name] === null) data[field.name] = Prisma.DbNull;
          await delegate(applicationSource, model).update({ where: { id: row.id }, data });
        }
        if (retention) {
          const nextCode = createHouseholdCode(ids.household, code.generation, code.keyVersion + 1), nextRing = createKeyRing(nextCode, ring);
          try {
            recoveryMaterial = { code: encodeHouseholdCode(nextCode), recoveryPackage: await exportRecoveryPackage(nextCode, nextRing) };
            recoverySealed = await sealKeyRing(nextCode, nextRing);
            await target.householdEncryption.update({ where: { householdId: ids.household }, data: { revision: 11, keyVersion: nextCode.keyVersion, sealedKeyRing: recoverySealed, recoveryDigest: createHash("sha256").update(recoveryMaterial.recoveryPackage).digest("hex") } });
          } finally { nextCode.secret = ""; for (const key of nextRing.keys) key.secret = ""; }
        }
        const latestCode = parseHouseholdCode(recoveryMaterial.code);
        try {
          await applicationSource.householdEncryption.create({ data: { householdId: ids.household, mode: "ENCRYPTED", revision: retention ? 11 : 10, generation: latestCode.generation, keyVersion: latestCode.keyVersion, sealedKeyRing: recoverySealed, recoveryDigest: createHash("sha256").update(recoveryMaterial.recoveryPackage).digest("hex") } });
        } finally { latestCode.secret = ""; }
      } finally { code.secret = ""; for (const key of ring.keys) key.secret = ""; }
      const successfulBundle = await captureFinancialSnapshot(applicationSource, ids.household, recoveryMaterial);
      expect(successfulBundle.snapshot.v).toBe(3);
      expect(successfulBundle.manifest.counts.billReconciliationApplication).toBe(retention ? 3 : manual ? 2 : 1);
      if (retention) expect(successfulBundle.manifest.requiredKeys).toContainEqual({ generation: code.generation, keyVersion: code.keyVersion });
      expect(JSON.stringify(successfulBundle)).not.toContain("SOURCE_SUCCESS_SESSION_NEVER_RESTORED");
      const sourceReceipt = successfulBundle.snapshot.tables.billReconciliationApplication.find((row) => row.clientRequestId === applicationUuid)!;
      expect(sourceReceipt.status).toBe("SUCCEEDED");

      await expectEmpty();
      const sessionsBefore = await target.appSession.findMany({ orderBy: { id: "asc" } });
      const checked = await checkpoint();
      checked.transactionTombstones.push(...successfulRows.filter((row) => row.deletedAt !== null).map((row) => ({ id: row.id, deletedAt: row.deletedAt!.toISOString() })));
      expect(await restoreFinancialSnapshot(target, successfulBundle, { material: recoveryMaterial, expectedManifestDigest: successfulBundle.manifestDigest, checkpoint: checked })).toMatchObject({ verified: true, counts: { transaction: retention ? 3 : 2, billReconciliationApplication: retention ? 3 : manual ? 2 : 1 } });
      expect(await target.appSession.findMany({ orderBy: { id: "asc" } })).toEqual(sessionsBefore);
      expect(await target.appSession.findUnique({ where: { id: sourceSessionId } })).toBeNull();
      expect(await target.ledgerAuditLog.count()).toBe(0);
      const restoredReceipt = await target.billReconciliationApplication.findUniqueOrThrow({ where: { id: String(sourceReceipt.id) } });
      expect(restoredReceipt).toMatchObject({ status: "SUCCEEDED", clientRequestId: applicationUuid, definition: null });
      const openedCode = parseHouseholdCode(recoveryMaterial.code), openedRing = await openRecoveryPackage(openedCode, recoveryMaterial.recoveryPackage);
      try {
        const restoredRows = await target.transaction.findMany({ orderBy: { id: "asc" } });
        for (const row of restoredRows) {
          const decoded = await decryptRow("transaction", row, openedRing, ids.household);
          const original = successfulRows.find((value) => value.id === row.id)!;
          const expected = rowToJson("transaction", original), actual = rowToJson("transaction", decoded);
          delete expected.encryptedPayload; delete expected.encryptionRevision;
          delete actual.encryptedPayload; delete actual.encryptionRevision;
          expect(actual).toEqual(expected);
        }
        const decodedReceipt = await decryptRow("billReconciliationApplication", restoredReceipt, openedRing, ids.household);
        expect(decodedReceipt.definition).toMatchObject({ outcome: applied.outcome, transactionIds: expect.arrayContaining([expenseId, incomeId, ...(retention ? [duplicateId] : [])]), consumedIncomeIds: manual ? [] : [incomeId],
          ...(retention ? { version: 3, manualGroups: [{ keepTransactionIds: expect.arrayContaining([expenseId, incomeId]), deletedTransactionIds: [duplicateId] }] }
            : manual ? { version: 2, manualGroups: [{ keepTransactionId: incomeId, deletedTransactionIds: [expenseId] }] } : {}) });
      } finally { openedCode.secret = ""; for (const key of openedRing.keys) key.secret = ""; }
      const targetUrl = new URL(process.env.DATABASE_URL!); targetUrl.pathname = `/${targetDatabase}`;
      const queried = await applicationWorker<{ queried: ReconciliationApplyOutcome; replayed: ReconciliationApplyOutcome; rejectedQueried?: ReconciliationApplyOutcome; rejectedReplayed?: ReconciliationApplyOutcome; closedQueried?: ReconciliationApplyOutcome; closedReplayed?: ReconciliationApplyOutcome; newAttempt: ReconciliationApplyOutcome; auditBefore: number; auditAfter: number; activeRequests: number; leases: number }>(targetUrl.toString(), {
        operation: "query", database: targetDatabase, session: { id: ids.currentUser, householdId: ids.household, memberId: ids.currentMember, appSessionId: ids.currentSession }, code: recoveryMaterial.code, input: applied.input, ...(applied.rejectedInput ? { rejectedInput: applied.rejectedInput } : {}), ...(applied.closedInput ? { closedInput: applied.closedInput } : {}),
      });
      expect(queried.queried).toEqual(applied.outcome);
      expect(queried.replayed).toEqual(applied.outcome);
      if (manual) {
        expect(queried.rejectedQueried).toEqual(applied.rejected);
        expect(queried.rejectedReplayed).toEqual(applied.rejected);
      }
      if (retention) {
        expect(queried.closedQueried).toEqual(applied.closed);
        expect(queried.closedReplayed).toEqual(applied.closed);
      }
      expect(queried.newAttempt).toMatchObject({ status: "error", error: "CONFLICT" });
      expect(queried).toMatchObject({ auditBefore: 0, auditAfter: 0, activeRequests: 0, leases: 0 });
      expect(await target.appSession.findMany({ orderBy: { id: "asc" } })).toEqual(sessionsBefore);
      expect(await applicationSource.ledgerAuditLog.count()).toBe(manual ? 1 : 2);
    } finally {
      await applicationSource?.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE ${databaseName(isolatedName)}`);
      ownedDatabases.delete(isolatedName);
    }
  }, 120_000);

  it("refuses executable or malformed reconciliation receipt definitions", async () => {
    const bundle = editedPlaintext((tables) => { (tables.billReconciliationApplication[0].definition as DataRow).executionInput = "FORBIDDEN_EXECUTION_INPUT"; });
    await expect(restore(bundle)).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
    await expectEmpty();
  });

  it.each([false, true])("restores terminal analysis definitions with optional progress present=%s", async (withProgress) => {
    await chooseUnencryptedTarget(false);
    const progress = { phase: "saving", completedBatches: 2, totalBatches: 2 };
    const bundle = editedPlaintext((tables) => {
      if (withProgress) (tables.billAnalysisRequest[0].definition as DataRow).progress = progress;
    });
    const sessions = await target.appSession.findMany({ orderBy: { id: "asc" } });
    expect(await restore(bundle)).toMatchObject({ verified: true });
    const request = await target.billAnalysisRequest.findUniqueOrThrow({ where: { id: ids.billRequest } });
    expect(request).toMatchObject({ status: "SUCCEEDED", clientRequestId: ids.billUuid });
    if (withProgress) expect(request.definition).toMatchObject({ progress });
    else expect(request.definition).not.toHaveProperty("progress");
    expect(await target.appSession.findMany({ orderBy: { id: "asc" } })).toEqual(sessions);
  });

  it.each(["PREPARING", "RUNNING", "STOPPING", "active-pointer"])("refuses executable analysis recovery state %s", async (state) => {
    const bundle = editedPlaintext((tables) => {
      (tables.billAnalysisRequest[0].definition as DataRow).progress = { phase: "analyzing", completedBatches: 1, totalBatches: 2 };
      if (state === "active-pointer") tables.billAnalysisReport[0].activeRequestId = ids.billRequest;
      else tables.billAnalysisRequest[0].status = state;
    });
    await expect(restore(bundle)).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
    await expectEmpty();
  });

  it.each([
    { phase: "invented", completedBatches: 0, totalBatches: 1 },
    { phase: "analyzing", completedBatches: -1, totalBatches: 1 },
    { phase: "analyzing", completedBatches: 2, totalBatches: 1 },
    { phase: "analyzing", completedBatches: 1, totalBatches: 25 },
    { phase: "analyzing", completedBatches: 1, totalBatches: 2, input: "FORBIDDEN_EXECUTION_INPUT" },
  ])("rejects malformed or executable protected progress %#", async (progress) => {
    const bundle = editedPlaintext((tables) => { (tables.billAnalysisRequest[0].definition as DataRow).progress = progress; });
    await expect(restore(bundle)).rejects.toMatchObject({ name: "RecoveryError" });
    await expectEmpty();
  });

  it("restores every financial field and original UUID while preserving the latest revoked identities and sessions", async () => {
    const beforeUsers = await target.user.findMany({ orderBy: { id: "asc" } }), beforeMembers = await target.householdMember.findMany({ orderBy: { id: "asc" } }), beforeSessions = await target.appSession.findMany({ orderBy: { id: "asc" } });
    const result = await restore();
    expect(result).toMatchObject({ verified: true, groupCount: 3 });
    expect(result.comparedFields).toBeGreaterThan(200);
    expect(await target.user.findMany({ orderBy: { id: "asc" } })).toEqual(beforeUsers);
    expect(await target.householdMember.findMany({ orderBy: { id: "asc" } })).toEqual(beforeMembers);
    expect(await target.appSession.findMany({ orderBy: { id: "asc" } })).toEqual(beforeSessions);
    const recaptured = await captureFinancialSnapshot(target, ids.household, material);
    expect(await verifyFinancialSnapshot(recaptured, { material, expectedManifestDigest: recaptured.manifestDigest })).toMatchObject({ verified: true, counts: encrypted.manifest.counts, groupCount: 3 });
    expect(await target.naturalLanguageRequest.findUnique({ where: { householdId_createdByMemberId_clientRequestId: { householdId: ids.household, createdByMemberId: ids.ownerMember, clientRequestId: ids.requestUuid } } })).toMatchObject({ id: ids.request, inputHash: null, result: null });
  });

  it("re-encrypts an old plaintext snapshot under the target's current mode without a silent downgrade", async () => {
    expect(await restore(plaintext)).toMatchObject({ verified: true, groupCount: 3 });
    expect(await target.householdEncryption.findUnique({ where: { householdId: ids.household } })).toMatchObject({ mode: "ENCRYPTED", revision: 10 });
    expect(await target.transaction.findUnique({ where: { id: ids.transaction } })).toMatchObject({ amountFen: 0, note: null, source: "encrypted" });
    for (const model of protectedModels) for (const row of await delegate(target, model).findMany()) {
      expect(row.encryptedPayload).toBeTypeOf("string");
      expect(JSON.stringify(row)).not.toContain("PRIVATE_RECOVERY");
      expect(JSON.stringify(row)).not.toContain("ORIGINAL_INPUT_HASH");
    }
  });

  it("decrypts an old encrypted snapshot into an explicitly unencrypted target without an online ring", async () => {
    await chooseUnencryptedTarget();
    const config = await target.householdEncryption.findUniqueOrThrow({ where: { householdId: ids.household } });
    const users = await target.user.findMany({ orderBy: { id: "asc" } }), members = await target.householdMember.findMany({ orderBy: { id: "asc" } }), sessions = await target.appSession.findMany({ orderBy: { id: "asc" } });
    expect(await restore()).toMatchObject({ verified: true, groupCount: 3, comparedFields: expect.any(Number) });
    expect(await target.householdEncryption.findUniqueOrThrow({ where: { householdId: ids.household } })).toEqual(config);
    expect(await target.user.findMany({ orderBy: { id: "asc" } })).toEqual(users);
    expect(await target.householdMember.findMany({ orderBy: { id: "asc" } })).toEqual(members);
    expect(await target.appSession.findMany({ orderBy: { id: "asc" } })).toEqual(sessions);
    await expectPlaintextTarget(encrypted);
  });

  it("restores a plaintext snapshot into an explicitly unencrypted target without inventing key material", async () => {
    await chooseUnencryptedTarget(false);
    const config = await target.householdEncryption.findUniqueOrThrow({ where: { householdId: ids.household } });
    expect(await restoreFinancialSnapshot(target, plaintext, { expectedManifestDigest: plaintext.manifestDigest, checkpoint: await checkpoint() })).toMatchObject({ verified: true, groupCount: 3 });
    expect(await target.householdEncryption.findUniqueOrThrow({ where: { householdId: ids.household } })).toEqual(config);
    await expectPlaintextTarget(plaintext);
  });

  it("still requires authenticated independent materials before writing encrypted sources to an unencrypted target", async () => {
    await chooseUnencryptedTarget();
    const approved = await checkpoint(), wrong = createHouseholdCode("another-household");
    for (const candidate of [undefined, { code: encodeHouseholdCode(wrong), recoveryPackage: material.recoveryPackage }, { code: material.code, recoveryPackage: currentSealed }]) {
      await expect(restoreFinancialSnapshot(target, encrypted, { material: candidate, expectedManifestDigest: encrypted.manifestDigest, checkpoint: approved })).rejects.toMatchObject({ code: "RECOVERY_MATERIALS" });
      await expectEmpty();
    }
    wrong.secret = "";
  });

  it("rejects authenticated older-version materials that do not match the unencrypted target's most recent package", async () => {
    await chooseUnencryptedTarget();
    const code = parseHouseholdCode(material.code), ring = await openRecoveryPackage(code, material.recoveryPackage);
    const olderCode = createHouseholdCode(ids.household, encrypted.snapshot.source.generation!, encrypted.snapshot.source.keyVersion);
    try {
      const older = { code: encodeHouseholdCode(olderCode), recoveryPackage: await exportRecoveryPackage(olderCode, { ...ring, generation: olderCode.generation, currentKeyVersion: olderCode.keyVersion }) };
      expect(await verifyFinancialSnapshot(encrypted, { material: older, expectedManifestDigest: encrypted.manifestDigest })).toMatchObject({ verified: true });
      await expect(restore(encrypted, { material: older })).rejects.toMatchObject({ code: "RECOVERY_MATERIALS" });
      await expectEmpty();
    } finally { for (const key of ring.keys) key.secret = ""; code.secret = ""; olderCode.secret = ""; }
  });

  it.each(["deleted", "authorization"] as const)("preserves the latest %s checkpoint when the explicit target is unencrypted", async (kind) => {
    await chooseUnencryptedTarget();
    const approved = await checkpoint();
    if (kind === "deleted") approved.confirmedDeletedIds.transaction.push(ids.transaction);
    else await target.appSession.update({ where: { id: ids.currentSession }, data: { revokedAt: latestLeftAt } });
    await expect(restore(encrypted, { checkpoint: approved })).rejects.toMatchObject({ code: kind === "deleted" ? "RECOVERY_DELETED" : "RECOVERY_FOUNDATION" });
    await expectEmpty();
  });

  it("rejects missing, wrong-purpose, wrong-family and incomplete historical recovery material without partial writes", async () => {
    const wrong = createHouseholdCode("another-household"), current = parseHouseholdCode(material.code), incomplete = createKeyRing(current);
    const insufficient = { code: material.code, recoveryPackage: await exportRecoveryPackage(current, incomplete) };
    for (const candidate of [undefined, { code: encodeHouseholdCode(wrong), recoveryPackage: material.recoveryPackage }, { code: material.code, recoveryPackage: currentSealed }, insufficient]) {
      await expect(verifyFinancialSnapshot(encrypted, { material: candidate, expectedManifestDigest: encrypted.manifestDigest })).rejects.toMatchObject({ code: "RECOVERY_MATERIALS" });
    }
    await expect(restore(encrypted, { material: insufficient })).rejects.toMatchObject({ code: "RECOVERY_MATERIALS" });
    await expectEmpty();
    for (const key of incomplete.keys) key.secret = "";
    current.secret = ""; wrong.secret = "";
  });

  it("requires a trusted manifest digest and rejects snapshot tampering before target writes", async () => {
    await expect(restore(encrypted, { expectedManifestDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "RECOVERY_MISMATCH" });
    const tampered = structuredClone(encrypted);
    tampered.snapshot.tables.transaction[0].actorMemberId = ids.currentMember;
    await expect(restore(tampered)).rejects.toMatchObject({ code: "RECOVERY_MISMATCH" });
    await expectEmpty();
  });

  it("rejects a stale authorization checkpoint and never overwrites a nonempty target", async () => {
    const stale = await checkpoint();
    await target.user.update({ where: { id: ids.currentUser }, data: { status: "LOCKED" } });
    await expect(restore(encrypted, { checkpoint: stale })).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
    await expectEmpty();
    await target.user.update({ where: { id: ids.currentUser }, data: { status: "ACTIVE" } });
    await target.ledger.create({ data: { householdId: ids.household, name: "CURRENT_TARGET_MUST_SURVIVE", isDefault: true } });
    await expect(restore()).rejects.toMatchObject({ code: "RECOVERY_NOT_EMPTY" });
    expect(await target.ledger.findMany()).toMatchObject([{ name: "CURRENT_TARGET_MUST_SURVIVE" }]);
  });

  it("refuses backups that would resurrect a confirmed deletion or undo a later soft deletion", async () => {
    const confirmed = await checkpoint();
    confirmed.confirmedDeletedIds.transaction.push(ids.transaction);
    await expect(restore(encrypted, { checkpoint: confirmed })).rejects.toMatchObject({ code: "RECOVERY_DELETED" });
    const laterSoftDelete = await checkpoint();
    laterSoftDelete.transactionTombstones.push({ id: ids.transaction, deletedAt: latestLeftAt.toISOString() });
    await expect(restore(encrypted, { checkpoint: laterSoftDelete })).rejects.toMatchObject({ code: "RECOVERY_DELETED" });
    await expectEmpty();
  });

  it("requires the target's explicit stable configuration and complete historical reference foundation", async () => {
    await target.householdMember.delete({ where: { id: ids.formerMember } });
    await expect(restore()).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
    await expectEmpty();
    const approved = await checkpoint();
    await target.householdEncryption.update({ where: { householdId: ids.household }, data: { mode: "ENABLING" } });
    await expect(restoreFinancialSnapshot(target, plaintext, { material, expectedManifestDigest: plaintext.manifestDigest, checkpoint: approved })).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
    await expect(inspectRecoveryFoundation(target, ids.household)).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
    await target.householdEncryption.delete({ where: { householdId: ids.household } });
    await expect(inspectRecoveryFoundation(target, ids.household)).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
  });

  it("does not reopen a closed household or restore authority to an unavailable owner", async () => {
    const approved = await checkpoint();
    await target.household.update({ where: { id: ids.household }, data: { closedAt: latestLeftAt } });
    await expect(restoreFinancialSnapshot(target, encrypted, { material, expectedManifestDigest: encrypted.manifestDigest, checkpoint: approved })).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
    await target.household.update({ where: { id: ids.household }, data: { closedAt: null } });
    await target.user.update({ where: { id: ids.currentUser }, data: { status: "DEACTIVATED" } });
    await expect(restoreFinancialSnapshot(target, encrypted, { material, expectedManifestDigest: encrypted.manifestDigest, checkpoint: approved })).rejects.toMatchObject({ code: "RECOVERY_FOUNDATION" });
    await expectEmpty();
  });

  it("rejects an online target ring that disagrees with the independently authenticated package", async () => {
    const code = parseHouseholdCode(material.code), wrongRing = createKeyRing(code);
    await target.householdEncryption.update({ where: { householdId: ids.household }, data: { sealedKeyRing: await sealKeyRing(code, wrongRing) } });
    await expect(restore(plaintext)).rejects.toMatchObject({ code: "RECOVERY_MATERIALS" });
    await expectEmpty();
    for (const key of wrongRing.keys) key.secret = "";
    code.secret = "";
  });

  it("verifies the original hash and result content from only the independent package", async () => {
    const code = parseHouseholdCode(material.code), ring = await openRecoveryPackage(code, material.recoveryPackage);
    try {
      const { decryptRow } = await import("@/lib/encryption/protected-models");
      const request = await decryptRow("naturalLanguageRequest", rowFromJson("naturalLanguageRequest", encrypted.snapshot.tables.naturalLanguageRequest[0]), ring, ids.household);
      expect(request).toMatchObject({ clientRequestId: ids.requestUuid, inputHash: "ORIGINAL_INPUT_HASH", result: { requestId: ids.requestUuid, resultVersion: 7, rows: [{ id: ids.transaction, amountFen: 12345, note: "PRIVATE_OLD_AI_RESULT" }] } });
    } finally { for (const key of ring.keys) key.secret = ""; code.secret = ""; }
  });

  it("checks the encrypted backup through the default CLI using ephemeral stdin and no database connection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "billboard-recovery-check-"));
    const filename = path.join(directory, "snapshot.json"), packageFile = path.join(directory, "recovery.bbp");
    try {
      await writeFile(filename, JSON.stringify(encrypted), { mode: 0o600 });
      await writeFile(packageFile, material.recoveryPackage, { mode: 0o600 });
      const result = await new Promise<{ code: number; output: string; errors: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "ops/encryption/verify-recovery.mts", "--snapshot", filename, "--manifest-digest", encrypted.manifestDigest, "--recovery-package", packageFile], {
          cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
          env: { DATABASE_URL: "postgresql://unreachable.invalid/never_connect", NODE_ENV: "test", PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
        });
        let output = "", errors = "";
        child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16384); });
        child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-16384); });
        child.once("error", () => reject(new Error("Recovery check CLI could not start")));
        child.once("close", (code) => resolve({ code: code ?? 1, output, errors }));
        child.stdin.end(`${material.code}\n`);
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ mode: "check-only", verified: true, targetWritten: false, groupCount: 3, counts: encrypted.manifest.counts });
      expect(result.output + result.errors).not.toContain(material.code);
      expect(result.output + result.errors).not.toContain("PRIVATE_RECOVERY_NOTE");
      await expectEmpty();
    } finally {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("billboard-recovery-check-")) throw new Error("Unexpected recovery check directory");
      await rm(resolved, { recursive: true, force: true });
    }
  });
});
