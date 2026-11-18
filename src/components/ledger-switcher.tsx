"use client";

import Link from "next/link";
import { BookOpen } from "lucide-react";
import { useId } from "react";
import { buildLedgerSelectionHref, useLedgerSelection } from "@/components/ledger-provider";
import { IosSelect } from "@/components/ios-select";
import { getLedgerDisplayName, getMessages, type Locale } from "@/lib/i18n";

export function LedgerSwitcher({ locale }: { locale: Locale }) {
  const selection = useLedgerSelection();
  const labels = getMessages(locale).ledgers;
  const id = useId();
  return <div className="flex min-w-0 items-center gap-3" aria-busy={selection.pending || undefined}>
      <IosSelect aria-label={labels.scope} disabled={selection.pending} id={id}
        leadingIcon={<BookOpen className="h-4 w-4" strokeWidth={1.6} />}
        onChange={(event) => selection.selectScope(event.target.value === "all" ? { kind: "household" } : { kind: "ledger", ledgerId: event.target.value })}
        options={[{ value: "all", label: labels.household }, ...selection.ledgers.map((ledger) => ({
          value: ledger.id, label: `${getLedgerDisplayName(ledger.name, locale)}${ledger.archivedAt ? ` · ${labels.archived}` : ""}`,
        }))]}
        value={selection.scope.kind === "household" ? "all" : selection.scope.ledgerId}
        variant="scope" />
    <Link className="hidden min-h-11 shrink-0 items-center rounded-xl px-2 text-xs text-[var(--bb-muted)] hover:text-[var(--bb-accent)] md:flex" href={buildLedgerSelectionHref("/ledgers", "", selection.scope, selection.context.ledgerId, false)}>{labels.manage}</Link>
  </div>;
}

export function LedgerEntrySelector({ locale }: { locale: Locale }) {
  const selection = useLedgerSelection();
  const labels = getMessages(locale).ledgers;
  const id = useId();
  return <label className="flex min-w-0 items-center gap-3 rounded-xl bg-[var(--bb-warm-surface)] px-3" htmlFor={id}>
    <span className="shrink-0 text-xs text-[var(--bb-muted)]">{labels.target}</span>
    <IosSelect aria-label={labels.target} disabled={selection.pending} id={id} value={selection.context.ledgerId}
      onChange={(event) => selection.selectEntryLedger(event.target.value)}
      options={selection.ledgers.filter((ledger) => !ledger.archivedAt).map((ledger) => ({ value: ledger.id, label: getLedgerDisplayName(ledger.name, locale) }))}
      variant="inline" />
  </label>;
}
