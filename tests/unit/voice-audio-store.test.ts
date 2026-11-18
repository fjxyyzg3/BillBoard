import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { wav } from "../fixtures/voice-wav";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: () => fixture.root || actual.tmpdir() };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});

let store: typeof import("@/lib/voice/audio-store");
const leases: Array<{ url: string; dispose(): Promise<void> }> = [];
const token = (url: string) => new URL(url).searchParams.get("token")!;
const root = () => path.join(fixture.root, "billboard-voice");

beforeAll(async () => {
  fixture.root = await fs.mkdtemp(path.join(tmpdir(), "billboard-voice-test-"));
  store = await import("@/lib/voice/audio-store");
});
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink);
  await Promise.all(leases.splice(0).map((lease) => lease.dispose()));
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(async () => { await fs.rm(fixture.root, { recursive: true, force: true }); });

async function create(audio = wav()) {
  vi.stubEnv("VOICE_AUDIO_PUBLIC_ORIGIN", "https://audio.example.test");
  const lease = await store.createVoiceAudioLease(audio);
  leases.push(lease);
  return lease;
}

async function files() {
  const entries = await fs.readdir(root(), { withFileTypes: true });
  const nested = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const directory = path.join(root(), entry.name);
    return (await fs.readdir(directory)).map((name) => path.join(directory, name));
  }));
  return nested.flat();
}

describe("short-lived voice audio storage", () => {
  it("cleans only expired owned files at initialization and retains fresh workers and unrelated files", async () => {
    vi.useFakeTimers();
    await fs.mkdir(root(), { mode: 0o700 });
    const old = path.join(root(), `worker-${Date.now() - 120_000}-old123`);
    const fresh = path.join(root(), `worker-${Date.now()}-new123`);
    const idle = path.join(root(), `worker-${Date.now() - 120_000}-idle12`);
    await fs.mkdir(old, { mode: 0o700 });
    await fs.mkdir(fresh, { mode: 0o700 });
    await fs.mkdir(idle, { mode: 0o700 });
    const expired = path.join(old, `${"a".repeat(32)}.wav`);
    const active = path.join(old, `${"b".repeat(32)}.wav`);
    const unrelated = path.join(old, "keep.txt");
    const freshFile = path.join(fresh, `${"c".repeat(32)}.wav`);
    await Promise.all([expired, active, unrelated, freshFile].map((file) => fs.writeFile(file, wav())));
    const past = new Date(Date.now() - 120_000);
    await fs.utimes(expired, past, past);
    await fs.utimes(unrelated, past, past);
    await fs.utimes(freshFile, past, past);
    await create();
    await expect(fs.stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    for (const file of [active, unrelated, freshFile]) expect((await fs.stat(file)).isFile()).toBe(true);
    expect((await fs.stat(idle)).isDirectory()).toBe(true);
    await vi.advanceTimersByTimeAsync(46_000);
    await vi.waitFor(async () => {
      await expect(fs.stat(freshFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(active)).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect((await fs.stat(unrelated)).isFile()).toBe(true);
    await fs.rm(old, { recursive: true });
    await fs.rm(fresh, { recursive: true });
    await fs.rmdir(idle);
  });

  it("stores exact WAV bytes privately and exposes only an opaque single-file capability", async () => {
    const audio = wav();
    const first = await create(audio);
    const second = await create(wav(8000, 3000));
    const url = new URL(first.url);
    expect(url.origin).toBe("https://audio.example.test");
    expect(url.pathname).toBe("/api/voice/audio");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
    expect(token(first.url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token(first.url)).not.toBe(token(second.url));
    expect(Buffer.from((await store.readVoiceAudioLease(token(first.url)))!)).toEqual(audio);
    const stored = await files();
    expect(stored).toHaveLength(2);
    expect(stored.some((file) => file.includes(token(first.url)))).toBe(false);
    if (process.platform !== "win32") {
      expect((await fs.stat(root())).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.dirname(stored[0]))).mode & 0o777).toBe(0o700);
      for (const file of stored) expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
    await first.dispose();
    await first.dispose();
    expect(await store.readVoiceAudioLease(token(first.url))).toBeNull();
    expect(await store.readVoiceAudioLease(token(second.url))).not.toBeNull();
    expect(await files()).toHaveLength(1);
  });

  it.each([
    "", "http://audio.example.test", "https://user:pass@audio.example.test", "https://@audio.example.test",
    "https://audio.example.test/path", "https://audio.example.test/?", "https://audio.example.test/#",
    "https://audio.example.test/%2e", " https://audio.example.test", "https://localhost", "https://sub.localhost",
    "https://127.0.0.1", "https://2130706433", "https://10.1.2.3", "https://172.16.2.3", "https://192.168.2.3",
    "https://169.254.169.254", "https://[::1]", "https://[fc00::1]", "https://[fe80::1]", "https://[::ffff:127.0.0.1]",
  ])("rejects non-public or non-root origins without exposing configuration (%s)", async (origin) => {
    vi.stubEnv("VOICE_AUDIO_PUBLIC_ORIGIN", origin);
    await expect(store.createVoiceAudioLease(wav())).rejects.toMatchObject({ message: "unavailable" });
    expect(await files()).toHaveLength(0);
  });

  it("rejects non-WAV and excessive data before creating a file", async () => {
    vi.stubEnv("VOICE_AUDIO_PUBLIC_ORIGIN", "https://audio.example.test");
    for (const audio of [new Uint8Array(20), new Uint8Array(2 * 1024 * 1024 + 1)]) {
      await expect(store.createVoiceAudioLease(audio)).rejects.toMatchObject({ message: "unavailable" });
    }
    expect(await files()).toHaveLength(0);
  });

  it("shares capabilities across independently loaded route bundles", async () => {
    const lease = await create();
    vi.resetModules();
    const reloaded = await import("@/lib/voice/audio-store");
    expect(Buffer.from((await reloaded.readVoiceAudioLease(token(lease.url)))!)).toEqual(wav());
    await lease.dispose();
    expect(await reloaded.readVoiceAudioLease(token(lease.url))).toBeNull();
  });

  it("caps concurrent reservations at 16 and frees capacity on disposal", async () => {
    vi.stubEnv("VOICE_AUDIO_PUBLIC_ORIGIN", "https://audio.example.test");
    const results = await Promise.allSettled(Array.from({ length: 17 }, () => store.createVoiceAudioLease(wav())));
    for (const result of results) if (result.status === "fulfilled") leases.push(result.value);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(16);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await leases[0].dispose();
    await create();
    expect(await files()).toHaveLength(16);
  });

  it("revokes and removes the file at 45 seconds without requiring another request", async () => {
    vi.useFakeTimers();
    const lease = await create();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(await store.readVoiceAudioLease(token(lease.url))).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await store.readVoiceAudioLease(token(lease.url))).toBeNull();
    await vi.waitFor(async () => expect(await files()).toHaveLength(0));
  });

  it("never opens a file for an unknown, malformed or revoked token", async () => {
    const lease = await create();
    await lease.dispose();
    vi.mocked(fs.open).mockClear();
    for (const value of ["../outside.wav", "a".repeat(43), token(lease.url), ""]) {
      expect(await store.readVoiceAudioLease(value)).toBeNull();
    }
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("does not return an open file after its capability is revoked during disk I/O", async () => {
    const lease = await create();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let resume!: () => void;
    let opened!: () => void;
    const pendingOpen = new Promise<void>((resolve) => { opened = resolve; });
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      opened();
      await new Promise<void>((resolve) => { resume = resolve; });
      return handle;
    });
    const pending = store.readVoiceAudioLease(token(lease.url));
    await pendingOpen;
    const disposal = lease.dispose();
    resume();
    expect(await pending).toBeNull();
    await disposal;
  });

  it("rejects a substituted hard link rather than reading or deleting outside audio", async () => {
    const lease = await create();
    const [stored] = await files();
    const outside = path.join(fixture.root, "outside.wav");
    await fs.writeFile(outside, wav(8000, 4000));
    await fs.unlink(stored);
    await fs.link(outside, stored);
    expect(await store.readVoiceAudioLease(token(lease.url))).toBeNull();
    await lease.dispose();
    expect(await fs.readFile(outside)).toEqual(wav(8000, 4000));
  });

  it("cleans failed file creation and returns only a fixed error", async () => {
    vi.mocked(fs.open).mockRejectedValueOnce(new Error("private filesystem details"));
    await expect(create()).rejects.toMatchObject({ message: "unavailable" });
    expect(await files()).toHaveLength(0);
    await create();
  });

  it("removes a file whose creation finishes after the lease expires", async () => {
    vi.useFakeTimers();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let resume!: () => void;
    let started!: () => void;
    const pendingOpen = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      started();
      await new Promise<void>((resolve) => { resume = resolve; });
      return actual.open(...args);
    });
    const pending = create().catch((error: Error) => error);
    await pendingOpen;
    await vi.advanceTimersByTimeAsync(45_000);
    resume();
    expect(await pending).toMatchObject({ message: "unavailable" });
    expect(await files()).toHaveLength(0);
    await create();
  });

  it("retains all 16 local reservations until expired filesystem writes actually finish", async () => {
    vi.useFakeTimers();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const resumes: Array<() => void> = [];
    let opened!: () => void;
    const allOpened = new Promise<void>((resolve) => { opened = resolve; });
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (resumes.length < 16) {
        await new Promise<void>((resolve) => {
          resumes.push(resolve);
          if (resumes.length === 16) opened();
        });
      }
      return actual.open(...args);
    });
    const writes = Array.from({ length: 16 }, () => create().catch((error: Error) => error));
    await allOpened;
    await vi.advanceTimersByTimeAsync(45_000);
    const additional = create().catch((error: Error) => error);
    try {
      expect(await additional).toMatchObject({ message: "unavailable" });
      expect(resumes).toHaveLength(16);
    } finally {
      resumes.forEach((resume) => resume());
      await Promise.all(writes);
    }
    expect(await files()).toHaveLength(0);
    vi.mocked(fs.open).mockImplementation(actual.open);
    await create();
  });

  it("removes a partially written file when disk writes fail", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await handle.write(new Uint8Array([1, 2, 3]));
        throw new Error("private write failure");
      });
      return handle;
    });
    await expect(create()).rejects.toMatchObject({ message: "unavailable" });
    expect(await files()).toHaveLength(0);
  });

  it("does not follow a replaced worker directory into another directory", async () => {
    const lease = await create();
    const [stored] = await files();
    const directory = path.dirname(stored);
    const backup = `${directory}-saved`;
    const outside = path.join(fixture.root, "outside-directory");
    await fs.mkdir(outside);
    const outsideAudio = path.join(outside, path.basename(stored));
    await fs.writeFile(outsideAudio, wav(8000, 5000));
    await fs.rename(directory, backup);
    try {
      await fs.symlink(outside, directory, "junction");
      expect(await store.readVoiceAudioLease(token(lease.url))).toBeNull();
      expect(await fs.readFile(outsideAudio)).toEqual(wav(8000, 5000));
    } finally {
      await fs.unlink(directory).catch(() => fs.rmdir(directory));
      await fs.rename(backup, directory);
    }
  });

  it.skipIf(process.platform === "win32")("never follows a substituted audio symlink", async () => {
    const lease = await create();
    const [stored] = await files();
    const outside = path.join(fixture.root, "outside-symlink.wav");
    await fs.writeFile(outside, wav(8000, 6000));
    await fs.unlink(stored);
    await fs.symlink(outside, stored);
    expect(await store.readVoiceAudioLease(token(lease.url))).toBeNull();
    await lease.dispose();
    expect(await fs.readFile(outside)).toEqual(wav(8000, 6000));
  });

  it("recreates a vanished idle directory instead of keeping a permanently broken cached path", async () => {
    const lease = await create();
    const [stored] = await files();
    await lease.dispose();
    await fs.rmdir(path.dirname(stored));
    const recovered = await create();
    expect(Buffer.from((await store.readVoiceAudioLease(token(recovered.url)))!)).toEqual(wav());
  });

  it("revokes immediately and retries a transient unlink failure before reporting successful disposal", async () => {
    vi.useFakeTimers();
    const lease = await create();
    vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("private unlink details"));
    let completion: string | undefined;
    void lease.dispose().then(() => { completion = "disposed"; }, (error: Error) => { completion = error.message; });
    expect(await store.readVoiceAudioLease(token(lease.url))).toBeNull();
    await vi.waitFor(() => expect(completion).toBe("disposed"));
    expect(await files()).toHaveLength(0);
  });

  it("retains failed cleanup capacity and allows an explicit disposal retry without exposing filesystem details", async () => {
    vi.useFakeTimers();
    const lease = await create();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.unlink).mockRejectedValue(new Error("private unlink details"));
    let failure: Error | undefined;
    void lease.dispose().catch((error: Error) => { failure = error; });
    await vi.waitFor(() => expect(failure).toMatchObject({ message: "unavailable" }));
    const attempts = vi.mocked(fs.unlink).mock.calls.length;
    expect(await store.readVoiceAudioLease(token(lease.url))).toBeNull();
    expect(fs.unlink).toHaveBeenCalledTimes(attempts);
    await Promise.all(Array.from({ length: 15 }, () => create()));
    await expect(create()).rejects.toMatchObject({ message: "unavailable" });
    vi.mocked(fs.unlink).mockImplementation(actual.unlink);
    await lease.dispose();
    await create();
    expect(await files()).toHaveLength(16);
  });

  it("keeps the original expiry cleanup after an earlier disposal exhausts its bounded retries", async () => {
    vi.useFakeTimers();
    const lease = await create();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.unlink).mockRejectedValue(new Error("private unlink details"));
    let failure: Error | undefined;
    void lease.dispose().catch((error: Error) => { failure = error; });
    await vi.waitFor(() => expect(failure).toMatchObject({ message: "unavailable" }));
    vi.mocked(fs.unlink).mockImplementation(actual.unlink);
    await vi.advanceTimersByTimeAsync(45_000);
    await vi.waitFor(async () => expect(await files()).toHaveLength(0));
    expect(await store.readVoiceAudioLease(token(lease.url))).toBeNull();
  });
});
