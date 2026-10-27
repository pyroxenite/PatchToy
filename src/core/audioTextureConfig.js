/**
 * Audio textures: configuration shared by the node library (pure, no DOM / GL)
 * and the GPU side (src/services/AudioTextures.js).
 *
 * Three kinds, all single-row or ring-buffered float textures (R16F / RG16F,
 * LINEAR filtering) in the shared GL context:
 *
 *   spectrum     W x 1 RG16F: r = FFT magnitude in dB, auto-gained to 0..1
 *                (smoothed), g = falling peak hold. x = frequency, log-spaced
 *                30 Hz .. 16 kHz (f = 30 * (16000 / 30)^x) or linear 0 .. 16 kHz.
 *   waveform     W x 1 R16F: the latest 1024 samples (~21 ms at 48 kHz),
 *                trigger-aligned on a rising zero crossing, auto-gained, signed
 *                -1..1 (0 = silence).
 *   spectrogram  W x 256 R16F, a ring buffer of spectra: row r holds the
 *                spectrum at time r / rate (rate = 256 / history rows per
 *                second, a power of two), so the newest row is
 *                floor(u_time * rate) mod 256 and only that row is uploaded
 *                each frame. Read it with time -> v:
 *                  texture(tex, vec2(freq, (u_time - age) / history - 0.5 / 256.0))
 *                (REPEAT wrap; age in 0 .. history * (1 - 2 / 256) seconds),
 *                or with pt_spectrogram(tex, uv, history).
 *
 * Global samplers (declared only when GLSL references them, bound lazily):
 *   u_spectrum     spectrum, 512 bins, log, smoothing 0.6
 *   u_waveform     waveform, 1024 samples
 *   u_spectrogram  spectrogram, 256 bins x 256 rows, log, 4 s history (64 rows/s)
 */

export const AUDIO_TEXTURE_KINDS = ['spectrum', 'waveform', 'spectrogram'];
export const AUDIO_TEXTURE_SCALES = ['log', 'linear'];
export const AUDIO_TEXTURE_BINS = {
    spectrum: [64, 128, 256, 512, 1024],
    waveform: [256, 512, 1024],
    spectrogram: [64, 128, 256, 512]
};
export const AUDIO_TEXTURE_SMOOTHING = [0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9];
export const AUDIO_TEXTURE_HISTORY = [2, 4, 8]; // seconds (128 / 64 / 32 rows per second)

export const SPECTROGRAM_ROWS = 256;
export const WAVE_WINDOW = 1024;          // samples in a waveform frame
export const FREQ_MIN = 30;               // Hz, log scale low edge
export const FREQ_MAX = 16000;            // Hz, high edge (both scales)

const DEFAULTS = {
    spectrum: { bins: 512, scale: 'log', smoothing: 0.6, history: 4 },
    waveform: { bins: 1024, scale: 'log', smoothing: 0, history: 4 },
    spectrogram: { bins: 256, scale: 'log', smoothing: 0.3, history: 4 }
};

const nearest = (list, v, fallback) => {
    if (v === null || v === undefined || v === '' || v === 'auto') return fallback;
    const x = Number(v);
    if (!Number.isFinite(x)) return fallback;
    let best = list[0];
    for (const c of list) if (Math.abs(c - x) < Math.abs(best - x)) best = c;
    return best;
};

/** Validated config { kind, bins, scale, smoothing, history } from node data (any missing field = default). */
export function normalizeAudioTexture(data = {}) {
    const kind = AUDIO_TEXTURE_KINDS.includes(String(data.kind)) ? String(data.kind) : 'spectrum';
    const d = DEFAULTS[kind];
    const scale = AUDIO_TEXTURE_SCALES.includes(String(data.scale)) ? String(data.scale) : d.scale;
    return {
        kind,
        bins: nearest(AUDIO_TEXTURE_BINS[kind], data.bins, d.bins),
        scale,
        smoothing: nearest(AUDIO_TEXTURE_SMOOTHING, data.smoothing, d.smoothing),
        history: nearest(AUDIO_TEXTURE_HISTORY, data.history, d.history)
    };
}

/** Texture key: one GPU texture per distinct key (waveform ignores scale / smoothing / history). */
export function audioTextureKey(cfg) {
    const c = normalizeAudioTexture(cfg);
    if (c.kind === 'waveform') return `waveform/${c.bins}`;
    if (c.kind === 'spectrum') return `spectrum/${c.bins}/${c.scale}/${c.smoothing}`;
    return `spectrogram/${c.bins}/${c.scale}/${c.smoothing}/${c.history}`;
}

export function parseAudioTextureKey(key) {
    const [kind, bins, scale, smoothing, history] = String(key).split('/');
    return normalizeAudioTexture({ kind, bins, scale, smoothing, history });
}

/** Rows per second of a spectrogram (a power of two, so GPU and CPU agree on floor(u_time * rate)). */
export function spectrogramRate(cfg) {
    return SPECTROGRAM_ROWS / cfg.history;
}

/** Built-in sampler uniforms -> texture key. */
export const BUILTIN_AUDIO_TEXTURES = {
    u_spectrum: audioTextureKey({ kind: 'spectrum' }),
    u_waveform: audioTextureKey({ kind: 'waveform' }),
    u_spectrogram: audioTextureKey({ kind: 'spectrogram' })
};

/** Centre frequency (Hz) of texel i of n for a scale. */
export function binFrequency(i, n, scale) {
    const x = (i + 0.5) / n;
    return scale === 'linear' ? x * FREQ_MAX : FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, x);
}

/** GLSL that reads a spectrogram texture with time -> x (pt_* library function, see audio.js). */
export const SPECTROGRAM_NOTE = 'Spectrogram: rows are a ring buffer indexed by time (row = floor(u_time * 256 / history) mod 256), ' +
    'so read it as texture(tex, vec2(freq, (u_time - age) / history - 0.5 / 256.0)) with age in 0 .. ~history seconds, ' +
    'or pt_spectrogram(tex, vec2(time 0 oldest..1 now, freq), history) in library code.';
