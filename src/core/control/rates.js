/**
 * Signal rates: which values are computed per pixel on the GPU and which once
 * per frame on the CPU.
 *
 * Rate is a property of ports, not a data type (a float is a float):
 *
 *   pixel    computed in GLSL for every pixel (today's cables). Shown as circles.
 *   control  computed once per frame in JavaScript, before rendering; can hold
 *            state (Lag, Counter...). Reaches shaders as a live uniform (changing
 *            it never recompiles). Shown as diamonds, cables drawn dashed.
 *   free     a value that is known on the CPU but has no reason to be a uniform
 *            (Float / Vec / Color constants, Time, Mouse, math on constants).
 *            It compiles into GLSL exactly as before when a shader uses it and is
 *            evaluated in JS when a control node uses it. Shown as circles.
 *
 * Node kinds:
 *   control  def.rate === 'control' (library group "Control": LFO, Lag, Counter...).
 *            Always runs in JS; its inputs are control-only (except inputs declared
 *            rate: 'pixel', e.g. Sample's probe input).
 *   source   CPU sources that push their own uniforms: Param, JS, Keyboard, XY Pad,
 *            MIDI CC / Note, Microphone. Outputs are control rate (textures excepted).
 *   infer    nodes with a JS twin (def.evaluate, from libNode `js`): math, vector,
 *            logic, Beat / Audio, constants. Rate inference:
 *              - any input pixel                         -> pixel (GLSL, as before)
 *              - else any input control, def.cpuSource, or an unconnected input
 *                defaulting to a clock uniform / u_mouse  -> control (runs in JS,
 *                                                            outputs become uniforms)
 *              - else (constants / unconnected inputs)    -> free
 *            Unconnected inputs must be CPU-known: inline numbers, GLSL literals or a
 *            built-in clock uniform (u_time, u_beatPhase...); '@p', v_uv, pt_uv()... are pixel.
 *   pixel    everything else.
 *
 * Connection rules (checked by connectionRateError, used by the UI and MCP):
 *   control -> pixel    allowed (live uniform)
 *   pixel -> control    rejected ("pixel values live on the GPU: use a Sample node")
 *   control -> control  evaluated in topological order each frame; cycles need a Delay
 *   event / string / list outputs only connect to nodes that run in JS.
 *
 * Disable for comparisons with ?control=off (or localStorage patchtoy_control_rate = 'off').
 */
import { CLOCK_UNIFORMS } from '../builtinUniforms.js';
import { CONTROL_ONLY_TYPES, parseLiteral } from './vmath.js';

export const PIXEL = 'pixel';
export const CONTROL = 'control';
export const FREE = 'free';

export const PIXEL_TO_CONTROL_HINT = 'pixel values live on the GPU: use a Sample node to read one back, one frame late';

let enabledFlag = null;
/** Control-rate inference on/off (on unless ?control=off). */
export function controlRateEnabled() {
    if (enabledFlag === null) {
        enabledFlag = true;
        try {
            const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('control') : null;
            const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('patchtoy_control_rate') : null;
            if (q === 'off' || (q === null && ls === 'off')) enabledFlag = false;
        } catch (e) { /* defaults to on */ }
    }
    return enabledFlag;
}

const SOURCE_FLAGS = ['isParamNode', 'isJSNode', 'isKeyboardNode', 'isXYPadNode', 'isMidiNoteNode', 'isMidiCCNode', 'isMicrophoneNode'];

/** control | source | infer | pixel */
export function nodeKind(node) {
    const def = node && node.definition;
    if (!def || !controlRateEnabled()) return 'pixel';
    if (def.rate === CONTROL) return 'control';
    for (const f of SOURCE_FLAGS) if (node[f] || def[f]) return 'source';
    if (typeof def.evaluate === 'function') return 'infer';
    return 'pixel';
}

/** Built-in uniform -> CPU value (clock.u key, or a function of the env). */
const CLOCK_KEYS = {
    u_time: 'time', u_level: 'level', u_bass: 'bass', u_lowMid: 'lowMid', u_mid: 'mid', u_high: 'high', u_kick: 'kick',
    u_beat: 'beat', u_beatPhase: 'beatPhase', u_barPhase: 'barPhase', u_beatCount: 'beatCount', u_bpm: 'bpm',
    u_beatTime: 'beatTime', u_beatConfidence: 'confidence', u_beatTrust: 'trust', u_beatRaw: 'raw'
};
for (const u of CLOCK_UNIFORMS) if (!CLOCK_KEYS[u]) CLOCK_KEYS[u] = u.replace(/^u_/, '');

/**
 * JS value of an unconnected input (inline data, literal default or a clock uniform),
 * or undefined when it is only known on the GPU (pixel). env = { u, mouse } (optional).
 */
export function cpuDefault(node, input, env = null) {
    if (input.functionOf || input.sceneInput) return undefined;
    const def = node.definition || {};
    if (typeof def.controlDefault === 'function') {
        const v = def.controlDefault(node, input, env);
        if (v !== undefined) return v;
    }
    const d = node.data && (def.inlineInputs || def.rate === CONTROL) ? node.data[input.name] : undefined;
    if (d !== undefined && d !== null) {
        if (typeof d === 'number' && Number.isFinite(d)) return d;
        if (typeof d === 'boolean') return d;
        if (Array.isArray(d) && d.length >= 1 && d.every(Number.isFinite)) return d.length === 1 ? d[0] : d.slice();
        if (typeof d === 'string') {
            if (input.type === 'string') return d;
            const lit = parseLiteral(d);
            if (lit !== undefined) return lit;
        }
    }
    let dv = input.default;
    if (dv === undefined || dv === null) {
        // No default: zero of the type (GLSL nodes would use the same)
        if (input.type === 'string') return '';
        if (input.type === 'list') return [];
        if (input.type === 'bool') return false;
        if (/^vec([234])$/.test(input.type)) return new Array(+input.type[3]).fill(0);
        return input.type === 'sampler2D' ? undefined : 0;
    }
    if (typeof dv === 'string') {
        const name = dv.trim();
        if (CLOCK_KEYS[name]) return env && env.u ? env.u[CLOCK_KEYS[name]] : 0;
        if (name === 'u_mouse') return env && env.mouse ? env.mouse.slice() : [0.5, 0.5];
        if (input.type === 'string') return dv;
    }
    const lit = parseLiteral(dv);
    return lit;
}

/** Does an unconnected input fall back to a per-frame uniform (clock, audio, u_mouse)? */
function defaultsToFrameUniform(node, input) {
    const def = node.definition || {};
    const d = node.data && (def.inlineInputs || def.rate === CONTROL) ? node.data[input.name] : undefined;
    const v = d !== undefined && d !== null ? d : input.default;
    if (typeof v !== 'string') return false;
    const name = v.trim();
    return !!CLOCK_KEYS[name] || name === 'u_mouse';
}

/** Is an input a control-only port (pixel sources are rejected)? */
export function isControlInput(node, index) {
    const input = node && node.inputs && node.inputs[index];
    if (!input || !controlRateEnabled()) return false;
    if (input.rate === CONTROL || input.cpuInput) return true;
    if (input.rate === PIXEL) return false;
    return nodeKind(node) === 'control';
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const GLSL_TYPES = new Set(['float', 'int', 'bool', 'vec2', 'vec3', 'vec4']);

function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}

/** Cheap structural fingerprint (no allocations): node ids, port counts / types, cables. */
function fingerprint(graph) {
    let h = graph.nodes.length * 7919 + graph.connections.length;
    for (const n of graph.nodes) {
        h = (h * 31 + n.id) | 0;
        h = (h * 17 + n.inputs.length * 5 + n.outputs.length) | 0;
        for (const o of n.outputs) {
            const t = o.type || '';
            h = (h * 7 + t.length * 3 + (t.length ? t.charCodeAt(t.length - 1) : 0)) | 0;
        }
    }
    for (const c of graph.connections) {
        if (!c.fromNode || !c.toNode) continue;
        h = (h * 31 + c.fromNode.id * 13 + c.fromOutput * 7 + c.toNode.id * 3 + c.toInput) | 0;
        if (c.accessor) h = (h * 7 + c.accessor.length) | 0;
    }
    return h;
}

export class ControlPlan {
    constructor(graph) {
        this.graph = graph;
        this.kind = new Map();
        this.rate = new Map();
        this.info = new Map();      // evaluated node -> { T, inTypes, outTypes, conns }
        this.order = [];            // JS evaluation order
        this.uniformNodes = new Set();
        this.violations = [];       // [{ conn, message }]
        this.errors = new Map();    // node -> message (cycles, type errors)
        this.inConns = new Map();   // node -> [conn per input]
        this.consumers = new Map(); // node -> [conn] (outgoing)
        this._build();
    }

    kindOf(node) {
        let k = this.kind.get(node);
        if (k === undefined) { k = nodeKind(node); this.kind.set(node, k); }
        return k;
    }

    conns(node) {
        return this.inConns.get(node) || [];
    }

    /** Rate of a node (pixel | control | free). */
    rateOf(node) {
        const r = this.rate.get(node);
        return r || PIXEL;
    }

    /** Rate of an output port. */
    outRate(node, k) {
        const r = this.rateOf(node);
        if (r !== CONTROL) return r;
        const t = this.outType(node, k);
        return t === 'sampler2D' || t === 'samplerCube' ? PIXEL : CONTROL;
    }

    /** Resolved type of an output port (control-evaluated nodes), else the port's type. */
    outType(node, k) {
        const info = this.info.get(node);
        if (info && info.outTypes && info.outTypes[k]) return info.outTypes[k];
        const p = node.outputs[k];
        if (!p) return null;
        if ((p.type === 'any' || !p.type) && node.resolvedOutputType) return node.resolvedOutputType;
        return p.type;
    }

    /** Displayed rate of an input port: control (diamond) or pixel (circle). */
    inRate(node, i) {
        if (isControlInput(node, i)) return CONTROL;
        if (this.kindOf(node) === 'infer' && this.rateOf(node) === CONTROL) return CONTROL;
        return PIXEL;
    }

    /** Does the node run in JS this frame (control / free nodes a control node needs, JS nodes)? */
    isEvaluated(node) {
        return this.info.has(node);
    }

    _build() {
        const g = this.graph;
        for (const n of g.nodes) {
            this.inConns.set(n, new Array(n.inputs.length).fill(null));
            this.consumers.set(n, []);
        }
        for (const c of g.connections) {
            if (!c.fromNode || !c.toNode) continue;
            const list = this.inConns.get(c.toNode);
            if (list && c.toInput < list.length) list[c.toInput] = c;
            const out = this.consumers.get(c.fromNode);
            if (out) out.push(c);
        }
        if (!controlRateEnabled()) {
            for (const n of g.nodes) this.rate.set(n, PIXEL);
            return;
        }

        // 1. Rates (memoized DFS over infer nodes)
        const visiting = new Set();
        const rateOf = (node) => {
            const known = this.rate.get(node);
            if (known) return known;
            const kind = this.kindOf(node);
            let r = PIXEL;
            if (kind === 'control' || kind === 'source') r = CONTROL;
            else if (kind === 'infer') {
                if (visiting.has(node)) return PIXEL; // pixel cycle (compiler reports it)
                visiting.add(node);
                r = node.definition.cpuSource ? CONTROL : FREE;
                const conns = this.conns(node);
                for (let i = 0; i < node.inputs.length; i++) {
                    const c = conns[i];
                    if (c) {
                        const s = rateOf(c.fromNode) === PIXEL ? PIXEL : this._outRateRaw(c.fromNode, c.fromOutput);
                        if (s === PIXEL) { r = PIXEL; break; }
                        if (s === CONTROL) r = CONTROL;
                    } else if (cpuDefault(node, node.inputs[i]) === undefined) {
                        r = PIXEL;
                        break;
                    } else if (defaultsToFrameUniform(node, node.inputs[i])) {
                        // Same value for every pixel but changes each frame: evaluate once
                        // on the CPU instead of per pixel (GPU drivers don't hoist it out of
                        // ray-march loops)
                        r = CONTROL;
                    }
                }
                visiting.delete(node);
            }
            this.rate.set(node, r);
            return r;
        };
        for (const n of g.nodes) rateOf(n);

        // 2. Types of non-pixel infer + control nodes (in dependency order, memoized)
        const typing = new Set();
        const typeOf = (node) => {
            if (this.info.has(node)) return this.info.get(node);
            const kind = this.kindOf(node);
            if (!((kind === 'infer' && this.rateOf(node) !== PIXEL) || kind === 'control')) return null;
            if (typing.has(node)) return null; // control cycle: resolved below
            typing.add(node);
            const conns = this.conns(node);
            const inTypes = {};
            for (let i = 0; i < node.inputs.length; i++) {
                const c = conns[i];
                const inp = node.inputs[i];
                if (!c) { inTypes[inp.name] = null; continue; }
                if (node.definition.delayed && inp.name === node.definition.delayed) {
                    // Delay input: typed by its source without forcing order (feedback loops)
                    inTypes[inp.name] = this._connTypeLazy(c, typeOf);
                    continue;
                }
                typeOf(c.fromNode);
                inTypes[inp.name] = this.connType(c);
            }
            const info = { T: null, inTypes, outTypes: null, conns };
            const def = node.definition;
            // Events read as numbers in generic math (pulses this frame)
            const vt = {};
            for (const k in inTypes) vt[k] = inTypes[k] === 'event' ? 'float' : inTypes[k];
            if (typeof def.validateTypes === 'function') {
                let v;
                try { v = def.validateTypes(node, vt, null); } catch (e) { v = { valid: false, error: e.message }; }
                if (!v || v.valid === false) {
                    this.errors.set(node, `${node.type}: ${(v && v.error) || 'invalid input types'}`);
                    info.invalid = true;
                }
                info.T = node._ptT || null;
                info.outTypes = (v && v.outputTypes) ? v.outputTypes.slice() : null;
            }
            if (!info.outTypes) info.outTypes = node.outputs.map(o => o.type);
            if (typeof def.controlOutputTypes === 'function') {
                const t = def.controlOutputTypes(node, inTypes);
                if (t) info.outTypes = t;
            }
            this.info.set(node, info);
            typing.delete(node);
            return info;
        };

        // 3. Evaluated set: control nodes, control-rate infer nodes, JS nodes, and the free
        //    infer nodes they read from.
        const needed = new Set();
        const need = (node) => {
            if (needed.has(node)) return;
            const kind = this.kindOf(node);
            if (kind === 'source' && !node.isJSNode) return; // read on demand
            if (kind === 'pixel') return;
            if (kind === 'infer' && this.rateOf(node) === PIXEL) return;
            needed.add(node);
            const conns = this.conns(node);
            for (let i = 0; i < conns.length; i++) {
                const c = conns[i];
                if (!c) continue;
                if (node.inputs[i] && node.inputs[i].rate === PIXEL) continue; // probe inputs (Sample)
                need(c.fromNode);
            }
        };
        for (const n of g.nodes) {
            const kind = this.kindOf(n);
            if (kind === 'control' || n.isJSNode || (kind === 'infer' && this.rateOf(n) === CONTROL)) need(n);
            else {
                // CPU inputs of other nodes (SceneSwitcher scene / next) read evaluated values too
                const conns = this.conns(n);
                for (let i = 0; i < conns.length; i++) if (conns[i] && isControlInput(n, i)) need(conns[i].fromNode);
            }
        }
        for (const n of needed) if (!n.isJSNode) typeOf(n);
        // JS nodes: their info only records the input wiring
        for (const n of needed) {
            if (n.isJSNode && !this.info.has(n)) {
                const conns = this.conns(n);
                const inTypes = {};
                n.inputs.forEach((inp, i) => { inTypes[inp.name] = conns[i] ? this.connType(conns[i]) : null; });
                this.info.set(n, { T: null, inTypes, outTypes: n.outputs.map(o => o.type), conns, js: true });
            }
        }

        // 4. Topological order (Kahn). Edges into a delayed input don't order (one frame later).
        const indeg = new Map();
        const nexts = new Map();
        for (const n of needed) { indeg.set(n, 0); nexts.set(n, []); }
        for (const n of needed) {
            const conns = this.conns(n);
            const delayed = n.definition && n.definition.delayed;
            for (let i = 0; i < conns.length; i++) {
                const c = conns[i];
                if (!c || !needed.has(c.fromNode)) continue;
                if (delayed && n.inputs[i] && n.inputs[i].name === delayed) continue;
                if (n.inputs[i] && n.inputs[i].rate === PIXEL) continue;
                indeg.set(n, indeg.get(n) + 1);
                nexts.get(c.fromNode).push(n);
            }
        }
        const queue = [];
        for (const n of g.nodes) if (needed.has(n) && indeg.get(n) === 0) queue.push(n);
        while (queue.length) {
            const n = queue.shift();
            this.order.push(n);
            for (const m of nexts.get(n)) {
                indeg.set(m, indeg.get(m) - 1);
                if (indeg.get(m) === 0) queue.push(m);
            }
        }
        if (this.order.length < needed.size) {
            for (const n of needed) {
                if (this.order.includes(n)) continue;
                this.errors.set(n, `${n.type} #${n.id} is part of a control loop: insert a Delay node to feed a value back one frame later`);
            }
        }

        // 5. Uniforms (control nodes read by shaders) and resolved port types
        for (const n of this.order) {
            const kind = this.kindOf(n);
            if (!((kind === 'infer' && this.rateOf(n) === CONTROL) || kind === 'control')) continue;
            const info = this.info.get(n);
            if (info && info.outTypes) {
                for (let k = 0; k < n.outputs.length; k++) {
                    const t = info.outTypes[k];
                    const declared = n.definition.outputs && n.definition.outputs[k] ? n.definition.outputs[k].type : undefined;
                    if (t && t !== n.outputs[k].type && (declared === undefined || declared === 'any' || n.outputs[k].generic)) {
                        n.outputs[k] = { ...n.outputs[k], type: t };
                    }
                }
            }
            this.uniformNodes.add(n);
        }

        // 6. Violations
        for (const c of g.connections) {
            if (!c.fromNode || !c.toNode) continue;
            const v = this._violation(c);
            if (v) this.violations.push({ conn: c, message: v });
        }
    }

    _outRateRaw(node, k) {
        const r = this.rate.get(node) || PIXEL;
        if (r !== CONTROL) return r;
        const p = node.outputs[k];
        const t = p && p.type;
        return t === 'sampler2D' || t === 'samplerCube' ? PIXEL : CONTROL;
    }

    /** Type carried by a cable (source type + accessor). */
    connType(c) {
        let t = this.outType(c.fromNode, c.fromOutput);
        if (c.accessor && t) t = accessorType(t, c.accessor);
        return t;
    }

    _connTypeLazy(c, typeOf) {
        // Delay inputs inside a loop: type the source if possible, never recurse forever
        try { typeOf(c.fromNode); } catch (e) { /* ignore */ }
        return this.connType(c);
    }

    /** Message when a cable breaks the rate rules, else null. */
    _violation(c) {
        const to = c.toNode;
        const from = c.fromNode;
        const inp = to.inputs[c.toInput];
        if (!inp) return null;
        const srcRate = this.outRate(from, c.fromOutput);
        const srcType = this.connType(c);
        const label = `${prettyName(from)}.${portName(from.outputs[c.fromOutput])} -> ${prettyName(to)}.${inp.name}`;
        if (isControlInput(to, c.toInput)) {
            if (srcType === 'sampler2D' || srcType === 'samplerCube') return `${label}: a texture lives on the GPU and cannot drive a control-rate input`;
            if (srcRate === PIXEL) return `${label}: ${prettyName(to)}.${inp.name} is a control-rate input and ${prettyName(from)} is computed per pixel (${PIXEL_TO_CONTROL_HINT})`;
            return null;
        }
        if (CONTROL_ONLY_TYPES.has(srcType)) {
            const toKind = this.kindOf(to);
            const runsInJs = toKind === 'control' || to.isJSNode || (toKind === 'infer' && this.rateOf(to) === CONTROL && srcType === 'event');
            if (!runsInJs) {
                const fix = srcType === 'string' ? 'use a Text Texture node' : srcType === 'list' ? 'use a List Texture node' : 'use a Counter, Toggle or Envelope to turn events into a value';
                return `${label}: ${srcType} values are control-only and cannot reach a shader (${fix})`;
            }
        }
        return null;
    }
}

function portName(p) {
    return p ? (p.name === '' ? 'out' : p.name) : '?';
}

function prettyName(n) {
    const t = (n.definition && n.definition.displayTitle) || n.type;
    return `${t} #${n.id}`;
}

/** Type after a swizzle accessor (struct members are not CPU values). */
export function accessorType(type, accessor) {
    const acc = String(accessor || '').replace(/^\./, '');
    if (!acc) return type;
    if (/^[xyzw]{1,4}$|^[rgba]{1,4}$|^[stpq]{1,4}$/.test(acc) && (GLSL_TYPES.has(type) || type === 'event')) {
        return acc.length === 1 ? 'float' : `vec${acc.length}`;
    }
    return type;
}

/** Apply a swizzle accessor to a JS value. */
export function applyAccessor(value, accessor) {
    const acc = String(accessor || '').replace(/^\./, '');
    if (!acc || !/^[xyzwrgbastpq]{1,4}$/.test(acc)) return value;
    const idx = c => 'xyzwrgbastpq'.indexOf(c) % 4;
    const arr = Array.isArray(value) ? value : null;
    const pick = (c) => (arr ? (arr[idx(c)] ?? 0) : (typeof value === 'boolean' ? (value ? 1 : 0) : Number(value) || 0));
    if (acc.length === 1) return pick(acc);
    return [...acc].map(pick);
}

// ---------------------------------------------------------------------------
// Cached plan per graph
// ---------------------------------------------------------------------------

/**
 * The control plan of a graph, rebuilt when its structure changes (fingerprint) or
 * when `force` is set (a new compile cycle).
 */
export function getControlPlan(graph, { force = false } = {}) {
    if (!graph || !Array.isArray(graph.nodes)) return null;
    const fp = fingerprint(graph);
    const cached = graph._controlPlan;
    if (!force && cached && cached._fp === fp) return cached;
    const plan = new ControlPlan(graph);
    plan._fp = fp;
    graph._controlPlan = plan;
    return plan;
}

/**
 * Would adding this cable break the rate rules? Returns { message } or null.
 * Builds a scratch plan with the cable added (the graph is not modified).
 */
export function connectionRateError(graph, fromNode, fromOutput, toNode, toInput, accessor = null) {
    if (!controlRateEnabled() || !graph || !fromNode || !toNode) return null;
    const c = { fromNode, fromOutput, toNode, toInput, accessor };
    const conns = graph.connections.filter(k => !(k.toNode === toNode && k.toInput === toInput));
    conns.push(c);
    const saved = graph.nodes.map(n => [n, n.outputs.slice(), n._ptT, n._ptInTypes]);
    let plan;
    try {
        plan = new ControlPlan({ nodes: graph.nodes, connections: conns });
    } finally {
        // The scratch plan may retype generic outputs: restore the ports in place
        for (const [n, outs, T, inTypes] of saved) {
            for (let k = 0; k < outs.length; k++) n.outputs[k] = outs[k];
            n._ptT = T;
            n._ptInTypes = inTypes;
        }
    }
    const before = new Set((getControlPlan(graph) || { violations: [] }).violations.map(v => v.message));
    const own = plan.violations.find(v => v.conn === c);
    if (own) return { message: own.message };
    const fresh = plan.violations.find(v => !before.has(v.message));
    if (fresh) {
        return { message: `${fresh.message} (connecting ${prettyName(fromNode)} makes ${prettyName(fresh.conn.fromNode)} pixel rate)` };
    }
    // Control loops need a Delay
    for (const [n, msg] of plan.errors) {
        if (/control loop/.test(msg) && !(getControlPlan(graph) || { errors: new Map() }).errors.has(n)) return { message: msg };
    }
    return null;
}

/** Ports shapes for drawing: 'circle' | 'diamond' | 'event'. */
export function portShape(plan, node, kind, index) {
    if (!plan) return 'circle';
    if (kind === 'out') {
        const t = plan.outType(node, index);
        if (t === 'event') return 'event';
        return plan.outRate(node, index) === CONTROL ? 'diamond' : 'circle';
    }
    const inp = node.inputs[index];
    if (inp && inp.type === 'event') return 'event';
    return plan.inRate(node, index) === CONTROL ? 'diamond' : 'circle';
}
