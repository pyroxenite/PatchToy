/**
 * ControlRuntime - evaluates the control-rate part of the graph once per frame,
 * from the app's animation loop (main.js), after Param pulses and before Scene
 * switchers, Feedback passes and the previews render:
 *
 *   1. plan = getControlPlan(graph) (src/core/control/rates.js; cached)
 *   2. nodes in plan.order run in topological order: control nodes and control-rate
 *      math call def.evaluate (their JS twin), JS nodes run their code with their
 *      control inputs (jsRuntime.runNode), free nodes a control node needs are
 *      evaluated too; sources (Param, Keyboard, MIDI...) are read on demand
 *   3. Delay nodes store this frame's input (def.post)
 *   4. every control node a shader reads pushes its outputs into the UniformRegistry
 *      under node_<compact id>_c<k> (no recompilation)
 *   5. a short history per node for the canvas sparklines
 *
 * Values live on the nodes: node._ctlOut[k] (last value of output k), node._ctlState
 * (persistent state object of stateful nodes), node._ctlError.
 *
 * render_preview pins the clock: evaluateScratch() re-evaluates the control graph at
 * the pinned time with dt = 0 on copies of the node state, pushes those uniforms for
 * the synchronous render and restoreLive() puts the live values back.
 */
import { clock } from '../Clock.js';
import { ShaderPreview } from '../../rendering/ShaderPreview.js';
import { jsRuntime, HELPERS } from '../../nodes/jsRuntime.js';
import { paramUniformValue, normalizeKind } from '../paramKinds.js';
import { getControlPlan, cpuDefault, applyAccessor } from './rates.js';
import { cast, zeroOf, GLSL_VALUE_TYPES } from './vmath.js';

const HISTORY = 96;           // sparkline samples (~1.6 s at 60 fps)
const ERROR_LOG_MS = 5000;
const NONFINITE_SHOW_MS = 1500; // a NaN / Infinity error stays on the node at least this long

/** A number that is NaN / ±Infinity, or a vector holding one. */
export function isNonFinite(v) {
    if (typeof v === 'number') return !Number.isFinite(v);
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) if (typeof v[i] === 'number' && !Number.isFinite(v[i])) return true;
    }
    return false;
}

/** v with every non-finite number replaced by the matching component of `fallback` (or 0). */
function finiteOr(v, fallback) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : (typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0);
    if (Array.isArray(v)) {
        return v.map((x, i) => (typeof x !== 'number' || Number.isFinite(x) ? x
            : (Array.isArray(fallback) && Number.isFinite(fallback[i]) ? fallback[i] : 0)));
    }
    return v;
}

/** Drop state fields that went non-finite (NaN in a Lag / Spring / Counter would stay forever). */
function scrubState(state) {
    if (!state) return;
    for (const k of Object.keys(state)) if (isNonFinite(state[k])) delete state[k];
}

const beatPos = (u) => (u.beatCount || 0) + (u.beatPhase || 0);

/** Current value of output k of a CPU source node (Param, constants, Keyboard, MIDI...). */
export function readSourceOutput(node, k, env = null) {
    const port = node.outputs[k] || {};
    const name = port.name;
    if (node.isParamNode) {
        const d = node.data || {};
        const kind = normalizeKind(d.kind) || 'float';
        if (kind === 'trigger') {
            if (name === 'pulse') return node.pulse ? 1 : 0;
            if (name === 'since') return Math.max(0, clock.u.time - (node.pressTime ?? -1e4));
            return Number(d.value) || 0;
        }
        if (kind === 'bool') return name === 'on' ? !!d.value : (d.value ? 1 : 0);
        if (kind === 'text') return String(d.value ?? '');
        if (kind === 'image') return 0;
        const v = paramUniformValue(d, { pulse: node.pulse, pressTime: node.pressTime });
        return Array.isArray(v) ? v.slice() : v;
    }
    if (node.isJSNode) {
        const o = node.outputs[k];
        const v = o && node.values ? node.values.get(o.name) : null;
        if (v && v.type === o.type) return Array.isArray(v.value) ? v.value : v.value;
        return o ? zeroOf(o.type) : 0;
    }
    if (node.isMidiCCNode && typeof node.getValue === 'function') return node.getValue();
    if (node.isMicrophoneNode && typeof node.getRMS === 'function') return node.getRMS();
    if (typeof node.getUniformValue === 'function') {
        const v = node.getUniformValue() || [];
        if (node.isKeyboardNode) return name === 'toggle' ? v[1] : v[0];
        if (node.isXYPadNode) return name === 'x' ? v[0] : name === 'y' ? v[1] : [v[0], v[1]];
        if (node.isMidiNoteNode) return name === 'velocity' ? v[1] : name === 'note' ? v[2] : name === 'pitch' ? v[2] / 127 : v[0];
        return Array.isArray(v) ? v[0] : v;
    }
    return 0;
}

class ControlRuntime {
    constructor() {
        this.lastTime = null;
        this.frame = 0;
        this.app = null;
        this.pushed = 0;          // uniform pushes last frame (get_project / debugging)
        this.evalMs = 0;          // CPU time of the last evaluation (EMA)
        this._logged = new Map();
        this._remap = null;
    }

    /** Uniform name base of a node in the current compile (node_<compact id>). */
    _varName(node) {
        const remap = this._remap;
        if (!remap || !remap.has(node.id)) return null;
        return `node_${remap.get(node.id)}`;
    }

    /** Value of input i of node (connected source, or its CPU default). */
    _inputValue(plan, node, i, env, scratch = false) {
        const input = node.inputs[i];
        const c = plan.conns(node)[i];
        if (!c) {
            const v = cpuDefault(node, input, env);
            return v === undefined ? zeroOf(input.type) : v;
        }
        const src = c.fromNode;
        let v;
        if (plan.isEvaluated(src) && !src.isJSNode) {
            const out = scratch && src._ctlScratchOut ? src._ctlScratchOut : src._ctlOut;
            v = out ? out[c.fromOutput] : undefined;
            if (v === undefined) v = zeroOf(plan.outType(src, c.fromOutput));
        } else if (plan.kindOf(src) === 'source' || src.isJSNode) {
            v = readSourceOutput(src, c.fromOutput, env);
            if (isNonFinite(v)) {
                // A Param edited to a bad value, a MIDI / JS source returning NaN: never let it in
                this._warnSource(src, c.fromOutput);
                v = finiteOr(v, 0);
            }
        } else {
            v = zeroOf(plan.outType(src, c.fromOutput)); // pixel source (rate violation; reported by the plan)
        }
        if (c.accessor) v = applyAccessor(v, c.accessor);
        return v;
    }

    _ctx(node, info, env, scratch) {
        return {
            T: info.T,
            inTypes: info.inTypes,
            dt: env.dt,
            time: env.u.time,
            beat: beatPos(env.u),
            u: env.u,
            frame: env.frame,
            mouse: env.mouse,
            scratch,
            makeCanvas: HELPERS.canvas,
            state: scratch ? (node._ctlScratch || (node._ctlScratch = cloneState(node._ctlState))) : (node._ctlState || (node._ctlState = {}))
        };
    }

    _evalNode(plan, node, env, scratch) {
        const def = node.definition;
        const info = plan.info.get(node);
        if (!info || typeof def.evaluate !== 'function') return;
        if (plan.errors.has(node) && !info.invalid) {
            this._setError(node, plan.errors.get(node));
            return;
        }
        if (info.invalid) {
            this._setError(node, plan.errors.get(node) || 'invalid input types');
            return;
        }
        // (per plan, not per frame: plans are rebuilt when the graph changes)
        let vmap = plan._violationOf;
        if (!vmap) {
            vmap = plan._violationOf = new Map();
            for (const v of plan.violations) if (!vmap.has(v.conn.toNode)) vmap.set(v.conn.toNode, v);
        }
        const violation = vmap.get(node);
        if (violation) {
            this._setError(node, violation.message);
            return;
        }
        const values = {};
        const types = {};
        for (let i = 0; i < node.inputs.length; i++) {
            const inp = node.inputs[i];
            let v = this._inputValue(plan, node, i, env, scratch);
            let t = info.inTypes[inp.name] || null;
            if (inp.type === 'event' && t && t !== 'event') {
                // A number driving an event input fires on its rising edge (through 0.5)
                const edges = node._ctlEdges || (node._ctlEdges = {});
                const x = typeof v === 'boolean' ? (v ? 1 : 0) : (Array.isArray(v) ? v[0] : Number(v) || 0);
                const prev = edges[inp.name];
                v = prev !== undefined && prev < 0.5 && x >= 0.5 ? 1 : 0;
                if (!scratch) edges[inp.name] = x;
                t = 'event';
            }
            values[inp.name] = v;
            types[inp.name] = t;
        }
        // Math twins of GLSL nodes compute in float32 like the GPU (uniforms are float32):
        // + - * / then match the shader bit for bit
        const f32 = plan.kindOf(node) === 'infer';
        if (f32) for (const k in values) values[k] = toF32(values[k]);
        const ctx = this._ctx(node, info, env, scratch);
        if (f32) ctx.u = env.u32 || (env.u32 = f32Clock(env.u));
        let out;
        try {
            out = def.evaluate(node, values, types, ctx);
        } catch (e) {
            this._setError(node, e && e.message ? e.message : String(e));
            return;
        }
        const res = scratch ? (node._ctlScratchOut = []) : (node._ctlOut || (node._ctlOut = []));
        let bad = null;
        for (let k = 0; k < node.outputs.length; k++) {
            const o = node.outputs[k];
            let v = out ? out[o.name] : undefined;
            const t = info.outTypes ? info.outTypes[k] : o.type;
            if (v === undefined || v === null) v = t === 'sampler2D' ? null : zeroOf(t);
            else if (GLSL_VALUE_TYPES.has(t) || t === 'event') v = cast(v, Array.isArray(v) ? `vec${v.length}` : (typeof v === 'boolean' ? 'bool' : 'float'), t);
            if (f32 && GLSL_VALUE_TYPES.has(t)) v = toF32(v);
            if (t !== 'list' && isNonFinite(v)) {
                // NaN / Infinity never reaches a uniform or another control node: the output
                // holds its last finite value (live), and the node shows the error
                const prev = scratch ? (node._ctlOut ? node._ctlOut[k] : undefined) : res[k];
                v = finiteOr(v, isNonFinite(prev) ? undefined : prev);
                (bad || (bad = [])).push(o.name);
            }
            res[k] = v;
        }
        if (bad) scrubState(ctx.state);
        if (!scratch) {
            const now = performance.now();
            if (bad) {
                node._ctlNonFiniteUntil = now + NONFINITE_SHOW_MS;
                this._setError(node, `${bad.join(', ')} went NaN / Infinity: holding the last finite value`);
            } else if (node._ctlError && !(node._ctlNonFiniteUntil > now)) {
                this._setError(node, null);
            }
            this._record(node, res, info);
            if (def.isTextureControl) this._uploadTextures(node, res, info);
        }
    }

    _postNode(plan, node, env, scratch) {
        const def = node.definition;
        const info = plan.info.get(node);
        if (!info || typeof def.post !== 'function' || info.invalid) return;
        const values = {};
        const types = {};
        for (let i = 0; i < node.inputs.length; i++) {
            const inp = node.inputs[i];
            values[inp.name] = this._inputValue(plan, node, i, env, scratch);
            types[inp.name] = info.inTypes[inp.name] || null;
        }
        try {
            def.post(node, values, types, this._ctx(node, info, env, scratch));
        } catch (e) {
            this._setError(node, e && e.message ? e.message : String(e));
        }
    }

    /** Sparkline history (numbers; vectors keep their first component, events their pulses). */
    _record(node, res, info) {
        const h = node._ctlHist || (node._ctlHist = { buf: new Float32Array(HISTORY), i: 0, n: 0, fired: 0, count: 0 });
        const t = info.outTypes ? info.outTypes[0] : null;
        let x = res[0];
        if (t === 'event') {
            if (x > 0) { h.fired = performance.now(); h.count += x; }
        }
        // Event-only nodes plot their first numeric output instead
        let k = 0;
        while (k < res.length && info.outTypes && (info.outTypes[k] === 'event' || info.outTypes[k] === 'string' || info.outTypes[k] === 'list' || info.outTypes[k] === 'sampler2D')) {
            if (info.outTypes[k] === 'event' && res[k] > 0 && k > 0) { h.fired = performance.now(); h.count += res[k]; }
            k++;
        }
        x = k < res.length ? res[k] : 0;
        if (Array.isArray(x)) x = x[0];
        if (typeof x === 'boolean') x = x ? 1 : 0;
        h.plotIndex = k < res.length ? k : -1;
        h.buf[h.i] = Number.isFinite(x) ? x : 0;
        h.i = (h.i + 1) % HISTORY;
        if (h.n < HISTORY) h.n++;
    }

    _uploadTextures(node, res, info) {
        const gl = node.graph && node.graph.sharedGL;
        if (!gl || typeof node.uploadTexture !== 'function') return;
        for (let k = 0; k < node.outputs.length; k++) {
            if ((info.outTypes ? info.outTypes[k] : node.outputs[k].type) !== 'sampler2D') continue;
            const v = res[k];
            if (!v) continue;
            const name = node.outputs[k].name;
            if (v.kind === 'data') {
                const key = `${v.version}:${v.width}`;
                if (node._texVersion && node._texVersion[name] === key && node.liveTexture(name)) continue;
                (node._texVersion || (node._texVersion = {}))[name] = key;
            }
            try { node.uploadTexture(gl, name, v); } catch (e) { this._setError(node, `texture: ${e.message}`); }
        }
    }

    /** A source node (Param, MIDI, JS...) produced NaN / Infinity: replaced by 0, logged (throttled). */
    _warnSource(src, k) {
        const key = `nonfinite:${src.id}:${k}`;
        const now = performance.now();
        if (now - (this._logged.get(key) || -Infinity) <= ERROR_LOG_MS) return;
        this._logged.set(key, now);
        const port = src.outputs && src.outputs[k];
        console.warn(`[control] #${src.id} ${src.type}${port ? ` (${port.name})` : ''} gave NaN / Infinity: read as 0`);
    }

    _setError(node, message) {
        if (node._ctlError === message) return;
        node._ctlError = message || null;
        if (message) {
            const last = this._logged.get(message) || -Infinity;
            const now = performance.now();
            if (now - last > ERROR_LOG_MS) {
                this._logged.set(message, now);
                console.warn(`[control #${node.id}] ${message}`);
            }
        }
        if (node.graph && node.graph.render) node.graph.render();
    }

    _env(app, dt) {
        // A new object per frame: per-frame caches key on it
        return {
            dt,
            u: clock.u,
            frame: clock.frame,
            mouse: [ShaderPreview.mouseX, ShaderPreview.mouseY]
        };
    }

    /** Push the outputs of control nodes read by shaders (live uniforms). */
    _push(plan, graph, scratch) {
        const reg = graph.uniformRegistry;
        if (!reg) return 0;
        let n = 0;
        for (const node of plan.uniformNodes) {
            const base = this._varName(node);
            if (!base) continue;
            const out = scratch ? (node._ctlScratchOut || node._ctlOut) : node._ctlOut;
            if (!out) continue;
            const info = plan.info.get(node);
            for (let k = 0; k < node.outputs.length; k++) {
                const t = info && info.outTypes ? info.outTypes[k] : node.outputs[k].type;
                if (!GLSL_VALUE_TYPES.has(t)) continue;
                let v = out[k];
                if (v === undefined) continue;
                if (t === 'bool') v = !!v;
                else if (t === 'int') v = Math.trunc(Number(v) || 0);
                else if (isNonFinite(v)) continue; // (never NaN into a shader: keep the last value)
                // Uniform names cached per node (no string built per output per frame)
                let names = node._ctlUniformNames;
                if (!names || names.base !== base) names = node._ctlUniformNames = { base, list: [] };
                const name = names.list[k] || (names.list[k] = `${base}_c${k}`);
                const u = reg.getUniform(name);
                if (u && u.type === t) u.value = v;
                else reg.registerUniform(name, t, v, node);
                n++;
            }
        }
        return n;
    }

    /** Per-frame entry point (main.js animation loop). Runs JS nodes too. Never throws. */
    tick(app) {
        this.app = app;
        const graph = app && app.nodeGraph;
        if (!graph) return;
        const t0 = performance.now();
        const time = clock.u.time;
        const dt = this.lastTime === null ? 0 : Math.max(0, Math.min(0.25, time - this.lastTime));
        this.lastTime = time;
        this.frame++;
        this._remap = app.compilationManager && app.compilationManager.globalNodeIdRemap;

        let plan = null;
        try {
            plan = getControlPlan(graph);
        } catch (e) {
            console.warn('[control] plan failed', e);
        }
        const jsEnv = jsRuntime.beginFrame ? jsRuntime.beginFrame(app) : null;
        if (!plan) {
            if (!jsRuntime.beginFrame) jsRuntime.tick(app);
            else jsRuntime.runAll(app, jsEnv);
            return;
        }
        if (plan !== this._lastPlan) {
            // A node that left the control plan (now pixel rate) drops its stale runtime error
            this._lastPlan = plan;
            const inPlan = new Set(plan.order);
            for (const n of graph.nodes) {
                if (n._ctlError && !inPlan.has(n) && !(plan.errors && plan.errors.has(n))) this._setError(n, null);
            }
        }
        const env = this._env(app, dt);
        const ran = this._ran || (this._ran = new Set());
        ran.clear();
        for (const node of plan.order) {
            try {
                if (node.isJSNode) {
                    if (jsEnv) {
                        node.controlInputs = this._jsInputs(plan, node, env);
                        jsRuntime.runOne(node, jsEnv, app);
                    }
                    ran.add(node);
                } else {
                    this._evalNode(plan, node, env, false);
                }
            } catch (e) {
                this._setError(node, e.message || String(e));
            }
        }
        // JS nodes outside the plan (plan failed for them): still run once
        if (jsEnv) {
            for (const node of graph.nodes) {
                if (node.isJSNode && !ran.has(node)) {
                    node.controlInputs = null;
                    jsRuntime.runOne(node, jsEnv, app);
                }
            }
        }
        for (const node of plan.order) {
            if (node.definition && typeof node.definition.post === 'function') this._postNode(plan, node, env, false);
        }
        this.pushed = this._push(plan, graph, false);
        const ms = performance.now() - t0;
        this.evalMs = this.evalMs ? this.evalMs * 0.95 + ms * 0.05 : ms;
    }

    /** Control inputs of a JS node: { name: value } (declared types). */
    _jsInputs(plan, node, env) {
        if (!node.inputs.length) return null;
        const out = {};
        for (let i = 0; i < node.inputs.length; i++) {
            const inp = node.inputs[i];
            let v = this._inputValue(plan, node, i, env);
            const info = plan.info.get(node);
            const from = info && info.inTypes ? info.inTypes[inp.name] : null;
            if (from && from !== inp.type) v = cast(v, from, inp.type);
            else if (!from) v = inp.jsDefault !== undefined ? inp.jsDefault : cast(v, Array.isArray(v) ? `vec${v.length}` : typeof v === 'string' ? 'string' : 'float', inp.type);
            out[inp.name] = v;
        }
        return out;
    }

    /**
     * Synchronous evaluation at the clock's current (pinned) values without touching
     * the live state (render_preview). dt = 0: stateful nodes report their current value.
     */
    evaluateScratch(app) {
        const graph = app && app.nodeGraph;
        if (!graph) return false;
        this._remap = app.compilationManager && app.compilationManager.globalNodeIdRemap;
        let plan;
        try { plan = getControlPlan(graph); } catch (e) { return false; }
        if (!plan || !plan.uniformNodes.size) return false;
        const env = this._env(app, 0);
        for (const node of plan.order) {
            node._ctlScratch = null;
            node._ctlScratchOut = null;
        }
        for (const node of plan.order) {
            if (node.isJSNode) continue;
            try { this._evalNode(plan, node, env, true); } catch (e) { /* keep live values */ }
        }
        this._push(plan, graph, true);
        return true;
    }

    /** Push the live values again after a scratch evaluation. */
    restoreLive(app) {
        const graph = app && app.nodeGraph;
        if (!graph) return;
        const plan = graph._controlPlan;
        if (!plan) return;
        for (const node of plan.order) {
            node._ctlScratch = null;
            node._ctlScratchOut = null;
        }
        this._push(plan, graph, false);
    }

    /** Reset the state of every control node (e.g. after loading a project). */
    resetState(graph) {
        for (const n of (graph && graph.nodes) || []) {
            n._ctlState = null;
            n._ctlOut = null;
            n._ctlHist = null;
        }
    }
}

const fround = Math.fround;
/** Round numbers (and number arrays) to float32. */
function toF32(v) {
    if (typeof v === 'number') return fround(v);
    if (Array.isArray(v)) return v.map(x => (typeof x === 'number' ? fround(x) : x));
    return v;
}

/** float32 copy of the clock uniforms (what shaders see). */
function f32Clock(u) {
    const out = {};
    for (const k in u) out[k] = typeof u[k] === 'number' ? fround(u[k]) : u[k];
    return out;
}

function cloneState(s) {
    if (!s) return {};
    const out = {};
    for (const k in s) {
        const v = s[k];
        if (Array.isArray(v)) out[k] = v.map(x => (x && typeof x === 'object' && !Array.isArray(x) ? { ...x } : (Array.isArray(x) ? x.slice() : x)));
        else if (v && typeof v === 'object' && !(typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) && !ArrayBuffer.isView(v)) out[k] = { ...v };
        else out[k] = v;
    }
    return out;
}

export const controlRuntime = new ControlRuntime();

/**
 * Value of a control-rate connection for CPU consumers outside the runtime
 * (SceneSwitcher scene / next inputs): the evaluated value, or undefined when the
 * source is not a control node.
 */
export function controlValueOf(conn) {
    if (!conn || !conn.fromNode) return undefined;
    const src = conn.fromNode;
    const g = src.graph;
    const plan = g && g._controlPlan;
    if (!plan || !plan.isEvaluated(src) || src.isJSNode) return undefined;
    let v = src._ctlOut ? src._ctlOut[conn.fromOutput] : undefined;
    if (v === undefined) return undefined;
    if (conn.accessor) v = applyAccessor(v, conn.accessor);
    return v;
}
