import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getMessages, LOCALE_COOKIE_NAME, type Locale } from "../../src/lib/i18n";
import { clearTransactions } from "./db-cleanup";
import { expect, test, type Page } from "./fixtures";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) || !/dev|test/i.test(databaseUrl.pathname)) {
  throw new Error("Member fixtures require a local dev/test database");
}
const db = new PrismaClient();
const users: string[] = [];
const households: string[] = [];
const password = "Member-filter-fixture-password";
const memberName = "小林".repeat(20);

async function captureDesignFixture(page: Page, name: string) {
  const html = await page.evaluate(async () => {
    const documentCopy = document.documentElement.cloneNode(true) as HTMLElement;
    documentCopy.querySelectorAll("script, link[rel='stylesheet'], nextjs-portal").forEach((element) => element.remove());
    const style = document.createElement("style");
    let css = Array.from(document.styleSheets).flatMap((sheet) => {
      try { return Array.from(sheet.cssRules).map((rule) => rule.cssText.replace(/url\(["']?([^"')]+)["']?\)/g, (match, resource: string) => resource.startsWith("data:") ? match : `url("${new URL(resource, sheet.href ?? document.baseURI).href}")`)); }
      catch { return []; }
    }).join("\n");
    const resources = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => match[1]).filter((url) => !url.startsWith("data:"));
    for (const resource of new Set(resources)) {
      const response = await fetch(resource);
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.slice(offset, offset + 0x8000));
      css = css.split(resource).join(`data:${response.headers.get("content-type") ?? "application/octet-stream"};base64,${btoa(binary)}`);
    }
    style.textContent = css;
    documentCopy.querySelector("head")!.append(style);
    document.querySelectorAll("select").forEach((select, index) => {
      const copy = documentCopy.querySelectorAll("select")[index];
      Array.from(copy.options).forEach((option, optionIndex) => option.toggleAttribute("selected", select.options[optionIndex].selected));
    });
    const base = document.createElement("base");
    base.href = window.location.origin;
    documentCopy.querySelector("head")!.prepend(base);
    return `<!doctype html>${documentCopy.outerHTML}`;
  });
  await mkdir("tmp/validation/four-phase-gaps/design", { recursive: true });
  await writeFile(`tmp/validation/four-phase-gaps/design/${name}.html`, html);
}

async function fixture() {
  const household = await db.household.create({ data: { name: "Member scope household", ledgers: { create: { name: "Default", isDefault: true } } }, include: { ledgers: true } });
  households.push(household.id);
  const owner = await db.user.create({ data: { email: `member-owner-${randomUUID()}@example.test`, displayName: "Owner", passwordHash: await hash(password) } });
  const partner = await db.user.create({ data: { email: `member-partner-${randomUUID()}@example.test`, displayName: "Partner", passwordHash: "not-used" } });
  users.push(owner.id, partner.id);
  const ownerMember = await db.householdMember.create({ data: { householdId: household.id, userId: owner.id, memberName: "负责人", role: "OWNER" } });
  const oldMember = await db.householdMember.create({ data: { householdId: household.id, userId: partner.id, memberName, role: "MEMBER", joinedAt: new Date("2026-08-01T00:00:00Z"), leftAt: new Date("2026-09-01T00:00:00Z") } });
  const newMember = await db.householdMember.create({ data: { householdId: household.id, userId: partner.id, memberName, role: "MEMBER", joinedAt: new Date("2026-10-01T00:00:00Z") } });
  const category = await db.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE" } });
  const base = { householdId: household.id, ledgerId: household.ledgers[0].id, categoryId: category.id, createdByMemberId: ownerMember.id, occurredAt: new Date("2026-10-15T04:00:00Z"), type: "EXPENSE" as const };
  await db.transaction.createMany({ data: [
    { ...base, actorMemberId: oldMember.id, amountFen: 1860, note: "Original membership expense" },
    { ...base, actorMemberId: newMember.id, amountFen: 240, note: "小林 current membership expense" },
    { ...base, actorMemberId: oldMember.id, amountFen: 999, deletedAt: new Date(), note: "Deleted original expense" },
  ] });
  return { owner, household, oldMember, newMember };
}

test.beforeEach(async () => { await clearTransactions(); });
test.afterEach(async () => {
  await clearTransactions();
  await db.household.deleteMany({ where: { id: { in: households.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
test.afterAll(async () => { await db.$disconnect(); });

for (const locale of ["zh-CN", "en-US"] as Locale[]) test(`keeps historical member scope through reports, records, search and export in ${locale}`, async ({ page, context }, testInfo) => {
  const data = await fixture();
  const messages = getMessages(locale);
  await context.addCookies([{ name: LOCALE_COOKIE_NAME, value: locale, url: "http://127.0.0.1:2501" }]);
  await page.goto("/login");
  await page.getByLabel(messages.login.email, { exact: true }).fill(data.owner.email);
  await page.getByLabel(messages.login.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: messages.login.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/home?mode=all&ledger=all");
  const memberSelector = page.getByRole("combobox", { name: messages.memberFilter.label, exact: true });
  await expect(memberSelector).toHaveValue("");
  await memberSelector.selectOption(data.oldMember.id);
  await expect(page).toHaveURL(new RegExp(`member=${data.oldMember.id}`));
  await expect(page.getByTestId("summary-grid")).toContainText("18.60");
  await expect(page.getByTestId("summary-grid")).not.toContainText("2.40");
  await captureDesignFixture(page, `member-home-${locale}`);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`member-home-${locale}-${width}.png`), fullPage: true });
  }
  const drilldown = page.getByTestId("summary-grid").locator("a").filter({ hasText: messages.ui.selectedRangeExpense });
  await expect(drilldown).toHaveAttribute("href", new RegExp(`member=${data.oldMember.id}`));
  await drilldown.click();
  await expect(page.getByText("Original membership expense", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText("小林 current membership expense", { exact: true }).filter({ visible: true })).toHaveCount(0);
  await page.getByLabel(messages.common.search, { exact: true }).fill("membership");
  await page.getByRole("button", { name: messages.common.searchAction, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`member=${data.oldMember.id}`));
  await expect(page.getByText("Original membership expense", { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole("button", { name: messages.safeguards.exports.open, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: messages.safeguards.exports.title, exact: true });
  await expect(dialog.getByRole("combobox", { name: messages.safeguards.exports.memberLabel, exact: true })).toHaveValue(data.oldMember.id);
  await expect(dialog).toContainText(messages.memberFilter.historicalIdentity(memberName, 1));
  await dialog.evaluate(async (element) => { await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))); });
  await captureDesignFixture(page, `member-export-${locale}`);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`member-export-${locale}-${width}.png`), fullPage: true });
  }
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: messages.safeguards.exports.submit, exact: true }).click()]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile((await download.path())!));
  expect(workbook.worksheets[0].rowCount).toBe(2);
  expect(workbook.worksheets[0].getRow(2).getCell(7).value).toBe(1860);
  await dialog.getByRole("combobox", { name: messages.safeguards.exports.memberLabel, exact: true }).selectOption("");
  const [allDownload] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: messages.safeguards.exports.submit, exact: true }).click()]);
  const allWorkbook = new ExcelJS.Workbook();
  await allWorkbook.xlsx.load(await readFile((await allDownload.path())!));
  expect(allWorkbook.worksheets[0].rowCount).toBe(3);
  await dialog.getByRole("button", { name: messages.safeguards.exports.cancel, exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("combobox", { name: messages.memberFilter.label, exact: true }).selectOption(data.newMember.id);
  await expect(page.getByText("小林 current membership expense", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Original membership expense", { exact: true }).filter({ visible: true })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("link", { name: messages.nav.home, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`member=${data.newMember.id}`));
  await expect(page.getByTestId("summary-grid")).toContainText("2.40");
  // Next.js can stream a 200 shell before notFound; the final UI must reveal no records.
  await page.goto("/records?member=nonexistent-member");
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expect(page.getByText("Original membership expense", { exact: true })).toHaveCount(0);
  await expect(page.getByText("小林 current membership expense", { exact: true })).toHaveCount(0);
});
