export const VOICE_MAX_SECONDS = 60;
const OUTPUT_SAMPLE_RATE = 16000;

export type VoiceRecording = {
  stop: () => Promise<Blob>;
  cancel: () => void;
};

export type VoiceRecordingOptions = {
  signal: AbortSignal;
  onLimit: () => void;
  onTime?: (seconds: number) => void;
  onError?: (error: DOMException) => void;
};

function recordingError(name: string) {
  return new DOMException("Voice recording could not be completed.", name);
}

function normalizeError(error: unknown): DOMException {
  const name = error instanceof Error ? error.name : "";
  if (["AbortError", "NotAllowedError", "NotFoundError", "NotSupportedError", "DataError"].includes(name)) {
    return recordingError(name);
  }
  return recordingError("NotReadableError");
}

export function encodeVoiceWav(chunks: Float32Array[], sampleRate: number): Blob {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!Number.isFinite(sampleRate) || sampleRate < OUTPUT_SAMPLE_RATE || sampleRate > 192000
    || length === 0 || length > sampleRate * VOICE_MAX_SECONDS) {
    throw recordingError("DataError");
  }
  const outputLength = Math.floor(length * OUTPUT_SAMPLE_RATE / sampleRate);
  if (!outputLength) throw recordingError("DataError");
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  const bytes = new ArrayBuffer(44 + outputLength * 2);
  const view = new DataView(bytes);
  const writeText = (at: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(at + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, OUTPUT_SAMPLE_RATE, true);
  view.setUint32(28, OUTPUT_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, outputLength * 2, true);

  // Average each output sample's covered input interval, including fractional edges.
  // This works at both 44.1 and 48 kHz without assuming the requested device rate.
  const ratio = sampleRate / OUTPUT_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index++) {
    const start = index * ratio;
    const end = Math.min(length, (index + 1) * ratio);
    let total = 0;
    for (let input = Math.floor(start); input < end; input++) {
      const value = samples[input];
      if (!Number.isFinite(value)) throw recordingError("DataError");
      total += value * (Math.min(end, input + 1) - Math.max(start, input));
    }
    const sample = Math.max(-1, Math.min(1, total / ratio));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

export async function startVoiceRecording(options: VoiceRecordingOptions): Promise<VoiceRecording> {
  if (options.signal.aborted) throw recordingError("AbortError");
  if (globalThis.isSecureContext !== true || !globalThis.navigator?.mediaDevices?.getUserMedia
    || typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
    throw recordingError("NotSupportedError");
  }

  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let chunks: Float32Array[] = [];
  let sampleCount = 0;
  let cancelled = false;
  let captureEnded = false;
  let finished = false;
  let failure: DOMException | undefined;
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let finishPromise: Promise<void> | undefined;
  let stopPromise: Promise<Blob> | undefined;
  let resolveFlushed: (() => void) | undefined;
  let rejectAborted: (error: DOMException) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  // Initialization can fail before the first asynchronous operation races this signal.
  void aborted.catch(() => {});
  const waitFor = <T>(promise: Promise<T>) => Promise.race([promise, aborted]);

  const releaseHardware = () => {
    clearTimeout(limitTimer);
    clearInterval(tickTimer);
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener("ended", onDeviceEnded);
      track.stop();
    }
    source?.disconnect();
    node?.disconnect();
    if (node) {
      node.port.onmessage = null;
      node.onprocessorerror = null;
      node.port.close();
    }
    if (context && context.state !== "closed") void context.close().catch(() => {});
  };

  const cancel = () => {
    if (cancelled || finished) return;
    cancelled = true;
    chunks = [];
    releaseHardware();
    resolveFlushed?.();
    rejectAborted(recordingError("AbortError"));
    options.signal.removeEventListener("abort", cancel);
  };

  const onDeviceEnded = () => {
    if (cancelled || captureEnded || failure || finished) return;
    failure = recordingError("NotReadableError");
    releaseHardware();
    chunks = [];
    options.onError?.(failure);
  };

  const finishCapture = (alreadyFlushed = false) => {
    if (finishPromise) return finishPromise;
    captureEnded = true;
    clearTimeout(limitTimer);
    clearInterval(tickTimer);
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener("ended", onDeviceEnded);
      track.stop();
    }
    finishPromise = (async () => {
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (alreadyFlushed) return;
        await waitFor(new Promise<void>((resolve, reject) => {
          resolveFlushed = resolve;
          flushTimer = setTimeout(() => reject(recordingError("NotReadableError")), 1000);
          node?.port.postMessage({ type: "stop" });
        }));
      } finally {
        clearTimeout(flushTimer);
        releaseHardware();
      }
    })();
    return finishPromise;
  };

  const reachLimit = (alreadyFlushed = false) => {
    if (captureEnded || cancelled || finished || failure) return;
    void finishCapture(alreadyFlushed).then(() => {
      if (cancelled || finished) return;
      options.onTime?.(VOICE_MAX_SECONDS);
      options.onLimit();
    }).catch((error: unknown) => {
      if (cancelled) return;
      failure = normalizeError(error);
      chunks = [];
      options.onError?.(failure);
    });
  };

  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    context = new AudioContext({ latencyHint: "interactive" });
    if (!context.audioWorklet || context.sampleRate < OUTPUT_SAMPLE_RATE || context.sampleRate > 192000) {
      throw recordingError("NotSupportedError");
    }
    const media = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false }).then((value) => {
      if (cancelled) {
        value.getTracks().forEach((track) => track.stop());
        throw recordingError("AbortError");
      }
      stream = value;
      // A touch hold may not activate audio before release. Active microphone capture
      // permits Web Audio in supporting browsers, so retry a resume blocked earlier.
      return context!.resume();
    });
    await waitFor(Promise.all([
      media,
      context.resume(),
      context.audioWorklet.addModule("/voice-recorder-worklet.js"),
    ]));
    if (cancelled || !stream) throw recordingError("AbortError");
    const sampleRate = context.sampleRate;
    const maxFrames = sampleRate * VOICE_MAX_SECONDS;
    node = new AudioWorkletNode(context, "billboard-voice-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { maxFrames },
    });
    node.port.onmessage = (event: MessageEvent) => {
      if (cancelled || finished || failure) return;
      const message = event.data;
      if (message?.type === "stopped") {
        resolveFlushed?.();
      } else if (message?.type === "limit") {
        // The worklet posts the limit after its final sample message, in port order.
        reachLimit(true);
      } else if (message?.type === "samples" && message.samples instanceof Float32Array) {
        sampleCount += message.samples.length;
        if (sampleCount > maxFrames) {
          onDeviceEnded();
          return;
        }
        chunks.push(message.samples);
      }
    };
    node.onprocessorerror = onDeviceEnded;
    for (const track of stream.getTracks()) track.addEventListener("ended", onDeviceEnded);
    source = context.createMediaStreamSource(stream);
    source.connect(node);
    node.connect(context.destination);
    const started = performance.now();
    options.onTime?.(0);
    tickTimer = setInterval(() => options.onTime?.(Math.min(VOICE_MAX_SECONDS, (performance.now() - started) / 1000)), 250);
    limitTimer = setTimeout(reachLimit, VOICE_MAX_SECONDS * 1000);

    return {
      cancel,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          try {
            if (cancelled) throw recordingError("AbortError");
            if (failure) throw failure;
            await finishCapture();
            if (cancelled) throw recordingError("AbortError");
            if (failure) throw failure;
            return encodeVoiceWav(chunks, sampleRate);
          } finally {
            finished = true;
            chunks = [];
            options.signal.removeEventListener("abort", cancel);
            releaseHardware();
          }
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    cancel();
    throw normalizeError(error);
  }
}
