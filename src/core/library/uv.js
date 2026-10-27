/**
 * UV & transform nodes. They work in "UV space": (0.5, 0.5) is the center of
 * the frame and the short axis spans 0..1 (the default `uv` is aspect-correct,
 * like the UV node's "contain" mode). Transforms happen around `center`.
 *
 * Every transform / distortion has a trailing `amount` input (0 = uv passes
 * through unchanged, 1 = full effect); see amount.js.
 */
import { libNode } from './define.js';
import { effectNode } from './amount.js';

const C = 'uv';
const UV = { name: 'uv', type: 'vec2', default: 'pt_uv()', description: 'Coordinates (default: aspect-correct UV, 0.5 = center)' };
const CENTER = { name: 'center', type: 'vec2', default: 'vec2(0.5)' };

export const UVNodes = {
    'CenteredUV': libNode({
        category: C,
        description: 'Screen coordinates: p is centered at (0,0) with y in -1..1 (for raymarching / math), uv is aspect-correct 0..1, aspect = width / height.',
        inputs: [],
        outputs: [
            { name: 'p', type: 'vec2' },
            { name: 'uv', type: 'vec2' },
            { name: 'aspect', type: 'float' }
        ],
        body: () => ({ out: { p: 'pt_centeredUV()', uv: 'pt_uv()', aspect: 'u_resolution.x / u_resolution.y' } })
    }),

    'PolarCoords': libNode({
        category: C,
        description: 'Converts uv to polar coordinates around center: angle (radians, -pi..pi), radius, and polar = vec2(angle as 0..1, radius).',
        inputs: [UV, CENTER],
        outputs: [
            { name: 'polar', type: 'vec2' },
            { name: 'angle', type: 'float' },
            { name: 'radius', type: 'float' }
        ],
        body: (I, { v }) => ({
            code: `vec2 ${v}_d = ${I.uv} - ${I.center};`,
            out: {
                polar: `vec2(atan(${v}_d.y, ${v}_d.x) / 6.2831853 + 0.5, length(${v}_d))`,
                angle: `atan(${v}_d.y, ${v}_d.x)`,
                radius: `length(${v}_d)`
            }
        })
    }),

    'RotateUV': effectNode({
        category: C,
        description: 'Rotates coordinates around center by angle (radians, counter-clockwise). amount scales the angle (0 = no rotation).',
        inputs: [UV, { name: 'angle', type: 'float', default: '0.785' }, CENTER],
        outputs: [{ name: 'uv', type: 'vec2' }],
        full: I => ({ out: { uv: `pt_rot2(-${I.angle}) * (${I.uv} - ${I.center}) + ${I.center}` } }),
        general: (I, ctx, a) => ({ out: { uv: `pt_rot2(-(${I.angle}) * ${a}) * (${I.uv} - ${I.center}) + ${I.center}` } }),
        bypass: I => ({ uv: I.uv }),
        guard: true
    }),

    'ScaleUV': effectNode({
        category: C,
        description: 'Zooms coordinates around center (scale > 1 makes content bigger). Accepts a float or a vec2. amount interpolates the zoom factor in log space (scale^amount; 0 = factor 1).',
        inputs: [UV, { name: 'scale', type: 'any', cast: 'vec2', default: '2.0' }, CENTER],
        outputs: [{ name: 'uv', type: 'vec2' }],
        full: I => ({ out: { uv: `(${I.uv} - ${I.center}) / (${I.scale} + vec2(1e-9)) + ${I.center}` } }),
        general: (I, { v }, a) => ({
            code: [
                `vec2 ${v}_s = ${I.scale};`,
                `vec2 ${v}_sa = max(abs(${v}_s), vec2(1e-9));`,
                // |s|^a written as |s| * |s|^(a-1) so a = 1 is exact; a negative factor flips through 0
                `vec2 ${v}_se = mix(vec2(1.0), sign(${v}_s), min(${a}, 1.0)) * ${v}_sa * pow(${v}_sa, vec2(${a} - 1.0));`
            ].join('\n'),
            out: { uv: `(${I.uv} - ${I.center}) / (${v}_se + vec2(1e-9)) + ${I.center}` }
        }),
        bypass: I => ({ uv: I.uv }),
        guard: true
    }),

    'TranslateUV': effectNode({
        category: C,
        description: 'Moves content by offset (in UV units). amount scales the offset.',
        inputs: [UV, { name: 'offset', type: 'vec2', default: 'vec2(0.1, 0.0)' }],
        outputs: [{ name: 'uv', type: 'vec2' }],
        full: I => ({ out: { uv: `${I.uv} - ${I.offset}` } }),
        general: (I, ctx, a) => ({ out: { uv: `${I.uv} - ${I.offset} * ${a}` } }),
        bypass: I => ({ uv: I.uv })
    }),

    'TileUV': effectNode({
        category: C,
        description: 'Repeats space in a grid: uv is the 0..1 position inside each tile, cell the integer tile index, id a random 0..1 value per tile. amount grows the tile count continuously from 1 to count while the tiles fold together (0 = uv passes through unchanged).',
        inputs: [UV, { name: 'count', type: 'any', cast: 'vec2', default: '4.0' }],
        outputs: [
            { name: 'uv', type: 'vec2' },
            { name: 'cell', type: 'vec2' },
            { name: 'id', type: 'float' }
        ],
        full: (I, { v }) => ({
            code: `vec2 ${v}_s = ${I.uv} * ${I.count};`,
            out: { uv: `fract(${v}_s)`, cell: `floor(${v}_s)`, id: `pt_hash12(floor(${v}_s))` }
        }),
        // count_eff = mix(1, count, a); each tile is pulled back onto the first by
        // a fraction a of its offset, so seams grow in continuously
        general: (I, { v }, a) => ({
            code: [
                `vec2 ${v}_s = ${I.uv} * mix(vec2(1.0), ${I.count}, ${a});`,
                `vec2 ${v}_f = floor(${v}_s);`
            ].join('\n'),
            out: { uv: `${v}_s - min(${a}, 1.0) * ${v}_f`, cell: `${v}_f`, id: `pt_hash12(${v}_f)` }
        }),
        bypass: I => ({ uv: I.uv })
    }),

    'MirrorUV': effectNode({
        category: C,
        description: 'Mirrors coordinates around center. axis = (1,0) mirrors left/right, (0,1) top/bottom, (1,1) both. amount sweeps the mirror line in from beyond the frame edge to center (0 = no mirror).',
        inputs: [UV, { name: 'axis', type: 'vec2', default: 'vec2(1.0, 0.0)' }, CENTER],
        outputs: [{ name: 'uv', type: 'vec2' }],
        full: I => ({ out: { uv: `mix(${I.uv}, ${I.center} + abs(${I.uv} - ${I.center}), clamp(${I.axis}, 0.0, 1.0))` } }),
        // The mirror line m moves linearly from the frame edge (a = 0.05) to center
        // (a = 1) and off to infinity as a -> 0. uv + 2 max(m - uv, 0) is exactly
        // uv on the unmirrored side, so there is no precision loss far away.
        general: (I, { v }, a) => ({
            code: [
                `float ${v}_ma = min(${a}, 1.0);`,
                `float ${v}_asp = u_resolution.x / u_resolution.y;`,
                `vec2 ${v}_ext = vec2(0.5 * max(${v}_asp, 1.0), 0.5 * max(1.0 / ${v}_asp, 1.0)) + abs(${I.center} - 0.5);`,
                `vec2 ${v}_m = ${I.center} - ${v}_ext * ((1.0 - ${v}_ma) / max(min(${v}_ma * 20.0, 1.0), 1e-20));`,
                `vec2 ${v}_uv = ${I.uv};`
            ].join('\n'),
            out: { uv: `mix(${v}_uv, ${v}_uv + 2.0 * max(${v}_m - ${v}_uv, 0.0), clamp(${I.axis}, 0.0, 1.0))` }
        }),
        bypass: I => ({ uv: I.uv }),
        guard: true
    }),

    'Kaleidoscope': effectNode({
        category: C,
        description: 'Folds space into mirrored angular segments around center (kaleidoscope). amount grows the number of mirrored wedges continuously (log space) from one unfolded view (0 = uv unchanged) to segments; a partial wedge folds in at the seam, and the angle offset scales in with it.',
        inputs: [UV, { name: 'segments', type: 'float', default: '6.0' }, { name: 'angle', type: 'float', default: '0.0' }, CENTER],
        outputs: [{ name: 'uv', type: 'vec2' }],
        full: (I, { v }) => ({
            code: [
                `vec2 ${v}_d = ${I.uv} - ${I.center};`,
                `float ${v}_seg = 6.2831853 / max(${I.segments}, 1.0);`,
                `float ${v}_a = mod(atan(${v}_d.y, ${v}_d.x) + ${I.angle}, ${v}_seg);`,
                `${v}_a = abs(${v}_a - 0.5 * ${v}_seg);`
            ].join('\n'),
            out: { uv: `${I.center} + length(${v}_d) * vec2(cos(${v}_a), sin(${v}_a))` }
        }),
        // M = number of half-wedges (mirror images) = (2 * segments)^a, in log
        // space so each step adds a similar share of new wedges; each is
        // 2 pi / M wide. M = 1: one wedge = the whole plane (identity). The
        // zigzag of full half-wedge pairs is followed by a tail (what is left of
        // the circle) that folds as a smaller mirror pair, so the angle map stays
        // continuous at the seam and in M. For M < 2 the tail is the first
        // mirror image squeezed into a sliver; it fades in (position blend,
        // weight smoothstep(1, 2, M)) so it doesn't flash in at amount 0+.
        // The phase offset (angle + pi / segments) lines the mirrors up with
        // the original node at a = 1.
        general: (I, { v }, a) => ({
            code: [
                `float ${v}_ka = min(${a}, 1.0);`,
                `float ${v}_n = max(${I.segments}, 1.0);`,
                `float ${v}_M = 2.0 * ${v}_n * pow(2.0 * ${v}_n, ${v}_ka - 1.0);`,
                `float ${v}_w = 6.2831853 / ${v}_M;`,
                `vec2 ${v}_d = ${I.uv} - ${I.center};`,
                `float ${v}_p = mod(atan(${v}_d.y, ${v}_d.x) + ${v}_ka * (${I.angle} + 3.14159265 / ${v}_n), 6.2831853);`,
                `float ${v}_s;`,
                `float ${v}_bw = 1.0;`,
                `if (${v}_M < 2.0) {`,
                `    ${v}_s = ${v}_p < ${v}_w ? ${v}_p : ${v}_w * (6.2831853 - ${v}_p) / max(6.2831853 - ${v}_w, 1e-6);`,
                `    if (${v}_p >= ${v}_w) ${v}_bw = smoothstep(1.0, 2.0, ${v}_M);`,
                `} else {`,
                `    float ${v}_J = 2.0 * floor(0.5 * ${v}_M);`,
                `    float ${v}_t = ${v}_p - ${v}_J * ${v}_w;`,
                `    float ${v}_g = 0.5 * (${v}_M - ${v}_J) * ${v}_w;`,
                `    ${v}_s = ${v}_t < 0.0 ? ${v}_w - abs(mod(${v}_p, 2.0 * ${v}_w) - ${v}_w) : ${v}_g - abs(${v}_t - ${v}_g);`,
                `}`,
                // Fractional segment counts: the original node cuts the last wedge
                // (a seam at angle pi) instead of folding it; cross-fade to that
                // over the last 10% so amount = 1 matches it (integer counts: no-op)
                `float ${v}_fr = fract(${v}_n);`,
                `float ${v}_fb = smoothstep(0.9, 1.0, ${v}_ka) * smoothstep(0.0, 0.02, min(${v}_fr, 1.0 - ${v}_fr));`,
                `if (${v}_fb > 0.0) {`,
                `    float ${v}_seg = 6.2831853 / ${v}_n;`,
                `    ${v}_s = mix(${v}_s, abs(mod(atan(${v}_d.y, ${v}_d.x) + ${I.angle}, ${v}_seg) - 0.5 * ${v}_seg), ${v}_fb);`,
                `}`
            ].join('\n'),
            out: { uv: `${I.center} + length(${v}_d) * mix(vec2(cos(${v}_p), sin(${v}_p)), vec2(cos(${v}_s), sin(${v}_s)), ${v}_bw)` }
        }),
        bypass: I => ({ uv: I.uv }),
        guard: true
    }),

    'Pixelate': effectNode({
        category: C,
        description: 'Snaps coordinates to a grid of cells (blocky / mosaic look). cells = cells per UV unit (float or vec2). amount grows the cell size in log space from one pixel (0 = exact pass-through) to the target.',
        inputs: [UV, { name: 'cells', type: 'any', cast: 'vec2', default: '32.0' }],
        outputs: [{ name: 'uv', type: 'vec2' }],
        full: I => ({ out: { uv: `(floor(${I.uv} * ${I.cells}) + 0.5) / max(${I.cells}, vec2(1e-6))` } }),
        // cells_eff = cells * (pixelCells / cells)^(1 - a), pixelCells = cells per
        // UV unit at one pixel; below 2 px the snap blends back into the raw uv.
        general: (I, { v }, a) => ({
            code: [
                `vec2 ${v}_c = ${I.cells};`,
                `float ${v}_cp = min(u_resolution.x, u_resolution.y);`,
                `vec2 ${v}_ce = ${v}_c * pow(max(vec2(${v}_cp) / max(${v}_c, vec2(1e-6)), vec2(1e-6)), vec2(1.0 - ${a}));`,
                `vec2 ${v}_sn = (floor(${I.uv} * ${v}_ce) + 0.5) / max(${v}_ce, vec2(1e-6));`,
                `float ${v}_w = max(clamp(${v}_cp / max(max(${v}_ce.x, ${v}_ce.y), 1e-6) - 1.0, 0.0, 1.0), step(1.0, ${a}));`
            ].join('\n'),
            out: { uv: `mix(${I.uv}, ${v}_sn, ${v}_w)` }
        }),
        bypass: I => ({ uv: I.uv }),
        guard: true
    }),

    'Twirl': effectNode({
        category: C,
        description: 'Swirls coordinates around center; strength in radians at the center, fading out at radius. amount scales the strength.',
        inputs: [UV, { name: 'strength', type: 'float', default: '3.0' }, { name: 'radius', type: 'float', default: '0.5' }, CENTER],
        outputs: [{ name: 'uv', type: 'vec2' }],
        full: (I, { v }) => ({
            code: [
                `vec2 ${v}_d = ${I.uv} - ${I.center};`,
                `float ${v}_k = 1.0 - smoothstep(0.0, max(${I.radius}, 1e-4), length(${v}_d));`
            ].join('\n'),
            out: { uv: `${I.center} + pt_rot2(${I.strength} * ${v}_k * ${v}_k) * ${v}_d` }
        }),
        general: (I, { v }, a) => ({
            code: [
                `vec2 ${v}_d = ${I.uv} - ${I.center};`,
                `float ${v}_k = 1.0 - smoothstep(0.0, max(${I.radius}, 1e-4), length(${v}_d));`
            ].join('\n'),
            out: { uv: `${I.center} + pt_rot2(${I.strength} * ${a} * ${v}_k * ${v}_k) * ${v}_d` }
        }),
        bypass: I => ({ uv: I.uv }),
        guard: true
    }),

    'WaveUV': effectNode({
        category: C,
        description: 'Wobbles coordinates with sine waves (x shifts by y and vice versa). Animate with t. amount scales the amplitude.',
        inputs: [
            UV,
            { name: 'amplitude', type: 'float', default: '0.02' },
            { name: 'frequency', type: 'float', default: '10.0' },
            { name: 't', type: 'float', default: 'u_time' }
        ],
        outputs: [{ name: 'uv', type: 'vec2' }],
        full: (I, { v }) => ({
            code: `vec2 ${v}_uv = ${I.uv};`,
            out: { uv: `${v}_uv + ${I.amplitude} * sin(${v}_uv.yx * ${I.frequency} + ${I.t})` }
        }),
        general: (I, { v }, a) => ({
            code: `vec2 ${v}_uv = ${I.uv};`,
            out: { uv: `${v}_uv + ${I.amplitude} * ${a} * sin(${v}_uv.yx * ${I.frequency} + ${I.t})` }
        }),
        bypass: I => ({ uv: I.uv })
    })
};
