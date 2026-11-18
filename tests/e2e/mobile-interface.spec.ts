import { expect, test, type Page, type Route } from "./fixtures";

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码").fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("entry and search accept drafts only after client initialization", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page);

  for (const path of ["/add", "/records"]) {
    let releaseClient!: () => void;
    const clientGate = new Promise<void>((resolve) => { releaseClient = resolve; });
    const clientScripts = /\/_next\/static\/.*\.js(?:\?.*)?$/;
    const holdClient = async (route: Route) => {
      await clientGate;
      await route.continue();
    };
    await page.route(clientScripts, holdClient);
    try {
      await page.goto(path, { waitUntil: "commit" });
      const input = page.getByLabel(path === "/add" ? "金额" : "搜索记录", { exact: true });
      const action = page.getByRole("button", {
        name: path === "/add" ? "保存记录" : "搜索",
        exact: true,
      });
      await expect(input).toBeVisible();
      await expect(input).toBeDisabled();
      await expect(action).toBeDisabled();
      releaseClient();
      await expect(input).toBeEditable();
      const draft = path === "/add" ? "24.50" : "E2E initialized search";
      await input.fill(draft);
      if (path === "/add") {
        await page.getByRole("radio", { name: "购物", exact: true }).check();
      } else {
        await page.getByRole("button", { name: "筛选", exact: true }).click();
        await page.getByRole("dialog", { name: "筛选", exact: true })
          .getByRole("button", { name: "关闭", exact: true }).click();
      }
      await expect(input).toHaveValue(draft);
    } finally {
      releaseClient();
      await page.unroute(clientScripts, holdClient);
    }
  }
});

test("login gives pending feedback and sends one request while waiting", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let requests = 0;
  await page.route("**/api/auth/callback/credentials**", async (route) => {
    requests += 1;
    await requestGate;
    await route.continue();
  });
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码").fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "正在登录…", exact: true })).toBeDisabled();
  await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
  await page.getByLabel("密码").press("Enter");
  await expect.poll(() => requests).toBe(1);
  releaseRequest();
  await expect(page).toHaveURL(/\/home$/);
});

test("mobile summary and entry remain readable at narrow widths in both languages", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await logIn(page);
  await page.goto("/add");
  await page.getByLabel("金额", { exact: true }).fill("21474836.47");
  await page.getByRole("radio", { name: process.env.SEED_USER_B_NAME!, exact: true }).check();
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
  await page.goto("/home?mode=all&perspective=spouse");

  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByTestId("summary-grid")).toBeVisible();
    await expect(page.getByRole("button", { name: /^(家庭|我|对方)$/ })).toHaveCount(0);
    const overflows = await page.getByTestId("summary-card").evaluateAll((cards) => cards.filter((card) => {
      const value = card.querySelector(".ios-amount");
      return card.scrollWidth > card.clientWidth || Boolean(value && value.scrollWidth > value.clientWidth);
    }).length);
    expect(overflows).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`), fullPage: true });
  }

  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("button", { name: "切换语言", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Household|Me|Spouse)$/ })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole("link", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Amount", { exact: true })).toBeEditable();
  await page.getByRole("button", { name: "More", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("add-english-320.png"), fullPage: true });
});
