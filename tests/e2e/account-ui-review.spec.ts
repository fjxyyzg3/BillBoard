import { getEncryptionMessages, getMessages } from "../../src/lib/i18n";
import { expect, test, type Page } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function login(page: Page) {
  const labels = getMessages("zh-CN").login;
  await page.goto("/login");
  await page.getByLabel(labels.email, { exact: true }).fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel(labels.password, { exact: true }).fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: labels.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("password mismatches focus and describe the confirmation field until edited", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/account");
  const labels = getMessages("zh-CN").identity;
  const confirmation = page.getByLabel(labels.confirmPassword, { exact: true });
  const form = page.locator("form").filter({ has: confirmation });
  // A client-validation regression must never change the shared test account password.
  await form.getByLabel(labels.currentPassword, { exact: true }).fill("synthetic-invalid-current-password");
  await form.getByLabel(labels.newPassword, { exact: true }).fill("synthetic-new-password");
  await confirmation.fill("synthetic-different-password");
  await form.getByRole("button", { name: labels.changePassword, exact: true }).click();
  await expect(confirmation).toBeFocused();
  await expect(confirmation).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByRole("alert")).toHaveText(labels.passwordMismatch);
  await expect.poll(() => confirmation.evaluate((input) => {
    const ids = input.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
    return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  })).toBe(labels.passwordMismatch);

  await confirmation.fill("synthetic-new-password");
  await expect(confirmation).not.toHaveAttribute("aria-invalid", "true");
  await expect(confirmation).not.toHaveAttribute("aria-describedby");
  await expect(form.getByRole("alert")).toHaveCount(0);
});

test("device cleanup defaults to cancellation and removes synthetic drafts only after confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page);
  await page.goto("/account/household");
  const settings = page.getByTestId("household-encryption-settings");
  await expect(settings).toBeVisible();
  await expect(settings).not.toHaveAttribute("data-desktop-update-blocked", "true");
  const labels = getEncryptionMessages("zh-CN");
  const trigger = settings.getByRole("button", { name: labels.forget, exact: true });
  const keys = ["billboard:transaction-draft:ui-review", "billboard:natural-language-ui-review", "billboard:voice-ui-review"];
  const draft = "synthetic-ui-review-draft";
  await page.evaluate(({ keys, draft }) => {
    for (const storage of [sessionStorage, localStorage]) for (const key of keys) storage.setItem(key, draft);
  }, { keys, draft });
  const readDrafts = () => page.evaluate((keys) => [sessionStorage, localStorage].flatMap((storage) => keys.map((key) => storage.getItem(key))), keys);

  await trigger.click();
  const dialog = page.getByRole("dialog", { name: labels.forgetTitle, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(labels.forgetHelp, { exact: true })).toBeVisible();
  const cancel = dialog.locator("footer").getByRole("button", { name: labels.cancel, exact: true });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await readDrafts()).toEqual(Array(6).fill(draft));

  await trigger.click();
  await dialog.getByRole("button", { name: labels.forgetConfirm, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(readDrafts).toEqual(Array(6).fill(null));
  await expect(page).toHaveURL(/\/account\/household$/);
});

test("long household names fit the heading and closure confirmation on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await login(page);
  await page.goto("/account/household");
  const messages = getMessages("zh-CN");
  const heading = page.getByRole("heading", { level: 1, name: messages.identity.householdTitle, exact: true }).locator("..").locator("p");
  const closure = page.locator("section").filter({ has: page.getByRole("heading", { name: messages.safeguards.lifecycle.closeTitle, exact: true }) });
  const confirmation = closure.getByRole("checkbox").locator("..").locator("span");
  await expect(heading).toBeVisible();
  await expect(confirmation).toBeVisible();
  const name = "W".repeat(80);
  // Exercise the real rendered containers without renaming the shared fixture household.
  await heading.evaluate((element, name) => { element.textContent = name; }, name);
  await confirmation.evaluate((element, copy) => { element.textContent = copy; }, `${messages.safeguards.lifecycle.closeConfirm} · ${name}`);
  await page.evaluate(() => document.fonts.ready);
  for (const text of [heading, confirmation]) {
    await expect.poll(() => text.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { fitsViewport: bounds.left >= 0 && bounds.right <= window.innerWidth + 1, overflows: element.scrollWidth > element.clientWidth + 1 };
    })).toEqual({ fitsViewport: true, overflows: false });
  }
});
