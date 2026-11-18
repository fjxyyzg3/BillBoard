import { expect, test, type Page } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

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

async function createLargeIncome(page: Page) {
  const note = `E2E layout amount ${Date.now()}`;

  await page.goto("/add");
  await expect(page.getByLabel("金额")).toBeEditable();
  await page.getByText("收入", { exact: true }).click();
  await page.getByLabel("金额").fill("21474836.47");
  await page.getByRole("radio", { name: "工资" }).check();
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注").fill(note);
  await page.getByRole("button", { name: "保存记录" }).click();
  await expect(page.getByText("记录已保存")).toBeVisible();
}

test("home summary cards keep a stable mobile grid without amount overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);
  await createLargeIncome(page);
  await page.goto("/home");

  const summaryGrid = page.getByTestId("summary-grid");
  await expect(summaryGrid).toBeVisible();

  const columnCount = await summaryGrid.evaluate((element) => {
    return getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length;
  });

  expect(columnCount).toBe(2);

  const summaryCards = page.getByTestId("summary-card");
  await expect(summaryCards).toHaveCount(3);
  await expect(summaryCards.first()).toContainText("所选范围支出");
  const primaryBox = await summaryCards.first().boundingBox();
  const gridBox = await summaryGrid.boundingBox();
  expect(primaryBox!.width).toBeGreaterThan(gridBox!.width * 0.95);

  const overflowCount = await summaryCards.evaluateAll((cards) => {
    return cards.filter((card) => card.scrollWidth > card.clientWidth).length;
  });

  expect(overflowCount).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("home-large-amount.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/records?sort=amount-desc&type=income");
  await expect(page.getByRole("link").filter({ hasText: "+21474836.47" }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("records-large-amount.png") });
});

test("desktop navigation keeps accessible labels after icons are added", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await logIn(page);

  const navigation = page.getByRole("complementary").getByRole("navigation");
  await expect(navigation.getByRole("link", { name: "首页", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "记一笔", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "记录", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "账本", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "AI 对账", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link")).toHaveCount(5);
  await expect(page.getByTestId("summary-grid")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("home-desktop.png"), fullPage: true });
});

test("records header keeps import, date and member controls accessible in the compact layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);
  await page.goto("/records");

  const importLink = page.getByTestId("records-import-link");
  const rangeControls = page.getByTestId("records-range-controls");
  const rangeTrigger = rangeControls.getByTestId("report-range-trigger");
  const memberSelect = page.getByLabel("归属成员", { exact: true });

  await expect(importLink).toBeVisible();
  await expect(rangeControls).toBeVisible();
  await expect(rangeTrigger).toBeVisible();
  await expect(memberSelect).toBeAttached();

  const importBox = await importLink.boundingBox();
  const rangeBox = await rangeControls.boundingBox();
  const triggerBox = await rangeTrigger.boundingBox();

  expect(importBox).not.toBeNull();
  expect(rangeBox).not.toBeNull();
  expect(triggerBox).not.toBeNull();
  expect(importBox!.y + importBox!.height).toBeLessThanOrEqual(rangeBox!.y);
  expect(triggerBox!.height).toBeGreaterThanOrEqual(44);
  await rangeTrigger.click();
  await expect(page.getByRole("dialog", { name: "时间范围", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rangeTrigger).toBeFocused();
  await memberSelect.selectOption({ index: 1 });
  await expect(page).toHaveURL(/member=/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("home category type switch keeps the current scroll position", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await logIn(page);
  await page.goto("/home?mode=all");

  const categorySection = page.locator("section.ios-panel").filter({ hasText: "分类分析" });
  await expect(categorySection).toBeVisible();
  await categorySection.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 40));

  const beforeScrollY = await page.evaluate(() => window.scrollY);
  expect(beforeScrollY).toBeGreaterThan(100);

  await categorySection.getByRole("link", { name: "收入", exact: true }).click();
  await expect(page).toHaveURL(/categoryType=income/);

  const afterScrollY = await page.evaluate(() => window.scrollY);
  expect(afterScrollY).toBeGreaterThan(100);
});
