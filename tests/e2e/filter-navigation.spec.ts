import { expect, test } from "@playwright/test";

test("shared filters persist while navigating between app pages", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill("spouse@example.com");
  await page.locator('input[name="password"]').fill("change-me");
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole("button", { name: "Spouse" }).click();
  await page.getByLabel("Range").selectOption("last-30-days");
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/range=last-30-days/);

  await page.getByRole("link", { name: "Add" }).click();
  await expect(page).toHaveURL(/\/add\?/);
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/range=last-30-days/);

  await page.getByRole("link", { name: "Records" }).click();
  await expect(page).toHaveURL(/\/records\?/);
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/range=last-30-days/);
});
