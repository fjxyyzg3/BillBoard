import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ReportAnalytics, type ReportAnalyticsLinks } from "@/components/report-analytics";
import { ReportCalendar, ReportCategoryTrends, ReportCumulative, ReportDistribution } from "@/components/report-analytics-charts";
import { buildReportAnalytics } from "@/lib/reports/analytics";
import type { BuildReportAnalyticsInput } from "@/lib/reports/analytics-types";

const input: BuildReportAnalyticsInput = {
  range: { from: "2026-05-01", to: "2026-05-03" },
  previousRange: { from: "2026-04-01", to: "2026-04-03" },
  yearAgoRange: { from: "2025-05-01", to: "2025-05-03" },
  firstRecordedDate: "2025-01-01",
  categories: [
    { period: "current", type: "expense", categoryId: "food", categoryName: "Food", amountFen: 22500, transactionCount: 3 },
    { period: "previous", type: "expense", categoryId: "food", categoryName: "Food", amountFen: 10000, transactionCount: 2 },
    { period: "current", type: "income", categoryId: "salary", categoryName: "Salary", amountFen: 100000, transactionCount: 1 },
  ],
  days: [
    { period: "current", date: "2026-05-01", expenseFen: 7500, expenseCount: 2 },
    { period: "current", date: "2026-05-03", expenseFen: 15000, expenseCount: 1 },
    { period: "previous", date: "2026-04-01", expenseFen: 10000, expenseCount: 2 },
  ],
  categoryMonths: [{ type: "expense", categoryId: "food", categoryName: "Food", month: "2026-05", amountFen: 22500, transactionCount: 3 }],
  distribution: {
    buckets: [{ key: "under-50", amountFen: 2500, transactionCount: 1 }, { key: "50-200", amountFen: 20000, transactionCount: 2 }],
    expenseCount: 3, totalFen: 22500, medianFen: 5000, maxFen: 15000, topFiveAmountFen: 22500,
  },
};

const report = buildReportAnalytics(input);
const selection = { mode: "month" as const, month: "2026-05", year: "2026" };
const links: ReportAnalyticsLinks = {
  current: { all: "/records?mode=month&month=2026-05&year=2026", expense: "/records?mode=month&month=2026-05&year=2026&type=expense", income: "/records?mode=month&month=2026-05&year=2026&type=income" },
  previous: { all: "/records?mode=custom&start=2026-04-01&end=2026-04-03", expense: "/records?mode=custom&start=2026-04-01&end=2026-04-03&type=expense", income: "/records?mode=custom&start=2026-04-01&end=2026-04-03&type=income" },
  yearOverYear: null,
  distribution: { "under-50": "/records?type=expense&amount=encrypted-small", "50-200": "/records?type=expense&amount=encrypted-medium" },
  maximumExpense: "/records?type=expense&amount=encrypted-maximum",
  annual: "/home?mode=year&year=2026",
};

function hrefs(markup: string) {
  return Array.from(markup.matchAll(/href="([^"]+)"/g), ([, href]) => new URL(href.replaceAll("&amp;", "&"), "https://example.test"));
}

describe("report analysis presentation", () => {
  test("shows factual monthly totals and comparison while retaining record links", () => {
    const markup = renderToStaticMarkup(<ReportAnalytics report={report} range={selection} locale="en-US" links={links} />);

    expect(markup).toContain("Income CN¥1,000.00, expenses CN¥225.00, recorded net CN¥775.00.");
    expect(markup).toContain("+CN¥125.00");
    expect(markup).toContain("+125%");
    expect(markup).toContain("The 3 largest expense records account for 100%");
    expect(hrefs(markup).some((href) => href.searchParams.get("amount") === "encrypted-maximum")).toBe(true);
  });

  test("does not generate comparative claims for incomplete history or a monthly review for multi-month ranges", () => {
    const partial = buildReportAnalytics({ ...input, firstRecordedDate: "2026-04-02" });
    const partialMarkup = renderToStaticMarkup(<ReportAnalytics report={partial} range={selection} locale="en-US" links={links} />);
    expect(partialMarkup).toContain("may be incomplete");
    expect(partialMarkup).not.toContain("+125%");
    expect(partialMarkup).not.toContain("The largest category change was");

    const annualMarkup = renderToStaticMarkup(<ReportAnalytics report={report} range={{ ...selection, mode: "year" }} locale="en-US" links={{ ...links, annual: null }} />);
    expect(annualMarkup).not.toContain("Monthly review");
  });

  test("calendar links include the exact Shanghai day and preserve the selected range", () => {
    const markup = renderToStaticMarkup(<ReportCalendar report={report} locale="en-US" links={links} />);
    const firstDay = hrefs(markup)[0];
    expect(firstDay.searchParams.get("month")).toBe("2026-05");
    expect(firstDay.searchParams.get("type")).toBe("expense");
    expect(firstDay.searchParams.get("from")).toBe("2026-04-30T16:00:00.000Z");
    expect(firstDay.searchParams.get("to")).toBe("2026-05-01T15:59:59.999Z");
    expect(hrefs(markup)).toHaveLength(2);
    expect(markup).toContain("No recorded expenses");
    expect(markup).toContain("Outside the selected range");
  });

  test("unplotted dates inside the selected range are described as unrecorded rather than outside it", () => {
    const cropped = { ...report, daily: report.daily.filter((day) => day.date >= "2026-05-03") };
    const markup = renderToStaticMarkup(<ReportCalendar report={cropped} locale="en-US" links={links} />);
    expect(markup).toContain("May 1, 2026: No recorded expenses");
    expect(markup).not.toContain("May 1, 2026: Outside the selected range");
  });

  test("distribution uses supplied opaque links and renders median, maximum and actual concentration", () => {
    const markup = renderToStaticMarkup(<ReportDistribution report={report} locale="en-US" links={links} />);
    expect(markup).toContain("Median expense");
    expect(markup).toContain("CN¥50.00");
    expect(markup).toContain("CN¥150.00");
    expect(markup).toContain("100%");
    expect(hrefs(markup).map((href) => href.searchParams.get("amount"))).toEqual(["encrypted-maximum", "encrypted-small", "encrypted-medium"]);
    expect(hrefs(markup).every((href) => !href.searchParams.has("minFen") && !href.searchParams.has("maxFen"))).toBe(true);
  });

  test("category matrix drilldowns clamp dates to the selected partial month", () => {
    const markup = renderToStaticMarkup(<ReportCategoryTrends report={report} type="expense" locale="en-US" links={links} />);
    const categoryLinks = hrefs(markup).filter((href) => href.searchParams.has("category"));
    expect(categoryLinks.length).toBeGreaterThan(0);
    expect(categoryLinks.every((href) => href.searchParams.get("category") === "food" && href.searchParams.get("from") === "2026-04-30T16:00:00.000Z" && href.searchParams.get("to") === "2026-05-03T15:59:59.999Z")).toBe(true);
  });

  test("cumulative drilldowns use the full elapsed current and baseline windows", () => {
    const markup = renderToStaticMarkup(<ReportCumulative report={report} locale="en-US" links={links} />);
    const [current, previous] = hrefs(markup);
    expect(current.searchParams.get("from")).toBe("2026-04-30T16:00:00.000Z");
    expect(current.searchParams.get("to")).toBe("2026-05-03T15:59:59.999Z");
    expect(previous.searchParams.get("start")).toBe("2026-04-01");
    expect(previous.searchParams.get("to")).toBe("2026-04-03T15:59:59.999Z");
    expect(markup).toContain('type="range"');
    expect(markup).toContain("CN¥225.00");
    expect(markup).toContain("CN¥100.00");
  });

  test("an income-only ledger gives a spending empty state instead of a zero curve", () => {
    const empty = buildReportAnalytics({ ...input, categories: input.categories.filter((row) => row.type === "income"), days: [], categoryMonths: [], distribution: { buckets: [], expenseCount: 0, totalFen: 0, medianFen: null, maxFen: null, topFiveAmountFen: 0 } });
    const markup = renderToStaticMarkup(<ReportCumulative report={empty} locale="en-US" links={links} />);
    expect(markup).toContain("No recorded expenses in this range.");
    expect(markup).not.toContain('type="range"');
  });

  test("a missing cumulative point within its period is described as unavailable history", () => {
    const incomplete = { ...report, cumulative: [{ dayIndex: 2, currentDate: null, currentFen: null, previousDate: "2026-04-02", previousFen: 10000 }] };
    const markup = renderToStaticMarkup(<ReportCumulative report={incomplete} locale="en-US" links={links} />);
    expect(markup).toContain("Historical data unavailable");
    expect(markup).not.toContain("This period has ended");
  });
});
