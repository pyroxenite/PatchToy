/**
 * Model node: a glTF 2.0 model drawn by a Render 3D node (parser: gltf.js).
 *
 * data.src = data URL (stored in the project, up to MODEL_SIZE_CAP) or URL. Loading is
 * asynchronous; until it is ready the model draws nothing. Every frame (once per frame,
 * when a Render 3D draws it) the clip at `time` is evaluated on the CPU: node TRS ->
 * world matrices -> per-primitive model / normal matrices, joint matrices uploaded to a
 * float texture (4 texels per joint) read by the vertex shader (R3_SKIN).
 */
import { LibraryNode } from '../nodes/LibraryNode.js';
import { COLORS, FONTS } from '../ui/theme.js';
import { fitText } from '../rendering/NodePainter.js';
import { clock } from '../core/Clock.js';
import { parseGLTF, mat4FromTRS, mat4Mul, normalMat3, sampleChannel } from './gltf.js';
import { uploadMesh, freeMesh, bindProgramUniforms } from './gl.js';
import { R3D, cpuInput, inputIndex } from './runtime.js';

/** Models up to this size are stored in the project as a data URL. */
export const MODEL_SIZE_CAP = 15 * 1024 * 1024;
const STATUS_H = 16;
const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function toast(msg, kind = 'info') {
    try {
        import('../ui/UIHelpers.js').then(m => m.UIHelpers && m.UIHelpers.toast && m.UIHelpers.toast(msg, kind)).catch(() => { });
    } catch (e) { /* ignore */ }
}

export class ModelNode extends LibraryNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isModelNode = true;
        this.modelReady = false;
        this.model = null;
        this.status = 'empty';
        this.error = null;
        this._loadKey = null;
        this._gl = null;
        this._gpu = null;
        this._frameStamp = -1;
        this._timeStamp = NaN;
        this._memoryBytes = null; // a model too large for the project (session only)
    }

    // ------------------------------------------------------------------ UI

    updateDimensions() {
        super.updateDimensions();
        if (this.heightForRows) this.height = this.heightForRows(Math.max(this.inputs.length, this.outputs.length, 1), STATUS_H);
    }

    drawBody(ctx, options = {}) {
        super.drawBody(ctx, options);
        const y = this.y + this.height - 9;
        ctx.save();
        ctx.font = FONTS.value;
        ctx.fillStyle = this.status === 'error' ? COLORS.error : COLORS.textFaint;
        const m = this.model;
        let text;
        if (this.status === 'error') text = this.error || 'error';
        else if (this.status === 'loading') text = `loading ${this.data.name || ''}…`;
        else if (m) text = `${this.data.name || 'model'} · ${m.stats.triangles.toLocaleString()} tris${m.animations.length ? ` · ${m.animations.length} clip${m.animations.length > 1 ? 's' : ''}` : ''}`;
        else text = 'drop a .glb on the canvas (or double-click)';
        ctx.fillText(fitText(ctx, FONTS.value, text, this.width - 16), this.x + 8, y);
        ctx.restore();
    }

    /** Double-click: pick a .glb / .gltf file. */
    openFilePicker() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.glb,.gltf,model/gltf-binary,model/gltf+json';
        input.onchange = () => {
            const f = input.files && input.files[0];
            if (f) assignModelFile(this, f).catch(e => { this.status = 'error'; this.error = e.message; });
        };
        input.click();
    }

    // ------------------------------------------------------------------ loading

    sourceKey() {
        if (this._memoryBytes) return `mem:${this._memoryBytes.byteLength}:${this.data.name}`;
        const s = this.data.src;
        if (!s) return null;
        return s.length > 256 ? `${s.length}:${s.slice(0, 64)}:${s.slice(-64)}` : s;
    }

    ensureLoaded() {
        const key = this.sourceKey();
        if (key === this._loadKey) return;
        this._loadKey = key;
        this.releaseGPU();
        this.model = null;
        this.modelReady = false;
        if (!key) { this.status = 'empty'; return; }
        this.status = 'loading';
        this._loading = this.load(key).catch(e => {
            if (this._loadKey !== key) return;
            this.status = 'error';
            this.error = e.message || String(e);
            console.warn(`[render3d] Model #${this.id}: ${this.error}`);
        });
    }

    async load(key) {
        let buf;
        if (this._memoryBytes) buf = this._memoryBytes;
        else {
            const res = await fetch(this.data.src);
            if (!res.ok) throw new Error(`could not load the model (${res.status})`);
            buf = await res.arrayBuffer();
        }
        const model = parseGLTF(buf);
        // Decode images (async, off the main thread)
        await Promise.all(model.textures.map(async (t) => {
            if (!t.image || t.image.bitmap) return;
            try {
                t.image.bitmap = await createImageBitmap(t.image.blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
            } catch (e) {
                model.warnings.push(`an image could not be decoded (${t.image.mime})`);
                t.image = null;
            }
        }));
        if (this._loadKey !== key) return;
        prepareModelData(model);
        this.model = model;
        this.status = 'ready';
        this.error = null;
        this.modelReady = true;
        this._frameStamp = -1;
        if (model.warnings.length) console.info(`[render3d] Model #${this.id}: ${model.warnings.join('; ')}`);
        if (this.graph) this.graph.render();
    }

    // ------------------------------------------------------------------ GPU

    uploadGPU(gl) {
        const m = this.model;
        this._gl = gl;
        const gpu = { meshes: [], textures: new Map(), jointTex: [] };
        for (const mesh of m.meshes) {
            gpu.meshes.push(mesh.primitives.map(p => uploadMesh(gl, {
                positions: p.positions, normals: p.normals, uvs: p.uvs, colors: p.colors, colorSize: p.colorSize,
                joints: p.joints, weights: p.weights, indices: p.indices, mode: p.mode,
            })));
        }
        for (const s of m.skins) {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, Math.max(1, s.joints.length * 4), 1, 0, gl.RGBA, gl.FLOAT, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gpu.jointTex.push(t);
        }
        gl.bindTexture(gl.TEXTURE_2D, null);
        this._gpu = gpu;
    }

    /** GL texture of glTF texture `index` (sRGB-decoded for colour textures). */
    texture(gl, index, srgb) {
        const key = `${index}|${srgb ? 1 : 0}`;
        const gpu = this._gpu;
        if (gpu.textures.has(key)) return gpu.textures.get(key);
        const t = this.model.textures[index];
        let tex = null;
        if (t && t.image && t.image.bitmap) {
            tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, t.image.bitmap);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
            const s = t.sampler || {};
            const wrap = w => (w === 33071 ? gl.CLAMP_TO_EDGE : w === 33648 ? gl.MIRRORED_REPEAT : gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(s.wrapS));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(s.wrapT));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, s.magFilter === 9728 ? gl.NEAREST : gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, s.minFilter === 9728 || s.minFilter === 9729 ? s.minFilter : gl.LINEAR_MIPMAP_LINEAR);
            gl.generateMipmap(gl.TEXTURE_2D);
            const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
            if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
        gpu.textures.set(key, tex);
        return tex;
    }

    releaseGPU() {
        const gl = this._gl;
        const gpu = this._gpu;
        if (gl && gpu) {
            for (const list of gpu.meshes) for (const m of list) freeMesh(gl, m);
            for (const t of gpu.textures.values()) if (t) gl.deleteTexture(t);
            for (const t of gpu.jointTex) gl.deleteTexture(t);
        }
        this._gpu = null;
    }

    cleanup() {
        this.releaseGPU();
        this.model = null;
        this.modelReady = false;
        this._loadKey = null;
    }

    // ------------------------------------------------------------------ per frame

    /** Evaluate the animation and the matrices (once per frame / pinned time). */
    prepareModel(gl) {
        this.ensureLoaded();
        const m = this.model;
        if (!m) return;
        if (!this._gpu || this._gl !== gl) this.uploadGPU(gl);
        if (this._frameStamp === clock.frame && this._timeStamp === clock.u.time && this._epoch === R3D.epoch) return;
        this._frameStamp = clock.frame;
        this._timeStamp = clock.u.time;
        this._epoch = R3D.epoch;
        const ci = this._clipIdx !== undefined ? this._clipIdx : (this._clipIdx = inputIndex(this, 'clip'));
        const ti = this._timeIdx !== undefined ? this._timeIdx : (this._timeIdx = inputIndex(this, 'time'));
        const clip = Math.round(cpuInput(this, ci, Number(this.data.clip) || 0));
        const time = cpuInput(this, ti, clock.u.time);
        evaluatePose(m, clip, time, this.data.fit ? m.fitMatrix : null);
        // joint matrices
        for (let s = 0; s < m.skins.length; s++) {
            const sk = m.skins[s];
            const arr = sk.jointData;
            for (let j = 0; j < sk.joints.length; j++) {
                mat4Mul(m.tmp, m.world[sk.joints[j]], sk.inverseBind.subarray(j * 16, j * 16 + 16));
                arr.set(m.tmp, j * 16);
            }
            gl.bindTexture(gl.TEXTURE_2D, this._gpu.jointTex[s]);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sk.joints.length * 4, 1, gl.RGBA, gl.FLOAT, arr);
        }
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    /**
     * Draw every primitive (Render 3D drawObject). phase 0 = opaque / mask primitives,
     * 1 = blended ones (alpha blending set here); pass 'shadow' = depth only.
     */
    drawModel(gl, r3, dr, pass, W, H, registry, guard, shadowOn, phase = 0) {
        const m = this.model;
        if (!m || !this._gpu) return;
        const forceBlend = dr.blend === 'alpha' || dr.blend === 'add';
        for (let i = 0; i < m.drawList.length; i++) {
            const it = m.drawList[i];
            const p = it.prim;
            const mat = p.material >= 0 ? m.materials[p.material] : DEFAULT_MAT;
            const blended = forceBlend || (dr.fileMaterial && mat.alphaMode === 'BLEND');
            if (pass === 'shadow') { if (blended) continue; }
            else if ((phase === 1) !== blended) continue;
            const mesh = this._gpu.meshes[it.mesh][it.primIndex];
            const defs = pass === 'shadow' ? it.shadowDefines : (dr.fileMaterial ? it.defines : it.skinDefines);
            const v = r3.variant(dr, pass === 'shadow' ? 'shadow' : 'main', defs.list, defs.key);
            if (!v.entry) continue;
            const L = v.entry.uniforms;
            gl.useProgram(v.entry.program);
            let unit = bindProgramUniforms(gl, L, pass === 'shadow' ? dr.shadowUniforms : dr.uniforms, registry, guard, W, H, this.graph, 1);
            unit = r3.setR3Uniforms(gl, L, dr, W, H, shadowOn, unit, guard, it.skin >= 0 ? IDENT : m.world[it.node], it.skin >= 0 ? IDENT3 : it.normalMat);
            if (it.skin >= 0 && L.r3_joints) {
                guard.bindTexture(unit, this._gpu.jointTex[it.skin]);
                gl.uniform1i(L.r3_joints, unit);
                unit++;
            }
            if (pass !== 'shadow' && dr.fileMaterial) unit = this.setMaterial(gl, L, mat, unit, guard);
            if (pass !== 'shadow') {
                r3.rebindTarget(gl, r3.targets.drawTarget(), W, H, blended ? { blend: 'alpha' } : null);
                if (mat.doubleSided || p.mode !== 'triangles') gl.disable(gl.CULL_FACE);
                else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
                if (blended && !forceBlend) {
                    gl.enable(gl.BLEND);
                    gl.depthMask(false);
                    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                }
            }
            r3.issue(gl, mesh, dr._count, dr);
            if (pass !== 'shadow' && blended && !forceBlend) {
                gl.disable(gl.BLEND);
                gl.depthMask(true);
            }
        }
    }

    setMaterial(gl, L, mat, unit, guard) {
        const b = mat.baseColor;
        if (L.r3m_base) gl.uniform4f(L.r3m_base, b[0], b[1], b[2], b[3] === undefined ? 1 : b[3]);
        if (L.r3m_mr) gl.uniform3f(L.r3m_mr, mat.metallic, mat.roughness, 0);
        if (L.r3m_emissive) gl.uniform3f(L.r3m_emissive, mat.emissive[0], mat.emissive[1], mat.emissive[2]);
        if (L.r3m_alphaCutoff) gl.uniform1f(L.r3m_alphaCutoff, mat.alphaCutoff);
        if (L.r3m_normalScale) gl.uniform1f(L.r3m_normalScale, mat.normalTex && mat.normalTex.scale !== undefined ? mat.normalTex.scale : 1);
        if (L.r3m_occStrength) gl.uniform1f(L.r3m_occStrength, mat.occTex && mat.occTex.strength !== undefined ? mat.occTex.strength : 1);
        if (L.r3m_unlit) gl.uniform1f(L.r3m_unlit, mat.unlit ? 1 : 0);
        for (const [loc, tex, srgb] of [[L.r3m_baseTex, mat.baseTex, true], [L.r3m_mrTex, mat.mrTex, false], [L.r3m_normalTex, mat.normalTex, false], [L.r3m_emTex, mat.emTex, true], [L.r3m_occTex, mat.occTex, false]]) {
            if (!loc || !tex) continue;
            guard.bindTexture(unit, this.texture(gl, tex.index, srgb));
            gl.uniform1i(loc, unit);
            unit++;
        }
        return unit;
    }

    describeModel() {
        const m = this.model;
        const d = { status: this.status, name: this.data.name || null };
        if (this.error) d.error = this.error;
        if (this.data.src && this.data.src.startsWith('data:')) d.bytes = Math.round(this.data.src.length * 0.75);
        if (this._memoryBytes) { d.bytes = this._memoryBytes.byteLength; d.stored_in_project = false; }
        if (m) {
            Object.assign(d, m.stats);
            d.clips = m.animations.map((a, i) => ({ index: i, name: a.name, duration: +a.duration.toFixed(3) }));
            if (m.warnings.length) d.warnings = m.warnings.slice();
        }
        return d;
    }
}

const IDENT3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const DEFAULT_MAT = { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.6, emissive: [0, 0, 0], alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false, unlit: false };

/** Per-model draw list, variant defines, stats, fit matrix; work arrays for the pose. */
function prepareModelData(m) {
    const n = m.nodes.length;
    m.world = m.nodes.map(() => new Float32Array(16));
    m.local = new Float32Array(16);
    m.tmp = new Float32Array(16);
    m.T = new Float32Array(n * 3);
    m.R = new Float32Array(n * 4);
    m.S = new Float32Array(n * 3);
    m.vec = new Float32Array(4);
    m.animated = new Uint8Array(n);
    m.t3 = [0, 0, 0];
    m.r4 = [0, 0, 0, 1];
    m.s3 = [1, 1, 1];
    m.order = [];
    const scene = m.scenes[m.scene] || m.scenes[0] || { nodes: [] };
    const visit = (i, depth) => {
        if (depth > 64 || m.order.includes(i)) return;
        m.order.push(i);
        for (const c of m.nodes[i].children) visit(c, depth + 1);
    };
    for (const r of scene.nodes) visit(r, 0);
    for (const s of m.skins) s.jointData = new Float32Array(Math.max(1, s.joints.length) * 16);
    m.drawList = [];
    let triangles = 0, vertices = 0;
    for (const i of m.order) {
        const node = m.nodes[i];
        if (node.mesh < 0) continue;
        const mesh = m.meshes[node.mesh];
        mesh.primitives.forEach((p, pi) => {
            const skin = node.skin >= 0 && p.joints && p.weights ? node.skin : -1;
            const mat = p.material >= 0 ? m.materials[p.material] : DEFAULT_MAT;
            const skinList = skin >= 0 ? ['R3_SKIN'] : [];
            const list = [...skinList];
            if (p.mode === 'points') list.push('R3_POINTS');
            if (p.uvs) {
                if (mat.baseTex && m.textures[mat.baseTex.index] && m.textures[mat.baseTex.index].image) list.push('R3_TEX_BASE');
                if (mat.mrTex && m.textures[mat.mrTex.index] && m.textures[mat.mrTex.index].image) list.push('R3_TEX_MR');
                if (mat.normalTex && m.textures[mat.normalTex.index] && m.textures[mat.normalTex.index].image) list.push('R3_TEX_NORMAL');
                if (mat.emTex && m.textures[mat.emTex.index] && m.textures[mat.emTex.index].image) list.push('R3_TEX_EMISSIVE');
                if (mat.occTex && m.textures[mat.occTex.index] && m.textures[mat.occTex.index].image) list.push('R3_TEX_OCC');
            }
            if (mat.alphaMode === 'MASK') list.push('R3_ALPHA_MASK');
            m.drawList.push({
                node: i, mesh: node.mesh, primIndex: pi, prim: p, skin,
                normalMat: new Float32Array(9),
                defines: { list, key: list.join(',') },
                skinDefines: { list: skinList, key: skinList.join(',') },
                shadowDefines: { list: skinList, key: skinList.join(',') },
            });
            const vc = p.positions.length / 3;
            vertices += vc;
            if (p.mode === 'triangles') triangles += (p.indices ? p.indices.length : vc) / 3;
        });
    }
    // rest pose bounds -> fit matrix (largest dimension 2, centred on the origin)
    evaluatePose(m, -1, 0, null);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const it of m.drawList) {
        const b = it.prim.bounds;
        const w = m.world[it.node];
        for (let c = 0; c < 8; c++) {
            const x = c & 1 ? b.max[0] : b.min[0], y = c & 2 ? b.max[1] : b.min[1], z = c & 4 ? b.max[2] : b.min[2];
            const px = w[0] * x + w[4] * y + w[8] * z + w[12], py = w[1] * x + w[5] * y + w[9] * z + w[13], pz = w[2] * x + w[6] * y + w[10] * z + w[14];
            min[0] = Math.min(min[0], px); min[1] = Math.min(min[1], py); min[2] = Math.min(min[2], pz);
            max[0] = Math.max(max[0], px); max[1] = Math.max(max[1], py); max[2] = Math.max(max[2], pz);
        }
    }
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const k = 2 / size;
    m.fitMatrix = new Float32Array([k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, -(min[0] + max[0]) / 2 * k, -(min[1] + max[1]) / 2 * k, -(min[2] + max[2]) / 2 * k, 1]);
    m.boundsRest = { min, max };
    m.stats = {
        meshes: m.meshes.length,
        primitives: m.drawList.length,
        triangles: Math.round(triangles),
        vertices,
        materials: m.materials.length,
        textures: m.textures.filter(t => t.image).length,
        skins: m.skins.length,
        joints: m.skins.reduce((a, s) => a + s.joints.length, 0),
        nodes: m.nodes.length,
        bounds: { min: min.map(v => +v.toFixed(4)), max: max.map(v => +v.toFixed(4)) },
    };
}

/** Node world matrices for a clip at time (clip < 0 or no clips: rest pose). */
function evaluatePose(m, clip, time, root) {
    const n = m.nodes.length;
    for (let i = 0; i < n; i++) {
        const nd = m.nodes[i];
        m.T[i * 3] = nd.t[0]; m.T[i * 3 + 1] = nd.t[1]; m.T[i * 3 + 2] = nd.t[2];
        m.R[i * 4] = nd.r[0]; m.R[i * 4 + 1] = nd.r[1]; m.R[i * 4 + 2] = nd.r[2]; m.R[i * 4 + 3] = nd.r[3];
        m.S[i * 3] = nd.s[0]; m.S[i * 3 + 1] = nd.s[1]; m.S[i * 3 + 2] = nd.s[2];
    }
    const anim = clip >= 0 && clip < m.animations.length ? m.animations[clip] : null;
    const animated = m.animated;
    animated.fill(0);
    if (anim && anim.duration > 0) {
        let t = time % anim.duration;
        if (t < 0) t += anim.duration;
        const v = m.vec;
        for (const ch of anim.channels) {
            sampleChannel(ch, t, v);
            const i = ch.node;
            animated[i] = 1;
            if (ch.path === 'translation') { m.T[i * 3] = v[0]; m.T[i * 3 + 1] = v[1]; m.T[i * 3 + 2] = v[2]; }
            else if (ch.path === 'rotation') { m.R[i * 4] = v[0]; m.R[i * 4 + 1] = v[1]; m.R[i * 4 + 2] = v[2]; m.R[i * 4 + 3] = v[3]; }
            else { m.S[i * 3] = v[0]; m.S[i * 3 + 1] = v[1]; m.S[i * 3 + 2] = v[2]; }
        }
    }
    const t3 = m.t3, r4 = m.r4, s3 = m.s3;
    for (const i of m.order) {
        const nd = m.nodes[i];
        let local;
        if (nd.matrix && !animated[i]) local = nd.matrix;
        else {
            t3[0] = m.T[i * 3]; t3[1] = m.T[i * 3 + 1]; t3[2] = m.T[i * 3 + 2];
            r4[0] = m.R[i * 4]; r4[1] = m.R[i * 4 + 1]; r4[2] = m.R[i * 4 + 2]; r4[3] = m.R[i * 4 + 3];
            s3[0] = m.S[i * 3]; s3[1] = m.S[i * 3 + 1]; s3[2] = m.S[i * 3 + 2];
            local = mat4FromTRS(m.local, t3, r4, s3);
        }
        const p = m.parents[i];
        if (p >= 0) mat4Mul(m.world[i], m.world[p], local);
        else if (root) mat4Mul(m.world[i], root, local);
        else m.world[i].set(local);
    }
    if (m.drawList) for (const it of m.drawList) normalMat3(it.normalMat, m.world[it.node]);
}

// ----------------------------------------------------------------------
// Loading from files (drop, file picker, automation)
// ----------------------------------------------------------------------

function bytesToDataURL(bytes, mime) {
    let s = '';
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return `data:${mime};base64,${btoa(s)}`;
}

/**
 * Give a Model node the bytes of a .glb / .gltf. Up to MODEL_SIZE_CAP they are stored in
 * the project as a data URL; above, the model is kept for this session only.
 */
export async function assignModelBytes(node, bytes, name) {
    const isGlb = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength)).every((b, i) => b === [0x67, 0x6C, 0x54, 0x46][i]);
    const mime = isGlb ? 'model/gltf-binary' : 'model/gltf+json';
    // validate before storing (clear errors: Draco, meshopt, external files...)
    parseGLTF(bytes);
    node.data.name = name || node.data.name || 'model';
    if (bytes.byteLength <= MODEL_SIZE_CAP) {
        node._memoryBytes = null;
        node.data.src = bytesToDataURL(bytes, mime);
        if (bytes.byteLength > 5 * 1024 * 1024) toast(`${name}: ${(bytes.byteLength / 1048576).toFixed(1)} MB stored in the project (large projects save and load slowly)`, 'warning');
        return { stored: true };
    }
    node.data.src = '';
    node._memoryBytes = bytes;
    toast(`${name}: ${(bytes.byteLength / 1048576).toFixed(1)} MB is over the ${MODEL_SIZE_CAP / 1048576} MB cap: shown for this session but not saved in the project`, 'warning');
    return { stored: false };
}

export async function assignModelFile(node, file) {
    const bytes = await file.arrayBuffer();
    const res = await assignModelBytes(node, bytes, file.name);
    node._loadKey = undefined;
    node.ensureLoaded();
    if (node.graph && node.graph.onGraphChanged) node.graph.onGraphChanged();
    return res;
}

/**
 * Create a Model node for a dropped file at a canvas position, wired into a Render 3D
 * node (the first one, or a new Render 3D + Preview).
 */
export async function loadModelFile(app, file, pos) {
    const bytes = await file.arrayBuffer();
    return createModelNode(app, bytes, file.name, pos);
}

export async function createModelNode(app, bytes, name, pos = { x: 100, y: 100 }, { connect = true } = {}) {
    const g = app.nodeGraph;
    const node = g.addNode ? g.addNode('Model', pos.x, pos.y) : null;
    if (!node) throw new Error('could not create a Model node');
    let res;
    try {
        res = await assignModelBytes(node, bytes, name);
    } catch (e) {
        node.status = 'error';
        node.error = e.message;
        throw e;
    }
    node.data.fit = 1;
    if (connect) {
        let r3 = g.nodes.find(n => n.isRender3DNode);
        if (!r3 && g.addNode) {
            r3 = g.addNode('Render3D', pos.x + 260, pos.y);
            const pv = g.addNode('Preview', pos.x + 560, pos.y);
            if (r3 && pv) await linkPorts(g, r3, 'color', pv, 'color');
        }
        if (r3) {
            const k = r3.data.items;
            const idx = r3.inputs.findIndex(i => i.name === `item${k}`);
            if (idx >= 0) await linkPorts(g, node, 'object', r3, `item${k}`);
            if (r3.shouldAddNewInput && r3.shouldAddNewInput()) r3.addDynamicInput();
        }
    }
    node._loadKey = undefined;
    node.ensureLoaded();
    if (g.onGraphChanged) g.onGraphChanged();
    g.render && g.render();
    return { node, ...res };
}

async function linkPorts(g, from, outName, to, inName) {
    const out = from.outputs.findIndex(o => o.name === outName);
    const inp = to.inputs.findIndex(i => i.name === inName);
    if (out < 0 || inp < 0) return false;
    const { Connection } = await import('../core/NodeGraph.js');
    g.connections = g.connections.filter(c => !(c.toNode === to && c.toInput === inp));
    g.connections.push(new Connection(from, out, to, inp));
    return true;
}
