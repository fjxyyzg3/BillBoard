import { expect, test } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

test("compact record filters discard canceled changes and apply private conditions together", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/records?mode=all");

  const filterToggle = page.getByRole("button", { name: "筛选", exact: true });
  const search = page.getByLabel("搜索记录", { exact: true });
  const typeFilter = page.getByLabel("类型", { exact: true }).and(page.locator("select"));
  const note = `E2E filter draft ${Date.now()}`;
  await expect(filterToggle).toHaveAttribute("aria-expanded", "false");
  await expect(typeFilter).toBeHidden();
  await search.fill(note);
  await filterToggle.click();
  await expect(filterToggle).toHaveAttribute("aria-expanded", "true");
  await page.getByLabel("金额筛选", { exact: true }).selectOption("exact");
  await page.getByLabel("精确金额（元）", { exact: true }).fill("280.50");
  await typeFilter.selectOption("income");
  await expect(search).toHaveValue(note);
  await expect(page.getByLabel("精确金额（元）", { exact: true })).toHaveValue("280.50");
  await page.getByLabel("分类", { exact: true }).selectOption({ label: "工资" });
  await typeFilter.selectOption("expense");
  await expect(page.getByLabel("分类", { exact: true })).toHaveValue("");
  await page.getByLabel("分类", { exact: true }).selectOption({ label: "购物" });
  await page.getByLabel("排序", { exact: true }).selectOption("amount-asc");
  await expect(page).toHaveURL(/\/records\?mode=all$/);
  await page.getByRole("dialog", { name: "筛选", exact: true })
    .getByRole("button", { name: "关闭", exact: true }).click();
  await expect(typeFilter).toBeHidden();
  await expect(search).toHaveValue(note);
  await page.getByRole("button", { name: "搜索", exact: true }).click();

  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("search")));
  const searchOnlyParams = new URL(page.url()).searchParams;
  for (const field of ["amount", "category", "sort", "type"]) {
    expect(searchOnlyParams.has(field)).toBe(false);
  }
  await filterToggle.click();
  await expect(page.getByLabel("金额筛选", { exact: true })).toHaveValue("any");
  await expect(typeFilter).toHaveValue("");
  await expect(page.getByLabel("分类", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("排序", { exact: true })).toHaveValue("");
  await page.getByLabel("金额筛选", { exact: true }).selectOption("exact");
  await page.getByLabel("精确金额（元）", { exact: true }).fill("280.50");
  await typeFilter.selectOption("expense");
  await page.getByLabel("分类", { exact: true }).selectOption({ label: "购物" });
  await page.getByLabel("排序", { exact: true }).selectOption("amount-asc");
  await page.getByRole("button", { name: "应用筛选", exact: true }).click();

  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("amount")));
  const appliedParams = new URL(page.url()).searchParams;
  expect(appliedParams.get("search")).toBeTruthy();
  expect(appliedParams.get("type")).toBe("expense");
  expect(appliedParams.get("category")).toBeTruthy();
  expect(appliedParams.get("sort")).toBe("amount-asc");
  expect(page.url()).not.toContain(note);
  expect(page.url()).not.toContain("280.50");
  expect(appliedParams.has("amountExact")).toBe(false);

  const activeFilters = page.getByRole("group", { name: "已生效筛选" });
  await expect(activeFilters).toBeVisible();
  await activeFilters.getByRole("button", { name: "移除筛选：支出", exact: true }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("type"));
  const afterTypeRemoval = new URL(page.url()).searchParams;
  for (const field of ["mode", "category", "sort", "search", "amount"]) {
    expect(afterTypeRemoval.get(field)).toBe(appliedParams.get(field));
  }
  await activeFilters.getByRole("button", { name: "清空金额", exact: true }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("amount"));
  await expect(search).toHaveValue(note);
  await activeFilters.getByRole("button", { name: "移除筛选：购物", exact: true }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("category"));
  await activeFilters.getByRole("button", { name: "移除筛选：金额从低到高", exact: true }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("sort"));
  await activeFilters.getByRole("button", { name: "清空搜索", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/records"
    && url.searchParams.get("mode") === "all"
    && url.searchParams.get("ledger") === appliedParams.get("ledger")
    && url.searchParams.get("entryLedger") === appliedParams.get("entryLedger")
    && [...url.searchParams.keys()].sort().join(",") === "entryLedger,ledger,mode");
  await expect(activeFilters).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("button", { name: "切换语言", exact: true }).click();
  await expect(page.getByLabel("Search records", { exact: true })).toBeVisible();
  const moreOptions = page.getByRole("button", { name: "More options", exact: true });
  await moreOptions.click();
  await expect(moreOptions).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply filters", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("records-filters-english.png"), fullPage: true });
});
