import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { DESKTOP_PRODUCT_ID, parseDesktopRelease } from "../../src/lib/desktop-update-manifest.mjs";
import { validateDesktopVersion } from "./build-config.mjs";
import { desktopEnvironment, desktopGitState, releaseRoot, repoRoot, reportDesktopFailure } from "./environment.mjs";
import { inspectDesktopInstaller } from "./inspect-installer.mjs";
import { inspectDesktopArtifact, publishVerifiedExe, validateDesktopBuildProvenance } from "./publish-release.mjs";

try {
  const { values } = parseArgs({ options: {
    metadata: { type: "string" }, "notes-zh": { type: "string" }, "notes-en": { type: "string" },
  } });
  if (!values.metadata || !values["notes-zh"]?.trim() || !values["notes-en"]?.trim()) {
    throw new Error("Usage: npm run desktop:publish -- --metadata <private-build-metadata.json> --notes-zh <Chinese notes> --notes-en <English notes>");
  }
  const metadataPath = resolve(repoRoot, values.metadata);
  const info = lstatSync(metadataPath);
  const local = relative(realpathSync(releaseRoot), realpathSync(metadataPath));
  const equalPath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 64 * 1024
    || !local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)
    || !equalPath(realpathSync(metadataPath), metadataPath)) {
    throw new Error("Windows installer metadata must be a bounded regular file in the private release directory");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  validateDesktopVersion(metadata.version);
  if (metadata.filename !== `BillBoard-${metadata.version}-x64.exe` || metadata.productId !== DESKTOP_PRODUCT_ID
    || metadata.appId !== DESKTOP_PRODUCT_ID || metadata.platform !== "win32" || metadata.arch !== "x64") {
    throw new Error("Windows installer metadata does not describe the fixed release application");
  }
  const environment = desktopEnvironment();
  validateDesktopBuildProvenance(metadata, desktopGitState());
  const source = join(dirname(metadataPath), metadata.filename);
  const actual = inspectDesktopArtifact(source);
  const embedded = await inspectDesktopInstaller(source, { expectedOrigin: environment.origin });
  if (actual.sha256 !== metadata.sha256 || actual.size !== metadata.size || embedded.version !== metadata.version
    || embedded.appId !== DESKTOP_PRODUCT_ID || embedded.productId !== DESKTOP_PRODUCT_ID
    || embedded.publicKeyFingerprint !== environment.publicKeyFingerprint
    || metadata.publicKeyFingerprint !== environment.publicKeyFingerprint) {
    throw new Error("Windows installer integrity, embedded version or signing identity does not match the release");
  }
  const release = parseDesktopRelease({
    schema: 1, productId: DESKTOP_PRODUCT_ID, platform: "win32", arch: "x64", version: metadata.version,
    ...actual, notes: { "zh-CN": values["notes-zh"], "en-US": values["notes-en"] },
  });
  validateDesktopBuildProvenance(metadata, desktopGitState());
  publishVerifiedExe({ source, directory: join(releaseRoot, "published"), release, privateKey: environment.privateKey });
  process.stdout.write(`Published private Windows update ${release.version}\nSHA-256: ${release.sha256}\n`);
} catch (error) {
  reportDesktopFailure(error, "Desktop publication failed before completion; inspect the private artifact, signing configuration and Git state");
}
