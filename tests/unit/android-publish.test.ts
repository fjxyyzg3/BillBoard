import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApkBadging, publishVerifiedApk, validateBuildProvenance } from "../../ops/android/publish-release.mjs";

const directories: string[] = [];
const { renameFailure } = vi.hoisted(() => ({ renameFailure: { active: false } }));
vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs")>();
  return { ...filesystem, renameSync: (...args: Parameters<typeof filesystem.renameSync>) => {
    if (renameFailure.active) throw new Error("Simulated filesystem rename failure");
    return filesystem.renameSync(...args);
  } };
});
afterEach(() => {
  renameFailure.active = false;
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function fixture(versionCode = 1047000) {
  const directory = mkdtempSync(join(tmpdir(), "billboard-publish-"));
  directories.push(directory);
  const bytes = Buffer.from(`signed-apk-fixture-${versionCode}`);
  const source = join(directory, "source.apk");
  writeFileSync(source, bytes);
  return { source, directory: join(directory, "published"), manifest: {
    versionName: `1.47.${versionCode - 1047000}`, versionCode, minSdk: 26, size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), notes: { "zh-CN": "更新", "en-US": "Update" },
  }, bytes };
}

describe("private Android publication", () => {
  it("extracts the actual APK package/version/minimum SDK rather than the website version", () => {
    expect(parseApkBadging("package: name='com.billboard.app' versionCode='1046000' versionName='1.46.0' platformBuildVersionName='16'\nminSdkVersion:'26'\n"))
      .toEqual({ applicationId: "com.billboard.app", versionCode: 1046000, versionName: "1.46.0", minSdk: 26 });
    expect(() => parseApkBadging("package: name='com.billboard.app.debug' versionCode='1046000' versionName='1.46.0'\nsdkVersion:'26'"))
      .toThrow("APK package");
  });

  it("requires a clean master build from the current pushed commit", () => {
    const sha = "a".repeat(40);
    expect(() => validateBuildProvenance({ sourceCommit: sha, sourceDirty: false }, { branch: "master", commit: sha, remoteCommit: sha, dirty: false })).not.toThrow();
    for (const state of [{ branch: "feature" }, { dirty: true }, { remoteCommit: "b".repeat(40) }, { commit: "b".repeat(40) }]) {
      expect(() => validateBuildProvenance({ sourceCommit: sha, sourceDirty: false }, { branch: "master", commit: sha, remoteCommit: sha, dirty: false, ...state })).toThrow("clean pushed master");
    }
    expect(() => validateBuildProvenance({ sourceCommit: sha, sourceDirty: true }, { branch: "master", commit: sha, remoteCommit: sha, dirty: false })).toThrow("clean pushed master");
  });

  it("publishes immutable content before replacing latest and retains older downloads", () => {
    const first = fixture();
    publishVerifiedApk(first);
    expect(JSON.parse(readFileSync(join(first.directory, "latest.json"), "utf8"))).toEqual(first.manifest);
    expect(readFileSync(join(first.directory, `${first.manifest.sha256}.apk`))).toEqual(first.bytes);
    const second = fixture(1047001);
    publishVerifiedApk({ ...second, directory: first.directory });
    expect(JSON.parse(readFileSync(join(first.directory, "latest.json"), "utf8"))).toEqual(second.manifest);
    expect(readFileSync(join(first.directory, `${first.manifest.sha256}.apk`))).toEqual(first.bytes);
    expect(readdirSync(first.directory).sort()).toEqual([`${first.manifest.sha256}.apk`, `${second.manifest.sha256}.apk`, "latest.json"].sort());
  });

  it("leaves the current manifest unchanged when verification fails or a downgrade is attempted", () => {
    const current = fixture(1047001);
    publishVerifiedApk(current);
    const previous = readFileSync(join(current.directory, "latest.json"));
    const older = fixture();
    expect(() => publishVerifiedApk({ ...older, directory: current.directory })).toThrow("downgrade");
    writeFileSync(current.source, "tampered");
    expect(() => publishVerifiedApk(current)).toThrow("integrity");
    expect(readFileSync(join(current.directory, "latest.json"))).toEqual(previous);
  });

  it("rejects conflicting immutable files and simultaneous publication without replacing either", () => {
    const release = fixture();
    mkdirSync(release.directory);
    const target = join(release.directory, `${release.manifest.sha256}.apk`);
    writeFileSync(target, "wrong bytes");
    expect(() => publishVerifiedApk(release)).toThrow("immutable");
    expect(readFileSync(target, "utf8")).toBe("wrong bytes");
    writeFileSync(join(release.directory, ".publish.lock"), "busy");
    expect(() => publishVerifiedApk(release)).toThrow("publication is already running");
    expect(readFileSync(join(release.directory, ".publish.lock"), "utf8")).toBe("busy");
  });

  it("preserves the entire prior release when the final atomic replacement fails", () => {
    const current = fixture();
    publishVerifiedApk(current);
    const previous = readFileSync(join(current.directory, "latest.json"));
    const next = fixture(1047001);
    renameFailure.active = true;
    expect(() => publishVerifiedApk({ ...next, directory: current.directory })).toThrow("rename failure");
    expect(readFileSync(join(current.directory, "latest.json"))).toEqual(previous);
    expect(readFileSync(join(current.directory, `${current.manifest.sha256}.apk`))).toEqual(current.bytes);
    expect(readFileSync(join(current.directory, `${next.manifest.sha256}.apk`))).toEqual(next.bytes);
    expect(readdirSync(current.directory).some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
  });
});
