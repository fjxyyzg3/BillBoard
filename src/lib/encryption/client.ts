import type { EncryptionInput, EncryptionStatus } from "./types";
import { clearClientEncryptionOperation, clearProtectedClientState, encryptionIdentityKey, forgetHouseholdCodes, loadProtectedClientState, loadProtectedClientStates, openLocalDraft, protectLocalDraft, saveProtectedClientState, type EncryptionIdentity } from "./client-store";
import { entryContextStorageScope, type EntryContext } from "@/lib/transactions/entry-context";

let current: { identity: EncryptionIdentity; status: EncryptionStatus; code: string | null } | null = null;
let generation = 0;
const draftVersions = new Map<string, number>();
const pendingWrites = new Map<string, Promise<boolean>>();

function pendingKey(key: string) { return key.startsWith("billboard:natural-language-pending:") || key.startsWith("billboard:voice-pending:"); }

async function persistEntryValue(key: string, value: string): Promise<boolean> {
  const owner = current;
  if (!owner || owner.status.mode === "UNENCRYPTED") return true;
  const version = (draftVersions.get(key) ?? 0) + 1;
  draftVersions.set(key, version);
  const expectedGeneration = generation;
  const ownsWrite = () => generation === expectedGeneration && draftVersions.get(key) === version;
  try {
    const protectedValue = await protectLocalDraft(owner.identity, key, value);
    if (!ownsWrite()) return false;
    await saveProtectedClientState(owner.identity, key, protectedValue, ownsWrite);
    return ownsWrite();
  } catch { return false; }
}

export function entryBrowserStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  return {
    getItem: (key) => window.sessionStorage.getItem(key),
    setItem: (key, value) => {
      window.sessionStorage.setItem(key, value);
      if (pendingKey(key)) pendingWrites.set(key, persistEntryValue(key, value));
    },
    removeItem: clearClientDraft,
  };
}

export async function ensureDurableEntryRequest(kind: "text" | "voice", requestId: string, context?: EntryContext) {
  if (!current || current.status.mode === "UNENCRYPTED") return;
  const owner = current.identity;
  if (context && (context.householdId !== owner.householdId || context.memberId !== owner.memberId)) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  const key = `billboard:${kind === "text" ? "natural-language" : "voice"}-pending:${context ? `v2:${entryContextStorageScope(context)}` : `v1:${owner.memberId}`}`;
  const storage = entryBrowserStorage();
  if (kind === "text") storage.setItem(key, requestId);
  else {
    const previous: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    const ids = Array.isArray(previous) ? previous.filter((value): value is string => typeof value === "string") : [];
    storage.setItem(key, JSON.stringify([...new Set([...ids, requestId])]));
  }
  if (!await pendingWrites.get(key)) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
}

export async function restoreEntryBrowserState() {
  const owner = current;
  if (!owner) return;
  const expectedGeneration = generation;
  let saved: Array<[string, string]>;
  try { saved = await loadProtectedClientStates(owner.identity); }
  catch (error) { if (owner.status.mode === "UNENCRYPTED") return; throw error; }
  for (const [key, protectedValue] of saved) if (pendingKey(key)) {
    const value = await openLocalDraft(owner.identity, key, protectedValue);
    if (generation !== expectedGeneration) return;
    if (!window.sessionStorage.getItem(key)) window.sessionStorage.setItem(key, value);
  }
}

export function setClientEncryption(identity: EncryptionIdentity, status: EncryptionStatus, code: string | null) {
  if (!current || encryptionIdentityKey(current.identity) !== encryptionIdentityKey(identity) || current.status.revision !== status.revision || current.status.mode !== status.mode || current.code !== code) generation += 1;
  current = { identity, status, code };
}

export function getClientEncryption() { return current; }
export function encryptionClientGeneration() { return generation; }

export function getEncryptionInput(): EncryptionInput | undefined {
  if (!current || current.status.mode === "UNENCRYPTED" || current.status.mode === "ENABLING") return undefined;
  if (!current.code) throw new Error("HOUSEHOLD_LOCKED");
  return { code: current.code, revision: current.status.revision };
}

export function appendEncryption(formData: FormData) {
  const encryption = getEncryptionInput();
  if (encryption) formData.set("__householdEncryption", JSON.stringify(encryption));
  return formData;
}

export function invokeEncryptedAction<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>, ...args: Args): Promise<Result> {
  const encryption = getEncryptionInput();
  return action(...(encryption ? [...args, encryption] : args) as Args);
}

export async function writeClientDraft(key: string, value: string): Promise<boolean> {
  const owner = current;
  const version = (draftVersions.get(key) ?? 0) + 1;
  draftVersions.set(key, version);
  const expectedGeneration = generation;
  const ownsWrite = () => generation === expectedGeneration && draftVersions.get(key) === version;
  try {
    const serialized = owner && owner.status.mode !== "UNENCRYPTED" ? await protectLocalDraft(owner.identity, key, value) : value;
    if (!ownsWrite()) return false;
    if (owner && owner.status.mode !== "UNENCRYPTED") await saveProtectedClientState(owner.identity, key, serialized, ownsWrite);
    else if (owner) void clearProtectedClientState(owner.identity, key).catch(() => undefined);
    if (!ownsWrite()) return false;
    window.sessionStorage.setItem(key, serialized);
    return window.sessionStorage.getItem(key) === serialized;
  } catch { return false; }
}

export async function readClientDraft(key: string): Promise<string | null> {
  const owner = current;
  const expectedGeneration = generation;
  let saved = window.sessionStorage.getItem(key);
  if (!saved && owner) {
    try { saved = await loadProtectedClientState(owner.identity, key); }
    catch (error) { if (owner.status.mode !== "UNENCRYPTED") throw error; }
  }
  if (!saved) return null;
  if (!owner) return saved;
  let protectedValue = false;
  try { protectedValue = JSON.parse(saved)?.encrypted === true; } catch { /* Legacy plain drafts are validated by the form. */ }
  let value: string;
  try { value = await openLocalDraft(owner.identity, key, saved); }
  catch (error) { if (protectedValue) throw new Error("PROTECTED_DRAFT_UNAVAILABLE"); throw error; }
  if (generation !== expectedGeneration) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  if (owner.status.mode !== "UNENCRYPTED" && value === saved && !await writeClientDraft(key, value)) throw new Error("LOCAL_DRAFT_STORAGE_UNAVAILABLE");
  if (generation !== expectedGeneration) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  return value;
}

export function clearClientDraft(key: string) {
  draftVersions.set(key, (draftVersions.get(key) ?? 0) + 1);
  pendingWrites.delete(key);
  try { window.sessionStorage.removeItem(key); } catch { /* A completed UUID is still safe to query. */ }
  if (current) void clearProtectedClientState(current.identity, key).catch(() => undefined);
}

export function clearUsableEncryption() {
  if (current) current = { ...current, code: null };
  generation += 1;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("billboard:encryption-lock"));
}

export async function forgetClientEncryption() {
  const previous = current;
  current = null;
  generation += 1;
  if (typeof window !== "undefined") {
    try {
      for (const storage of [window.sessionStorage, window.localStorage]) {
        for (let index = storage.length - 1; index >= 0; index -= 1) {
          const key = storage.key(index);
          if (key?.startsWith("billboard:transaction-draft:") || key?.startsWith("billboard:natural-language-") || key?.startsWith("billboard:voice-")) storage.removeItem(key);
        }
      }
    } catch { /* Protected key removal must still run when Web Storage is unavailable. */ }
    window.dispatchEvent(new Event("billboard:encryption-lock"));
    let failed = false;
    if (previous) await forgetHouseholdCodes(previous.identity).catch(() => { failed = true; });
    await forgetHouseholdCodes().catch(() => { failed = true; });
    await clearClientEncryptionOperation().catch(() => { failed = true; });
    await clearProtectedClientState().catch(() => { failed = true; });
    if (failed) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
  }
}

export async function encryptedJsonFetch(path: string, input: Record<string, unknown>, signal?: AbortSignal) {
  if (!path.startsWith("/api/") && path !== "/records/search") throw new Error("INVALID_ENCRYPTED_ENDPOINT");
  const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, encryption: getEncryptionInput() }) });
  if (response.status === 401) clearUsableEncryption();
  return response;
}
