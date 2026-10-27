import { clock } from '../core/Clock.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';
import { TypeSystem } from '../core/NodeDefinitions.js';
import { UIHelpers } from '../ui/UIHelpers.js';
import { paramLabel } from '../core/paramKinds.js';
import { contentGate } from '../core/contentGate.js';

/**
 * Runs JS nodes (src/nodes/JSNode.js) once per frame, from the app's animation
 * loop (main.js), before the renderers draw:
 *
 *   setupCode  runs once (async; `await loadScript(url)` loads a script tag)
 *   code       runs every frame; its return value defines typed outputs:
 *                number -> float, true/false -> bool, [a, b(, c, d)] -> vecN,
 *                float(x) int(x) bool(x) vec2(..) vec3(..) vec4(..) wrappers,
 *                { name: value, ... } -> several named outputs.
 *                Control-only outputs (never reach a shader directly): a string ->
 *                'string', list(array) or an array of 5+ numbers -> 'list',
 *                event(fired) -> 'event' (a one-frame pulse).
 *   inputs     control-rate input ports declared in the code with lines such as
 *                // @input speed float = 0.5
 *                // @input word string
 *              (types float int bool vec2 vec3 vec4 event string list). Values arrive
 *              as inputs.speed and as a plain variable `speed`; the ControlRuntime
 *              (src/core/control/ControlRuntime.js) runs JS nodes in control order, so
 *              upstream control nodes are evaluated first in the same frame.
 *
 * Output values are written straight into the UniformRegistry every frame (live
 * uniforms, no recompilation). Only a change of the output signature (names /
 * types) rebuilds the node's ports and recompiles.
 *
 * Trust: code is only executed when it was authored in this browser (typed in the
 * editor, the default snippet, or set through MCP automation) or the user allowed
 * it. Code that arrives with a project (file, URL, gallery, cloud) is checked
 * against a per-browser list of trusted code; unknown code pauses its node and
 * asks once: "This project contains JavaScript nodes. Run them?".
 */

const TRUST_KEY = 'patchtoy_js_trusted';
const TRUST_MAX = 200;
const MAX_OUTPUTS = 16;
const SIGNATURE_COOLDOWN_MS = 500;
const ERROR_LOG_MS = 5000;

const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;

const FRAME_ARGS = ['time', 'dt', 'frame', 'resolution', 'mouse', 'audio', 'params', 'state',
    'float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'clamp', 'mix', 'damp',
    'canvas', 'texture', 'dataTexture',
    'u_time', 'u_resolution', 'u_mouse',
    'inputs', 'list', 'event'];
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
    'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch',
    'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await', 'implements',
    'package', 'protected', 'interface', 'private', 'public', 'null', 'true', 'false', 'undefined', 'NaN', 'Infinity', 'arguments', 'eval']);
export const JS_INPUT_TYPES = ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'event', 'string', 'list'];
const MAX_INPUTS = 12;

/**
 * Control-rate inputs declared in JS code: lines "// @input name type [= default]".
 * Returns [{ name, type, default? }] (invalid lines are ignored).
 */
export function parseInputDecls(code) {
    const out = [];
    const re = /^\s*\/\/\s*@input\s+([A-Za-z_$][\w$]*)\s+([A-Za-z0-9]+)(?:\s*=\s*(.*?))?\s*$/gm;
    let m;
    const seen = new Set();
    while ((m = re.exec(String(code || ''))) && out.length < MAX_INPUTS) {
        const [, name, rawType, dv] = m;
        const type = rawType === 'number' ? 'float' : rawType === 'text' ? 'string' : rawType === 'trigger' ? 'event' : rawType;
        if (!JS_INPUT_TYPES.includes(type) || seen.has(name)) continue;
        seen.add(name);
        const d = { name, type };
        if (dv !== undefined && dv !== '') d.default = dv.trim();
        out.push(d);
    }
    return out;
}

/** JS value of a declared input default. */
export function jsInputDefault(decl) {
    const t = decl.type;
    const raw = decl.default;
    if (t === 'string') return raw === undefined ? '' : String(raw).replace(/^(['"])(.*)\1$/, '$2');
    if (t === 'list') {
        if (raw === undefined) return [];
        return String(raw).replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    }
    if (t === 'bool') return raw === 'true' || raw === '1';
    if (t === 'event') return 0;
    const nums = raw === undefined ? [] : String(raw).replace(/^(vec[234]|float|int)?\s*[\[(]|[\])]$/g, '').split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    if (/^vec([234])$/.test(t)) {
        const size = +t[3];
        if (nums.length === 1) return new Array(size).fill(nums[0]);
        return Array.from({ length: size }, (_, i) => nums[i] ?? (i === 3 ? 1 : 0));
    }
    const v = nums.length ? nums[0] : 0;
    return t === 'int' ? Math.trunc(v) : v;
}
const MAX_TEX = 4096;

// ---------------------------------------------------------------------------
// Typed value helpers (available inside node code)
// ---------------------------------------------------------------------------

const typed = (type, value) => ({ __glsl: type, type, value });
const n = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
// Output values: a NaN / Infinity number is sent as 0 and flags the node (see runOne)
let sawNonFinite = false;
const nf = (x) => {
    if (typeof x === 'number' && !Number.isFinite(x)) { sawNonFinite = true; return 0; }
    return n(x);
};
const vecArgs = (size, args) => {
    let a = args;
    if (args.length === 1) {
        const x = args[0];
        if (Array.isArray(x)) a = x;
        else if (x && typeof x === 'object') a = ['x', 'y', 'z', 'w'].map(k => x[k] ?? x[{ x: 'r', y: 'g', z: 'b', w: 'a' }[k]]);
        else a = new Array(size).fill(x);
    }
    return Array.from({ length: size }, (_, i) => nf(a[i] ?? (i === 3 ? 1 : 0)));
};
export const HELPERS = {
    float: (x) => typed('float', nf(x)),
    int: (x) => typed('int', Math.trunc(nf(x))),
    bool: (x) => typed('bool', !!x),
    vec2: (...a) => typed('vec2', vecArgs(2, a)),
    vec3: (...a) => typed('vec3', vecArgs(3, a)),
    vec4: (...a) => typed('vec4', vecArgs(4, a)),
    clamp: (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x)),
    mix: (a, b, t) => a + (b - a) * t,
    canvas: makeCanvas,
    list: (array) => {
        if (!array || typeof array.length !== 'number') throw new Error('list(array): needs an array of numbers');
        return typed('list', Array.from(array, n));
    },
    event: (fired = true) => typed('event', typeof fired === 'number' ? Math.max(0, Math.round(fired)) : (fired ? 1 : 0)),
    texture: (source, opts = {}) => {
        if (!isTexSource(source)) throw new Error('texture(source): source must be a canvas (see canvas(w, h)), an <img>, a <video> or an ImageBitmap');
        return typed('sampler2D', { kind: 'canvas', source, filter: opts.filter === 'nearest' ? 'nearest' : 'linear', wrap: opts.wrap || 'clamp' });
    },
    dataTexture: (array, width, height = 1, channels = 4) => {
        if (!array || typeof array.length !== 'number') throw new Error('dataTexture(array, width, height, channels): array must be a Float32Array or an array of numbers');
        const c = Math.round(n(channels));
        if (!(c >= 1 && c <= 4)) throw new Error(`dataTexture: channels must be 1..4 (got ${channels})`);
        const w = Math.round(width === undefined ? Math.ceil(array.length / c) : n(width));
        const h = Math.round(n(height));
        if (!(w >= 1 && h >= 1 && w <= MAX_TEX && h <= MAX_TEX)) throw new Error(`dataTexture: width and height must be 1..${MAX_TEX} (got ${width} x ${height})`);
        if (array.length > w * h * c) throw new Error(`dataTexture: ${array.length} values do not fit ${w} x ${h} x ${c} channels`);
        return typed('sampler2D', { kind: 'data', data: array, width: w, height: h, channels: c });
    },
};

/** Something texImage2D can upload as an image. */
export function isTexSource(v) {
    return !!v && typeof v === 'object' && (
        (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) ||
        (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas) ||
        (typeof HTMLImageElement !== 'undefined' && v instanceof HTMLImageElement) ||
        (typeof HTMLVideoElement !== 'undefined' && v instanceof HTMLVideoElement) ||
        (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap));
}

const DRAW_METHODS = ['fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'fill', 'stroke', 'drawImage', 'putImageData', 'reset'];

/**
 * canvas(w, h): a 2D canvas whose context marks it dirty whenever something is
 * drawn, so it is uploaded to its texture only on frames where it changed
 * (set c.dirty = true to force an upload, e.g. after drawing through another API).
 */
function makeCanvas(width = 512, height = 512) {
    const w = Math.round(n(width)), h = Math.round(n(height));
    if (!(w >= 1 && h >= 1 && w <= MAX_TEX && h <= MAX_TEX)) throw new Error(`canvas: size must be 1..${MAX_TEX} (got ${width} x ${height})`);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.dirty = true;
    const getContext = c.getContext.bind(c);
    c.getContext = (type, opts) => {
        const ctx = getContext(type, opts);
        if (ctx && type === '2d' && !ctx.__ptTracked) {
            ctx.__ptTracked = true;
            for (const m of DRAW_METHODS) {
                const fn = ctx[m];
                if (typeof fn !== 'function') continue;
                ctx[m] = function (...args) { c.dirty = true; return fn.apply(ctx, args); };
            }
        }
        if (type !== '2d') c.dirty = true;
        return ctx;
    };
    return c;
}

/** Short description of a texture output; part of the output signature (size / kind changes recompile). */
export function texDesc(value) {
    if (!value) return 'tex';
    if (value.kind === 'data') return `data ${value.width}x${value.height}x${value.channels}`;
    const s = value.source || {};
    const w = s.videoWidth || s.naturalWidth || s.width || 0;
    const h = s.videoHeight || s.naturalHeight || s.height || 0;
    return `canvas ${w}x${h}`;
}

/** Convert one returned value to { type, value }; throws a readable error. */
function toTyped(name, v) {
    if (v && typeof v === 'object' && v.__glsl) return { type: v.type, value: v.value };
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string' && v.value !== undefined) {
        // legacy { type, value }
        const t = v.type;
        if (t === 'float' || t === 'int') return { type: t, value: t === 'int' ? Math.trunc(nf(v.value)) : nf(v.value) };
        if (t === 'bool') return { type: t, value: !!v.value };
        if (/^vec[234]$/.test(t)) return { type: t, value: vecArgs(+t[3], [v.value]) };
    }
    if (isTexSource(v)) return { type: 'sampler2D', value: { kind: 'canvas', source: v, filter: 'linear', wrap: 'clamp' } };
    if (ArrayBuffer.isView(v)) throw new Error(`output "${name}": wrap typed arrays with dataTexture(array, width, height, channels)`);
    if (typeof v === 'number') return { type: 'float', value: nf(v) };
    if (typeof v === 'boolean') return { type: 'bool', value: v };
    if (typeof v === 'string') return { type: 'string', value: v };
    if (Array.isArray(v)) {
        if (v.length === 1) return { type: 'float', value: nf(v[0]) };
        if (v.length >= 2 && v.length <= 4) return { type: `vec${v.length}`, value: v.map(nf) };
        return { type: 'list', value: v.map(n) }; // 0 or 5+ numbers: a control-only list
    }
    if (v && typeof v === 'object' && 'x' in v && 'y' in v) {
        const size = 'w' in v ? 4 : 'z' in v ? 3 : 2;
        return { type: `vec${size}`, value: vecArgs(size, [v]) };
    }
    throw new Error(`output "${name}": cannot use ${v === null ? 'null' : typeof v} as an output (return a number, boolean, [x, y(, z, w)], a string, list(array) or float()/vec3()...)`);
}

/** Normalize a frame's return value to [{ name, type, value }]. */
export function normalizeResult(result) {
    if (result === undefined || result === null) return [];
    const isMulti = typeof result === 'object' && !Array.isArray(result) && !result.__glsl && !isTexSource(result) && !ArrayBuffer.isView(result) &&
        !(typeof result.type === 'string' && result.value !== undefined) && !('x' in result && 'y' in result);
    const entries = isMulti ? Object.entries(result) : [['out', result]];
    if (entries.length > MAX_OUTPUTS) throw new Error(`too many outputs (${entries.length}, max ${MAX_OUTPUTS})`);
    return entries.map(([name, v]) => {
        const t = { name: String(name), ...toTyped(name, v) };
        if (t.type === 'sampler2D') t.tex = texDesc(t.value);
        return t;
    });
}

export function zeroOf(type) {
    if (type === 'bool') return false;
    if (type === 'string') return '';
    if (type === 'list') return [];
    if (/^vec([234])$/.test(type)) return new Array(+type[3]).fill(0);
    return 0;
}

// ---------------------------------------------------------------------------
// Trust (per browser)
// ---------------------------------------------------------------------------

export const DEFAULT_KEYS = new Set();

export function codeKey(data) {
    return `${data && data.setupCode ? data.setupCode : ''}\u0000${data && data.code ? data.code : ''}`;
}

class TrustStore {
    constructor() {
        this.list = null;
        /** Trusted for this page session only (projects opened by the MCP agent): never persisted. */
        this.session = new Set();
    }

    load() {
        if (this.list) return this.list;
        try {
            const raw = JSON.parse(localStorage.getItem(TRUST_KEY) || '[]');
            this.list = Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : [];
        } catch (e) {
            this.list = [];
        }
        return this.list;
    }

    has(key) {
        return DEFAULT_KEYS.has(key) || this.session.has(key) || this.load().includes(key);
    }

    addSession(key) {
        if (!DEFAULT_KEYS.has(key)) this.session.add(key);
    }

    add(key) {
        if (DEFAULT_KEYS.has(key)) return;
        const list = this.load();
        const i = list.indexOf(key);
        if (i >= 0) list.splice(i, 1);
        list.push(key);
        while (list.length > TRUST_MAX) list.shift();
        try {
            localStorage.setItem(TRUST_KEY, JSON.stringify(list));
        } catch (e) {
            // Quota: keep the newest half
            list.splice(0, Math.floor(list.length / 2));
            try { localStorage.setItem(TRUST_KEY, JSON.stringify(list)); } catch (err) { /* in-memory only */ }
        }
    }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

class JSRuntime {
    constructor() {
        this.trust = new TrustStore();
        this.pending = new Set();
        this.prompting = false;
        this.suspend = 0;            // >0: don't evaluate trust (automation load in progress)
        this.lastTime = null;
        this.paramsView = {};
        this._logged = new Map();    // message -> last console time
        this.texNodes = new Set();   // JS nodes owning GL textures
        this.app = null;
    }

    /** A project is replaced: forget nodes of the old one waiting for a trust prompt, restart dt. */
    resetProject() {
        this.pending.clear();
        this.lastTime = null;
    }

    /**
     * Mark a node's current code as trusted (editor save, the user allowed it, MCP).
     * persist: false trusts it for this page session only (a project the MCP agent opened:
     * the code wasn't written here, so it must not run without a prompt from a share link later).
     */
    trustNode(node, { persist = true } = {}) {
        if (!node || !node.isJSNode) return;
        if (persist) this.trust.add(codeKey(node.data));
        else this.trust.addSession(codeKey(node.data));
        node.trust = 'trusted';
        this.pending.delete(node);
    }

    isTrusted(node) {
        return this.trust.has(codeKey(node.data));
    }

    /** Evaluate trust for nodes that have not been checked yet (fresh from a load). */
    _checkTrust(nodes) {
        if (this.suspend > 0) return;
        for (const node of nodes) {
            if (node.trust === 'trusted' || node.trust === 'blocked') {
                // Code changed behind our back (set_node_data, paste): re-check
                if (node.trust === 'trusted' && node._trustKey !== codeKey(node.data)) {
                    node.trust = this.isTrusted(node) ? 'trusted' : null;
                }
                if (node.trust) {
                    node._trustKey = codeKey(node.data);
                    continue;
                }
            }
            if (node.trust === 'pending') continue;
            node._trustKey = codeKey(node.data);
            if (this.isTrusted(node)) {
                node.trust = 'trusted';
            } else {
                node.trust = 'pending';
                this.pending.add(node);
            }
        }
        if (this.pending.size && !this.prompting) this._prompt();
    }

    async _prompt(single = null) {
        this.prompting = true;
        // Let the rest of a project load land first so one question covers every node
        await new Promise(r => setTimeout(r, 120));
        const graph = this.app && this.app.nodeGraph;
        const nodes = single ? [single] : [...this.pending].filter(n => graph && graph.nodes.includes(n));
        if (!nodes.length) {
            this.prompting = false;
            return;
        }
        const many = nodes.length > 1;
        let choice = null;
        try {
            choice = await UIHelpers.choose({
                title: single ? 'Run this JavaScript node?' : 'This project contains JavaScript nodes. Run them?',
                message: `${many ? `${nodes.length} JS nodes` : 'A JS node'} in this patch contain${many ? '' : 's'} code that was not written in this browser. ` +
                    'JavaScript in this project can access your PatchToy session (it could act as you: edit, publish or delete your projects), the network and this site’s storage. Only run code you trust; ' +
                    'until then the node' + (many ? 's stay' : ' stays') + ' paused. You can review the code by double-clicking the node.',
                buttons: [
                    { label: 'Keep paused', value: 'block', variant: 'ghost' },
                    { spacer: true },
                    { label: many ? 'Run them' : 'Run it', value: 'run', variant: 'primary' }
                ]
            });
        } catch (e) {
            choice = null;
        }
        for (const node of nodes) {
            this.pending.delete(node);
            if (choice === 'run') this.trustNode(node);
            else node.trust = 'blocked';
            if (node.graph) node.graph.render();
        }
        this.prompting = false;
        if (this.pending.size) this._prompt();
    }

    /** Ask again for a paused node (click on it). */
    askFor(node) {
        if (this.prompting || !node) return;
        this._prompt(node);
    }

    _buildParams(graph) {
        const view = {};
        for (const n of graph.nodes) {
            if (!n.isParamNode) continue;
            const label = paramLabel(n);
            const v = n.data.value;
            view[label] = Array.isArray(v) ? v.slice() : v;
        }
        return view;
    }

    _resolution(app) {
        const c = app && app.nodeCanvas;
        const dpr = window.devicePixelRatio || 1;
        if (c && c.clientWidth) return [c.clientWidth * dpr, c.clientHeight * dpr];
        return [window.innerWidth * dpr, window.innerHeight * dpr];
    }

    /**
     * Per-frame setup shared by tick() and the ControlRuntime: clock delta, texture GC,
     * trust checks. Returns the frame env, or null when the graph has no JS nodes.
     */
    beginFrame(app) {
        this.app = app;
        const graph = app && app.nodeGraph;
        if (!graph) return null;
        let nodes = null;
        for (const node of graph.nodes) {
            if (node.isJSNode) (nodes || (nodes = [])).push(node);
        }
        const time = clock.u.time;
        const dt = this.lastTime === null ? 0 : Math.max(0, Math.min(0.25, time - this.lastTime));
        this.lastTime = time;
        if (this.texNodes.size) this._collectTextures(graph);
        if (!nodes) return null;
        this._checkTrust(nodes);
        return {
            time, dt,
            frame: clock.frame,
            resolution: this._resolution(app),
            mouse: [ShaderPreview.mouseX, ShaderPreview.mouseY],
            audio: clock.u,
            params: this._buildParams(graph)
        };
    }

    /** Run one JS node for this frame (no-op unless trusted). Never throws. */
    runOne(node, env, app) {
        if (!env || node.trust !== 'trusted') return;
        try {
            this.runNode(node, env, app);
        } catch (e) {
            this.reportError(node, e, app);
        }
    }

    /** Run every JS node of the graph (graph order). */
    runAll(app, env = null) {
        const graph = app && app.nodeGraph;
        if (!graph || !env) return;
        for (const node of graph.nodes) if (node.isJSNode) this.runOne(node, env, app);
    }

    /** Per-frame entry point without the ControlRuntime (graph order). Never throws. */
    tick(app) {
        const env = this.beginFrame(app);
        if (env) this.runAll(app, env);
    }

    runNode(node, env, app) {
        // (Re)start setup when the setup code changes
        const setupSrc = node.data.setupCode || '';
        if (node._setupFor !== setupSrc) {
            node._setupFor = setupSrc;
            node.state = {};
            node.setupState = 'idle';
            node.cleanupDom?.();
        }
        if (node.setupState === 'idle') {
            if (!setupSrc.trim()) {
                node.setupState = 'ready';
            } else {
                node.setupState = 'running';
                const token = node._setupToken = {};
                let fn;
                try {
                    fn = new AsyncFunction('loadScript', 'state', 'params', 'canvas', 'texture', 'dataTexture', setupSrc);
                } catch (e) {
                    node.setupState = 'error';
                    this.reportError(node, e, app, 'setup');
                    return;
                }
                Promise.resolve()
                    .then(() => fn.call(node.state, (url) => node.loadScript(url), node.state, env.params, HELPERS.canvas, HELPERS.texture, HELPERS.dataTexture))
                    .then(() => {
                        if (node._setupToken !== token) return;
                        node.setupState = 'ready';
                        this.clearError(node, app);
                    }, (e) => {
                        if (node._setupToken !== token) return;
                        node.setupState = 'error';
                        this.reportError(node, e, app, 'setup');
                    });
                return;
            }
        }
        if (node.setupState !== 'ready') return;

        // Compile the frame function once per code change (declared inputs become variables)
        const code = node.data.code || '';
        if (node._fnFor !== code) {
            node._fnFor = code;
            node._fn = null;
            if (typeof node.syncInputsFromCode === 'function') node.syncInputsFromCode();
            node._inputNames = (node.inputs || []).map(i => i.name).filter(nm => /^[A-Za-z_$][\w$]*$/.test(nm) && !RESERVED.has(nm) && !FRAME_ARGS.includes(nm));
            try {
                node._fn = new Function(...FRAME_ARGS, ...node._inputNames, code);
            } catch (e) {
                node._fnError = e;
            }
        }
        if (!node._fn) {
            this.reportError(node, node._fnError || new Error('code failed to compile'), app);
            return;
        }

        const state = node.state || (node.state = {});
        const damp = (a, b, rate) => a + (b - a) * (1 - Math.exp(-n(rate) * env.dt));
        const H = HELPERS;
        const inputs = this._inputsOf(node);
        sawNonFinite = false;
        const result = node._fn.call(state,
            env.time, env.dt, env.frame, env.resolution, env.mouse, env.audio, env.params, state,
            H.float, H.int, H.bool, H.vec2, H.vec3, H.vec4, H.clamp, H.mix, damp,
            H.canvas, H.texture, H.dataTexture,
            env.time, env.resolution, env.mouse,
            inputs, H.list, H.event,
            ...(node._inputNames || []).map(nm => inputs[nm]));
        if (result && typeof result.then === 'function') {
            throw new Error('the frame code must not be async (return values, not a Promise); load things in setup');
        }
        const outs = normalizeResult(result);
        this.apply(node, outs, app);
        // NaN / Infinity never reaches a uniform: sent as 0, and the node says so while it lasts
        if (sawNonFinite) this.reportError(node, new Error('an output is NaN / Infinity (sent as 0)'), app);
        else this.clearError(node, app);
    }

    /** Input values of a JS node: from the ControlRuntime (connected) or the declared defaults. */
    _inputsOf(node) {
        const out = {};
        const given = node.controlInputs || null;
        for (const inp of node.inputs || []) {
            if (given && given[inp.name] !== undefined) out[inp.name] = given[inp.name];
            else out[inp.name] = inp.jsDefault !== undefined ? (Array.isArray(inp.jsDefault) ? inp.jsDefault.slice() : inp.jsDefault) : jsInputDefault(inp);
        }
        return out;
    }

    /** Push values; rebuild ports + recompile only when the signature changes. */
    apply(node, outs, app) {
        const sig = outs.map(o => `${o.name}:${o.type}${o.tex ? `[${o.tex}]` : ''}`).join(',');
        if (sig !== node.signature()) {
            const now = performance.now();
            if (now - (node._sigChangedAt || 0) < SIGNATURE_COOLDOWN_MS) {
                // Keep the current ports while the signature flaps; push what still matches
                node._flapping = true;
            } else {
                node._sigChangedAt = now;
                node._flapping = false;
                node.setOutputs(outs.map(o => (o.tex ? { name: o.name, type: o.type, tex: o.tex } : { name: o.name, type: o.type })));
                node.recompiles = (node.recompiles || 0) + 1;
                const g = node.graph;
                if (g && g.onGraphChanged) g.onGraphChanged();
            }
        }
        node.values = new Map(outs.map(o => [o.name, o]));
        node.pushValues();
        if (node.textures && node.textures.size) this.texNodes.add(node);
    }

    /** Free GL textures of JS nodes that left the graph (deleted, or another project loaded). */
    _collectTextures(graph) {
        for (const node of this.texNodes) {
            if (!graph.nodes.includes(node)) {
                node.freeTextures?.();
                this.texNodes.delete(node);
            }
        }
    }

    reportError(node, err, app, phase = 'frame') {
        const msg = `${phase === 'setup' ? 'setup: ' : ''}${err && err.message ? err.message : String(err)}`;
        if (node.jsError === msg) return;
        node.jsError = msg;
        if (node.graph) node.graph.render();
        const cm = app && app.compilationManager;
        if (cm && cm.setRuntimeError) cm.setRuntimeError(node, msg);
        const last = this._logged.has(msg) ? this._logged.get(msg) : -Infinity;
        const now = performance.now();
        if (now - last > ERROR_LOG_MS) {
            this._logged.set(msg, now);
            console.warn(`[JS #${node.id}] ${msg}`);
        }
    }

    clearError(node, app) {
        if (!node.jsError) return;
        node.jsError = null;
        if (node.graph) node.graph.render();
        const cm = app && app.compilationManager;
        if (cm && cm.setRuntimeError) cm.setRuntimeError(node, null);
    }
}

export const jsRuntime = new JSRuntime();
// The remote-media prompt waits while the JavaScript prompt is open
contentGate.isBusy = () => jsRuntime.prompting;

/** Remap connections from a node whose outputs changed (by name), dropping invalid ones. */
export function remapOutputConnections(node, oldOutputs) {
    const g = node.graph;
    if (!g || !Array.isArray(g.connections)) return;
    g.connections = g.connections.filter(c => {
        if (c.fromNode !== node) return true;
        const old = oldOutputs[c.fromOutput];
        const idx = old ? node.outputs.findIndex(o => o.name === old.name) : -1;
        if (idx < 0) return false;
        const inT = c.toNode.inputs[c.toInput] && c.toNode.inputs[c.toInput].type;
        const outT = node.outputs[idx].type;
        if (inT && inT !== 'any' && inT !== outT && !TypeSystem.canConvert(outT, inT)) return false;
        c.fromOutput = idx;
        return true;
    });
}
