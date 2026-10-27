import { libNode } from './define.js';
import { beatGate, beatGateGLSL } from '../Clock.js';

// ---- Beat node options (clock: stable | raw, gate: fade | hold | off) ----

export const BEAT_OPTIONS = [
    { key: 'clock', label: 'clock', values: ['stable', 'raw'], default: 'stable' },
    { key: 'gate', label: 'gate', values: ['fade', 'hold', 'off'], default: 'fade' }
];

/** Validated Beat option value. */
export function beatOption(data, key) {
    const o = BEAT_OPTIONS.find(x => x.key === key);
    const v = String((data && data[key]) ?? o.default).trim().toLowerCase();
    return o.values.includes(v) ? v : o.default;
}

/** BeatEnvelope: gated when gate is not 'off' and its phase is the built-in beat phase. */
function envelopeGated(data, phaseConnected) {
    return !phaseConnected && String((data && data.gate) ?? 'fade').trim().toLowerCase() !== 'off';
}

const node_gate = (I) => beatGateGLSL('u_beatTrust', I.threshold);

const easeOutCubic = (p) => { const q = 1 - p; return 1 - q * q * q; };

/**
 * Beat outputs (JS, control rate). hold keeps its own beat position in ctx.state: it stops
 * while trust < threshold, and once trusted again catches up with the live clock by
 * bending its rate (to the nearest bar alignment, never backwards, never a jump).
 */
function beatOutputs(I, ctx) {
    const u = ctx.u;
    const raw = beatOption(ctx.data, 'clock') === 'raw';
    const gate = beatOption(ctx.data, 'gate');
    const trust = Number.isFinite(u.trust) ? u.trust : 1;
    const decay = Math.max(I.decay, 0);
    let phase, bar, count, bpm, time;
    if (raw) {
        const r = Array.isArray(u.raw) ? u.raw : [u.beatPhase, u.barPhase, u.beatCount, u.bpm];
        phase = r[0]; bar = r[1]; count = r[2]; bpm = r[3]; time = count + easeOutCubic(phase);
    } else {
        phase = u.beatPhase; bar = u.barPhase; count = u.beatCount; bpm = u.bpm; time = u.beatTime;
    }
    const g = trust < 1 ? beatGate(trust, I.threshold) : 1;
    let pulse = Math.exp(-phase * decay);
    if (gate === 'fade') {
        if (g < 1) pulse *= g;
    } else if (gate === 'hold' && !ctx.scratch) {
        // (render_preview evaluations, ctx.scratch, show the pinned clock as is)
        const S = ctx.state || {};
        const P = count + phase;
        const thr = Math.min(Number.isFinite(I.threshold) ? I.threshold : 0.5, 1);
        const certain = thr <= 0 || trust >= thr;
        if (!Number.isFinite(S.pos) || !Number.isFinite(S.lastP) || P < S.lastP - 1 || P > S.lastP + 8) {
            S.pos = P; // start, or the clock jumped (export from the start, set_time, render_preview)
            S.bpm = bpm;
        } else if (certain) {
            const dP = Math.max(0, P - S.lastP);
            let e = P - (S.pos + dP); // error after this frame's advance
            const k = 4 * Math.round(e / 4);
            e -= k; // to the nearest bar alignment
            if (Math.abs(e) < 1e-3) S.pos = P - k;
            else S.pos += dP * (1 + Math.min(Math.max(e, -0.5), 1));
            S.bpm = bpm;
        }
        S.lastP = P;
        if (S.pos !== P) {
            count = Math.floor(S.pos);
            phase = S.pos - count;
            bar = ((((count % 4) + 4) % 4) + phase) / 4;
            time = count + easeOutCubic(phase);
            pulse = Math.exp(-phase * decay);
        }
        if (Number.isFinite(S.bpm)) bpm = S.bpm;
    }
    return { pulse, phase, bar, count, bpm, time: time * I.rate, confidence: u.confidence, gate: g };
}

/**
 * Live input sources driven from JavaScript (keyboard, XY pad, MIDI notes).
 *
 * Each node exposes a single uniform named exactly like its compiled variable
 * (node_N). CompilationManager registers it in the UniformRegistry under that
 * name, and the node class pushes new values into the registry whenever its
 * state changes, so previews update without recompiling.
 */

function liveUniform(node, type, fallback) {
    const value = typeof node.getUniformValue === 'function' ? node.getUniformValue() : fallback;
    return { name: node.varName, type, value: Array.isArray(value) ? [...value] : value };
}

export const SourceNodes = {
    'Keyboard': {
        category: 'source',
        description: 'Keyboard key state for data.key (KeyboardEvent.key or .code, e.g. " "/"Space", "a", "ArrowUp"): down = 1 while held, toggle flips 0/1 on each press. Click the key label, then press a key to change it.',
        inputs: [],
        outputs: [
            { name: 'down', type: 'float' },
            { name: 'toggle', type: 'float' }
        ],
        data: { key: 'Space' },
        isKeyboardNode: true,
        glsl: (node) => {
            const v = node.varName;
            node.outputVars = { down: `${v}.x`, toggle: `${v}.y` };
            return { code: '', output: `${v}.x`, uniforms: [liveUniform(node, 'vec2', [0, 0])] };
        }
    },

    'XYPad': {
        category: 'source',
        description: 'Draggable 2D pad: xy (0..1 each, origin bottom-left), x and y. Values are stored in data.x / data.y.',
        inputs: [],
        outputs: [
            { name: 'xy', type: 'vec2' },
            { name: 'x', type: 'float' },
            { name: 'y', type: 'float' }
        ],
        data: { x: 0.5, y: 0.5 },
        isXYPadNode: true,
        glsl: (node) => {
            const v = node.varName;
            node.outputVars = { xy: v, x: `${v}.x`, y: `${v}.y` };
            const x = Number.isFinite(node.data.x) ? node.data.x : 0.5;
            const y = Number.isFinite(node.data.y) ? node.data.y : 0.5;
            return { code: '', output: v, uniforms: [liveUniform(node, 'vec2', [x, y])] };
        }
    },

    'MidiNote': {
        category: 'source',
        description: 'MIDI note input: gate = 1 while a matching note is held, velocity 0..1 of the last note-on, note = last MIDI note number (0..127), pitch = note / 127. data.channel 0 = any channel, data.note -1 = any note.',
        inputs: [],
        outputs: [
            { name: 'gate', type: 'float' },
            { name: 'velocity', type: 'float' },
            { name: 'note', type: 'float' },
            { name: 'pitch', type: 'float' }
        ],
        data: { channel: 0, note: -1 },
        isMidiNoteNode: true,
        glsl: (node) => {
            const v = node.varName;
            node.outputVars = { gate: `${v}.x`, velocity: `${v}.y`, note: `${v}.z`, pitch: `(${v}.z / 127.0)` };
            return { code: '', output: `${v}.x`, uniforms: [liveUniform(node, 'vec3', [0, 0, 0])] };
        }
    },

    // ---- Music: global audio / beat uniforms from the AudioEngine + Clock (top bar audio source) ----

    'Audio': libNode({
        category: 'source',
        description: 'Music analysis of the top-bar audio source (mic, file, tab audio or metronome): level, bass, mid, high are auto-gained 0..1, kick jumps to 1 on each kick drum and decays. Same values as u_level, u_bass, u_mid, u_high, u_kick.',
        inputs: [],
        outputs: [
            { name: 'level', type: 'float' },
            { name: 'bass', type: 'float' },
            { name: 'mid', type: 'float' },
            { name: 'high', type: 'float' },
            { name: 'kick', type: 'float' }
        ],
        isAudioNode: true,
        cpuSource: true, // control rate: the values come from the CPU clock / audio engine
        body: () => ({ out: { level: 'u_level', bass: 'u_bass', mid: 'u_mid', high: 'u_high', kick: 'u_kick' } }),
        js: (I, { u }) => ({ level: u.level, bass: u.bass, mid: u.mid, high: u.high, kick: u.kick })
    }),

    'Beat': libNode({
        category: 'source',
        description: 'Beat clock (detected from music, tap tempo or metronome): pulse = exp(-phase * decay) is 1 on each beat, phase 0..1 within the beat, bar 0..1 over 4 beats, count = beat number, bpm, time = beat-locked time in beats (eased on each beat) * rate, a drop-in for Time. confidence (u_beatConfidence) = how sure the tracker is: 0 no beat / coasting, ~0.5 tentative, ~1 locked; 1 with the metronome or tapped tempo, 0 with audio off. gate = certainty gate 0..1: a smoothstep of u_beatTrust (how far the published clock can be relied on) around threshold; 0 while the clock coasts on an untrusted estimate (a new track) or glides onto the new tempo, 1 when locked and always without live audio. Options: clock = stable (default: the published clock, which coasts through uncertainty and glides to a new tempo without jumps) or raw (the tracker\'s live estimate, for diagnostics); gate = fade (default: pulse x a smoothstep of trust around threshold), hold (every output freezes while trust < threshold, then catches up smoothly) or off. pulse already includes the gate (fade); multiply other beat-driven effects (phase, bar, count...) by gate, and every beat effect by confidence to switch it off with audio off.',
        inputs: [
            { name: 'decay', type: 'float', default: '6.0', description: 'How fast pulse falls after each beat' },
            { name: 'rate', type: 'float', default: '1.0', description: 'Scales time (0.25 = one unit per bar)' },
            { name: 'threshold', type: 'float', default: '0.5', description: 'Certainty (trust) where the gate acts: fade = half pulse here (0 at threshold - 0.25, full at + 0.25), hold = frozen below it; 0 = never gate' }
        ],
        outputs: [
            { name: 'pulse', type: 'float' },
            { name: 'phase', type: 'float' },
            { name: 'bar', type: 'float' },
            { name: 'count', type: 'float' },
            { name: 'bpm', type: 'float' },
            { name: 'time', type: 'float' },
            { name: 'confidence', type: 'float' },
            { name: 'gate', type: 'float' }
        ],
        optionPills: BEAT_OPTIONS,
        data: { clock: 'stable', gate: 'fade' },
        isBeatNode: true,
        cpuSource: true, // control rate: the beat clock lives on the CPU (src/core/Clock.js)
        js: (I, ctx) => beatOutputs(I, ctx),
        body: (I, ctx) => {
            const raw = beatOption(ctx.data, 'clock') === 'raw';
            const gate = beatOption(ctx.data, 'gate');
            if (gate === 'hold' && ctx.compiler && ctx.compiler.addWarning) {
                ctx.compiler.addWarning('Beat: gate "hold" needs the node to run at control rate (decay / rate / threshold CPU values); in GLSL it fades instead');
            }
            const ph = raw ? 'u_beatRaw.x' : 'u_beatPhase';
            let pulse = `exp(-${ph} * max(${I.decay}, 0.0))`;
            if (gate !== 'off') pulse = `(${pulse} * ${node_gate(I)})`;
            return {
                out: {
                    pulse,
                    phase: ph,
                    bar: raw ? 'u_beatRaw.y' : 'u_barPhase',
                    count: raw ? 'u_beatRaw.z' : 'u_beatCount',
                    bpm: raw ? 'u_beatRaw.w' : 'u_bpm',
                    time: raw ? `(u_beatRaw.z + 1.0 - pow(1.0 - u_beatRaw.x, 3.0)) * ${I.rate}` : `u_beatTime * ${I.rate}`,
                    confidence: 'u_beatConfidence',
                    gate: node_gate(I)
                }
            };
        }
    }),

    'BeatEnvelope': libNode({
        category: 'source',
        description: 'Envelope 0..1 over a phase (default: the beat phase). data.shape: exp (decay exp(-phase*k)), ad (short attack then decay), pump (sidechain duck: 0 on the beat, smoothstep back up), saw (1 - phase) or sine. k sets the sharpness. gate = fade (default): on the built-in beat phase (phase unconnected) the envelope fades with u_beatTrust while the beat clock is uncertain (pump fades to 1 = no ducking, the others to 0); off = never. A connected phase is never gated.',
        inputs: [
            { name: 'phase', type: 'float', default: 'u_beatPhase', description: 'Phase 0..1 (Beat.phase, Beat.bar, fract(x)...)' },
            { name: 'k', type: 'float', default: '6.0', description: 'Sharpness: decay rate / pump release' }
        ],
        outputs: [{ name: 'env', type: 'float' }],
        textFields: [{ key: 'shape', label: 'shape', default: 'exp' }],
        optionPills: [{ key: 'gate', label: 'gate', values: ['fade', 'off'], default: 'fade' }],
        data: { gate: 'fade' },
        body: (I, ctx) => {
            const p = `clamp(${I.phase}, 0.0, 1.0)`;
            const k = `max(${I.k}, 0.001)`;
            const shape = String(ctx.data.shape || 'exp').trim().toLowerCase();
            const shapes = {
                exp: `exp(-${p} * ${k})`,
                ad: `smoothstep(0.0, 0.04, ${p}) * exp(-max(${p} - 0.04, 0.0) * ${k})`,
                pump: `smoothstep(0.0, clamp(3.0 / ${k}, 0.05, 1.0), ${p})`,
                saw: `1.0 - ${p}`,
                sine: `0.5 + 0.5 * cos(${p} * 6.28318531)`
            };
            if (!shapes[shape] && ctx.compiler && ctx.compiler.addWarning) {
                ctx.compiler.addWarning(`BeatEnvelope: unknown shape "${shape}" (use exp, ad, pump, saw or sine)`);
            }
            let env = shapes[shape] || shapes.exp;
            if (envelopeGated(ctx.data, !!(ctx.types && ctx.types.phase))) {
                const g = beatGateGLSL('u_beatTrust');
                env = shape === 'pump' ? `(1.0 - (1.0 - ${env}) * ${g})` : `(${env} * ${g})`;
            }
            return { out: { env } };
        },
        cpuSource: true, // default phase = the CPU beat clock
        js: (I, ctx) => {
            const p = Math.min(Math.max(I.phase, 0), 1);
            const k = Math.max(I.k, 0.001);
            const ss = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
            const shape = String(ctx.data.shape || 'exp').trim().toLowerCase();
            let env;
            switch (shape) {
                case 'ad': env = ss(0, 0.04, p) * Math.exp(-Math.max(p - 0.04, 0) * k); break;
                case 'pump': env = ss(0, Math.min(Math.max(3 / k, 0.05), 1), p); break;
                case 'saw': env = 1 - p; break;
                case 'sine': env = 0.5 + 0.5 * Math.cos(p * 6.28318531); break;
                default: env = Math.exp(-p * k);
            }
            const trust = ctx.u && Number.isFinite(ctx.u.trust) ? ctx.u.trust : 1;
            if (trust < 1 && envelopeGated(ctx.data, !!(ctx.inTypes && ctx.inTypes.phase))) {
                const g = beatGate(trust);
                env = shape === 'pump' ? 1 - (1 - env) * g : env * g;
            }
            return env;
        }
    })
};
