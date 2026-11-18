import { createPublicKey } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  DESKTOP_APP_ID, DESKTOP_ELECTRON_VERSION, protectDesktopPrivatePath, publicKeyFingerprint, validateDesktopAppIdentity,
  validateDesktopOrigin, validateDesktopVersion,
} from "./build-config.mjs";
import {
  desktopEnvironment, desktopGitState, desktopRoot, isMainModule, releaseRoot, repoRoot,
  reportDesktopFailure, runDesktopTool,
} from "./environment.mjs";
import { inspectDesktopArtifact, validateDesktopBuildProvenance } from "./publish-release.mjs";
import { inspectDesktopInstaller } from "./inspect-installer.mjs";

function copyApplicationTree(source, destination) {
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) {
    throw new Error("Desktop release source must contain only regular application files");
  }
  mkdirSync(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyApplicationTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error("Desktop release source must contain only regular application files");
  }
}

export function createDesktopStaging({ directory, origin: inputOrigin, publicKey: inputKey, version: inputVersion,
  appId = DESKTOP_APP_ID, productName = "BillBoard", repositoryRoot = repoRoot }) {
  const origin = validateDesktopOrigin(inputOrigin);
  const version = validateDesktopVersion(inputVersion);
  validateDesktopAppIdentity(appId, origin);
  if (!/^[A-Za-z0-9 -]{1,64}$/.test(productName) || (appId === DESKTOP_APP_ID && productName !== "BillBoard")) {
    throw new Error("Desktop release product name must match its fixed identity");
  }
  const publicKey = createPublicKey(inputKey).export({ type: "spki", format: "pem" }).toString();
  publicKeyFingerprint(publicKey);
  const output = resolve(directory);
  if (existsSync(output)) throw new Error("Desktop release staging directory must be new");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  protectDesktopPrivatePath(output, { directory: true });
  copyApplicationTree(join(repositoryRoot, "desktop/src"), join(output, "src"));
  mkdirSync(join(output, "shared"));
  copyFileSync(join(repositoryRoot, "src/lib/desktop-update-manifest.mjs"), join(output, "shared/desktop-update-manifest.mjs"));
  const runtime = { origin, publicKey, productId: DESKTOP_APP_ID, version, appId };
  writeFileSync(join(output, "runtime-config.json"), JSON.stringify(runtime, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  writeFileSync(join(output, "package.json"), JSON.stringify({
    name: appId === DESKTOP_APP_ID ? "billboard-desktop" : `billboard-desktop-validation-${appId.split(".").at(-1)}`,
    version, private: true, description: "BillBoard Windows desktop client", author: "BillBoard",
    type: "module", main: "src/main.mjs", productName,
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return output;
}

export function buildDesktopInstaller({ stageDirectory, outputDirectory }) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Desktop release construction requires the verified Windows x64 build environment");
  }
  const stage = resolve(stageDirectory);
  const output = resolve(outputDirectory);
  const runtime = JSON.parse(readFileSync(join(stage, "runtime-config.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
  validateDesktopOrigin(runtime.origin);
  validateDesktopAppIdentity(runtime.appId, runtime.origin);
  validateDesktopVersion(runtime.version);
  publicKeyFingerprint(runtime.publicKey);
  if (runtime.productId !== DESKTOP_APP_ID || pkg.version !== runtime.version || pkg.main !== "src/main.mjs") {
    throw new Error("Desktop release staged version and product identity do not match");
  }
  if (!/^[A-Za-z0-9 -]{1,64}$/.test(pkg.productName) || (runtime.appId === DESKTOP_APP_ID && pkg.productName !== "BillBoard")) {
    throw new Error("Desktop release product name must match its fixed identity");
  }
  const require = createRequire(join(desktopRoot, "package.json"));
  const base = require(join(desktopRoot, "electron-builder.cjs"));
  const config = {
    ...base, appId: runtime.appId, productName: pkg.productName, executableName: pkg.productName,
    directories: { app: stage, output, buildResources: join(desktopRoot, "build") },
    electronDist: join(desktopRoot, "node_modules/electron/dist"), electronVersion: DESKTOP_ELECTRON_VERSION,
    win: { ...base.win, icon: join(repoRoot, "public/icons/icon-512.png") },
    nsis: { ...base.nsis, include: join(desktopRoot, "installer.nsh") },
  };
  const configDirectory = mkdtempSync(join(dirname(stage), "config-"));
  const configFile = join(configDirectory, "builder.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  protectDesktopPrivatePath(output, { directory: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BILLBOARD_DESKTOP_|CSC_|WIN_CSC_)/.test(key)));
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  runDesktopTool(process.execPath, [
    join(desktopRoot, "node_modules/electron-builder/out/cli/cli.js"), "--projectDir", desktopRoot,
    "--config", configFile, "--win", "nsis", "--x64", "--publish", "never",
  ], { cwd: desktopRoot, privateValues: [runtime.origin], env });
  const installer = join(output, `BillBoard-${runtime.version}-x64.exe`);
  inspectDesktopArtifact(installer);
  return installer;
}

async function main() {
  const environment = desktopEnvironment();
  const state = desktopGitState();
  const source = { sourceCommit: state.commit, sourceDirty: state.dirty };
  validateDesktopBuildProvenance(source, state);
  const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  if (desktopPackage.version !== version) throw new Error("Desktop release version must match the root project version");
  mkdirSync(join(desktopRoot, "build"), { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(desktopRoot, "build/release-"));
  const stageDirectory = createDesktopStaging({ directory: join(work, "app"), origin: environment.origin,
    publicKey: environment.publicKey, version });
  const sourceFile = buildDesktopInstaller({ stageDirectory, outputDirectory: join(work, "output") });
  const { size, sha256 } = inspectDesktopArtifact(sourceFile);
  const embedded = await inspectDesktopInstaller(sourceFile, { expectedOrigin: environment.origin });
  if (embedded.version !== version || embedded.appId !== DESKTOP_APP_ID || embedded.productId !== DESKTOP_APP_ID
    || embedded.publicKeyFingerprint !== environment.publicKeyFingerprint) {
    throw new Error("Windows installer embedded version or signing identity does not match the release");
  }
  // Recheck after the build; a concurrent source edit invalidates formal release provenance.
  validateDesktopBuildProvenance(source, desktopGitState());
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  protectDesktopPrivatePath(releaseRoot, { directory: true });
  const filename = `BillBoard-${version}-x64.exe`;
  const destination = join(releaseRoot, filename);
  if (existsSync(destination)) throw new Error("Desktop release output already exists; retain it and review the existing artifact before rebuilding");
  copyFileSync(sourceFile, destination);
  writeFileSync(`${destination}.sha256`, `${sha256}  ${filename}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(`${destination}.json`, JSON.stringify({
    filename, version, productId: DESKTOP_APP_ID, appId: DESKTOP_APP_ID, platform: "win32", arch: "x64",
    size, sha256, publicKeyFingerprint: environment.publicKeyFingerprint, ...source,
    builtAt: new Date().toISOString(),
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(`Verified private Windows installer: tmp/releases/windows/${filename}\nSHA-256: ${sha256}\n`);
}

if (isMainModule(import.meta.url)) {
  try { await main(); } catch (error) {
    reportDesktopFailure(error, "Desktop release construction failed; inspect the private configuration, Git state and local toolchain");
  }
}
