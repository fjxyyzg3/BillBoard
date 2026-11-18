export const MAX_VOICE_AUDIO_BYTES = 2 * 1024 * 1024;

export type VoiceAudioError = "invalid_audio" | "audio_too_large" | "audio_too_long" | "no_speech";

export function validateVoiceWav(audio: Uint8Array): VoiceAudioError | null {
  if (audio.byteLength > MAX_VOICE_AUDIO_BYTES) return "audio_too_large";
  if (audio.byteLength < 44) return "invalid_audio";
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const tag = (offset: number, value: string) => [...value].every((character, index) => audio[offset + index] === character.charCodeAt(0));

  // The browser encoder emits one PCM format chunk followed by one data chunk.
  // Reject additional metadata and inconsistent lengths instead of repairing input.
  if (!tag(0, "RIFF") || !tag(8, "WAVE") || !tag(12, "fmt ") || !tag(36, "data")
    || view.getUint32(4, true) !== audio.byteLength - 8
    || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1
    || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000
    || view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2
    || view.getUint16(34, true) !== 16) return "invalid_audio";

  const dataLength = view.getUint32(40, true);
  if (dataLength !== audio.byteLength - 44 || dataLength % 2 !== 0) return "invalid_audio";
  if (dataLength > 60 * 16000 * 2) return "audio_too_long";
  if (dataLength === 0 || audio.subarray(44).every((value) => value === 0)) return "no_speech";
  return null;
}
