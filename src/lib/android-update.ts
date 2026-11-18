import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ANDROID_SHA256_PATTERN, MAX_ANDROID_APK_BYTES, parseAndroidUpdateManifest } from "./android-update-manifest.mjs";

export const androidUpdateHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

function releaseDirectory() {
  return process.env.NODE_ENV === "production"
    ? "/var/lib/billboard/android-updates"
    : join(process.cwd(), "tmp/releases/android/published");
}

async function readPrivateFile(filename: string, maximumBytes: number) {
  const directory = resolve(releaseDirectory());
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return null;
  const canonicalDirectory = await realpath(directory);
  const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  if (comparable(canonicalDirectory) !== comparable(directory)) return null;
  const path = join(directory, filename);
  const fileInfo = await lstat(path);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size < 1 || fileInfo.size > maximumBytes) return null;
  const file = await open(path, "r");
  try {
    const current = await file.stat();
    if (!current.isFile() || current.ino !== fileInfo.ino || current.dev !== fileInfo.dev
      || current.size !== fileInfo.size || current.size > maximumBytes) return null;
    const bytes = Buffer.allocUnsafe(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await file.read(bytes, offset, bytes.length - offset, offset);
      if (chunk.bytesRead === 0) return null;
      offset += chunk.bytesRead;
    }
    return (await file.stat()).size === current.size ? bytes : null;
  } finally {
    await file.close();
  }
}

export async function readAndroidApk(sha256: string) {
  if (!ANDROID_SHA256_PATTERN.test(sha256)) return null;
  try {
    const bytes = await readPrivateFile(`${sha256}.apk`, MAX_ANDROID_APK_BYTES);
    return bytes && createHash("sha256").update(bytes).digest("hex") === sha256 ? bytes : null;
  } catch {
    // Missing, corrupt and inaccessible private artifacts share the same response.
    return null;
  }
}

export async function readAndroidUpdate() {
  try {
    const bytes = await readPrivateFile("latest.json", 32 * 1024);
    if (!bytes) return null;
    const manifest = parseAndroidUpdateManifest(JSON.parse(bytes.toString("utf8")));
    const apk = await readAndroidApk(manifest.sha256);
    return apk?.length === manifest.size ? manifest : null;
  } catch {
    return null;
  }
}
