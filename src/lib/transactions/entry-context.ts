import { z } from "zod";

export const entryContextSchema = z.object({
  householdId: z.string().min(1),
  memberId: z.string().min(1),
  ledgerId: z.string().min(1),
}).strict();

export type EntryContext = z.infer<typeof entryContextSchema>;
export type EntryTarget = { context: EntryContext; ledgerName: string };

export function matchesEntryContext(original: EntryContext, current: EntryContext) {
  return original.householdId === current.householdId
    && original.memberId === current.memberId && original.ledgerId === current.ledgerId;
}

export function entryContextStorageScope(context: EntryContext) {
  return [context.householdId, context.memberId, context.ledgerId].map(encodeURIComponent).join(":");
}

export function matchesEntryIdentity(original: Pick<EntryContext, "householdId" | "memberId">, current: Pick<EntryContext, "householdId" | "memberId">) {
  return original.householdId === current.householdId && original.memberId === current.memberId;
}

export function entryIdentityStorageScope(context: Pick<EntryContext, "householdId" | "memberId">) {
  return [context.householdId, context.memberId].map(encodeURIComponent).join(":");
}

const statePrefixes = ["billboard:transaction-draft:", "billboard:natural-language-pending:", "billboard:voice-pending:"];
const protectedDraftSchema = z.object({
  v: z.literal(1),
  encrypted: z.literal(true),
  iv: z.array(z.number().int().min(0).max(255)).length(12),
  ciphertext: z.array(z.number().int().min(0).max(255)).min(16).max(2_000_000),
}).strict();

function ownedContext(key: string, identity: EntryContext): EntryContext | null {
  for (const prefix of statePrefixes) {
    if (key === `${prefix}v1:${identity.memberId}`) return identity;
    const start = `${prefix}v2:${entryIdentityStorageScope(identity)}:`;
    if (!key.startsWith(start)) continue;
    try {
      const ledgerId = decodeURIComponent(key.slice(start.length));
      if (ledgerId) return { ...identity, ledgerId };
    } catch { return null; }
  }
  return null;
}

export function parseEntryContextFormValue(value: FormDataEntryValue | null) {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Unauthorized");
  try { return entryContextSchema.parse(JSON.parse(value)); }
  catch { throw new Error("Unauthorized"); }
}

function pendingStateFor(key: string, raw: string | null, context: EntryContext): string | null {
  if (raw === null) return null;
  if (key.startsWith("billboard:natural-language-pending:")) return z.string().uuid().safeParse(raw).success ? raw : null;
  try {
    const value: unknown = JSON.parse(raw);
    if (key.startsWith("billboard:voice-pending:")) {
      if (!Array.isArray(value)) return null;
      const ids = [...new Set(value.filter((id): id is string => z.string().uuid().safeParse(id).success))];
      return ids.length ? JSON.stringify(ids) : null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    // Authentication expiry may keep ciphertext for this identity; decryption still checks its scope and GCM tag.
    if (protectedDraftSchema.safeParse(value).success) return raw;
    const draft = value as Record<string, unknown>;
    if (draft.status !== "awaiting-confirmation" || draft.memberId !== context.memberId || !z.string().uuid().safeParse(draft.clientRequestId).success
      || typeof draft.payload !== "object" || draft.payload === null || typeof draft.savedAt !== "string") return null;
    if (draft.version === 1) return raw;
    const storedContext = entryContextSchema.safeParse(draft.context);
    return draft.version === 2 && storedContext.success && matchesEntryContext(storedContext.data, context) ? raw : null;
  } catch { return null; }
}

export function clearEntryBrowserState(storage: Storage, options: { preservePendingFor?: EntryContext } = {}) {
  const context = options.preservePendingFor;
  const scope = context ? entryIdentityStorageScope(context) : null;
  const activeScope = storage.getItem("billboard:active-entry-identity:v1")
    ?? storage.getItem("billboard:active-entry-context:v1")?.split(":").slice(0, 2).join(":");
  const hasNewIdentity = Boolean(scope && activeScope && activeScope !== scope);
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (!key || !statePrefixes.some((prefix) => key.startsWith(prefix))) continue;
    const owner = context ? ownedContext(key, context) : null;
    // An old provider's delayed cleanup must not touch the newly authenticated identity.
    if (hasNewIdentity && !owner) continue;
    const raw = storage.getItem(key);
    const retained = owner && !hasNewIdentity ? pendingStateFor(key, raw, owner) : null;
    if (retained === null) storage.removeItem(key);
    else if (retained !== raw) storage.setItem(key, retained);
  }
}

export function retainCurrentEntryBrowserState(storage: Storage, context: EntryContext) {
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key && statePrefixes.some((prefix) => key.startsWith(prefix)) && !ownedContext(key, context)) storage.removeItem(key);
  }
}
