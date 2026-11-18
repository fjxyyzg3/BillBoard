import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { createDesktopStaging, buildDesktopInstaller } from "../ops/desktop/build-exe.mjs";
import { protectDesktopPrivatePath, publicKeyFingerprint } from "../ops/desktop/build-config.mjs";
import { inspectDesktopInstaller } from "../ops/desktop/inspect-installer.mjs";
import { createDesktopManifest } from "../src/lib/desktop-update-manifest.mjs";
import { validateRuntimeConfig } from "./src/policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronExecutable = require("./node_modules/electron");
const bridgeOnly = process.argv.includes("--bridge-only");
const reuseOption = process.argv.slice(2).find(value => value.startsWith("--installer-lifecycle-only="));
const baselineOption = process.argv.slice(2).find(value => value.startsWith("--navigation-baseline="));
const startupOption = process.argv.slice(2).find(value => value.startsWith("--startup-probes="));
const startupProbes = startupOption ? Number(startupOption.slice("--startup-probes=".length)) : 1;
const lifecycleOnly = Boolean(reuseOption);
if ((bridgeOnly && lifecycleOnly) || (baselineOption && !bridgeOnly) || (startupOption && !bridgeOnly)
  || !Number.isInteger(startupProbes) || startupProbes < 1 || startupProbes > 32
  || process.argv.slice(2).some(value => value !== "--bridge-only" && value !== reuseOption && value !== baselineOption && value !== startupOption)) {
  throw new Error("Usage: node desktop/test-windows.mjs [--bridge-only [--navigation-baseline=<isolated-fixture-directory>] [--startup-probes=1..32] | --installer-lifecycle-only=<isolated-fixture-directory>]");
}
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows validation requires Windows x64");

const temporaryRoot = join(root, "tmp");
mkdirSync(temporaryRoot, { recursive: true });
const work = lifecycleOnly ? resolve(reuseOption.slice("--installer-lifecycle-only=".length)) : mkdtempSync(join(temporaryRoot, "windows-validation-"));
const canonicalWork = realpathSync(work);
const temporaryRelative = relative(realpathSync(temporaryRoot), canonicalWork);
assert(/^windows-validation-[A-Za-z0-9]+$/.test(temporaryRelative) && !lstatSync(work).isSymbolicLink(), "Only an existing isolated Windows fixture may be reused");
const suffix = randomBytes(5).toString("hex");
const priorRuntime = lifecycleOnly ? validateRuntimeConfig(JSON.parse(readFileSync(ownedPath(join(work, "stage-one/runtime-config.json")), "utf8"))) : null;
const priorPackage = lifecycleOnly ? JSON.parse(readFileSync(ownedPath(join(work, "stage-one/package.json")), "utf8")) : null;
const appId = priorRuntime?.appId ?? `com.billboard.desktop.validation.${suffix}`;
const productName = priorPackage?.productName ?? `BillBoard Validation ${suffix}`;
assert(/^com\.billboard\.desktop\.validation\.[a-z0-9]+$/.test(appId)
  && productName === `BillBoard Validation ${appId.split(".").at(-1)}`, "The fixture cannot use the production product identity or shortcuts");
const firstVersion = "0.0.1";
const secondVersion = "0.0.2";
let pendingUuid = randomUUID();
const running = new Set();
let launchCount = 0;
const evidence = { appId, productName, mode: lifecycleOnly ? "installer-lifecycle-only" : baselineOption ? "navigation-baseline" : bridgeOnly ? "bridge-only" : "full", checks: [], limitations: ["Real microphone and camera hardware are not verified by this synthetic fixture."] };
const evidencePath = join(work, lifecycleOnly ? `evidence-lifecycle-${suffix}.json` : "evidence.json");
if (lifecycleOnly) evidence.limitations.push("Signed updater protocol behavior is verified separately by the latest bridge-only run; this phase reuses the original public key without its private key.");
protectDesktopPrivatePath(work, { directory: true });

function ownedPath(path) {
  const absolute = resolve(path);
  const local = relative(canonicalWork, absolute);
  assert(local && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`), "Validation target escaped its isolated temporary directory");
  assert.equal(realpathSync(work), canonicalWork, "Validation directory was replaced");
  assert(!lstatSync(work).isSymbolicLink(), "Validation directory became a link");
  let existing = absolute;
  while (!existsSync(existing)) existing = dirname(existing);
  const resolvedParent = realpathSync(existing);
  const parentLocal = relative(canonicalWork, resolvedParent);
  assert(!isAbsolute(parentLocal) && parentLocal !== ".." && !parentLocal.startsWith(`..${sep}`), "Validation target resolves outside its isolated temporary directory");
  return absolute;
}

function record(check, detail = {}) {
  evidence.checks.push({ check, ...detail });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(`PASS ${check}\n`);
}

async function waitFor(check, description, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`${description}${last ? `: ${last.message}` : ""}`);
}

function makeCertificate() {
  const executable = "C:/Program Files/Git/usr/bin/openssl.exe";
  assert(existsSync(executable), "Git OpenSSL is required for the isolated HTTPS fixture");
  const key = ownedPath(join(work, "localhost-key.pem"));
  const certificate = ownedPath(join(work, "localhost-cert.pem"));
  if (!lifecycleOnly) {
    execFileSync(executable, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
      "-keyout", key, "-out", certificate, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  }
  const cert = new X509Certificate(readFileSync(certificate));
  const spki = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  return { key, certificate, spki };
}

const signing = generateKeyPairSync("ed25519");
const publicKey = priorRuntime?.publicKey ?? signing.publicKey.export({ type: "spki", format: "pem" }).toString();
const tls = makeCertificate();
const fixturePage = readFileSync(join(root, "desktop/tests/fixtures/windows-page.html"));
const syntheticBytes = Buffer.alloc(512 * 1024, 0x51);
syntheticBytes.write("MZ synthetic validation payload - never execute");
const distribution = { mode: "valid", slow: false, nextSession: false, artifact: syntheticBytes, artifactPath: null,
  downloadRequests: 0, downloadSessions: [], sessions: [] };

function manifest() {
  const bytes = distribution.artifactPath ? readFileSync(distribution.artifactPath) : distribution.artifact;
  const release = { schema: 1, productId: "com.billboard.desktop", platform: "win32", arch: "x64", version: secondVersion,
    size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), notes: { "zh-CN": "隔离验证版本", "en-US": "Isolated validation release" } };
  const envelope = createDesktopManifest(release, signing.privateKey);
  if (distribution.mode === "tampered") {
    const corrupted = Buffer.from(envelope.signature, "base64"); corrupted[0] ^= 1;
    envelope.signature = corrupted.toString("base64");
  }
  return { release, envelope, bytes };
}

const server = createServer({ key: readFileSync(tls.key), cert: readFileSync(tls.certificate) }, async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "microphone=(self), camera=(self), geolocation=()");
  const path = request.url;
  if (path === "/fixture/login" || path === "/fixture/login-next") {
    distribution.nextSession = path.endsWith("-next");
    response.setHeader("Set-Cookie", `__Secure-authjs.session-token=${distribution.nextSession ? "synthetic-session-two" : "synthetic-session-one"}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400`);
    response.end("ok"); return;
  }
  if (path === "/home" || path === "/" || path === "/slow-navigation" || path === "/slow-stop") {
    if (path === "/slow-navigation" || path === "/slow-stop") await delay(2000);
    distribution.sessions.push(request.headers.cookie?.includes("synthetic-session-one") === true);
    response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(fixturePage); return;
  }
  if (path === "/iframe") {
    response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end("<!doctype html><p>Isolated iframe boundary</p>"); return;
  }
  if (path === "/fixture/export.json") {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Disposition", 'attachment; filename="billboard-validation.json"');
    response.end('{"synthetic":true,"kind":"saved-fixture"}'); return;
  }
  const expectedCookie = `__Secure-authjs.session-token=${distribution.nextSession ? "synthetic-session-two" : "synthetic-session-one"}`;
  if (request.headers.cookie !== expectedCookie || distribution.mode === "revoked") {
    response.writeHead(401); response.end(); return;
  }
  if (lifecycleOnly) { response.writeHead(404); response.end(); return; }
  const current = manifest();
  if (path === "/api/windows/update") {
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(current.envelope)); return;
  }
  if (path === `/api/windows/update/${current.release.sha256}`) {
    distribution.downloadRequests += 1;
    distribution.downloadSessions.push(request.headers.cookie.includes("synthetic-session-one") ? "one" : "two");
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", String(current.bytes.length));
    if (distribution.artifactPath && !distribution.slow) {
      const input = createReadStream(distribution.artifactPath, { highWaterMark: 64 * 1024 });
      response.once("close", () => input.destroy()); input.pipe(response); return;
    }
    for (let offset = 0; offset < current.bytes.length && !response.destroyed; offset += 16 * 1024) {
      let bytes = current.bytes.subarray(offset, offset + 16 * 1024);
      if (distribution.mode === "corrupt" && offset === 0) { bytes = Buffer.from(bytes); bytes[0] ^= 1; }
      response.write(bytes);
      if (distribution.slow) await delay(50);
    }
    if (!response.destroyed) response.end();
    return;
  }
  response.writeHead(404); response.end();
});
server.on("clientError", (_error, socket) => socket.destroy());
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(lifecycleOnly ? Number(new URL(priorRuntime.origin).port) : 0, "127.0.0.1", resolve);
});
const origin = `https://localhost:${server.address().port}`;
if (lifecycleOnly) assert.equal(origin, priorRuntime.origin, "The original fixture origin must be restored exactly");
const stageOne = lifecycleOnly ? ownedPath(join(work, "stage-one")) : createDesktopStaging({ directory: ownedPath(join(work, "stage-one")), origin, publicKey, version: firstVersion, appId, productName });
const stageTwo = createDesktopStaging({ directory: ownedPath(join(work, lifecycleOnly ? `stage-two-lifecycle-${suffix}` : "stage-two")), origin, publicKey, version: secondVersion, appId, productName });
if (baselineOption) {
  const baseline = realpathSync(resolve(baselineOption.slice("--navigation-baseline=".length)));
  assert(/^windows-validation-[A-Za-z0-9]+$/.test(relative(realpathSync(temporaryRoot), baseline)), "The navigation baseline must be a previous isolated fixture");
  for (const name of ["main.mjs", "preload.cjs"]) {
    const source = join(baseline, "stage-one/src", name);
    assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink()
      && realpathSync(source).startsWith(`${baseline}${sep}`), "The navigation baseline must contain regular fixture files");
    copyFileSync(source, ownedPath(join(stageOne, "src", name)));
  }
}
const launchEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
  && !/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|BILLBOARD_DESKTOP_|CSC_|WIN_CSC_)/.test(key)));
launchEnvironment.NODE_EXTRA_CA_CERTS = tls.certificate;

async function site(application, callback, argument) {
  return application.evaluate(async ({ webContents }, { origin, source, argument }) => {
    const remote = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(`${origin}/`));
    if (!remote) throw new Error("Synthetic remote WebContentsView is not ready");
    return remote.executeJavaScript(`(${source})(${JSON.stringify(argument) ?? "undefined"})`);
  }, { origin, source: callback.toString(), argument });
}

async function launch(executablePath, applicationDirectory, pinned = true) {
  const args = [...(applicationDirectory ? [applicationDirectory] : []), ...(pinned ? [`--ignore-certificate-errors-spki-list=${tls.spki}`] : [])];
  const application = await electron.launch({ executablePath, args, env: launchEnvironment, chromiumSandbox: true, timeout: 45000 });
  running.add(application);
  const child = application.process();
  const launchNumber = ++launchCount;
  let diagnostics = "";
  child.stderr?.on("data", chunk => {
    diagnostics = (diagnostics + chunk).slice(-32768);
    if (diagnostics.includes("BB_VALIDATION_STARTUP")) evidence.startupDiagnostic = diagnostics;
  });
  child.once("exit", () => writeFileSync(join(work, `electron-${launchNumber}.log`), diagnostics.replace(/ws:\/\/\S+/g, "<isolated-debug-endpoint>")));
  if (pinned) {
    try { await waitFor(() => site(application, () => Boolean(window.fixture?.state)), "The real native bridge did not initialize"); }
    catch (error) {
      const contents = await application.evaluate(async ({ webContents }) => Promise.all(webContents.getAllWebContents().map(async value => ({
        type: value.getType(), url: value.getURL(), loading: value.isLoadingMainFrame(),
        document: await value.executeJavaScript("({ready:document.readyState,fixture:typeof window.fixture,bridge:typeof window.BillBoardDesktop,text:document.body?.innerText?.slice(0,400)})").catch(() => null),
      })))).catch(() => []);
      evidence.failedLaunch = { number: launchNumber, exitCode: child.exitCode, signal: child.signalCode, contents, serverPageRequests: distribution.sessions.length };
      throw error;
    }
  }
  return application;
}

async function metadata(application) {
  return application.evaluate(({ app }) => ({ version: app.getVersion(), profile: app.getPath("userData"), application: app.getAppPath(), packaged: app.isPackaged, name: app.getName(), executable: process.execPath, pid: process.pid }));
}

async function focus(application) {
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
}

async function command(application, command, fields = {}) {
  await site(application, ({ command, fields }) => window.fixture.post(command, fields), { command, fields });
}

async function waitState(application, status, error = undefined) {
  return waitFor(async () => {
    const state = await site(application, () => window.fixture.state);
    return state?.status === status && (error === undefined || state.error === error) ? state : null;
  }, `Expected native updater state ${status}${error ? `/${error}` : ""}`);
}

async function stop(application) {
  if (!running.has(application)) return;
  const child = application.process();
  if (!application.windows().length) {
    const script = "$validationTarget=[int]$env:BB_VALIDATION_PID; $validationProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$validationTarget); "
      + "if($validationProcess -and $validationProcess.CommandLine.IndexOf($env:BB_VALIDATION_ROOT,[StringComparison]::OrdinalIgnoreCase) -ge 0){[void](Get-Process -Id $validationTarget).CloseMainWindow()}";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true,
      env: { ...process.env, BB_VALIDATION_PID: String(child.pid), BB_VALIDATION_ROOT: canonicalWork }, timeout: 10000, stdio: "ignore" });
  }
  await site(application, () => window.fixture?.setSafety({ ready: true, busy: false, dirty: false })).catch(() => {});
  await application.close();
  running.delete(application);
  assert.equal(child.exitCode, 0, "The synthetic client did not exit normally");
}

async function assertMaterials(application) {
  const value = await site(application, () => window.fixture.readMaterials());
  assert.deepEqual(value, { uuid: pendingUuid, nonExportable: true, plaintextMatches: true });
}

async function assertNavigationBoundary(application) {
  await focus(application);
  await application.evaluate(({ dialog, webContents, ipcMain }, origin) => {
    const remote = webContents.getAllWebContents().find(value => value.getURL().startsWith(`${origin}/`));
    globalThis.billboardValidationNavigation = [];
    globalThis.billboardValidationNavigationContents = remote;
    globalThis.billboardValidationNavigationListeners = ["did-start-navigation", "did-start-loading", "did-stop-loading", "did-finish-load", "did-navigate", "did-navigate-in-page", "did-fail-load"].map(name => {
      const listener = (details, ...args) => globalThis.billboardValidationNavigation.push({ event: name, at: Date.now(), loading: remote.isLoadingMainFrame(),
        url: remote.getURL(), isMainFrame: details?.isMainFrame, isSameDocument: details?.isSameDocument, legacy: args.filter(value => ["string", "number", "boolean"].includes(typeof value)).slice(0, 4) });
      remote.on(name, listener); return [name, listener];
    });
    globalThis.billboardValidationIpcObserver = (event, raw, generation) => {
      if (event.sender !== remote) return;
      try { const value = JSON.parse(raw); globalThis.billboardValidationNavigation.push({ event: "ipc", command: value.command, probe: value.probe, generation, at: Date.now(), loading: remote.isLoadingMainFrame() }); } catch { /* Only valid synthetic bridge messages are relevant. */ }
    };
    ipcMain.on("bb:command", globalThis.billboardValidationIpcObserver);
    globalThis.billboardValidationConfirmations = 0;
    globalThis.billboardValidationOriginalDialog = dialog.showMessageBox;
    dialog.showMessageBox = async () => {
      globalThis.billboardValidationConfirmations += 1;
      globalThis.billboardValidationNavigation.push({ event: "native-confirmation", at: Date.now(), loading: remote.isLoadingMainFrame(), url: remote.getURL() });
      return { response: 0, checkboxChecked: false };
    };
  }, origin);
  try {
    const scheduled = await site(application, () => {
      const fixture = window.fixture;
      const scheduled = { nonce: fixture.documentNonce, scheduledAt: Date.now() };
      setTimeout(() => {
        const probe = { ...scheduled, emittedAt: Date.now(), documentUrl: location.href };
        fixture.post("safety", { ready: fixture.ready, busy: fixture.busy, dirty: fixture.dirty, identity: fixture.identity, probe });
        fixture.post("install", { probe });
      }, 650);
      location.assign(new URL("/slow-navigation", location.origin).href);
      return scheduled;
    });
    await waitFor(() => application.evaluate((_electron, nonce) => globalThis.billboardValidationNavigation.some(event => event.command === "install" && event.probe?.nonce === nonce), scheduled.nonce), "The old-document timer did not emit its native install attempt");
    await delay(100);
    const confirmations = await application.evaluate(() => globalThis.billboardValidationConfirmations);
    evidence.navigationProbe = await application.evaluate(() => ({ confirmations: globalThis.billboardValidationConfirmations, events: globalThis.billboardValidationNavigation }));
    const attempted = evidence.navigationProbe.events.find(event => event.command === "install" && event.probe?.nonce === scheduled.nonce);
    assert(attempted?.loading && attempted.probe.documentUrl.endsWith("/home"), "Invalid probe: the install attempt was not emitted by the old document during navigation");
    evidence.navigationProbe.validOldDocumentAttempt = true;
    assert.equal(confirmations, 0, "An old document reached native install confirmation during an unfinished navigation");
    await waitFor(() => site(application, () => location.pathname === "/slow-navigation" && Boolean(window.fixture?.state)), "Synthetic navigation did not finish");
    record("an unfinished navigation cannot revive an old document installation intent", { nativeConfirmationBoundaryStub: "cancel", confirmations });
  } finally {
    await application.evaluate(({ dialog, ipcMain }) => {
      for (const [name, listener] of globalThis.billboardValidationNavigationListeners ?? []) globalThis.billboardValidationNavigationContents.removeListener(name, listener);
      ipcMain.removeListener("bb:command", globalThis.billboardValidationIpcObserver);
      dialog.showMessageBox = globalThis.billboardValidationOriginalDialog;
      delete globalThis.billboardValidationOriginalDialog;
      delete globalThis.billboardValidationConfirmations;
      delete globalThis.billboardValidationNavigation;
      delete globalThis.billboardValidationNavigationContents;
      delete globalThis.billboardValidationNavigationListeners;
      delete globalThis.billboardValidationIpcObserver;
    }).catch(() => {});
  }
}

async function assertNavigationAndDownloadRecovery(application) {
  await site(application, () => { history.pushState(null, "", "/same-document#fixture"); });
  await delay(100);
  await site(application, () => { window.fixture.state = null; window.fixture.post("status"); });
  await waitFor(() => site(application, () => Boolean(window.fixture?.state)), "The bridge did not recover after same-document navigation");
  record("same-document navigation keeps the current native bridge usable");

  await application.evaluate(({ dialog, ipcMain }) => {
    globalThis.billboardValidationAbortConfirmations = 0;
    globalThis.billboardValidationAbortGenerations = [];
    globalThis.billboardValidationAbortOriginal = dialog.showMessageBox;
    dialog.showMessageBox = async () => { globalThis.billboardValidationAbortConfirmations += 1; return { response: 0, checkboxChecked: false }; };
    globalThis.billboardValidationAbortObserver = (_event, raw, generation) => {
      try { const value = JSON.parse(raw); globalThis.billboardValidationAbortGenerations.push({ command: value.command, generation, probe: value.probe }); } catch { /* Observe only the synthetic bridge. */ }
    };
    ipcMain.on("bb:command", globalThis.billboardValidationAbortObserver);
  });
  try {
    await command(application, "status");
    await site(application, () => {
      const fixture = window.fixture;
      setTimeout(() => {
        fixture.post("safety", { ready: fixture.ready, busy: fixture.busy, dirty: fixture.dirty, identity: fixture.identity });
        fixture.post("install", { probe: "aborted-navigation-old-intent" });
        window.stop();
      }, 250);
      location.assign(new URL("/slow-stop", location.origin).href);
      return true;
    });
    await waitFor(() => application.evaluate(() => globalThis.billboardValidationAbortGenerations.some(value => value.probe === "aborted-navigation-old-intent")), "The pre-scheduled abort probe did not run");
    await site(application, () => { window.fixture.state = null; window.fixture.heartbeat(); window.fixture.post("status"); });
    await waitFor(() => site(application, () => Boolean(window.fixture?.state)), "The bridge did not recover after window.stop cancelled navigation");
    const result = await application.evaluate(() => ({ confirmations: globalThis.billboardValidationAbortConfirmations,
      generationAdvanced: globalThis.billboardValidationAbortGenerations[0]?.generation !== globalThis.billboardValidationAbortGenerations.at(-1)?.generation }));
    assert.equal(result.confirmations, 0, "A cancelled navigation revived the old install intent");
    assert.equal(result.generationAdvanced, true, "Cancelling a navigation reused the original document generation");
    record("window.stop invalidates the old intent and permits fresh status and safety in a new native generation", result);
  } finally {
    await application.evaluate(({ dialog, ipcMain }) => {
      dialog.showMessageBox = globalThis.billboardValidationAbortOriginal;
      ipcMain.removeListener("bb:command", globalThis.billboardValidationAbortObserver);
      delete globalThis.billboardValidationAbortOriginal;
      delete globalThis.billboardValidationAbortObserver;
      delete globalThis.billboardValidationAbortGenerations;
      delete globalThis.billboardValidationAbortConfirmations;
    });
  }

  const savePath = ownedPath(join(work, "saved-fixture.json"));
  await application.evaluate(({ session }, path) => {
    globalThis.billboardValidationDownload = null;
    session.fromPartition("persist:billboard").once("will-download", (_event, item) => {
      item.setSavePath(path);
      item.once("done", (_event, state) => { globalThis.billboardValidationDownload = { state, path: item.getSavePath() }; });
    });
  }, savePath);
  await site(application, () => {
    location.assign(new URL("/fixture/export.json", location.origin).href);
    return true;
  });
  const saved = await waitFor(() => application.evaluate(() => globalThis.billboardValidationDownload), "Native file download did not complete");
  assert.equal(saved.state, "completed"); assert.equal(saved.path, savePath);
  assert.deepEqual(JSON.parse(readFileSync(savePath, "utf8")), { synthetic: true, kind: "saved-fixture" });
  await site(application, () => { window.fixture.state = null; window.fixture.post("status"); });
  await waitFor(() => site(application, () => Boolean(window.fixture?.state)), "The bridge was stranded after a normal file download");
  record("a native file download saves exact content and does not strand the current document bridge", { savePathSelection: "fixed synthetic path; operating-system save dialog not exercised" });
  await application.evaluate(() => { delete globalThis.billboardValidationDownload; });
}

async function bridgeChecks() {
  process.stdout.write("Running real Electron bridge, TLS, persistence and update checks\n");
  for (let attempt = 0; attempt < startupProbes; attempt += 1) {
    const untrustedStage = createDesktopStaging({ directory: ownedPath(join(work, `stage-untrusted-tls-${attempt}`)), origin, publicKey, version: firstVersion,
      appId: `${appId}tls${attempt}`, productName: `${productName} TLS ${attempt}` });
    const diagnosticFile = join(untrustedStage, "src/main.mjs");
    const originalSource = readFileSync(diagnosticFile, "utf8");
    const diagnosticSource = originalSource.replace("void start().catch(async () => {", "void start().catch(async (error) => { process.stderr.write('BB_VALIDATION_STARTUP ' + String(error?.stack ?? error) + '\\n');");
    assert.notEqual(diagnosticSource, originalSource, "The fixture startup diagnostic boundary no longer matches the source");
    writeFileSync(diagnosticFile, diagnosticSource);
    const untrusted = await launch(electronExecutable, untrustedStage, false);
    const host = await untrusted.firstWindow();
    await host.locator("#retry").waitFor({ state: "visible", timeout: 20000 });
    await stop(untrusted);
  }
  record("TLS rejects the untrusted certificate without a synthetic SPKI pin", { startupProbes });

  let application = await launch(electronExecutable, stageOne);
  await focus(application);
  const initial = await metadata(application);
  assert(initial.profile.endsWith(appId), "The validation profile is not isolated by its appId");
  assert.equal((await site(application, () => window.fixture.state)).installedVersion, firstVersion);
  const boundaries = await site(application, () => ({ bridge: typeof window.BillBoardDesktop?.postMessage === "function", node: typeof window.require,
    process: typeof window.process, iframeBridge: typeof document.querySelector("iframe").contentWindow.BillBoardDesktop }));
  assert.deepEqual(boundaries, { bridge: true, node: "undefined", process: "undefined", iframeBridge: "undefined" });
  record("sandboxed main-frame bridge and iframe isolation", { actualVersion: initial.version, profile: initial.profile,
    remotePageAttached: application.context().pages().some(page => page.url().startsWith(`${origin}/`)),
    attachedPageCount: application.context().pages().length });
  const devices = await site(application, async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return { audioInputs: devices.filter(device => device.kind === "audioinput").length, videoInputs: devices.filter(device => device.kind === "videoinput").length };
  });
  record("real Chromium input-device inventory", devices);
  if (!devices.audioInputs) evidence.limitations.push("Chromium enumerated zero audioinput devices; real microphone recording cannot be verified on this host.");
  assert.equal(await site(application, () => Notification.requestPermission()), "denied");
  record("unneeded notification permission is denied by the native boundary");

  await site(application, () => window.fixture.login());
  await waitFor(async () => application.evaluate(async ({ session }, origin) => (await session.fromPartition("persist:billboard").cookies.get({ url: origin })).some(cookie => cookie.name === "__Secure-authjs.session-token"), origin), "Synthetic cookie was not stored");
  await site(application, uuid => window.fixture.seedMaterials(uuid), pendingUuid);
  await assertMaterials(application);
  await stop(application);
  application = await launch(electronExecutable, stageOne);
  assert.equal(distribution.sessions.at(-1), true, "The initial request after restart did not restore the original HttpOnly cookie");
  await assertMaterials(application);
  record("normal restart preserves the HttpOnly cookie, non-exportable IndexedDB key and original pending UUID");

  distribution.mode = "tampered";
  await command(application, "check");
  await waitState(application, "error", "invalid");
  record("real HTTPS updater rejects a tampered Ed25519 manifest");
  distribution.mode = "corrupt";
  await command(application, "check"); await waitState(application, "available");
  await command(application, "download"); await waitState(application, "error", "invalid");
  record("real HTTPS updater rejects installer bytes that differ from their signed digest");
  distribution.mode = "valid";
  await command(application, "check"); await waitState(application, "available");
  await command(application, "download"); await waitState(application, "ready");
  await site(application, () => window.fixture.setSafety({ busy: true }));
  await command(application, "install"); await waitState(application, "error", "busy");
  assert.equal((await metadata(application)).version, firstVersion);
  await site(application, () => window.fixture.setSafety({ busy: false }));
  record("busy native installation is refused without quitting or executing the downloaded payload");

  await command(application, "check"); await waitState(application, "available");
  await command(application, "download"); await waitState(application, "ready");
  await assertNavigationBoundary(application);
  await assertNavigationAndDownloadRecovery(application);

  await command(application, "check"); await waitState(application, "available");
  distribution.slow = true;
  const originalTaskRequests = distribution.downloadSessions.length;
  await command(application, "download"); await waitState(application, "downloading");
  await site(application, () => window.fixture.login(true));
  await waitState(application, "idle");
  assert(distribution.downloadSessions.slice(originalTaskRequests).length > 0
    && distribution.downloadSessions.slice(originalTaskRequests).every(session => session === "one"), "An update request followed a replacement login");
  assert.equal((await metadata(application)).version, firstVersion);
  record("a replaced Cookie cancels the original in-flight update instead of rebinding it");
  await command(application, "check"); await waitState(application, "available");
  await command(application, "download"); await waitState(application, "downloading");
  await command(application, "cancel"); await waitState(application, "error", "cancelled");
  record("cancelling a real HTTPS download retains the current client");
  distribution.slow = false;
  distribution.mode = "revoked";
  await command(application, "check"); await waitState(application, "error", "auth");
  assert.equal((await metadata(application)).version, firstVersion);
  record("the original Cookie cannot authorize an update after server-side revocation");
  distribution.mode = "valid";
  await site(application, () => window.fixture.login());
  await waitState(application, "idle");
  await stop(application);
}

function inspectWindowsRegistration(installDirectory) {
  const script = "$ErrorActionPreference='Stop'; $name=$env:BB_VALIDATION_PRODUCT; $target=$env:BB_VALIDATION_INSTALL; "
    + "$expected='\"'+(Join-Path $target ('Uninstall '+$name+'.exe'))+'\" /currentuser'; "
    + "$entries=@(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -and $_.DisplayName.StartsWith($name+' ') -and $_.UninstallString -eq $expected }); "
    + "$shell=New-Object -ComObject WScript.Shell; $desktop=Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) ($name+'.lnk'); $menu=Join-Path (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs') ($name+'.lnk'); "
    + "$desktopTarget=$null; if(Test-Path -LiteralPath $desktop){$desktopTarget=$shell.CreateShortcut($desktop).TargetPath}; $menuTarget=$null; if(Test-Path -LiteralPath $menu){$menuTarget=$shell.CreateShortcut($menu).TargetPath}; "
    + "@{count=$entries.Count;version=if($entries.Count -eq 1){$entries[0].DisplayVersion}else{$null};desktopTarget=$desktopTarget;menuTarget=$menuTarget} | ConvertTo-Json -Compress";
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...process.env, BB_VALIDATION_PRODUCT: productName, BB_VALIDATION_INSTALL: installDirectory }, encoding: "utf8", timeout: 20000,
  }));
}

async function runInstaller(path, arguments_, timeout = 120000) {
  const executable = ownedPath(path);
  assert(lstatSync(executable).isFile() && !lstatSync(executable).isSymbolicLink(), "The synthetic installer must be an owned regular file");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.unref();
      evidence.activeInstallerPid = child.pid;
      reject(new Error("Synthetic installer exceeded its bounded wait; it was not forcibly terminated"));
    }, timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function installerChecks() {
  process.stdout.write(lifecycleOnly ? "Reusing the isolated first installer and building the final target\n" : "Building two isolated NSIS installers\n");
  const firstInstaller = lifecycleOnly ? ownedPath(join(work, `installer-one/BillBoard-${firstVersion}-x64.exe`))
    : buildDesktopInstaller({ stageDirectory: stageOne, outputDirectory: ownedPath(join(work, "installer-one")) });
  const fingerprint = directory => {
    const hash = createHash("sha256");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "The native validation source must be regular files");
      hash.update(name); hash.update(readFileSync(path));
    }
    return hash.digest("hex");
  };
  evidence.targetNativeSourceSha256 = fingerprint(join(stageTwo, "src"));
  const secondInstaller = buildDesktopInstaller({ stageDirectory: stageTwo, outputDirectory: ownedPath(join(work, lifecycleOnly ? `installer-lifecycle-${suffix}` : "installer-two")) });
  assert.equal(fingerprint(join(root, "desktop/src")), evidence.targetNativeSourceSha256, "Native source changed during target construction; retain the artifact and rebuild the target from the final source");
  for (const [path, version] of [[firstInstaller, firstVersion], [secondInstaller, secondVersion]]) {
    const embedded = await inspectDesktopInstaller(path, { expectedOrigin: origin });
    assert.equal(embedded.appId, appId); assert.equal(embedded.version, version);
    assert.equal(embedded.publicKeyFingerprint, publicKeyFingerprint(publicKey));
  }
  const installDirectory = ownedPath(join(work, "installed"));
  const executable = ownedPath(join(installDirectory, `${productName}.exe`));
  assert(!existsSync(executable) && (lifecycleOnly || !existsSync(installDirectory)), "The synthetic client must not already be installed");
  let result = await runInstaller(firstInstaller, ["/S", "/currentuser", `/D=${installDirectory}`]);
  assert.equal(result.code, 0, "The first real NSIS installation failed");
  assert(existsSync(executable), "NSIS reported success without installing the expected executable");
  let registration = inspectWindowsRegistration(installDirectory);
  assert.equal(registration.count, 1); assert.equal(registration.version, firstVersion);
  assert.equal(registration.desktopTarget?.toLowerCase(), executable.toLowerCase());
  assert.equal(registration.menuTarget?.toLowerCase(), executable.toLowerCase());
  let application = await launch(executable);
  let actual = await metadata(application);
  assert.equal(actual.version, firstVersion); assert.equal(actual.packaged, true);
  if (lifecycleOnly) {
    const retained = await site(application, () => window.fixture.readMaterials());
    assert(retained?.nonExportable && retained.plaintextMatches && typeof retained.uuid === "string", "The reused fixture has no retained synthetic materials");
    pendingUuid = retained.uuid;
    assert.equal(distribution.sessions.at(-1), true, "The reused fixture did not retain its original Cookie");
  }
  await assertMaterials(application);
  record("NSIS installs the actual packaged first version with desktop, Start menu and uninstall entries", { actualVersion: actual.version, profile: actual.profile });

  const pid = actual.pid;
  result = await runInstaller(secondInstaller, ["/S", "/currentuser", `/D=${installDirectory}`], 60000);
  assert.notEqual(result.code, 0, "A running client was overwritten by manual setup");
  const retained = await metadata(application);
  assert.equal(retained.pid, pid);
  assert.equal(retained.version, firstVersion);
  assert.equal(inspectWindowsRegistration(installDirectory).version, firstVersion);
  record("manual NSIS upgrade refuses a running client without killing it", { installerExitCode: result.code, actualVersion: firstVersion });
  await stop(application);

  result = await runInstaller(secondInstaller, ["/S", "/currentuser", `/D=${installDirectory}`]);
  assert.equal(result.code, 0, "The real NSIS coverage upgrade failed after normal exit");
  application = await launch(executable);
  actual = await metadata(application);
  assert.equal(actual.version, secondVersion); assert.equal(actual.packaged, true);
  assert.equal((await site(application, () => window.fixture.state)).installedVersion, secondVersion);
  assert.equal(distribution.sessions.at(-1), true);
  await assertMaterials(application);
  if (!lifecycleOnly) {
    distribution.artifactPath = secondInstaller;
    await command(application, "check"); await waitState(application, "idle");
  }
  record("real NSIS coverage upgrade restores the original Cookie, CryptoKey and UUID and reports the installed second version", { actualVersion: actual.version, profile: actual.profile });
  await stop(application);

  const uninstaller = ownedPath(join(installDirectory, `Uninstall ${productName}.exe`));
  result = await runInstaller(uninstaller, ["/S", "/currentuser", `_?=${installDirectory}`]);
  assert.equal(result.code, 0); assert(!existsSync(executable));
  registration = inspectWindowsRegistration(installDirectory);
  assert.equal(registration.count, 0); assert.equal(registration.desktopTarget, null); assert.equal(registration.menuTarget, null);
  assert(existsSync(actual.profile), "Ordinary uninstall removed the isolated persistent user data");
  result = await runInstaller(secondInstaller, ["/S", "/currentuser", `/D=${installDirectory}`]);
  assert.equal(result.code, 0);
  application = await launch(executable);
  await assertMaterials(application);
  assert.equal(distribution.sessions.at(-1), true);
  assert.equal((await metadata(application)).version, secondVersion);
  record("ordinary uninstall removes only the fixture installation and retains materials for reinstall");
  await stop(application);
  result = await runInstaller(uninstaller, ["/S", "/currentuser", `_?=${installDirectory}`]);
  assert.equal(result.code, 0);
  assert.equal(inspectWindowsRegistration(installDirectory).count, 0);
}

try {
  if (!lifecycleOnly) await bridgeChecks();
  if (!bridgeOnly) await installerChecks();
  evidence.completed = true;
  record("validation finished");
  process.stdout.write(`Evidence: ${relative(root, evidencePath).replaceAll("\\", "/")}\n`);
} catch (error) {
  evidence.completed = false;
  evidence.error = error.message;
  evidence.failureStack = error.stack;
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  process.stderr.write(`Windows validation failed: ${error.message}\nEvidence: ${relative(root, evidencePath).replaceAll("\\", "/")}\n`);
  process.exitCode = 1;
} finally {
  for (const application of running) await stop(application).catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
