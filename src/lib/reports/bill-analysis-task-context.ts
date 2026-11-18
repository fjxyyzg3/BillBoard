import type { AppSessionUser } from "@/auth";
import { physicalDb } from "@/lib/db";
import { openKeyRing, parseHouseholdCode } from "@/lib/encryption/crypto";
import { assertEncryptionSession, encryptionMode } from "@/lib/encryption/request";
import type { EncryptionRequestContext } from "@/lib/encryption/request-context";
import { EncryptionRequestError, type EncryptionInput } from "@/lib/encryption/types";

export function disposeBillAnalysisTaskContext(context: EncryptionRequestContext): void {
  context.disposed = true;
  if (context.ring) for (const key of context.ring.keys) key.secret = "";
  context.ring = null;
}

export async function createBillAnalysisTaskContext(
  session: AppSessionUser, input: EncryptionInput | undefined, startedAt: number,
): Promise<EncryptionRequestContext> {
  await assertEncryptionSession(physicalDb, session);
  const config = await physicalDb.householdEncryption.findUnique({ where: { householdId: session.householdId } });
  const mode = encryptionMode(config?.mode ?? "UNENCRYPTED");
  const revision = config?.revision ?? 0;
  if (input && input.revision !== revision) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
  if (config?.activeOperationId || !["UNENCRYPTED", "ENCRYPTED"].includes(mode)) throw new EncryptionRequestError("ENCRYPTION_BUSY");
  const context: EncryptionRequestContext = {
    session, mode: mode === "ENCRYPTED" ? "ENCRYPTED" : "UNENCRYPTED", configMode: mode, revision,
    ring: null, expiresAt: startedAt + 10 * 60_000, disposed: false, readOnly: false,
  };
  try {
    if (mode === "ENCRYPTED") {
      if (!input?.code || !config?.sealedKeyRing) throw new EncryptionRequestError("ENCRYPTION_REQUIRED");
      try {
        const code = parseHouseholdCode(input.code);
        if (code.householdId !== session.householdId || code.generation !== config.generation || code.keyVersion !== config.keyVersion) throw new Error("Invalid key");
        context.ring = await openKeyRing(code, config.sealedKeyRing);
      } catch { throw new EncryptionRequestError("ENCRYPTION_INVALID"); }
    }
    if (Date.now() >= context.expiresAt) throw new EncryptionRequestError("ENCRYPTION_EXPIRED");
    return context;
  } catch (error) {
    disposeBillAnalysisTaskContext(context);
    throw error;
  }
}
