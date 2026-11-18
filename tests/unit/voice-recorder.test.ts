import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeVoiceWav, startVoiceRecording, VOICE_MAX_SECONDS } from "@/lib/voice/recorder";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("voice WAV encoding", () => {
  it.each([16000, 44100, 48000])("encodes actual %i Hz samples as mono PCM16 at 16 kHz", async (sampleRate) => {
    const samples = Float32Array.from({ length: sampleRate }, (_, index) =>
      Math.sin(2 * Math.PI * 1000 * index / sampleRate) / 2,
    );
    const blob = encodeVoiceWav([samples.slice(0, 1000), samples.slice(1000)], sampleRate);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 16000 * 2);
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(32000);
    let squaredError = 0;
    for (let i = 0; i < 16000; i++) {
      const expected = Math.sin(2 * Math.PI * 1000 * i / 16000) / 2;
      squaredError += (view.getInt16(44 + i * 2, true) / 32768 - expected) ** 2;
    }
    expect(Math.sqrt(squaredError / 16000)).toBeLessThan(0.06);
  });

  it("rejects empty and excessive samples instead of disguising or truncating them", () => {
    expect(() => encodeVoiceWav([], 48000)).toThrow();
    expect(() => encodeVoiceWav([new Float32Array(16000 * VOICE_MAX_SECONDS + 1)], 16000)).toThrow();
  });

  it("bounds the complete 60 second recording below the 2 MiB upload limit", () => {
    const blob = encodeVoiceWav([new Float32Array(48000 * VOICE_MAX_SECONDS)], 48000);
    expect(blob.size).toBe(1_920_044);
    expect(blob.size).toBeLessThan(2 * 1024 * 1024);
  });
});

function browserAudio(media?: Promise<MediaStream>, requiresCaptureToResume = false) {
  const track = new EventTarget() as EventTarget & { readyState: string; stop: () => void };
  track.readyState = "live";
  track.stop = () => { track.readyState = "ended"; };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  let context: FakeContext;
  let node: FakeNode;
  let captureReady = false;
  let pendingResume: (() => void) | undefined;

  class FakeContext {
    sampleRate = 48000;
    state = "suspended";
    destination = {};
    audioWorklet = { addModule: async () => {} };
    constructor() { context = this; }
    async resume() {
      if (requiresCaptureToResume && !captureReady) {
        await new Promise<void>((resolve) => { pendingResume = resolve; });
      } else pendingResume?.();
      this.state = "running";
    }
    async close() { this.state = "closed"; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }

  class FakeNode {
    onprocessorerror: (() => void) | null = null;
    port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: (data: { type: string }) => {
        if (data.type === "stop") this.emit({ type: "stopped" });
      },
      closed: false,
      close: () => { this.port.closed = true; },
    };
    constructor() { node = this; }
    connect() {}
    disconnect() {}
    emit(data: unknown) { this.port.onmessage?.({ data } as MessageEvent); }
  }
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => (media ?? Promise.resolve(stream)).then((value) => {
    captureReady = true;
    return value;
  }) } });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  return { track, stream, context: () => context, node: () => node };
}

describe("voice recording lifetime", () => {
  it("recovers a gesture-blocked context once microphone capture permits audio processing", async () => {
    const audio = browserAudio(undefined, true);
    const controller = new AbortController();
    const result = startVoiceRecording({ signal: controller.signal, onLimit: vi.fn() });
    try {
      await vi.waitFor(() => expect(audio.context().state).toBe("running"), { timeout: 100 });
      const recording = await result;
      audio.node().emit({ type: "samples", samples: new Float32Array(48000) });
      expect((await recording.stop()).size).toBe(32044);
    } finally {
      controller.abort();
      await result.catch(() => {});
    }
    expect(audio.context().state).toBe("closed");
    expect(audio.track.readyState).toBe("ended");
  });

  it("cancels immediately while permission is pending and stops a late microphone stream", async () => {
    let grant: (stream: MediaStream) => void = () => {};
    const audio = browserAudio(new Promise((resolve) => { grant = resolve; }));
    const controller = new AbortController();
    const result = startVoiceRecording({ signal: controller.signal, onLimit: vi.fn() });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(audio.context().state).toBe("closed");
    grant(audio.stream);
    await vi.waitFor(() => expect(audio.track.readyState).toBe("ended"));
    expect(audio.node()).toBeUndefined();
  });

  it("stops microphone hardware and emits real samples only on explicit stop", async () => {
    const audio = browserAudio();
    const recording = await startVoiceRecording({ signal: new AbortController().signal, onLimit: vi.fn() });
    audio.node().emit({ type: "samples", samples: new Float32Array(48000).fill(0.5) });
    const output = await recording.stop();
    expect(output.size).toBe(32044);
    const bytes = new DataView(await output.arrayBuffer());
    expect(bytes.getInt16(44, true)).toBe(16384);
    expect(audio.track.readyState).toBe("ended");
    expect(audio.context().state).toBe("closed");
    expect(audio.node().port.closed).toBe(true);
  });

  it("discards samples on cancel and cannot return an uploadable recording", async () => {
    const audio = browserAudio();
    const controller = new AbortController();
    const recording = await startVoiceRecording({ signal: controller.signal, onLimit: vi.fn() });
    audio.node().emit({ type: "samples", samples: new Float32Array(48000) });
    controller.abort();
    await expect(recording.stop()).rejects.toMatchObject({ name: "AbortError" });
    expect(audio.track.readyState).toBe("ended");
    expect(audio.context().state).toBe("closed");
    expect(audio.node().port.closed).toBe(true);
  });

  it("stops at 60 seconds but keeps captured samples available until the later release", async () => {
    vi.useFakeTimers();
    const audio = browserAudio();
    const onLimit = vi.fn();
    const recording = await startVoiceRecording({ signal: new AbortController().signal, onLimit });
    audio.node().emit({ type: "samples", samples: new Float32Array(48000) });
    await vi.advanceTimersByTimeAsync(60000);
    expect(onLimit).toHaveBeenCalledOnce();
    expect(audio.track.readyState).toBe("ended");
    expect(audio.context().state).toBe("closed");
    expect((await recording.stop()).size).toBe(32044);
  });

  it("does not mislabel a disconnected microphone as successful audio", async () => {
    const audio = browserAudio();
    const onError = vi.fn();
    const recording = await startVoiceRecording({ signal: new AbortController().signal, onLimit: vi.fn(), onError });
    audio.node().emit({ type: "samples", samples: new Float32Array(48000) });
    audio.track.dispatchEvent(new Event("ended"));
    expect(onError.mock.calls[0][0].name).toBe("NotReadableError");
    await expect(recording.stop()).rejects.toMatchObject({ name: "NotReadableError" });
    expect(audio.context().state).toBe("closed");
  });

  it("releases hardware at the worklet frame limit even after that processor becomes inactive", async () => {
    const audio = browserAudio();
    const onLimit = vi.fn();
    const recording = await startVoiceRecording({ signal: new AbortController().signal, onLimit });
    audio.node().port.postMessage = () => {};
    audio.node().emit({ type: "samples", samples: new Float32Array(48000 * 60) });
    audio.node().emit({ type: "limit" });
    await Promise.resolve();
    expect(onLimit).toHaveBeenCalledOnce();
    expect(audio.track.readyState).toBe("ended");
    expect(audio.context().state).toBe("closed");
    expect((await recording.stop()).size).toBe(1_920_044);
  });

  it("does not leave an unhandled rejection when initialization fails before microphone request", async () => {
    browserAudio();
    vi.stubGlobal("AudioContext", class {
      sampleRate = 48000;
      state = "running";
      close = async () => {};
    });
    await expect(startVoiceRecording({ signal: new AbortController().signal, onLimit: vi.fn() }))
      .rejects.toMatchObject({ name: "NotSupportedError" });
    await Promise.resolve();
  });
});

describe("voice capture worklet", () => {
  it("downmixes actual channels and enforces the frame cap before sending samples", () => {
    const messages: { type: string; samples?: Float32Array }[] = [];
    let Processor: new (options: unknown) => {
      process: (inputs: Float32Array[][]) => boolean;
      port: { onmessage: (event: { data: { type: string } }) => void };
    };
    vm.runInNewContext(readFileSync("public/voice-recorder-worklet.js", "utf8"), {
      AudioWorkletProcessor: class { port = { postMessage: (message: { type: string }) => messages.push(message) }; },
      registerProcessor: (_name: string, value: typeof Processor) => { Processor = value; },
      Float32Array,
    });
    const processor = new Processor!({ processorOptions: { maxFrames: 3 } });
    expect(processor.process([[new Float32Array([1, 0, -1, 0]), new Float32Array([0, 1, 0, -1])]])).toBe(false);
    expect(Array.from(messages[0].samples!)).toEqual([0.5, 0.5, -0.5]);
    expect(messages[1]).toEqual({ type: "limit" });
    processor.process([[new Float32Array([1])]]);
    expect(messages).toHaveLength(2);
    processor.port.onmessage({ data: { type: "stop" } });
    expect(messages[2]).toEqual({ type: "stopped" });
  });
});
