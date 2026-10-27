/**
 * 2D shapes as signed distance fields (negative inside, 0 on the edge,
 * positive outside), in UV units. Each shape also outputs an anti-aliased
 * `mask` (1 inside, 0 outside). SDF* operators combine distances and work for
 * both 2D shapes and 3D SDFs (e.g. inside a Raymarch scene).
 */
import { libNode } from './define.js';

const C = 'shape';
const UV = { name: 'uv', type: 'vec2', default: 'pt_uv()', description: 'Coordinates (default: aspect-correct UV, 0.5 = center)' };
const CENTER = { name: 'center', type: 'vec2', default: 'vec2(0.5)' };
const MASK = (v) => `1.0 - smoothstep(-max(fwidth(${v}_d), 1e-5), max(fwidth(${v}_d), 1e-5), ${v}_d)`;

/** Shape helper: dist(I, v) returns the distance expression (may use `${v}_q` = uv - center). */
function shape(description, params, dist, opts = {}) {
    const inputs = opts.legacyOrder ? [UV, ...params, CENTER] : [UV, CENTER, ...params];
    return libNode({
        category: C,
        description,
        inputs: opts.noCenter ? [UV, ...params] : inputs,
        outputs: [
            { name: 'd', type: 'float', description: 'Signed distance (negative inside)' },
            { name: 'mask', type: 'float', description: 'Anti-aliased fill, 1 inside' }
        ],
        body: (I, { v }) => ({
            code: opts.noCenter ? '' : `vec2 ${v}_q = ${I.uv} - ${I.center};`,
            out: { d: dist(I, v), mask: MASK(v) }
        })
    });
}

function op(description, inputs, expr) {
    return libNode({
        category: C,
        description,
        inputs,
        outputs: [{ name: 'd', type: 'float' }],
        expr
    });
}

const A = { name: 'a', type: 'float', default: '1.0' };
const B = { name: 'b', type: 'float', default: '1.0' };
const K = { name: 'k', type: 'float', default: '0.1', description: 'Blend radius' };

export const ShapeNodes = {
    'Rect': shape('Rectangle SDF; size is the full width / height.',
        [{ name: 'size', type: 'vec2', default: 'vec2(0.5, 0.3)' }],
        (I, v) => `pt_sdBox2(${v}_q, ${I.size} * 0.5)`),

    'RoundedRect': shape('Rectangle with rounded corners; size is the full width / height, radius the corner radius.',
        [{ name: 'size', type: 'vec2', default: 'vec2(0.5, 0.3)' }, { name: 'radius', type: 'float', default: '0.05' }],
        (I, v) => `pt_sdBox2(${v}_q, max(${I.size} * 0.5 - vec2(${I.radius}), vec2(0.0))) - ${I.radius}`),

    'Ring': shape('Ring (annulus) SDF: a circle outline of the given radius and width.',
        [{ name: 'radius', type: 'float', default: '0.3' }, { name: 'width', type: 'float', default: '0.05' }],
        (I, v) => `abs(length(${v}_q) - ${I.radius}) - ${I.width} * 0.5`),

    'Segment': shape('Line segment from a to b with the given width (rounded caps).',
        [
            { name: 'a', type: 'vec2', default: 'vec2(0.3, 0.3)' },
            { name: 'b', type: 'vec2', default: 'vec2(0.7, 0.7)' },
            { name: 'width', type: 'float', default: '0.03' }
        ],
        (I) => `pt_sdSegment(${I.uv}, ${I.a}, ${I.b}) - ${I.width} * 0.5`,
        { noCenter: true }),

    'Triangle': shape('Equilateral triangle SDF (pointing up); radius ~ distance from center to the sides.',
        [{ name: 'radius', type: 'float', default: '0.25' }],
        (I, v) => `pt_sdEqTriangle(${v}_q, ${I.radius})`),

    'Hexagon': shape('Regular hexagon SDF; radius = distance from center to the flat sides.',
        [{ name: 'radius', type: 'float', default: '0.25' }],
        (I, v) => `pt_sdHexagon(${v}_q, ${I.radius})`),

    'Star': shape('Star SDF with the given number of points; sharpness from 2 (spiky) up to points (a regular polygon).',
        [
            { name: 'radius', type: 'float', default: '0.3' },
            { name: 'points', type: 'float', default: '5.0' },
            { name: 'sharpness', type: 'float', default: '2.5' }
        ],
        (I, v) => `pt_sdStar(${v}_q, ${I.radius}, ${I.points}, ${I.sharpness})`),

    'Polygon': shape('Regular polygon SDF with the given number of sides.',
        [{ name: 'radius', type: 'float', default: '0.3' }, { name: 'sides', type: 'float', default: '6.0' }],
        (I, v) => `pt_sdStar(${v}_q, ${I.radius}, ${I.sides}, ${I.sides})`),

    'Fill': libNode({
        category: C,
        description: 'Turns a signed distance into a fill mask (1 inside, 0 outside) with an anti-aliased or soft edge.',
        inputs: [
            { name: 'd', type: 'float', default: '0.0' },
            { name: 'softness', type: 'float', default: '0.0', description: '0 = crisp anti-aliased edge' }
        ],
        outputs: [{ name: 'mask', type: 'float' }],
        body: (I, { v }) => ({
            code: `float ${v}_w = max(${I.softness}, max(fwidth(${I.d}), 1e-5));`,
            out: { mask: `1.0 - smoothstep(-${v}_w, ${v}_w, ${I.d})` }
        })
    }),

    'Stroke': libNode({
        category: C,
        description: 'Outline of a signed distance shape: a band of the given width centered on the edge (mask 0..1).',
        inputs: [
            { name: 'd', type: 'float', default: '0.0' },
            { name: 'width', type: 'float', default: '0.01' },
            { name: 'softness', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'mask', type: 'float' }],
        body: (I, { v }) => ({
            code: [
                `float ${v}_e = abs(${I.d}) - ${I.width} * 0.5;`,
                `float ${v}_w = max(${I.softness}, max(fwidth(${v}_e), 1e-5));`
            ].join('\n'),
            out: { mask: `1.0 - smoothstep(-${v}_w, ${v}_w, ${v}_e)` }
        })
    }),

    'SDFUnion': op('Union of two distance fields (2D or 3D): min(a, b).', [A, B], I => `min(${I.a}, ${I.b})`),
    'SDFSubtract': op('Cuts shape b out of shape a (2D or 3D): max(a, -b).', [A, B], I => `max(${I.a}, -${I.b})`),
    'SDFIntersect': op('Intersection of two distance fields (2D or 3D): max(a, b).', [A, B], I => `max(${I.a}, ${I.b})`),
    'SDFSmoothUnion': op('Smooth (blobby) union of two distance fields; k = blend radius.', [A, B, K], I => `pt_smin(${I.a}, ${I.b}, ${I.k})`),
    'SDFSmoothSubtract': op('Smoothly cuts b out of a; k = blend radius.', [A, B, K], I => `pt_smax(${I.a}, -${I.b}, ${I.k})`),
    'SDFSmoothIntersect': op('Smooth intersection of two distance fields; k = blend radius.', [A, B, K], I => `pt_smax(${I.a}, ${I.b}, ${I.k})`),
    'SDFOnion': op('Turns a solid shape into a shell of the given thickness: abs(d) - thickness.',
        [{ name: 'd', type: 'float', default: '0.0' }, { name: 'thickness', type: 'float', default: '0.02' }],
        I => `abs(${I.d}) - ${I.thickness}`),
    'SDFRound': op('Inflates / rounds a shape by radius: d - radius.',
        [{ name: 'd', type: 'float', default: '0.0' }, { name: 'radius', type: 'float', default: '0.02' }],
        I => `${I.d} - ${I.radius}`)
};

/** The original Circle node, upgraded (input order kept for saved projects: uv, radius, center). */
export const LegacyShapeOverrides = {
    'Circle': shape('Circle SDF (negative inside) plus an anti-aliased mask.',
        [{ name: 'radius', type: 'float', default: '0.3' }],
        (I, v) => `length(${v}_q) - ${I.radius}`,
        { legacyOrder: true })
};
