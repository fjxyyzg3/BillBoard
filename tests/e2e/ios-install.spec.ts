import { expect, test } from "./fixtures";

test("returns a visitor who signs in for the iOS app to the installation section", async ({ page }) => {
  await page.goto("/help");
  const installation = page.locator("#ios-install");
  await installation.getByRole("link", { name: "登录以安装" }).click({ timeout: 5000 });
  await page.getByLabel("邮箱", { exact: true }).fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码", { exact: true }).fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/help#ios-install$/);
  await expect(installation.getByRole("heading", { name: "安装 iOS 版" })).toBeVisible();
  await expect(installation.getByRole("link", { name: "登录以安装" })).toHaveCount(0);
});
