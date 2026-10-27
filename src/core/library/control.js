/**
 * Control nodes (library group "Control"): they run once per frame in JavaScript
 * (src/core/control/ControlRuntime.js), can keep state between frames and reach
 * shaders as live uniforms. See src/core/control/rates.js for the rate model.
 *
 * A control node is a libNode (same inputs / generic T / inline fields) with
 * rate: 'control' and a `js(I, ctx)` evaluator instead of GLSL:
 *   I    inputs cast like GLSL would (T broadcast...), events as pulse counts
 *   ctx  { T, node, data, state (persists), dt (s, 0 while paused), time (s),
 *          beat (beat position), u (clock uniforms), frame, scratch (true in
 *          render_preview evaluations: do not schedule side effects) }
 * `post(I, ctx)` (Delay) runs after every other node, so a Delay can close a loop.
 * `options` are enumerated fields shown as click-to-cycle pills on the node.
 *
 * Event values are numbers: pulses this frame (0 on most frames, 1 when fired).
 */
import { libNode } from './define.js';
import { compileExpression } from '../control/expr.js';
import { fract, clamp, map2, mix as lerp } from '../control/vmath.js';

const C = 'control';

/** Deterministic 0..1 hash of a number (LFO random, Random seeds). */
const hash01 = (x) => fract(Math.sin(x * 12.9898 + 78.233) * 43758.5453123);

function mulberry32(a) {
    let t = (a + 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function controlNode(spec) {
    const { options = [], data = {}, post, js, ...rest } = spec;
    const optData = {};
    for (const o of options) optData[o.key] = o.default;
    const def = libNode({
        category: C,
        ...rest,
        data: { ...optData, ...data },
        js,
        body: () => { throw new Error(`${spec.displayTitle || 'this'} node runs at control rate (in JavaScript), not in GLSL`); }
    });
    def.rate = 'control';
    def.isControlNode = true;
    def.inlineInputs = true;
    if (options.length) {
        def.options = options;
        def.hasInputFields = true;
        def.data = { ...(def.data || {}), ...optData, ...data };
    }
    if (typeof post === 'function') {
        // Runs after every other node of the frame (Delay: store this frame's input)
        def.post = (node, values, types, ctx) => post(def.castControlInputs(values, types, ctx.T || 'float'), { ...ctx, node, data: node.data || {} });
    }
    return def;
}

/** Option value (validated against the list). */
const opt = (ctx, key, values, fallback) => {
    const v = String(ctx.data[key] !== undefined ? ctx.data[key] : fallback).trim().toLowerCase();
    return values.includes(v) ? v : fallback;
};

const fired = (e) => (typeof e === 'number' ? e > 0 : !!e);

export const LFO_SHAPES = ['sine', 'tri', 'saw', 'square', 'random'];

export const ControlNodes = {
    'LFO': controlNode({
        displayTitle: 'LFO',
        description: "Low-frequency oscillator at control rate: out 0..1, bipolar -1..1, wrap = an event at the start of each cycle. data.shape sine | tri | saw | square (width = duty cycle) | random (a new random value each cycle). data.unit 'hz' (rate = cycles per second) or 'beats' (rate = cycle length in beats of the beat clock: 1 = every beat, 4 = every bar). phase offsets the cycle (0..1). With an unconnected rate the phase is computed from the clock (deterministic, beat-locked); a connected rate is integrated so modulating it never jumps.",
        inputs: [
            { name: 'rate', type: 'float', default: '1.0', description: 'Hz, or cycle length in beats' },
            { name: 'phase', type: 'float', default: '0.0', description: 'Phase offset 0..1' },
            { name: 'width', type: 'float', default: '0.5', description: 'Square duty cycle 0..1' }
        ],
        outputs: [{ name: 'out', type: 'float' }, { name: 'bipolar', type: 'float' }, { name: 'wrap', type: 'event' }],
        options: [
            { key: 'shape', label: 'shape', values: LFO_SHAPES, default: 'sine' },
            { key: 'unit', label: 'unit', values: ['hz', 'beats'], default: 'hz' }
        ],
        js: (I, ctx) => {
            const S = ctx.state;
            const shape = opt(ctx, 'shape', LFO_SHAPES, 'sine');
            const beats = opt(ctx, 'unit', ['hz', 'beats'], 'hz') === 'beats';
            const rateConnected = !!(ctx.inTypes && ctx.inTypes.rate);
            let cycles;
            if (!rateConnected) {
                cycles = beats ? ctx.beat / Math.max(Math.abs(I.rate), 1e-6) * Math.sign(I.rate || 1) : ctx.time * I.rate;
            } else {
                const dBeat = S.lastBeat === undefined ? 0 : Math.max(0, ctx.beat - S.lastBeat);
                if (S.cycles === undefined) S.cycles = beats ? ctx.beat / Math.max(Math.abs(I.rate), 1e-6) : ctx.time * I.rate;
                S.cycles += beats ? dBeat / Math.max(Math.abs(I.rate), 1e-6) * Math.sign(I.rate || 1) : ctx.dt * I.rate;
                cycles = S.cycles;
            }
            S.lastBeat = ctx.beat;
            const c = cycles + I.phase;
            const f = fract(c);
            const n = Math.floor(c);
            let out;
            switch (shape) {
                case 'tri': out = 1 - Math.abs(2 * f - 1); break;
                case 'saw': out = f; break;
                case 'square': out = f < clamp(I.width, 0, 1) ? 1 : 0; break;
                case 'random': out = hash01(n + 0.5); break;
                default: out = 0.5 + 0.5 * Math.sin(f * Math.PI * 2);
            }
            const wrap = S.lastCycle !== undefined && n !== S.lastCycle ? 1 : 0;
            S.lastCycle = n;
            return { out, bipolar: out * 2 - 1, wrap };
        }
    }),

    'Lag': controlNode({
        displayTitle: 'Lag',
        description: 'Smooths a control signal (float or vector) with separate rise (up) and fall (down) times in seconds: exponential, frame-rate independent (the value covers ~63% of a step in that time). 0 = instant.',
        inputs: [
            { name: 'in', type: 'T', default: '0.0' },
            { name: 'up', type: 'float', default: '0.2', description: 'Rise time (s)' },
            { name: 'down', type: 'float', default: '0.2', description: 'Fall time (s)' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        js: (I, ctx) => {
            const S = ctx.state;
            if (S.y === undefined || (Array.isArray(S.y) !== Array.isArray(I.in)) || (Array.isArray(S.y) && S.y.length !== I.in.length)) {
                S.y = Array.isArray(I.in) ? I.in.slice() : I.in;
                return S.y;
            }
            const k = (x, y) => {
                const tau = x > y ? I.up : I.down;
                if (!(tau > 0)) return x;
                return y + (x - y) * (1 - Math.exp(-ctx.dt / tau));
            };
            S.y = map2(I.in, S.y, k);
            return S.y;
        }
    }),

    'Slew': controlNode({
        displayTitle: 'Slew Limiter',
        description: 'Limits how fast a control signal can change: at most rise units per second upwards and fall units per second downwards (linear glide, per component).',
        inputs: [
            { name: 'in', type: 'T', default: '0.0' },
            { name: 'rise', type: 'float', default: '1.0', description: 'Max rise (units / s)' },
            { name: 'fall', type: 'float', default: '1.0', description: 'Max fall (units / s)' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        js: (I, ctx) => {
            const S = ctx.state;
            if (S.y === undefined || Array.isArray(S.y) !== Array.isArray(I.in) || (Array.isArray(S.y) && S.y.length !== I.in.length)) {
                S.y = Array.isArray(I.in) ? I.in.slice() : I.in;
                return S.y;
            }
            const k = (x, y) => {
                const d = x - y;
                const lim = (d > 0 ? Math.max(I.rise, 0) : Math.max(I.fall, 0)) * ctx.dt;
                return Math.abs(d) <= lim ? x : y + Math.sign(d) * lim;
            };
            S.y = map2(I.in, S.y, k);
            return S.y;
        }
    }),

    'Spring': controlNode({
        displayTitle: 'Spring',
        description: 'A damped spring following its target (float or vector): stiffness pulls towards the target, damping removes energy (critical damping is about 2 * sqrt(stiffness)). Overshoots and wobbles below that. Outputs the position and its velocity.',
        inputs: [
            { name: 'target', type: 'T', default: '0.0' },
            { name: 'stiffness', type: 'float', default: '120.0' },
            { name: 'damping', type: 'float', default: '10.0' }
        ],
        outputs: [{ name: 'out', type: 'T' }, { name: 'velocity', type: 'T' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const vec = Array.isArray(I.target);
            if (S.x === undefined || Array.isArray(S.x) !== vec || (vec && S.x.length !== I.target.length)) {
                S.x = vec ? I.target.slice() : I.target;
                S.v = vec ? I.target.map(() => 0) : 0;
            }
            const k = Math.max(I.stiffness, 0), c = Math.max(I.damping, 0);
            let dt = ctx.dt;
            const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
            const h = dt / steps;
            for (let s = 0; s < steps; s++) {
                if (vec) {
                    for (let i = 0; i < S.x.length; i++) {
                        S.v[i] += (k * (I.target[i] - S.x[i]) - c * S.v[i]) * h;
                        S.x[i] += S.v[i] * h;
                    }
                } else {
                    S.v += (k * (I.target - S.x) - c * S.v) * h;
                    S.x += S.v * h;
                }
            }
            return { out: vec ? S.x.slice() : S.x, velocity: vec ? S.v.slice() : S.v };
        }
    }),

    'Trigger': controlNode({
        displayTitle: 'Trigger',
        description: "Edge detector: fires an event when in crosses threshold. data.edge 'rising' (default), 'falling', 'both' or 'change' (any change of the rounded value, e.g. a step counter). gate = 1 while in >= threshold, count = events so far.",
        inputs: [
            { name: 'in', type: 'float', default: '0.0' },
            { name: 'threshold', type: 'float', default: '0.5' }
        ],
        outputs: [{ name: 'trig', type: 'event' }, { name: 'gate', type: 'float' }, { name: 'count', type: 'float' }],
        options: [{ key: 'edge', label: 'edge', values: ['rising', 'falling', 'both', 'change'], default: 'rising' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const edge = opt(ctx, 'edge', ['rising', 'falling', 'both', 'change'], 'rising');
            const high = I.in >= I.threshold;
            let fire = 0;
            if (S.high !== undefined) {
                if (edge === 'change') fire = Math.round(I.in) !== S.last ? 1 : 0;
                else if (high !== S.high) fire = (edge === 'both' || (edge === 'rising' && high) || (edge === 'falling' && !high)) ? 1 : 0;
            }
            S.high = high;
            S.last = Math.round(I.in);
            S.count = (S.count || 0) + fire;
            return { trig: fire, gate: high ? 1 : 0, count: S.count };
        }
    }),

    'Counter': controlNode({
        displayTitle: 'Counter',
        description: "Counts events: each trig adds step, reset goes back to start. data.mode 'wrap' (count runs start .. start + length - 1 and wraps, e.g. a palette index), 'clamp' (stops at the last value), 'pingpong' (bounces) or 'free' (no limit). wrapped = an event when it wraps around.",
        inputs: [
            { name: 'trig', type: 'event' },
            { name: 'reset', type: 'event' },
            { name: 'step', type: 'float', default: '1.0' },
            { name: 'length', type: 'float', default: '4.0', description: 'Number of values (wrap / clamp / pingpong)' },
            { name: 'start', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'count', type: 'float' }, { name: 'wrapped', type: 'event' }],
        options: [{ key: 'mode', label: 'mode', values: ['wrap', 'clamp', 'pingpong', 'free'], default: 'wrap' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const mode = opt(ctx, 'mode', ['wrap', 'clamp', 'pingpong', 'free'], 'wrap');
            const len = Math.max(1, Math.round(I.length));
            if (S.n === undefined || fired(I.reset)) { S.n = 0; S.dir = 1; }
            let wrapped = 0;
            const pulses = Math.max(0, Math.round(Number(I.trig) || 0));
            for (let p = 0; p < pulses; p++) {
                if (mode === 'pingpong') {
                    if (len === 1) { S.n = 0; continue; }
                    S.n += S.dir * I.step;
                    if (S.n >= len - 1) { S.n = len - 1; S.dir = -1; wrapped = 1; }
                    else if (S.n <= 0) { S.n = 0; S.dir = 1; wrapped = 1; }
                } else {
                    S.n += I.step;
                    if (mode === 'wrap' && (S.n >= len || S.n < 0)) { S.n = ((S.n % len) + len) % len; wrapped = 1; }
                    if (mode === 'clamp') S.n = clamp(S.n, 0, len - 1);
                }
            }
            return { count: I.start + S.n, wrapped };
        }
    }),

    'Timer': controlNode({
        displayTitle: 'Timer',
        description: 'Stopwatch: seconds (and beats of the beat clock) since the last reset event, counting while run > 0.5. Paused with the transport.',
        inputs: [
            { name: 'reset', type: 'event' },
            { name: 'run', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'seconds', type: 'float' }, { name: 'beats', type: 'float' }],
        js: (I, ctx) => {
            const S = ctx.state;
            if (S.t === undefined || fired(I.reset)) { S.t = 0; S.b = 0; }
            const dBeat = S.lastBeat === undefined ? 0 : Math.max(0, ctx.beat - S.lastBeat);
            S.lastBeat = ctx.beat;
            if (I.run > 0.5) { S.t += ctx.dt; S.b += dBeat; }
            return { seconds: S.t, beats: S.b };
        }
    }),

    'SampleHold': controlNode({
        displayTitle: 'Sample & Hold',
        description: 'Holds the value of in (float or vector) from the moment trig fired until it fires again. Before the first event it holds the first value it saw.',
        inputs: [
            { name: 'in', type: 'T', default: '0.0' },
            { name: 'trig', type: 'event' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        js: (I, ctx) => {
            const S = ctx.state;
            if (S.v === undefined || fired(I.trig) || Array.isArray(S.v) !== Array.isArray(I.in)) S.v = Array.isArray(I.in) ? I.in.slice() : I.in;
            return S.v;
        }
    }),

    'Toggle': controlNode({
        displayTitle: 'Toggle',
        description: 'Flip-flop: each trig event flips the state between 0 and 1; reset sets it back to data.initial. Outputs the state (float 0/1) and an event whenever it changes.',
        inputs: [
            { name: 'trig', type: 'event' },
            { name: 'reset', type: 'event' }
        ],
        outputs: [{ name: 'state', type: 'float' }, { name: 'changed', type: 'event' }],
        data: { initial: 0 },
        js: (I, ctx) => {
            const S = ctx.state;
            const init = Number(ctx.data.initial) > 0.5 ? 1 : 0;
            if (S.s === undefined) S.s = init;
            const before = S.s;
            if (fired(I.reset)) S.s = init;
            const pulses = Math.max(0, Math.round(Number(I.trig) || 0));
            if (pulses % 2 === 1) S.s = 1 - S.s;
            return { state: S.s, changed: S.s !== before ? 1 : 0 };
        }
    }),

    'Threshold': controlNode({
        displayTitle: 'Threshold',
        description: 'Schmitt trigger: gate turns on when in rises above high and off only when it falls below low (hysteresis: no chatter on noisy signals such as audio levels). on / off fire an event at each transition.',
        inputs: [
            { name: 'in', type: 'float', default: '0.0' },
            { name: 'high', type: 'float', default: '0.6' },
            { name: 'low', type: 'float', default: '0.4' }
        ],
        outputs: [{ name: 'gate', type: 'float' }, { name: 'on', type: 'event' }, { name: 'off', type: 'event' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const hi = Math.max(I.high, I.low), lo = Math.min(I.high, I.low);
            const was = !!S.on;
            if (!was && I.in > hi) S.on = true;
            else if (was && I.in < lo) S.on = false;
            return { gate: S.on ? 1 : 0, on: !was && S.on ? 1 : 0, off: was && !S.on ? 1 : 0 };
        }
    }),

    'EnvelopeFollower': controlNode({
        displayTitle: 'Envelope Follower',
        description: 'Follows the level of any control signal (absolute value): rises with attack seconds and falls with release seconds (exponential). Turns audio bands into smooth drives, or events (one-frame pulses) into a flash that decays over release.',
        inputs: [
            { name: 'in', type: 'float', default: '0.0' },
            { name: 'attack', type: 'float', default: '0.01' },
            { name: 'release', type: 'float', default: '0.3' }
        ],
        outputs: [{ name: 'env', type: 'float' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const x = Math.abs(I.in);
            if (S.e === undefined) S.e = x;
            const tau = x > S.e ? I.attack : I.release;
            S.e = tau > 0 ? S.e + (x - S.e) * (1 - Math.exp(-ctx.dt / tau)) : x;
            return S.e;
        }
    }),

    'RandomValue': controlNode({
        displayTitle: 'Random (control)',
        description: "Seeded random values in [min, max]: a new value on every trig event and/or rate times per second (0 = only on events). Same seed = same sequence after a reset. data.mode 'step' (jumps) or 'smooth' (glides to the next value over the interval).",
        inputs: [
            { name: 'trig', type: 'event' },
            { name: 'rate', type: 'float', default: '0.0', description: 'New values per second (0 = events only)' },
            { name: 'min', type: 'float', default: '0.0' },
            { name: 'max', type: 'float', default: '1.0' },
            { name: 'seed', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'out', type: 'float' }, { name: 'changed', type: 'event' }],
        options: [{ key: 'mode', label: 'mode', values: ['step', 'smooth'], default: 'step' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const smooth = opt(ctx, 'mode', ['step', 'smooth'], 'step') === 'smooth';
            if (S.seed !== I.seed || S.i === undefined) {
                S.seed = I.seed;
                S.i = 0;
                S.t = 0;
                S.prev = S.cur = mulberry32(Math.round(I.seed * 1000) * 7919);
            }
            let changed = 0;
            const next = () => {
                S.i++;
                S.prev = smooth ? S.prev + (S.cur - S.prev) * clamp(S.t * Math.max(I.rate, 0), 0, 1) : S.cur;
                S.cur = mulberry32(Math.round(S.seed * 1000) * 7919 + S.i * 104729);
                S.t = 0;
                changed = 1;
            };
            if (fired(I.trig)) next();
            S.t += ctx.dt;
            if (I.rate > 0 && S.t >= 1 / I.rate) next();
            let v = S.cur;
            if (smooth) {
                const k = I.rate > 0 ? clamp(S.t * I.rate, 0, 1) : 1;
                v = lerp(S.prev, S.cur, k * k * (3 - 2 * k));
            }
            return { out: I.min + (I.max - I.min) * v, changed };
        }
    }),

    'Delay': controlNode((() => {
        // Time went backwards (export from start, set_time, a seek): entries "from the future"
        // would freeze the output until they age out, so drop them. A new array: scratch
        // evaluations (render_preview) share the live buffer through a shallow state copy.
        const sinceNow = (S, time) => {
            const buf = S.buf;
            if (!buf) return (S.buf = []);
            if (buf.length && buf[buf.length - 1].t > time + 1e-6) return (S.buf = buf.filter(e => e.t <= time));
            return buf;
        };
        return {
        displayTitle: 'Delay',
        description: "Delays a control signal (float or vector) by amount frames or seconds (data.unit 'frames' | 'seconds', up to 600 frames / 10 s). Because the output is from the past, a Delay may close a control loop (feedback over time): connect a node's output back into its own inputs through it.",
        inputs: [
            { name: 'in', type: 'T', default: '0.0' },
            { name: 'amount', type: 'float', default: '1.0', description: 'Frames or seconds' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        options: [{ key: 'unit', label: 'unit', values: ['frames', 'seconds'], default: 'frames' }],
        delayed: 'in',
        js: (I, ctx) => {
            // Output phase: read from the past (the input of this frame is stored in post)
            const S = ctx.state;
            const buf = sinceNow(S, ctx.time);
            const seconds = opt(ctx, 'unit', ['frames', 'seconds'], 'frames') === 'seconds';
            const amount = Math.max(0, Number(I.amount) || 0);
            if (!buf.length) return S.last !== undefined ? S.last : I.in;
            if (seconds) {
                const t = ctx.time - amount;
                let v = buf[0].v;
                for (const e of buf) { if (e.t <= t) v = e.v; else break; }
                return v;
            }
            const n = Math.min(Math.round(amount), buf.length);
            return n <= 0 ? buf[buf.length - 1].v : buf[buf.length - n].v;
        },
        post: (I, ctx) => {
            const S = ctx.state;
            const buf = sinceNow(S, ctx.time);
            if (ctx.dt > 0 || !buf.length) buf.push({ t: ctx.time, v: Array.isArray(I.in) ? I.in.slice() : I.in });
            S.last = I.in;
            const seconds = opt(ctx, 'unit', ['frames', 'seconds'], 'frames') === 'seconds';
            if (seconds) { while (buf.length > 2 && buf[1].t < ctx.time - 10) buf.shift(); while (buf.length > 1200) buf.shift(); }
            else while (buf.length > 601) buf.shift();
        }
    }; })()),

    'Gate': controlNode({
        displayTitle: 'Gate',
        description: "Passes in while open > 0.5. When closed: data.closed 'hold' keeps the last passed value, 'zero' outputs 0.",
        inputs: [
            { name: 'in', type: 'T', default: '0.0' },
            { name: 'open', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        options: [{ key: 'closed', label: 'closed', values: ['hold', 'zero'], default: 'hold' }],
        js: (I, ctx) => {
            const S = ctx.state;
            if (I.open > 0.5 || S.v === undefined) S.v = Array.isArray(I.in) ? I.in.slice() : I.in;
            if (I.open > 0.5) return S.v;
            if (opt(ctx, 'closed', ['hold', 'zero'], 'hold') === 'zero') return Array.isArray(I.in) ? I.in.map(() => 0) : 0;
            return S.v;
        }
    }),

    'SelectIndex': controlNode({
        displayTitle: 'Select (index)',
        description: "Switch: outputs input number round(index) of 0..3 (floats or vectors; e.g. a Counter picking a palette color). data.overflow 'wrap' (index mod count) or 'clamp'. data.count = how many inputs are used (2-4).",
        inputs: [
            { name: 'index', type: 'float', default: '0.0' },
            { name: '0', type: 'T', default: '0.0' },
            { name: '1', type: 'T', default: '0.0' },
            { name: '2', type: 'T', default: '0.0' },
            { name: '3', type: 'T', default: '0.0' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        data: { count: 4 },
        options: [{ key: 'overflow', label: 'overflow', values: ['wrap', 'clamp'], default: 'wrap' }],
        js: (I, ctx) => {
            const n = clamp(Math.round(Number(ctx.data.count) || 4), 1, 4);
            let i = Math.round(I.index);
            i = opt(ctx, 'overflow', ['wrap', 'clamp'], 'wrap') === 'clamp' ? clamp(i, 0, n - 1) : ((i % n) + n) % n;
            return I[String(i)];
        }
    }),

    'MathExpression': controlNode({
        displayTitle: 'Math Expression',
        description: 'Evaluates data.expr every frame with inputs a, b, c, d and t (seconds), dt, beat (beat position), phase (beat phase), bpm, pi, tau, e. Operators + - * / % (GLSL mod) ^ (power), comparisons (1 / 0), && || !, c ? x : y; functions sin cos tan asin acos atan atan2 abs sign floor ceil round fract sqrt exp log log2 pow min max clamp mix step smoothstep mod hypot noise hash. A small safe language: no JavaScript is evaluated.',
        inputs: [
            { name: 'a', type: 'float', default: '0.0' },
            { name: 'b', type: 'float', default: '0.0' },
            { name: 'c', type: 'float', default: '0.0' },
            { name: 'd', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'out', type: 'float' }],
        textFields: [{ key: 'expr', label: 'expr', default: 'a + b * sin(t * 2)' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const src = String(ctx.data.expr ?? '');
            if (S.src !== src) {
                S.src = src;
                S.err = null;
                try { S.fn = compileExpression(src, ['a', 'b', 'c', 'd', 't', 'dt', 'beat', 'phase', 'bpm']).fn; } catch (e) { S.fn = null; S.err = e.message; }
            }
            if (!S.fn) throw new Error(`expr: ${S.err}`);
            const v = S.fn({ a: I.a, b: I.b, c: I.c, d: I.d, t: ctx.time, dt: ctx.dt, beat: ctx.beat, phase: ctx.u.beatPhase, bpm: ctx.u.bpm });
            return Number.isFinite(v) ? v : 0;
        }
    }),

    'BeatDivider': controlNode({
        displayTitle: 'Beat Divider',
        description: 'Fires an event every N beats of the beat clock (every = 1: each beat, 4: each bar, 0.5: eighth notes), offset in beats. phase = 0..1 progress through the current division, index = how many divisions have passed. Follows tap tempo, the metronome and detected beats (the stable published clock); silent while paused. unsure = hold (default): no events while the beat clock is unsure (u_beatTrust < 0.5, e.g. right after a track change, while it coasts on the old tempo and glides to the new one); fire: always.',
        inputs: [
            { name: 'every', type: 'float', default: '1.0', description: 'Beats per event' },
            { name: 'offset', type: 'float', default: '0.0', description: 'Offset (beats)' }
        ],
        outputs: [{ name: 'beat', type: 'event' }, { name: 'phase', type: 'float' }, { name: 'index', type: 'float' }],
        options: [{ key: 'unsure', label: 'unsure', values: ['hold', 'fire'], default: 'hold' }],
        js: (I, ctx) => {
            // Fires when the beat passes a division boundary it has not passed before.
            // S.top = the furthest beat position reached: a tap snaps the beat back by up to
            // half a beat, and the boundary it re-crosses must not fire a second time. A jump
            // back of more than a beat (export from start, set_time, a new tap sequence) starts over.
            // Comparing positions (not indices) also keeps a change of every / offset from firing.
            const S = ctx.state;
            const n = Math.max(Math.abs(I.every), 1e-3);
            const beat = ctx.beat;
            const x = (beat - I.offset) / n;
            const idx = Math.floor(x);
            let fire = 0;
            if (S.top === undefined || !Number.isFinite(S.top) || beat < S.top - 1) {
                S.top = beat;
            } else if (beat > S.top) {
                if (ctx.dt > 0 && idx > Math.floor((S.top - I.offset) / n)) fire = 1;
                S.top = beat;
                // unsure = hold: a boundary passed while the clock is unsure is skipped (no backlog)
                const trust = ctx.u && Number.isFinite(ctx.u.trust) ? ctx.u.trust : 1;
                if (fire && trust < 0.5 && opt(ctx, 'unsure', ['hold', 'fire'], 'hold') === 'hold') fire = 0;
            }
            return { beat: fire, phase: x - idx, index: idx };
        }
    }),

    // ---- GPU -> control ----

    'Sample': (() => {
        const def = controlNode({
            displayTitle: 'Sample',
            description: "Reads a pixel-rate value (any float / vec2 / vec3 / vec4 sub-graph) at one uv point back to the CPU, as a control-rate value: value (vec4; missing components 0, alpha 1) and x (its first component). Evaluated by the debug-probe readback (src/rendering/ProbeRenderer.js) every frame, asynchronously: the value is one frame late. uv (control rate, 0..1, origin bottom-left) picks the point; resolution = the canvas background / largest Preview. Use it to drive control nodes (Threshold, Counter, SceneSwitcher...) from what a shader computes, e.g. the brightness of the frame center.",
            inputs: [
                { name: 'in', type: 'any', rate: 'pixel', description: 'Pixel-rate value to read back' },
                { name: 'uv', type: 'vec2', default: 'vec2(0.5, 0.5)', description: 'Sample point (0..1)' }
            ],
            outputs: [{ name: 'value', type: 'vec4' }, { name: 'x', type: 'float' }],
            js: (I, ctx) => {
                const node = ctx.node;
                if (!ctx.scratch) node._sampleUV = Array.isArray(I.uv) ? I.uv.slice(0, 2) : [0.5, 0.5];
                if (node._probeStatus === 'error') throw new Error(`sample: ${node._probeError || 'input does not compile'}`);
                if (node._probeStatus === 'none') throw new Error('connect a pixel value to sample');
                const v = node._sampleRGBA || [0, 0, 0, 0];
                return { value: [v[0], v[1], v[2], v[3]], x: v[0] };
            }
        });
        def.isProbeNode = true;
        def.isSampleNode = true;
        def.probeKind = 'point';
        def.probeView = 'sample';
        return def;
    })(),

    // ---- Non-GLSL values: strings and lists, and their conversions to textures ----

    'TextPick': controlNode({
        displayTitle: 'Text Pick',
        description: 'Picks item round(index) (wrapping) of data.items, a list of words or lines separated by "|" or new lines; outputs it as a string (control-only) plus the item count. Feed a Counter or Beat Divider index for beat lyrics, then a Text Texture to draw it.',
        inputs: [{ name: 'index', type: 'float', default: '0.0' }],
        outputs: [{ name: 'text', type: 'string' }, { name: 'count', type: 'float' }],
        textFields: [{ key: 'items', label: 'items', default: 'FEEL|THE|BEAT' }],
        js: (I, ctx) => {
            const items = String(ctx.data.items ?? '').split(/\||\n/).map(s => s.trim()).filter(Boolean);
            if (!items.length) return { text: '', count: 0 };
            const i = ((Math.round(I.index) % items.length) + items.length) % items.length;
            return { text: items[i], count: items.length };
        }
    }),

    'NumberList': controlNode({
        displayTitle: 'Number List',
        description: 'A list of numbers (data.values, separated by commas or spaces) as a control-only list value, plus its length. Combine with List Texture to read it in GLSL, or JS nodes (inputs.<name> is an array).',
        inputs: [],
        outputs: [{ name: 'list', type: 'list' }, { name: 'length', type: 'float' }],
        textFields: [{ key: 'values', label: 'values', default: '0, 0.25, 0.5, 1' }],
        js: (I, ctx) => {
            const S = ctx.state;
            const src = String(ctx.data.values ?? '');
            if (S.src !== src) {
                S.src = src;
                S.list = src.split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite);
            }
            return { list: S.list, length: S.list.length };
        }
    }),

    'TextTexture': controlNode({
        displayTitle: 'Text Texture',
        description: "Draws a string (control-only, e.g. from Text Pick, a text Param or a JS node) into a canvas texture: white text on transparent black, centered (sample it with TextureSample; .r / .a is the ink). Redrawn and uploaded only when the text or style changes. data.width / data.height (pixels), data.font (CSS font family), data.weight, size = font size relative to the height (0..1).",
        inputs: [
            { name: 'text', type: 'string', default: '' },
            { name: 'size', type: 'float', default: '0.6' }
        ],
        outputs: [{ name: 'tex', type: 'sampler2D' }],
        data: { width: 512, height: 256, font: 'sans-serif', weight: 'bold' },
        isTextureControl: true,
        js: (I, ctx) => {
            const S = ctx.state;
            const d = ctx.data;
            const w = clamp(Math.round(Number(d.width) || 512), 8, 2048);
            const h = clamp(Math.round(Number(d.height) || 256), 8, 2048);
            const key = `${I.text}\u0000${I.size}\u0000${w}x${h}\u0000${d.font}\u0000${d.weight}`;
            if (!S.canvas || S.canvas.width !== w || S.canvas.height !== h) {
                S.canvas = ctx.makeCanvas ? ctx.makeCanvas(w, h) : null;
                S.key = null;
            }
            if (S.canvas && S.key !== key && !ctx.scratch) {
                S.key = key;
                const g = S.canvas.getContext('2d');
                g.clearRect(0, 0, w, h);
                g.fillStyle = '#ffffff';
                const px = Math.max(4, Math.round(h * clamp(I.size, 0.05, 1)));
                g.font = `${String(d.weight || 'bold')} ${px}px ${String(d.font || 'sans-serif')}`;
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                let text = String(I.text ?? '');
                // Shrink to fit the width
                const m = g.measureText(text).width;
                if (m > w * 0.94) g.font = `${String(d.weight || 'bold')} ${Math.max(4, Math.floor(px * w * 0.94 / m))}px ${String(d.font || 'sans-serif')}`;
                g.fillText(text, w / 2, h * 0.53);
                S.canvas.dirty = true;
            }
            return { tex: S.canvas ? { kind: 'canvas', source: S.canvas, filter: 'linear', wrap: 'clamp' } : null };
        }
    }),

    'ListTexture': controlNode({
        displayTitle: 'List Texture',
        description: 'Uploads a list of numbers (control-only) as a data texture N x 1 (RGBA32F, NEAREST; value i is texel (i, 0) in the red channel: texelFetch(tex, ivec2(i, 0), 0).r). Re-uploaded only when the list changes. count = the list length (pass it to your GLSL loop).',
        inputs: [{ name: 'list', type: 'list', default: '' }],
        outputs: [{ name: 'tex', type: 'sampler2D' }, { name: 'count', type: 'float' }],
        isTextureControl: true,
        js: (I, ctx) => {
            const S = ctx.state;
            const list = Array.isArray(I.list) ? I.list : [];
            const n = Math.max(1, list.length);
            const same = S.data && S.data.length === n && list.every((v, i) => S.data[i] === (+v || 0));
            if (!same) {
                S.data = new Float32Array(n);
                list.forEach((v, i) => { S.data[i] = +v || 0; });
                S.version = (S.version || 0) + 1;
            }
            return { tex: { kind: 'data', data: S.data, width: n, height: 1, channels: 1, version: S.version }, count: list.length };
        }
    })
};

export { hash01 };
