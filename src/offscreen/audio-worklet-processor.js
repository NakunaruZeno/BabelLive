/**
 * BabelLive — AudioWorklet Processor
 * Converts Float32 audio samples to 16kHz Int16 PCM on the dedicated audio rendering thread.
 * Emits 2048-sample frames (128ms @ 16kHz = 4096 bytes) via zero-copy transferable ArrayBuffer.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._frameSize = options?.processorOptions?.frameSize || 2048;
    this._buffer = new Int16Array(this._frameSize);
    this._writePos = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = channel[i];
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      this._buffer[this._writePos++] = clamped < 0 ? (clamped * 0x8000) | 0 : (clamped * 0x7FFF) | 0;

      if (this._writePos >= this._frameSize) {
        const frame = new Int16Array(this._buffer);
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this._writePos = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
