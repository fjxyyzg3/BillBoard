import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const toolPath = join(process.cwd(), "ops/desktop/build-config.mjs");

async function tools() {
  expect(existsSync(toolPath), "Desktop release configuration must be implemented").toBe(true);
  return import("../../ops/desktop/build-config.mjs");
}

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("Windows desktop release configuration", () => {
  it("accepts only a credential-free HTTPS root and redacts private build output", async () => {
    const { validateDesktopOrigin, redactDesktopOutput } = await tools();
    expect(validateDesktopOrigin("https://billboard.example/")).toBe("https://billboard.example");
    expect(validateDesktopOrigin("https://billboard.example:8443")).toBe("https://billboard.example:8443");
    for (const value of ["http://billboard.example", "https://user:private@billboard.example", "https://billboard.example/app",
      "https://billboard.example/?token=private", "https://billboard.example/#fragment", "https://billboard.example\\@evil.example",
      "https://billboard.example\n", "https://<private-host>"]) {
      expect(() => validateDesktopOrigin(value)).toThrow("Desktop origin must be an HTTPS root URL");
    }
    expect(redactDesktopOutput("https://private.example/login private.example secret.pem PRIVATE", ["https://private.example", "secret.pem", "PRIVATE"]))
      .toBe("<redacted>/login <redacted> <redacted> <redacted>");
  });

  it("uses a persistent Ed25519 key outside repository roots and refuses replacement", async () => {
    const { initializeDesktopSigning, loadDesktopSigningKey } = await tools();
    const directory = mkdtempSync(join(tmpdir(), "billboard-desktop-key-"));
    directories.push(directory);
    const file = join(directory, "private.pem");
    const repositoryRoots = [join(directory, "repository")];
    const first = initializeDesktopSigning(file, { repositoryRoots });
    const bytes = readFileSync(file);
    expect(first.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(loadDesktopSigningKey(file, { repositoryRoots }).publicKey).toBe(first.publicKey);
    expect(createPublicKey(bytes).asymmetricKeyType).toBe("ed25519");
    expect(() => initializeDesktopSigning(file, { repositoryRoots })).toThrow("already exists");
    expect(readFileSync(file)).toEqual(bytes);
    expect(() => initializeDesktopSigning(join(repositoryRoots[0], "private.pem"), { repositoryRoots })).toThrow("outside all repository roots");
    mkdirSync(repositoryRoots[0]);
    const alias = join(directory, "repository-alias");
    symlinkSync(repositoryRoots[0], alias, "junction");
    expect(() => initializeDesktopSigning(join(alias, "private.pem"), { repositoryRoots })).toThrow("outside all repository roots");
  });

  it("rejects another private-key algorithm and produces a fingerprint of only the public key", async () => {
    const { loadDesktopSigningKey } = await tools();
    const directory = mkdtempSync(join(tmpdir(), "billboard-desktop-key-"));
    directories.push(directory);
    const file = join(directory, "wrong.pem");
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    writeFileSync(file, key.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    expect(() => loadDesktopSigningKey(file, { repositoryRoots: [] })).toThrow("Ed25519");
  });

  it("confines validation profiles to synthetic HTTPS origins and representable Windows versions", async () => {
    const { validateDesktopAppIdentity, validateDesktopVersion } = await tools();
    expect(() => validateDesktopAppIdentity("com.billboard.desktop", "https://billboard.example")).not.toThrow();
    expect(() => validateDesktopAppIdentity("com.billboard.desktop.validation.smoke", "https://billboard.test")).not.toThrow();
    expect(() => validateDesktopAppIdentity("com.billboard.desktop.validation.smoke", "https://service.invalid")).toThrow("synthetic HTTPS origin");
    expect(() => validateDesktopAppIdentity("com.other.desktop", "https://billboard.example")).toThrow("separate validation appId");
    expect(validateDesktopVersion("1.57.0")).toBe("1.57.0");
    for (const value of ["v1.57.0", "1.57.0-beta", "1.057.0", "1.65536.0"]) {
      expect(() => validateDesktopVersion(value)).toThrow("Windows version fields");
    }
  });

  it("stages only the native source, unique shared protocol, public trust and fixed release identity", async () => {
    const { createDesktopStaging } = await import("../../ops/desktop/build-exe.mjs");
    const directory = mkdtempSync(join(tmpdir(), "billboard-desktop-stage-"));
    directories.push(directory);
    mkdirSync(join(directory, "repository/desktop/src"), { recursive: true });
    mkdirSync(join(directory, "repository/src/lib"), { recursive: true });
    writeFileSync(join(directory, "repository/desktop/src/main.mjs"), "export const native = true;\n");
    writeFileSync(join(directory, "repository/.env.desktop.local"), "PRIVATE_CONFIG_MUST_NOT_BE_PACKED\n");
    copyFileSync(join(process.cwd(), "src/lib/desktop-update-manifest.mjs"), join(directory, "repository/src/lib/desktop-update-manifest.mjs"));
    const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    const stage = createDesktopStaging({ directory: join(directory, "staging"), repositoryRoot: join(directory, "repository"),
      origin: "https://billboard.test", publicKey: key, version: "1.57.0", appId: "com.billboard.desktop.validation.smoke", productName: "BillBoard Validation" });
    expect(readdirSync(stage).sort()).toEqual(["package.json", "runtime-config.json", "shared", "src"]);
    expect(JSON.parse(readFileSync(join(stage, "runtime-config.json"), "utf8"))).toEqual({
      origin: "https://billboard.test", publicKey: key.toString(), productId: "com.billboard.desktop", version: "1.57.0",
      appId: "com.billboard.desktop.validation.smoke",
    });
    expect(JSON.parse(readFileSync(join(stage, "package.json"), "utf8")).main).toBe("src/main.mjs");
    expect(readFileSync(join(stage, "shared/desktop-update-manifest.mjs"))).toEqual(readFileSync(join(process.cwd(), "src/lib/desktop-update-manifest.mjs")));
  });
});
