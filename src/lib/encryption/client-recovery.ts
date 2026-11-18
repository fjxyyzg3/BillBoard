import { createHouseholdCode, createKeyRing, encodeHouseholdCode, exportRecoveryPackage, openEntity, openRecoveryPackage, parseHouseholdCode, sealEntity, sealKeyRing, type KeyRing } from "./crypto";
import type { EncryptionIdentity } from "./client-store";

export type EncryptionCandidate = {
  v: 1; identity: EncryptionIdentity; id: string; kind: "ENABLE" | "DISABLE" | "ROTATE";
  code: string; previousCode: string | null; expectedRevision: number; revision: number;
  candidateKeyRing: string; candidateRecoveryPackage: string; recoveryDigest: string;
  recoveryFile: string; operationFile: string; prepared: boolean;
};

export type EncryptionOperationReceipt = {
  id: string; kind: string; status: string; expiresAt: string;
  candidateGeneration: string | null; candidateKeyVersion: number | null;
  recoveryDigest: string | null; sourceRevision: number; barrierRevision: number;
};

export function matchesEncryptionReceipt(candidate: EncryptionCandidate, operation: EncryptionOperationReceipt) {
  if (operation.id !== candidate.id) return false;
  if (operation.kind === "CANCELLED" && operation.status === "ABORTED") {
    return operation.candidateGeneration === null && operation.candidateKeyVersion === null && operation.recoveryDigest === null;
  }
  if (operation.kind !== candidate.kind || operation.sourceRevision !== candidate.expectedRevision
    || operation.barrierRevision !== candidate.expectedRevision + 1 || operation.recoveryDigest !== candidate.recoveryDigest) return false;
  if (operation.status !== "COMMITTED" && operation.candidateGeneration === null && operation.candidateKeyVersion === null) return true;
  const parsed = parseHouseholdCode(candidate.code);
  return operation.candidateGeneration === parsed.generation && operation.candidateKeyVersion === parsed.keyVersion;
}

export async function recoveryDigest(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createEncryptionCandidate(identity: EncryptionIdentity, kind: EncryptionCandidate["kind"], revision: number, previousCode: string | null, previousRing?: KeyRing): Promise<EncryptionCandidate> {
  const current = previousCode ? parseHouseholdCode(previousCode) : undefined;
  if (kind !== "ENABLE" && (!current || !previousRing)) throw new Error("ENCRYPTION_REQUIRED");
  const candidateCode = kind === "DISABLE" ? current! : kind === "ROTATE"
    ? createHouseholdCode(identity.householdId, current!.generation, current!.keyVersion + 1) : createHouseholdCode(identity.householdId);
  const ring = kind === "DISABLE" ? previousRing! : createKeyRing(candidateCode, previousRing);
  const code = encodeHouseholdCode(candidateCode);
  const id = crypto.randomUUID();
  const candidateKeyRing = await sealKeyRing(candidateCode, ring);
  const candidateRecoveryPackage = await exportRecoveryPackage(candidateCode, ring);
  const digest = await recoveryDigest(candidateRecoveryPackage);
  const recoveryFile = JSON.stringify({ v: 1, householdId: identity.householdId, candidateRecoveryPackage, recoveryDigest: digest }, null, 2);
  const state = { v: 1 as const, identity, id, kind, code, previousCode, expectedRevision: revision, revision, candidateKeyRing, candidateRecoveryPackage, recoveryDigest: digest, recoveryFile, prepared: false };
  const encryptedState = await sealEntity(ring, { householdId: identity.householdId, model: "ClientEncryptionOperation", id }, state);
  const operationFile = JSON.stringify({ v: 1, householdId: identity.householdId, id, candidateRecoveryPackage, encryptedState }, null, 2);
  return { ...state, operationFile };
}

export async function restoreEncryptionCandidate(identity: EncryptionIdentity, code: string, operationFile: string): Promise<EncryptionCandidate> {
  const packet = JSON.parse(operationFile);
  if (packet.v !== 1 || packet.householdId !== identity.householdId || typeof packet.id !== "string" || typeof packet.candidateRecoveryPackage !== "string" || typeof packet.encryptedState !== "string") throw new Error("ENCRYPTION_INVALID");
  const ring = await openRecoveryPackage(parseHouseholdCode(code.trim()), packet.candidateRecoveryPackage);
  const value = await openEntity(ring, { householdId: identity.householdId, model: "ClientEncryptionOperation", id: packet.id }, packet.encryptedState) as EncryptionCandidate;
  if (value.v !== 1 || value.code !== code.trim() || value.id !== packet.id || value.identity.accountId !== identity.accountId || value.identity.householdId !== identity.householdId || value.identity.memberId !== identity.memberId || value.recoveryDigest !== await recoveryDigest(value.candidateRecoveryPackage)) throw new Error("ENCRYPTION_INVALID");
  return { ...value, operationFile };
}

export async function readRecoveryFile(code: string, text: string) {
  const packet = JSON.parse(text);
  if (packet.v !== 1 || typeof packet.candidateRecoveryPackage !== "string" || packet.recoveryDigest !== await recoveryDigest(packet.candidateRecoveryPackage)) throw new Error("ENCRYPTION_INVALID");
  const parsed = parseHouseholdCode(code.trim());
  if (packet.householdId !== parsed.householdId) throw new Error("ENCRYPTION_INVALID");
  return openRecoveryPackage(parsed, packet.candidateRecoveryPackage);
}
