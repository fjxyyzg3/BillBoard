import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TrendChartPlot } from "@/components/trend-chart-plot";

describe("TrendChartPlot", () => {
  test("lets keyboard users select every date in a complete month", () => {
    const markup = renderToStaticMarkup(
      <TrendChartPlot
        labels={{ income: "Income", expense: "Expense", tx: "transactions", hint: "Choose a date", viewRecords: "View records" }}
        points={Array.from({ length: 31 }, (_, index) => ({
          key: `2026-10-${index + 1}`,
          label: `October ${index + 1}`,
          incomeFen: 0,
          expenseFen: index * 100,
          transactionCount: index === 0 ? 0 : 1,
        }))}
      />,
    );

    expect(markup).toContain('type="range"');
    expect(markup).toContain('max="30"');
    expect(markup).toContain('aria-label="Choose a date"');
    expect(markup).toContain("October 31");
  });

  test("announces a negative month net and includes a zero baseline without invalid coordinates", () => {
    const markup = renderToStaticMarkup(
      <TrendChartPlot
        labels={{ income: "Income", expense: "Expense", tx: "transactions", hint: "Choose a month", viewRecords: "View records", net: "Net", cumulative: "Cumulative net" }}
        points={[{ key: "2026-01", label: "January 2026", incomeFen: 0, expenseFen: 12500, netFen: -12500, cumulativeNetFen: -12500, transactionCount: 1 }]}
        view="balance"
      />,
    );

    expect(markup).toContain('data-trend-view="balance"');
    expect(markup).toContain("Net −¥125.00");
    expect(markup).toContain('data-testid="trend-zero-axis"');
    expect(markup).toContain('data-testid="trend-series-point"');
    expect(markup).not.toMatch(/NaN|Infinity/);
    const zeroY = markup.match(/data-testid="trend-zero-axis"[^>]*y1="([^"]+)"/)?.[1];
    const pointY = markup.match(/data-testid="trend-series-point"[^>]*y1="([^"]+)"/)?.[1];
    expect(Number(zeroY)).toBeLessThan(Number(pointY));
  });

  test("plots and announces cumulative values rather than the independent month net", () => {
    const markup = renderToStaticMarkup(
      <TrendChartPlot
        labels={{ income: "Income", expense: "Expense", tx: "transactions", hint: "Choose a month", viewRecords: "View records", net: "Net", cumulative: "Cumulative net" }}
        points={[{ key: "2026-02", label: "February 2026", incomeFen: 0, expenseFen: 100000, netFen: -100000, cumulativeNetFen: 200000, transactionCount: 1 }]}
        view="cumulative"
      />,
    );

    expect(markup).toContain("Cumulative net ¥2,000.00");
    expect(markup).not.toContain("Cumulative net −¥1,000.00");
    expect(markup).not.toMatch(/NaN|Infinity/);
  });

  test("keeps an empty single month visible and selectable at zero", () => {
    const markup = renderToStaticMarkup(
      <TrendChartPlot
        labels={{ income: "Income", expense: "Expense", tx: "transactions", hint: "Choose a month", viewRecords: "View records", net: "Net", cumulative: "Cumulative net" }}
        points={[{ key: "2026-02", label: "February 2026", incomeFen: 0, expenseFen: 0, netFen: 0, cumulativeNetFen: 0, transactionCount: 0 }]}
        view="balance"
      />,
    );

    expect(markup).toContain("Net ¥0.00");
    expect(markup).toContain('max="0"');
    expect(markup).toContain('data-testid="trend-series-point"');
    expect(markup).not.toMatch(/NaN|Infinity/);
  });
});
