import { z } from "zod";

export type LedgerSummary = {
  id: string;
  name: string;
  isDefault: boolean;
  archivedAt: string | null;
};

export type LedgerScope = { kind: "household" } | { kind: "ledger"; ledgerId: string };
export type LedgerIdentity = { householdId: string; memberId: string };
export type LedgerPreference = LedgerIdentity & { scope: LedgerScope; entryLedgerId: string };

export const LEDGER_PREFERENCE_COOKIE = "billboard-ledger-preference-v1";

const idSchema = z.string().min(1).max(512);
const preferenceSchema = z.object({
  householdId: idSchema,
  memberId: idSchema,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("household") }).strict(),
    z.object({ kind: z.literal("ledger"), ledgerId: idSchema }).strict(),
  ]),
  entryLedgerId: idSchema,
}).strict();

function matchesIdentity(preference: LedgerIdentity, identity: LedgerIdentity) {
  return preference.householdId === identity.householdId && preference.memberId === identity.memberId;
}

export function parseLedgerPreference(raw: string | null | undefined, identity: LedgerIdentity): LedgerPreference | undefined {
  if (!raw || raw.length > 4096) return undefined;
  try {
    const parsed = preferenceSchema.safeParse(JSON.parse(decodeURIComponent(raw)));
    return parsed.success && matchesIdentity(parsed.data, identity) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function serializeLedgerPreference(preference: LedgerPreference) {
  return encodeURIComponent(JSON.stringify(preferenceSchema.parse(preference)));
}

export function resolveLedgerSelection(input: {
  ledgers: readonly LedgerSummary[];
  identity: LedgerIdentity;
  preference?: LedgerPreference;
  ledger?: string | null;
  entryLedgerId?: string | null;
}): { scope: LedgerScope; entryLedgerId: string } {
  const defaultLedger = input.ledgers.find((ledger) => ledger.isDefault && ledger.archivedAt === null);
  if (!defaultLedger) throw new Error("Ledger is unavailable");
  const preference = input.preference && matchesIdentity(input.preference, input.identity) ? input.preference : undefined;
  const preferredScope = preference?.scope;

  let scope: LedgerScope = { kind: "household" };
  if (input.ledger !== undefined && input.ledger !== null) {
    if (input.ledger !== "all") {
      if (!input.ledgers.some((ledger) => ledger.id === input.ledger)) throw new Error("Ledger is unavailable");
      scope = { kind: "ledger", ledgerId: input.ledger };
    }
  } else if (preferredScope?.kind === "ledger" && input.ledgers.some((ledger) => ledger.id === preferredScope.ledgerId)) {
    scope = preferredScope;
  }

  const activeLedger = (id: string | undefined) => input.ledgers.find((ledger) => ledger.id === id && ledger.archivedAt === null);
  if (input.entryLedgerId !== undefined && input.entryLedgerId !== null) {
    const explicitTarget = activeLedger(input.entryLedgerId);
    if (!explicitTarget) throw new Error("Ledger is unavailable");
    return { scope, entryLedgerId: explicitTarget.id };
  }
  const viewedLedgerId = scope.kind === "ledger" ? scope.ledgerId : undefined;
  const entryLedger = activeLedger(viewedLedgerId) ?? activeLedger(preference?.entryLedgerId) ?? defaultLedger;
  return { scope, entryLedgerId: entryLedger.id };
}
