/**
 * Compact glTF 2.0 loader for Render 3D (no dependency).
 *
 * parseGLTF(arrayBufferOrText) -> model (CPU data, no GL):
 *   { meshes: [{ name, primitives: [{ positions, normals, uvs, colors, colorSize, joints, weights,
 *     indices, mode, material, bounds }] }], nodes: [{ name, mesh, skin, children, t, r, s, matrix }],
 *     scenes, scene, materials: [...], textures: [{ image (Blob), sampler }], skins: [{ joints,
 *     inverseBind (Float32Array 16 x n), skeleton }], animations: [{ name, duration, channels:
 *     [{ node, path, times, values, interp }] }], warnings }
 *
 * Supported: .glb and .gltf (embedded / data: URI buffers and images), every accessor
 * component type (normalized / quantized integers are converted to floats), sparse
 * accessors, triangle strips / fans (converted), node hierarchy with TRS or matrices,
 * PBR metal / rough materials with textures, KHR_materials_unlit, KHR_materials_emissive_strength,
 * KHR_mesh_quantization, skins, animation clips (translation / rotation / scale; LINEAR,
 * STEP, CUBICSPLINE). Not supported (clear error): Draco and meshopt compression, external
 * files. Ignored with a warning: morph targets, KHR_texture_transform, other uv sets.
 */

export class GLTFError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GLTFError';
    }
}

const COMPONENT = {
    5120: { array: Int8Array, size: 1, norm: v => Math.max(v / 127, -1) },
    5121: { array: Uint8Array, size: 1, norm: v => v / 255 },
    5122: { array: Int16Array, size: 2, norm: v => Math.max(v / 32767, -1) },
    5123: { array: Uint16Array, size: 2, norm: v => v / 65535 },
    5125: { array: Uint32Array, size: 4, norm: v => v / 4294967295 },
    5126: { array: Float32Array, size: 4, norm: v => v },
};
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const UNSUPPORTED = {
    KHR_draco_mesh_compression: 'Draco-compressed meshes are not supported: export from Blender without "Compression" (glTF exporter > Data > Compression off)',
    EXT_meshopt_compression: 'meshopt-compressed files are not supported: export without meshopt compression',
    KHR_meshopt_compression: 'meshopt-compressed files are not supported: export without meshopt compression',
};

function utf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
}

function decodeDataURI(uri) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
    if (!m) return null;
    const data = m[3];
    if (m[2]) {
        const bin = atob(data);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return { mime: m[1], bytes: out };
    }
    return { mime: m[1], bytes: new TextEncoder().encode(decodeURIComponent(data)) };
}

/** Split a .glb into its JSON and binary chunk (or parse .gltf text). */
function container(input) {
    if (typeof input === 'string') return { json: JSON.parse(input), bin: null };
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length >= 12 && dv.getUint32(0, true) === 0x46546C67) { // 'glTF'
        const version = dv.getUint32(4, true);
        if (version !== 2) throw new GLTFError(`glTF version ${version} is not supported (2.0 only)`);
        let off = 12;
        let json = null, bin = null;
        while (off + 8 <= bytes.length) {
            const len = dv.getUint32(off, true);
            const type = dv.getUint32(off + 4, true);
            const chunk = bytes.subarray(off + 8, off + 8 + len);
            if (type === 0x4E4F534A) json = JSON.parse(utf8(chunk));
            else if (type === 0x004E4942) bin = chunk;
            off += 8 + len;
        }
        if (!json) throw new GLTFError('GLB without a JSON chunk');
        return { json, bin };
    }
    // .gltf as bytes
    try { return { json: JSON.parse(utf8(bytes)), bin: null }; } catch (e) {
        throw new GLTFError('Not a glTF file (.glb or .gltf expected)');
    }
}

export function parseGLTF(input) {
    const { json: g, bin } = container(input);
    const warnings = [];
    const asset = g.asset || {};
    if (!String(asset.version || '').startsWith('2')) throw new GLTFError(`glTF ${asset.version || '?'} is not supported (2.0 only)`);
    for (const ext of g.extensionsRequired || []) {
        if (UNSUPPORTED[ext]) throw new GLTFError(UNSUPPORTED[ext]);
        if (!['KHR_materials_unlit', 'KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength'].includes(ext)) {
            throw new GLTFError(`required extension ${ext} is not supported`);
        }
    }
    for (const ext of g.extensionsUsed || []) {
        if (UNSUPPORTED[ext]) throw new GLTFError(UNSUPPORTED[ext]);
        if (ext === 'KHR_texture_transform') warnings.push('KHR_texture_transform is ignored');
    }

    // ---- buffers
    const buffers = (g.buffers || []).map((b, i) => {
        if (b.uri === undefined) {
            if (!bin) throw new GLTFError(`buffer ${i} has no data`);
            return bin;
        }
        const d = decodeDataURI(b.uri);
        if (!d) throw new GLTFError(`buffer ${i} references an external file (${b.uri}): use a .glb or embed the buffers`);
        return d.bytes;
    });
    const viewBytes = (vi) => {
        const v = g.bufferViews[vi];
        if (!v) throw new GLTFError(`bufferView ${vi} missing`);
        if (v.extensions && (v.extensions.EXT_meshopt_compression || v.extensions.KHR_meshopt_compression)) throw new GLTFError(UNSUPPORTED.EXT_meshopt_compression);
        const buf = buffers[v.buffer];
        return { bytes: buf.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength), stride: v.byteStride || 0 };
    };

    // ---- accessors -> typed arrays (floats unless asked for raw ints)
    const cache = new Map();
    const accessor = (ai, { raw = false } = {}) => {
        const key = `${ai}|${raw}`;
        if (cache.has(key)) return cache.get(key);
        const a = g.accessors[ai];
        if (!a) throw new GLTFError(`accessor ${ai} missing`);
        const comp = COMPONENT[a.componentType];
        if (!comp) throw new GLTFError(`accessor ${ai}: component type ${a.componentType} unknown`);
        const n = COUNT[a.type];
        const count = a.count;
        const out = raw ? new comp.array(count * n) : new Float32Array(count * n);
        if (a.bufferView !== undefined) {
            const { bytes, stride } = viewBytes(a.bufferView);
            const elem = comp.size * n;
            const st = stride || elem;
            const base = a.byteOffset || 0;
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const get = {
                5120: o => dv.getInt8(o), 5121: o => dv.getUint8(o), 5122: o => dv.getInt16(o, true),
                5123: o => dv.getUint16(o, true), 5125: o => dv.getUint32(o, true), 5126: o => dv.getFloat32(o, true),
            }[a.componentType];
            const norm = a.normalized && !raw;
            for (let i = 0; i < count; i++) {
                const o = base + i * st;
                for (let k = 0; k < n; k++) {
                    const v = get(o + k * comp.size);
                    out[i * n + k] = norm ? comp.norm(v) : v;
                }
            }
        }
        if (a.sparse) {
            const sp = a.sparse;
            const idxArr = (() => {
                const { bytes } = viewBytes(sp.indices.bufferView);
                const c = COMPONENT[sp.indices.componentType];
                return new c.array(bytes.buffer.slice(bytes.byteOffset + (sp.indices.byteOffset || 0), bytes.byteOffset + (sp.indices.byteOffset || 0) + sp.count * c.size));
            })();
            const { bytes } = viewBytes(sp.values.bufferView);
            const vals = new comp.array(bytes.buffer.slice(bytes.byteOffset + (sp.values.byteOffset || 0), bytes.byteOffset + (sp.values.byteOffset || 0) + sp.count * n * comp.size));
            for (let i = 0; i < sp.count; i++) {
                for (let k = 0; k < n; k++) out[idxArr[i] * n + k] = a.normalized && !raw ? comp.norm(vals[i * n + k]) : vals[i * n + k];
            }
        }
        const res = { data: out, n, count, min: a.min, max: a.max };
        cache.set(key, res);
        return res;
    };

    // ---- meshes
    const meshes = (g.meshes || []).map((m, mi) => ({
        name: m.name || `mesh ${mi}`,
        primitives: (m.primitives || []).map((p, pi) => {
            if (p.extensions && p.extensions.KHR_draco_mesh_compression) throw new GLTFError(UNSUPPORTED.KHR_draco_mesh_compression);
            if (p.targets && p.targets.length && !warnings.includes('morph targets are ignored')) warnings.push('morph targets are ignored');
            const A = p.attributes || {};
            if (A.POSITION === undefined) throw new GLTFError(`mesh ${mi} primitive ${pi} has no POSITION`);
            if (A.TEXCOORD_1 !== undefined && !warnings.includes('only the first uv set (TEXCOORD_0) is used')) warnings.push('only the first uv set (TEXCOORD_0) is used');
            const pos = accessor(A.POSITION);
            let mode = p.mode === undefined ? 4 : p.mode;
            let indices = p.indices !== undefined ? accessor(p.indices, { raw: true }).data : null;
            const vcount = pos.count;
            // strips / fans -> lists
            if (mode === 5 || mode === 6) {
                const src = indices || Uint32Array.from({ length: vcount }, (_, i) => i);
                const tri = [];
                for (let i = 2; i < src.length; i++) {
                    if (mode === 5) { if (i % 2) tri.push(src[i - 1], src[i - 2], src[i]); else tri.push(src[i - 2], src[i - 1], src[i]); }
                    else tri.push(src[0], src[i - 1], src[i]);
                }
                indices = tri;
                mode = 4;
            } else if (mode === 2 || mode === 3) {
                const src = indices || Uint32Array.from({ length: vcount }, (_, i) => i);
                const ln = [];
                for (let i = 1; i < src.length; i++) ln.push(src[i - 1], src[i]);
                if (mode === 2 && src.length > 2) ln.push(src[src.length - 1], src[0]);
                indices = ln;
                mode = 1;
            }
            if (indices && !(indices instanceof Uint16Array || indices instanceof Uint32Array)) {
                indices = vcount > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices);
            }
            let normals = A.NORMAL !== undefined ? accessor(A.NORMAL).data : null;
            if (!normals && mode === 4) normals = computeNormals(pos.data, indices, vcount);
            const uvs = A.TEXCOORD_0 !== undefined ? accessor(A.TEXCOORD_0).data : null;
            let colors = null, colorSize = 4;
            if (A.COLOR_0 !== undefined) {
                const c = accessor(A.COLOR_0);
                colors = c.data;
                colorSize = c.n;
            }
            const joints = A.JOINTS_0 !== undefined ? accessor(A.JOINTS_0, { raw: false }).data : null;
            let weights = A.WEIGHTS_0 !== undefined ? accessor(A.WEIGHTS_0).data : null;
            if (weights) {
                // normalise (exporters leave small drifts)
                for (let i = 0; i < weights.length; i += 4) {
                    const s = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3];
                    if (s > 1e-6 && Math.abs(s - 1) > 1e-4) for (let k = 0; k < 4; k++) weights[i + k] /= s;
                }
            }
            const bounds = boundsOf(pos.data);
            return {
                positions: pos.data, normals, uvs, colors, colorSize, joints, weights, indices,
                mode: mode === 0 ? 'points' : mode === 1 ? 'lines' : 'triangles',
                material: p.material !== undefined ? p.material : -1,
                bounds,
            };
        }),
    }));

    // ---- nodes
    const nodes = (g.nodes || []).map((n, i) => ({
        name: n.name || `node ${i}`,
        mesh: n.mesh !== undefined ? n.mesh : -1,
        skin: n.skin !== undefined ? n.skin : -1,
        children: n.children || [],
        matrix: n.matrix ? Float32Array.from(n.matrix) : null,
        t: n.translation ? n.translation.slice() : [0, 0, 0],
        r: n.rotation ? n.rotation.slice() : [0, 0, 0, 1],
        s: n.scale ? n.scale.slice() : [1, 1, 1],
        camera: n.camera !== undefined ? n.camera : -1,
    }));
    const parents = new Int32Array(nodes.length).fill(-1);
    nodes.forEach((n, i) => n.children.forEach(c => { parents[c] = i; }));
    const scenes = (g.scenes || []).map(s => ({ name: s.name || '', nodes: s.nodes || [] }));
    let scene = g.scene !== undefined ? g.scene : 0;
    if (!scenes.length) {
        scenes.push({ name: '', nodes: nodes.map((_, i) => i).filter(i => parents[i] < 0) });
        scene = 0;
    }

    // ---- materials
    const materials = (g.materials || []).map((m, i) => {
        const pbr = m.pbrMetallicRoughness || {};
        const ext = m.extensions || {};
        const tex = t => (t ? { index: t.index, texCoord: t.texCoord || 0, scale: t.scale, strength: t.strength } : null);
        const strength = ext.KHR_materials_emissive_strength ? Number(ext.KHR_materials_emissive_strength.emissiveStrength) || 1 : 1;
        return {
            name: m.name || `material ${i}`,
            baseColor: pbr.baseColorFactor || [1, 1, 1, 1],
            metallic: pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1,
            roughness: pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1,
            emissive: (m.emissiveFactor || [0, 0, 0]).map(v => v * strength),
            baseTex: tex(pbr.baseColorTexture),
            mrTex: tex(pbr.metallicRoughnessTexture),
            normalTex: tex(m.normalTexture),
            occTex: tex(m.occlusionTexture),
            emTex: tex(m.emissiveTexture),
            alphaMode: m.alphaMode || 'OPAQUE',
            alphaCutoff: m.alphaCutoff !== undefined ? m.alphaCutoff : 0.5,
            doubleSided: !!m.doubleSided,
            unlit: !!ext.KHR_materials_unlit,
        };
    });

    // ---- textures / images (decoded later, on the GPU side)
    const images = (g.images || []).map((im, i) => {
        let bytes = null, mime = im.mimeType || 'image/png';
        if (im.bufferView !== undefined) bytes = viewBytes(im.bufferView).bytes;
        else if (im.uri) {
            const d = decodeDataURI(im.uri);
            if (!d) { warnings.push(`image ${i} is an external file (${im.uri}): skipped`); return null; }
            bytes = d.bytes;
            mime = d.mime || mime;
        }
        if (!bytes) return null;
        return { blob: new Blob([bytes], { type: mime }), mime };
    });
    const samplers = g.samplers || [];
    const textures = (g.textures || []).map(t => {
        const src = t.source !== undefined ? t.source : (t.extensions && t.extensions.EXT_texture_webp ? t.extensions.EXT_texture_webp.source : undefined);
        return { image: src !== undefined ? images[src] : null, sampler: t.sampler !== undefined ? samplers[t.sampler] || {} : {} };
    });

    // ---- skins
    const skins = (g.skins || []).map((s, i) => {
        const joints = s.joints || [];
        let ibm;
        if (s.inverseBindMatrices !== undefined) ibm = accessor(s.inverseBindMatrices).data;
        else { ibm = new Float32Array(16 * joints.length); for (let j = 0; j < joints.length; j++) ibm.set(IDENT, j * 16); }
        if (joints.length > 1024) throw new GLTFError(`skin ${i} has ${joints.length} joints (1024 max)`);
        return { name: s.name || `skin ${i}`, joints, inverseBind: ibm, skeleton: s.skeleton !== undefined ? s.skeleton : -1 };
    });

    // ---- animations
    const animations = (g.animations || []).map((an, i) => {
        let duration = 0;
        const channels = [];
        for (const ch of an.channels || []) {
            const t = ch.target || {};
            if (t.node === undefined || !['translation', 'rotation', 'scale'].includes(t.path)) continue;
            const sm = an.samplers[ch.sampler];
            if (!sm) continue;
            const times = accessor(sm.input).data;
            const values = accessor(sm.output).data;
            duration = Math.max(duration, times[times.length - 1] || 0);
            channels.push({ node: t.node, path: t.path, times, values, interp: sm.interpolation || 'LINEAR', n: t.path === 'rotation' ? 4 : 3 });
        }
        return { name: an.name || `clip ${i}`, duration, channels };
    });

    const cameras = (g.cameras || []).map(c => ({ type: c.type, yfov: c.perspective ? c.perspective.yfov : null }));
    return { meshes, nodes, parents, scenes, scene, materials, textures, skins, animations, cameras, warnings, generator: asset.generator || '' };
}

const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function boundsOf(p) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            if (p[i + k] < min[k]) min[k] = p[i + k];
            if (p[i + k] > max[k]) max[k] = p[i + k];
        }
    }
    return { min, max };
}

function computeNormals(p, idx, vcount) {
    const n = new Float32Array(vcount * 3);
    const tri = idx ? idx.length / 3 : vcount / 3;
    for (let t = 0; t < tri; t++) {
        const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
        const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
        const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const v of [a, b, c]) { n[v * 3] += nx; n[v * 3 + 1] += ny; n[v * 3 + 2] += nz; }
    }
    for (let i = 0; i < vcount; i++) {
        const l = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]) || 1;
        n[i * 3] /= l; n[i * 3 + 1] /= l; n[i * 3 + 2] /= l;
    }
    return n;
}

// ----------------------------------------------------------------------
// Math (column-major 4x4, like glTF / GLSL)
// ----------------------------------------------------------------------

export function mat4FromTRS(out, t, r, s) {
    const [x, y, z, w] = r;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = (1 - (yy + zz)) * s[0]; out[1] = (xy + wz) * s[0]; out[2] = (xz - wy) * s[0]; out[3] = 0;
    out[4] = (xy - wz) * s[1]; out[5] = (1 - (xx + zz)) * s[1]; out[6] = (yz + wx) * s[1]; out[7] = 0;
    out[8] = (xz + wy) * s[2]; out[9] = (yz - wx) * s[2]; out[10] = (1 - (xx + yy)) * s[2]; out[11] = 0;
    out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
    return out;
}

export function mat4Mul(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i++) {
        const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
        out[i * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
        out[i * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
        out[i * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
        out[i * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
    }
    return out;
}

/** Normal matrix (inverse transpose of the upper 3x3), column-major mat3. */
export function normalMat3(out, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a10 = m[4], a11 = m[5], a12 = m[6], a20 = m[8], a21 = m[9], a22 = m[10];
    const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (!det) { out.set([1, 0, 0, 0, 1, 0, 0, 0, 1]); return out; }
    det = 1 / det;
    // inverse (rows) transposed
    out[0] = b01 * det; out[1] = (-a22 * a01 + a02 * a21) * det; out[2] = (a12 * a01 - a02 * a11) * det;
    out[3] = b11 * det; out[4] = (a22 * a00 - a02 * a20) * det; out[5] = (-a12 * a00 + a02 * a10) * det;
    out[6] = b21 * det; out[7] = (-a21 * a00 + a01 * a20) * det; out[8] = (a11 * a00 - a01 * a10) * det;
    // transpose
    let t = out[1]; out[1] = out[3]; out[3] = t;
    t = out[2]; out[2] = out[6]; out[6] = t;
    t = out[5]; out[5] = out[7]; out[7] = t;
    return out;
}

function slerp(out, a, ai, b, bi, t) {
    let ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
    let bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
    let cos = ax * bx + ay * by + az * bz + aw * bw;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let k0, k1;
    if (cos > 0.9995) { k0 = 1 - t; k1 = t; }
    else {
        const th = Math.acos(cos), s = Math.sin(th);
        k0 = Math.sin((1 - t) * th) / s;
        k1 = Math.sin(t * th) / s;
    }
    out[0] = ax * k0 + bx * k1; out[1] = ay * k0 + by * k1; out[2] = az * k0 + bz * k1; out[3] = aw * k0 + bw * k1;
    const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l; out[3] /= l;
}

/** Sample one animation channel at time t (seconds, already wrapped) into out (3 or 4 floats). */
export function sampleChannel(ch, t, out) {
    const T = ch.times, V = ch.values, n = ch.n;
    const last = T.length - 1;
    const cubic = ch.interp === 'CUBICSPLINE';
    const stride = cubic ? n * 3 : n;
    const off = cubic ? n : 0; // value (between in / out tangents)
    if (last < 0) return out;
    if (t <= T[0] || last === 0) { for (let k = 0; k < n; k++) out[k] = V[off + k]; return out; }
    if (t >= T[last]) { for (let k = 0; k < n; k++) out[k] = V[last * stride + off + k]; return out; }
    let lo = 0, hi = last;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const dt = T[hi] - T[lo];
    const u = dt > 0 ? (t - T[lo]) / dt : 0;
    if (ch.interp === 'STEP') { for (let k = 0; k < n; k++) out[k] = V[lo * stride + k]; return out; }
    if (cubic) {
        const u2 = u * u, u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
        for (let k = 0; k < n; k++) {
            const p0 = V[lo * stride + n + k], m0 = V[lo * stride + 2 * n + k] * dt;
            const p1 = V[hi * stride + n + k], m1 = V[hi * stride + k] * dt;
            out[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
        }
        if (n === 4) { const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1; for (let k = 0; k < 4; k++) out[k] /= l; }
        return out;
    }
    if (n === 4) { slerp(out, V, lo * 4, V, hi * 4, u); return out; }
    for (let k = 0; k < n; k++) out[k] = V[lo * n + k] + (V[hi * n + k] - V[lo * n + k]) * u;
    return out;
}
