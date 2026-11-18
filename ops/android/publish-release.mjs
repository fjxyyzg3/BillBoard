import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, copyFileSync, constants, existsSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { MAX_ANDROID_APK_BYTES, parseAndroidUpdateManifest } from "../../src/lib/android-update-manifest.mjs";

export function parseApkBadging(output) {
  const packageLine = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m.exec(output);
  const sdk = /^(?:minSdkVersion|sdkVersion):'(\d+)'/m.exec(output);
  if (!packageLine || packageLine[1] !== "com.billboard.app" || !sdk) {
    throw new Error("APK package and minimum SDK must match the release application");
  }
  return { applicationId: packageLine[1], versionCode: Number(packageLine[2]), versionName: packageLine[3], minSdk: Number(sdk[1]) };
}

export function validateBuildProvenance(metadata, state) {
  if (state.branch !== "master" || state.dirty || metadata.sourceDirty !== false
    || !/^[a-f0-9]{40}$/.test(metadata.sourceCommit ?? "")
    || metadata.sourceCommit !== state.commit || state.commit !== state.remoteCommit) {
    throw new Error("APK publication requires a clean pushed master build matching the current commit");
  }
}

function assertArtifact(path, manifest, message = "APK integrity verification failed") {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size !== manifest.size || file.size > MAX_ANDROID_APK_BYTES
    || createHash("sha256").update(readFileSync(path)).digest("hex") !== manifest.sha256) throw new Error(message);
}

export function publishVerifiedApk({ source, directory, manifest: input }) {
  const manifest = parseAndroidUpdateManifest(input);
  assertArtifact(source, manifest);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  const comparable = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (!info.isDirectory() || info.isSymbolicLink() || comparable(realpathSync(directory)) !== comparable(resolve(directory))) {
    throw new Error("Android publication directory must be a private regular directory");
  }
  const lock = join(directory, ".publish.lock");
  let lockFd;
  try {
    lockFd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Android publication is already running; inspect the private lock before retrying");
    throw error;
  }
  const id = randomUUID();
  const stagedApk = join(directory, `.apk-${id}.tmp`);
  const stagedManifest = join(directory, `.latest-${id}.tmp`);
  try {
    const latest = join(directory, "latest.json");
    if (existsSync(latest)) {
      const latestInfo = lstatSync(latest);
      if (!latestInfo.isFile() || latestInfo.isSymbolicLink() || latestInfo.size > 32 * 1024) {
        throw new Error("Existing Android manifest is invalid");
      }
      const current = parseAndroidUpdateManifest(JSON.parse(readFileSync(latest, "utf8")));
      if (manifest.versionCode < current.versionCode
        || (manifest.versionCode === current.versionCode && manifest.sha256 !== current.sha256)) {
        throw new Error("Android publication cannot downgrade or replace an existing versionCode");
      }
    }
    const destination = join(directory, `${manifest.sha256}.apk`);
    if (existsSync(destination)) {
      assertArtifact(destination, manifest, "Existing immutable Android APK does not match its content hash");
    } else {
      copyFileSync(source, stagedApk, constants.COPYFILE_EXCL);
      assertArtifact(stagedApk, manifest);
      const stagedFd = openSync(stagedApk, "r+");
      try { fsyncSync(stagedFd); } finally { closeSync(stagedFd); }
      // Creating a hard link is atomic and refuses to overwrite an existing hash.
      linkSync(stagedApk, destination);
    }
    const manifestFd = openSync(stagedManifest, "wx", 0o600);
    try {
      writeFileSync(manifestFd, JSON.stringify(manifest, null, 2) + "\n");
      fsyncSync(manifestFd);
    } finally {
      closeSync(manifestFd);
    }
    renameSync(stagedManifest, latest);
    return manifest;
  } finally {
    for (const path of [stagedApk, stagedManifest]) {
      if (existsSync(path)) unlinkSync(path);
    }
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
