import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";
import { getMessages, LOCALE_COOKIE_NAME, type Locale } from "../../src/lib/i18n";
import { expect, test } from "./fixtures";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) || !/_(?:dev|test)$/.test(databaseUrl.pathname)) {
  throw new Error("Lifecycle fixtures require a local development/test database");
}
const database = new PrismaClient();
const password = "Lifecycle-e2e-fixture-password";
const userIds: string[] = [];
const householdIds: string[] = [];

async function fixture() {
  const passwordHash = await hash(password);
  const household = await database.household.create({ data: {
    name: "Lifecycle e2e household", ledgers: { create: { name: "Default", isDefault: true } },
  }, include: { ledgers: true } });
  householdIds.push(household.id);
  const people = [];
  for (const role of ["OWNER", "MEMBER"] as const) {
    const user = await database.user.create({ data: {
      email: `lifecycle-e2e-${randomUUID()}@example.com`, displayName: role, passwordHash, emailVerifiedAt: new Date(),
    } });
    userIds.push(user.id);
    const member = await database.householdMember.create({ data: {
      userId: user.id, householdId: household.id, memberName: role, role,
    } });
    people.push({ user, member });
  }
  const category = await database.category.findFirstOrThrow({ where: { type: "EXPENSE", isActive: true } });
  const transaction = await database.transaction.create({ data: {
    householdId: household.id, ledgerId: household.ledgers[0].id,
    actorMemberId: people[1].member.id, createdByMemberId: people[1].member.id,
    categoryId: category.id, type: "EXPENSE", amountFen: 12345,
    occurredAt: new Date("2026-10-21T04:00:00Z"), note: "Lifecycle retained shared expense",
  } });
  return { household, owner: people[0], partner: people[1], transaction };
}

async function login(page: Page, email: string, locale: Locale = "zh-CN") {
  const labels = getMessages(locale).login;
  await page.goto("/login");
  await page.getByLabel(labels.email, { exact: true }).fill(email);
  await page.getByLabel(labels.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: labels.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function captureScreen(page: Page, name: string) {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
}

test.afterEach(async () => {
  await database.accountToken.deleteMany({ where: { userId: { in: userIds } } });
  await database.invitation.deleteMany({ where: { householdId: { in: householdIds } } });
  await database.identityAuditLog.deleteMany({ where: { OR: [{ householdId: { in: householdIds } }, { actorUserId: { in: userIds } }] } });
  await database.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await database.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});
test.afterAll(async () => { await database.$disconnect(); });

test("a member explicitly deactivates their account and both devices lose access while shared history remains", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const current = await fixture();
  const labels = getMessages("zh-CN");
  const secondBrowser = await browser.newContext();
  const secondPage = await secondBrowser.newPage();
  try {
    await login(page, current.partner.user.email);
    await login(secondPage, current.partner.user.email);
    await page.goto("/account");
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: labels.safeguards.lifecycle.deactivateTitle, exact: true }) });
    await expect(section.getByRole("link", { name: labels.safeguards.lifecycle.exportLink })).toHaveAttribute("href", "/records");
    await expect(section.getByRole("link", { name: labels.safeguards.lifecycle.privacyLink })).toHaveAttribute("href", "/account/privacy");
    await section.getByLabel(labels.identity.currentPassword, { exact: true }).fill("Incorrect-password");
    await section.getByRole("checkbox", { name: labels.safeguards.lifecycle.deactivateConfirm, exact: true }).check();
    await section.getByRole("button", { name: labels.safeguards.lifecycle.deactivateSubmit, exact: true }).click();
    await expect(section.getByRole("alert")).toHaveText(labels.identity.errors.INVALID_PASSWORD);
    expect((await database.user.findUniqueOrThrow({ where: { id: current.partner.user.id } })).status).toBe("ACTIVE");
    await captureScreen(page, "lifecycle-account-zh");
    await section.getByLabel(labels.identity.currentPassword, { exact: true }).fill(password);
    await section.getByRole("button", { name: labels.safeguards.lifecycle.deactivateSubmit, exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
    expect((await database.user.findUniqueOrThrow({ where: { id: current.partner.user.id } })).status).toBe("DEACTIVATED");
    await secondPage.goto("/account");
    await expect(secondPage).toHaveURL(/\/login\?reason=session-expired$/);
    expect(await database.transaction.findUniqueOrThrow({ where: { id: current.transaction.id } })).toEqual(current.transaction);
    await login(page, current.owner.user.email);
    await page.goto("/records?mode=month&month=2026-10&year=2026");
    await expect(page.getByText(current.transaction.note!, { exact: true }).filter({ visible: true })).toBeVisible();
    expect(await database.householdMember.count({ where: { householdId: current.household.id, role: "OWNER", leftAt: null } })).toBe(1);
  } finally { await secondBrowser.close(); }
});

test("an owner closes the named household in English and both accounts can sign in without old household access", async ({ page, browser, context }) => {
  test.setTimeout(90_000);
  const current = await fixture();
  const labels = getMessages("en-US");
  await context.addCookies([{ name: LOCALE_COOKIE_NAME, value: "en-US", url: "http://127.0.0.1:2501" }]);
  const secondBrowser = await browser.newContext();
  const secondPage = await secondBrowser.newPage();
  try {
    await login(page, current.owner.user.email, "en-US");
    await login(secondPage, current.partner.user.email);
    await page.goto("/account");
    const deactivation = page.locator("section").filter({ has: page.getByRole("heading", { name: labels.safeguards.lifecycle.deactivateTitle, exact: true }) });
    await deactivation.getByLabel(labels.identity.currentPassword, { exact: true }).fill(password);
    await deactivation.getByRole("checkbox").check();
    await deactivation.getByRole("button", { name: labels.safeguards.lifecycle.deactivateSubmit, exact: true }).click();
    await expect(deactivation.getByRole("alert")).toHaveText(labels.identity.errors.OWNER_TRANSFER_REQUIRED);
    expect((await database.household.findUniqueOrThrow({ where: { id: current.household.id } })).closedAt).toBeNull();
    await page.goto("/account/household");
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: labels.safeguards.lifecycle.closeTitle, exact: true }) });
    await expect(section.getByText(current.household.name, { exact: true })).toBeVisible();
    await expect(section.getByRole("checkbox")).toHaveAccessibleName(`${labels.safeguards.lifecycle.closeConfirm} · ${current.household.name}`);
    await captureScreen(page, "lifecycle-household-en");
    await section.getByLabel(labels.identity.currentPassword, { exact: true }).fill(password);
    await section.getByRole("checkbox").check();
    await section.getByRole("button", { name: labels.safeguards.lifecycle.closeSubmit, exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
    await secondPage.goto("/records");
    await expect(secondPage).toHaveURL(/\/login\?reason=session-expired$/);
    expect(await database.householdMember.count({ where: { householdId: current.household.id, leftAt: null } })).toBe(0);
    expect(await database.user.count({ where: { id: { in: [current.owner.user.id, current.partner.user.id] }, status: "ACTIVE" } })).toBe(2);
    expect(await database.transaction.findUniqueOrThrow({ where: { id: current.transaction.id } })).toEqual(current.transaction);
    await login(secondPage, current.partner.user.email);
    await expect(secondPage.getByRole("heading", { name: getMessages("zh-CN").accountAccess.title, exact: true })).toBeVisible();
    await login(page, current.owner.user.email, "en-US");
    await expect(page.getByRole("heading", { name: labels.accountAccess.title, exact: true })).toBeVisible();
    await page.goto("/account");
    const accountOnly = page.locator("section").filter({ has: page.getByRole("heading", { name: labels.safeguards.lifecycle.deactivateTitle, exact: true }) });
    await expect(accountOnly.getByRole("link", { name: labels.safeguards.lifecycle.exportLink })).toHaveCount(0);
    await accountOnly.getByLabel(labels.identity.currentPassword, { exact: true }).fill(password);
    await accountOnly.getByRole("checkbox").check();
    await accountOnly.getByRole("button", { name: labels.safeguards.lifecycle.deactivateSubmit, exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
    expect((await database.user.findUniqueOrThrow({ where: { id: current.owner.user.id } })).status).toBe("DEACTIVATED");
    expect((await database.user.findUniqueOrThrow({ where: { id: current.partner.user.id } })).status).toBe("ACTIVE");
  } finally { await secondBrowser.close(); }
});
