"use client";

import { useState } from "react";
import { TrendChartPlot, type TrendChartPlotLabels, type TrendPoint, type TrendView } from "@/components/trend-chart-plot";
import type { Locale } from "@/lib/i18n";

type TrendChartViewsProps = {
  contextKey?: string;
  labels: TrendChartPlotLabels & {
    balance: string;
    balanceFooter: string;
    balanceNote: string;
    cashflow: string;
    cashflowNote: string;
    cumulative: string;
    cumulativeFooter: string;
    cumulativeNote: string;
    cumulativeTotal: string;
    empty: string;
    monthHint: string;
    net: string;
    selectedExpense: string;
    title: string;
    viewLabel: string;
    viewMonthRecords: string;
  };
  locale: Locale;
  monthlyPoints: (TrendPoint & { cumulativeNetFen: number; netFen: number })[];
  points: TrendPoint[];
};

export function TrendChartViews({ contextKey, labels, locale, monthlyPoints, points }: TrendChartViewsProps) {
  const [view, setView] = useState<TrendView>("cashflow");
  const activePoints = view === "cashflow" ? points : monthlyPoints;
  const lastMonth = monthlyPoints.at(-1);
  const valueFen = view === "cashflow" ? points.reduce((sum, point) => sum + point.expenseFen, 0)
    : view === "cumulative" ? lastMonth?.cumulativeNetFen ?? 0 : lastMonth?.netFen ?? 0;
  const valueLabel = view === "cashflow" ? labels.selectedExpense : view === "cumulative" ? labels.cumulativeTotal
    : [lastMonth?.label, labels.net].filter(Boolean).join(" · ");
  const note = view === "cashflow" ? labels.cashflowNote : view === "balance" ? labels.balanceNote : labels.cumulativeNote;
  const noRecords = !activePoints.some((point) => point.transactionCount > 0);
  const numberFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <section className="ios-panel min-w-0 p-4" data-testid="trend-card">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium text-[var(--bb-ink)]">{labels.title}</h2>
        <div aria-label={labels.viewLabel} className="bb-segmented bb-segmented--three bb-segmented--neutral grid w-full min-w-0 grid-cols-3 gap-1 rounded-xl bg-[var(--bb-warm-surface)] p-1 sm:w-auto" role="group">
          {(["cashflow", "balance", "cumulative"] as const).map((item) => (
            <button
              aria-pressed={view === item}
              className={`bb-tap min-h-11 min-w-0 rounded-lg px-2 py-2 text-[11px] leading-4 sm:px-3 sm:text-xs ${view === item ? "text-[var(--bb-ink)]" : "text-[var(--bb-muted)] hover:text-[var(--bb-ink)]"}`}
              key={item}
              onClick={() => setView(item)}
              type="button"
            >{labels[item]}</button>
          ))}
        </div>
      </div>

      <div className="mt-5 flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-[11px] text-[var(--bb-muted)]">{valueLabel}</p>
          <p className={`mt-1 break-all text-[clamp(1.25rem,5vw,1.75rem)] font-normal leading-tight tabular-nums ${valueFen < 0 ? "text-[var(--bb-danger)]" : "text-[var(--bb-ink)]"}`}>
            {valueFen < 0 ? "−" : ""}<span className="mr-1 text-[0.7em]">¥</span>{numberFormat.format(Math.abs(valueFen) / 100)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--bb-muted)]">
          {view === "cashflow" ? <>
            <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--bb-income)]" />{labels.income}</span>
            <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--bb-coral)]" />{labels.expense}</span>
          </> : <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--bb-primary)]" />{view === "balance" ? labels.net : labels.cumulative}</span>}
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-[var(--bb-muted)]">{note}</p>

      {activePoints.length > 0 ? (
        <TrendChartPlot
          key={JSON.stringify([contextKey, view, activePoints])}
          labels={{ ...labels, hint: view === "cashflow" ? labels.hint : labels.monthHint, viewRecords: view === "cashflow" ? labels.viewRecords : labels.viewMonthRecords }}
          locale={locale}
          points={activePoints}
          view={view}
        />
      ) : null}
      {noRecords ? <p className="mt-3 text-xs leading-5 text-[var(--bb-muted)]">{labels.empty}</p> : null}
      {view !== "cashflow" ? <p className="mt-3 text-[11px] leading-5 text-[var(--bb-muted)]">{view === "balance" ? labels.balanceFooter : labels.cumulativeFooter}</p> : null}
    </section>
  );
}
