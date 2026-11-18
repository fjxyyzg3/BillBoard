import { describe, expect, it, vi } from "vitest";
import { clearEntryBrowserState, entryContextStorageScope, retainCurrentEntryBrowserState } from "@/lib/transactions/entry-context";
import { VoiceAccountingQueue } from "@/lib/voice/accounting-queue";

const context = { householdId: "household", memberId: "member", ledgerId: "default-ledger:household" };
const requestId = "00000000-0000-4000-8000-000000000001";
const textRequestId = "00000000-0000-4000-8000-000000000002";
const voiceKey = `billboard:voice-pending:v2:${entryContextStorageScope(context)}`;
const textKey = `billboard:natural-language-pending:v2:${entryContextStorageScope(context)}`;

function memoryStorage() {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() { return data.size; },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
  return { data, storage };
}

describe("entry state when authentication ends", () => {
  it("retains all ledger drafts and pending UUIDs while the household member stays the same", () => {
    const { storage } = memoryStorage();
    const next = { ...context, ledgerId: "travel-ledger" };
    storage.setItem("billboard:active-entry-context:v1", entryContextStorageScope(context));
    storage.setItem(textKey, textRequestId);
    storage.setItem(voiceKey, JSON.stringify([requestId]));
    const draftKey = `billboard:transaction-draft:v2:${entryContextStorageScope(context)}`;
    storage.setItem(draftKey, JSON.stringify({ status: "draft", note: "Breakfast draft" }));
    retainCurrentEntryBrowserState(storage, next);
    expect(storage.getItem(textKey)).toBe(textRequestId);
    expect(storage.getItem(voiceKey)).toBe(JSON.stringify([requestId]));
    expect(storage.getItem(draftKey)).toContain("Breakfast draft");
  });

  it("retains original confirmation UUIDs and the exact pending manual snapshot while clearing editable drafts", () => {
    const { data, storage } = memoryStorage();
    storage.setItem("billboard:active-entry-context:v1", entryContextStorageScope(context));
    storage.setItem(voiceKey, JSON.stringify([requestId, "private transcript", requestId]));
    storage.setItem(textKey, textRequestId);
    const pendingKey = `billboard:transaction-draft:v2:${entryContextStorageScope(context)}`;
    const pendingSnapshot = JSON.stringify({ version: 2, memberId: context.memberId, context, status: "awaiting-confirmation", clientRequestId: textRequestId,
      payload: { type: "expense", amount: "18.60", categoryId: "category", actorMemberId: "former-member", occurredAt: "2026-10-21T12:00", note: "Exact pending note" }, savedAt: "2026-10-21T04:00:00.000Z" });
    storage.setItem(pendingKey, pendingSnapshot);
    storage.setItem(`billboard:transaction-draft:v1:${context.memberId}`, JSON.stringify({ status: "draft", note: "Private editable draft" }));
    storage.setItem("billboard:voice-pending:v2:other:member:ledger", JSON.stringify([textRequestId]));
    storage.setItem("unrelated-preference", "retained");
    clearEntryBrowserState(storage, { preservePendingFor: context });
    expect(storage.getItem(voiceKey)).toBe(JSON.stringify([requestId]));
    expect(storage.getItem(textKey)).toBe(textRequestId);
    expect(storage.getItem("unrelated-preference")).toBe("retained");
    expect(storage.getItem(pendingKey)).toBe(pendingSnapshot);
    expect(storage.getItem(`billboard:transaction-draft:v1:${context.memberId}`)).toBeNull();
    expect(JSON.stringify([...data])).not.toContain("Private editable draft");
    expect(JSON.stringify([...data])).not.toContain("private transcript");
  });

  it("lets the same original identity recover only its UUID through a query after signing in again", async () => {
    const { storage } = memoryStorage();
    storage.setItem(voiceKey, JSON.stringify([requestId]));
    clearEntryBrowserState(storage, { preservePendingFor: context });
    retainCurrentEntryBrowserState(storage, context);
    const query = vi.fn(async () => ({ status: "error" as const, requestId, code: "NOT_ACCEPTED" as const }));
    const submit = vi.fn();
    const transcribe = vi.fn();
    const queue = new VoiceAccountingQueue({ context, memberId: context.memberId, storage: () => storage, uuid: () => textRequestId, query, submit, transcribe });
    await queue.initialize();
    expect(query).toHaveBeenCalledWith(requestId, 2, context);
    expect(submit).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(storage.getItem(voiceKey)).toBeNull();
    queue.dispose();
  });

  it("keeps an opaque protected draft for the original identity until explicit logout or identity change", () => {
    const { storage } = memoryStorage();
    const key = `billboard:transaction-draft:v2:${entryContextStorageScope(context)}`;
    const protectedDraft = JSON.stringify({ v: 1, encrypted: true, iv: Array(12).fill(1), ciphertext: Array(32).fill(2) });
    storage.setItem(key, protectedDraft);
    clearEntryBrowserState(storage, { preservePendingFor: context });
    expect(storage.getItem(key)).toBe(protectedDraft);
    clearEntryBrowserState(storage);
    expect(storage.getItem(key)).toBeNull();
    storage.setItem(key, protectedDraft);
    retainCurrentEntryBrowserState(storage, { ...context, memberId: "new-identity" });
    expect(storage.getItem(key)).toBeNull();
  });

  it("does not retain malformed objects that claim to be encrypted drafts", () => {
    const { storage } = memoryStorage();
    const key = `billboard:transaction-draft:v2:${entryContextStorageScope(context)}`;
    for (const value of [
      { v: 1, encrypted: true, iv: Array(12).fill(1), ciphertext: ["private note"] },
      { v: 1, encrypted: true, iv: Array(11).fill(1), ciphertext: Array(32).fill(2) },
      { v: 1, encrypted: true, iv: Array(12).fill(1), ciphertext: Array(32).fill(2), note: "private note" },
    ]) {
      storage.setItem(key, JSON.stringify(value));
      clearEntryBrowserState(storage, { preservePendingFor: context });
      expect(storage.getItem(key)).toBeNull();
    }
  });

  it("discards the old UUIDs for a new identity and prevents late old cleanup from deleting the new identity's state", () => {
    const { storage } = memoryStorage();
    const next = { ...context, memberId: "rejoined-member" };
    const nextScope = entryContextStorageScope(next);
    const newKey = `billboard:voice-pending:v2:${nextScope}`;
    storage.setItem(voiceKey, JSON.stringify([requestId]));
    retainCurrentEntryBrowserState(storage, next);
    expect(storage.getItem(voiceKey)).toBeNull();
    storage.setItem("billboard:active-entry-context:v1", nextScope);
    storage.setItem(newKey, JSON.stringify([textRequestId]));
    clearEntryBrowserState(storage, { preservePendingFor: context });
    expect(storage.getItem(newKey)).toBe(JSON.stringify([textRequestId]));
    expect(storage.getItem(voiceKey)).toBeNull();
    clearEntryBrowserState(storage);
    expect(storage.getItem(newKey)).toBeNull();
  });
});
