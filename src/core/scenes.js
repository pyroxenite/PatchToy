/**
 * Scene system core: transitions, easing, the transition GLSL library, the
 * compiler extension that turns SceneSwitcher inputs into per-scene functions,
 * and the graph analysis used to skip Feedback passes of hidden scenes.
 *
 * Codegen (see installSceneCompiler):
 *   - every connected scene input of a SceneSwitcher is compiled into its own
 *     function `vec4 node_S_s<i>()` holding the scene's upstream sub-graph;
 *   - nodes that the rest of the pass (main) computes anyway are evaluated once
 *     in main() and handed to the scene functions through globals (sc_gN);
 *     nodes that depend on the pixel position (gl_FragCoord, UV, ...) or on
 *     scene presence are compiled into each scene function instead, so a
 *     transition can evaluate a scene at a modified coordinate;
 *   - `node_S_eval(int i)` dispatches to a scene function, and `node_S_run()`
 *     calls it in a loop whose bounds are uniforms (k0..k1): 1 iteration when a
 *     scene is shown, 2 during a transition. All branches depend on uniforms only,
 *     so they are coherent and hidden scenes cost nothing per pixel; the single
 *     call site keeps every scene body inlined once.
 *   - inside shaders that contain a SceneSwitcher, functions read the pixel
 *     position from the global `sc_FragCoord` (gl_FragCoord is rewritten in
 *     function bodies). main() sets it to gl_FragCoord, node_S_run() points it at
 *     the transition's sample coordinate while a scene is evaluated.
 *
 * Shaders of graphs without a SceneSwitcher are not affected at all.
 */

// ----------------------------------------------------------------------
// Transitions
// ----------------------------------------------------------------------

/**
 * id = the value of the style uniform (GLSL switch), single = only one scene is
 * evaluated at a time (the other one is not visible), presence = how presence is
 * handed to the two scenes: 'linear' (from 1 - p, to p) or 'halves' (the leaving
 * scene finishes before the entering one starts).
 */
export const TRANSITIONS = [
    { key: 'cut', id: 0, label: 'Cut', single: true, description: 'Instant switch (duration ignored).' },
    { key: 'crossfade', id: 1, label: 'Crossfade', description: 'Opacity blend.' },
    { key: 'dissolve', id: 2, label: 'Noise dissolve', description: 'Value-noise threshold; softness = edge width, strength = noise scale.' },
    { key: 'wipe', id: 3, label: 'Wipe', description: 'Directional wipe; angle = direction the new scene enters from (0 = right, 90 = top), softness = edge width.' },
    { key: 'iris', id: 4, label: 'Iris', description: 'Radial reveal from the center; softness = edge width.' },
    { key: 'zoom', id: 5, label: 'Zoom through', description: 'Flies into the old scene and out of the new one; strength = zoom amount.' },
    { key: 'push', id: 6, label: 'Push', description: 'The new scene pushes the old one out; angle = direction.' },
    { key: 'slide', id: 7, label: 'Slide over', description: 'The new scene slides over the old one; angle = direction.' },
    { key: 'luma', id: 8, label: 'Luma reveal', description: "Dark areas of the old scene reveal the new one first; softness = edge width." },
    { key: 'displace', id: 9, label: 'Displacement', description: "The old scene's colours warp the new one, which settles as it fades in; strength = warp amount." },
    { key: 'pixelate', id: 10, label: 'Pixelate', description: 'Pixelates out and back in (both scenes are evaluated at cell centers); strength = max cell size.' },
    { key: 'self', id: 11, label: 'Self + fade', description: 'Hands presence to both scenes (ScenePresence) and crossfades on top.' },
    { key: 'self-add', id: 12, label: 'Self (additive)', description: 'Hands presence to both scenes and adds them: each scene fades itself with ScenePresence.' },
    { key: 'sequential', id: 13, label: 'Sequential', single: true, presence: 'halves', description: 'The old scene plays its exit (presence 1 -> 0) in the first half, the new one its entrance in the second; one scene is evaluated at a time.' },
    { key: 'custom', id: 14, label: 'Custom', description: "The SceneSwitcher's transition input (a sub-graph using TransitionInput: a, b, progress, uv -> color). Falls back to a crossfade when nothing is connected." },
];
export const TRANSITION_BY_KEY = Object.fromEntries(TRANSITIONS.map(t => [t.key, t]));
export const TRANSITION_KEYS = TRANSITIONS.map(t => t.key);

/** Normalize a transition name ('Noise dissolve', 'cross-fade', 2, ...) to its key, or null. */
export function transitionKey(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return (TRANSITIONS.find(t => t.id === v) || {}).key || null;
    const s = String(v).trim().toLowerCase();
    if (TRANSITION_BY_KEY[s]) return s;
    const n = s.replace(/[^a-z]/g, '');
    const hit = TRANSITIONS.find(t => t.key.replace(/[^a-z]/g, '') === n || t.label.toLowerCase().replace(/[^a-z]/g, '') === n);
    if (hit) return hit.key;
    const alias = { fade: 'crossfade', mix: 'crossfade', noise: 'dissolve', radial: 'iris', circle: 'iris', zoomthrough: 'zoom', lumakey: 'luma', displacement: 'displace', pixel: 'pixelate', additive: 'self-add', selfadd: 'self-add', selffade: 'self' };
    return alias[n] || null;
}

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

export const EASINGS = {
    linear: t => t,
    smooth: t => t * t * (3 - 2 * t),
    'in-out': t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    in: t => t * t * t,
    out: t => 1 - Math.pow(1 - t, 3),
    sine: t => -(Math.cos(Math.PI * t) - 1) / 2,
    expo: t => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
};
export const EASING_KEYS = Object.keys(EASINGS);
export function ease(name, t) {
    return (EASINGS[name] || EASINGS.smooth)(clamp01(t));
}

/**
 * off | bars (every autoBars bars of the beat clock) | seconds | music (bars while music / the metronome
 * drives the beat clock, else seconds). bars / music hold (no switch) while live music drives the clock
 * but its beat is untrusted, for up to 8 s (a track change; SceneSwitcherNode AUTO_HOLD_MS).
 */
export const AUTO_MODES = ['off', 'bars', 'seconds', 'music'];

// ----------------------------------------------------------------------
// GLSL
// ----------------------------------------------------------------------

/**
 * Shared transition functions (one copy per shader). Ideas adapted from the
 * gl-transitions collection (MIT, https://github.com/gl-transitions/gl-transitions):
 * directional wipe, circle open, pixelize, displacement, luma.
 *   st = style id (TRANSITIONS), p = eased progress, uv = frame coordinate 0..1,
 *   tp = (angle in radians, softness 0..1, strength, unused).
 * sct_uvA / sct_uvB: where scene A (leaving) / B (entering) is sampled.
 */
export const TRANSITION_GLSL = `vec2 sct_dir(float a) {
    return vec2(cos(a), sin(a));
}

float sct_proj(vec2 uv, vec2 d) {
    return dot(uv - 0.5, d) / max(abs(d.x) + abs(d.y), 1e-4) + 0.5;
}

vec2 sct_shift(vec2 d) {
    return d * (abs(d.x) + abs(d.y));
}

vec2 sct_pixelate(vec2 uv, float p, float strength) {
    float peak = 1.0 - abs(2.0 * p - 1.0);
    float cell = 1.0 + peak * peak * max(strength, 0.05) * 48.0;
    vec2 n = max(floor(u_resolution / cell), vec2(1.0));
    return (floor(uv * n) + 0.5) / n;
}

vec2 sct_uvA(int st, vec2 uv, float p, vec4 tp) {
    if (st == 5) {
        float z = 1.0 + p * p * max(tp.z, 0.05) * 4.0;
        return 0.5 + (uv - 0.5) / z;
    }
    if (st == 6) return uv + sct_shift(sct_dir(tp.x)) * p;
    if (st == 10) return sct_pixelate(uv, p, tp.z);
    return uv;
}

vec2 sct_uvB(int st, vec2 uv, float p, vec4 tp, vec4 a) {
    if (st == 5) {
        float q = 1.0 - p;
        float z = 1.0 / (1.0 + q * q * max(tp.z, 0.05) * 4.0);
        return 0.5 + (uv - 0.5) / z;
    }
    if (st == 6 || st == 7) return uv + sct_shift(sct_dir(tp.x)) * (p - 1.0);
    if (st == 9) return uv + (a.rg - 0.5) * tp.z * 0.6 * (1.0 - p);
    if (st == 10) return sct_pixelate(uv, p, tp.z);
    return uv;
}

float sct_edge(float x, float p, float s) {
    return smoothstep(x, x + s, p * (1.0 + s));
}

vec4 sct_combine(int st, vec4 a, vec4 b, vec2 uv, float p, vec4 tp) {
    if (st < 0) return a;
    float s = max(tp.y, 0.001);
    if (st == 0 || st == 13) return p < 0.5 ? a : b;
    if (st == 2) {
        vec2 q = uv * vec2(u_resolution.x / u_resolution.y, 1.0) * (6.0 * max(tp.z, 0.05));
        float n = 0.65 * pt_valueNoise2(q) + 0.35 * pt_valueNoise2(q * 3.7 + 17.0);
        float h = s * 0.5;
        return mix(a, b, smoothstep(n - h, n + h, mix(-h, 1.0 + h, p)));
    }
    if (st == 3) return mix(a, b, sct_edge(1.0 - sct_proj(uv, sct_dir(tp.x)), p, s * 0.5));
    if (st == 4) {
        vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
        float r = length((uv - 0.5) * asp) / (0.5 * length(asp));
        return mix(a, b, sct_edge(r, p, s * 0.5));
    }
    if (st == 5) return mix(a, b, smoothstep(0.3, 0.7, p));
    if (st == 6 || st == 7) return sct_proj(uv, sct_dir(tp.x)) > 1.0 - p ? b : a;
    if (st == 8) return mix(a, b, sct_edge(pt_luma(a.rgb), p, s * 0.5));
    if (st == 9) return mix(a, b, smoothstep(0.1, 0.9, p));
    if (st == 10) return mix(a, b, smoothstep(0.42, 0.58, p));
    if (st == 12) return vec4(a.rgb + b.rgb, max(a.a, b.a));
    return mix(a, b, p);
}`;

// ----------------------------------------------------------------------
// Graph analysis
// ----------------------------------------------------------------------

/** Scene key "switcherId:sceneIndex" for gates. */
export const gateKey = (switcherId, index) => `${switcherId}:${index}`;

function inputConnections(graph) {
    const map = new Map();
    for (const c of graph.connections || []) {
        let list = map.get(c.toNode);
        if (!list) map.set(c.toNode, list = []);
        list.push(c);
    }
    return map;
}

/**
 * For every node reachable from a connected Preview: under which scenes it is
 * needed. Map nodeId -> Set of gate keys, '*' = needed regardless of scenes.
 * Feedback inputs (their render pass) inherit the Feedback node's gates; a
 * SceneSwitcher's scene input i gates its upstream with "switcher:i".
 */
export function sceneGates(graph) {
    const gates = new Map();
    if (!graph || !Array.isArray(graph.nodes)) return gates;
    const inConns = inputConnections(graph);
    const stack = [];
    for (const n of graph.nodes) {
        if (n.isPreviewNode && inConns.has(n)) stack.push([n, '*']);
    }
    while (stack.length) {
        const [node, key] = stack.pop();
        let s = gates.get(node.id);
        if (!s) gates.set(node.id, s = new Set());
        if (s.has('*') || s.has(key)) continue;
        s.add(key);
        for (const c of inConns.get(node) || []) {
            let k = key;
            if (node.isSceneSwitcher) {
                const si = node.sceneIndexOfInput ? node.sceneIndexOfInput(c.toInput) : -1;
                if (si >= 0) k = gateKey(node.id, si);
            }
            stack.push([c.fromNode, k]);
        }
    }
    return gates;
}

/** The single scene (switcher node + index) a node belongs to, or null. */
export function sceneOwner(graph, gates, nodeId) {
    const s = gates && gates.get(nodeId);
    if (!s || s.has('*') || !s.size) return null;
    const [key] = s;
    const [swId, idx] = key.split(':').map(Number);
    const sw = graph.nodes.find(n => n.id === swId);
    return sw ? { switcher: sw, index: idx, ambiguous: s.size > 1 } : null;
}

/**
 * Does a Feedback pass need to run this frame? False only when every path from
 * a Preview to it goes through scenes that are not evaluated right now and the
 * node is not flagged data.keepRunning.
 */
export function feedbackPassActive(fb, gates, graph) {
    if (!gates || (fb.data && fb.data.keepRunning)) return true;
    const s = gates.get(fb.id);
    if (!s || !s.size || s.has('*')) return true;
    for (const key of s) {
        const [swId, idx] = key.split(':').map(Number);
        const sw = graph.nodes.find(n => n.id === swId);
        if (!sw || typeof sw.isSceneEvaluated !== 'function' || sw.isSceneEvaluated(idx)) return true;
    }
    return false;
}

// ----------------------------------------------------------------------
// ShaderCompiler extension
// ----------------------------------------------------------------------

const POSITIONAL = /\b(gl_FragCoord|sc_FragCoord|v_uv)\b/;
const LOCAL_ID = /\bnode_\d+\w*/g;

export function installSceneCompiler(ShaderCompiler) {
    const P = ShaderCompiler.prototype;

    /** Per-compile scene state (called from reset()). */
    P._resetScenes = function () {
        this.sceneSwitchers = new Set();   // switcher ids compiled into this shader
        this.sceneHoisted = new Map();     // "value|type" -> global name
        this.positional = new Set();       // node ids whose value depends on the pixel / scene
        this._mainSetCache = null;
        this._sceneGatesCache = null;
        this._sceneTracking = undefined;
    };

    /** The innermost scene being compiled ({switcher, varName, index, ...}) or null. */
    P.currentSceneFrame = function () {
        for (let i = (this.lambdaStack || []).length - 1; i >= 0; i--) {
            if (this.lambdaStack[i].scene) return this.lambdaStack[i].scene;
        }
        return null;
    };

    /** Static fallback (e.g. a Feedback pass of a scene): the scene a node belongs to. */
    P.staticSceneOf = function (node) {
        const graph = node && node.graph;
        if (!graph || !Array.isArray(graph.nodes)) return null;
        if (!this._sceneGatesCache) this._sceneGatesCache = sceneGates(graph);
        return sceneOwner(graph, this._sceneGatesCache, node.id);
    };

    /**
     * Nodes the current pass computes in main() anyway: reachable from the compile
     * root without entering scene inputs, CPU-only inputs, function inputs or
     * Feedback passes.
     */
    P._sceneMainSet = function (nodeGraph) {
        if (this._mainSetCache) return this._mainSetCache;
        const set = new Set();
        const root = this.compileRoot;
        if (root) {
            const inConns = inputConnections(nodeGraph);
            const stack = [root];
            while (stack.length) {
                const n = stack.pop();
                if (set.has(n.id)) continue;
                set.add(n.id);
                if (n.isFeedbackNode || (n.definition && n.definition.isFeedbackNode)) continue;
                for (const c of inConns.get(n) || []) {
                    const inp = n.inputs[c.toInput];
                    if (!inp || inp.functionOf || inp.sceneInput || inp.cpuInput) continue;
                    stack.push(c.fromNode);
                }
            }
        }
        this._mainSetCache = set;
        return set;
    };

    /** Value for a sceneInput / cpuInput of a SceneSwitcher; false = failed. */
    P.compileSceneSlot = function (node, input, inputIndex, connection, nodeGraph) {
        if (input.cpuInput || !connection) return null;
        const index = typeof node.sceneIndexOfInput === 'function' ? node.sceneIndexOfInput(inputIndex) : parseInt(input.name, 10);
        if (!(index >= 0)) return null;
        return this.compileSceneInput(node, connection, nodeGraph, index) || false;
    };

    /** Compile one scene's upstream sub-graph into `vec4 <switcher>_s<index>()`. */
    P.compileSceneInput = function (node, connection, nodeGraph, index) {
        const fnName = `${node.varName}_s${index}`;
        const main = { code: this.generatedCode, cache: this.compiledNodes, map: this.codeToNodeMap };
        const outerStack = this.lambdaStack.slice();
        // Inside another function scope (a scene of another switcher, a Raymarch SDF):
        // no main() values to share, everything is compiled into the scene function.
        const mainSet = outerStack.length === 0 ? this._sceneMainSet(nodeGraph) : new Set();
        this.sceneSwitchers.add(node.id);
        this.generatedCode = [];
        this.compiledNodes = new Map();
        this.codeToNodeMap = new Map();
        const frame = { params: [], fnName, scene: { switcher: node, varName: node.varName, index, main, outerStack, mainSet } };
        this.lambdaStack.push(frame);
        let ret = null;
        let body = [];
        try {
            const src = this.resolveConnection(connection, nodeGraph, node);
            if (src) ret = this.convertForInput(src.value, src.type, 'vec4', node);
            body = this.generatedCode;
        } finally {
            this.generatedCode = main.code;
            this.compiledNodes = main.cache;
            this.codeToNodeMap = main.map;
            this.lambdaStack.pop();
        }
        if (ret === null || ret === undefined) return null;
        const bodyCode = body.map(line => '    ' + line).join('\n');
        this.addCustomFunction(fnName, `vec4 ${fnName}() {\n${bodyCode}${bodyCode ? '\n' : ''}    return ${ret};\n}`, node.id);
        return fnName;
    };

    /**
     * resolveConnection hook: inside a scene function, a value that main() computes
     * anyway is taken from main (through a global) instead of being recompiled -
     * unless it depends on the pixel position or scene presence.
     * Returns undefined (not handled), null (failed) or { value, type }.
     */
    P._sceneHoist = function (connection, nodeGraph, targetNode) {
        const top = this.lambdaStack[this.lambdaStack.length - 1];
        const sc = top && top.scene;
        if (!sc || !sc.mainSet.has(connection.fromNode.id)) return undefined;
        const fromNode = connection.fromNode;
        const cur = { code: this.generatedCode, cache: this.compiledNodes, map: this.codeToNodeMap, stack: this.lambdaStack };
        this.generatedCode = sc.main.code;
        this.compiledNodes = sc.main.cache;
        this.codeToNodeMap = sc.main.map;
        this.lambdaStack = sc.outerStack;
        let src;
        try {
            src = this.resolveConnection(connection, nodeGraph, targetNode);
        } finally {
            this.generatedCode = cur.code;
            this.compiledNodes = cur.cache;
            this.codeToNodeMap = cur.map;
            this.lambdaStack = cur.stack;
        }
        if (!src) return null;
        if (this.positional.has(fromNode.id)) return undefined; // evaluate inside the scene
        if (/^sampler|^image/.test(src.type)) return src;
        const locals = (String(src.value).match(LOCAL_ID) || []).filter(id => !this.uniformNames.has(id));
        if (!locals.length) return src; // uniforms / literals are valid anywhere
        const key = `${src.value}|${src.type}`;
        let g = this.sceneHoisted.get(key);
        if (!g) {
            g = `sc_g${this.sceneHoisted.size}`;
            this.sceneHoisted.set(key, g);
            this.customFunctions.set(`__${g}`, `${src.type} ${g};`);
            const line = sc.main.code.length;
            sc.main.code.push(`${g} = ${src.value};`);
            sc.main.map.set(line, fromNode.id);
        }
        return { value: g, type: src.type };
    };

    /** compileNodeBody hook: remember nodes whose value depends on the pixel or scene. */
    P._trackPositional = function (node, def, result, nodeGraph) {
        if (this._sceneTracking === undefined) {
            this._sceneTracking = !!(nodeGraph && nodeGraph.nodes && nodeGraph.nodes.some(n => n.isSceneSwitcher || (n.definition && n.definition.isSceneSwitcher)));
        }
        if (!this._sceneTracking || !result) return;
        let pos = !!def.sceneDependent;
        if (!pos) {
            const text = [result.code, result.output, result.preamble, result.requiresFunction ? def.glslFunction : ''].filter(Boolean).join('\n');
            pos = POSITIONAL.test(text);
        }
        if (!pos) {
            for (const c of nodeGraph.connections) {
                if (c.toNode === node && this.positional.has(c.fromNode.id)) { pos = true; break; }
            }
        }
        if (pos) this.positional.add(node.id);
    };

    /** buildFragmentShader hook: functions read the pixel position from sc_FragCoord. */
    P._sceneShaderParts = function (customFunctionCode) {
        if (!this.sceneSwitchers || !this.sceneSwitchers.size) return null;
        return {
            functions: `vec4 sc_FragCoord;\n\n${customFunctionCode.replace(/\bgl_FragCoord\b/g, 'sc_FragCoord')}`,
            mainOpen: 'void main() { sc_FragCoord = gl_FragCoord;'
        };
    };
}
