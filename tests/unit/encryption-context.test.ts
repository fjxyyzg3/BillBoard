import { describe, expect, it } from "vitest";
import { getEncryptionContext, runEncryptionContext, type EncryptionRequestContext } from "@/lib/encryption/request-context";

function context(householdId: string): EncryptionRequestContext {
  return { session: { id: "user", householdId, memberId: "member", appSessionId: "session", role: "OWNER" }, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1, ring: null, expiresAt: Date.now() + 10000, disposed: false, readOnly: true };
}

describe("request-scoped household execution", () => {
  it("isolates concurrent requests and releases context on success or failure", async () => {
    const a = context("household-a"), b = context("household-b");
    const values = await Promise.all([a, b].map((value) => runEncryptionContext(value, async () => {
      await new Promise((resolve) => setTimeout(resolve, 3));
      return getEncryptionContext()?.session.householdId;
    })));
    expect(values).toEqual(["household-a", "household-b"]);
    expect(getEncryptionContext()).toBeUndefined();
    expect(a.disposed).toBe(true);
    const failed = context("failed");
    await expect(runEncryptionContext(failed, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(failed.disposed).toBe(true);
  });

  it("rejects expired and detached execution rather than inheriting a later request", async () => {
    const expired = context("expired");
    expired.expiresAt = Date.now() - 1;
    await expect(runEncryptionContext(expired, async () => getEncryptionContext())).rejects.toThrow("ENCRYPTION_EXPIRED");
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    let detached!: Promise<unknown>;
    const active = context("active");
    await runEncryptionContext(active, async () => {
      detached = (async () => { await deferred; return getEncryptionContext(); })();
      expect(getEncryptionContext()).toBe(active);
    });
    release();
    await expect(detached).rejects.toThrow("ENCRYPTION_EXPIRED");
  });
});
