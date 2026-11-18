import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { getMessages } from "../../src/lib/i18n";
import { getCapturedIdentityMail } from "./mail-fixture";
import { expect, test } from "./fixtures";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) || !/_(?:dev|test)$/.test(databaseUrl.pathname)) throw new Error("Access request fixtures require a local development/test database");
const database = new PrismaClient();
const emails: string[] = [];

function applicantEmail() {
  const email = `access-request-${randomUUID()}@example.com`;
  emails.push(email);
  return email;
}

test.beforeEach(async () => {
  // Each case exercises its own public budget, independently of earlier requests.
  await database.identityRateLimit.deleteMany({ where: { id: { startsWith: "public-application:" } } });
});

test.afterEach(async () => {
  const applications = await database.accessApplication.findMany({ where: { email: { in: emails } }, select: { id: true } });
  await database.opsAuditLog.deleteMany({ where: { targetAccessApplicationId: { in: applications.map((application) => application.id) } } });
  await database.invitation.deleteMany({ where: { accessApplicationId: { in: applications.map((application) => application.id) } } });
  await database.accessApplication.deleteMany({ where: { email: { in: emails } } });
  await database.accessApplicationConfirmation.deleteMany({ where: { email: { in: emails } } });
  emails.length = 0;
});
test.afterAll(async () => { await database.$disconnect(); });

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`a public ${locale} application has a local 60-second resubmission cooldown`, async ({ page, context }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    const email = applicantEmail();
    const replacementEmail = applicantEmail();
    const labels = getMessages(locale).accessApplication;
    const cooldownLabel = (seconds: number) => locale === "zh-CN" ? `${seconds} 秒后可重新提交` : `Submit again in ${seconds}s`;
    // A real pending request takes the same public acceptance path without sending another email.
    await database.accessApplication.create({ data: { email, verifiedAt: new Date() } });
    await context.addCookies([{ name: "billboard-locale", value: locale, url: "http://127.0.0.1:2501" }]);
    await page.clock.install();
    await page.goto("/help");
    await page.clock.pauseAt(Date.now() + 60_000);
    const section = page.locator("#apply");
    const input = section.getByLabel(labels.email, { exact: true });
    const submit = section.locator('button[type="submit"]');
    let submissions = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"] && new URL(request.url()).pathname === "/help") submissions += 1;
    });
    await input.fill(email);
    await submit.click();
    await expect(section.getByRole("status")).toHaveText(labels.accepted);
    await expect(submit).toHaveText(cooldownLabel(60));
    await expect(submit).toBeDisabled();
    await expect(input).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await input.fill(replacementEmail);
    await section.locator("form").evaluate((form: HTMLFormElement) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    // A backgrounded page may receive one timer callback after most of a minute has elapsed.
    await page.clock.fastForward(59_000);
    await expect(submit).toHaveText(cooldownLabel(1));
    await expect(submit).toBeDisabled();
    expect(submissions).toBe(1);
    expect(await getCapturedIdentityMail(email)).toEqual([]);
    expect(await getCapturedIdentityMail(replacementEmail)).toEqual([]);
    expect(await page.evaluate((value) => [localStorage, sessionStorage].some((storage) => Object.keys(storage).some((key) => storage.getItem(key)?.includes(value))), email)).toBe(false);
    await page.clock.runFor(1_000);
    await expect(submit).toHaveText(labels.submit);
    await expect(submit).toBeEnabled();
    await input.fill(email);
    await submit.click();
    await expect(submit).toHaveText(cooldownLabel(60));
    await expect(submit).toBeDisabled();
    expect(submissions).toBe(2);
  });
}

test("a failed application submission uses the same 60-second resubmission cooldown", async ({ page }) => {
  const labels = getMessages("zh-CN").accessApplication;
  const email = applicantEmail();
  await page.clock.install();
  await page.route("**/help", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) await route.abort("failed");
    else await route.continue();
  });
  await page.goto("/help");
  await page.clock.pauseAt(Date.now() + 60_000);
  const section = page.locator("#apply");
  const submit = section.locator('button[type="submit"]');
  await section.getByLabel(labels.email, { exact: true }).fill(email);
  await submit.click();
  await expect(section.getByRole("alert")).toBeVisible();
  await expect(submit).toHaveText("60 秒后可重新提交");
  await expect(submit).toBeDisabled();
  await page.clock.fastForward(60_000);
  await expect(submit).toHaveText(labels.submit);
  await expect(submit).toBeEnabled();
});

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`a public ${locale} request limits notes to 80 characters in the browser and on the server`, async ({ page, context }) => {
    const email = applicantEmail();
    const messages = getMessages(locale);
    await context.addCookies([{ name: "billboard-locale", value: locale, url: "http://127.0.0.1:2501" }]);
    await page.goto("/help");
    const section = page.locator("#apply");
    await section.getByLabel(messages.accessApplication.email, { exact: true }).fill(email);
    const note = section.getByLabel(messages.accessApplication.note, { exact: true });
    await note.fill("甲".repeat(79));
    await note.pressSequentially("乙丙");
    await expect(note).toHaveValue(`${"甲".repeat(79)}乙`);
    const oversized = "甲".repeat(81);
    await note.evaluate((element: HTMLTextAreaElement, value) => { element.value = value; }, oversized);
    // Bypass native form validation to exercise the server's independent limit.
    await section.locator("form").evaluate((form: HTMLFormElement) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await expect(section.getByRole("alert")).toHaveText(messages.identity.errors.APPLICATION_NOTE_TOO_LONG);
    await expect(note).toHaveValue(oversized);
    expect(await database.accessApplicationConfirmation.count({ where: { email } })).toBe(0);
    expect(await getCapturedIdentityMail(email)).toEqual([]);
    expect(await page.evaluate((raw) => [localStorage, sessionStorage].some((storage) => Object.keys(storage).some((key) => storage.getItem(key)?.includes(raw))), oversized)).toBe(false);
  });

  test(`a public ${locale} request enters review only after explicit email confirmation`, async ({ page, context }) => {
    const email = applicantEmail();
    const labels = getMessages(locale).accessApplication;
    const note = locale === "zh-CN" ? "维护者的朋友\n申请家庭记账".padEnd(80, "甲") : null;
    await context.addCookies([{ name: "billboard-locale", value: locale, url: "http://127.0.0.1:2501" }]);
    await page.goto("/help");
    await page.getByRole("heading", { name: labels.title, exact: true }).scrollIntoViewIfNeeded();
    await page.getByLabel(labels.email, { exact: true }).fill(email);
    if (note) await page.getByLabel(labels.note, { exact: true }).fill(note);
    await page.getByRole("button", { name: labels.submit, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: labels.accepted })).toBeVisible();
    let confirmationLink = "";
    await expect.poll(async () => {
      const messages = await getCapturedIdentityMail(email);
      if (note) expect(messages.every((message) => !message.text.includes(note))).toBe(true);
      confirmationLink = messages.flatMap((message) => message.text.match(/http:\/\/127\.0\.0\.1:2501\/account-link#kind=application&token=[A-Za-z0-9_-]+/g) ?? []).at(-1) ?? "";
      return confirmationLink.length > 0;
    }, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => Boolean((await database.accessApplicationConfirmation.findFirst({ where: { email } }))?.sentAt)).toBe(true);
    expect((await database.accessApplicationConfirmation.findFirstOrThrow({ where: { email } })).note).toBe(note);
    expect(await database.accessApplication.count({ where: { email } })).toBe(0);
    expect(await database.user.count({ where: { email } })).toBe(0);

    const networkUrls: string[] = [];
    page.on("request", (request) => { if (request.method() === "GET") networkUrls.push(request.url()); });
    await page.goto(confirmationLink);
    await expect(page).toHaveURL("http://127.0.0.1:2501/account-link");
    await expect(page.getByRole("heading", { name: labels.confirmTitle, exact: true })).toBeVisible();
    expect(await database.accessApplication.count({ where: { email } })).toBe(0);
    const token = new URLSearchParams(new URL(confirmationLink).hash.slice(1)).get("token")!;
    expect(networkUrls.every((url) => !url.includes(token) && !url.includes("#kind="))).toBe(true);
    expect(await page.evaluate((raw) => [localStorage, sessionStorage].some((storage) => Object.keys(storage).some((key) => storage.getItem(key)?.includes(raw))), token)).toBe(false);

    await page.getByRole("button", { name: labels.confirm, exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(labels.pending);
    const application = await database.accessApplication.findFirstOrThrow({ where: { email } });
    expect(application.status).toBe("PENDING");
    expect(application.locale).toBe(locale);
    expect(application.note).toBe(note);
    expect(application.verifiedAt).toBeInstanceOf(Date);
    expect(await database.user.count({ where: { email } })).toBe(0);
    expect((await context.cookies()).some((cookie) => cookie.name.includes("session-token"))).toBe(false);
    if (note) {
      expect(networkUrls.every((url) => !decodeURIComponent(url).includes(note))).toBe(true);
      expect(await page.evaluate((raw) => [localStorage, sessionStorage].some((storage) => Object.keys(storage).some((key) => storage.getItem(key)?.includes(raw))), note)).toBe(false);
    }
    await page.getByRole("link", { name: labels.back, exact: true }).click();
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole("heading", { name: getMessages(locale).help.title, exact: true })).toBeVisible();
  });
}

test("an expired request confirmation keeps the guide reachable and creates no account", async ({ page }) => {
  const email = applicantEmail();
  const token = randomBytes(32).toString("base64url");
  await database.accessApplicationConfirmation.create({ data: { email, tokenHash: createHash("sha256").update(token).digest("hex"), sentAt: new Date(), expiresAt: new Date(Date.now() - 60_000) } });
  const messages = getMessages("zh-CN");
  await page.goto(`/account-link#kind=application&token=${token}`);
  await page.getByRole("button", { name: messages.accessApplication.confirm, exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: messages.identity.errors.APPLICATION_LINK_INVALID })).toHaveText(messages.identity.errors.APPLICATION_LINK_INVALID);
  expect(await database.accessApplication.count({ where: { email } })).toBe(0);
  expect(await database.user.count({ where: { email } })).toBe(0);
  await page.getByRole("link", { name: messages.accessApplication.back, exact: true }).click();
  await expect(page).toHaveURL(/\/help$/);
});
