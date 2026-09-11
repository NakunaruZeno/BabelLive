/**
 * BabelLive — AudioWorklet Processor
 * Converts Float32 audio samples to Int16 PCM and buffers into frames.
 * Posts each frame (320 samples = 20ms @ 16kHz) to the main thread.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._frameSize = options.processorOptions?.frameSize ?? 320;
    this._buffer = new Int16Array(this._frameSize);
    this._writePos = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = channel[i];
      // Clamp and convert Float32 [-1, 1] to Int16 [-32768, 32767]
      this._buffer[this._writePos++] = s < -1 ? -32768 : s > 1 ? 32767 : (s * 32767) | 0;
      if (this._writePos >= this._frameSize) {
        this.port.postMessage(this._buffer.slice(0));
        this._writePos = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
