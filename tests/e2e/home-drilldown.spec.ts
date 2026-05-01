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

test("home expense drill-down preserves shared filters", async ({ page }) => {
  const note = `E2E home drilldown ${Date.now()}`;

  await logIn(page);
  await page.goto("/add");

  await page.getByLabel("金额").fill("45.67");
  await page.getByRole("button", { name: "买菜" }).click();
  await page.getByLabel("成员").selectOption({ label: requireEnv("SEED_USER_B_NAME") });
  await page.getByLabel("备注").fill(note);
  await page.getByRole("button", { name: "保存记录" }).click();
  await expect(page.getByText("记录已保存")).toBeVisible();
  const addUrl = new URL(page.url());
  expect(addUrl.pathname).toBe("/add");
  expect(addUrl.searchParams.get("created")).toBe("1");
  expect(addUrl.searchParams.get("type")).toBe("expense");

  await page.goto("/home?perspective=spouse&range=last-30-days");
  await page.getByRole("link", { name: /查看当前视图的支出记录/ }).click();

  await expect(page).toHaveURL(/\/records\?/);
  await expect(page.getByRole("link", { name: /-45\.67.*买菜.*老婆/ })).toBeVisible();
  await expect(page.getByText(note)).toHaveCount(0);

  const recordsUrl = new URL(page.url());
  expect(recordsUrl.pathname).toBe("/records");
  expect(recordsUrl.searchParams.get("perspective")).toBe("spouse");
  expect(recordsUrl.searchParams.get("range")).toBe("last-30-days");
  expect(recordsUrl.searchParams.get("type")).toBe("expense");
});
