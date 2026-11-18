import { expect, test, type Page } from "./fixtures";
import type { DesktopSafety, DesktopUpdaterState } from "../../src/lib/desktop-updater";

type Command = DesktopSafety & { command: string; requestId?: string };
type FixtureWindow = typeof window & { desktopFixture: {
  commands: Command[]; emit: (patch: Partial<DesktopUpdaterState>) => void; raw: (data: string) => void;
  control: (message: { type: "prepare"; requestId: string } | { type: "release" }) => void;
} };

async function nativeBridge(page: Page, options: { holdInitialState?: boolean; ignoreChecks?: number } = {}) {
  await page.addInitScript((options) => {
    let state: DesktopUpdaterState = { status: "idle", installedVersion: "1.56.1", progress: 0, error: null,
      release: { schema: 1, productId: "com.billboard.desktop", platform: "win32", arch: "x64", version: "1.57.0", size: 120_000_000,
        sha256: "a".repeat(64), notes: { "zh-CN": "支持 Windows 客户端安全更新。", "en-US": "Safe Windows client updates." } } };
    const commands: Command[] = [];
    let ignoredChecks = options.ignoreChecks ?? 0;
    let receive: ((event: { data: string }) => void) | null = null;
    function emit(patch: Partial<DesktopUpdaterState>) {
      state = { ...state, ...patch };
      receive?.({ data: JSON.stringify(state) });
    }
    (window as FixtureWindow).desktopFixture = { commands, emit, raw(data) { receive?.({ data }); }, control(message) {
      receive?.({ data: JSON.stringify(message) });
    } };
    // Only the native boundary is substituted; page behavior and sessions remain real.
    window.BillBoardDesktop = { subscribe(listener) { receive = listener; return () => { if (receive === listener) receive = null; }; }, postMessage(raw) {
      const message = JSON.parse(raw) as Command;
      commands.push(message);
      queueMicrotask(() => {
        if (message.command === "status" && !options.holdInitialState) emit({});
        if (message.command === "check") {
          if (ignoredChecks > 0) { ignoredChecks -= 1; return; }
          emit({ status: "available", error: null });
        }
        if (message.command === "download") emit({ status: "downloading", progress: 32, error: null });
        if (message.command === "install") emit({ status: "installing", error: null });
        if (message.command === "cancel") emit({ status: state.status === "installing" ? "ready" : "available", error: "cancelled" });
      });
    } };
  }, options);
}

async function login(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(process.env.SEED_USER_A_EMAIL!);
  await page.getByLabel("密码", { exact: true }).fill(process.env.SEED_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 20_000 });
}

async function panel(page: Page) {
  await page.getByRole("button", { name: /客户端更新/ }).click();
  return page.getByRole("dialog", { name: "Windows 客户端更新", exact: true });
}

async function download(page: Page) {
  const dialog = await panel(page);
  await dialog.getByRole("button", { name: "下载更新", exact: true }).click();
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("value", "32");
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.emit({ status: "ready", progress: 100 }));
  await expect(dialog.getByRole("button", { name: "重启并安装", exact: true })).toBeDisabled();
  return dialog;
}

async function commands(page: Page, command: string) {
  return page.evaluate((name) => (window as FixtureWindow).desktopFixture.commands.filter((item) => item.command === name), command);
}

test("waits for native state and retries unacknowledged startup checks without starting the fifteen-minute interval", async ({ page }) => {
  await nativeBridge(page, { holdInitialState: true, ignoreChecks: 1 });
  await login(page);
  expect(await commands(page, "check")).toHaveLength(0);
  await page.clock.install();
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.emit({ status: "idle" }));
  await expect.poll(async () => (await commands(page, "check")).length).toBe(1);
  await page.clock.runFor(500);
  expect(await commands(page, "check")).toHaveLength(1);
  await page.clock.runFor(1_500);
  await expect.poll(async () => (await commands(page, "check")).length).toBe(2);
  await page.clock.runFor(14 * 60 * 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(await commands(page, "check")).toHaveLength(2);
});

test("uses the installed client version and requires a separate saved confirmation after download", async ({ page }, testInfo) => {
  await nativeBridge(page);
  await login(page);
  const dialog = await panel(page);
  await expect(dialog.getByText("1.56.1", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1.57.0", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "下载更新", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("windows-update-panel.png") });
  await dialog.getByRole("button", { name: "下载更新", exact: true }).click();
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.emit({ status: "ready", progress: 100 }));
  await expect(dialog.getByRole("button", { name: "重启并安装", exact: true })).toBeDisabled();
  expect(await commands(page, "install")).toHaveLength(0);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "重启并安装", exact: true }).click();
  await expect(dialog.getByText("请在客户端确认重启并安装", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.emit({ status: "error", error: "install" }));
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByTestId("desktop-update-badge")).toBeVisible();
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.emit({ status: "idle", installedVersion: "1.57.0", error: null }));
  await expect(page.getByTestId("desktop-update-badge")).toHaveCount(0);
});

test("closing the panel and losing focus cannot authorize a later installation", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  const dialog = await panel(page);
  await dialog.getByRole("button", { name: "下载更新", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.emit({ status: "ready", progress: 100 }));
  expect(await commands(page, "install")).toHaveLength(0);
  await panel(page);
  await dialog.getByRole("checkbox").check();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(dialog.getByRole("button", { name: "重启并安装", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "重启并安装", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  expect(await commands(page, "cancel")).toHaveLength(1);
  await panel(page);
  await expect(dialog.getByRole("button", { name: "重启并安装", exact: true })).toBeDisabled();
});

test("blocks installation for real unsaved and pending accounting forms", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  await page.getByRole("link", { name: "记一笔", exact: true }).click();
  await page.getByLabel("金额", { exact: true }).fill("12.34");
  const dialog = await download(page);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "重启并安装", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("请先完成录音");
  expect(await commands(page, "install")).toHaveLength(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/add**", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(page.locator('form[data-apk-update-blocked="true"]')).toBeVisible();
    await panel(page);
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "重启并安装", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("请先完成录音");
    expect(await commands(page, "install")).toHaveLength(0);
  } finally { release(); }
});

test("freezes new business submissions during native confirmation and permits its blur", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  const dialog = await download(page);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "重启并安装", exact: true }).click();
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.control({ type: "prepare", requestId: "first" }));
  await expect.poll(async () => (await commands(page, "prepared")).at(-1)?.ready).toBe(true);
  const first = (await commands(page, "prepared")).at(-1)!;
  expect(JSON.parse(first.identity)).toHaveLength(3);
  expect(first.busy).toBe(false);
  expect(first.dirty).toBe(false);
  expect(Object.keys(first).sort()).toEqual(["command", "requestId", "ready", "busy", "dirty", "identity", "locale"].sort());
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    document.querySelector<HTMLAnchorElement>('aside a[href^="/add"]')!.click();
  });
  await expect(page).toHaveURL(/\/home$/);
  expect(await commands(page, "cancel")).toHaveLength(0);
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.control({ type: "prepare", requestId: "after-confirm" }));
  await expect.poll(async () => (await commands(page, "prepared")).at(-1)?.requestId).toBe("after-confirm");
  expect((await commands(page, "prepared")).at(-1)?.ready).toBe(true);
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.control({ type: "release" }));
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("link", { name: "记一笔", exact: true }).click();
  await expect(page).toHaveURL(/\/add/);
});

test("rejects stale prepare requests after navigation and unknown native states", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  const dialog = await download(page);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "重启并安装", exact: true }).click();
  await page.evaluate(() => {
    history.pushState(null, "", "/home?ledger=all");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/ledger=all/);
  await expect.poll(async () => (await commands(page, "cancel")).length).toBe(1);
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.control({ type: "prepare", requestId: "old-page" }));
  await expect.poll(async () => (await commands(page, "prepared")).at(-1)?.ready).toBe(false);
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.raw('{"status":"unknown"}'));
  await expect.poll(async () => (await commands(page, "safety")).at(-1)?.ready).toBe(false);
});

test("reports Excel generation and encryption backup operations outside the app shell", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  await page.goto("/records");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/records/export", async (route) => {
    await gate;
    await route.abort("aborted");
  });
  try {
    await page.getByRole("button", { name: "导出", exact: true }).click();
    const exporting = page.getByRole("dialog", { name: "导出账目", exact: true });
    await exporting.getByRole("button", { name: "下载 Excel", exact: true }).click();
    await expect(page.locator('[data-desktop-update-blocked="true"]')).toHaveCount(1);
    await expect.poll(async () => (await commands(page, "safety")).at(-1)?.busy).toBe(true);
    await exporting.getByRole("button", { name: "取消", exact: true }).click();
  } finally { release(); }
  await page.goto("/account/household");
  const settings = page.getByTestId("household-encryption-settings");
  await expect(settings).not.toHaveAttribute("data-desktop-update-blocked", "true");
  await settings.getByRole("button", { name: "开启加密", exact: true }).click();
  await expect(settings.getByTestId("encryption-candidate")).toBeVisible();
  await expect(settings).toHaveAttribute("data-desktop-update-blocked", "true");
  await expect.poll(async () => (await commands(page, "safety")).at(-1)?.busy).toBe(true);
  const code = await settings.getByTestId("encryption-candidate").locator("textarea[readonly]").inputValue();
  await settings.getByTestId("encryption-candidate").locator('input[type="file"]').first().setInputFiles({ name: "code.json", mimeType: "application/json", buffer: Buffer.from(code) });
  await expect(settings.getByText("已回读验证", { exact: false }).first()).toBeVisible();
  await expect(settings).toHaveAttribute("data-desktop-update-blocked", "true");
  await page.evaluate(() => (window as FixtureWindow).desktopFixture.control({ type: "prepare", requestId: "account-page" }));
  expect((await commands(page, "prepared")).at(-1)?.ready).toBe(false);
  await page.goto("/home");
  await expect.poll(async () => (await commands(page, "safety")).at(-1)?.busy).toBe(true);
  const updating = await download(page);
  await updating.getByRole("checkbox").check();
  await updating.getByRole("button", { name: "重启并安装", exact: true }).click();
  await expect(updating.getByRole("alert")).toContainText("请先完成录音");
  expect(await commands(page, "install")).toHaveLength(0);
});

test("automatic checks stay limited while manual checks may retry immediately", async ({ page }) => {
  await nativeBridge(page);
  await login(page);
  await expect(page.getByTestId("desktop-update-badge")).toBeVisible();
  const count = (await commands(page, "check")).length;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(await commands(page, "check")).toHaveLength(count);
  await panel(page);
  await expect.poll(async () => (await commands(page, "check")).length).toBe(count + 1);
});

test("normal browsers keep Windows controls hidden", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("button", { name: /客户端更新/ })).toHaveCount(0);
  await expect(page.getByTestId("desktop-update-badge")).toHaveCount(0);
});
