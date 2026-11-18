"use client";

import { createContext, useContext, useEffect, useMemo, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { confirmImportMappingNavigation } from "@/components/import-review-history-guard";
import { LEDGER_PREFERENCE_COOKIE, parseLedgerPreference, resolveLedgerSelection, serializeLedgerPreference,
  type LedgerIdentity, type LedgerScope, type LedgerSummary } from "@/lib/ledgers/selection";
import type { EntryContext } from "@/lib/transactions/entry-context";

export type LedgerCatalog = {
  identity: LedgerIdentity;
  role: "OWNER" | "MEMBER";
  ledgers: LedgerSummary[];
  legacyDefaultLedgerId?: string;
};

type LedgerSelection = LedgerCatalog & {
  scope: LedgerScope;
  context: EntryContext;
  ledgerName: string;
  pending: boolean;
  selectScope: (scope: LedgerScope) => void;
  selectEntryLedger: (ledgerId: string) => void;
};
const LedgerContext = createContext<LedgerSelection | null>(null);

export function buildLedgerSelectionHref(pathname: string, query: string, scope: LedgerScope, entryLedgerId: string, clearScopeFilters: boolean) {
  const params = new URLSearchParams(query);
  params.set("ledger", scope.kind === "household" ? "all" : scope.ledgerId);
  // Management can archive the current target; keep its write target as a recoverable preference.
  if (pathname === "/ledgers") params.delete("entryLedger");
  else params.set("entryLedger", entryLedgerId);
  if (clearScopeFilters) for (const key of ["search", "amount", "record", "page", "filterError"]) params.delete(key);
  return `${pathname}?${params}`;
}

export function LedgerProvider({ catalog, initialPreference, children }: { catalog: LedgerCatalog; initialPreference?: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const query = params.toString();
  const preference = useMemo(() => parseLedgerPreference(initialPreference, catalog.identity), [initialPreference, catalog.identity]);
  const selection = useMemo(() => {
    const current = new URLSearchParams(query);
    if (current.getAll("ledger").length > 1 || current.getAll("entryLedger").length > 1) throw new Error("Ledger is unavailable");
    return resolveLedgerSelection({ ...catalog, preference, ledger: current.get("ledger"), entryLedgerId: current.get("entryLedger") });
  }, [catalog, preference, query]);
  const ledger = catalog.ledgers.find((item) => item.id === selection.entryLedgerId)!;
  const serialized = serializeLedgerPreference({ ...catalog.identity, ...selection });

  useEffect(() => {
    document.cookie = `${LEDGER_PREFERENCE_COOKIE}=${serialized}; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
  }, [serialized]);

  const value: LedgerSelection = {
    ...catalog,
    scope: selection.scope,
    context: { ...catalog.identity, ledgerId: ledger.id },
    ledgerName: ledger.name,
    pending,
    selectScope(scope) {
      if (!confirmImportMappingNavigation()) return;
      const next = resolveLedgerSelection({ ...catalog, preference: { ...catalog.identity, ...selection }, ledger: scope.kind === "household" ? "all" : scope.ledgerId });
      startTransition(() => router.replace(buildLedgerSelectionHref(pathname, query, next.scope, next.entryLedgerId, true), { scroll: false }));
    },
    selectEntryLedger(ledgerId) {
      if (!confirmImportMappingNavigation()) return;
      const next = resolveLedgerSelection({ ...catalog, preference: { ...catalog.identity, ...selection }, ledger: selection.scope.kind === "household" ? "all" : selection.scope.ledgerId, entryLedgerId: ledgerId });
      startTransition(() => router.replace(buildLedgerSelectionHref(pathname, query, next.scope, next.entryLedgerId, false), { scroll: false }));
    },
  };
  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}

export function useOptionalLedgerSelection() { return useContext(LedgerContext); }

export function useLedgerSelection() {
  const value = useOptionalLedgerSelection();
  if (!value) throw new Error("Ledger selection requires its application provider");
  return value;
}
