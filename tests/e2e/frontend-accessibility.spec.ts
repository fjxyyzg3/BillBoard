import { getMessages, LOCALE_COOKIE_NAME } from "../../src/lib/i18n";
import { expect, test, type Page } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function logIn(page: Page, locale: "zh-CN" | "en-US" = "zh-CN") {
  const messages = getMessages(locale);
  await page.context().addCookies([{ name: LOCALE_COOKIE_NAME, value: locale, url: "http://127.0.0.1:2501" }]);
  await page.goto("/login");
  await page.getByLabel(messages.login.email).fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel(messages.login.password).fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: messages.login.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`page titles identify the current task and skip navigation reaches content in ${locale}`, async ({ page }) => {
    const messages = getMessages(locale);
    await logIn(page, locale);
    for (const [route, title] of [
      ["/home", messages.home.title],
      ["/add", messages.add.title],
      ["/records", messages.records.title],
      ["/records/import", messages.import.title],
      ["/ledgers", messages.ledgers.title],
    ]) {
      await page.goto(route);
      await expect(page).toHaveTitle(`${title} · BillBoard`);
    }
    await page.goto("/add");
    await expect(page.getByLabel(messages.common.amount, { exact: true })).toBeEditable();
    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: locale === "zh-CN" ? "跳到主要内容" : "Skip to main content" });
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.querySelector("main")?.contains(document.activeElement))).toBe(true);
  });
}

test("category choices share one tab stop and respond to arrow keys", async ({ page }) => {
  await logIn(page);
  await page.goto("/add");
  await expect(page.getByLabel("金额", { exact: true })).toBeEditable();
  const categories = page.getByRole("group", { name: "分类", exact: true });
  const radios = categories.getByRole("radio");
  await expect(radios).toHaveCount(7);
  const initial = categories.getByRole("radio", { checked: true });
  const initialValue = await initial.inputValue();
  await initial.focus();
  await page.keyboard.press("ArrowRight");
  const selected = categories.getByRole("radio", { checked: true });
  await expect(selected).toBeFocused();
  await expect(selected.locator("..")).toHaveCSS("background-color", "rgb(255, 240, 235)");
  expect(await selected.inputValue()).not.toBe(initialValue);
  await page.keyboard.press("Tab");
  await expect(categories.getByRole("button", { name: "更多", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await radios.count()).toBeGreaterThan(7);
  await expect(selected).toBeChecked();
});
