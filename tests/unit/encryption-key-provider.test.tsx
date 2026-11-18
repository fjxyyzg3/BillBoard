import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionProvider } from "@/components/encryption-provider";
import { createHouseholdCode, encodeHouseholdCode } from "@/lib/encryption/crypto";
import type { EncryptionStatus } from "@/lib/encryption/types";

const harness = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[], effects: [] as Array<() => void>, layoutEffects: [] as Array<() => void>, retain: vi.fn(), recall: vi.fn(), remember: vi.fn(), generation: 0, promote: vi.fn(), current: null as { identity: { accountId: string; householdId: string; memberId: string }; status: EncryptionStatus; code: string | null } | null }));
const identity = { accountId: "account", householdId: "household", memberId: "member" };
const status = { mode: "ENCRYPTED" as const, revision: 1, generation: "generation", keyVersion: 1, isOwner: false, operation: null };
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [harness.states[index], (value: unknown) => { harness.states[index] = typeof value === "function" ? value(harness.states[index]) : value; }];
  },
  useEffect: (work: () => void) => harness.effects.push(work), useLayoutEffect: (work: () => void) => harness.layoutEffects.push(work), useCallback: (work: unknown) => work,
}));
vi.mock("@/lib/encryption/client-store", () => ({
  encryptionIdentityKey: (value: typeof identity) => JSON.stringify([value.accountId, value.householdId, value.memberId]),
  retainHouseholdIdentity: harness.retain, recallHouseholdCode: harness.recall, rememberHouseholdCode: harness.remember,
}));
vi.mock("@/lib/encryption/client", () => ({ encryptionClientGeneration: () => harness.generation, getClientEncryption: () => harness.current, clearUsableEncryption: () => { harness.generation += 1; }, setClientEncryption: harness.promote }));

function render(currentStatus: EncryptionStatus = status, runEffects = true) {
  harness.cursor = 0; harness.effects = []; harness.layoutEffects = [];
  const tree = EncryptionProvider({ identity, status: currentStatus, children: null }) as ReactElement<{ value: { ready: boolean; code: string | null; supply: (code: string, remember: boolean) => Promise<void>; activate: (nextStatus: EncryptionStatus, code: string | null) => void } }>;
  if (runEffects) for (const work of [...harness.layoutEffects, ...harness.effects]) work();
  return tree.props.value;
}

describe("native key cleanup before changing identity", () => {
  beforeEach(() => {
    harness.states = []; harness.generation = 0; harness.current = null; harness.retain.mockReset(); harness.recall.mockReset().mockResolvedValue(null); harness.remember.mockReset(); harness.promote.mockReset().mockImplementation((identity, status, code) => { harness.current = { identity, status, code }; });
    vi.stubGlobal("window", { sessionStorage: { getItem: () => null, setItem: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  it("keeps plain SSR readiness stable while device identity cleanup is pending", async () => {
    let finish!: () => void;
    harness.retain.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const plain: EncryptionStatus = { ...status, mode: "UNENCRYPTED", revision: 0, generation: null, keyVersion: 0 };
    const value = render(plain);
    const initialLocal = harness.states[0];
    expect(value.ready).toBe(true);
    expect(value.code).toBeNull();
    expect(harness.promote).toHaveBeenCalledWith(identity, plain, null);
    expect(harness.generation).toBe(0);
    finish();
    await vi.waitFor(() => expect(harness.promote).toHaveBeenCalledTimes(2));
    expect(harness.states[0]).toBe(initialLocal);
    expect(harness.recall).not.toHaveBeenCalled();
  });

  it("does not load the new identity or overwrite its native pointer after old-identity cleanup fails, and supports retry", async () => {
    harness.retain.mockRejectedValue(new Error("LOCAL_KEY_CLEAR_REQUIRED"));
    render();
    await vi.waitFor(() => expect(harness.states[0]).toMatchObject({ clearRequired: true }));
    expect(harness.recall).not.toHaveBeenCalled();
    expect(harness.remember).not.toHaveBeenCalled();
    harness.retain.mockResolvedValue(undefined);
    render();
    await vi.waitFor(() => expect(harness.recall).toHaveBeenCalledWith(identity));
    expect(harness.states[0]).not.toMatchObject({ clearRequired: true });
  });

  it("still permits a session-only import when ordinary protected storage is unavailable", async () => {
    harness.retain.mockRejectedValue(new Error("LOCAL_KEY_STORAGE_UNAVAILABLE"));
    const value = render();
    await vi.waitFor(() => expect(harness.states[0]).toMatchObject({ ready: true }));
    const code = encodeHouseholdCode(createHouseholdCode(identity.householdId, status.generation, status.keyVersion));
    await value.supply(code, false);
    expect(harness.promote).toHaveBeenCalledWith(identity, status, code);
    expect(harness.remember).not.toHaveBeenCalled();
  });

  it("makes the verified committed code available to the next operation before the server refresh arrives", async () => {
    harness.retain.mockResolvedValue(undefined);
    const code = encodeHouseholdCode(createHouseholdCode(identity.householdId, status.generation, status.keyVersion));
    const value = render();
    await vi.waitFor(() => expect(harness.states[0]).toMatchObject({ ready: true }));
    value.activate(status, code);
    const refreshed = render(status, false);
    expect(refreshed.code).toBe(code);
  });
});
