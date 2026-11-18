import type { Dir, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordExportError } from "./input";

export const RECORD_EXPORT_TTL_MS = 180_000;
const CLEANUP_INTERVAL_MS = 10_000;
const CLEANUP_BATCH_SIZE = 64;
const DIRECTORY_NAME = /^export-(\d{13})-[A-Za-z0-9]{6}$/;
const FILE_NAME = "records.xlsx";

type PrivateDirectory = { root: string; directory: string; rootStat: Stats; stat: Stats };
type CleanupLoop = {
  root: string;
  scan?: Dir;
  rootStat?: Stats;
  running?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  stopped: boolean;
  stop: () => Promise<void>;
};
type CleanupState = { active: Set<string>; loop?: CleanupLoop };
const processState = globalThis as typeof globalThis & { billboardRecordExportCleanup?: CleanupState };
const cleanup = processState.billboardRecordExportCleanup ??= { active: new Set() };

function privateDirectory(stat: Stats) {
  return stat.isDirectory() && !stat.isSymbolicLink()
    && (process.platform === "win32" || ((stat.mode & 0o777) === 0o700 && stat.uid === process.getuid?.()));
}

function sameFile(left: Stats, right: Stats) { return left.dev === right.dev && left.ino === right.ino; }
function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

async function checkDirectory(info: PrivateDirectory) {
  const [rootStat, stat] = await Promise.all([fs.lstat(info.root), fs.lstat(info.directory)]);
  if (!privateDirectory(rootStat) || !privateDirectory(stat) || !sameFile(rootStat, info.rootStat) || !sameFile(stat, info.stat)) {
    throw new RecordExportError("unavailable");
  }
}

async function removeOwnedDirectory(info: PrivateDirectory) {
  const rootStat = await fs.lstat(info.root).catch((error) => { if (!missing(error)) throw error; });
  if (!rootStat) return;
  if (!privateDirectory(rootStat) || !sameFile(rootStat, info.rootStat)) throw new RecordExportError("unavailable");
  const stat = await fs.lstat(info.directory).catch((error) => { if (!missing(error)) throw error; });
  if (!stat) return;
  await checkDirectory(info);
  const filename = path.join(info.directory, FILE_NAME);
  const file = await fs.lstat(filename).catch((error) => { if (!missing(error)) throw error; });
  if (file && (!file.isFile() || file.isSymbolicLink() || (process.platform !== "win32" && file.uid !== process.getuid?.()))) {
    throw new RecordExportError("unavailable");
  }
  await checkDirectory(info);
  if (file) await fs.unlink(filename).catch((error) => { if (!missing(error)) throw error; });
  // Never recursively remove unexpected files or follow a substituted path.
  await fs.rmdir(info.directory).catch((error) => { if (!missing(error)) throw error; });
}

async function closeScan(loop: CleanupLoop) {
  const scan = loop.scan;
  loop.scan = undefined;
  loop.rootStat = undefined;
  await scan?.close().catch(() => undefined);
}

async function scanExpired(loop: CleanupLoop) {
  const rootStat = await fs.lstat(loop.root).catch((error) => { if (!missing(error)) throw error; });
  if (!rootStat) { await closeScan(loop); return; }
  if (!privateDirectory(rootStat)) throw new RecordExportError("unavailable");
  if (loop.rootStat && !sameFile(rootStat, loop.rootStat)) await closeScan(loop);
  if (!loop.scan) {
    loop.scan = await fs.opendir(loop.root);
    loop.rootStat = rootStat;
  }
  const cutoff = Date.now() - RECORD_EXPORT_TTL_MS;
  // Keep the directory cursor between batches so fresh/unrelated entries cannot starve old files.
  for (let index = 0; index < CLEANUP_BATCH_SIZE && !loop.stopped; index++) {
    const entry = await loop.scan.read();
    if (!entry) { await closeScan(loop); break; }
    const match = DIRECTORY_NAME.exec(entry.name);
    if (!match || Number(match[1]) > cutoff || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(loop.root, entry.name);
    if (cleanup.active.has(directory)) continue;
    try {
      const stat = await fs.lstat(directory);
      if (!privateDirectory(stat)) continue;
      await removeOwnedDirectory({ root: loop.root, directory, rootStat, stat });
    } catch {
      // A later pass retries transient errors; foreign paths never broaden deletion scope.
    }
  }
}

function runCleanup(loop: CleanupLoop) {
  if (loop.stopped) return Promise.resolve();
  loop.running ??= scanExpired(loop).catch(() => closeScan(loop)).finally(() => { loop.running = undefined; });
  return loop.running;
}

export async function startRecordExportCleanup() {
  if (cleanup.loop) return cleanup.loop.stop;
  const loop: CleanupLoop = {
    root: path.join(tmpdir(), "billboard-record-exports"), stopped: false,
    async stop() {
      loop.stopped = true;
      clearInterval(loop.timer);
      await loop.running;
      await closeScan(loop);
      if (cleanup.loop === loop) cleanup.loop = undefined;
    },
  };
  cleanup.loop = loop;
  await runCleanup(loop);
  if (!loop.stopped) {
    loop.timer = setInterval(() => { void runCleanup(loop); }, CLEANUP_INTERVAL_MS);
    loop.timer.unref?.();
  }
  return loop.stop;
}

export async function createRecordExportFile() {
  const root = path.join(tmpdir(), "billboard-record-exports");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (!privateDirectory(rootStat)) throw new RecordExportError("unavailable");
  await startRecordExportCleanup();
  const directory = await fs.mkdtemp(path.join(root, `export-${Date.now()}-`));
  cleanup.active.add(directory);
  try {
    await fs.chmod(directory, 0o700);
    const stat = await fs.lstat(directory);
    const info: PrivateDirectory = { root, directory, rootStat, stat };
    await checkDirectory(info);
    const filename = path.join(directory, FILE_NAME);
    let disposed = false;
    let closing = false;
    let disposal: Promise<void> | undefined;
    return {
      filename,
      async check() {
        if (disposed || closing) throw new RecordExportError("timeout");
        await checkDirectory(info);
      },
      async dispose() {
        if (disposed) return;
        closing = true;
        // The owner calls this only after its writer and download handle have settled.
        cleanup.active.delete(directory);
        disposal ??= removeOwnedDirectory(info).then(() => { disposed = true; }).catch((error) => {
          disposal = undefined;
          throw error;
        });
        return disposal;
      },
    };
  } catch (error) {
    cleanup.active.delete(directory);
    throw error;
  }
}
