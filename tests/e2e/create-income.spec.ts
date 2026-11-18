import { expect, test, type Page } from "./fixtures";

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

  await expect(page.getByLabel("金额")).toBeEditable();
  await page.getByText("收入", { exact: true }).click();
  await page.getByLabel("金额").fill("4321.09");
  await page.getByRole("radio", { name: "工资" }).check();
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注").fill(note);
  await page.getByRole("button", { name: "保存记录" }).click();

  await expect(page.getByText("记录已保存")).toBeVisible();
  const addUrl = new URL(page.url());
  expect(addUrl.pathname).toBe("/add");
  expect(addUrl.searchParams.has("created")).toBe(false);
  expect(addUrl.searchParams.has("amountFen")).toBe(false);
  expect(addUrl.searchParams.has("type")).toBe(false);
  expect(addUrl.searchParams.has("clientRequestId")).toBe(false);
  await expect(page.getByText("收入：4,321.09")).toBeVisible();
  await expect(page.getByLabel("金额")).toHaveValue("");
  await expect(page.getByRole("radio", { name: "支出", exact: true })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "备注", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加备注", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "再记一笔" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "返回首页" })).toHaveCount(0);

  await page.getByRole("link", { name: "记录" }).click();
  await expect(page).toHaveURL(/\/records/);
  const createdRecord = page.getByRole("link").filter({ hasText: note });
  await expect(createdRecord).toBeVisible();
  await expect(createdRecord).toContainText("+4321.09");
  await expect(createdRecord).toContainText("工资");
  await expect(createdRecord).toContainText(requireEnv("SEED_USER_A_NAME"));
});
