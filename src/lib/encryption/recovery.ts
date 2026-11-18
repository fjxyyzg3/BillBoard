import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalJson, record, unframe } from "./codec";
import { openEntity, openKeyRing, openRecoveryPackage, parseHouseholdCode, sealEntity, type KeyRing } from "./crypto";
import { decryptRow, encryptRow, modelInfo, protectedModels, rowFromJson, rowToJson, type DataRow, type ProtectedModel } from "./protected-models";
import { parseReconciliationApplicationDefinition } from "@/lib/reports/bill-reconciliation-application-protocol";

type Client = PrismaClient | Prisma.TransactionClient;
type Tables = Record<ProtectedModel, DataRow[]>;
type Counts = Record<ProtectedModel, number>;
const legacyModels = ["transaction", "ledger", "importDraft", "importDraftRow", "importCategoryMapping", "importMemberMapping", "naturalLanguageRequest", "voiceProcessingAdmission", "appEvent"] as const;
const versionTwoModels = [...legacyModels, "billAnalysisReport", "billAnalysisRequest"] as const;
const versionThreeModels = [...versionTwoModels, "billReconciliationApplication"] as const;
type LegacyModel = typeof legacyModels[number];
const snapshotModels = (version: 1 | 2 | 3): readonly ProtectedModel[] => version === 1 ? legacyModels : version === 2 ? versionTwoModels : versionThreeModels;
type KeyReference = { generation: string; keyVersion: number };
type Source = { mode: "UNENCRYPTED" | "ENCRYPTED"; revision: number; generation: string | null; keyVersion: number };
type Proof = { v: 1; baseDigest: string; contentDigest: string; groupsDigest: string; groupCount: number };
export type RecoveryMaterial = { code: string; recoveryPackage: string };
export type FinancialSnapshot = { v: 1 | 2 | 3; id: string; householdId: string; capturedAt: string; source: Source; tables: Tables };
export type RecoveryManifest = {
  v: 1 | 2 | 3; snapshotId: string; householdId: string; source: Source; snapshotDigest: string;
  counts: Counts; requiredKeys: KeyReference[];
  proof: { kind: "ENCRYPTED"; payload: string } | { kind: "PLAINTEXT"; payload: Proof };
};
export type FinancialRecoveryBundle = { snapshot: FinancialSnapshot; manifest: RecoveryManifest; manifestDigest?: string };
export type RecoveryCheckpoint = {
  householdId: string; checkedAt: string; authorizationDigest: string;
  transactionTombstones: Array<{ id: string; deletedAt: string }>;
} & ({ v: 1; confirmedDeletedIds: Record<LegacyModel, string[]> } | { v: 2; confirmedDeletedIds: Record<typeof versionTwoModels[number], string[]> } | { v: 3; confirmedDeletedIds: Record<ProtectedModel, string[]> });
export type RecoveryVerification = { verified: true; counts: Counts; groupCount: number; comparedFields: number };
type VerifyOptions = { expectedManifestDigest: string; material?: RecoveryMaterial };
type Delegate = { findMany(args: DataRow): Promise<DataRow[]>; count(args?: DataRow): Promise<number>; createMany(args: DataRow): Promise<unknown> };

export const MAX_RECOVERY_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const MAX_ROW_BYTES = 80 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RECOVERY_ROWS = 500_000;
const options = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 };
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const shaPattern = /^[0-9a-f]{64}$/;

export class RecoveryError extends Error {
  constructor(readonly code: "RECOVERY_INVALID" | "RECOVERY_MATERIALS" | "RECOVERY_FOUNDATION" | "RECOVERY_NOT_EMPTY" | "RECOVERY_DELETED" | "RECOVERY_MISMATCH" | "RECOVERY_BUDGET") {
    super(code); this.name = "RecoveryError";
  }
}
function fail(code: ConstructorParameters<typeof RecoveryError>[0] = "RECOVERY_INVALID"): never { throw new RecoveryError(code); }
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { if (error instanceof RecoveryError) throw error; return fail(); }
}
const delegate = (client: Client, model: ProtectedModel) => (client as unknown as Record<string, Delegate>)[model];
const identifier = (value: unknown): string => typeof value === "string" && idPattern.test(value) ? value : fail();
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail();
  return value;
}
function digest(value: unknown, maxBytes = MAX_RECOVERY_SNAPSHOT_BYTES): string {
  return createHash("sha256").update(canonicalJson(value, maxBytes), "utf8").digest("hex");
}
export function recoveryManifestDigest(manifest: RecoveryManifest): string { return digest(manifest, MAX_MANIFEST_BYTES); }
function emptyTables(models: readonly ProtectedModel[] = versionThreeModels): Tables {
  return Object.fromEntries<DataRow[]>(models.map((model) => [model, []])) as Tables;
}
function clear(ring: KeyRing | null | undefined) { if (ring) for (const key of ring.keys) key.secret = ""; }
function sourceMetadata(value: unknown): Source {
  const input = record(value, ["mode", "revision", "generation", "keyVersion"]);
  if (input.mode !== "ENCRYPTED" && input.mode !== "UNENCRYPTED") fail();
  const source: Source = { mode: input.mode, revision: integer(input.revision), generation: input.generation === null ? null : identifier(input.generation), keyVersion: integer(input.keyVersion) };
  if (source.mode === "ENCRYPTED" && (!source.generation || source.keyVersion < 1)) fail();
  return source;
}
function snapshotInput(value: unknown): FinancialSnapshot {
  const input = record(value, ["v", "id", "householdId", "capturedAt", "source", "tables"]);
  if ((input.v !== 1 && input.v !== 2 && input.v !== 3) || typeof input.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.id)) fail();
  const models = snapshotModels(input.v), householdId = identifier(input.householdId), tables = emptyTables(models);
  const source = sourceMetadata(input.source), supplied = record(input.tables, models);
  let rowCount = 0, bytes = 0;
  for (const model of models) {
    const entries = supplied[model];
    if (!Array.isArray(entries)) fail();
    rowCount += entries.length;
    if (rowCount > MAX_RECOVERY_ROWS) fail("RECOVERY_BUDGET");
    const fields = modelInfo.get(model)!.fields.filter((field) => field.kind !== "object").map((field) => field.name);
    const seen = new Set<string>();
    for (const entry of entries) {
      const row = record(entry, fields);
      if (Object.keys(row).length !== fields.length || fields.some((field) => !Object.hasOwn(row, field))) fail();
      const id = identifier(row.id);
      if (seen.has(id) || (model !== "importDraftRow" && row.householdId !== householdId)) fail();
      seen.add(id);
      const encoded = canonicalJson(row, MAX_ROW_BYTES);
      bytes += Buffer.byteLength(encoded);
      if (bytes > MAX_RECOVERY_SNAPSHOT_BYTES) fail("RECOVERY_BUDGET");
      tables[model].push(JSON.parse(encoded) as DataRow);
    }
    tables[model].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  const draftIds = new Set(tables.importDraft.map((row) => row.id));
  if (tables.importDraftRow.some((row) => !draftIds.has(row.draftId))) fail();
  return { v: input.v, id: input.id, householdId, capturedAt: timestamp(input.capturedAt), source, tables };
}
function requiredKeys(snapshot: FinancialSnapshot): KeyReference[] {
  const keys = new Map<string, KeyReference>();
  if (snapshot.source.mode === "ENCRYPTED") {
    keys.set(`${snapshot.source.generation}:${snapshot.source.keyVersion}`, { generation: snapshot.source.generation!, keyVersion: snapshot.source.keyVersion });
  }
  for (const model of snapshotModels(snapshot.v)) for (const row of snapshot.tables[model]) {
    if (!row.encryptedPayload) continue;
    const envelope = record(unframe("BBE1", row.encryptedPayload, 48 * 1024 * 1024), ["v", "purpose", "householdId", "generation", "keyVersion", "revision", "salt", "nonce", "keyNonce", "wrappedKey", "ciphertext"]);
    if (envelope.v !== 1 || envelope.purpose !== "entity" || envelope.householdId !== snapshot.householdId) fail();
    const reference = { generation: identifier(envelope.generation), keyVersion: integer(envelope.keyVersion, 1) };
    keys.set(`${reference.generation}:${reference.keyVersion}`, reference);
  }
  return [...keys.values()].sort((a, b) => a.generation.localeCompare(b.generation) || a.keyVersion - b.keyVersion);
}
async function materialRing(material: RecoveryMaterial | undefined, householdId: string): Promise<KeyRing> {
  try {
    const input = record(material, ["code", "recoveryPackage"]);
    if (typeof input.code !== "string" || typeof input.recoveryPackage !== "string") fail("RECOVERY_MATERIALS");
    const code = parseHouseholdCode(input.code);
    try {
      if (code.householdId !== householdId) fail("RECOVERY_MATERIALS");
      return await openRecoveryPackage(code, input.recoveryPackage);
    } finally { code.secret = ""; }
  } catch { return fail("RECOVERY_MATERIALS"); }
}
function logicalRow(model: ProtectedModel, row: DataRow) {
  const { encryptedPayload: _payload, encryptionRevision: _revision, ...logical } = rowToJson(model, row);
  void _payload; void _revision;
  return logical;
}
async function plainTables(snapshot: FinancialSnapshot, ring: KeyRing | null): Promise<Tables> {
  const models = snapshotModels(snapshot.v), result = emptyTables(models), drafts = new Map(snapshot.tables.importDraft.map((row) => [row.id, String(row.ledgerId)]));
  for (const model of models) for (const row of snapshot.tables[model]) {
    let plain = rowFromJson(model, row);
    if (snapshot.source.mode === "UNENCRYPTED") {
      if (row.encryptedPayload || row.encryptionRevision) fail();
    } else if (model === "appEvent" && !row.encryptedPayload && row.summary === null && row.metadata === null) {
      if (row.encryptionRevision) fail();
    } else {
      if (!ring) fail("RECOVERY_MATERIALS");
      try { plain = await decryptRow(model, plain, ring, snapshot.householdId, drafts.get(row.draftId)); }
      catch { return fail("RECOVERY_MATERIALS"); }
    }
    result[model].push(logicalRow(model, plain));
  }
  for (const model of models) result[model].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return result;
}
function groupSummary(tables: Tables) {
  const groups = new Map<string, { key: unknown[]; count: number; amountFen: string }>();
  for (const row of tables.transaction) {
    if (!Number.isSafeInteger(row.amountFen) || Number(row.amountFen) <= 0 || !["INCOME", "EXPENSE"].includes(String(row.type))) fail();
    const month = new Date(new Date(timestamp(row.occurredAt)).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
    const key = [row.householdId, row.ledgerId, row.actorMemberId, row.createdByMemberId, month, row.type, row.deletedAt !== null];
    const encoded = canonicalJson(key, 4096), group = groups.get(encoded) ?? { key, count: 0, amountFen: "0" };
    group.count++; group.amountFen = (BigInt(group.amountFen) + BigInt(Number(row.amountFen))).toString(); groups.set(encoded, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
function manifestBase(snapshot: FinancialSnapshot) {
  return { v: snapshot.v, snapshotId: snapshot.id, householdId: snapshot.householdId, source: snapshot.source,
    snapshotDigest: digest(snapshot), counts: Object.fromEntries(snapshotModels(snapshot.v).map((model) => [model, snapshot.tables[model].length])) as Counts,
    requiredKeys: requiredKeys(snapshot) };
}
function proofFor(base: ReturnType<typeof manifestBase>, tables: Tables): Proof {
  const groups = groupSummary(tables);
  return { v: 1, baseDigest: digest(base, MAX_MANIFEST_BYTES), contentDigest: digest(tables), groupsDigest: digest(groups), groupCount: groups.length };
}
function proofContext(snapshot: FinancialSnapshot) { return { householdId: snapshot.householdId, model: "recovery-manifest", id: snapshot.id, revision: snapshot.id }; }
function verification(base: ReturnType<typeof manifestBase>, tables: Tables, proof: Proof): RecoveryVerification {
  return { verified: true, counts: base.counts, groupCount: proof.groupCount,
    comparedFields: snapshotModels(base.v).reduce((sum, model) => sum + tables[model].reduce((total, row) => total + Object.keys(row).length, 0), 0) };
}

export async function captureFinancialSnapshot(client: PrismaClient, householdId: string, material?: RecoveryMaterial): Promise<Required<FinancialRecoveryBundle>> {
  return guarded(async () => {
    identifier(householdId);
    let ring: KeyRing | null = null;
    try {
      return await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Household" WHERE id=${householdId} FOR UPDATE`;
        const config = await tx.householdEncryption.findUnique({ where: { householdId } });
        if (!await tx.household.findUnique({ where: { id: householdId }, select: { id: true } }) || config?.activeOperationId || (config && !["UNENCRYPTED", "ENCRYPTED"].includes(config.mode))) fail("RECOVERY_FOUNDATION");
        if (await tx.resourceLease.count({ where: { householdId } })) fail("RECOVERY_FOUNDATION");
        if (await tx.billAnalysisRequest.count({ where: { householdId, status: { in: ["PREPARING", "RUNNING", "STOPPING"] } } }) || await tx.billAnalysisReport.count({ where: { householdId, activeRequestId: { not: null } } })) fail("RECOVERY_FOUNDATION");
        const source = sourceMetadata({ mode: config?.mode ?? "UNENCRYPTED", revision: config?.revision ?? 0, generation: config?.generation ?? null, keyVersion: config?.keyVersion ?? 0 });
        if (source.mode === "ENCRYPTED") {
          ring = await materialRing(material, householdId);
          if (ring.generation !== source.generation || ring.currentKeyVersion !== source.keyVersion) fail("RECOVERY_MATERIALS");
        }
        const tables = emptyTables();
        let total = 0, bytes = 0;
        for (const model of protectedModels) {
          let afterId: string | undefined;
          while (true) {
            const chunk = await delegate(tx, model).findMany({ where: { ...(model === "importDraftRow" ? { draft: { householdId } } : { householdId }), ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take: 500 });
            for (const row of chunk) {
              const serialized = rowToJson(model, row);
              bytes += Buffer.byteLength(canonicalJson(serialized, MAX_ROW_BYTES));
              if (++total > MAX_RECOVERY_ROWS || bytes > MAX_RECOVERY_SNAPSHOT_BYTES) fail("RECOVERY_BUDGET");
              tables[model].push(serialized);
            }
            if (chunk.length < 500) break;
            afterId = String(chunk.at(-1)!.id);
          }
        }
        const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        const snapshot = snapshotInput({ v: 3, id: randomUUID(), householdId, capturedAt: now.toISOString(), source, tables });
        const base = manifestBase(snapshot), plain = await plainTables(snapshot, ring), proof = proofFor(base, plain);
        const manifest: RecoveryManifest = { ...base, proof: ring ? { kind: "ENCRYPTED", payload: await sealEntity(ring, proofContext(snapshot), proof) } : { kind: "PLAINTEXT", payload: proof } };
        return { snapshot, manifest, manifestDigest: recoveryManifestDigest(manifest) };
      }, options);
    } finally { clear(ring); }
  });
}

async function unpack(bundle: unknown, verify: VerifyOptions) {
  const input = record(bundle, ["snapshot", "manifest", "manifestDigest"]), snapshot = snapshotInput(input.snapshot);
  const manifest = record(input.manifest, ["v", "snapshotId", "householdId", "source", "snapshotDigest", "counts", "requiredKeys", "proof"]);
  if (typeof verify.expectedManifestDigest !== "string" || !shaPattern.test(verify.expectedManifestDigest) || digest(manifest, MAX_MANIFEST_BYTES) !== verify.expectedManifestDigest
    || (input.manifestDigest !== undefined && input.manifestDigest !== verify.expectedManifestDigest)) fail("RECOVERY_MISMATCH");
  const { proof: rawProof, ...suppliedBase } = manifest;
  const base = manifestBase(snapshot);
  if (canonicalJson(suppliedBase, MAX_MANIFEST_BYTES) !== canonicalJson(base, MAX_MANIFEST_BYTES)) fail("RECOVERY_MISMATCH");
  let ring: KeyRing | null = null;
  try {
    if (snapshot.source.mode === "ENCRYPTED" || verify.material) ring = await materialRing(verify.material, snapshot.householdId);
    if (base.requiredKeys.some((required) => !ring?.keys.some((key) => key.generation === required.generation && key.keyVersion === required.keyVersion))) fail("RECOVERY_MATERIALS");
    const tables = await plainTables(snapshot, ring), expected = proofFor(base, tables);
    const proof = record(rawProof, ["kind", "payload"]);
    let actual: unknown;
    if (snapshot.source.mode === "ENCRYPTED") {
      if (proof.kind !== "ENCRYPTED" || typeof proof.payload !== "string" || !ring) fail("RECOVERY_MATERIALS");
      try { actual = await openEntity(ring, proofContext(snapshot), proof.payload); } catch { return fail("RECOVERY_MATERIALS"); }
    } else {
      if (proof.kind !== "PLAINTEXT") fail();
      actual = proof.payload;
    }
    if (canonicalJson(actual, MAX_MANIFEST_BYTES) !== canonicalJson(expected, MAX_MANIFEST_BYTES)) fail("RECOVERY_MISMATCH");
    // Only normalize missing new entities after authenticating the exact original representation.
    return { snapshot, base, tables: { ...emptyTables(), ...tables }, ring, summary: verification(base, tables, expected) };
  } catch (error) { clear(ring); throw error; }
}

export async function verifyFinancialSnapshot(bundle: unknown, verify: VerifyOptions): Promise<RecoveryVerification> {
  return guarded(async () => {
    const opened = await unpack(bundle, verify);
    try { return opened.summary; } finally { clear(opened.ring); }
  });
}

async function foundation(client: Client, householdId: string) {
  const household = await client.household.findUnique({ where: { id: householdId } });
  const config = await client.householdEncryption.findUnique({ where: { householdId } });
  if (!household || household.closedAt || household.timezone !== "Asia/Shanghai" || !config || (config.mode !== "ENCRYPTED" && config.mode !== "UNENCRYPTED") || config.activeOperationId) fail("RECOVERY_FOUNDATION");
  const mode: Source["mode"] = config.mode;
  if (mode === "ENCRYPTED" && (!config.generation || config.keyVersion < 1 || !config.sealedKeyRing || !config.recoveryDigest)) fail("RECOVERY_FOUNDATION");
  const members = await client.householdMember.findMany({ where: { householdId }, orderBy: { id: "asc" } });
  const userIds = [...new Set(members.map((member) => member.userId))];
  const users = await client.user.findMany({ where: { id: { in: userIds } }, orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true } });
  if (!members.some((member) => member.role === "OWNER" && !member.leftAt && users.some((user) => user.id === member.userId && user.status === "ACTIVE"))) fail("RECOVERY_FOUNDATION");
  const sessions = await client.appSession.findMany({ where: { userId: { in: userIds } }, orderBy: { id: "asc" }, select: { id: true, userId: true, memberId: true, expiresAt: true, revokedAt: true, updatedAt: true } });
  const categories = await client.category.findMany({ orderBy: { id: "asc" } });
  // Read only authorization metadata. Password hashes, session keys and tokens never enter the snapshot.
  const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  return { config, mode, members, categories, authorizationDigest: digest(normalize({ household, config, members, users, sessions, categories })) };
}

export async function inspectRecoveryFoundation(client: PrismaClient, householdId: string) {
  return guarded(async () => {
    const checked = await foundation(client, identifier(householdId));
    return { householdId, mode: checked.mode, revision: checked.config.revision, generation: checked.config.generation, keyVersion: checked.config.keyVersion, authorizationDigest: checked.authorizationDigest };
  });
}
function checkCheckpoint(value: RecoveryCheckpoint, snapshot: FinancialSnapshot, tables: Tables, actualDigest: string) {
  const input = record(value, ["v", "householdId", "checkedAt", "authorizationDigest", "confirmedDeletedIds", "transactionTombstones"]);
  if ((input.v !== 1 && input.v !== 2 && input.v !== 3) || input.householdId !== snapshot.householdId || input.v < snapshot.v) fail("RECOVERY_FOUNDATION");
  if (input.authorizationDigest !== actualDigest) fail("RECOVERY_FOUNDATION");
  if (Date.parse(timestamp(input.checkedAt)) < Date.parse(snapshot.capturedAt)) fail("RECOVERY_FOUNDATION");
  const models = snapshotModels(input.v), deleted = record(input.confirmedDeletedIds, models);
  for (const model of models) {
    if (!Array.isArray(deleted[model])) fail("RECOVERY_FOUNDATION");
    const ids = new Set((deleted[model] as unknown[]).map(identifier));
    if (tables[model].some((row) => ids.has(String(row.id)))) fail("RECOVERY_DELETED");
  }
  if (!Array.isArray(input.transactionTombstones)) fail("RECOVERY_FOUNDATION");
  const transactions = new Map(tables.transaction.map((row) => [row.id, row]));
  for (const value of input.transactionTombstones) {
    const tombstone = record(value, ["id", "deletedAt"]), id = identifier(tombstone.id), deletedAt = timestamp(tombstone.deletedAt);
    if (transactions.has(id) && transactions.get(id)!.deletedAt !== deletedAt) fail("RECOVERY_DELETED");
  }
}
function checkReferences(tables: Tables, members: Awaited<ReturnType<typeof foundation>>["members"], categories: Awaited<ReturnType<typeof foundation>>["categories"]) {
  const memberIds = new Set(members.map((member) => member.id)), categoryIds = new Set(categories.map((category) => category.id)), ledgers = new Set(tables.ledger.map((row) => row.id));
  if (tables.ledger.filter((row) => row.isDefault === true && row.archivedAt === null).length !== 1) fail("RECOVERY_FOUNDATION");
  for (const model of protectedModels) for (const row of tables[model]) {
    for (const field of ["actorMemberId", "createdByMemberId", "memberId"]) if (row[field] != null && !memberIds.has(String(row[field]))) fail("RECOVERY_FOUNDATION");
    if (row.categoryId != null && !categoryIds.has(String(row.categoryId))) fail("RECOVERY_FOUNDATION");
    if (row.ledgerId != null && !ledgers.has(row.ledgerId)) fail("RECOVERY_FOUNDATION");
    if (model === "voiceProcessingAdmission" && !members.some((member) => member.id === row.memberId && member.userId === row.userId)) fail("RECOVERY_FOUNDATION");
    if (model === "billAnalysisRequest" && !["SUCCEEDED", "FAILED"].includes(String(row.status))) fail("RECOVERY_FOUNDATION");
    if (model === "billAnalysisRequest" && row.reportId != null && !tables.billAnalysisReport.some((report) => report.id === row.reportId && report.householdId === row.householdId)) fail("RECOVERY_FOUNDATION");
    if (model === "billAnalysisReport" && row.activeRequestId !== null) fail("RECOVERY_FOUNDATION");
    if ((model === "billAnalysisRequest" || model === "billAnalysisReport") && row.definition != null) {
      const definition = record(row.definition, ["scope", "locale", "range", "snapshotAt", "inputHash", "purpose", "version", ...(model === "billAnalysisRequest" ? ["progress"] : [])]);
      if ((definition.purpose !== undefined && !["analysis", "reconciliation"].includes(String(definition.purpose)))
        || (definition.version !== undefined && definition.version !== 1) || (definition.purpose === "reconciliation" && definition.version !== 1)) fail("RECOVERY_FOUNDATION");
      if (definition.progress !== undefined) {
        const progress = record(definition.progress, ["phase", "completedBatches", "totalBatches"]);
        if (!["preparing", "analyzing", "waiting", "summarizing", "saving"].includes(String(progress.phase)) || integer(progress.completedBatches) > integer(progress.totalBatches) || integer(progress.totalBatches) > 24) fail("RECOVERY_FOUNDATION");
      }
      const selected = record(definition.scope, ["mode", "period", "ledgerId", "actorMemberId"]);
      if (selected.ledgerId != null && !ledgers.has(selected.ledgerId)) fail("RECOVERY_FOUNDATION");
      if (selected.actorMemberId != null && !memberIds.has(String(selected.actorMemberId))) fail("RECOVERY_FOUNDATION");
    }
    if (model === "billAnalysisReport" && row.content && typeof row.content === "object" && !Array.isArray(row.content)) {
      const refs = (row.content as DataRow).transactionRefs;
      if (refs !== undefined) {
        if (!refs || typeof refs !== "object" || Array.isArray(refs) || Object.values(refs).some((id) => typeof id !== "string" || !tables.transaction.some((transaction) => transaction.id === id && transaction.householdId === row.householdId))) fail("RECOVERY_FOUNDATION");
      }
      const content = row.content as DataRow;
      if (content.purpose === "reconciliation") {
        if (content.version !== 1 || !content.assertions || typeof content.assertions !== "object" || Array.isArray(content.assertions)) fail("RECOVERY_FOUNDATION");
        for (const value of Object.values(content.assertions)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) fail("RECOVERY_FOUNDATION");
          const assertion = value as DataRow;
          if (!tables.transaction.some((transaction) => transaction.id === assertion.id && transaction.householdId === row.householdId)
            || !ledgers.has(assertion.ledgerId) || !memberIds.has(String(assertion.actorMemberId)) || !memberIds.has(String(assertion.createdByMemberId)) || !categoryIds.has(String(assertion.categoryId))) fail("RECOVERY_FOUNDATION");
        }
      }
    }
    if (model === "billReconciliationApplication") {
      if (!["SUCCEEDED", "REJECTED", "NOT_ACCEPTED"].includes(String(row.status))) fail("RECOVERY_FOUNDATION");
      if (row.reportId != null && !tables.billAnalysisReport.some((report) => report.id === row.reportId && report.householdId === row.householdId)) fail("RECOVERY_FOUNDATION");
      let definition;
      try { definition = parseReconciliationApplicationDefinition(row.definition); } catch { return fail("RECOVERY_FOUNDATION"); }
      if (definition.outcome.requestId !== row.clientRequestId || (row.status === "SUCCEEDED") !== (definition.outcome.status === "success")
        || (row.status === "NOT_ACCEPTED" && (definition.inputHash !== null || definition.outcome.error !== "NOT_ACCEPTED"))
        || (row.status !== "NOT_ACCEPTED" && definition.inputHash === null)) fail("RECOVERY_FOUNDATION");
      for (const id of definition.transactionIds ?? []) if (!tables.transaction.some((transaction) => transaction.id === id && transaction.householdId === row.householdId)) fail("RECOVERY_FOUNDATION");
      for (const id of definition.consumedIncomeIds ?? []) if (!definition.transactionIds?.includes(id) || !tables.transaction.some((transaction) => transaction.id === id && transaction.type === "INCOME" && transaction.deletedAt !== null)) fail("RECOVERY_FOUNDATION");
      if (definition.version === 2 || definition.version === 3) for (const group of definition.manualGroups) {
        for (const transaction of group.transactions) if (!definition.transactionIds?.includes(transaction.transactionId) || !tables.transaction.some((value) => value.id === transaction.transactionId && value.householdId === row.householdId)) fail("RECOVERY_FOUNDATION");
        for (const id of group.deletedTransactionIds) if (!tables.transaction.some((transaction) => transaction.id === id && transaction.householdId === row.householdId && transaction.deletedAt !== null)) fail("RECOVERY_FOUNDATION");
      }
    }
  }
}
function createData(model: ProtectedModel, row: DataRow): DataRow {
  const result = rowFromJson(model, row);
  for (const field of modelInfo.get(model)!.fields) if (field.type === "Json" && result[field.name] === null) result[field.name] = Prisma.DbNull;
  return result;
}

export async function restoreFinancialSnapshot(client: PrismaClient, bundle: unknown, verify: VerifyOptions & { checkpoint: RecoveryCheckpoint }): Promise<RecoveryVerification> {
  return guarded(async () => {
    const opened = await unpack(bundle, verify);
    let trustedRing: KeyRing | null = null;
    try {
      return await client.$transaction(async (tx) => {
        const householdId = opened.snapshot.householdId;
        await tx.$queryRaw`SELECT id FROM "Household" WHERE id=${householdId} FOR UPDATE`;
        await tx.$queryRaw`SELECT m.id FROM "HouseholdMember" m JOIN "User" u ON u.id=m.user_id WHERE m.household_id=${householdId} ORDER BY m.id FOR UPDATE OF m,u`;
        await tx.$queryRaw`SELECT s.id FROM "AppSession" s JOIN "HouseholdMember" m ON m.user_id=s.user_id WHERE m.household_id=${householdId} ORDER BY s.id FOR SHARE OF s`;
        const current = await foundation(tx, householdId);
        checkCheckpoint(verify.checkpoint, opened.snapshot, opened.tables, current.authorizationDigest);
        if (await tx.resourceLease.count({ where: { householdId } })) fail("RECOVERY_FOUNDATION");
        for (const model of protectedModels) if (await delegate(tx, model).count()) fail("RECOVERY_NOT_EMPTY");
        if (current.mode === "ENCRYPTED" || opened.snapshot.source.mode === "ENCRYPTED") {
          if (!opened.ring || !verify.material || current.config.generation !== opened.ring.generation || current.config.keyVersion !== opened.ring.currentKeyVersion || createHash("sha256").update(verify.material.recoveryPackage).digest("hex") !== current.config.recoveryDigest) fail("RECOVERY_MATERIALS");
        }
        if (current.mode === "ENCRYPTED") {
          const code = parseHouseholdCode(verify.material!.code);
          try { trustedRing = await openKeyRing(code, current.config.sealedKeyRing!); } catch { return fail("RECOVERY_MATERIALS"); } finally { code.secret = ""; }
          if (digest(trustedRing, MAX_MANIFEST_BYTES) !== digest(opened.ring, MAX_MANIFEST_BYTES)) fail("RECOVERY_MATERIALS");
        }
        checkReferences(opened.tables, current.members, current.categories);
        const placeholder = current.categories[0]?.id;
        if (!placeholder && opened.tables.transaction.length) fail("RECOVERY_FOUNDATION");
        const drafts = new Map(opened.tables.importDraft.map((row) => [row.id, String(row.ledgerId)]));
        for (const model of ["ledger" as const, ...protectedModels.filter((model) => model !== "ledger")]) {
          for (let offset = 0; offset < opened.tables[model].length; offset += 250) {
            const batch: DataRow[] = [];
            for (const row of opened.tables[model].slice(offset, offset + 250)) {
              const plain = rowFromJson(model, row);
              const restored = current.mode === "ENCRYPTED" ? await encryptRow(model, plain, opened.ring!, householdId, placeholder ?? "", drafts.get(row.draftId)) : { ...plain, encryptedPayload: null, encryptionRevision: null };
              batch.push(createData(model, restored));
            }
            await delegate(tx, model).createMany({ data: batch });
          }
        }
        const restored = emptyTables();
        for (const model of protectedModels) restored[model] = (await delegate(tx, model).findMany({ where: model === "importDraftRow" ? { draft: { householdId } } : { householdId }, orderBy: { id: "asc" } })).map((row) => rowToJson(model, row));
        const actual = await plainTables({ ...opened.snapshot, v: 3, source: { mode: current.mode, revision: current.config.revision, generation: current.config.generation, keyVersion: current.config.keyVersion }, tables: restored }, opened.ring);
        for (const model of protectedModels) if (canonicalJson(actual[model], MAX_RECOVERY_SNAPSHOT_BYTES) !== canonicalJson(opened.tables[model], MAX_RECOVERY_SNAPSHOT_BYTES)) fail("RECOVERY_MISMATCH");
        if (digest(groupSummary(actual)) !== digest(groupSummary(opened.tables)) || (await foundation(tx, householdId)).authorizationDigest !== current.authorizationDigest) fail("RECOVERY_MISMATCH");
        return opened.summary;
      }, options);
    } finally { clear(opened.ring); clear(trustedRing); }
  });
}
