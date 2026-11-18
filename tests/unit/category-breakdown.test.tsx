import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoryBreakdown } from "@/components/category-breakdown";

describe("CategoryBreakdown", () => {
  it("renders legend labels until cumulative share exceeds 90 percent and folds the rest into other", () => {
    const items = [
      { amountFen: 400000, categoryId: "cat-care", categoryName: "Care", share: 0.4, transactionCount: 2 },
      {
        amountFen: 300000,
        categoryId: "cat-property",
        categoryName: "Property",
        share: 0.3,
        transactionCount: 1,
      },
      {
        amountFen: 220000,
        categoryId: "cat-clothing",
        categoryName: "Clothing",
        share: 0.22,
        transactionCount: 1,
      },
      { amountFen: 50000, categoryId: "cat-meals", categoryName: "Meals", share: 0.05, transactionCount: 1 },
      {
        amountFen: 30000,
        categoryId: "cat-education",
        categoryName: "Education",
        share: 0.03,
        transactionCount: 1,
      },
    ];

    const markup = renderToStaticMarkup(
      <CategoryBreakdown
        getCategoryHref={(item) => `/records?category=${item.categoryId}`}
        items={items}
        labels={{
          empty: "当前筛选下还没有支出记录。",
          otherCategory: "其他",
          title: "分类分析",
          transactionCount: (countLabel) => `${countLabel} 笔记录`,
        }}
        locale="zh-CN"
        summaryLabel="总支出 10,000.00 · 8 笔记录"
        totalExpenseLabel={(amountFen) => (amountFen / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}
      />,
    );

    expect(markup).toContain('data-testid="category-donut-chart"');
    expect(markup).toContain("总支出 10,000.00 · 8 笔记录");
    expect(markup).toContain("Care 40%");
    expect(markup).toContain("Property 30%");
    expect(markup).toContain("Clothing 22%");
    expect(markup).toContain("其他 8%");
    expect(markup).not.toContain("Meals 5%");
    expect(markup).not.toContain("Education 3%");
    expect(markup.match(/data-testid="category-chart-label"/g)).toHaveLength(4);
    expect(markup).toContain('data-testid="category-row-progress"');
    expect(markup).toContain("--category-color:");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("查看全部分类");
    const extraRowsIndex = markup.indexOf('data-testid="category-extra-rows"');
    expect(extraRowsIndex).toBeGreaterThan(0);
    const visibleRows = markup.slice(0, extraRowsIndex);
    const extraRows = markup.slice(extraRowsIndex);
    expect(visibleRows).toContain('href="/records?category=cat-clothing"');
    expect(visibleRows).not.toContain('href="/records?category=cat-meals"');
    expect(extraRows).toContain('href="/records?category=cat-meals"');
    expect(extraRows).toContain('href="/records?category=cat-education"');
    expect(extraRows).toContain('aria-hidden="true"');
    expect(extraRows).toContain('inert=""');
  });

  it("uses the shared category palette for chart arcs and row progress", () => {
    const items = [
      {
        amountFen: 70000,
        categoryId: "cat-dining",
        categoryName: "Dining",
        share: 0.7,
        transactionCount: 3,
      },
      {
        amountFen: 30000,
        categoryId: "cat-transport",
        categoryName: "Transport",
        share: 0.3,
        transactionCount: 1,
      },
    ];

    const markup = renderToStaticMarkup(
      <CategoryBreakdown
        getCategoryHref={(item) => `/records?category=${item.categoryId}`}
        items={items}
        labels={{
          empty: "当前筛选下还没有支出记录。",
          otherCategory: "其他",
          title: "分类分析",
          transactionCount: (countLabel) => `${countLabel} 笔记录`,
        }}
        locale="zh-CN"
        totalExpenseLabel={(amountFen) => (amountFen / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}
      />,
    );

    expect(markup).toContain('stroke="#D48673"');
    expect(markup).toContain('stroke="#78A785"');
    expect(markup).toContain("--category-color:#D48673");
    expect(markup).toContain("--category-color:#78A785");
    expect(markup).not.toContain("查看全部分类");
  });
});
