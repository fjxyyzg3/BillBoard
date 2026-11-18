import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDesktopManifest } from "../../src/lib/desktop-update-manifest.mjs";
import { DesktopUpdater } from "../src/updater.mjs";

const cookie = "authjs.session-token=original";
const bytes = Buffer.from("MZcancelled-navigation-installer");
const keys = generateKeyPairSync("ed25519");
const release = {
  schema: 1, productId: "com.billboard.desktop", platform: "win32", arch: "x64", version: "1.57.1",
  size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
  notes: { "zh-CN": "测试更新", "en-US": "Test update" },
};
const envelope = createDesktopManifest(release, keys.privateKey);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "billboard-cancellation-"));
  const state = { ready: true, cookieReads: 0, pausedRead: null, launches: 0 };
  const updater = new DesktopUpdater({
    origin: "https://billboard.example", publicKey: keys.publicKey, version: "1.57.0", cacheDirectory: directory,
    getCookie: async () => {
      state.cookieReads += 1;
      const pause = state.pausedRead;
      if (pause && --pause.remaining === 0) {
        state.pausedRead = null;
        pause.reached();
        await pause.wait;
      }
      return cookie;
    },
    getSafety: () => ({ ready: state.ready, busy: false, dirty: false, identity: "original-member", at: Date.now() }),
    isFocused: () => true,
    prepare: async () => ({ ready: state.ready, busy: false, dirty: false, identity: "original-member", at: Date.now() }),
    release: () => {}, confirmInstall: async () => true,
    launchInstaller: async () => { state.launches += 1; }, quit: () => {},
    fetcher: async (url) => String(url).endsWith("/api/windows/update") ? Response.json(envelope) : new Response(bytes),
  });
  t.after(async () => { await updater.cancel(); await rm(directory, { recursive: true, force: true }); });
  function pauseCookieRead(number) {
    let reached;
    let resume;
    const paused = new Promise(resolve => { reached = resolve; });
    const wait = new Promise(resolve => { resume = resolve; });
    state.pausedRead = { remaining: number, reached, wait };
    return { paused, resume };
  }
  return { updater, state, directory, pauseCookieRead };
}

test("navigation cancellation during the final Cookie await cannot revive an installation", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.updater.check();
  await f.updater.download();
  assert.equal(f.updater.snapshot().status, "ready");
  // Installation reads the original cookie before preparing, before reauthorization, and before launch.
  const gate = f.pauseCookieRead(3);
  const installing = f.updater.install();
  await gate.paused;
  f.state.ready = false;
  const cancelling = f.updater.cancel();
  // A same-document navigation can produce a new ready heartbeat without renewing the old intent.
  f.state.ready = true;
  gate.resume();
  await Promise.all([installing, cancelling]);
  assert.equal(f.state.launches, 0, "A cancelled operation launched its verified installer after reading the original Cookie");
  assert.equal(f.updater.snapshot().error, "cancelled");
});

test("download cancellation during its last Cookie await cannot publish a ready executable", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.updater.check();
  // Pause the authorization read after the response has been saved and flushed to its partial file.
  const gate = f.pauseCookieRead(2);
  const downloading = f.updater.download();
  await gate.paused;
  const cancelling = f.updater.cancel();
  gate.resume();
  await Promise.all([downloading, cancelling]);
  assert.notEqual(f.updater.snapshot().status, "ready", "A cancelled download became ready after its Cookie read completed");
  assert.equal(f.updater.snapshot().error, "cancelled");
  assert.deepEqual((await readdir(f.directory)).filter(name => /\.(?:exe|part)$/.test(name)), []);
  assert.equal(f.state.launches, 0);
});
