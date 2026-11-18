import { TrendChartViews } from "@/components/trend-chart-views";
import { getMessages, type Locale } from "@/lib/i18n";
import type { ReportBalanceTrendPoint, ReportTrendPoint } from "@/lib/reports/aggregate";

type TrendChartProps = {
  contextKey?: string;
  getPointHref?: (point: ReportTrendPoint) => string | undefined;
  granularity: "day" | "month";
  labels: {
    empty: string;
    expense: string;
    income: string;
    title: string;
    tx: string;
  };
  locale: Locale;
  monthlyPoints: ReportBalanceTrendPoint[];
  points: ReportTrendPoint[];
};

export function TrendChart({ contextKey, getPointHref, granularity, labels, locale, monthlyPoints, points }: TrendChartProps) {
  const messages = getMessages(locale);
  const monthFormatter = new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "Asia/Shanghai" });
  const dayFormatter = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "Asia/Shanghai" });
  const dateFormatter = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Shanghai" });

  function serializePoint(point: ReportTrendPoint, pointGranularity: "day" | "month") {
    const fromLabel = dateFormatter.format(point.bucketStart);
    const toLabel = dateFormatter.format(point.bucketEnd);
    return {
      key: point.bucketKey,
      label: (pointGranularity === "day" ? dayFormatter : monthFormatter).format(point.bucketStart),
      axisLabel: new Intl.DateTimeFormat(locale, {
        day: pointGranularity === "day" ? "numeric" : undefined,
        month: pointGranularity === "month" ? "2-digit" : undefined,
        year: pointGranularity === "month" ? "2-digit" : undefined,
        timeZone: "Asia/Shanghai",
      }).format(point.bucketStart),
      rangeLabel: fromLabel === toLabel ? fromLabel : `${fromLabel} – ${toLabel}`,
      incomeFen: point.incomeFen,
      expenseFen: point.expenseFen,
      netFen: point.netFen,
      transactionCount: point.transactionCount,
      href: point.transactionCount > 0 ? getPointHref?.(point) : undefined,
    };
  }

  return (
    <TrendChartViews
      contextKey={contextKey}
      labels={{
        ...labels,
        cashflow: messages.trend.cashflow,
        balance: messages.trend.balance,
        cumulative: messages.trend.cumulative,
        viewLabel: messages.trend.viewLabel,
        net: messages.trend.net,
        selectedExpense: messages.ui.selectedRangeExpense,
        cumulativeTotal: messages.trend.cumulativeTotal,
        cashflowNote: granularity === "day" ? messages.trend.cashflowDayNote : messages.trend.cashflowMonthNote,
        balanceNote: messages.trend.balanceNote,
        cumulativeNote: messages.trend.cumulativeNote,
        balanceFooter: messages.trend.balanceFooter,
        cumulativeFooter: messages.trend.cumulativeFooter,
        hint: messages.ui.trendHint,
        monthHint: messages.trend.monthHint,
        unit: messages.ui.currencyUnit,
        viewRecords: messages.ui.viewRecords,
        viewMonthRecords: messages.trend.viewMonthRecords,
      }}
      locale={locale}
      monthlyPoints={monthlyPoints.map((point) => ({ ...serializePoint(point, "month"), cumulativeNetFen: point.cumulativeNetFen }))}
      points={points.map((point) => serializePoint(point, granularity))}
    />
  );
}
