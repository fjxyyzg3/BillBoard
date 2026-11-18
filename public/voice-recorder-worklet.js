/* global AudioWorkletProcessor, registerProcessor */

class VoiceRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.remaining = options.processorOptions.maxFrames;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === "stop") {
        this.active = false;
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0].length) return true;
    const length = Math.min(channels[0].length, this.remaining);
    const samples = new Float32Array(length);
    for (const channel of channels) {
      for (let index = 0; index < length; index++) samples[index] += channel[index] / channels.length;
    }
    // Leave the output silent: the connected destination keeps processing alive without feedback.
    this.port.postMessage({ type: "samples", samples }, [samples.buffer]);
    this.remaining -= length;
    if (!this.remaining) {
      this.active = false;
      this.port.postMessage({ type: "limit" });
    }
    return this.active;
  }
}

registerProcessor("billboard-voice-recorder", VoiceRecorderProcessor);
