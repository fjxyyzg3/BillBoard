import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getUpdate } from "@/app/api/android/update/route";
import { GET as downloadApk } from "@/app/api/android/update/[sha256]/route";

const { requireAppSessionMock } = vi.hoisted(() => ({ requireAppSessionMock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: requireAppSessionMock }));

let repository: string;
let published: string;
const apk = Buffer.from("PK\u0003\u0004fixture-apk-binary\u0000\u00ff", "utf8");
const hash = createHash("sha256").update(apk).digest("hex");
const manifest = {
  versionName: "1.47.0", versionCode: 1047000, size: apk.length, sha256: hash, minSdk: 26,
  notes: { "zh-CN": "支持应用内更新", "en-US": "Support in-app updates" },
};

function download(value = hash) {
  return downloadApk(new Request(`https://billboard.example/api/android/update/${value}`), {
    params: Promise.resolve({ sha256: value }),
  });
}

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("location")).toBeNull();
}

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "billboard-android-update-"));
  published = join(repository, "tmp/releases/android/published");
  await mkdir(published, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(repository);
  requireAppSessionMock.mockResolvedValue({ id: "user-1", householdId: "household-1", memberId: "member-1" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  requireAppSessionMock.mockReset();
  await rm(repository, { recursive: true, force: true });
});

describe("authenticated Android release distribution", () => {
  it("returns 401 without redirecting or exposing release existence when the session is invalid", async () => {
    requireAppSessionMock.mockRejectedValue(new Error("Unauthorized"));
    for (const response of [await getUpdate(), await download(), await download("../latest.json")]) {
      expect(response.status).toBe(401);
      expectPrivate(response);
      expect(await response.text()).toBe("");
    }
  });

  it("returns 404 when no complete release has been published", async () => {
    expect((await getUpdate()).status).toBe(404);
    expect((await download()).status).toBe(404);
    await writeFile(join(published, "latest.json"), JSON.stringify(manifest));
    expect((await getUpdate()).status).toBe(404);
  });

  it("returns the APK's published version and exact binary with private headers", async () => {
    await writeFile(join(published, `${hash}.apk`), apk);
    await writeFile(join(published, "latest.json"), JSON.stringify({ ...manifest, sourceCommit: "private-build-details" }));
    const update = await getUpdate();
    expect(update.status).toBe(200);
    expectPrivate(update);
    expect(await update.json()).toEqual(manifest);
    const binary = await download();
    expect(binary.status).toBe(200);
    expectPrivate(binary);
    expect(binary.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(binary.headers.get("content-length")).toBe(String(apk.length));
    expect(Buffer.from(await binary.arrayBuffer())).toEqual(apk);
  });

  it.each(["../latest.json", "a".repeat(63), "A".repeat(64), `${hash}.apk`, `${hash}%2f..`])("rejects a noncanonical hash %s", async (value) => {
    const result = await download(value);
    expect(result.status).toBe(404);
    expectPrivate(result);
  });

  it("rejects corrupt, oversized or invalid release metadata and mismatched APK contents", async () => {
    await writeFile(join(published, `${hash}.apk`), apk);
    for (const invalid of [{ ...manifest, size: 100 * 1024 * 1024 + 1 }, { ...manifest, notes: { "zh-CN": "" } }, { ...manifest, minSdk: -1 }]) {
      await writeFile(join(published, "latest.json"), JSON.stringify(invalid));
      expect((await getUpdate()).status).toBe(404);
    }
    await writeFile(join(published, `${hash}.apk`), Buffer.from("corrupt"));
    expect((await download()).status).toBe(404);
    await writeFile(join(published, "latest.json"), JSON.stringify(manifest));
    expect((await getUpdate()).status).toBe(404);
  });

  it("never follows a release directory symlink outside the private distribution root", async () => {
    const outside = join(repository, "outside");
    await mkdir(outside);
    await writeFile(join(outside, `${hash}.apk`), apk);
    await writeFile(join(outside, "latest.json"), JSON.stringify(manifest));
    await rm(published, { recursive: true });
    await symlink(outside, published, process.platform === "win32" ? "junction" : "dir");
    expect((await getUpdate()).status).toBe(404);
    expect((await download()).status).toBe(404);
    expect(await readFile(join(outside, `${hash}.apk`))).toEqual(apk);
  });

  it("refuses an oversized file before loading its bytes and accepts long bilingual notes within the JSON cap", async () => {
    await writeFile(join(published, `${hash}.apk`), apk);
    const longNotes = { "zh-CN": "新".repeat(4000), "en-US": "更".repeat(4000) };
    await writeFile(join(published, "latest.json"), JSON.stringify({ ...manifest, notes: longNotes }));
    const update = await getUpdate();
    expect(update.status).toBe(200);
    expect((await update.json()).notes).toEqual(longNotes);
    await truncate(join(published, `${hash}.apk`), 100 * 1024 * 1024 + 1);
    expect((await download()).status).toBe(404);
    expect((await getUpdate()).status).toBe(404);
  });
});
