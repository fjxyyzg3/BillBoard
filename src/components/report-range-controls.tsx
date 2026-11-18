"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, ChevronDown } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { BottomSheet } from "@/components/bottom-sheet";
import { IosSelect } from "@/components/ios-select";
import { getMessages, type Locale, type Messages } from "@/lib/i18n";
import {
  buildSharedReportParams,
  isValidReportDate,
  type ReportRangeMode,
  type ReportRangeOptions,
  type ReportRangeSelection,
} from "@/lib/reports/report-range";

type ReportRangeControlsProps = {
  allowedModes?: ReportRangeMode[];
  className?: string;
  labels: Messages["home"]["range"];
  closeLabel?: string;
  locale?: Locale;
  rangeOptions: ReportRangeOptions;
  selection: ReportRangeSelection;
  variant?: "compact" | "heading";
};

export function buildReportHref(
  pathname: string,
  currentParams: URLSearchParams,
  selection: ReportRangeSelection,
  patch: Partial<ReportRangeSelection>,
) {
  const nextSelection = { ...selection, ...patch };
  const params = new URLSearchParams(currentParams.toString());

  for (const [key, value] of buildSharedReportParams(nextSelection)) {
    params.set(key, value);
  }
  if (nextSelection.mode !== "custom") {
    params.delete("start");
    params.delete("end");
  }
  params.delete("perspective");
  params.delete("range");
  params.delete("from");
  params.delete("to");
  params.delete("record");
  params.delete("page");

  return `${pathname}?${params.toString()}`;
}

function getMonthYear(value: string) {
  return value.slice(0, 4);
}

function getMonthPart(value: string) {
  return value.slice(5, 7);
}

function getCustomEndpoints(selection: ReportRangeSelection) {
  const monthEnd = new Date(Date.UTC(Number(selection.month.slice(0, 4)), Number(selection.month.slice(5, 7)), 0)).getUTCDate();
  return { start: selection.start ?? `${selection.month}-01`, end: selection.end ?? `${selection.month}-${monthEnd}` };
}

function getMonthYearOptions(months: string[], years: string[]) {
  const monthYears = Array.from(new Set(months.map(getMonthYear)));

  return monthYears.length > 0 ? monthYears : years;
}

function getMonthPartsForYear(months: string[], year: string) {
  return months.filter((month) => getMonthYear(month) === year).map(getMonthPart);
}

function buildSelectOptions(values: string[]) {
  return values.map((value) => ({
    label: value,
    value,
  }));
}

export function ReportRangeControls({
  allowedModes,
  className = "",
  labels,
  closeLabel,
  locale = "zh-CN",
  rangeOptions,
  selection,
  variant = "compact",
}: ReportRangeControlsProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentParams = new URLSearchParams(searchParams.toString());
  const [open, setOpen] = useState(false);
  const [editingCustom, setEditingCustom] = useState(false);
  const [start, setStart] = useState(getCustomEndpoints(selection).start);
  const [end, setEnd] = useState(getCustomEndpoints(selection).end);
  const [customError, setCustomError] = useState(false);
  const errorId = useId();
  const activeMode = editingCustom ? "custom" : selection.mode;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rangeLabel = selection.mode === "all"
    ? labels.all
    : selection.mode === "recent"
      ? labels.recent
    : selection.mode === "custom"
      ? `${selection.start} – ${selection.end}`
    : selection.mode === "year"
      ? selection.year
      : new Intl.DateTimeFormat(locale, {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "long",
        }).format(new Date(`${selection.month}-01T00:00:00+08:00`));
  const visibleLabel = variant === "heading" && selection.mode === "month"
    ? new Intl.DateTimeFormat(locale, { timeZone: "Asia/Shanghai", month: locale === "zh-CN" ? "numeric" : "long" }).format(new Date(`${selection.month}-01T00:00:00+08:00`))
    : rangeLabel;

  function navigate(patch: Partial<ReportRangeSelection>) {
    router.replace(buildReportHref(pathname, currentParams, selection, patch), { scroll: false });
  }

  function applyCustomRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValidReportDate(start) || !isValidReportDate(end) || start > end) {
      setCustomError(true);
      return;
    }
    setCustomError(false);
    setEditingCustom(false);
    navigate({ mode: "custom", start, end });
    setOpen(false);
  }

  const modes: Array<{ label: string; value: ReportRangeMode }> = [
    { label: labels.month, value: "month" },
    { label: labels.year, value: "year" },
    { label: labels.all, value: "all" },
    { label: labels.recent, value: "recent" },
    { label: labels.custom, value: "custom" },
  ];
  const monthYearOptions = getMonthYearOptions(rangeOptions.months, rangeOptions.years);
  const selectedMonthYear = getMonthYear(selection.month);
  const selectedMonthPart = getMonthPart(selection.month);
  const activeMonthYear = monthYearOptions.includes(selectedMonthYear)
    ? selectedMonthYear
    : (monthYearOptions[0] ?? selectedMonthYear);
  const activeMonthParts = getMonthPartsForYear(rangeOptions.months, activeMonthYear);
  const activeMonthPart = activeMonthParts.includes(selectedMonthPart)
    ? selectedMonthPart
    : (activeMonthParts[0] ?? selectedMonthPart);

  function navigateMonthYear(year: string) {
    const monthParts = getMonthPartsForYear(rangeOptions.months, year);
    const nextMonthPart = monthParts.includes(activeMonthPart)
      ? activeMonthPart
      : (monthParts[0] ?? activeMonthPart);

    navigate({ month: `${year}-${nextMonthPart}`, year });
  }

  function navigateMonthPart(monthPart: string) {
    navigate({ month: `${activeMonthYear}-${monthPart}`, year: activeMonthYear });
  }

  return (
    <>
      <div className={`inline-flex min-w-0 max-w-full ${variant === "heading" ? "" : "rounded-full border border-[var(--bb-warm-line)] bg-[var(--bb-surface)]"} ${className}`}>
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`${labels.title}: ${rangeLabel}`}
          className={`flex min-h-11 w-full items-center gap-2 rounded-full text-left font-medium text-[var(--bb-ink)] transition-colors hover:bg-[var(--bb-warm-surface)] active:bg-[var(--bb-accent-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ios-blue)] ${variant === "heading" ? "py-1 text-2xl tracking-tight" : "px-3 py-2 text-xs"}`}
          data-testid="report-range-trigger"
          onClick={() => {
            const dates = getCustomEndpoints(selection);
            setStart(dates.start);
            setEnd(dates.end);
            setEditingCustom(false);
            setCustomError(false);
            setOpen(true);
          }}
          ref={triggerRef}
          type="button"
        >
          {variant === "compact" ? <CalendarDays aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--bb-muted)]" strokeWidth={1.6} /> : null}
          <span className="min-w-0 flex-1 truncate">{visibleLabel}</span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--bb-muted)]" strokeWidth={1.6} />
        </button>
      </div>

      <BottomSheet
        closeLabel={closeLabel ?? getMessages(locale).common.close}
        onClose={() => setOpen(false)}
        open={open}
        returnFocusRef={triggerRef}
        title={labels.title}
      >
        <div className="space-y-6">
          <div className="bb-segmented bb-segmented--three bb-segmented--pill grid w-full grid-cols-3 gap-1 rounded-2xl bg-[var(--bb-warm-surface)] p-1">
            {modes.filter((mode) => !allowedModes || allowedModes.includes(mode.value)).map((mode) => {
              const isActive = activeMode === mode.value;

              return (
                <button
                  aria-pressed={isActive}
                  className={`min-h-11 rounded-full px-4 text-sm font-semibold transition-colors ${
                    isActive
                      ? "text-[var(--bb-accent-ink)]"
                      : "text-[var(--bb-muted)] hover:text-[var(--bb-ink)]"
                  }`}
                  key={mode.value}
                  onClick={() => {
                    if (mode.value === "custom" && activeMode !== "custom") {
                      const dates = getCustomEndpoints(selection);
                      setStart(dates.start);
                      setEnd(dates.end);
                    }
                    setEditingCustom(mode.value === "custom");
                    setCustomError(false);
                    if (mode.value !== "custom") navigate({ mode: mode.value });
                  }}
                  type="button"
                >
                  {mode.label}
                </button>
              );
            })}
          </div>

          <div className="min-w-0">
            {activeMode === "month" ? (
              <div className="grid min-w-0 grid-cols-2 gap-3">
                <label className="min-w-0 space-y-2 text-sm font-medium text-[var(--bb-muted)]">
                  <span className="shrink-0">{labels.yearLabel}</span>
                  <IosSelect
                    className="w-full"
                    onChange={(event) => navigateMonthYear(event.target.value)}
                    options={buildSelectOptions(monthYearOptions)}
                    value={activeMonthYear}
                    variant="pill"
                  />
                </label>

                <label className="min-w-0 space-y-2 text-sm font-medium text-[var(--bb-muted)]">
                  <span className="shrink-0">{labels.monthLabel}</span>
                  <IosSelect
                    className="w-full"
                    onChange={(event) => navigateMonthPart(event.target.value)}
                    options={buildSelectOptions(activeMonthParts)}
                    value={activeMonthPart}
                    variant="pill"
                  />
                </label>
              </div>
            ) : null}

            {activeMode === "year" ? (
              <label className="block min-w-0 space-y-2 text-sm font-medium text-[var(--bb-muted)]">
                <span className="shrink-0">{labels.yearLabel}</span>
                <IosSelect
                  className="w-full"
                  onChange={(event) => navigate({ year: event.target.value })}
                  options={buildSelectOptions(rangeOptions.years)}
                  value={selection.year}
                  variant="pill"
                />
              </label>
            ) : null}

            {activeMode === "all" ? (
              <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.allDescription}</p>
            ) : null}
            {activeMode === "recent" ? (
              <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.recentDescription}</p>
            ) : null}
            {activeMode === "custom" ? (
              <form className="space-y-4" noValidate onSubmit={applyCustomRange}>
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <label className="min-w-0 space-y-2 text-sm font-medium text-[var(--bb-muted)]">
                    <span className="block">{labels.startDate}</span>
                    <input aria-describedby={customError ? errorId : undefined} aria-invalid={customError || undefined} className="ios-field min-h-12 min-w-0 w-full" name="start" onChange={(event) => setStart(event.target.value)} required type="date" value={start} />
                  </label>
                  <label className="min-w-0 space-y-2 text-sm font-medium text-[var(--bb-muted)]">
                    <span className="block">{labels.endDate}</span>
                    <input aria-describedby={customError ? errorId : undefined} aria-invalid={customError || undefined} className="ios-field min-h-12 min-w-0 w-full" name="end" onChange={(event) => setEnd(event.target.value)} required type="date" value={end} />
                  </label>
                </div>
                <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.customDescription}</p>
                {customError ? <p className="text-sm text-red-700" id={errorId} role="alert">{labels.invalidRange}</p> : null}
                <button className="bb-tap min-h-12 w-full rounded-xl bg-[var(--bb-primary)] px-4 text-sm font-semibold text-white" type="submit">{labels.apply}</button>
              </form>
            ) : null}
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
