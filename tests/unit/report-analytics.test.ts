import { describe, expect, it } from "vitest";
import { buildReportAnalytics as build } from "@/lib/reports/analytics";
import type { BuildReportAnalyticsInput } from "@/lib/reports/analytics-types";

function input(overrides: Partial<BuildReportAnalyticsInput> = {}): BuildReportAnalyticsInput {
  return {
    range: { from: "2026-04-01", to: "2026-04-03" },
    previousRange: { from: "2026-03-01", to: "2026-03-03" },
    yearAgoRange: { from: "2025-04-01", to: "2025-04-03" },
    firstRecordedDate: "2025-01-01",
    categories: [], days: [], categoryMonths: [],
    distribution: { buckets: [], expenseCount: 0, totalFen: 0, medianFen: null, maxFen: null, topFiveAmountFen: 0 },
    ...overrides,
  };
}

describe("report analytics", () => {
  it("compares household amounts and orders category changes by their absolute contribution", async () => {
    const report = await build(input({
      categories: [
        { period: "current", type: "expense", categoryId: "dining", categoryName: "Dining", amountFen: 9000, transactionCount: 3 },
        { period: "current", type: "income", categoryId: "salary", categoryName: "Salary", amountFen: 40000, transactionCount: 1 },
        { period: "previous", type: "expense", categoryId: "dining", categoryName: "Dining", amountFen: 2000, transactionCount: 2 },
        { period: "previous", type: "expense", categoryId: "travel", categoryName: "Travel", amountFen: 10000, transactionCount: 1 },
        { period: "previous", type: "income", categoryId: "salary", categoryName: "Salary", amountFen: 30000, transactionCount: 1 },
        { period: "yearAgo", type: "expense", categoryId: "dining", categoryName: "Dining", amountFen: 6000, transactionCount: 3 },
      ],
    }));

    expect(report.summary).toEqual({ incomeFen: 40000, expenseFen: 9000, netFen: 31000, incomeCount: 1, expenseCount: 3, transactionCount: 4 });
    expect(report.comparisons.previous.expense).toEqual({ deltaFen: -3000, ratio: -0.25 });
    expect(report.comparisons.yearAgo.expense).toEqual({ deltaFen: 3000, ratio: 0.5 });
    expect(report.categoryChanges.expense.map(({ categoryId }) => categoryId)).toEqual(["travel", "dining"]);
    expect(report.categoryChanges.expense[0]).toMatchObject({ current: { amountFen: 0, transactionCount: 0, averageFen: null }, deltaFen: -10000, ratio: -1 });
    expect(report.categoryChanges.expense[1]).toMatchObject({ current: { amountFen: 9000, transactionCount: 3, averageFen: 3000 }, previous: { averageFen: 1000 }, deltaFen: 7000, ratio: 3.5 });
  });

  it("does not invent comparisons for a missing baseline or all-time range", async () => {
    const noBaseline = await build(input({ categories: [
      { period: "current", type: "expense", categoryId: "dining", categoryName: "Dining", amountFen: 1000, transactionCount: 1 },
    ] }));
    expect(noBaseline.comparisons.previous).toMatchObject({ availability: "missing", expense: { deltaFen: null, ratio: null } });
    expect(noBaseline.categoryChanges.expense[0]).toMatchObject({ deltaFen: null, ratio: null });
    expect(noBaseline.cumulative.every(({ previousFen }) => previousFen === null)).toBe(true);

    const allTime = await build(input({ previousRange: null, yearAgoRange: null }));
    expect(allTime.comparisons.previous).toMatchObject({ availability: "not-applicable", range: null, summary: null });
  });

  it("distinguishes zero spending from missing records and avoids negative-net percentages", async () => {
    const report = await build(input({ categories: [
      { period: "current", type: "expense", categoryId: "dining", categoryName: "Dining", amountFen: 2000, transactionCount: 1 },
      { period: "previous", type: "income", categoryId: "salary", categoryName: "Salary", amountFen: 1000, transactionCount: 1 },
      { period: "yearAgo", type: "expense", categoryId: "dining", categoryName: "Dining", amountFen: 1000, transactionCount: 1 },
    ] }));
    expect(report.comparisons.previous.availability).toBe("available");
    expect(report.comparisons.previous.expense).toEqual({ deltaFen: 2000, ratio: null });
    expect(report.comparisons.yearAgo.net).toEqual({ deltaFen: -1000, ratio: null });
  });

  it("marks history beginning inside the baseline as partial without treating internal gaps as missing", async () => {
    const report = await build(input({ firstRecordedDate: "2026-03-02", categories: [
      { period: "previous", type: "income", categoryId: "salary", categoryName: "Salary", amountFen: 1000, transactionCount: 1 },
    ] }));
    expect(report.comparisons.previous.availability).toBe("partial");
    expect(report.comparisons.previous.income.deltaFen).toBe(-1000);
    expect(report.comparisons.previous.income.ratio).toBeNull();
    expect(report.daily.map(({ expenseFen }) => expenseFen)).toEqual([0, 0, 0]);
  });

  it("fills calendar dates and keeps unequal-length cumulative comparisons honest", async () => {
    const report = await build(input({
      previousRange: { from: "2026-03-01", to: "2026-03-04" },
      categories: [{ period: "previous", type: "expense", categoryId: "dining", categoryName: "Dining", amountFen: 700, transactionCount: 2 }],
      days: [
        { period: "current", date: "2026-04-01", expenseFen: 100, expenseCount: 1 },
        { period: "current", date: "2026-04-03", expenseFen: 200, expenseCount: 1 },
        { period: "previous", date: "2026-03-02", expenseFen: 300, expenseCount: 1 },
        { period: "previous", date: "2026-03-04", expenseFen: 400, expenseCount: 1 },
      ],
    }));
    expect(report.daily).toEqual([
      { date: "2026-04-01", expenseFen: 100, expenseCount: 1 },
      { date: "2026-04-02", expenseFen: 0, expenseCount: 0 },
      { date: "2026-04-03", expenseFen: 200, expenseCount: 1 },
    ]);
    expect(report.cumulative.map(({ currentFen, previousFen }) => [currentFen, previousFen])).toEqual([[100, 0], [100, 300], [300, 300], [null, 700]]);
    expect(report.cumulative[3]).toMatchObject({ dayIndex: 4, currentDate: null, previousDate: "2026-03-04" });
  });

  it("creates continuous month series and keeps income separate from expenses", async () => {
    const report = await build(input({
      range: { from: "2026-01-20", to: "2026-03-03" },
      categoryMonths: [
        { type: "expense", categoryId: "dining", categoryName: "Dining", month: "2026-01", amountFen: 100, transactionCount: 1 },
        { type: "expense", categoryId: "dining", categoryName: "Dining", month: "2026-03", amountFen: 300, transactionCount: 2 },
        { type: "income", categoryId: "salary", categoryName: "Salary", month: "2026-02", amountFen: 900, transactionCount: 1 },
      ],
    }));
    expect(report.categoryMonths.months).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(report.categoryMonths.expense[0]).toMatchObject({ totalFen: 400 });
    expect(report.categoryMonths.expense[0].points.map(({ amountFen }) => amountFen)).toEqual([100, 0, 300]);
    expect(report.categoryMonths.income[0].points.map(({ amountFen }) => amountFen)).toEqual([0, 900, 0]);
  });

  it("preserves exact half-fen statistics and exposes all six non-overlapping amount intervals", async () => {
    const report = await build(input({ distribution: {
      expenseCount: 2, totalFen: 10001, medianFen: 5000.5, maxFen: 5001, topFiveAmountFen: 10001,
      buckets: [{ key: "50-200", amountFen: 10001, transactionCount: 2 }],
    } }));
    expect(report.distribution).toMatchObject({ medianFen: 5000.5, maxFen: 5001, topFiveShare: 1 });
    expect(report.distribution.buckets.map(({ minFen, maxFen }) => [minFen, maxFen])).toEqual([
      [0, 4999], [5000, 19999], [20000, 49999], [50000, 99999], [100000, 499999], [500000, null],
    ]);
    expect(report.distribution.buckets.map(({ transactionCount }) => transactionCount)).toEqual([0, 2, 0, 0, 0, 0]);
  });

  it("returns null distribution statistics when the range has no expenses", async () => {
    const report = await build(input());
    expect(report.distribution).toMatchObject({ expenseCount: 0, totalFen: 0, medianFen: null, maxFen: null, topFiveShare: null });
    expect(report.distribution.buckets.every(({ amountFen, transactionCount }) => amountFen === 0 && transactionCount === 0)).toBe(true);
    expect(report.categoryChanges).toEqual({ income: [], expense: [] });
  });

  it("keeps ancient custom totals intact while drawing only the recorded history", async () => {
    const report = await build(input({
      range: { from: "0001-01-01", to: "2026-04-03" }, previousRange: null, yearAgoRange: null,
      firstRecordedDate: "2026-04-02",
      categories: [{ period: "current", type: "expense", categoryId: "dining", categoryName: "Dining", amountFen: 1000, transactionCount: 1 }],
      days: [{ period: "current", date: "2026-04-02", expenseFen: 1000, expenseCount: 1 }],
    }));
    expect(report.range.from).toBe("0001-01-01");
    expect(report.summary.expenseFen).toBe(1000);
    expect(report.daily).toHaveLength(2);
    expect(report.daily.map(({ date }) => date)).toEqual(["2026-04-02", "2026-04-03"]);
    expect(report.cumulative).toHaveLength(2);
    expect(report.cumulative[0].dayIndex).toBeGreaterThan(700000);
    expect(report.categoryMonths.months).toEqual(["2026-04"]);
  });

  it("limits an empty long-range calendar to the final month", async () => {
    const report = await build(input({
      range: { from: "0001-01-01", to: "2026-04-03" }, previousRange: null, yearAgoRange: null, firstRecordedDate: null,
    }));
    expect(report.daily).toHaveLength(3);
    expect(report.daily.map(({ date }) => date)).toEqual(["2026-04-01", "2026-04-02", "2026-04-03"]);
    expect(report.categoryMonths.months).toEqual(["2026-04"]);
    expect(report.cumulative).toHaveLength(3);
  });

  it.each([
    { name: "a complete year", from: "2021-01-01", to: "2021-12-31", first: "2021-06-01", days: 365, months: 12 },
    { name: "the elapsed current year", from: "2026-01-01", to: "2026-10-15", first: "2026-09-01", days: 288, months: 10 },
    { name: "a complete leap year", from: "2024-01-01", to: "2024-12-31", first: "2024-06-01", days: 366, months: 12 },
    { name: "a month", from: "2026-04-01", to: "2026-04-30", first: "2026-04-15", days: 30, months: 1 },
    { name: "the recent three months", from: "2026-08-01", to: "2026-10-15", first: "2026-09-25", days: 76, months: 3 },
  ])("preserves the whole display window for $name when records start later", async ({ from, to, first, days, months }) => {
    const report = await build(input({
      range: { from, to }, previousRange: null, yearAgoRange: null, firstRecordedDate: first,
      categories: [{ period: "current", type: "expense", categoryId: "dining", categoryName: "Dining", amountFen: 1000, transactionCount: 1 }],
      days: [{ period: "current", date: first, expenseFen: 1000, expenseCount: 1 }],
      categoryMonths: [{ type: "expense", categoryId: "dining", categoryName: "Dining", month: first.slice(0, 7), amountFen: 1000, transactionCount: 1 }],
    }));

    expect(report.daily).toHaveLength(days);
    expect(report.daily[0]).toEqual({ date: from, expenseFen: 0, expenseCount: 0 });
    expect(report.daily.at(-1)?.date).toBe(to);
    expect(report.categoryMonths.months).toHaveLength(months);
    expect(report.categoryMonths.months[0]).toBe(from.slice(0, 7));
    expect(report.categoryMonths.months.at(-1)).toBe(to.slice(0, 7));
    expect(report.categoryMonths.expense[0].points.reduce((total, point) => total + point.amountFen, 0)).toBe(1000);
    expect(report.cumulative[0]).toMatchObject({ dayIndex: 1, currentDate: from, currentFen: 0 });
    expect(report.cumulative.at(-1)?.currentFen).toBe(1000);
    expect(report.firstRecordedDate).toBe(first);
  });

  it("retains every month and day of an empty selected year", async () => {
    const report = await build(input({
      range: { from: "2021-01-01", to: "2021-12-31" }, previousRange: null, yearAgoRange: null, firstRecordedDate: null,
    }));
    expect(report.daily).toHaveLength(365);
    expect(report.categoryMonths.months).toHaveLength(12);
    expect(report.daily[0]).toEqual({ date: "2021-01-01", expenseFen: 0, expenseCount: 0 });
    expect(report.daily.at(-1)).toEqual({ date: "2021-12-31", expenseFen: 0, expenseCount: 0 });
    expect(report.summary.transactionCount).toBe(0);
  });
});
