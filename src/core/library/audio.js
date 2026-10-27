/**
 * Audio textures in the graph (sources / audio):
 *
 *   Audio Texture      spectrum / waveform / spectrogram of the top-bar audio
 *                      source as a sampler2D (+ the value at uv, + the
 *                      spectrogram's newest row). Options are node data
 *                      (kind, bins, scale, smoothing, history), one GPU texture
 *                      per distinct configuration, shared by every node / shader.
 *   Spectrum Bars      uv -> bar mask, peak caps and level (classic analyser)
 *   Waveform Line      uv -> anti-aliased oscilloscope line + glow
 *   Circular Spectrum  centred coords -> polar bars around a ring
 *
 * The helpers take a `tex` input that defaults to the global samplers
 * (u_spectrum / u_waveform), so they work with nothing wired; connect an
 * Audio Texture to use other options. Their trailing `amount` follows
 * library/amount.js: 0 = no contribution (exact), 1 = full, in between the bar
 * heights / wave amplitude scale.
 *
 * Texture layout and the GPU side: src/core/audioTextureConfig.js and
 * src/services/AudioTextures.js. The renderers bind the texture uniforms
 * (`audioTexture` key) through FeedbackRenderer.injectFeedbackTextures.
 */
import { GLSL_LIB, collectLibrary } from './glsl.js';
import { effectNode } from './amount.js';
import { builtinUniformsIn } from '../builtinUniforms.js';
import {
    normalizeAudioTexture, audioTextureKey, spectrogramRate,
    AUDIO_TEXTURE_KINDS, AUDIO_TEXTURE_BINS, AUDIO_TEXTURE_SCALES, AUDIO_TEXTURE_SMOOTHING, AUDIO_TEXTURE_HISTORY,
    SPECTROGRAM_ROWS, SPECTROGRAM_NOTE
} from '../audioTextureConfig.js';

const C = 'source';

// ---------------------------------------------------------------------------
// Shared GLSL (registered into the pt_* library)
// ---------------------------------------------------------------------------
Object.assign(GLSL_LIB, {
    /** Spectrogram read with time -> x: uv.x 0 = oldest .. 1 = now, uv.y = frequency 0..1. */
    pt_spectrogram: `vec4 pt_spectrogram(sampler2D tex, vec2 uv, float history) {
    float rows = float(textureSize(tex, 0).y);
    float age = (1.0 - clamp(uv.x, 0.0, 1.0)) * history * (1.0 - 2.0 / rows);
    return texture(tex, vec2(clamp(uv.y, 0.0, 1.0), (u_time - age) / history - 0.5 / rows));
}`,

    /** Texture x of a bar position: logw = 1 reads a linear-frequency texture on a log axis. */
    pt_specAxis: `float pt_specAxis(float x, float logw) {
    float lx = 30.0 * pow(533.33333, clamp(x, 0.0, 1.0)) / 16000.0;
    return mix(x, lx, clamp(logw, 0.0, 1.0));
}`,

    /** Spectrum bars: x = mask, y = peak cap, z = bar level, w = bar centre 0..1. */
    pt_spectrumBars: `vec4 pt_spectrumBars(sampler2D tex, vec2 uv, float bars, float gap, float height, float mirror, float logw, float amt) {
    float n = max(floor(bars + 0.5), 1.0);
    float x = clamp(uv.x, 0.0, 1.0);
    float i = min(floor(x * n), n - 1.0);
    float fx = x * n - i;
    vec2 lv = vec2(0.0);
    for (int k = 0; k < 4; k++) {
        float tx = pt_specAxis((i + (float(k) + 0.5) * 0.25) / n, logw);
        lv = max(lv, texture(tex, vec2(tx, 0.5)).rg);
    }
    lv *= amt;
    bool mir = mirror > 0.5;
    float y = mir ? abs(uv.y - 0.5) * 2.0 : uv.y;
    float py = max(fwidth(uv.y) * (mir ? 2.0 : 1.0), 1e-5);
    float pxw = max(fwidth(uv.x) * n, 1e-5);
    float g = clamp(gap, 0.0, 0.95) * 0.5;
    float body = smoothstep(g - pxw, g + pxw, fx) * (1.0 - smoothstep(1.0 - g - pxw, 1.0 - g + pxw, fx));
    float h = lv.x * height;
    float m = body * (1.0 - smoothstep(h - py, h + py, y)) * step(1e-4, h);
    float ph = lv.y * height + 0.012;
    float cap = body * (1.0 - smoothstep(0.006, 0.006 + py, abs(y - ph))) * step(1e-4, lv.y);
    return vec4(m, cap, lv.x, (i + 0.5) / n);
}`,

    /** Signed waveform sample at x (0..1). */
    pt_waveAt: `float pt_waveAt(sampler2D tex, float x) {
    return texture(tex, vec2(clamp(x, 0.0, 1.0), 0.5)).r;
}`,

    /** Oscilloscope line: x = anti-aliased line, y = glow, z = waveform value at uv.x. */
    pt_waveformLine: `vec3 pt_waveformLine(sampler2D tex, vec2 uv, float center, float gain, float thickness) {
    vec2 fw = max(fwidth(uv), vec2(1e-6));
    float sx = fw.y / fw.x;
    float dx = max(fw.x * 1.5, 1.0 / 4096.0);
    vec2 q = vec2(uv.x * sx, uv.y);
    float x0 = uv.x - 3.0 * dx;
    vec2 prev = vec2(x0 * sx, center + gain * pt_waveAt(tex, x0));
    float d = 1e9;
    for (int k = -2; k <= 3; k++) {
        float x = uv.x + float(k) * dx;
        vec2 p = vec2(x * sx, center + gain * pt_waveAt(tex, x));
        vec2 ab = p - prev;
        vec2 ap = q - prev;
        float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
        d = min(d, length(ap - ab * t));
        prev = p;
    }
    float th = max(thickness, 0.0);
    float line = 1.0 - smoothstep(th - fw.y, th + fw.y, d);
    float glow = exp(-max(d - th, 0.0) / max(th * 6.0 + fw.y * 2.0, 1e-4));
    return vec3(line, glow, pt_waveAt(tex, uv.x));
}`,

    /** Polar spectrum bars around a ring: x = mask, y = peak cap, z = level, w = ring line. */
    pt_circularSpectrum: `vec4 pt_circularSpectrum(sampler2D tex, vec2 p, float radius, float height, float bars, float gap, float rotation, float mirror, float amt) {
    float r = length(p);
    float t = fract(atan(p.x, p.y) / 6.2831853 + rotation);
    float n = max(floor(bars + 0.5), 1.0);
    float i = min(floor(t * n), n - 1.0);
    float fx = t * n - i;
    float c = (i + 0.5) / n;
    bool mir = mirror > 0.5;
    float sx = mir ? 1.0 - abs(2.0 * c - 1.0) : c;
    float hw = (mir ? 0.5 : 0.25) / n;
    vec2 lv = max(texture(tex, vec2(clamp(sx - hw, 0.0, 1.0), 0.5)).rg, texture(tex, vec2(clamp(sx + hw, 0.0, 1.0), 0.5)).rg);
    lv *= amt;
    float pr = max(length(fwidth(p)), 1e-5);
    float arc = pr * n / (6.2831853 * max(r, 1e-3));
    float g = clamp(gap, 0.0, 0.95) * 0.5;
    float body = smoothstep(g - arc, g + arc, fx) * (1.0 - smoothstep(1.0 - g - arc, 1.0 - g + arc, fx));
    float h = radius + lv.x * height;
    float m = body * smoothstep(radius - pr, radius + pr, r) * (1.0 - smoothstep(h - pr, h + pr, r)) * step(1e-4, lv.x);
    float ph = radius + lv.y * height + 0.015;
    float cap = body * (1.0 - smoothstep(0.005, 0.005 + pr, abs(r - ph))) * step(1e-4, lv.y);
    float ring = (1.0 - smoothstep(0.003, 0.003 + pr, abs(r - radius + 0.012))) * step(1e-4, amt);
    return vec4(m, cap, lv.x, ring);
}`
});

// ---------------------------------------------------------------------------
// Audio Texture
// ---------------------------------------------------------------------------

export const AUDIO_TEXTURE_OPTIONS = [
    { key: 'kind', label: 'kind', values: AUDIO_TEXTURE_KINDS },
    { key: 'bins', label: 'bins', values: [64, 128, 256, 512, 1024] }, // per kind: audioTextureOptionValues
    { key: 'scale', label: 'scale', values: AUDIO_TEXTURE_SCALES },
    { key: 'smoothing', label: 'smooth', values: AUDIO_TEXTURE_SMOOTHING },
    { key: 'history', label: 'history', values: AUDIO_TEXTURE_HISTORY, unit: 's' }
];

/** Option values for a node (bins follow its kind). */
export function audioTextureOptionValues(opt, data) {
    if (opt.key === 'bins') return AUDIO_TEXTURE_BINS[normalizeAudioTexture(data).kind];
    return opt.values;
}

const AUDIO_TEXTURE_DESC = 'Audio as a texture (sampler2D) from the top-bar audio source (mic, file, tab audio; metronome = a deterministic synthetic mix, off = zeros). ' +
    "data.kind: 'spectrum' (bins x 1: r = magnitude in dB, auto-gained 0..1 and smoothed, g = falling peak hold; x = frequency, log 30 Hz..16 kHz: f = 30 * 533.3^x, or linear 0..16 kHz), " +
    "'waveform' (bins x 1: r = the latest ~21 ms of samples, signed -1..1, trigger-aligned and auto-gained) or " +
    "'spectrogram' (bins x 256 ring buffer of spectra over data.history seconds; read it with time -> x through the value output or pt_spectrogram). " +
    'data.bins (texture width: spectrum 64..1024, default 512; waveform 256 | 512 | 1024, default 1024; spectrogram 64..512, default 256; \'auto\' = default), data.scale log | linear, data.smoothing 0 | 0.3 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 (spectrum default 0.6, spectrogram 0.3; \'auto\'), data.history 2 | 4 | 8 s (spectrogram). ' +
    'Outputs: tex, value = the texture at uv (spectrum / waveform: at uv.x; spectrogram: uv.x = time 0 oldest..1 now, uv.y = frequency), head = v coordinate of the newest spectrogram row. ' +
    'Without wiring, GLSL can use the globals u_spectrum, u_waveform, u_spectrogram (bound only when referenced).';

export const AudioNodes = {
    'AudioTexture': {
        category: C,
        displayTitle: 'Audio Texture',
        description: AUDIO_TEXTURE_DESC,
        inputs: [{ name: 'uv', type: 'vec2', default: 'pt_uvStretch()', description: 'Where value samples (default: the frame, 0..1)' }],
        outputs: [
            { name: 'tex', type: 'sampler2D' },
            { name: 'value', type: 'float' },
            { name: 'head', type: 'float' }
        ],
        data: { kind: 'spectrum', bins: 'auto', scale: 'log', smoothing: 'auto', history: 4 }, // 'auto' = the kind's default
        options: AUDIO_TEXTURE_OPTIONS,
        isLibraryNode: true,
        isAudioTextureNode: true,
        audioNote: SPECTROGRAM_NOTE,
        glsl(node, inputValues) {
            const cfg = normalizeAudioTexture(node.data || {});
            const key = audioTextureKey(cfg);
            const v = node.varName;
            const tex = `${v}_tex`;
            const uv = inputValues.uv || 'pt_uvStretch()';
            const lines = [`vec2 ${v}_uv = ${uv};`];
            if (cfg.kind === 'spectrogram') {
                const rate = spectrogramRate(cfg);
                lines.push(`float ${v}_value = pt_spectrogram(${tex}, ${v}_uv, ${cfg.history.toFixed(1)}).r;`);
                lines.push(`float ${v}_head = (mod(floor(u_time * ${rate.toFixed(1)}), ${SPECTROGRAM_ROWS}.0) + 0.5) / ${SPECTROGRAM_ROWS}.0;`);
            } else {
                lines.push(`float ${v}_value = texture(${tex}, vec2(${v}_uv.x, 0.5)).r;`);
                lines.push(`float ${v}_head = 0.5;`);
            }
            const code = lines.join('\n');
            const preamble = collectLibrary(code);
            node.outputVars = { tex, value: `${v}_value`, head: `${v}_head` };
            node.audioTextureKey = key;
            const uniforms = [
                { name: tex, type: 'sampler2D', value: 0, audioTexture: key },
                ...builtinUniformsIn(`${code}\n${preamble}`)
            ];
            return { code, output: tex, preamble: preamble || undefined, uniforms };
        }
    },

    'SpectrumBars': effectNode({
        category: C,
        displayTitle: 'Spectrum Bars',
        description: 'Classic analyser bars from a spectrum texture (default u_spectrum; or an Audio Texture spectrum). uv 0..1 (x = frequency), bars = count, gap = fraction of each bar left empty, height scales the bars, mirror 1 = bars grow up and down from the middle, log 1 = read a linear-scale texture on a log axis (u_spectrum is already log-spaced: keep 0). ' +
            'Outputs: mask (anti-aliased bar body), cap (falling peak-hold caps), level (the bar value 0..1, for colouring), bar (bar centre 0..1). amount scales the bar heights (0 = nothing drawn).',
        inputs: [
            { name: 'uv', type: 'vec2', default: 'pt_uvStretch()' },
            { name: 'tex', type: 'sampler2D', default: 'u_spectrum', description: 'Spectrum texture (Audio Texture.tex; default u_spectrum)' },
            { name: 'bars', type: 'float', default: '48.0' },
            { name: 'gap', type: 'float', default: '0.3' },
            { name: 'height', type: 'float', default: '0.9' },
            { name: 'mirror', type: 'float', default: '0.0' },
            { name: 'log', type: 'float', default: '0.0', description: '1 = log axis for a linear-scale texture' }
        ],
        outputs: [
            { name: 'mask', type: 'float' },
            { name: 'cap', type: 'float' },
            { name: 'level', type: 'float' },
            { name: 'bar', type: 'float' }
        ],
        general: (I, { v }, a) => ({
            code: `vec4 ${v}_b = pt_spectrumBars(${I.tex}, ${I.uv}, ${I.bars}, ${I.gap}, ${I.height}, ${I.mirror}, ${I.log}, ${a});`,
            out: { mask: `${v}_b.x`, cap: `${v}_b.y`, level: `${v}_b.z`, bar: `${v}_b.w` }
        }),
        bypass: () => ({ mask: '0.0', cap: '0.0', level: '0.0' }),
        guard: true
    }),

    'WaveformLine': effectNode({
        category: C,
        displayTitle: 'Waveform Line',
        description: 'Oscilloscope line from a waveform texture (default u_waveform; or an Audio Texture waveform): uv 0..1, center = y of the zero line, gain = amplitude (uv units), thickness = half width (uv-y units; distance to the polyline, so steep parts stay even). ' +
            'Outputs: line (anti-aliased 0..1), glow (soft falloff around it), value (signed sample at uv.x). amount scales the amplitude (0 = nothing drawn).',
        inputs: [
            { name: 'uv', type: 'vec2', default: 'pt_uvStretch()' },
            { name: 'tex', type: 'sampler2D', default: 'u_waveform', description: 'Waveform texture (Audio Texture.tex; default u_waveform)' },
            { name: 'center', type: 'float', default: '0.5' },
            { name: 'gain', type: 'float', default: '0.3' },
            { name: 'thickness', type: 'float', default: '0.004' }
        ],
        outputs: [
            { name: 'line', type: 'float' },
            { name: 'glow', type: 'float' },
            { name: 'value', type: 'float' }
        ],
        general: (I, { v }, a) => ({
            code: `vec3 ${v}_w = pt_waveformLine(${I.tex}, ${I.uv}, ${I.center}, ${I.gain} * ${a}, ${I.thickness});`,
            out: { line: `${v}_w.x`, glow: `${v}_w.y`, value: `${v}_w.z` }
        }),
        bypass: () => ({ line: '0.0', glow: '0.0' }),
        guard: true
    }),

    'CircularSpectrum': effectNode({
        category: C,
        displayTitle: 'Circular Spectrum',
        description: 'Polar spectrum bars around a ring (default u_spectrum). p = centred coordinates (default: aspect-correct, y -1..1), radius = inner ring, height = bar length at level 1, bars, gap, rotation (turns), mirror 1 = lows at the top and highs at the bottom on both sides (symmetric). ' +
            'Outputs: mask (bars), cap (peak caps), level (bar value 0..1), ring (thin inner circle). amount scales the bar lengths (0 = nothing drawn).',
        inputs: [
            { name: 'p', type: 'vec2', default: 'pt_centeredUV()' },
            { name: 'tex', type: 'sampler2D', default: 'u_spectrum', description: 'Spectrum texture (Audio Texture.tex; default u_spectrum)' },
            { name: 'radius', type: 'float', default: '0.4' },
            { name: 'height', type: 'float', default: '0.35' },
            { name: 'bars', type: 'float', default: '96.0' },
            { name: 'gap', type: 'float', default: '0.35' },
            { name: 'rotation', type: 'float', default: '0.0' },
            { name: 'mirror', type: 'float', default: '1.0' }
        ],
        outputs: [
            { name: 'mask', type: 'float' },
            { name: 'cap', type: 'float' },
            { name: 'level', type: 'float' },
            { name: 'ring', type: 'float' }
        ],
        general: (I, { v }, a) => ({
            code: `vec4 ${v}_c = pt_circularSpectrum(${I.tex}, ${I.p}, ${I.radius}, ${I.height}, ${I.bars}, ${I.gap}, ${I.rotation}, ${I.mirror}, ${a});`,
            out: { mask: `${v}_c.x`, cap: `${v}_c.y`, level: `${v}_c.z`, ring: `${v}_c.w` }
        }),
        bypass: () => ({ mask: '0.0', cap: '0.0', level: '0.0', ring: '0.0' }),
        guard: true
    })
};
