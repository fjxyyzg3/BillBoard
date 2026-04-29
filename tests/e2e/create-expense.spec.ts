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

test("users can create an expense and confirm what was saved", async ({ page }) => {
  const note = `E2E expense ${Date.now()}`;

  await logIn(page);
  await page.goto("/add?perspective=spouse&range=last-30-days");

  await page.getByLabel("金额").fill("12.34");
  await page.getByRole("button", { name: "买菜" }).click();
  await page.getByLabel("成员").selectOption({ label: requireEnv("SEED_USER_B_NAME") });
  await page.getByLabel("备注").fill(note);
  await page.getByRole("button", { name: "保存记录" }).click();

  await expect(page.getByText("记录已保存")).toBeVisible();
  const addUrl = new URL(page.url());
  expect(addUrl.pathname).toBe("/add");
  expect(addUrl.searchParams.get("created")).toBe("1");
  expect(addUrl.searchParams.get("perspective")).toBe("spouse");
  expect(addUrl.searchParams.get("range")).toBe("last-30-days");
  expect(addUrl.searchParams.get("type")).toBe("expense");
  await expect(page.getByText("支出：12.34")).toBeVisible();
  await expect(page.getByRole("link", { name: "再记一笔" })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回首页" })).toBeVisible();

  await page.getByRole("link", { name: "记录" }).click();
  await expect(page).toHaveURL(/\/records/);
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/range=last-30-days/);
  const createdRecord = page.getByRole("link", { name: new RegExp(note) });
  await expect(createdRecord).toBeVisible();
  await expect(createdRecord).toContainText("-12.34");
});
