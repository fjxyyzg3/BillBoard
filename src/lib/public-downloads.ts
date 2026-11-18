import type { Stats } from "node:fs";
import { MAX_ANDROID_APK_BYTES, parseAndroidUpdateManifest } from "./android-update-manifest.mjs";
import { MAX_DESKTOP_INSTALLER_BYTES, MAX_DESKTOP_MANIFEST_BYTES, parseDesktopEnvelope, parseDesktopRelease } from "./desktop-update-manifest.mjs";
import type { DownloadAvailability, DownloadCatalog, DownloadPlatform } from "./download-types";
import {
  openReleaseArtifact, readReleaseManifest, releaseDeadline, reserveReleaseFile, sameReleaseFile,
  streamReleaseArtifact, verifyReleaseArtifact, type ReleaseFailure, type ReleaseFile,
} from "./release-files";

type CurrentRelease = { version: string; size: number; sha256: string; minSdk?: number };
const rejectedArtifacts: Partial<Record<DownloadPlatform, { path: string; info: Stats }>> = {};

function maximumArtifactBytes(platform: DownloadPlatform) {
  return platform === "android" ? MAX_ANDROID_APK_BYTES : MAX_DESKTOP_INSTALLER_BYTES;
}

async function readCurrentRelease(platform: DownloadPlatform, signal: AbortSignal): Promise<CurrentRelease> {
  const bytes = await readReleaseManifest(platform, platform === "android" ? 32 * 1024 : MAX_DESKTOP_MANIFEST_BYTES, signal);
  if (platform === "android") {
    const release = parseAndroidUpdateManifest(JSON.parse(bytes.toString("utf8")));
    return { version: release.versionName, size: release.size, sha256: release.sha256, minSdk: release.minSdk };
  }
  const envelope = parseDesktopEnvelope(bytes);
  // Publication verifies the signature; native clients still authenticate the original envelope with their pinned key.
  const release = parseDesktopRelease(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(envelope.payload, "base64"))));
  return { version: release.version, size: release.size, sha256: release.sha256 };
}

function isRejected(platform: DownloadPlatform, file: ReleaseFile) {
  const rejected = rejectedArtifacts[platform];
  return rejected?.path === file.path && sameReleaseFile(rejected.info, file.info);
}

async function availability(platform: DownloadPlatform, requestSignal: AbortSignal): Promise<DownloadAvailability> {
  const releaseSlot = reserveReleaseFile();
  if (!releaseSlot) return { status: "busy" };
  const operation = releaseDeadline(requestSignal, 30_000);
  let file: ReleaseFile | undefined;
  try {
    const release = await readCurrentRelease(platform, operation.signal);
    file = await openReleaseArtifact(platform, release.sha256, maximumArtifactBytes(platform), operation.signal);
    if (file.info.size !== release.size || isRejected(platform, file)) return { status: "unavailable" };
    operation.signal.throwIfAborted();
    // Catalog reads inspect only bounded metadata and file identity; downloads verify the complete bytes.
    return { status: "available", version: release.version, size: release.size, ...(release.minSdk ? { minSdk: release.minSdk } : {}) };
  } catch {
    return { status: operation.signal.aborted ? "busy" : "unavailable" };
  } finally {
    try { await file?.handle.close(); } finally { releaseSlot(); operation.clear(); }
  }
}

export async function readDownloadCatalog(signal: AbortSignal): Promise<DownloadCatalog> {
  // Leave one file slot free for a replacement request while a cancelled catalog is still closing files.
  const android = await availability("android", signal);
  const windows = await availability("windows", signal);
  return { android, windows };
}

export async function streamPublicDownload(platform: DownloadPlatform, requestSignal: AbortSignal) {
  if (requestSignal.aborted) return { status: "cancelled" } as ReleaseFailure;
  const releaseSlot = reserveReleaseFile();
  if (!releaseSlot) return { status: "busy" } as ReleaseFailure;
  const operation = releaseDeadline(requestSignal, 10 * 60_000);
  let file: ReleaseFile | undefined;
  try {
    const release = await readCurrentRelease(platform, operation.signal);
    file = await openReleaseArtifact(platform, release.sha256, maximumArtifactBytes(platform), operation.signal);
    if (file.info.size !== release.size || isRejected(platform, file)) throw new Error("Unavailable public download");
    if (!await verifyReleaseArtifact(file, release.sha256, operation.signal)) {
      // Remember only the latest rejected file per platform; a replaced artifact is inspected afresh.
      rejectedArtifacts[platform] = { path: file.path, info: file.info };
      throw new Error("Unavailable public download");
    }
    operation.signal.throwIfAborted();
    delete rejectedArtifacts[platform];
    return { status: "ok" as const, body: streamReleaseArtifact(file, release.sha256, operation, releaseSlot), release };
  } catch {
    try { await file?.handle.close(); } finally { releaseSlot(); operation.clear(); }
    return { status: operation.signal.aborted ? "cancelled" : "missing" } as ReleaseFailure;
  }
}
