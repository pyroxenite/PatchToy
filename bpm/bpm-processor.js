class BPMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = 0;
    this.envLP = 0;
    this.envHP = 0;
    this.sampleRate_ = sampleRate;
    this.peakHold = 0;

    this.onsets = [];
    this.maxOnsets = 64;
    this.hist = new Map();
    this.lastPost = 0;
    this.lastOnsetTime = -Infinity;

    // tunables
    this.envFastFreq = 35;
    this.envSlowFreq = 1.2;
    this.minSurge = 0.002;
    this.triggerRatio = 1.7;
    this.refractoryMs = 90;

    this.frames = 0;
    this.lastOnsetDebug = 0;
  }

  lp(x, yPrev, fc) {
    const dt = 1 / this.sampleRate_;
    const RC = 1 / (2 * Math.PI * fc);
    const a = dt / (RC + dt);
    return yPrev + a * (x - yPrev);
  }

  registerOnset(t) {
    this.onsets.push(t);
    if (this.onsets.length > this.maxOnsets) this.onsets.shift();
    this.lastOnsetTime = t;

    const L = this.onsets.length;
    if (L < 2) return;

    const last = this.onsets[L - 1];
    const startIdx = Math.max(0, L - 12);
    for (let i = startIdx; i < L - 1; i++) {
      const dt = last - this.onsets[i];
      if (dt <= 0.12 || dt > 2.0) continue;
      let bpm = 60 / dt;
      while (bpm < 60) bpm *= 2;
      while (bpm > 200) bpm /= 2;
      const key = Math.round(bpm * 2) / 2;
      const weight = 1.0 / (1 + (L - 1 - i));
      const prev = this.hist.get(key) || 0;
      this.hist.set(key, 0.98 * prev + weight);
    }
    for (const k of this.hist.keys()) {
      const v = this.hist.get(k) * 0.995;
      if (v < 0.01) this.hist.delete(k); else this.hist.set(k, v);
    }
  }

  estimateBPM() {
    let total = 0;
    let bestK = null;
    let bestV = -1;
    for (const [k, v] of this.hist.entries()) {
      total += v;
      if (v > bestV) { bestV = v; bestK = k; }
    }

    let cluster = 0;
    const clusterRadius = 1.0;
    if (bestK != null) {
      for (const [k, v] of this.hist.entries()) {
        if (Math.abs(k - bestK) <= clusterRadius) cluster += v;
      }
    }

    const histStrength = total > 0 ? Math.min(1, cluster / total) : 0;
    const hasOnset = this.lastOnsetTime > -Infinity;
    const age = hasOnset ? currentTime - this.lastOnsetTime : Infinity;
    const recency = hasOnset && isFinite(age) ? Math.exp(-age / 2.0) : 0;
    const confidence = Math.max(0, Math.min(1, 0.75 * histStrength + 0.25 * recency));

    if (bestK == null) {
      return { confidence };
    }

    let acc = 0, w = 0;
    for (const [k, v] of this.hist.entries()) {
      if (Math.abs(k - bestK) <= 1.0) { acc += k * v; w += v; }
    }
    const bpm = w > 0 ? acc / w : bestK;
    if (!isFinite(bpm) || bpm < 40 || bpm > 240) {
      return { confidence };
    }
    return { bpm: Math.round(bpm), confidence };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0]; const ch1 = input[1];
    const N = ch0.length;

    const refractorySamples = Math.round(this.refractoryMs * this.sampleRate_ / 1000);

    for (let i = 0; i < N; i++) {
      const s0 = ch0[i] || 0;
      const s1 = ch1 ? ch1[i] : 0;
      const s = 0.5 * (s0 + s1);

      const rect = Math.abs(s);
      this.env = this.lp(rect, this.env, this.envFastFreq);
      this.envLP = this.lp(this.env, this.envLP, this.envSlowFreq);
      this.envHP = Math.max(0, this.env - this.envLP);

      if (this.peakHold > 0) {
        this.peakHold--;
      } else {
        const ratio = this.envLP > 1e-4 ? this.env / this.envLP : Infinity;
        if (this.envHP > this.minSurge && ratio > this.triggerRatio) {
          this.registerOnset(currentTime);
          this.peakHold = refractorySamples;
          this.port.postMessage({ onset: currentTime });
          if (currentTime - this.lastOnsetDebug > 0.25) {
            this.port.postMessage({
              debug: `onset env=${this.env.toFixed(4)} slow=${this.envLP.toFixed(4)} hp=${this.envHP.toFixed(4)} ratio=${ratio.toFixed(2)}`
            });
            this.lastOnsetDebug = currentTime;
          }
        }
      }
    }

    if (currentTime - this.lastPost > 0.1) {
      const estimate = this.estimateBPM();
      if (estimate) this.port.postMessage(estimate);
      this.lastPost = currentTime;

      // occasional debug
      if ((this.frames++ % 50) === 0) {
        this.port.postMessage({ debug: `hist bins=${this.hist.size}` });
      }
    }

    return true;
  }
}
registerProcessor('bpm-processor', BPMProcessor);
