/**
 * Scene nodes: SceneSwitcher (shows one of N scenes, transitions between two),
 * ScenePresence (inside a scene: how visible that scene is) and TransitionInput
 * (inside a custom transition sub-graph). Runtime / UI: src/nodes/SceneSwitcherNode.js,
 * compiler extension + transitions: src/core/scenes.js.
 */
import { TRANSITION_GLSL, TRANSITION_KEYS, EASING_KEYS } from '../scenes.js';
import { collectLibrary } from './glsl.js';

/** Inputs before the numbered scene inputs (SceneSwitcherNode keeps this order). */
export const SWITCHER_CONTROL_INPUTS = [
    { name: 'scene', type: 'float', cpuInput: true, rate: 'control', description: 'Control-rate selector (Param, Counter, JS, Float/Int, MIDI CC, Keyboard, math on those...): its rounded value picks the scene. Pixel (GPU) values are rejected: read one back with a Sample node.' },
    { name: 'next', type: 'float', cpuInput: true, rate: 'control', description: 'Control-rate trigger: advances to the next scene each time the value rises (a Beat Divider / Trigger event, Param trigger count / pulse, JS, Keyboard...).' },
    {
        name: 'transition', type: 'vec4', default: 'mix(sc_a, sc_b, sc_p)',
        functionOf: { params: [{ name: 'sc_a', type: 'vec4' }, { name: 'sc_b', type: 'vec4' }, { name: 'sc_p', type: 'float' }, { name: 'sc_uv', type: 'vec2' }], returns: 'vec4' },
        description: "Custom transition (style 'custom'): a sub-graph built from TransitionInput (a = leaving scene, b = entering scene, progress, uv) returning the mixed color."
    }
];

export const SCENE_INPUT_DEFAULT = 'vec4(0.0, 0.0, 0.0, 1.0)';
export const sceneInputDef = (k) => ({ name: String(k), type: 'vec4', default: SCENE_INPUT_DEFAULT, sceneInput: true, optional: true });

/** Uniform values when the node has no runtime yet (definition checks). */
const IDLE_UNIFORMS = { a: 0, b: 0, k0: 0, k1: 1, st: -1, p: 0, pres: [1, 1, 0, 0], tp: [0, 0.3, 1, 0], idx: 0 };

function switcherUniforms(node) {
    const u = (typeof node.computeUniforms === 'function' && node.computeUniforms()) || IDLE_UNIFORMS;
    const v = node.varName;
    return [
        { name: `${v}_a`, type: 'int', value: u.a },
        { name: `${v}_b`, type: 'int', value: u.b },
        { name: `${v}_k0`, type: 'int', value: u.k0 },
        { name: `${v}_k1`, type: 'int', value: u.k1 },
        { name: `${v}_st`, type: 'int', value: u.st },
        { name: `${v}_p`, type: 'float', value: u.p },
        { name: `${v}_pres`, type: 'vec4', value: [...u.pres] },
        { name: `${v}_tp`, type: 'vec4', value: [...u.tp] },
        { name: `${v}_idx`, type: 'float', value: u.idx },
        'u_resolution'
    ];
}

export const SceneNodes = {
    'SceneSwitcher': {
        category: 'logic',
        displayTitle: 'Scene Switcher',
        description: "Shows one of its scene inputs and transitions between two of them. Each scene's exclusive upstream sub-graph is compiled into its own function and only the shown scene(s) are evaluated: 1 while a scene is shown, 2 during a transition, whatever the number of scenes (Feedback passes used only by hidden scenes are skipped too). The scene is chosen on the CPU: Parameters panel (Scenes), clicking a scene row on the node, keys 1-9, the scene / next inputs (Param, JS...), data.auto or MCP set_scene. data: scenes [{name, transition?, duration?}], current (index), transition (style), duration, durationUnit 'seconds' | 'beats', easing, angle (deg), softness, strength, auto 'off' | 'bars' | 'seconds', autoBars, autoSeconds, playlist (scene indices).",
        inputs: [...SWITCHER_CONTROL_INPUTS, sceneInputDef(0), sceneInputDef(1), sceneInputDef(2)],
        outputs: [
            { name: 'color', type: 'vec4' },
            { name: 'index', type: 'float', description: 'Current scene index (CPU value)' },
            { name: 'progress', type: 'float', description: 'Eased transition progress (0 when no transition runs)' }
        ],
        data: {
            scenes: [{ name: 'Scene 1' }, { name: 'Scene 2' }],
            current: 0,
            transition: 'crossfade',
            duration: 2.0,
            durationUnit: 'seconds',
            easing: 'smooth',
            angle: 0,
            softness: 0.3,
            strength: 1.0,
            auto: 'off',
            autoBars: 8,
            autoSeconds: 12,
            playlist: []
        },
        isSceneSwitcher: true,
        isDynamicInput: true,
        transitions: TRANSITION_KEYS,
        easings: EASING_KEYS,
        glsl: (node, inputs) => {
            const v = node.varName;
            node.compiledVarName = v;
            const branches = [];
            for (let i = 0; i < node.inputs.length; i++) {
                const inp = node.inputs[i];
                if (!inp.sceneInput) continue;
                const fn = inputs[inp.name];
                if (!fn || typeof fn !== 'string' || !/^[A-Za-z_]\w*$/.test(fn)) continue;
                const k = typeof node.sceneIndexOfInput === 'function' ? node.sceneIndexOfInput(i) : parseInt(inp.name, 10);
                if (k >= 0) branches.push(`    if (i == ${k}) return ${fn}();`);
            }
            const custom = inputs.transition && /^[A-Za-z_]\w*$/.test(inputs.transition) ? inputs.transition : null;
            const evalFn = `vec4 ${v}_eval(int i) {\n${branches.join('\n')}${branches.length ? '\n' : ''}    return ${SCENE_INPUT_DEFAULT};\n}`;
            // One loop with uniform bounds and a single call site: 1 iteration while a
            // scene is shown, 2 during a transition; every branch is uniform (coherent).
            const runFn = `vec4 ${v}_run() {
    vec4 base = sc_FragCoord;
    vec2 uv = base.xy / u_resolution;
    int st = ${v}_st;
    float p = ${v}_p;
    vec4 tp = ${v}_tp;
    vec4 a = ${SCENE_INPUT_DEFAULT};
    vec4 b = a;
    for (int k = ${v}_k0; k < ${v}_k1; k++) {
        vec2 suv = k == 0 ? sct_uvA(st, uv, p, tp) : sct_uvB(st, uv, p, tp, a);
        sc_FragCoord = vec4(suv * u_resolution, base.zw);
        vec4 c = ${v}_eval(k == 0 ? ${v}_a : ${v}_b);
        if (k == 0) a = c; else b = c;
    }
    sc_FragCoord = base;
${custom ? `    if (st == 14) return ${custom}(a, b, p, uv);\n` : ''}    return sct_combine(st, a, b, uv, p, tp);
}`;
            const lib = collectLibrary(TRANSITION_GLSL);
            node.outputVars = { color: v, index: `${v}_idx`, progress: `${v}_p` };
            return {
                code: `vec4 ${v} = ${v}_run();`,
                output: v,
                preamble: [lib, TRANSITION_GLSL, evalFn, runFn].filter(Boolean).join('\n\n'),
                uniforms: switcherUniforms(node)
            };
        }
    },

    'ScenePresence': {
        category: 'input',
        displayTitle: 'Scene Presence',
        description: "Inside a scene (any node upstream of a SceneSwitcher scene input): how present that scene is. presence 0 = hidden, 1 = fully shown; it rises while the scene enters and falls while it leaves (over the transition duration, eased). phase: -1 -> 0 while entering, 0 when shown, 0 -> 1 while leaving. leaving: 1 while leaving. Wire presence into effect amount inputs (0 = identity) for per-scene entrances and exits. The scene is found by graph reachability; outside a scene presence is 1.",
        inputs: [],
        outputs: [
            { name: 'presence', type: 'float' },
            { name: 'phase', type: 'float' },
            { name: 'leaving', type: 'float' }
        ],
        isScenePresence: true,
        sceneDependent: true,
        glsl: (node, inputs, compiler) => {
            const v = node.varName;
            let owner = compiler && compiler.currentSceneFrame ? compiler.currentSceneFrame() : null;
            let sw = owner ? { node: owner.switcher, varName: owner.varName, index: owner.index } : null;
            if (!sw && compiler && compiler.staticSceneOf) {
                const o = compiler.staticSceneOf(node);
                if (o) sw = { node: o.switcher, varName: `node_${compiler.getRemappedNodeId ? compiler.getRemappedNodeId(o.switcher.id) : o.switcher.id}`, index: o.index };
            }
            node.outputVars = { presence: `${v}_presence`, phase: `${v}_phase`, leaving: `${v}_leaving` };
            if (!sw) {
                node.sceneLabel = null;
                return {
                    code: `float ${v}_presence = 1.0;\nfloat ${v}_phase = 0.0;\nfloat ${v}_leaving = 0.0;`,
                    output: `${v}_presence`
                };
            }
            const s = sw.varName;
            const k = sw.index;
            const names = sw.node && typeof sw.node.sceneName === 'function' ? sw.node.sceneName(k) : `Scene ${k + 1}`;
            node.sceneLabel = names;
            const u = (sw.node && typeof sw.node.computeUniforms === 'function' && sw.node.computeUniforms()) || IDLE_UNIFORMS;
            return {
                code: `float ${v}_presence = (${s}_a == ${k}) ? ${s}_pres.x : ((${s}_b == ${k}) ? ${s}_pres.y : 0.0);
float ${v}_phase = (${s}_a == ${k}) ? ${s}_pres.z : ((${s}_b == ${k}) ? ${s}_pres.w : 0.0);
float ${v}_leaving = step(0.0001, ${v}_phase);`,
                output: `${v}_presence`,
                uniforms: [
                    { name: `${s}_a`, type: 'int', value: u.a },
                    { name: `${s}_b`, type: 'int', value: u.b },
                    { name: `${s}_pres`, type: 'vec4', value: [...u.pres] }
                ]
            };
        }
    },

    'TransitionInput': {
        category: 'input',
        displayTitle: 'Transition Input',
        description: "Inside a SceneSwitcher's custom transition sub-graph (its 'transition' input, style 'custom'): a = the leaving scene's color, b = the entering scene's color, progress = eased progress 0..1, uv = frame coordinate. Elsewhere: black, 0 and the screen UV.",
        inputs: [],
        outputs: [
            { name: 'a', type: 'vec4' },
            { name: 'b', type: 'vec4' },
            { name: 'progress', type: 'float' },
            { name: 'uv', type: 'vec2' }
        ],
        glsl: (node, inputs, compiler) => {
            const v = node.varName;
            const P = name => (compiler && compiler.getLambdaParam ? compiler.getLambdaParam(name) : null);
            const a = P('sc_a') || 'vec4(0.0, 0.0, 0.0, 1.0)';
            const b = P('sc_b') || 'vec4(0.0, 0.0, 0.0, 1.0)';
            const p = P('sc_p') || '0.0';
            const uv = P('sc_uv') || 'gl_FragCoord.xy / u_resolution';
            node.outputVars = { a: `${v}_a`, b: `${v}_b`, progress: `${v}_p`, uv: `${v}_uv` };
            return {
                code: `vec4 ${v}_a = ${a};\nvec4 ${v}_b = ${b};\nfloat ${v}_p = ${p};\nvec2 ${v}_uv = ${uv};`,
                output: `${v}_a`,
                uniforms: ['u_resolution']
            };
        }
    }
};
