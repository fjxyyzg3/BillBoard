import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
const toolPath = join(process.cwd(), "ops/desktop/publish-release.mjs");
const { failure } = vi.hoisted(() => ({ failure: { rename: false } }));
vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs")>();
  return { ...filesystem, renameSync: (...args: Parameters<typeof filesystem.renameSync>) => {
    if (failure.rename) throw new Error("Simulated atomic rename failure");
    return filesystem.renameSync(...args);
  } };
});

async function tools() {
  expect(existsSync(toolPath), "Windows private publication must be implemented").toBe(true);
  return import("../../ops/desktop/publish-release.mjs");
}

afterEach(() => {
  failure.rename = false;
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function fixture(version = "1.57.0") {
  const directory = mkdtempSync(join(tmpdir(), "billboard-desktop-publish-"));
  directories.push(directory);
  const bytes = Buffer.from(`NSIS-fixture-${version}`);
  const source = join(directory, "source.exe");
  writeFileSync(source, bytes);
  return { source, directory: join(directory, "published"), release: {
    schema: 1 as const, productId: "com.billboard.desktop" as const, platform: "win32" as const, arch: "x64" as const,
    version, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    notes: { "zh-CN": "更新", "en-US": "Update" },
  }, bytes };
}

describe("private signed Windows publication", () => {
  it("requires a clean, pushed master build and the matching current SHA", async () => {
    const { validateDesktopBuildProvenance } = await tools();
    const sha = "a".repeat(40);
    const metadata = { sourceCommit: sha, sourceDirty: false };
    const state = { branch: "master", commit: sha, remoteCommit: sha, dirty: false };
    expect(() => validateDesktopBuildProvenance(metadata, state)).not.toThrow();
    for (const patch of [{ branch: "feature" }, { dirty: true }, { commit: "b".repeat(40) }, { remoteCommit: "b".repeat(40) }]) {
      expect(() => validateDesktopBuildProvenance(metadata, { ...state, ...patch })).toThrow("clean pushed master");
    }
    expect(() => validateDesktopBuildProvenance({ ...metadata, sourceDirty: true }, state)).toThrow("clean pushed master");
  });

  it("signs the exact payload, publishes immutable bytes, and retains old downloads", async () => {
    const { publishVerifiedExe } = await tools();
    const { verifyDesktopManifest } = await import("../../src/lib/desktop-update-manifest.mjs");
    const keys = generateKeyPairSync("ed25519");
    const first = fixture();
    publishVerifiedExe({ ...first, privateKey: keys.privateKey });
    const envelope = JSON.parse(readFileSync(join(first.directory, "latest.json"), "utf8"));
    expect(verifyDesktopManifest(envelope, keys.publicKey)).toEqual(first.release);
    expect(readFileSync(join(first.directory, `${first.release.sha256}.exe`))).toEqual(first.bytes);
    writeFileSync(first.source, "changed source after publication");
    expect(readFileSync(join(first.directory, `${first.release.sha256}.exe`))).toEqual(first.bytes);
    const second = fixture("1.57.1");
    publishVerifiedExe({ ...second, directory: first.directory, privateKey: keys.privateKey });
    expect(readFileSync(join(first.directory, `${first.release.sha256}.exe`))).toEqual(first.bytes);
    expect(readFileSync(join(first.directory, `${second.release.sha256}.exe`))).toEqual(second.bytes);
    expect(verifyDesktopManifest(readFileSync(join(first.directory, "latest.json")), keys.publicKey).version).toBe("1.57.1");
  });

  it("rejects downgrade, same-version replacement, changed signing keys and corrupted bytes", async () => {
    const { publishVerifiedExe } = await tools();
    const { privateKey } = generateKeyPairSync("ed25519");
    const first = fixture("1.57.1");
    publishVerifiedExe({ ...first, privateKey });
    const before = readFileSync(join(first.directory, "latest.json"));
    const downgrade = fixture("1.57.0");
    expect(() => publishVerifiedExe({ ...downgrade, directory: first.directory, privateKey })).toThrow("downgrade");
    const replacement = fixture("1.57.1");
    replacement.release.notes["en-US"] = "Replaced notes";
    expect(() => publishVerifiedExe({ ...replacement, directory: first.directory, privateKey })).toThrow("replace an existing version");
    const next = fixture("1.57.2");
    expect(() => publishVerifiedExe({ ...next, directory: first.directory, privateKey: generateKeyPairSync("ed25519").privateKey })).toThrow("Existing Windows manifest");
    writeFileSync(next.source, "corrupted bytes");
    expect(() => publishVerifiedExe({ ...next, directory: first.directory, privateKey })).toThrow("integrity");
    expect(readFileSync(join(first.directory, "latest.json"))).toEqual(before);
  });

  it("keeps the old signed latest usable after publication is interrupted", async () => {
    const { publishVerifiedExe } = await tools();
    const { privateKey } = generateKeyPairSync("ed25519");
    const first = fixture();
    publishVerifiedExe({ ...first, privateKey });
    const before = readFileSync(join(first.directory, "latest.json"));
    const next = fixture("1.57.1");
    failure.rename = true;
    expect(() => publishVerifiedExe({ ...next, directory: first.directory, privateKey })).toThrow("Simulated atomic rename failure");
    failure.rename = false;
    expect(readFileSync(join(first.directory, "latest.json"))).toEqual(before);
    expect(readFileSync(join(first.directory, `${first.release.sha256}.exe`))).toEqual(first.bytes);
    expect(readdirSync(first.directory).some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
    publishVerifiedExe({ ...next, directory: first.directory, privateKey });
  });

  it("rejects an active publication, a directory alias, and altered immutable content", async () => {
    const { publishVerifiedExe } = await tools();
    const { privateKey } = generateKeyPairSync("ed25519");
    const first = fixture();
    mkdirSync(first.directory);
    writeFileSync(join(first.directory, ".publish.lock"), "active publisher");
    expect(() => publishVerifiedExe({ ...first, privateKey })).toThrow("already running");
    rmSync(join(first.directory, ".publish.lock"));
    const alias = join(first.directory, "../alias");
    symlinkSync(first.directory, alias, "junction");
    expect(() => publishVerifiedExe({ ...first, directory: alias, privateKey })).toThrow("private regular directory");
    writeFileSync(join(first.directory, `${first.release.sha256}.exe`), "altered immutable bytes");
    expect(() => publishVerifiedExe({ ...first, privateKey })).toThrow("Existing immutable Windows installer");
    expect(existsSync(join(first.directory, "latest.json"))).toBe(false);
  });
});
