/**
 * PatchToy audio analysis: band levels, kick onsets, tempo and a phase-locked beat.
 *
 * This file is self-contained (no imports) because it is loaded two ways:
 *  - in the browser as an AudioWorklet module (AudioEngine adds it with
 *    `audioWorklet.addModule(new URL('./audio/beat-worklet.js', import.meta.url))`,
 *    which Vite copies verbatim), where it registers the 'patchtoy-analysis' processor;
 *  - in Node, as a plain ES module, so the tracker can be tested offline on
 *    synthetic signals (`import { BeatTracker } from '.../beat-worklet.js'`).
 *
 * Pipeline (one analysis frame every `hop` samples, ~5.3 ms at 48 kHz):
 *
 *   samples -> Hann window -> FFT (1024) -> ~21 log-spaced bands
 *     -> per-band log compression, normalised by the band's running level (whitening)
 *     -> half-wave rectified difference vs. 2 frames ago (spectral flux, max-filtered
 *        across neighbouring bands to ignore pitch glides), weighted towards the low end
 *     -> onset strength o[n] (mean ~1), minus its running mean, clipped at 0;
 *        the same for the kick band alone (oLow[n], < 200 Hz); and the physical level
 *        rise in dB (rise[n]), which, unlike the whitened flux, stays small for noise
 *
 *   tempo:  every 0.25 s, autocorrelation of o[n] (decimated to ~94 Hz) over two windows:
 *           8 s (stable estimate) and 3 s (fast change detection). Each candidate period
 *           (70-180 BPM, 0.5 BPM steps) is scored with a comb over its multiples, times a
 *           broad prior. Ratio ambiguities are settled with two cues (resolveRatio):
 *           octaves (x2, x1/2) by beat alternation (at double time every other beat is an
 *           off-beat), other ratios (x3/2, x4/3 ...) by phase-comb peakiness (at the right
 *           tempo one alignment collects the onsets of every bar). Re-checked twice in the
 *           8 s after adopting a tempo, with hysteresis for octave changes; a metrical ratio
 *           the 8 s window disagrees with must be the answer 3 times in a row (the peakiness
 *           is noisy on smeared room-mic onsets), and one the slow path has reverted is not
 *           tried again (no tempo ping-pong).
 *   switching: the current tempo is followed continuously by the beat filter (below), so
 *           the autocorrelation only decides when the music has *changed*:
 *            - fast path: the beat filter has lost the beat and the 3 s window clearly and
 *              periodically prefers a tempo that is not a simple ratio of the current one
 *              for 0.75 s (track change / DJ cut: relock in ~3 s);
 *            - slow path: the 8 s window clearly prefers another tempo for ~3 s;
 *            - simple ratios of a well-locked tempo (octave flips) need ~10 s of clearly
 *              better evidence while the beat is lost, so syncopation, fills and half-time
 *              sections don't flip the tempo.
 *   beat:   a Kalman filter on (next beat time, period, period drift per beat). After each
 *           predicted beat, the strongest onset cluster near the prediction gives a timing
 *           measurement (its centroid) and a weight (salience x distance x dB rise); the
 *           measurement noise scales with 1/weight and errors far outside the predicted
 *           spread are down-weighted (fills). Gradual tempo changes (live drummers,
 *           accelerando, DJ pitch nudges) are followed continuously: the period glides
 *           instead of stepping, and a persistent bias in the errors (maneuver detection)
 *           raises the process noise while the tempo moves, lowers it while it is steady.
 *           The timing noise is learned from the scatter of the errors (a few ms for clean
 *           drums, 15-25 ms through a room mic), so noisy timing neither drags the period nor
 *           looks like a tempo change. When the 8 s tempo estimate has been steady for 4 s
 *           (constant-tempo music) the period is held to it (~5 s time constant) with less
 *           process noise: no +-1-2% wander on weak onsets, ramps still followed.
 *           Silence gives no update: the filter coasts at the last tempo. After a confident
 *           lock the coasting is protected (breakdowns): weak onsets count quadratically
 *           less, corrections are capped, the period is held near the last confident tempo.
 *   phase:  when a tempo is adopted, the phase is the best comb alignment of recent onsets
 *           (per-beat compressed, so steady onsets on every beat beat a few loud syncopated
 *           ones; the kick band is weighted in lightly), re-checked 3 s later. If the filter
 *           loses the beat and another alignment stays better, it re-aligns: within ~1 s
 *           when drum hits (level jumps like the beats it locked to) now land there (a new
 *           track), after 3-9 s of persistent evidence otherwise, and never onto an
 *           alignment without drum-like hits (an off-beat bass line in a breakdown).
 *   output: the beat period for the clock, a smoothed tempo for display / u_bpm (level +
 *           trend smoothing: steady when the tempo is, no lag on ramps) and a confidence
 *           (0 no beat / coasting, ~0.5 tentative, ~1 locked: periodicity x hit rate, with
 *           long-term evidence as a floor: tempo agreeing with the steady 8 s estimate and the
 *           tracked phase being the best, clearly peaked comb alignment over 8 s and 4 s, so
 *           weak but consistent onsets (room mic) still give a confident beat; the floor goes
 *           when the hits collapse relative to their own recent level: new track, break).
 *   kick:   low-band (<200 Hz) flux against an adaptive threshold (running mean +
 *           deviation, and half of the recent kick peak), 120 ms refractory period.
 *
 * Times reported to the main thread are AudioContext times of the *signal* (the
 * analysis delay is already subtracted), so the main thread only adds input/output
 * latency to place beats on the audible timeline.
 */

// ---------------------------------------------------------------------------
// Message layout (worklet -> main thread), a Float64Array posted every 2 frames.
// Keep in sync with AudioEngine.js (it imports nothing from here on purpose).
// ---------------------------------------------------------------------------
export const MSG = {
    TIME: 0,          // signal time (s) of the newest analysed frame
    LEVEL: 1,         // 0..1 auto-gained bands
    BASS: 2,
    LOWMID: 3,
    MID: 4,
    HIGH: 5,
    KICK_TIME: 6,     // signal time of the latest kick onset (-1 = none yet)
    KICK_COUNT: 7,    // increments on every kick onset
    BPM: 8,           // current tempo, smoothed for display / u_bpm (0 = none yet)
    CONFIDENCE: 9,    // 0..1
    BEAT_TIME: 10,    // signal time of a predicted beat (anchor), -1 = none
    PERIOD: 11,       // seconds per beat (tracking period: follows tempo changes beat by beat)
    MIC_RMS: 12,      // envelope of input 1 (Microphone node meter)
    INPUT_DB: 13,     // input level in dBFS (for "no signal" hints)
    LOCKED: 14,       // 1 when the tempo is locked by the user
    ODF: 15,          // current onset strength (debug / meters)
    SIZE: 16
};

const TWO_PI = Math.PI * 2;

/** In-place iterative radix-2 complex FFT. */
class FFT {
    constructor(n) {
        this.n = n;
        let levels = 0;
        while ((1 << levels) < n) levels++;
        this.rev = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            let r = 0;
            for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
            this.rev[i] = r;
        }
        this.cos = new Float64Array(n / 2);
        this.sin = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            this.cos[i] = Math.cos(TWO_PI * i / n);
            this.sin[i] = -Math.sin(TWO_PI * i / n);
        }
    }

    transform(re, im) {
        const n = this.n;
        const rev = this.rev;
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let size = 2; size <= n; size <<= 1) {
            const half = size >>> 1;
            const step = n / size;
            for (let start = 0; start < n; start += size) {
                for (let k = 0, t = 0; k < half; k++, t += step) {
                    const a = start + k;
                    const b = a + half;
                    const wr = this.cos[t];
                    const wi = this.sin[t];
                    const xr = re[b] * wr - im[b] * wi;
                    const xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
            }
        }
    }
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Running-mean coefficient that starts as a plain average (unbiased from the first frame). */
const warm = (c, count) => (count < 1 ? 1 : Math.max(c, 1 / (count + 1)));

/** One-pole smoothing coefficient for a time constant (s) at a given update interval (s). */
const coef = (tau, dt) => 1 - Math.exp(-dt / tau);

/** a and b are the same tempo within 1.5%, or octaves of each other. */
function sameTempo(a, b) {
    const r = a / b;
    return Math.abs(r - 1) < 0.015 || Math.abs(r / 2 - 1) < 0.015 || Math.abs(r * 2 - 1) < 0.015;
}

/** Simple tempo ratios (octave and metrical errors). */
const RATIOS = [2, 0.5, 1.5, 2 / 3, 3, 1 / 3, 4 / 3, 0.75];

/** The simple ratio a/b is close to (0 = none). */
function ratioOf(a, b, tol = 0.03) {
    const r = a / b;
    for (let i = 0; i < RATIOS.length; i++) if (Math.abs(r / RATIOS[i] - 1) < tol) return RATIOS[i];
    return 0;
}

export const TRACKER_DEFAULTS = {
    minBpm: 70,
    maxBpm: 180,
    preferLow: 85,      // flat prior between preferLow and preferHigh
    preferHigh: 165,
    priorWidth: 0.4,    // octaves (Gaussian falloff outside the preferred range)
    tempoWindow: 8,     // s of onset strength used for the stable tempo estimate
    shortWindow: 3,     // s used for fast change detection
    tempoEvery: 0.25,   // s between tempo estimates
    switchAfter: 3.0,   // s a competing tempo must stay clearly better before switching
    switchRatio: 1.15,  // "clearly better" = score ratio
    fastSwitchAfter: 0.75, // s for the fast path (beat lost + recent window clearly prefers another tempo)
    fastRatio: 1.3,
    fastClarity: 0.6,
    fastStrength: 1.8,  // phase-comb peakiness the new tempo needs on the fast path (a real beat)
    octaveSwitchAfter: 10, // s for a simple ratio (x2, x1/2, x3/2 ...) of a well-locked tempo
    freshTime: 8,       // s after adopting a tempo during which a ratio switch is still easy
    altThreshold: 0.32, // beat alternation above which a tempo is taken as double time
    phaseWindow: 6,     // s used for comb phase alignment
    combPower: 0.5,     // per-beat compression in the phase comb (1 = linear): rewards an onset on every beat
    lowPhaseWeight: 0.25, // weight of the kick-band onsets in phase alignment (syncopated kicks: keep it low)
    // Beat Kalman filter (state: next beat time, period, period drift per beat)
    kfSigmaMs: 6,       // onset timing noise of a clear onset (ms)
    kfQPhase: 0.003,    // process noise per beat, as fractions of the period
    kfQPeriod: 0.0015,
    kfQDrift: 0.0015,
    kfRho: 0.9,         // drift persistence per beat (decays to 0 without new evidence)
    kfAdaptive: true,   // timing noise learned from the measured errors (else kfSigmaMs throughout)
    kfAdaptMax: 4,      // ... up to this many times kfSigmaMs
    acqBeats: 8,        // beats of faster lock-quality tracking after (re)locking
    displayTau: 1.2,    // s, smoothing of the reported (display) tempo
    detectDelay: null   // analysis delay (s) subtracted from reported times; null = calibrated default
};

/**
 * Pure analysis core: feed it mono blocks with `process(samples)`; read the public
 * fields (level, bass, ..., bpm, confidence, beatTime, period, kickTime, kickCount).
 */
export class BeatTracker {
    constructor(sampleRate, options = {}) {
        this.opts = { ...TRACKER_DEFAULTS, ...options };
        const sr = this.sr = sampleRate;
        const scale = sr > 60000 ? 2 : 1;
        const N = this.N = 1024 * scale;
        const hop = this.hop = 256 * scale;
        this.fps = sr / hop;
        this.dt = hop / sr;

        // Calibrated offline on synthetic drums: the log-flux of a percussive onset peaks
        // about half a window after the attack enters the frame (mean beat error ~0 ms).
        this.detectDelay = this.opts.detectDelay != null ? this.opts.detectDelay : (N * 0.48) / sr;

        this.fft = new FFT(N);
        this.window = new Float64Array(N);
        let wsum = 0;
        for (let i = 0; i < N; i++) {
            this.window[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / N);
            wsum += this.window[i];
        }
        this.magScale = 2 / wsum; // full-scale sine -> magnitude 1
        this.re = new Float64Array(N);
        this.im = new Float64Array(N);
        this.ring = new Float32Array(N);
        this.ringPos = 0;
        this.sinceHop = 0;
        this.samples = 0;
        this.timeBase = 0;
        this.started = false;

        // ---- Filterbank: log-spaced bands, at least one bin wide ----
        const binHz = sr / N;
        const maxBin = Math.min(N / 2 - 1, Math.floor(12000 / binHz));
        const edges = [1];
        while (edges[edges.length - 1] < maxBin) {
            const prev = edges[edges.length - 1];
            edges.push(Math.min(maxBin, Math.max(prev + 1, Math.round(prev * Math.pow(2, 1 / 3)))));
        }
        this.bandLo = new Int32Array(edges.length - 1);
        this.bandHi = new Int32Array(edges.length - 1);
        this.bandW = new Float64Array(edges.length - 1);
        this.bandLow = new Uint8Array(edges.length - 1);
        for (let b = 0; b < edges.length - 1; b++) {
            this.bandLo[b] = edges[b];
            this.bandHi[b] = edges[b + 1]; // exclusive
            const fc = binHz * (edges[b] + edges[b + 1] - 1) / 2;
            this.bandW[b] = fc < 250 ? 2.5 : fc < 4000 ? 1.0 : 0.6;
            this.bandLow[b] = fc < 200 ? 1 : 0;
        }
        const B = this.nBands = this.bandLo.length;
        this.bandMag = new Float64Array(B);
        this.bandRef = new Float64Array(B);
        this.bandLog = new Float64Array(B);
        this.bandLog1 = new Float64Array(B); // 1 frame ago
        this.bandLog2 = new Float64Array(B); // 2 frames ago

        // ---- Uniform bands (Hz edges) -> bin ranges ----
        const bin = f => clamp(Math.round(f / binHz), 1, N / 2 - 1);
        this.uBands = [
            [bin(20), bin(sr / 2)],    // level
            [bin(20), bin(150)],       // bass
            [bin(150), bin(500)],      // lowMid
            [bin(500), bin(2000)],     // mid
            [bin(2000), bin(Math.min(16000, sr / 2))] // high
        ];
        for (const r of this.uBands) if (r[1] <= r[0]) r[1] = r[0] + 1;
        this.uDb = new Float64Array(5);
        this.uPeak = new Float64Array(5).fill(-60);
        this.uFloor = new Float64Array(5).fill(-60);
        this.uOut = new Float64Array(5);
        this.level = 0; this.bass = 0; this.lowMid = 0; this.mid = 0; this.high = 0;
        this.inputDb = -120;

        // ---- Onset strength ----
        this.refCoef = coef(3.0, this.dt);
        this.odfMean = 0;            // long mean for normalisation
        this.odfMeanCoef = coef(4.0, this.dt);
        this.excessMean = 1;         // short mean for the excess signal
        this.excessCoef = coef(1.0, this.dt);
        this.odf = 0;
        this.ringSize = 1;
        while (this.ringSize < this.fps * 13) this.ringSize <<= 1;
        this.mask = this.ringSize - 1;
        this.o = new Float32Array(this.ringSize);   // excess onset strength per frame
        this.oLow = new Float32Array(this.ringSize); // excess kick-band onset strength per frame
        this.rise = new Float32Array(this.ringSize); // level rise (dB over 2 frames) per frame
        this.levelDb1 = -120;
        this.levelDb2 = -120;
        this.n = -1;                                // index of the newest frame
        this.firstFull = Math.ceil(N / hop) - 1;    // first frame without zero padding
        this.warmup = Math.round(this.fps);         // frames ignored by the tempo estimator

        // ---- Kick detection ----
        this.lowMean = 0;
        this.lowMeanCoef = coef(2.0, this.dt);
        this.kMu = 0; this.kDev = 0;
        this.kCoef = coef(1.2, this.dt);
        this.kPrev = 0;
        this.kPeak = 0;
        this.kPeakDecay = Math.exp(-this.dt / 3.0);
        this.kickTime = -1;
        this.kickCount = 0;
        this.lastKickFrame = -1e9;

        // ---- Tempo ----
        const o = this.opts;
        const fpsd = this.fpsd = this.fps / 2;
        this.tempoLen = Math.round(o.tempoWindow * fpsd);
        this.shortLen = Math.round(o.shortWindow * fpsd);
        this.maxLag = Math.ceil(4 * 60 / o.minBpm * fpsd) + 3;
        this.maxLagS = Math.ceil(2 * 60 / o.minBpm * fpsd) + 3;
        this.xd = new Float64Array(this.tempoLen);
        this.xs = new Float64Array(this.shortLen);
        this.acf = new Float64Array(this.maxLag + 1);
        this.acfS = new Float64Array(this.maxLagS + 1);
        const nCand = Math.round((o.maxBpm - o.minBpm) / 0.5) + 1;
        this.candBpm = new Float64Array(nCand);
        this.candPrior = new Float64Array(nCand);
        this.candScore = new Float64Array(nCand);
        this.candScoreS = new Float64Array(nCand);
        this.candSorted = new Float64Array(nCand);
        for (let i = 0; i < nCand; i++) {
            const b = o.minBpm + i * 0.5;
            this.candBpm[i] = b;
            this.candPrior[i] = this.prior(b);
        }
        this.tempoEveryFrames = Math.round(o.tempoEvery * this.fps);
        this.nextTempoAt = Math.round(4.5 * this.fps);
        this.hasAcf = false;
        this.bpm = 0;                 // current tempo (beat filter period), 0 = none
        this.bpmOut = 0;              // smoothed tempo for display
        this.bpmTrend = 0;            // its trend (BPM per frame)
        this.tempoConf = 0;           // smoothed tempo clarity 0..1
        this.clarityL = 0;
        this.clarityS = 0;
        this.acfBpm = 0;              // latest raw estimates (8 s / 4 s windows)
        this.acfBpmS = 0;
        this.acfHist = new Float64Array(16); // last 4 s of 8 s estimates (steadiness)
        this.acfHistN = 0;
        this.acfSteady = 0;           // mean of acfHist while it is steady and clear, else 0
        this.challenger = 0;
        this.challengeTime = 0;
        this.fastCand = 0;
        this.fastTime = 0;
        this.pending = 0;             // first-lock candidate
        this.pendingCount = 0;
        this.freshUntil = 0;          // frame until which the adopted tempo is still tentative
        this.resolveChecks = 0;       // pending re-checks of the tempo ratio after adopting a tempo
        this.resolveAt = 0;
        this.ratioPend = 0;           // metrical ratio waiting for confirmation (re-check)
        this.ratioPendCount = 0;
        this.ratioSwitch = null;      // last switch made by the ratio re-check { from, to, n }
        this.ratioVeto = null;        // a ratio switch the slow path reverted { a, b }
        this.locked = false;          // user-locked tempo

        // ---- Beat filter (frame units) ----
        this.hasBeat = false;
        this.P = 0.5 * this.fps;      // frames per beat
        this.D = 0;                   // period drift per beat
        this.C = new Float64Array(9); // 3x3 covariance (row-major) of (tau, P, D)
        this.tmp = new Float64Array(9);
        this.evalBeat = 0;            // tau: next predicted beat awaiting its measurement
        this.acq = 0;
        this.lockQ = 0;               // lock quality: smoothed onset-on-prediction weight (~8 beats)
        this.q3 = 0;                  // the same over ~3 beats (fast loss detection, gain scaling)
        this.q3Ref = 0;               // q3's recent level (~15 beats)
        this.misCount = 0;
        this.drumMis = 0;             // consecutive checks where drum hits moved to another phase
        this.trust = 0;
        this.confirmAt = 0;
        this.nextPhaseCheck = 0;
        this.confidence = 0;
        this.evidence = 0;            // long-term tempo / phase agreement 0..1 (updateEvidence)
        this.tempoRef = 0;            // last steady 8 s tempo (updateEvidence)
        this.evParts = new Float64Array(4); // (debug / tests) tempo, peak, best8, best4 factors of it
        this.beatTime = -1;
        this.period = 0.5;
        this.lastError = 0;
        this.lastSalience = 0;
        this.riseRef = 0;             // typical level rise (dB) of recent on-beat onsets
        this.anchorP = 0;             // period of the last confident lock (held through breaks)
        this.eBar = 0;                // running mean of the timing errors (maneuver detection)
        this.eVar = 0;                // their variance around that mean (timing noise, frames^2; 0 = unknown)
        this.qBoost = 0;              // 0 = steady tempo, 1 = tempo moving
    }

    prior(b) {
        const o = this.opts;
        if (b < o.preferLow) {
            const x = Math.log2(b / o.preferLow) / o.priorWidth;
            return Math.exp(-0.5 * x * x);
        }
        if (b > o.preferHigh) {
            const x = Math.log2(b / o.preferHigh) / o.priorWidth;
            return Math.exp(-0.5 * x * x);
        }
        return 1;
    }

    /** Signal time (s) of analysis frame m (detection delay already removed). */
    frameTime(m) {
        return this.timeBase + ((m + 1) * this.hop - this.detectDelay * this.sr) / this.sr;
    }

    /** Inverse of frameTime. */
    timeToFrame(t) {
        return ((t - this.timeBase) * this.sr + this.detectDelay * this.sr) / this.hop - 1;
    }

    /** Feed mono samples. `startTime` (s) is the signal time of samples[0] (first call only). */
    process(samples, startTime = 0) {
        if (!this.started) {
            this.started = true;
            this.timeBase = startTime;
        }
        const N = this.N;
        for (let i = 0; i < samples.length; i++) {
            this.ring[this.ringPos] = samples[i];
            this.ringPos = (this.ringPos + 1) % N;
            if (++this.sinceHop === this.hop) {
                this.sinceHop = 0;
                this.samples += this.hop;
                this.analyzeFrame();
            }
        }
    }

    analyzeFrame() {
        const N = this.N;
        const re = this.re;
        const im = this.im;
        let pos = this.ringPos; // oldest sample
        let sumSq = 0;
        for (let i = 0; i < N; i++) {
            const s = this.ring[pos];
            sumSq += s * s;
            re[i] = s * this.window[i];
            im[i] = 0;
            pos = pos + 1 === N ? 0 : pos + 1;
        }
        this.inputDb = 10 * Math.log10(sumSq / N + 1e-12);
        this.fft.transform(re, im);
        const scale2 = this.magScale * this.magScale;
        // power spectrum into re[0..N/2)
        for (let k = 0; k < N / 2; k++) re[k] = (re[k] * re[k] + im[k] * im[k]) * scale2;

        this.n++;
        const n = this.n;
        this.updateBands(re);
        this.updateOnset(re, n);
        this.updateKick(n);
        if (n >= this.nextTempoAt) {
            this.nextTempoAt = n + this.tempoEveryFrames;
            this.estimateTempo(n);
        }
        this.updateBeat(n);
    }

    updateBands(pow) {
        const dt = this.dt;
        for (let u = 0; u < 5; u++) {
            const [lo, hi] = this.uBands[u];
            let s = 0;
            for (let k = lo; k < hi; k++) s += pow[k];
            // Sum of power over the band (energy), in dB
            const db = 10 * Math.log10(s + 1e-12);
            if (u === 0) {
                // physical level rise: unlike the whitened flux, it stays small for noise in quiet parts
                const r = db - this.levelDb2;
                this.levelDb2 = this.levelDb1;
                this.levelDb1 = db;
                this.rise[this.n & this.mask] = r > 0 && r < 60 ? r : 0;
            }
            // Peak follower: fast attack, ~6 s release; floor follower: fast fall, ~4 s rise
            let pk = this.uPeak[u];
            pk = db > pk ? pk + (db - pk) * 0.5 : pk + (db - pk) * coef(6, dt);
            let fl = this.uFloor[u];
            fl = db < fl ? fl + (db - fl) * 0.2 : fl + (db - fl) * coef(4, dt);
            if (pk < -75) pk = -75;
            this.uPeak[u] = pk;
            this.uFloor[u] = fl;
            const range = Math.max(18, pk - fl);
            const target = clamp((db - (pk - range)) / range, 0, 1);
            const v = target * target; // expand: quiet stays low, peaks pop
            const prev = this.uOut[u];
            this.uOut[u] = prev + (v - prev) * (v > prev ? coef(0.012, dt) : coef(0.14, dt));
        }
        this.level = this.uOut[0];
        this.bass = this.uOut[1];
        this.lowMid = this.uOut[2];
        this.mid = this.uOut[3];
        this.high = this.uOut[4];
    }

    updateOnset(pow, n) {
        const B = this.nBands;
        const mag = this.bandMag;
        // frames counted from the first one whose window holds only real samples
        const valid = n - this.firstFull;
        let global = 0;
        const rc = warm(this.refCoef, valid);
        for (let b = 0; b < B; b++) {
            let s = 0;
            const lo = this.bandLo[b];
            const hi = this.bandHi[b];
            for (let k = lo; k < hi; k++) s += pow[k];
            mag[b] = Math.sqrt(s / (hi - lo));
            const r = this.bandRef[b] + (mag[b] - this.bandRef[b]) * rc;
            this.bandRef[b] = r;
            global += r;
        }
        global /= B;
        const floor = Math.max(1e-6, global * 0.05);
        let flux = 0;
        let lowFlux = 0;
        for (let b = 0; b < B; b++) {
            const ref = Math.max(this.bandRef[b], floor);
            const L = Math.log(1 + mag[b] / (0.25 * ref));
            // previous level: max over neighbouring bands 2 frames ago (vibrato suppression)
            let prev = this.bandLog2[b];
            if (b > 0 && this.bandLog2[b - 1] > prev) prev = this.bandLog2[b - 1];
            if (b < B - 1 && this.bandLog2[b + 1] > prev) prev = this.bandLog2[b + 1];
            const d = valid >= 2 ? L - prev : 0;
            if (d > 0) {
                flux += d * this.bandW[b];
                if (this.bandLow[b]) lowFlux += d;
            }
            this.bandLog2[b] = this.bandLog1[b];
            this.bandLog1[b] = L;
            this.bandLog[b] = L;
        }
        // normalise to a running mean of ~1 (clamped so one huge transient can't dominate)
        if (valid >= 2) this.odfMean += (flux - this.odfMean) * warm(this.odfMeanCoef, valid - 2);
        const odf = Math.min(6, flux / Math.max(this.odfMean, 1e-6));
        this.odf = odf;
        if (valid >= 2) this.excessMean += (odf - this.excessMean) * warm(this.excessCoef, valid - 2);
        const ex = odf - this.excessMean;
        this.o[n & this.mask] = ex > 0 ? ex : 0;
        this.lowFlux = lowFlux;
    }

    updateKick(n) {
        const valid = n - this.firstFull - 2;
        this.oLow[n & this.mask] = 0;
        if (valid < 0) return;
        this.lowMean += (this.lowFlux - this.lowMean) * warm(this.lowMeanCoef, valid);
        const x = this.lowFlux / Math.max(this.lowMean, 1e-6);
        this.kMu += (x - this.kMu) * warm(this.kCoef, valid);
        this.kDev += (Math.abs(x - this.kMu) - this.kDev) * warm(this.kCoef, valid);
        // kick-band onset strength for phase scoring (same scale as o[n]: ~1 = average)
        const xl = Math.min(6, x) - this.kMu;
        this.oLow[n & this.mask] = xl > 0 && this.inputDb > -70 ? xl : 0;
        if (valid < this.fps * 0.5) { this.kPrev = x; return; }
        // Peak hold of recent low-band onsets (~3 s): a kick must be strong relative to the
        // recent kicks, so weaker low-end events (bass notes, snare bodies) don't trigger
        this.kPeak = Math.max(x, this.kPeak * this.kPeakDecay);
        const thr = Math.max(this.kMu + 2.2 * this.kDev + 0.35, 0.5 * this.kPeak);
        const minGap = Math.round(0.12 * this.fps);
        if (x > thr && x > this.kPrev && n - this.lastKickFrame >= minGap && this.inputDb > -70) {
            this.lastKickFrame = n;
            this.kickTime = this.frameTime(n);
            this.kickCount++;
        }
        this.kPrev = x;
    }

    /** Linear interpolation into an onset ring (o or oLow) at fractional frame m. */
    ringAt(r, m) {
        if (m < this.warmup || m > this.n || m < this.n - this.ringSize + 2) return 0;
        const i = Math.floor(m);
        const f = m - i;
        const a = r[i & this.mask];
        const b = i + 1 <= this.n ? r[(i + 1) & this.mask] : a;
        return a + (b - a) * f;
    }

    oAt(m) {
        return this.ringAt(this.o, m);
    }

    /** 3-tap smoothed onset strength used by the phase combs (full band + weighted kick band). */
    combAt(m, lw) {
        const o = this.o, L = this.oLow;
        let v = this.ringAt(o, m) + 0.5 * (this.ringAt(o, m - 1) + this.ringAt(o, m + 1));
        if (lw > 0) v += lw * (this.ringAt(L, m) + 0.5 * (this.ringAt(L, m - 1) + this.ringAt(L, m + 1)));
        return v;
    }

    // ------------------------------------------------------------------
    // Tempo
    // ------------------------------------------------------------------

    acfAt(acf, lag, maxLag) {
        if (lag < 0 || lag >= maxLag) return 0;
        const i = Math.floor(lag);
        const f = lag - i;
        return acf[i] + (acf[i + 1] - acf[i]) * f;
    }

    /** Comb score (autocorrelation at 4 multiples of the period, 8 s window) for a tempo. */
    combScore(bpm) {
        const tau = 60 * this.fpsd / bpm;
        const a = this.acf, L = this.maxLag;
        return this.acfAt(a, tau, L) + 0.5 * this.acfAt(a, 2 * tau, L) + 0.33 * this.acfAt(a, 3 * tau, L) + 0.25 * this.acfAt(a, 4 * tau, L);
    }

    /** Comb score over the short (4 s) window: 2 multiples. */
    combScoreS(bpm) {
        const tau = 60 * this.fpsd / bpm;
        const a = this.acfS, L = this.maxLagS;
        return this.acfAt(a, tau, L) + 0.5 * this.acfAt(a, 2 * tau, L);
    }

    /** Normalised autocorrelation of x[0..len) into acf[0..maxLag]. Returns false if silent. */
    autocorr(x, len, acf, maxLag) {
        let mean = 0;
        for (let i = 0; i < len; i++) mean += x[i];
        mean /= len;
        let energy = 0;
        for (let i = 0; i < len; i++) {
            x[i] -= mean;
            energy += x[i] * x[i];
        }
        if (energy < 1e-9) return false;
        // Biased autocorrelation (naturally favours shorter periods)
        for (let lag = 0; lag <= maxLag; lag++) {
            let s = 0;
            for (let i = 0, j = lag; j < len; i++, j++) s += x[i] * x[j];
            acf[lag] = s / energy;
        }
        return true;
    }

    /** Best candidate of a score array: { bpm (refined), score (with prior), clarity }. */
    pickBest(scores) {
        const nc = this.candBpm.length;
        let best = -1;
        let bestScore = -Infinity;
        for (let i = 0; i < nc; i++) {
            const w = scores[i] * this.candPrior[i];
            if (w > bestScore) { bestScore = w; best = i; }
        }
        // Parabolic refinement on the weighted score
        let bpm = this.candBpm[best];
        if (best > 0 && best < nc - 1) {
            const a = scores[best - 1] * this.candPrior[best - 1];
            const c = scores[best + 1] * this.candPrior[best + 1];
            const den = a - 2 * bestScore + c;
            if (den < 0) bpm += 0.5 * clamp(0.5 * (a - c) / den, -0.5, 0.5);
        }
        // Clarity: peak above the median of all candidates
        this.candSorted.set(scores);
        this.candSorted.sort();
        const median = this.candSorted[nc >> 1];
        const clarity = clamp((scores[best] - median) / 0.5, 0, 1);
        return { bpm, score: bestScore, clarity };
    }

    estimateTempo(n) {
        // skip the first second (filters and running means are still settling)
        const avail = Math.floor((this.n + 1 - this.warmup) / 2);
        const len = Math.min(this.tempoLen, avail, Math.floor((this.ringSize - 4) / 2));
        if (len < this.maxLag + 16) return;
        const xd = this.xd;
        const start = n - 2 * len + 1;
        for (let i = 0; i < len; i++) {
            const m = start + 2 * i;
            xd[i] = this.o[m & this.mask] + this.o[(m + 1) & this.mask];
        }
        const lenS = Math.min(this.shortLen, len);
        this.xs.set(xd.subarray(len - lenS, len));
        const okL = this.autocorr(xd, len, this.acf, this.maxLag);
        const okS = okL && this.autocorr(this.xs, lenS, this.acfS, this.maxLagS);
        if (!okL || !okS) {
            this.acfHist[this.acfHistN++ % this.acfHist.length] = 0;
            this.acfSteady = 0;
            this.tempoConf += (0 - this.tempoConf) * 0.15;
            this.clarityL *= 0.85;
            this.clarityS *= 0.85;
            return;
        }
        this.hasAcf = true;
        const nc = this.candBpm.length;
        for (let i = 0; i < nc; i++) {
            this.candScore[i] = this.combScore(this.candBpm[i]);
            this.candScoreS[i] = this.combScoreS(this.candBpm[i]);
        }
        const L = this.pickBest(this.candScore);
        const S = this.pickBest(this.candScoreS);
        this.clarityL += (L.clarity - this.clarityL) * 0.3;
        this.clarityS += (S.clarity - this.clarityS) * 0.3;
        // Periodicity of the music: the 8 s window, or the 4 s one while the tempo moves
        this.tempoConf += (Math.max(L.clarity, 0.85 * S.clarity) - this.tempoConf) * 0.15;
        this.acfBpm = L.bpm;
        this.acfBpmS = S.bpm;
        // Steadiness of the 8 s estimate over the last 4 s: within +-0.3% and clear throughout
        // (a constant-tempo song; ramps and wobbles move it more than that). Its octave is folded
        // to the current tempo's (it may hop between octaves), estimates at the edges of the
        // tempo range are not trusted (the true peak may lie outside).
        const H = this.acfHist;
        let a = L.clarity > 0.25 && L.bpm > this.opts.minBpm + 1 && L.bpm < this.opts.maxBpm - 1 ? L.bpm : 0;
        if (a && this.bpm > 0) {
            while (a > this.bpm * Math.SQRT2) a /= 2;
            while (a < this.bpm / Math.SQRT2) a *= 2;
        }
        H[this.acfHistN++ % H.length] = a;
        this.acfSteady = 0;
        if (this.acfHistN >= H.length) {
            let lo = Infinity, hi = 0, sum = 0;
            for (let i = 0; i < H.length; i++) { lo = Math.min(lo, H[i]); hi = Math.max(hi, H[i]); sum += H[i]; }
            if (lo > 0 && hi / lo - 1 < 0.006) this.acfSteady = sum / H.length;
        }
        this.decideTempo(L, S, n);
    }

    decideTempo(L, S, n) {
        const o = this.opts;
        if (this.locked) return;
        const dtE = o.tempoEvery;
        if (!this.bpm) {
            // First lock: two consistent, reasonably clear estimates in a row
            if (L.clarity < 0.3) { this.pendingCount = 0; return; }
            if (this.pending && Math.abs(L.bpm - this.pending) / this.pending < 0.02) this.pendingCount++;
            else { this.pending = L.bpm; this.pendingCount = 1; }
            if (this.pendingCount >= 2) {
                this.setTempo(this.resolveRatio(L.bpm, false), n, o.phaseWindow);
                this.pendingCount = 0;
            }
            return;
        }
        const cur = this.bpm;
        const fresh = n < this.freshUntil;
        if (this.resolveChecks > 0 && n >= this.resolveAt) {
            const r = this.resolveRatio(cur, false);
            const rr = ratioOf(r, cur);
            // switch only to a stable answer (resolving it again gives itself), never back to a
            // ratio the slow path has already reverted (see setTempo)
            const ok = rr && Math.abs(this.resolveRatio(r, false) / r - 1) < 0.02 && this.octaveOk(cur, r) && !this.ratioVetoed(cur, r);
            // A metrical ratio (x3/2, x4/3 ...) against a clear 8 s autocorrelation that agrees with
            // the current tempo must be the answer three times in a row (1 s apart): the phase-comb
            // peakiness behind it is noisy on smeared onsets (room mic, reverb), and a switch the
            // autocorrelation disagrees with is soon reverted by the slow path (a tempo ping-pong).
            // ("agrees": at least half of its last 4 s of estimates, octave-folded, are the current
            // tempo; a single estimate may hop to a metrical ratio for a moment)
            const acfAgrees = this.acfAgreement(cur) >= 0.5;
            if (ok && rr !== 2 && rr !== 0.5 && acfAgrees) {
                // (the same ratio class: its octave is settled again at the switch)
                const same = this.ratioPend && (Math.abs(r / this.ratioPend - 1) < 0.02 || ratioOf(r, this.ratioPend) === 2 || ratioOf(r, this.ratioPend) === 0.5);
                if (same) this.ratioPendCount++;
                else { this.ratioPend = r; this.ratioPendCount = 1; }
                if (this.ratioPendCount < 3) {
                    this.resolveAt = n + Math.round(this.fps);
                } else {
                    this.ratioPend = 0;
                    this.resolveChecks--;
                    this.setTempo(r, n, o.phaseWindow, this.resolveChecks, true);
                    return;
                }
            } else {
                this.ratioPend = 0;
                this.resolveChecks--;
                this.resolveAt = n + Math.round(4 * this.fps);
                if (ok) {
                    this.setTempo(r, n, o.phaseWindow, this.resolveChecks, true);
                    return;
                }
            }
        }

        // ---- Fast path: the beat is lost and the recent window clearly shows another tempo ----
        const relS = Math.abs(S.bpm - cur) / cur;
        let fastOk = false;
        if (S.clarity >= o.fastClarity && (this.q3 < 0.45 || this.lockQ < 0.35) && relS > 0.05 && !ratioOf(S.bpm, cur)) {
            const curS = this.combScoreS(cur) * this.prior(cur);
            fastOk = S.score > o.fastRatio * Math.max(curS, 1e-6);
        }
        if (fastOk) {
            if (this.fastCand && Math.abs(S.bpm - this.fastCand) / this.fastCand < 0.025) {
                this.fastTime += dtE;
                this.fastCand += (S.bpm - this.fastCand) * 0.4;
            } else {
                this.fastCand = S.bpm;
                this.fastTime = dtE;
            }
            if (this.fastTime >= o.fastSwitchAfter - 1e-9) {
                const b = this.resolveRatio(this.fastCand, true);
                if (Math.abs(b / cur - 1) > 0.04 && !ratioOf(b, cur) && this.phaseStrength(b, 3) >= o.fastStrength) {
                    this.setTempo(b, n, 3);
                    return;
                }
                this.fastCand = 0;
                this.fastTime = 0;
            }
        } else {
            this.fastTime = Math.max(0, this.fastTime - dtE);
            if (this.fastTime === 0) this.fastCand = 0;
        }

        // A steady 8 s estimate (acfSteady, octave-folded) is the better long-term tempo: noisy
        // onset timing (room mic, smeared attacks) makes the filter's period wander +-1-2%
        // around it, so it is held there (time constant ~5 s), unless the filter sees the tempo
        // move (maneuver detection)
        const A = this.acfSteady;
        if (A && Math.abs(A / cur - 1) < 0.025 && L.clarity > 0.3) {
            const g = 0.05 * Math.min(1, L.clarity) * (1 - this.qBoost);
            this.P += (60 * this.fps / A - this.P) * g;
            this.D *= 1 - g;
        }

        // ---- Slow path (8 s window) ----
        const rel = Math.abs(L.bpm - cur) / cur;
        if (rel < 0.04) {
            // Same tempo: the beat filter follows it; pull it only while it has no good lock
            if (L.clarity > 0.15 && this.lockQ < 0.5) {
                const target = 60 * this.fps / L.bpm;
                this.P += (target - this.P) * 0.04 * L.clarity * (1 - this.lockQ);
            }
            this.challenger = 0;
            this.challengeTime = 0;
            return;
        }
        const ratio = ratioOf(L.bpm, cur);
        if (rel < 0.08 && !ratio && !fresh) {
            // Near the current tempo: the filter has drifted (or the music did). Pull it back
            // towards the estimate while the beat is weak; never re-align the phase for it.
            if (L.clarity > 0.4 && this.lockQ < 0.4) {
                const target = 60 * this.fps / L.bpm;
                this.P += (target - this.P) * 0.08 * L.clarity * (1 - this.lockQ);
            }
            this.challenger = 0;
            this.challengeTime = 0;
            return;
        }
        const curScore = this.combScore(cur) * this.prior(cur);
        let better = L.clarity > 0.3 && L.score > o.switchRatio * Math.max(curScore, 1e-6);
        // A simple ratio of a well-locked tempo is syncopation / half-time feel, not a new tempo
        if (better && ratio && !fresh && this.lockQ > 0.4) better = false;
        if (better && this.challenger && Math.abs(L.bpm - this.challenger) / this.challenger < 0.03) {
            this.challengeTime += dtE;
            this.challenger += (L.bpm - this.challenger) * 0.3;
        } else if (better) {
            this.challenger = L.bpm;
            this.challengeTime = dtE;
        } else {
            this.challengeTime = Math.max(0, this.challengeTime - dtE);
            if (this.challengeTime === 0) this.challenger = 0;
        }
        // A tempo with little support (low confidence) is given up sooner
        const needed = ratioOf(this.challenger, cur) && !fresh
            ? o.octaveSwitchAfter
            : o.switchAfter * (0.35 + 0.65 * this.confidence);
        if (this.challenger && this.challengeTime >= needed) {
            // The ratio check has the last word: it may say the current tempo is right after all
            const b = this.resolveRatio(this.challenger, false);
            if (Math.abs(b / cur - 1) > 0.04 && this.octaveOk(cur, b)) this.setTempo(b, n, o.phaseWindow);
            else { this.challenger = 0; this.challengeTime = 0; }
        }
    }

    /**
     * Hysteresis for octave switches away from an adopted tempo: going to double time needs
     * alternation clearly below the threshold, going to half time clearly above it.
     */
    octaveOk(from, to) {
        const r = ratioOf(to, from);
        const th = this.opts.altThreshold, m = 0.08;
        if (r === 2) return this.alternation(to, this.opts.phaseWindow) < th - m;
        if (r === 0.5) return this.alternation(from, this.opts.phaseWindow) > th + m;
        return true;
    }

    /** Fraction of the last 4 s of 8 s tempo estimates (octave-folded) within 3% of `bpm`. */
    acfAgreement(bpm) {
        const H = this.acfHist, n = Math.min(this.acfHistN, H.length);
        let k = 0;
        for (let i = 0; i < n; i++) {
            let a = H[i];
            if (!a) continue;
            while (a > bpm * Math.SQRT2) a /= 2;
            while (a < bpm / Math.SQRT2) a *= 2;
            if (Math.abs(a / bpm - 1) < 0.03) k++;
        }
        return n ? k / H.length : 0;
    }

    /** The ratio switch a -> b was reverted earlier (setTempo). */
    ratioVetoed(a, b) {
        const v = this.ratioVeto;
        return !!v && Math.abs(a / v.a - 1) < 0.03 && Math.abs(b / v.b - 1) < 0.03;
    }

    /**
     * Settle x2 / x1/2 / x3/2 / x4/3 ambiguities around a tempo estimate. Two cues, each
     * reliable for one kind of error (checked offline on rock, house, swing, funk, breaks,
     * dembow, drum & bass and hip-hop patterns):
     *  - octaves (x2, x1/2): beat alternation. At double the real tempo every other beat is
     *    a real off-beat, so even and odd beats carry very different onset energy; at the
     *    real tempo they are similar (kick on 1 and 3, snare on 2 and 4).
     *  - other ratios (x3/2, x2/3, x4/3, x3/4): phase-comb peakiness. At the right tempo one
     *    beat alignment collects the onsets of every bar, a wrong ratio keeps sliding
     *    through the bar.
     * Only candidates with a competitive comb score are considered.
     */
    resolveRatio(bpm, short) {
        const o = this.opts;
        const win = short ? 3 : o.phaseWindow;
        const score = b => Math.max(0, (short ? this.combScoreS(b) : this.combScore(b)) * this.prior(b));
        const ok = (b, ref) => b >= o.minBpm && b <= o.maxBpm && score(b) >= 0.4 * score(ref);
        const octave = (b) => {
            if (ok(b / 2, b) && this.alternation(b, win) > o.altThreshold) return b / 2;
            if (ok(b * 2, b) && this.alternation(b * 2, win) < o.altThreshold) return b * 2;
            return b;
        };
        // each ratio class is judged by its best octave (peakiness is not octave-neutral), so
        // this stage only compares ratio classes; the octave stage then settles the octave
        const canon = (c) => {
            while (c >= 2 * o.minBpm) c /= 2;
            while (c < o.minBpm) c *= 2;
            return c;
        };
        const classScore = (k) => Math.max(score(k), 2 * k <= o.maxBpm ? score(2 * k) : 0);
        const ratio = (b) => {
            let best = b, bestV = -1;
            const cands = [b, b * 1.5, b / 1.5, b * 4 / 3, b * 0.75];
            let top = 1e-6;
            for (const c of cands) if (c >= o.minBpm && c <= o.maxBpm) top = Math.max(top, classScore(canon(c)));
            for (const c of cands) {
                if (c < o.minBpm || c > o.maxBpm) continue;
                const k = canon(c);
                if (classScore(k) < 0.35 * top) continue;
                for (const m of [k, 2 * k]) {
                    if (m > o.maxBpm) continue;
                    const v = this.phaseStrength(m, win) * this.prior(m);
                    if (v > bestV) { bestV = v; best = m; }
                }
            }
            return best;
        };
        return octave(ratio(octave(bpm)));
    }

    /** Best / mean phase-comb sum over 48 evenly spaced alignments (tempo-independent sampling). */
    phaseStrength(bpm, windowSec, lw = 0.25) {
        const P = 60 * this.fps / bpm;
        let best = 0, total = 0;
        for (let i = 0; i < 48; i++) {
            const s = this.combSum(this.n - 2 - i * P / 48, P, windowSec, lw);
            total += s;
            if (s > best) best = s;
        }
        return total > 0 ? best * 48 / total : 0;
    }

    /** |even - odd| / (even + odd) beat energy at the best alignment for a tempo (0..1). */
    alternation(bpm, windowSec, lw = 0.25) {
        const P = 60 * this.fps / bpm;
        const { beat } = this.combPhase(this.n, P, windowSec, lw);
        const K = this.combBeats(P, windowSec);
        const pw = this.opts.combPower;
        let even = 0, odd = 0;
        for (let k = 0; k < K; k++) {
            const v = Math.pow(this.combAt(beat - k * P, lw), pw);
            if (k & 1) odd += v; else even += v;
        }
        return Math.abs(even - odd) / Math.max(even + odd, 1e-9);
    }

    /**
     * Adopt a tempo and re-align the phase from the last `windowSec` of onsets.
     * `byRatio`: the switch comes from the ratio re-check. If the slow / fast path later goes
     * back to the tempo it left (within 30 s), the ratio cue and the autocorrelation disagree:
     * that ratio is vetoed for this tempo (until another tempo is adopted) and the reverted
     * tempo isn't re-checked, so the two can't ping-pong.
     */
    setTempo(bpm, n = this.n, windowSec = this.opts.phaseWindow, resolveChecks = 2, byRatio = false) {
        const rs = this.ratioSwitch;
        if (byRatio) {
            this.ratioSwitch = { from: this.bpm, to: bpm, n };
        } else {
            if (rs && n - rs.n < 30 * this.fps && Math.abs(bpm / rs.from - 1) < 0.03) {
                this.ratioVeto = { a: rs.from, b: rs.to };
                resolveChecks = 0;
            } else if (!(this.ratioVeto && Math.abs(bpm / this.ratioVeto.a - 1) < 0.03)) {
                this.ratioVeto = null;
            }
            this.ratioSwitch = null;
        }
        this.ratioPend = 0;
        this.evidence = 0;
        this.tempoRef = 0;
        this.bpm = bpm;
        this.bpmOut = bpm;
        this.bpmTrend = 0;
        this.P = 60 * this.fps / bpm;
        this.D = 0;
        this.resetCovariance();
        this.challenger = 0;
        this.challengeTime = 0;
        this.fastCand = 0;
        this.fastTime = 0;
        this.freshUntil = n + Math.round(this.opts.freshTime * this.fps);
        this.anchorP = 0;
        this.alignPhase(n, windowSec);
        // the ratio check rests on a few seconds of music: repeat it with more data
        this.resolveChecks = resolveChecks;
        this.resolveAt = n + Math.round(4 * this.fps);
    }

    resetCovariance() {
        const C = this.C;
        const P = this.P;
        C.fill(0);
        C[0] = (0.06 * P) * (0.06 * P);
        C[4] = this.locked ? 0 : (0.012 * P) * (0.012 * P);
        C[8] = this.locked ? 0 : (0.002 * P) * (0.002 * P);
    }

    // ------------------------------------------------------------------
    // Phase
    // ------------------------------------------------------------------

    /** Number of beats a phase comb uses for a window. */
    combBeats(P, windowSec) {
        return Math.max(3, Math.min(Math.floor(windowSec * this.fps / P), Math.floor((this.n - this.warmup - 4) / P)));
    }

    /** Comb sum (compressed per beat) for beats at `beat`, beat - P, ... */
    combSum(beat, P, windowSec, lw = this.opts.lowPhaseWeight) {
        const K = this.combBeats(P, windowSec);
        const pw = this.opts.combPower;
        let s = 0;
        for (let k = 0; k < K; k++) s += Math.pow(this.combAt(beat - k * P, lw), pw);
        return s;
    }

    /** Best beat alignment (comb over the last windowSec seconds) for period P. */
    combPhase(n, P = this.P, windowSec = this.opts.phaseWindow, lw = this.opts.lowPhaseWeight) {
        const guard = 2;
        let bestPhi = 0;
        let best = -1;
        let total = 0;
        let count = 0;
        for (let phi = 0; phi < P; phi += 0.5) {
            const s = this.combSum(n - guard - phi, P, windowSec, lw);
            total += s;
            count++;
            if (s > best) { best = s; bestPhi = phi; }
        }
        const mean = total / Math.max(1, count);
        return { beat: n - guard - bestPhi, strength: mean > 0 ? best / mean : 0, mean };
    }

    /** Comb strength of a given alignment relative to the mean over all phases. */
    combStrengthAt(beat, n, windowSec = this.opts.phaseWindow, lw = this.opts.lowPhaseWeight, mean = null) {
        const P = this.P;
        if (mean === null) {
            let total = 0, count = 0;
            for (let phi = 0; phi < P; phi += 2) {
                total += this.combSum(n - 2 - phi, P, windowSec, lw);
                count++;
            }
            mean = total / Math.max(1, count);
        }
        // nearest beat of this alignment that the comb can see
        let b = beat;
        while (b > n - 2) b -= P;
        const s = this.combSum(b, P, windowSec, lw);
        return mean > 0 ? s / mean : 0;
    }

    alignPhase(n, windowSec = this.opts.phaseWindow) {
        if (n < 8) return;
        const { beat } = this.combPhase(n, this.P, windowSec);
        this.setBeatAt(beat, n);
        this.hasBeat = true;
        this.acq = this.opts.acqBeats;
        this.q3 = 0.5;
        this.misCount = 0;
        this.nextPhaseCheck = n + Math.round(0.5 * this.fps);
        // The alignment may rest on only a few beats: check it once more with a full window
        this.confirmAt = n + Math.round(3 * this.fps);
    }

    /** Put the next predicted beat on the grid of `beat` (frames), just ahead of the search window. */
    setBeatAt(beat, n) {
        const win = 0.3 * this.P;
        let e = beat;
        while (e + win <= n) e += this.P;
        while (e - this.P + win > n) e -= this.P;
        this.evalBeat = e;
        this.D = 0;
        this.resetCovariance();
    }

    /** Half-width (frames) of the onset search window around a predicted beat. */
    searchWin() {
        const sig = this.opts.kfSigmaMs * 1e-3 * this.fps;
        const sd = Math.sqrt(this.C[0] + sig * sig);
        return clamp(2.5 * sd + 0.05 * this.P, 0.12 * this.P, 0.3 * this.P);
    }

    /**
     * Phase detector for predicted beat tb (frames): find the strongest onset cluster
     * within the search window (mildly preferring the prediction), then take the centroid
     * of the onset strength around it. Returns the timing error (frames), the salience of
     * that cluster relative to the average onset strength, and a weight that also falls
     * off with distance from the prediction (far onsets barely count).
     */
    phaseDetect(tb, win) {
        const P = this.P;
        const sig = this.opts.kfSigmaMs * 1e-3 * this.fps;
        const sd = Math.sqrt(this.C[0] + sig * sig);
        const wide = Math.max(1.5 * sd, 0.08 * P);
        const m0 = Math.ceil(tb - win);
        const m1 = Math.floor(tb + win);
        let best = -1;
        let bestM = tb;
        for (let m = m0; m <= m1; m++) {
            const x = (m - tb) / wide;
            const v = this.oSmooth(m) * Math.exp(-0.5 * x * x);
            if (v > best) { best = v; bestM = m; }
        }
        const sigma = Math.max(1.5, 0.05 * P);
        let num = 0, den = 0, gsum = 0;
        const r = Math.ceil(2.5 * sigma);
        for (let m = Math.round(bestM) - r; m <= Math.round(bestM) + r; m++) {
            const x = (m - bestM) / sigma;
            const g = Math.exp(-0.5 * x * x);
            const v = this.oAt(m);
            num += (m - tb) * g * v;
            den += g * v;
            gsum += g;
        }
        const avg = Math.max(this.excessBaseline(), 1e-3);
        const sal = den / Math.max(gsum, 1e-9) / avg;
        const e = den > 1e-9 ? num / den : 0;
        const d = e / Math.max(2 * sd, 0.1 * P);
        let w = clamp((sal - 1.1) / 2.0, 0, 1) * Math.exp(-0.5 * d * d);
        // The onset must also be a physical level jump comparable to the beats so far: the
        // whitened flux makes noise in a quiet breakdown look like onsets, the dB rise doesn't
        const c = Math.round(tb + e);
        let rise = 0;
        for (let m = c - 3; m <= c + 3; m++) { const v = this.ringAt(this.rise, m); if (v > rise) rise = v; }
        const ref = this.riseRef;
        if (ref > 3) w *= clamp((rise - 0.2 * ref) / (0.3 * ref), 0.3, 1);
        // learned only from a confident lock (or the first beats), never while coasting
        if (w > 0.6 && (this.lockQ > 0.5 || ref === 0)) this.riseRef += (rise - ref) * (ref > 0 ? 0.1 : 1);
        return { e, sal, w };
    }

    /** 3-tap smoothed excess onset strength at frame m. */
    oSmooth(m) {
        return 0.5 * this.oAt(m) + 0.25 * (this.oAt(m - 1) + this.oAt(m + 1));
    }

    excessBaseline() {
        // mean of the excess signal over the last ~4 s (cheap: sample every 4 frames)
        const len = Math.min(this.n - this.warmup, Math.round(4 * this.fps));
        let s = 0, c = 0;
        for (let m = this.n - len; m <= this.n; m += 4) { s += this.o[m & this.mask]; c++; }
        return c ? s / c : 0;
    }

    /**
     * One beat of the Kalman filter: measurement update with timing error e (frames) and
     * weight w (0..1, scales the measurement precision), then prediction to the next beat.
     */
    kalmanBeat(e, w, coasting = false) {
        const o = this.opts;
        const C = this.C;
        // Timing noise: kfSigmaMs for clean onsets, more when the measured errors scatter more
        // (room mic, reverb, smeared or humanised attacks), so noisy timing neither drags the
        // period around nor looks like a tempo change (maneuver detection, below)
        const sig0 = o.kfSigmaMs * 1e-3 * this.fps;
        const sig = this.eVar > 0 && o.kfAdaptive ? clamp(Math.sqrt(this.eVar), sig0, o.kfAdaptMax * sig0) : sig0;
        if (w > 0.03) {
            // Robust gating: an error far outside the predicted spread (a fill, a flam) is
            // down-weighted smoothly instead of yanking the period
            const d = Math.abs(e) / Math.sqrt(C[0] + sig * sig / w);
            if (d > 2.5) w *= Math.exp(-0.5 * (d - 2.5) * (d - 2.5));
        }
        if (w > 0.03) {
            const R = sig * sig / w;
            const S = C[0] + R;
            // After a gap (no recent onsets on the beat) one onset is not enough evidence for
            // a tempo change: period / drift gains fade in with the recent hit rate, and the
            // phase gain is softened (a stray onset in a breakdown can't drag the beat away)
            const gP = this.locked ? 0 : clamp((this.q3 - 0.15) / 0.45, 0, 1);
            const k0 = (C[0] / S) * (0.4 + 0.6 * clamp(this.q3 / 0.5, 0, 1));
            const k1 = gP * C[3] / S;
            const k2 = gP * C[6] / S;
            const P0 = this.P;
            // Coasting after a confident lock: only small nudges (a phase that really moved is
            // left to the re-acquisition check, which needs persistent evidence)
            const mp = coasting ? 0.03 : 1, mt = coasting ? 0.003 : 0.012;
            this.evalBeat += clamp(k0 * e, -mp * P0, mp * P0);
            this.P += clamp(k1 * e, -mt * P0, mt * P0);
            this.D += clamp(k2 * e, -0.005 * P0, 0.005 * P0);
            const r0 = C[0], r1 = C[1], r2 = C[2];
            C[0] -= k0 * r0; C[1] -= k0 * r1; C[2] -= k0 * r2;
            C[3] -= k1 * r0; C[4] -= k1 * r1; C[5] -= k1 * r2;
            C[6] -= k2 * r0; C[7] -= k2 * r1; C[8] -= k2 * r2;
        } else {
            // No evidence: coast at the current tempo (the drift estimate fades)
            this.D *= 0.7;
        }
        // Tempo is held through breaks (music doesn't speed up while the drums are out):
        // less process noise without evidence, so a long gap doesn't open the gate wide
        // Maneuver detection: a persistent bias in the timing errors means the tempo is
        // moving (accelerando, drummer drift) -> more process noise, the filter follows
        // faster; zero-mean errors (steady tempo) -> less, steadier phase and tempo.
        if (w > 0.3 && !coasting) {
            this.eBar += (e - this.eBar) * 0.35;
            const d = e - this.eBar;
            this.eVar = this.eVar > 0 ? this.eVar + (d * d - this.eVar) * 0.08 : sig0 * sig0;
        } else this.eBar *= 0.8;
        const bias = Math.abs(this.eBar) / sig;
        const tq = clamp((bias - 0.5) / 1.0, 0, 1);
        this.qBoost += (tq - this.qBoost) * (tq > this.qBoost ? 0.5 : 0.1);
        const qs = (w > 0.03 ? 1 : 0.35) * (0.5 + 1.5 * this.qBoost);
        // Predict: tau += P, P += D, D *= rho
        const rho = o.kfRho;
        this.evalBeat += this.P;
        this.P += this.D;
        this.D *= rho;
        // C = F C F^T + Q with F = [[1,1,0],[0,1,1],[0,0,rho]]
        const A = this.tmp;
        for (let j = 0; j < 3; j++) {
            A[j] = C[j] + C[3 + j];
            A[3 + j] = C[3 + j] + C[6 + j];
            A[6 + j] = rho * C[6 + j];
        }
        for (let i = 0; i < 3; i++) {
            const a0 = A[3 * i], a1 = A[3 * i + 1], a2 = A[3 * i + 2];
            C[3 * i] = a0 + a1;
            C[3 * i + 1] = a1 + a2;
            C[3 * i + 2] = rho * a2;
        }
        const P = this.P;
        C[0] += (qs * o.kfQPhase * P) ** 2;
        if (this.locked) {
            C[1] = C[2] = C[3] = C[4] = C[5] = C[6] = C[7] = C[8] = 0;
            this.D = 0;
        } else {
            // a steady long-term tempo (constant-tempo music): less period / drift noise
            const qp = this.acfSteady && Math.abs(this.acfSteady * P / (60 * this.fps) - 1) < 0.025 ? 0.5 : 1;
            C[4] += (qp * qs * o.kfQPeriod * P) ** 2;
            C[8] += (qp * qs * o.kfQDrift * P) ** 2;
            // keep the period inside the tempo range, the drift small
            const lo = 60 * this.fps / (o.maxBpm * 1.1), hi = 60 * this.fps / (o.minBpm / 1.1);
            if (this.P < lo) { this.P = lo; this.D = 0; }
            if (this.P > hi) { this.P = hi; this.D = 0; }
            this.D = clamp(this.D, -0.005 * P, 0.005 * P);
        }
        // Bound the uncertainty (long gaps): scale rows/columns to keep C positive definite
        this.capVar(0, (0.08 * P) ** 2);
        if (!this.locked) {
            this.capVar(1, (0.03 * P) ** 2);
            this.capVar(2, (0.006 * P) ** 2);
        }
    }

    capVar(i, max) {
        const C = this.C;
        const v = C[4 * i];
        if (v <= max) return;
        const s = Math.sqrt(max / v);
        for (let j = 0; j < 3; j++) {
            C[3 * i + j] *= s;
            C[3 * j + i] *= s;
        }
    }

    updateBeat(n) {
        if (!this.hasBeat) {
            this.confidence += (0 - this.confidence) * coef(2, this.dt);
            return;
        }
        const o = this.opts;
        let guard = 0;
        while (guard++ < 4) {
            const win = this.searchWin();
            if (n < this.evalBeat + win) break;
            const { e, sal, w: w0 } = this.phaseDetect(this.evalBeat, win);
            // Coasting after a confident lock: weak onsets barely count (noise in a breakdown),
            // the strong ones at the drop still do
            const coasting = !!this.anchorP && (this.lockQ < 0.4 || this.q3 < 0.4);
            const w = coasting ? w0 * w0 : w0;
            const acq = this.acq > 0;
            this.kalmanBeat(e, w, coasting);
            this.q3 += (w - this.q3) * 0.4;
            this.q3Ref += (this.q3 - this.q3Ref) * 0.06;
            // Remember the tempo of a confident lock; while the beat is weak (breakdown, fill)
            // the period is held near it instead of wandering after stray onsets
            if (!this.locked) {
                if (this.lockQ > 0.6) this.anchorP = this.anchorP ? this.anchorP + (this.P - this.anchorP) * 0.15 : this.P;
                else if (this.lockQ < 0.4 && this.anchorP) this.P += (this.anchorP - this.P) * 0.25 * (1 - this.lockQ / 0.4);
            }
            this.lastError = e / this.fps;
            this.lastSalience = sal;
            this.lockQ += (w - this.lockQ) * (acq ? 0.25 : 0.12);
            if (this.acq > 0) this.acq--;
        }
        if (!this.locked) this.bpm = 60 * this.fps / this.P;
        // Display tempo: glides after the filter's period. Level + trend smoothing (Holt), so it
        // is steady while the tempo is, and follows a ramp without lagging behind it.
        // Small wobbles are smoothed heavily, a real tempo move (> ~1%) is followed quickly.
        const dev = this.bpmOut > 0 ? Math.abs(this.bpm - this.bpmOut) / this.bpmOut / 0.008 : 0;
        const a = coef(o.displayTau * (2 - 1.2 * this.qBoost) / (1 + dev * dev), this.dt);
        const pred = this.bpmOut + this.bpmTrend;
        const lvl = pred + a * (this.bpm - pred);
        this.bpmTrend += (lvl - this.bpmOut - this.bpmTrend) * a * 0.25;
        this.bpmTrend = clamp(this.bpmTrend, -2 * this.dt, 2 * this.dt); // at most 2 BPM/s
        this.bpmOut = lvl;

        // One-time confirmation of a fresh alignment, with the full comb window
        if (this.confirmAt && n >= this.confirmAt) {
            this.confirmAt = 0;
            const { beat, strength, mean } = this.combPhase(n);
            const d = this.phaseDiff(beat);
            if (Math.abs(d) > 0.15 && strength > 1.25 * this.combStrengthAt(this.evalBeat, n, o.phaseWindow, o.lowPhaseWeight, mean)) {
                this.setBeatAt(beat, n);
                this.acq = o.acqBeats;
            }
        }

        // Re-acquisition: if a clearly better alignment persists, jump to it
        if (n >= this.nextPhaseCheck && this.n - this.warmup > 4 * this.fps) {
            this.nextPhaseCheck = n + Math.round(0.5 * this.fps);
            // Trust remembers a good lock for a while (~20 s), so a breakdown where only
            // off-beat parts remain doesn't flip the phase; a fresh or weak lock re-aligns fast
            this.trust = Math.max(this.lockQ, this.trust * Math.exp(-0.5 / 20));
            const win = 4;
            const { beat, strength, mean } = this.combPhase(n, this.P, win);
            const d = this.phaseDiff(beat);
            this.updateEvidence(n, d, strength, mean);
            let need = Infinity;
            const lost = this.lockQ < 0.35;
            // Only when the filter has lost its lock: a locked filter that keeps finding onsets
            // where it expects them is not second-guessed (syncopation can look "better")
            if (Math.abs(d) > 0.15 && strength > 1.5 && this.tempoConf > 0.2 && (lost || this.q3 < 0.35)) {
                const curStrength = this.combStrengthAt(this.evalBeat, n, win, o.lowPhaseWeight, mean);
                if (strength > 1.3 * curStrength) {
                    // A new track at another phase brings full drum hits there: big level jumps
                    // (like the beats we locked to) and a strong comb -> re-align in ~1.5 s.
                    // A breakdown with only an off-beat bass line or pads has neither: it needs
                    // persistent evidence for 3-9 s (longer after a confident lock, twice that
                    // for an exact off-beat alternative), so it doesn't flip the beat.
                    const rNew = this.riseSum(this.alignedBeat(beat, n), 2);
                    const rCur = this.riseSum(this.alignedBeat(this.evalBeat, n), 2);
                    const drums = this.riseRef > 3 && rNew >= 0.65 * this.riseRef && rNew > 1.6 * rCur && strength >= 2.5;
                    if (drums) this.drumMis++; else this.drumMis = 0;
                    if (lost) {
                        need = 6 + Math.round(12 * clamp((this.trust - 0.3) / 0.4, 0, 1));
                        if (Math.abs(d) > 0.4) need *= 2;
                        // an alignment without drum-like hits (off-beat bass, pads, open hats in a
                        // breakdown) is not the beat, however long it lasts
                        if (this.riseRef > 3 && rNew < (Math.abs(d) > 0.35 ? 0.7 : 0.5) * this.riseRef) need = Infinity;
                        this.misCount++;
                    }
                } else { this.misCount = Math.max(0, this.misCount - 1); this.drumMis = 0; }
            } else {
                this.misCount = Math.max(0, this.misCount - 1);
                this.drumMis = 0;
            }
            if (this.misCount >= need || this.drumMis >= 2) {
                this.realignReason = this.drumMis >= 2 ? 'drums' : 'persistent'; // (debug / tests)
                this.setBeatAt(beat, n);
                this.acq = o.acqBeats;
                this.misCount = 0;
                this.drumMis = 0;
            }
        }

        // Needs both a clear periodicity and onsets that keep landing on the predicted beats.
        // The hit rate mixes the slow and the fast lock quality, so confidence falls within
        // ~1-2 beats when the beat is lost and comes back as soon as the beats land again
        // (after a trusted lock, landing beats also vouch for the periodicity while the
        // tempo window still holds the breakdown).
        // Long-term agreement (updateEvidence) sets a floor when individual beats are weak:
        // smeared or quiet onsets through a room mic rarely make a clean hit, yet tempo and phase
        // that keep agreeing bar after bar are the beat. Not when the hits have just collapsed
        // relative to their own recent level (weak but steady hits are this signal's normal; a
        // sudden loss is a new track or a break: confidence must still fall within a beat or two).
        const hits = 0.4 * this.lockQ + 0.6 * this.q3;
        const ev = this.evidence * clamp((this.q3 / Math.max(this.q3Ref, 0.15) - 0.25) / 0.35, 0, 1);
        const periodic = Math.max(this.tempoConf, this.anchorP ? 0.9 * this.q3 : 0);
        const target = clamp(Math.max(periodic * clamp(hits * 1.8, 0, 1), 0.9 * ev), 0, 1);
        this.confidence += (target - this.confidence) * coef(0.5, this.dt);
        this.period = this.P / this.fps;
        this.beatTime = this.frameTime(this.evalBeat);
    }

    /**
     * Long-term evidence (0..1, every 0.5 s) that the tracked beat is the music's beat, from
     * agreement over several bars rather than the strength of single onsets:
     *  - tempo: the steady 8 s autocorrelation tempo (acfSteady, or the last one while the
     *    estimate is unsteady) matches the filter's, or an octave of it (the autocorrelation
     *    can't tell octaves apart); a steady estimate elsewhere vetoes;
     *  - phase: over 8 s the tracked alignment is (nearly) the best phase-comb alignment and
     *    clearly peaked (which also says the period fits), and over the last 4 s it still is,
     *    so a new track at another phase or tempo takes the evidence away within ~1-2 s.
     * A wrong tempo ratio doesn't get it: its comb doesn't peak. Rises over ~3 s, falls within
     * ~1 s. d4 / best4 / mean4: the 4 s comb of the re-acquisition check (best alignment's
     * phase difference, strength and mean).
     */
    updateEvidence(n, d4, best4, mean4) {
        const lw = this.opts.lowPhaseWeight;
        // Tempo: remember the last steady 8 s tempo (it may lose clarity in a quieter section
        // without the tempo changing); a steady estimate elsewhere contradicts the filter
        const A = this.acfSteady;
        if (A) this.tempoRef = A;
        // (a phase comb clearly peaked over 8 s also says the period fits: 1% off smears it by
        // a sixth of a beat; so without a steady estimate the comb alone counts, a bit less)
        let tempo = 0;
        if (!this.locked) {
            if (A) tempo = sameTempo(A, this.bpm) ? 1 : 0;
            else if (this.tempoRef && sameTempo(this.tempoRef, this.bpm)) tempo = 0.9;
            else if (this.tempoConf > 0.25) tempo = 0.8;
        }
        let target = 0;
        if (tempo > 0) {
            const L8 = this.combPhase(n, this.P, 8, lw);
            const d8 = this.phaseDiff(L8.beat);
            const cur8 = Math.abs(d8) < 0.04 ? L8.strength : this.combStrengthAt(this.evalBeat, n, 8, lw, L8.mean);
            const cur4 = Math.abs(d4) < 0.04 ? best4 : this.combStrengthAt(this.evalBeat, n, 4, lw, mean4);
            const peak = clamp((cur8 - 1.3) / 0.7, 0, 1);
            const best8 = clamp((cur8 / Math.max(L8.strength, 1e-9) - 0.75) / 0.17, 0, 1);
            const best4r = clamp((cur4 / Math.max(best4, 1e-9) - 0.6) / 0.25, 0, 1);
            target = tempo * peak * best8 * best4r;
            const E = this.evParts;
            E[0] = tempo; E[1] = peak; E[2] = best8; E[3] = best4r;
        } else this.evParts.fill(0);
        this.evidence += (target - this.evidence) * (target < this.evidence ? 0.5 : 0.15);
    }

    /** Phase of an alignment `beat` relative to the filter's next beat, in beats (-0.5, 0.5]. */
    phaseDiff(beat) {
        const P = this.P;
        let d = (beat - this.evalBeat) / P;
        d -= Math.round(d);
        return d;
    }

    /** Latest beat of the grid through `beat` that the combs can see (<= n - 2). */
    alignedBeat(beat, n) {
        let b = beat;
        while (b > n - 2) b -= this.P;
        while (b + this.P <= n - 2) b += this.P;
        return b;
    }

    /** Mean level rise (dB, max within +-3 frames) on a beat grid over a window. */
    riseSum(beat, windowSec) {
        const P = this.P;
        const K = this.combBeats(P, windowSec);
        let s = 0;
        for (let k = 0; k < K; k++) {
            const c = Math.round(beat - k * P);
            let mx = 0;
            for (let m = c - 3; m <= c + 3; m++) { const v = this.ringAt(this.rise, m); if (v > mx) mx = v; }
            s += mx;
        }
        return s / K;
    }

    // ---- Control (from the main thread) ----

    /** Force a tempo (tap / manual BPM). `beatTime` (signal time) optionally anchors the phase. */
    forceTempo(bpm, beatTime = null, lock = this.locked) {
        if (!(bpm > 0)) return;
        this.bpm = clamp(bpm, 30, 300);
        this.bpmOut = this.bpm;
        this.bpmTrend = 0;
        this.P = 60 * this.fps / this.bpm;
        this.D = 0;
        this.locked = !!lock;
        this.anchorP = 0;
        this.challenger = 0;
        this.challengeTime = 0;
        this.fastCand = 0;
        this.fastTime = 0;
        this.freshUntil = 0;
        this.ratioPend = 0;
        this.ratioSwitch = null;
        this.ratioVeto = null;
        if (beatTime != null && Number.isFinite(beatTime)) {
            this.setBeatAt(this.timeToFrame(beatTime), this.n);
            this.hasBeat = true;
            this.acq = this.opts.acqBeats;
        } else if (!this.hasBeat) {
            this.alignPhase(this.n);
        } else {
            this.resetCovariance();
        }
    }

    setLocked(lock) {
        this.locked = !!lock;
        this.resetCovariance();
    }

    /** Forget everything learned from the previous source (new input). */
    reset() {
        this.bpm = 0;
        this.bpmOut = 0;
        this.bpmTrend = 0;
        this.hasBeat = false;
        this.hasAcf = false;
        this.locked = false;
        this.lockQ = 0;
        this.q3 = 0;
        this.q3Ref = 0;
        this.trust = 0;
        this.misCount = 0;
        this.acq = 0;
        this.tempoConf = 0;
        this.clarityL = 0;
        this.clarityS = 0;
        this.confidence = 0;
        this.evidence = 0;
        this.tempoRef = 0;
        this.challenger = 0;
        this.challengeTime = 0;
        this.fastCand = 0;
        this.fastTime = 0;
        this.pendingCount = 0;
        this.freshUntil = 0;
        this.resolveChecks = 0;
        this.ratioPend = 0;
        this.ratioSwitch = null;
        this.ratioVeto = null;
        this.D = 0;
        this.riseRef = 0;
        this.anchorP = 0;
        this.eBar = 0;
        this.eVar = 0;
        this.acfHistN = 0;
        this.acfSteady = 0;
        this.beatTime = -1;
        // Onset history and running statistics restart with the new signal
        const n = Math.max(0, this.n);
        this.o.fill(0);
        this.oLow.fill(0);
        this.rise.fill(0);
        this.bandRef.fill(0);
        this.firstFull = n + Math.ceil(this.N / this.hop);
        this.warmup = n + 1 + Math.round(this.fps);
        this.nextTempoAt = n + Math.round(4.5 * this.fps);
        this.odfMean = 0;
        this.excessMean = 1;
        this.lowMean = 0; this.kMu = 0; this.kDev = 0; this.kPeak = 0;
    }

    /** Write the current state into a message array (see MSG). */
    writeState(out) {
        out[MSG.TIME] = this.frameTime(this.n);
        out[MSG.LEVEL] = this.level;
        out[MSG.BASS] = this.bass;
        out[MSG.LOWMID] = this.lowMid;
        out[MSG.MID] = this.mid;
        out[MSG.HIGH] = this.high;
        out[MSG.KICK_TIME] = this.kickTime;
        out[MSG.KICK_COUNT] = this.kickCount;
        out[MSG.BPM] = this.hasBeat ? (this.locked ? this.bpm : this.bpmOut) : 0;
        out[MSG.CONFIDENCE] = this.confidence;
        out[MSG.BEAT_TIME] = this.hasBeat ? this.beatTime : -1;
        out[MSG.PERIOD] = this.period;
        out[MSG.INPUT_DB] = this.inputDb;
        out[MSG.LOCKED] = this.locked ? 1 : 0;
        out[MSG.ODF] = this.odf;
        return out;
    }
}

// ---------------------------------------------------------------------------
// Audio texture frames (spectrum + waveform for src/services/AudioTextures.js).
// Only while the main thread asks for them ({type: 'textures', on}); the
// BeatTracker is not involved: its power spectrum (tracker.re[0..N/2) after each
// analysis frame) is copied as is, and the waveform comes from a separate ring.
// Message: Float32Array [bins, WAVE, power[bins], wave[WAVE]], posted right after
// the state message.
// ---------------------------------------------------------------------------
export const TEX_WAVE = 1024;

export class TextureTap {
    constructor() {
        this.ring = new Float32Array(2 * TEX_WAVE);  // power of two
        this.mask = this.ring.length - 1;
        this.pos = 0;                                 // next write index (= oldest sample)
        this.msg = null;
    }

    push(block) {
        const r = this.ring, m = this.mask;
        let p = this.pos;
        for (let i = 0; i < block.length; i++) { r[p] = block[i]; p = (p + 1) & m; }
        this.pos = p;
    }

    /** Fill the message from the tracker's latest power spectrum and the sample ring. */
    frame(tracker) {
        const bins = tracker.N >> 1;
        const len = 2 + bins + TEX_WAVE;
        if (!this.msg || this.msg.length !== len) this.msg = new Float32Array(len);
        const out = this.msg;
        out[0] = bins;
        out[1] = TEX_WAVE;
        const re = tracker.re;
        for (let k = 0; k < bins; k++) out[2 + k] = re[k];
        // Trigger: the latest rising zero crossing in the older half -> a stable oscilloscope
        const r = this.ring, m = this.mask, base = this.pos;
        let start = TEX_WAVE;
        for (let j = TEX_WAVE; j >= 1; j--) {
            if (r[(base + j - 1) & m] < 0 && r[(base + j) & m] >= 0) { start = j; break; }
        }
        const o = 2 + bins;
        for (let j = 0; j < TEX_WAVE; j++) out[o + j] = r[(base + start + j) & m];
        return out;
    }
}

// ---------------------------------------------------------------------------
// AudioWorklet registration (browser only)
// ---------------------------------------------------------------------------
if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
    class PatchToyAnalysisProcessor extends AudioWorkletProcessor {
        constructor(options) {
            super();
            const opts = (options && options.processorOptions) || {};
            this.tracker = new BeatTracker(sampleRate, opts.tracker || {});
            this.mono = new Float32Array(128);
            this.state = new Float64Array(MSG.SIZE);
            this.framesSincePost = 0;
            this.lastN = -1;
            this.micEnv = 0;
            this.micMsg = new Float64Array(1); // mic level alone (no analysed source, see process)
            this.micBlocks = 0;
            this.tap = null;          // TextureTap while audio textures are wanted
            this.port.onmessage = (e) => this.onCommand(e.data || {});
        }

        onCommand(cmd) {
            const t = this.tracker;
            switch (cmd.type) {
                case 'tempo': t.forceTempo(cmd.bpm, cmd.beatTime, cmd.lock); break;
                case 'lock': t.setLocked(cmd.lock); break;
                case 'reset': t.reset(); break;
                case 'textures': this.tap = cmd.on ? (this.tap || new TextureTap()) : null; break;
            }
        }

        process(inputs) {
            const input = inputs[0];
            const tracker = this.tracker;
            if (input && input.length) {
                const len = input[0].length;
                if (this.mono.length !== len) this.mono = new Float32Array(len);
                const mono = this.mono;
                const ch = input.length;
                if (ch === 1) mono.set(input[0]);
                else {
                    for (let i = 0; i < len; i++) {
                        let s = 0;
                        for (let c = 0; c < ch; c++) s += input[c][i];
                        mono[i] = s / ch;
                    }
                }
                tracker.process(mono, currentTime);
                if (this.tap) this.tap.push(mono);
            } else if (tracker.started) {
                // Disconnected input: keep time flowing with silence
                this.mono.fill(0);
                tracker.process(this.mono, currentTime);
                if (this.tap) this.tap.push(this.mono);
            }

            // Input 1: Microphone node meter (instant attack, smooth decay, like rms-processor)
            const mic = inputs[1];
            if (mic && mic.length && mic[0].length) {
                const s = mic[0];
                let peak = 0, sum = 0;
                for (let i = 0; i < s.length; i++) {
                    const a = Math.abs(s[i]);
                    if (a > peak) peak = a;
                    sum += s[i] * s[i];
                }
                const cur = Math.max(peak * 0.7, Math.sqrt(sum / s.length));
                this.micEnv = cur > this.micEnv ? cur : this.micEnv * 0.99;
            } else {
                this.micEnv *= 0.99;
            }

            // No analysed source yet (Metronome / Off in a fresh session): the tracker clock is
            // not running, so nothing below posts. A Microphone node meter still needs its
            // level: post it alone every 4 blocks (~ the state rate: 2 hops of 256 at 48 kHz)
            if (!tracker.started) {
                if (++this.micBlocks >= 4 && (this.micEnv > 1e-6 || (mic && mic.length))) {
                    this.micBlocks = 0;
                    this.micMsg[0] = this.micEnv;
                    this.port.postMessage(this.micMsg);
                }
                return true;
            }

            if (tracker.n !== this.lastN) {
                this.framesSincePost += tracker.n - this.lastN;
                this.lastN = tracker.n;
                if (this.framesSincePost >= 2) {
                    this.framesSincePost = 0;
                    tracker.writeState(this.state);
                    this.state[MSG.MIC_RMS] = this.micEnv;
                    this.port.postMessage(this.state);
                    if (this.tap) this.port.postMessage(this.tap.frame(tracker));
                }
            }
            return true;
        }
    }
    registerProcessor('patchtoy-analysis', PatchToyAnalysisProcessor);
}
