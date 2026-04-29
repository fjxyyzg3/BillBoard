import { expect, test } from "@playwright/test";

test("guests land on the default Chinese login screen", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "家庭记账" })).toBeVisible();
  await expect(page.getByRole("button", { name: "切换语言" })).toBeVisible();
});

test("guests can switch the login screen to English", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "切换语言" }).click();

  await expect(page.getByRole("heading", { name: "Household Accounting" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Household Accounting" })).toBeVisible();
});
