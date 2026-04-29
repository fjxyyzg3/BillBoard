import { expect, test } from "@playwright/test";

test("shared filters persist while navigating between app pages", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("spouse@example.com");
  await page.getByLabel("密码").fill("change-me");
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/home?perspective=spouse&range=last-30-days");
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/range=last-30-days/);

  const navigation = page.getByRole("navigation");
  await navigation.getByRole("link", { name: "记一笔", exact: true }).click();
  await expect(page).toHaveURL(/\/add\?/);
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/range=last-30-days/);

  await navigation.getByRole("link", { name: "记录" }).click();
  await expect(page).toHaveURL(/\/records\?/);
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/range=last-30-days/);

  await page.getByRole("button", { name: "切换语言" }).click();
  await expect(navigation.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Add", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Records", exact: true })).toBeVisible();

  const recordsUrl = new URL(page.url());
  expect(recordsUrl.pathname).toBe("/records");
  expect(recordsUrl.searchParams.get("perspective")).toBe("spouse");
  expect(recordsUrl.searchParams.get("range")).toBe("last-30-days");
  expect(recordsUrl.searchParams.has("locale")).toBe(false);
});
