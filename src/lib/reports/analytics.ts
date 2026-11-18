import type {
  AnalyticsCategoryAggregate,
  AnalyticsCategoryChange,
  AnalyticsCategoryMonthAggregate,
  AnalyticsCategorySeries,
  AnalyticsCategoryTotals,
  AnalyticsChange,
  AnalyticsComparison,
  AnalyticsDateRange,
  AnalyticsDay,
  AnalyticsDayAggregate,
  AnalyticsPeriod,
  AnalyticsSummary,
  AnalyticsTransactionType,
  BuildReportAnalyticsInput,
  ReportAnalytics,
} from "./analytics-types";

export type { ReportAnalytics } from "./analytics-types";

export const EXPENSE_BUCKETS = [
  { key: "under-50", minFen: 0, maxFen: 4999 },
  { key: "50-200", minFen: 5000, maxFen: 19999 },
  { key: "200-500", minFen: 20000, maxFen: 49999 },
  { key: "500-1000", minFen: 50000, maxFen: 99999 },
  { key: "1000-5000", minFen: 100000, maxFen: 499999 },
  { key: "5000-plus", minFen: 500000, maxFen: null },
] as const;

function dateKeys(range: AnalyticsDateRange): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${range.from}T00:00:00.000Z`);
  const end = new Date(`${range.to}T00:00:00.000Z`).getTime();
  while (cursor.getTime() <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function monthKeys(range: AnalyticsDateRange): string[] {
  const months: string[] = [];
  const cursor = new Date(`${range.from.slice(0, 7)}-01T00:00:00.000Z`);
  const last = range.to.slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= last) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function chartRange(range: AnalyticsDateRange, firstRecordedDate: string | null): AnalyticsDateRange {
  const startsAt = new Date(`${range.from}T00:00:00.000Z`).getTime();
  const endsAt = new Date(`${range.to}T00:00:00.000Z`).getTime();
  if ((endsAt - startsAt) / 86400000 + 1 <= 366) return range;
  const earliest = firstRecordedDate !== null && firstRecordedDate <= range.to
    ? firstRecordedDate : `${range.to.slice(0, 7)}-01`;
  return { from: earliest > range.from ? earliest : range.from, to: range.to };
}

function summarize(rows: AnalyticsCategoryAggregate[], period: AnalyticsPeriod): AnalyticsSummary {
  const summary = { incomeFen: 0, expenseFen: 0, netFen: 0, incomeCount: 0, expenseCount: 0, transactionCount: 0 };
  for (const row of rows) {
    if (row.period !== period) continue;
    if (row.type === "income") {
      summary.incomeFen += row.amountFen;
      summary.incomeCount += row.transactionCount;
    } else {
      summary.expenseFen += row.amountFen;
      summary.expenseCount += row.transactionCount;
    }
    summary.transactionCount += row.transactionCount;
  }
  summary.netFen = summary.incomeFen - summary.expenseFen;
  return summary;
}

function change(current: number, previous: number, availability: AnalyticsComparison["availability"]): AnalyticsChange {
  if (availability === "missing" || availability === "not-applicable") {
    return { deltaFen: null, ratio: null };
  }
  return {
    deltaFen: current - previous,
    ratio: availability === "available" && previous > 0 ? (current - previous) / previous : null,
  };
}

function comparison(
  current: AnalyticsSummary,
  baseline: AnalyticsSummary,
  range: AnalyticsDateRange | null,
  firstRecordedDate: string | null,
): AnalyticsComparison {
  const availability: AnalyticsComparison["availability"] = !range
    ? "not-applicable"
    : baseline.transactionCount === 0
      ? "missing"
      : firstRecordedDate !== null && firstRecordedDate > range.from ? "partial" : "available";
  return {
    range,
    summary: range ? baseline : null,
    availability,
    income: change(current.incomeFen, baseline.incomeFen, availability),
    expense: change(current.expenseFen, baseline.expenseFen, availability),
    net: change(current.netFen, baseline.netFen, availability),
  };
}

function categoryTotals(row: AnalyticsCategoryAggregate | undefined): AnalyticsCategoryTotals {
  const amountFen = row?.amountFen ?? 0;
  const transactionCount = row?.transactionCount ?? 0;
  return { amountFen, transactionCount, averageFen: transactionCount > 0 ? amountFen / transactionCount : null };
}

function categoryChanges(
  rows: AnalyticsCategoryAggregate[],
  type: AnalyticsTransactionType,
  availability: AnalyticsComparison["availability"],
): AnalyticsCategoryChange[] {
  const current = new Map(rows.filter((row) => row.period === "current" && row.type === type).map((row) => [row.categoryId, row]));
  const previous = new Map(rows.filter((row) => row.period === "previous" && row.type === type).map((row) => [row.categoryId, row]));
  return Array.from(new Set([...current.keys(), ...previous.keys()])).map((categoryId) => {
    const currentRow = current.get(categoryId);
    const previousRow = previous.get(categoryId);
    const currentTotals = categoryTotals(currentRow);
    const previousTotals = categoryTotals(previousRow);
    return {
      categoryId,
      categoryName: (currentRow ?? previousRow)!.categoryName,
      current: currentTotals,
      previous: previousTotals,
      ...change(currentTotals.amountFen, previousTotals.amountFen, availability),
    };
  }).sort((left, right) =>
    Math.abs(right.deltaFen ?? right.current.amountFen) - Math.abs(left.deltaFen ?? left.current.amountFen)
    || right.current.amountFen - left.current.amountFen
    || left.categoryName.localeCompare(right.categoryName),
  );
}

function dailyAmounts(range: AnalyticsDateRange, rows: AnalyticsDayAggregate[], period: "current" | "previous"): AnalyticsDay[] {
  const byDate = new Map(rows.filter((row) => row.period === period).map((row) => [row.date, row]));
  return dateKeys(range).map((date) => ({
    date,
    expenseFen: byDate.get(date)?.expenseFen ?? 0,
    expenseCount: byDate.get(date)?.expenseCount ?? 0,
  }));
}

function cumulativeSeries(days: AnalyticsDay[], range: AnalyticsDateRange | null) {
  let totalFen = 0;
  const points = new Map<number, { date: string; totalFen: number }>();
  if (!range) return points;
  const startsAt = new Date(`${range.from}T00:00:00.000Z`).getTime();
  for (const day of days) {
    totalFen += day.expenseFen;
    const index = Math.round((new Date(`${day.date}T00:00:00.000Z`).getTime() - startsAt) / 86400000);
    points.set(index, { date: day.date, totalFen });
  }
  return points;
}

function cumulativeAmounts(
  current: AnalyticsDay[], previous: AnalyticsDay[], currentRange: AnalyticsDateRange, previousRange: AnalyticsDateRange | null,
): ReportAnalytics["cumulative"] {
  const currentPoints = cumulativeSeries(current, currentRange);
  const previousPoints = cumulativeSeries(previous, previousRange);
  const currentStart = currentPoints.keys().next().value ?? Infinity;
  const previousStart = previousPoints.keys().next().value ?? Infinity;
  const start = Math.min(currentStart, previousStart);
  const end = Math.max(currentPoints.size ? currentStart + currentPoints.size - 1 : -1, previousPoints.size ? previousStart + previousPoints.size - 1 : -1);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => {
    const index = start + offset;
    const currentDay = currentPoints.get(index);
    const previousDay = previousPoints.get(index);
    return {
      dayIndex: index + 1,
      currentDate: currentDay?.date ?? null,
      previousDate: previousDay?.date ?? null,
      currentFen: currentDay?.totalFen ?? null,
      previousFen: previousDay?.totalFen ?? null,
    };
  });
}

function categorySeries(rows: AnalyticsCategoryMonthAggregate[], months: string[], type: AnalyticsTransactionType): AnalyticsCategorySeries[] {
  const categories = new Map<string, { name: string; points: Map<string, AnalyticsCategoryMonthAggregate> }>();
  for (const row of rows) {
    if (row.type !== type) continue;
    const category = categories.get(row.categoryId) ?? { name: row.categoryName, points: new Map() };
    category.points.set(row.month, row);
    categories.set(row.categoryId, category);
  }
  return Array.from(categories.entries()).map(([categoryId, category]) => {
    const points = months.map((month) => ({
      month,
      amountFen: category.points.get(month)?.amountFen ?? 0,
      transactionCount: category.points.get(month)?.transactionCount ?? 0,
    }));
    return { categoryId, categoryName: category.name, totalFen: points.reduce((total, point) => total + point.amountFen, 0), points };
  }).sort((left, right) => right.totalFen - left.totalFen || left.categoryName.localeCompare(right.categoryName));
}

export function buildReportAnalytics(input: BuildReportAnalyticsInput): ReportAnalytics {
  const summary = summarize(input.categories, "current");
  const previous = comparison(summary, summarize(input.categories, "previous"), input.previousRange, input.firstRecordedDate);
  const yearAgo = comparison(summary, summarize(input.categories, "yearAgo"), input.yearAgoRange, input.firstRecordedDate);
  const visualRange = chartRange(input.range, input.firstRecordedDate);
  const daily = dailyAmounts(visualRange, input.days, "current");
  const previousDays = input.previousRange && previous.availability !== "missing"
    ? dailyAmounts(chartRange(input.previousRange, input.firstRecordedDate), input.days, "previous") : [];
  const months = monthKeys(visualRange);
  const buckets = new Map(input.distribution.buckets.map((bucket) => [bucket.key, bucket]));
  return {
    range: input.range,
    firstRecordedDate: input.firstRecordedDate,
    summary,
    comparisons: { previous, yearAgo },
    categoryChanges: {
      income: categoryChanges(input.categories, "income", previous.availability),
      expense: categoryChanges(input.categories, "expense", previous.availability),
    },
    daily,
    cumulative: cumulativeAmounts(daily, previousDays, input.range, input.previousRange),
    categoryMonths: {
      months,
      income: categorySeries(input.categoryMonths, months, "income"),
      expense: categorySeries(input.categoryMonths, months, "expense"),
    },
    distribution: {
      ...input.distribution,
      buckets: EXPENSE_BUCKETS.map((bucket) => ({
        ...bucket,
        amountFen: buckets.get(bucket.key)?.amountFen ?? 0,
        transactionCount: buckets.get(bucket.key)?.transactionCount ?? 0,
      })),
      topFiveShare: input.distribution.totalFen > 0 ? input.distribution.topFiveAmountFen / input.distribution.totalFen : null,
    },
  };
}
