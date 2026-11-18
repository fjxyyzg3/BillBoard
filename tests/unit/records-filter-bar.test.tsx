import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import {
  buildRecordsFilterHref,
  RecordsFilterBar,
} from "@/components/records-filter-bar";
import { getMessages } from "@/lib/i18n";

vi.mock("next/navigation", () => ({
  usePathname: () => "/records",
  useRouter: () => ({
    replace: vi.fn(),
  }),
  useSearchParams: () =>
    new URLSearchParams(
      "type=expense&category=category-dining&sort=amount-desc&search=v1.opaque-token&amount=v1.amount-token",
    ),
}));

describe("RecordsFilterBar", () => {
  test("keeps search submission separate from unconfirmed advanced filters", () => {
    const markup = renderToStaticMarkup(
      <RecordsFilterBar
        amountFilter={{ mode: "exact", valueFen: 29900 }}
        categories={[]}
        labels={{ common: getMessages("zh-CN").common }}
        locale="zh-CN"
        searchValue="shoes"
      />,
    );
    const forms = markup.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];

    expect(forms).toHaveLength(2);
    expect(forms[0]).toContain('name="search"');
    expect(forms[0]).not.toContain('name="amountMode"');
    expect(forms[0]).not.toContain('name="amountExact"');
    expect(forms[1]).toContain('name="amountMode"');
    expect(markup).toContain('aria-haspopup="dialog"');
  });

  test("renders amount and sorting selects alongside type and category filters", () => {
    const markup = renderToStaticMarkup(
      <RecordsFilterBar
        categories={[
          { id: "category-dining", name: "Dining", type: "expense" },
          { id: "category-salary", name: "Salary", type: "income" },
        ]}
        labels={{ common: getMessages("zh-CN").common }}
        locale="zh-CN"
        searchValue="dinner"
      />,
    );

    expect(markup.match(/<select/g)).toHaveLength(4);
    expect(markup).toContain('action="/records/search"');
    expect(markup).toContain('method="post"');
    expect(markup).toContain('autoComplete="off"');
    expect(markup).toContain('name="returnTo"');
    expect(markup).toContain("&amp;search=v1.opaque-token&amp;amount=v1.amount-token");
    expect(markup).toContain('name="search"');
    expect(markup).toContain('value="dinner"');
    expect(markup).toContain("搜索");
    expect(markup).toContain("清空搜索");
    expect(markup).toContain("排序");
    expect(markup).toContain("金额从高到低");
    expect(markup).toContain('name="amountMode"');
    expect(markup).toContain("不限金额");
    expect(markup).toContain("精确金额");
    expect(markup).toContain("金额范围");
    expect(markup).not.toContain('name="amountExact"');
    expect(markup).not.toContain('name="amountMin"');
    expect(markup).not.toContain('name="amountMax"');
  });

  test("restores an exact amount in yuan in the advanced form", () => {
    const markup = renderToStaticMarkup(
      <RecordsFilterBar
        amountFilter={{ mode: "exact", valueFen: 29900 }}
        categories={[]}
        labels={{ common: getMessages("zh-CN").common }}
        locale="zh-CN"
        searchValue="shoes"
      />,
    );

    expect(markup).toContain('<option value="exact" selected="">');
    expect(markup).toContain('name="amountExact"');
    expect(markup).toContain('inputMode="decimal"');
    expect(markup).toContain('value="299.00"');
    expect(markup).toContain("清空金额");
    const forms = markup.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
    expect(forms[1]).toContain('name="amountExact"');
    expect(forms[1]).toContain('type="submit"');
  });

  test("restores a one-sided inclusive amount range including zero", () => {
    const markup = renderToStaticMarkup(
      <RecordsFilterBar
        amountFilter={{ mode: "range", minFen: 0 }}
        categories={[]}
        labels={{ common: getMessages("en-US").common }}
        locale="en-US"
      />,
    );

    expect(markup).toContain('<option value="range" selected="">');
    expect(markup).toContain('name="amountMin"');
    expect(markup).toContain('name="amountMax"');
    expect(markup).toContain('value="0.00"');
    expect(markup).toContain("Minimum amount (yuan)");
    expect(markup).toContain("Maximum amount (yuan)");
    expect(markup).toContain("Clear amount");
  });

  test("shows a localized server amount validation error", () => {
    const markup = renderToStaticMarkup(
      <RecordsFilterBar
        amountError="invalidAmountRange"
        categories={[]}
        labels={{ common: getMessages("zh-CN").common }}
        locale="zh-CN"
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("最低金额不能大于最高金额");
  });

  test("clears an opaque search token while preserving other filters", () => {
    const href = buildRecordsFilterHref(
      "/records",
      new URLSearchParams("mode=month&month=2026-04&page=3&record=record-1&type=expense"),
      { clearSearch: true },
    );

    expect(href).toBe(
      "/records?mode=month&month=2026-04&record=record-1&type=expense",
    );
  });

  test("clears search without removing other filters", () => {
    const href = buildRecordsFilterHref(
      "/records",
      new URLSearchParams(
        "mode=month&month=2026-04&page=3&record=record-1&type=expense&search=v1.opaque-token&amount=v1.amount-token",
      ),
      { clearSearch: true },
    );

    expect(href).toBe(
      "/records?mode=month&month=2026-04&record=record-1&type=expense&amount=v1.amount-token",
    );
  });

  test("clears the amount condition, its error and legacy perspective while resetting pagination", () => {
    const href = buildRecordsFilterHref(
      "/records",
      new URLSearchParams(
        "mode=month&month=2026-04&perspective=me&type=expense&category=category-dining&sort=amount-desc&search=v1.opaque-token&amount=v1.amount-token&filterError=invalidAmount&page=3&record=record-1",
      ),
      { clearAmount: true },
    );

    expect(href).toBe(
      "/records?mode=month&month=2026-04&type=expense&category=category-dining&sort=amount-desc&search=v1.opaque-token&record=record-1",
    );
  });

  test("builds sorting hrefs without closing the selected record drawer", () => {
    const href = buildRecordsFilterHref(
      "/records",
      new URLSearchParams(
        "mode=month&month=2026-04&year=2026&type=expense&category=category-dining&record=record-1",
      ),
      { sort: "amount-asc" },
    );

    expect(href).toBe(
      "/records?mode=month&month=2026-04&year=2026&type=expense&category=category-dining&record=record-1&sort=amount-asc",
    );
  });

  test("clears the records page cursor when filters change", () => {
    const href = buildRecordsFilterHref(
      "/records",
      new URLSearchParams("mode=month&month=2026-04&year=2026&page=4&type=expense"),
      { categoryId: "category-dining" },
    );

    expect(href).toBe(
      "/records?mode=month&month=2026-04&year=2026&type=expense&category=category-dining",
    );
  });
});
