import { CategoryBreakdown } from "@/components/category-breakdown";
import { MemberFilter } from "@/components/member-filter";
import { Reveal } from "@/components/motion-primitives";
import { ReportAnalytics } from "@/components/report-analytics";
import { ReportRangeControls } from "@/components/report-range-controls";
import { SummaryCard } from "@/components/summary-card";
import { TrendChart } from "@/components/trend-chart";
import { formatLocaleNumber, getMessages } from "@/lib/i18n";
import { formatFen } from "@/lib/money";
import { buildMemberFilterOptions } from "@/lib/records/member-filter";
import Link from "next/link";
import type { loadHomePage } from "./loader";

function buildPageHref(
  pathname: string,
  sharedParams: URLSearchParams,
  extras?: Record<string, string | undefined>,
) {
  const params = new URLSearchParams(sharedParams.toString());

  for (const [key, value] of Object.entries(extras ?? {})) {
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  }

  const query = params.toString();

  return query ? `${pathname}?${query}` : pathname;
}

function buildRecordsHref(
  sharedParams: URLSearchParams,
  extras?: Record<string, string | undefined>,
) {
  return buildPageHref("/records", sharedParams, { sort: "amount-desc", ...extras });
}

function formatSignedFen(fen: number) {
  if (fen === 0) {
    return "0.00";
  }

  return `${fen < 0 ? "-" : ""}${formatFen(Math.abs(fen))}`;
}


export function HomeView({ data }: { data: Awaited<ReturnType<typeof loadHomePage>> }) {
  const { locale, report, householdMembers, actorMemberId, sharedParams, analytics, analyticsLinks, recordsHref, fullWidthSecondary, categoryType, categoryData, categoryEmpty, categorySummaryLabel } = data;
  const messages = getMessages(locale);
  const categoryLabels = messages.home.categories;
  return (
    <section className="space-y-4">
      <Reveal>
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h1 className="sr-only">{messages.home.title}</h1>
          <ReportRangeControls
            closeLabel={messages.common.close}
            labels={messages.home.range}
            locale={locale}
            rangeOptions={report.rangeOptions}
            selection={report.range}
            variant="heading"
          />
          <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--bb-muted)]">
            {report.range.mode === "month" ? <><span>{report.range.month.slice(0, 4)}</span><span aria-hidden="true">·</span></> : null}
            <MemberFilter compact members={buildMemberFilterOptions(householdMembers, locale)} actorMemberId={actorMemberId} locale={locale} />
          </div>
        </header>
      </Reveal>

      <Reveal delay={0.05}>
        <div className="ios-panel relative grid grid-cols-2 overflow-hidden" data-testid="summary-grid">
          <SummaryCard
            featured
            joined
            href={buildRecordsHref(sharedParams, { type: "expense" })}
            title={messages.ui.selectedRangeExpense}
            tone="expense"
            value={formatFen(report.summary.expenseFen)}
            viewLabel={messages.common.view}
          />
          <SummaryCard
            joined
            fullWidth={fullWidthSecondary}
            href={buildRecordsHref(sharedParams, { type: "income" })}
            title={messages.home.summary.incomeTitle}
            tone="income"
            value={formatFen(report.summary.incomeFen)}
            viewLabel={messages.common.view}
          />
          <SummaryCard
            joined
            fullWidth={fullWidthSecondary}
            href={recordsHref}
            title={messages.home.summary.netTitle}
            tone={report.summary.netFen < 0 ? "deficit" : "neutral"}
            value={formatSignedFen(report.summary.netFen)}
            viewLabel={messages.common.view}
          />
          <Link className="bb-tap absolute right-4 top-4 inline-flex min-h-11 max-w-[45%] items-center text-right text-xs text-[var(--bb-muted)] hover:text-[var(--bb-primary)]" href={recordsHref}>
            {messages.home.transactionCount(
              formatLocaleNumber(report.summary.transactionCount, locale),
              report.summary.transactionCount,
            )} ›
          </Link>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <TrendChart
            contextKey={sharedParams.toString()}
            getPointHref={(point) => {
              if (point.transactionCount === 0) {
                return undefined;
              }

              return buildRecordsHref(sharedParams, {
                from: point.bucketStart.toISOString(),
                to: point.bucketEnd.toISOString(),
              });
            }}
            granularity={report.trend.granularity}
            labels={{
              empty: messages.trend.empty,
              expense: messages.trend.expense,
              income: messages.trend.income,
              title: messages.trend.title,
              tx: messages.common.tx,
            }}
            locale={locale}
            monthlyPoints={report.balanceTrend.points}
            points={report.trend.points}
          />
          <CategoryBreakdown
            getCategoryHref={(item) =>
              buildRecordsHref(sharedParams, {
                category: item.categoryId,
                type: categoryType,
              })
            }
            headerAction={
              <div className="bb-category-type-switch bb-segmented bb-segmented--spaced bb-segmented--neutral bb-segmented--pill grid grid-cols-2 gap-1 rounded-full bg-[var(--bb-warm-surface)] p-1">
                <Link
                  aria-current={categoryType === "expense" ? "page" : undefined}
                  className={`bb-tap inline-flex min-h-11 items-center justify-center rounded-full px-3 text-xs font-medium ${categoryType === "expense"
                      ? "text-[var(--bb-ink)]"
                      : "text-[var(--bb-muted)] hover:text-[var(--bb-ink)]"
                    }`}
                  href={buildPageHref("/home", sharedParams)}
                  scroll={false}
                >
                  {categoryLabels.expenseTab}
                </Link>
                <Link
                  aria-current={categoryType === "income" ? "page" : undefined}
                  className={`bb-tap inline-flex min-h-11 items-center justify-center rounded-full px-3 text-xs font-medium ${categoryType === "income"
                      ? "text-[var(--bb-ink)]"
                      : "text-[var(--bb-muted)] hover:text-[var(--bb-ink)]"
                    }`}
                  href={buildPageHref("/home", sharedParams, { categoryType: "income" })}
                  scroll={false}
                >
                  {categoryLabels.incomeTab}
                </Link>
              </div>
            }
            items={categoryData.items}
            labels={{
              empty: categoryEmpty,
              otherCategory: categoryLabels.otherCategory,
              title: categoryLabels.title,
              transactionCount: categoryLabels.transactionCount,
            }}
            locale={locale}
            summaryLabel={categorySummaryLabel}
            totalExpenseLabel={(amountFen) => formatFen(amountFen)}
          />
        </div>
      </Reveal>
      <Reveal delay={0.15}>
        <ReportAnalytics
          links={analyticsLinks}
          locale={locale}
          range={report.range}
          report={analytics}
        />
      </Reveal>
    </section>
  );
}
