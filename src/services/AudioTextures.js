/**
 * AudioTextures - spectrum, waveform and spectrogram textures in the shared GL
 * context (formats and layout: src/core/audioTextureConfig.js).
 *
 * Data path
 *   live audio  The analysis worklet (services/audio/beat-worklet.js) already
 *               computes a 1024-point FFT every 256 samples for the beat tracker.
 *               While a shader uses an audio texture, AudioEngine asks it to post
 *               that power spectrum plus a trigger-aligned 1024-sample waveform
 *               with its regular state message (~94 Hz); the BeatTracker itself
 *               is untouched. AudioEngine keeps those frames in its message ring,
 *               so file sources read the frame that is audible now (like u_bass).
 *   metronome   A deterministic synthetic mix (kick / bass line / chords / snare /
 *               hats on the metronome groove) evaluated at the clock's beat
 *               position: headless renders and render_preview are reproducible.
 *   off         Zeros.
 *
 * Upload: lazily, at most once per frame per texture, on the first bind of the
 * frame (the renderers call liveTexture() for every sampler uniform that has a
 * textureOwner, see FeedbackRenderer.injectFeedbackTextures / ShaderPreview.render).
 * Textures no shader binds are never computed. Per frame: spectrum = one W x 1
 * RG16F texSubImage2D, waveform = one W x 1 R16F, spectrogram = the new row(s)
 * of a W x 256 R16F ring buffer (a full upload only after a reset / time jump).
 *
 * Inside clock.withOverride (render_preview) the metronome textures are
 * evaluated at the pinned time / beat (the whole spectrogram history too);
 * live sources keep their current content.
 */
import { clock } from '../core/Clock.js';
import { audioEngine } from './AudioEngine.js';
import {
    parseAudioTextureKey, spectrogramRate, binFrequency,
    SPECTROGRAM_ROWS, WAVE_WINDOW, FREQ_MIN, FREQ_MAX
} from '../core/audioTextureConfig.js';

const RANGE_DB = 62;        // dynamic range mapped to 0..1
const TILT_DB = 3;          // dB per octave added (relative to 1 kHz): music falls ~3-6 dB/oct
const REF_FLOOR_DB = -40;   // auto-gain reference never drops below this (silence stays dark)
const REF_RELEASE_DB = 6;   // dB per second the reference falls after a loud part
const PEAK_FALL = 0.5;      // peak-hold fall (units per second)
const SYNTH_SR = 48000;
const ROWS = SPECTROGRAM_ROWS;
const TAU = Math.PI * 2;
const LOG2 = Math.log2;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Deterministic 0..1 hash of two integers. */
function hash2(a, b) {
    let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Metronome synth: a deterministic mix on the groove of Clock.groove
// (kick + bass on every beat, snare on 2 & 4, hats on 8ths) plus a bass line
// and a four-chord progression (Am F C G, one chord per bar).
// ---------------------------------------------------------------------------
const CHORDS = [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]]; // semitones from A3 (220 Hz)
const BASS_STEPS = [0, 0, 12, 7];

function groove(B, periodMs, g) {
    const count = Math.floor(B);
    const phase = B - count;
    const sec = phase * periodMs / 1000;
    g.sec = sec;
    g.kick = Math.exp(-sec / 0.11);
    g.snare = (((count % 2) + 2) % 2) === 1 ? Math.exp(-sec / 0.16) : 0;
    const half = (phase * 2) % 1;
    g.hat = Math.exp(-(half * periodMs / 2000) / 0.05) * (phase >= 0.5 ? 1 : 0.6);
    g.kickF = 48 + 90 * Math.exp(-sec / 0.035);
    const bar = Math.floor(count / 4);
    const chord = CHORDS[((bar % 4) + 4) % 4];
    g.bassF = 55 * Math.pow(2, (chord[0] + BASS_STEPS[((count % 4) + 4) % 4]) / 12);
    g.bassEnv = 0.25 + 0.75 * Math.exp(-sec / 0.35);
    for (let k = 0; k < 3; k++) {
        g.tones[k] = 220 * Math.pow(2, chord[k] / 12);
        g.ltones[k] = LOG2(g.tones[k]);
    }
    g.lkick = LOG2(g.kickF);
    g.lbass = LOG2(g.bassF);
    g.pad = 0.55 + 0.25 * Math.sin(TAU * B / 8);
    return g;
}

const newGroove = () => ({
    sec: 0, kick: 0, snare: 0, hat: 0, kickF: 60, bassF: 55, bassEnv: 0, pad: 0,
    tones: new Float64Array(3), ltones: new Float64Array(3), lkick: 6, lbass: 6
});
const LOG2_H = [0, 0, 1, LOG2(3), 2];

const gauss = (x, w) => { const z = x / w; const z2 = z * z; return z2 > 9 ? 0 : Math.exp(-z2); };

/** Synthetic spectrum value 0..1 at frequency f (Hz, lf = log2 f) for groove state g; n = noise frame. */
function synthSpectrum(f, lf, g, n) {
    let s = 0.1 + 0.16 * gauss(lf - 8.6, 2.2);
    s += 1.05 * g.kick * gauss(lf - g.lkick, 0.5);
    const lb = g.lbass;
    for (let h = 1; h <= 4; h++) s += (0.6 * g.bassEnv / h) * gauss(lf - lb - LOG2_H[h], 0.05);
    for (let k = 0; k < 3; k++) {
        const lt = g.ltones[k];
        s += 0.34 * g.pad * gauss(lf - lt, 0.03) + 0.17 * g.pad * gauss(lf - lt - 1, 0.03) + 0.09 * g.pad * gauss(lf - lt - 1.585, 0.03);
    }
    const fb = Math.floor(lf * 48);
    const r = hash2(fb, n);
    s += 0.55 * g.snare * gauss(lf - 10.8, 1.3) * (0.6 + 0.8 * r);
    s += 0.5 * g.hat * gauss(lf - 13.1, 0.7) * (0.5 + r);
    s *= 0.9 + 0.2 * hash2(fb + 7919, n);
    if (f < 35) s *= Math.max(0, f / 35);
    if (f > 14000) s *= Math.exp(-(f - 14000) / 1500);
    return 1 - Math.exp(-1.5 * s);
}

/** Synthetic signed waveform: n samples ending at time t (s), beat position B at t. */
function synthWave(out, t, B, periodMs, g) {
    const n = out.length;
    const bps = 1000 / periodMs;
    const osc = synthWave.osc || (synthWave.osc = new Float64Array(24));
    const BLOCK = 32;
    for (let j0 = 0; j0 < n; j0 += BLOCK) {
        // Envelopes and oscillator phases exact at each 32-sample block (0.7 ms),
        // advanced by rotation inside it (no transcendental calls per sample)
        const back0 = (n - 1 - j0) / SYNTH_SR;
        const ts0 = t - back0;
        groove(B - back0 * bps, periodMs, g);
        const sec = g.sec;
        const kf = 48 + 90 * Math.exp(-sec / 0.035);
        const freqs = [kf, g.bassF, 2 * g.bassF, g.tones[0], g.tones[1], g.tones[2]];
        for (let k = 0; k < 6; k++) {
            const ph = k === 0 ? TAU * (48 * sec + 90 * 0.035 * (1 - Math.exp(-sec / 0.035))) : TAU * freqs[k] * ts0;
            const d = TAU * freqs[k] / SYNTH_SR;
            osc[4 * k] = Math.cos(ph); osc[4 * k + 1] = Math.sin(ph);
            osc[4 * k + 2] = Math.cos(d); osc[4 * k + 3] = Math.sin(d);
        }
        const aK = 0.62 * g.kick, aB = 0.26 * g.bassEnv, aP = 0.06 * g.pad, aS = 0.3 * g.snare, aH = 0.14 * g.hat;
        const end = Math.min(n, j0 + BLOCK);
        for (let j = j0; j < end; j++) {
            const idx = Math.floor((t - (n - 1 - j) / SYNTH_SR) * SYNTH_SR);
            let v = aK * osc[1] + aB * (osc[5] + 0.35 * osc[9]) + aP * (osc[13] + osc[17] + osc[21]);
            v += aS * (2 * hash2(idx, 17) - 1) + aH * (hash2(idx, 29) - hash2(idx - 1, 29));
            const x = clamp(1.7 * v, -3, 3);
            out[j] = x * (27 + x * x) / (27 + 9 * x * x); // tanh (Pade)
            for (let k = 0; k < 24; k += 4) {
                const c = osc[k], sn = osc[k + 1];
                osc[k] = c * osc[k + 2] - sn * osc[k + 3];
                osc[k + 1] = sn * osc[k + 2] + c * osc[k + 3];
            }
        }
    }
}

/**
 * Start index of a trigger-aligned window of `len` samples in `src` (2 * len long):
 * the latest rising zero crossing in the older half, else the newest window.
 * (Same rule as the worklet's live waveform.)
 */
function triggerStart(src, len) {
    for (let j = len; j >= 1; j--) {
        if (src[j - 1] < 0 && src[j] >= 0) return j;
    }
    return len;
}

// ---------------------------------------------------------------------------

class Entry {
    constructor(key) {
        this.key = key;
        this.cfg = parseAudioTextureKey(key);
        const c = this.cfg;
        this.w = c.bins;
        this.h = c.kind === 'spectrogram' ? ROWS : 1;
        this.channels = c.kind === 'spectrum' ? 2 : 1;
        this.cpu = new Float32Array(this.w * this.h * this.channels);
        this.freqs = new Float32Array(this.w);
        this.lfreqs = new Float32Array(this.w);
        for (let i = 0; i < this.w; i++) {
            this.freqs[i] = binFrequency(i, this.w, c.scale);
            this.lfreqs[i] = LOG2(this.freqs[i]);
        }
        this.rate = c.kind === 'spectrogram' ? spectrogramRate(c) : 0;
        this.cur = c.kind === 'spectrogram' ? new Float32Array(this.w) : null;   // smoothed live spectrum
        this.prev = c.kind === 'spectrogram' ? new Float32Array(this.w) : null;  // last written row
        this.row = null;          // newest absolute row written (spectrogram)
        this.mode = null;         // data mode of the content: live | synth | zero
        this.stamp = null;        // frame stamp of the last update
        this.zero = true;         // content is all zeros
        this.ovDirty = false;     // overwritten by an override render: rebuild on the next live frame
        this.map = null;          // FFT bin mapping (built per sample rate / FFT size)
        this.mapFor = '';
        this.gl = null;
        this.tex = null;
        this.usedFrame = 0;
        this.uploads = 0;
    }
}

export class AudioTextureManager {
    constructor() {
        this.entries = new Map();
        this.gl = null;
        this.f = {
            stamp: null, mode: 'zero', override: false,
            t: 0, B: 0, periodMs: 500, dt: 0, noise: 0,
            norm: null, nBins: 0, binHz: 0,
            wave: new Float32Array(WAVE_WINDOW), waveOk: false
        };
        this.lastT = null;
        this.ref = REF_FLOOR_DB;
        this.wavePeak = 0.1;
        this.g = newGroove();
        this.synthBuf = new Float32Array(2 * WAVE_WINDOW);
        this.frameBytes = 0;      // bytes uploaded in the current frame (all textures)
        this.lastFrameBytes = 0;
        this.sweepAt = 0;
    }

    // ------------------------------------------------------------------
    // Renderer interface (textureOwner)
    // ------------------------------------------------------------------

    /** The GL texture for a key, created (zeros) on first use. Called at compile time. */
    getTexture(gl, key) {
        if (!gl) return null;
        if (!this.gl) this.gl = gl;
        let e = this.entries.get(key);
        if (!e) { e = new Entry(key); this.entries.set(key, e); }
        this.ensureTexture(e, gl);
        e.usedFrame = clock.frame;
        return e.tex;
    }

    /** Current texture for a key, updated for this frame (called on every bind). */
    liveTexture(key) {
        let e = this.entries.get(key);
        if (!e) {
            if (!this.gl) return null;
            this.getTexture(this.gl, key);
            e = this.entries.get(key);
        }
        if (!e.tex) return null;
        e.usedFrame = clock.frame;
        try {
            this.update(e);
        } catch (err) {
            if (!this._warned) { this._warned = true; console.warn('[audio textures] update failed', err); }
        }
        return e.tex;
    }

    // ------------------------------------------------------------------
    // Per-frame source data
    // ------------------------------------------------------------------

    sourceMode() {
        if (audioEngine.source === 'metronome') return 'synth';
        if (audioEngine.isLive()) return 'live';
        return 'zero';
    }

    /** Prepare this frame's data. Returns false when textures must keep their content. */
    prepare() {
        const u = clock.u;
        const override = clock._override > 0;
        const f = this.f;
        if (!override && clock.paused) { f.hold = false; return false; }
        const B = u.beatCount + u.beatPhase;
        const stamp = override ? `o${u.time}|${B}|${u.bpm}` : clock.frame;
        if (stamp === f.stamp) return f.hold !== true;
        f.stamp = stamp;
        f.override = override;
        f.mode = this.sourceMode();
        f.hold = override && f.mode === 'live';
        if (f.hold) return false;

        if (!override && stamp !== this._bytesStamp) {
            this._bytesStamp = stamp;
            this.lastFrameBytes = this.frameBytes;
            this.frameBytes = 0;
            if (clock.frame >= this.sweepAt) this.sweep();
        }

        const t = Math.fround(u.time);
        f.t = t;
        f.B = B;
        f.periodMs = u.bpm > 0 ? 60000 / u.bpm : 500;
        f.noise = Math.floor(t * 30);
        if (override) f.dt = 0;
        else {
            f.dt = this.lastT === null ? 0 : clamp(t - this.lastT, 0, 0.1);
            this.lastT = t;
        }

        f.waveOk = false;
        f.norm = null;
        if (f.mode === 'live') this.prepareLive(f);
        else if (f.mode === 'synth') this.prepareSynthWave(f);
        return true;
    }

    prepareLive(f) {
        const now = performance.now();
        audioEngine.wantTextures(now);
        const msg = audioEngine.textureFrame();
        const sr = audioEngine.ctx ? audioEngine.ctx.sampleRate : 48000;
        if (!msg) return;
        const nb = msg[0] | 0;
        const nw = msg[1] | 0;
        if (!(nb > 8) || msg.length < 2 + nb + nw) return;
        if (!f.normBuf || f.normBuf.length !== nb) f.normBuf = new Float32Array(nb);
        const norm = f.normBuf;
        const binHz = sr / (2 * nb);
        // dB with a pink-noise tilt, auto-gained to the recent loudest bin
        let maxDb = -200;
        for (let k = 1; k < nb; k++) {
            const fk = k * binHz;
            const db = 10 * Math.log10(msg[2 + k] + 1e-14) + TILT_DB * LOG2(Math.max(fk, 20) / 1000);
            norm[k] = db;
            if (fk >= FREQ_MIN && fk <= FREQ_MAX && db > maxDb) maxDb = db;
        }
        norm[0] = -200;
        this.ref = Math.max(maxDb, this.ref - REF_RELEASE_DB * f.dt, REF_FLOOR_DB);
        if (this.ref > 12) this.ref = 12;
        const lo = this.ref - RANGE_DB;
        for (let k = 0; k < nb; k++) {
            const v = clamp((norm[k] - lo) / RANGE_DB, 0, 1);
            norm[k] = v * Math.sqrt(v); // expand a little: quiet stays low, peaks pop
        }
        f.norm = norm;
        f.nBins = nb;
        f.binHz = binHz;

        // Waveform: auto-gained (peak follower, max gain 8)
        const off = 2 + nb;
        const n = Math.min(nw, WAVE_WINDOW);
        let peak = 0;
        for (let j = 0; j < n; j++) { const a = Math.abs(msg[off + j]); if (a > peak) peak = a; }
        this.wavePeak = Math.max(peak, this.wavePeak * Math.exp(-f.dt / 1.5), 0.1);
        const gain = 0.85 / this.wavePeak;
        for (let j = 0; j < WAVE_WINDOW; j++) f.wave[j] = j < n ? clamp(msg[off + j] * gain, -1, 1) : 0;
        f.waveOk = true;
    }

    prepareSynthWave(f) {
        const buf = this.synthBuf;
        synthWave(buf, f.t, f.B, f.periodMs, this.g);
        const s = triggerStart(buf, WAVE_WINDOW);
        for (let j = 0; j < WAVE_WINDOW; j++) f.wave[j] = clamp(buf[s + j], -1, 1);
        f.waveOk = true;
    }

    /** FFT bin -> texel mapping (max over the covered bins, interpolation below one bin). */
    buildMap(e, nb, binHz) {
        const sig = `${nb}/${binHz}`;
        if (e.mapFor === sig) return e.map;
        const w = e.w;
        const lo = new Int32Array(w), hi = new Int32Array(w), fr = new Float32Array(w);
        const edge = i => (e.cfg.scale === 'linear' ? (i / w) * FREQ_MAX : FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, i / w));
        for (let i = 0; i < w; i++) {
            const ka = edge(i) / binHz;
            const kb = edge(i + 1) / binHz;
            const a = Math.max(1, Math.round(ka));
            const b = Math.min(nb - 1, Math.round(kb) - 1);
            if (b >= a) { lo[i] = a; hi[i] = b; }
            else {
                const kc = clamp((ka + kb) / 2, 1, nb - 1.001);
                lo[i] = Math.floor(kc); hi[i] = -1; fr[i] = kc - lo[i];
            }
        }
        e.map = { lo, hi, fr };
        e.mapFor = sig;
        return e.map;
    }

    /** Live spectrum (0..1, unsmoothed) into out[0..w). */
    liveSpectrum(e, out) {
        const f = this.f;
        if (!f.norm) { out.fill(0); return; }
        const { lo, hi, fr } = this.buildMap(e, f.nBins, f.binHz);
        const norm = f.norm;
        for (let i = 0; i < e.w; i++) {
            if (hi[i] < 0) {
                const k = lo[i];
                out[i] = norm[k] + (norm[k + 1] - norm[k]) * fr[i];
            } else {
                let m = 0;
                for (let k = lo[i]; k <= hi[i]; k++) if (norm[k] > m) m = norm[k];
                out[i] = m;
            }
        }
    }

    /** Synthetic spectrum at time t / beat B into out (stride 1). */
    synthRow(e, out, B, noise) {
        const g = groove(B, this.f.periodMs, this.g);
        const fq = e.freqs, lf = e.lfreqs;
        for (let i = 0; i < e.w; i++) out[i] = synthSpectrum(fq[i], lf[i], g, noise);
    }

    // ------------------------------------------------------------------
    // Texture updates
    // ------------------------------------------------------------------

    update(e) {
        const f = this.f;
        if (!this.prepare()) {
            // Paused, or a live source inside a pinned render: keep the content (a
            // spectrogram is re-aligned to the pinned u_time, restored afterwards)
            if (f.hold && e.cfg.kind === 'spectrogram') this.holdSpectrogram(e);
            return;
        }
        if (e.gpuShifted && !f.override) { e.gpuShifted = false; this.upload(e, 0, e.h); }
        if (e.stamp === f.stamp) return;
        e.stamp = f.stamp;
        if (e.ovDirty && !f.override) { e.ovDirty = false; e.row = null; e.mode = null; }
        const kind = e.cfg.kind;
        if (kind === 'spectrum') this.updateSpectrum(e);
        else if (kind === 'waveform') this.updateWaveform(e);
        else this.updateSpectrogram(e);
        if (f.override) e.ovDirty = true;
    }

    /**
     * Live spectrogram inside a pinned render (render_preview time != live time):
     * upload the history shifted so that the ring rows match the pinned u_time
     * (the shader derives the newest row from u_time).
     */
    holdSpectrogram(e) {
        const f = this.f;
        if (e.heldStamp === f.stamp || e.row === null) return;
        e.heldStamp = f.stamp;
        const rP = Math.floor(Math.fround(clock.u.time) * e.rate);
        const shift = (((rP - e.row) % ROWS) + ROWS) % ROWS;
        if (shift === 0 && !e.gpuShifted) return;
        const w = e.w;
        if (!this.shiftBuf || this.shiftBuf.length !== e.cpu.length) this.shiftBuf = new Float32Array(e.cpu.length);
        const out = this.shiftBuf;
        for (let k = 0; k < ROWS; k++) out.set(e.cpu.subarray(k * w, (k + 1) * w), ((k + shift) % ROWS) * w);
        this.upload(e, 0, ROWS, out);
        e.gpuShifted = true;
    }

    updateSpectrum(e) {
        const f = this.f;
        const w = e.w;
        const cpu = e.cpu;
        if (f.mode === 'zero') {
            e.mode = 'zero';
            if (e.zero) return;
            cpu.fill(0);
            e.zero = true;
            this.upload(e, 0, 1);
            return;
        }
        if (!this.tmp || this.tmp.length < w) this.tmp = new Float32Array(Math.max(w, 1024));
        const x = this.tmp;
        if (f.mode === 'synth') {
            this.synthRow(e, x, f.B, f.noise);
            for (let i = 0; i < w; i++) cpu[2 * i] = x[i];
            // Peak hold (deterministic, no state): the envelopes' max over the last
            // 0.3 s (falling), then one more synthetic row with those
            const bps = 1000 / f.periodMs;
            const g = this.g, h = this.gHold || (this.gHold = newGroove());
            groove(f.B, f.periodMs, g);
            Object.assign(h, { kick: g.kick, snare: g.snare, hat: g.hat, bassEnv: g.bassEnv, pad: g.pad, lkick: g.lkick, lbass: g.lbass });
            h.ltones.set(g.ltones);
            for (let k = 1; k <= 3; k++) {
                const back = 0.1 * k, fall = PEAK_FALL * back * 1.5;
                groove(f.B - back * bps, f.periodMs, g);
                if (g.kick - fall > h.kick) { h.kick = g.kick - fall; h.lkick = g.lkick; }
                h.snare = Math.max(h.snare, g.snare - fall);
                h.hat = Math.max(h.hat, g.hat - fall);
                h.bassEnv = Math.max(h.bassEnv, g.bassEnv - fall);
            }
            const fq = e.freqs, lf = e.lfreqs;
            for (let i = 0; i < w; i++) {
                const p = synthSpectrum(fq[i], lf[i], h, f.noise);
                cpu[2 * i + 1] = p > x[i] ? p : x[i];
            }
        } else {
            this.liveSpectrum(e, x);
            const s = e.cfg.smoothing;
            const n60 = f.dt * 60;
            const rel = s > 0 ? Math.pow(s, n60) : 0;
            const att = s > 0 ? Math.pow(s * 0.4, n60) : 0;
            const fall = PEAK_FALL * f.dt;
            const fresh = e.mode !== 'live';
            for (let i = 0; i < w; i++) {
                const v = x[i];
                let r = fresh ? v : cpu[2 * i];
                r = v + (r - v) * (v > r ? att : rel);
                cpu[2 * i] = r;
                const p = fresh ? r : cpu[2 * i + 1] - fall;
                cpu[2 * i + 1] = p > r ? p : r;
            }
        }
        e.mode = f.mode;
        e.zero = false;
        this.upload(e, 0, 1);
    }

    updateWaveform(e) {
        const f = this.f;
        const cpu = e.cpu;
        if (f.mode === 'zero' || !f.waveOk) {
            e.mode = f.mode;
            if (e.zero) return;
            cpu.fill(0);
            e.zero = true;
            this.upload(e, 0, 1);
            return;
        }
        const w = e.w;
        const src = f.wave;
        const scale = (WAVE_WINDOW - 1) / Math.max(1, w - 1);
        for (let i = 0; i < w; i++) {
            const p = i * scale;
            const k = Math.floor(p);
            const a = src[k];
            const b = k + 1 < WAVE_WINDOW ? src[k + 1] : a;
            cpu[i] = a + (b - a) * (p - k);
        }
        e.mode = f.mode;
        e.zero = false;
        this.upload(e, 0, 1);
    }

    updateSpectrogram(e) {
        const f = this.f;
        const w = e.w;
        const cpu = e.cpu;
        const rate = e.rate;
        const rNow = Math.floor(f.t * rate);
        const bps = 1000 / f.periodMs;
        const writeRow = (r, src) => cpu.set(src.length === w ? src : src.subarray(0, w), (((r % ROWS) + ROWS) % ROWS) * w);
        if (!this.tmp || this.tmp.length < w) this.tmp = new Float32Array(Math.max(w, 1024));
        const x = this.tmp.subarray(0, w);
        const synthAt = (r) => {
            const tr = r / rate;
            this.synthRow(e, x, f.B - (f.t - tr) * bps, Math.floor(tr * 30));
            return x;
        };

        const rebuild = e.row === null || e.mode !== f.mode || rNow < e.row || rNow - e.row >= ROWS;
        if (rebuild) {
            if (f.mode === 'synth') {
                for (let r = rNow - ROWS + 1; r <= rNow; r++) writeRow(r, synthAt(r));
                e.prev.set(x);
                e.zero = false;
            } else {
                cpu.fill(0);
                e.cur.fill(0);
                e.prev.fill(0);
                if (f.mode === 'live') {
                    this.liveSpectrum(e, e.cur);
                    writeRow(rNow, e.cur);
                    e.prev.set(e.cur);
                }
                e.zero = f.mode === 'zero';
            }
            e.row = rNow;
            e.mode = f.mode;
            this.upload(e, 0, ROWS);
            return;
        }
        if (f.mode === 'live') {
            // smoothed current spectrum (time constant from the smoothing option)
            this.liveSpectrum(e, x);
            const s = e.cfg.smoothing;
            const k = s > 0 ? Math.pow(s, f.dt * 60) : 0;
            const cur = e.cur;
            for (let i = 0; i < w; i++) cur[i] = x[i] + (cur[i] - x[i]) * k;
        }
        if (rNow === e.row) return;
        if (f.mode === 'zero' && e.zero) { e.row = rNow; return; }
        const first = e.row + 1;
        const n = rNow - e.row;
        for (let r = first; r <= rNow; r++) {
            if (f.mode === 'synth') writeRow(r, synthAt(r));
            else if (f.mode === 'zero') writeRow(r, x.fill(0));
            else {
                const a = (r - e.row) / n;
                const cur = e.cur, prev = e.prev;
                for (let i = 0; i < w; i++) x[i] = prev[i] + (cur[i] - prev[i]) * a;
                writeRow(r, x);
            }
        }
        if (f.mode === 'live') e.prev.set(e.cur);
        e.row = rNow;
        e.zero = f.mode === 'zero';
        // upload the new rows (one or two ranges in the ring)
        const r0 = ((first % ROWS) + ROWS) % ROWS;
        const cnt = Math.min(n, ROWS);
        if (r0 + cnt <= ROWS) this.upload(e, r0, cnt);
        else { this.upload(e, r0, ROWS - r0); this.upload(e, 0, cnt - (ROWS - r0)); }
    }

    // ------------------------------------------------------------------
    // GL
    // ------------------------------------------------------------------

    formats(e, gl) {
        return e.channels === 2 ? [gl.RG16F, gl.RG] : [gl.R16F, gl.RED];
    }

    ensureTexture(e, gl) {
        if (e.tex && e.gl === gl) return;
        const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
        const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        const [internal, format] = this.formats(e, gl);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, e.w, e.h, 0, format, gl.FLOAT, e.cpu);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, e.cfg.kind === 'spectrogram' ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, prev);
        if (flip) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        e.gl = gl;
        e.tex = tex;
    }

    /** Upload rows [row, row + count) of the CPU copy (or of src, same layout). */
    upload(e, row, count, src = e.cpu) {
        const gl = e.gl;
        if (!gl || !e.tex || count <= 0) return;
        const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
        const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
        gl.bindTexture(gl.TEXTURE_2D, e.tex);
        if (flip) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        const [, format] = this.formats(e, gl);
        const stride = e.w * e.channels;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, e.w, count, format, gl.FLOAT, src, row * stride);
        gl.bindTexture(gl.TEXTURE_2D, prev);
        if (flip) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        e.uploads++;
        this.frameBytes += count * stride * 4;
    }

    /**
     * Forget all per-frame history: auto-gain reference, waveform peak follower, smoothed
     * spectra and peak caps, spectrogram rows, groove state. The GL textures stay (zeroed),
     * so compiled shaders keep their bindings. Used for reproducible starts (offline export
     * "from start", render_preview warm-up) and when a project is replaced.
     */
    reset() {
        this.lastT = null;
        this.ref = REF_FLOOR_DB;
        this.wavePeak = 0.1;
        this.g = newGroove();
        this.gHold = null;
        const f = this.f;
        f.stamp = null;
        f.hold = false;
        f.override = false;
        f.dt = 0;
        f.norm = null;
        f.waveOk = false;
        f.wave.fill(0);
        for (const e of this.entries.values()) {
            e.cpu.fill(0);
            if (e.cur) e.cur.fill(0);
            if (e.prev) e.prev.fill(0);
            e.row = null;
            e.mode = null;
            e.stamp = null;
            e.heldStamp = null;
            e.zero = true;
            e.ovDirty = false;
            e.gpuShifted = false;
            try { if (e.tex) this.upload(e, 0, e.h); } catch (err) { /* context lost */ }
        }
    }

    /** Free textures no shader has bound for ~30 s (re-created on demand). */
    sweep() {
        this.sweepAt = clock.frame + 600;
        for (const [key, e] of this.entries) {
            if (clock.frame - e.usedFrame > 1800) {
                try { if (e.tex) e.gl.deleteTexture(e.tex); } catch (err) { /* context lost */ }
                this.entries.delete(key);
            }
        }
    }

    // ------------------------------------------------------------------
    // Inspection (node thumbnails, automation status)
    // ------------------------------------------------------------------

    /** CPU copy of a texture ({ cfg, data, w, h, channels, row, mode }) or null. */
    peek(key) {
        const e = this.entries.get(key);
        if (!e) return null;
        return { cfg: e.cfg, data: e.cpu, w: e.w, h: e.h, channels: e.channels, row: e.row, mode: e.mode };
    }

    status() {
        const textures = [];
        for (const e of this.entries.values()) {
            let max = 0, sum = 0;
            const n = e.w * e.h;
            for (let i = 0; i < n; i++) {
                const v = Math.abs(e.cpu[i * e.channels]);
                sum += v;
                if (v > max) max = v;
            }
            textures.push({
                key: e.key, kind: e.cfg.kind, width: e.w, height: e.h,
                format: e.channels === 2 ? 'rg16f' : 'r16f',
                mode: e.mode, max: +max.toFixed(4), mean: +(sum / n).toFixed(4),
                uploads: e.uploads, newest_row: e.cfg.kind === 'spectrogram' ? e.row : undefined
            });
        }
        return { source_mode: this.sourceMode(), upload_bytes_last_frame: this.lastFrameBytes, textures };
    }
}

export const audioTextures = new AudioTextureManager();
if (typeof window !== 'undefined') window.__patchtoyAudioTextures = audioTextures;
