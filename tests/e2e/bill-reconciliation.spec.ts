import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { LOCALE_COOKIE_NAME } from "../../src/lib/i18n";
import { clearTransactions } from "./db-cleanup";
import { expect, test, type Page } from "./fixtures";

const endpoint = "/api/reports/reconcile";
const yearUrl = "/records/reconcile?mode=year&year=2021&ledger=all";
const pointerKey = "billboard:bill-reconciliation-application:v1";
let database: PrismaClient;
let householdId: string;
let memberId: string;
let ledgerId: string;
let expenseId: string;
let incomeId: string;
let duplicateIds: string[];

function env(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing required env: ${name}`); return value; }
async function login(page: Page, account = "A") {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(env(`SEED_USER_${account}_EMAIL`));
  await page.getByLabel("密码", { exact: true }).fill(env(`SEED_USER_${account}_PASSWORD`));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}
async function scan(page: Page) {
  await page.goto(yearUrl);
  await page.getByTestId("bill-analysis-generate").click();
  await expect(page.getByTestId("bill-reconciliation-report")).toBeVisible({ timeout: 20_000 });
  const feedback = page.getByTestId("bill-analysis-feedback");
  if (await feedback.isVisible()) await feedback.getByRole("button", { name: "关闭提示", exact: true }).click();
}
function group(page: Page, payment: string) { return page.getByTestId("bill-reconciliation-report").locator('[data-testid^="reconciliation-suggestion-"]').filter({ hasText: payment }); }

test.beforeEach(async () => {
  const url = new URL(env("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) throw new Error("Reconciliation E2E requires a local development/test database");
  await clearTransactions();
  database = new PrismaClient();
  const user = await database.user.findUniqueOrThrow({ where: { email: env("SEED_USER_A_EMAIL") }, include: { householdMember: { where: { leftAt: null }, take: 1 } } });
  memberId = user.householdMember[0].id;
  householdId = user.householdMember[0].householdId;
  ledgerId = (await database.ledger.findFirstOrThrow({ where: { householdId, isDefault: true } })).id;
  const expenseCategory = await database.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE", isActive: true } });
  const incomeCategory = await database.category.findFirstOrThrow({ where: { type: "INCOME", isActive: true } });
  duplicateIds = [randomUUID(), randomUUID()]; expenseId = randomUUID(); incomeId = randomUUID();
  const base = { householdId, ledgerId, actorMemberId: memberId, createdByMemberId: memberId };
  await database.transaction.createMany({ data: [
    ...duplicateIds.map((id) => ({ ...base, id, categoryId: expenseCategory.id, type: "EXPENSE" as const, amountFen: 5000,
      occurredAt: new Date("2021-01-05T12:00:00+08:00"), note: "Payment id e2e-duplicate-001" })),
    { ...base, id: expenseId, categoryId: expenseCategory.id, type: "EXPENSE", amountFen: 10000, occurredAt: new Date("2021-01-10T12:00:00+08:00"), note: "Payment id e2e-reimburse-001" },
    { ...base, id: incomeId, categoryId: incomeCategory.id, type: "INCOME", amountFen: 3000, occurredAt: new Date("2021-02-10T12:00:00+08:00"), note: "Reimbursement payment id e2e-reimburse-001" },
  ] });
  await database.user.update({ where: { id: user.id }, data: { aiProcessingEnabled: true } });
});

test.afterEach(async () => { if (database) { await clearTransactions(); await database.$disconnect(); } });

test("previews cross-month changes, applies only checked suggestions once and shares the handled state", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page);
  await scan(page);
  const duplicate = group(page, "e2e-duplicate-001");
  const reimbursement = group(page, "e2e-reimburse-001");
  await expect(duplicate.getByRole("checkbox")).toBeChecked();
  await expect(reimbursement.getByRole("checkbox")).toBeChecked();
  await duplicate.getByRole("checkbox").uncheck();
  await reimbursement.getByRole("checkbox").check();
  const report = page.getByTestId("bill-reconciliation-report");
  await expect(report).toContainText("各月份变化");
  await expect(report).toContainText("2021-01");
  await expect(report).toContainText("2021-02");
  await expect(report).toContainText("70.00");
  await expect(report).toContainText("历史统计、趋势及比较结果");
  const applications: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith(endpoint) && request.method() === "POST" && request.postDataJSON().operation === "apply") applications.push(request.postDataJSON().requestId); });
  await page.getByTestId("bill-reconciliation-apply").evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByTestId("bill-reconciliation-feedback")).toContainText("所选修改已应用", { timeout: 15_000 });
  expect(applications).toHaveLength(1);
  expect(await database.transaction.findUniqueOrThrow({ where: { id: expenseId } })).toMatchObject({ amountFen: 7000, deletedAt: null });
  expect((await database.transaction.findUniqueOrThrow({ where: { id: incomeId } })).deletedAt).not.toBeNull();
  expect(await database.transaction.count({ where: { id: { in: duplicateIds }, deletedAt: null } })).toBe(2);
  expect(await database.billReconciliationApplication.count({ where: { householdId, status: "SUCCEEDED" } })).toBe(1);
  await expect(reimbursement.getByRole("checkbox")).toBeDisabled();
  await page.context().addCookies([{ name: LOCALE_COOKIE_NAME, value: "en-US", url: baseURL! }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "AI reconciliation", exact: true })).toBeVisible();
  await expect(report).toContainText("Already handled");
  await expect(report).toContainText("Chinese");
  await report.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await mkdir(resolve("tmp/verification/ai-bill-reconciliation"), { recursive: true });
  await page.getByTestId("bill-analysis-panel").screenshot({ path: resolve("tmp/verification/ai-bill-reconciliation/applied-en-390.png") });
  const shared = await browser.newContext({ baseURL });
  try {
    const spouse = await shared.newPage();
    await login(spouse, "B");
    await spouse.goto(yearUrl);
    await expect(group(spouse, "e2e-reimburse-001").getByRole("checkbox")).toBeDisabled();
    await expect(group(spouse, "e2e-reimburse-001")).toContainText("已处理");
    expect(await database.billReconciliationApplication.count({ where: { householdId } })).toBe(1);
  } finally { await shared.close(); }
});

test("a changed record rejects the entire selection without partial accounting or transaction audit", async ({ page }) => {
  await login(page);
  await scan(page);
  await group(page, "e2e-reimburse-001").getByRole("checkbox").check();
  await database.transaction.update({ where: { id: duplicateIds[0] }, data: { amountFen: 6000 } });
  await page.getByTestId("bill-reconciliation-apply").click();
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText("记录或报告已变化，请重新扫描后确认", { timeout: 15_000 });
  await expect(page.getByTestId("bill-reconciliation-apply")).toBeDisabled();
  expect(await database.transaction.count({ where: { id: { in: [...duplicateIds, expenseId, incomeId] }, deletedAt: null } })).toBe(4);
  expect((await database.transaction.findUniqueOrThrow({ where: { id: expenseId } })).amountFen).toBe(10000);
  expect(await database.ledgerAuditLog.count({ where: { targetId: { in: [...duplicateIds, expenseId, incomeId] } } })).toBe(0);
  expect(await database.billReconciliationApplication.count({ where: { householdId, status: "REJECTED" } })).toBe(1);
});

test("a lost application response is recovered after closing the whole client by querying the original UUID", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const original = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  let reopened: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const page = await original.newPage();
    await login(page);
    await scan(page);
    await group(page, "e2e-duplicate-001").getByRole("checkbox").uncheck();
    await group(page, "e2e-reimburse-001").getByRole("checkbox").check();
    let lost = false;
    await page.route(`**${endpoint}`, async (route) => {
      const input = route.request().postDataJSON();
      if (input.operation === "apply" && !lost) { lost = true; const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort("failed"); }
      else if (input.operation === "query-application") await route.abort("failed");
      else await route.continue();
    });
    await page.getByTestId("bill-reconciliation-apply").click();
    await expect(page.getByTestId("bill-reconciliation-feedback")).toContainText("修改结果待确认", { timeout: 15_000 });
    const pointer = await page.evaluate((key) => {
      const storedKey = Object.keys(localStorage).find((stored) => stored === key || stored.startsWith(`${key}:`));
      return JSON.parse(storedKey ? localStorage.getItem(storedKey) ?? "null" : "null");
    }, pointerKey);
    expect(Object.keys(pointer).sort()).toEqual(["generation", "identity", "reportId", "requestId", "version"]);
    expect(JSON.stringify(pointer)).not.toMatch(/e2e-reimburse|3000|10000|suggestionIds|note/);
    const saved = await original.storageState();
    await original.close();
    reopened = await browser.newContext({ baseURL, storageState: saved });
    const next = await reopened.newPage();
    const operations: string[] = [];
    next.on("request", (request) => { if (request.url().endsWith(endpoint) && request.method() === "POST") operations.push(request.postDataJSON().operation); });
    await next.goto(yearUrl);
    await expect(next.getByTestId("bill-reconciliation-feedback")).toContainText("所选修改已应用", { timeout: 15_000 });
    expect(operations).toContain("query-application");
    expect(operations).not.toContain("apply");
    expect(operations).not.toContain("generate");
    expect(await database.billReconciliationApplication.count({ where: { householdId } })).toBe(1);
    expect(await next.evaluate((key) => Object.keys(localStorage).filter((stored) => stored === key || stored.startsWith(`${key}:`)), pointerKey)).toEqual([]);
  } finally { await original.close(); await reopened?.close(); }
});

test("legacy reports remain read only without AI consent and the old generation endpoint is retired", async ({ page }) => {
  const scope = { mode: "year" as const, period: "2020", ledgerId: null, actorMemberId: null };
  const historical = await database.billAnalysisReport.create({ data: { householdId, createdByMemberId: memberId, definition: { scope }, generation: 1,
    generatedAt: new Date(), inputHash: "a".repeat(64), content: { locale: "zh-CN", range: { from: "2020-01-01", to: "2020-12-31" }, snapshotAt: new Date().toISOString(),
      body: { overview: "Synthetic historical review", observations: [], recommendations: [], limitations: [] }, metrics: [], evidence: [] } } });
  await database.user.updateMany({ where: { householdMember: { some: { id: memberId } } }, data: { aiProcessingEnabled: false } });
  await login(page);
  await page.goto(yearUrl);
  await page.getByTestId("bill-analysis-panel").getByRole("button", { name: "家庭共享报告", exact: true }).click();
  await page.getByTestId("bill-analysis-entry").filter({ hasText: "2020" }).getByRole("button", { name: "查看报告", exact: true }).click();
  const report = page.getByTestId("bill-analysis-report");
  await expect(report).toContainText("历史分析报告，仅供查看");
  await expect(report).toContainText("Synthetic historical review");
  await expect(report.getByRole("button", { name: "一键应用所选修改", exact: true })).toHaveCount(0);
  const response = await page.evaluate(async (scope) => {
    const result = await fetch("/api/reports/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "generate", requestId: crypto.randomUUID(), scope, locale: "zh-CN" }) });
    return result.status;
  }, scope);
  expect(response).toBe(410);
  expect(await database.billAnalysisReport.findUniqueOrThrow({ where: { id: historical.id } })).toMatchObject({ generation: 1, inputHash: historical.inputHash, content: historical.content });
  expect(await database.billReconciliationApplication.count({ where: { householdId } })).toBe(0);
});
