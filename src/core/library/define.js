/**
 * Helpers to declare library nodes compactly.
 *
 * libNode(spec) returns a regular NodeDefinitions entry (category, description,
 * inputs, outputs, validateTypes, glsl, ...), so library nodes go through the
 * normal ShaderCompiler path.
 *
 * Spec:
 *   category, description          required
 *   inputs:  [{ name, type, default, defaultType?, scalar?, cast?, description?, functionOf? }]
 *            type 'T'   -> generic (genType): float | vec2 | vec3 | vec4, resolved per node
 *                          from the widest connected generic input. Unconnected values are
 *                          broadcast/cast to T. `scalar: true` keeps a float as float (GLSL
 *                          overloads like mix(vec3, vec3, float)).
 *            type 'any' + cast: 'vec2' -> accepts float or vector, always cast to vec2.
 *            default '@p' -> the 3D sample point: the scene parameter `p` inside a
 *                          Raymarch scene, otherwise a z=0 slice of the screen.
 *   outputs: [{ name, type }]  type 'T' -> generic
 *   expr(I, ctx)  -> GLSL expression for the single output, or
 *   body(I, ctx)  -> { code?, out: { [outputName]: expression }, preamble? }
 *                    ctx = { T, v (unique var prefix), node, compiler, types, data }
 *   genDefault    -> T when nothing generic is connected (default 'float')
 *   textFields    -> [{ key, label, default }] string fields edited on the node (LibraryNode)
 *   js(I, ctx)    -> optional JS twin of expr/body with the same semantics (GLSL mod,
 *                    broadcasting...; helpers in src/core/control/vmath.js). Returns the
 *                    single output's value or { [outputName]: value }. With it the node can
 *                    run at control rate (once per frame on the CPU) when all its inputs are
 *                    CPU values; see src/core/control/rates.js. I holds the inputs already
 *                    cast like the GLSL path does (T broadcast, scalar, cast); ctx = { T, node,
 *                    data, dt, time, u (clock uniforms), state }.
 *
 * Unconnected scalar inputs with numeric defaults become inline editable
 * fields: their value lives in node.data[inputName] (numbers). The compiler
 * also accepts node.data[inputName] = [x, y, (z, w)] or a GLSL literal string
 * such as "vec3(1.0, 0.5, 0.0)" for vector inputs.
 *
 * Shared GLSL functions are referenced by name (pt_*) and collected
 * automatically (see glsl.js); built-in uniforms used by the generated code
 * (u_resolution, u_time, u_mouse, u_camera) are declared automatically.
 */
import { collectLibrary } from './glsl.js';
import { BUILTIN_UNIFORM_TYPES } from '../builtinUniforms.js';
import { cast as jsCast, SIZES as JS_SIZES } from '../control/vmath.js';

export const SCENE_P = '@p';
const SCENE_P_FALLBACK = 'vec3(pt_centeredUV() * 2.0, 0.0)';
const BUILTIN_UNIFORMS = Object.keys(BUILTIN_UNIFORM_TYPES); // u_time, u_resolution, ..., u_beat, u_bass

export const SIZES = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4 };
const BY_SIZE = { 1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4' };

/** Format a JS number as a GLSL float literal. */
export function glslFloat(x) {
    if (!Number.isFinite(x)) return '0.0';
    let s = String(x);
    if (!/[.eE]/.test(s)) s += '.0';
    return s;
}

export function isNumericLiteral(s) {
    return typeof s === 'string' && /^-?\d+(\.\d*)?([eE][-+]?\d+)?$/.test(s.trim());
}

/** Best-effort GLSL type of an (unconnected) value expression. */
export function literalType(value) {
    if (typeof value !== 'string') return 'float';
    const v = value.trim();
    const m = v.match(/^(vec[234]|float|int|bool)\s*\(/);
    if (m) return m[1];
    if (v === 'true' || v === 'false') return 'bool';
    if (/^-?\d+$/.test(v)) return 'float'; // int-looking literals in float slots
    return 'float';
}

const wrap = v => (/^[A-Za-z_][\w.]*$/.test(v) ? v : `(${v})`);

/** Cast a GLSL expression between float/int/bool/vecN (scalar broadcast, zero padding). */
export function cast(value, from, to) {
    if (!to || !from || from === to) return value;
    if (from === 'int' || from === 'bool') {
        value = `float(${value})`;
        from = 'float';
        if (to === 'float') return value;
    }
    if (to === 'int') return from === 'float' ? `int(${value})` : `int(${wrap(value)}.x)`;
    if (to === 'bool') return from === 'float' ? `(${value} > 0.5)` : `(${wrap(value)}.x > 0.5)`;
    if (from === 'float') return to === 'float' ? value : `${to}(${value})`;
    const fs = SIZES[from];
    const ts = SIZES[to];
    if (!fs || !ts) return value;
    if (ts === 1) return `${wrap(value)}.x`;
    if (ts < fs) return `${wrap(value)}.${'xyzw'.slice(0, ts)}`;
    const pad = [];
    for (let k = fs; k < ts; k++) pad.push(k === 3 ? '1.0' : '0.0');
    return `${to}(${value}, ${pad.join(', ')})`;
}

/** Type of an unconnected input, honoring inline data values. */
function unconnectedType(node, input) {
    const d = node.data ? node.data[input.name] : undefined;
    if (Array.isArray(d) && d.length >= 2 && d.length <= 4) return BY_SIZE[d.length];
    if (typeof d === 'string' && /^(vec[234])\s*\(/.test(d.trim())) return literalType(d);
    if (typeof d === 'number') return 'float';
    return input.defaultType || literalType(input.default);
}

function uniformsIn(code) {
    return BUILTIN_UNIFORMS.filter(u => new RegExp(`\\b${u}\\b`).test(code));
}

/** Type of a plain JS input value (unconnected inputs). */
function valueType(v) {
    if (typeof v === 'boolean') return 'bool';
    if (Array.isArray(v) && v.length >= 2 && v.length <= 4) return `vec${v.length}`;
    return 'float';
}

/**
 * Build a node definition from a compact spec (see file header).
 */
export function libNode(spec) {
    const {
        category, description, inputs = [], outputs = [], expr, body,
        genDefault = 'float', textFields, validate, data: extraData, js, ...rest
    } = spec;

    if (!expr && !body) throw new Error(`libNode(${description}): needs expr or body`);

    const defInputs = inputs.map(i => {
        const out = { name: i.name, type: i.type === 'T' ? 'any' : i.type, default: i.default };
        if (i.type === 'T') out.generic = true;
        for (const k of ['description', 'functionOf', 'defaultNode', 'cast', 'scalar', 'min', 'max', 'rate', 'cpuInput', 'options']) {
            if (i[k] !== undefined) out[k] = i[k];
        }
        return out;
    });
    const defOutputs = outputs.map(o => {
        const out = { name: o.name, type: o.type === 'T' ? 'any' : o.type };
        if (o.type === 'T') out.generic = true;
        if (o.description) out.description = o.description;
        return out;
    });

    // Inline-editable numeric defaults for scalar inputs
    const data = {};
    for (const i of inputs) {
        const scalarSlot = i.type === 'float' || i.type === 'int' || i.type === 'T' || (i.type === 'any' && i.cast);
        if (scalarSlot && isNumericLiteral(i.default) && i.inline !== false) {
            data[i.name] = parseFloat(i.default);
        }
    }
    for (const f of textFields || []) data[f.key] = f.default;
    Object.assign(data, extraData || {});
    const hasInline = Object.keys(data).some(k => typeof data[k] === 'number');

    const genericInputs = inputs.filter(i => i.type === 'T');

    const def = {
        category,
        description,
        inputs: defInputs,
        outputs: defOutputs,
        ...rest,
        isLibraryNode: true,
        inlineInputs: true,
        validateTypes(node, inputTypes, compiler) {
            let best = 0;
            const sizesSeen = new Set();
            for (const i of genericInputs) {
                let t = inputTypes[i.name];
                if (!t) {
                    t = unconnectedType(node, i);
                    if (!(SIZES[t] > 1)) continue; // unconnected scalars don't drive T
                }
                if (!(t in SIZES)) {
                    return { valid: false, error: `input '${i.name}' expects float or vec2/3/4, got ${t}` };
                }
                if (i.scalar && SIZES[t] === 1) continue;
                best = Math.max(best, SIZES[t]);
                if (SIZES[t] > 1) sizesSeen.add(SIZES[t]);
            }
            for (const i of inputs) {
                const t = inputTypes[i.name];
                if (i.type === 'any' && i.cast && t && !(t in SIZES)) {
                    return { valid: false, error: `input '${i.name}' expects float or vector, got ${t}` };
                }
            }
            if (sizesSeen.size > 1 && compiler && compiler.addWarning) {
                compiler.addWarning(`${node.type}: mixing vector sizes, smaller vectors are padded with zeros`);
            }
            const T = best ? BY_SIZE[best] : genDefault;
            node._ptT = T;
            node._ptInTypes = { ...inputTypes };
            if (validate) {
                const extra = validate(node, inputTypes, T);
                if (extra && extra.valid === false) return extra;
                if (extra && extra.outputTypes) return { valid: true, outputTypes: extra.outputTypes };
            }
            return { valid: true, outputTypes: outputs.map(o => (o.type === 'T' ? T : o.type)) };
        },
        glsl(node, inputValues, compiler) {
            const T = node._ptT || genDefault;
            const types = node._ptInTypes || {};
            const I = {};
            for (const i of inputs) {
                let value = inputValues[i.name];
                if (value === SCENE_P) {
                    value = (compiler && compiler.getLambdaParam && compiler.getLambdaParam('p')) || SCENE_P_FALLBACK;
                }
                const from = types[i.name] || (value === inputValues[i.name] ? unconnectedType(node, i) : 'vec3');
                if (i.type === 'T') {
                    if (i.scalar && SIZES[from] === 1) value = cast(value, from, 'float');
                    else value = cast(value, from, T);
                } else if (i.type === 'any' && i.cast) {
                    value = cast(value, from, i.cast);
                } else if (compiler && compiler.usedStructs && /^[A-Z]/.test(i.type) && !types[i.name]) {
                    compiler.usedStructs.add(i.type); // struct-typed default constructor
                }
                I[i.name] = value;
            }

            const v = node.varName;
            const ctx = { T, v, node, compiler, types, data: node.data || {} };
            const outType = o => (o.type === 'T' ? T : (ctx.outTypes && ctx.outTypes[o.name]) || o.type);

            let code = '';
            let extraPreamble = '';
            let outExprs;
            if (expr) {
                outExprs = { [outputs[0].name]: expr(I, ctx) };
            } else {
                const r = body(I, ctx) || {};
                code = r.code || '';
                extraPreamble = r.preamble || '';
                outExprs = r.out || {};
            }
            if (ctx.outTypes) {
                // body may override output types (e.g. Swizzle)
                for (let k = 0; k < outputs.length; k++) {
                    if (ctx.outTypes[outputs[k].name] && node.outputs[k]) node.outputs[k].type = ctx.outTypes[outputs[k].name];
                }
            }

            let decl = '';
            let output;
            if (outputs.length === 1) {
                decl = `${outType(outputs[0])} ${v} = ${outExprs[outputs[0].name]};`;
                output = v;
            } else {
                const outputVars = {};
                const lines = [];
                for (const o of outputs) {
                    const name = `${v}_${o.name}`;
                    lines.push(`${outType(o)} ${name} = ${outExprs[o.name]};`);
                    outputVars[o.name] = name;
                }
                decl = lines.join('\n');
                node.outputVars = outputVars;
                output = outputVars[outputs[0].name];
            }

            const fullCode = code ? `${code}\n${decl}` : decl;
            const libCode = collectLibrary(`${fullCode}\n${extraPreamble}`);
            const preamble = [libCode, extraPreamble].filter(Boolean).join('\n\n');
            const uniforms = uniformsIn(`${fullCode}\n${preamble}`);

            return { code: fullCode, output, preamble: preamble || undefined, uniforms };
        }
    };
    if (typeof js === 'function') {
        /**
         * Control-rate evaluation (src/core/control/ControlRuntime.js). values / types:
         * input name -> JS value and its type (types[name] is null for unconnected inputs).
         * ctx.T is the generic type the rate plan resolved with validateTypes().
         */
        def.castControlInputs = function (values, types, T) {
            const I = {};
            for (const i of inputs) {
                let value = values[i.name];
                const from = types[i.name] || valueType(value);
                if (i.type === 'T') value = (i.scalar && JS_SIZES[from] === 1) ? jsCast(value, from, 'float') : jsCast(value, from, T);
                else if (i.type === 'any' && i.cast) value = jsCast(value, from, i.cast);
                else if (i.type !== 'any') value = jsCast(value, from, i.type);
                I[i.name] = value;
            }
            return I;
        };
        def.evaluate = function (node, values, types, ctx) {
            const T = ctx.T || genDefault;
            const I = def.castControlInputs(values, types, T);
            const out = js(I, { ...ctx, T, node, data: node.data || {} });
            if (outputs.length === 1 && !(out && typeof out === 'object' && !Array.isArray(out) && outputs[0].name in out)) {
                return { [outputs[0].name]: out };
            }
            return out || {};
        };
    }
    if (hasInline || (textFields && textFields.length)) {
        def.hasInputFields = true;
        def.data = data;
    }
    if (textFields) def.textFields = textFields;
    return def;
}

// ----------------------------------------------------------------------
// Shorthands
// ----------------------------------------------------------------------

/** Generic unary function node: result = fn(x). */
export function unaryNode(category, description, fn, opts = {}) {
    const jsFn = opts.js;
    return libNode({
        category,
        description,
        inputs: [{ name: 'x', type: 'T', default: opts.default || '0.0' }],
        outputs: [{ name: 'out', type: 'T' }],
        expr: I => (typeof fn === 'function' ? fn(I.x) : `${fn}(${I.x})`),
        ...(jsFn ? { js: I => (Array.isArray(I.x) ? I.x.map(jsFn) : jsFn(I.x)) } : {}),
        ...opts.extra
    });
}

/** Generic binary node: result = fn(a, b). */
export function binaryNode(category, description, fn, opts = {}) {
    return libNode({
        category,
        description,
        inputs: [
            { name: 'a', type: 'T', default: opts.a || '0.0' },
            { name: 'b', type: 'T', default: opts.b || '1.0', scalar: !!opts.scalarB }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        expr: I => (typeof fn === 'function' ? fn(I.a, I.b) : `${fn}(${I.a}, ${I.b})`),
        ...(opts.js ? { js: I => binaryMap(I.a, I.b, opts.js) } : {}),
        ...opts.extra
    });
}

/** Component-wise f(a, b) with scalar broadcast (control-rate twin of binary GLSL functions). */
export function binaryMap(a, b, f) {
    const aa = Array.isArray(a), ba = Array.isArray(b);
    if (!aa && !ba) return f(a, b);
    const n = Math.max(aa ? a.length : 1, ba ? b.length : 1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = f(aa ? (a[i] ?? 0) : a, ba ? (b[i] ?? 0) : b);
    return out;
}
