import { expect, test, webkit, type Page } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码", { exact: true }).fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function useCompatibilityPicker(page: Page) {
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (property: string, value?: string) => property === "appearance" && value === "base-select"
      ? false : value === undefined ? supports(property) : supports(property, value);
  });
}

test("mobile ledger picker uses the application menu and dismisses without changing scope", async ({ page }, testInfo) => {
  await logIn(page);
  const select = page.getByRole("combobox", { name: "查看范围", exact: true });
  await expect(select).toHaveCSS("appearance", "base-select");
  await select.tap();
  await expect(select).toHaveJSProperty("value", "all");
  expect(await select.evaluate((element) => element.matches(":open"))).toBe(true);
  const picker = await select.evaluate((element) => {
    const style = getComputedStyle(element, "::picker(select)");
    return { radius: style.borderRadius, background: style.backgroundColor, shadow: style.boxShadow };
  });
  expect(picker.radius).toBe("16px");
  expect(picker.background).toBe("rgb(255, 255, 255)");
  expect(picker.shadow).not.toBe("none");
  await page.screenshot({ path: testInfo.outputPath("ledger-picker.png") });
  await page.keyboard.press("Escape");
  await expect(select).toBeFocused();
  await expect(select).toHaveValue("all");
});

for (const fallback of [false, true]) {
  test(`picker works inside a sheet with keyboard selection (${fallback ? "compatibility" : "native"})`, async ({ page }, testInfo) => {
    if (fallback) {
      await useCompatibilityPicker(page);
    }
    await logIn(page);
    await page.goto("/records");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    const sheet = page.getByRole("dialog").filter({ has: page.getByLabel("金额筛选", { exact: true }) });
    const select = sheet.getByRole("combobox", { name: "金额筛选", exact: true });
    await select.focus();
    await select.press("Space");
    if (fallback) {
      const list = page.getByRole("listbox");
      await expect(list).toBeVisible();
      await expect(select).toBeFocused();
      await select.press("End");
      await expect(select).toHaveAttribute("aria-activedescendant", /option-2$/);
      await select.press("Escape");
      await expect(list).not.toBeVisible();
      await expect(sheet).toBeVisible();
      await select.press("Space");
      await list.getByRole("option", { name: "精确金额", exact: true }).tap();
    } else {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
    await expect(sheet.getByLabel("精确金额（元）", { exact: true })).toBeVisible();
    await expect(select).toBeFocused();
    await select.press("Space");
    await page.screenshot({ path: testInfo.outputPath(`filter-picker-${fallback ? "compatibility" : "native"}.png`) });
    await select.press("Escape");
    await expect(sheet).toBeVisible();
    if (fallback) {
      const mode = await select.evaluate((element) => new FormData((element.closest("form")!)).get("amountMode"));
      expect(mode).toBe("exact");
    }
    await sheet.getByLabel("精确金额（元）", { exact: true }).fill("12.34");
    await sheet.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.has("amount") && !url.searchParams.has("amountExact"));
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(sheet.getByLabel("精确金额（元）", { exact: true })).toHaveValue("12.34");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}

for (const activation of ["keyboard", "pointer"] as const) {
  test(`compatibility picker reopens before close toggle dispatch (${activation})`, async ({ page }) => {
    await useCompatibilityPicker(page);
    await logIn(page);
    await page.goto("/records");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    const sheet = page.getByRole("dialog").filter({ has: page.getByLabel("金额筛选", { exact: true }) });
    const trigger = sheet.getByRole("combobox", { name: "金额筛选", exact: true });
    await trigger.press("Space");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await trigger.press("End");
    await expect(trigger).toHaveAttribute("aria-activedescendant", /option-2$/);
    const state = await trigger.evaluate((element, input) => {
      const picker = document.getElementById(element.getAttribute("aria-controls")!)!;
      const native = element.closest(".ios-select")!.querySelector("select")!;
      const originalValue = native.value;
      // Keep close and reopen in one task, ahead of the browser's queued toggle event.
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const closed = !picker.matches(":popover-open");
      if (input === "keyboard") element.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      else (element as HTMLButtonElement).click();
      return { closed, reopened: picker.matches(":popover-open"), unchanged: native.value === originalValue };
    }, activation);
    expect(state).toEqual({ closed: true, reopened: true, unchanged: true });
    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();
    await list.getByRole("option", { name: "精确金额", exact: true }).tap();
    await expect(sheet.getByLabel("精确金额（元）", { exact: true })).toBeVisible();
    await expect(trigger).toBeFocused();
  });
}

test("WebKit long menus scroll within the screen and dismiss on outside taps", async ({ baseURL }, testInfo) => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await useCompatibilityPicker(page);
    await logIn(page);
    await page.goto("/records");
    await page.getByRole("button", { name: "筛选", exact: true }).tap();
    const select = page.getByRole("combobox", { name: "分类", exact: true });
    await select.tap();
    const list = page.getByRole("listbox");
    await expect(list).toBeVisible();
    // Probe long labels without changing option values or persisted data.
    await list.getByRole("option").last().locator("span").evaluate((element) => {
      element.textContent = "家庭共享账本 / ".repeat(6) + "LongUnbrokenName".repeat(8);
    });
    await select.press("End");
    const activeId = await select.getAttribute("aria-activedescendant");
    const last = page.locator(`[id="${activeId}"]`);
    await expect(last).toBeInViewport();
    expect(await last.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const bounds = (await list.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(740);
    expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("webkit-category-picker.png") });
    await page.touchscreen.tap(314, Math.min(730, bounds.y + bounds.height + 16));
    await expect(list).toBeHidden();
    await expect(page.getByRole("dialog", { name: "筛选", exact: true })).toBeVisible();
  } finally {
    await browser.close();
  }
});
