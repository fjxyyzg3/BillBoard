import { AsyncLocalStorage } from "node:async_hooks";
import type { KeyRing } from "./crypto";
import { EncryptionRequestError } from "./types";
import type { EncryptionMode } from "./types";

export type EncryptionRequestContext = {
  session: { id: string; householdId: string; memberId: string; appSessionId: string; role: "OWNER" | "MEMBER" };
  mode: "UNENCRYPTED" | "ENCRYPTED";
  configMode: EncryptionMode;
  revision: number;
  ring: KeyRing | null;
  expiresAt: number;
  disposed: boolean;
  readOnly: boolean;
};

const execution = new AsyncLocalStorage<EncryptionRequestContext>();

export function assertEncryptionContext(context: EncryptionRequestContext) {
  if (context.disposed || Date.now() >= context.expiresAt) throw new EncryptionRequestError("ENCRYPTION_EXPIRED");
}

export function getEncryptionContext(): EncryptionRequestContext | undefined {
  const context = execution.getStore();
  if (context) assertEncryptionContext(context);
  return context;
}
export function isEncryptedRequest() { return getEncryptionContext()?.mode === "ENCRYPTED"; }
export async function runEncryptionContext<T>(context: EncryptionRequestContext, work: () => Promise<T>): Promise<T> {
  assertEncryptionContext(context);
  if (execution.getStore()) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  return execution.run(context, async () => {
    try {
      const result = await work();
      assertEncryptionContext(context);
      return result;
    } finally {
      context.disposed = true;
      if (context.ring) for (const key of context.ring.keys) key.secret = "";
      context.ring = null;
    }
  });
}
