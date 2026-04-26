import { expect, test } from "@playwright/test";

test("guests land on the login screen", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Household Accounting" })).toBeVisible();
});
