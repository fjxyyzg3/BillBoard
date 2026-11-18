export type EncryptionIdentity = { accountId: string; householdId: string; memberId: string };
type StoredCode = { identity: string; iv: Uint8Array; ciphertext: ArrayBuffer };
const databaseName = "billboard-household-keys-v1";
type NativeBridge = { postMessage: (message: string) => void; onmessage: ((event: { data: string }) => void) | null };
const nativePending = new Map<string, { resolve: (value: string | null) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }>();
let attachedBridge: NativeBridge | undefined;
let storageEpoch = 0;
let activeIdentity: string | null = null;
const operationWrites = new Map<string, Promise<void>>();
const stateWrites = new Map<string, Promise<void>>();

async function queueStateWrite(key: string, work: () => Promise<void>) {
  const pending = (stateWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  stateWrites.set(key, pending);
  try { await pending; }
  finally { if (stateWrites.get(key) === pending) stateWrites.delete(key); }
}

function bridge(): NativeBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { BillBoardHouseholdKeys?: NativeBridge }).BillBoardHouseholdKeys;
}

async function nativeCode(operation: "store" | "load" | "clear", identity: EncryptionIdentity, code?: string): Promise<string | null> {
  const epoch = storageEpoch;
  const native = bridge();
  if (!native) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  if (attachedBridge !== native) {
    attachedBridge = native;
    native.onmessage = (event) => {
      try {
        const result = JSON.parse(event.data);
        const waiting = nativePending.get(result.requestId);
        if (!waiting || result.v !== 1) return;
        nativePending.delete(result.requestId);
        clearTimeout(waiting.timer);
        if (!result.ok) waiting.reject();
        else waiting.resolve(typeof result.payload?.code === "string" ? result.payload.code : null);
      } catch { /* Ignore messages outside the narrow key-storage protocol. */ }
    };
  }
  await transaction("keys", "readwrite", (store) => store.put(identity, "native-identity"));
  if (operation === "store" && epoch !== storageEpoch) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const fail = () => reject(new Error("LOCAL_KEY_STORAGE_UNAVAILABLE"));
    const timer = setTimeout(() => { nativePending.delete(requestId); fail(); }, 10_000);
    nativePending.set(requestId, { resolve, reject: fail, timer });
    try { native.postMessage(JSON.stringify({ v: 1, requestId, operation, payload: { identity, ...(code === undefined ? {} : { code }) } })); }
    catch { clearTimeout(timer); nativePending.delete(requestId); fail(); }
  });
}

export function encryptionIdentityKey(identity: EncryptionIdentity) {
  return JSON.stringify([identity.accountId, identity.householdId, identity.memberId]);
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("keys");
      request.result.createObjectStore("codes", { keyPath: "identity" });
    };
    request.onerror = () => reject(new Error("LOCAL_KEY_STORAGE_UNAVAILABLE"));
    request.onsuccess = () => resolve(request.result);
  });
}

async function transaction<T>(store: "keys" | "codes", mode: IDBTransactionMode, work: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const connection = await database();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(store, mode);
    let value: T;
    let request: IDBRequest<T>;
    try { request = work(tx.objectStore(store)); }
    catch (error) { tx.abort(); connection.close(); reject(error); return; }
    request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => { connection.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { connection.close(); reject(new Error("LOCAL_KEY_STORAGE_UNAVAILABLE")); };
  });
}

async function deviceKey() {
  const existing = await transaction<CryptoKey | undefined>("keys", "readonly", (store) => store.get("device"));
  if (existing) return existing;
  const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  // add, rather than put, avoids replacing another tab's device key.
  try { await transaction("keys", "readwrite", (store) => store.add(candidate, "device")); }
  catch {
    const winner = await transaction<CryptoKey | undefined>("keys", "readonly", (store) => store.get("device"));
    if (winner) return winner;
    throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  }
  return candidate;
}

export async function rememberHouseholdCode(identity: EncryptionIdentity, code: string) {
  const epoch = storageEpoch;
  if (bridge()) {
    await nativeCode("store", identity, code);
    if (await nativeCode("load", identity) !== code) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
    return;
  }
  const scope = encryptionIdentityKey(identity);
  const key = await deviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(code);
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(scope) }, key, plaintext);
    await transaction("codes", "readwrite", (store) => {
      if (epoch !== storageEpoch) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
      return store.put({ identity: scope, iv, ciphertext } satisfies StoredCode);
    });
    if (await recallHouseholdCode(identity) !== code) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  } finally { plaintext.fill(0); }
}

export async function recallHouseholdCode(identity: EncryptionIdentity): Promise<string | null> {
  if (bridge()) return nativeCode("load", identity);
  const scope = encryptionIdentityKey(identity);
  const saved = await transaction<StoredCode | undefined>("codes", "readonly", (store) => store.get(scope));
  if (!saved) return null;
  const key = await transaction<CryptoKey | undefined>("keys", "readonly", (store) => store.get("device"));
  if (!key) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: saved.iv as Uint8Array<ArrayBuffer>, additionalData: new TextEncoder().encode(scope) }, key, saved.ciphertext));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(plaintext); }
  finally { plaintext.fill(0); }
}

export async function forgetHouseholdCodes(identity?: EncryptionIdentity) {
  storageEpoch += 1;
  const nativeIdentity = identity ?? await transaction<EncryptionIdentity | undefined>("keys", "readonly", (store) => store.get("native-identity"));
  if (bridge() && nativeIdentity) await nativeCode("clear", nativeIdentity);
  if (identity) await transaction("codes", "readwrite", (store) => store.delete(encryptionIdentityKey(identity)));
  else await transaction("codes", "readwrite", (store) => store.clear());
}

export async function retainHouseholdIdentity(identity: EncryptionIdentity) {
  const scope = encryptionIdentityKey(identity);
  if (activeIdentity !== scope) { activeIdentity = scope; storageEpoch += 1; }
  const nativeIdentity = await transaction<EncryptionIdentity | undefined>("keys", "readonly", (store) => store.get("native-identity"));
  if (bridge() && nativeIdentity && encryptionIdentityKey(nativeIdentity) !== scope) {
    try { await nativeCode("clear", nativeIdentity); }
    catch { throw new Error("LOCAL_KEY_CLEAR_REQUIRED"); }
  }
  const saved = await transaction<StoredCode[]>("codes", "readonly", (store) => store.getAll());
  for (const item of saved) if (item.identity !== scope) {
    await transaction("codes", "readwrite", (store) => store.delete(item.identity));
  }
  const keys = await transaction<IDBValidKey[]>("keys", "readonly", (store) => store.getAllKeys());
  for (const key of keys) if (typeof key === "string"
    && ((key.startsWith("operation:") && key !== `operation:${scope}`) || (key.startsWith("state:") && !key.startsWith(`state:${scope}:`)))) {
    await queueStateWrite(key, async () => { await transaction("keys", "readwrite", (store) => store.delete(key)); });
  }
}

export async function saveProtectedClientState(identity: EncryptionIdentity, storageKey: string, value: string, current: () => boolean) {
  const epoch = storageEpoch;
  const key = `state:${encryptionIdentityKey(identity)}:${storageKey}`;
  await queueStateWrite(key, async () => {
    await transaction("keys", "readwrite", (store) => {
      if (epoch !== storageEpoch || !current()) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
      return store.put(value, key);
    });
    if (await transaction("keys", "readonly", (store) => store.get(key)) !== value) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  });
}

export async function loadProtectedClientState(identity: EncryptionIdentity, storageKey: string) {
  const key = `state:${encryptionIdentityKey(identity)}:${storageKey}`;
  await stateWrites.get(key)?.catch(() => undefined);
  return await transaction<string | undefined>("keys", "readonly", (store) => store.get(key)) ?? null;
}

export async function loadProtectedClientStates(identity: EncryptionIdentity) {
  const prefix = `state:${encryptionIdentityKey(identity)}:`;
  await Promise.allSettled([...stateWrites].filter(([key]) => key.startsWith(prefix)).map(([, work]) => work));
  const keys = await transaction<IDBValidKey[]>("keys", "readonly", (store) => store.getAllKeys());
  const values: Array<[string, string]> = [];
  for (const key of keys) if (typeof key === "string" && key.startsWith(prefix)) {
    const value = await transaction<string | undefined>("keys", "readonly", (store) => store.get(key));
    if (value) values.push([key.slice(prefix.length), value]);
  }
  return values;
}

export async function clearProtectedClientState(identity?: EncryptionIdentity, storageKey?: string) {
  const prefix = identity ? `state:${encryptionIdentityKey(identity)}:` : "state:";
  if (identity && storageKey) {
    const key = `${prefix}${storageKey}`;
    await queueStateWrite(key, async () => { await transaction("keys", "readwrite", (store) => store.delete(key)); });
    return;
  }
  await Promise.allSettled([...stateWrites.values()]);
  const keys = await transaction<IDBValidKey[]>("keys", "readonly", (store) => store.getAllKeys());
  for (const key of keys) if (typeof key === "string" && key.startsWith(prefix)) {
    await queueStateWrite(key, async () => { await transaction("keys", "readwrite", (store) => store.delete(key)); });
  }
}

export async function saveClientEncryptionOperation(identity: EncryptionIdentity, value: unknown) {
  const epoch = storageEpoch;
  const key = `operation:${encryptionIdentityKey(identity)}`;
  const serialized = JSON.stringify(value);
  const pending = (operationWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (epoch !== storageEpoch) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
    const protectedValue = await protectLocalDraft(identity, key, serialized);
    await transaction("keys", "readwrite", (store) => {
      if (epoch !== storageEpoch) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
      return store.put(protectedValue, key);
    });
    if (JSON.stringify(await loadClientEncryptionOperation(identity)) !== serialized) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  });
  operationWrites.set(key, pending);
  try { await pending; }
  finally { if (operationWrites.get(key) === pending) operationWrites.delete(key); }
}

export async function loadClientEncryptionOperation(identity: EncryptionIdentity): Promise<unknown> {
  const key = `operation:${encryptionIdentityKey(identity)}`;
  const saved = await transaction<string | undefined>("keys", "readonly", (store) => store.get(key));
  return saved ? JSON.parse(await openLocalDraft(identity, key, saved)) : null;
}

export async function clearClientEncryptionOperation(identity?: EncryptionIdentity) {
  if (identity) await transaction("keys", "readwrite", (store) => store.delete(`operation:${encryptionIdentityKey(identity)}`));
  else {
    const keys = await transaction<IDBValidKey[]>("keys", "readonly", (store) => store.getAllKeys());
    for (const key of keys) if (typeof key === "string" && key.startsWith("operation:")) await transaction("keys", "readwrite", (store) => store.delete(key));
  }
}

export async function protectLocalDraft(identity: EncryptionIdentity, storageKey: string, plaintext: string) {
  const key = await deviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const input = new TextEncoder().encode(plaintext);
  try {
    const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${encryptionIdentityKey(identity)}:${storageKey}`) }, key, input));
    return JSON.stringify({ v: 1, encrypted: true, iv: Array.from(iv), ciphertext: Array.from(bytes) });
  } finally { input.fill(0); }
}

export async function openLocalDraft(identity: EncryptionIdentity, storageKey: string, serialized: string) {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object" || !("encrypted" in value) || value.encrypted !== true) return serialized;
  const data = value as unknown as { iv: number[]; ciphertext: number[] };
  if (!Array.isArray(data.iv) || data.iv.length !== 12 || !Array.isArray(data.ciphertext)) throw new Error("INVALID_LOCAL_DRAFT");
  const key = await deviceKey();
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(data.iv), additionalData: new TextEncoder().encode(`${encryptionIdentityKey(identity)}:${storageKey}`) }, key, new Uint8Array(data.ciphertext)));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(plaintext); }
  finally { plaintext.fill(0); }
}
