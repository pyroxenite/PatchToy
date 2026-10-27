import { ShaderPreview } from './ShaderPreview.js';
import { clock } from '../core/Clock.js';

/**
 * ProbeRenderer - GPU side of the debug / probe nodes (src/core/library/debug.js).
 *
 * Values live on the GPU, per pixel. A probe compiles its input sub-graph exactly
 * like a Preview does (ShaderCompiler.compileFromNodeAsOutput + FeedbackRenderer
 * texture injection, rendered by a ShaderPreview in the shared GL context), so it
 * can read anything a Preview can show: Feedback buffers, audio / beat uniforms,
 * Params, JS outputs and textures.
 *
 * Sampling: every gl_FragCoord in the probe's copy of the shader is replaced by
 *   gl_FragCoord.xy * u_probeMap.xy + u_probeMap.zw
 * and u_resolution is the reference resolution (canvas background, else the
 * largest Preview), so a probe can evaluate the frame at any coordinate while it
 * draws into one cell of a small atlas:
 *   - point probes: one texel each, mapped (scale 1, so derivatives / fwidth stay
 *     one pixel wide) to the exact sample point (uv * resolution);
 *   - grid probes (Frame Stats, Histogram): a 64 x N block covering the frame.
 *
 * Readback: all probes of a frame are drawn into one atlas (RGBA32F with
 * EXT_color_buffer_float, else RGBA8 = clamped 0..1, flagged "8-bit" on the
 * nodes), then ONE readPixels into a pixel-pack buffer guarded by a fence. The
 * result is collected on a later frame once the fence has signalled, so the CPU
 * never waits on the GPU (no pipeline stall); a new batch is only issued after
 * the previous one arrived. Grid probes refresh at most every GRID_INTERVAL_MS.
 *
 * Only probes that are visible (in the open group and on screen) or that an MCP
 * client read recently (markReader) are rendered.
 */

const ATLAS_W = 64;           // atlas width (point probes per row, grid width)
const GRID_W = 64;            // grid probes: samples across the frame
const GRID_INTERVAL_MS = 100; // grid probes refresh rate
const READER_LEASE_MS = 15000;
const READ_EVERY = 3;         // display-only probes: one readback batch per 3 frames

const fragCoordMacro = 'PT_PROBE_FRAGCOORD';

/** The probe's copy of a compiled fragment shader: gl_FragCoord goes through u_probeMap. */
export function rewriteProbeFragment(fragment) {
    const body = fragment.replace(/\bgl_FragCoord\b/g, fragCoordMacro);
    const decl = `uniform vec4 u_probeMap;\n#define ${fragCoordMacro} vec4(gl_FragCoord.xy * u_probeMap.xy + u_probeMap.zw, gl_FragCoord.zw)`;
    if (/precision\s+highp\s+float\s*;/.test(body)) {
        return body.replace(/(precision\s+highp\s+float\s*;)/, `$1\n${decl}`);
    }
    const nl = body.indexOf('\n');
    return body.slice(0, nl + 1) + 'precision highp float;\n' + decl + '\n' + body.slice(nl + 1);
}

/** ShaderPreview driven by the ProbeRenderer (no own animation loop, no TV-noise program). */
class ProbeShader extends ShaderPreview {
    animate() { /* rendered on demand by ProbeRenderer */ }
    setupNoiseShader() {
        this.noiseProgram = null;
        this.noiseUniforms = {};
    }
    onSetUniforms(gl, locs) {
        const m = this.probeMap;
        if (locs.u_probeMap && m) gl.uniform4f(locs.u_probeMap, m[0], m[1], m[2], m[3]);
    }
}

export class ProbeRenderer {
    constructor({ graph, compiler, feedbackRenderer = null, manager = null }) {
        this.graph = graph;
        this.compiler = compiler;
        this.feedbackRenderer = feedbackRenderer;
        this.manager = manager;
        this.gl = feedbackRenderer ? feedbackRenderer.gl : null;
        const gl = this.gl;
        this.isGL2 = !!gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
        this.float = this.isGL2 && !!gl.getExtension('EXT_color_buffer_float');

        this.entries = new Map(); // probe node -> { shader: ProbeShader, fragment, ok, error }
        this.atlas = null;        // { fb, tex, w, h }
        this.pbo = null;
        this.pboBytes = 0;
        this.cpu = null;
        this.pending = null;      // { sync, layout, len, issuedAt }
        this.frame = 0;
        this._lastIssue = -Infinity; // frame of the last readback batch (READ_EVERY)

        // Cost bookkeeping (read_probes reports it)
        this.stats = {
            format: this.float ? 'rgba32f' : 'rgba8',
            mode: 'async (pixel-pack buffer + fence, 1 readPixels per batch)',
            batches: 0,
            probes_last: 0,
            texels_last: 0,
            issue_ms: 0,       // CPU time to draw the batch and queue its readPixels (EMA)
            collect_ms: 0,     // CPU time to copy a signalled batch to JS (EMA)
            latency_ms: 0,     // issue -> results available (EMA, ~1 frame)
            sync_reads: 0,
            sync_read_ms: 0    // blocking readPixels used by MCP sampleNow (last)
        };
    }

    get supported() {
        return this.isGL2;
    }

    // ------------------------------------------------------------------
    // Compilation (called by CompilationManager after the previews)
    // ------------------------------------------------------------------

    compile() {
        const probes = this.graph.nodes.filter(n => n.isProbeNode);
        for (const [node, e] of this.entries) {
            if (!probes.includes(node)) this._dispose(node, e);
        }
        if (!this.supported) {
            for (const node of probes) node.setProbeStatus?.('error', 'Probes need WebGL 2');
            return;
        }
        for (const node of probes) {
            try {
                this._compileProbe(node);
            } catch (err) {
                node.setProbeStatus?.('error', (err && err.message) || String(err));
            }
        }
        this._registerUniforms();
    }

    _compileProbe(node) {
        const g = this.graph;
        // The probed value is input 0 (Sample also has a control-rate uv input)
        const conn = g.connections.find(c => c.toNode === node && c.toInput === 0 && c.fromNode);
        if (!conn) {
            this._dropProgram(node);
            node.setProbeStatus('none');
            return;
        }
        let shader;
        this.compiler.quiet = true; // errors are shown on the probe node, not in the console
        try {
            shader = this.compiler.compileFromNodeAsOutput(conn.fromNode, conn.fromOutput, g, conn.accessor || null);
        } finally {
            this.compiler.quiet = false;
        }
        if (!shader || !shader.fragment) {
            this._dropProgram(node);
            const errs = (shader && shader.errors) || [];
            node.setProbeStatus('error', errs.length ? String(errs[0]) : 'input does not compile');
            return;
        }
        if (this.feedbackRenderer) this.feedbackRenderer.injectFeedbackTextures(shader, this.gl);
        const fragment = rewriteProbeFragment(shader.fragment);

        let e = this.entries.get(node);
        if (!e) {
            e = { shader: null, fragment: null, ok: false, error: null };
            this.entries.set(node, e);
        }
        if (!e.shader) {
            e.shader = new ProbeShader(null, null, { sharedGL: this.gl, uniformRegistry: g.uniformRegistry });
        }
        e.shader.graph = g;
        e.shader.uniformRegistry = g.uniformRegistry;

        if (e.fragment !== fragment) {
            e.fragment = fragment;
            const src = { vertex: shader.vertex, fragment, uniformValues: shader.uniformValues || [], webglErrors: [] };
            e.ok = e.shader.loadShader(src);
            e.error = e.ok ? null : (src.webglErrors[0] || 'GLSL error');
            if (!e.ok) e.shader.program = null;
        } else {
            // Same program: only the uniform objects (and their injected textures) are new
            e.shader.customUniformValues = shader.uniformValues || [];
        }
        e.sourceType = shader.sourceType || 'vec4';
        if (e.ok) node.setProbeStatus('ok', null, e.sourceType);
        else node.setProbeStatus('error', String(e.error).split('\n')[0].slice(0, 160));
    }

    /** Uniforms only a probe uses must be live too (Param values, uniform-mode constants). */
    _registerUniforms() {
        const reg = this.graph.uniformRegistry;
        const mgr = this.manager;
        if (!reg || !mgr || typeof mgr.findNodeByRemappedName !== 'function') return;
        for (const e of this.entries.values()) {
            if (!e.ok || !e.shader) continue;
            for (const u of e.shader.customUniformValues || []) {
                if (u.feedbackNodeId !== undefined || u.microphoneNodeId !== undefined || u.midiCCNodeId !== undefined) continue;
                if (reg.hasUniform(u.name)) continue;
                const src = mgr.findNodeByRemappedName(u.name);
                if (src) reg.registerUniform(u.name, u.type, u.value, src);
            }
        }
    }

    _dropProgram(node) {
        const e = this.entries.get(node);
        if (!e) return;
        if (e.shader) e.shader.program = null; // releases the shared program
        e.fragment = null;
        e.ok = false;
    }

    _dispose(node, e) {
        try {
            // Releases the shared program (the quad / camera texture are shared per context)
            if (e.shader) e.shader.destroy();
        } catch (err) { /* context lost */ }
        this.entries.delete(node);
    }

    // ------------------------------------------------------------------
    // Per-frame
    // ------------------------------------------------------------------

    /** Main loop hook (after Feedback passes): collect the last batch, issue the next. */
    tick() {
        if (!this.supported || !this.entries.size) return;
        this.frame++;
        if (clock.manualOwners && clock.manualOwners.has('export')) {
            // Offline export: the async readback would hand the frame N-1 or N-2 value to the
            // Sample nodes depending on GPU timing (and nothing while the tab is hidden), so two
            // exports of one patch differ. Read the control-feeding probes synchronously instead:
            // always exactly one frame late. Display-only probes wait (the editor is suspended).
            const readers = [];
            for (const node of this.entries.keys()) if (node.probeAlways) readers.push(node);
            if (readers.length) this.sampleNow(readers);
            return;
        }
        if (this.pending && !this._collect()) return; // GPU not done yet: never wait
        if (typeof document !== 'undefined' && document.hidden) return;
        // Display-only probes are read back every READ_EVERY frames (the readback costs about
        // a millisecond per batch); Sample nodes feeding control values, every frame
        if (this.frame - this._lastIssue < READ_EVERY && !this._controlReaders()) return;
        const layout = this._layout(null);
        if (!layout) return;
        const t0 = performance.now();
        this._draw(layout);
        this._issueRead(layout);
        this._lastIssue = this.frame;
        const dt = performance.now() - t0;
        const s = this.stats;
        s.issue_ms = s.batches ? s.issue_ms * 0.9 + dt * 0.1 : dt;
        s.batches++;
        s.probes_last = layout.points.length + layout.grids.length;
        s.texels_last = layout.texels;
    }

    /** Does a probe feed control values (probeAlways: Sample nodes)? */
    _controlReaders() {
        for (const node of this.entries.keys()) if (node.probeAlways) return true;
        return false;
    }

    /** MCP: keep these probes rendering for a while even when off-screen. */
    markReader(nodes) {
        const until = performance.now() + READER_LEASE_MS;
        for (const n of nodes) n.probeReaderUntil = until;
    }

    /**
     * Render + read the given probes right now (blocking readPixels). Used by MCP
     * reads so a value is available even before the first async batch arrived.
     */
    sampleNow(nodes) {
        if (!this.supported) return false;
        const want = new Set(nodes.filter(n => this.entries.get(n)?.ok));
        if (!want.size) return false;
        const gl = this.gl;
        if (this.pending) {
            // Results of the in-flight batch would arrive after these: drop them
            gl.deleteSync(this.pending.sync);
            this.pending = null;
        }
        const layout = this._layout(want);
        if (!layout) return false;
        const t0 = performance.now();
        this._draw(layout);
        const buf = this._cpuBuffer(layout.len);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.atlas.fb);
        gl.readPixels(0, 0, ATLAS_W, layout.h, gl.RGBA, this.float ? gl.FLOAT : gl.UNSIGNED_BYTE, buf);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this._distribute(layout, buf);
        this.stats.sync_reads++;
        this.stats.sync_read_ms = performance.now() - t0;
        return true;
    }

    /** Reference resolution: the canvas background, else the largest Preview, else screen aspect. */
    resolution() {
        const bg = this.manager && this.manager.backgroundRenderer;
        if (bg && bg.activePreviewNode && bg.canvas && bg.canvas.width > 1 && bg.canvas.height > 1) {
            return [bg.canvas.width, bg.canvas.height];
        }
        let best = null;
        for (const n of this.graph.nodes) {
            const r = n.isPreviewNode && n.renderer;
            if (r && r.width > 1 && r.height > 1 && (!best || r.width * r.height > best[0] * best[1])) best = [r.width, r.height];
        }
        if (best) return best;
        const aspect = (typeof screen !== 'undefined' && screen.width && screen.height) ? screen.width / screen.height : 1.6;
        return [640, Math.max(1, Math.round(640 / aspect))];
    }

    _viewRect() {
        const g = this.graph;
        const c = g.canvas;
        if (!c) return null;
        const dpr = window.devicePixelRatio || 1;
        const z = g.zoom || 1;
        const x0 = -g.panX / z;
        const y0 = -g.panY / z;
        return { x0, y0, x1: x0 + c.width / dpr / z, y1: y0 + c.height / dpr / z };
    }

    isOnScreen(node, view = this._viewRect()) {
        const g = this.graph;
        if (g.groupCtl && typeof g.groupCtl.isVisible === 'function' && !g.groupCtl.isVisible(node)) return false;
        if (!view) return false;
        return !(node.x > view.x1 || node.y > view.y1 || node.x + node.width < view.x0 || node.y + node.height < view.y0);
    }

    /** Which probes render this batch and where their cells are in the atlas. */
    _layout(force) {
        const now = performance.now();
        const view = this._viewRect();
        const live = new Set(this.graph.nodes);
        const points = [];
        const grids = [];
        for (const [node, e] of this.entries) {
            if (!e.ok || !e.shader || !e.shader.program || !live.has(node)) continue;
            const visible = this.isOnScreen(node, view);
            if (force) {
                if (!force.has(node)) continue;
            } else {
                // probeAlways: Sample nodes drive control values, so they read back every frame
                const reader = node.probeAlways || (node.probeReaderUntil && node.probeReaderUntil > now);
                if (!reader && !visible) continue;
            }
            if (node.definition && node.definition.probeKind === 'grid') {
                if (!force && node._probeGridAt && now - node._probeGridAt < GRID_INTERVAL_MS) continue;
                node._probeGridAt = now;
                grids.push({ node, e, visible });
            } else {
                points.push({ node, e, visible, uv: node.getSampleUV() });
            }
        }
        if (!points.length && !grids.length) return null;

        const res = this.resolution();
        const gw = GRID_W;
        const gh = Math.max(8, Math.min(64, Math.round(GRID_W * res[1] / res[0])));
        const pointRows = Math.ceil(points.length / ATLAS_W);
        points.forEach((p, i) => { p.x = i % ATLAS_W; p.y = Math.floor(i / ATLAS_W); });
        let y = pointRows;
        for (const g of grids) {
            g.x = 0;
            g.y = y;
            g.w = gw;
            g.h = gh;
            y += gh;
        }
        const h = Math.max(1, y);
        return {
            points, grids, res, h,
            len: ATLAS_W * h * 4,
            texels: points.length + grids.length * gw * gh,
            meta: {
                time: clock.u.time,
                beatCount: clock.u.beatCount,
                bpm: clock.u.bpm,
                float: this.float,
                res,
                frame: this.frame
            }
        };
    }

    _ensureAtlas(h) {
        const gl = this.gl;
        if (this.atlas && this.atlas.h >= h) return;
        const cap = Math.max(h, this.atlas ? this.atlas.h * 2 : 4);
        if (this.atlas) {
            gl.deleteFramebuffer(this.atlas.fb);
            gl.deleteTexture(this.atlas.tex);
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ATLAS_W, cap, 0, gl.RGBA, gl.FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS_W, cap, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindTexture(gl.TEXTURE_2D, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!ok && this.float) {
            // Float targets refused after all: fall back to 8-bit
            gl.deleteFramebuffer(fb);
            gl.deleteTexture(tex);
            this.float = false;
            this.stats.format = 'rgba8';
            this.atlas = null;
            this._ensureAtlas(h);
            return;
        }
        this.atlas = { fb, tex, w: ATLAS_W, h: cap };
    }

    _draw(layout) {
        this._ensureAtlas(layout.h);
        const target = { framebuffer: this.atlas.fb };
        const [rw, rh] = layout.res;
        const draw = (e, rect, map) => {
            const s = e.shader;
            s.framebuffer = target;
            s.width = rw;
            s.height = rh;
            s.viewportRect = rect;
            s.probeMap = map;
            s.refreshTextureUniforms();
            s.render();
        };
        for (const p of layout.points) {
            const cx = Math.min(Math.max(p.uv[0], -4), 5) * rw;
            const cy = Math.min(Math.max(p.uv[1], -4), 5) * rh;
            draw(p.e, [p.x, p.y, 1, 1], [1, 1, cx - (p.x + 0.5), cy - (p.y + 0.5)]);
        }
        for (const g of layout.grids) {
            const sx = rw / g.w;
            const sy = rh / g.h;
            draw(g.e, [g.x, g.y, g.w, g.h], [sx, sy, -g.x * sx, -g.y * sy]);
        }
    }

    _cpuBuffer(len) {
        const T = this.float ? Float32Array : Uint8Array;
        if (!this.cpu || this.cpu.length < len || !(this.cpu instanceof T)) this.cpu = new T(len);
        return this.cpu;
    }

    _issueRead(layout) {
        const gl = this.gl;
        const bytes = layout.len * (this.float ? 4 : 1);
        if (!this.pbo) this.pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        // Re-specify (orphan) the store every batch: rewriting a fenced READ buffer in
        // place makes Chrome drop its readback shadow copy (and log a perf warning)
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
        this.pboBytes = bytes;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.atlas.fb);
        gl.readPixels(0, 0, ATLAS_W, layout.h, gl.RGBA, this.float ? gl.FLOAT : gl.UNSIGNED_BYTE, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        this.pending = { sync, layout, len: layout.len, issuedAt: performance.now() };
    }

    /** Copy a finished batch to JS; false while the GPU is still working on it. */
    _collect() {
        const gl = this.gl;
        const p = this.pending;
        const status = gl.clientWaitSync(p.sync, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) return false;
        gl.deleteSync(p.sync);
        this.pending = null;
        if (status === gl.WAIT_FAILED) return true;
        const t0 = performance.now();
        const buf = this._cpuBuffer(p.len);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf, 0, p.len);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this._distribute(p.layout, buf);
        const s = this.stats;
        const dt = performance.now() - t0;
        s.collect_ms = s.collect_ms ? s.collect_ms * 0.9 + dt * 0.1 : dt;
        const lat = t0 - p.issuedAt;
        s.latency_ms = s.latency_ms ? s.latency_ms * 0.9 + lat * 0.1 : lat;
        return true;
    }

    _distribute(layout, buf) {
        const k = this.float ? 1 : 1 / 255;
        const live = new Set(this.graph.nodes);
        for (const p of layout.points) {
            if (!live.has(p.node)) continue;
            const i = (p.y * ATLAS_W + p.x) * 4;
            p.node.onProbeSample([buf[i] * k, buf[i + 1] * k, buf[i + 2] * k, buf[i + 3] * k], { ...layout.meta, uv: p.uv, visible: p.visible });
        }
        for (const g of layout.grids) {
            if (!live.has(g.node)) continue;
            g.node.onProbeGrid({ data: buf, stride: ATLAS_W, x0: g.x, y0: g.y, w: g.w, h: g.h, scale: k }, { ...layout.meta, visible: g.visible });
        }
    }
}
