// AudioWorklet: resample the device clock to 16 kHz and batch 128 ms PCM frames.
class LiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Float32Array(2048);
    this.index = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const value of channel) {
      this.sum += value;
      this.count++;
      this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.frame[this.index++] = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        if (this.index === this.frame.length) {
          this.port.postMessage(this.frame, [this.frame.buffer]);
          this.frame = new Float32Array(2048);
          this.index = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("live-capture", LiveCapture);
