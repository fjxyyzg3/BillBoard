import { describe, expect, it } from "vitest";
import { MAX_VOICE_AUDIO_BYTES, validateVoiceWav } from "@/lib/voice/wav";
import { wav } from "../fixtures/voice-wav";

describe("voice WAV validation", () => {
  it("accepts mono PCM16 at 16 kHz including the exact 60-second limit", () => {
    expect(validateVoiceWav(wav())).toBeNull();
    expect(validateVoiceWav(wav(60 * 16000))).toBeNull();
  });

  it("rejects empty and entirely silent recordings", () => {
    expect(validateVoiceWav(new Uint8Array())).toBe("invalid_audio");
    expect(validateVoiceWav(wav(0))).toBe("no_speech");
    expect(validateVoiceWav(wav(16000, 0))).toBe("no_speech");
  });

  it("rejects oversized and overlong audio without truncating samples", () => {
    expect(validateVoiceWav(new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1))).toBe("audio_too_large");
    expect(validateVoiceWav(wav(60 * 16000 + 1))).toBe("audio_too_long");
  });

  it.each([
    [0, 0], [4, 0], [8, 0], [12, 0], [16, 18], [20, 3], [22, 2],
    [24, 48000], [28, 64000], [32, 4], [34, 8], [36, 0], [40, 2],
  ])("rejects inconsistent header field at %i", (offset, value) => {
    const audio = wav();
    if ([20, 22, 32, 34].includes(offset)) audio.writeUInt16LE(value, offset);
    else audio.writeUInt32LE(value, offset);
    expect(validateVoiceWav(audio)).toBe("invalid_audio");
  });

  it("rejects truncated, trailing and partial sample data", () => {
    expect(validateVoiceWav(wav().subarray(0, 43))).toBe("invalid_audio");
    expect(validateVoiceWav(wav().subarray(0, 100))).toBe("invalid_audio");
    const trailing = Buffer.concat([wav(), Buffer.from([1])]);
    trailing.writeUInt32LE(trailing.length - 8, 4);
    expect(validateVoiceWav(trailing)).toBe("invalid_audio");
  });

  it("validates a view using its own byte offset and length", () => {
    const audio = wav();
    const wrapped = Buffer.concat([Buffer.alloc(7), audio, Buffer.alloc(9)]);
    expect(validateVoiceWav(wrapped.subarray(7, 7 + audio.length))).toBeNull();
  });
});
