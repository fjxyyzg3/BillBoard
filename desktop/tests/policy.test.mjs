import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

const policy = await import("../src/policy.mjs").catch(() => ({}));
const origin = "https://billboard.example";

test("only canonical HTTPS root origins are accepted", () => {
  assert.equal(typeof policy.validateOrigin, "function", "Missing HTTPS origin validation");
  assert.equal(policy.validateOrigin(`${origin}/`), origin);
  for (const value of ["http://billboard.example", `${origin}/home`, `${origin}?x=1`, `${origin}#x`, "https://user:password@billboard.example", "https://billboard.example\\other", " https://billboard.example", "https://billboard.example:0", "https://billboard.example\n"]) {
    assert.throws(() => policy.validateOrigin(value));
  }
});

test("trusted navigation binds scheme, host, port and rejects ambiguous URLs", () => {
  assert.equal(typeof policy.isTrustedUrl, "function", "Missing navigation isolation");
  assert.equal(policy.isTrustedUrl(`${origin}/records?from=2026-10-01`, origin), true);
  for (const value of ["https://billboard.example.evil.test", "http://billboard.example", "https://billboard.example:444/", "https://evil.test/", "file:///C:/Windows/test", "javascript:alert(1)", "https://billboard.example\\@evil.test/", "https://user@billboard.example/"]) {
    assert.equal(policy.isTrustedUrl(value, origin), false);
  }
  assert.equal(policy.isExternalHttps("https://docs.example/help", origin), true);
  assert.equal(policy.isExternalHttps("mailto:person@example.test", origin), false);
});

test("IPC requires the active WebContents main frame and current trusted document", () => {
  assert.equal(typeof policy.isTrustedSender, "function", "Missing IPC sender validation");
  const frame = { url: `${origin}/home` };
  const contents = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  assert.equal(policy.isTrustedSender({ sender: contents, senderFrame: frame }, contents, origin), true);
  assert.equal(policy.isTrustedSender({ sender: contents, senderFrame: { url: frame.url } }, contents, origin), false);
  assert.equal(policy.isTrustedSender({ sender: { ...contents }, senderFrame: frame }, contents, origin), false);
  frame.url = "https://evil.test/";
  assert.equal(policy.isTrustedSender({ sender: contents, senderFrame: frame }, contents, origin), false);
});

test("only user-requested microphone, camera and clipboard writes are eligible", () => {
  assert.equal(typeof policy.allowedPermission, "function", "Missing permission allowlist");
  assert.equal(policy.allowedPermission("media", { mediaTypes: ["audio"], isMainFrame: true, requestingUrl: `${origin}/add` }, origin), true);
  assert.equal(policy.allowedPermission("media", { mediaTypes: ["video"], isMainFrame: true, requestingUrl: `${origin}/account/household` }, origin), true);
  for (const permission of ["display-capture", "notifications", "geolocation", "midi", "fileSystem", "clipboard-read", "unknown"]) {
    assert.equal(policy.allowedPermission(permission, { isMainFrame: true, requestingUrl: origin }, origin), false);
  }
  assert.equal(policy.allowedPermission("media", { mediaTypes: ["audio"], isMainFrame: false, requestingUrl: origin }, origin), false);
  assert.equal(policy.allowedPermission("media", { mediaTypes: ["audio"], isMainFrame: true, requestingUrl: "https://evil.test" }, origin), false);
});

test("runtime configuration has a fixed product, Ed25519 public key and isolated validation profile", () => {
  assert.equal(typeof policy.validateRuntimeConfig, "function", "Missing private runtime configuration validation");
  const { publicKey } = generateKeyPairSync("ed25519");
  const config = { origin, publicKey: publicKey.export({ type: "spki", format: "pem" }), productId: "com.billboard.desktop", appId: "com.billboard.desktop", version: "1.57.0" };
  assert.equal(policy.validateRuntimeConfig(config).origin, origin);
  assert.throws(() => policy.validateRuntimeConfig({ ...config, publicKey: "not a key" }));
  assert.throws(() => policy.validateRuntimeConfig({ ...config, productId: "another.product" }));
  assert.throws(() => policy.validateRuntimeConfig({ ...config, privateKey: "secret" }));
  assert.throws(() => policy.validateRuntimeConfig({ ...config, appId: "com.billboard.desktop.validation.fixture", origin: "https://private.invalid" }));
  assert.equal(policy.validateRuntimeConfig({ ...config, appId: "com.billboard.desktop.validation.fixture" }).appId, "com.billboard.desktop.validation.fixture");
});

test("download names cannot become executable or escape the selected file location", () => {
  assert.equal(typeof policy.safeDownloadName, "function", "Missing file-save policy");
  assert.equal(policy.safeDownloadName("billboard-records_2026.xlsx"), "billboard-records_2026.xlsx");
  assert.equal(policy.safeDownloadName("billboard-recovery.json"), "billboard-recovery.json");
  for (const value of ["../secret.json", "C:\\private\\key.json", "installer.exe", "payload.xlsx.exe", "file:stream.json", "CON.json", "hidden.json "]) assert.equal(policy.safeDownloadName(value), null);
});
