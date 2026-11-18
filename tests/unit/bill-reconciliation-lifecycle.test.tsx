import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionLifecycle, forgetEncryptionIdentity } from "@/components/encryption-lifecycle";
import { reconciliationApplicationStorageKey, RECONCILIATION_APPLICATION_STORAGE_KEY } from "@/lib/reports/bill-reconciliation-controller";

const harness = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, forget: vi.fn(), lock: vi.fn(), pathname: "/login" }));
vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect); } }));
vi.mock("@/lib/encryption/client", () => ({ forgetClientEncryption: harness.forget, clearUsableEncryption: harness.lock }));

describe("reconciliation result-check pointer lifecycle", () => {
  let data: Map<string, string>;
  const channels: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
  beforeEach(() => {
    data = new Map([[RECONCILIATION_APPLICATION_STORAGE_KEY, "identity-bound-pending-uuid"],
      [reconciliationApplicationStorageKey("household:member", "00000000-0000-4000-8000-000000000002"), "second-pending-uuid"]]);
    harness.effects = []; harness.forget.mockReset().mockResolvedValue(undefined); harness.lock.mockReset(); channels.length = 0;
    vi.stubGlobal("window", { localStorage: { get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
      removeItem: (key: string) => { data.delete(key); } } });
    vi.stubGlobal("BroadcastChannel", class {
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() { channels.push(this); }
      postMessage() {}
      close() {}
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("clears the pointer only after explicit identity forgetting succeeds", async () => {
    await forgetEncryptionIdentity();
    expect(data.has(RECONCILIATION_APPLICATION_STORAGE_KEY)).toBe(false);
    expect(data.size).toBe(0);
    harness.forget.mockRejectedValueOnce(new Error("Key storage failed"));
    data.set(RECONCILIATION_APPLICATION_STORAGE_KEY, "unconfirmed");
    await expect(forgetEncryptionIdentity()).rejects.toThrow("Key storage failed");
    expect(data.get(RECONCILIATION_APPLICATION_STORAGE_KEY)).toBe("unconfirmed");
  });

  it("retains the pointer when a session expires and the login page clears usable keys", () => {
    EncryptionLifecycle();
    harness.effects[0]();
    expect(harness.lock).toHaveBeenCalledOnce();
    expect(data.has(RECONCILIATION_APPLICATION_STORAGE_KEY)).toBe(true);
    expect(data.size).toBe(2);
    expect(harness.forget).not.toHaveBeenCalled();
  });

  it("clears another tab’s pointer when the shared identity is explicitly forgotten", () => {
    EncryptionLifecycle();
    const cleanup = harness.effects[1]();
    channels[0].onmessage?.({ data: "forget" });
    expect(data.has(RECONCILIATION_APPLICATION_STORAGE_KEY)).toBe(false);
    expect(data.size).toBe(0);
    expect(harness.forget).toHaveBeenCalledOnce();
    cleanup?.();
  });
});
