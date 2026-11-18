"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { parseHouseholdCode } from "@/lib/encryption/crypto";
import { clearUsableEncryption, encryptionClientGeneration, getClientEncryption, setClientEncryption } from "@/lib/encryption/client";
import { encryptionIdentityKey, recallHouseholdCode, rememberHouseholdCode, retainHouseholdIdentity, type EncryptionIdentity } from "@/lib/encryption/client-store";
import type { EncryptionStatus } from "@/lib/encryption/types";
import { getEncryptionMessages, type Locale } from "@/lib/i18n";

type Value = { identity: EncryptionIdentity; status: EncryptionStatus; code: string | null; ready: boolean; supply: (code: string, remember: boolean) => Promise<void>; activate: (status: EncryptionStatus, code: string | null) => void };
const Context = createContext<Value | null>(null);

export function EncryptionProvider({ identity, status, children, locale = "zh-CN" }: { identity: EncryptionIdentity; status: EncryptionStatus; children: ReactNode; locale?: Locale }) {
  const scope = encryptionIdentityKey(identity);
  const [local, setLocal] = useState<{ scope: string; code: string | null; ready: boolean; clearRequired?: boolean }>({ scope: status.mode === "UNENCRYPTED" ? scope : "", code: null, ready: status.mode === "UNENCRYPTED" });
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    // Plain households need no device key; establish their runtime before child effects.
    if (status.mode === "UNENCRYPTED") setClientEncryption(identity, status, null);
  }, [identity, status]);
  const activate = useCallback((nextStatus: EncryptionStatus, code: string | null) => {
    if (code) {
      const parsed = parseHouseholdCode(code);
      if (parsed.householdId !== identity.householdId || parsed.generation !== nextStatus.generation || parsed.keyVersion !== nextStatus.keyVersion) throw new Error("ENCRYPTION_INVALID");
    }
    setClientEncryption(identity, nextStatus, code);
    setLocal({ scope, code, ready: true });
  }, [identity, scope]);
  const supply = useCallback(async (text: string, remember: boolean) => {
    const generation = encryptionClientGeneration();
    try { await retainHouseholdIdentity(identity); }
    catch (error) { if (error instanceof Error && error.message === "LOCAL_KEY_CLEAR_REQUIRED") throw error; }
    const code = text.trim();
    const parsed = parseHouseholdCode(code);
    if (parsed.householdId !== identity.householdId || (status.generation && parsed.generation !== status.generation) || parsed.keyVersion !== status.keyVersion) throw new Error("ENCRYPTION_INVALID");
    if (remember) await rememberHouseholdCode(identity, code);
    if (generation !== encryptionClientGeneration()) throw new Error("LOCAL_KEY_STORAGE_UNAVAILABLE");
    setClientEncryption(identity, status, code);
    setLocal({ scope, code, ready: true });
  }, [identity, scope, status]);

  useEffect(() => {
    let active = true;
    const previous = getClientEncryption();
    if (!previous || encryptionIdentityKey(previous.identity) !== scope || previous.status.revision !== status.revision || previous.status.mode !== status.mode) clearUsableEncryption();
    const generation = encryptionClientGeneration();
    void (async () => {
      try { await retainHouseholdIdentity(identity); }
      catch (error) {
        if (error instanceof Error && error.message === "LOCAL_KEY_CLEAR_REQUIRED") {
          if (active && generation === encryptionClientGeneration()) setLocal({ scope, code: null, ready: false, clearRequired: true });
          return;
        }
      }
      try {
        const previousIdentity = window.sessionStorage.getItem("billboard:encryption-identity:v1");
        if (previousIdentity && previousIdentity !== scope) {
          for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
            const key = window.sessionStorage.key(index);
            if (key && /^(billboard:transaction-draft:|billboard:natural-language-|billboard:voice-)/.test(key)) window.sessionStorage.removeItem(key);
          }
        }
        window.sessionStorage.setItem("billboard:encryption-identity:v1", scope);
      } catch { /* The server-derived identity still scopes all protected device keys. */ }
      let code: string | null = null;
      if (status.mode !== "UNENCRYPTED") {
        try {
          const saved = previous && encryptionIdentityKey(previous.identity) === scope && previous.status.revision === status.revision
            ? previous.code : await recallHouseholdCode(identity);
          if (saved) {
            const parsed = parseHouseholdCode(saved);
            if (parsed.householdId === identity.householdId && parsed.generation === status.generation && parsed.keyVersion === status.keyVersion) code = saved;
          }
        } catch { /* A device without protected storage can still use an imported code in memory. */ }
      }
      if (!active || generation !== encryptionClientGeneration()) return;
      setClientEncryption(identity, status, code);
      setLocal((value) => value.scope === scope && value.code === code && value.ready && !value.clearRequired ? value : { scope, code, ready: true });
    })();
    const lock = () => { if (active) setLocal({ scope, code: null, ready: true }); };
    window.addEventListener("billboard:encryption-lock", lock);
    return () => { active = false; window.removeEventListener("billboard:encryption-lock", lock); };
  }, [identity, scope, status, attempt]);

  const value = local.scope === scope ? local : { code: null, ready: false };
  const labels = getEncryptionMessages(locale);
  return <Context.Provider value={{ identity, status, code: value.code, ready: value.ready, supply, activate }}>{local.scope === scope && local.clearRequired ? <div className="mx-auto max-w-lg space-y-4 px-4 py-6"><p className="text-sm leading-6 text-[var(--bb-danger)]" role="alert">{labels.forgetFailed}</p><button className="min-h-11 rounded-xl border border-[var(--bb-line-strong)] px-4 text-sm" onClick={() => setAttempt((value) => value + 1)} type="button">{labels.retry}</button><a className="ml-4 inline-flex min-h-11 items-center text-sm" href="/account">{labels.account}</a></div> : children}</Context.Provider>;
}

export function useEncryption() {
  const value = useContext(Context);
  if (!value) throw new Error("Encryption provider is required");
  return value;
}

export function useOptionalEncryption() { return useContext(Context); }
