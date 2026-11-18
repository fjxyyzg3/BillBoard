import type { Prisma, PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";
import { resolveHouseholdContext, type HouseholdSession } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import {
  LEDGER_PREFERENCE_COOKIE,
  parseLedgerPreference,
  resolveLedgerSelection,
  type LedgerSummary,
} from "./selection";

type Client = PrismaClient | Prisma.TransactionClient;

export async function authorizeLedgerReadScope(client: Client, session: HouseholdSession, ledgerId?: string) {
  const context = await resolveHouseholdContext(client, session);
  if (ledgerId === undefined) return context;
  const ledger = await client.ledger.findFirst({
    where: { id: ledgerId, householdId: context.householdId },
    select: { id: true, name: true },
  });
  if (!ledger) throw new Error("Ledger is unavailable");
  return { ...context, ledgerId: ledger.id, ledgerName: ledger.name };
}

export async function loadLedgerCatalog(session: HouseholdSession, client: Client = db) {
  const context = await authorizeLedgerReadScope(client, session);
  const rows = await client.ledger.findMany({
    where: { householdId: context.householdId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, isDefault: true, archivedAt: true, acceptsLegacyDrafts: true },
  });
  const ledgers: LedgerSummary[] = rows.map((ledger) => ({
    id: ledger.id, name: ledger.name, isDefault: ledger.isDefault, archivedAt: ledger.archivedAt?.toISOString() ?? null,
  }));
  const legacyDefaultLedgerId = rows.find((ledger) => ledger.acceptsLegacyDrafts)?.id;
  return {
    identity: { householdId: context.householdId, memberId: context.memberId },
    role: context.role,
    ledgers,
    legacyDefaultLedgerId,
  };
}

function singleParameter(value: string | string[] | undefined) {
  if (Array.isArray(value)) throw new Error("Ledger is unavailable");
  return value;
}

export async function resolveLedgerPageContext(
  session: HouseholdSession,
  params: Record<string, string | string[] | undefined> = {},
) {
  const catalog = await loadLedgerCatalog(session);
  const cookieStore = await cookies();
  const preference = parseLedgerPreference(cookieStore.get(LEDGER_PREFERENCE_COOKIE)?.value, catalog.identity);
  const selected = resolveLedgerSelection({
    ...catalog,
    preference,
    ledger: singleParameter(params.ledger),
    entryLedgerId: singleParameter(params.entryLedger),
  });
  const ledger = catalog.ledgers.find((item) => item.id === selected.entryLedgerId);
  if (!ledger) throw new Error("Ledger is unavailable");
  return {
    ...catalog,
    ...selected,
    context: { ...catalog.identity, ledgerId: ledger.id },
    ledgerName: ledger.name,
  };
}
