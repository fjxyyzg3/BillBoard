"use client";

import { appendEncryption } from "@/lib/encryption/client";

import { House, ListFilter, LoaderCircle, Search, Tags, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore, useTransition, type FormEvent } from "react";
import { BottomSheet } from "@/components/bottom-sheet";
import { IosSelect } from "@/components/ios-select";
import styles from "./finance-b2.module.css";
import { getCategoryDisplayName, getMessages, type Locale, type Messages } from "@/lib/i18n";
import { formatFen } from "@/lib/money";
import {
  parseRecordAmountFilter,
  type RecordAmountFilter,
  type RecordAmountFilterError,
} from "@/lib/records/amount-filter";
import { parseRecordSort, type RecordSort } from "@/lib/records/sort";

type CategoryOption = {
  id: string;
  name: string;
  type: "income" | "expense";
};

type RecordsFilterBarProps = {
  amountError?: RecordAmountFilterError;
  amountFilter?: RecordAmountFilter;
  categories: CategoryOption[];
  labels: {
    common: Messages["common"];
  };
  locale: Locale;
  searchValue?: string;
};

type AmountDraft = {
  mode: "any" | "exact" | "range";
  exact: string;
  min: string;
  max: string;
};

type FilterDraft = {
  amount: AmountDraft;
  categoryId: string;
  search: string;
  sort: RecordSort | "";
  type: CategoryOption["type"] | "";
};

type FilterState = {
  draft: FilterDraft;
  error?: RecordAmountFilterError;
  source: string;
};

function subscribeToHydration() {
  return () => {};
}

function getHydratedSnapshot() {
  return true;
}

function getServerHydrationSnapshot() {
  return false;
}

function getAmountDraft(filter?: RecordAmountFilter): AmountDraft {
  return {
    mode: filter?.mode ?? "any",
    exact: filter?.mode === "exact" ? formatFen(filter.valueFen) : "",
    min: filter?.mode === "range" && filter.minFen !== undefined ? formatFen(filter.minFen) : "",
    max: filter?.mode === "range" && filter.maxFen !== undefined ? formatFen(filter.maxFen) : "",
  };
}

function parseType(value: string | null): CategoryOption["type"] | undefined {
  if (value === "income" || value === "expense") {
    return value;
  }

  return undefined;
}

type RecordsFilterPatch = {
  categoryId?: string;
  clearAmount?: boolean;
  clearRecord?: boolean;
  clearSearch?: boolean;
  sort?: RecordSort | "";
  type?: CategoryOption["type"] | "";
};

export function buildRecordsFilterHref(
  pathname: string,
  currentParams: URLSearchParams,
  patch: RecordsFilterPatch,
) {
  const params = new URLSearchParams(currentParams.toString());

  params.delete("perspective");
  params.delete("page");

  if (patch.clearRecord) {
    params.delete("record");
  }

  if (patch.clearSearch) {
    params.delete("search");
  }

  if (patch.clearAmount) {
    params.delete("amount");
    params.delete("filterError");
  }

  if ("type" in patch) {
    if (patch.type) {
      params.set("type", patch.type);
    } else {
      params.delete("type");
    }
  }

  if ("categoryId" in patch) {
    if (patch.categoryId) {
      params.set("category", patch.categoryId);
    } else {
      params.delete("category");
    }
  }

  if ("sort" in patch) {
    if (patch.sort) {
      params.set("sort", patch.sort);
    } else {
      params.delete("sort");
    }
  }

  const query = params.toString();

  return query ? `${pathname}?${query}` : pathname;
}

export function RecordsFilterBar({
  amountError,
  amountFilter,
  categories,
  labels,
  locale,
  searchValue,
}: RecordsFilterBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchParamsValue = searchParams.toString();
  const ui = getMessages(locale).ui;
  const filterId = useId();
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydrationSnapshot,
  );
  const amountId = `${filterId}-amount`;
  const amountErrorId = `${amountId}-error`;
  const submittedSearch = searchValue?.trim() ?? "";
  const selectedType = parseType(searchParams.get("type")) ?? "";
  const selectedCategoryId = searchParams.get("category") ?? "";
  const selectedSort = parseRecordSort(searchParams.get("sort")) ?? "";
  const submittedDraft: FilterDraft = {
    amount: getAmountDraft(amountFilter),
    categoryId: selectedCategoryId,
    search: submittedSearch,
    sort: selectedSort,
    type: selectedType,
  };
  const filterSource = JSON.stringify([searchParamsValue, submittedDraft, amountError]);
  const [filterState, setFilterState] = useState<FilterState>({
    source: filterSource,
    draft: submittedDraft,
    error: amountError,
  });
  const [filtersOpen, setFiltersOpen] = useState(Boolean(amountError));
  const [submissionFailed, setSubmissionFailed] = useState<"search" | "filters" | null>(null);
  const [submitting, setSubmitting] = useState<"search" | "filters" | null>(null);
  const [navigating, startNavigation] = useTransition();
  const requestRef = useRef<AbortController | null>(null);
  const submissionPending = submitting !== null || navigating;
  useEffect(() => () => requestRef.current?.abort(), [searchParamsValue]);
  if (filterState.source !== filterSource) {
    setFilterState({ source: filterSource, draft: submittedDraft, error: amountError });
    if (amountError) {
      setFiltersOpen(true);
    }
  }
  const draft = filterState.source === filterSource ? filterState.draft : submittedDraft;
  const currentAmountError =
    filterState.source === filterSource ? filterState.error : amountError;
  const categoryOptions = [
    { value: "", label: labels.common.allCategories },
    ...categories
      .filter((category) => !draft.type || category.type === draft.type)
      .map((category) => ({
        value: category.id,
        label: getCategoryDisplayName(category.name, locale),
      })),
  ];
  const selectedCategory = categories.find((category) => category.id === selectedCategoryId);
  const selectedSortLabel = selectedSort === "amount-asc"
    ? labels.common.amountLowToHigh
    : labels.common.amountHighToLow;
  const selectedAmountLabel = amountFilter?.mode === "exact"
    ? `¥${formatFen(amountFilter.valueFen)}`
    : amountFilter?.mode === "range"
      ? amountFilter.minFen === undefined
        ? `≤ ¥${formatFen(amountFilter.maxFen!)}`
        : amountFilter.maxFen === undefined
          ? `≥ ¥${formatFen(amountFilter.minFen)}`
          : `¥${formatFen(amountFilter.minFen)} – ${formatFen(amountFilter.maxFen)}`
      : "";
  const appliedFilters = [
    ...(submittedSearch ? [{
      key: "search",
      label: submittedSearch,
      clearLabel: labels.common.clearSearch,
      patch: { clearSearch: true },
    }] : []),
    ...(selectedType ? [{
      key: "type",
      label: labels.common[selectedType],
      patch: { type: "" as const, clearRecord: true },
    }] : []),
    ...(selectedCategoryId ? [{
      key: "category",
      label: selectedCategory
        ? getCategoryDisplayName(selectedCategory.name, locale)
        : labels.common.category,
      patch: { categoryId: "", clearRecord: true },
    }] : []),
    ...(amountFilter ? [{
      key: "amount",
      label: selectedAmountLabel,
      clearLabel: labels.common.clearAmountFilter,
      patch: { clearAmount: true },
    }] : []),
    ...(selectedSort ? [{
      key: "sort",
      label: selectedSortLabel,
      patch: { sort: "" as const },
    }] : []),
  ];
  const advancedFilterCount = appliedFilters.filter((filter) => filter.key !== "search").length;

  function updateDraft(patch: Partial<FilterDraft>) {
    setFilterState({
      source: filterSource,
      draft: { ...draft, ...patch },
      error: "amount" in patch ? undefined : currentAmountError,
    });
  }

  function updateAmount(patch: Partial<AmountDraft>) {
    updateDraft({ amount: { ...draft.amount, ...patch } });
  }

  function validateAmount(event: FormEvent<HTMLFormElement>) {
    try {
      parseRecordAmountFilter(draft.amount);
    } catch (error) {
      event.preventDefault();
      setFiltersOpen(true);
      setFilterState({
        source: filterSource,
        draft,
        error:
          error instanceof Error && error.message === "invalidAmountRange"
            ? "invalidAmountRange"
            : "invalidAmount",
      });
    }
  }

  function removeFilter(patch: RecordsFilterPatch) {
    if (submissionPending) return;
    router.replace(buildRecordsFilterHref(pathname, searchParams, patch), { scroll: false });
  }

  function closeFilters() {
    requestRef.current?.abort();
    requestRef.current = null;
    setSubmitting(null);
    setSubmissionFailed(null);
    setFiltersOpen(false);
    setFilterState({
      source: filterSource,
      draft: { ...submittedDraft, search: draft.search },
      error: amountError,
    });
  }

  function openFilters() {
    setSubmissionFailed(null);
    setFilterState({
      source: filterSource,
      draft: { ...submittedDraft, search: draft.search },
      error: amountError,
    });
    setFiltersOpen(true);
  }

  function selectType(type: FilterDraft["type"]) {
    const categoryId = categories.some((category) =>
      category.id === selectedCategoryId && (!type || category.type === type),
    ) ? selectedCategoryId : "";
    removeFilter({ categoryId, clearRecord: type !== selectedType, type });
  }

  async function submit(event: FormEvent<HTMLFormElement>, kind: "search" | "filters") {
    if (kind === "filters") validateAmount(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (requestRef.current || navigating) return;
    const form = event.currentTarget;
    const controller = new AbortController();
    requestRef.current = controller;
    setSubmitting(kind);
    setSubmissionFailed(null);
    try {
      const response = await fetch(form.action, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        body: appendEncryption(new FormData(form)),
      });
      if (!response.ok) throw new Error("FILTER_UNAVAILABLE");
      const destination = new URL(response.url);
      if (destination.origin !== window.location.origin) throw new Error("FILTER_UNAVAILABLE");
      if (controller.signal.aborted) return;
      startNavigation(() => {
        router.push(`${destination.pathname}${destination.search}`, { scroll: false });
        if (kind === "filters") setFiltersOpen(false);
      });
    } catch {
      if (!controller.signal.aborted) setSubmissionFailed(kind);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setSubmitting(null);
      }
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <form
        action={`${pathname}/search`}
        aria-busy={!isHydrated || submissionPending || undefined}
        method="post"
        onSubmit={(event) => submit(event, "search")}
      >
        <input
          name="returnTo"
          type="hidden"
          value={buildRecordsFilterHref(pathname, searchParams, {})}
        />
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <label className="sr-only" htmlFor={`${filterId}-search`}>{labels.common.search}</label>
            <input
              autoComplete="off"
              className="min-h-11 w-full min-w-0 rounded-2xl border border-[var(--bb-warm-line)] bg-white/90 py-2.5 pl-3 pr-11 text-base text-[var(--bb-ink)] outline-none transition placeholder:text-[var(--bb-faint)] focus:border-[var(--ios-blue)] focus:ring-2 focus:ring-[var(--ios-blue)]/15"
              id={`${filterId}-search`}
              disabled={!isHydrated || submissionPending}
              name="search"
              onChange={(event) => updateDraft({ search: event.target.value })}
              placeholder={labels.common.searchPlaceholder}
              type="search"
              value={draft.search}
            />
            <button
              aria-label={labels.common.searchAction}
              className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-2xl text-[var(--bb-accent-strong)] transition hover:bg-[var(--bb-accent-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ios-blue)]"
              disabled={!isHydrated || submissionPending}
              type="submit"
            >
              {submitting === "search" ? <LoaderCircle aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" /> : <Search aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} />}
            </button>
          </div>
          <button
            aria-controls={filterId}
            aria-expanded={filtersOpen}
            aria-haspopup="dialog"
            aria-label={ui.filters}
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-2xl border border-[var(--bb-warm-line)] bg-white/90 px-3 text-sm font-medium text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ios-blue)]"
            onClick={openFilters}
            disabled={!isHydrated || submissionPending}
            ref={filterTriggerRef}
            type="button"
          >
            <ListFilter aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} />
            <span>{ui.filters}</span>
            {advancedFilterCount ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--bb-accent-soft)] px-1 text-xs text-[var(--bb-accent-strong)]">
                {advancedFilterCount}
              </span>
            ) : null}
          </button>
        </div>
        {submitting === "search" ? <p className="sr-only" role="status">{labels.common.searching}</p> : null}
        {submissionFailed === "search" ? <p className="mt-2 text-sm text-[var(--bb-danger)]" role="alert">{labels.common.searchFailed}</p> : null}
      </form>

      <div aria-label={labels.common.type} className={`${styles.typeFilters} bb-segmented bb-segmented--three`} role="group">
        {([
          { value: "", label: labels.common.allTypes },
          { value: "expense", label: labels.common.expense },
          { value: "income", label: labels.common.income },
        ] as const).map((type) => (
          <button
            aria-pressed={selectedType === type.value}
            className={`min-h-11 rounded-full px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ios-blue)] ${
              selectedType === type.value
                ? "text-[var(--bb-accent-strong)]"
                : "text-[var(--bb-muted)]"
            }`}
            key={type.value}
            disabled={submissionPending}
            onClick={() => selectType(type.value)}
            type="button"
          >
            {type.label}
          </button>
        ))}
      </div>

      {appliedFilters.length ? (
        <div aria-label={ui.activeFilters} className="flex flex-wrap gap-2" role="group">
          {appliedFilters.map((filter) => (
            <button
              aria-label={"clearLabel" in filter
                ? filter.clearLabel
                : `${ui.removeFilter}${locale === "zh-CN" ? "：" : ": "}${filter.label}`}
              className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full bg-[var(--bb-warm-surface)] px-3 py-1.5 text-xs font-medium text-[var(--bb-muted)] transition hover:bg-[var(--bb-accent-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ios-blue)]"
              key={filter.key}
              disabled={submissionPending}
              onClick={() => removeFilter(filter.patch)}
              type="button"
            >
              {filter.key === "search" ? <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
              <span className="max-w-56 truncate">{filter.label}</span>
              <X aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            </button>
          ))}
        </div>
      ) : null}

      <form
        action={`${pathname}/search`}
        aria-busy={submissionPending || undefined}
        method="post"
        onSubmit={(event) => submit(event, "filters")}
      >
        <input
          name="returnTo"
          type="hidden"
          value={buildRecordsFilterHref(pathname, searchParams, {
            categoryId: draft.categoryId,
            clearRecord: draft.type !== selectedType || draft.categoryId !== selectedCategoryId,
            sort: draft.sort,
            type: draft.type,
          })}
        />
        <input name="search" type="hidden" value={draft.search} />
        <BottomSheet
          closeLabel={labels.common.close}
          footer={
            <button
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[var(--bb-primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--bb-primary-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ios-blue)] disabled:opacity-60"
              disabled={submissionPending}
              type="submit"
            >
              {submissionPending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" /> : null}
              {submissionPending ? labels.common.searching : ui.applyFilters}
            </button>
          }
          onClose={closeFilters}
          open={filtersOpen}
          returnFocusRef={filterTriggerRef}
          title={ui.filters}
        >
          <fieldset aria-label={ui.filters} className="min-w-0 space-y-5" disabled={submissionPending} id={filterId}>
            {submissionFailed === "filters" ? <p className="text-sm text-[var(--bb-danger)]" role="alert">{labels.common.searchFailed}</p> : null}
            {submitting === "filters" ? <p className="sr-only" role="status">{labels.common.searching}</p> : null}
            <div className="grid min-w-0 gap-3 sm:grid-cols-3">
              <div className="min-w-0 space-y-2">
                <label className="block text-sm font-semibold text-[var(--ios-muted)]" htmlFor={`${filterId}-type`}>
                  {labels.common.type}
                </label>
                <IosSelect
                  id={`${filterId}-type`}
                  leadingIcon={<House className="h-4 w-4" strokeWidth={2.15} />}
                  onChange={(event) => {
                    const type = parseType(event.target.value) ?? "";
                    const categoryId = categories.some((category) =>
                      category.id === draft.categoryId && (!type || category.type === type),
                    ) ? draft.categoryId : "";
                    updateDraft({ categoryId, type });
                  }}
                  options={[
                    { value: "", label: labels.common.allTypes },
                    { value: "expense", label: labels.common.expense },
                    { value: "income", label: labels.common.income },
                  ]}
                  value={draft.type}
                />
              </div>
              <div className="min-w-0 space-y-2">
                <label className="block text-sm font-semibold text-[var(--ios-muted)]" htmlFor={`${filterId}-category`}>
                  {labels.common.category}
                </label>
                <IosSelect
                  id={`${filterId}-category`}
                  leadingIcon={<Tags className="h-4 w-4" strokeWidth={2.15} />}
                  onChange={(event) => updateDraft({ categoryId: event.target.value })}
                  options={categoryOptions}
                  value={draft.categoryId}
                />
              </div>
              <div className="min-w-0 space-y-2">
                <label className="block text-sm font-semibold text-[var(--ios-muted)]" htmlFor={`${filterId}-sort`}>
                  {labels.common.sort}
                </label>
                <IosSelect
                  id={`${filterId}-sort`}
                  leadingIcon={<ListFilter className="h-4 w-4" strokeWidth={2.15} />}
                  onChange={(event) => updateDraft({ sort: parseRecordSort(event.target.value) ?? "" })}
                  options={[
                    { value: "", label: labels.common.newestFirst },
                    { value: "amount-desc", label: labels.common.amountHighToLow },
                    { value: "amount-asc", label: labels.common.amountLowToHigh },
                  ]}
                  value={draft.sort}
                />
              </div>
            </div>

            <div className="grid min-w-0 gap-3 sm:grid-cols-3">
              <div className="min-w-0 space-y-2">
                <label className="text-sm font-semibold text-[var(--ios-muted)]" htmlFor={amountId}>
                  {labels.common.amountFilter}
                </label>
                <IosSelect
                  aria-describedby={currentAmountError ? amountErrorId : undefined}
                  id={amountId}
                  name="amountMode"
                  onChange={(event) => {
                    const mode = event.target.value;
                    updateAmount({ mode: mode === "exact" || mode === "range" ? mode : "any" });
                  }}
                  options={[
                    { value: "any", label: labels.common.allAmounts },
                    { value: "exact", label: labels.common.amountExact },
                    { value: "range", label: labels.common.amountRange },
                  ]}
                  value={draft.amount.mode}
                />
              </div>
              {draft.amount.mode === "exact" ? (
                <label className="min-w-0 space-y-2 sm:col-span-2">
                  <span className="text-sm font-semibold text-[var(--ios-muted)]">
                    {labels.common.amountExactYuan}
                  </span>
                  <input
                    aria-describedby={currentAmountError ? amountErrorId : undefined}
                    aria-invalid={currentAmountError ? true : undefined}
                    autoComplete="off"
                    className="min-h-11 w-full min-w-0 rounded-2xl border border-[var(--bb-warm-line)] bg-white/90 px-3 py-2.5 text-base text-[var(--bb-ink)] outline-none transition placeholder:text-[var(--bb-faint)] focus:border-[var(--ios-blue)] focus:ring-2 focus:ring-[var(--ios-blue)]/15"
                    inputMode="decimal"
                    name="amountExact"
                    onChange={(event) => updateAmount({ exact: event.target.value })}
                    placeholder="0.00"
                    type="text"
                    value={draft.amount.exact}
                  />
                </label>
              ) : null}
              {draft.amount.mode === "range" ? (
                <>
                  <label className="min-w-0 space-y-2">
                    <span className="text-sm font-semibold text-[var(--ios-muted)]">{labels.common.amountMin}</span>
                    <input
                      aria-describedby={currentAmountError ? amountErrorId : undefined}
                      aria-invalid={currentAmountError ? true : undefined}
                      autoComplete="off"
                      className="min-h-11 w-full min-w-0 rounded-2xl border border-[var(--bb-warm-line)] bg-white/90 px-3 py-2.5 text-base text-[var(--bb-ink)] outline-none transition placeholder:text-[var(--bb-faint)] focus:border-[var(--ios-blue)] focus:ring-2 focus:ring-[var(--ios-blue)]/15"
                      inputMode="decimal"
                      name="amountMin"
                      onChange={(event) => updateAmount({ min: event.target.value })}
                      placeholder={labels.common.optional}
                      type="text"
                      value={draft.amount.min}
                    />
                  </label>
                  <label className="min-w-0 space-y-2">
                    <span className="text-sm font-semibold text-[var(--ios-muted)]">{labels.common.amountMax}</span>
                    <input
                      aria-describedby={currentAmountError ? amountErrorId : undefined}
                      aria-invalid={currentAmountError ? true : undefined}
                      autoComplete="off"
                      className="min-h-11 w-full min-w-0 rounded-2xl border border-[var(--bb-warm-line)] bg-white/90 px-3 py-2.5 text-base text-[var(--bb-ink)] outline-none transition placeholder:text-[var(--bb-faint)] focus:border-[var(--ios-blue)] focus:ring-2 focus:ring-[var(--ios-blue)]/15"
                      inputMode="decimal"
                      name="amountMax"
                      onChange={(event) => updateAmount({ max: event.target.value })}
                      placeholder={labels.common.optional}
                      type="text"
                      value={draft.amount.max}
                    />
                  </label>
                </>
              ) : null}
            </div>
            {currentAmountError ? (
              <p className="text-sm text-red-700" id={amountErrorId} role="alert">
                {labels.common[currentAmountError]}
              </p>
            ) : null}
          </fieldset>
        </BottomSheet>
      </form>
    </div>
  );
}
