import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as desktopProtocol from "@/lib/desktop-update-manifest.mjs";
import type { DesktopRelease } from "@/lib/desktop-update-manifest.mjs";

const keys = generateKeyPairSync("ed25519");
const release: DesktopRelease = {
  schema: 1, productId: "com.billboard.desktop", platform: "win32", arch: "x64",
  version: "1.57.0", size: 1234, sha256: "a".repeat(64),
  notes: { "zh-CN": "支持 Windows 应用内更新", "en-US": "Support Windows in-app updates" },
};

async function protocol() {
  return desktopProtocol;
}

function signedPayload(bytes: Uint8Array) {
  return { payload: Buffer.from(bytes).toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64") };
}

describe("Windows update manifest signature protocol", () => {
  it("signs and verifies a strictly bounded Ed25519 release envelope", async () => {
    const { createDesktopManifest, verifyDesktopManifest, parseDesktopEnvelope } = await protocol();
    const envelope = createDesktopManifest(release, keys.privateKey);
    expect(Object.keys(envelope).sort()).toEqual(["payload", "signature"]);
    expect(Buffer.from(envelope.signature, "base64")).toHaveLength(64);
    expect(parseDesktopEnvelope(JSON.stringify(envelope))).toEqual(envelope);
    expect(verifyDesktopManifest(Buffer.from(JSON.stringify(envelope)), keys.publicKey)).toEqual(release);
  });

  it("verifies the exact original payload bytes without reserializing signed JSON", async () => {
    const { verifyDesktopManifest } = await protocol();
    const { notes, ...fields } = release;
    const bytes = Buffer.from(`  ${JSON.stringify({ notes, ...fields }, null, 2)}\n`);
    expect(verifyDesktopManifest(signedPayload(bytes), keys.publicKey)).toEqual(release);
  });

  it("rejects modified payloads, modified signatures, and a different verification key", async () => {
    const { createDesktopManifest, verifyDesktopManifest } = await protocol();
    const envelope = createDesktopManifest(release, keys.privateKey);
    expect(() => verifyDesktopManifest({ ...envelope, payload: Buffer.from(JSON.stringify({ ...release, size: release.size + 1 })).toString("base64") }, keys.publicKey)).toThrow();
    const corruptedSignature = Buffer.from(envelope.signature, "base64");
    corruptedSignature[0] ^= 1;
    expect(() => verifyDesktopManifest({ ...envelope, signature: corruptedSignature.toString("base64") }, keys.publicKey)).toThrow();
    expect(() => verifyDesktopManifest(envelope, generateKeyPairSync("ed25519").publicKey)).toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => createDesktopManifest(release, rsa.privateKey)).toThrow();
    expect(() => verifyDesktopManifest(envelope, rsa.publicKey)).toThrow();
  });

  it.each([
    { schema: 2 }, { productId: "another.desktop" }, { platform: "linux" }, { arch: "arm64" },
    { version: "1.057.0" }, { version: "1.57.0-beta" }, { version: "1.57" },
    { size: 0 }, { size: 1.5 }, { size: 256 * 1024 * 1024 + 1 },
    { sha256: "A".repeat(64) }, { sha256: "a".repeat(63) },
    { notes: { "zh-CN": "更新", "en-US": "" } },
    { notes: { "zh-CN": "更新\u0000", "en-US": "Update" } },
    { notes: { "zh-CN": "新".repeat(4001), "en-US": "Update" } },
    { notes: { ...release.notes, another: "Unexpected" } },
    { downloadUrl: "https://example.com/untrusted.exe" }, { installArguments: ["/S"] },
  ])("rejects invalid or extended release payload case %# even with a valid signature", async (invalid) => {
    const { parseDesktopRelease, verifyDesktopManifest, createDesktopManifest } = await protocol();
    const value = { ...release, ...invalid };
    expect(() => parseDesktopRelease(value)).toThrow();
    expect(() => createDesktopManifest(value, keys.privateKey)).toThrow();
    expect(() => verifyDesktopManifest(signedPayload(Buffer.from(JSON.stringify(value))), keys.publicKey)).toThrow();
  });

  it("rejects noncanonical base64, invalid UTF-8, and envelope extensions", async () => {
    const { createDesktopManifest, parseDesktopEnvelope, verifyDesktopManifest } = await protocol();
    const envelope = createDesktopManifest(release, keys.privateKey);
    for (const invalid of [
      { ...envelope, signature: `${envelope.signature}\n` },
      { ...envelope, signature: envelope.signature.replace(/=+$/, "") },
      { ...envelope, signature: Buffer.alloc(65).toString("base64") },
      { ...envelope, payload: `${envelope.payload}!` },
      { ...envelope, url: "https://example.com/file.exe" },
    ]) expect(() => parseDesktopEnvelope(invalid)).toThrow();
    expect(() => parseDesktopEnvelope(Buffer.from([0xff]))).toThrow();
    expect(() => verifyDesktopManifest(signedPayload(Buffer.from([0xff])), keys.publicKey)).toThrow();
  });

  it("enforces the outer 64 KiB and decoded 32 KiB limits before parsing payload JSON", async () => {
    const { createDesktopManifest, parseDesktopEnvelope, verifyDesktopManifest } = await protocol();
    const envelope = createDesktopManifest(release, keys.privateKey);
    expect(() => parseDesktopEnvelope(`${" ".repeat(64 * 1024)}${JSON.stringify(envelope)}`)).toThrow();
    expect(() => verifyDesktopManifest(signedPayload(Buffer.alloc(32 * 1024 + 1, 0x20)), keys.publicKey)).toThrow();
    const notes = { "zh-CN": "新".repeat(4000), "en-US": "新".repeat(4000) };
    expect(verifyDesktopManifest(createDesktopManifest({ ...release, notes }, keys.privateKey), keys.publicKey).notes).toEqual(notes);
  });

  it("compares each version segment numerically and rejects non-release versions", async () => {
    const { compareDesktopVersions } = await protocol();
    expect(compareDesktopVersions("1.9.9", "1.10.0")).toBe(-1);
    expect(compareDesktopVersions("2.0.0", "1.1000.1000")).toBe(1);
    expect(compareDesktopVersions("1.57.0", "1.57.0")).toBe(0);
    expect(compareDesktopVersions("1.10000000000000000000.0", "1.9999999999999999999.0")).toBe(1);
    for (const invalid of ["v1.57.0", "1.57.0.1", "1.057.0", "1.57.0-beta", "1.57.NaN"]) {
      expect(() => compareDesktopVersions(invalid, release.version)).toThrow();
    }
  });
});
