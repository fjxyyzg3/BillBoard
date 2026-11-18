import { describe, expect, it } from "vitest";
import { aggregateHomeReport, type ReportTransaction, type ReportTrendPoint } from "@/lib/reports/aggregate";
import { buildMonthlyBalanceTrend } from "@/lib/reports/balance-trend";

function transaction(type: "income" | "expense", amountFen: number, occurredAt: string): ReportTransaction {
  return {
    id: `${type}-${occurredAt}`,
    amountFen,
    actorMemberId: "member-1",
    actorMemberName: "Owner",
    categoryId: "category-1",
    categoryName: "Category",
    createdByMemberId: "member-1",
    createdByMemberName: "Owner",
    note: null,
    occurredAt: new Date(occurredAt),
    type,
  };
}

function point(bucketKey: string, from: string, to: string, incomeFen = 0, expenseFen = 0): ReportTrendPoint {
  return {
    bucketKey,
    bucketStart: new Date(from),
    bucketEnd: new Date(to),
    label: bucketKey,
    incomeFen,
    expenseFen,
    netFen: incomeFen - expenseFen,
    transactionCount: incomeFen || expenseFen ? 1 : 0,
  };
}

describe("monthly balance trend", () => {
  it("adds monthly net values and a cumulative balance to an existing home report", () => {
    const report = aggregateHomeReport({
      range: {
        mode: "year",
        month: "2026-03",
        year: "2026",
        from: new Date("2025-12-31T16:00:00.000Z"),
        to: new Date("2026-03-31T15:59:59.999Z"),
      },
      rangeOptions: { months: ["2026-03"], years: ["2026"] },
      timezone: "Asia/Shanghai",
      transactions: [
        transaction("income", 300000, "2026-01-15T02:00:00.000Z"),
        transaction("expense", 100000, "2026-02-15T02:00:00.000Z"),
        transaction("income", 200000, "2026-03-15T02:00:00.000Z"),
      ],
    });

    expect(report).toMatchObject({
      balanceTrend: {
        granularity: "month",
        points: [
          expect.objectContaining({ bucketKey: "2026-01", netFen: 300000, cumulativeNetFen: 300000 }),
          expect.objectContaining({ bucketKey: "2026-02", netFen: -100000, cumulativeNetFen: 200000 }),
          expect.objectContaining({ bucketKey: "2026-03", netFen: 200000, cumulativeNetFen: 400000 }),
        ],
      },
    });
    expect(report.balanceTrend.points.at(-1)?.cumulativeNetFen).toBe(report.summary.netFen);
  });

  it("groups daily points by Shanghai months across a leap-day boundary without mutating input", () => {
    const trend = {
      granularity: "day" as const,
      points: [
        point("2024-03-01", "2024-02-29T16:00:00.000Z", "2024-03-01T15:59:59.999Z", 0, 1500),
        point("2024-02-29", "2024-02-28T16:00:00.000Z", "2024-02-29T15:59:59.999Z", 1000),
      ],
    };
    const before = structuredClone(trend);
    const range = { from: new Date("2024-02-28T16:00:00.000Z"), to: new Date("2024-03-01T15:59:59.999Z") };
    const result = buildMonthlyBalanceTrend({ trend, range });

    expect(result.points.map(({ bucketKey, netFen, cumulativeNetFen, transactionCount }) => ({ bucketKey, netFen, cumulativeNetFen, transactionCount }))).toEqual([
      { bucketKey: "2024-02", netFen: 1000, cumulativeNetFen: 1000, transactionCount: 1 },
      { bucketKey: "2024-03", netFen: -1500, cumulativeNetFen: -500, transactionCount: 1 },
    ]);
    expect(result.points[0].bucketStart).toEqual(range.from);
    expect(result.points[0].bucketEnd).toEqual(new Date("2024-02-29T15:59:59.999Z"));
    expect(result.points[1].bucketStart).toEqual(new Date("2024-02-29T16:00:00.000Z"));
    expect(result.points[1].bucketEnd).toEqual(range.to);
    expect(trend).toEqual(before);
  });

  it("combines daily income, expenses and counts into a single selected month", () => {
    const report = aggregateHomeReport({
      range: { mode: "month", month: "2026-04", year: "2026", from: new Date("2026-03-31T16:00:00.000Z"), to: new Date("2026-04-06T15:59:59.999Z") },
      rangeOptions: { months: ["2026-04"], years: ["2026"] },
      timezone: "Asia/Shanghai",
      transactions: [
        transaction("income", 10000, "2026-04-01T00:00:00.000Z"),
        transaction("income", 2000, "2026-04-02T00:00:00.000Z"),
        transaction("expense", 15000, "2026-04-03T00:00:00.000Z"),
      ],
    });

    expect(report.trend.granularity).toBe("day");
    expect(report.trend.points).toHaveLength(6);
    expect(report.balanceTrend.points).toHaveLength(1);
    expect(report.balanceTrend.points[0]).toMatchObject({
      bucketKey: "2026-04", incomeFen: 12000, expenseFen: 15000,
      netFen: -3000, cumulativeNetFen: -3000, transactionCount: 3,
      bucketStart: report.range.from, bucketEnd: report.range.to,
    });
  });

  it("clips partial monthly buckets and omits points wholly outside the selected range", () => {
    const trend = {
      granularity: "month" as const,
      points: [
        point("2026-04", "2026-03-31T16:00:00.000Z", "2026-04-30T15:59:59.999Z", 999999),
        point("2026-05", "2026-04-30T16:00:00.000Z", "2026-05-31T15:59:59.999Z", 3000, 1000),
        point("2026-06", "2026-05-31T16:00:00.000Z", "2026-06-30T15:59:59.999Z", 2000, 500),
        point("2026-07", "2026-06-30T16:00:00.000Z", "2026-07-31T15:59:59.999Z", 888888),
      ],
    };
    const range = { from: new Date("2026-05-09T16:00:00.000Z"), to: new Date("2026-06-06T15:59:59.999Z") };
    const result = buildMonthlyBalanceTrend({ trend, range });

    expect(result.points.map(({ bucketKey, netFen, cumulativeNetFen }) => ({ bucketKey, netFen, cumulativeNetFen }))).toEqual([
      { bucketKey: "2026-05", netFen: 2000, cumulativeNetFen: 2000 },
      { bucketKey: "2026-06", netFen: 1500, cumulativeNetFen: 3500 },
    ]);
    expect(result.points[0].bucketStart).toEqual(range.from);
    expect(result.points[0].label).toBe("2026-05");
    expect(result.points[1].bucketEnd).toEqual(range.to);
  });

  it("keeps existing empty months without rebuilding a compressed history", () => {
    const result = buildMonthlyBalanceTrend({
      trend: {
        granularity: "month",
        points: [
          point("2026-03", "2026-02-28T16:00:00.000Z", "2026-03-31T15:59:59.999Z", 1000),
          point("2026-04", "2026-03-31T16:00:00.000Z", "2026-04-30T15:59:59.999Z"),
          point("2026-05", "2026-04-30T16:00:00.000Z", "2026-05-06T15:59:59.999Z", 0, 2000),
        ],
      },
      range: { from: new Date("0001-01-01T00:00:00.000+08:00"), to: new Date("2026-05-06T15:59:59.999Z") },
    });

    expect(result.points.map(({ bucketKey }) => bucketKey)).toEqual(["2026-03", "2026-04", "2026-05"]);
    expect(result.points.map(({ cumulativeNetFen }) => cumulativeNetFen)).toEqual([1000, 1000, -1000]);
    expect(result.points[1]).toMatchObject({ incomeFen: 0, expenseFen: 0, netFen: 0, transactionCount: 0 });
  });

  it.each([0, 1, -1, 500, -500])("preserves a single month with a balance of %i fen", (netFen) => {
    const result = buildMonthlyBalanceTrend({
      trend: { granularity: "month", points: [point("2026-04", "2026-03-31T16:00:00.000Z", "2026-04-30T15:59:59.999Z", Math.max(0, netFen), Math.max(0, -netFen))] },
      range: { from: new Date("2026-03-31T16:00:00.000Z"), to: new Date("2026-04-30T15:59:59.999Z") },
    });

    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({ netFen, cumulativeNetFen: netFen });
    expect(Number.isSafeInteger(result.points[0].cumulativeNetFen)).toBe(true);
  });

  it("preserves early Gregorian years and leap-month boundaries", () => {
    const report = aggregateHomeReport({
      range: { mode: "custom", month: "0004-02", year: "0004", from: new Date("0004-01-31T16:00:00.000Z"), to: new Date("0004-02-29T15:59:59.999Z") },
      rangeOptions: { months: ["0004-02"], years: ["0004"] },
      timezone: "Asia/Shanghai",
      transactions: [],
    });

    expect(report.balanceTrend.points).toHaveLength(1);
    expect(report.balanceTrend.points[0]).toMatchObject({ bucketKey: "0004-02", bucketStart: report.range.from, bucketEnd: report.range.to, netFen: 0, cumulativeNetFen: 0 });
  });

  it("returns an empty monthly sequence when the existing trend is empty", () => {
    expect(buildMonthlyBalanceTrend({
      trend: { granularity: "day", points: [] },
      range: { from: new Date("2026-03-31T16:00:00.000Z"), to: new Date("2026-04-30T15:59:59.999Z") },
    })).toEqual({ granularity: "month", points: [] });
  });
});
