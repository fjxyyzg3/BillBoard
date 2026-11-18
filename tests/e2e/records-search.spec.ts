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

test("users can submit, clear, and restore a locale-aware records search", async ({ page }) => {
  const note = `E2E search ${Date.now()}`;

  await logIn(page);
  await page.goto("/add?mode=all");
  await page.getByLabel("金额").fill("16");
  await page.getByRole("radio", { name: "购物", exact: true }).check();
  await page.getByRole("radio", { name: requireEnv("SEED_USER_B_NAME"), exact: true }).check();
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注").fill(note);
  await page.getByRole("button", { name: "保存记录" }).click();
  await expect(page.getByText("记录已保存")).toBeVisible();

  await page.goto("/records?mode=all");
  const searchInput = page.getByLabel("搜索记录");
  await searchInput.fill(`  ${note}  `);
  await expect(page).toHaveURL(/mode=all/);
  await expect(page).not.toHaveURL(/search=/);
  await page.getByRole("button", { name: "搜索", exact: true }).click();

  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("search")));
  const noteSearchToken = new URL(page.url()).searchParams.get("search");
  if (!noteSearchToken) {
    throw new Error("Expected an opaque note search token");
  }
  expect(page.url()).not.toContain(note);
  const matchedRecord = page.getByRole("link", { name: /购物.*老婆.*-16\.00/ });
  await expect(matchedRecord).toBeVisible();
  await expect(matchedRecord.getByText(note, { exact: true })).toBeVisible();

  const noMatch = `${note}-no-match`;
  await searchInput.fill(noMatch);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("search")));
  expect(page.url()).not.toContain(noMatch);
  await expect(page.getByText("当前筛选下没有记录。试试扩大时间范围或清除筛选。")).toBeVisible();
  await expect(page.getByLabel("搜索记录")).toHaveValue(noMatch);

  await page.getByRole("button", { name: "清空搜索" }).click();
  await expect(page).toHaveURL((url) => {
    return url.pathname === "/records" && url.searchParams.get("mode") === "all" && !url.searchParams.has("search");
  });
  await expect(page.getByLabel("搜索记录")).toHaveValue("");

  await page.goto(`/records?mode=all&search=${encodeURIComponent(noteSearchToken)}`);
  await expect(page.getByLabel("搜索记录")).toHaveValue(note);
  await page.goto("/records?mode=all");
  await page.goBack();
  await expect(page.getByLabel("搜索记录")).toHaveValue(note);
  // Finish the history navigation before starting a document reload.
  await page.goForward({ waitUntil: "networkidle" });
  await expect(page.getByLabel("搜索记录")).toHaveValue("");

  await page.reload();
  await expect(page.getByRole("button", { name: "切换语言" })).toBeEnabled();
  await page.getByRole("button", { name: "切换语言" }).click();
  await expect(page.getByLabel("Search records")).toBeVisible();
  await page.getByLabel("Search records").fill("Shopping");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("search")));
  expect(page.url()).not.toContain("Shopping");
  await expect(page.getByRole("link", { name: /Shopping.*老婆.*-16\.00/ })).toBeVisible();
});
