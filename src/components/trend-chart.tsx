import Link from "next/link";
import type { ReportTrendPoint } from "@/lib/reports/aggregate";

type TrendChartProps = {
  getPointHref?: (point: ReportTrendPoint) => string | undefined;
  granularity: "day" | "month";
  points: ReportTrendPoint[];
};

export function TrendChart({ getPointHref, granularity, points }: TrendChartProps) {
  const maxAmount = points.reduce(
    (currentMax, point) => Math.max(currentMax, point.incomeFen, point.expenseFen),
    0,
  );
  const chartHeight = 160;

  if (points.length === 0) {
    return (
      <section className="ios-panel p-5 min-w-0">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold text-stone-900">Trend</h2>
          <p className="text-sm text-stone-500">No activity yet for the selected filters.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="ios-panel p-5 min-w-0">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold text-stone-900">Trend</h2>
          <p className="text-sm text-stone-500">
            {granularity === "month" ? "Monthly" : "Daily"} income and expense totals.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-xs text-stone-500">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            Income
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-stone-400" />
            Expense
          </span>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto">
        <ul className="flex min-w-max items-end gap-3 pb-1">
          {points.map((point) => {
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
                  <p className="text-[11px] font-medium text-stone-700">{point.label}</p>
                  <p className="text-[11px] text-stone-500">{point.transactionCount} tx</p>
                </div>
              </>
            );

            return (
              <li key={point.bucketKey}>
                {href ? (
                  <Link
                    className="block rounded-xl px-1 py-2 transition hover:bg-stone-50"
                    href={href}
                    title={`${point.label}: income ${point.incomeFen / 100}, expense ${point.expenseFen / 100}`}
                  >
                    {content}
                  </Link>
                ) : (
                  <div
                    className="rounded-xl px-1 py-2"
                    title={`${point.label}: income ${point.incomeFen / 100}, expense ${point.expenseFen / 100}`}
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
