import { createHash, generateKeyPairSync } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopManifest } from "@/lib/desktop-update-manifest.mjs";
import { GET as catalogGet } from "@/app/api/downloads/route";
import { GET as downloadGet } from "@/app/api/downloads/[platform]/route";
import * as downloadRoute from "@/app/api/downloads/[platform]/route";
import { GET as nativeWindowsGet } from "@/app/api/windows/update/[sha256]/route";

const { requireAppSessionMock } = vi.hoisted(() => ({ requireAppSessionMock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: requireAppSessionMock }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));

const keys = generateKeyPairSync("ed25519");
const apk = Buffer.alloc(256 * 1024, 0x41);
apk.write("PK synthetic Android installer");
const exe = Buffer.alloc(256 * 1024, 0x53);
exe.write("MZ synthetic Windows installer");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Platform = "android" | "windows";
const responses = new Set<Response>();
let repository: string;

function directory(platform: Platform) {
  return join(repository, `tmp/releases/${platform}/published`);
}

function artifact(platform: Platform, bytes = platform === "android" ? apk : exe) {
  return join(directory(platform), `${digest(bytes)}.${platform === "android" ? "apk" : "exe"}`);
}

async function publish(platform: Platform, bytes = platform === "android" ? apk : exe, version = "1.57.0") {
  const common = { size: bytes.length, sha256: digest(bytes), notes: { "zh-CN": "安装应用", "en-US": "Install the app" } };
  const manifest = platform === "android"
    ? { ...common, versionName: version, versionCode: 1057000, minSdk: 29, sourceCommit: "private-build-metadata" }
    : createDesktopManifest({ ...common, schema: 1, productId: "com.billboard.desktop", platform: "win32", arch: "x64", version }, keys.privateKey);
  await writeFile(artifact(platform, bytes), bytes);
  await writeFile(join(directory(platform), "next.json"), JSON.stringify(manifest));
  await rename(join(directory(platform), "next.json"), join(directory(platform), "latest.json"));
}

async function catalog(signal?: AbortSignal) {
  const response = await catalogGet(new Request("https://billboard.example/api/downloads", { signal }));
  responses.add(response);
  return response;
}

async function download(platform: string, signal?: AbortSignal) {
  const response = await downloadGet(new Request(`https://billboard.example/api/downloads/${encodeURIComponent(platform)}`, { signal }), {
    params: Promise.resolve({ platform }),
  });
  responses.add(response);
  return response;
}

function expectHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("location")).toBeNull();
}

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "billboard-public-downloads-"));
  await Promise.all([mkdir(directory("android"), { recursive: true }), mkdir(directory("windows"), { recursive: true })]);
  vi.spyOn(process, "cwd").mockReturnValue(repository);
  vi.stubEnv("OPS_ADMIN_INSTANCE", "false");
  requireAppSessionMock.mockRejectedValue(new Error("No session"));
});

afterEach(async () => {
  for (const response of responses) {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
  responses.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  requireAppSessionMock.mockReset();
  await rm(repository, { recursive: true, force: true });
});

describe("public installation downloads", () => {
  it("exposes only installation metadata and exact published files without reading a session", async () => {
    await publish("android");
    await publish("windows");
    const metadata = await catalog();
    expect(metadata.status).toBe(200);
    expectHeaders(metadata);
    expect(await metadata.json()).toEqual({
      android: { status: "available", version: "1.57.0", size: apk.length, minSdk: 29 },
      windows: { status: "available", version: "1.57.0", size: exe.length },
    });
    for (const platform of ["android", "windows"] as const) {
      const response = await download(platform);
      expect(response.status).toBe(200);
      expectHeaders(response);
      expect(response.headers.get("content-type")).toBe(platform === "android" ? "application/vnd.android.package-archive" : "application/octet-stream");
      expect(response.headers.get("content-disposition")).toContain(platform === "android" ? "BillBoard-1.57.0.apk" : "BillBoard-1.57.0-x64.exe");
      expect(response.headers.get("content-length")).toBe(String(apk.length));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(platform === "android" ? apk : exe);
    }
    expect(requireAppSessionMock).not.toHaveBeenCalled();
  });

  it("rejects OPS before resolving any release files", async () => {
    await publish("android");
    await publish("windows");
    vi.stubEnv("OPS_ADMIN_INSTANCE", "true");
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => { throw new Error("OPS must not resolve release files"); });
    cwd.mockClear();
    for (const response of [await catalog(), await download("android"), await download("windows")]) {
      expect(response.status).toBe(404);
      expectHeaders(response);
      expect(await response.text()).toBe("");
    }
    expect(cwd).not.toHaveBeenCalled();
    expect(requireAppSessionMock).not.toHaveBeenCalled();
  });

  it("inspects catalog metadata without reading complete installer contents", async () => {
    await publish("android");
    await publish("windows");
    const open = fileSystem.open;
    const installerReads: Array<{ mock: { calls: unknown[] } }> = [];
    vi.spyOn(fileSystem, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (/\.(?:apk|exe)$/.test(String(args[0]))) installerReads.push(vi.spyOn(file, "read"));
      return file;
    });
    expect((await catalog()).status).toBe(200);
    expect((await catalog()).status).toBe(200);
    expect(installerReads).toHaveLength(4);
    expect(installerReads.every(read => read.mock.calls.length === 0)).toBe(true);
    expect(Buffer.from(await (await download("windows")).arrayBuffer())).toEqual(exe);
    expect(installerReads.some(read => read.mock.calls.length > 0)).toBe(true);
  });

  it("isolates unavailable platforms and never serves an orphaned artifact without a valid latest manifest", async () => {
    await publish("windows");
    await writeFile(artifact("android"), apk);
    expect(await (await catalog()).json()).toEqual({
      android: { status: "unavailable" }, windows: { status: "available", version: "1.57.0", size: exe.length },
    });
    expect((await download("android")).status).toBe(404);
    await writeFile(join(directory("windows"), "latest.json"), "invalid");
    expect((await download("windows")).status).toBe(404);
    await rm(directory("windows"), { recursive: true });
    expect(await (await catalog()).json()).toEqual({ android: { status: "unavailable" }, windows: { status: "unavailable" } });
  });

  it.each(["../latest.json", "linux", "Android", "windows.exe", digest(apk)])("rejects unsupported platform %s", async platform => {
    await publish("android");
    expect((await download(platform)).status).toBe(404);
  });

  it.each(["android", "windows"] as const)("rejects oversized, missing and corrupted %s artifacts", async platform => {
    await publish(platform);
    await writeFile(artifact(platform), Buffer.alloc(apk.length, 0x58));
    expect((await download(platform)).status).toBe(404);
    expect((await (await catalog()).json())[platform]).toEqual({ status: "unavailable" });
    await publish(platform);
    expect((await (await catalog()).json())[platform].status).toBe("available");
    await truncate(artifact(platform), (platform === "android" ? 100 : 256) * 1024 * 1024 + 1);
    expect((await download(platform)).status).toBe(404);
    expect((await (await catalog()).json())[platform]).toEqual({ status: "unavailable" });
    await rm(artifact(platform));
    expect((await download(platform)).status).toBe(404);
  });

  it.each(["android", "windows"] as const)("refuses %s directory symlinks and ancestor junctions", async platform => {
    await publish(platform);
    const outside = join(repository, `outside-${platform}`);
    await rename(directory(platform), outside);
    await symlink(outside, directory(platform), process.platform === "win32" ? "junction" : "dir");
    expect((await download(platform)).status).toBe(404);
    expect((await (await catalog()).json())[platform]).toEqual({ status: "unavailable" });
    await rm(directory(platform));
    await rm(join(repository, `tmp/releases/${platform}`), { recursive: true });
    await mkdir(join(outside, "published"));
    await symlink(outside, join(repository, `tmp/releases/${platform}`), process.platform === "win32" ? "junction" : "dir");
    expect((await download(platform)).status).toBe(404);
    expect(await readFile(join(outside, `${digest(platform === "android" ? apk : exe)}.${platform === "android" ? "apk" : "exe"}`))).toEqual(platform === "android" ? apk : exe);
  });

  it("pins an accepted download while stable links follow the next atomic publication", async () => {
    await publish("windows");
    const first = await download("windows");
    const next = Buffer.alloc(exe.length, 0x4e);
    await publish("windows", next, "1.58.0");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(exe);
    const second = await download("windows");
    expect(second.headers.get("content-disposition")).toContain("1.58.0");
    expect(Buffer.from(await second.arrayBuffer())).toEqual(next);
    expect((await (await catalog()).json()).windows.version).toBe("1.58.0");
  });

  it("fails a download if its validated path is replaced while streaming", async () => {
    await publish("android");
    const response = await download("android");
    await rename(artifact("android"), join(directory("android"), "retained.apk"));
    await writeFile(artifact("android"), Buffer.alloc(apk.length, 0x58));
    await expect(response.arrayBuffer()).rejects.toThrow();
    await publish("android");
    expect(Buffer.from(await (await download("android")).arrayBuffer())).toEqual(apk);
  });

  it("shares two bounded file slots between both public platforms and the native Windows endpoint", async () => {
    await publish("android");
    await publish("windows");
    const first = await download("android");
    const second = await download("windows");
    const busy = await download("android");
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(await (await catalog()).json()).toEqual({ android: { status: "busy" }, windows: { status: "busy" } });
    requireAppSessionMock.mockResolvedValue({ id: "user", appSessionId: "session", householdId: "household", memberId: "member" });
    const native = await nativeWindowsGet(new Request("https://billboard.example/api/windows/update/fixture"), { params: Promise.resolve({ sha256: digest(exe) }) });
    responses.add(native);
    expect(native.status).toBe(503);
    await first.body!.cancel();
    expect(Buffer.from(await (await download("android")).arrayBuffer())).toEqual(apk);
    await second.body!.cancel();
  });

  it("does not leave download streams open when handling HEAD requests", async () => {
    await publish("android");
    await publish("windows");
    // Next delegates HEAD to GET when no explicit HEAD handler exists, then omits its body.
    const handler = "HEAD" in downloadRoute ? downloadRoute.HEAD as typeof downloadGet : downloadGet;
    const heads: Response[] = [];
    for (const platform of ["android", "windows"]) {
      const response = await handler(new Request(`https://billboard.example/api/downloads/${platform}`, { method: "HEAD" }), {
        params: Promise.resolve({ platform }),
      });
      responses.add(response);
      heads.push(response);
      expect(response.status).toBe(200);
      expectHeaders(response);
    }
    const android = await download("android");
    const windows = await download("windows");
    expect(android.status).toBe(200);
    expect(windows.status).toBe(200);
    expect(heads.every(response => response.body === null)).toBe(true);
  });

  it("releases capacity when clients disconnect and rejects already cancelled requests", async () => {
    await publish("android");
    await publish("windows");
    const abort = new AbortController();
    const first = await download("android", abort.signal);
    const second = await download("windows");
    abort.abort();
    await expect(first.arrayBuffer()).rejects.toThrow();
    expect(Buffer.from(await (await download("android")).arrayBuffer())).toEqual(apk);
    await second.body!.cancel();
    expect((await download("android", abort.signal)).status).toBe(408);
    expect((await catalog(abort.signal)).status).toBe(408);
  });

  it("allows a replacement catalog request while a cancelled request releases its files", async () => {
    await publish("android");
    await publish("windows");
    const abort = new AbortController();
    const cancelled = catalog(abort.signal);
    abort.abort();
    const replacement = await catalog();
    expect(replacement.status).toBe(200);
    expect(await replacement.json()).toEqual({
      android: { status: "available", version: "1.57.0", size: apk.length, minSdk: 29 },
      windows: { status: "available", version: "1.57.0", size: exe.length },
    });
    expect((await cancelled).status).toBe(408);
  });

  it("expires stalled public downloads and reclaims their file resources", async () => {
    await publish("android");
    await publish("windows");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = await download("android");
    const second = await download("windows");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await expect(first.arrayBuffer()).rejects.toThrow();
    await expect(second.arrayBuffer()).rejects.toThrow();
    expect(Buffer.from(await (await download("android")).arrayBuffer())).toEqual(apk);
  });
});
