import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hash } from "argon2";
import { PrismaClient } from "@prisma/client";
import { LOCALE_COOKIE_NAME } from "../../src/lib/i18n";
import { openKeyRing, parseHouseholdCode } from "../../src/lib/encryption/crypto";
import { decryptRow } from "../../src/lib/encryption/protected-models";
import { clearTransactions } from "./db-cleanup";
import { expect, test, type Page } from "./fixtures";

const endpoint = "/api/reports/reconcile";
const workspace = "/records/reconcile?mode=year&year=2026&ledger=all";
const pointerPrefix = "billboard:bill-reconciliation-application:v1";
let database: PrismaClient;
let householdId: string;
let ids: string[];

function env(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing required env: ${name}`); return value; }
async function login(page: Page, email = env("SEED_USER_A_EMAIL"), password = env("SEED_USER_A_PASSWORD")) {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}
async function scan(page: Page) {
  await page.goto(workspace);
  await page.getByTestId("bill-analysis-generate").click();
  await expect(page.getByTestId("bill-reconciliation-report")).toBeVisible({ timeout: 20_000 });
  const feedback = page.getByTestId("bill-analysis-feedback");
  if (await feedback.isVisible()) await feedback.getByRole("button", { name: "关闭提示", exact: true }).click();
}
function groupFor(page: Page, marker: string) {
  return page.getByTestId("reconciliation-retention-group").filter({ hasText: marker });
}
function recordFor(page: Page, marker: string) {
  return groupFor(page, marker).locator('[data-testid^="manual-record-"]').filter({ hasText: marker });
}
async function skipGroup(page: Page, marker: string) {
  await groupFor(page, marker).getByTestId("retention-keep-all").click();
}
function automatic(page: Page) { return page.getByTestId("bill-reconciliation-report").locator('[data-testid^="reconciliation-suggestion-"]').filter({ hasText: "Payment id e2e-manual-auto-001" }).filter({ has: page.locator('input[type="checkbox"]') }); }

async function enableEncryptionWithVerifiedBackups(page: Page) {
  await page.goto("/account/household");
  const settings = page.getByTestId("household-encryption-settings");
  await settings.getByRole("button", { name: "开启加密", exact: true }).click();
  const candidate = settings.getByTestId("encryption-candidate");
  await expect(candidate).toBeVisible({ timeout: 15_000 });
  const code = await candidate.locator("textarea[readonly]").inputValue();
  const files: Buffer[] = [];
  for (const label of ["保存解锁码副本", "保存恢复文件", "保存临时操作恢复文件"]) {
    const [download] = await Promise.all([page.waitForEvent("download"), candidate.getByRole("button", { name: label, exact: true }).click()]);
    const path = await download.path();
    if (!path) throw new Error("Synthetic encryption recovery download is unavailable");
    files.push(await readFile(path));
  }
  expect(files[0].toString()).toBe(code);
  for (let index = 0; index < files.length; index++) await candidate.locator('input[type="file"]').nth(index).setInputFiles({ name: `verified-${index}.json`, mimeType: "application/json", buffer: files[index] });
  await candidate.getByRole("checkbox").check();
  await candidate.getByRole("button", { name: "确认并执行", exact: true }).click();
  await expect(settings.getByText("已加密", { exact: true })).toBeVisible({ timeout: 45_000 });
  return { code, settings };
}

test.beforeEach(async () => {
  const url = new URL(env("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) throw new Error("Manual reconciliation E2E requires a local development/test database");
  await clearTransactions();
  database = new PrismaClient();
  const user = await database.user.findUniqueOrThrow({ where: { email: env("SEED_USER_A_EMAIL") }, include: { householdMember: { where: { leftAt: null }, take: 1 } } });
  const member = user.householdMember[0];
  householdId = member.householdId;
  const ledger = await database.ledger.findFirstOrThrow({ where: { householdId, isDefault: true } });
  const category = await database.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE", isActive: true } });
  ids = Array.from({ length: 6 }, () => randomUUID());
  const amounts = [7775, 1390, 7775, 1390, 5000, 5000];
  const names = ["Synthetic minimal A", "Synthetic meal B", "Synthetic merchant C", "Synthetic meal D", "Synthetic auto E", "Synthetic auto F"];
  await database.transaction.createMany({ data: ids.map((id, index) => ({ id, householdId, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: category.id, type: "EXPENSE", amountFen: amounts[index],
    occurredAt: new Date(`2026-10-${20 + Math.floor(index / 2)}T${index % 2 ? "03:13" : "00:00"}:00+08:00`),
    note: `${names[index]} · Manual review id e2e-manual-001${index >= 4 ? " · Payment id e2e-manual-auto-001" : ""}`,
    ...(index === 2 || index === 3 ? { source: "wechat_pay", sourceFingerprint: `synthetic-manual-${id}`, sourceImportedAt: new Date() } : {}),
  })) });
  await database.user.update({ where: { id: user.id }, data: { aiProcessingEnabled: true } });
});
test.afterEach(async () => { if (database) { await clearTransactions(); await database.$disconnect(); } });

test("opens from records without importing extra filters, preserves browser back and replaces unsupported ranges explicitly", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("bill-analysis-panel")).toHaveCount(0);
  const recordsUrl = "/records?mode=custom&start=2026-10-01&end=2026-10-31&ledger=all&type=expense&sort=amount-desc";
  await page.goto(recordsUrl);
  await page.getByTestId("records-reconciliation-link").click();
  await expect(page).toHaveURL((url) => url.pathname === "/records/reconcile" && url.searchParams.get("rangeReset") === "1" && !url.searchParams.has("type") && !url.searchParams.has("sort"));
  await expect(page.getByTestId("reconciliation-workspace").getByRole("status")).toContainText("已明确切换为本月");
  await page.getByTestId("report-range-trigger").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "月", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "年", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "全部", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goBack();
  await expect(page).toHaveURL(recordsUrl);
});

test("groups by amount, keeps multiple original records and applies mixed changes while preserving skipped groups", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const first = await database.transaction.findUniqueOrThrow({ where: { id: ids[0] } });
  const extraId = randomUUID();
  await database.transaction.create({ data: { id: extraId, householdId: first.householdId, ledgerId: first.ledgerId,
    actorMemberId: first.actorMemberId, createdByMemberId: first.createdByMemberId, categoryId: first.categoryId,
    type: "EXPENSE", amountFen: 7775, occurredAt: new Date("2026-10-23T04:00:00+08:00"),
    note: "Synthetic additional G · Manual review id e2e-manual-001" } });
  await login(page); await scan(page);
  await expect(page.getByRole("button", { name: "人工核对", exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="radio"]')).toHaveCount(0);
  await expect(page.getByTestId("reconciliation-retention-group")).toHaveCount(3);
  await expect(automatic(page).getByRole("checkbox")).toBeChecked();
  await expect(recordFor(page, "Synthetic minimal A").getByRole("checkbox")).toBeChecked();
  await expect(recordFor(page, "Synthetic merchant C").getByRole("checkbox")).not.toBeChecked();
  await expect(recordFor(page, "Synthetic additional G").getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByTestId("bill-reconciliation-apply")).toBeInViewport();
  await expect(page.getByTestId("bill-reconciliation-apply")).toBeDisabled();
  await skipGroup(page, "Synthetic auto E");
  await recordFor(page, "Synthetic additional G").getByRole("checkbox").check();
  await skipGroup(page, "Synthetic meal B");
  const payloads: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.url().endsWith(endpoint) && request.method() === "POST" && request.postDataJSON().operation === "apply") payloads.push(request.postDataJSON()); });
  await expect(page.getByTestId("bill-reconciliation-apply")).toBeEnabled();
  await page.getByTestId("bill-reconciliation-apply").click();
  await expect(page.getByTestId("bill-reconciliation-feedback")).toContainText("所选修改已应用", { timeout: 15_000 });
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ version: 3, suggestionIds: [expect.any(String)], manualGroups: [{ noticeId: expect.any(String), refs: expect.any(Array), keepRefs: expect.any(Array) }] });
  const submitted = payloads[0].manualGroups as Array<{ refs: string[]; keepRefs: string[] }>;
  expect(submitted).toHaveLength(1); expect(submitted[0].refs).toHaveLength(3); expect(submitted[0].keepRefs).toHaveLength(2);
  expect(await database.transaction.findUniqueOrThrow({ where: { id: ids[0] } })).toMatchObject({ deletedAt: null, amountFen: first.amountFen, note: first.note, occurredAt: first.occurredAt, source: first.source, clientRequestId: first.clientRequestId });
  expect((await database.transaction.findUniqueOrThrow({ where: { id: extraId } })).deletedAt).toBeNull();
  expect((await database.transaction.findUniqueOrThrow({ where: { id: ids[2] } })).deletedAt).not.toBeNull();
  expect(await database.transaction.count({ where: { id: { in: [ids[1], ids[3]] }, deletedAt: null } })).toBe(2);
  expect(await database.transaction.count({ where: { id: { in: [ids[4], ids[5]] }, deletedAt: null } })).toBe(1);
  await recordFor(page, "Synthetic meal D").getByRole("checkbox").uncheck();
  await expect(recordFor(page, "Synthetic meal B").getByRole("checkbox")).toBeChecked();
  await mkdir(resolve("tmp/verification/reconciliation-grouped-retention"), { recursive: true });
  await page.screenshot({ path: resolve("tmp/verification/reconciliation-grouped-retention/manual-zh-390.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 390, height: 568 });
  const apply = page.getByTestId("bill-reconciliation-apply");
  await expect(apply).toBeEnabled();
  await apply.scrollIntoViewIfNeeded();
  const bottomNav = page.getByRole("navigation").filter({ visible: true });
  await expect(bottomNav.getByRole("link")).toHaveCount(3);
  const applyBox = await apply.boundingBox();
  const navBox = await bottomNav.boundingBox();
  expect(applyBox).not.toBeNull(); expect(navBox).not.toBeNull();
  expect(applyBox!.y).toBeGreaterThanOrEqual(0);
  expect(applyBox!.y + applyBox!.height).toBeLessThanOrEqual(navBox!.y);
  expect(await apply.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return target === button || button.contains(target);
  })).toBe(true);
  await apply.click({ trial: true });
  await page.screenshot({ path: resolve("tmp/verification/reconciliation-grouped-retention/manual-apply-390-short-viewport.png") });
  await apply.click();
  await expect.poll(async () => database.billReconciliationApplication.count({ where: { householdId, status: "SUCCEEDED" } })).toBe(2);
  expect((await database.transaction.findUniqueOrThrow({ where: { id: ids[1] } })).deletedAt).toBeNull();
  expect((await database.transaction.findUniqueOrThrow({ where: { id: ids[3] } })).deletedAt).not.toBeNull();
  await page.context().addCookies([{ name: LOCALE_COOKIE_NAME, value: "en-US", url: baseURL! }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "AI reconciliation", exact: true })).toBeVisible();
  await page.screenshot({ path: resolve("tmp/verification/reconciliation-grouped-retention/manual-en-390-short.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("retains the chosen keep set on scope return and resets defaults only on a new generation", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page); await scan(page);
  await automatic(page).getByRole("checkbox").uncheck();
  await skipGroup(page, "Synthetic auto E");
  await recordFor(page, "Synthetic merchant C").getByRole("checkbox").check();
  await recordFor(page, "Synthetic minimal A").getByRole("checkbox").uncheck();
  await page.getByRole("link", { name: "返回记录", exact: true }).click();
  await page.getByTestId("records-reconciliation-link").click();
  await expect(recordFor(page, "Synthetic merchant C").getByRole("checkbox")).toBeChecked();
  await expect(recordFor(page, "Synthetic minimal A").getByRole("checkbox")).not.toBeChecked();
  await page.getByTestId("bill-analysis-generate").click();
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText("旧代次未提交的人工分组与选择已清除", { timeout: 20_000 });
  await expect(recordFor(page, "Synthetic minimal A").getByRole("checkbox")).toBeChecked();
  await expect(recordFor(page, "Synthetic merchant C").getByRole("checkbox")).not.toBeChecked();
});

test("blocks zero keepers and ignores fully retained groups without sending a no-op request", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page); await scan(page);
  await automatic(page).getByRole("checkbox").uncheck();
  await skipGroup(page, "Synthetic auto E");
  await recordFor(page, "Synthetic minimal A").getByRole("checkbox").uncheck();
  await expect(page.getByTestId("bill-reconciliation-apply")).toBeDisabled();
  await expect(groupFor(page, "Synthetic minimal A")).toContainText("至少保留一笔");
  await skipGroup(page, "Synthetic minimal A");
  await skipGroup(page, "Synthetic meal B");
  const applies: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith(endpoint) && request.method() === "POST" && request.postDataJSON().operation === "apply") applies.push(request.postDataJSON().requestId); });
  await expect(page.getByTestId("bill-reconciliation-apply")).toBeDisabled();
  expect(applies).toHaveLength(0);
  expect(await database.billReconciliationApplication.count({ where: { householdId } })).toBe(0);
  expect(await database.transaction.count({ where: { id: { in: ids }, deletedAt: null } })).toBe(6);
});

test("recovers a manual application after the whole context closes using only its original UUID", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const original = await browser.newContext({ baseURL, viewport: { width: 390, height: 700 } });
  let reopened: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const page = await original.newPage(); await login(page); await scan(page);
    await automatic(page).getByRole("checkbox").uncheck();
    await skipGroup(page, "Synthetic auto E");
    await skipGroup(page, "Synthetic meal B");
    await page.route(`**${endpoint}`, async (route) => {
      const body = route.request().postDataJSON();
      if (body.operation === "apply") { expect((await route.fetch()).ok()).toBe(true); await route.abort("failed"); }
      else if (body.operation === "query-application") await route.abort("failed");
      else await route.continue();
    });
    await page.getByTestId("bill-reconciliation-apply").click();
    await expect(page.getByTestId("bill-reconciliation-feedback")).toContainText("修改结果待确认", { timeout: 15_000 });
    const pointer = await page.evaluate((prefix) => { const key = Object.keys(localStorage).find((key) => key.startsWith(prefix)); return JSON.parse(key ? localStorage.getItem(key) ?? "null" : "null"); }, pointerPrefix);
    expect(Object.keys(pointer).sort()).toEqual(["generation", "identity", "reportId", "requestId", "version"]);
    expect(JSON.stringify(pointer)).not.toMatch(/manualGroups|keepRef|refs|7775|Synthetic/);
    const state = await original.storageState(); await original.close();
    reopened = await browser.newContext({ baseURL, storageState: state });
    const next = await reopened.newPage(); const operations: string[] = [];
    next.on("request", (request) => { if (request.url().endsWith(endpoint) && request.method() === "POST") operations.push(request.postDataJSON().operation); });
    await next.goto(workspace);
    await expect(next.getByTestId("bill-reconciliation-feedback")).toContainText("所选修改已应用", { timeout: 15_000 });
    expect(operations).toContain("query-application"); expect(operations).not.toContain("apply"); expect(operations).not.toContain("generate");
    expect(await database.billReconciliationApplication.count({ where: { householdId } })).toBe(1);
  } finally { await original.close(); await reopened?.close(); }
});

test("keeps the English short-screen form keyboard accessible without changing the default selection on reload", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await login(page); await scan(page);
  await page.context().addCookies([{ name: LOCALE_COOKIE_NAME, value: "en-US", url: baseURL! }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "AI reconciliation", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 568 });
  await skipGroup(page, "Synthetic auto E");
  const first = recordFor(page, "Synthetic minimal A").getByRole("checkbox");
  const second = recordFor(page, "Synthetic merchant C").getByRole("checkbox");
  await expect(first).toBeChecked();
  await expect(second).not.toBeChecked();
  await second.focus();
  await page.keyboard.press("Space");
  await expect(second).toBeChecked();
  await expect(second).toBeFocused();
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).not.toBeChecked();
  await expect(first).toBeFocused();
  await mkdir(resolve("tmp/verification/reconciliation-grouped-retention"), { recursive: true });
  await page.screenshot({ path: resolve("tmp/verification/reconciliation-grouped-retention/manual-en-keyboard-390-short.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByTestId("reconciliation-retention-group").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve("tmp/verification/reconciliation-grouped-retention/manual-en-desktop.png") });
});

test("rejects a live conflict in a mixed selection without partial changes and rescans through its recovery action", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page); await scan(page);
  await expect(automatic(page).getByRole("checkbox")).toBeChecked();
  await skipGroup(page, "Synthetic auto E");
  await skipGroup(page, "Synthetic meal B");
  const generations: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith(endpoint) && request.method() === "POST" && request.postDataJSON().operation === "generate") generations.push(request.postDataJSON().requestId); });
  await database.transaction.update({ where: { id: ids[2] }, data: { amountFen: 8800 } });
  await page.getByTestId("bill-reconciliation-apply").click();
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText("记录或报告已变化，请重新扫描后确认", { timeout: 15_000 });
  await expect(page.getByTestId("bill-reconciliation-apply")).toBeDisabled();
  expect(await database.transaction.count({ where: { id: { in: ids }, deletedAt: null } })).toBe(6);
  expect(await database.ledgerAuditLog.count({ where: { targetId: { in: ids } } })).toBe(0);
  expect(await database.billReconciliationApplication.count({ where: { householdId, status: "REJECTED" } })).toBe(1);
  await page.getByTestId("bill-reconciliation-report").getByRole("button", { name: "重新扫描", exact: true }).click();
  await expect.poll(async () => (await database.billAnalysisReport.findFirstOrThrow({ where: { householdId, generatedAt: { not: null } } })).generation, { timeout: 20_000 }).toBe(2);
  await expect(page.getByTestId("bill-reconciliation-report")).toContainText("旧代次未提交的人工分组与选择已清除");
  await expect(recordFor(page, "Synthetic meal B").getByRole("checkbox")).toBeChecked();
  expect(generations).toHaveLength(1);
});

test("unlocks the dedicated encrypted view and applies a manual group without plaintext SSR or stored accounting payloads", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let ownerId: string | undefined;
  let encryptedHouseholdId: string | undefined;
  try {
    const password = "synthetic-reconciliation-encryption-password";
    const owner = await database.user.create({ data: { email: `reconciliation-encrypted-${randomUUID()}@example.test`, displayName: "Encrypted reconciliation owner", passwordHash: await hash(password), emailVerifiedAt: new Date(), aiProcessingEnabled: true } });
    ownerId = owner.id;
    const household = await database.household.create({ data: { name: "Synthetic encrypted reconciliation", members: { create: { userId: owner.id, memberName: "Encrypted owner", role: "OWNER" } }, ledgers: { create: { name: "Default", isDefault: true, acceptsLegacyDrafts: true } } }, include: { members: true, ledgers: true } });
    encryptedHouseholdId = household.id;
    const member = household.members[0], ledger = household.ledgers[0];
    const category = await database.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE", isActive: true } });
    const notes = [`Encrypted minimal keeper ${randomUUID()} · Manual review id e2e-encrypted-manual-001`, `Encrypted detailed merchant ${randomUUID()} · Manual review id e2e-encrypted-manual-001`];
    const protectedIds = [randomUUID(), randomUUID()];
    await database.transaction.createMany({ data: protectedIds.map((id, index) => ({ id, householdId: household.id, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: category.id, type: "EXPENSE", amountFen: 7775, occurredAt: new Date(`2026-10-${20 + index}T00:00:00+08:00`), note: notes[index] })) });
    await login(page, owner.email, password);
    const { code, settings } = await enableEncryptionWithVerifiedBackups(page);
    const encrypted = await database.householdEncryption.findUniqueOrThrow({ where: { householdId: household.id } });
    expect(encrypted.mode).toBe("ENCRYPTED");
    for (const id of protectedIds) expect(await database.transaction.findUniqueOrThrow({ where: { id } })).toMatchObject({ amountFen: 0, note: null, encryptedPayload: expect.stringMatching(/^BBE1\./) });
    await settings.getByRole("button", { name: "清除此设备的解锁码", exact: true }).click();
    const clearDialog = page.getByRole("dialog", { name: "清除解锁码和本地草稿", exact: true });
    await clearDialog.getByRole("button", { name: "确认清除", exact: true }).click();
    await expect(clearDialog).toBeHidden();
    const response = await page.goto(workspace);
    const initialHtml = await response!.text();
    for (const note of notes) expect(initialHtml).not.toContain(note);
    expect(initialHtml).not.toContain("77.75");
    await expect(page.getByTestId("household-encryption-gate")).toBeVisible();
    await expect(page.getByTestId("bill-reconciliation-report")).toHaveCount(0);
    const viewRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/household/view" && request.postDataJSON().page === "reconciliation");
    await page.getByLabel("家庭解锁码", { exact: true }).fill(code);
    await page.getByRole("button", { name: "导入并解锁", exact: true }).click();
    const admitted = await viewRequest;
    expect(admitted.postDataJSON()).toMatchObject({ page: "reconciliation", encryption: { code } });
    expect(new URL(admitted.url()).search).toBe("");
    expect(admitted.url()).not.toContain(code);
    expect(JSON.stringify(admitted.headers())).not.toContain(code);
    await expect(page.getByTestId("reconciliation-workspace")).toBeVisible();
    await page.getByTestId("bill-analysis-generate").click();
    await expect(page.getByTestId("bill-reconciliation-report")).toBeVisible({ timeout: 20_000 });
    const feedback = page.getByTestId("bill-analysis-feedback");
    if (await feedback.isVisible()) await feedback.getByRole("button", { name: "关闭提示", exact: true }).click();
    await expect(recordFor(page, notes[0]).getByRole("checkbox")).toBeChecked();
    await expect(recordFor(page, notes[1]).getByRole("checkbox")).not.toBeChecked();
    const application = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === endpoint && request.postDataJSON().operation === "apply");
    await page.getByTestId("bill-reconciliation-apply").click();
    const input = await application;
    expect(input.postDataJSON()).toMatchObject({ operation: "apply", version: 3, suggestionIds: [], encryption: { code } });
    expect(input.url()).not.toContain(code);
    expect(JSON.stringify(input.headers())).not.toContain(code);
    await expect(page.getByTestId("bill-reconciliation-feedback")).toContainText("所选修改已应用", { timeout: 15_000 });
    const keeper = await database.transaction.findUniqueOrThrow({ where: { id: protectedIds[0] } });
    const removed = await database.transaction.findUniqueOrThrow({ where: { id: protectedIds[1] } });
    expect(keeper.deletedAt).toBeNull(); expect(removed.deletedAt).not.toBeNull();
    expect(keeper).toMatchObject({ amountFen: 0, note: null, encryptedPayload: expect.stringMatching(/^BBE1\./) });
    const ring = await openKeyRing(parseHouseholdCode(code), encrypted.sealedKeyRing!);
    expect(await decryptRow("transaction", keeper, ring, household.id, ledger.id)).toMatchObject({ amountFen: 7775, note: notes[0], occurredAt: new Date("2026-10-20T00:00:00+08:00"), actorMemberId: member.id, ledgerId: ledger.id });
    const receipt = await database.billReconciliationApplication.findFirstOrThrow({ where: { householdId: household.id } });
    expect(receipt).toMatchObject({ status: "SUCCEEDED", encryptedPayload: expect.stringMatching(/^BBE1\./) });
    expect(JSON.stringify(receipt.definition)).not.toMatch(/keepRef|manualGroups|Encrypted minimal|7775/);
  } finally {
    if (encryptedHouseholdId) {
      await database.appEvent.deleteMany({ where: { householdId: encryptedHouseholdId } });
      await database.billReconciliationApplication.deleteMany({ where: { householdId: encryptedHouseholdId } });
      await database.billAnalysisRequest.deleteMany({ where: { householdId: encryptedHouseholdId } });
      await database.billAnalysisReport.deleteMany({ where: { householdId: encryptedHouseholdId } });
      await database.ledgerAuditLog.deleteMany({ where: { householdId: encryptedHouseholdId } });
      await database.transaction.deleteMany({ where: { householdId: encryptedHouseholdId } });
      await database.household.deleteMany({ where: { id: encryptedHouseholdId } });
    }
    if (ownerId) await database.user.deleteMany({ where: { id: ownerId } });
  }
});
