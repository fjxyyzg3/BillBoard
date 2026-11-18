import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient, TransactionType } from "@prisma/client";
import { LOCALE_COOKIE_NAME } from "../../src/lib/i18n";
import { readBillAnalysisAgentCalls } from "./bill-analysis-agent-observer";
import { clearTransactions } from "./db-cleanup";
import { expect, test, type BrowserContext, type Page } from "./fixtures";

const endpoint = "/api/reports/reconcile";
const monthUrl = "/records/reconcile?mode=month&month=2021-07&year=2021&ledger=all";
const pointerKey = "billboard:bill-analysis-pending:v1";
const ledgerPrefix = "E2E AI analysis ";
const screenshotDir = resolve("tmp/verification/ai-bill-analysis");

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function testDatabase() {
  const url = new URL(requireEnv("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Bill analysis fixtures require the local development/test database");
  }
  return new PrismaClient();
}

let database: PrismaClient;
let householdId: string;
let ownerId: string;
let spouseId: string;
let formerId: string;
let archivedLedgerId: string;
let defaultLedgerId: string;
let ownerExpenseId: string;
let archivedExpenseId: string;

async function login(page: Page, account = "A") {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(requireEnv(`SEED_USER_${account}_EMAIL`));
  await page.getByLabel("密码", { exact: true }).fill(requireEnv(`SEED_USER_${account}_PASSWORD`));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}

async function setSyntheticConsent(enabled: boolean) {
  // Explicit synthetic fixture preference; production seed does not infer consent.
  await database.user.updateMany({ where: { email: { in: [requireEnv("SEED_USER_A_EMAIL"), requireEnv("SEED_USER_B_EMAIL")] } }, data: { aiProcessingEnabled: enabled } });
}

async function requests() {
  return database.billAnalysisRequest.findMany({ where: { householdId }, orderBy: { createdAt: "asc" } });
}

async function dismissFeedback(page: Page, english = false) {
  const feedback = page.getByTestId("bill-analysis-feedback");
  if (await feedback.isVisible()) {
    const dismiss = feedback.getByRole("button", { name: english ? "Dismiss" : "关闭提示", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
  }
}

async function generate(page: Page) {
  const button = page.getByTestId("bill-analysis-generate");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId("bill-reconciliation-report")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("bill-analysis-feedback")).toContainText(/报告已生成|report is ready/);
  await dismissFeedback(page);
}

async function mobileScreenshot(page: Page, name: string) {
  await mkdir(screenshotDir, { recursive: true });
  const panel = page.getByTestId("bill-analysis-panel");
  await panel.evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(screenshotDir, `${name}-viewport.png`) });
  await panel.screenshot({ path: resolve(screenshotDir, `${name}-panel.png`) });
}

test.beforeEach(async () => {
  await clearTransactions();
  database = testDatabase();
  const [owner, spouse] = await Promise.all(["A", "B"].map((account) => database.user.findUniqueOrThrow({
    where: { email: requireEnv(`SEED_USER_${account}_EMAIL`) }, include: { householdMember: { where: { leftAt: null }, take: 1 } },
  })));
  if (!owner.householdMember[0] || !spouse.householdMember[0]) throw new Error("Synthetic household members are missing");
  householdId = owner.householdMember[0].householdId;
  ownerId = owner.householdMember[0].id;
  spouseId = spouse.householdMember[0].id;
  const ledger = await database.ledger.findFirstOrThrow({ where: { householdId, isDefault: true } });
  defaultLedgerId = ledger.id;
  const archived = await database.ledger.create({ data: { householdId, name: `${ledgerPrefix}${randomUUID()}`, archivedAt: new Date() } });
  archivedLedgerId = archived.id;
  const former = await database.householdMember.create({ data: { householdId, userId: spouse.id, memberName: "AI report historical member", role: "MEMBER", leftAt: new Date("2020-01-01T00:00:00Z") } });
  formerId = former.id;
  const categories = await database.category.findMany({ where: { name: { in: ["Dining", "Transport", "Salary"] }, isActive: true } });
  const entries = [
    { category: "Dining", amountFen: 3500, memberId: ownerId, ledgerId: defaultLedgerId, date: "2021-07-05", note: "Synthetic market meal", id: randomUUID() },
    { category: "Transport", amountFen: 2200, memberId: spouseId, ledgerId: defaultLedgerId, date: "2021-07-06", note: "Synthetic taxi", id: randomUUID() },
    { category: "Salary", amountFen: 800000, memberId: ownerId, ledgerId: defaultLedgerId, date: "2021-07-01", note: "Synthetic salary", id: randomUUID() },
    { category: "Dining", amountFen: 5000, memberId: ownerId, ledgerId: archivedLedgerId, date: "2021-07-07", note: "Synthetic archived trip", id: randomUUID() },
    { category: "Dining", amountFen: 1000, memberId: formerId, ledgerId: archivedLedgerId, date: "2021-07-10", note: "Synthetic historical member expense", id: randomUUID() },
    { category: "Dining", amountFen: 2000, memberId: ownerId, ledgerId: defaultLedgerId, date: "2021-06-05", note: "Synthetic previous month", id: randomUUID() },
    { category: "Dining", amountFen: 1500, memberId: ownerId, ledgerId: defaultLedgerId, date: "2020-07-05", note: "Synthetic previous year", id: randomUUID() },
    { category: "Dining", amountFen: 990000, memberId: ownerId, ledgerId: defaultLedgerId, date: "2021-07-05", note: "Synthetic deleted transaction", id: randomUUID(), deletedAt: new Date() },
  ];
  ownerExpenseId = entries[0].id;
  archivedExpenseId = entries[3].id;
  await database.transaction.createMany({ data: entries.map((entry) => {
    const category = categories.find((candidate) => candidate.name === entry.category);
    if (!category) throw new Error("Synthetic transaction category is missing");
    return { id: entry.id, householdId, ledgerId: entry.ledgerId, actorMemberId: entry.memberId, createdByMemberId: entry.memberId,
      categoryId: category.id, type: entry.category === "Salary" ? TransactionType.INCOME : TransactionType.EXPENSE,
      amountFen: entry.amountFen, occurredAt: new Date(`${entry.date}T12:00:00+08:00`), note: entry.note, deletedAt: entry.deletedAt ?? null };
  }) });
  await setSyntheticConsent(false);
});

test.afterEach(async ({ page }) => {
  if (!database) return;
  try {
    const active = await database.billAnalysisRequest.findMany({ where: { householdId, status: { in: ["PREPARING", "RUNNING", "STOPPING"] } }, select: { clientRequestId: true } });
    for (const item of active) {
      await page.evaluate(async ({ endpoint, requestId }) => {
        try { await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "cancel", requestId }) }); } catch { /* Server-owned tasks retain their original deadline. */ }
      }, { endpoint, requestId: item.clientRequestId }).catch(() => undefined);
    }
    await expect.poll(async () => database.resourceLease.count({ where: { householdId, kind: "ai" } }), { timeout: 15_000 }).toBe(0);
    await clearTransactions();
    await database.ledgerAuditLog.deleteMany({ where: { ledgerId: archivedLedgerId } });
    await database.ledger.deleteMany({ where: { id: archivedLedgerId, householdId, name: { startsWith: ledgerPrefix } } });
    await database.householdMember.deleteMany({ where: { id: formerId, householdId, leftAt: { not: null } } });
  } finally { await database.$disconnect(); }
});

test("requires personal consent and shares a monthly report without requiring AI for later reads", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const generated: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith(endpoint) && request.method() === "POST") {
    const body = request.postDataJSON(); if (body.operation === "generate") generated.push(body.requestId);
  } });
  await login(page);
  await page.goto(monthUrl);
  const panel = page.getByTestId("bill-analysis-panel");
  await expect(panel).toContainText("原文备注");
  await page.getByTestId("bill-analysis-generate").click();
  const consent = page.getByRole("dialog", { name: "AI 与语音", exact: true });
  await expect(consent).toBeVisible();
  const ai = consent.getByRole("checkbox", { name: /^允许 AI 处理/ });
  await expect(ai).not.toBeChecked();
  expect(generated).toHaveLength(0);
  expect(await database.billAnalysisRequest.count({ where: { householdId } })).toBe(0);
  await ai.check();
  await consent.getByRole("button", { name: "保存选择", exact: true }).click();
  await expect(consent).toBeHidden();
  await generate(page);
  const report = page.getByTestId("bill-reconciliation-report");
  await expect(report).toContainText("本次未发现可处理项");
  await expect(report).toContainText("建议按生成时的语言保存");
  await expect(report).toContainText("统计截止");
  expect(generated).toHaveLength(1);
  const stored = await database.billAnalysisReport.findFirstOrThrow({ where: { householdId, generatedAt: { not: null } } });
  expect(stored.createdByMemberId).toBe(ownerId);
  expect(await database.billAnalysisReport.count({ where: { householdId, generatedAt: { not: null } } })).toBe(1);
  await mobileScreenshot(page, "monthly-zh-390");

  await page.evaluate(async (endpoint) => {
    const response = await fetch("/api/account/processing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ai: false, voice: false }) });
    if (!response.ok) throw new Error("Could not disable the synthetic account AI preference");
    window.dispatchEvent(new Event("billboard-processing-change"));
    const report = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "list" }) });
    if (!report.ok) throw new Error("Saved reports require reading access without AI consent");
  }, endpoint);
  await page.reload();
  await expect(report).toContainText("本次未发现可处理项");
  expect(generated).toHaveLength(1);
  expect((await database.user.findUniqueOrThrow({ where: { email: requireEnv("SEED_USER_A_EMAIL") } })).aiProcessingEnabled).toBe(false);

  const sharedContext = await browser.newContext({ baseURL });
  try {
    const spousePage = await sharedContext.newPage();
    await login(spousePage, "B");
    await spousePage.goto(monthUrl);
    await expect(spousePage.getByTestId("bill-reconciliation-report")).toContainText("本次未发现可处理项");
    expect((await database.user.findUniqueOrThrow({ where: { email: requireEnv("SEED_USER_B_EMAIL") } })).aiProcessingEnabled).toBe(false);
    expect(await database.billAnalysisRequest.count({ where: { householdId } })).toBe(1);
  } finally { await sharedContext.close(); }

  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("button", { name: "切换语言", exact: true }).click();
  await expect(page.getByTestId("reconciliation-workspace").getByRole("heading", { name: "AI reconciliation", level: 1, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(report).toContainText("No actionable items found");
  await expect(report).toContainText("Chinese");
  await expect(report).toContainText("All members");
  await expect(report).toContainText("Suggestions retain the language used when generated");
  expect(generated).toHaveLength(1);
  await mobileScreenshot(page, "monthly-en-390");
});

test("continues the original archived-ledger member scope across navigation and also generates annual analysis", async ({ page }) => {
  test.setTimeout(120_000);
  await setSyntheticConsent(true);
  await database.transaction.update({ where: { id: archivedExpenseId }, data: { note: "Synthetic trip __analysis_delayed__" } });
  await login(page);
  await page.goto("/add");
  await expect(page.getByLabel("金额", { exact: true })).toBeEditable();
  await page.goto(`${monthUrl}&ledger=${archivedLedgerId}&member=${ownerId}`.replace("&ledger=all", ""));
  await page.getByTestId("bill-analysis-generate").click();
  await expect.poll(async () => (await requests())[0]?.status).toBe("RUNNING");
  const originalRequest = (await requests())[0];
  await page.getByRole("combobox", { name: "归属成员", exact: true }).selectOption(formerId);
  await expect(page.getByTestId("bill-analysis-generate")).toBeDisabled();
  await page.getByRole("combobox", { name: "查看范围", exact: true }).selectOption("all");
  await page.getByRole("link", { name: "记一笔", exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/add(?:\?|$)/);
  await expect(page.getByTestId("bill-analysis-feedback")).toContainText("2021-07");
  await expect(page.getByTestId("bill-analysis-feedback")).toContainText(ledgerPrefix);
  await expect(page.getByTestId("bill-analysis-feedback")).toContainText(/正在分批核对|正在校验建议/);
  await expect.poll(async () => (await requests()).find((item) => item.id === originalRequest.id)?.status, { timeout: 20_000 }).toBe("SUCCEEDED");
  await page.getByTestId("bill-analysis-feedback").getByRole("link", { name: "查看报告", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/records/reconcile" && url.searchParams.get("ledger") === archivedLedgerId && url.searchParams.get("member") === ownerId);
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText(ledgerPrefix);
  expect(await database.billAnalysisRequest.count({ where: { householdId } })).toBe(1);
  await dismissFeedback(page);

  await database.transaction.update({ where: { id: archivedExpenseId }, data: { note: "Synthetic archived trip" } });
  await page.goto("/records/reconcile?mode=year&year=2021&ledger=all");
  await generate(page);
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText("本次未发现可处理项");
  expect(await database.billAnalysisReport.count({ where: { householdId, generatedAt: { not: null } } })).toBe(2);
  const scopes = (await database.billAnalysisReport.findMany({ where: { householdId } })).map((item) => item.definition);
  expect(scopes).toEqual(expect.arrayContaining([expect.objectContaining({ scope: expect.objectContaining({ mode: "year", period: "2021", ledgerId: null, actorMemberId: null }) })]));
});

test("keeps the successful report through a failed attempt and a refresh while regeneration continues", async ({ page }) => {
  test.setTimeout(120_000);
  await setSyntheticConsent(true);
  await login(page);
  await page.goto(monthUrl);
  const generated: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith(endpoint) && request.method() === "POST") {
    const body = request.postDataJSON(); if (body.operation === "generate") generated.push(body.requestId);
  } });
  await generate(page);
  const before = await database.billAnalysisReport.findFirstOrThrow({ where: { householdId }, select: { id: true, content: true, inputHash: true, generatedAt: true } });
  await database.transaction.update({ where: { id: ownerExpenseId }, data: { note: "Synthetic changed note __analysis_fail__" } });
  await page.getByTestId("bill-analysis-generate").click();
  await expect(page.getByTestId("bill-analysis-error")).toContainText("分析服务暂不可用", { timeout: 20_000 });
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText("本次未发现可处理项");
  expect(await database.billAnalysisReport.findUniqueOrThrow({ where: { id: before.id }, select: { id: true, content: true, inputHash: true, generatedAt: true } })).toEqual(before);
  await page.getByTestId("bill-analysis-panel").getByRole("button", { name: "家庭共享报告", exact: true }).click();
  const latestAttempt = page.getByTestId("bill-analysis-history").getByTestId("bill-analysis-entry");
  await expect(latestAttempt).toHaveCount(1);
  await expect(latestAttempt).toContainText("生成失败");
  await expect(latestAttempt.getByRole("button", { name: "查看已有报告", exact: true })).toBeVisible();
  await latestAttempt.getByRole("button", { name: "查看已有报告", exact: true }).click();
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText("本次未发现可处理项");

  await database.transaction.update({ where: { id: ownerExpenseId }, data: { note: "Synthetic retry __analysis_delayed__" } });
  await page.getByTestId("bill-analysis-generate").click();
  await expect.poll(async () => (await requests()).filter((item) => item.status === "RUNNING").length).toBe(1);
  const pointer = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), pointerKey);
  expect(Object.keys(pointer).sort()).toEqual(["identity", "requestId", "version"]);
  expect(JSON.stringify(pointer)).not.toMatch(/2021|Synthetic|analysis_delayed/);
  await page.reload();
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText("本次未发现可处理项");
  await expect.poll(async () => (await requests()).find((item) => item.clientRequestId === pointer.requestId)?.status, { timeout: 20_000 }).toBe("SUCCEEDED");
  await expect(page.getByTestId("bill-analysis-pending")).toHaveCount(0, { timeout: 15_000 });
  expect(generated).toHaveLength(3);
  expect(new Set(generated).size).toBe(3);
  const regenerated = await database.billAnalysisReport.findUniqueOrThrow({ where: { id: before.id } });
  expect(regenerated.generation).toBe(2);
  expect(regenerated.inputHash).not.toBe(before.inputHash);
  expect(regenerated.generatedAt!.getTime()).toBeGreaterThan(before.generatedAt!.getTime());
  expect(await database.billAnalysisReport.count({ where: { householdId, generatedAt: { not: null } } })).toBe(1);
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText("本次未发现可处理项");
});

test("discovers the original server task after the entire browser context closes without sessionStorage", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  await setSyntheticConsent(true);
  await database.transaction.update({ where: { id: ownerExpenseId }, data: { note: "Synthetic closed application __analysis_delayed__" } });
  const baseline = await readBillAnalysisAgentCalls();
  const original = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  let reopened: BrowserContext | undefined;
  try {
    const originalPage = await original.newPage();
    await login(originalPage);
    await originalPage.goto(monthUrl);
    const submitted = originalPage.waitForResponse((response) => response.url().endsWith(endpoint) && response.request().method() === "POST" && response.request().postDataJSON().operation === "generate");
    await originalPage.getByTestId("bill-analysis-generate").click();
    const response = await submitted;
    expect(response.headers()["content-type"]).toContain("application/json");
    const receipt = await response.json();
    expect(receipt).toMatchObject({ result: { status: "processing" } });
    const requestId = receipt.result.requestId as string;
    await expect.poll(async () => (await requests()).find((item) => item.clientRequestId === requestId)?.status).toBe("RUNNING");
    await expect.poll(async () => (await readBillAnalysisAgentCalls()).count).toBe(baseline.count + 1);
    const accepted = (await requests()).find((item) => item.clientRequestId === requestId)!;
    const deadline = accepted.deadlineAt;
    const originalSession = accepted.originalAppSessionId;
    const cookies = await original.cookies();
    await original.close();

    expect(await database.resourceLease.count({ where: { householdId, kind: "ai" } })).toBe(1);
    expect((await requests()).find((item) => item.id === accepted.id)).toMatchObject({ status: "RUNNING", originalAppSessionId: originalSession, deadlineAt: deadline });
    reopened = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: "reduce", storageState: { cookies, origins: [] } });
    await reopened.addInitScript((key) => {
      (window as unknown as { initialAnalysisPointer: string | null }).initialAnalysisPointer = sessionStorage.getItem(key);
    }, pointerKey);
    const page = await reopened.newPage();
    const regenerated: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(endpoint) && request.method() === "POST" && request.postDataJSON().operation === "generate") regenerated.push(request.postDataJSON().requestId);
    });
    await page.goto(monthUrl);
    expect(await page.evaluate(() => (window as unknown as { initialAnalysisPointer: string | null }).initialAnalysisPointer)).toBeNull();
    await expect(page.getByTestId("bill-analysis-pending")).toBeVisible();
    await expect(page.getByTestId("bill-analysis-pending")).toContainText(/正在分批核对|正在校验建议/);
    await expect(page.getByTestId("bill-analysis-feedback").getByRole("button", { name: "取消扫描", exact: true })).toBeEnabled();
    await expect.poll(async () => (await requests()).find((item) => item.id === accepted.id)?.status, { timeout: 20_000 }).toBe("SUCCEEDED");
    await expect(page.getByTestId("bill-reconciliation-report")).toContainText("本次未发现可处理项", { timeout: 15_000 });
    expect(await database.billAnalysisRequest.count({ where: { householdId } })).toBe(1);
    expect((await requests())[0]).toMatchObject({ clientRequestId: requestId, originalAppSessionId: originalSession, deadlineAt: deadline });
    expect(regenerated).toEqual([]);
    const observed = await readBillAnalysisAgentCalls();
    expect(observed.count - baseline.count).toBe(1);
    expect(observed.calls.filter((call) => call.sequence > baseline.count).map((call) => call.stage)).toEqual(["context"]);
    await mobileScreenshot(page, "reopened-background-zh-390");
  } finally { await original.close(); await reopened?.close(); }
});

test("shares active progress with another member and a new sign-in session while preserving original cancellation rights", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  await setSyntheticConsent(true);
  await database.transaction.update({ where: { id: ownerExpenseId }, data: { note: "Synthetic read-only observers __analysis_delayed__" } });
  const category = await database.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE", isActive: true } });
  await database.transaction.createMany({ data: Array.from({ length: 500 }, (_, index) => ({
    householdId, ledgerId: defaultLedgerId, actorMemberId: ownerId, createdByMemberId: ownerId, categoryId: category.id,
    type: TransactionType.EXPENSE, amountFen: 100, occurredAt: new Date("2021-07-09T12:00:00+08:00"), note: `Synthetic observer batch ${index} __analysis_delayed__`,
  })) });
  await login(page);
  await page.goto(monthUrl);
  const memberContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const newSessionContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const memberPage = await memberContext.newPage();
    const newSessionPage = await newSessionContext.newPage();
    await login(memberPage, "B");
    await login(newSessionPage, "A");
    await newSessionContext.addCookies([{ name: LOCALE_COOKIE_NAME, value: "en-US", url: baseURL! }]);
    const baseline = await readBillAnalysisAgentCalls();
    const generated: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(endpoint) && request.method() === "POST" && request.postDataJSON().operation === "generate") generated.push(request.postDataJSON().requestId);
    });
    await page.getByTestId("bill-analysis-generate").click();
    await expect.poll(async () => (await requests()).find((item) => item.status === "RUNNING")?.status).toBe("RUNNING");
    const accepted = (await requests()).find((item) => item.status === "RUNNING")!;
    await Promise.all([memberPage.goto(monthUrl), newSessionPage.goto(monthUrl)]);
    for (const observer of [memberPage, newSessionPage]) {
      await expect(observer.getByTestId("bill-analysis-pending")).toBeVisible();
      await expect(observer.getByTestId("bill-analysis-pending").getByRole("button", { name: /取消扫描|Cancel scan/, exact: true })).toHaveCount(0);
      await expect(observer.getByTestId("bill-analysis-feedback").getByRole("button", { name: /取消扫描|Cancel scan/, exact: true })).toHaveCount(0);
    }
    await expect(memberPage.getByTestId("bill-analysis-pending")).toContainText("其他登录会话");
    await expect(newSessionPage.getByTestId("bill-analysis-pending")).toContainText("another sign-in session");
    const results = await Promise.all([memberPage, newSessionPage].map((observer) => observer.evaluate(async ({ endpoint, requestId }) => {
      const entries = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "entries" }) });
      const cancellation = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "cancel", requestId }) });
      return { entriesStatus: entries.status, entries: await entries.json(), cancelStatus: cancellation.status, cancellation: await cancellation.json() };
    }, { endpoint, requestId: accepted.clientRequestId })));
    for (const result of results) {
      expect(result.entriesStatus).toBe(200);
      expect(result.entries.active.task).toMatchObject({ id: accepted.id, canCancel: false, status: "processing" });
      expect(result.entries.active.task).not.toHaveProperty("requestId");
      const encoded = JSON.stringify(result.entries);
      for (const secret of [accepted.clientRequestId, accepted.originalAppSessionId, accepted.ownerId!, accepted.leaseToken!]) expect(encoded).not.toContain(secret);
      expect(result.cancelStatus).toBe(200);
      expect(result.cancellation.result.status).toBe("error");
      expect(["NOT_ACCEPTED", "CONFLICT"]).toContain(result.cancellation.result.error);
    }
    expect((await requests()).find((item) => item.id === accepted.id)).toMatchObject({ status: "RUNNING", originalAppSessionId: accepted.originalAppSessionId });
    expect(await database.resourceLease.count({ where: { householdId, kind: "ai" } })).toBe(1);
    await expect(page.getByTestId("bill-analysis-feedback").getByRole("button", { name: "取消扫描", exact: true })).toBeEnabled();
    await expect.poll(async () => (await requests()).find((item) => item.id === accepted.id)?.status, { timeout: 20_000 }).toBe("SUCCEEDED");
    await Promise.all([expect(memberPage.getByTestId("bill-reconciliation-report")).toContainText("本次未发现可处理项", { timeout: 15_000 }), expect(newSessionPage.getByTestId("bill-reconciliation-report")).toContainText("No actionable items found", { timeout: 15_000 })]);
    const observed = await readBillAnalysisAgentCalls();
    const contextCalls = observed.calls.filter((call) => call.sequence > baseline.count);
    expect(observed.count - baseline.count).toBe(2);
    expect(contextCalls.map((call) => call.stage)).toEqual(["context", "context"]);
    expect(contextCalls.map((call) => call.batchId)).toEqual(["b1", "b2"]);
    expect((await requests()).find((item) => item.id === accepted.id)?.definition).toMatchObject({ progress: { completedBatches: 2, totalBatches: 2 } });
    expect(generated).toEqual([accepted.clientRequestId]);
    await mobileScreenshot(newSessionPage, "shared-background-en-390");
  } finally { await memberContext.close(); await newSessionContext.close(); }
});

test("closes an undelivered UUID before accepting a new task and cancels without publishing a partial report", async ({ page }) => {
  test.setTimeout(120_000);
  await setSyntheticConsent(true);
  await login(page);
  await page.goto(monthUrl);
  let dropped = false;
  let originalId = "";
  await page.route(`**${endpoint}`, async (route) => {
    const input = route.request().postDataJSON();
    if (!dropped && input.operation === "generate") { dropped = true; originalId = input.requestId; await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByTestId("bill-analysis-generate").click();
  await expect(page.getByTestId("bill-analysis-error")).toContainText("原请求未受理", { timeout: 15_000 });
  const rejected = (await requests())[0];
  expect(rejected).toMatchObject({ clientRequestId: originalId, status: "FAILED", errorCode: "NOT_ACCEPTED" });
  const late = await page.evaluate(async ({ endpoint, requestId }) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "generate", requestId, scope: { mode: "month", period: "2021-07", ledgerId: null, actorMemberId: null }, locale: "zh-CN" }) });
    return response.text();
  }, { endpoint, requestId: originalId });
  expect(late).toContain("NOT_ACCEPTED");
  expect(await database.resourceLease.count({ where: { householdId } })).toBe(0);
  expect(await database.billAnalysisReport.count({ where: { householdId } })).toBe(0);
  await page.unroute(`**${endpoint}`);

  await database.transaction.update({ where: { id: ownerExpenseId }, data: { note: "Synthetic cancellation __analysis_delayed__" } });
  await page.getByTestId("bill-analysis-generate").click();
  await expect.poll(async () => (await requests()).filter((item) => item.status === "RUNNING").length).toBe(1);
  await page.getByTestId("bill-analysis-feedback").getByRole("button", { name: "取消扫描", exact: true }).click();
  await expect(page.getByTestId("bill-analysis-error")).toContainText("分析已取消", { timeout: 20_000 });
  await expect(page.getByTestId("bill-analysis-generate")).toBeEnabled();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pointerKey)).toBeNull();
  expect(await database.billAnalysisReport.count({ where: { householdId, generatedAt: { not: null } } })).toBe(0);
  expect((await requests()).map((item) => item.errorCode).sort()).toEqual(["CANCELLED", "NOT_ACCEPTED"]);
});
