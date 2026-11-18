import type { ReportRange, ReportRangeOptions } from "@/lib/reports/report-range";
import { buildMonthlyBalanceTrend } from "@/lib/reports/balance-trend";

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

export type ReportBalanceTrendPoint = ReportTrendPoint & {
  cumulativeNetFen: number;
};

export type ReportCategoryItem = {
  amountFen: number;
  categoryId: string;
  categoryName: string;
  share: number;
  transactionCount: number;
};

export type HomeReport = {
  balanceTrend: {
    granularity: "month";
    points: ReportBalanceTrendPoint[];
  };
  categories: {
    expense: {
      items: ReportCategoryItem[];
      totalFen: number;
    };
    income: {
      items: ReportCategoryItem[];
      totalFen: number;
    };
  };
  range: ReportRange;
  rangeOptions: ReportRangeOptions;
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

type ReportRangeBounds = Pick<ReportRange, "from" | "to">;

type AggregateHomeReportInput = {
  range: ReportRange;
  rangeOptions: ReportRangeOptions;
  timezone: string;
  transactions: ReportTransaction[];
};

function padTwoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function getShanghaiDate(date: Date) {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS);
}

function getCalendarDate(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function getShanghaiStart(year: number, month: number, day: number) {
  return new Date(getCalendarDate(year, month, day).getTime() - SHANGHAI_OFFSET_MS);
}

function getShanghaiEnd(year: number, month: number, day: number) {
  return new Date(getShanghaiStart(year, month, day + 1).getTime() - 1);
}

function getDayBucketKey(date: Date) {
  const shanghaiDate = getShanghaiDate(date);

  return `${String(shanghaiDate.getUTCFullYear()).padStart(4, "0")}-${padTwoDigits(shanghaiDate.getUTCMonth() + 1)}-${padTwoDigits(shanghaiDate.getUTCDate())}`;
}

function getMonthBucketKey(date: Date) {
  const shanghaiDate = getShanghaiDate(date);

  return `${String(shanghaiDate.getUTCFullYear()).padStart(4, "0")}-${padTwoDigits(shanghaiDate.getUTCMonth() + 1)}`;
}

function buildHomeTrendPoints(
  range: ReportRange,
  timezone: string,
): HomeReport["trend"] {
  return buildTrendPointsByGranularity(
    range.mode === "month" ? "day" : "month",
    { from: range.from, to: range.to },
    timezone,
  );
}

function buildTrendPointsByGranularity(
  granularity: "day" | "month",
  rangeBounds: ReportRangeBounds,
  timezone: string,
): HomeReport["trend"] {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("v1 supports Asia/Shanghai report math only");
  }

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
    const cursor = getCalendarDate(shanghaiFrom.getUTCFullYear(), shanghaiFrom.getUTCMonth(), 1);
    const lastMonth = getCalendarDate(shanghaiTo.getUTCFullYear(), shanghaiTo.getUTCMonth(), 1);
    const points: ReportTrendPoint[] = [];

    while (cursor.getTime() <= lastMonth.getTime()) {
      const year = cursor.getUTCFullYear();
      const month = cursor.getUTCMonth();
      const bucketStart = new Date(Math.max(getShanghaiStart(year, month, 1).getTime(), rangeBounds.from.getTime()));
      const bucketEnd = new Date(Math.min(getShanghaiEnd(year, month + 1, 0).getTime(), rangeBounds.to.getTime()));

      points.push({
        bucketEnd,
        bucketKey: `${String(year).padStart(4, "0")}-${padTwoDigits(month + 1)}`,
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
  const cursor = getCalendarDate(
    shanghaiFrom.getUTCFullYear(),
    shanghaiFrom.getUTCMonth(),
    shanghaiFrom.getUTCDate(),
  );
  const lastDay = getCalendarDate(
    shanghaiTo.getUTCFullYear(),
    shanghaiTo.getUTCMonth(),
    shanghaiTo.getUTCDate(),
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
      bucketKey: `${String(year).padStart(4, "0")}-${padTwoDigits(month + 1)}-${padTwoDigits(day)}`,
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

function buildCategoryItems(
  groups: Map<
    string,
    {
      amountFen: number;
      categoryId: string;
      categoryName: string;
      transactionCount: number;
    }
  >,
  totalFen: number,
) {
  return Array.from(groups.values())
    .sort((left, right) => {
      if (right.amountFen !== left.amountFen) {
        return right.amountFen - left.amountFen;
      }

      return left.categoryName.localeCompare(right.categoryName);
    })
    .map((item) => ({
      ...item,
      share: totalFen === 0 ? 0 : item.amountFen / totalFen,
    }));
}

function addCategoryAmount(
  groups: Map<
    string,
    {
      amountFen: number;
      categoryId: string;
      categoryName: string;
      transactionCount: number;
    }
  >,
  transaction: ReportTransaction,
) {
  const currentCategory = groups.get(transaction.categoryId);

  if (currentCategory) {
    currentCategory.amountFen += transaction.amountFen;
    currentCategory.transactionCount += 1;
    return;
  }

  groups.set(transaction.categoryId, {
    amountFen: transaction.amountFen,
    categoryId: transaction.categoryId,
    categoryName: transaction.categoryName,
    transactionCount: 1,
  });
}

function applyTrendTransaction(
  trend: HomeReport["trend"],
  transaction: ReportTransaction,
  trendByKey: Map<string, ReportTrendPoint>,
) {
  const bucketKey =
    trend.granularity === "month"
      ? getMonthBucketKey(transaction.occurredAt)
      : getDayBucketKey(transaction.occurredAt);
  const bucket = trendByKey.get(bucketKey);

  if (!bucket) {
    return;
  }

  if (transaction.type === "income") {
    bucket.incomeFen += transaction.amountFen;
  } else {
    bucket.expenseFen += transaction.amountFen;
  }

  bucket.netFen = bucket.incomeFen - bucket.expenseFen;
  bucket.transactionCount += 1;
}

export function aggregateHomeReport({
  range,
  rangeOptions,
  timezone,
  transactions,
}: AggregateHomeReportInput): HomeReport {
  const trend = buildHomeTrendPoints(range, timezone);
  const trendByKey = new Map(trend.points.map((point) => [point.bucketKey, point]));
  const expenseCategoryTotals = new Map<
    string,
    {
      amountFen: number;
      categoryId: string;
      categoryName: string;
      transactionCount: number;
    }
  >();
  const incomeCategoryTotals = new Map<
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
    if (transaction.type === "income") {
      incomeFen += transaction.amountFen;
      addCategoryAmount(incomeCategoryTotals, transaction);
    } else {
      expenseFen += transaction.amountFen;
      addCategoryAmount(expenseCategoryTotals, transaction);
    }

    applyTrendTransaction(trend, transaction, trendByKey);
  }

  return {
    balanceTrend: buildMonthlyBalanceTrend({ trend, range }),
    categories: {
      expense: {
        items: buildCategoryItems(expenseCategoryTotals, expenseFen),
        totalFen: expenseFen,
      },
      income: {
        items: buildCategoryItems(incomeCategoryTotals, incomeFen),
        totalFen: incomeFen,
      },
    },
    range,
    rangeOptions,
    summary: {
      expenseFen,
      incomeFen,
      netFen: incomeFen - expenseFen,
      transactionCount: transactions.length,
    },
    trend,
  };
}
