import { LedgerManagement } from "@/components/ledger-management";
import { getMessages } from "@/lib/i18n";
import type { loadLedgersPage } from "./loader";


export function LedgersView({ data }: { data: Awaited<ReturnType<typeof loadLedgersPage>> }) {
  const { locale, catalog } = data;
  const messages = getMessages(locale);
  const labels = messages.ledgers;
  return <div className="space-y-6">
    <header className="space-y-2">
      <h1 className="bb-section-title">{labels.title}</h1>
      <p className="text-sm leading-relaxed text-[var(--bb-muted)]">{labels.description}</p>
    </header>
    <LedgerManagement ledgers={catalog.ledgers} locale={locale} role={catalog.role} />
  </div>;
}
