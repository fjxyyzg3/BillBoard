import { describe, expect, it } from "vitest";
import { aggregateReport, type ReportTransaction } from "@/lib/reports/aggregate";

describe("aggregateReport", () => {
  it("builds summary, daily trend, expense categories, and recent transactions", () => {
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
    ];

    const report = aggregateReport({
      rangePreset: "last-7-days",
      rangeBounds: {
        from: new Date("2026-04-19T16:00:00.000Z"),
        to: new Date("2026-04-26T15:59:59.999Z"),
      },
      timezone: "Asia/Shanghai",
      transactions,
    });

    expect(report.summary).toEqual({
      expenseFen: 13500,
      incomeFen: 10000,
      netFen: -3500,
      transactionCount: 3,
    });
    expect(report.trend.granularity).toBe("day");
    expect(report.trend.points).toHaveLength(7);
    expect(report.trend.points.find((point) => point.bucketKey === "2026-04-24")).toMatchObject({
      incomeFen: 10000,
      expenseFen: 0,
      transactionCount: 1,
    });
    expect(report.trend.points.find((point) => point.bucketKey === "2026-04-25")).toMatchObject({
      incomeFen: 0,
      expenseFen: 4500,
      transactionCount: 1,
    });
    expect(report.categories.totalExpenseFen).toBe(13500);
    expect(report.categories.items).toHaveLength(2);
    expect(report.categories.items[0]).toMatchObject({
      categoryId: "category-travel",
      categoryName: "Travel",
      amountFen: 9000,
      transactionCount: 1,
    });
    expect(report.categories.items[0].share).toBeCloseTo(9000 / 13500);
    expect(report.categories.items[1]).toMatchObject({
      categoryId: "category-dining",
      categoryName: "Dining",
      amountFen: 4500,
      transactionCount: 1,
    });
    expect(report.recentTransactions.map((transaction) => transaction.id)).toEqual([
      "expense-dining",
      "income-salary",
      "expense-travel",
    ]);
  });

  it("groups last 12 months by month and fills empty buckets", () => {
    const transactions: ReportTransaction[] = [
      {
        id: "travel-may",
        amountFen: 3600,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-travel",
        categoryName: "Travel",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: null,
        occurredAt: new Date("2025-05-20T03:00:00.000Z"),
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

    const report = aggregateReport({
      rangePreset: "last-12-months",
      rangeBounds: {
        from: new Date("2025-04-30T16:00:00.000Z"),
        to: new Date("2026-04-30T15:59:59.999Z"),
      },
      timezone: "Asia/Shanghai",
      transactions,
    });

    expect(report.trend.granularity).toBe("month");
    expect(report.trend.points).toHaveLength(12);
    expect(report.trend.points[0]?.bucketKey).toBe("2025-05");
    expect(report.trend.points[11]?.bucketKey).toBe("2026-04");
    expect(report.trend.points.find((point) => point.bucketKey === "2025-06")).toMatchObject({
      incomeFen: 0,
      expenseFen: 0,
      transactionCount: 0,
    });
    expect(report.trend.points.find((point) => point.bucketKey === "2025-05")).toMatchObject({
      expenseFen: 3600,
      incomeFen: 0,
      transactionCount: 1,
    });
    expect(report.trend.points.find((point) => point.bucketKey === "2026-04")).toMatchObject({
      expenseFen: 0,
      incomeFen: 120000,
      transactionCount: 1,
    });
  });
});
