import { randomUUID } from "node:crypto";
import { PrismaClient, TransactionType } from "@prisma/client";
import { expect, test, type Page } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function testDatabase() {
  const url = new URL(requireEnv("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Balance trend fixtures require a local development/test database");
  }
  return new PrismaClient();
}

let database: PrismaClient;
let transactionIds: string[];
let ledgerId: string;
let archivedLedgerId: string;
let partnerId: string;

test.beforeEach(async () => {
  database = testDatabase();
  transactionIds = [];
  archivedLedgerId = "";
  const user = await database.user.findUniqueOrThrow({
    where: { email: requireEnv("SEED_USER_A_EMAIL") },
    include: { householdMember: { where: { leftAt: null }, take: 1 } },
  });
  const member = user.householdMember[0];
  if (!member) throw new Error("Balance trend fixtures require an active seeded member");
  const ledger = await database.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true } });
  ledgerId = ledger.id;
  partnerId = (await database.householdMember.findFirstOrThrow({ where: { householdId: member.householdId, id: { not: member.id }, leftAt: null } })).id;
  archivedLedgerId = (await database.ledger.create({
    data: { householdId: member.householdId, name: `Balance trend ${randomUUID()}`, archivedAt: new Date() },
  })).id;
  const salary = await database.category.findFirstOrThrow({ where: { name: "Salary", isActive: true } });
  const dining = await database.category.findFirstOrThrow({ where: { name: "Dining", isActive: true } });
  const entries = [
    { date: "2018-12-15", amountFen: 900000, income: true },
    { date: "2019-01-05", amountFen: 500000, income: true },
    { date: "2019-01-15", amountFen: 200000 },
    { date: "2019-02-15", amountFen: 100000, partner: true },
    { date: "2019-03-05", amountFen: 400000, income: true },
    { date: "2019-03-15", amountFen: 200000, partner: true },
    { date: "2019-01-20", amountFen: 99999999, deleted: true },
    { date: "2019-05-15", amountFen: 700000, partner: true, archived: true },
  ];
  await database.transaction.createMany({ data: entries.map((entry) => {
    const id = randomUUID();
    transactionIds.push(id);
    return {
      id, householdId: member.householdId, ledgerId: entry.archived ? archivedLedgerId : ledgerId,
      actorMemberId: entry.partner ? partnerId : member.id, createdByMemberId: member.id,
      categoryId: entry.income ? salary.id : dining.id,
      type: entry.income ? TransactionType.INCOME : TransactionType.EXPENSE,
      amountFen: entry.amountFen, occurredAt: new Date(`${entry.date}T12:00:00+08:00`),
      deletedAt: entry.deleted ? new Date() : null, note: `Balance trend fixture ${entry.date}`,
    };
  }) });
});

test.afterEach(async () => {
  if (!database) return;
  try {
    await database.transaction.deleteMany({ where: { id: { in: transactionIds } } });
    if (archivedLedgerId) await database.ledger.delete({ where: { id: archivedLedgerId } });
  } finally { await database.$disconnect(); }
});

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

function homeUrl(extra = "") {
  return `/home?mode=year&year=2019&month=2019-01&ledger=${encodeURIComponent(ledgerId)}${extra}`;
}

test("monthly net and cumulative lines reconcile with scoped records and keep empty months", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await logIn(page);
  await page.goto(homeUrl());
  const cashflow = page.getByRole("button", { name: "收支趋势", exact: true });
  const balance = page.getByRole("button", { name: "结余趋势", exact: true });
  const cumulative = page.getByRole("button", { name: "累计结余", exact: true });
  await expect(cashflow).toHaveAttribute("aria-pressed", "true");
  await balance.click();
  await expect(balance).toHaveAttribute("aria-pressed", "true");
  const picker = page.getByTestId("trend-date-picker");
  const detail = page.getByTestId("trend-detail");
  await expect(picker).toBeEnabled();
  await picker.focus();
  await picker.press("Home");
  await expect(detail).toContainText("3,000.00");
  await picker.press("ArrowRight");
  await expect(detail).toContainText(/[-−]¥?1,000\.00/);
  await expect(page.getByTestId("trend-plot").locator("polyline, path")).toHaveCount(1);
  await picker.press("ArrowRight");
  await expect(detail).toContainText("2,000.00");
  await cumulative.click();
  await picker.focus();
  await picker.press("End");
  await expect(detail).toContainText("4,000.00");
  await expect(detail.getByRole("link")).toHaveCount(0);
  await picker.press("Home");
  await picker.press("ArrowRight");
  await expect(detail).toContainText("2,000.00");
  await picker.press("ArrowRight");
  await expect(detail).toContainText("4,000.00");
  await detail.getByRole("link", { name: "查看当月记录" }).click();
  await expect(page.locator('a[href*="record="]')).toHaveCount(2);
  const params = new URL(page.url()).searchParams;
  expect(params.get("ledger")).toBe(ledgerId);
  expect(params.get("from")).toBe("2019-02-28T16:00:00.000Z");
  expect(params.get("to")).toBe("2019-03-31T15:59:59.999Z");

  await page.goto(homeUrl());
  await balance.click();
  await page.getByLabel("归属成员", { exact: true }).selectOption(partnerId);
  await expect(page).toHaveURL((url) => url.searchParams.get("member") === partnerId);
  await expect(balance).toHaveAttribute("aria-pressed", "true");
  await picker.focus();
  await picker.press("Home");
  await expect(detail).toContainText("0.00");
  await expect(detail.getByRole("link")).toHaveCount(0);
  await cumulative.click();
  await picker.focus();
  await picker.press("End");
  await expect(detail).toContainText(/[-−]¥?3,000\.00/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("home-monthly-net-mobile.png"), fullPage: true });

  await page.goto(homeUrl().replace(`ledger=${encodeURIComponent(ledgerId)}`, "ledger=all"));
  await cumulative.click();
  await picker.focus();
  await picker.press("End");
  await expect(detail).toContainText(/[-−]¥?3,000\.00/);
});

test("month selection keeps daily cashflow, monthly net as one point, and English mobile labels", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await logIn(page);
  await page.goto(`/home?mode=month&month=2019-01&year=2019&ledger=${encodeURIComponent(ledgerId)}`);
  const picker = page.getByTestId("trend-date-picker");
  await expect(picker).toHaveAttribute("max", "30");
  await page.getByRole("button", { name: "结余趋势", exact: true }).click();
  await expect(picker).toHaveAttribute("max", "0");
  await picker.focus();
  await picker.press("Home");
  await expect(page.getByTestId("trend-detail")).toContainText("3,000.00");
  await page.getByRole("button", { name: "累计结余", exact: true }).click();
  await expect(picker).toHaveAttribute("max", "0");
  await picker.focus();
  await picker.press("Home");
  await expect(page.getByTestId("trend-detail")).toContainText("3,000.00");
  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("button", { name: "切换语言", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cash flow", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Net trend", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cumulative net", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("home-monthly-net-english-320.png"), fullPage: true });
});
