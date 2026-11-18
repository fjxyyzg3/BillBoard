import { expect, test, type Locator, type Page } from "./fixtures";

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码", { exact: true }).fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function expectSelectionOn(control: Locator, selected: Locator) {
  await expect.poll(async () => {
    const bounds = await selected.boundingBox();
    if (!bounds) return false;
    return control.evaluate((element, target) => {
      const style = getComputedStyle(element, "::before");
      if (style.content === "none") return false;
      const box = element.getBoundingClientRect();
      const border = getComputedStyle(element);
      const transform = new DOMMatrixReadOnly(style.transform);
      return Math.abs(box.x + parseFloat(border.borderLeftWidth) + parseFloat(style.left) + transform.m41 - target.x) < 1
        && Math.abs(box.y + parseFloat(border.borderTopWidth) + parseFloat(style.top) + transform.m42 - target.y) < 1
        && Math.abs(parseFloat(style.width) - target.width) < 1
        && Math.abs(parseFloat(style.height) - target.height) < 1;
    }, bounds);
  }).toBe(true);
}

test("home selections slide continuously and remain aligned after rapid changes and category navigation", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await logIn(page);
  const trend = page.getByRole("group", { name: "趋势视图", exact: true });
  await expectSelectionOn(trend, trend.getByRole("button", { name: "收支趋势", exact: true }));
  await trend.evaluate((element) => {
    element.addEventListener("transitionrun", (event) => {
      if (event.target === element && (event as TransitionEvent).pseudoElement === "::before"
        && (event as TransitionEvent).propertyName === "transform") element.setAttribute("data-sliding", "true");
    });
  });
  await trend.getByRole("button", { name: "累计结余", exact: true }).click();
  await expect(trend).toHaveAttribute("data-sliding", "true");
  await trend.getByRole("button", { name: "结余趋势", exact: true }).click();
  await trend.getByRole("button", { name: "收支趋势", exact: true }).click();
  await expectSelectionOn(trend, trend.getByRole("button", { name: "收支趋势", exact: true }));

  const income = page.locator(".bb-category-type-switch").getByRole("link", { name: "收入", exact: true });
  await income.locator("..").evaluate((element) => {
    element.addEventListener("transitionrun", (event) => {
      if (event.target === element && (event as TransitionEvent).pseudoElement === "::before"
        && (event as TransitionEvent).propertyName === "transform") element.setAttribute("data-sliding", "true");
    });
  });
  await income.click();
  await expect(income).toHaveAttribute("aria-current", "page");
  await expect(income.locator("..")).toHaveAttribute("data-sliding", "true");
  await expectSelectionOn(income.locator(".."), income);
  await page.goBack();
  const expense = page.locator(".bb-category-type-switch").getByRole("link", { name: "支出", exact: true });
  await expect(expense).toHaveAttribute("aria-current", "page");
  await expectSelectionOn(expense.locator(".."), expense);
  await page.screenshot({ path: testInfo.outputPath("home-switches-mobile.png"), fullPage: true });
});

test("entry switches preserve the draft and interpolate into the existing income green", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await logIn(page);
  await page.goto("/add");
  const modes = page.getByRole("group", { name: "输入方式", exact: true });
  const natural = modes.getByRole("button", { name: "自然语言", exact: true });
  await expect(natural).toBeEnabled();
  await page.getByLabel("金额", { exact: true }).fill("12.34");
  const income = page.getByRole("radio", { name: "收入", exact: true });
  const types = income.locator("../..");
  await expectSelectionOn(types, page.getByRole("radio", { name: "支出", exact: true }).locator(".."));
  const startColor = await types.evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
  await types.evaluate((element) => {
    element.addEventListener("transitionrun", (event) => {
      if (event.target !== element || (event as TransitionEvent).pseudoElement !== "::before"
        || (event as TransitionEvent).propertyName !== "background-color") return;
      const color = (event as TransitionEvent & { animation?: Animation }).animation
        ?? element.getAnimations({ subtree: true }).find((animation) => (animation as CSSTransition).transitionProperty === "background-color");
      if (!color) return;
      color.pause();
      color.currentTime = Number(color.effect!.getTiming().duration) / 4;
      element.setAttribute("data-color-transition", "paused");
    });
  });
  await income.locator("..").click();
  await expect(income).toBeChecked();
  await expect(types).toHaveAttribute("data-color-transition", "paused");
  const middleColor = await types.evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
  expect(middleColor).not.toBe(startColor);
  expect(middleColor).not.toBe("rgb(230, 243, 236)");
  await types.evaluate((element) => element.getAnimations({ subtree: true }).forEach((animation) => animation.finish()));
  await expect.poll(() => types.evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).toBe("rgb(230, 243, 236)");
  await expect(income.locator("..")).toHaveCSS("color", "rgb(31, 92, 66)");
  await expectSelectionOn(types, income.locator(".."));

  await natural.click();
  await expectSelectionOn(modes, natural);
  await modes.getByRole("button", { name: "手工填写", exact: true }).click();
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("12.34");
  await expect(income).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("entry-income-green-mobile.png"), fullPage: true });
});

test("record and multi-row date selections fit narrow screens and respect reduced motion and keyboard input", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await logIn(page);
  await page.goto("/records");
  const types = page.getByRole("group", { name: "类型", exact: true });
  for (const label of ["收入", "支出", "全部类型"]) {
    const button = types.getByRole("button", { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expectSelectionOn(types, button);
    expect(await types.evaluate((element) => getComputedStyle(element, "::before").transitionDuration)).toBe("0s");
  }
  await page.getByTestId("report-range-trigger").click();
  const range = page.getByRole("dialog").locator(".bb-segmented");
  const custom = range.getByRole("button", { name: "自定义", exact: true });
  await custom.click();
  await expect(custom).toHaveAttribute("aria-pressed", "true");
  await expectSelectionOn(range, custom);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.keyboard.press("Escape");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await types.getByRole("button", { name: "收入", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(types.getByRole("button", { name: "收入", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectSelectionOn(types, types.getByRole("button", { name: "收入", exact: true }));
  expect(await types.evaluate((element) => getComputedStyle(element, "::before").transitionDuration)).toBe("0s");
});
