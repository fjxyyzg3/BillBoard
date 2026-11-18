import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendEncryption, clearClientDraft, clearUsableEncryption, ensureDurableEntryRequest, entryBrowserStorage, forgetClientEncryption, getEncryptionInput, readClientDraft, restoreEntryBrowserState, setClientEncryption, writeClientDraft } from "@/lib/encryption/client";
import { encryptionIdentityKey, loadClientEncryptionOperation, recallHouseholdCode, rememberHouseholdCode, retainHouseholdIdentity, saveClientEncryptionOperation } from "@/lib/encryption/client-store";
import { createHouseholdCode, encodeHouseholdCode } from "@/lib/encryption/crypto";

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const stores = { keys: new Map<IDBValidKey, unknown>(), codes: new Map<IDBValidKey, unknown>() };
function fakeDatabase() {
  return { close() {}, transaction(name: keyof typeof stores) {
    const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; abort: () => void; objectStore: () => unknown } = { objectStore: () => ({}), abort() {} };
    const request = (work: () => unknown) => {
      const result: { result?: unknown; onsuccess?: () => void } = {};
      queueMicrotask(() => { result.result = work(); result.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
      return result;
    };
    tx.objectStore = () => ({
      get: (key: IDBValidKey) => request(() => stores[name].get(key)),
      put: (value: { identity?: string }, key?: IDBValidKey) => request(() => { stores[name].set(key ?? value.identity!, value); return key; }),
      add: (value: unknown, key: IDBValidKey) => request(() => { stores[name].set(key, value); return key; }),
      delete: (key: IDBValidKey) => request(() => stores[name].delete(key)),
      clear: () => request(() => stores[name].clear()),
      getAll: () => request(() => [...stores[name].values()]),
      getAllKeys: () => request(() => [...stores[name].keys()]),
    });
    return tx;
  } };
}
const identity = { accountId: "account-1", householdId: "household-1", memberId: "member-1" };
const status = { mode: "ENCRYPTED" as const, revision: 4, generation: "generation-1", keyVersion: 1, isOwner: true, operation: null };

describe("browser household secrets", () => {
  beforeEach(async () => {
    stores.keys.clear(); stores.codes.clear();
    vi.stubGlobal("indexedDB", { open: () => {
      const request: { result: unknown; onsuccess?: () => void } = { result: fakeDatabase() };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } });
    const browser = new EventTarget() as EventTarget & { sessionStorage: MemoryStorage; localStorage: MemoryStorage };
    browser.sessionStorage = new MemoryStorage(); browser.localStorage = new MemoryStorage();
    vi.stubGlobal("window", browser);
    await forgetClientEncryption();
  });

  it("stores only authenticated ciphertext and a nonextractable device key", async () => {
    const code = encodeHouseholdCode(createHouseholdCode(identity.householdId));
    await rememberHouseholdCode(identity, code);
    expect(await recallHouseholdCode(identity)).toBe(code);
    expect(stores.keys.get("device")).toMatchObject({ extractable: false });
    expect(JSON.stringify(stores.codes.get(encryptionIdentityKey(identity)))).not.toContain(code);
    expect(await recallHouseholdCode({ ...identity, memberId: "member-2" })).toBeNull();
    await retainHouseholdIdentity({ ...identity, memberId: "member-2" });
    expect(await recallHouseholdCode(identity)).toBeNull();
  });

  it("encrypts a pending snapshot while preserving its UUID and exact input", async () => {
    setClientEncryption(identity, status, "request-code");
    const key = "billboard:transaction-draft:v2:household-1:member-1:ledger-1";
    const draft = JSON.stringify({ requestId: "same-original-uuid", amount: "18.60", note: "private breakfast" });
    expect(await writeClientDraft(key, draft)).toBe(true);
    const saved = window.sessionStorage.getItem(key)!;
    expect(saved).not.toContain("private breakfast"); expect(saved).not.toContain("18.60"); expect(saved).not.toContain("request-code");
    expect(await readClientDraft(key)).toBe(draft);
  });

  it("restores the exact protected draft after the browser session storage is recreated", async () => {
    setClientEncryption(identity, status, "request-code");
    const key = "billboard:transaction-draft:v2:household-1:member-1:ledger-1";
    const draft = JSON.stringify({ clientRequestId: "same-original-uuid", amount: "47.82", note: "restart-private-note" });
    expect(await writeClientDraft(key, draft)).toBe(true);
    Object.assign(window, { sessionStorage: new MemoryStorage() });
    clearUsableEncryption();
    setClientEncryption(identity, status, "request-code");
    expect(await readClientDraft(key)).toBe(draft);
    expect(JSON.stringify([...stores.keys])).not.toContain("restart-private-note");
    clearClientDraft(key);
    Object.assign(window, { sessionStorage: new MemoryStorage() });
    expect(await readClientDraft(key)).toBeNull();
  });

  it("restores pending text and voice UUIDs from ciphertext and clears completed requests durably", async () => {
    setClientEncryption(identity, status, "request-code");
    const context = { householdId: identity.householdId, memberId: identity.memberId, ledgerId: "ledger-1" };
    const requestId = crypto.randomUUID();
    const textKey = "billboard:natural-language-pending:v2:household-1:member-1:ledger-1";
    const voiceKey = "billboard:voice-pending:v2:household-1:member-1:ledger-1";
    await ensureDurableEntryRequest("text", requestId, context);
    await ensureDurableEntryRequest("voice", requestId, context);
    expect(JSON.stringify([...stores.keys])).not.toContain(requestId);
    Object.assign(window, { sessionStorage: new MemoryStorage() });
    await restoreEntryBrowserState();
    expect(window.sessionStorage.getItem(textKey)).toBe(requestId);
    expect(window.sessionStorage.getItem(voiceKey)).toBe(JSON.stringify([requestId]));
    entryBrowserStorage().removeItem(textKey);
    entryBrowserStorage().removeItem(voiceKey);
    Object.assign(window, { sessionStorage: new MemoryStorage() });
    await restoreEntryBrowserState();
    expect(window.sessionStorage.getItem(textKey)).toBeNull();
    expect(window.sessionStorage.getItem(voiceKey)).toBeNull();
  });

  it("does not admit encrypted tasks when a protected UUID cannot be saved", async () => {
    setClientEncryption(identity, status, "request-code");
    vi.stubGlobal("indexedDB", { open: () => { throw new Error("device unavailable"); } });
    await expect(ensureDurableEntryRequest("text", crypto.randomUUID(), { householdId: identity.householdId, memberId: identity.memberId, ledgerId: "ledger-1" })).rejects.toThrow("LOCAL_KEY_STORAGE_UNAVAILABLE");
  });

  it("does not revive protected drafts after identity change or explicit logout", async () => {
    setClientEncryption(identity, status, "request-code");
    const key = "billboard:transaction-draft:v2:household-1:member-1:ledger-1";
    expect(await writeClientDraft(key, "original protected payload")).toBe(true);
    await retainHouseholdIdentity({ ...identity, memberId: "replacement-member" });
    Object.assign(window, { sessionStorage: new MemoryStorage() });
    expect(await readClientDraft(key)).toBeNull();
    expect(await writeClientDraft(key, "another protected payload")).toBe(true);
    await forgetClientEncryption();
    setClientEncryption(identity, status, "request-code");
    expect(await readClientDraft(key)).toBeNull();
  });

  it("does not deliver an old decrypted draft after the active identity changes", async () => {
    setClientEncryption(identity, status, "request-code");
    const key = "billboard:transaction-draft:v2:household-1:member-1:ledger-1";
    await writeClientDraft(key, "old identity draft");
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const mayFinish = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args: Parameters<typeof decrypt>) => { entered(); await mayFinish; return decrypt(...args); });
    try {
      const pending = readClientDraft(key);
      const rejected = expect(pending).rejects.toThrow("LOCAL_KEY_STORAGE_UNAVAILABLE");
      await waiting;
      setClientEncryption({ ...identity, memberId: "replacement-member" }, status, "another-code");
      release();
      await rejected;
    } finally { release(); spy.mockRestore(); }
  });

  it("identifies an unreadable protected draft after disabling without deleting its only stored envelope", async () => {
    setClientEncryption(identity, status, "request-code");
    const key = "billboard:transaction-draft:v2:household-1:member-1:ledger-1";
    await writeClientDraft(key, JSON.stringify({ clientRequestId: "original-uuid", note: "protected original" }));
    const original = window.sessionStorage.getItem(key);
    stores.keys.delete("device");
    setClientEncryption(identity, { ...status, mode: "UNENCRYPTED", revision: 6 }, null);
    await expect(readClientDraft(key)).rejects.toThrow("PROTECTED_DRAFT_UNAVAILABLE");
    expect(window.sessionStorage.getItem(key)).toBe(original);
    expect([...stores.keys.keys()].some((stored) => typeof stored === "string" && stored.startsWith("state:"))).toBe(true);
  });

  it("does not let an unfinished encryption write resurrect a cleared draft", async () => {
    setClientEncryption(identity, status, "request-code");
    const pending = writeClientDraft("draft", "sensitive");
    clearClientDraft("draft");
    expect(await pending).toBe(false);
    expect(window.sessionStorage.getItem("draft")).toBeNull();
  });

  it("does not let a pending device-key save recreate a code after logout", async () => {
    const pending = rememberHouseholdCode(identity, "must-not-return");
    const rejected = expect(pending).rejects.toThrow("LOCAL_KEY_STORAGE_UNAVAILABLE");
    await forgetClientEncryption();
    await rejected;
    expect(await recallHouseholdCode(identity)).toBeNull();
  });

  it("persists operation revisions in invocation order even when encryption finishes out of order", async () => {
    await rememberHouseholdCode(identity, "initialize-device-key");
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let release!: () => void;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const firstMayFinish = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const spy = vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args: Parameters<typeof encrypt>) => {
      if (first) { first = false; entered(); await firstMayFinish; }
      return encrypt(...args);
    });
    try {
      const older = saveClientEncryptionOperation(identity, { id: "original-uuid", prepared: false });
      await firstEntered;
      const newer = saveClientEncryptionOperation(identity, { id: "original-uuid", prepared: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await Promise.all([older, newer]);
      expect(await loadClientEncryptionOperation(identity)).toEqual({ id: "original-uuid", prepared: true });
    } finally { release(); spy.mockRestore(); }
  });

  it("retains protected code on expiry and removes it on explicit logout", async () => {
    await rememberHouseholdCode(identity, "remembered-code");
    setClientEncryption(identity, status, "remembered-code");
    clearUsableEncryption();
    expect(() => getEncryptionInput()).toThrow("HOUSEHOLD_LOCKED");
    expect(await recallHouseholdCode(identity)).toBe("remembered-code");
    await forgetClientEncryption();
    expect(await recallHouseholdCode(identity)).toBeNull();
  });

  it("reports a native clear failure for retry after immediately dropping usable memory", async () => {
    let saved: string | null = null;
    let clearFails = true;
    const native = {
      onmessage: null as ((event: { data: string }) => void) | null,
      postMessage(text: string) {
        const request = JSON.parse(text);
        expect(request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(request.payload.identity).toEqual(identity);
        if (request.operation === "store") saved = request.payload.code;
        const ok = request.operation !== "clear" || !clearFails;
        if (request.operation === "clear" && ok) saved = null;
        native.onmessage?.({ data: JSON.stringify({ v: 1, requestId: request.requestId, ok, ...(ok ? { payload: request.operation === "load" ? { code: saved } : {} } : { error: "unavailable" }) }) });
      },
    };
    Object.assign(window, { BillBoardHouseholdKeys: native });
    await rememberHouseholdCode(identity, "native-code");
    setClientEncryption(identity, status, "native-code");
    await expect(forgetClientEncryption()).rejects.toThrow("LOCAL_KEY_STORAGE_UNAVAILABLE");
    expect(getEncryptionInput()).toBeUndefined();
    expect(saved).toBe("native-code");
    clearFails = false;
    await forgetClientEncryption();
    expect(saved).toBeNull();
  });

  it("retains the old native identity pointer when cleanup fails and replaces it only after a successful retry", async () => {
    const next = { ...identity, memberId: "replacement-member" };
    const calls: Array<{ operation: string; payload: { identity: typeof identity; code?: string } }> = [];
    let clearFails = true;
    const native = {
      onmessage: null as ((event: { data: string }) => void) | null,
      postMessage(text: string) {
        const request = JSON.parse(text); calls.push(request);
        const ok = request.operation !== "clear" || !clearFails;
        native.onmessage?.({ data: JSON.stringify({ v: 1, requestId: request.requestId, ok, ...(ok ? { payload: { code: request.operation === "load" ? null : undefined } } : { error: "unavailable" }) }) });
      },
    };
    Object.assign(window, { BillBoardHouseholdKeys: native });
    stores.keys.set("native-identity", identity);
    await expect(retainHouseholdIdentity(next)).rejects.toThrow("LOCAL_KEY_CLEAR_REQUIRED");
    expect(stores.keys.get("native-identity")).toEqual(identity);
    expect(calls.map((call) => call.operation)).toEqual(["clear"]);
    clearFails = false;
    await retainHouseholdIdentity(next);
    await recallHouseholdCode(next);
    expect(stores.keys.get("native-identity")).toEqual(next);
    expect(calls.map((call) => call.operation)).toEqual(["clear", "clear", "load"]);
  });

  it("adds the code only to runtime FormData and keeps unencrypted requests compatible", () => {
    const form = new FormData(); form.set("note", "business input");
    expect(appendEncryption(form).has("__householdEncryption")).toBe(false);
    setClientEncryption(identity, status, "runtime-code");
    expect(JSON.parse(String(appendEncryption(form).get("__householdEncryption")))).toEqual({ code: "runtime-code", revision: 4 });
  });
});
