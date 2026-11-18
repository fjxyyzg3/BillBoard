import type { HomeReport, ReportBalanceTrendPoint } from "@/lib/reports/aggregate";
import type { ReportRange } from "@/lib/reports/report-range";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function buildMonthlyBalanceTrend({ trend, range }: {
  trend: HomeReport["trend"];
  range: Pick<ReportRange, "from" | "to">;
}): HomeReport["balanceTrend"] {
  const monthFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "Asia/Shanghai",
    year: "2-digit",
  });
  const byMonth = new Map<string, ReportBalanceTrendPoint>();

  for (const point of [...trend.points].sort((left, right) => left.bucketStart.getTime() - right.bucketStart.getTime())) {
    const start = Math.max(point.bucketStart.getTime(), range.from.getTime());
    const end = Math.min(point.bucketEnd.getTime(), range.to.getTime());
    if (start > end) continue;

    const shanghaiDate = new Date(start + SHANGHAI_OFFSET_MS);
    const year = shanghaiDate.getUTCFullYear();
    const month = shanghaiDate.getUTCMonth();
    const bucketKey = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
    const current = byMonth.get(bucketKey);

    if (current) {
      current.incomeFen += point.incomeFen;
      current.expenseFen += point.expenseFen;
      current.netFen = current.incomeFen - current.expenseFen;
      current.transactionCount += point.transactionCount;
      continue;
    }

    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month, 1);
    calendar.setUTCHours(0, 0, 0, 0);
    const monthStart = calendar.getTime() - SHANGHAI_OFFSET_MS;
    calendar.setUTCMonth(month + 1);
    const monthEnd = calendar.getTime() - SHANGHAI_OFFSET_MS - 1;
    const bucketStart = new Date(Math.max(monthStart, range.from.getTime()));

    byMonth.set(bucketKey, {
      ...point,
      bucketKey,
      bucketStart,
      bucketEnd: new Date(Math.min(monthEnd, range.to.getTime())),
      label: trend.granularity === "month" ? point.label : monthFormatter.format(bucketStart),
      netFen: point.incomeFen - point.expenseFen,
      cumulativeNetFen: 0,
    });
  }

  let cumulativeNetFen = 0;
  const points = Array.from(byMonth.values()).map((point) => {
    cumulativeNetFen += point.netFen;
    return { ...point, cumulativeNetFen };
  });

  return { granularity: "month", points };
}
