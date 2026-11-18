import { expect, test } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

test("time filters persist while navigation drops legacy member filters", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_B_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_B_PASSWORD"));
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/home?perspective=spouse&mode=month&month=2026-05&year=2026");
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/mode=month/);
  await expect(page).toHaveURL(/month=2026-05/);
  await expect(page).toHaveURL(/year=2026/);
  await expect(page.getByRole("button", { name: /^(家庭|我|对方)$/ })).toHaveCount(0);

  const navigation = page.getByRole("navigation");
  await navigation.getByRole("link", { name: "记一笔", exact: true }).click();
  await expect(page).toHaveURL(/\/add\?/);
  await expect(page).not.toHaveURL(/perspective=/);
  await expect(page).toHaveURL(/mode=month/);
  await expect(page).toHaveURL(/month=2026-05/);
  await expect(page).toHaveURL(/year=2026/);

  await expect(navigation.getByRole("link", { name: "记录" })).toHaveAttribute(
    "href",
    "/records?mode=month&month=2026-05&year=2026",
  );
  await navigation.getByRole("link", { name: "记录" }).click();
  await expect(page).toHaveURL(/\/records\?/);
  await expect(page).not.toHaveURL(/perspective=/);
  await expect(page).toHaveURL(/mode=month/);
  await expect(page).toHaveURL(/month=2026-05/);
  await expect(page).toHaveURL(/year=2026/);
  await expect(page.getByRole("button", { name: /^(家庭|我|对方)$/ })).toHaveCount(0);

  await page.getByRole("button", { name: "切换语言" }).click();
  await expect(navigation.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Add", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Records", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Ledgers", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link")).toHaveCount(5);

  const recordsUrl = new URL(page.url());
  expect(recordsUrl.pathname).toBe("/records");
  expect(recordsUrl.searchParams.has("perspective")).toBe(false);
  expect(recordsUrl.searchParams.get("mode")).toBe("month");
  expect(recordsUrl.searchParams.get("month")).toBe("2026-05");
  expect(recordsUrl.searchParams.get("year")).toBe("2026");
  expect(recordsUrl.searchParams.has("locale")).toBe(false);
});
