import { expect, test, type Page } from "./fixtures";

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码").fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("summary-grid")).toBeVisible();
}

test("retired diagnostic endpoints return not found", async ({ request }) => {
  const reportPath = "/api/internal/diagnostic-reports/11111111-1111-4111-8111-111111111111";

  expect((await request.get("/api/internal/diagnostic-reports")).status()).toBe(404);
  expect((await request.get(reportPath)).status()).toBe(404);
  expect((await request.post(`${reportPath}/resolve`)).status()).toBe(404);
});

test("mobile navigation stays compact and utilities remain keyboard accessible", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);

  const navigation = page.locator("nav:visible");
  const bounds = await navigation.boundingBox();
  expect(bounds!.height).toBeLessThanOrEqual(80);
  await expect(navigation.getByRole("link")).toHaveCount(3);
  await expect(page.locator('[data-testid="diagnostic-feedback-trigger"]:visible')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("home-mobile.png"), fullPage: true });

  const menu = page.getByRole("button", { name: "更多选项" });
  await menu.click();
  await expect(page.getByRole("button", { name: "切换语言" })).toBeVisible();
  await expect(page.locator('[data-testid="diagnostic-feedback-trigger"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "账号与家庭", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "更多选项" })).toContainText(/v\d+\.\d+\.\d+/);
  await page.screenshot({ path: testInfo.outputPath("mobile-menu.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(page.getByRole("group", { name: "更多选项" })).toHaveCount(0);
  await expect(page.locator('[data-testid="diagnostic-feedback-trigger"]:visible')).toHaveCount(0);
});

test("trend values can be inspected before opening their records", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);
  await page.goto("/add");
  await page.getByLabel("金额").fill("12.34");
  await page.screenshot({ path: testInfo.outputPath("add-mobile.png") });
  await page.getByRole("button", { name: "保存记录" }).click();
  await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
  await page.goto("/home?mode=month");

  const dateLabel = new Intl.DateTimeFormat("zh-CN", { day: "numeric", month: "short", timeZone: "Asia/Shanghai" }).format(new Date());
  const picker = page.getByTestId("trend-date-picker");
  await expect(picker).toBeEnabled();
  await picker.focus();
  await picker.press("Home");
  const day = Number(new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "Asia/Shanghai" }).format(new Date()));
  for (let index = 1; index < day; index += 1) await picker.press("ArrowRight");
  await expect(picker).toHaveAttribute("aria-valuetext", new RegExp(dateLabel));
  await expect(page).toHaveURL(/\/home\?mode=month$/);
  const detail = page.getByTestId("trend-detail");
  await expect(detail).toBeVisible();
  const expenseText = await detail.locator("p").filter({ hasText: /^支出/ }).innerText();
  expect(Number(expenseText.split("¥")[1].replaceAll(",", ""))).toBeGreaterThanOrEqual(12.34);
  await page.screenshot({ path: testInfo.outputPath("trend-mobile.png"), fullPage: true });
  await detail.getByRole("link", { name: "查看记录" }).click();
  await expect(page).toHaveURL(/\/records\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get("mode")).toBe("month");
  expect(url.searchParams.has("from")).toBe(true);
  expect(url.searchParams.has("to")).toBe(true);
  const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai",
  }).format(new Date());
  expect(url.searchParams.get("from")).toBe(new Date(`${shanghaiDate}T00:00:00+08:00`).toISOString());
  expect(url.searchParams.get("to")).toBe(new Date(`${shanghaiDate}T23:59:59.999+08:00`).toISOString());
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole("heading", { name: "记录", exact: true })).toBeVisible();
  await expect(page.getByLabel("搜索记录", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("records-mobile.png") });
});
