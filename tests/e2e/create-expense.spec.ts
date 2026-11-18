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

test("users can create an expense and confirm what was saved", async ({ page }) => {
  const note = `E2E expense ${Date.now()}`;

  await logIn(page);
  await page.goto("/add?perspective=spouse&mode=month");
  const legacyAddHref = page.url();

  await expect(page.getByRole("button", { name: "更多" })).toBeVisible();
  await expect(page.getByLabel("时间")).toBeVisible();
  await page.getByLabel("金额").fill("12+8/2");
  await expect(page.getByText("= 16.00")).toBeVisible();
  await page.getByRole("radio", { name: "购物" }).check();
  await page.getByRole("radio", { name: requireEnv("SEED_USER_B_NAME"), exact: true }).check();
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注").fill(note);
  await page.getByRole("button", { name: "收起备注", exact: true }).click();
  await page.getByRole("button", { name: "保存记录" }).click();

  await expect(page.getByText("记录已保存")).toBeVisible();
  await expect(page).toHaveURL(legacyAddHref);
  await expect(page.locator('a[href*="perspective="]')).toHaveCount(0);
  const addUrl = new URL(page.url());
  expect(addUrl.pathname).toBe("/add");
  expect(addUrl.searchParams.get("mode")).toBe("month");
  expect(addUrl.searchParams.has("created")).toBe(false);
  expect(addUrl.searchParams.has("amountFen")).toBe(false);
  expect(addUrl.searchParams.has("type")).toBe(false);
  expect(addUrl.searchParams.has("clientRequestId")).toBe(false);
  await expect(page.getByText("支出：16.00")).toBeVisible();
  await expect(page.getByLabel("金额")).toHaveValue("");
  await expect(page.getByRole("radio", { name: "支出", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: requireEnv("SEED_USER_A_NAME"), exact: true })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "备注", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加备注", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "更多" })).toBeVisible();
  await expect(page.getByRole("link", { name: "再记一笔" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "返回首页" })).toHaveCount(0);

  await page.getByRole("link", { name: "记录" }).click();
  await expect(page).toHaveURL(/\/records/);
  await expect(page).not.toHaveURL(/perspective=/);
  await expect(page).toHaveURL(/mode=month/);
  const createdRecord = page.getByRole("link").filter({ hasText: note });
  await expect(createdRecord).toBeVisible();
  await expect(createdRecord).toContainText("-16.00");
  await expect(createdRecord).toContainText("购物");
  await expect(createdRecord).toContainText(requireEnv("SEED_USER_B_NAME"));

  await createdRecord.click();
  const editorDrawer = page.getByRole("dialog", { name: "编辑记录", exact: true });
  await expect(editorDrawer).toContainText("编辑记录");
  await editorDrawer.getByLabel("金额").fill("10/3");
  await expect(page.getByText("= 3.33")).toBeVisible();
  await page.getByRole("button", { name: "保存修改" }).click();

  const updatedRecord = page.getByRole("link").filter({ hasText: note });
  await expect(updatedRecord).toBeVisible();
  await expect(updatedRecord).toContainText("-3.33");
});
