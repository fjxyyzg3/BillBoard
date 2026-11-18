import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TrendChart } from "@/components/trend-chart";
import type { ReportBalanceTrendPoint, ReportTrendPoint } from "@/lib/reports/aggregate";

const labels = { empty: "No records", expense: "Expense", income: "Income", title: "Trend", tx: "records" };
const day: ReportTrendPoint = {
  bucketKey: "2026-01-02",
  bucketStart: new Date("2026-01-01T16:00:00.000Z"),
  bucketEnd: new Date("2026-01-02T15:59:59.999Z"),
  label: "Jan 2",
  incomeFen: 400000,
  expenseFen: 100000,
  netFen: 300000,
  transactionCount: 2,
};
const month: ReportBalanceTrendPoint = {
  ...day,
  bucketKey: "2026-01",
  bucketStart: new Date("2025-12-31T16:00:00.000Z"),
  bucketEnd: new Date("2026-01-31T15:59:59.999Z"),
  cumulativeNetFen: 300000,
};

describe("TrendChart", () => {
  test("offers the three approved views in order and defaults to cash flow", () => {
    const markup = renderToStaticMarkup(<TrendChart granularity="day" labels={labels} locale="zh-CN" monthlyPoints={[month]} points={[day]} />);
    const buttons = Array.from(markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g));

    expect(buttons.map((match) => match[2])).toEqual(["收支趋势", "结余趋势", "累计结余"]);
    expect(buttons.map((match) => match[1])).toEqual(["true", "false", "false"]);
    expect(markup).toContain('data-trend-view="cashflow"');
    expect(markup).toContain('max="0"');
  });

  test("keeps all three translated views available when the selected range has no records", () => {
    const markup = renderToStaticMarkup(<TrendChart granularity="day" labels={labels} locale="en-US" monthlyPoints={[]} points={[]} />);
    const buttons = Array.from(markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g));

    expect(buttons.map((match) => match[2])).toEqual(["Cash flow", "Net trend", "Cumulative net"]);
    expect(buttons.map((match) => match[1])).toEqual(["true", "false", "false"]);
    expect(markup).toContain("No records");
    expect(markup).not.toContain('data-testid="trend-date-picker"');
  });
});
