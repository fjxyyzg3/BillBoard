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

test("mobile range sheets keep focus inside the native modal and restore the page on dismissal", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);
  const trigger = page.getByTestId("report-range-trigger");
  await trigger.evaluate((element) => {
    window.scrollTo(0, Math.max(0, element.getBoundingClientRect().top + window.scrollY - 24));
  });
  const beforeScrollY = await page.evaluate(() => window.scrollY);
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "时间范围", exact: true });
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(sheet.getByRole("button", { name: "关闭", exact: true })).toBeFocused();

  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press("Tab");
    expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }

  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }

  const lockedScrollY = await page.evaluate(() => window.scrollY);
  await page.mouse.move(12, 20);
  await page.mouse.wheel(0, 640);
  expect(await page.evaluate(() => window.scrollY)).toBe(lockedScrollY);
  expect(await sheet.evaluate((element) => {
    return element.getAnimations({ subtree: true }).some((animation) => animation.playState === "running");
  })).toBe(false);

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(beforeScrollY, 0);

  await trigger.click();
  await expect(sheet).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("filter sheets discard unapplied fields and keep their footer usable in a short mobile viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await logIn(page);
  await page.goto("/records?mode=all");

  const search = page.getByLabel("搜索记录", { exact: true });
  expect(await search.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  const searchDraft = `E2E sheet form ${Date.now()}`;
  await search.fill(searchDraft);
  const trigger = page.getByRole("button", { name: "筛选", exact: true });
  const sheet = page.getByRole("dialog", { name: "筛选", exact: true });
  await trigger.click();
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("金额筛选", { exact: true }).selectOption("exact");
  await sheet.getByLabel("精确金额（元）", { exact: true }).fill("88.50");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/records\?mode=all$/);
  await expect(search).toHaveValue(searchDraft);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("金额筛选", { exact: true })).toHaveValue("any");
  await sheet.getByLabel("金额筛选", { exact: true }).selectOption("exact");
  const amount = sheet.getByLabel("精确金额（元）", { exact: true });
  expect(await amount.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await amount.fill("88.50");
  await sheet.getByLabel("排序", { exact: true }).selectOption("amount-asc");
  await page.setViewportSize({ width: 320, height: 360 });
  await amount.focus();

  const apply = sheet.getByRole("button", { name: "应用筛选", exact: true });
  await expect(apply).toBeVisible();
  // Viewport resize events and the opening animation settle after setViewportSize.
  await expect.poll(async () => {
    const bounds = await apply.boundingBox();
    return bounds ? bounds.y + bounds.height : Infinity;
  }).toBeLessThanOrEqual(360);
  const applyBox = await apply.boundingBox();
  expect(applyBox).not.toBeNull();
  expect(applyBox!.y).toBeGreaterThanOrEqual(0);
  expect(applyBox!.y + applyBox!.height).toBeLessThanOrEqual(360);
  expect(await sheet.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile-filter-short-viewport.png") });
  await apply.click();

  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("amount")));
  await expect(sheet).toBeHidden();
  const params = new URL(page.url()).searchParams;
  expect(params.get("sort")).toBe("amount-asc");
  expect(params.get("search")).toBeTruthy();
  expect(page.url()).not.toContain(searchDraft);
  expect(page.url()).not.toContain("88.50");
  expect(params.has("amountExact")).toBe(false);
});

test("an editor sheet stays modal when the user cancels discarding a changed amount", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);
  const note = `E2E sheet editor ${Date.now()}`;
  await page.goto("/add?mode=all");
  await page.getByLabel("金额", { exact: true }).fill("8.25");
  await page.getByRole("radio", { name: "购物", exact: true }).check();
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注", { exact: true }).fill(note);
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
  await page.goto("/records?mode=all");
  await page.getByLabel("搜索记录", { exact: true }).fill(note);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("search")));
  const recordsUrl = page.url();
  await page.locator('a[href*="record="]').filter({ hasText: note }).click();

  const sheet = page.getByRole("dialog", { name: "编辑记录", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("金额", { exact: true }).fill("9.25");
  page.once("dialog", (confirmation) => confirmation.dismiss());
  await page.keyboard.press("Escape");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("金额", { exact: true })).toHaveValue("9.25");
  expect(await sheet.evaluate((element) => element.matches(":modal"))).toBe(true);

  page.once("dialog", (confirmation) => confirmation.accept());
  await sheet.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(recordsUrl);
});
