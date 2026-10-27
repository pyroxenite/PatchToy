/**
 * Math nodes. All are genType-generic (float / vec2 / vec3 / vec4): the output
 * type follows the widest connected generic input; unconnected values are
 * broadcast. Inputs marked scalar keep a float when GLSL has a scalar overload.
 */
import { libNode, unaryNode, binaryNode, binaryMap } from './define.js';
import { fract, mod, clamp, mix, step, smoothstep, sign, roundHalfAway, map3 } from '../control/vmath.js';

// `js` = the control-rate twin of each GLSL expression (same semantics), see define.js.

const C = 'math';

export const MathNodes = {
    'Abs': unaryNode(C, 'Absolute value |x|, per component.', 'abs', { js: Math.abs }),
    'Negate': unaryNode(C, 'Negates the input: -x.', x => `-${x}`, { js: x => -x }),
    'OneMinus': unaryNode(C, 'Returns 1 - x (inverts a 0..1 value).', x => `1.0 - ${x}`, { js: x => 1 - x }),
    'Floor': unaryNode(C, 'Rounds down to the nearest integer, per component.', 'floor', { js: Math.floor }),
    'Ceil': unaryNode(C, 'Rounds up to the nearest integer, per component.', 'ceil', { js: Math.ceil }),
    'Round': unaryNode(C, 'Rounds to the nearest integer, per component.', 'round', { js: roundHalfAway }),
    'Fract': unaryNode(C, 'Fractional part x - floor(x); repeats a value in 0..1.', 'fract', { js: fract }),
    'Sign': unaryNode(C, 'Sign of x: -1, 0 or 1, per component.', 'sign', { js: sign }),
    'Saturate': unaryNode(C, 'Clamps the input to the 0..1 range.', x => `clamp(${x}, 0.0, 1.0)`, { js: x => clamp(x, 0, 1) }),
    'Sqrt': unaryNode(C, 'Square root (negative inputs are treated as 0).', x => `sqrt(max(${x}, 0.0))`, { js: x => Math.sqrt(Math.max(x, 0)) }),
    'Exp': unaryNode(C, 'Natural exponent e^x.', 'exp', { js: Math.exp }),
    'Log': unaryNode(C, 'Natural logarithm (inputs are clamped to a tiny positive value).', x => `log(max(${x}, 1e-8))`, { default: '1.0', js: x => Math.log(Math.max(x, 1e-8)) }),
    'Tan': unaryNode(C, 'Tangent of an angle in radians.', 'tan', { js: Math.tan }),
    'Asin': unaryNode(C, 'Arc sine in radians (input clamped to -1..1).', x => `asin(clamp(${x}, -1.0, 1.0))`, { js: x => Math.asin(clamp(x, -1, 1)) }),
    'Acos': unaryNode(C, 'Arc cosine in radians (input clamped to -1..1).', x => `acos(clamp(${x}, -1.0, 1.0))`, { js: x => Math.acos(clamp(x, -1, 1)) }),

    'Atan2': libNode({
        category: C,
        description: 'Angle in radians (-pi..pi) of the point (x, y): atan(y, x).',
        inputs: [
            { name: 'y', type: 'T', default: '0.0' },
            { name: 'x', type: 'T', default: '1.0' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        expr: I => `atan(${I.y}, ${I.x})`,
        js: I => binaryMap(I.y, I.x, Math.atan2)
    }),

    'Pow': binaryNode(C, 'Raises a to the power b (negative bases are clamped to 0).', (a, b) => `pow(max(${a}, 0.0), ${b})`, { a: '1.0', b: '2.0', js: (a, b) => Math.pow(Math.max(a, 0), b) }),
    'Mod': binaryNode(C, 'Modulo a mod b (always positive for positive b); repeats a value every b.', 'mod', { a: '0.0', b: '1.0', scalarB: true, js: mod }),
    'Min': binaryNode(C, 'Smaller of a and b, per component.', 'min', { a: '0.0', b: '1.0', scalarB: true, js: Math.min }),
    'Max': binaryNode(C, 'Larger of a and b, per component.', 'max', { a: '0.0', b: '1.0', scalarB: true, js: Math.max }),

    'Clamp': libNode({
        category: C,
        description: 'Limits x to the range [min, max].',
        inputs: [
            { name: 'x', type: 'T', default: '0.5' },
            { name: 'min', type: 'T', default: '0.0', scalar: true },
            { name: 'max', type: 'T', default: '1.0', scalar: true }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        expr: I => `clamp(${I.x}, ${I.min}, ${I.max})`,
        js: I => map3(I.x, I.min, I.max, clamp)
    }),

    'Step': libNode({
        category: C,
        description: 'Hard threshold: 0 where x < edge, 1 otherwise.',
        inputs: [
            { name: 'edge', type: 'T', default: '0.5', scalar: true },
            { name: 'x', type: 'T', default: '0.0' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        expr: I => `step(${I.edge}, ${I.x})`,
        js: I => binaryMap(I.edge, I.x, step)
    }),

    'Remap': libNode({
        category: C,
        description: 'Linearly remaps x from [inMin, inMax] to [outMin, outMax] (no clamping).',
        inputs: [
            { name: 'x', type: 'T', default: '0.5' },
            { name: 'inMin', type: 'T', default: '0.0' },
            { name: 'inMax', type: 'T', default: '1.0' },
            { name: 'outMin', type: 'T', default: '0.0' },
            { name: 'outMax', type: 'T', default: '1.0' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        expr: I => `${I.outMin} + (${I.x} - ${I.inMin}) / (${I.inMax} - ${I.inMin} + 1e-9) * (${I.outMax} - ${I.outMin})`,
        js: I => {
            const f = (x, a, b, c, d) => c + (x - a) / (b - a + 1e-9) * (d - c);
            const v = [I.x, I.inMin, I.inMax, I.outMin, I.outMax];
            const n = Math.max(...v.map(x => (Array.isArray(x) ? x.length : 1)));
            if (n === 1) return f(...v);
            return Array.from({ length: n }, (_, k) => f(...v.map(x => (Array.isArray(x) ? (x[k] ?? 0) : x))));
        }
    }),

    'Oscillator': libNode({
        category: C,
        description: 'Sine wave over time: offset + amplitude * sin(2pi * (t * frequency + phase)). Output in [offset-amplitude, offset+amplitude].',
        inputs: [
            { name: 't', type: 'float', default: 'u_time' },
            { name: 'frequency', type: 'float', default: '0.5' },
            { name: 'amplitude', type: 'float', default: '0.5' },
            { name: 'offset', type: 'float', default: '0.5' },
            { name: 'phase', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'out', type: 'float' }],
        expr: I => `${I.offset} + ${I.amplitude} * sin(6.2831853 * (${I.t} * ${I.frequency} + ${I.phase}))`,
        js: I => I.offset + I.amplitude * Math.sin(6.2831853 * (I.t * I.frequency + I.phase))
    })
};

/** Upgraded generic versions of the original float-only math nodes. */
export const LegacyMathOverrides = {
    'Sin': unaryNode(C, 'Sine of an angle in radians, per component.', 'sin', { js: Math.sin }),
    'Cos': unaryNode(C, 'Cosine of an angle in radians, per component.', 'cos', { js: Math.cos }),
    'Mix': libNode({
        category: C,
        description: 'Linear interpolation between a and b: a * (1 - t) + b * t. Works on floats, vectors and colors.',
        inputs: [
            { name: 'a', type: 'T', default: '0.0' },
            { name: 'b', type: 'T', default: '1.0' },
            { name: 't', type: 'T', default: '0.5', scalar: true }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        expr: I => `mix(${I.a}, ${I.b}, ${I.t})`,
        js: I => map3(I.a, I.b, I.t, mix)
    }),
    'Smoothstep': libNode({
        category: C,
        description: 'Smooth Hermite ramp from 0 (x <= edge0) to 1 (x >= edge1).',
        inputs: [
            { name: 'edge0', type: 'T', default: '0.0', scalar: true },
            { name: 'edge1', type: 'T', default: '1.0', scalar: true },
            { name: 'x', type: 'T', default: '0.5' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        expr: I => `smoothstep(${I.edge0}, ${I.edge1}, ${I.x})`,
        js: I => map3(I.edge0, I.edge1, I.x, smoothstep)
    })
};
