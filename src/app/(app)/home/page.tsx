import Link from "next/link";
import { CategoryBreakdown } from "@/components/category-breakdown";
import { PerspectiveToggle } from "@/components/perspective-toggle";
import { RecentTransactions } from "@/components/recent-transactions";
import { SummaryCard } from "@/components/summary-card";
import { TimeRangeSelector } from "@/components/time-range-selector";
import { TrendChart } from "@/components/trend-chart";
import { requireAppSession } from "@/lib/auth/session";
import { formatLocaleNumber, getMessages, type Locale } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { formatFen } from "@/lib/money";
import { parsePerspective } from "@/lib/perspective";
import { parseRangePreset } from "@/lib/range-preset";
import type { ReportTransaction } from "@/lib/reports/aggregate";
import { queryDashboard } from "@/lib/reports/query-dashboard";

type HomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function readParam(
  params: Record<string, string | string[] | undefined> | undefined,
  key: string,
) {
  const value = params?.[key];

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function buildSharedParams(range: string, perspective: string) {
  const params = new URLSearchParams();

  params.set("range", range);

  if (perspective !== "household") {
    params.set("perspective", perspective);
  }

  return params;
}

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

function formatSignedFen(fen: number) {
  if (fen === 0) {
    return "0.00";
  }

  return `${fen < 0 ? "-" : ""}${formatFen(Math.abs(fen))}`;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const user = await requireAppSession();
  const locale = await getServerLocale();
  const messages = getMessages(locale);
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const rangePreset = parseRangePreset(readParam(resolvedSearchParams, "range"));
  const perspective = parsePerspective(readParam(resolvedSearchParams, "perspective"));
  const dashboard = await queryDashboard({
    currentMemberId: user.memberId,
    householdId: user.householdId,
    perspective,
    rangePreset,
  });
  const sharedParams = buildSharedParams(rangePreset, perspective);
  const recordsHref = buildPageHref("/records", sharedParams);
  const addHref = buildPageHref("/add", sharedParams);

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ios-muted)]">
            {messages.home.eyebrow}
          </p>
          <h1 className="text-3xl font-semibold tracking-[-0.01em] text-[var(--ios-text)]">
            {messages.home.title}
          </h1>
          <p className="text-sm text-stone-500">{messages.home.description}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <TimeRangeSelector labels={messages.range} />
          <Link
            className="inline-flex items-center justify-center rounded-full bg-[var(--ios-blue)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-600"
            href={addHref}
          >
            {messages.home.addTransaction}
          </Link>
        </div>
      </header>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <PerspectiveToggle labels={messages.perspective} />
        <p className="text-sm text-stone-500">
          {messages.home.transactionCount(
            formatLocaleNumber(dashboard.summary.transactionCount, locale),
            dashboard.summary.transactionCount,
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="summary-grid">
        <SummaryCard
          detail={messages.home.summary.incomeDetail}
          href={buildPageHref("/records", sharedParams, { type: "income" })}
          title={messages.home.summary.incomeTitle}
          tone="income"
          value={formatFen(dashboard.summary.incomeFen)}
          viewLabel={messages.common.view}
        />
        <SummaryCard
          detail={messages.home.summary.expenseDetail}
          href={buildPageHref("/records", sharedParams, { type: "expense" })}
          title={messages.home.summary.expenseTitle}
          tone="expense"
          value={formatFen(dashboard.summary.expenseFen)}
          viewLabel={messages.common.view}
        />
        <SummaryCard
          detail={messages.home.summary.netDetail}
          href={recordsHref}
          title={messages.home.summary.netTitle}
          value={formatSignedFen(dashboard.summary.netFen)}
          viewLabel={messages.common.view}
        />
        <SummaryCard
          detail={messages.home.summary.transactionsDetail}
          href={recordsHref}
          title={messages.home.summary.transactionsTitle}
          value={formatLocaleNumber(dashboard.summary.transactionCount, locale)}
          viewLabel={messages.common.view}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <TrendChart
          getPointHref={(point) => {
            if (point.transactionCount === 0) {
              return undefined;
            }

            return buildPageHref("/records", sharedParams, {
              from: point.bucketStart.toISOString(),
              to: point.bucketEnd.toISOString(),
            });
          }}
          granularity={dashboard.trend.granularity}
          labels={{
            daily: messages.trend.daily,
            empty: messages.trend.empty,
            expense: messages.trend.expense,
            income: messages.trend.income,
            monthly: messages.trend.monthly,
            title: messages.trend.title,
            tx: messages.common.tx,
          }}
          locale={locale}
          points={dashboard.trend.points}
        />
        <CategoryBreakdown
          getCategoryHref={(item) =>
            buildPageHref("/records", sharedParams, {
              category: item.categoryId,
              type: "expense",
            })
          }
          items={dashboard.categories.items}
          labels={messages.categories}
          locale={locale}
          totalExpenseLabel={(amountFen) => formatFen(amountFen)}
        />
      </div>

      <RecentTransactions
        getRecordHref={(transaction: ReportTransaction) =>
          buildPageHref("/records", sharedParams, { record: transaction.id })
        }
        items={dashboard.recentTransactions}
        labels={{
          common: {
            actor: messages.common.actor,
            createdBy: messages.common.createdBy,
            expense: messages.common.expense,
            income: messages.common.income,
            noNote: messages.common.noNote,
          },
          recent: messages.recent,
        }}
        locale={locale}
      />
    </section>
  );
}
