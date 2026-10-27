/**
 * JS twins (def.evaluate) for the hand-written definitions in NodeDefinitions.js
 * (library nodes declare theirs with libNode `js`). With a twin a node can run at
 * control rate when its inputs are CPU values (see rates.js); none of this changes
 * the GLSL these nodes generate.
 *
 * evaluate(node, values, types, ctx) -> { [outputName]: value }
 * controlDefault(node, input, env) -> JS value of an unconnected input
 */
import { cast } from './vmath.js';

const n = (v, fb = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const asFloat = (v, t) => cast(v, t || (Array.isArray(v) ? `vec${v.length}` : typeof v === 'boolean' ? 'bool' : 'float'), 'float');

/** Vec2 / Vec3 / Vec4: components from inputs, else data.x / y / z / w. */
function vecTwin(size, fallback) {
    const keys = ['x', 'y', 'z', 'w'].slice(0, size);
    return {
        controlDefault: (node, input) => n(node.data && node.data[input.name], fallback[keys.indexOf(input.name)] ?? 0),
        evaluate: (node, values, types) => ({ out: keys.map((k, i) => asFloat(values[k] ?? fallback[i], types[k])) })
    };
}

export const LEGACY_TWINS = {
    Float: { evaluate: (node) => ({ out: n(node.data.value, 1) }) },
    Int: { evaluate: (node) => ({ out: Math.floor(n(node.data.value, 0)) }) },
    Bool: { evaluate: (node) => ({ out: !!node.data.value }) },
    Vec2: vecTwin(2, [0, 0]),
    Vec3: vecTwin(3, [1, 0.5, 0]),
    Vec4: vecTwin(4, [1, 0, 0, 1]),
    Color: { evaluate: (node) => ({ color: [n(node.data.r, 1), n(node.data.g, 0.5), n(node.data.b, 0)] }) },
    // cpuSource: per-frame values, so math on them runs once per frame on the CPU
    Time: { cpuSource: true, evaluate: (node, v, t, ctx) => ({ [node.outputs[0] ? node.outputs[0].name : 'time']: ctx.u.time }) },
    Mouse: { cpuSource: true, evaluate: (node, v, t, ctx) => ({ [node.outputs[0] ? node.outputs[0].name : 'mouse']: (ctx.mouse || [0.5, 0.5]).slice() }) },
    Pi: { evaluate: () => ({ pi: 3.14159265, tau: 6.28318531 }) },
    Map: {
        evaluate: (node, values, types) => {
            const d = node.data || {};
            const x = asFloat(values.value, types.value);
            const inMin = n(d.inMin, 0), inMax = n(d.inMax, 1), outMin = n(d.outMin, 0), outMax = n(d.outMax, 1);
            // Same 4-decimal constants as the GLSL (toFixed(4))
            const f4 = (k) => +k.toFixed(4);
            const inRange = inMax - inMin, outRange = outMax - outMin;
            let y = Math.abs(inRange) < 0.0001 ? f4(outMin) : ((x - f4(inMin)) / f4(inRange) * f4(outRange) + f4(outMin));
            if (d.clip) y = Math.min(Math.max(y, f4(Math.min(outMin, outMax))), f4(Math.max(outMin, outMax)));
            return { out: y };
        }
    },
    FloatToVec3: {
        evaluate: (node, values, types) => {
            const f = asFloat(values.f, types.f);
            return { out: [f, f, f] };
        }
    },
    Vec3ToVec4: {
        evaluate: (node, values, types) => {
            const rgb = cast(values.rgb, types.rgb || (Array.isArray(values.rgb) ? `vec${values.rgb.length}` : 'float'), 'vec3');
            return { out: [rgb[0], rgb[1], rgb[2], asFloat(values.a, types.a)] };
        }
    }
};

/** Attach the twins (never overrides an existing evaluate). */
export function installControlTwins(defs) {
    for (const [name, twin] of Object.entries(LEGACY_TWINS)) {
        const def = defs[name];
        if (!def || typeof def.evaluate === 'function') continue;
        def.evaluate = twin.evaluate;
        if (twin.controlDefault) def.controlDefault = twin.controlDefault;
        if (twin.cpuSource) def.cpuSource = true;
    }
}
