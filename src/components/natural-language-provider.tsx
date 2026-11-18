"use client";

import { encryptionClientGeneration, ensureDurableEntryRequest, entryBrowserStorage, getEncryptionInput, invokeEncryptedAction, restoreEntryBrowserState } from "@/lib/encryption/client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { queryNaturalLanguageEntry, submitNaturalLanguageEntry } from "@/app/(app)/add/natural-language-actions";
import { NaturalLanguageController } from "@/lib/transactions/natural-language-controller";
import { VoiceAccountingError, VoiceAccountingQueue } from "@/lib/voice/accounting-queue";
import { useOptionalLedgerSelection } from "@/components/ledger-provider";
import type { NaturalLanguageActionResult } from "@/lib/transactions/natural-language-types";
import { clearEntryBrowserState, entryIdentityStorageScope, retainCurrentEntryBrowserState, type EntryContext as AccountingContext } from "@/lib/transactions/entry-context";
import { getEncryptionMessages, type Locale } from "@/lib/i18n";
import { useOptionalEncryption } from "@/components/encryption-provider";

type EntryControllers = { entry: NaturalLanguageController; voice: VoiceAccountingQueue };
const EntryContext = createContext<EntryControllers | null>(null);

export function NaturalLanguageProvider({ currentMemberId, context: initialContext, children, locale = "zh-CN" }: { currentMemberId: string; context?: AccountingContext; children: ReactNode; locale?: Locale }) {
  const selection = useOptionalLedgerSelection();
  const encryption = useOptionalEncryption();
  const encryptionReady = encryption?.ready ?? true;
  const encryptionRevision = encryption?.status.revision;
  const context = selection?.context ?? initialContext;
  const ledgerName = selection?.ledgerName;
  const mounted = useRef(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [controllers] = useState(() => {
    const voiceAdmissions = new Map<string, string>();
    const checkSession = (response: Response) => {
      if (response.status === 401 && mounted.current) {
        mounted.current = false;
        created.entry.dispose();
        created.voice.dispose();
        try { clearEntryBrowserState(window.sessionStorage, { preservePendingFor: context }); } catch { /* Server authorization still rejects the old identity. */ }
        window.location.replace("/login?reason=session-expired");
      }
    };
    const voiceResult = async (response: Response): Promise<NaturalLanguageActionResult> => {
      checkSession(response);
      if (!response.ok) throw new VoiceAccountingError(response.status === 401 ? "unauthorized" : "unavailable");
      return response.json();
    };
    let tail = Promise.resolve();
    const waitUntil = async (settled: () => boolean) => {
      // Let the request owner consume its response before testing its final state.
      await Promise.resolve();
      if (settled() || !mounted.current) return;
      await new Promise<void>((resolve) => {
        const check = () => {
          if (settled() || !mounted.current) { unsubscribe(); resolve(); }
        };
        const stopEntry = created.entry.subscribe(check);
        const stopVoice = created.voice.subscribe(check);
        const unsubscribe = () => { stopEntry(); stopVoice(); };
        check();
      });
    };
    const schedule = <T,>(operation: () => Promise<T>, settled: () => boolean): Promise<T> => {
      const result = tail.then(async () => {
        await waitUntil(() => !created.voice.getSnapshot().tasks.some((task) => task.phase === "unknown" || task.phase === "processing"));
        if (!mounted.current) throw new VoiceAccountingError("cancelled");
        return operation();
      });
      // A lost response can leave the Agent running. Keep its slot until the UUID is confirmed.
      tail = result.then(() => waitUntil(settled), () => waitUntil(settled));
      return result;
    };
    const shared = {
      memberId: currentMemberId,
      context,
      ledgerName,
      legacyDefaultLedgerId: selection?.legacyDefaultLedgerId,
      targets: selection?.ledgers.map((ledger) => ({ context: { ...selection.identity, ledgerId: ledger.id }, ledgerName: ledger.name })),
      storage: entryBrowserStorage,
      uuid: () => window.crypto.randomUUID(),
    };
    const created: EntryControllers = {
      entry: new NaturalLanguageController({ ...shared,
        submit: (input) => schedule(async () => { await ensureDurableEntryRequest("text", input.requestId, input.context); return invokeEncryptedAction(submitNaturalLanguageEntry, input); },
          () => created.entry.getSnapshot().pending?.requestId !== input.requestId),
        query: async (id, version, target) => {
          await ensureDurableEntryRequest("text", id, target);
          const encryption = getEncryptionInput();
          return encryption ? queryNaturalLanguageEntry(id, version, target, encryption)
            : target ? queryNaturalLanguageEntry(id, version, target) : queryNaturalLanguageEntry(id, version);
        },
      }),
      voice: new VoiceAccountingQueue({ ...shared,
        transcribe: async (audio, locale, signal, target, requestId) => {
          if (!requestId) throw new VoiceAccountingError("context_required");
          await ensureDurableEntryRequest("voice", requestId, target);
          const encryption = getEncryptionInput();
          let body: Blob | FormData = audio;
          let headers: Record<string, string> = { "Content-Type": "audio/wav", "X-Voice-Locale": locale, "X-Voice-Request-Id": requestId, ...(target ? { "X-Entry-Context": JSON.stringify(target) } : {}) };
          if (encryption) {
            const form = new FormData();
            form.set("audio", audio, "voice.wav");
            form.set("locale", locale);
            form.set("requestId", requestId);
            if (target) form.set("context", JSON.stringify(target));
            form.set("__householdEncryption", JSON.stringify(encryption));
            body = form;
            headers = {};
          }
          const response = await fetch("/api/voice/transcribe", { method: "POST", body, signal, headers });
          checkSession(response);
          const result: unknown = await response.json();
          if (!response.ok || !result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string"
            || !("voiceAdmissionId" in result) || typeof result.voiceAdmissionId !== "string") {
            throw new VoiceAccountingError(result && typeof result === "object" && "error" in result && typeof result.error === "string"
              ? result.error : "unavailable");
          }
          if (!mounted.current) throw new VoiceAccountingError("cancelled");
          voiceAdmissions.set(requestId, result.voiceAdmissionId);
          return result.text;
        },
        submit: (input) => schedule(async () => {
          await ensureDurableEntryRequest("voice", input.requestId, input.context);
          const result = await voiceResult(await fetch("/api/voice/entry", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...input, ...(voiceAdmissions.has(input.requestId) ? { voiceAdmissionId: voiceAdmissions.get(input.requestId) } : {}), encryption: getEncryptionInput() }),
          }));
          if (result.status === "success" || result.status === "error") voiceAdmissions.delete(input.requestId);
          return result;
        }, () => !created.voice.getSnapshot().tasks.some((task) => task.id === input.requestId && task.phase !== "success" && task.phase !== "failed")),
        query: async (requestId, version, target) => {
          await ensureDurableEntryRequest("voice", requestId, target);
          const encryption = getEncryptionInput();
          const result = await voiceResult(await (encryption ? fetch("/api/voice/entry", {
            method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operation: "query", requestId, resultVersion: version, context: target, encryption }),
          }) : fetch(`/api/voice/entry?${new URLSearchParams({ requestId, resultVersion: String(version) })}`,
            { cache: "no-store", headers: { "X-Requested-With": "XMLHttpRequest", ...(target ? { "X-Entry-Context": JSON.stringify(target) } : {}) } })));
          if (result.status === "success" || result.status === "error") voiceAdmissions.delete(requestId);
          return result;
        },
      }),
    };
    return created;
  });

  useEffect(() => {
    mounted.current = true;
    if (context) {
      try {
        const scope = entryIdentityStorageScope(context);
        const previous = window.sessionStorage.getItem("billboard:active-entry-identity:v1")
          ?? window.sessionStorage.getItem("billboard:active-entry-context:v1")?.split(":").slice(0, 2).join(":");
        if (previous && previous !== scope) clearEntryBrowserState(window.sessionStorage);
        retainCurrentEntryBrowserState(window.sessionStorage, context);
        window.sessionStorage.setItem("billboard:active-entry-identity:v1", scope);
        window.sessionStorage.removeItem("billboard:active-entry-context:v1");
      } catch { /* Scoped keys and server authorization remain authoritative. */ }
    }
    return () => {
      mounted.current = false;
      // Strict Mode immediately mounts again; only dispose an actual app-session exit.
      queueMicrotask(() => {
        if (!mounted.current) {
          controllers.entry.dispose();
          controllers.voice.dispose();
          try { clearEntryBrowserState(window.sessionStorage, { preservePendingFor: context }); } catch { /* State is also discarded in memory. */ }
        }
      });
    };
    // Controllers belong to the immutable identity. A ledger switch only changes future work below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controllers]);

  useEffect(() => {
    if (!encryptionReady) return;
    let active = true;
    const generation = encryptionClientGeneration();
    void restoreEntryBrowserState().then(() => {
      if (!active || !mounted.current || generation !== encryptionClientGeneration()) return;
      void controllers.entry.initialize();
      void controllers.voice.initialize();
    }).catch(() => {
      // Encrypted tasks cannot start until their original UUIDs can be recovered reliably.
      if (active && mounted.current) setStorageUnavailable(true);
    });
    return () => { active = false; };
  }, [controllers, encryptionReady, encryptionRevision]);

  useEffect(() => {
    if (!context) return;
    controllers.entry.setTarget(context, ledgerName ?? context.ledgerId);
    controllers.voice.setTarget(context, ledgerName ?? context.ledgerId);
  }, [controllers, context, ledgerName]);
  return <EntryContext.Provider value={controllers}>{storageUnavailable ? <p className="mx-4 my-3 text-sm leading-6 text-[var(--bb-danger)]" role="alert">{getEncryptionMessages(locale).pendingStorageUnavailable}</p> : null}{children}</EntryContext.Provider>;
}

export function useNaturalLanguageEntry() {
  const controller = useContext(EntryContext)?.entry;
  if (!controller) throw new Error("Natural language entry requires its application provider");
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  return { controller, ...state };
}

export function useVoiceAccountingQueue() {
  const queue = useContext(EntryContext)?.voice;
  if (!queue) throw new Error("Voice accounting requires its application provider");
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getServerSnapshot);
  return { queue, ...state };
}
