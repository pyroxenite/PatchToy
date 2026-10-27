/**
 * Shared GPU resources of one WebGL2 context (the app's shared context, or a legacy
 * per-canvas context), created lazily and owned here:
 *
 *   ProgramCache       linked programs keyed by their vertex + fragment source. Every
 *                      renderer showing the same shader (a Preview node, the background /
 *                      fullscreen preview, the output window, the recorder) uses ONE
 *                      program; a recompile that produces the same source relinks nothing;
 *                      a few unused programs are kept (undo / redo, toggling a node back).
 *                      With KHR_parallel_shader_compile, programs can be linked without
 *                      blocking (acquire({async: true}) + poll()).
 *   quad buffer        the full-screen triangle strip every pass draws.
 *   noise program      the "no signal" TV static of unconnected previews.
 *   camera frame       one texture holding the active camera / screen / video frame,
 *                      uploaded at most once per animation frame for every user.
 *   present pass       copies a render target into the context's canvas so it can be
 *                      drawn onto a 2D canvas with drawImage (GPU copy, no readPixels).
 *
 * Objects managed here are protected against gl.deleteProgram / deleteBuffer /
 * deleteTexture from code that still treats them as per-renderer objects: those calls
 * are ignored for managed objects (they are freed by their owner, refcounted).
 */
import { clock } from '../core/Clock.js';

const STATE = new WeakMap(); // gl -> resources

const FULLSCREEN_VS = `#version 300 es
in vec2 a_position;
void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const NOISE_FS = `#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
out vec4 fragColor;

// Better hash function for noise (less repetition)
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    // Lower spatial resolution - make bigger pixels (4x4 blocks)
    vec2 pixelSize = vec2(4.0);
    vec2 uv = floor(gl_FragCoord.xy / pixelSize);

    // Animate the noise over time with better randomness
    float t = u_time * 10.0;
    float noise = hash(uv + vec2(t * 1.3, t * 0.7));

    // Add some subtle scanlines (less frequent)
    float scanline = sin(gl_FragCoord.y * 3.14159 * 0.5) * 0.03;
    noise += scanline;

    fragColor = vec4(vec3(noise * 0.7), 1.0);
}`;

// Copy a texture 1:1 (texelFetch: exact texels), premultiplied for the canvas compositor.
// flip = 1: the canvas gets the texture rows bottom-up (the order readPixels returns).
const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform ivec2 u_size;
uniform int u_flip;
out vec4 fragColor;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    if (u_flip == 1) p.y = u_size.y - 1 - p.y;
    vec4 c = texelFetch(u_tex, p, 0);
    fragColor = vec4(c.rgb * c.a, c.a);
}`;

/** Keep the unused programs of the last few compiles (undo / redo, A/B toggles). */
const MAX_IDLE_PROGRAMS = 24;

export class ProgramCache {
    constructor(gl, res) {
        this.gl = gl;
        this.res = res;
        this.entries = new Map();     // key -> entry
        this.idle = new Set();        // entries with refs = 0, oldest first
        this.pending = new Set();     // entries still linking (async)
        this.parallel = !!gl.getExtension('KHR_parallel_shader_compile');
        this.epoch = 0;               // bumped on project switch: older programs aren't kept idle
        this.stats = { links: 0, hits: 0, failures: 0, evicted: 0 };
    }

    static key(vs, fs) {
        return `${vs.length}:${vs}\u0000${fs}`;
    }

    /**
     * Get (and reference) the program for a source pair. async: start linking and return
     * an entry with status 'pending' (poll() completes it); otherwise the entry is
     * 'ready' or 'error' on return. Call release(entry) when done with it.
     */
    acquire(vs, fs, { async = false } = {}) {
        const key = ProgramCache.key(vs, fs);
        let e = this.entries.get(key);
        if (e) {
            this.stats.hits++;
            e.fresh = false;
        } else {
            e = this._start(key, vs, fs);
            e.fresh = true;
        }
        e.refs++;
        e.epoch = this.epoch;
        this.idle.delete(e);
        if (!async && e.status === 'pending') this.finish(e);
        return e;
    }

    release(e) {
        if (!e || e.refs <= 0) return;
        e.refs--;
        if (e.refs === 0) {
            if (e.epoch < this.epoch) { this._drop(e); return; }
            this.idle.add(e);
            while (this.idle.size > MAX_IDLE_PROGRAMS) {
                const oldest = this.idle.values().next().value;
                this.stats.evicted++;
                this._drop(oldest);
            }
        }
    }

    has(vs, fs) {
        return this.entries.has(ProgramCache.key(vs, fs));
    }

    _start(key, vs, fs) {
        const gl = this.gl;
        const e = { key, vs, fs, program: null, vsh: null, fsh: null, status: 'pending', error: null, uniforms: null, aPosition: -1, refs: 0, fresh: true, waiters: null };
        const vsh = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vsh, vs);
        gl.compileShader(vsh);
        const fsh = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fsh, fs);
        gl.compileShader(fsh);
        const program = gl.createProgram();
        gl.attachShader(program, vsh);
        gl.attachShader(program, fsh);
        gl.linkProgram(program);
        e.program = program;
        e.vsh = vsh;
        e.fsh = fsh;
        this.res.managed.add(program);
        this.entries.set(key, e);
        this.pending.add(e);
        this.stats.links++;
        return e;
    }

    /** Linking finished (never blocks; true without KHR_parallel_shader_compile). */
    isComplete(e) {
        if (e.status !== 'pending') return true;
        if (!this.parallel) return true;
        const ext = this.gl.getExtension('KHR_parallel_shader_compile');
        return !!this.gl.getProgramParameter(e.program, ext.COMPLETION_STATUS_KHR);
    }

    /** Resolve a pending entry now (blocks until the driver is done). */
    finish(e) {
        if (e.status !== 'pending') return e;
        const gl = this.gl;
        this.pending.delete(e);
        if (gl.getProgramParameter(e.program, gl.LINK_STATUS)) {
            e.status = 'ready';
            const uniforms = {};
            const n = gl.getProgramParameter(e.program, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < n; i++) {
                const info = gl.getActiveUniform(e.program, i);
                if (info) uniforms[info.name] = gl.getUniformLocation(e.program, info.name);
            }
            e.uniforms = uniforms;
            e.aPosition = gl.getAttribLocation(e.program, 'a_position');
        } else {
            e.status = 'error';
            this.stats.failures++;
            if (!gl.getShaderParameter(e.vsh, gl.COMPILE_STATUS)) {
                e.error = { stage: 'vertex', log: gl.getShaderInfoLog(e.vsh) || 'vertex shader failed to compile' };
            } else if (!gl.getShaderParameter(e.fsh, gl.COMPILE_STATUS)) {
                e.error = { stage: 'fragment', log: gl.getShaderInfoLog(e.fsh) || 'fragment shader failed to compile' };
            } else {
                e.error = { stage: 'link', log: gl.getProgramInfoLog(e.program) || 'program failed to link' };
            }
        }
        // Linked (or failed): the shader objects are no longer needed
        gl.detachShader(e.program, e.vsh);
        gl.detachShader(e.program, e.fsh);
        gl.deleteShader(e.vsh);
        gl.deleteShader(e.fsh);
        e.vsh = e.fsh = null;
        if (e.status === 'error') {
            // The error is cached (no GL objects): compiling the same broken source again
            // reports it right away instead of relinking
            this.res.managed.delete(e.program);
            this.res.rawDeleteProgram(e.program);
            e.program = null;
        }
        if (e.waiters) {
            const w = e.waiters;
            e.waiters = null;
            for (const fn of w) { try { fn(e); } catch (err) { console.warn('[programs] callback failed', err); } }
        }
        return e;
    }

    /** Complete every pending entry whose link finished. Returns how many completed. */
    poll() {
        if (!this.pending.size) return 0;
        let n = 0;
        for (const e of [...this.pending]) {
            if (this.isComplete(e)) { this.finish(e); n++; }
        }
        return n;
    }

    _drop(e) {
        this.idle.delete(e);
        this.pending.delete(e);
        if (this.entries.get(e.key) === e) this.entries.delete(e.key);
        const gl = this.gl;
        if (e.vsh) { gl.deleteShader(e.vsh); e.vsh = null; }
        if (e.fsh) { gl.deleteShader(e.fsh); e.fsh = null; }
        if (e.program) {
            this.res.managed.delete(e.program);
            this.res.rawDeleteProgram(e.program);
            e.program = null;
        }
        e.status = 'dropped';
    }

    /** Free every program nobody uses. */
    trim() {
        for (const e of [...this.idle]) this._drop(e);
    }

    /** Another project was loaded: free unused programs, don't keep the old ones once released. */
    newEpoch() {
        this.epoch++;
        this.trim();
    }

    info() {
        let live = 0;
        for (const e of this.entries.values()) if (e.refs > 0) live++;
        return { programs: this.entries.size, in_use: live, idle: this.idle.size, pending: this.pending.size, parallel_compile: this.parallel, ...this.stats };
    }
}

function compileStatic(gl, vs, fs) {
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
    };
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
    gl.detachShader(p, v);
    gl.detachShader(p, f);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!ok) {
        gl.deleteProgram(p);
        return null;
    }
    return p;
}

/** Shared resources of a context (created on first use). */
export function glResources(gl) {
    let r = STATE.get(gl);
    if (r) return r;
    r = {
        gl,
        managed: new WeakSet(),
        rawDeleteProgram: null,
        rawDeleteBuffer: null,
        rawDeleteTexture: null,
        programs: null,
        _quad: null,
        _noise: null,
        _present: null,
        _camera: null,
    };
    STATE.set(gl, r);
    // Ignore deletes of managed objects (they are refcounted / owned here)
    const proto = Object.getPrototypeOf(gl);
    const own = (name) => Object.prototype.hasOwnProperty.call(gl, name) ? gl[name] : null;
    const guard = (name) => {
        const prev = own(name) || proto[name];
        r['raw' + name[0].toUpperCase() + name.slice(1)] = (obj) => prev.call(gl, obj);
        gl[name] = function (obj) {
            if (obj && r.managed.has(obj)) return undefined;
            return prev.call(gl, obj);
        };
    };
    guard('deleteProgram');
    guard('deleteBuffer');
    guard('deleteTexture');
    r.programs = new ProgramCache(gl, r);
    return r;
}

export function programCache(gl) {
    return glResources(gl).programs;
}

/** The full-screen quad (TRIANGLE_STRIP, 4 vertices, vec2 positions). */
export function quadBuffer(gl) {
    const r = glResources(gl);
    if (!r._quad) {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        r._quad = b;
        r.managed.add(b);
    }
    return r._quad;
}

/** TV-static program + uniform locations ({ program, uniforms: { u_time, u_resolution }, aPosition }). */
export function noiseProgram(gl) {
    const r = glResources(gl);
    if (r._noise === null) {
        const p = compileStatic(gl, FULLSCREEN_VS, NOISE_FS);
        if (p) {
            r.managed.add(p);
            r._noise = {
                program: p,
                uniforms: { u_time: gl.getUniformLocation(p, 'u_time'), u_resolution: gl.getUniformLocation(p, 'u_resolution') },
                aPosition: gl.getAttribLocation(p, 'a_position'),
            };
        } else {
            r._noise = false;
        }
    }
    return r._noise || null;
}

/** Is a video element showing a usable frame? */
function videoReady(v) {
    if (!v || !v.readyState || v.readyState < 2 || v.paused) return false;
    return v.srcObject !== null || (!!v.src && v.src !== '');
}

/** The first active camera / screen / video node's video element (or null). */
export function activeVideoElement(graph) {
    if (!graph || !graph.nodes) return null;
    const nodes = graph.nodes;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if ((n.isCameraNode || n.isScreenCaptureNode || n.isVideoURLNode) && n.isActive && n.videoElement) return n.videoElement;
    }
    return null;
}

/**
 * The shared camera texture (u_camera): the active video source's current frame,
 * uploaded at most once per animation frame (whoever asks first uploads it).
 * fallback: a video element used when no video node is active (legacy #cameraVideo).
 */
export function cameraTexture(gl, graph = null, fallback = null) {
    const r = glResources(gl);
    let c = r._camera;
    if (!c) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        c = r._camera = { texture: t, at: -1 };
        r.managed.add(t);
    }
    // Once per frame: the clock frame advances every animation frame (and every offline step)
    const stamp = clock.frame;
    if (c.at === stamp) return c.texture;
    c.at = stamp;
    const video = activeVideoElement(graph) || fallback;
    if (videoReady(video)) {
        gl.bindTexture(gl.TEXTURE_2D, c.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    return c.texture;
}

/** Make sure the context's canvas can hold a w x h region (it only grows; see shrinkCanvas). */
export function ensureCanvasSize(gl, w, h) {
    const c = gl.canvas;
    if (!c) return;
    if (c.width < w || c.height < h) {
        c.width = Math.max(c.width, w);
        c.height = Math.max(c.height, h);
    }
    const r = glResources(gl);
    const now = performance.now();
    // Remember the largest region used recently, to shrink the canvas after a big output closed
    if (!r._canvasUse || now - r._canvasUse.since > 5000) r._canvasUse = { w, h, since: now, maxW: w, maxH: h };
    else { r._canvasUse.maxW = Math.max(r._canvasUse.maxW, w); r._canvasUse.maxH = Math.max(r._canvasUse.maxH, h); }
}

/**
 * Shrink the context's canvas when nothing used more than half of it for a while
 * (a 4K output or recording closed). Called once in a while by the render loop.
 */
export function shrinkCanvas(gl) {
    const r = glResources(gl);
    const c = gl.canvas;
    const u = r._canvasUse;
    if (!c || !u) return;
    const now = performance.now();
    if (now - u.since < 4000) return;
    const w = Math.max(512, u.maxW), h = Math.max(512, u.maxH);
    if (c.width > w * 1.5 || c.height > h * 1.5) {
        c.width = Math.min(c.width, w);
        c.height = Math.min(c.height, h);
    }
    r._canvasUse = { w: 0, h: 0, since: now, maxW: 0, maxH: 0 };
}

/**
 * Copy `texture` (w x h) onto a 2D canvas context through the GL canvas (GPU copy).
 * flipY: the 2D canvas gets the rows bottom-up, like readPixels + putImageData did.
 */
export function presentTexture(gl, texture, w, h, ctx2d, { flipY = true } = {}) {
    const r = glResources(gl);
    if (r._present === undefined || r._present === null) {
        const p = compileStatic(gl, FULLSCREEN_VS, PRESENT_FS);
        r._present = p ? {
            program: p,
            u_tex: gl.getUniformLocation(p, 'u_tex'),
            u_size: gl.getUniformLocation(p, 'u_size'),
            u_flip: gl.getUniformLocation(p, 'u_flip'),
            aPosition: gl.getAttribLocation(p, 'a_position'),
        } : false;
        if (p) r.managed.add(p);
    }
    const P = r._present;
    if (!P) return false;
    ensureCanvasSize(gl, w, h);
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(P.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(P.u_tex, 0);
    gl.uniform2i(P.u_size, w, h);
    gl.uniform1i(P.u_flip, flipY ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer(gl));
    gl.enableVertexAttribArray(P.aPosition);
    gl.vertexAttribPointer(P.aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    const glCanvas = gl.canvas;
    const prevOp = ctx2d.globalCompositeOperation;
    ctx2d.globalCompositeOperation = 'copy';
    ctx2d.drawImage(glCanvas, 0, glCanvas.height - h, w, h, 0, 0, w, h);
    ctx2d.globalCompositeOperation = prevOp;
    return true;
}
