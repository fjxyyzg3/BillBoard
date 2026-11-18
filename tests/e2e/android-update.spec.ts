import { expect, test, type Page } from "./fixtures";
import type { UpdaterState } from "../../src/lib/android-updater";

type FixtureWindow = typeof window & { updaterFixture: { commands: string[]; emit: (patch: Partial<UpdaterState>) => void } };

async function nativeBridge(page: Page) {
  await page.addInitScript(() => {
    let state: UpdaterState = { status: "idle", installedVersion: "1.46.1", installedVersionCode: 1046001,
      release: { versionName: "1.47.0", versionCode: 1047000, size: 5000000, sha256: "a".repeat(64), minSdk: 29,
        notes: { "zh-CN": "支持应用内检查与安装更新。", "en-US": "Check and install app updates." } }, progress: 0, error: null };
    const commands: string[] = [];
    const emit = (patch: Partial<UpdaterState>) => {
      state = { ...state, ...patch };
      window.BillBoardUpdater?.onmessage?.({ data: JSON.stringify(state) });
    };
    (window as FixtureWindow).updaterFixture = { commands, emit };
    // The native WebMessage bridge is the sole substituted boundary.
    window.BillBoardUpdater = { onmessage: null, postMessage(message) {
      const { command } = JSON.parse(message);
      commands.push(command);
      queueMicrotask(() => {
        if (command === "status") emit({});
        if (command === "check") emit({ status: state.release && state.release.versionCode > state.installedVersionCode ? "available" : "idle", error: null });
        if (command === "download") emit({ status: "downloading", progress: 32 });
        if (command === "install") emit({ status: "installing" });
        if (command === "cancel") emit({ status: "available", error: "cancelled" });
      });
    } };
  });
}

async function login(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码").fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function showUpdate(page: Page) {
  await page.getByRole("button", { name: /更多选项/ }).click();
  await page.getByRole("button", { name: /应用更新/ }).click();
  return page.getByRole("dialog", { name: "应用更新", exact: true });
}

test("native update badge persists through reading, download and rejected installation", async ({ page }, testInfo) => {
  await nativeBridge(page);
  await login(page);
  await expect(page.getByTestId("apk-update-badge")).toBeVisible();
  const panel = await showUpdate(page);
  await expect(panel.getByText("1.46.1", { exact: true })).toBeVisible();
  await expect(panel.getByText("1.47.0", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "下载并安装", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("apk-update-panel.png") });
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "下载并安装", exact: true }).click();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "32");
  await page.evaluate(() => (window as FixtureWindow).updaterFixture.emit({ status: "ready", progress: 100 }));
  await expect(panel.getByText("请在系统页面确认安装", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as FixtureWindow).updaterFixture.emit({ status: "error", error: "install" }));
  await expect(panel.getByRole("button", { name: "安装更新", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByTestId("apk-update-badge")).toBeVisible();
  await page.evaluate(() => (window as FixtureWindow).updaterFixture.emit({ status: "idle", installedVersion: "1.47.0", installedVersionCode: 1047000, error: null }));
  await expect(page.getByTestId("apk-update-badge")).toHaveCount(0);
});

test("backgrounding prevents automatic installation until another explicit tap", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  const panel = await showUpdate(page);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "下载并安装", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.evaluate(() => (window as FixtureWindow).updaterFixture.emit({ status: "ready", progress: 100 }));
  await expect(panel.getByText("下载完成，已通过校验", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as FixtureWindow).updaterFixture.commands.includes("install"))).toBe(false);
  await panel.getByRole("button", { name: "安装更新", exact: true }).click();
  await expect(panel.getByText("请在系统页面确认安装", { exact: true })).toBeVisible();
});

test("closing during download keeps the badge and requires a new install tap", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  const panel = await showUpdate(page);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "下载并安装", exact: true }).click();
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => (window as FixtureWindow).updaterFixture.emit({ status: "ready", progress: 100 }));
  await expect(page.getByTestId("apk-update-badge")).toBeVisible();
  expect(await page.evaluate(() => (window as FixtureWindow).updaterFixture.commands.includes("install"))).toBe(false);
  await showUpdate(page);
  await expect(panel.getByRole("button", { name: "安装更新", exact: true })).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "安装更新", exact: true }).click();
  await expect(panel.getByText("请在系统页面确认安装", { exact: true })).toBeVisible();
});

test("closing during installation preparation cancels it before returning to the ledger", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  const panel = await showUpdate(page);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "下载并安装", exact: true }).click();
  await page.evaluate(() => (window as FixtureWindow).updaterFixture.emit({ status: "ready", progress: 100 }));
  await expect(panel.getByText("请在系统页面确认安装", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByTestId("apk-update-badge")).toBeVisible();
  await showUpdate(page);
  await expect(panel.getByText("请在系统页面确认安装", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "下载并安装", exact: true })).toBeDisabled();
});

test("a real pending ledger submission blocks update installation", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  await page.getByRole("link", { name: "记一笔", exact: true }).click();
  await page.getByLabel("金额", { exact: true }).fill("12.34");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/add**", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(page.locator('form[data-apk-update-blocked="true"]')).toBeVisible();
    const panel = await showUpdate(page);
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "下载并安装", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("请先完成录音");
    expect(await page.evaluate(() => (window as FixtureWindow).updaterFixture.commands.includes("download"))).toBe(false);
  } finally {
    release();
  }
});

test("normal browsers do not show APK update controls", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await expect(page.getByRole("button", { name: /应用更新/ })).toHaveCount(0);
  await expect(page.getByTestId("apk-update-badge")).toHaveCount(0);
});
