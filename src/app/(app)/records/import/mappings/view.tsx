import { ImportCategoryMappingManager } from "@/components/import-category-mapping-manager";
import { getMessages } from "@/lib/i18n";
import styles from "@/components/finance-b2.module.css";
import Link from "next/link";
import type { loadMappingsPage } from "./loader";



export function MappingsView({ data }: { data: Awaited<ReturnType<typeof loadMappingsPage>> }) {
  const { locale, mappings, categories } = data;
  const messages = getMessages(locale);

  return (
    <section className={`${styles.workflow} space-y-5`}>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="bb-section-title break-words">{messages.import.manageMappings}</h1>
          <p className="text-sm leading-relaxed text-[var(--bb-muted)]">{messages.import.managedMappingsDescription}</p>
        </div>
        <Link
          className="inline-flex min-h-11 items-center self-start rounded-xl border border-[var(--bb-warm-line)] bg-white px-3 py-2 text-sm font-medium text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)] sm:self-auto"
          href="/records/import"
        >
          {messages.import.backToImport}
        </Link>
      </header>
      {mappings.length === 0 ? (
        <p className="ios-panel p-5 text-sm text-stone-500">{messages.import.managedMappingsEmpty}</p>
      ) : (
        <ImportCategoryMappingManager
          categories={categories}
          key={locale}
          locale={locale}
          mappings={mappings}
        />
      )}
    </section>
  );
}
