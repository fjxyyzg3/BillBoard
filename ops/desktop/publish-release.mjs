import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  closeSync, copyFileSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  MAX_DESKTOP_INSTALLER_BYTES, MAX_DESKTOP_MANIFEST_BYTES, compareDesktopVersions,
  createDesktopManifest, parseDesktopRelease, verifyDesktopManifest,
} from "../../src/lib/desktop-update-manifest.mjs";
import { protectDesktopPrivatePath } from "./build-config.mjs";

export function validateDesktopBuildProvenance(metadata, state) {
  if (state.branch !== "master" || state.dirty || metadata.sourceDirty !== false
    || !/^[a-f0-9]{40}$/.test(metadata.sourceCommit ?? "")
    || metadata.sourceCommit !== state.commit || state.commit !== state.remoteCommit) {
    throw new Error("Desktop publication requires a clean pushed master build matching the current commit");
  }
}

export function inspectDesktopArtifact(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_DESKTOP_INSTALLER_BYTES) {
    throw new Error("Windows installer integrity verification failed");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) {
      throw new Error("Windows installer integrity verification failed");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (!bytes) break;
      total += bytes;
      if (total > MAX_DESKTOP_INSTALLER_BYTES) throw new Error("Windows installer integrity verification failed");
      hash.update(chunk.subarray(0, bytes));
    }
    if (total !== info.size) throw new Error("Windows installer integrity verification failed");
    return { size: total, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function assertArtifact(path, release, message = "Windows installer integrity verification failed") {
  const actual = inspectDesktopArtifact(path);
  if (actual.size !== release.size || actual.sha256 !== release.sha256) throw new Error(message);
}

export function publishVerifiedExe({ source, directory, release: input, privateKey }) {
  const release = parseDesktopRelease(input);
  const envelope = createDesktopManifest(release, privateKey);
  const publicKey = createPublicKey(privateKey);
  assertArtifact(source, release);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  const comparable = (path) => process.platform === "win32" ? path.toLowerCase() : path;
  if (!info.isDirectory() || info.isSymbolicLink() || comparable(realpathSync(directory)) !== comparable(resolve(directory))) {
    throw new Error("Desktop publication directory must be a private regular directory");
  }
  protectDesktopPrivatePath(directory, { directory: true });
  const lock = join(directory, ".publish.lock");
  let lockFd;
  try {
    lockFd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Desktop publication is already running; inspect the private lock before retrying");
    throw error;
  }
  const id = randomUUID();
  const stagedExe = join(directory, `.exe-${id}.tmp`);
  const stagedManifest = join(directory, `.latest-${id}.tmp`);
  try {
    const latest = join(directory, "latest.json");
    if (existsSync(latest)) {
      let current;
      try {
        const latestInfo = lstatSync(latest);
        if (!latestInfo.isFile() || latestInfo.isSymbolicLink() || latestInfo.size > MAX_DESKTOP_MANIFEST_BYTES) throw new Error();
        current = verifyDesktopManifest(readFileSync(latest), publicKey);
      } catch {
        throw new Error("Existing Windows manifest is invalid or uses a different persistent signing key");
      }
      const comparison = compareDesktopVersions(release.version, current.version);
      if (comparison < 0) throw new Error("Desktop publication cannot downgrade an existing version");
      if (comparison === 0 && JSON.stringify(release) !== JSON.stringify(current)) {
        throw new Error("Desktop publication cannot replace an existing version with different content or notes");
      }
    }
    const destination = join(directory, `${release.sha256}.exe`);
    if (existsSync(destination)) {
      assertArtifact(destination, release, "Existing immutable Windows installer does not match its content hash");
    } else {
      copyFileSync(source, stagedExe, constants.COPYFILE_EXCL);
      assertArtifact(stagedExe, release);
      const fd = openSync(stagedExe, "r+");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      // Atomic hard-link creation cannot replace a published content hash.
      linkSync(stagedExe, destination);
    }
    const fd = openSync(stagedManifest, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(envelope, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stagedManifest, latest);
    return envelope;
  } finally {
    for (const file of [stagedExe, stagedManifest]) {
      if (existsSync(file)) unlinkSync(file);
    }
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
