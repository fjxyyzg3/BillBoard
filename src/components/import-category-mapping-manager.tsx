"use client";

import { IosSelect } from "@/components/ios-select";

import { invokeEncryptedAction } from "@/lib/encryption/client";

import { useRouter } from "next/navigation";
import { useImportMappingNavigationGuard } from "@/components/use-import-mapping-navigation-guard";
import styles from "./finance-b2.module.css";
import { useEffect, useRef, useState, useTransition } from "react";
import type { FormEvent } from "react";

import { saveManagedImportMappings } from "@/app/(app)/records/import/mappings/actions";
import { getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type { ManagedImportCategoryMapping } from "@/lib/imports/category-mapping-management";
import { filterManagedImportMappings, getManagedImportMappingChanges, type ManagedImportMappingFilters } from "@/lib/imports/managed-mapping-form";
import { IGNORE_IMPORT_MAPPING_VALUE } from "@/lib/imports/mapping-form";
import { ALIPAY_SOURCE, CMB_SOURCE, SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";

type Props = {
  locale: Locale;
  mappings: ManagedImportCategoryMapping[];
  categories: Array<{ id: string; name: string; type: "EXPENSE" | "INCOME" }>;
};

type Feedback = "saved" | "failed" | "conflict" | "unknown" | null;

export function ImportCategoryMappingManager({ locale, mappings, categories }: Props) {
  const router = useRouter();
  const messages = getMessages(locale);
  const labels = messages.import;
  const [sourceMappings, setSourceMappings] = useState(mappings);
  const [baseline, setBaseline] = useState(mappings);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<ManagedImportMappingFilters>({ source: "", transactionType: "", keyword: "" });
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const busyRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = formRef.current;
    const actions = actionsRef.current;
    if (!form || !actions) return;
    const reserveActionsSpace = () => {
      form.style.setProperty("--managed-mapping-actions-height", `${actions.getBoundingClientRect().height}px`);
    };
    reserveActionsSpace();
    const observer = new ResizeObserver(reserveActionsSpace);
    observer.observe(actions);
    return () => observer.disconnect();
  }, []);
  if (sourceMappings !== mappings) {
    setSourceMappings(mappings);
    setBaseline(mappings);
    setChoices({});
  }
  const busy = saving || refreshing;
  const needsRefresh = feedback === "conflict" || feedback === "unknown";
  const visibleMappings = filterManagedImportMappings(baseline, filters, locale);
  const visibleMappingIds = new Set(visibleMappings.map(({ id }) => id));
  const changes = getManagedImportMappingChanges(baseline, choices);
  useImportMappingNavigationGuard({ dirty: changes.length > 0, pending: busy, formRef, locale, onDiscard: () => setChoices({}) });
  const hiddenChangesCount = changes.filter(({ id }) => !visibleMappingIds.has(id)).length;
  const hasFilters = Boolean(filters.source || filters.transactionType || filters.keyword);
  const sources = [
    [SUI_SHOU_JI_SOURCE, labels.sources.suiShouJi],
    [WECHAT_PAY_SOURCE, labels.sources.wechatPay],
    [ALIPAY_SOURCE, labels.sources.alipay],
    [CMB_SOURCE, labels.sources.cmb],
  ] as const;

  async function saveMappings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || busy || needsRefresh) return;
    if (changes.length === 0) return;

    busyRef.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await invokeEncryptedAction(saveManagedImportMappings, changes);
      if (result.status !== "saved") {
        setFeedback(result.status);
        return;
      }

      const savedMappings = new Map(result.mappings.map((mapping) => [mapping.id, mapping]));
      setBaseline((current) => current.map((mapping) => {
        const saved = savedMappings.get(mapping.id);
        if (!saved) return mapping;
        const category = categories.find((option) => option.id === saved.categoryId);
        return { ...mapping, ...saved, categoryName: category?.name ?? null,
          categoryIsActive: saved.categoryId ? true : null };
      }));
      setChoices((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => !savedMappings.has(id)),
      ));
      setFeedback("saved");
      startRefresh(() => router.refresh());
    } catch {
      setFeedback("unknown");
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  const feedbackMessage = feedback === "saved" ? labels.mappingsSaved
    : feedback === "failed" ? labels.mappingsSaveFailed
      : feedback === "conflict" ? labels.mappingsConflict
        : feedback === "unknown" ? labels.mappingsResultUnknown : null;

  return (
    <div className={`${styles.workflow} space-y-5`}>
      <div className="ios-panel space-y-3 p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="min-w-0 space-y-2">
            <label className="block text-sm font-medium text-stone-700" htmlFor="managed-mapping-source">{labels.mappingSourceFilter}</label>
            <IosSelect
              disabled={busy}
              id="managed-mapping-source"
              onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value as ManagedImportMappingFilters["source"] }))}
              value={filters.source}
              options={[{ value: "", label: labels.allMappingSources }, ...sources.map(([source, label]) => ({ value: source, label }))]}
            />
          </div>
          <div className="min-w-0 space-y-2">
            <label className="block text-sm font-medium text-stone-700" htmlFor="managed-mapping-type">{labels.mappingTypeFilter}</label>
            <IosSelect
              disabled={busy}
              id="managed-mapping-type"
              onChange={(event) => setFilters((current) => ({ ...current, transactionType: event.target.value as ManagedImportMappingFilters["transactionType"] }))}
              value={filters.transactionType}
              options={[{ value: "", label: messages.common.allTypes }, { value: "EXPENSE", label: messages.common.expense }, { value: "INCOME", label: messages.common.income }]}
            />
          </div>
          <div className="col-span-2 min-w-0 space-y-2 sm:col-span-1">
            <label className="block text-sm font-medium text-stone-700" htmlFor="managed-mapping-keyword">{labels.mappingKeywordFilter}</label>
            <input
              autoComplete="off"
              className="min-h-12 w-full min-w-0 rounded-xl border border-[var(--bb-line-strong)] bg-white px-3 py-2 text-base text-[var(--bb-ink)]"
              disabled={busy}
              id="managed-mapping-keyword"
              onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))}
              placeholder={labels.mappingKeywordPlaceholder}
              type="search"
              value={filters.keyword}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p aria-live="polite" className="text-sm text-stone-500">{labels.managedMappingsCount(visibleMappings.length, baseline.length)}</p>
          <button
            className="min-h-11 rounded-xl px-3 py-2 text-sm font-medium text-[var(--bb-accent-strong)] transition hover:bg-[var(--bb-warm-surface)] disabled:text-stone-400"
            disabled={busy || !hasFilters}
            onClick={() => setFilters({ source: "", transactionType: "", keyword: "" })}
            type="button"
          >
            {labels.clearMappingFilters}
          </button>
        </div>
      </div>
      <form className="space-y-5 pb-[calc(var(--managed-mapping-actions-height,8rem)+1.5rem)]" data-apk-update-blocked={busy || feedback === "unknown" || undefined} data-desktop-update-dirty={changes.length > 0 || undefined} id="managed-import-mappings" onSubmit={saveMappings} ref={formRef}>
        {visibleMappings.length === 0 ? (
          <p className="ios-panel p-5 text-sm text-stone-500">{labels.managedMappingsFilteredEmpty}</p>
        ) : null}
        {sources.flatMap(([source, sourceLabel]) => (["EXPENSE", "INCOME"] as const).map((type) => {
          const group = visibleMappings.filter((mapping) => mapping.source === source && mapping.transactionType === type);
          if (group.length === 0) return null;
          const typeLabel = type === "EXPENSE" ? messages.common.expense : messages.common.income;
          return (
            <section className="ios-panel space-y-3 p-4 sm:p-5" key={`${source}:${type}`}>
              <h2 className="text-lg font-semibold">{sourceLabel} · {typeLabel}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.map((mapping) => {
                  const options = categories.filter((category) => category.type === type);
                  const inactive = mapping.categoryId !== null && !options.some((category) => category.id === mapping.categoryId);
                  const currentLabel = mapping.categoryId === null ? labels.ignoreMapping
                    : getCategoryDisplayName(mapping.categoryName ?? "", locale);
                  const inputId = `managed-mapping-${mapping.id}`;

                  return (
                    <article className={`${styles.mappingCard} min-w-0 space-y-3 rounded-2xl border p-3`} data-managed-mapping-id={mapping.id} key={mapping.id}>
                      <dl className="space-y-2 text-sm">
                        <div>
                          <dt className="text-xs text-stone-500">{labels.primaryCategory}</dt>
                          <dd className="break-words font-medium text-stone-800">{mapping.primaryCategory || labels.originalCategoryEmpty}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-stone-500">{labels.secondaryCategory}</dt>
                          <dd className="break-words font-medium text-stone-800">{mapping.secondaryCategory || labels.originalCategoryEmpty}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-stone-500">{labels.currentMapping}</dt>
                          <dd className="break-words text-stone-700">{currentLabel}{inactive ? ` · ${labels.inactiveCategory}` : ""}</dd>
                        </div>
                      </dl>
                      <label className="block text-sm font-medium text-stone-700" htmlFor={inputId}>{messages.common.category}</label>
                      <IosSelect
                        aria-label={`${sourceLabel} · ${typeLabel} · ${mapping.primaryCategory || labels.originalCategoryEmpty} / ${mapping.secondaryCategory || labels.originalCategoryEmpty}`}
                        disabled={busy}
                        id={inputId}
                        name={`managed-mapping:${mapping.id}`}
                        onChange={(event) => {
                          setChoices((current) => ({ ...current, [mapping.id]: event.target.value }));
                          setFeedback((current) => current === "conflict" || current === "unknown" ? current : null);
                        }}
                        value={choices[mapping.id] ?? mapping.categoryId ?? IGNORE_IMPORT_MAPPING_VALUE}
                        options={[
                          { value: "", label: messages.common.category },
                          { value: IGNORE_IMPORT_MAPPING_VALUE, label: labels.ignoreMapping },
                          ...(inactive ? [{ disabled: true, value: mapping.categoryId ?? "", label: `${currentLabel} · ${labels.inactiveCategory}` }] : []),
                          ...options.map((category) => ({ value: category.id, label: getCategoryDisplayName(category.name, locale) })),
                        ]}
                      />
                    </article>
                  );
                })}
              </div>
            </section>
          );
        }))}
        <div data-bottom-actions className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bb-mobile-nav-height)+env(safe-area-inset-bottom))] z-20 md:bottom-0" data-testid="managed-mapping-actions">
          <div className="mx-auto max-w-7xl md:pl-56">
            <div className="pointer-events-auto space-y-3 border-t border-[var(--bb-warm-line)] bg-[var(--bb-surface)] px-4 py-3 sm:px-6 md:px-8" ref={actionsRef}>
              {feedbackMessage ? (
                <p className={`text-sm ${feedback === "saved" ? "text-emerald-700" : "text-red-700"}`} role={feedback === "saved" ? "status" : "alert"}>{feedbackMessage}</p>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-stone-600">{labels.managedMappingsPendingChanges(changes.length, hiddenChangesCount)}</p>
                <div className="flex gap-2">
                  <button
                    className={`${styles.primaryButton} w-full bg-[var(--bb-primary)] px-4 text-white transition hover:bg-[var(--bb-primary-hover)] disabled:bg-stone-200 disabled:text-stone-500 sm:w-auto`}
                    disabled={busy || needsRefresh}
                    type="submit"
                  >
                    {busy ? labels.savingMappings : labels.saveMappingChanges}
                  </button>
                  {needsRefresh ? (
                    <button
                      className="min-h-12 w-full rounded-xl border border-[var(--bb-line-strong)] bg-white px-4 py-3 font-semibold text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)] sm:w-auto"
                      onClick={() => window.location.reload()}
                      type="button"
                    >
                      {labels.refreshMappings}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
