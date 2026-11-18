import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { PrismaClient } from "@prisma/client";
import type { Locator, Page } from "@playwright/test";
import { getMessages, LOCALE_COOKIE_NAME, type Locale } from "../../src/lib/i18n";
import { expect, test } from "./fixtures";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) || !/_(?:dev|test)$/.test(databaseUrl.pathname)) {
  throw new Error("Processing choice fixtures require a local development/test database");
}
const database = new PrismaClient();
const password = "Processing-choice-e2e-password";
const householdIds: string[] = [];
const userIds: string[] = [];
type MicrophoneWindow = typeof window & { processingMicrophoneCalls: number };

async function fixture() {
  const user = await database.user.create({ data: {
    email: `processing-e2e-${randomUUID()}@example.com`, displayName: "Processing choice owner",
    passwordHash: await hash(password), emailVerifiedAt: new Date(),
  } });
  userIds.push(user.id);
  const household = await database.household.create({ data: {
    name: "Processing choice household", ledgers: { create: { name: "Default", isDefault: true } },
    members: { create: { userId: user.id, memberName: "Owner", role: "OWNER" } },
  } });
  householdIds.push(household.id);
  return { user, household };
}

async function login(page: Page, email: string, locale: Locale = "zh-CN") {
  const labels = getMessages(locale).login;
  await page.goto("/login");
  await page.getByLabel(labels.email, { exact: true }).fill(email);
  await page.getByLabel(labels.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: labels.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

function settings(page: Page, locale: Locale, within?: Locator) {
  const labels = getMessages(locale).safeguards.processing;
  return (within ?? page).locator("section").filter({ has: page.getByRole("checkbox", { name: labels.ai }) });
}

async function saveChoices(page: Page, locale: Locale, ai: boolean, voice: boolean, within?: Locator) {
  const labels = getMessages(locale).safeguards.processing;
  const form = settings(page, locale, within);
  await form.getByRole("checkbox", { name: labels.ai }).setChecked(ai);
  await form.getByRole("checkbox", { name: labels.voice }).setChecked(voice);
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/account/processing" && result.request().method() === "POST");
  await form.getByRole("button", { name: labels.save, exact: true }).click();
  const saved = await response;
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ ai, voice });
}

async function refreshChoices(page: Page) {
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/account/processing" && result.request().method() === "GET");
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const refreshed = await response;
  expect(refreshed.status()).toBe(200);
  await refreshed.finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function accountingPosts(page: Page) {
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (request.headers()["next-action"] || path === "/api/voice/transcribe" || path === "/api/voice/entry")) {
      requests.push(path);
    }
  });
  return requests;
}

async function capture(page: Page, name: string, dialog: Locator) {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await expect.poll(() => dialog.locator(".pointer-events-auto").evaluate((panel) => getComputedStyle(panel).opacity)).toBe("1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
}

test.afterEach(async () => {
  await database.identityAuditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await database.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await database.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});
test.afterAll(async () => { await database.$disconnect(); });

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`first processing choice preserves the text and never submits until the user explicitly retries in ${locale}`, async ({ page, context }) => {
    test.setTimeout(90_000);
    const current = await fixture();
    const labels = getMessages(locale);
    const processing = labels.safeguards.processing;
    await context.addCookies([{ name: LOCALE_COOKIE_NAME, value: locale, url: "http://127.0.0.1:2501" }]);
    await login(page, current.user.email, locale);
    await page.goto("/add");
    await page.getByRole("button", { name: labels.add.naturalMode, exact: true }).click();
    const description = page.getByRole("textbox", { name: labels.add.naturalLanguage.label, exact: true });
    const text = locale === "zh-CN" ? "午饭35元" : "Lunch 35 CNY";
    await description.fill(text);
    const form = page.locator("form").filter({ has: description });
    const requests = accountingPosts(page);
    await form.getByRole("button", { name: labels.add.naturalLanguage.import, exact: true }).click();
    const choice = page.getByRole("dialog", { name: processing.title, exact: true });
    await expect(choice).toBeVisible();
    await expect(choice.getByText(processing.required, { exact: true })).toBeVisible();
    await expect(choice.getByRole("checkbox", { name: processing.ai })).not.toBeChecked();
    await expect(choice.getByRole("checkbox", { name: processing.voice })).not.toBeChecked();
    expect(requests).toEqual([]);
    expect(await database.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
    await capture(page, `processing-first-${locale}`, choice);
    await choice.getByRole("button", { name: processing.later, exact: true }).click();
    await expect(choice).toHaveCount(0);
    await expect(description).toHaveValue(text);
    expect(requests).toEqual([]);
    expect(await database.transaction.count({ where: { householdId: current.household.id } })).toBe(0);
    await form.getByRole("button", { name: labels.add.naturalLanguage.import, exact: true }).click();
    await expect(choice).toBeVisible();
    await saveChoices(page, locale, true, false, choice);
    await expect(choice).toHaveCount(0);
    await expect(description).toHaveValue(text);
    expect(requests).toEqual([]);
    expect(await database.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
    expect(await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }))).not.toContain(text);
    await form.getByRole("button", { name: labels.add.naturalLanguage.import, exact: true }).click();
    await expect(form.getByText(labels.add.naturalLanguage.success(1, null, "35.00"), { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(await database.transaction.count({ where: { householdId: current.household.id, amountFen: 3500, deletedAt: null } })).toBe(1);
    expect(await database.naturalLanguageRequest.count({ where: { householdId: current.household.id, status: "SUCCEEDED" } })).toBe(1);
    expect(await database.user.findUniqueOrThrow({ where: { id: current.user.id } })).toMatchObject({ aiProcessingEnabled: true, voiceProcessingEnabled: false });
  });
}

test("cross-device choices gate microphone access independently and closing both still permits manual accounting", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const current = await fixture();
  const labels = getMessages("zh-CN");
  const processing = labels.safeguards.processing;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    (window as MicrophoneWindow).processingMicrophoneCalls = 0;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      (window as MicrophoneWindow).processingMicrophoneCalls += 1;
      throw new DOMException("Synthetic microphone permission refusal", "NotAllowedError");
    } });
  });
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  const microphoneCalls = () => page.evaluate(() => (window as MicrophoneWindow).processingMicrophoneCalls);
  const tryVoice = async () => {
    const link = page.getByRole("link", { name: labels.nav.add, exact: true }).filter({ visible: true });
    await link.focus();
    await page.keyboard.press("Space");
  };
  try {
    await login(page, current.user.email);
    await login(second, current.user.email);
    await page.goto("/add");
    await page.getByRole("button", { name: labels.add.naturalMode, exact: true }).click();
    const description = page.getByRole("textbox", { name: labels.add.naturalLanguage.label, exact: true });
    await description.fill("午饭99元");
    const requests = accountingPosts(page);
    await second.goto("/account");
    await saveChoices(second, "zh-CN", true, false);
    await refreshChoices(page);
    await tryVoice();
    const choice = page.getByRole("dialog", { name: processing.title, exact: true });
    await expect(choice).toBeVisible();
    await expect(choice.getByText(processing.voiceRequired, { exact: true })).toBeVisible();
    await expect(choice.getByRole("checkbox", { name: processing.ai })).toBeChecked();
    await expect(choice.getByRole("checkbox", { name: processing.voice })).not.toBeChecked();
    expect(await microphoneCalls()).toBe(0);
    expect(requests).toEqual([]);
    await choice.getByRole("button", { name: processing.later, exact: true }).click();
    await expect(choice).toHaveCount(0);
    await saveChoices(second, "zh-CN", false, true);
    await refreshChoices(page);
    await tryVoice();
    await expect(choice).toBeVisible();
    await expect(choice.getByRole("checkbox", { name: processing.ai })).not.toBeChecked();
    await expect(choice.getByRole("checkbox", { name: processing.voice })).toBeChecked();
    expect(await microphoneCalls()).toBe(0);
    expect(requests).toEqual([]);
    await choice.getByRole("button", { name: processing.later, exact: true }).click();
    await expect(choice).toHaveCount(0);
    await saveChoices(second, "zh-CN", true, true);
    await refreshChoices(page);
    await tryVoice();
    const voice = page.getByRole("dialog", { name: labels.add.voice.title, exact: true });
    await expect(voice.getByRole("alert")).toContainText(labels.add.voice.errors.denied);
    expect(await microphoneCalls()).toBe(1);
    expect(requests).toEqual([]);
    await voice.getByRole("button", { name: labels.add.voice.close, exact: true }).click();
    await saveChoices(second, "zh-CN", false, false);
    await refreshChoices(page);
    await expect(description).toHaveValue("午饭99元");
    const natural = page.locator("form").filter({ has: description });
    await natural.getByRole("button", { name: labels.add.naturalLanguage.import, exact: true }).click();
    await expect(choice).toBeVisible();
    await choice.getByRole("button", { name: processing.later, exact: true }).click();
    await expect(choice).toHaveCount(0);
    await expect(description).toHaveValue("午饭99元");
    expect(requests).toEqual([]);
    await page.getByRole("button", { name: labels.add.manualMode, exact: true }).click();
    await page.getByLabel(labels.common.amount, { exact: true }).fill("12.34");
    await page.getByRole("button", { name: labels.add.save, exact: true }).click();
    await expect(page.getByText(labels.add.successMessage, { exact: true })).toBeVisible();
    expect(await database.transaction.count({ where: { householdId: current.household.id, amountFen: 1234, deletedAt: null } })).toBe(1);
    expect(await database.naturalLanguageRequest.count({ where: { householdId: current.household.id } })).toBe(0);
    expect(await database.user.findUniqueOrThrow({ where: { id: current.user.id } })).toMatchObject({ aiProcessingEnabled: false, voiceProcessingEnabled: false });
    await second.reload();
    await expect(settings(second, "zh-CN").getByRole("checkbox", { name: processing.ai })).not.toBeChecked();
    await expect(settings(second, "zh-CN").getByRole("checkbox", { name: processing.voice })).not.toBeChecked();
  } finally { await secondContext.close(); }
});
