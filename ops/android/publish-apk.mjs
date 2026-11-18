import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { androidEnvironment, repoRoot, runAndroidTool } from "./environment.mjs";
import { parseApkBadging, publishVerifiedApk, validateBuildProvenance } from "./publish-release.mjs";
import { MAX_ANDROID_APK_BYTES, parseAndroidUpdateManifest } from "../../src/lib/android-update-manifest.mjs";

try {
  const { values } = parseArgs({ options: {
    metadata: { type: "string" }, "notes-zh": { type: "string" }, "notes-en": { type: "string" },
  } });
  if (!values.metadata || !values["notes-zh"]?.trim() || !values["notes-en"]?.trim()) {
    throw new Error("Usage: npm run android:publish -- --metadata <private-build-metadata.json> --notes-zh <Chinese notes> --notes-en <English notes>");
  }
  const releaseRoot = realpathSync(join(repoRoot, "tmp/releases/android"));
  const metadataPath = resolve(repoRoot, values.metadata);
  const metadataInfo = lstatSync(metadataPath);
  const localPath = relative(releaseRoot, realpathSync(metadataPath));
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 64 * 1024
    || localPath.startsWith(`..${sep}`) || localPath === ".." || resolve(releaseRoot, localPath) !== metadataPath) {
    throw new Error("APK metadata must be a regular file inside the private Android release directory");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version)
    || metadata.filename !== `BillBoard-${metadata.version}.apk` || metadata.applicationId !== "com.billboard.app") {
    throw new Error("APK metadata does not describe a BillBoard release");
  }
  const source = join(dirname(metadataPath), metadata.filename);
  const info = lstatSync(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_ANDROID_APK_BYTES
    || info.size !== metadata.bytes || createHash("sha256").update(readFileSync(source)).digest("hex") !== metadata.sha256) {
    throw new Error("APK integrity verification failed");
  }
  const environment = androidEnvironment();
  const { config } = environment;
  const verification = runAndroidTool(environment.java, [
    "-jar", join(config.ANDROID_HOME, "build-tools/36.0.0/lib/apksigner.jar"),
    "verify", "--verbose", "--print-certs", source,
  ], environment, { showOutput: false });
  const certificate = runAndroidTool(join(config.JAVA_HOME, "bin", process.platform === "win32" ? "keytool.exe" : "keytool"), [
    "-exportcert", "-rfc", "-keystore", config.BILLBOARD_ANDROID_KEYSTORE,
    "-alias", config.BILLBOARD_ANDROID_KEY_ALIAS, "-storepass:env", "BILLBOARD_ANDROID_STORE_PASSWORD",
  ], environment, { showOutput: false });
  const fingerprint = new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase();
  if (!verification.includes(`Signer #1 certificate SHA-256 digest: ${fingerprint}`)
    || !/^Number of signers: 1\s*$/m.test(verification)
    || !verification.includes("Verified using v2 scheme (APK Signature Scheme v2): true")
    || metadata.signingCertificateSha256 !== fingerprint) {
    throw new Error("APK signature does not match the configured persistent certificate");
  }
  const badging = runAndroidTool(join(config.ANDROID_HOME, "build-tools/36.0.0", process.platform === "win32" ? "aapt2.exe" : "aapt2"),
    ["dump", "badging", source], environment, { showOutput: false });
  const apk = parseApkBadging(badging);
  if (apk.versionName !== metadata.version || apk.versionCode !== metadata.versionCode) {
    throw new Error("APK version does not match its verified build metadata");
  }
  const manifest = parseAndroidUpdateManifest({ ...apk, size: info.size, sha256: metadata.sha256,
    notes: { "zh-CN": values["notes-zh"], "en-US": values["notes-en"] },
  });
  const git = (args) => execFileSync("git", args, {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const remoteCommit = git(["ls-remote", "origin", "refs/heads/master"]).split(/\s+/)[0];
  validateBuildProvenance(metadata, {
    branch: git(["branch", "--show-current"]), commit: git(["rev-parse", "HEAD"]),
    remoteCommit, dirty: Boolean(git(["status", "--porcelain"])),
  });
  publishVerifiedApk({ source, directory: join(releaseRoot, "published"), manifest });
  process.stdout.write(`Published private Android update ${manifest.versionName} (${manifest.versionCode})\nSHA-256: ${manifest.sha256}\n`);
} catch (error) {
  const allowed = ["Usage:", "APK ", "Android publication", "Invalid Android", "Existing Android", "Existing immutable"];
  process.stderr.write(`${allowed.some((prefix) => error.message.startsWith(prefix))
    ? error.message : "Android publication failed before completion; inspect the private release metadata, toolchain and Git state"}\n`);
  process.exitCode = 1;
}
