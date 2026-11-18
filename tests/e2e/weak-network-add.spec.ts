import { expect, test, type Page, type Route } from "./fixtures";

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
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}

async function fillExpense(page: Page, amount: string, note: string) {
  await page.getByLabel("金额").fill(amount);
  await page.getByRole("radio", { name: "购物" }).check();
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注").fill(note);
}

test.describe.serial("weak-network add transaction", () => {
  test("shows navigation pending before delayed add data arrives", async ({
    page,
  }) => {
    await logIn(page);

    let releaseAddRequest: (() => void) | undefined;
    const addRequestGate = new Promise<void>((resolve) => {
      releaseAddRequest = resolve;
    });

    await page.route(/\/add(?:\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await addRequestGate;
      }

      await route.continue();
    });
    await page.reload();

    const addLink = page.getByRole("link", { name: "记一笔", exact: true });
    await addLink.evaluate((element) => (element as HTMLAnchorElement).click());

    await expect(addLink).toHaveAttribute("aria-busy", "true", { timeout: 100 });

    releaseAddRequest?.();
    await expect(page).toHaveURL(/\/add$/);
    await expect(page.getByLabel("金额")).toBeEditable();
  });

  test("restores an editable member-scoped draft after reload", async ({ page }) => {
    await logIn(page);
    await page.goto("/add");

    await fillExpense(page, "24.68", "Reload draft");
    await page.getByRole("radio", { name: requireEnv("SEED_USER_B_NAME"), exact: true }).check();
    await page.reload();

    await expect(page.getByLabel("金额")).toHaveValue("24.68");
    await expect(page.getByLabel("备注")).toHaveValue("Reload draft");
    await expect(page.getByRole("radio", { name: requireEnv("SEED_USER_B_NAME"), exact: true })).toBeChecked();
    await expect(page.getByLabel("金额")).toBeEditable();
  });

  test("shows the slow-network state and completes without reloading the add page", async ({
    page,
  }) => {
    await logIn(page);
    await page.goto("/add");
    await page.evaluate(() => {
      (window as typeof window & { weakNetworkMarker?: string }).weakNetworkMarker = "preserved";
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 7000,
      downloadThroughput: 10 * 1024 * 1024,
      uploadThroughput: 10 * 1024 * 1024,
    });

    await fillExpense(page, "67.89", "Slow save");
    await page.getByRole("button", { name: "保存记录" }).click();

    await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled({ timeout: 100 });
    await expect(page.getByLabel("金额")).toBeDisabled();
    await expect(page.getByRole("radio", { name: requireEnv("SEED_USER_A_NAME"), exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "收起备注", exact: true })).toBeDisabled();
    await expect(page.getByText("网络较慢，仍在保存…")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("记录已保存")).toBeVisible({ timeout: 15000 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { weakNetworkMarker?: string }).weakNetworkMarker,
        ),
      )
      .toBe("preserved");

    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    await page.getByRole("link", { name: "记录", exact: true }).click();
    await expect(page.getByRole("link").filter({ hasText: "Slow save" })).toHaveCount(1);
  });

  test("recovers an unknown result and retries the committed request exactly once", async ({
    page,
  }) => {
    await logIn(page);
    await page.goto("/add");
    let postCount = 0;

    await page.route(/\/add(?:\?.*)?$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      postCount += 1;

      if (postCount === 1) {
        const response = await route.fetch();
        await response.body();
        await route.abort("failed");
        return;
      }

      await route.continue();
    });

    await fillExpense(page, "91.27", "Unknown result");
    await page.getByRole("button", { name: "保存记录" }).click();
    await expect(page.getByText("保存结果尚未确认")).toBeVisible();

    const requestIdBeforeReload = await page.evaluate(() => {
      const key = Object.keys(window.sessionStorage).find((candidate) =>
        candidate.startsWith("billboard:transaction-draft:v2:"),
      );
      const raw = key ? window.sessionStorage.getItem(key) : null;
      return raw ? (JSON.parse(raw) as { clientRequestId?: string }).clientRequestId : undefined;
    });

    expect(requestIdBeforeReload).toEqual(expect.any(String));
    await page.reload();
    await expect(page.getByText("保存结果尚未确认")).toBeVisible();
    await expect(page.getByLabel("金额")).toHaveValue("91.27");
    await expect(page.getByLabel("金额")).toBeDisabled();
    await expect(page.getByLabel("备注", { exact: true })).toHaveValue("Unknown result");
    await expect(page.getByLabel("备注", { exact: true })).toBeDisabled();
    await page.waitForTimeout(300);
    expect(postCount).toBe(1);

    const requestIdAfterReload = await page.evaluate(() => {
      const key = Object.keys(window.sessionStorage).find((candidate) =>
        candidate.startsWith("billboard:transaction-draft:v2:"),
      );
      const raw = key ? window.sessionStorage.getItem(key) : null;
      return raw ? (JSON.parse(raw) as { clientRequestId?: string }).clientRequestId : undefined;
    });

    expect(requestIdAfterReload).toBe(requestIdBeforeReload);
    await page.getByRole("button", { name: "重新确认保存" }).click();
    await expect(page.getByText("记录已保存")).toBeVisible();
    expect(postCount).toBe(2);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.sessionStorage).some((candidate) =>
            candidate.startsWith("billboard:transaction-draft:v2:"),
          ),
        ),
      )
      .toBe(false);

    await page.getByRole("link", { name: "记录", exact: true }).click();
    await expect(page.getByRole("link").filter({ hasText: "Unknown result" })).toHaveCount(1);
  });

  test("meets add and save targets across three 400 Kbps and 800 ms RTT runs", async ({
    page,
  }) => {
    test.skip(
      process.env.WEAK_NETWORK_PRODUCTION_PERF !== "1",
      "Requires a production standalone server at the Playwright base URL",
    );
    test.setTimeout(60_000);
    const cdp = await page.context().newCDPSession(page);
    const throughputBytesPerSecond = (400 * 1024) / 8;
    const measurements: Array<{ addInteractiveMs: number; saveConfirmedMs: number }> = [];
    let blockAddPrefetch = true;
    const addRoutePattern = /\/add(?:\?.*)?$/;
    const addRouteHandler = async (route: Route) => {
      const headers = route.request().headers();
      const isPrefetch =
        headers["next-router-prefetch"] === "1" || headers.purpose === "prefetch";

      if (blockAddPrefetch && isPrefetch) {
        await route.abort();
        return;
      }

      await route.continue();
    };

    await cdp.send("Network.enable");
    await cdp.send("Network.clearBrowserCache");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 800,
      downloadThroughput: throughputBytesPerSecond,
      uploadThroughput: throughputBytesPerSecond,
    });
    await page.route(addRoutePattern, addRouteHandler);
    await logIn(page);
    await expect(page.getByTestId("summary-grid")).toBeVisible();
    // Finish the origin page before clearing HTTP cache. Add prefetch remains
    // blocked, so the first measured navigation still loads its route cold.
    await page.waitForLoadState("networkidle");

    for (const [index, amount] of ["32.11", "32.12", "32.13"].entries()) {
      if (index === 0) {
        blockAddPrefetch = false;
        await cdp.send("Network.clearBrowserCache");
      }

      const addStartedAt = Date.now();
      await page.getByRole("link", { name: "记一笔", exact: true }).click();
      await expect(page.getByLabel("金额")).toBeEditable({ timeout: 10_000 });
      const addInteractiveMs = Date.now() - addStartedAt;
      console.log(
        `Weak-network add ${index === 0 ? "cold" : "in-app"} run ${index + 1}: ${addInteractiveMs}ms`,
      );

      if (index === 0) {
        await page.unroute(addRoutePattern, addRouteHandler);
      }

      await fillExpense(page, amount, `400 Kbps run ${index + 1}`);
      const saveStartedAt = Date.now();
      await page.getByRole("button", { name: "保存记录" }).click();
      await expect(page.getByText("记录已保存")).toBeVisible({ timeout: 4000 });
      const saveConfirmedMs = Date.now() - saveStartedAt;
      console.log(`Weak-network save run ${index + 1}: ${saveConfirmedMs}ms`);

      measurements.push({ addInteractiveMs, saveConfirmedMs });
      expect(addInteractiveMs).toBeLessThan(3000);
      expect(saveConfirmedMs).toBeLessThan(4000);

      if (index < 2) {
        await page.getByRole("link", { name: "首页", exact: true }).click();
        await expect(page.getByRole("heading", { name: "首页" })).toBeVisible();
      }
    }

    console.log(`Weak-network measurements: ${JSON.stringify(measurements)}`);
  });
});
