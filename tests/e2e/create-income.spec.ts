import { expect, test, type Page } from "@playwright/test";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("users can create an income and confirm what was saved", async ({ page }) => {
  const note = `E2E income ${Date.now()}`;

  await logIn(page);
  await page.goto("/add");

  await page.getByLabel("收入").check({ force: true });
  await page.getByLabel("金额").fill("4321.09");
  await page.getByRole("button", { name: "工资" }).click();
  await page.getByLabel("备注").fill(note);
  await page.getByRole("button", { name: "保存记录" }).click();

  await expect(page.getByText("记录已保存")).toBeVisible();
  const addUrl = new URL(page.url());
  expect(addUrl.pathname).toBe("/add");
  expect(addUrl.searchParams.get("created")).toBe("1");
  expect(addUrl.searchParams.get("type")).toBe("income");
  await expect(page.getByText("收入：4,321.09")).toBeVisible();
  await expect(page.getByRole("link", { name: "再记一笔" })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回首页" })).toBeVisible();

  await page.getByRole("link", { name: "记录" }).click();
  await expect(page).toHaveURL(/\/records/);
  const createdRecord = page.getByRole("link", { name: new RegExp(note) });
  await expect(createdRecord).toBeVisible();
  await expect(createdRecord).toContainText("+4321.09");
});
