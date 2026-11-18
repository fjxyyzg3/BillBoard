import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DownloadPlatform } from "./download-types";

export const releaseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

export type ReleaseFailure = { status: "missing" | "busy" | "cancelled" };
export type ReleaseFile = { handle: FileHandle; info: Stats; path: string; directory: string };
const chunkBytes = 64 * 1024;
const processState = globalThis as typeof globalThis & { billboardReleaseFiles?: { active: number } };
const releaseFiles = processState.billboardReleaseFiles ??= { active: 0 };

function releaseDirectory(platform: DownloadPlatform) {
  return resolve(process.env.NODE_ENV === "production"
    ? `/var/lib/billboard/${platform === "android" ? "android" : "windows"}-updates`
    : join(process.cwd(), `tmp/releases/${platform}/published`));
}

function samePath(first: string, second: string) {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

export function sameReleaseFile(first: Stats, second: Stats) {
  return second.isFile() && first.ino === second.ino && first.dev === second.dev && first.size === second.size
    && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

async function validDirectory(directory: string) {
  const info = await lstat(directory);
  return info.isDirectory() && !info.isSymbolicLink() && samePath(await realpath(directory), directory);
}

async function unchanged(file: ReleaseFile) {
  const info = await lstat(file.path);
  return !info.isSymbolicLink() && sameReleaseFile(file.info, info) && sameReleaseFile(file.info, await file.handle.stat())
    && await validDirectory(file.directory) && samePath(await realpath(file.path), file.path);
}

async function openReleaseFile(platform: DownloadPlatform, filename: string, maximumBytes: number, signal: AbortSignal): Promise<ReleaseFile> {
  signal.throwIfAborted();
  const directory = releaseDirectory(platform);
  if (!await validDirectory(directory)) throw new Error("Unavailable release file");
  const path = join(directory, filename);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes
    || !samePath(await realpath(path), path)) throw new Error("Unavailable release file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const file = { handle, info, path, directory };
    if (!await unchanged(file)) throw new Error("Unavailable release file");
    signal.throwIfAborted();
    return file;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function openReleaseArtifact(platform: DownloadPlatform, sha256: string, maximumBytes: number, signal: AbortSignal) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Unavailable release file");
  return openReleaseFile(platform, `${sha256}.${platform === "android" ? "apk" : "exe"}`, maximumBytes, signal);
}

export function reserveReleaseFile() {
  if (releaseFiles.active >= 2) return null;
  releaseFiles.active += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      releaseFiles.active -= 1;
    }
  };
}

export function releaseDeadline(requestSignal: AbortSignal, milliseconds: number) {
  const expiry = new AbortController();
  const timer = setTimeout(() => expiry.abort(new Error("Release request timed out")), milliseconds);
  timer.unref?.();
  return { signal: AbortSignal.any([requestSignal, expiry.signal]), clear: () => clearTimeout(timer) };
}

export async function readReleaseManifest(platform: DownloadPlatform, maximumBytes: number, signal: AbortSignal) {
  const file = await openReleaseFile(platform, "latest.json", maximumBytes, signal);
  try {
    const bytes = Buffer.alloc(file.info.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Unavailable release file");
      offset += bytesRead;
    }
    if (!await unchanged(file)) throw new Error("Unavailable release file");
    signal.throwIfAborted();
    return bytes;
  } finally {
    await file.handle.close();
  }
}

export async function verifyReleaseArtifact(file: ReleaseFile, sha256: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  const bytes = Buffer.alloc(chunkBytes);
  let offset = 0;
  while (offset < file.info.size) {
    signal.throwIfAborted();
    const { bytesRead } = await file.handle.read(bytes, 0, Math.min(bytes.length, file.info.size - offset), offset);
    if (!bytesRead) return false;
    offset += bytesRead;
    hash.update(bytes.subarray(0, bytesRead));
  }
  signal.throwIfAborted();
  return hash.digest("hex") === sha256 && await unchanged(file);
}

export function streamReleaseArtifact(file: ReleaseFile, sha256: string, operation: ReturnType<typeof releaseDeadline>, releaseSlot: () => void) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let pendingRead: Promise<unknown> | undefined;
  let finishing: Promise<void> | undefined;
  let stopped = false;
  let offset = 0;
  const hash = createHash("sha256");
  const onAbort = () => { void finish(new Error("Release request aborted or timed out")); };

  function finish(error?: Error): Promise<void> {
    if (finishing) return finishing;
    stopped = true;
    operation.signal.removeEventListener("abort", onAbort);
    operation.clear();
    finishing = (async () => {
      try { await pendingRead; } catch { /* Closing still releases the bounded file resource. */ }
      try { await file.handle.close(); } catch { error ??= new Error("Unavailable release file"); } finally { releaseSlot(); }
      if (error) controller.error(error);
    })();
    return finishing;
  }

  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      operation.signal.addEventListener("abort", onAbort, { once: true });
      if (operation.signal.aborted) onAbort();
    },
    async pull() {
      if (stopped) return;
      try {
        operation.signal.throwIfAborted();
        const bytes = new Uint8Array(Math.min(chunkBytes, file.info.size - offset));
        pendingRead = file.handle.read(bytes, 0, bytes.length, offset);
        const { bytesRead } = await pendingRead as Awaited<ReturnType<FileHandle["read"]>>;
        pendingRead = undefined;
        if (stopped) return;
        operation.signal.throwIfAborted();
        if (!bytesRead) throw new Error("Unavailable release file");
        offset += bytesRead;
        hash.update(bytes.subarray(0, bytesRead));
        controller.enqueue(bytes.subarray(0, bytesRead));
        if (offset === file.info.size) {
          if (hash.digest("hex") !== sha256 || !await unchanged(file)) throw new Error("Unavailable release file");
          if (stopped) return;
          await finish();
          controller.close();
        }
      } catch {
        await finish(new Error("Unavailable release file"));
      }
    },
    cancel() { return finish(); },
  });
}

export function releaseFailure(status: ReleaseFailure["status"]) {
  return new Response(null, {
    status: status === "busy" ? 503 : status === "cancelled" ? 408 : 404,
    headers: { ...releaseHeaders, ...(status === "busy" ? { "Retry-After": "5" } : {}) },
  });
}
