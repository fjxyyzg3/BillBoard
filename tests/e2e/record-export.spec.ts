import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { clearTransactions } from "./db-cleanup";
import { expect, test, type Page } from "./fixtures";

const prefix = "E2E export ";
const users: string[] = [];
const households: string[] = [];
let archivedId: string;
let foreignId: string;
let historicalMemberId: string;
let foreignMemberId: string;

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function client() {
  const url = new URL(env("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/dev|test/i.test(url.pathname)) throw new Error("Export fixtures require a local dev/test database");
  return new PrismaClient();
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(env("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码", { exact: true }).fill(env("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}

async function fixture() {
  const prisma = client();
  try {
    await prisma.resourceLease.deleteMany({ where: { kind: "export" } });
    await prisma.resourceWindow.deleteMany({ where: { kind: "export" } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: env("SEED_USER_A_EMAIL") }, select: { householdMember: { where: { leftAt: null }, take: 1 } } });
    const member = user.householdMember[0];
    if (!member) throw new Error("Seed membership is missing");
    const defaultLedger = await prisma.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true } });
    const archived = await prisma.ledger.create({ data: { householdId: member.householdId, name: `${prefix}归档`, archivedAt: new Date() } });
    archivedId = archived.id;
    const oldUser = await prisma.user.create({ data: { email: `export-historical-${randomUUID()}@example.test`, displayName: "Historical export member", passwordHash: "not-used" } });
    users.push(oldUser.id);
    const oldMember = await prisma.householdMember.create({ data: { householdId: member.householdId, userId: oldUser.id, memberName: "导出历史成员", role: "MEMBER", leftAt: new Date() } });
    historicalMemberId = oldMember.id;
    const category = await prisma.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE" } });
    const base = { householdId: member.householdId, actorMemberId: member.id, createdByMemberId: member.id, categoryId: category.id, type: "EXPENSE" as const, occurredAt: new Date("2026-10-15T04:00:00Z") };
    await prisma.transaction.createMany({ data: [
      { ...base, ledgerId: defaultLedger.id, amountFen: 101, note: "=1+1", source: "wechat_pay", sourceFingerprint: "not-exported-fingerprint" },
      { ...base, ledgerId: archived.id, actorMemberId: oldMember.id, createdByMemberId: oldMember.id, amountFen: 202, note: "archived-history" },
      { ...base, ledgerId: defaultLedger.id, amountFen: 999, note: "deleted-history", deletedAt: new Date() },
    ] });
    const foreignUser = await prisma.user.create({ data: { email: `export-foreign-${randomUUID()}@example.test`, displayName: "Foreign export member", passwordHash: "not-used" } });
    users.push(foreignUser.id);
    const foreign = await prisma.household.create({ data: { name: `${prefix}foreign`, ledgers: { create: { name: "Default", isDefault: true } }, members: { create: { userId: foreignUser.id, memberName: "Foreign", role: "OWNER" } } }, include: { ledgers: true, members: true } });
    households.push(foreign.id);
    foreignId = foreign.ledgers[0].id;
    foreignMemberId = foreign.members[0].id;
  } finally { await prisma.$disconnect(); }
}

test.beforeEach(async () => { await clearTransactions(); await fixture(); });
test.afterEach(async () => {
  await clearTransactions();
  const prisma = client();
  try {
    await prisma.resourceLease.deleteMany({ where: { kind: "export" } });
    await prisma.resourceWindow.deleteMany({ where: { kind: "export" } });
    await prisma.ledger.deleteMany({ where: { name: { startsWith: prefix } } });
    await prisma.householdMember.deleteMany({ where: { userId: { in: users } } });
    await prisma.household.deleteMany({ where: { id: { in: households.splice(0) } } });
    await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  } finally { await prisma.$disconnect(); }
});

test("downloads the selected family dates as safe Excel on a phone, including archived history", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/records?ledger=all&mode=custom&start=2026-10-01&end=2026-10-31&type=income");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出账目", exact: true });
  await expect(dialog).toContainText("归属成员及日期");
  await expect(dialog).toContainText("筛选不影响导出");
  await expect(dialog).toContainText("家庭总览");
  await dialog.getByLabel("开始日期", { exact: true }).fill("2026-10-01");
  await dialog.getByLabel("结束日期", { exact: true }).fill("2026-10-31");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`record-export-${width}.png`), fullPage: true });
  }
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "下载 Excel", exact: true }).click()]);
  expect(download.suggestedFilename()).toBe("billboard-records_2026-10-01_2026-10-31.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile((await download.path())!));
  const sheet = workbook.worksheets[0];
  expect(sheet.rowCount).toBe(3);
  const amounts: number[] = [];
  sheet.eachRow((row, index) => { if (index > 1) amounts.push(Number(row.getCell(7).value)); });
  expect(amounts.sort()).toEqual([101, 202]);
  const literal = [sheet.getRow(2), sheet.getRow(3)].find((row) => row.getCell(7).value === 101)!;
  expect(literal.getCell(9).type).toBe(ExcelJS.ValueType.String);
  expect(literal.getCell(9).value).toBe("=1+1");
  expect(JSON.stringify(sheet.model)).toContain("导出历史成员");
  expect(JSON.stringify(sheet.model)).not.toContain("not-exported-fingerprint");
  expect(JSON.stringify(sheet.model)).not.toContain("deleted-history");
  await expect(dialog.getByRole("status")).toHaveText("已开始下载。");
  expect(page.url()).not.toContain("export");
  expect(await page.evaluate(() => JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)]))).not.toContain("not-exported-fingerprint");
});

test("retains a failed range for retry and exports a single archived ledger in English", async ({ page }) => {
  await login(page);
  await page.context().addCookies([{ name: "billboard-locale", value: "en-US", url: "http://127.0.0.1:2501" }]);
  await page.goto(`/records?ledger=${encodeURIComponent(archivedId)}&mode=custom&start=2026-10-01&end=2026-10-31`);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export records", exact: true });
  await dialog.getByLabel("From date", { exact: true }).fill("2026-10-10");
  await dialog.getByLabel("To date", { exact: true }).fill("2026-10-20");
  await page.route("**/api/records/export", async (route) => { await route.fulfill({ status: 503, json: { error: "unavailable" } }); }, { times: 1 });
  await dialog.getByRole("button", { name: "Download Excel", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Export failed. Keep your range and retry.");
  await expect(dialog.getByLabel("From date", { exact: true })).toHaveValue("2026-10-10");
  await expect(dialog.getByLabel("To date", { exact: true })).toHaveValue("2026-10-20");
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download Excel", exact: true }).click()]);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await readFile((await download.path())!));
  expect(workbook.worksheets[0].name).toBe("Records");
  expect(workbook.worksheets[0].rowCount).toBe(2);
  expect(workbook.worksheets[0].getRow(2).getCell(7).value).toBe(202);
});

test("follows the selected historical member and explicitly switches export back to all members", async ({ page }) => {
  await login(page);
  await page.goto(`/records?ledger=all&member=${encodeURIComponent(historicalMemberId)}&mode=custom&start=2026-10-01&end=2026-10-31&type=income`);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出账目", exact: true });
  const member = dialog.getByRole("combobox", { name: "归属成员", exact: true });
  await expect(member).toHaveValue(historicalMemberId);
  await expect(member.locator("option:checked")).toContainText("导出历史成员");
  const [historicalDownload] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "下载 Excel", exact: true }).click()]);
  const historical = new ExcelJS.Workbook();
  await historical.xlsx.load(await readFile((await historicalDownload.path())!));
  expect(historical.worksheets[0].rowCount).toBe(2);
  expect(historical.worksheets[0].getRow(2).getCell(7).value).toBe(202);
  await expect(dialog.getByRole("status")).toHaveText("已开始下载。");
  await member.selectOption("");
  await expect(member.locator("option:checked")).toHaveText("全部成员");
  const [familyDownload] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "下载 Excel", exact: true }).click()]);
  const family = new ExcelJS.Workbook();
  await family.xlsx.load(await readFile((await familyDownload.path())!));
  expect(family.worksheets[0].rowCount).toBe(3);
  expect([2, 3].map((index) => family.worksheets[0].getRow(index).getCell(7).value).sort()).toEqual([101, 202]);
});

test("rejects forged family, foreign scope and a revoked browser session at the real endpoint", async ({ page }) => {
  await login(page);
  const data = { from: "2026-10-01", to: "2026-10-31", locale: "zh-CN" };
  const headers = { origin: "http://127.0.0.1:2501" };
  const endpoint = "/api/records/export";
  expect((await page.request.post(endpoint, { data: { ...data, householdId: households[0] }, headers })).status()).toBe(400);
  expect((await page.request.post(endpoint, { data: { ...data, ledgerId: foreignId }, headers })).status()).toBe(401);
  expect((await page.request.post(endpoint, { data: { ...data, actorMemberId: foreignMemberId }, headers })).status()).toBe(401);
  expect((await page.request.post(endpoint, { data, headers: { origin: "https://other.example.test" } })).status()).toBe(403);
  const prisma = client();
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: env("SEED_USER_A_EMAIL") } });
    const current = await prisma.appSession.findFirstOrThrow({ where: { userId: user.id, revokedAt: null }, orderBy: { loginAt: "desc" } });
    await prisma.appSession.update({ where: { id: current.id }, data: { revokedAt: new Date() } });
  } finally { await prisma.$disconnect(); }
  const response = await page.request.post(endpoint, { data, headers });
  expect(response.status()).toBe(401);
  expect(response.headers()["cache-control"]).toBe("no-store");
});
