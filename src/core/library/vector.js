/**
 * Vector nodes: products, lengths, construction / destructuring, swizzles.
 */
import { libNode, SIZES, cast } from './define.js';
import { dot, cross, length, distance, reflect, refract, cast as jsCast } from '../control/vmath.js';

// `js` = the control-rate twin of each GLSL expression (see define.js).

const C = 'vector';
const VEC_TYPES = ['vec2', 'vec3', 'vec4'];

export const VectorNodes = {
    'Dot': libNode({
        category: C,
        description: 'Dot product of a and b (cosine of the angle times lengths).',
        inputs: [
            { name: 'a', type: 'T', default: '1.0' },
            { name: 'b', type: 'T', default: '1.0' }
        ],
        outputs: [{ name: 'out', type: 'float' }],
        expr: I => `dot(${I.a}, ${I.b})`,
        js: I => dot(I.a, I.b)
    }),

    'Cross': libNode({
        category: C,
        description: 'Cross product of two 3D vectors (perpendicular to both).',
        inputs: [
            { name: 'a', type: 'vec3', default: 'vec3(1.0, 0.0, 0.0)' },
            { name: 'b', type: 'vec3', default: 'vec3(0.0, 1.0, 0.0)' }
        ],
        outputs: [{ name: 'out', type: 'vec3' }],
        expr: I => `cross(${I.a}, ${I.b})`,
        js: I => cross(I.a, I.b)
    }),

    'Normalize': libNode({
        category: C,
        description: 'Scales a vector to length 1 (zero vectors stay zero).',
        inputs: [{ name: 'v', type: 'T', default: '1.0' }],
        outputs: [{ name: 'out', type: 'T' }],
        genDefault: 'vec3',
        expr: I => `${I.v} / max(length(${I.v}), 1e-8)`,
        js: I => {
            const l = Math.max(length(I.v), 1e-8);
            return Array.isArray(I.v) ? I.v.map(x => x / l) : I.v / l;
        }
    }),

    'Distance': libNode({
        category: C,
        description: 'Euclidean distance between points a and b.',
        inputs: [
            { name: 'a', type: 'T', default: '0.0' },
            { name: 'b', type: 'T', default: '0.5' }
        ],
        outputs: [{ name: 'out', type: 'float' }],
        expr: I => `distance(${I.a}, ${I.b})`,
        js: I => distance(I.a, I.b)
    }),

    'Reflect': libNode({
        category: C,
        description: 'Reflects incident direction i around normal n (n should be normalized).',
        inputs: [
            { name: 'i', type: 'T', default: '0.0' },
            { name: 'n', type: 'T', default: '0.0' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        genDefault: 'vec3',
        expr: I => `reflect(${I.i}, ${I.n})`,
        js: I => reflect(I.i, I.n)
    }),

    'Refract': libNode({
        category: C,
        description: 'Refracts incident direction i through a surface with normal n and index ratio eta (e.g. 1/1.33).',
        inputs: [
            { name: 'i', type: 'T', default: '0.0' },
            { name: 'n', type: 'T', default: '0.0' },
            { name: 'eta', type: 'float', default: '0.75' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        genDefault: 'vec3',
        expr: I => `refract(${I.i}, ${I.n}, ${I.eta})`,
        js: I => refract(I.i, I.n, I.eta)
    }),

    'Split': libNode({
        category: C,
        description: 'Splits a vector (or color) into its x, y, z, w components. Missing components read 0 (w reads 1).',
        inputs: [{ name: 'v', type: 'any', cast: 'vec4', default: 'vec4(0.0, 0.0, 0.0, 1.0)', defaultType: 'vec4' }],
        outputs: [
            { name: 'x', type: 'float' },
            { name: 'y', type: 'float' },
            { name: 'z', type: 'float' },
            { name: 'w', type: 'float' }
        ],
        body: (I, { v }) => ({
            code: `vec4 ${v}_v = ${I.v};`,
            out: { x: `${v}_v.x`, y: `${v}_v.y`, z: `${v}_v.z`, w: `${v}_v.w` }
        }),
        js: I => ({ x: I.v[0], y: I.v[1], z: I.v[2], w: I.v[3] })
    }),

    'MakeVec2': libNode({
        category: C,
        description: 'Builds a vec2 from two floats.',
        inputs: [
            { name: 'x', type: 'float', default: '0.0' },
            { name: 'y', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'out', type: 'vec2' }],
        expr: I => `vec2(${I.x}, ${I.y})`,
        js: I => [I.x, I.y]
    }),

    'MakeVec3': libNode({
        category: C,
        description: 'Builds a vec3 (e.g. an RGB color or 3D point) from three floats.',
        inputs: [
            { name: 'x', type: 'float', default: '0.0' },
            { name: 'y', type: 'float', default: '0.0' },
            { name: 'z', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'out', type: 'vec3' }],
        expr: I => `vec3(${I.x}, ${I.y}, ${I.z})`,
        js: I => [I.x, I.y, I.z]
    }),

    'MakeVec4': libNode({
        category: C,
        description: 'Builds a vec4 (e.g. an RGBA color) from four floats.',
        inputs: [
            { name: 'x', type: 'float', default: '0.0' },
            { name: 'y', type: 'float', default: '0.0' },
            { name: 'z', type: 'float', default: '0.0' },
            { name: 'w', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'out', type: 'vec4' }],
        expr: I => `vec4(${I.x}, ${I.y}, ${I.z}, ${I.w})`,
        js: I => [I.x, I.y, I.z, I.w]
    }),

    'Swizzle': libNode({
        category: C,
        description: 'Reorders / picks vector components with a mask such as "xy", "zyx", "rgb" or "xxx" (data.mask). Components past the input size read 0 (w reads 1).',
        inputs: [{ name: 'v', type: 'T', default: '0.0' }],
        outputs: [{ name: 'out', type: 'any' }],
        textFields: [{ key: 'mask', label: 'mask', default: 'xyz' }],
        genDefault: 'vec4',
        validate(node) {
            const mask = String(node.data && node.data.mask !== undefined ? node.data.mask : 'xyz').trim();
            if (!/^([xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/.test(mask)) {
                return { valid: false, error: `invalid swizzle mask "${mask}" (use 1-4 of xyzw, rgba or stpq)` };
            }
            return { valid: true, outputTypes: [mask.length === 1 ? 'float' : `vec${mask.length}`] };
        },
        body: (I, ctx) => {
            const mask = String(ctx.data.mask !== undefined ? ctx.data.mask : 'xyz').trim();
            ctx.outTypes = { out: mask.length === 1 ? 'float' : `vec${mask.length}` };
            const index = c => 'xyzwrgbastpq'.indexOf(c) % 4;
            const size = SIZES[ctx.T];
            let value;
            if (size === 1 && [...mask].every(c => index(c) === 0)) {
                // GLSL ES cannot swizzle scalars: broadcast instead
                value = mask.length === 1 ? I.v : `vec${mask.length}(${I.v})`;
            } else {
                const src = [...mask].some(c => index(c) >= size) ? cast(I.v, ctx.T, 'vec4') : I.v;
                value = `${/^[A-Za-z_][\w.]*$/.test(src) ? src : `(${src})`}.${mask}`;
            }
            return { out: { out: value } };
        },
        js: (I, ctx) => {
            const mask = String(ctx.data.mask !== undefined ? ctx.data.mask : 'xyz').trim();
            const index = c => 'xyzwrgbastpq'.indexOf(c) % 4;
            const v = jsCast(I.v, ctx.T, 'vec4');
            const out = [...mask].map(c => v[index(c)]);
            return out.length === 1 ? out[0] : out;
        }
    }),

    'Rotate2D': libNode({
        category: C,
        description: 'Rotates a 2D vector around the origin by angle (radians, counter-clockwise).',
        inputs: [
            { name: 'v', type: 'vec2', default: 'vec2(1.0, 0.0)' },
            { name: 'angle', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'out', type: 'vec2' }],
        expr: I => `pt_rot2(${I.angle}) * ${I.v}`,
        js: I => {
            const c = Math.cos(I.angle), s = Math.sin(I.angle);
            return [c * I.v[0] - s * I.v[1], s * I.v[0] + c * I.v[1]];
        }
    })
};

/** Generic replacement for the original vec2-only Length node. */
export const LegacyVectorOverrides = {
    'Length': libNode({
        category: C,
        description: 'Length (magnitude) of a vector; absolute value for floats.',
        inputs: [{ name: 'v', type: 'T', default: '0.0' }],
        outputs: [{ name: 'out', type: 'float' }],
        expr: I => `length(${I.v})`,
        js: I => length(I.v)
    })
};

export { VEC_TYPES };
