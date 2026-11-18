import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopManifest } from "@/lib/desktop-update-manifest.mjs";
import { GET as metadataGet } from "@/app/api/windows/update/route";
import { GET as installerGet } from "@/app/api/windows/update/[sha256]/route";

const { requireAppSessionMock } = vi.hoisted(() => ({ requireAppSessionMock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: requireAppSessionMock }));

const keys = generateKeyPairSync("ed25519");
const installer = Buffer.alloc(256 * 1024, 0x53);
installer.write("MZ synthetic Windows installer");
const sha256 = createHash("sha256").update(installer).digest("hex");
const release = {
  schema: 1, productId: "com.billboard.desktop", platform: "win32", arch: "x64",
  version: "1.57.0", size: installer.length, sha256,
  notes: { "zh-CN": "支持 Windows 应用内更新", "en-US": "Support Windows in-app updates" },
};
const originalSession = { id: "user-1", appSessionId: "session-1", householdId: "household-1", memberId: "member-1" };
let repository: string;
let published: string;
const responses = new Set<Response>();

async function getUpdate(signal?: AbortSignal) {
  const response = await metadataGet(new Request("https://billboard.example/api/windows/update", { signal }));
  responses.add(response);
  return response;
}

async function download(value = sha256, signal?: AbortSignal) {
  const response = await installerGet(new Request(`https://billboard.example/api/windows/update/${value}`, { signal }), {
    params: Promise.resolve({ sha256: value }),
  });
  responses.add(response);
  return response;
}

async function publish() {
  await writeFile(join(published, `${sha256}.exe`), installer);
  const envelope = createDesktopManifest(release, keys.privateKey);
  const bytes = Buffer.from(` ${JSON.stringify(envelope)}\n`);
  await writeFile(join(published, "latest.json"), bytes);
  return { envelope, bytes };
}

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("location")).toBeNull();
}

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "billboard-windows-update-"));
  published = join(repository, "tmp/releases/windows/published");
  await mkdir(published, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(repository);
  requireAppSessionMock.mockResolvedValue(originalSession);
});

afterEach(async () => {
  for (const response of responses) {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
  responses.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  requireAppSessionMock.mockReset();
  await rm(repository, { recursive: true, force: true });
});

describe("authenticated Windows release distribution", () => {
  it("returns private 401 responses before revealing whether an artifact exists", async () => {
    requireAppSessionMock.mockRejectedValue(new Error("Unauthorized"));
    for (const response of [await getUpdate(), await download(), await download("../latest.json")]) {
      expect(response.status).toBe(401);
      expectPrivate(response);
      expect(await response.text()).toBe("");
    }
  });

  it("denies accounts without the original valid household membership or AppSession", async () => {
    await publish();
    for (const invalid of [
      { ...originalSession, householdId: undefined }, { ...originalSession, memberId: undefined },
      { ...originalSession, appSessionId: undefined },
    ]) {
      requireAppSessionMock.mockResolvedValue(invalid);
      expect((await getUpdate()).status).toBe(401);
      expect((await download()).status).toBe(401);
    }
  });

  it("returns 404 for unpublished, incomplete and absent private release directories", async () => {
    expect((await getUpdate()).status).toBe(404);
    expect((await download()).status).toBe(404);
    await writeFile(join(published, "latest.json"), JSON.stringify(createDesktopManifest(release, keys.privateKey)));
    expect((await getUpdate()).status).toBe(404);
    await rm(published, { recursive: true });
    expect((await getUpdate()).status).toBe(404);
    expect((await download()).status).toBe(404);
  });

  it("returns the exact signed envelope and streams the exact installer bytes with private headers", async () => {
    const { bytes } = await publish();
    const metadata = await getUpdate();
    expect(metadata.status).toBe(200);
    expectPrivate(metadata);
    expect(Buffer.from(await metadata.arrayBuffer())).toEqual(bytes);
    const binary = await download();
    expect(binary.status).toBe(200);
    expectPrivate(binary);
    expect(binary.headers.get("content-type")).toBe("application/octet-stream");
    expect(binary.headers.get("content-disposition")).toBe('attachment; filename="BillBoard-Setup.exe"');
    expect(binary.headers.get("content-length")).toBe(String(installer.length));
    expect(Buffer.from(await binary.arrayBuffer())).toEqual(installer);
  });

  it.each(["../latest.json", "a".repeat(63), "A".repeat(64), `${sha256}.exe`, `${sha256}%2f..`])("rejects noncanonical artifact path case %#", async (value) => {
    const response = await download(value);
    expect(response.status).toBe(404);
    expectPrivate(response);
  });

  it("rejects oversized metadata and installers, invalid schema and corrupt installer content", async () => {
    await publish();
    for (const invalid of [
      Buffer.alloc(64 * 1024 + 1, 0x20),
      Buffer.from(JSON.stringify({ ...createDesktopManifest(release, keys.privateKey), publicKey: "untrusted" })),
      Buffer.from(JSON.stringify({ payload: Buffer.from(JSON.stringify({ ...release, platform: "linux" })).toString("base64"), signature: Buffer.alloc(64).toString("base64") })),
      Buffer.from(JSON.stringify(createDesktopManifest({ ...release, size: release.size + 1 }, keys.privateKey))),
    ]) {
      await writeFile(join(published, "latest.json"), invalid);
      expect((await getUpdate()).status).toBe(404);
    }
    await publish();
    await writeFile(join(published, `${sha256}.exe`), Buffer.alloc(installer.length, 0x45));
    expect((await download()).status).toBe(404);
    expect((await getUpdate()).status).toBe(404);
    await truncate(join(published, `${sha256}.exe`), 256 * 1024 * 1024 + 1);
    expect((await download()).status).toBe(404);
    expect((await getUpdate()).status).toBe(404);
  });

  it("never follows release directory symlinks or ancestor junctions outside the private root", async () => {
    const outside = join(repository, "outside");
    await mkdir(outside);
    await writeFile(join(outside, `${sha256}.exe`), installer);
    await writeFile(join(outside, "latest.json"), JSON.stringify(createDesktopManifest(release, keys.privateKey)));
    await rm(published, { recursive: true });
    await symlink(outside, published, process.platform === "win32" ? "junction" : "dir");
    expect((await getUpdate()).status).toBe(404);
    expect((await download()).status).toBe(404);
    expect(await readFile(join(outside, `${sha256}.exe`))).toEqual(installer);
    await rm(published);
    await rm(join(repository, "tmp/releases/windows"), { recursive: true });
    await mkdir(join(outside, "published"));
    await writeFile(join(outside, "published", `${sha256}.exe`), installer);
    await symlink(outside, join(repository, "tmp/releases/windows"), process.platform === "win32" ? "junction" : "dir");
    expect((await download()).status).toBe(404);
  });

  it("keeps original digest artifacts downloadable after latest.json advances", async () => {
    await publish();
    await writeFile(join(published, "latest.json"), "invalid atomic-publish fixture");
    expect((await getUpdate()).status).toBe(404);
    const binary = await download();
    expect(binary.status).toBe(200);
    expect(Buffer.from(await binary.arrayBuffer())).toEqual(installer);
  });

  it("fails a stream if its artifact path is replaced after validation and releases the file resource", async () => {
    await publish();
    requireAppSessionMock.mockResolvedValueOnce(originalSession).mockImplementationOnce(async () => {
      await rename(join(published, `${sha256}.exe`), join(published, "retained.exe"));
      await writeFile(join(published, `${sha256}.exe`), Buffer.alloc(installer.length, 0x45));
      return originalSession;
    });
    const response = await download();
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    await publish();
    const resumed = await download();
    expect(resumed.status).toBe(200);
    expect(Buffer.from(await resumed.arrayBuffer())).toEqual(installer);
  });

  it("refuses a replaced or invalid session after artifact validation rather than rebinding a request", async () => {
    await publish();
    requireAppSessionMock.mockResolvedValueOnce(originalSession).mockResolvedValueOnce({ ...originalSession, appSessionId: "session-2" });
    expect((await getUpdate()).status).toBe(401);
    requireAppSessionMock.mockResolvedValueOnce(originalSession).mockRejectedValueOnce(new Error("Revoked original session"));
    expect((await download()).status).toBe(401);
  });

  it("bounds installer streams to two per process and releases capacity on consumer cancellation", async () => {
    await publish();
    const first = await download();
    const second = await download();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const busy = await download();
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    expectPrivate(busy);
    expect((await getUpdate()).status).toBe(503);
    await first.body!.cancel();
    const resumed = await download();
    expect(resumed.status).toBe(200);
    expect(Buffer.from(await resumed.arrayBuffer())).toEqual(installer);
  });

  it("releases active streams after request abort and denies requests that were already aborted", async () => {
    await publish();
    const abort = new AbortController();
    const first = await download(sha256, abort.signal);
    const second = await download();
    abort.abort();
    await expect(first.arrayBuffer()).rejects.toThrow();
    const resumed = await download();
    expect(resumed.status).toBe(200);
    await resumed.body!.cancel();
    await second.body!.cancel();
    expect((await download(sha256, abort.signal)).status).toBe(408);
    expect((await getUpdate(abort.signal)).status).toBe(408);
  });

  it("expires stalled streams after ten minutes and frees both resource slots", async () => {
    await publish();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = await download();
    const second = await download();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await expect(first.arrayBuffer()).rejects.toThrow();
    await expect(second.arrayBuffer()).rejects.toThrow();
    const resumed = await download();
    expect(resumed.status).toBe(200);
    expect(Buffer.from(await resumed.arrayBuffer())).toEqual(installer);
  });
});
