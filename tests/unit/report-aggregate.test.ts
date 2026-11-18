import { describe, expect, it } from "vitest";
import { aggregateHomeReport, type ReportTransaction } from "@/lib/reports/aggregate";

describe("aggregateHomeReport", () => {
  it("preserves early Gregorian years in custom trend buckets", () => {
    const report = aggregateHomeReport({
      range: {
        mode: "custom", month: "2026-04", year: "2026", start: "0004-02-01", end: "0004-02-29",
        from: new Date("0004-01-31T16:00:00.000Z"), to: new Date("0004-02-29T15:59:59.999Z"),
      },
      rangeOptions: { months: ["2026-04"], years: ["2026"] },
      timezone: "Asia/Shanghai",
      transactions: [],
    });

    expect(report.trend.points).toHaveLength(1);
    expect(report.trend.points[0]?.bucketKey).toBe("0004-02");
    expect(report.trend.points[0]?.bucketStart).toEqual(new Date("0004-01-31T16:00:00.000Z"));
    expect(report.trend.points[0]?.bucketEnd).toEqual(new Date("0004-02-29T15:59:59.999Z"));
  });

  it("keeps monthly drilldowns inside a custom date window", () => {
    const range = {
      mode: "custom" as const,
      month: "2026-04",
      year: "2026",
      start: "2026-02-15",
      end: "2026-04-20",
      from: new Date("2026-02-14T16:00:00.000Z"),
      to: new Date("2026-04-20T15:59:59.999Z"),
    };
    const report = aggregateHomeReport({
      range,
      rangeOptions: { months: ["2026-04", "2026-03", "2026-02"], years: ["2026"] },
      timezone: "Asia/Shanghai",
      transactions: [],
    });

    expect(report.trend.points).toHaveLength(3);
    expect(report.trend.points[0]?.bucketStart).toEqual(range.from);
    expect(report.trend.points[2]?.bucketEnd).toEqual(range.to);
    expect(report.trend.points[1]?.bucketStart).toEqual(new Date("2026-02-28T16:00:00.000Z"));
    expect(report.trend.points[1]?.bucketEnd).toEqual(new Date("2026-03-31T15:59:59.999Z"));
  });

  it("builds summary, daily month trend, and income and expense category sections", () => {
    const transactions: ReportTransaction[] = [
      {
        id: "expense-dining",
        amountFen: 4500,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-dining",
        categoryName: "Dining",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: "Dinner",
        occurredAt: new Date("2026-04-25T10:00:00.000Z"),
        type: "expense",
      },
      {
        id: "expense-travel",
        amountFen: 9000,
        actorMemberId: "member-2",
        actorMemberName: "Spouse",
        categoryId: "category-travel",
        categoryName: "Travel",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: "Train tickets",
        occurredAt: new Date("2026-04-23T04:00:00.000Z"),
        type: "expense",
      },
      {
        id: "income-salary",
        amountFen: 10000,
        actorMemberId: "member-2",
        actorMemberName: "Spouse",
        categoryId: "category-salary",
        categoryName: "Salary",
        createdByMemberId: "member-2",
        createdByMemberName: "Spouse",
        note: "Payroll",
        occurredAt: new Date("2026-04-24T01:30:00.000Z"),
        type: "income",
      },
      {
        id: "income-bonus",
        amountFen: 5000,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-bonus",
        categoryName: "Bonus",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: "Quarter bonus",
        occurredAt: new Date("2026-04-24T02:00:00.000Z"),
        type: "income",
      },
    ];
    const range = {
      mode: "month" as const,
      month: "2026-04",
      year: "2026",
      from: new Date("2026-03-31T16:00:00.000Z"),
      to: new Date("2026-04-30T15:59:59.999Z"),
    };
    const rangeOptions = {
      months: ["2026-04", "2026-03"],
      years: ["2026"],
    };

    const report = aggregateHomeReport({
      range,
      rangeOptions,
      timezone: "Asia/Shanghai",
      transactions,
    });

    expect(report.summary).toEqual({
      expenseFen: 13500,
      incomeFen: 15000,
      netFen: 1500,
      transactionCount: 4,
    });
    expect(report.range).toBe(range);
    expect(report.rangeOptions).toBe(rangeOptions);
    expect(report.trend.granularity).toBe("day");
    expect(report.trend.points).toHaveLength(30);
    expect(report.trend.points[0]?.bucketKey).toBe("2026-04-01");
    expect(report.trend.points[29]?.bucketKey).toBe("2026-04-30");
    expect(report.trend.points.find((point) => point.bucketKey === "2026-04-24")).toMatchObject({
      incomeFen: 15000,
      expenseFen: 0,
      transactionCount: 2,
    });
    expect(report.trend.points.find((point) => point.bucketKey === "2026-04-25")).toMatchObject({
      incomeFen: 0,
      expenseFen: 4500,
      transactionCount: 1,
    });
    expect(report.categories.expense.totalFen).toBe(13500);
    expect(report.categories.expense.items.map((item) => item.categoryName)).toEqual([
      "Travel",
      "Dining",
    ]);
    expect(report.categories.expense.items[0]).toMatchObject({
      amountFen: 9000,
      categoryId: "category-travel",
      transactionCount: 1,
    });
    expect(report.categories.expense.items[0]?.share).toBeCloseTo(9000 / 13500);
    expect(report.categories.income.totalFen).toBe(15000);
    expect(report.categories.income.items.map((item) => item.categoryName)).toEqual([
      "Salary",
      "Bonus",
    ]);
    expect(report.categories.income.items[1]).toMatchObject({
      amountFen: 5000,
      categoryId: "category-bonus",
      transactionCount: 1,
    });
    expect(report.categories.income.items[1]?.share).toBeCloseTo(5000 / 15000);
  });

  it("builds monthly trend buckets for year ranges", () => {
    const transactions: ReportTransaction[] = [
      {
        id: "travel-january",
        amountFen: 3600,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-travel",
        categoryName: "Travel",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: null,
        occurredAt: new Date("2026-01-20T03:00:00.000Z"),
        type: "expense",
      },
      {
        id: "salary-april",
        amountFen: 120000,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-salary",
        categoryName: "Salary",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: null,
        occurredAt: new Date("2026-04-02T01:00:00.000Z"),
        type: "income",
      },
    ];

    const report = aggregateHomeReport({
      range: {
        mode: "year",
        month: "2026-04",
        year: "2026",
        from: new Date("2025-12-31T16:00:00.000Z"),
        to: new Date("2026-12-31T15:59:59.999Z"),
      },
      rangeOptions: {
        months: ["2026-04", "2026-03", "2026-02", "2026-01"],
        years: ["2026"],
      },
      timezone: "Asia/Shanghai",
      transactions,
    });

    expect(report.trend.granularity).toBe("month");
    expect(report.trend.points).toHaveLength(12);
    expect(report.trend.points[0]?.bucketKey).toBe("2026-01");
    expect(report.trend.points[11]?.bucketKey).toBe("2026-12");
    expect(report.trend.points.find((point) => point.bucketKey === "2026-02")).toMatchObject({
      incomeFen: 0,
      expenseFen: 0,
      transactionCount: 0,
    });
    expect(report.trend.points.find((point) => point.bucketKey === "2026-01")).toMatchObject({
      incomeFen: 0,
      expenseFen: 3600,
      transactionCount: 1,
    });
    expect(report.trend.points.find((point) => point.bucketKey === "2026-04")).toMatchObject({
      incomeFen: 120000,
      expenseFen: 0,
      transactionCount: 1,
    });
  });

  it("builds monthly trend buckets for all ranges", () => {
    const transactions: ReportTransaction[] = [
      {
        id: "travel-december",
        amountFen: 4200,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-travel",
        categoryName: "Travel",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: null,
        occurredAt: new Date("2025-12-12T03:00:00.000Z"),
        type: "expense",
      },
      {
        id: "salary-march",
        amountFen: 120000,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-salary",
        categoryName: "Salary",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: null,
        occurredAt: new Date("2026-03-02T01:00:00.000Z"),
        type: "income",
      },
    ];

    const report = aggregateHomeReport({
      range: {
        mode: "all",
        month: "2026-04",
        year: "2026",
        from: new Date("2025-10-31T16:00:00.000Z"),
        to: new Date("2026-04-26T15:59:59.999Z"),
      },
      rangeOptions: {
        months: ["2026-04", "2026-03", "2026-02", "2026-01", "2025-12", "2025-11"],
        years: ["2026", "2025"],
      },
      timezone: "Asia/Shanghai",
      transactions,
    });

    expect(report.trend.granularity).toBe("month");
    expect(report.trend.points).toHaveLength(6);
    expect(report.trend.points[0]?.bucketKey).toBe("2025-11");
    expect(report.trend.points[5]?.bucketKey).toBe("2026-04");
    expect(report.trend.points.find((point) => point.bucketKey === "2025-12")).toMatchObject({
      incomeFen: 0,
      expenseFen: 4200,
      transactionCount: 1,
    });
    expect(report.trend.points.find((point) => point.bucketKey === "2026-02")).toMatchObject({
      incomeFen: 0,
      expenseFen: 0,
      transactionCount: 0,
    });
    expect(report.trend.points.find((point) => point.bucketKey === "2026-03")).toMatchObject({
      incomeFen: 120000,
      expenseFen: 0,
      transactionCount: 1,
    });
  });
});
