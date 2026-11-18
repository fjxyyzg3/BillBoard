"use client";

import Link from "next/link";
import { useState } from "react";
import { IosSelect } from "@/components/ios-select";
import {
  AnalysisAvailability, AnalysisValue, analysisDate, analysisDateFilters, analysisMoney,
  analysisPercent, analysisRecordHref, type ReportAnalyticsLinks,
} from "@/components/report-analytics-shared";
import { formatLocaleNumber, getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type { AnalyticsTransactionType, ReportAnalytics as ReportAnalyticsData } from "@/lib/reports/analytics-types";

type ChartProps = { report: ReportAnalyticsData; locale: Locale; links: ReportAnalyticsLinks };

function monthLabel(month: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale, { timeZone: "Asia/Shanghai", year: "numeric", month: "short" }).format(new Date(`${month}-01T00:00:00+08:00`));
}

function lastMonthDate(month: string) {
  const [year, number] = month.split("-").map(Number);
  return `${month}-${new Date(Date.UTC(year, number, 0)).getUTCDate()}`;
}

function compactMoney(fen: number, locale: Locale) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(fen / 100);
}

export function ReportCalendar({ report, locale, links }: ChartProps) {
  const labels = getMessages(locale).home.analytics;
  const months = report.categoryMonths.months;
  const [selectedMonth, setSelectedMonth] = useState(months.at(-1) ?? report.range.to.slice(0, 7));
  const month = months.includes(selectedMonth) ? selectedMonth : (months.at(-1) ?? report.range.to.slice(0, 7));
  const days = report.daily.filter((day) => day.date.startsWith(month));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const maximum = Math.max(1, ...days.map((day) => day.expenseFen));
  const monthStart = new Date(`${month}-01T00:00:00Z`);
  const offset = (monthStart.getUTCDay() + 6) % 7;
  const count = Number(lastMonthDate(month).slice(-2));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm leading-6 text-[var(--bb-muted)]">{labels.calendarHint}</p>
        <IosSelect aria-label={labels.calendarMonth} className="w-full sm:w-auto sm:min-w-44" onChange={(event) => setSelectedMonth(event.target.value)} options={[...months].reverse().map((value) => ({ value, label: monthLabel(value, locale) }))} value={month} variant="pill" />
      </div>
      <div className="grid grid-cols-7 gap-1 sm:gap-2" data-testid="report-calendar">
        {labels.weekdays.map((day) => <div className="py-1 text-center text-xs text-[var(--bb-muted)]" key={day}>{day}</div>)}
        {Array.from({ length: offset }, (_, index) => <div aria-hidden="true" key={`offset-${index}`} />)}
        {Array.from({ length: count }, (_, index) => {
          const date = `${month}-${String(index + 1).padStart(2, "0")}`;
          const data = byDate.get(date);
          const recorded = data && data.expenseCount > 0;
          const inRange = date >= report.range.from && date <= report.range.to;
          const label = `${analysisDate(date, locale)}: ${recorded ? `${analysisMoney(data.expenseFen, locale)}, ${labels.transactions(formatLocaleNumber(data.expenseCount, locale))}` : inRange ? labels.noRecordedExpense : labels.outsideRange}`;
          const classes = `flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-2 text-center sm:min-h-20 ${inRange ? "text-[var(--bb-ink)]" : "text-[var(--bb-muted)] opacity-40"}`;
          const content = <><span className="text-xs sm:text-sm">{index + 1}</span><span className="max-w-full truncate text-[10px] font-medium tabular-nums sm:text-xs">{recorded ? compactMoney(data.expenseFen, locale) : "—"}</span></>;
          const background = recorded ? `color-mix(in srgb, var(--bb-primary) ${8 + data.expenseFen / maximum * 28}%, var(--bb-surface))` : "var(--bb-warm-surface)";
          return recorded ? <Link aria-label={label} className={`bb-tap ${classes} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bb-primary)]`} href={analysisRecordHref(links.current.expense, analysisDateFilters(date))} key={date} style={{ background }} title={label}>{content}</Link>
            : <div aria-label={label} className={classes} key={date} style={{ background }} title={label}>{content}</div>;
        })}
      </div>
    </div>
  );
}

export function ReportCumulative({ report, locale, links }: ChartProps) {
  const labels = getMessages(locale).home.analytics;
  const points = report.cumulative;
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const index = Math.min(selectedIndex ?? Math.max(0, points.length - 1), points.length - 1);
  const selected = points[index];
  const maximum = points.reduce((max, point) => Math.max(max, point.currentFen ?? 0, point.previousFen ?? 0), 100);
  const showPrevious = report.comparisons.previous.availability === "available" || report.comparisons.previous.availability === "partial";
  const x = (position: number) => 8 + position / Math.max(1, points.length - 1) * 584;
  const y = (amount: number) => 160 - amount / maximum * 144;
  function missingPointLabel(period: "current" | "previous") {
    const range = period === "current" ? report.range : report.comparisons.previous.range;
    const days = range ? Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86400000) + 1 : 0;
    return selected && selected.dayIndex > days ? labels.periodEnded : labels.missingHistory;
  }
  function line(key: "currentFen" | "previousFen") {
    let started = false;
    return points.map((point, position) => {
      const value = point[key];
      if (value === null) { started = false; return ""; }
      const command = started ? "L" : "M";
      started = true;
      return `${command}${x(position).toFixed(2)},${y(value).toFixed(2)}`;
    }).join(" ");
  }
  return (
    <div className="space-y-4">
      <AnalysisAvailability comparison={report.comparisons.previous} locale={locale} />
      <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.cumulativeHint}</p>
      {!selected || (report.summary.expenseCount === 0 && (report.comparisons.previous.summary?.expenseCount ?? 0) === 0) ? <p className="py-5 text-sm">{labels.noExpenses}</p> : <>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs"><span className="flex items-center gap-2"><span aria-hidden="true" className="h-1 w-6 bg-[var(--bb-primary)]" />{labels.current}</span>{showPrevious ? <span className="flex items-center gap-2"><span aria-hidden="true" className="w-6 border-t-2 border-dashed border-[var(--bb-income)]" />{labels.previous}</span> : null}</div>
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
          <div aria-hidden="true" className="flex h-44 flex-col justify-between pb-2 pt-3 text-right text-xs tabular-nums text-[var(--bb-muted)]"><span>¥{compactMoney(maximum, locale)}</span><span>¥{compactMoney(maximum / 2, locale)}</span><span>0</span></div>
          <div className="min-w-0">
            <svg aria-label={labels.views.cumulative} className="h-44 w-full overflow-visible" preserveAspectRatio="none" role="img" viewBox="0 0 600 176">
              <title>{labels.views.cumulative}</title>
              {[16, 88, 160].map((position) => <line key={position} stroke="var(--bb-warm-line)" x1="8" x2="592" y1={position} y2={position} />)}
              {showPrevious ? <path d={line("previousFen")} fill="none" stroke="var(--bb-income)" strokeDasharray="7 5" strokeWidth="2.5" vectorEffect="non-scaling-stroke" /> : null}
              <path d={line("currentFen")} fill="none" stroke="var(--bb-primary)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
              <line stroke="var(--bb-line-strong)" strokeDasharray="3 4" x1={x(index)} x2={x(index)} y1="8" y2="164" />
              {selected.currentFen !== null ? <circle cx={x(index)} cy={y(selected.currentFen)} fill="var(--bb-primary)" r="4" /> : null}
              {showPrevious && selected.previousFen !== null ? <circle cx={x(index)} cy={y(selected.previousFen)} fill="var(--bb-income)" r="4" /> : null}
            </svg>
            <input aria-label={labels.cumulativePoint} aria-valuetext={`${labels.dayNumber(selected.dayIndex)}, ${labels.current} ${selected.currentFen === null ? missingPointLabel("current") : analysisMoney(selected.currentFen, locale)}${showPrevious ? `, ${labels.previous} ${selected.previousFen === null ? missingPointLabel("previous") : analysisMoney(selected.previousFen, locale)}` : ""}`} className="min-h-11 w-full accent-[var(--bb-primary)]" max={Math.max(0, points.length - 1)} min={0} onChange={(event) => setSelectedIndex(Number(event.target.value))} step={1} type="range" value={index} />
            <div aria-hidden="true" className="flex justify-between text-xs text-[var(--bb-muted)]"><span>{labels.dayNumber(points[0].dayIndex)}</span><span>{labels.dayNumber(points[points.length - 1].dayIndex)}</span></div>
          </div>
        </div>
        <div aria-live="polite" className="grid min-w-0 gap-3 rounded-xl bg-[var(--bb-warm-surface)] p-3 text-sm sm:grid-cols-2" data-testid="report-cumulative-detail">
          {(["current", "previous"] as const).filter((period) => period === "current" || showPrevious).map((period) => {
            const date = selected[`${period}Date`];
            const amount = selected[`${period}Fen`];
            const from = period === "current" ? report.range.from : report.comparisons.previous.range?.from;
            const href = period === "current" ? links.current.expense : links.previous?.expense;
            return <div className="min-w-0 space-y-1" key={period}><p className="text-xs text-[var(--bb-muted)]">{labels[period]} · {date ? analysisDate(date, locale) : missingPointLabel(period)}</p><AnalysisValue className="break-words font-semibold tabular-nums" href={href && date && from ? analysisRecordHref(href, analysisDateFilters(from, date)) : undefined}>{amount === null ? "—" : analysisMoney(amount, locale)}</AnalysisValue></div>;
          })}
        </div>
      </>}
    </div>
  );
}

export function ReportCategoryTrends({ report, type, locale, links }: ChartProps & { type: AnalyticsTransactionType }) {
  const labels = getMessages(locale).home.analytics;
  const rows = report.categoryMonths[type];
  const [selectedId, setSelectedId] = useState(rows[0]?.categoryId ?? "");
  const selected = rows.find((row) => row.categoryId === selectedId) ?? rows[0];
  const maximum = rows.reduce((max, row) => row.points.reduce((value, point) => Math.max(value, point.amountFen), max), 1);
  const selectedMax = selected?.points.reduce((max, point) => Math.max(max, point.amountFen), 1) ?? 1;
  function monthHref(categoryId: string, month: string) {
    return analysisRecordHref(links.current[type], { category: categoryId, ...analysisDateFilters(month > report.range.from.slice(0, 7) ? `${month}-01` : report.range.from, month < report.range.to.slice(0, 7) ? lastMonthDate(month) : report.range.to) });
  }
  return (
    <div className="min-w-0 space-y-4">
      {links.annual ? <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.monthTrendHint} <AnalysisValue href={links.annual}>{labels.showYear} ›</AnalysisValue></p> : null}
      <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.categoryMonthHint}</p>
      {!selected ? <p className="py-5 text-sm text-[var(--bb-muted)]">{labels.noCategories}</p> : <>
        <div className="max-h-96 min-w-0 overflow-auto rounded-xl border border-[var(--bb-warm-line)] focus-visible:outline-2 focus-visible:outline-[var(--bb-primary)]" role="region" aria-label={labels.views.annual} tabIndex={0}>
          <table className="w-full border-collapse text-xs tabular-nums">
            <thead className="sticky top-0 z-10 bg-[var(--bb-surface)]"><tr><th className="sticky left-0 min-w-24 bg-[var(--bb-surface)] px-3 py-3 text-left font-medium">{labels.category}</th>{report.categoryMonths.months.map((month) => <th className="min-w-24 whitespace-nowrap px-2 py-3 text-right font-medium" key={month}>{monthLabel(month, locale)}</th>)}</tr></thead>
            <tbody>{rows.map((row) => <tr className="border-t border-[var(--bb-warm-line)]" key={row.categoryId}><th className="sticky left-0 bg-[var(--bb-surface)] px-3 py-2 text-left font-medium"><button aria-pressed={selected.categoryId === row.categoryId} className={`bb-tap min-h-11 text-left ${selected.categoryId === row.categoryId ? "text-[var(--bb-primary)]" : ""}`} onClick={() => setSelectedId(row.categoryId)} type="button">{getCategoryDisplayName(row.categoryName, locale)}</button></th>{row.points.map((point) => <td className="px-1 py-1 text-right" key={point.month}>{point.transactionCount > 0 ? <Link aria-label={`${getCategoryDisplayName(row.categoryName, locale)}, ${monthLabel(point.month, locale)}, ${analysisMoney(point.amountFen, locale)}, ${labels.transactions(formatLocaleNumber(point.transactionCount, locale))}`} className="bb-tap flex min-h-11 items-center justify-end rounded-lg px-2 underline decoration-[var(--bb-line-strong)] underline-offset-4 focus-visible:outline-2 focus-visible:outline-[var(--bb-primary)]" href={monthHref(row.categoryId, point.month)} style={{ background: `color-mix(in srgb, var(--bb-primary) ${8 + point.amountFen / maximum * 28}%, var(--bb-surface))` }}>{analysisMoney(point.amountFen, locale)}</Link> : <span className="block px-2 text-[var(--bb-muted)]" aria-label={labels.noData}>—</span>}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <div className="space-y-3 rounded-xl bg-[var(--bb-warm-surface)] p-3">
          <IosSelect aria-label={labels.category} className="w-full sm:w-auto sm:min-w-52" onChange={(event) => setSelectedId(event.target.value)} options={rows.map((row) => ({ value: row.categoryId, label: getCategoryDisplayName(row.categoryName, locale) }))} value={selected.categoryId} variant="pill" />
          <h3 className="text-sm font-semibold">{labels.categoryTrend(getCategoryDisplayName(selected.categoryName, locale))}</h3>
          <ul className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {selected.points.map((point) => <li className="space-y-1.5" key={point.month}><div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs tabular-nums"><span>{monthLabel(point.month, locale)}</span><AnalysisValue href={point.transactionCount > 0 ? monthHref(selected.categoryId, point.month) : undefined}>{analysisMoney(point.amountFen, locale)}</AnalysisValue></div><div aria-hidden="true" className="h-2 rounded-full bg-[var(--bb-surface)]"><div className="h-2 rounded-full bg-[var(--bb-primary)]" style={{ width: `${point.amountFen / selectedMax * 100}%` }} /></div></li>)}
          </ul>
        </div>
      </>}
    </div>
  );
}

export function ReportDistribution({ report, locale, links }: ChartProps) {
  const labels = getMessages(locale).home.analytics;
  const data = report.distribution;
  const maximum = Math.max(1, ...data.buckets.map((bucket) => bucket.transactionCount));
  if (data.expenseCount === 0) return <p className="py-5 text-sm text-[var(--bb-muted)]">{labels.noExpenses}</p>;
  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.distributionHint}</p>
      <dl className="grid gap-3 rounded-xl bg-[var(--bb-warm-surface)] p-3 sm:grid-cols-3">
        <div className="min-w-0"><dt className="text-xs text-[var(--bb-muted)]">{labels.median}</dt><dd className="mt-1 break-words font-semibold tabular-nums">{data.medianFen === null ? "—" : analysisMoney(data.medianFen, locale)}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-[var(--bb-muted)]">{labels.maximum}</dt><dd className="mt-1 break-words font-semibold tabular-nums"><AnalysisValue href={links.maximumExpense}>{data.maxFen === null ? "—" : analysisMoney(data.maxFen, locale)}</AnalysisValue></dd></div>
        <div className="min-w-0"><dt className="text-xs text-[var(--bb-muted)]">{labels.topFive}</dt><dd className="mt-1 font-semibold tabular-nums">{data.topFiveShare === null ? "—" : analysisPercent(data.topFiveShare, locale)}</dd></div>
      </dl>
      <ul className="space-y-4" data-testid="report-distribution">
        {data.buckets.map((bucket) => {
          const label = labels.buckets[bucket.key as keyof typeof labels.buckets];
          const content = <><div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm"><span className="font-medium">{label}</span><span className="text-xs tabular-nums text-[var(--bb-muted)]">{labels.transactions(formatLocaleNumber(bucket.transactionCount, locale))} · {analysisMoney(bucket.amountFen, locale)}</span></div><div aria-hidden="true" className="mt-2 h-3 overflow-hidden rounded-full bg-[var(--bb-warm-surface)]"><div className="h-full rounded-full bg-[var(--bb-primary)]" style={{ width: `${bucket.transactionCount / maximum * 100}%` }} /></div></>;
          return <li key={bucket.key}>{bucket.transactionCount > 0 && links.distribution[bucket.key] ? <Link className="bb-tap block min-h-11 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bb-primary)]" href={links.distribution[bucket.key]}>{content}</Link> : <div>{content}</div>}</li>;
        })}
      </ul>
      <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.topFiveNote}</p>
    </div>
  );
}
