import { expect, test, type Locator, type Page } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码", { exact: true }).fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("summary-grid")).toBeVisible();
}

async function expectSelectionOn(navigation: Locator, label: string) {
  const selection = navigation.locator('span[aria-hidden="true"]');
  await expect(selection).toHaveCount(1);
  await expect.poll(async () => {
    const pill = await selection.boundingBox();
    const link = await navigation.getByRole("link", { name: label, exact: true }).boundingBox();
    if (!pill || !link) return false;
    return Math.abs(pill.x - link.x) < 1 && Math.abs(pill.width - link.width) < 1;
  }).toBe(true);
  const radius = await selection.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius));
  expect(radius).toBeGreaterThan((await selection.boundingBox())!.height / 2);
}

test("bottom navigation uses its own feedback without a native tap rectangle", async ({ page }) => {
  await logIn(page);
  const links = page.locator(".bb-floating-nav").getByRole("link");
  await expect(links).toHaveCount(3);
  expect(await links.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).getPropertyValue("-webkit-tap-highlight-color"))))
    .toEqual(Array(3).fill("rgba(0, 0, 0, 0)"));
});

test("category analysis switches without a native tap rectangle and preserves the selected range", async ({ page }) => {
  await logIn(page);
  await page.goto("/home?mode=all");
  const categories = page.locator("section.ios-panel").filter({ has: page.getByRole("heading", { name: "分类分析", exact: true }) });
  const expense = categories.getByRole("link", { name: "支出", exact: true });
  const income = categories.getByRole("link", { name: "收入", exact: true });
  for (const link of [expense, income]) {
    await expect(link).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");
  }
  await income.tap();
  await expect(income).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL((url) => url.searchParams.get("categoryType") === "income"
    && url.searchParams.get("mode") === "all");
  await expense.tap();
  await expect(expense).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL((url) => !url.searchParams.has("categoryType") && url.searchParams.get("mode") === "all");
});

test("one pill follows pending navigation and remains selected on Add", async ({ page }) => {
  await logIn(page);
  const navigation = page.locator(".bb-floating-nav");
  await expectSelectionOn(navigation, "首页");

  let releaseNavigation!: () => void;
  const gate = new Promise<void>((resolve) => { releaseNavigation = resolve; });
  await page.route((url) => url.pathname === "/records", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await navigation.getByRole("link", { name: "记录", exact: true }).tap();
    await expect(navigation.getByRole("link", { name: "记录", exact: true })).toHaveAttribute("aria-busy", "true");
    await expect(navigation.getByRole("link", { name: "首页", exact: true })).toHaveAttribute("aria-current", "page");
    await expectSelectionOn(navigation, "记录");
  } finally {
    releaseNavigation();
  }
  await expect(page).toHaveURL(/\/records$/);
  for (const [label, route] of [["记一笔", "/add"], ["首页", "/home"], ["记一笔", "/add"], ["记录", "/records"]]) {
    await navigation.getByRole("link", { name: label, exact: true }).tap();
    await expect(page).toHaveURL((url) => url.pathname === route);
    await expectSelectionOn(navigation, label);
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/add$/);
  await expectSelectionOn(navigation, "记一笔");
  await page.goForward();
  await expect(page).toHaveURL(/\/records$/);
  await expectSelectionOn(navigation, "记录");
});

test("reduced motion keeps the pill static and keyboard focus visible at mobile widths", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await logIn(page);
  const navigation = page.locator(".bb-floating-nav");
  const add = navigation.getByRole("link", { name: "记一笔", exact: true });
  await page.keyboard.press("Tab");
  await add.focus();
  await expect(add).toBeFocused();
  await expect(add).toHaveCSS("outline-style", "solid");
  await expect(add).toHaveCSS("outline-width", "2px");
  await add.press("Enter");
  await expect(page).toHaveURL(/\/add$/);
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expectSelectionOn(navigation, "记一笔");
    await expect(navigation.locator('span[aria-hidden="true"]')).toHaveCSS("transition-duration", "0s");
  }
});
