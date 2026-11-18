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
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function createExpense(
  page: Page,
  amount: string,
  occurredAt: string,
  note: string,
  memberName?: string,
) {
  await page.goto("/add?mode=all");
  await page.getByLabel("金额", { exact: true }).fill(amount);
  await page.getByRole("radio", { name: "购物", exact: true }).check();
  if (memberName) {
    await page.getByRole("radio", { name: memberName, exact: true }).check();
  }
  await page.locator('input[name="occurredAt"]').fill(occurredAt);
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注", { exact: true }).fill(note);
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
}

test("mobile records group by Shanghai date and keep amount sorting flat", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 740 });
  await logIn(page);

  const note = `E2E mobile date ${Date.now()}`;
  await createExpense(page, "20", "2026-05-01T23:59", `${note} evening`);
  await createExpense(page, "30", "2026-05-02T00:01", `${note} midnight`);
  await createExpense(page, "21474836.47", "2026-05-02T20:00", `${note} later`);
  await page.goto("/records?mode=month&month=2026-05&year=2026&perspective=me");
  await page.getByLabel("搜索记录", { exact: true }).fill(note);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("search")));
  expect(new URL(page.url()).searchParams.has("perspective")).toBe(false);
  await expect(page.getByRole("button", { name: /^(家庭|我|对方)$/ })).toHaveCount(0);

  const recordLinks = page.locator('a[href*="record="]');
  const dateHeadings = page.getByTestId("records-date-heading");
  await expect(recordLinks).toHaveCount(3);
  await expect(dateHeadings).toHaveCount(2);
  await expect(dateHeadings.nth(0).locator("time")).toHaveAttribute("datetime", "2026-05-02");
  await expect(dateHeadings.nth(1).locator("time")).toHaveAttribute("datetime", "2026-05-01");
  await expect(recordLinks.nth(0)).toContainText(`${note} later`);
  await expect(recordLinks.nth(1)).toContainText(`${note} midnight`);
  await expect(recordLinks.nth(2)).toContainText(`${note} evening`);
  await expect(recordLinks.nth(0).locator(".ios-amount")).toHaveText("-21474836.47");
  expect(await recordLinks.nth(0).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const originalParams = new URL(page.url()).searchParams;
  let searchPostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/records/search") {
      searchPostCount += 1;
    }
  });
  const typeControls = page.getByRole("group", { name: "类型", exact: true });
  await typeControls.getByRole("button", { name: "收入", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("type") === "income");
  await expect(recordLinks).toHaveCount(0);
  await typeControls.getByRole("button", { name: "支出", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("type") === "expense");
  await expect(recordLinks).toHaveCount(3);
  for (const field of ["mode", "month", "year", "search"]) {
    expect(new URL(page.url()).searchParams.get(field)).toBe(originalParams.get(field));
  }
  expect(new URL(page.url()).searchParams.has("perspective")).toBe(false);
  expect(searchPostCount).toBe(0);

  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByLabel("分类", { exact: true }).selectOption({ label: "购物" });
  await page.getByLabel("排序", { exact: true }).selectOption("amount-asc");
  await page.getByRole("button", { name: "应用筛选", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("sort") === "amount-asc");
  const appliedParams = new URL(page.url()).searchParams;
  const appliedSearchPostCount = searchPostCount;
  await expect(page.getByLabel("搜索记录", { exact: true })).toHaveValue(note);
  await expect(dateHeadings).toHaveCount(0);
  await expect(recordLinks).toHaveCount(3);
  await expect(recordLinks.nth(0)).toContainText("-20.00");
  await expect(recordLinks.nth(1)).toContainText("-30.00");
  await expect(recordLinks.nth(2)).toContainText("-21474836.47");
  await typeControls.getByRole("button", { name: "收入", exact: true }).click();
  await expect(page).toHaveURL((url) =>
    url.searchParams.get("type") === "income" && !url.searchParams.has("category"),
  );
  for (const field of ["mode", "month", "year", "search", "sort"]) {
    expect(new URL(page.url()).searchParams.get(field)).toBe(appliedParams.get(field));
  }
  expect(new URL(page.url()).searchParams.has("perspective")).toBe(false);
  expect(searchPostCount).toBe(appliedSearchPostCount);
  await typeControls.getByRole("button", { name: "支出", exact: true }).click();
  await expect(recordLinks).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("records-small-mobile.png"), fullPage: true });

  const filteredUrl = page.url();
  const targetRecord = recordLinks.nth(2);
  // A row can be inside the viewport while fixed navigation covers its click point.
  await targetRecord.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await expect.poll(() => targetRecord.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return hit !== null && element.contains(hit);
  })).toBe(true);
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await targetRecord.click();
  const editor = page.getByRole("dialog", { name: "编辑记录", exact: true });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page).toHaveURL(filteredUrl);
  expect(Math.abs(await page.evaluate(() => window.scrollY) - beforeScroll)).toBeLessThan(3);
});

test("record drilldown displays the actual Shanghai range and returns to its original filters", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);

  const params = new URLSearchParams({
    mode: "all",
    perspective: "me",
    type: "expense",
    page: "2",
    from: "2026-05-01T16:00:00.000Z",
    to: "2026-05-02T15:59:59.999Z",
  });
  await page.goto(`/records?${params.toString()}`);
  const actualRange = page.getByTestId("records-drilldown-range");
  await expect(actualRange).toBeVisible();
  await expect(actualRange).toContainText("当前查看范围");
  await expect(actualRange).toContainText("2026年5月2日");
  await expect(actualRange).not.toContainText("2026年5月1日");
  await actualRange.getByRole("link", { name: "返回原时间范围", exact: true }).click();
  await expect(page).toHaveURL((url) =>
    url.pathname === "/records" &&
    url.searchParams.get("mode") === "all" &&
    !url.searchParams.has("perspective") &&
    url.searchParams.get("type") === "expense" &&
    !url.searchParams.has("from") &&
    !url.searchParams.has("to") &&
    !url.searchParams.has("page"),
  );
  await expect(actualRange).toHaveCount(0);
});

test("history navigation between records binds every editor field to the selected record", async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);

  const note = `E2E editor history ${Date.now()}`;
  const noteA = `${note} A`;
  const noteB = `${note} B`;
  const memberA = requireEnv("SEED_USER_A_NAME");
  const memberB = requireEnv("SEED_USER_B_NAME");
  const dateA = "2026-05-03T09:10";
  const dateB = "2026-05-04T21:15";
  await createExpense(page, "12.34", dateA, noteA, memberA);
  await createExpense(page, "98.76", dateB, noteB, memberB);
  await page.goto("/records?mode=all");
  await page.getByLabel("搜索记录", { exact: true }).fill(note);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("search")));
  const filteredUrl = page.url();
  const recordA = page.getByRole("link").filter({ hasText: noteA });
  const recordB = page.getByRole("link").filter({ hasText: noteB });
  const editor = page.getByRole("dialog", { name: "编辑记录", exact: true });

  await recordA.click();
  await expect(editor).toBeVisible();
  const recordAUrl = page.url();
  const recordAId = new URL(recordAUrl).searchParams.get("record");
  expect(recordAId).toBeTruthy();
  await expect(editor.getByLabel("金额", { exact: true })).toHaveValue("12.34");
  await expect(editor.getByRole("radio", { name: memberA, exact: true })).toBeChecked();
  await expect(editor.getByLabel("时间", { exact: true })).toHaveValue(dateA);
  await expect(editor.getByLabel("备注", { exact: true })).toHaveValue(noteA);
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page).toHaveURL(filteredUrl);
  await expect(editor).toBeHidden();

  await recordB.click();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("金额", { exact: true })).toHaveValue("98.76");
  await expect(editor.getByRole("radio", { name: memberB, exact: true })).toBeChecked();
  await expect(editor.getByLabel("时间", { exact: true })).toHaveValue(dateB);
  await expect(editor.getByLabel("备注", { exact: true })).toHaveValue(noteB);

  // Saving A adds the list entry between the two editor history entries.
  await page.evaluate(() => window.history.go(-2));
  await expect(page).toHaveURL(recordAUrl);
  await expect(editor).toBeVisible();
  await expect(editor.locator('input[name="transactionId"]').first()).toHaveValue(recordAId!);
  await expect(editor.getByLabel("金额", { exact: true })).toHaveValue("12.34");
  await expect(editor.getByRole("radio", { name: memberA, exact: true })).toBeChecked();
  await expect(editor.getByLabel("时间", { exact: true })).toHaveValue(dateA);
  await expect(editor.getByLabel("备注", { exact: true })).toHaveValue(noteA);

  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page).toHaveURL(filteredUrl);
  await page.reload();
  await expect(recordA).toContainText("-12.34");
  await expect(recordA).toContainText(memberA);
  await expect(recordB).toContainText("-98.76");
  await expect(recordB).toContainText(memberB);
  await recordA.click();
  await expect(editor.getByLabel("时间", { exact: true })).toHaveValue(dateA);
  await expect(editor.getByLabel("备注", { exact: true })).toHaveValue(noteA);
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page).toHaveURL(filteredUrl);
  await recordB.click();
  await expect(editor.getByLabel("时间", { exact: true })).toHaveValue(dateB);
  await expect(editor.getByLabel("备注", { exact: true })).toHaveValue(noteB);
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page).toHaveURL(filteredUrl);
});
