import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareDesktopVersions, MAX_DESKTOP_INSTALLER_BYTES, MAX_DESKTOP_MANIFEST_BYTES, verifyDesktopManifest } from "../shared/desktop-update-manifest.mjs";

const failure = code => Object.assign(new Error("Desktop update could not be completed"), { code });
const comparable = value => process.platform === "win32" ? value.toLowerCase() : value;

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || comparable(await realpath(directory)) !== comparable(resolve(directory))) throw failure("invalid");
}

async function removeFile(path) {
  if (path) await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
}

async function readResponse(response, maximum, signal, chunk) {
  if (response.status === 401 || response.status === 403) throw failure("auth");
  if (response.status === 404 || response.status === 429 || response.status === 503) throw failure("unavailable");
  if (response.status !== 200 || response.redirected || !response.body) throw failure("invalid");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw failure("invalid");
  const reader = response.body.getReader();
  const buffers = [];
  let count = 0;
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw failure("cancelled");
      const next = await reader.read();
      if (signal.aborted) throw failure("cancelled");
      if (next.done) break;
      count += next.value.byteLength;
      if (count > maximum) throw failure("invalid");
      if (chunk) await chunk(next.value, count);
      else buffers.push(Buffer.from(next.value));
    }
    if (!count || (declared !== null && count !== Number(declared))) throw failure("invalid");
    return chunk ? count : Buffer.concat(buffers);
  } finally {
    signal.removeEventListener("abort", stop);
    await reader.cancel().catch(() => {});
  }
}

export async function verifyInstaller(path, release) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== release.size || info.size > MAX_DESKTOP_INSTALLER_BYTES) throw failure("invalid");
  const file = await open(path, "r");
  try {
    const opened = await file.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw failure("invalid");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    while (true) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, release.size - count + 1), count);
      if (!result.bytesRead) break;
      if (!count && (buffer[0] !== 0x4d || buffer[1] !== 0x5a)) throw failure("invalid");
      count += result.bytesRead;
      if (count > release.size) throw failure("invalid");
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const final = await file.stat();
    if (count !== release.size || final.size !== info.size || final.mtimeMs !== info.mtimeMs || hash.digest("hex") !== release.sha256) throw failure("invalid");
  } finally { await file.close(); }
}

export class DesktopUpdater {
  constructor(options) {
    this.options = options;
    this.state = { status: "idle", installedVersion: options.version, release: null, progress: 0, error: null };
    this.operation = null;
    this.cookie = null;
    this.identity = null;
    this.envelope = null;
    this.readyFile = null;
  }

  snapshot() { return structuredClone(this.state); }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.options.onState?.(this.snapshot());
  }

  async cleanCache() {
    await privateDirectory(this.options.cacheDirectory);
    const names = (await readdir(this.options.cacheDirectory)).slice(0, 128);
    for (const name of names) if (/^(?:[a-f0-9]{64}\.exe|[a-f0-9-]{36}\.part)$/.test(name)) await removeFile(join(this.options.cacheDirectory, name));
  }

  safety() {
    const state = this.options.getSafety();
    if (!state?.ready || state.busy || state.dirty || typeof state.identity !== "string" || !state.identity
      || !Number.isFinite(state.at) || Date.now() - state.at > 5000 || !this.options.isFocused()) throw failure("busy");
    if (this.identity && state.identity !== this.identity) throw failure("auth");
    return state;
  }

  assertActive(operation) {
    if (this.operation !== operation || operation.controller.signal.aborted) throw failure("cancelled");
  }

  async assertSession(operation) {
    this.assertActive(operation);
    const cookie = await this.options.getCookie();
    this.assertActive(operation);
    if (!this.cookie || cookie !== this.cookie) throw failure("auth");
  }

  async request(path, operation) {
    await this.assertSession(operation);
    const response = await (this.options.fetcher ?? fetch)(`${this.options.origin}${path}`, {
      headers: { Cookie: this.cookie, "Cache-Control": "no-store" }, redirect: "error", credentials: "omit", signal: operation.controller.signal,
    });
    if (response.url && new URL(response.url).origin !== this.options.origin) throw failure("invalid");
    return response;
  }

  verify(raw) {
    try { return verifyDesktopManifest(raw, this.options.publicKey); }
    catch { throw failure("invalid"); }
  }

  async run(kind, action) {
    if (this.operation) return;
    const operation = { controller: new AbortController(), partial: null };
    this.operation = operation;
    const timer = setTimeout(() => operation.controller.abort(), kind === "download" ? 600_000 : kind === "install" ? 180_000 : 30_000);
    operation.done = (async () => {
      try { await action(operation); }
      catch (error) {
        const code = operation.controller.signal.aborted ? "cancelled" : ["auth", "invalid", "unavailable", "busy", "install", "cancelled"].includes(error.code) ? error.code : "offline";
        if (code === "auth" || code === "invalid") {
          await removeFile(this.readyFile).catch(() => {});
          this.readyFile = null;
        }
        this.setState({ status: "error", error: code, progress: 0 });
      } finally {
        clearTimeout(timer);
        await removeFile(operation.partial).catch(() => {});
        if (this.operation === operation) this.operation = null;
        if (kind === "install") this.options.release();
      }
    })();
    return operation.done;
  }

  async check() {
    return this.run("check", async operation => {
      await removeFile(this.readyFile);
      this.readyFile = null;
      this.cookie = await this.options.getCookie();
      this.identity = this.options.getSafety()?.identity ?? null;
      if (!this.cookie) throw failure("auth");
      this.setState({ status: "checking", error: null, progress: 0 });
      const response = await this.request("/api/windows/update", operation);
      const bytes = await readResponse(response, MAX_DESKTOP_MANIFEST_BYTES, operation.controller.signal);
      const release = this.verify(bytes);
      await this.assertSession(operation);
      this.assertActive(operation);
      this.envelope = bytes;
      this.setState({ status: compareDesktopVersions(release.version, this.options.version) > 0 ? "available" : "idle", release });
    });
  }

  async download() {
    if (!this.envelope || !this.state.release || compareDesktopVersions(this.state.release.version, this.options.version) <= 0) return;
    return this.run("download", async operation => {
      const release = this.verify(this.envelope);
      await privateDirectory(this.options.cacheDirectory);
      const response = await this.request(`/api/windows/update/${release.sha256}`, operation);
      this.setState({ status: "downloading", progress: 0, error: null });
      operation.partial = join(this.options.cacheDirectory, `${randomUUID()}.part`);
      const file = await open(operation.partial, "wx", 0o600);
      const hash = createHash("sha256");
      let count;
      try {
        count = await readResponse(response, release.size, operation.controller.signal, async (bytes, length) => {
          hash.update(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            const written = await file.write(bytes, offset, bytes.length - offset);
            if (!written.bytesWritten) throw failure("download");
            offset += written.bytesWritten;
          }
          this.setState({ progress: Math.min(99, Math.floor(length * 100 / release.size)) });
        });
        await file.sync();
      } finally { await file.close(); }
      if (count !== release.size || hash.digest("hex") !== release.sha256) throw failure("invalid");
      await this.assertSession(operation);
      await verifyInstaller(operation.partial, release);
      this.assertActive(operation);
      const destination = join(this.options.cacheDirectory, `${release.sha256}.exe`);
      await removeFile(destination);
      this.assertActive(operation);
      await rename(operation.partial, destination);
      operation.partial = destination;
      this.assertActive(operation);
      operation.partial = null;
      this.readyFile = destination;
      this.setState({ status: "ready", progress: 100 });
    });
  }

  async install() {
    if (!this.readyFile || !this.envelope) return;
    return this.run("install", async operation => {
      this.setState({ status: "installing", error: null });
      this.safety();
      await this.assertSession(operation);
      const initial = await this.options.prepare().catch(() => { throw failure("busy"); });
      this.assertActive(operation);
      if (!initial?.ready || initial.busy || initial.dirty || initial.identity !== this.identity) throw failure("busy");
      const confirmed = await this.options.confirmInstall();
      this.assertActive(operation);
      if (!confirmed) {
        this.setState({ status: "ready", error: null });
        return;
      }
      const prepared = await this.options.prepare().catch(() => { throw failure("busy"); });
      this.assertActive(operation);
      if (!prepared?.ready || prepared.busy || prepared.dirty || prepared.identity !== this.identity) throw failure("busy");
      this.safety();
      const auth = await this.request("/api/windows/update", operation);
      this.verify(await readResponse(auth, MAX_DESKTOP_MANIFEST_BYTES, operation.controller.signal));
      const release = this.verify(this.envelope);
      if (compareDesktopVersions(release.version, this.options.version) <= 0) throw failure("invalid");
      await privateDirectory(this.options.cacheDirectory);
      await verifyInstaller(this.readyFile, release);
      await this.assertSession(operation);
      this.safety();
      this.assertActive(operation);
      try { await this.options.launchInstaller(this.readyFile); }
      catch { throw failure("install"); }
      this.setState({ status: "installing", error: null });
      this.options.quit();
    });
  }

  async cancel() {
    const operation = this.operation;
    if (operation) {
      operation.controller.abort();
      await operation.done;
    }
    this.options.release();
  }

  async invalidate() {
    await this.cancel();
    await removeFile(this.readyFile).catch(() => {});
    this.readyFile = null;
    this.cookie = null;
    this.identity = null;
    this.envelope = null;
    this.setState({ status: "idle", release: null, error: null, progress: 0 });
  }
}
