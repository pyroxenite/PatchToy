/**
 * Color nodes. Colors are vec3 RGB in 0..1 (vec4 inputs are truncated to RGB
 * automatically). Hues are in turns: 0..1 = one trip around the color wheel.
 *
 * Colour adjustments have a trailing `amount` input (0 = color unchanged,
 * 1 = full effect); see amount.js.
 */
import { libNode } from './define.js';
import { effectNode, renamedAmount } from './amount.js';

const C = 'color';
const COLOR = (d = 'vec3(1.0, 0.5, 0.2)') => ({ name: 'color', type: 'vec3', default: d });
const T_UV_X = { name: 't', type: 'float', default: 'pt_uv().x', description: 'Position along the gradient (default: horizontal UV)' };

function colorOp(description, extraInputs, expr) {
    return libNode({
        category: C,
        description,
        inputs: [COLOR(), ...extraInputs],
        outputs: [{ name: 'color', type: 'vec3' }],
        expr
    });
}

/** Colour adjustment with the shared amount input: full = original, general(I, ctx, a). */
function colorFx(description, extraInputs, { full, general, guard = false, ...rest }) {
    return effectNode({
        category: C,
        description,
        inputs: [COLOR(), ...extraInputs],
        outputs: [{ name: 'color', type: 'vec3' }],
        full: (I, ctx) => ({ out: { color: full(I, ctx) } }),
        general: (I, ctx, a) => {
            const r = general(I, ctx, a);
            return typeof r === 'string' ? { out: { color: r } } : { code: r.code, out: { color: r.color } };
        },
        bypass: I => ({ color: I.color }),
        guard,
        ...rest
    });
}

export const ColorNodes = {
    'HSVToRGB': libNode({
        category: C,
        description: 'Builds an RGB color from hue (turns, 0..1 wraps), saturation and value.',
        inputs: [
            { name: 'h', type: 'float', default: '0.0' },
            { name: 's', type: 'float', default: '1.0' },
            { name: 'v', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'color', type: 'vec3' }],
        expr: I => `pt_hsv2rgb(vec3(fract(${I.h}), clamp(${I.s}, 0.0, 1.0), ${I.v}))`
    }),

    'RGBToHSV': libNode({
        category: C,
        description: 'Converts an RGB color to hue (0..1), saturation and value; hsv packs all three.',
        inputs: [COLOR()],
        outputs: [
            { name: 'hsv', type: 'vec3' },
            { name: 'h', type: 'float' },
            { name: 's', type: 'float' },
            { name: 'v', type: 'float' }
        ],
        body: (I, { v }) => ({
            code: `vec3 ${v}_c = pt_rgb2hsv(${I.color});`,
            out: { hsv: `${v}_c`, h: `${v}_c.x`, s: `${v}_c.y`, v: `${v}_c.z` }
        })
    }),

    'CosinePalette': libNode({
        category: C,
        description: 'Inigo Quilez cosine palette: a + b * cos(2pi * (c * t + d)). Defaults give a rainbow; animate t for color cycling.',
        inputs: [
            T_UV_X,
            { name: 'a', type: 'vec3', default: 'vec3(0.5)' },
            { name: 'b', type: 'vec3', default: 'vec3(0.5)' },
            { name: 'c', type: 'vec3', default: 'vec3(1.0)' },
            { name: 'd', type: 'vec3', default: 'vec3(0.0, 0.33, 0.67)' }
        ],
        outputs: [{ name: 'color', type: 'vec3' }],
        expr: I => `${I.a} + ${I.b} * cos(6.2831853 * (${I.c} * ${I.t} + ${I.d}))`
    }),

    'HueShift': colorFx('Rotates the hue of a color by shift turns (1 = full circle). amount scales the shift.',
        [{ name: 'shift', type: 'float', default: '0.25' }], {
            full: I => `pt_hsv2rgb(vec3(fract(pt_rgb2hsv(${I.color}).x + ${I.shift}), pt_rgb2hsv(${I.color}).yz))`,
            // The HSV round-trip error (colors outside 0..1) fades out with amount, so 0 is the input
            general: (I, { v }, a) => ({
                code: [
                    `vec3 ${v}_c = ${I.color};`,
                    `vec3 ${v}_h = pt_rgb2hsv(${v}_c);`
                ].join('\n'),
                color: `pt_hsv2rgb(vec3(fract(${v}_h.x + ${I.shift} * ${a}), ${v}_h.yz)) + (1.0 - min(${a}, 1.0)) * (${v}_c - pt_hsv2rgb(${v}_h))`
            }),
            guard: true
        }),

    'Saturation': colorFx('Adjusts saturation: saturation 0 = grayscale, 1 = unchanged, >1 = more vivid. amount blends the saturation factor from 1 (0 = color unchanged) to saturation.',
        [{ name: 'saturation', type: 'float', default: '1.5' }], {
            full: I => `max(mix(vec3(pt_luma(${I.color})), ${I.color}, ${I.saturation}), 0.0)`,
            general: (I, { v }, a) => ({
                code: [
                    `vec3 ${v}_c = ${I.color};`,
                    `vec3 ${v}_r = mix(vec3(pt_luma(${v}_c)), ${v}_c, mix(1.0, ${I.saturation}, ${a}));`
                ].join('\n'),
                color: `mix(${v}_r, max(${v}_r, 0.0), min(${a}, 1.0))`
            }),
            migrateData: renamedAmount('saturation') // was amount (the factor) before the shared amount input
        }),

    'BrightnessContrast': colorFx('Adds brightness and scales contrast around mid gray. amount scales the brightness and blends contrast from 1.',
        [{ name: 'brightness', type: 'float', default: '0.0' }, { name: 'contrast', type: 'float', default: '1.2' }], {
            full: I => `(${I.color} - 0.5) * ${I.contrast} + 0.5 + ${I.brightness}`,
            general: (I, ctx, a) => `(${I.color} - 0.5) * mix(1.0, ${I.contrast}, ${a}) + 0.5 + ${I.brightness} * ${a}`,
            guard: true
        }),

    'Gamma': colorFx('Gamma curve: color^(1/gamma). gamma > 1 brightens midtones (2.2 = linear to sRGB). amount moves gamma in log space from 1 (gamma^amount).',
        [{ name: 'gamma', type: 'float', default: '2.2' }], {
            full: I => `pow(max(${I.color}, 0.0), vec3(1.0 / max(${I.gamma}, 1e-4)))`,
            // gamma^a as g * g^(a-1) (exact at a = 1); negative components fade to 0 instead of clamping at once
            general: (I, { v }, a) => ({
                code: [
                    `vec3 ${v}_c = ${I.color};`,
                    `float ${v}_g = max(${I.gamma}, 1e-4);`,
                    `float ${v}_ge = ${v}_g * pow(${v}_g, ${a} - 1.0);`
                ].join('\n'),
                color: `pow(max(${v}_c, 0.0), vec3(1.0 / ${v}_ge)) + min(${v}_c, 0.0) * (1.0 - min(${a}, 1.0))`
            }),
            guard: true
        }),

    'Grayscale': effectNode({
        category: C,
        description: 'Perceptual luminance of a color (Rec. 709): luma as a float and gray as a color. amount desaturates gray from the input color (0) to full gray (1); luma is always the luminance.',
        inputs: [COLOR()],
        outputs: [
            { name: 'gray', type: 'vec3' },
            { name: 'luma', type: 'float' }
        ],
        full: (I, { v }) => ({
            code: `float ${v}_l = pt_luma(${I.color});`,
            out: { gray: `vec3(${v}_l)`, luma: `${v}_l` }
        }),
        general: (I, { v }, a) => ({
            code: [
                `vec3 ${v}_c = ${I.color};`,
                `float ${v}_l = pt_luma(${v}_c);`
            ].join('\n'),
            out: { gray: `mix(${v}_c, vec3(${v}_l), ${a})`, luma: `${v}_l` }
        }),
        bypass: I => ({ gray: I.color })
    }),

    'Invert': colorFx('Inverts a color: 1 - color. amount blends toward the inverse (0.5 = mid gray).', [], {
        full: I => `1.0 - ${I.color}`,
        general: (I, { v }, a) => ({
            code: `vec3 ${v}_c = ${I.color};`,
            color: `mix(${v}_c, 1.0 - ${v}_c, ${a})`
        })
    }),

    'Posterize': colorFx('Reduces each channel to a number of flat levels (poster / toon look). amount coarsens the level step linearly from 1/1023 (1024 levels; 0 = color unchanged) to 1/(levels - 1).',
        [{ name: 'levels', type: 'float', default: '4.0' }], {
            full: I => `floor(clamp(${I.color}, 0.0, 1.0) * (max(${I.levels}, 2.0) - 0.001)) / (max(${I.levels}, 2.0) - 1.0)`,
            general: (I, { v }, a) => ({
                code: [
                    `float ${v}_pa = min(${a}, 1.0);`,
                    `float ${v}_L0 = max(${I.levels}, 2.0);`,
                    // 1/(L - 1) moves linearly from 1/1023 to 1/(L0 - 1); written so L = L0 exactly at a = 1
                    `float ${v}_k = 1.0 - (${v}_L0 - 1.0) / 1023.0;`,
                    `float ${v}_L = ${v}_L0 + (1.0 - ${v}_pa) * (${v}_L0 - 1.0) * ${v}_k / (1.0 - ${v}_k * (1.0 - ${v}_pa));`,
                    `vec3 ${v}_c = mix(${I.color}, clamp(${I.color}, 0.0, 1.0), ${v}_pa);`
                ].join('\n'),
                color: `min(floor(${v}_c * (${v}_L - 0.001)) / (${v}_L - 1.0), max(${v}_c, vec3(1.0)))`
            }),
            guard: true
        }),

    // Tint always had a trailing amount (default 1.0, 0 = unchanged); it now uses the shared input
    'Tint': colorFx('Multiplies a color by a tint color. amount blends the tint in (0 = unchanged, 1 = full tint).',
        [{ name: 'tint', type: 'vec3', default: 'vec3(1.0, 0.8, 0.6)' }], {
            full: I => `mix(${I.color}, ${I.color} * ${I.tint}, 1.0)`,
            general: (I, ctx, a) => `mix(${I.color}, ${I.color} * ${I.tint}, ${a})`
        }),

    'Gradient': libNode({
        category: C,
        description: 'Three-stop color gradient: a at t=0, b at t=mid, c at t=1.',
        inputs: [
            T_UV_X,
            { name: 'a', type: 'vec3', default: 'vec3(0.05, 0.03, 0.15)' },
            { name: 'b', type: 'vec3', default: 'vec3(0.9, 0.25, 0.2)' },
            { name: 'c', type: 'vec3', default: 'vec3(1.0, 0.9, 0.55)' },
            { name: 'mid', type: 'float', default: '0.5' }
        ],
        outputs: [{ name: 'color', type: 'vec3' }],
        body: (I, { v }) => ({
            code: [
                `float ${v}_t = clamp(${I.t}, 0.0, 1.0);`,
                `float ${v}_m = clamp(${I.mid}, 0.001, 0.999);`
            ].join('\n'),
            out: { color: `${v}_t < ${v}_m ? mix(${I.a}, ${I.b}, ${v}_t / ${v}_m) : mix(${I.b}, ${I.c}, (${v}_t - ${v}_m) / (1.0 - ${v}_m))` }
        })
    }),

    'ColorRamp': libNode({
        category: C,
        description: 'Four evenly spaced color stops (c0 at t=0 ... c3 at t=1) with smooth blending.',
        inputs: [
            T_UV_X,
            { name: 'c0', type: 'vec3', default: 'vec3(0.0, 0.05, 0.2)' },
            { name: 'c1', type: 'vec3', default: 'vec3(0.0, 0.5, 0.6)' },
            { name: 'c2', type: 'vec3', default: 'vec3(0.95, 0.8, 0.3)' },
            { name: 'c3', type: 'vec3', default: 'vec3(1.0, 0.3, 0.4)' }
        ],
        outputs: [{ name: 'color', type: 'vec3' }],
        body: (I, { v }) => ({
            code: `float ${v}_t = clamp(${I.t}, 0.0, 1.0) * 3.0;`,
            out: {
                color: `mix(mix(${I.c0}, ${I.c1}, smoothstep(0.0, 1.0, ${v}_t)), mix(${I.c2}, ${I.c3}, smoothstep(2.0, 3.0, ${v}_t)), smoothstep(1.0, 2.0, ${v}_t))`
            }
        })
    }),

    'TonemapACES': colorOp('Filmic ACES tonemapping: maps HDR colors (> 1) into 0..1 with a pleasing curve. exposure scales the input first.',
        [{ name: 'exposure', type: 'float', default: '1.0' }],
        I => `pt_aces(${I.color} * ${I.exposure})`)
};
