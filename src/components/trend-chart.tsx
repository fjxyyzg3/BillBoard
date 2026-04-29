import Link from "next/link";
import type { Locale } from "@/lib/i18n";
import type { ReportTrendPoint } from "@/lib/reports/aggregate";

type TrendChartProps = {
  getPointHref?: (point: ReportTrendPoint) => string | undefined;
  granularity: "day" | "month";
  labels: {
    daily: string;
    empty: string;
    expense: string;
    income: string;
    monthly: string;
    title: string;
    tx: string;
  };
  locale: Locale;
  points: ReportTrendPoint[];
};

function formatPointLabel(point: ReportTrendPoint, granularity: "day" | "month", locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    day: granularity === "day" ? "numeric" : undefined,
    month: "short",
    timeZone: "Asia/Shanghai",
    year: granularity === "month" ? "2-digit" : undefined,
  }).format(point.bucketStart);
}

export function TrendChart({ getPointHref, granularity, labels, locale, points }: TrendChartProps) {
  const maxAmount = points.reduce(
    (currentMax, point) => Math.max(currentMax, point.incomeFen, point.expenseFen),
    0,
  );
  const chartHeight = 160;

  if (points.length === 0) {
    return (
      <section className="ios-panel p-5 min-w-0">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold text-stone-900">{labels.title}</h2>
          <p className="text-sm text-stone-500">{labels.empty}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="ios-panel p-5 min-w-0">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold text-stone-900">{labels.title}</h2>
          <p className="text-sm text-stone-500">
            {granularity === "month" ? labels.monthly : labels.daily}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-xs text-stone-500">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            {labels.income}
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-stone-400" />
            {labels.expense}
          </span>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto">
        <ul className="flex min-w-max items-end gap-3 pb-1">
          {points.map((point) => {
            const pointLabel = formatPointLabel(point, granularity, locale);
            const incomeHeight =
              maxAmount === 0 ? 0 : Math.max(8, Math.round((point.incomeFen / maxAmount) * chartHeight));
            const expenseHeight =
              maxAmount === 0 ? 0 : Math.max(8, Math.round((point.expenseFen / maxAmount) * chartHeight));
            const href = getPointHref?.(point);
            const content = (
              <>
                <div className="flex h-40 items-end justify-center gap-1">
                  <span
                    className="w-3 rounded-t-full bg-emerald-500/90"
                    style={{ height: point.incomeFen === 0 ? 0 : `${incomeHeight}px` }}
                  />
                  <span
                    className="w-3 rounded-t-full bg-stone-400"
                    style={{ height: point.expenseFen === 0 ? 0 : `${expenseHeight}px` }}
                  />
                </div>
                <div className="mt-3 text-center">
                  <p className="text-[11px] font-medium text-stone-700">{pointLabel}</p>
                  <p className="text-[11px] text-stone-500">
                    {point.transactionCount} {labels.tx}
                  </p>
                </div>
              </>
            );

            return (
              <li key={point.bucketKey}>
                {href ? (
                  <Link
                    className="block rounded-xl px-1 py-2 transition hover:bg-stone-50"
                    href={href}
                    title={`${pointLabel}: ${labels.income} ${point.incomeFen / 100}, ${labels.expense} ${point.expenseFen / 100}`}
                  >
                    {content}
                  </Link>
                ) : (
                  <div
                    className="rounded-xl px-1 py-2"
                    title={`${pointLabel}: ${labels.income} ${point.incomeFen / 100}, ${labels.expense} ${point.expenseFen / 100}`}
                  >
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
