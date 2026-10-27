#!/usr/bin/env node
/**
 * Self-made glTF 2.0 test models (no downloads, CC0): a skinned, animated tentacle creature
 * and a textured box, written as .glb.
 *
 *   node scripts/make-test-glb.mjs [outDir]        # default: assets/models
 *
 * tentacle-creature.glb: a body (UV sphere, striped PNG base-colour texture) on a "body"
 * bone and N tentacles (tapered tubes, vertex colours, emissive tips), each skinned to a
 * chain of bones (4 weights per vertex). Clips: "Sway" (2 s, slow) and "Dance" (1 s: two
 * bounces, one per beat at 120 BPM when time = Beat.time / 2). Node hierarchy: Creature >
 * Body bone > tentacle bone chains; the mesh node is a sibling of the skeleton.
 * textured-box.glb: one box with normals, uvs and a checker texture (static).
 *
 * Exports buildCreatureGLB(opts) / buildBoxGLB() (the MCP e2e test uses them in memory).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../tests/lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class GLB {
    constructor() {
        this.json = { asset: { version: '2.0', generator: 'PatchToy make-test-glb.mjs' }, buffers: [], bufferViews: [], accessors: [] };
        this.chunks = [];
        this.length = 0;
    }

    view(bytes, target) {
        const pad = (4 - (this.length % 4)) % 4;
        if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
        const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.chunks.push(u8);
        const v = { buffer: 0, byteOffset: this.length, byteLength: u8.byteLength };
        if (target) v.target = target;
        this.length += u8.byteLength;
        this.json.bufferViews.push(v);
        return this.json.bufferViews.length - 1;
    }

    accessor(array, type, { componentType = 5126, target = 34962, minmax = false, normalized = false } = {}) {
        const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
        const a = { bufferView: this.view(array, target), componentType, count: array.length / n, type };
        if (normalized) a.normalized = true;
        if (minmax) {
            const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
            for (let i = 0; i < array.length; i++) { const k = i % n; min[k] = Math.min(min[k], array[i]); max[k] = Math.max(max[k], array[i]); }
            a.min = min; a.max = max;
        }
        this.json.accessors.push(a);
        return this.json.accessors.length - 1;
    }

    image(pngBytes) {
        const v = this.view(pngBytes);
        (this.json.images = this.json.images || []).push({ bufferView: v, mimeType: 'image/png' });
        (this.json.samplers = this.json.samplers || [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]);
        (this.json.textures = this.json.textures || []).push({ source: this.json.images.length - 1, sampler: 0 });
        return this.json.textures.length - 1;
    }

    toBuffer() {
        const pad = (4 - (this.length % 4)) % 4;
        if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
        this.json.buffers = [{ byteLength: this.length }];
        let jsonBytes = Buffer.from(JSON.stringify(this.json), 'utf8');
        const jpad = (4 - (jsonBytes.length % 4)) % 4;
        jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jpad, 0x20)]);
        const bin = Buffer.concat(this.chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
        const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
        const head = Buffer.alloc(12);
        head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
        const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBytes.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
        const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4);
        return Buffer.concat([head, jh, jsonBytes, bh, bin]);
    }
}

function stripesPNG(w = 64, h = 64) {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const band = Math.floor(y / (h / 8)) % 2;
            const spot = ((x - w / 2) ** 2 + (y % (h / 4) - h / 8) ** 2) < 12;
            data[i] = spot ? 255 : band ? 230 : 120;
            data[i + 1] = spot ? 240 : band ? 120 : 50;
            data[i + 2] = spot ? 200 : band ? 170 : 140;
            data[i + 3] = 255;
        }
    }
    return encodePNG({ width: w, height: h, data }, { channels: 4 });
}

function checkerPNG(w = 32, h = 32) {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, c = ((x >> 3) + (y >> 3)) % 2 ? 230 : 40;
        data[i] = c; data[i + 1] = c * 0.8; data[i + 2] = 60; data[i + 3] = 255;
    }
    return encodePNG({ width: w, height: h, data }, { channels: 4 });
}

function quatAxisAngle(ax, ay, az, angle) {
    const s = Math.sin(angle / 2);
    return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

function quatMul(a, b) {
    return [
        a[3] * b[0] + b[3] * a[0] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] + b[3] * a[1] + a[2] * b[0] - a[0] * b[2],
        a[3] * b[2] + b[3] * a[2] + a[0] * b[1] - a[1] * b[0],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}

/** The skinned tentacle creature. */
export function buildCreatureGLB({ tentacles = 6, bones = 6, rings = 30, sides = 14, height = 2.4 } = {}) {
    const glb = new GLB();
    const L = height / bones;            // bone length
    const ringR = 0.45;                  // tentacle base ring radius
    const positions = [], normals = [], uvs = [], colors = [], joints = [], weights = [], indices = [];
    const BODY = 0;                      // joint 0 = body bone; tentacle k bone j = 1 + k * bones + j
    const jointNodes = [];               // node index per joint (filled below)

    // ---- body: a UV sphere, weight 1 on the body bone
    const sw = 24, sh = 16, R = 0.62;
    const bodyCenter = [0, 0.15, 0];
    for (let j = 0; j <= sh; j++) {
        const th = j / sh * Math.PI;
        for (let i = 0; i <= sw; i++) {
            const ph = i / sw * Math.PI * 2;
            const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
            positions.push(bodyCenter[0] + nx * R, bodyCenter[1] + ny * R * 0.85, bodyCenter[2] + nz * R);
            normals.push(nx, ny, nz);
            uvs.push(i / sw, j / sh);
            colors.push(1, 1, 1, 1);
            joints.push(BODY, 0, 0, 0);
            weights.push(1, 0, 0, 0);
        }
    }
    const bodyIndexCount = (() => {
        const start = indices.length;
        for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
            const a = j * (sw + 1) + i, b = a + sw + 1;
            indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
        return indices.length - start;
    })();

    // ---- tentacles: tapered tubes going down then out (rest pose: straight down)
    const tentStart = positions.length / 3;
    const bases = [];
    for (let k = 0; k < tentacles; k++) {
        const a = k / tentacles * Math.PI * 2;
        const base = [Math.cos(a) * ringR, -0.25, Math.sin(a) * ringR];
        bases.push(base);
        const first = positions.length / 3;
        for (let r = 0; r <= rings; r++) {
            const f = r / rings;                       // 0 at the base, 1 at the tip
            const y = -f * height;
            const rad = 0.17 * (1 - f) + 0.025;
            const bf = Math.min(bones - 1e-4, f * bones);
            const j0 = Math.floor(bf), w1 = bf - j0;
            const ja = 1 + k * bones + j0, jb = 1 + k * bones + Math.min(bones - 1, j0 + 1);
            const tip = Math.pow(f, 3);
            for (let s = 0; s <= sides; s++) {
                const ph = s / sides * Math.PI * 2;
                const nx = Math.cos(ph), nz = Math.sin(ph);
                positions.push(base[0] + nx * rad, base[1] + y, base[2] + nz * rad);
                normals.push(nx, 0, nz);
                uvs.push(s / sides, f);
                // deep violet -> cyan towards the tips
                colors.push(0.35 + 0.1 * f, 0.15 + 0.75 * tip, 0.75 + 0.2 * tip, 1);
                if (jb === ja) { joints.push(ja, 0, 0, 0); weights.push(1, 0, 0, 0); }
                else { joints.push(ja, jb, 0, 0); weights.push(1 - w1, w1, 0, 0); }
            }
        }
        for (let r = 0; r < rings; r++) for (let s = 0; s < sides; s++) {
            const a = first + r * (sides + 1) + s, b = a + sides + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    const tentIndexStart = bodyIndexCount;

    // ---- buffers
    const P = new Float32Array(positions), N = new Float32Array(normals), UV = new Float32Array(uvs);
    const C = new Float32Array(colors), J = new Uint8Array(joints), W = new Float32Array(weights);
    const I = new Uint16Array(indices);
    const aP = glb.accessor(P, 'VEC3', { minmax: true });
    const aN = glb.accessor(N, 'VEC3');
    const aUV = glb.accessor(UV, 'VEC2');
    const aC = glb.accessor(C, 'VEC4');
    const aJ = glb.accessor(J, 'VEC4', { componentType: 5121 });
    const aW = glb.accessor(W, 'VEC4');
    // two primitives sharing the vertex buffers: body (textured) and tentacles (vertex colours, emissive)
    const aIbody = glb.accessor(I.slice(0, tentIndexStart), 'SCALAR', { componentType: 5123, target: 34963 });
    const aItent = glb.accessor(I.slice(tentIndexStart), 'SCALAR', { componentType: 5123, target: 34963 });
    const tex = glb.image(stripesPNG());
    glb.json.materials = [
        { name: 'Body', pbrMetallicRoughness: { baseColorTexture: { index: tex }, metallicFactor: 0.1, roughnessFactor: 0.45 } },
        { name: 'Tentacles', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.0, roughnessFactor: 0.35 }, emissiveFactor: [0.05, 0.35, 0.45] },
    ];
    const attrs = { POSITION: aP, NORMAL: aN, TEXCOORD_0: aUV, COLOR_0: aC, JOINTS_0: aJ, WEIGHTS_0: aW };
    glb.json.meshes = [{ name: 'Creature', primitives: [{ attributes: attrs, indices: aIbody, material: 0 }, { attributes: attrs, indices: aItent, material: 1 }] }];
    void tentStart;

    // ---- nodes: 0 Creature root, 1 mesh, 2 body bone, then tentacle chains
    const nodes = [{ name: 'Creature', children: [1, 2] }, { name: 'CreatureMesh', mesh: 0, skin: 0 }, { name: 'Body', translation: [0, 0, 0], children: [] }];
    jointNodes[BODY] = 2;
    const restWorld = [[0, 0, 0]];
    for (let k = 0; k < tentacles; k++) {
        let parent = 2;
        for (let j = 0; j < bones; j++) {
            const idx = nodes.length;
            const t = j === 0 ? [bases[k][0], bases[k][1], bases[k][2]] : [0, -L, 0];
            nodes.push({ name: `T${k}_${j}`, translation: t, children: [] });
            nodes[parent].children.push(idx);
            jointNodes[1 + k * bones + j] = idx;
            restWorld[1 + k * bones + j] = [bases[k][0], bases[k][1] - j * L, bases[k][2]];
            parent = idx;
        }
    }
    const jointCount = 1 + tentacles * bones;
    const ibm = new Float32Array(jointCount * 16);
    for (let j = 0; j < jointCount; j++) {
        const w = restWorld[j];
        ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -w[0], -w[1], -w[2], 1], j * 16);
    }
    const aIBM = glb.accessor(ibm, 'MAT4', { target: 0 });
    glb.json.skins = [{ name: 'CreatureSkin', joints: jointNodes.slice(0, jointCount), inverseBindMatrices: aIBM, skeleton: 2 }];
    glb.json.nodes = nodes;
    glb.json.scenes = [{ name: 'Scene', nodes: [0] }];
    glb.json.scene = 0;

    // ---- animations
    const clip = (name, duration, keys, amp, speed, bounces) => {
        const times = new Float32Array(keys + 1).map((_, i) => i / keys * duration);
        const tIn = glb.accessor(times, 'SCALAR', { minmax: true, target: 0 });
        const samplers = [], channels = [];
        // body bob (translation)
        const bob = new Float32Array((keys + 1) * 3);
        for (let i = 0; i <= keys; i++) {
            const ph = i / keys * Math.PI * 2 * bounces;
            bob[i * 3 + 1] = Math.abs(Math.sin(ph / 2)) * 0.25 * amp;
        }
        samplers.push({ input: tIn, output: glb.accessor(bob, 'VEC3', { target: 0 }), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: 2, path: 'translation' } });
        for (let k = 0; k < tentacles; k++) {
            const a = k / tentacles * Math.PI * 2;
            // bend axis: tangent of the ring (bends the tentacle outwards / inwards)
            const ax = [-Math.sin(a), 0, Math.cos(a)];
            for (let j = 0; j < bones; j++) {
                const q = new Float32Array((keys + 1) * 4);
                for (let i = 0; i <= keys; i++) {
                    const ph = i / keys * Math.PI * 2 * speed;
                    const ang = (j === 0 ? -0.55 : 0) * amp + Math.sin(ph - j * 0.7 + k * 1.1) * 0.32 * amp;
                    const twist = Math.cos(ph * 0.5 + k) * 0.15 * amp;
                    const qq = quatMul(quatAxisAngle(ax[0], ax[1], ax[2], ang), quatAxisAngle(0, 1, 0, twist));
                    q.set(qq, i * 4);
                }
                samplers.push({ input: tIn, output: glb.accessor(q, 'VEC4', { target: 0 }), interpolation: 'LINEAR' });
                channels.push({ sampler: samplers.length - 1, target: { node: jointNodes[1 + k * bones + j], path: 'rotation' } });
            }
        }
        return { name, samplers, channels };
    };
    glb.json.animations = [clip('Sway', 2, 24, 1, 1, 1), clip('Dance', 1, 24, 1.6, 2, 2)];
    // accessors without a target must not carry it
    for (const v of glb.json.bufferViews) if (v.target === undefined) delete v.target;
    return glb.toBuffer();
}

/** A static textured box. */
export function buildBoxGLB() {
    const glb = new GLB();
    const P = [], N = [], UV = [], I = [];
    const faces = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
    for (const [n, u, v] of faces) {
        const b = P.length / 3;
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            P.push((n[0] + u[0] * su + v[0] * sv) * 0.5, (n[1] + u[1] * su + v[1] * sv) * 0.5, (n[2] + u[2] * su + v[2] * sv) * 0.5);
            N.push(...n);
            UV.push((su + 1) / 2, 1 - (sv + 1) / 2);
        }
        I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const tex = glb.image(checkerPNG());
    glb.json.materials = [{ name: 'Checker', pbrMetallicRoughness: { baseColorTexture: { index: tex }, metallicFactor: 0, roughnessFactor: 0.6 } }];
    glb.json.meshes = [{ name: 'Box', primitives: [{ attributes: { POSITION: glb.accessor(new Float32Array(P), 'VEC3', { minmax: true }), NORMAL: glb.accessor(new Float32Array(N), 'VEC3'), TEXCOORD_0: glb.accessor(new Float32Array(UV), 'VEC2') }, indices: glb.accessor(new Uint16Array(I), 'SCALAR', { componentType: 5123, target: 34963 }), material: 0 }] }];
    glb.json.nodes = [{ name: 'Box', mesh: 0, rotation: [0, 0.3826834, 0, 0.9238795] }];
    glb.json.scenes = [{ nodes: [0] }];
    glb.json.scene = 0;
    return glb.toBuffer();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const out = path.resolve(process.argv[2] || path.join(ROOT, 'assets', 'models'));
    fs.mkdirSync(out, { recursive: true });
    for (const [name, buf] of [['tentacle-creature.glb', buildCreatureGLB()], ['textured-box.glb', buildBoxGLB()]]) {
        fs.writeFileSync(path.join(out, name), buf);
        console.log(`${path.relative(ROOT, path.join(out, name))} (${(buf.length / 1024).toFixed(1)} KB)`);
    }
}
