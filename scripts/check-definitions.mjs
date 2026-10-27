#!/usr/bin/env node
/**
 * Static checks for the node library (no browser needed):
 *   node scripts/check-definitions.mjs
 *
 * - every definition has an allowed category, a description, well-formed ports
 * - every glsl() runs on a mock node without throwing, for unconnected inputs
 *   and (for generic nodes) for float / vec2 / vec3 / vec4 connections
 * - generated code has balanced brackets and no "undefined"
 * - every shared GLSL library function is well-formed and its pt_* references resolve
 *
 * - every JS twin (def.evaluate, control-rate evaluation) runs on its defaults and
 *   returns finite values for every output; control nodes (def.rate 'control') are
 *   checked that way instead of through glsl()
 *
 * WebGL compilation of every node is covered by the browser harness.
 */
process.removeAllListeners('warning'); // silence the typeless-package ESM notice

const { NodeDefinitions, NODE_CATEGORIES } = await import('../src/core/NodeDefinitions.js');
const { TypeRegistry } = await import('../src/core/TypeRegistry.js');
const { GLSL_LIB, collectLibrary } = await import('../src/core/library/glsl.js');

const KNOWN_TYPES = new Set(['any', 'float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4',
    'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4', 'sampler2D', 'samplerCube',
    'event', 'string', 'list']); // event / string / list: control-rate only (src/core/control/rates.js)
const { cpuDefault } = await import('../src/core/control/rates.js');
const GEN = ['float', 'vec2', 'vec3', 'vec4'];

const failures = [];
const fail = (type, msg) => failures.push(`${type}: ${msg}`);
const isKnownType = t => KNOWN_TYPES.has(t) || TypeRegistry.hasType(t);

function balanced(code) {
    const pairs = { ')': '(', ']': '[', '}': '{' };
    const stack = [];
    for (const ch of code.replace(/\/\/.*$/gm, '')) {
        if ('([{'.includes(ch)) stack.push(ch);
        else if (pairs[ch]) {
            if (stack.pop() !== pairs[ch]) return false;
        }
    }
    return stack.length === 0;
}

function mockCompiler() {
    return {
        warnings: [],
        usedStructs: new Set(),
        addWarning(w) { this.warnings.push(w); },
        getLambdaParam: () => null
    };
}

function mockNode(type, def) {
    const clone = v => JSON.parse(JSON.stringify(v === undefined ? null : v));
    const node = {
        id: 7,
        type,
        varName: 'node_7',
        definition: def,
        data: clone(def.data) || {},
        inputs: (def.inputs || []).map(p => ({ ...p })),
        outputs: (def.outputs || []).map(p => ({ ...p })),
        graph: { nodes: [], connections: [] }
    };
    // Node.applyDefinition copies input defaults into data for inline-field nodes
    if (def.hasInputFields) {
        for (const input of node.inputs) {
            if (input.default !== undefined && node.data[input.name] === undefined) node.data[input.name] = input.default;
        }
    }
    return node;
}

function placeholder(type) {
    if (type === 'float' || type === 'any') return '1.0';
    if (type === 'int') return '1';
    if (type === 'bool') return 'true';
    if (/^vec[234]$/.test(type)) return `${type}(1.0)`;
    if (type === 'sampler2D') return 'u_camera';
    if (TypeRegistry.isStruct(type)) return `in_${type}`;
    return '1.0';
}

/** Run validateTypes + glsl once; returns the glsl result or null. */
function run(type, def, inputTypes, values) {
    const node = mockNode(type, def);
    const compiler = mockCompiler();
    if (def.validateTypes) {
        const v = def.validateTypes(node, inputTypes, compiler);
        if (!v || typeof v.valid !== 'boolean') {
            fail(type, 'validateTypes must return { valid, ... }');
            return null;
        }
        if (!v.valid) return { invalid: v.error };
        if (v.outputTypes) {
            v.outputTypes.forEach((t, k) => { if (node.outputs[k] && t) node.outputs[k].type = t; });
        } else if (v.outputType && node.outputs[0]) {
            node.outputs[0].type = v.outputType;
        }
    }
    const result = def.glsl(node, values, compiler);
    if (!result || typeof result !== 'object') {
        fail(type, 'glsl() must return an object');
        return null;
    }
    const all = [result.code || '', result.output || '', result.preamble || ''].join('\n');
    if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(all)) fail(type, `generated code contains undefined/NaN:\n${all}`);
    // ForLoopStart / ForLoopEnd open and close the loop block on purpose
    if (!def.isForLoopStartNode && !def.isForLoopEndNode && !balanced(result.code || '')) {
        fail(type, `unbalanced brackets in code:\n${result.code}`);
    }
    if (result.preamble && !balanced(result.preamble)) fail(type, 'unbalanced brackets in preamble');
    if (typeof result.output !== 'string' || !result.output) fail(type, 'glsl() result has no output expression');
    const multi = (def.outputs || []).length > 1 && !def.isForLoopStartNode && !def.isForLoopEndNode;
    if (multi && def.isLibraryNode) {
        for (const o of def.outputs) {
            if (!node.outputVars || !node.outputVars[o.name]) fail(type, `multi-output node did not set outputVars.${o.name}`);
        }
    }
    for (const o of node.outputs) {
        if (o.type === 'any' && def.isLibraryNode) fail(type, `output '${o.name}' left unresolved ('any')`);
    }
    return result;
}

let checked = 0;
for (const [type, def] of Object.entries(NodeDefinitions)) {
    checked++;
    if (!NODE_CATEGORIES.includes(def.category)) fail(type, `category '${def.category}' is not one of ${NODE_CATEGORIES.join(', ')}`);
    if (typeof def.description !== 'string' || def.description.trim().length < 10) fail(type, 'missing description');
    if (!Array.isArray(def.inputs)) fail(type, 'inputs must be an array');
    if (!Array.isArray(def.outputs)) fail(type, 'outputs must be an array');
    if (!Array.isArray(def.inputs) || !Array.isArray(def.outputs)) continue;

    for (const [kind, ports] of [['input', def.inputs], ['output', def.outputs]]) {
        const names = new Set();
        for (const port of ports) {
            if (!port || typeof port.name !== 'string' || !port.name) { fail(type, `${kind} without a name`); continue; }
            if (names.has(port.name)) fail(type, `duplicate ${kind} name '${port.name}'`);
            names.add(port.name);
            if (!/^[a-z0-9][A-Za-z0-9]*$/.test(port.name)) fail(type, `${kind} name '${port.name}' should be short camelCase`);
            if (!isKnownType(port.type)) fail(type, `${kind} '${port.name}' has unknown type '${port.type}'`);
            if (kind === 'input' && port.default !== undefined && port.default !== null && typeof port.default !== 'string') {
                fail(type, `input '${port.name}' default must be a GLSL string`);
            }
        }
    }

    // JS twin / control node: evaluate the defaults (generic inputs also as vec3)
    if (typeof def.evaluate === 'function') {
        for (const gen of ['float', 'vec3']) {
            const node = mockNode(type, def);
            const inTypes = {};
            const vals = {};
            node.inputs.forEach((input, idx) => {
                const generic = input.generic || (input.type === 'any' && !input.cast);
                if (generic && gen !== 'float') { inTypes[input.name] = gen; vals[input.name] = [1 + idx, 0.5 + 2 * idx, 0.25 + 3 * idx]; return; }
                inTypes[input.name] = null;
                let v = cpuDefault(node, input, { u: { time: 1, beatPhase: 0.25, beatCount: 3, beat: 0.5, barPhase: 0.3, bpm: 120, beatTime: 3.2, confidence: 1, level: 0.5, bass: 0.5, mid: 0.5, high: 0.5, kick: 0.5 }, mouse: [0.5, 0.5] });
                if (v === undefined) v = 0; // pixel-only default: such nodes never run in JS unconnected
                vals[input.name] = v;
            });
            let T = null;
            if (def.validateTypes) {
                const v = def.validateTypes(node, inTypes, mockCompiler());
                if (!v || !v.valid) continue;
                T = node._ptT || null;
            }
            try {
                const ctx = { T, inTypes, dt: 1 / 60, time: 1, beat: 3.25, u: { time: 1, beatPhase: 0.25, beatCount: 3, bpm: 120, beatTime: 3.2, confidence: 1, barPhase: 0.3, level: 0.5, bass: 0.4, mid: 0.3, high: 0.2, kick: 0.1, beat: 0.6 }, frame: 1, state: {}, scratch: false, mouse: [0.5, 0.5] };
                const out = def.evaluate(node, vals, inTypes, ctx);
                for (const o of def.outputs) {
                    const v = out ? out[o.name] : undefined;
                    if (o.type === 'sampler2D') continue;
                    const ok = v !== undefined && (typeof v === 'boolean' || typeof v === 'string' || (Array.isArray(v) ? v.every(Number.isFinite) : Number.isFinite(v)));
                    if (!ok) fail(type, `evaluate() (${gen}) output '${o.name}' is ${JSON.stringify(v)}`);
                }
            } catch (e) {
                fail(type, `evaluate() threw (${gen}): ${e.stack.split('\n').slice(0, 2).join(' | ')}`);
            }
        }
    } else if (def.rate === 'control') {
        fail(type, 'control-rate nodes need a JS evaluator (libNode js)');
    }
    if (def.rate === 'control') continue; // runs in JS only, never compiled into GLSL

    if (def.glsl === null && (def.isPreviewNode || def.isCommentNode || def.isProbeNode)) continue;
    if (typeof def.glsl !== 'function') { fail(type, 'glsl must be a function'); continue; }

    // 1) Nothing connected
    const values = {};
    const noTypes = {};
    for (const input of def.inputs) {
        values[input.name] = input.functionOf ? 'scene_fn' : input.default;
        noTypes[input.name] = null;
    }
    try {
        const r = run(type, def, noTypes, values);
        if (r && r.invalid) fail(type, `rejects its own defaults: ${r.invalid}`);
    } catch (e) {
        fail(type, `glsl() threw with defaults: ${e.stack.split('\n').slice(0, 2).join(' | ')}`);
    }

    // 2) Every input connected (generic inputs with each genType)
    const generic = def.inputs.filter(i => i.type === 'any' && i.generic);
    const variants = generic.length ? GEN : [null];
    for (const g of variants) {
        const types = {};
        const vals = {};
        for (const input of def.inputs) {
            if (input.functionOf) { vals[input.name] = 'scene_fn'; types[input.name] = 'function'; continue; }
            const t = input.type === 'any' ? (input.generic ? g : (input.cast || 'float')) : input.type;
            types[input.name] = t;
            vals[input.name] = TypeRegistry.isStruct(t) || t === 'sampler2D' ? placeholder(t) : `in_${input.name}`;
        }
        if (def.isDynamicInput || def.isForLoopStartNode || def.isForLoopEndNode || def.isJSNode) continue;
        try {
            const r = run(type, def, types, vals);
            if (r && r.invalid) fail(type, `rejects connected ${g || 'inputs'}: ${r.invalid}`);
        } catch (e) {
            fail(type, `glsl() threw with connected ${g || 'inputs'}: ${e.stack.split('\n').slice(0, 2).join(' | ')}`);
        }
    }
}

// Effect amount convention (src/core/library/amount.js): def.amountInput names a
// trailing float input with inline default 1.0; at amount = 0 every output listed in
// def.amountBypass compiles to the bypass expression (inputs substituted).
const amountNodes = [];
for (const [type, def] of Object.entries(NodeDefinitions)) {
    if (!def.amountInput) continue;
    amountNodes.push(type);
    const inputs = def.inputs || [];
    const last = inputs[inputs.length - 1];
    if (!last || last.name !== def.amountInput) { fail(type, `amount input '${def.amountInput}' must be the last input`); continue; }
    if (last.type !== 'float' || last.default !== '1.0') fail(type, `amount input must be float with default '1.0'`);
    if (!def.data || def.data[def.amountInput] !== 1) fail(type, 'amount input needs the inline default 1');
    if (def.identityAtZero !== true) fail(type, 'amountInput set without identityAtZero');
    if (typeof def.amountNote !== 'string' || !def.amountNote) fail(type, 'amountInput set without the shared amountNote');
    if (!/\bamount\b/.test(def.description || '')) fail(type, 'description should explain what amount does');
    const bypass = def.amountBypass;
    if (!bypass || typeof bypass !== 'object' || !Object.keys(bypass).length) { fail(type, 'amountBypass must map outputs to their bypass'); continue; }
    const outNames = new Set((def.outputs || []).map(o => o.name));
    for (const k of Object.keys(bypass)) if (!outNames.has(k)) fail(type, `amountBypass names unknown output '${k}'`);

    const values = {};
    const noTypes = {};
    for (const input of inputs) { values[input.name] = input.default; noTypes[input.name] = null; }
    for (const [amt, label] of [['0.0', 'amount = 0'], ['in_amount', 'connected amount']]) {
        const node = mockNode(type, def);
        node.data[def.amountInput] = amt === '0.0' ? 0 : 1;
        const vals = { ...values, [def.amountInput]: amt };
        const types = { ...noTypes, [def.amountInput]: amt === '0.0' ? null : 'float' };
        try {
            if (def.validateTypes) def.validateTypes(node, types, mockCompiler());
            const r = def.glsl(node, vals, mockCompiler());
            if (amt === '0.0') {
                const multi = (def.outputs || []).length > 1;
                for (const [out, tpl] of Object.entries(bypass)) {
                    let expected = tpl;
                    for (const input of inputs) expected = expected.replace(new RegExp(`\\b${input.name}\\b`, 'g'), input.default);
                    const varName = multi ? `node_7_${out}` : 'node_7';
                    if (!new RegExp(`\\b${varName} = ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`).test(r.code)) {
                        fail(type, `${label}: output '${out}' should be the bypass ${expected}:\n${r.code}`);
                    }
                }
            } else if (!r.code.includes('max(in_amount, 0.0)')) {
                fail(type, `${label}: generated code does not read the amount input`);
            }
        } catch (e) {
            fail(type, `glsl() threw with ${label}: ${e.stack.split('\n').slice(0, 2).join(' | ')}`);
        }
    }
}

// Behaviour: Beat Divider fires each division once, also when tap tempo snaps the beat
// backwards (review D-B8). 30 s at 60 fps of a metronome clock with irregular taps
// (250-900 ms apart: every tap re-anchors the phase, some by up to -0.5 beat).
{
    const { Clock } = await import('../src/core/Clock.js');
    const def = NodeDefinitions.BeatDivider;
    for (const every of [0.5, 1]) {
        const c = new Clock();
        c.setMode('metronome', { bpm: 120 });
        const node = { id: 1, type: 'BeatDivider', data: {}, inputs: def.inputs, outputs: def.outputs };
        const state = {};
        const fired = [];
        let now = 1000, nextTap = 1500, seed = 7, minBeat = Infinity, maxBeat = -Infinity;
        for (let f = 0; f < 60 * 30; f++) {
            now += 1000 / 60;
            c.update(now);
            if (now >= nextTap) {
                c.tap(now);
                seed = (seed * 1103515245 + 12345) % 2147483648;
                nextTap = now + 250 + (seed % 650);
            }
            const out = def.evaluate(node, { every, offset: 0 }, { every: null, offset: null },
                { dt: 1 / 60, time: c.time, beat: c.beatPos, u: c.u, frame: f, state, scratch: false });
            if (f > 120) { minBeat = Math.min(minBeat, c.beatPos); maxBeat = Math.max(maxBeat, c.beatPos); }
            if (out.beat) fired.push(Math.floor(c.beatPos / every));
        }
        const dups = fired.filter((v, i) => fired.indexOf(v) !== i);
        if (dups.length) fail('BeatDivider', `every ${every}: divisions fired twice after a tap: ${dups.join(', ')}`);
        const expected = Math.floor(maxBeat / every) - Math.floor(minBeat / every);
        if (fired.length < expected - 1) fail('BeatDivider', `every ${every}: ${fired.length} events for ${expected} divisions`);
    }
}

// Shared GLSL library
for (const [name, code] of Object.entries(GLSL_LIB)) {
    const m = code.match(/^\s*(\w+)\s+(\w+)\s*\(/);
    if (!m || m[2] !== name) fail(`GLSL_LIB.${name}`, 'code must declare a function with the same name');
    if (!balanced(code)) fail(`GLSL_LIB.${name}`, 'unbalanced brackets');
    for (const ref of code.match(/\bpt_[A-Za-z0-9_]+/g) || []) {
        if (!GLSL_LIB[ref]) fail(`GLSL_LIB.${name}`, `references unknown ${ref}`);
    }
    const collected = collectLibrary(`${name}()`);
    if (!collected.includes(code)) fail(`GLSL_LIB.${name}`, 'collectLibrary does not include it');
}

const byCategory = {};
for (const def of Object.values(NodeDefinitions)) byCategory[def.category] = (byCategory[def.category] || 0) + 1;

if (failures.length) {
    console.error(`\n${failures.length} problem(s) in ${checked} definitions:\n`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
console.log(`OK: ${checked} node definitions, ${Object.keys(GLSL_LIB).length} GLSL library functions, ${amountNodes.length} effects with an amount input.`);
console.log(NODE_CATEGORIES.map(c => `${c}: ${byCategory[c] || 0}`).join('  '));
