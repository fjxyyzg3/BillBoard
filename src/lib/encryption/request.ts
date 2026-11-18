import type { AppSessionUser } from "@/auth";
import type { Prisma } from "@prisma/client";
import { physicalDb } from "@/lib/db";
import { openKeyRing, parseHouseholdCode } from "./crypto";
import { getEncryptionContext, runEncryptionContext } from "./request-context";
import { EncryptionRequestError, type EncryptionInput, type EncryptionMode, type EncryptionStatus } from "./types";
import { assertEncryptionTransport } from "./transport";

const MODES = new Set<EncryptionMode>(["UNENCRYPTED", "ENABLING", "ENCRYPTED", "DISABLING"]);
export async function assertEncryptionSession(client: Prisma.TransactionClient, session: Pick<AppSessionUser, "id" | "memberId" | "appSessionId">) {
  const [{ now }] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const current = new Date(Math.max(now.getTime(), Date.now()));
  const actualSession = await client.appSession.findFirst({ where: { id: session.appSessionId, userId: session.id, memberId: session.memberId, revokedAt: null, expiresAt: { gt: current } }, select: { id: true } });
  if (!actualSession) throw new Error("Unauthorized");
  return current;
}
export function encryptionMode(value: string): EncryptionMode {
  if (!MODES.has(value as EncryptionMode)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  return value as EncryptionMode;
}

export function parseEncryptionInput(value: unknown): EncryptionInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["code", "revision"].includes(key)) || typeof input.code !== "string" || input.code.length > 4096 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  return { code: input.code, revision: Number(input.revision) };
}

export function extractEncryption(formData: FormData): EncryptionInput | undefined {
  const values = formData.getAll("__householdEncryption");
  formData.delete("__householdEncryption");
  if (!values.length) return undefined;
  if (values.length !== 1 || typeof values[0] !== "string" || values[0].length > 8192) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  try { return parseEncryptionInput(JSON.parse(values[0])); }
  catch { throw new EncryptionRequestError("ENCRYPTION_INVALID"); }
}

export async function getHouseholdEncryptionStatus(session: AppSessionUser): Promise<EncryptionStatus> {
  const config = await physicalDb.householdEncryption.findUnique({ where: { householdId: session.householdId } });
  const operation = config?.activeOperationId ? await physicalDb.encryptionOperation.findUnique({ where: { id: config.activeOperationId }, select: { id: true, kind: true, status: true, expiresAt: true } }) : null;
  return {
    mode: encryptionMode(config?.mode ?? "UNENCRYPTED"), revision: config?.revision ?? 0,
    generation: config?.generation ?? null, keyVersion: config?.keyVersion ?? 0, isOwner: session.role === "OWNER",
    operation: operation ? { ...operation, expiresAt: operation.expiresAt.toISOString() } : null,
  };
}

export async function withHouseholdEncryption<T>(input: EncryptionInput | undefined, work: (session: AppSessionUser) => Promise<T>, options: { readOnly?: boolean; receiptQuery?: boolean } = {}): Promise<T> {
  const { requireAppSession } = await import("@/lib/auth/session");
  const session = await requireAppSession();
  await assertEncryptionSession(physicalDb, session);
  if (input?.code) {
    const { headers } = await import("next/headers");
    assertEncryptionTransport(await headers());
  }
  const existing = getEncryptionContext();
  if (existing) {
    if (existing.session.appSessionId !== session.appSessionId || existing.session.memberId !== session.memberId || (input && input.revision !== existing.revision) || (!options.readOnly && !options.receiptQuery && existing.readOnly)) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
    return work(session);
  }
  const config = await physicalDb.householdEncryption.findUnique({ where: { householdId: session.householdId } });
  const mode = encryptionMode(config?.mode ?? "UNENCRYPTED");
  const revision = config?.revision ?? 0;
  if (input && input.revision !== revision) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
  const converting = mode === "ENABLING" || mode === "DISABLING" || !!config?.activeOperationId;
  // Receipt queries preserve their existing terminal writes only in a stable mode.
  const readOnly = options.readOnly === true || (options.receiptQuery === true && converting);
  if (converting && !readOnly) throw new EncryptionRequestError("ENCRYPTION_BUSY");
  const encrypted = mode === "ENCRYPTED" || mode === "DISABLING";
  let ring = null;
  if (encrypted) {
    if (!input?.code || !config?.sealedKeyRing) throw new EncryptionRequestError("ENCRYPTION_REQUIRED");
    try {
      const code = parseHouseholdCode(input.code);
      if (code.householdId !== session.householdId || code.generation !== config.generation || code.keyVersion !== config.keyVersion) throw new Error("Invalid key");
      ring = await openKeyRing(code, config.sealedKeyRing);
    } catch { throw new EncryptionRequestError("ENCRYPTION_INVALID"); }
  }
  return runEncryptionContext({ session, mode: encrypted ? "ENCRYPTED" : "UNENCRYPTED", configMode: mode, revision, ring, expiresAt: Date.now() + 10 * 60 * 1000, disposed: false, readOnly }, async () => {
    const value = await work(session);
    const current = await requireAppSession();
    await assertEncryptionSession(physicalDb, session);
    const latest = await physicalDb.householdEncryption.findUnique({ where: { householdId: session.householdId }, select: { revision: true, mode: true } });
    if (current.appSessionId !== session.appSessionId || current.memberId !== session.memberId || current.householdId !== session.householdId || (latest?.revision ?? 0) !== revision || (latest?.mode ?? "UNENCRYPTED") !== mode) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
    return value;
  });
}
