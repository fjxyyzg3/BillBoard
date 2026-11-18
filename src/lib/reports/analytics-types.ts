export type AnalyticsTransactionType = "income" | "expense";
export type AnalyticsPeriod = "current" | "previous" | "yearAgo";
export type AnalyticsDateRange = { from: string; to: string };

export type AnalyticsSummary = {
  incomeFen: number;
  expenseFen: number;
  netFen: number;
  incomeCount: number;
  expenseCount: number;
  transactionCount: number;
};

export type AnalyticsChange = { deltaFen: number | null; ratio: number | null };

export type AnalyticsComparison = {
  range: AnalyticsDateRange | null;
  summary: AnalyticsSummary | null;
  availability: "available" | "partial" | "missing" | "not-applicable";
  income: AnalyticsChange;
  expense: AnalyticsChange;
  net: AnalyticsChange;
};

export type AnalyticsCategoryTotals = {
  amountFen: number;
  transactionCount: number;
  averageFen: number | null;
};

export type AnalyticsCategoryChange = AnalyticsChange & {
  categoryId: string;
  categoryName: string;
  current: AnalyticsCategoryTotals;
  previous: AnalyticsCategoryTotals;
};

export type AnalyticsDay = { date: string; expenseFen: number; expenseCount: number };

export type AnalyticsCumulativePoint = {
  dayIndex: number;
  currentDate: string | null;
  previousDate: string | null;
  currentFen: number | null;
  previousFen: number | null;
};

export type AnalyticsCategorySeries = {
  categoryId: string;
  categoryName: string;
  totalFen: number;
  points: Array<{ month: string; amountFen: number; transactionCount: number }>;
};

export type AnalyticsExpenseBucket = {
  key: string;
  minFen: number;
  maxFen: number | null;
  amountFen: number;
  transactionCount: number;
};

export type AnalyticsDistribution = {
  buckets: AnalyticsExpenseBucket[];
  expenseCount: number;
  totalFen: number;
  medianFen: number | null;
  maxFen: number | null;
  topFiveAmountFen: number;
  topFiveShare: number | null;
};

export type ReportAnalytics = {
  range: AnalyticsDateRange;
  firstRecordedDate: string | null;
  summary: AnalyticsSummary;
  comparisons: { previous: AnalyticsComparison; yearAgo: AnalyticsComparison };
  categoryChanges: Record<AnalyticsTransactionType, AnalyticsCategoryChange[]>;
  daily: AnalyticsDay[];
  cumulative: AnalyticsCumulativePoint[];
  categoryMonths: { months: string[] } & Record<AnalyticsTransactionType, AnalyticsCategorySeries[]>;
  distribution: AnalyticsDistribution;
};

export type AnalyticsCategoryAggregate = {
  period: AnalyticsPeriod;
  type: AnalyticsTransactionType;
  categoryId: string;
  categoryName: string;
  amountFen: number;
  transactionCount: number;
};

export type AnalyticsDayAggregate = AnalyticsDay & { period: "current" | "previous" };

export type AnalyticsCategoryMonthAggregate = {
  type: AnalyticsTransactionType;
  categoryId: string;
  categoryName: string;
  month: string;
  amountFen: number;
  transactionCount: number;
};

export type AnalyticsDistributionAggregate = Omit<AnalyticsDistribution, "buckets" | "topFiveShare"> & {
  buckets: Array<{ key: string; amountFen: number; transactionCount: number }>;
};

export type BuildReportAnalyticsInput = {
  range: AnalyticsDateRange;
  previousRange: AnalyticsDateRange | null;
  yearAgoRange: AnalyticsDateRange | null;
  firstRecordedDate: string | null;
  categories: AnalyticsCategoryAggregate[];
  days: AnalyticsDayAggregate[];
  categoryMonths: AnalyticsCategoryMonthAggregate[];
  distribution: AnalyticsDistributionAggregate;
};
