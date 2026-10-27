/**
 * WebGL2 plumbing for Render 3D: render targets (MRT + MSAA), the shadow map, mesh
 * buffers (VAOs), the GL state save / restore around a render, uniform binding.
 *
 * Everything runs in the app's shared GL context. A Render 3D node renders lazily, when
 * a consumer binds one of its textures (ShaderPreview / Feedback / probe uniform loops)
 * or its own thumbnail is drawn: render() saves the bits of GL state other renderers
 * rely on and restores them afterwards, so it can run in the middle of another
 * renderer's uniform setup.
 */
import { applyClockUniforms } from '../core/Clock.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';
import { cameraTexture } from '../rendering/glResources.js';

// Attribute locations shared by every Render 3D program (layout(location = N) in the VS)
export const ATTR = { position: 0, normal: 1, uv: 2, color: 3, joints: 4, weights: 5 };

const capsCache = new WeakMap();

/** Float render targets / MSAA support of a context (cached). */
export function glCaps(gl) {
    let c = capsCache.get(gl);
    if (c) return c;
    const floatRT = !!gl.getExtension('EXT_color_buffer_float');
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
    const samplesFor = (fmt) => {
        try {
            const s = gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES);
            return s && s.length ? Math.max(...s) : 0;
        } catch (e) { return 0; }
    };
    c = {
        floatRT,
        maxSamples,
        msaaColor: floatRT ? samplesFor(gl.RGBA16F) : samplesFor(gl.RGBA8),
        msaaR32F: floatRT ? samplesFor(gl.R32F) : 0,
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096,
        maxUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) || 32,
    };
    capsCache.set(gl, c);
    return c;
}

function makeTex(gl, w, h, internal, format, type, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
}

function makeRB(gl, samples, internal, w, h) {
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    if (samples > 1) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, internal, w, h);
    else gl.renderbufferStorage(gl.RENDERBUFFER, internal, w, h);
    return rb;
}

/**
 * The textures a Render 3D node outputs (color RGBA16F, depth R32F, normal RGBA16F) and the
 * framebuffers it draws into. With MSAA the scene is drawn into multisampled renderbuffers
 * and resolved (blitFramebuffer) into the textures.
 */
export class R3Targets {
    constructor(gl) {
        this.gl = gl;
        this.w = 0;
        this.h = 0;
        this.key = '';
        this.tex = { color: null, depth: null, normal: null };
        this.fbo = null;       // resolve / single-sample target (textures + depth renderbuffer)
        this.msFbo = null;     // multisampled target
        this.rbs = [];
        this.samples = 0;
        this.has = { depth: false, normal: false };
        this.drawBuffers = null;
        this.drawBuffersMs = null;
        this.bytes = 0;
    }

    /** (Re)allocate for w x h with these attachments. Returns true when (re)created. */
    ensure(w, h, { msaa = 4, depth = false, normal = false } = {}) {
        const gl = this.gl;
        const caps = glCaps(gl);
        let samples = 0;
        if (msaa > 1 && caps.maxSamples > 1) {
            samples = Math.min(msaa, caps.maxSamples, caps.msaaColor || 0);
            if (depth && caps.floatRT) samples = Math.min(samples, caps.msaaR32F || 0);
            if (samples < 2) samples = 0;
        }
        const key = `${w}x${h}|${samples}|${depth ? 1 : 0}${normal ? 1 : 0}`;
        if (key === this.key && this.fbo) return false;
        this.release();
        this.key = key;
        this.w = w;
        this.h = h;
        this.samples = samples;
        this.has.depth = depth;
        this.has.normal = normal;
        const f16 = caps.floatRT;
        const colorFmt = f16 ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
        const depthFmt = f16 ? [gl.R32F, gl.RED, gl.FLOAT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
        this.tex.color = makeTex(gl, w, h, colorFmt[0], colorFmt[1], colorFmt[2], gl.LINEAR);
        this.tex.depth = depth ? makeTex(gl, w, h, depthFmt[0], depthFmt[1], depthFmt[2], gl.NEAREST) : null;
        this.tex.normal = normal ? makeTex(gl, w, h, colorFmt[0], colorFmt[1], colorFmt[2], gl.NEAREST) : null;
        this.colorInternal = colorFmt[0];
        this.depthInternal = depthFmt[0];
        const db = [gl.COLOR_ATTACHMENT0, depth ? gl.COLOR_ATTACHMENT1 : gl.NONE, normal ? gl.COLOR_ATTACHMENT2 : gl.NONE];
        this.drawBuffers = db;

        this.fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex.color, 0);
        if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.tex.depth, 0);
        if (normal) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.tex.normal, 0);
        if (!samples) {
            const zrb = makeRB(gl, 0, gl.DEPTH_COMPONENT24, w, h);
            this.rbs.push(zrb);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, zrb);
        }
        gl.drawBuffers(db);
        let ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

        if (samples && ok) {
            this.msFbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
            const c = makeRB(gl, samples, colorFmt[0], w, h);
            this.rbs.push(c);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c);
            if (depth) {
                const d = makeRB(gl, samples, depthFmt[0], w, h);
                this.rbs.push(d);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, d);
            }
            if (normal) {
                const n = makeRB(gl, samples, colorFmt[0], w, h);
                this.rbs.push(n);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.RENDERBUFFER, n);
            }
            const z = makeRB(gl, samples, gl.DEPTH_COMPONENT24, w, h);
            this.rbs.push(z);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, z);
            gl.drawBuffers(db);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                // MSAA not usable with these formats: single-sample with its own depth buffer
                gl.deleteFramebuffer(this.msFbo);
                this.msFbo = null;
                this.samples = 0;
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
                const zrb = makeRB(gl, 0, gl.DEPTH_COMPONENT24, w, h);
                this.rbs.push(zrb);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, zrb);
                ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
            }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.ok = ok;
        const px = w * h;
        const cb = f16 ? 8 : 4;
        this.bytes = px * (cb + (depth ? 4 : 0) + (normal ? cb : 0)) + px * Math.max(1, this.samples) * (cb + (depth ? 4 : 0) + (normal ? cb : 0) + 4) * (this.samples ? 1 : 0) + (this.samples ? 0 : px * 4);
        return true;
    }

    /** The framebuffer to draw into this frame. */
    drawTarget() {
        return this.msFbo || this.fbo;
    }

    /** Resolve the multisampled attachments into the output textures. */
    resolve() {
        if (!this.msFbo) return;
        const gl = this.gl;
        const w = this.w, h = this.h;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
        const att = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2];
        const on = [true, this.has.depth, this.has.normal];
        const bufs = this._blitBufs || (this._blitBufs = [[gl.COLOR_ATTACHMENT0], [gl.NONE, gl.COLOR_ATTACHMENT1], [gl.NONE, gl.NONE, gl.COLOR_ATTACHMENT2]]);
        for (let i = 0; i < 3; i++) {
            if (!on[i]) continue;
            gl.readBuffer(att[i]);
            gl.drawBuffers(bufs[i]);
            gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        }
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.drawBuffers(this.drawBuffers);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    }

    release() {
        const gl = this.gl;
        if (!gl) return;
        for (const k of ['color', 'depth', 'normal']) {
            if (this.tex[k]) gl.deleteTexture(this.tex[k]);
            this.tex[k] = null;
        }
        for (const rb of this.rbs) gl.deleteRenderbuffer(rb);
        this.rbs = [];
        if (this.fbo) gl.deleteFramebuffer(this.fbo);
        if (this.msFbo) gl.deleteFramebuffer(this.msFbo);
        this.fbo = this.msFbo = null;
        this.key = '';
        this.bytes = 0;
    }
}

/** Directional shadow map: a depth texture compared in the shader (sampler2DShadow). */
export class R3ShadowMap {
    constructor(gl) {
        this.gl = gl;
        this.size = 0;
        this.tex = null;
        this.fbo = null;
    }

    ensure(size) {
        const gl = this.gl;
        if (this.tex && this.size === size) return;
        this.release();
        this.size = size;
        this.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, size, size, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        this.fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.tex, 0);
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);
        this.ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    release() {
        const gl = this.gl;
        if (this.tex) gl.deleteTexture(this.tex);
        if (this.fbo) gl.deleteFramebuffer(this.fbo);
        this.tex = this.fbo = null;
        this.size = 0;
    }
}

const GL_MODES = { triangles: 4, lines: 1, points: 0 }; // gl.TRIANGLES, gl.LINES, gl.POINTS

/**
 * Upload a CPU mesh (geometry.js format, or a glTF primitive) into a VAO.
 * Optional attributes may be typed arrays of any glTF component type: { data, size, type, normalized }.
 */
export function uploadMesh(gl, mesh, prev = null) {
    if (prev) freeMesh(gl, prev);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = [];
    const attr = (loc, a, size) => {
        if (!a) return false;
        const data = a.data || a;
        if (!data || !data.length) return false;
        const b = gl.createBuffer();
        buffers.push(b);
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        const type = a.type || gl.FLOAT;
        gl.vertexAttribPointer(loc, a.size || size, type, !!a.normalized, 0, 0);
        return true;
    };
    const has = {
        position: attr(ATTR.position, mesh.positions, 3),
        normal: attr(ATTR.normal, mesh.normals, 3),
        uv: attr(ATTR.uv, mesh.uvs, 2),
        color: attr(ATTR.color, mesh.colors, mesh.colorSize || 4),
        joints: attr(ATTR.joints, mesh.joints, 4),
        weights: attr(ATTR.weights, mesh.weights, 4),
    };
    let indexType = 0;
    if (mesh.indices && mesh.indices.length) {
        const b = gl.createBuffer();
        buffers.push(b);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
        indexType = mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : mesh.indices instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const vcount = mesh.positions ? (mesh.positions.data || mesh.positions).length / 3 : 0;
    return {
        vao, buffers, has, indexType,
        count: mesh.indices && mesh.indices.length ? mesh.indices.length : vcount,
        vertices: vcount,
        mode: GL_MODES[mesh.mode] !== undefined ? GL_MODES[mesh.mode] : 4,
        points: mesh.mode === 'points',
        triangles: mesh.mode === 'points' || mesh.mode === 'lines' ? 0 : Math.floor((mesh.indices && mesh.indices.length ? mesh.indices.length : vcount) / 3),
    };
}

export function freeMesh(gl, m) {
    if (!m) return;
    try {
        if (m.vao) gl.deleteVertexArray(m.vao);
        for (const b of m.buffers || []) gl.deleteBuffer(b);
    } catch (e) { /* context lost */ }
    m.vao = null;
    m.buffers = [];
}

/** Constant values of the attributes a mesh does not provide (context-wide state, set per draw). */
export function setDefaultAttribs(gl, has) {
    if (!has.normal) gl.vertexAttrib3f(ATTR.normal, 0, 1, 0);
    if (!has.uv) gl.vertexAttrib2f(ATTR.uv, 0, 0);
    if (!has.color) gl.vertexAttrib4f(ATTR.color, 1, 1, 1, 1);
    if (!has.joints) gl.vertexAttrib4f(ATTR.joints, 0, 0, 0, 0);
    if (!has.weights) gl.vertexAttrib4f(ATTR.weights, 0, 0, 0, 0);
    if (!has.position) gl.vertexAttrib3f(ATTR.position, 0, 0, 0);
}

// ----------------------------------------------------------------------
// GL state around a lazy render
// ----------------------------------------------------------------------

const CAPS = ['DEPTH_TEST', 'CULL_FACE', 'BLEND', 'POLYGON_OFFSET_FILL', 'SCISSOR_TEST'];

export class GLStateGuard {
    constructor(gl) {
        this.gl = gl;
        this.units = new Int32Array(64);
        this.unitTex = new Array(64).fill(null);
        this.saved = new Uint8Array(64);
        this.caps = new Uint8Array(CAPS.length);
        this.depth = 0;
    }

    begin() {
        const gl = this.gl;
        this.depth++;
        const s = this._stack || (this._stack = []);
        const frame = s[this.depth - 1] || (s[this.depth - 1] = { saved: new Uint8Array(64), tex: new Array(64).fill(null), caps: new Uint8Array(CAPS.length) });
        frame.drawFb = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
        frame.readFb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        frame.program = gl.getParameter(gl.CURRENT_PROGRAM);
        frame.vp = gl.getParameter(gl.VIEWPORT);
        frame.active = gl.getParameter(gl.ACTIVE_TEXTURE);
        frame.vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        frame.ab = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        frame.rb = gl.getParameter(gl.RENDERBUFFER_BINDING);
        for (let i = 0; i < CAPS.length; i++) frame.caps[i] = gl.isEnabled(gl[CAPS[i]]) ? 1 : 0;
        frame.saved.fill(0);
        this.frame = frame;
    }

    /** Bind texture to a unit, remembering the unit's previous binding the first time. */
    bindTexture(unit, tex) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + unit);
        const f = this.frame;
        if (f && !f.saved[unit]) {
            f.saved[unit] = 1;
            f.tex[unit] = gl.getParameter(gl.TEXTURE_BINDING_2D);
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
    }

    end() {
        const gl = this.gl;
        const f = this.frame;
        if (!f) return;
        for (let i = 0; i < 64; i++) {
            if (!f.saved[i]) continue;
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, f.tex[i]);
            f.tex[i] = null;
        }
        gl.activeTexture(f.active);
        for (let i = 0; i < CAPS.length; i++) {
            if (f.caps[i]) gl.enable(gl[CAPS[i]]); else gl.disable(gl[CAPS[i]]);
        }
        gl.depthMask(true);
        gl.bindVertexArray(f.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, f.ab);
        gl.bindRenderbuffer(gl.RENDERBUFFER, f.rb);
        // the program in use may have been deleted meanwhile (released by a recompile)
        if (!f.program || gl.isProgram(f.program)) gl.useProgram(f.program);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, f.drawFb);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, f.readFb);
        gl.viewport(f.vp[0], f.vp[1], f.vp[2], f.vp[3]);
        f.program = f.drawFb = f.readFb = f.vao = f.ab = f.rb = null;
        this.depth--;
        this.frame = this.depth > 0 ? this._stack[this.depth - 1] : null;
    }
}

// ----------------------------------------------------------------------
// Uniforms of a compiled program
// ----------------------------------------------------------------------

/**
 * Set the standard + compiled uniforms of a program (same rules as ShaderPreview.render).
 * Returns the next free texture unit. guard: GLStateGuard (texture unit bookkeeping).
 */
export function bindProgramUniforms(gl, locs, list, registry, guard, width, height, graph, unit = 1) {
    if (locs.u_resolution) gl.uniform2f(locs.u_resolution, width, height);
    applyClockUniforms(gl, locs);
    if (locs.u_mouse) gl.uniform2f(locs.u_mouse, ShaderPreview.mouseX, ShaderPreview.mouseY);
    if (locs.u_camera) {
        guard.bindTexture(0, cameraTexture(gl, graph || null, null));
        gl.uniform1i(locs.u_camera, 0);
    }
    if (!list) return unit;
    for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (registry && u.feedbackNodeId === undefined && u.microphoneNodeId === undefined && u.midiCCNodeId === undefined) {
            const r = registry.getUniform(u.name);
            if (r) u.value = r.value;
        }
        const loc = locs[u.name];
        if (loc === null || loc === undefined) continue;
        const v = u.value;
        switch (u.type) {
            case 'float':
                if (u.microphoneNode && u.microphoneNode.isActive) u.value = u.microphoneNode.getRMS();
                if (u.midiCCNode) u.value = u.midiCCNode.getValue();
                gl.uniform1f(loc, u.value);
                break;
            case 'int': gl.uniform1i(loc, v); break;
            case 'bool': gl.uniform1i(loc, v ? 1 : 0); break;
            case 'vec2': if (v) gl.uniform2f(loc, v[0], v[1]); break;
            case 'vec3': if (v) gl.uniform3f(loc, v[0], v[1], v[2]); break;
            case 'vec4': if (v) gl.uniform4f(loc, v[0], v[1], v[2], v[3]); break;
            case 'mat4': if (v) gl.uniformMatrix4fv(loc, false, v); break;
            case 'sampler2D': {
                if (u.feedbackNode) u.texture = u.feedbackNode.getReadTexture();
                if (u.textureOwner) u.texture = u.textureOwner.liveTexture(u.textureKey);
                if (u.texture) {
                    guard.bindTexture(unit, u.texture);
                    gl.uniform1i(loc, unit);
                    unit++;
                } else {
                    gl.uniform1i(loc, 0);
                }
                break;
            }
        }
    }
    return unit;
}

// ----------------------------------------------------------------------
// Thumbnail: tonemapped, downscaled copy of the color texture (node preview)
// ----------------------------------------------------------------------

const THUMB_VS = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;
const THUMB_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec4 u_bg;
in vec2 v_uv;
out vec4 fragColor;
void main() {
    vec4 c = texture(u_tex, v_uv);
    vec3 rgb = c.rgb + u_bg.rgb * (1.0 - c.a);
    fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

const thumbPrograms = new WeakMap();

export function thumbProgram(gl) {
    let p = thumbPrograms.get(gl);
    if (p !== undefined) return p;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const vs = sh(gl.VERTEX_SHADER, THUMB_VS), fs = sh(gl.FRAGMENT_SHADER, THUMB_FS);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_position');
    gl.linkProgram(prog);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { thumbPrograms.set(gl, null); return null; }
    p = { program: prog, u_tex: gl.getUniformLocation(prog, 'u_tex'), u_bg: gl.getUniformLocation(prog, 'u_bg') };
    thumbPrograms.set(gl, p);
    return p;
}
