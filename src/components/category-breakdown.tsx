import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { CategoryListExpander } from "@/components/category-list-expander";
import { CategoryIconBadge } from "@/components/category-icon-badge";
import { getCategoryChartColor } from "@/lib/category-palette";
import { formatLocaleNumber, getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";

type CategoryBreakdownItem = {
  amountFen: number;
  categoryId: string;
  categoryName: string;
  share: number;
  transactionCount: number;
};

type CategoryBreakdownProps = {
  getCategoryHref: (item: CategoryBreakdownItem) => string;
  headerAction?: ReactNode;
  items: CategoryBreakdownItem[];
  labels: {
    empty: string;
    otherCategory: string;
    title: string;
    transactionCount: (countLabel: string, count: number) => string;
  };
  locale: Locale;
  summaryLabel?: string;
  totalExpenseLabel: (amountFen: number) => string;
};

type ChartSegment = {
  color: string;
  key: string;
  label: string;
  share: number;
};

type ChartArc = ChartSegment & {
  strokeLength: number;
  strokeOffset: number;
};

function formatPercent(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(value);
}

function getRowColor(item: CategoryBreakdownItem, index: number) {
  return getCategoryChartColor(item.categoryName, index);
}

function buildChartSegments(
  items: CategoryBreakdownItem[],
  locale: Locale,
  otherCategory: string,
) {
  const totalAmountFen = items.reduce((sum, item) => sum + item.amountFen, 0);
  let cumulativeShare = 0;
  const visibleItems: CategoryBreakdownItem[] = [];

  for (const item of items) {
    const share = totalAmountFen === 0 ? 0 : item.amountFen / totalAmountFen;

    visibleItems.push(item);
    cumulativeShare += share;

    if (cumulativeShare >= 0.9 && visibleItems.length < items.length) {
      break;
    }
  }

  const otherItems = items.slice(visibleItems.length);
  const segments: ChartSegment[] = visibleItems.map((item, index) => ({
    color: getCategoryChartColor(item.categoryName, index),
    key: item.categoryId,
    label: getCategoryDisplayName(item.categoryName, locale),
    share: totalAmountFen === 0 ? 0 : item.amountFen / totalAmountFen,
  }));
  const otherAmountFen = otherItems.reduce((sum, item) => sum + item.amountFen, 0);

  if (otherAmountFen > 0) {
    segments.push({
      color: getCategoryChartColor("Other", segments.length),
      key: "other",
      label: otherCategory,
      share: totalAmountFen === 0 ? 0 : otherAmountFen / totalAmountFen,
    });
  }

  return segments;
}

function buildChartArcs(segments: ChartSegment[], circumference: number) {
  return segments.reduce<{ arcs: ChartArc[]; offset: number }>(
    (current, segment) => {
      const strokeLength = Math.max(segment.share * circumference - 1.5, 0);
      const arc: ChartArc = {
        ...segment,
        strokeLength,
        strokeOffset: -current.offset,
      };

      return {
        arcs: [...current.arcs, arc],
        offset: current.offset + segment.share * circumference,
      };
    },
    { arcs: [], offset: 0 },
  ).arcs;
}

function categoryColorStyle(color: string): CSSProperties {
  return { "--category-color": color } as CSSProperties;
}

export function CategoryBreakdown({
  getCategoryHref,
  headerAction,
  items,
  labels,
  locale,
  summaryLabel,
  totalExpenseLabel,
}: CategoryBreakdownProps) {
  const chartSegments = buildChartSegments(items, locale, labels.otherCategory);
  const circumference = 2 * Math.PI * 52;
  const chartArcs = buildChartArcs(chartSegments, circumference);
  const ui = getMessages(locale).ui;
  const categoryRows = items.map((item, index) => {
    const rowColor = getRowColor(item, index);

    return (
      <Link
        className="block min-w-0 rounded-xl px-1 py-2.5 transition-colors hover:bg-[var(--bb-warm-surface)] active:bg-[var(--bb-accent-soft)]"
        href={getCategoryHref(item)}
        key={item.categoryId}
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-[var(--bb-ink)]">
              <CategoryIconBadge categoryName={item.categoryName} className="h-7 w-7" iconClassName="h-4 w-4" />
              <span className="truncate">{getCategoryDisplayName(item.categoryName, locale)}</span>
            </p>
            <p className="mt-0.5 text-xs text-[var(--bb-muted)]">
              {labels.transactionCount(
                formatLocaleNumber(item.transactionCount, locale),
                item.transactionCount,
              )}
              <span className="mx-1.5" aria-hidden="true">·</span>
              {formatPercent(item.share, locale)}
            </p>
          </div>
          <p className="ios-amount whitespace-nowrap text-right text-sm font-medium text-[var(--bb-ink)]">
            {totalExpenseLabel(item.amountFen)}
          </p>
        </div>
        <div className="mt-2 h-1 rounded-full bg-[var(--bb-warm-surface)]">
          <div
            className="h-1 rounded-full bg-[var(--category-color)]"
            data-testid="category-row-progress"
            style={{
              ...categoryColorStyle(rowColor),
              width: `${item.share * 100}%`,
              minWidth: item.share > 0 ? "2px" : "0",
            }}
          />
        </div>
      </Link>
    );
  });

  return (
    <section className="ios-panel min-w-0 p-4 sm:p-5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 className="min-w-0 text-[15px] font-medium text-[var(--bb-ink)]">{labels.title}</h2>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>
      {summaryLabel ? <p className="mt-1.5 text-xs leading-5 text-[var(--bb-muted)]">{summaryLabel}</p> : null}

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--bb-muted)]">{labels.empty}</p>
      ) : (
        <div className="mt-3 space-y-4">
          <div aria-hidden="true" className="hidden space-y-3 rounded-2xl bg-stone-50/80 p-3 md:block" data-testid="category-donut-chart">
            <svg className="mx-auto block h-36 w-36" viewBox="0 0 140 140">
              <circle
                cx="70"
                cy="70"
                fill="none"
                r="52"
                stroke="#eee9e3"
                strokeWidth="22"
              />
              {chartArcs.map((arc) => (
                <circle
                  cx="70"
                  cy="70"
                  fill="none"
                  key={arc.key}
                  r="52"
                  stroke={arc.color}
                  strokeDasharray={`${arc.strokeLength} ${circumference}`}
                  strokeDashoffset={arc.strokeOffset}
                  strokeWidth="22"
                  transform="rotate(-90 70 70)"
                />
              ))}
              <circle cx="70" cy="70" fill="#ffffff" r="35" />
            </svg>
            <ul className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 text-xs leading-5 text-[var(--bb-muted)]">
              {chartSegments.map((segment) => (
                <li className="flex min-w-0 items-start gap-1.5" key={segment.key} style={categoryColorStyle(segment.color)}>
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--category-color)]" />
                  <span className="min-w-0 break-words tabular-nums" data-testid="category-chart-label">
                    {segment.label} {formatPercent(segment.share, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <CategoryListExpander
            key={`${locale}:${items.map((item) => item.categoryId).join("|")}`}
            rows={categoryRows}
            showAllLabel={ui.showAllCategories}
            showLessLabel={ui.showLessCategories}
          />
        </div>
      )}
    </section>
  );
}
