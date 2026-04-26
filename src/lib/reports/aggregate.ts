import type { RangePreset } from "@/lib/time-range";

const SHANGHAI_OFFSET_HOURS = 8;
const SHANGHAI_OFFSET_MS = SHANGHAI_OFFSET_HOURS * 60 * 60 * 1000;

export type ReportTransaction = {
  id: string;
  amountFen: number;
  actorMemberId: string;
  actorMemberName: string;
  categoryId: string;
  categoryName: string;
  createdByMemberId: string;
  createdByMemberName: string;
  note: string | null;
  occurredAt: Date;
  type: "income" | "expense";
};

export type ReportTrendPoint = {
  bucketEnd: Date;
  bucketKey: string;
  bucketStart: Date;
  expenseFen: number;
  incomeFen: number;
  label: string;
  netFen: number;
  transactionCount: number;
};

export type DashboardReport = {
  categories: {
    items: Array<{
      amountFen: number;
      categoryId: string;
      categoryName: string;
      share: number;
      transactionCount: number;
    }>;
    totalExpenseFen: number;
  };
  range: {
    from: Date;
    preset: RangePreset;
    to: Date;
  };
  recentTransactions: ReportTransaction[];
  summary: {
    expenseFen: number;
    incomeFen: number;
    netFen: number;
    transactionCount: number;
  };
  trend: {
    granularity: "day" | "month";
    points: ReportTrendPoint[];
  };
};

type AggregateReportInput = {
  rangeBounds: {
    from: Date;
    to: Date;
  };
  rangePreset: RangePreset;
  timezone: string;
  transactions: ReportTransaction[];
};

function padTwoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function getShanghaiDate(date: Date) {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS);
}

function getShanghaiStart(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, -SHANGHAI_OFFSET_HOURS, 0, 0, 0));
}

function getShanghaiEnd(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, 23 - SHANGHAI_OFFSET_HOURS, 59, 59, 999));
}

function getDayBucketKey(date: Date) {
  const shanghaiDate = getShanghaiDate(date);

  return `${shanghaiDate.getUTCFullYear()}-${padTwoDigits(shanghaiDate.getUTCMonth() + 1)}-${padTwoDigits(shanghaiDate.getUTCDate())}`;
}

function getMonthBucketKey(date: Date) {
  const shanghaiDate = getShanghaiDate(date);

  return `${shanghaiDate.getUTCFullYear()}-${padTwoDigits(shanghaiDate.getUTCMonth() + 1)}`;
}

function buildTrendPoints(
  rangePreset: RangePreset,
  rangeBounds: AggregateReportInput["rangeBounds"],
  timezone: string,
): DashboardReport["trend"] {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("v1 supports Asia/Shanghai report math only");
  }

  const granularity = rangePreset === "last-12-months" ? "month" : "day";
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: timezone,
  });
  const monthFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: timezone,
    year: "2-digit",
  });

  if (granularity === "month") {
    const shanghaiFrom = getShanghaiDate(rangeBounds.from);
    const shanghaiTo = getShanghaiDate(rangeBounds.to);
    const cursor = new Date(
      Date.UTC(shanghaiFrom.getUTCFullYear(), shanghaiFrom.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    const lastMonth = new Date(
      Date.UTC(shanghaiTo.getUTCFullYear(), shanghaiTo.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    const points: ReportTrendPoint[] = [];

    while (cursor.getTime() <= lastMonth.getTime()) {
      const year = cursor.getUTCFullYear();
      const month = cursor.getUTCMonth();
      const bucketStart = getShanghaiStart(year, month, 1);
      const bucketEnd = getShanghaiEnd(year, month + 1, 0);

      points.push({
        bucketEnd,
        bucketKey: `${year}-${padTwoDigits(month + 1)}`,
        bucketStart,
        expenseFen: 0,
        incomeFen: 0,
        label: monthFormatter.format(bucketStart),
        netFen: 0,
        transactionCount: 0,
      });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    return { granularity, points };
  }

  const shanghaiFrom = getShanghaiDate(rangeBounds.from);
  const shanghaiTo = getShanghaiDate(rangeBounds.to);
  const cursor = new Date(
    Date.UTC(
      shanghaiFrom.getUTCFullYear(),
      shanghaiFrom.getUTCMonth(),
      shanghaiFrom.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const lastDay = new Date(
    Date.UTC(
      shanghaiTo.getUTCFullYear(),
      shanghaiTo.getUTCMonth(),
      shanghaiTo.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const points: ReportTrendPoint[] = [];

  while (cursor.getTime() <= lastDay.getTime()) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const day = cursor.getUTCDate();
    const bucketStart = getShanghaiStart(year, month, day);
    const bucketEnd = getShanghaiEnd(year, month, day);

    points.push({
      bucketEnd,
      bucketKey: `${year}-${padTwoDigits(month + 1)}-${padTwoDigits(day)}`,
      bucketStart,
      expenseFen: 0,
      incomeFen: 0,
      label: dayFormatter.format(bucketStart),
      netFen: 0,
      transactionCount: 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { granularity, points };
}

export function aggregateReport({
  rangeBounds,
  rangePreset,
  timezone,
  transactions,
}: AggregateReportInput): DashboardReport {
  const trend = buildTrendPoints(rangePreset, rangeBounds, timezone);
  const trendByKey = new Map(trend.points.map((point) => [point.bucketKey, point]));
  const categoryTotals = new Map<
    string,
    {
      amountFen: number;
      categoryId: string;
      categoryName: string;
      transactionCount: number;
    }
  >();
  let incomeFen = 0;
  let expenseFen = 0;

  for (const transaction of transactions) {
    const bucketKey =
      trend.granularity === "month"
        ? getMonthBucketKey(transaction.occurredAt)
        : getDayBucketKey(transaction.occurredAt);
    const bucket = trendByKey.get(bucketKey);

    if (transaction.type === "income") {
      incomeFen += transaction.amountFen;
    } else {
      expenseFen += transaction.amountFen;

      const currentCategory = categoryTotals.get(transaction.categoryId);

      if (currentCategory) {
        currentCategory.amountFen += transaction.amountFen;
        currentCategory.transactionCount += 1;
      } else {
        categoryTotals.set(transaction.categoryId, {
          amountFen: transaction.amountFen,
          categoryId: transaction.categoryId,
          categoryName: transaction.categoryName,
          transactionCount: 1,
        });
      }
    }

    if (bucket) {
      if (transaction.type === "income") {
        bucket.incomeFen += transaction.amountFen;
      } else {
        bucket.expenseFen += transaction.amountFen;
      }

      bucket.netFen = bucket.incomeFen - bucket.expenseFen;
      bucket.transactionCount += 1;
    }
  }

  const totalExpenseFen = expenseFen;

  return {
    categories: {
      items: Array.from(categoryTotals.values())
        .sort((left, right) => {
          if (right.amountFen !== left.amountFen) {
            return right.amountFen - left.amountFen;
          }

          return left.categoryName.localeCompare(right.categoryName);
        })
        .map((item) => ({
          ...item,
          share: totalExpenseFen === 0 ? 0 : item.amountFen / totalExpenseFen,
        })),
      totalExpenseFen,
    },
    range: {
      from: rangeBounds.from,
      preset: rangePreset,
      to: rangeBounds.to,
    },
    recentTransactions: [...transactions]
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
      .slice(0, 5),
    summary: {
      expenseFen,
      incomeFen,
      netFen: incomeFen - expenseFen,
      transactionCount: transactions.length,
    },
    trend,
  };
}
