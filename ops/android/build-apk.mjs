import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { androidVersionCode } from "./build-config.mjs";
import { androidEnvironment, repoRoot, runAndroidTool, runGradle } from "./environment.mjs";

try {
  const environment = androidEnvironment();
  const { config } = environment;
  const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const versionCode = androidVersionCode(version);
  runGradle([":app:lintRelease", ":app:testReleaseUnitTest", ":app:assembleRelease"], environment);
  const apk = join(repoRoot, "android/app/build/outputs/apk/release/app-release.apk");
  const verification = runAndroidTool(environment.java, [
    "-jar", join(config.ANDROID_HOME, "build-tools/36.0.0/lib/apksigner.jar"),
    "verify", "--verbose", "--print-certs", apk,
  ], environment, { showOutput: false });
  const certificate = runAndroidTool(join(config.JAVA_HOME, "bin", process.platform === "win32" ? "keytool.exe" : "keytool"), [
    "-exportcert", "-rfc", "-keystore", config.BILLBOARD_ANDROID_KEYSTORE, "-alias", config.BILLBOARD_ANDROID_KEY_ALIAS,
    "-storepass:env", "BILLBOARD_ANDROID_STORE_PASSWORD",
  ], environment, { showOutput: false });
  const fingerprint = new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase();
  if (!verification.includes(`certificate SHA-256 digest: ${fingerprint}`) || !verification.includes("Verified using v2 scheme (APK Signature Scheme v2): true")) {
    throw new Error("APK must be signed with the configured persistent certificate and APK Signature Scheme v2");
  }
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true }).trim();
  const bytes = readFileSync(apk);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const outputDirectory = join(repoRoot, "tmp/releases/android");
  mkdirSync(outputDirectory, { recursive: true });
  const filename = `BillBoard-${version}.apk`;
  copyFileSync(apk, join(outputDirectory, filename));
  writeFileSync(join(outputDirectory, `${filename}.sha256`), `${sha256}  ${filename}\n`);
  writeFileSync(join(outputDirectory, `${filename}.json`), JSON.stringify({
    filename, applicationId: "com.billboard.app", version, versionCode,
    sha256, signingCertificateSha256: fingerprint, bytes: bytes.length,
    sourceCommit: git(["rev-parse", "HEAD"]), sourceDirty: Boolean(git(["status", "--porcelain"])),
    builtAt: new Date().toISOString(),
  }, null, 2) + "\n");
  process.stdout.write(`Verified signed APK: tmp/releases/android/${filename}\nSHA-256: ${sha256}\n`);
} catch (error) {
  // Tool output is sanitized by the runner; unexpected native filesystem errors may contain private paths.
  const allowed = ["Android origin must", "Set JAVA_HOME", "A persistent", "Android tool failed", "APK must", "Project version"];
  process.stderr.write(`${allowed.some((prefix) => error.message.startsWith(prefix)) ? error.message : "Android release failed before publication; inspect the private local configuration and toolchain"}\n`);
  process.exitCode = 1;
}
