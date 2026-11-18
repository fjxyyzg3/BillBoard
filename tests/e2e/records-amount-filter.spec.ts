import { expect, test, type Page } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function createExpense(page: Page, amount: string, note: string) {
  await page.goto("/add?mode=all");
  await page.getByLabel("金额").fill(amount);
  await page.getByRole("radio", { name: "购物", exact: true }).check();
  await page.getByRole("radio", { name: requireEnv("SEED_USER_B_NAME"), exact: true }).check();
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注", { exact: true }).fill(note);
  await page.getByRole("button", { name: "保存记录" }).click();
  await expect(page.getByText("记录已保存")).toBeVisible();
}

function expectOpaqueAmountUrl(page: Page) {
  const params = new URL(page.url()).searchParams;
  const token = params.get("amount");

  expect(token).toBeTruthy();
  expect(token).not.toBe("200");
  expect(token).not.toBe("20000");
  for (const field of ["amountMode", "amountExact", "amountMin", "amountMax"]) {
    expect(params.has(field)).toBe(false);
  }
}

async function showFilters(page: Page) {
  const toggle = page.getByRole("button", { name: "筛选", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") {
    await toggle.click();
  }
}

test("users can refine existing filters by exact or inclusive amounts and restore them", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const note = `E2E amount boundaries ${Date.now()}`;

  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);
  for (const amount of ["199.99", "200.00", "300.00", "300.01"]) {
    await createExpense(page, amount, note);
  }

  await page.goto("/records?perspective=spouse&mode=all&type=expense&sort=amount-asc");
  await showFilters(page);
  await page.getByLabel("分类").selectOption({ label: "购物" });
  await page.getByRole("button", { name: "应用筛选", exact: true }).click();
  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("category")));
  const categoryId = new URL(page.url()).searchParams.get("category");
  const secondPageUrl = new URL(page.url());
  secondPageUrl.searchParams.set("page", "2");
  await page.goto(secondPageUrl.toString());

  await page.getByLabel("搜索记录", { exact: true }).fill(note);
  await showFilters(page);
  await page.getByLabel("金额筛选", { exact: true }).selectOption({ label: "精确金额" });
  await page.getByLabel("精确金额（元）", { exact: true }).fill("200");
  await page.getByRole("button", { name: "应用筛选", exact: true }).click();
  await expect(page).toHaveURL((url) => {
    return Boolean(url.searchParams.get("search")) &&
      Boolean(url.searchParams.get("amount")) &&
      !url.searchParams.has("page");
  });

  const exactUrl = page.url();
  const exactParams = new URL(exactUrl).searchParams;
  expect(exactParams.get("mode")).toBe("all");
  expect(exactParams.has("perspective")).toBe(false);
  expect(exactParams.get("type")).toBe("expense");
  expect(exactParams.get("category")).toBe(categoryId);
  expect(exactParams.get("sort")).toBe("amount-asc");
  expect(exactUrl).not.toContain(note);
  expectOpaqueAmountUrl(page);
  const recordLinks = page.locator('a[href*="record="]');
  await expect(recordLinks).toHaveCount(1);
  await expect(recordLinks.first()).toContainText("-200.00");

  await page.reload();
  await expect(page.getByLabel("搜索记录", { exact: true })).toHaveValue(note);
  await expect(page.getByLabel("精确金额（元）", { exact: true })).toHaveValue("200.00");

  await showFilters(page);
  await page.getByLabel("金额筛选", { exact: true }).selectOption({ label: "金额范围" });
  await page.getByLabel("最低金额（元）", { exact: true }).fill("200");
  await page.getByLabel("最高金额（元）", { exact: true }).fill("300");
  await page.getByRole("button", { name: "应用筛选", exact: true }).click();
  await expect(recordLinks).toHaveCount(2);
  await expect(recordLinks.nth(0)).toContainText("-200.00");
  await expect(recordLinks.nth(1)).toContainText("-300.00");
  expectOpaqueAmountUrl(page);
  const rangeUrl = page.url();

  await page.goBack();
  await expect(page).toHaveURL(exactUrl);
  await expect(page.getByLabel("精确金额（元）", { exact: true })).toHaveValue("200.00");
  await expect(recordLinks).toHaveCount(1);
  await page.goForward();
  await expect(page).toHaveURL(rangeUrl);
  await expect(page.getByLabel("最低金额（元）", { exact: true })).toHaveValue("200.00");
  await expect(page.getByLabel("最高金额（元）", { exact: true })).toHaveValue("300.00");
  await page.reload();
  await expect(page.getByLabel("搜索记录", { exact: true })).toHaveValue(note);
  await expect(page.getByLabel("最低金额（元）", { exact: true })).toHaveValue("200.00");
  await expect(page.getByLabel("最高金额（元）", { exact: true })).toHaveValue("300.00");
  await expect(recordLinks).toHaveCount(2);
  await expect(page.getByTestId("app-route-loading")).toHaveCount(0);
  await expect(recordLinks.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("amount-filter-mobile.png"), fullPage: true, animations: "disabled" });

  await showFilters(page);
  await page.getByLabel("最低金额（元）", { exact: true }).fill("300");
  await page.getByLabel("最高金额（元）", { exact: true }).fill("200");
  await page.getByRole("button", { name: "应用筛选", exact: true }).click();
  const amountError = page.locator('form[action="/records/search"]').getByRole("alert");
  await expect(amountError).toHaveText("最低金额不能大于最高金额");
  await expect(page).toHaveURL(rangeUrl);
  await expect(recordLinks).toHaveCount(2);

  await page.getByRole("dialog", { name: "筛选", exact: true })
    .getByRole("button", { name: "关闭", exact: true }).click();

  const paramsBeforeClear = new URL(rangeUrl).searchParams;
  await page.getByRole("button", { name: "清空金额", exact: true }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("amount"));
  const clearedParams = new URL(page.url()).searchParams;
  for (const field of ["mode", "type", "category", "sort", "search"]) {
    expect(clearedParams.get(field)).toBe(paramsBeforeClear.get(field));
  }
  expect(clearedParams.has("perspective")).toBe(false);
  await expect(page.getByLabel("金额筛选", { exact: true }).locator("option:checked")).toHaveText("不限金额");
  await expect(page.getByLabel("搜索记录", { exact: true })).toHaveValue(note);
  await expect(amountError).toHaveCount(0);
  await expect(recordLinks).toHaveCount(4);
});

test("users can edit a matched record without losing the amount and keyword filters", async ({ page }) => {
  const note = `E2E amount edit ${Date.now()}`;

  await logIn(page);
  await createExpense(page, "280", note);
  await page.goto("/records?perspective=spouse&mode=all&type=expense");
  await page.getByLabel("搜索记录", { exact: true }).fill(note);
  await showFilters(page);
  await page.getByLabel("金额筛选", { exact: true }).selectOption({ label: "金额范围" });
  await page.getByLabel("最低金额（元）", { exact: true }).fill("200");
  await page.getByLabel("最高金额（元）", { exact: true }).fill("300");
  await page.getByRole("button", { name: "应用筛选", exact: true }).click();
  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("amount")));
  const filteredUrl = page.url();

  await page.getByRole("link", { name: /购物.*-280\.00/ }).click();
  const editorDrawer = page.getByRole("dialog", { name: "编辑记录", exact: true });
  await expect(editorDrawer).toBeVisible();
  await expect(editorDrawer.getByRole("textbox", { name: "备注", exact: true })).toHaveValue(note);
  await editorDrawer.getByLabel("金额").fill("220");
  await editorDrawer.getByRole("button", { name: "保存修改" }).click();

  await expect(page).toHaveURL(filteredUrl);
  await expect(page.getByLabel("搜索记录", { exact: true })).toHaveValue(note);
  await expect(page.getByLabel("最低金额（元）", { exact: true })).toHaveValue("200.00");
  await expect(page.getByLabel("最高金额（元）", { exact: true })).toHaveValue("300.00");
  await expect(page.locator('a[href*="record="]')).toHaveCount(1);
  await expect(page.getByRole("link", { name: /购物.*-220\.00/ })).toBeVisible();
  await expect(editorDrawer).toHaveCount(0);
});
