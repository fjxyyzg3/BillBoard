import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { expect, test } from "@playwright/test";
import type { Locale } from "@/lib/i18n";

let styles: string;

test.beforeAll(async () => {
  const cssPath = path.resolve("src/app/globals.css");
  const result = await postcss([tailwind({ base: process.cwd() })])
    .process(readFileSync(cssPath, "utf8"), { from: cssPath });
  const font = readFileSync("src/assets/fonts/geist-latin.woff2").toString("base64");
  styles = `@font-face { font-family: Geist; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }
    :root { --font-geist: Geist; }${result.css}`;
});

for (const locale of ["zh-CN", "en-US"] satisfies Locale[]) {
  test(`category chart labels stay readable inside a narrow desktop column in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Render outside Playwright's JSX transform, using the real React component.
    const markup = execFileSync(process.execPath, ["--import", "tsx", "--eval", `
      const { createElement } = require('react');
      const { renderToStaticMarkup } = require('react-dom/server');
      const { CategoryBreakdown } = require('./src/components/category-breakdown.tsx');
      const labels = require('./src/lib/i18n.ts').getMessages(process.env.CHART_LOCALE).home.categories;
      process.stdout.write(renderToStaticMarkup(createElement(CategoryBreakdown, {
        getCategoryHref: item => '/records?category=' + item.categoryId,
        items: [['Dining', 40], ['Transport', 30], ['Shopping', 22], ['Entertainment', 8]].map(([name, share]) =>
          ({ categoryId: name, categoryName: name, share: share / 100, amountFen: share * 10000, transactionCount: 1 })),
        labels: { empty: '', otherCategory: labels.otherCategory, title: labels.title, transactionCount: labels.transactionCount },
        locale: process.env.CHART_LOCALE, totalExpenseLabel: amount => (amount / 100).toFixed(2)
      })));
    `], { encoding: "utf8", env: { ...process.env, CHART_LOCALE: locale }, windowsHide: true });
    await page.setContent(`<style>${styles}</style><main style="width:325px">${markup}</main>`);
    await page.evaluate(() => document.fonts.ready);
    const chart = page.getByTestId("category-donut-chart");
    await expect(chart).toBeVisible();
    const clipped = await chart.locator('[data-testid="category-arc-label"], [data-testid="category-chart-label"]').evaluateAll((elements) => elements.filter((element) => {
      const container = element.closest("svg") ?? element.closest('[data-testid="category-donut-chart"]')!;
      const text = element.getBoundingClientRect();
      const bounds = container.getBoundingClientRect();
      return text.left < bounds.left - 1 || text.right > bounds.right + 1 || element.scrollWidth > element.clientWidth + 1;
    }).map((element) => element.textContent));
    expect(clipped).toEqual([]);
    await expect(chart).toContainText(locale === "zh-CN" ? "购物 22%" : "Shopping 22%");
  });
}
