class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.acc = 0;
    this.count = 0;
    this.lastPost = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0]; const ch1 = input[1];
    const N = ch0.length;

    // accumulate RMS over block
    for (let i = 0; i < N; i++) {
      const s0 = ch0[i] || 0;
      const s1 = ch1 ? ch1[i] : 0;
      const s = 0.5 * (s0 + s1);
      this.acc += s * s;
      this.count++;
    }

    if (currentTime - this.lastPost > 0.05 && this.count > 0) {
      const rms = Math.sqrt(this.acc / this.count);
      this.port.postMessage({ rms });
      this.acc = 0; this.count = 0;
      this.lastPost = currentTime;
    }
    return true;
  }
}
registerProcessor('meter-processor', MeterProcessor);