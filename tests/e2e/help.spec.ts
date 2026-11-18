import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { expect, test, type BrowserContext, type Page } from "./fixtures";
import type { DownloadCatalog } from "../../src/lib/download-types";

const availableDownloads: DownloadCatalog = {
  android: { status: "available", version: "1.60.0", size: 5242880, minSdk: 29 },
  windows: { status: "available", version: "1.59.0", size: 73400320 },
};

async function serveDownloads(page: Page, catalog: DownloadCatalog = availableDownloads) {
  // Only the release metadata HTTP boundary is substituted; the page renders normally.
  await page.route("**/api/downloads", (route) => route.fulfill({ json: catalog }));
}

test("the sign-in page links to the public guide", async ({ page }) => {
  await serveDownloads(page);
  await page.goto("/login");
  await page.getByRole("link", { name: "使用教程与下载", exact: true }).click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByRole("heading", { level: 1, name: "使用教程与下载" })).toBeVisible();
});

for (const layout of ["mobile", "desktop"] as const) {
  test(`the ${layout} navigation reaches the guide and returns to the ledger`, async ({ page }) => {
    await page.setViewportSize(layout === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    await serveDownloads(page);
    await page.goto("/login");
    await page.getByLabel("邮箱", { exact: true }).fill(process.env.SEED_USER_A_EMAIL!);
    await page.getByLabel("密码", { exact: true }).fill(process.env.SEED_USER_A_PASSWORD!);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
    if (layout === "mobile") await page.getByRole("button", { name: "更多选项", exact: true }).click();
    await page.getByRole("link", { name: "使用教程与下载", exact: true }).click();
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole("heading", { level: 1, name: "使用教程与下载" })).toBeVisible();
    await page.getByRole("link", { name: "登录或进入账本", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
  });
}

test("the complete help guide is public, readable before downloads finish, and bilingual", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/downloads", async (route) => {
    await gate;
    await route.fulfill({ json: availableDownloads });
  });

  try {
    const response = await page.goto("/help", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole("heading", { level: 1, name: "使用教程与下载" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "家庭加密与恢复" })).toBeVisible();
    await expect(page.getByText("正在读取安装包信息…", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "教程目录" })).toBeVisible();
  } finally {
    release();
  }

  await expect(page.getByRole("link", { name: "下载 Android APK", exact: true })).toHaveAttribute("href", "/api/downloads/android");
  await expect(page.getByRole("link", { name: "下载 Windows EXE", exact: true })).toHaveAttribute("href", "/api/downloads/windows");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "切换语言", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Guide and downloads" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Household encryption and recovery" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download Android APK", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
});

test("each platform shows its published version and streams the browser attachment", async ({ browser, baseURL }) => {
  if (baseURL !== "http://127.0.0.1:2501") throw new Error("Download fixtures require the local E2E server");
  const attachments = {
    android: { name: "billboard-1.60.0.apk", body: "Android fixture attachment", type: "application/vnd.android.package-archive" },
    windows: { name: "billboard-1.59.0.exe", body: "Windows fixture attachment", type: "application/octet-stream" },
  };
  const tunneledSockets = new Set<Duplex>();
  // Chromium download-attribute requests bypass page/context.route; isolate the actual HTTP boundary.
  const proxy = createServer((request, response) => {
    const target = new URL(request.url ?? "/", baseURL);
    if (target.origin !== baseURL) { response.writeHead(403); response.end(); return; }
    const platform = target.pathname === "/api/downloads/android" ? "android"
      : target.pathname === "/api/downloads/windows" ? "windows" : null;
    if (platform) {
      const attachment = attachments[platform];
      response.writeHead(200, { "Content-Type": attachment.type, "Content-Disposition": `attachment; filename="${attachment.name}"` });
      response.end(attachment.body);
      return;
    }
    const upstream = requestHttp(target, { method: request.method, headers: { ...request.headers, host: target.host } }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  // Chromium uses CONNECT for Next dev's HMR WebSocket, even on plain loopback HTTP.
  proxy.on("connect", (request, socket, head) => {
    if (request.url !== "127.0.0.1:2501") { socket.destroy(); return; }
    const upstream = connect({ host: "127.0.0.1", port: 2501 });
    tunneledSockets.add(socket); tunneledSockets.add(upstream);
    socket.once("error", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => { tunneledSockets.delete(socket); upstream.destroy(); });
    upstream.once("close", () => { tunneledSockets.delete(upstream); socket.destroy(); });
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  let context: BrowserContext | undefined;
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Download fixture proxy did not bind");
    context = await browser.newContext({ baseURL, proxy: { server: `http://127.0.0.1:${address.port}` } });
    const page = await context.newPage();
    await serveDownloads(page);
    await page.goto("/help");
    const android = page.getByRole("article", { name: "Android APK", exact: true });
    const windows = page.getByRole("article", { name: "Windows x64 EXE", exact: true });
    await expect(android).toContainText("1.60.0");
    await expect(android).toContainText("5 MiB");
    await expect(windows).toContainText("1.59.0");
    await expect(windows).toContainText("70 MiB");

    for (const platform of ["android", "windows"] as const) {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("link", { name: platform === "android" ? "下载 Android APK" : "下载 Windows EXE", exact: true }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(attachments[platform].name);
      expect(await download.failure()).toBeNull();
      const downloadedPath = await download.path();
      expect(downloadedPath).not.toBeNull();
      expect(await readFile(downloadedPath!, "utf8")).toBe(attachments[platform].body);
    }
    await expect(page).toHaveURL(/\/help$/);
  } finally {
    try { await context?.close(); }
    finally {
      for (const socket of tunneledSockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => error ? reject(error) : resolve());
        proxy.closeAllConnections();
      });
    }
  }
});

for (const missing of ["android", "windows"] as const) {
  test(`an unavailable ${missing} package leaves the other download and guide available`, async ({ page }) => {
    await serveDownloads(page, { ...availableDownloads, [missing]: { status: "unavailable" } });
    await page.goto("/help");
    const unavailableCard = page.getByRole("article", { name: missing === "android" ? "Android APK" : "Windows x64 EXE", exact: true });
    await expect(unavailableCard.getByText("安装包暂不可用，请稍后重试。", { exact: true })).toBeVisible();
    await expect(unavailableCard.getByRole("link", { name: /^下载/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: missing === "android" ? "下载 Windows EXE" : "下载 Android APK", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "账单导入与 Excel 导出" })).toBeVisible();
  });
}

test("metadata failure keeps the guide readable and can be retried", async ({ page }) => {
  let recovered = false;
  await page.route("**/api/downloads", (route) => recovered
    ? route.fulfill({ json: availableDownloads })
    : route.abort("failed"));
  await page.goto("/help");
  await expect(page.getByText("安装包信息暂时无法读取，教程仍可继续阅读。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "家庭加密与恢复" })).toBeVisible();
  recovered = true;
  await page.getByRole("button", { name: "重新读取安装包", exact: true }).click();
  await expect(page.getByRole("link", { name: "下载 Android APK", exact: true })).toBeVisible();
});

test("a busy platform does not hide the other installer", async ({ page }) => {
  await serveDownloads(page, { ...availableDownloads, android: { status: "busy" } });
  await page.goto("/help");
  await expect(page.getByText("下载服务繁忙，请稍后重试。", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载 Windows EXE", exact: true })).toBeVisible();
});

for (const platform of ["android", "windows"] as const) {
  test(`the ${platform} client directs users to its existing updater`, async ({ page }) => {
    await page.addInitScript((nativePlatform) => {
      if (nativePlatform === "android") {
        window.BillBoardUpdater = { onmessage: null, postMessage() {} };
      } else {
        window.BillBoardDesktop = { postMessage() {}, subscribe: () => () => {} };
      }
    }, platform);
    await serveDownloads(page);
    await page.goto("/help");
    await expect(page.getByText("你正在客户端中阅读。请返回账本，打开手机「更多」中的「应用更新」，或桌面侧栏中的「客户端更新」。", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /^下载 (Android APK|Windows EXE)$/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "返回账本检查更新", exact: true })).toHaveAttribute("href", "/home");
  });
}
