import { randomUUID } from "node:crypto";
import { MAX_NATURAL_LANGUAGE_TEXT_LENGTH, normalizeNaturalLanguageText } from "@/lib/transactions/natural-language-protocol";
import { createVoiceAudioLease } from "./audio-store";
import { validateVoiceWav, type VoiceAudioError } from "./wav";

export type VoiceTranscriptionErrorCode = VoiceAudioError | "unauthorized" | "forbidden" | "context_required" | "consent_required" | "text_too_long" | "rate_limited" | "unavailable" | "timeout" | "cancelled";

export class VoiceTranscriptionError extends Error {
  constructor(public readonly code: VoiceTranscriptionErrorCode) {
    super(code);
  }
}

export async function readVoiceBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
  overflowCode: VoiceTranscriptionErrorCode,
): Promise<Buffer> {
  if (signal.aborted) throw signal.reason;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  let stopping: Promise<void> | undefined;
  const cancel = () => { stopping ??= reader.cancel().catch(() => undefined); return stopping; };
  const abort = () => { void cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw new VoiceTranscriptionError(overflowCode);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function transcribeVoiceAudio(audio: Uint8Array, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new VoiceTranscriptionError("cancelled");
  const audioError = validateVoiceWav(audio);
  if (audioError) throw new VoiceTranscriptionError(audioError);
  const apiKey = process.env.VOLCENGINE_ASR_API_KEY?.trim();
  if (!apiKey) throw new VoiceTranscriptionError("unavailable");

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 30_000);
  const combinedSignal = AbortSignal.any([signal, timeout.signal]);
  let lease: Awaited<ReturnType<typeof createVoiceAudioLease>> | undefined;
  try {
    lease = await acquireAudioLease(audio, combinedSignal);
    const requestId = randomUUID();
    const call = async (operation: "submit" | "query", body: unknown) => {
      combinedSignal.throwIfAborted();
      const response = await fetch(`https://openspeech.bytedance.com/api/v3/auc/bigmodel/${operation}`, {
        method: "POST", cache: "no-store", redirect: "error", signal: combinedSignal,
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
          "X-Api-Resource-Id": "volc.seedasr.auc",
          "X-Api-Request-Id": requestId,
          ...(operation === "submit" ? { "X-Api-Sequence": "-1" } : {}),
        },
        body: JSON.stringify(body),
      });
      try {
        if (response.status === 429) throw new VoiceTranscriptionError("rate_limited");
        const code = response.headers.get("X-Api-Status-Code");
        if (code === "20000003" || code === "45000002") throw new VoiceTranscriptionError("no_speech");
        if (code === "45000151") throw new VoiceTranscriptionError("invalid_audio");
        if (code === "45000131") throw new VoiceTranscriptionError("rate_limited");
        if (code === "45000132") throw new VoiceTranscriptionError("audio_too_large");
        if (!response.ok) throw new VoiceTranscriptionError("unavailable");
        const pending = operation === "query" && (code === "20000001" || code === "20000002");
        if (code !== "20000000" && !pending) throw new VoiceTranscriptionError("unavailable");
        return { pending, bytes: await readVoiceBody(response.body, 256 * 1024, combinedSignal, "unavailable") };
      } finally {
        if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
      }
    };
    await call("submit", {
      user: { uid: requestId },
      audio: { url: lease.url, format: "wav", codec: "raw", rate: 16000, bits: 16, channel: 1 },
      request: { model_name: "bigmodel" },
    });
    while (true) {
      const { pending, bytes } = await call("query", {});
      if (pending) { await waitToQuery(combinedSignal); continue; }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (typeof body !== "object" || body === null || !("result" in body)
        || typeof body.result !== "object" || body.result === null || !("text" in body.result)
        || typeof body.result.text !== "string") throw new VoiceTranscriptionError("unavailable");
      const text = normalizeNaturalLanguageText(body.result.text);
      if (!text) throw new VoiceTranscriptionError("no_speech");
      if (text.length > MAX_NATURAL_LANGUAGE_TEXT_LENGTH) throw new VoiceTranscriptionError("text_too_long");
      return text;
    }
  } catch (error) {
    if (signal.aborted) throw new VoiceTranscriptionError("cancelled");
    if (timeout.signal.aborted) throw new VoiceTranscriptionError("timeout");
    if (error instanceof VoiceTranscriptionError) throw error;
    throw new VoiceTranscriptionError("unavailable");
  } finally {
    clearTimeout(timer);
    try { await lease?.dispose(); }
    catch { throw new VoiceTranscriptionError(signal.aborted ? "cancelled" : timeout.signal.aborted ? "timeout" : "unavailable"); }
  }
}

async function acquireAudioLease(audio: Uint8Array, signal: AbortSignal) {
  signal.throwIfAborted();
  // Filesystem work cannot be abandoned on abort: the caller owns the shared
  // processing slot until the write and any resulting private-file cleanup finish.
  const lease = await createVoiceAudioLease(audio);
  if (signal.aborted) {
    await lease.dispose();
    signal.throwIfAborted();
  }
  return lease;
}

function waitToQuery(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}
