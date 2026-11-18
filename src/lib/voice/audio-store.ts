import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_VOICE_AUDIO_BYTES, validateVoiceWav } from "./wav";

const LEASE_TTL_MS = 45_000;
const MAX_ACTIVE_LEASES = 16;
const FILE_NAME = /^[a-f0-9]{32}\.wav$/;
const WORKER_NAME = /^worker-(\d{13})-[A-Za-z0-9]{6}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

type Directory = { root: string; path: string; rootStat: Stats; stat: Stats };
type Entry = {
  expiresAt: number;
  revoked?: boolean;
  directory?: Directory;
  file?: string;
  stat?: Stats;
  timer?: ReturnType<typeof setTimeout>;
  creation?: Promise<void>;
  disposal?: Promise<void>;
};
type Store = { entries: Map<string, Entry>; directory?: Promise<Directory> };
const storeKey = Symbol.for("billboard.voice-audio-store.v1");
const shared = globalThis as typeof globalThis & { [key: symbol]: Store | undefined };
const store: Store = shared[storeKey] ??= { entries: new Map<string, Entry>() };

function unavailable() { return new Error("unavailable"); }

function publicOrigin() {
  const value = process.env.VOICE_AUDIO_PUBLIC_ORIGIN ?? "";
  // Inspect the input before URL normalization can hide credentials, paths or whitespace.
  if (!/^https:\/\/[^\s/@\\?#]+\/?$/.test(value)) throw unavailable();
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || host === "localhost" || host.endsWith(".localhost")) throw unavailable();
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))) throw unavailable();
  } else if (version === 6) {
    // Only global unicast literals are usable public download origins; this also excludes mapped private IPv4.
    const first = Number.parseInt(host.split(":", 1)[0], 16);
    if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) throw unavailable();
  }
  return url.origin;
}

function sameFile(actual: Stats, expected: Stats) {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function isPrivateDirectory(stat: Stats) {
  return stat.isDirectory() && !stat.isSymbolicLink()
    && (process.platform === "win32" || ((stat.mode & 0o777) === 0o700 && stat.uid === process.getuid?.()));
}

async function checkDirectory(directory: Directory) {
  const rootStat = await fs.lstat(directory.root);
  const stat = await fs.lstat(directory.path);
  if (!isPrivateDirectory(rootStat) || !isPrivateDirectory(stat)
    || !sameFile(rootStat, directory.rootStat) || !sameFile(stat, directory.stat)) throw unavailable();
}

async function cleanOrphans(root: string) {
  const cutoff = Date.now() - LEASE_TTL_MS;
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const match = WORKER_NAME.exec(item.name);
    if (!match || Number(match[1]) > cutoff || !item.isDirectory() || item.isSymbolicLink()) continue;
    const directory = path.join(root, item.name);
    try {
      if (!isPrivateDirectory(await fs.lstat(directory))) continue;
      for (const file of await fs.readdir(directory, { withFileTypes: true })) {
        if (!FILE_NAME.test(file.name) || !file.isFile() || file.isSymbolicLink()) continue;
        const filename = path.join(directory, file.name);
        const stat = await fs.lstat(filename);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs <= cutoff) await fs.unlink(filename);
      }
    } catch {
      // Another worker may still own fresh files, or may have removed this directory concurrently.
    }
  }
}

async function initializeDirectory(): Promise<Directory> {
  const root = path.join(tmpdir(), "billboard-voice");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (!isPrivateDirectory(rootStat)) throw unavailable();
  await cleanOrphans(root);
  const directory = await fs.mkdtemp(path.join(root, `worker-${Date.now()}-`));
  try {
    await fs.chmod(directory, 0o700);
    const stat = await fs.lstat(directory);
    if (!isPrivateDirectory(stat)) throw unavailable();
    const result = { root, path: directory, rootStat, stat };
    // A recent crash can leave files younger than the cutoff at startup. One delayed pass
    // removes those after expiry without periodically traversing other live workers.
    const cleanup = setTimeout(() => {
      void checkDirectory(result).then(() => cleanOrphans(root)).catch(() => undefined);
    }, LEASE_TTL_MS + 1000);
    cleanup.unref?.();
    return result;
  } catch {
    await fs.rmdir(directory).catch(() => undefined);
    throw unavailable();
  }
}

async function getDirectory(retry = true): Promise<Directory> {
  store.directory ??= initializeDirectory().catch(() => {
    store.directory = undefined;
    throw unavailable();
  });
  const pending = store.directory;
  const directory = await pending;
  try {
    await checkDirectory(directory);
    return directory;
  } catch (error) {
    if (!retry || (error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
    if (store.directory === pending) store.directory = undefined;
    return getDirectory(false);
  }
}

async function deleteFile(entry: Entry) {
  if (!entry.directory || !entry.file) return;
  try {
    await checkDirectory(entry.directory);
    await fs.unlink(entry.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
  }
}

function revoke(token: string, entry: Entry) {
  entry.revoked = true;
  entry.disposal ??= (async () => {
    // Expiry revokes access immediately, but cannot free a reservation or unlink
    // a pathname while an outstanding open/write may still create its file.
    await entry.creation;
    for (const delay of [0, 25, 100]) {
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      try {
        await deleteFile(entry);
        if (store.entries.get(token) === entry) store.entries.delete(token);
        clearTimeout(entry.timer);
        return;
      } catch {
        // Keep the capacity reservation and original expiry timer until deletion succeeds.
      }
    }
    entry.disposal = undefined;
    throw unavailable();
  })();
  return entry.disposal;
}

function isActive(token: string, entry: Entry) {
  return !entry.revoked && store.entries.get(token) === entry && entry.expiresAt > Date.now();
}

export function isVoiceAudioLeaseActive(token: string) {
  const entry = store.entries.get(token);
  return !!entry && isActive(token, entry);
}

export async function createVoiceAudioLease(audio: Uint8Array): Promise<{ url: string; dispose(): Promise<void> }> {
  let token: string | undefined;
  let entry: Entry | undefined;
  let handle: fs.FileHandle | undefined;
  let finishCreation: (() => void) | undefined;
  try {
    const origin = publicOrigin();
    if (validateVoiceWav(audio) || store.entries.size >= MAX_ACTIVE_LEASES) throw unavailable();
    token = randomBytes(32).toString("base64url");
    entry = { expiresAt: Date.now() + LEASE_TTL_MS,
      creation: new Promise<void>((resolve) => { finishCreation = resolve; }) };
    // Reserve before the first await so concurrent writers cannot exceed the process limit.
    store.entries.set(token, entry);
    const currentToken = token;
    const currentEntry = entry;
    entry.timer = setTimeout(() => { void revoke(currentToken, currentEntry).catch(() => undefined); }, LEASE_TTL_MS);
    entry.timer.unref?.();
    const directory = await getDirectory();
    entry.directory = directory;
    if (!isActive(token, entry)) throw unavailable();
    entry.file = path.join(directory.path, `${randomBytes(16).toString("hex")}.wav`);
    handle = await fs.open(/* turbopackIgnore: true */ entry.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(audio);
    entry.stat = await handle.stat();
    await handle.close();
    handle = undefined;
    finishCreation?.();
    if (!isActive(token, entry)) throw unavailable();
    return { url: `${origin}/api/voice/audio?token=${token}`, dispose: () => revoke(currentToken, currentEntry) };
  } catch {
    await handle?.close().catch(() => undefined);
    finishCreation?.();
    if (token && entry) {
      await revoke(token, entry).catch(() => undefined);
      await deleteFile(entry).catch(() => undefined);
    }
    throw unavailable();
  }
}

export async function readVoiceAudioLease(token: string): Promise<Uint8Array | null> {
  if (!TOKEN.test(token)) return null;
  const entry = store.entries.get(token);
  if (!entry || !isActive(token, entry)) return null;
  let handle: fs.FileHandle | undefined;
  try {
    if (!entry.directory || !entry.file || !entry.stat) return null;
    await checkDirectory(entry.directory);
    const before = await fs.lstat(entry.file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !sameFile(before, entry.stat)) return null;
    handle = await fs.open(/* turbopackIgnore: true */ entry.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !sameFile(stat, entry.stat) || stat.size !== entry.stat.size
      || stat.size > MAX_VOICE_AUDIO_BYTES) return null;
    const audio = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < audio.length) {
      const { bytesRead } = await handle.read(audio, offset, audio.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.nlink !== 1 || validateVoiceWav(audio)) return null;
    // Closing is also asynchronous: recheck authorization after every disk operation is complete.
    await handle.close();
    handle = undefined;
    return isActive(token, entry) ? audio : null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}
