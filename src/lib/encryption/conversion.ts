import { createHash } from "node:crypto";
import { Prisma, type EncryptionOperation } from "@prisma/client";
import type { KeyRing } from "./crypto";
import { bulkReplace } from "./database";
import { decryptRow, encryptRow, protectedFields, protectedModels, rowFromJson, rowToJson, type DataRow, type ProtectedModel } from "./protected-models";
import { EncryptionRequestError } from "./types";

type Tx = Prisma.TransactionClient;
type Delegate = { findMany(args: DataRow): Promise<DataRow[]>; count(args: DataRow): Promise<number> };
const delegate = (tx: Tx, model: ProtectedModel) => (tx as unknown as Record<string, Delegate>)[model];
const scope = (model: ProtectedModel, householdId: string) => model === "importDraftRow" ? { draft: { householdId } } : { householdId };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) && !(item instanceof Date) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
type Manifest = { v: 1; completed: number; total: number; counts: Record<string, number>; verified: boolean; plaintextStaging: boolean };
type Cursor = { model: number; afterId: string | null };

export function conversionProgress(op: EncryptionOperation) {
  const manifest = op.manifest as Manifest | null;
  return { completed: manifest?.completed ?? 0, total: manifest?.total ?? 0 };
}
async function counts(tx: Tx, householdId: string) {
  const result: Record<string, number> = {};
  for (const model of protectedModels) result[model] = await delegate(tx, model).count({ where: scope(model, householdId) });
  return result;
}
async function plainSource(model: ProtectedModel, row: DataRow, op: EncryptionOperation, source: KeyRing | null, ledgerId?: string): Promise<DataRow> {
  if (op.sourceMode === "UNENCRYPTED") {
    if (row.encryptedPayload) throw new EncryptionRequestError("ENCRYPTION_INVALID");
    return row;
  }
  if (!row.encryptedPayload && model === "appEvent" && row.summary === null && row.metadata === null) return row;
  if (!source) throw new EncryptionRequestError("ENCRYPTION_REQUIRED");
  return decryptRow(model, row, source, op.householdId, ledgerId);
}
function protectedSnapshot(model: ProtectedModel, row: DataRow) {
  const json = rowToJson(model, row);
  return Object.fromEntries(protectedFields[model].map((field) => [field, json[field] ?? null]));
}

export async function convertBatch(tx: Tx, operation: EncryptionOperation, source: KeyRing | null, candidate: KeyRing) {
  let cursor = (operation.cursor as Cursor | null) ?? { model: 0, afterId: null };
  let manifest = operation.manifest as Manifest | null;
  if (!manifest) {
    const current = await counts(tx, operation.householdId);
    manifest = { v: 1, completed: 0, total: Object.values(current).reduce((sum, count) => sum + count, 0), counts: current, verified: false, plaintextStaging: operation.kind === "DISABLE" };
  }
  const category = await tx.category.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  let consumed = 0;
  while (cursor.model < protectedModels.length && consumed < 250) {
    const model = protectedModels[cursor.model];
    const chunk = await delegate(tx, model).findMany({ where: { AND: [scope(model, operation.householdId), ...(cursor.afterId ? [{ id: { gt: cursor.afterId } }] : [])] }, orderBy: { id: "asc" }, take: 250 - consumed });
    if (!chunk.length) { cursor = { model: cursor.model + 1, afterId: null }; continue; }
    const drafts = model === "importDraftRow" ? new Map((await tx.importDraft.findMany({ where: { id: { in: [...new Set(chunk.map((row) => String(row.draftId)))] }, householdId: operation.householdId }, select: { id: true, ledgerId: true } })).map((draft) => [draft.id, draft.ledgerId])) : new Map<string, string>();
    const previous = new Map((await tx.encryptionStaging.findMany({ where: { operationId: operation.id, model, entityId: { in: chunk.map((row) => String(row.id)) } } })).map((stage) => [stage.entityId, stage]));
    const creates: Prisma.EncryptionStagingCreateManyInput[] = [];
    const originals = new Map<string, { plain: DataRow; ledgerId?: string }>();
    for (const row of chunk) {
      const id = String(row.id), sourceHash = hash(rowToJson(model, row)), old = previous.get(id);
      if (old) {
        if (old.sourceDigest.split(":")[0] !== sourceHash) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
        continue;
      }
      const ledgerId = drafts.get(String(row.draftId));
      if (model === "importDraftRow" && !ledgerId) throw new EncryptionRequestError("ENCRYPTION_INVALID");
      const plain = await plainSource(model, row, operation, source, ledgerId);
      const target = operation.kind === "DISABLE" ? { ...plain, encryptedPayload: null, encryptionRevision: null } : await encryptRow(model, plain, candidate, operation.householdId, category?.id ?? "", ledgerId);
      const json = rowToJson(model, target);
      creates.push({ operationId: operation.id, model, entityId: id, sourceDigest: `${sourceHash}:${hash(json)}`, target: json as Prisma.InputJsonObject });
      originals.set(id, { plain, ledgerId });
    }
    if (creates.length) {
      await tx.encryptionStaging.createMany({ data: creates });
      // Verify the actual stored target, including JSON/date representation, before advancing.
      const saved = await tx.encryptionStaging.findMany({ where: { operationId: operation.id, model, entityId: { in: creates.map((row) => row.entityId) } } });
      for (const stage of saved) {
        const original = originals.get(stage.entityId)!;
        const target = rowFromJson(model, stage.target as DataRow);
        const restored = operation.kind === "DISABLE" ? target : await decryptRow(model, target, candidate, operation.householdId, original.ledgerId);
        if (hash(protectedSnapshot(model, restored)) !== hash(protectedSnapshot(model, original.plain)) || stage.sourceDigest.split(":")[1] !== hash(stage.target)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
      }
    }
    consumed += chunk.length;
    cursor.afterId = String(chunk.at(-1)!.id);
  }
  manifest.completed = await tx.encryptionStaging.count({ where: { operationId: operation.id } });
  if (cursor.model >= protectedModels.length) {
    const current = await counts(tx, operation.householdId);
    const targetCounts = await tx.encryptionStaging.groupBy({ by: ["model"], where: { operationId: operation.id }, _count: true });
    const targets = new Map(targetCounts.map((item) => [item.model, item._count]));
    const complete = protectedModels.every((model) => current[model] === (targets.get(model) ?? 0));
    manifest.counts = current; manifest.total = Object.values(current).reduce((sum, count) => sum + count, 0);
    manifest.verified = complete;
    // Minimal late events can arrive between batches; rescan IDs without replacing verified rows.
    if (!complete) cursor = { model: 0, afterId: null };
  }
  const op = await tx.encryptionOperation.update({ where: { id: operation.id }, data: { status: manifest.verified ? "VERIFIED" : "RUNNING", cursor: cursor as unknown as Prisma.InputJsonObject, manifest: manifest as unknown as Prisma.InputJsonObject } });
  return { op, done: manifest.verified };
}

export async function publishConversion(tx: Tx, op: EncryptionOperation) {
  const manifest = op.manifest as Manifest | null;
  if (op.status !== "VERIFIED" || !manifest?.verified) throw new EncryptionRequestError("ENCRYPTION_BUSY");
  const current = await counts(tx, op.householdId);
  for (const model of protectedModels) {
    if (current[model] !== manifest.counts[model] || current[model] !== await tx.encryptionStaging.count({ where: { operationId: op.id, model } })) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
    let afterId: string | undefined;
    while (true) {
      const source = await delegate(tx, model).findMany({ where: { AND: [scope(model, op.householdId), ...(afterId ? [{ id: { gt: afterId } }] : [])] }, orderBy: { id: "asc" }, take: 500 });
      if (!source.length) break;
      const target = new Map((await tx.encryptionStaging.findMany({ where: { operationId: op.id, model, entityId: { in: source.map((row) => String(row.id)) } } })).map((row) => [row.entityId, row]));
      const replacements: DataRow[] = [];
      for (const original of source) {
        const stage = target.get(String(original.id));
        if (!stage || stage.sourceDigest !== `${hash(rowToJson(model, original))}:${hash(stage.target)}`) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
        replacements.push(rowFromJson(model, stage.target as DataRow));
      }
      await bulkReplace(tx, model, replacements, [...protectedFields[model], "encryptedPayload", "encryptionRevision"]);
      afterId = String(source.at(-1)!.id);
    }
  }
  // Remove the isolated working copy in the same atomic publish; the receipt remains durable.
  await tx.encryptionStaging.deleteMany({ where: { operationId: op.id } });
}
