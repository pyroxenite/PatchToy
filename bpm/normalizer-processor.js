class NormalizerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.runningRMS = 0.001;
    this.targetRMS = 0.25;      // ≈ -12 dBFS
    this.attack = 0.05;         // seconds
    this.release = 1.0;         // seconds
    this.sampleRate_ = sampleRate;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const ch1 = input[1];
    const N = ch0.length;

    // measure RMS
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const s0 = ch0[i] || 0;
      const s1 = ch1 ? ch1[i] : 0;
      const s = 0.5 * (s0 + s1);
      acc += s * s;
    }
    const rms = Math.sqrt(acc / N);

    // smooth RMS (EMA)
    const dt = N / this.sampleRate_;
    const tau = rms > this.runningRMS ? this.attack : this.release;
    const alpha = 1 - Math.exp(-dt / tau);
    this.runningRMS += alpha * (rms - this.runningRMS);

    // gain toward target
    let g = this.targetRMS / (this.runningRMS + 1e-6);
    g = Math.min(8, Math.max(0.1, g)); // clamp  -20 dB..+18 dB

    // apply gain
    for (let c = 0; c < output.length; c++) {
      const inp = input[c] || input[0];
      const out = output[c];
      for (let i = 0; i < N; i++) out[i] = inp[i] * g;
    }

    return true;
  }
}
registerProcessor('normalizer-processor', NormalizerProcessor);