import { expect, test, type Page } from "./fixtures";

type UpdateCommand =
  | { command: "version" | "safari" }
  | { command: "install"; build: string; url: string; expiresAt: number };
type FixtureWindow = typeof window & { iosUpdateCommands: UpdateCommand[] };

const installed = { version: "1.68.1", build: "1.2.1" };
const latest = { version: "1.69.0", build: "1.10.1" };
const manifest = `https://billboard.invalid/api/ios/install/manifest/${"a".repeat(64)}`;
const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`;
const pendingWorkMessage = "有尚未处理的记账任务或未保存的草稿。请处理后重试。";

async function nativeBridge(page: Page, installOpens = true) {
  await page.addInitScript(({ version, installOpens }) => {
    const commands: UpdateCommand[] = [];
    (window as FixtureWindow).iosUpdateCommands = commands;
    Object.defineProperty(window, "webkit", { value: { messageHandlers: { billboardUpdate: {
      async postMessage(message: UpdateCommand) {
        commands.push(message);
        if (message.command === "version") return version;
        return message.command === "safari" || installOpens;
      },
    } } } });
  }, { version: installed, installOpens });
}

async function updateEndpoint(page: Page, beforeGrant?: () => Promise<void>) {
  const checks: string[] = [];
  const grants: unknown[] = [];
  await page.route("**/api/ios/update", async (route) => {
    if (route.request().method() === "GET") {
      checks.push(route.request().method());
      await route.fulfill({ json: latest });
      return;
    }
    expect(route.request().method()).toBe("POST");
    grants.push(route.request().postDataJSON());
    await beforeGrant?.();
    await route.fulfill({ json: { url: installUrl, build: latest.build, expiresAt: Date.now() + 60_000 } });
  });
  return { checks, grants };
}

async function login(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码", { exact: true }).fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 20_000 });
}

async function openUpdate(page: Page) {
  await page.getByRole("button", { name: /更多选项/ }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "检查更新", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function commands(page: Page, command: UpdateCommand["command"]) {
  return page.evaluate((name) => (window as FixtureWindow).iosUpdateCommands.filter((item) => item.command === name), command);
}

test("checks a newer numeric build on demand and hands it to iOS after an install tap", async ({ page }) => {
  await nativeBridge(page);
  const { checks, grants } = await updateEndpoint(page);
  await login(page);
  expect(checks).toHaveLength(0);

  const dialog = await openUpdate(page);
  await expect(dialog.getByText(installed.version)).toBeVisible();
  await expect(dialog.getByText(installed.build)).toBeVisible();
  await expect(dialog.getByText(latest.version)).toBeVisible();
  await expect(dialog.getByText(latest.build)).toBeVisible();
  expect(checks).toHaveLength(1);
  expect(grants).toHaveLength(0);
  expect(await commands(page, "install")).toHaveLength(0);

  await dialog.getByRole("button", { name: "安装更新", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已交给 iOS，请确认安装。");
  expect(grants).toEqual([{ currentBuild: installed.build, targetBuild: latest.build }]);
  expect(await commands(page, "install")).toEqual([
    { command: "install", build: latest.build, url: installUrl, expiresAt: expect.any(Number) },
  ]);
});

test("protects an unsaved accounting form from both handoffs and permits Safari after the draft is cleared", async ({ page }) => {
  await nativeBridge(page);
  const { grants } = await updateEndpoint(page);
  await login(page);
  await page.getByRole("link", { name: "记一笔", exact: true }).click();
  const amount = page.getByLabel("金额", { exact: true });
  await amount.fill("12.34");
  await expect(page.locator('form[data-desktop-update-dirty="true"]')).toBeVisible();

  const dialog = await openUpdate(page);
  await dialog.getByRole("button", { name: "安装更新", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(pendingWorkMessage);
  expect(grants).toHaveLength(0);
  expect(await commands(page, "install")).toHaveLength(0);
  await dialog.getByRole("button", { name: "在 Safari 中打开", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(pendingWorkMessage);
  expect(await commands(page, "safari")).toHaveLength(0);

  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(amount).toHaveValue("12.34");
  await amount.clear();
  await expect(page.locator('form[data-desktop-update-dirty="true"]')).toHaveCount(0);
  await openUpdate(page);
  await dialog.getByRole("button", { name: "在 Safari 中打开", exact: true }).click();
  await expect.poll(() => commands(page, "safari")).toEqual([{ command: "safari" }]);
  expect(grants).toHaveLength(0);
});

test("rechecks for unfinished work when the short-lived installation grant arrives", async ({ page }) => {
  await nativeBridge(page);
  let releaseGrant!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGrant = resolve; });
  const { checks, grants } = await updateEndpoint(page, () => gate);
  await login(page);
  const dialog = await openUpdate(page);
  const install = dialog.getByRole("button", { name: "安装更新", exact: true });

  try {
    await install.click();
    await expect.poll(() => grants.length).toBe(1);
    await expect(install).toBeDisabled();
    await page.evaluate(() => {
      // Model the pending marker that can be committed while the grant is in flight.
      const marker = document.createElement("span");
      marker.id = "fixture-pending-accounting";
      marker.hidden = true;
      marker.dataset.apkUpdateBlocked = "true";
      document.body.append(marker);
    });
  } finally {
    releaseGrant();
  }
  await expect(dialog.getByRole("status")).toHaveText(pendingWorkMessage);
  expect(await commands(page, "install")).toHaveLength(0);

  await page.evaluate(() => document.getElementById("fixture-pending-accounting")?.remove());
  await dialog.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(install).toBeEnabled();
  expect(checks).toHaveLength(2);
  await install.click();
  await expect(dialog.getByRole("status")).toContainText("已交给 iOS，请确认安装。");
  expect(grants).toHaveLength(2);
  expect(await commands(page, "install")).toHaveLength(1);
});

test("allows retries after an expired session or missing release and offers Safari after a failed system handoff", async ({ page }) => {
  await nativeBridge(page, false);
  const older = { version: "1.68.0", build: "1.1.1" };
  const offers = [{ status: 401 }, { status: 404 }, { json: installed }, { json: older }, { json: latest }];
  await page.route("**/api/ios/update", async (route) => {
    if (route.request().method() === "GET") {
      const offer = offers.shift();
      if (!offer) throw new Error("Unexpected update check");
      await route.fulfill(offer);
      return;
    }
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ json: { url: installUrl, build: latest.build, expiresAt: Date.now() + 60_000 } });
  });
  await login(page);
  const dialog = await openUpdate(page);
  const status = dialog.getByRole("status");
  const recheck = dialog.getByRole("button", { name: "重新检查", exact: true });
  const install = dialog.getByRole("button", { name: "安装更新", exact: true });

  await expect(status).toHaveText("登录已失效，请重新登录。");
  await expect(dialog.getByRole("link", { name: "重新登录", exact: true })).toHaveAttribute("href", "/login?reason=session-expired");
  await recheck.click();
  await expect(status).toHaveText("暂时没有可领取的 iOS 版本。");
  await recheck.click();
  await expect(status).toHaveText("已是最新版本");
  await expect(install).toHaveCount(0);
  await recheck.click();
  await expect(dialog.getByText(`${older.version} (${older.build})`, { exact: true })).toBeVisible();
  await expect(status).toHaveText("已是最新版本");
  await expect(install).toHaveCount(0);

  await recheck.click();
  await install.click();
  await expect(status).toContainText("无法打开安装入口。");
  expect(await commands(page, "install")).toHaveLength(1);
  await dialog.getByRole("button", { name: "在 Safari 中打开", exact: true }).click();
  await expect.poll(() => commands(page, "safari")).toEqual([{ command: "safari" }]);
});

test("ordinary browsers keep the in-app update entry hidden", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await expect(page.getByRole("button", { name: "检查更新", exact: true })).toHaveCount(0);
});
