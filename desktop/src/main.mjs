import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, WebContentsView } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedPermission, isExternalHttps, isTrustedSender, isTrustedUrl, safeDownloadName, validateRuntimeConfig } from "./policy.mjs";
import { getDesktopMessages } from "./messages.mjs";
import { DesktopUpdater } from "./updater.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
let window;
let remote;
let updater;
let preparation;
let generation = 0;
let documentReady = false;
let loadedFrame = null;
let completedGeneration = null;
let navigationFailed = false;
let nativeBusy = 0;
let exiting = false;
let closePrompt = false;
let locale = "zh-CN";
let safety = { ready: false, busy: false, dirty: false, identity: "", at: 0 };
const downloads = new Set();
const labels = () => getDesktopMessages(locale);

function send(value) {
  if (remote && !remote.webContents.isDestroyed()) remote.webContents.send("bb:event", JSON.stringify(value));
}

function releasePreparation() {
  if (preparation) {
    clearTimeout(preparation.timer);
    preparation.reject(new Error("Preparation cancelled"));
    preparation = null;
  }
  send({ type: "release" });
}

function prepare() {
  if (preparation) {
    clearTimeout(preparation.timer);
    preparation.reject(new Error("Preparation replaced"));
    preparation = null;
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    preparation = { requestId, generation, resolve, reject, timer: setTimeout(() => {
      preparation = null;
      reject(new Error("Page safety state unavailable"));
    }, 3000) };
    send({ type: "prepare", requestId });
  });
}

function showHost(failed) {
  if (!window || window.isDestroyed()) return;
  if (remote) remote.setVisible(false);
  window.webContents.send("bb:host", { locale, message: failed ? labels().failed : labels().loading, retry: labels().retry, failed });
}

async function loadSite(origin) {
  showHost(false);
  try { await remote.webContents.loadURL(`${origin}/home`); }
  catch { showHost(true); }
}

async function restrictDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") return;
  const identity = await new Promise((resolve, reject) => {
    const process = spawn("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
    let output = "";
    process.stdout.on("data", value => { output += value; });
    process.once("error", reject);
    process.once("exit", code => {
      const sid = /S-1-[0-9-]+/.exec(output)?.[0];
      if (code === 0 && sid) resolve(sid); else reject(new Error("Private directory identity unavailable"));
    });
  });
  await new Promise((resolve, reject) => {
    const process = spawn("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${identity}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true, stdio: "ignore" });
    process.once("error", reject);
    process.once("exit", code => code === 0 ? resolve() : reject(new Error("Private directory protection failed")));
  });
}

function launchInstaller(path) {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], { detached: true, windowsHide: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function start() {
  const config = validateRuntimeConfig(JSON.parse(await readFile(join(sourceDirectory, "../runtime-config.json"), "utf8")));
  if (config.appId === config.productId && ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "ignore-certificate-errors", "ignore-certificate-errors-spki-list", "disable-web-security", "no-sandbox"].some(name => app.commandLine.hasSwitch(name))) throw new Error("Unsafe production launch options");
  app.setAppUserModelId(config.appId);
  app.setPath("userData", join(app.getPath("appData"), config.appId));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  await app.whenReady();
  if (app.getVersion() !== config.version) throw new Error("Installed client version does not match its runtime configuration");
  await restrictDirectory(app.getPath("userData"));
  try { if ((await readFile(join(app.getPath("userData"), "locale"), "utf8")) === "en-US") locale = "en-US"; } catch { /* First launch uses Chinese. */ }
  Menu.setApplicationMenu(null);
  const profile = session.fromPartition("persist:billboard");
  const getCookie = async () => (await profile.cookies.get({ url: config.origin })).filter(cookie => /^(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name)).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  window = new BrowserWindow({ title: "BillBoard", width: 1200, height: 840, minWidth: 720, minHeight: 560, backgroundColor: "#f7f6f2", autoHideMenuBar: true,
    icon: join(sourceDirectory, "icon.png"),
    webPreferences: { preload: join(sourceDirectory, "host-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
  remote = new WebContentsView({ webPreferences: { preload: join(sourceDirectory, "preload.cjs"), session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false } });
  window.contentView.addChildView(remote);
  remote.setVisible(false);
  const resize = () => { const [width, height] = window.getContentSize(); remote.setBounds({ x: 0, y: 0, width, height }); };
  window.on("resize", resize); resize();
  const cacheDirectory = join(app.getPath("userData"), "updates");
  await restrictDirectory(cacheDirectory);
  updater = new DesktopUpdater({ ...config, version: app.getVersion(), cacheDirectory, getCookie, getSafety: () => ({ ...safety, busy: safety.busy || nativeBusy > 0 }),
    isFocused: () => !window.isDestroyed() && window.isFocused() && !window.isMinimized(), prepare, release: releasePreparation,
    confirmInstall: async () => {
      const result = await dialog.showMessageBox(window, { type: "question", title: labels().installTitle, message: labels().install, buttons: [labels().cancel, labels().confirm], defaultId: 0, cancelId: 0, noLink: true });
      if (!window.isDestroyed() && window.isFocused() && !window.isMinimized()) remote.webContents.focus();
      return result.response === 1;
    },
    launchInstaller, quit: () => { exiting = true; app.quit(); }, onState: send });
  await updater.cleanCache();
  let previousCookie = await getCookie();
  profile.cookies.on("changed", async (_event, cookie) => {
    if (!/^(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/.test(cookie.name)) return;
    const current = await getCookie().catch(() => "");
    if (current !== previousCookie) { previousCookie = current; await updater.invalidate(); }
  });
  ipcMain.on("bb:command", (event, raw, messageGeneration) => {
    if (!documentReady || messageGeneration !== generation || remote.webContents.isLoadingMainFrame() || !isTrustedSender(event, remote.webContents, config.origin)
      || typeof raw !== "string" || raw.length > 8192) return;
    let value;
    try { value = JSON.parse(raw); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.locale === "zh-CN" || value.locale === "en-US") {
      if (locale !== value.locale) { locale = value.locale; void writeFile(join(app.getPath("userData"), "locale"), locale, { mode: 0o600 }).catch(() => {}); }
    }
    if (value.command === "safety" || value.command === "prepared") {
      if (!["ready", "busy", "dirty"].every(key => typeof value[key] === "boolean") || typeof value.identity !== "string" || value.identity.length > 1024 || /[\u0000-\u001f]/.test(value.identity)) return;
      if (safety.identity && safety.identity !== value.identity) { releasePreparation(); void updater.invalidate(); }
      safety = { ready: value.ready, busy: value.busy, dirty: value.dirty, identity: value.identity, at: Date.now() };
      if (value.command === "prepared" && preparation?.requestId === value.requestId && preparation.generation === generation) {
        const pending = preparation; preparation = null; clearTimeout(pending.timer); pending.resolve({ ...safety, busy: safety.busy || nativeBusy > 0 });
      }
      return;
    }
    if (value.command === "status") send(updater.snapshot());
    else if (value.command === "check") void updater.check();
    else if (value.command === "download") void updater.download();
    else if (value.command === "install") void updater.install();
    else if (value.command === "cancel") { releasePreparation(); void updater.cancel(); }
  });
  ipcMain.on("bb:retry", event => { if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) void loadSite(config.origin); });
  const granted = new Set();
  profile.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (contents !== remote.webContents || !details.isMainFrame || !isTrustedUrl(details.requestingUrl ?? requestingOrigin, config.origin)) return false;
    if (permission === "clipboard-sanitized-write") return true;
    return permission === "media" && ["audio", "video"].includes(details.mediaType) && granted.has(details.mediaType);
  });
  profile.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents !== remote.webContents || !window.isFocused() || !allowedPermission(permission, details, config.origin)) { callback(false); return; }
    if (permission === "clipboard-sanitized-write") { callback(true); return; }
    const types = details.mediaTypes;
    if (types.every(type => granted.has(type))) { callback(true); return; }
    const result = await dialog.showMessageBox(window, { type: "question", title: labels().permissions, message: types.includes("video") ? labels().camera : labels().microphone,
      buttons: [labels().deny, labels().allow], defaultId: 0, cancelId: 0, noLink: true });
    const allowed = result.response === 1 && isTrustedUrl(remote.webContents.getURL(), config.origin);
    if (allowed) types.forEach(type => granted.add(type));
    callback(allowed);
  });
  profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  profile.on("will-download", (event, item, contents) => {
    const name = safeDownloadName(item.getFilename());
    const url = item.getURL();
    if (contents !== remote.webContents || !isTrustedUrl(contents.getURL(), config.origin) || !name
      || (!isTrustedUrl(url, config.origin) && !url.startsWith(`blob:${config.origin}/`)) || item.getTotalBytes() > 32 * 1024 * 1024) { event.preventDefault(); return; }
    nativeBusy += 1; downloads.add(item);
    item.setSaveDialogOptions({ title: labels().save, defaultPath: join(app.getPath("downloads"), name), properties: ["showOverwriteConfirmation"] });
    const timer = setTimeout(() => item.cancel(), 120_000);
    item.on("updated", () => { if (item.getReceivedBytes() > 32 * 1024 * 1024) item.cancel(); });
    item.once("done", (_event, state) => {
      clearTimeout(timer); nativeBusy = Math.max(0, nativeBusy - 1); downloads.delete(item);
      if (state !== "completed" && state !== "cancelled" && !window.isDestroyed()) void dialog.showMessageBox(window, { type: "error", message: labels().fileFailed });
    });
  });
  remote.webContents.setWindowOpenHandler(details => {
    if (isExternalHttps(details.url, config.origin)) void shell.openExternal(details.url).catch(() => {});
    return { action: "deny" };
  });
  remote.webContents.on("will-frame-navigate", details => {
    if (!isTrustedUrl(details.url, config.origin)) {
      details.preventDefault();
      if (details.isMainFrame && isExternalHttps(details.url, config.origin)) void shell.openExternal(details.url).catch(() => {});
    }
  });
  remote.webContents.on("will-redirect", (event, url) => { if (!isTrustedUrl(url, config.origin)) event.preventDefault(); });
  remote.webContents.on("will-attach-webview", event => event.preventDefault());
  remote.webContents.on("did-start-navigation", details => {
    if (!details.isMainFrame) return;
    if (!details.isSameDocument) documentReady = false;
    navigationFailed = false;
    generation += 1; releasePreparation();
    safety = { ...safety, ready: false, at: 0 };
    void updater.cancel();
  });
  remote.webContents.on("did-navigate", () => { loadedFrame = null; completedGeneration = null; });
  remote.webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
    if (isMainFrame && documentReady) remote.webContents.send("bb:ready", { generation, discardQueue: true });
  });
  remote.webContents.on("did-finish-load", () => {
    if (isTrustedUrl(remote.webContents.getURL(), config.origin)) {
      loadedFrame = remote.webContents.mainFrame;
      completedGeneration = generation;
      if (!remote.webContents.isLoadingMainFrame()) {
        documentReady = true;
        remote.webContents.send("bb:ready", { generation, discardQueue: false });
        remote.setVisible(true); remote.webContents.focus();
      }
    }
    else showHost(true);
  });
  remote.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { navigationFailed = true; documentReady = false; showHost(true); }
  });
  remote.webContents.on("did-stop-loading", () => {
    if (!documentReady && !navigationFailed && loadedFrame && loadedFrame === remote.webContents.mainFrame
      && !remote.webContents.isLoadingMainFrame() && isTrustedUrl(remote.webContents.getURL(), config.origin)) {
      documentReady = true;
      remote.webContents.send("bb:ready", { generation, discardQueue: completedGeneration !== generation });
      remote.setVisible(true); remote.webContents.focus();
    }
  });
  remote.webContents.on("render-process-gone", () => { documentReady = false; releasePreparation(); void updater.invalidate(); showHost(true); });
  app.on("certificate-error", (event, _contents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
  window.on("close", event => {
    if (exiting) return;
    if (nativeBusy || safety.busy || safety.dirty) {
      event.preventDefault();
      if (closePrompt) return;
      closePrompt = true;
      void dialog.showMessageBox(window, { type: "warning", title: labels().closeTitle, message: labels().close, buttons: [labels().keep, labels().exit], defaultId: 0, cancelId: 0, noLink: true })
        .then(async result => { if (result.response === 1) { downloads.forEach(item => item.cancel()); await updater.cancel(); exiting = true; app.quit(); } })
        .finally(() => { closePrompt = false; });
    } else { exiting = true; void updater.cancel(); }
  });
  window.on("closed", () => { if (!remote.webContents.isDestroyed()) remote.webContents.close(); app.quit(); });
  app.on("before-quit", () => { releasePreparation(); void updater.cancel(); });
  await window.loadFile(join(sourceDirectory, "host.html"));
  void loadSite(config.origin);
}

void start().catch(async () => {
  await app.whenReady();
  dialog.showErrorBox("BillBoard", labels().startup);
  app.quit();
});
