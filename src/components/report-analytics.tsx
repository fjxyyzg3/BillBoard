"use client";

import { useState } from "react";
import { IosSelect } from "@/components/ios-select";
import { ReportCalendar, ReportCategoryTrends, ReportCumulative, ReportDistribution } from "@/components/report-analytics-charts";
import {
  AnalysisAvailability, AnalysisValue, analysisDate, analysisDelta, analysisMoney,
  analysisPercent, analysisRecordHref, type ReportAnalyticsLinks, type ReportPeriodLinks,
} from "@/components/report-analytics-shared";
import { formatLocaleNumber, getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type { AnalyticsComparison, AnalyticsTransactionType, ReportAnalytics as ReportAnalyticsData } from "@/lib/reports/analytics-types";
import type { ReportRangeSelection } from "@/lib/reports/report-range";

export type { ReportAnalyticsLinks } from "@/components/report-analytics-shared";

type ReportAnalyticsProps = { report: ReportAnalyticsData; range: ReportRangeSelection; locale: Locale; links: ReportAnalyticsLinks };
type AnalysisView = "comparison" | "categories" | "calendar" | "cumulative" | "annual" | "distribution";

function PeriodComparison({ report, comparison, title, links, currentLinks, locale }: {
  report: ReportAnalyticsData; comparison: AnalyticsComparison; title: string;
  links: ReportPeriodLinks | null; currentLinks: ReportPeriodLinks; locale: Locale;
}) {
  const labels = getMessages(locale).home.analytics;
  const metrics = [
    { key: "expense" as const, title: labels.expense, current: report.summary.expenseFen, previous: comparison.summary?.expenseFen, href: "expense" as const },
    { key: "income" as const, title: labels.income, current: report.summary.incomeFen, previous: comparison.summary?.incomeFen, href: "income" as const },
    { key: "net" as const, title: labels.net, current: report.summary.netFen, previous: comparison.summary?.netFen, href: "all" as const },
  ];
  return (
    <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--bb-warm-line)] p-3 sm:p-4">
      <div>
        <h3 className="font-semibold text-[var(--bb-ink)]">{title}</h3>
        {comparison.range ? <p className="mt-1 text-xs leading-5 text-[var(--bb-muted)]">{analysisDate(comparison.range.from, locale)} – {analysisDate(comparison.range.to, locale)}</p> : null}
      </div>
      <AnalysisAvailability comparison={comparison} locale={locale} />
      {comparison.summary ? (
        <div className="divide-y divide-[var(--bb-warm-line)]">
          {metrics.map((metric) => {
            const change = comparison[metric.key];
            return (
              <div className="min-w-0 space-y-2 py-3 first:pt-0 last:pb-0" key={metric.key}>
                <p className="text-sm font-medium">{metric.title}</p>
                <div className="grid min-w-0 grid-cols-2 gap-3 text-sm tabular-nums">
                  <div className="min-w-0"><p className="mb-1 text-xs text-[var(--bb-muted)]">{labels.current}</p><AnalysisValue className="break-words font-semibold" href={currentLinks[metric.href]}>{analysisMoney(metric.current, locale)}</AnalysisValue></div>
                  <div className="min-w-0"><p className="mb-1 text-xs text-[var(--bb-muted)]">{title}</p><AnalysisValue className="break-words" href={links?.[metric.href]}>{analysisMoney(metric.previous ?? 0, locale)}</AnalysisValue></div>
                </div>
                {change.deltaFen !== null ? <p className="text-xs tabular-nums text-[var(--bb-muted)]">{labels.delta} <strong className="font-medium text-[var(--bb-ink)]">{analysisDelta(change.deltaFen, locale)}</strong>{change.ratio !== null ? ` (${change.ratio > 0 ? "+" : ""}${analysisPercent(change.ratio, locale)})` : ""}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function MonthlyReview({ report, locale, links }: Omit<ReportAnalyticsProps, "range">) {
  const labels = getMessages(locale).home.analytics;
  const largestChange = report.comparisons.previous.availability === "available"
    ? report.categoryChanges.expense.filter((item) => item.deltaFen !== null && item.deltaFen !== 0)
      .sort((left, right) => Math.abs(right.deltaFen ?? 0) - Math.abs(left.deltaFen ?? 0))[0]
    : undefined;
  return (
    <section className="rounded-2xl bg-[var(--bb-warm-surface)] p-4" data-testid="report-monthly-summary">
      <h3 className="font-semibold">{labels.monthlyTitle}</h3>
      <p className="mt-1 text-xs text-[var(--bb-muted)]">{labels.monthlyFacts}</p>
      {report.summary.transactionCount === 0 ? <p className="mt-3 text-sm">{labels.noData}</p> : (
        <ul className="mt-3 space-y-3 text-sm leading-6">
          <li><AnalysisValue href={links.current.all}>{labels.monthlyTotals(analysisMoney(report.summary.incomeFen, locale), analysisMoney(report.summary.expenseFen, locale), analysisMoney(report.summary.netFen, locale))}</AnalysisValue></li>
          {largestChange ? <li><AnalysisValue href={analysisRecordHref(links.current.expense, { category: largestChange.categoryId })}>{labels.monthlyChange(getCategoryDisplayName(largestChange.categoryName, locale), analysisDelta(largestChange.deltaFen!, locale))}</AnalysisValue></li> : null}
          {report.distribution.maxFen !== null ? <li><AnalysisValue href={links.maximumExpense}>{labels.monthlyMaximum(analysisMoney(report.distribution.maxFen, locale))}</AnalysisValue></li> : null}
          {report.distribution.topFiveShare !== null ? <li><AnalysisValue href={links.current.expense}>{labels.monthlyConcentration(Math.min(5, report.distribution.expenseCount), analysisPercent(report.distribution.topFiveShare, locale))}</AnalysisValue></li> : null}
        </ul>
      )}
    </section>
  );
}

function CategoryChanges({ report, type, locale, links }: Omit<ReportAnalyticsProps, "range"> & { type: AnalyticsTransactionType }) {
  const labels = getMessages(locale).home.analytics;
  const rows = report.categoryChanges[type];
  const maximum = Math.max(1, ...rows.flatMap((row) => [row.current.amountFen, row.previous.amountFen]));
  return (
    <div className="space-y-4">
      <AnalysisAvailability comparison={report.comparisons.previous} locale={locale} />
      {rows.length === 0 ? <p className="py-5 text-sm text-[var(--bb-muted)]">{labels.noCategories}</p> : (
        <ul className="divide-y divide-[var(--bb-warm-line)]">
          {rows.map((row) => (
            <li className="space-y-3 py-4 first:pt-0" key={row.categoryId}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 className="font-semibold">{getCategoryDisplayName(row.categoryName, locale)}</h3>
                {row.deltaFen !== null ? <p className="text-sm tabular-nums">{analysisDelta(row.deltaFen, locale)}{row.ratio !== null ? <span className="ml-2 text-xs text-[var(--bb-muted)]">{row.ratio > 0 ? "+" : ""}{analysisPercent(row.ratio, locale)}</span> : null}</p> : null}
              </div>
              {(["current", "previous"] as const).map((period) => {
                const values = row[period];
                const href = period === "current" ? links.current[type] : links.previous?.[type];
                return (
                  <div className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3" key={period}>
                    <p className="pt-0.5 text-xs text-[var(--bb-muted)]">{labels[period]}</p>
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm tabular-nums">
                        <AnalysisValue href={values.transactionCount > 0 && href ? analysisRecordHref(href, { category: row.categoryId }) : undefined}>{analysisMoney(values.amountFen, locale)}</AnalysisValue>
                        <span className="text-xs text-[var(--bb-muted)]">{labels.transactions(formatLocaleNumber(values.transactionCount, locale))} · {labels.average} {values.averageFen === null ? "—" : analysisMoney(values.averageFen, locale)}</span>
                      </div>
                      <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-[var(--bb-warm-surface)]"><div className={`h-full rounded-full ${period === "current" ? "bg-[var(--bb-primary)]" : "bg-[var(--bb-line-strong)]"}`} style={{ width: `${values.amountFen / maximum * 100}%` }} /></div>
                    </div>
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReportAnalytics({ report, range, locale, links }: ReportAnalyticsProps) {
  const [view, setView] = useState<AnalysisView>("comparison");
  const [transactionType, setTransactionType] = useState<AnalyticsTransactionType>("expense");
  const labels = getMessages(locale).home.analytics;
  return (
    <section className="ios-panel min-w-0 space-y-5 p-4 sm:p-5" data-testid="report-analytics">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h2 className="text-[15px] font-medium text-[var(--bb-ink)]">{labels.title}</h2><p className="mt-1 text-xs leading-5 text-[var(--bb-muted)]">{analysisDate(report.range.from, locale)} – {analysisDate(report.range.to, locale)}</p></div>
        <IosSelect aria-label={labels.view} className="w-full max-w-full sm:w-52" data-testid="report-analysis-view" onChange={(event) => setView(event.target.value as AnalysisView)} options={Object.entries(labels.views).map(([value, label]) => ({ value, label }))} value={view} variant="pill" />
      </header>
      {view === "categories" || view === "annual" ? <IosSelect aria-label={labels.transactionType} className="w-full sm:w-48" onChange={(event) => setTransactionType(event.target.value as AnalyticsTransactionType)} options={[{ value: "expense", label: labels.expense }, { value: "income", label: labels.income }]} value={transactionType} variant="pill" /> : null}
      <div key={view}>
        {view === "comparison" ? <div className="space-y-4"><div className="grid items-start gap-4 lg:grid-cols-2"><PeriodComparison report={report} comparison={report.comparisons.previous} title={labels.previous} links={links.previous} currentLinks={links.current} locale={locale} /><PeriodComparison report={report} comparison={report.comparisons.yearAgo} title={labels.yearAgo} links={links.yearOverYear} currentLinks={links.current} locale={locale} /></div>{range.mode === "month" ? <MonthlyReview report={report} locale={locale} links={links} /> : null}<p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.netNote}</p></div> : null}
        {view === "categories" ? <CategoryChanges report={report} type={transactionType} locale={locale} links={links} /> : null}
        {view === "calendar" ? <ReportCalendar report={report} locale={locale} links={links} /> : null}
        {view === "cumulative" ? <ReportCumulative report={report} locale={locale} links={links} /> : null}
        {view === "annual" ? <ReportCategoryTrends report={report} type={transactionType} locale={locale} links={links} /> : null}
        {view === "distribution" ? <ReportDistribution report={report} locale={locale} links={links} /> : null}
      </div>
      <footer className="space-y-1 border-t border-[var(--bb-warm-line)] pt-3 text-xs leading-5 text-[var(--bb-muted)]"><p>{labels.recordedOnly}</p>{report.firstRecordedDate && report.range.from < report.firstRecordedDate ? <p>{labels.firstRecord(analysisDate(report.firstRecordedDate, locale))}</p> : null}</footer>
    </section>
  );
}
