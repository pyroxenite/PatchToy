/**
 * Noise nodes. Every noise output `n` is in 0..1. The input point is
 * multiplied by `scale` (features per UV unit) before sampling.
 */
import { libNode } from './define.js';

const C = 'noise';
const P2 = { name: 'p', type: 'vec2', default: 'pt_uv()', description: 'Sample point (default: aspect-correct UV)' };
const scale = d => ({ name: 'scale', type: 'float', default: d });

export const NoiseNodes = {
    'Random': libNode({
        category: C,
        description: 'Hash / white noise: a stable pseudo-random 0..1 value for any float, vec2 or vec3 input (default: per pixel). Change seed (e.g. Time) to re-roll.',
        inputs: [
            { name: 'p', type: 'T', default: 'floor(gl_FragCoord.xy)', defaultType: 'vec2' },
            { name: 'seed', type: 'float', default: '0.0' }
        ],
        outputs: [{ name: 'n', type: 'float' }],
        expr: (I, { T }) => {
            if (T === 'float') return `pt_hash11(${I.p} + ${I.seed} * 17.31)`;
            if (T === 'vec2') return `pt_hash12(${I.p} + ${I.seed} * vec2(17.31, 9.17))`;
            if (T === 'vec3') return `pt_hash13(${I.p} + ${I.seed} * vec3(17.31, 9.17, 3.71))`;
            return `pt_hash13(${I.p}.xyz + ${I.p}.w * 7.13 + ${I.seed} * vec3(17.31, 9.17, 3.71))`;
        }
    }),

    'ValueNoise': libNode({
        category: C,
        description: 'Smooth value noise (blocky-soft blobs), 0..1.',
        inputs: [P2, scale('8.0')],
        outputs: [{ name: 'n', type: 'float' }],
        expr: I => `pt_valueNoise2(${I.p} * ${I.scale})`
    }),

    'PerlinNoise': libNode({
        category: C,
        description: 'Classic 2D gradient (Perlin) noise, 0..1.',
        inputs: [P2, scale('8.0')],
        outputs: [{ name: 'n', type: 'float' }],
        expr: I => `clamp(0.5 + 0.5 * pt_perlin2(${I.p} * ${I.scale}), 0.0, 1.0)`
    }),

    'PerlinNoise3D': libNode({
        category: C,
        description: '3D gradient noise, 0..1. Feed a 3D point (e.g. ScenePoint for SDF displacement, or vec3(uv, time) for animated 2D noise).',
        inputs: [
            { name: 'p', type: 'vec3', default: 'vec3(pt_uv(), 0.0)' },
            scale('4.0')
        ],
        outputs: [{ name: 'n', type: 'float' }],
        expr: I => `clamp(0.5 + 0.5 * pt_perlin3(${I.p} * ${I.scale}), 0.0, 1.0)`
    }),

    'SimplexNoise': libNode({
        category: C,
        description: '2D simplex noise (fewer grid artifacts than Perlin), 0..1.',
        inputs: [P2, scale('8.0')],
        outputs: [{ name: 'n', type: 'float' }],
        expr: I => `clamp(0.5 + 0.5 * pt_simplex2(${I.p} * ${I.scale}), 0.0, 1.0)`
    }),

    'FBM': libNode({
        category: C,
        description: 'Fractal Brownian motion: several octaves of Perlin noise summed (clouds, terrain), 0..1.',
        inputs: [
            P2,
            scale('4.0'),
            { name: 'octaves', type: 'int', default: '5', description: '1..12' },
            { name: 'lacunarity', type: 'float', default: '2.0', description: 'Frequency multiplier per octave' },
            { name: 'gain', type: 'float', default: '0.5', description: 'Amplitude multiplier per octave' }
        ],
        outputs: [{ name: 'n', type: 'float' }],
        expr: I => `clamp(0.5 + 0.5 * pt_fbm2(${I.p} * ${I.scale}, ${I.octaves}, ${I.lacunarity}, ${I.gain}), 0.0, 1.0)`
    }),

    'Voronoi': libNode({
        category: C,
        description: 'Cellular (Worley) noise: d = distance to the nearest cell point, edge = distance to cell borders (F2-F1), id = random 0..1 per cell.',
        inputs: [P2, scale('6.0'), { name: 'jitter', type: 'float', default: '1.0', description: '0 = square grid, 1 = fully random' }],
        outputs: [
            { name: 'd', type: 'float' },
            { name: 'edge', type: 'float' },
            { name: 'id', type: 'float' }
        ],
        body: (I, { v }) => ({
            code: `vec3 ${v}_vo = pt_voronoi2(${I.p} * ${I.scale}, ${I.jitter});`,
            out: { d: `${v}_vo.x`, edge: `${v}_vo.y`, id: `${v}_vo.z` }
        })
    }),

    'DomainWarp': libNode({
        category: C,
        description: 'Warps space with layered FBM (marble / smoke patterns). n = noise at the warped point (0..1), p = warped coordinates to feed other nodes.',
        inputs: [
            P2,
            scale('3.0'),
            { name: 'strength', type: 'float', default: '1.5' },
            { name: 'octaves', type: 'int', default: '4' }
        ],
        outputs: [
            { name: 'n', type: 'float' },
            { name: 'p', type: 'vec2' }
        ],
        body: (I, { v }) => ({
            code: `vec2 ${v}_w = pt_domainWarp2(${I.p} * ${I.scale}, ${I.strength}, ${I.octaves});`,
            out: {
                n: `clamp(0.5 + 0.5 * pt_fbm2(${v}_w, ${I.octaves}, 2.0, 0.5), 0.0, 1.0)`,
                p: `${v}_w / max(${I.scale}, 1e-6)`
            }
        })
    })
};
