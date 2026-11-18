import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDesktopManifest } from "../../src/lib/desktop-update-manifest.mjs";

const updaterModule = await import("../src/updater.mjs").catch(() => ({}));
const binary = Buffer.from("MZsynthetic-Windows-installer-fixture");
const keys = generateKeyPairSync("ed25519");
const release = { schema: 1, productId: "com.billboard.desktop", platform: "win32", arch: "x64", version: "1.57.1", size: binary.length,
  sha256: createHash("sha256").update(binary).digest("hex"), notes: { "zh-CN": "测试更新", "en-US": "Test update" } };
const envelope = createDesktopManifest(release, keys.privateKey);

async function fixture(t, overrides = {}) {
  assert.equal(typeof updaterModule.DesktopUpdater, "function", "Missing native updater");
  const directory = await mkdtemp(join(tmpdir(), "billboard-desktop-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const state = { cookie: "authjs.session-token=original", safety: { ready: true, busy: false, dirty: false, identity: "original-member", at: Date.now() }, confirmed: true, focused: true };
  const updater = new updaterModule.DesktopUpdater({ origin: "https://billboard.example", publicKey: keys.publicKey, version: "1.57.0", cacheDirectory: directory,
    getCookie: async () => state.cookie, getSafety: () => ({ ...state.safety, at: Date.now() }), isFocused: () => state.focused,
    prepare: async () => { calls.push("prepare"); return { ...state.safety, at: Date.now() }; }, release: () => calls.push("release"),
    confirmInstall: async () => state.confirmed, launchInstaller: async path => { calls.push(["launch", path]); }, quit: () => calls.push("quit"),
    fetcher: async (url, options) => {
      calls.push(["fetch", String(url), options.headers.Cookie]);
      return String(url).endsWith("/api/windows/update") ? Response.json(envelope) : new Response(binary, { headers: { "Content-Length": String(binary.length) } });
    }, ...overrides });
  return { updater, directory, calls, state };
}

test("download never installs without a separate explicit installation and confirmation", async t => {
  const f = await fixture(t);
  await f.updater.check();
  assert.equal(f.updater.snapshot().status, "available");
  await f.updater.download();
  assert.equal(f.updater.snapshot().status, "ready");
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === "launch"), false);
  await f.updater.install();
  assert.equal(f.calls.filter(call => call === "prepare").length, 2);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === "launch").length, 1);
  assert(f.calls.includes("quit"));
  assert(f.calls.filter(call => Array.isArray(call) && call[0] === "fetch").every(call => call[2] === "authjs.session-token=original"));
});

test("a wrong verification key is rejected before an installer can be downloaded", async t => {
  const f = await fixture(t, { publicKey: generateKeyPairSync("ed25519").publicKey });
  await f.updater.check();
  assert.equal(f.updater.snapshot().error, "invalid");
  assert.equal((await readdir(f.directory)).length, 0);
});

test("new login cookies cannot authorize a previously downloaded task", async t => {
  const f = await fixture(t);
  await f.updater.check(); await f.updater.download();
  f.state.cookie = "authjs.session-token=new-login";
  await f.updater.install();
  assert.equal(f.updater.snapshot().error, "auth");
  assert(!f.calls.includes("quit"));
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith(".exe")).length, 0);
});

test("revocation after download is checked using the original session before execution", async t => {
  let checks = 0;
  const f = await fixture(t, { fetcher: async url => String(url).endsWith("/api/windows/update")
    ? (++checks === 1 ? Response.json(envelope) : new Response(null, { status: 401 })) : new Response(binary) });
  await f.updater.check(); await f.updater.download(); await f.updater.install();
  assert.equal(f.updater.snapshot().error, "auth");
  assert(!f.calls.includes("quit"));
});

test("busy or unknown page state prevents installation", async t => {
  const f = await fixture(t);
  await f.updater.check(); await f.updater.download();
  f.state.safety.busy = true;
  await f.updater.install();
  assert.equal(f.updater.snapshot().error, "busy");
  assert(!f.calls.includes("quit"));
  f.state.safety = null;
  await f.updater.install();
  assert(!f.calls.includes("quit"));
});

test("cancelling the native confirmation releases the page and preserves the old application", async t => {
  let statusDuringConfirmation;
  const f = await fixture(t, { confirmInstall: async () => {
    statusDuringConfirmation = f.updater.snapshot().status;
    return false;
  } });
  await f.updater.check(); await f.updater.download();
  f.state.confirmed = false;
  await f.updater.install();
  assert.equal(statusDuringConfirmation, "installing");
  assert.equal(f.updater.snapshot().status, "ready");
  assert(!f.calls.includes("quit"));
  assert(f.calls.includes("release"));
});

test("a fresh prepared state catches new work started during native confirmation", async t => {
  let prepares = 0;
  const f = await fixture(t, { prepare: async () => ({ ready: true, busy: ++prepares > 1, dirty: false, identity: "original-member", at: Date.now() }) });
  await f.updater.check(); await f.updater.download(); await f.updater.install();
  assert.equal(f.updater.snapshot().error, "busy");
  assert(!f.calls.includes("quit"));
});

test("a modified cached installer is rejected immediately before execution", async t => {
  const f = await fixture(t);
  await f.updater.check(); await f.updater.download();
  await writeFile(join(f.directory, `${release.sha256}.exe`), Buffer.from("MZmodified"));
  await f.updater.install();
  assert.equal(f.updater.snapshot().error, "invalid");
  assert(!f.calls.includes("quit"));
});

test("a size or digest mismatch never leaves a ready executable", async t => {
  const f = await fixture(t, { fetcher: async url => String(url).endsWith("/api/windows/update") ? Response.json(envelope) : new Response(Buffer.from("MZwrong")) });
  await f.updater.check(); await f.updater.download();
  assert.equal(f.updater.snapshot().error, "invalid");
  assert.equal((await readdir(f.directory)).length, 0);
});

test("redirected update responses cannot change the trusted download origin", async t => {
  const f = await fixture(t, { fetcher: async () => new Response(null, { status: 302, headers: { Location: "https://evil.test/payload" } }) });
  await f.updater.check();
  assert.equal(f.updater.snapshot().error, "invalid");
});

test("cancelling a slow binary stream stops work and removes incomplete bytes", async t => {
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const f = await fixture(t, { fetcher: async url => String(url).endsWith("/api/windows/update") ? Response.json(envelope)
    : new Response(new ReadableStream({ start(controller) { controller.enqueue(binary.subarray(0, 2)); bodyStarted(); } })) });
  await f.updater.check();
  const pending = f.updater.download();
  await started;
  await f.updater.cancel();
  await pending;
  assert(!f.calls.includes("quit"));
  assert.equal((await readdir(f.directory)).filter(name => /\.(part|exe)$/.test(name)).length, 0);
});
