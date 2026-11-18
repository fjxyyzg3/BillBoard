import { randomUUID } from "node:crypto";
import { PrismaClient, TransactionType } from "@prisma/client";
import { expect, test, type Page } from "./fixtures";

test.use({ actionTimeout: 10_000 });

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function testDatabase() {
  const url = new URL(requireEnv("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/(?:dev|test)/i.test(url.pathname)) {
    throw new Error("Report fixtures require the local development/test database");
  }
  return new PrismaClient();
}

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

const homeUrl = "/home?mode=month&month=2021-07&year=2021";
let database: PrismaClient;
let transactionIds: string[];

test.beforeEach(async () => {
  database = testDatabase();
  transactionIds = [];
  const user = await database.user.findUniqueOrThrow({
    where: { email: requireEnv("SEED_USER_A_EMAIL") },
    include: { householdMember: { where: { leftAt: null }, take: 1 } },
  });
  const member = user.householdMember[0];
  if (!member) throw new Error("Report fixture requires a seeded household member");
  const ledger = await database.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true } });
  const partner = await database.householdMember.findFirstOrThrow({
    where: { householdId: member.householdId, id: { not: member.id } },
  });
  const categories = await database.category.findMany({
    where: { name: { in: ["Dining", "Shopping", "Salary"] }, isActive: true },
  });
  const entries = [
    { date: "2021-06-01", category: "Dining", amountFen: 10000, memberId: member.id },
    { date: "2021-06-10", category: "Shopping", amountFen: 5000, memberId: partner.id },
    { date: "2021-06-15", category: "Salary", amountFen: 100000, memberId: member.id },
    { date: "2021-07-05", category: "Dining", amountFen: 4999, memberId: member.id },
    { date: "2021-07-10", category: "Shopping", amountFen: 5000, memberId: partner.id },
    { date: "2021-07-20", category: "Dining", amountFen: 20000, memberId: partner.id },
    { date: "2021-07-25", category: "Salary", amountFen: 100000, memberId: member.id },
  ];
  const data = entries.map((entry) => {
    const category = categories.find((item) => item.name === entry.category);
    if (!category) throw new Error(`Missing seeded category: ${entry.category}`);
    const id = randomUUID();
    transactionIds.push(id);
    return {
      id,
      householdId: member.householdId,
      ledgerId: ledger.id,
      actorMemberId: entry.memberId,
      createdByMemberId: entry.memberId,
      categoryId: category.id,
      type: entry.category === "Salary" ? TransactionType.INCOME : TransactionType.EXPENSE,
      amountFen: entry.amountFen,
      occurredAt: new Date(`${entry.date}T12:00:00+08:00`),
      note: `Report analytics ${entry.date}`,
    };
  });
  await database.transaction.createMany({ data });
});

test.afterEach(async () => {
  if (database) {
    try {
      await database.transaction.deleteMany({ where: { id: { in: transactionIds } } });
    } finally {
      await database.$disconnect();
    }
  }
});

test("report views reconcile household amounts with calendar, category and encrypted amount drilldowns", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await logIn(page);
  await page.goto(homeUrl);

  const panel = page.getByTestId("report-analytics");
  const view = page.getByTestId("report-analysis-view");
  await expect(page.getByTestId("summary-card").first().locator(".ios-amount")).toHaveText("¥299.99");
  await expect(panel).toContainText("149.99");
  await expect(page.getByTestId("report-monthly-summary")).toContainText("200.00");

  const previous = panel.locator("section").filter({ has: page.getByRole("heading", { name: "上期", exact: true }) });
  await previous.getByRole("link").filter({ hasText: "150.00" }).click();
  await expect(page.locator('a[href*="record="]')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get("mode")).toBe("month");
  expect(new URL(page.url()).searchParams.get("month")).toBe("2021-07");
  await page.getByRole("link", { name: "返回原时间范围", exact: true }).click();
  await expect(page.locator('a[href*="record="]')).toHaveCount(3);
  await page.getByRole("navigation").getByRole("link", { name: "首页", exact: true }).click();
  await expect(page.getByTestId("summary-card").first().locator(".ios-amount")).toHaveText("¥299.99");

  await view.selectOption("categories");
  const dining = panel.locator("li").filter({ has: page.getByRole("heading", { name: "餐饮", exact: true }) });
  await expect(dining).toContainText("249.99");
  await expect(dining).toContainText("2 笔");
  await dining.getByRole("link").filter({ hasText: "249.99" }).click();
  await expect(page.locator('a[href*="record="]')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get("category")).toBeTruthy();

  await page.goto(homeUrl);
  await view.selectOption("calendar");
  await page.getByTestId("report-calendar").locator('a[href*="from=2021-07-19"]').click();
  await expect(page.locator('a[href*="record="]')).toHaveCount(1);
  await expect(page.locator('a[href*="record="]').first()).toContainText("Report analytics 2021-07-20");
  expect(new URL(page.url()).searchParams.get("to")).toBe("2021-07-20T15:59:59.999Z");

  await page.goto(homeUrl);
  await view.selectOption("cumulative");
  const slider = panel.getByRole("slider", { name: "累计支出日期" });
  await slider.focus();
  await slider.press("Home");
  await expect(page.getByTestId("report-cumulative-detail")).toContainText("2021年7月1日");
  await slider.press("End");
  await expect(page.getByTestId("report-cumulative-detail")).toContainText("299.99");

  await view.selectOption("distribution");
  await expect(panel.locator("dl > div").filter({ hasText: "单笔中位数" })).toContainText("50.00");
  await expect(panel.locator("dl > div").filter({ hasText: "最大单笔支出" })).toContainText("200.00");
  await expect(panel).toContainText("100%");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("report-distribution-mobile.png"), fullPage: true });
  await page.getByTestId("report-distribution").getByRole("link").filter({ hasText: "¥50–199.99" }).click();
  await expect(page.locator('a[href*="record="]')).toHaveCount(1);
  await expect(page.locator('a[href*="record="]').first()).toContainText("Report analytics 2021-07-10");
  const amountParams = new URL(page.url()).searchParams;
  expect(amountParams.get("amount")).toMatch(/^v3\./);
  expect(amountParams.get("ledger")).toBe("all");
  expect(amountParams.get("entryLedger")).toBeTruthy();
  expect(amountParams.has("minFen")).toBe(false);
  expect(amountParams.has("maxFen")).toBe(false);
  expect(amountParams.get("type")).toBe("expense");

  await page.goto("/home?mode=year&month=2021-07&year=2021");
  await view.selectOption("annual");
  await panel.getByLabel("选择分类", { exact: true }).selectOption({ label: "餐饮" });
  await expect(panel.getByRole("heading", { name: "餐饮 · 月度走势" })).toBeVisible();
  await panel.getByRole("table").getByRole("link", { name: /餐饮, 2021年7月,/ }).click();
  await expect(page.locator('a[href*="record="]')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get("from")).toBe("2021-06-30T16:00:00.000Z");
});

test("custom date validation and shared navigation work on mobile in Chinese and English", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await logIn(page);
  await page.goto(homeUrl);
  await expect(page.getByTestId("summary-card").first().locator(".ios-amount")).toHaveText("¥299.99");
  await page.getByTestId("report-range-trigger").click();
  const sheet = page.getByRole("dialog", { name: "时间范围", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("combobox", { name: "月份", exact: true }).selectOption("06");
  await expect(page).toHaveURL((url) => url.searchParams.get("month") === "2021-06");
  await sheet.getByRole("button", { name: "自定义", exact: true }).click();
  await expect(sheet.getByLabel("开始日期")).toHaveValue("2021-06-01");
  await expect(sheet.getByLabel("结束日期")).toHaveValue("2021-06-30");
  await sheet.getByLabel("开始日期").fill("2021-07-20");
  await sheet.getByLabel("结束日期").fill("2021-07-05");
  await sheet.getByRole("button", { name: "应用日期" }).click();
  await expect(sheet.getByRole("alert")).toBeVisible();
  await expect(sheet.getByLabel("开始日期")).toHaveValue("2021-07-20");
  await sheet.getByLabel("开始日期").fill("2021-07-05");
  await sheet.getByLabel("结束日期").fill("2021-07-10");
  await sheet.getByRole("button", { name: "应用日期" }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("mode") === "custom" && url.searchParams.get("start") === "2021-07-05" && url.searchParams.get("end") === "2021-07-10");
  await expect(page.getByTestId("summary-card").first().locator(".ios-amount")).toHaveText("¥99.99");
  await expect(page.getByTestId("report-monthly-summary")).toHaveCount(0);
  const navigation = page.getByRole("navigation");
  await navigation.getByRole("link", { name: "记一笔", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/add" && url.searchParams.get("start") === "2021-07-05" && url.searchParams.get("end") === "2021-07-10");
  await navigation.getByRole("link", { name: "记录", exact: true }).click();
  await expect(page.locator('a[href*="record="]')).toHaveCount(2);
  await navigation.getByRole("link", { name: "首页", exact: true }).click();
  await expect(page.getByTestId("summary-card").first().locator(".ios-amount")).toHaveText("¥99.99");
  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("button", { name: "切换语言" }).click();
  await expect(page.getByLabel("Analysis view")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "More options", exact: true })).toBeHidden();
  await page.getByLabel("Analysis view").selectOption("calendar");
  await expect(page.getByLabel("Calendar month")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("report-custom-calendar-english-mobile.png"), fullPage: true });
  await page.getByTestId("report-range-trigger").click();
  await page.getByRole("dialog").getByRole("button", { name: "Last 3 months", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("mode") === "recent" && !url.searchParams.has("start") && !url.searchParams.has("end"));
});
