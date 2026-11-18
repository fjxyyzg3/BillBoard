import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { openEntity, opaqueIndex, sealEntity, type EntityContext, type KeyRing } from "./crypto";
import { EncryptionRequestError } from "./types";

export type DataRow = Record<string, unknown>;
export const protectedFields = {
  transaction: ["type", "categoryId", "amountFen", "occurredAt", "note", "source", "sourceFingerprint", "sourceImportedAt"],
  ledger: ["name"],
  importDraft: ["source", "fileName"],
  importDraftRow: ["transactionType", "occurredAt", "occurredDate", "amountFen", "actorExternalName", "creatorExternalName", "categoryId", "primaryCategory", "secondaryCategory", "mappingKey", "note", "sourceFingerprint", "refundOriginalAmountFen", "refundSourceFingerprints", "skipReason", "duplicateCandidates", "rawTransactionType", "rawDate", "rawAmount", "rawMember", "rawCreatedBy", "rawCurrency"],
  importCategoryMapping: ["source", "transactionType", "primaryCategory", "secondaryCategory", "categoryId"],
  importMemberMapping: ["source", "externalName"],
  naturalLanguageRequest: ["inputHash", "referenceAt", "result", "errorCode", "issues"],
  voiceProcessingAdmission: ["audioHash", "textHash"],
  appEvent: ["summary", "metadata"],
  billAnalysisReport: ["definition", "content", "inputHash"],
  billAnalysisRequest: ["definition", "errorCode"],
  billReconciliationApplication: ["definition"],
} as const;
export type ProtectedModel = keyof typeof protectedFields;
export const protectedModels = Object.keys(protectedFields) as ProtectedModel[];
export function isProtectedModel(value: string): value is ProtectedModel { return Object.hasOwn(protectedFields, value); }
export const modelInfo = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name[0].toLowerCase() + model.name.slice(1), model]));

export function rowToJson(model: string, row: DataRow): DataRow {
  const result: DataRow = {};
  for (const field of modelInfo.get(model)!.fields.filter((field) => field.kind !== "object")) {
    const value = row[field.name];
    if (value !== undefined) result[field.name] = value instanceof Date ? value.toISOString() : value;
  }
  return result;
}
export function rowFromJson(model: string, row: DataRow): DataRow {
  const result = { ...row };
  for (const field of modelInfo.get(model)!.fields) {
    if (field.type === "DateTime" && result[field.name] != null) {
      const value = result[field.name];
      const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
      if (!Number.isFinite(date.getTime())) throw new EncryptionRequestError("ENCRYPTION_INVALID");
      result[field.name] = date;
    }
  }
  return result;
}
export function entityContext(model: ProtectedModel, row: DataRow, householdId: string, ledgerId?: string): EntityContext {
  return {
    householdId, model, id: String(row.id),
    ledgerId: typeof row.ledgerId === "string" ? row.ledgerId : ledgerId ?? null,
    actorMemberId: typeof row.actorMemberId === "string" ? row.actorMemberId : ["appEvent", "voiceProcessingAdmission", "importMemberMapping"].includes(model) && typeof row.memberId === "string" ? row.memberId : null,
    createdByMemberId: typeof row.createdByMemberId === "string" ? row.createdByMemberId : null,
    ...(row.encryptionRevision ? { revision: String(row.encryptionRevision) } : {}),
  };
}

export async function decryptRow(model: ProtectedModel, row: DataRow, ring: KeyRing, householdId: string, ledgerId?: string): Promise<DataRow> {
  if (!row.encryptedPayload || !row.encryptionRevision) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  let payload: unknown;
  try { payload = await openEntity(ring, entityContext(model, row, householdId, ledgerId), String(row.encryptedPayload)); }
  catch { throw new EncryptionRequestError("ENCRYPTION_INVALID"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  const values = payload as DataRow;
  const fields: readonly string[] = protectedFields[model];
  if (Object.keys(values).length !== fields.length || fields.some((field) => !Object.hasOwn(values, field))) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  return rowFromJson(model, { ...row, ...values });
}

export async function encryptRow(model: ProtectedModel, original: DataRow, ring: KeyRing, householdId: string, categoryPlaceholder: string, ledgerId?: string): Promise<DataRow> {
  const row = { ...original, encryptionRevision: randomUUID() };
  const serialized = rowToJson(model, row);
  const values: DataRow = {};
  for (const field of protectedFields[model]) values[field] = serialized[field] ?? null;
  const encryptedPayload = await sealEntity(ring, entityContext(model, row, householdId, ledgerId), values);
  const empty: DataRow = {};
  for (const field of protectedFields[model]) empty[field] = null;
  if (model === "transaction") Object.assign(empty, { type: "EXPENSE", categoryId: categoryPlaceholder, amountFen: 0, occurredAt: new Date(0), source: "encrypted", sourceFingerprint: await opaqueIndex(ring, "transaction-source", JSON.stringify(original.source != null && original.sourceFingerprint != null ? [original.source, original.sourceFingerprint] : ["manual", original.id])) });
  if (model === "ledger") empty.name = "Encrypted ledger";
  if (model === "importDraft") Object.assign(empty, { source: "encrypted", fileName: "encrypted" });
  if (model === "importDraftRow") empty.refundSourceFingerprints = [];
  if (model === "importCategoryMapping") Object.assign(empty, { source: "encrypted", transactionType: "EXPENSE", primaryCategory: await opaqueIndex(ring, "category-mapping", JSON.stringify(protectedFields.importCategoryMapping.slice(0, 4).map((key) => original[key]))), secondaryCategory: "", categoryId: null });
  if (model === "importMemberMapping") Object.assign(empty, { source: "encrypted", externalName: await opaqueIndex(ring, "member-mapping", JSON.stringify([original.source, original.externalName])) });
  if (model === "voiceProcessingAdmission") empty.audioHash = "encrypted";
  return { ...row, ...empty, encryptedPayload };
}

export function publicRow(row: DataRow): DataRow {
  const result = { ...row };
  delete result.encryptedPayload;
  delete result.encryptionRevision;
  return result;
}
