/**
 * Image effects. Texture-based effects take a sampler2D: connect a Feedback
 * node's output or the `tex` output of Camera / VideoURL / ScreenCapture
 * (unconnected = the active video source).
 *
 * Every effect has a trailing `amount` input (0 = bypass, 1 = full effect);
 * see amount.js.
 */
import { libNode } from './define.js';
import { effectNode, renamedAmount } from './amount.js';

const C = 'effect';
const COLOR = { name: 'color', type: 'vec3', default: 'vec3(1.0)' };
const SUV = { name: 'uv', type: 'vec2', default: 'pt_uvStretch()', description: 'Screen UV 0..1 (default: stretched to the frame)' };
const TEX = { name: 'tex', type: 'sampler2D', default: 'u_camera', description: 'Texture (Feedback, Camera.tex, ...)' };

export const EffectNodes = {
    'Vignette': effectNode({
        category: C,
        description: 'Darkens the frame edges. mask = 1 in the middle fading to 0 at the corners. amount scales the darkening (0 = mask 1 everywhere).',
        inputs: [
            COLOR,
            SUV,
            { name: 'radius', type: 'float', default: '0.75' },
            { name: 'softness', type: 'float', default: '0.45' }
        ],
        outputs: [
            { name: 'color', type: 'vec3' },
            { name: 'mask', type: 'float' }
        ],
        full: (I, { v }) => ({
            code: `float ${v}_k = 1.0 - smoothstep(${I.radius} - ${I.softness}, ${I.radius}, length(${I.uv} - 0.5) * 1.41421);`,
            out: { color: `${I.color} * ${v}_k`, mask: `${v}_k` }
        }),
        general: (I, { v }, a) => ({
            code: `float ${v}_k = 1.0 - ${a} * smoothstep(${I.radius} - ${I.softness}, ${I.radius}, length(${I.uv} - 0.5) * 1.41421);`,
            out: { color: `${I.color} * ${v}_k`, mask: `${v}_k` }
        }),
        bypass: I => ({ color: I.color, mask: '1.0' })
    }),

    'Grain': effectNode({
        category: C,
        description: 'Animated film grain added to a color (t = seed, default Time). intensity = grain strength; amount scales it (0 = no grain).',
        inputs: [
            COLOR,
            { name: 'intensity', type: 'float', default: '0.08' },
            { name: 't', type: 'float', default: 'u_time' }
        ],
        outputs: [{ name: 'color', type: 'vec3' }],
        full: I => ({ out: { color: `${I.color} + (pt_hash12(gl_FragCoord.xy + fract(${I.t}) * vec2(113.7, 71.3)) - 0.5) * ${I.intensity}` } }),
        general: (I, ctx, a) => ({ out: { color: `${I.color} + (pt_hash12(gl_FragCoord.xy + fract(${I.t}) * vec2(113.7, 71.3)) - 0.5) * ${I.intensity} * ${a}` } }),
        bypass: I => ({ color: I.color }),
        migrateData: renamedAmount('intensity') // was amount (the strength) before the shared amount input
    }),

    'Dither': effectNode({
        category: C,
        description: 'Ordered (Bayer 4x4) dithering to a number of color levels per channel (retro / 1-bit look with levels = 2). amount coarsens the quantization step linearly from 1/1023 (1024 levels; 0 = color unchanged) to 1/(levels - 1).',
        inputs: [
            COLOR,
            { name: 'levels', type: 'float', default: '4.0' },
            { name: 'pixelSize', type: 'float', default: '2.0', description: 'Dither cell size in pixels' }
        ],
        outputs: [{ name: 'color', type: 'vec3' }],
        full: (I, { v }) => ({
            code: [
                `float ${v}_l = max(${I.levels}, 2.0) - 1.0;`,
                `float ${v}_b = pt_bayer4(gl_FragCoord.xy / max(${I.pixelSize}, 1.0));`
            ].join('\n'),
            out: { color: `floor(clamp(${I.color}, 0.0, 1.0) * ${v}_l + ${v}_b) / ${v}_l` }
        }),
        general: (I, { v }, a) => ({
            code: [
                `float ${v}_da = min(${a}, 1.0);`,
                `float ${v}_l0 = max(${I.levels}, 2.0) - 1.0;`,
                // 1/l moves linearly from 1/1023 to 1/l0 (even visual steps); exact l0 at a = 1
                `float ${v}_l = ${v}_l0 / (1.0 - (1.0 - ${v}_l0 / 1023.0) * (1.0 - ${v}_da));`,
                `float ${v}_b = pt_bayer4(gl_FragCoord.xy / max(${I.pixelSize}, 1.0));`,
                `vec3 ${v}_c = mix(${I.color}, clamp(${I.color}, 0.0, 1.0), ${v}_da);`
            ].join('\n'),
            out: { color: `min(floor(${v}_c * ${v}_l + ${v}_b) / ${v}_l, max(${v}_c, vec3(1.0)))` }
        }),
        bypass: I => ({ color: I.color }),
        guard: true
    }),

    'Scanlines': effectNode({
        category: C,
        description: 'CRT-style horizontal scanlines over a color. amount scales the intensity.',
        inputs: [
            COLOR,
            SUV,
            { name: 'count', type: 'float', default: '180.0', description: 'Lines per frame height' },
            { name: 'intensity', type: 'float', default: '0.3' },
            { name: 'speed', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'color', type: 'vec3' }],
        full: I => ({ out: { color: `${I.color} * (1.0 - ${I.intensity} * (0.5 + 0.5 * sin((${I.uv}.y + u_time * ${I.speed}) * ${I.count} * 6.2831853)))` } }),
        general: (I, ctx, a) => ({ out: { color: `${I.color} * (1.0 - ${I.intensity} * ${a} * (0.5 + 0.5 * sin((${I.uv}.y + u_time * ${I.speed}) * ${I.count} * 6.2831853)))` } }),
        bypass: I => ({ color: I.color })
    }),

    'Glow': effectNode({
        category: C,
        description: 'Neon glow from a signed distance: intensity * (radius / |d|)^falloff (bright near the edge, fading out). amount scales the glow (0 = no glow).',
        inputs: [
            { name: 'd', type: 'float', default: '0.1' },
            { name: 'radius', type: 'float', default: '0.02' },
            { name: 'intensity', type: 'float', default: '1.0' },
            { name: 'falloff', type: 'float', default: '1.2' }
        ],
        outputs: [{ name: 'glow', type: 'float' }],
        full: I => ({ out: { glow: `min(${I.intensity} * pow(${I.radius} / max(abs(${I.d}), 1e-4), ${I.falloff}), 64.0)` } }),
        general: (I, ctx, a) => ({ out: { glow: `${a} * min(${I.intensity} * pow(${I.radius} / max(abs(${I.d}), 1e-4), ${I.falloff}), 64.0)` } }),
        bypass: () => ({ glow: '0.0' })
    }),

    'ChromaticAberration': effectNode({
        category: C,
        description: 'Samples a texture with red / blue channels pushed apart radially (lens fringing). strength = channel offset; amount scales it (0 = plain texture read).',
        inputs: [
            TEX,
            SUV,
            { name: 'strength', type: 'float', default: '0.006' },
            { name: 'center', type: 'vec2', default: 'vec2(0.5)' }
        ],
        outputs: [{ name: 'color', type: 'vec4' }],
        full: (I, { v }) => ({
            code: `vec2 ${v}_o = (${I.uv} - ${I.center}) * ${I.strength} * 2.0;`,
            out: {
                color: `vec4(texture(${I.tex}, ${I.uv} + ${v}_o).r, texture(${I.tex}, ${I.uv}).g, texture(${I.tex}, ${I.uv} - ${v}_o).b, texture(${I.tex}, ${I.uv}).a)`
            }
        }),
        general: (I, { v }, a) => ({
            code: `vec2 ${v}_o = (${I.uv} - ${I.center}) * ${I.strength} * ${a} * 2.0;`,
            out: {
                color: `vec4(texture(${I.tex}, ${I.uv} + ${v}_o).r, texture(${I.tex}, ${I.uv}).g, texture(${I.tex}, ${I.uv} - ${v}_o).b, texture(${I.tex}, ${I.uv}).a)`
            }
        }),
        bypass: I => ({ color: `texture(${I.tex}, ${I.uv})` }),
        migrateData: renamedAmount('strength') // was amount (the offset) before the shared amount input
    }),

    'TextureBlur': effectNode({
        category: C,
        description: '9-tap Gaussian blur of a texture; radius in pixels. amount scales the radius (0 = plain texture read).',
        inputs: [TEX, SUV, { name: 'radius', type: 'float', default: '2.0' }],
        outputs: [{ name: 'color', type: 'vec4' }],
        full: (I, ctx) => blur9(I, ctx, I.radius),
        general: (I, ctx, a) => blur9(I, ctx, `${I.radius} * ${a}`),
        bypass: I => ({ color: `texture(${I.tex}, ${I.uv})` }),
        guard: true
    }),

    'EdgeDetect': effectNode({
        category: C,
        description: 'Sobel edge detection on a texture: edges = edge strength (0..1+), color = edges as white lines. amount scales the edge response (0 = no edges).',
        inputs: [TEX, SUV, { name: 'thickness', type: 'float', default: '1.0', description: 'Sample offset in pixels' }],
        outputs: [
            { name: 'edges', type: 'float' },
            { name: 'color', type: 'vec3' }
        ],
        full: (I, ctx) => sobel(I, ctx, null),
        general: (I, ctx, a) => sobel(I, ctx, a),
        bypass: () => ({ edges: '0.0', color: 'vec3(0.0)' })
    })
};

function blur9(I, { v }, radius) {
    return {
        code: [
            `vec2 ${v}_px = ${radius} / vec2(textureSize(${I.tex}, 0));`,
            `vec4 ${v}_acc = texture(${I.tex}, ${I.uv}) * 0.25;`,
            `${v}_acc += (texture(${I.tex}, ${I.uv} + vec2(${v}_px.x, 0.0)) + texture(${I.tex}, ${I.uv} - vec2(${v}_px.x, 0.0)) + texture(${I.tex}, ${I.uv} + vec2(0.0, ${v}_px.y)) + texture(${I.tex}, ${I.uv} - vec2(0.0, ${v}_px.y))) * 0.125;`,
            `${v}_acc += (texture(${I.tex}, ${I.uv} + ${v}_px) + texture(${I.tex}, ${I.uv} - ${v}_px) + texture(${I.tex}, ${I.uv} + vec2(${v}_px.x, -${v}_px.y)) + texture(${I.tex}, ${I.uv} - vec2(${v}_px.x, -${v}_px.y))) * 0.0625;`
        ].join('\n'),
        out: { color: `${v}_acc` }
    };
}

function sobel(I, { v }, a) {
    const s = (dx, dy) => `pt_luma(texture(${I.tex}, ${I.uv} + ${v}_px * vec2(${dx}, ${dy})).rgb)`;
    const len = `length(vec2(${v}_gx, ${v}_gy))`;
    return {
        code: [
            `vec2 ${v}_px = ${I.thickness} / vec2(textureSize(${I.tex}, 0));`,
            `float ${v}_gx = -${s('-1.0', '-1.0')} - 2.0 * ${s('-1.0', '0.0')} - ${s('-1.0', '1.0')} + ${s('1.0', '-1.0')} + 2.0 * ${s('1.0', '0.0')} + ${s('1.0', '1.0')};`,
            `float ${v}_gy = -${s('-1.0', '-1.0')} - 2.0 * ${s('0.0', '-1.0')} - ${s('1.0', '-1.0')} + ${s('-1.0', '1.0')} + 2.0 * ${s('0.0', '1.0')} + ${s('1.0', '1.0')};`,
            `float ${v}_e = ${a ? `${len} * ${a}` : len};`
        ].join('\n'),
        out: { edges: `${v}_e`, color: `vec3(clamp(${v}_e, 0.0, 1.0))` }
    };
}

/** TextureSample, rewritten so an unconnected uv / texture still compiles. */
export const LegacyEffectOverrides = {
    'TextureSample': libNode({
        category: C,
        description: 'Reads a texture (Feedback output, Camera.tex, ...) at uv. Unconnected texture = the active video source.',
        inputs: [
            { name: 'texture', type: 'sampler2D', default: 'u_camera' },
            SUV
        ],
        outputs: [{ name: 'color', type: 'vec4' }],
        expr: I => `texture(${I.texture}, ${I.uv})`
    })
};
