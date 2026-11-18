import { expect, it, vi } from "vitest";
import { readVoiceBody, transcribeVoiceAudio } from "@/lib/voice/transcribe";
import { wav } from "../fixtures/voice-wav";

const { createLease, disposeLease } = vi.hoisted(() => ({ createLease: vi.fn(), disposeLease: vi.fn() }));
vi.mock("@/lib/voice/audio-store", () => ({ createVoiceAudioLease: createLease }));

it.each(["overflow", "abort"] as const)("waits for the original %s cancellation before releasing the reader and caller", async (kind) => {
  const abort = new AbortController();
  const reason = new Error("Synthetic upload abort");
  let release!: () => void;
  let cleanupFinished = false;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const cancel = vi.fn(async () => { await cleanup; cleanupFinished = true; });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { if (kind === "overflow") controller.enqueue(new Uint8Array(1025)); },
    cancel,
  });
  let settled = false;
  const reading = readVoiceBody(stream, 1024, abort.signal, "audio_too_large").finally(() => { settled = true; });
  const failed = kind === "overflow" ? expect(reading).rejects.toMatchObject({ code: "audio_too_large" }) : expect(reading).rejects.toBe(reason);
  try {
    if (kind === "abort") abort.abort(reason);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupFinished).toBe(false);
    expect(settled).toBe(false);
    expect(stream.locked).toBe(true);
  } finally { release(); await failed; }
  expect(cleanupFinished).toBe(true);
  expect(stream.locked).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(["http", "business"] as const)("waits for cancellation of a rejected %s provider response before releasing its caller", async (kind) => {
  vi.stubEnv("VOLCENGINE_ASR_API_KEY", "unit-test-key-not-a-secret");
  createLease.mockReset().mockResolvedValue({ url: "https://audio.example.test/synthetic-placeholder", dispose: disposeLease });
  disposeLease.mockReset().mockResolvedValue(undefined);
  let release!: () => void;
  let cleanupFinished = false;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const cancel = vi.fn(async () => { await cleanup; cleanupFinished = true; });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({ cancel }), {
    status: kind === "http" ? 429 : 200,
    headers: { "X-Api-Status-Code": kind === "http" ? "20000000" : "45000131" },
  }));
  let settled = false;
  const reading = transcribeVoiceAudio(wav(), new AbortController().signal).finally(() => { settled = true; });
  const failed = expect(reading).rejects.toMatchObject({ code: "rate_limited", message: "rate_limited" });
  try {
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupFinished).toBe(false);
    expect(settled).toBe(false);
    expect(disposeLease).not.toHaveBeenCalled();
  } finally {
    release();
    try { await failed; }
    finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  }
  expect(cleanupFinished).toBe(true);
  expect(disposeLease).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});
