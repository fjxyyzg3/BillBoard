import { createHash } from "node:crypto";
import { Prisma, type EncryptionOperation, type HouseholdEncryption } from "@prisma/client";
import type { AppSessionUser } from "@/auth";
import { resolveHouseholdContext } from "@/lib/auth/household-context";
import { physicalDb } from "@/lib/db";
import { describeKeyRing, openKeyRing, openRecoveryPackage, parseHouseholdCode, type KeyRing } from "./crypto";
import { assertEncryptionSession, encryptionMode, getHouseholdEncryptionStatus, parseEncryptionInput } from "./request";
import { EncryptionRequestError } from "./types";
import { convertBatch, publishConversion, conversionProgress } from "./conversion";

type Input = Record<string, unknown>;
type Tx = Prisma.TransactionClient;
export const operationOptions = { maxWait: 10000, timeout: 120000 };
const TERMINAL = new Set(["COMMITTED", "ABORTED", "EXPIRED"]);
const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  return value;
};
export const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function owner(tx: Tx, session: AppSessionUser, lock = true) {
  const identity = await resolveHouseholdContext(tx, session, { metadataOnly: true, lock });
  if (identity.role !== "OWNER") throw new Error("Forbidden");
  return assertEncryptionSession(tx, session);
}
async function configFor(tx: Tx, householdId: string) {
  return tx.householdEncryption.upsert({ where: { householdId }, create: { householdId }, update: {} });
}
function operationDto(op: EncryptionOperation) {
  return { id: op.id, kind: op.kind, status: op.status, expiresAt: op.expiresAt.toISOString(), candidateGeneration: op.candidateGeneration, candidateKeyVersion: op.candidateKeyVersion, recoveryDigest: op.recoveryDigest, sourceRevision: op.sourceRevision, barrierRevision: op.barrierRevision };
}
async function result<Extra extends Input = Record<never, never>>(session: AppSessionUser, op: EncryptionOperation | null, extra: Extra = {} as Extra) {
  const value = { status: await getHouseholdEncryptionStatus(session), operation: op ? operationDto(op) : null, ...extra };
  await resolveHouseholdContext(physicalDb, session, { metadataOnly: true });
  await assertEncryptionSession(physicalDb, session);
  return value;
}
function candidateMetadata(input: Input) {
  const kind = input.kind;
  if (!["ENABLE", "DISABLE", "ROTATE"].includes(String(kind)) || input.candidateBackedUp !== true || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  const candidateKeyRing = input.candidateKeyRing;
  const recovery = input.candidateRecoveryPackage;
  if (typeof candidateKeyRing !== "string" || !candidateKeyRing.startsWith("BBR1.") || candidateKeyRing.length > 3 * 1024 * 1024 || typeof recovery !== "string" || !recovery.startsWith("BBP1.") || recovery.length > 3 * 1024 * 1024 || input.recoveryDigest !== digest(recovery)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  const header = describeKeyRing(candidateKeyRing);
  return { kind: String(kind), candidateKeyRing, recoveryDigest: String(input.recoveryDigest), sourceRevision: Number(input.expectedRevision), candidateGeneration: header.generation, candidateKeyVersion: header.keyVersion };
}

export async function prepareEncryption(session: AppSessionUser, input: Input) {
  // Master material is accepted only after the client knows the preparation receipt.
  if (input.candidateCode !== undefined || input.encryption !== undefined) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  const id = uuid(input.id), metadata = candidateMetadata(input);
  if (describeKeyRing(metadata.candidateKeyRing).householdId !== session.householdId) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  const op = await physicalDb.$transaction(async (tx) => {
    const now = await owner(tx, session);
    const previous = await tx.encryptionOperation.findUnique({ where: { id } });
    if (previous) {
      if (previous.householdId !== session.householdId || previous.userId !== session.id || previous.memberId !== session.memberId || previous.kind !== metadata.kind || previous.candidateKeyRing !== metadata.candidateKeyRing || previous.recoveryDigest !== metadata.recoveryDigest || previous.sourceRevision !== metadata.sourceRevision) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
      await owner(tx, session, false);
      return previous;
    }
    const config = await configFor(tx, session.householdId);
    if (config.activeOperationId || !["UNENCRYPTED", "ENCRYPTED"].includes(config.mode)) throw new EncryptionRequestError("ENCRYPTION_BUSY");
    if (config.revision !== metadata.sourceRevision || (metadata.kind === "ENABLE" ? config.mode !== "UNENCRYPTED" : config.mode !== "ENCRYPTED")) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
    if (metadata.kind === "ENABLE" ? metadata.candidateGeneration === config.generation || metadata.candidateKeyVersion !== 1 : metadata.candidateGeneration !== config.generation || metadata.candidateKeyVersion !== config.keyVersion + (metadata.kind === "ROTATE" ? 1 : 0)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
    const operation = await tx.encryptionOperation.create({ data: {
      id, householdId: session.householdId, userId: session.id, memberId: session.memberId, appSessionId: session.appSessionId,
      ...metadata, sourceMode: config.mode, barrierRevision: config.revision + 1,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    } });
    await tx.householdEncryption.update({ where: { householdId: config.householdId }, data: { mode: metadata.kind === "ENABLE" ? "ENABLING" : metadata.kind === "DISABLE" ? "DISABLING" : "ENCRYPTED", revision: operation.barrierRevision, activeOperationId: id } });
    await owner(tx, session, false);
    return operation;
  }, operationOptions);
  return result(session, op);
}

export function containsKeys(candidate: KeyRing, previous: KeyRing) {
  return previous.householdId === candidate.householdId && previous.keys.every((old) => candidate.keys.some((key) => key.generation === old.generation && key.keyVersion === old.keyVersion && key.secret === old.secret));
}
export async function operationKeys(op: EncryptionOperation, config: HouseholdEncryption, input: Input) {
  const code = parseHouseholdCode(String(input.candidateCode ?? ""));
  if (code.householdId !== op.householdId) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  if (code.generation !== op.candidateGeneration || code.keyVersion !== op.candidateKeyVersion) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
  if ((input.candidateKeyRing !== undefined && input.candidateKeyRing !== op.candidateKeyRing) || !op.candidateKeyRing || typeof input.candidateRecoveryPackage !== "string" || digest(input.candidateRecoveryPackage) !== op.recoveryDigest) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  const candidate = await openKeyRing(code, op.candidateKeyRing);
  const recovery = await openRecoveryPackage(code, input.candidateRecoveryPackage);
  if (!containsKeys(recovery, candidate) || !containsKeys(candidate, recovery)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  for (const key of recovery.keys) key.secret = "";
  let source: KeyRing | null = null;
  if (config.sealedKeyRing) {
    const encryption = parseEncryptionInput(input.encryption);
    if (!encryption || encryption.revision !== config.revision) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
    const previous = parseHouseholdCode(encryption.code);
    if (previous.householdId !== op.householdId || previous.generation !== config.generation || previous.keyVersion !== config.keyVersion) throw new EncryptionRequestError("ENCRYPTION_INVALID");
    source = await openKeyRing(previous, config.sealedKeyRing);
    if (!containsKeys(candidate, source)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
    if (op.kind === "DISABLE") {
      if (code.secret !== previous.secret || code.generation !== previous.generation || code.keyVersion !== previous.keyVersion || !containsKeys(source, candidate)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
    } else if (code.secret === previous.secret) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  }
  if (op.kind === "ENABLE" && (code.generation === config.generation || code.keyVersion !== 1)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  if (op.kind === "ROTATE" && (code.generation !== config.generation || code.keyVersion !== config.keyVersion + 1 || !source)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  if (op.kind !== "DISABLE" && source && source.keys.some((key) => key.generation === candidate.generation && key.keyVersion === candidate.currentKeyVersion)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  return { code, source, candidate };
}

async function ongoing(tx: Tx, session: AppSessionUser, input: Input) {
  await owner(tx, session);
  const op = await tx.encryptionOperation.findFirst({ where: { id: uuid(input.id), householdId: session.householdId, userId: session.id, memberId: session.memberId } });
  if (!op) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
  if (TERMINAL.has(op.status)) return { op, config: null };
  if (op.appSessionId !== session.appSessionId || op.expiresAt.getTime() <= Date.now()) throw new EncryptionRequestError("ENCRYPTION_EXPIRED");
  const config = await configFor(tx, session.householdId);
  if (config.activeOperationId !== op.id || config.revision !== op.barrierRevision) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
  return { op, config };
}
function dispose(rings: Array<KeyRing | null>) {
  for (const ring of rings) if (ring) for (const key of ring.keys) key.secret = "";
}

async function recheckOperation(tx: Tx, session: AppSessionUser, op: EncryptionOperation) {
  const now = await owner(tx, session, false);
  if (op.expiresAt.getTime() <= now.getTime()) throw new EncryptionRequestError("ENCRYPTION_EXPIRED");
}

export async function batchEncryption(session: AppSessionUser, input: Input) {
  const outcome = await physicalDb.$transaction(async (tx) => {
    const { op, config } = await ongoing(tx, session, input);
    if (!config) return { op, done: op.status === "COMMITTED" };
    const keys = await operationKeys(op, config, input);
    try {
      await recheckOperation(tx, session, op);
      if (op.kind === "ROTATE") return { op, done: true };
      // A deadline alone does not prove a parser or provider has actually stopped.
      if (await tx.resourceLease.count({ where: { householdId: op.householdId } })) return { op, done: false, waiting: true };
      const converted = await convertBatch(tx, op, keys.source, keys.candidate);
      await recheckOperation(tx, session, op);
      return converted;
    } finally { dispose([keys.source, keys.candidate]); }
  }, operationOptions);
  return result(session, outcome.op, { done: outcome.done, waiting: "waiting" in outcome && outcome.waiting, progress: conversionProgress(outcome.op) });
}

export async function commitEncryption(session: AppSessionUser, input: Input) {
  const op = await physicalDb.$transaction(async (tx) => {
    const { op, config } = await ongoing(tx, session, input);
    if (!config) return op;
    const keys = await operationKeys(op, config, input);
    try {
      await recheckOperation(tx, session, op);
      if (await tx.resourceLease.count({ where: { householdId: op.householdId } })) throw new EncryptionRequestError("ENCRYPTION_BUSY");
      if (op.kind !== "ROTATE") await publishConversion(tx, op);
      await recheckOperation(tx, session, op);
      await tx.householdEncryption.update({ where: { householdId: op.householdId }, data: {
        mode: op.kind === "DISABLE" ? "UNENCRYPTED" : "ENCRYPTED", revision: config.revision + 1,
        generation: keys.code.generation, keyVersion: keys.code.keyVersion,
        sealedKeyRing: op.candidateKeyRing, recoveryDigest: op.recoveryDigest, activeOperationId: null,
      } });
      const committed = await tx.encryptionOperation.update({ where: { id: op.id }, data: { status: "COMMITTED", completedAt: new Date(), candidateGeneration: keys.code.generation, candidateKeyVersion: keys.code.keyVersion } });
      await recheckOperation(tx, session, op);
      return committed;
    } finally { dispose([keys.source, keys.candidate]); }
  }, operationOptions);
  return result(session, op, { done: true });
}

export async function queryEncryption(session: AppSessionUser, input: Input) {
  await resolveHouseholdContext(physicalDb, session, { metadataOnly: true });
  await assertEncryptionSession(physicalDb, session);
  const op = await physicalDb.encryptionOperation.findFirst({ where: { id: uuid(input.id), householdId: session.householdId, userId: session.id, memberId: session.memberId } });
  return result(session, op, { unknown: !op, ...(op ? { progress: conversionProgress(op) } : {}) });
}

export async function abortEncryption(session: AppSessionUser, input: Input) {
  const op = await physicalDb.$transaction(async (tx) => {
    const now = await owner(tx, session);
    const id = uuid(input.id), config = await configFor(tx, session.householdId);
    const existing = await tx.encryptionOperation.findUnique({ where: { id } });
    if (!existing) {
      // A tombstone closes the race with a preparation whose response was lost.
      const cancelled = await tx.encryptionOperation.create({ data: { id, householdId: session.householdId, userId: session.id, memberId: session.memberId, appSessionId: session.appSessionId, kind: "CANCELLED", status: "ABORTED", sourceMode: config.mode, sourceRevision: config.revision, barrierRevision: config.revision, expiresAt: now, completedAt: now } });
      await owner(tx, session, false);
      return cancelled;
    }
    if (existing.householdId !== session.householdId) throw new Error("Forbidden");
    if (TERMINAL.has(existing.status)) {
      await owner(tx, session, false);
      return existing;
    }
    if (config.activeOperationId !== existing.id) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
    await tx.encryptionStaging.deleteMany({ where: { operationId: id } });
    await tx.householdEncryption.update({ where: { householdId: config.householdId }, data: { mode: encryptionMode(existing.sourceMode), revision: config.revision + 1, activeOperationId: null } });
    const cancelled = await tx.encryptionOperation.update({ where: { id }, data: { status: existing.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : "ABORTED", completedAt: now } });
    await owner(tx, session, false);
    return cancelled;
  }, operationOptions);
  return result(session, op, { done: true });
}

export async function encryptionMaterials(session: AppSessionUser) {
  await owner(physicalDb, session, false);
  const config = await physicalDb.householdEncryption.findUnique({ where: { householdId: session.householdId } });
  const value = { status: await getHouseholdEncryptionStatus(session), sealedKeyRing: config?.sealedKeyRing ?? null, recoveryRequired: !!config?.sealedKeyRing };
  await owner(physicalDb, session, false);
  return value;
}
