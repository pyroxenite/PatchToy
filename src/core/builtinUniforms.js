/**
 * Built-in uniforms every shader can use without wiring a node.
 *
 * The ShaderCompiler declares one of these only when the generated code
 * (node code, custom GLSL functions, library functions) references it, and the
 * renderers (ShaderPreview, FeedbackRenderer, BackgroundRenderer) set the
 * values every frame from the global clock (src/core/Clock.js).
 */
import { BUILTIN_AUDIO_TEXTURES } from './audioTextureConfig.js';

export const BUILTIN_UNIFORM_TYPES = {
    u_time: 'float',
    u_resolution: 'vec2',
    u_mouse: 'vec2',
    u_camera: 'sampler2D',
    // Audio analysis (AudioEngine): auto-gained 0..1 levels and a kick envelope
    u_level: 'float',
    u_bass: 'float',
    u_lowMid: 'float',
    u_mid: 'float',
    u_high: 'float',
    u_kick: 'float',
    // Beat clock (tracker, tap tempo or metronome). The published, stable clock: while the
    // tracker's estimate is untrusted it coasts, then glides to the new tempo (Clock.js)
    u_beat: 'float',        // 1 on each beat, decays; fades with u_beatTrust
    u_beatPhase: 'float',   // 0..1 within the beat
    u_barPhase: 'float',    // 0..1 over 4 beats
    u_beatCount: 'float',   // integer beat counter
    u_bpm: 'float',         // tempo (smoothed: glides with tempo changes)
    u_beatTime: 'float',    // beatCount + eased beatPhase: a beat-locked "time"
    u_beatConfidence: 'float', // 0..1 how sure the beat tracker is (1 with the metronome / taps)
    u_beatTrust: 'float',   // 0..1 how far the published clock can be relied on (1 without live audio)
    u_beatRaw: 'vec4',      // the tracker's live (raw) clock: phase, bar phase, count, bpm (diagnostics)
    // Audio textures (src/services/AudioTextures.js, see core/audioTextureConfig.js)
    u_spectrum: 'sampler2D',    // 512 x 1: r = log-frequency magnitude 0..1, g = peak hold
    u_waveform: 'sampler2D',    // 1024 x 1: r = signed samples -1..1
    u_spectrogram: 'sampler2D'  // 256 x 256 ring buffer (4 s, 64 rows/s): time -> v
};

/** Uniforms driven by the clock / audio engine (everything except resolution, mouse, camera). */
export const CLOCK_UNIFORMS = [
    'u_time', 'u_level', 'u_bass', 'u_lowMid', 'u_mid', 'u_high', 'u_kick',
    'u_beat', 'u_beatPhase', 'u_barPhase', 'u_beatCount', 'u_bpm', 'u_beatTime', 'u_beatConfidence',
    'u_beatTrust', 'u_beatRaw'
];

/**
 * The compiler's uniform entry for a built-in: the name (string) for clock / screen
 * built-ins, an object uniform for the audio texture samplers so the renderers bind
 * them through the same path as JS / Feedback textures (FeedbackRenderer.injectFeedbackTextures).
 */
export function builtinUniformEntry(name) {
    const key = BUILTIN_AUDIO_TEXTURES[name];
    return key ? { name, type: 'sampler2D', value: 0, audioTexture: key } : name;
}

const PATTERN = new RegExp(`\\b(${Object.keys(BUILTIN_UNIFORM_TYPES).join('|')})\\b`, 'g');

/** Names of the built-in uniforms referenced in a piece of GLSL. */
export function builtinUniformsIn(code) {
    const found = new Set();
    if (!code) return [];
    for (const m of String(code).matchAll(PATTERN)) found.add(m[1]);
    return [...found];
}

/** `uniform float u_time;` style declaration for a built-in (null if unknown). */
export function builtinDeclaration(name) {
    const type = BUILTIN_UNIFORM_TYPES[name];
    return type ? `uniform ${type} ${name};` : null;
}
