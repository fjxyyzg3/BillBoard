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

test("legacy member links show household totals and preserve household drilldowns", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);

  const marker = `E2E household drilldown ${Date.now()}`;
  const memberA = requireEnv("SEED_USER_A_NAME");
  const memberB = requireEnv("SEED_USER_B_NAME");
  const entries = [
    { amount: "12.34", category: "购物", member: memberA, note: `${marker} expense A`, type: "expense", occurredAt: "2021-02-03T09:00" },
    { amount: "45.67", category: "购物", member: memberB, note: `${marker} expense B`, type: "expense", occurredAt: "2021-02-03T10:00" },
    { amount: "123.45", category: "工资", member: memberA, note: `${marker} income A`, type: "income", occurredAt: "2021-02-03T11:00" },
    { amount: "234.56", category: "工资", member: memberB, note: `${marker} income B`, type: "income", occurredAt: "2021-02-03T12:00" },
    { amount: "20.00", category: "餐饮", member: memberA, note: `${marker} next day`, type: "expense", occurredAt: "2021-02-04T09:00" },
  ];

  for (const entry of entries) {
    await page.goto("/add");
    await page.getByLabel("金额", { exact: true }).fill(entry.amount);
    await page.getByText(entry.type === "income" ? "收入" : "支出", { exact: true }).click();
    await page.getByRole("radio", { name: entry.category, exact: true }).check();
    await page.getByRole("radio", { name: entry.member, exact: true }).check();
    await page.locator('input[name="occurredAt"]').fill(entry.occurredAt);
    await page.getByRole("button", { name: "添加备注", exact: true }).click();
    await page.getByLabel("备注", { exact: true }).fill(entry.note);
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
  }

  const rangeQuery = "mode=month&month=2021-02&year=2021";
  const legacyHomeUrl = `/home?${rangeQuery}&perspective=spouse`;
  const cards = page.getByTestId("summary-card");
  const recordLinks = page.locator('a[href*="record="]');
  const categorySection = page.locator("section.ios-panel").filter({ hasText: "分类分析" });

  async function expectRecords(expectedEntries: typeof entries) {
    await expect(recordLinks).toHaveCount(expectedEntries.length);
    for (const entry of expectedEntries) {
      const record = recordLinks.filter({ hasText: entry.note });
      await expect(record).toBeVisible();
      await expect(record).toContainText(entry.member);
      await expect(record).toContainText(entry.category);
      await expect(record.locator(".ios-amount")).toHaveText(`${entry.type === "income" ? "+" : "-"}${entry.amount}`);
    }
  }

  function expectDrilldownUrl() {
    const url = new URL(page.url());
    expect(url.pathname).toBe("/records");
    expect(url.searchParams.has("perspective")).toBe(false);
    expect(url.searchParams.get("mode")).toBe("month");
    expect(url.searchParams.get("month")).toBe("2021-02");
    expect(url.searchParams.get("year")).toBe("2021");
    expect(url.searchParams.get("sort")).toBe("amount-desc");
    return url.searchParams;
  }

  for (const legacyPerspective of ["me", "spouse"]) {
    await page.goto(`/home?${rangeQuery}&perspective=${legacyPerspective}`);
    await expect(cards.nth(0).locator(".ios-amount")).toHaveText("¥78.01");
    await expect(cards.nth(1).locator(".ios-amount")).toHaveText("¥358.01");
    await expect(cards.nth(2).locator(".ios-amount")).toHaveText("¥280.00");
    await expect(page.getByTestId("summary-grid").getByRole("link", { name: "5 笔记录 ›", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(家庭|我|对方)$/ })).toHaveCount(0);
    await expect(categorySection).toContainText("总支出 78.01 · 3 笔记录");
    const shopping = categorySection.getByRole("link").filter({ hasText: "购物" });
    await expect(shopping).toContainText("2 笔记录");
    await expect(shopping.locator(".ios-amount")).toHaveText("58.01");

    const headerBox = await page.getByRole("heading", { name: "首页", exact: true }).locator("..").boundingBox();
    const summaryBox = await page.getByTestId("summary-grid").boundingBox();
    expect(summaryBox!.y - headerBox!.y - headerBox!.height).toBeLessThanOrEqual(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    if (legacyPerspective === "spouse") {
      await page.screenshot({ path: testInfo.outputPath("household-home-mobile.png"), fullPage: true });
    }

    await page.goto(`/records?${rangeQuery}&perspective=${legacyPerspective}`);
    await expectRecords(entries);
    await expect(page.getByRole("button", { name: /^(家庭|我|对方)$/ })).toHaveCount(0);
    await expect(page.locator('a[href*="perspective="]')).toHaveCount(0);
    if (legacyPerspective === "spouse") {
      await page.screenshot({ path: testInfo.outputPath("household-records-mobile.png"), fullPage: true });
    }
  }

  await page.goto(legacyHomeUrl);
  await cards.nth(0).click();
  await expectRecords(entries.filter((entry) => entry.type === "expense"));
  expect(expectDrilldownUrl().get("type")).toBe("expense");

  await page.goto(legacyHomeUrl);
  await cards.nth(1).click();
  await expectRecords(entries.filter((entry) => entry.type === "income"));
  expect(expectDrilldownUrl().get("type")).toBe("income");

  await page.goto(legacyHomeUrl);
  await categorySection.getByRole("link").filter({ hasText: "购物" }).click();
  await expectRecords(entries.filter((entry) => entry.category === "购物"));
  const categoryParams = expectDrilldownUrl();
  expect(categoryParams.get("category")).toBeTruthy();
  expect(categoryParams.get("type")).toBe("expense");

  await page.goto(legacyHomeUrl);
  await categorySection.getByRole("link", { name: "收入", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("categoryType") === "income" && !url.searchParams.has("perspective"));
  await expect(categorySection).toContainText("总收入 358.01 · 2 笔记录");
  await categorySection.getByRole("link").filter({ hasText: "工资" }).click();
  await expectRecords(entries.filter((entry) => entry.type === "income"));
  expect(expectDrilldownUrl().get("type")).toBe("income");
  expect(expectDrilldownUrl().get("category")).toBeTruthy();

  await page.goto(legacyHomeUrl);
  const picker = page.getByTestId("trend-date-picker");
  await expect(picker).toBeEnabled();
  await picker.focus();
  await picker.press("Home");
  await picker.press("ArrowRight");
  await picker.press("ArrowRight");
  const detail = page.getByTestId("trend-detail");
  await expect(detail).toContainText("2月3日");
  await expect(detail).toContainText("收入 ¥358.01");
  await expect(detail).toContainText("支出 ¥58.01");
  await expect(detail).toContainText("4 笔");
  await detail.getByRole("link", { name: "查看记录" }).click();
  await expectRecords(entries.filter((entry) => entry.occurredAt.startsWith("2021-02-03")));
  const dailyParams = expectDrilldownUrl();
  expect(dailyParams.get("from")).toBe("2021-02-02T16:00:00.000Z");
  expect(dailyParams.get("to")).toBe("2021-02-03T15:59:59.999Z");
  await page.getByRole("link", { name: "返回原时间范围", exact: true }).click();
  await expectRecords(entries);
  const restoredParams = expectDrilldownUrl();
  expect(restoredParams.has("from")).toBe(false);
  expect(restoredParams.has("to")).toBe(false);
});
