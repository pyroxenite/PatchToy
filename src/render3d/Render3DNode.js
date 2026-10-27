/**
 * Render 3D node: owns the render targets of its scene, renders lazily (the first time a
 * consumer binds one of its textures in a frame, or its thumbnail is drawn), shows a
 * preview with orbit / zoom when no camera is connected.
 *
 * Laziness gives the scheduling rules for free: a Render 3D whose output nobody shows
 * (hidden SceneSwitcher scene, off-screen previews) costs nothing; a render_preview with
 * a pinned time re-renders at that time; a Feedback reading it gets this frame's image.
 */
import { Node } from '../nodes/Node.js';
import { COLORS, FONTS } from '../ui/theme.js';
import { drawLabel, fitText } from '../rendering/NodePainter.js';
import { clock } from '../core/Clock.js';
import { quality } from '../rendering/QualityGovernor.js';
import { presentTexture, programCache, quadBuffer } from '../rendering/glResources.js';
import { renderLoop } from '../rendering/RenderLoop.js';
import { R3D, cpuInput, inputIndex, textureSizeOf } from './runtime.js';
import { compileRender3D, withDefines } from './compile.js';
import { R3Targets, R3ShadowMap, GLStateGuard, bindProgramUniforms, setDefaultAttribs, thumbProgram, glCaps } from './gl.js';
import { defaultBoxMesh } from './objectNodes.js';

const STATIC_INPUTS = 3; // camera, background, bgDepth
const STATUS_H = 18;
const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const BLEND_BUFFERS = [0x8CE0, 0, 0]; // COLOR_ATTACHMENT0, NONE, NONE

function itemInput(k) {
    return { name: `item${k}`, type: 'any', description: 'A Mesh, Model, Group 3D or light to draw (connecting the last free input adds one)' };
}

// Largest output shown recently (QualityGovernor.outputs), scanned without allocations
const scan = { best: null, prev: null, area: 0, now: 0 };
function scanOutput(o, kind) {
    if (scan.now - o.at > 700) return;
    if (kind === 'previews') { scan.prev = o; return; }
    const a = o.w * o.h * (o.scale || 1) * (o.scale || 1);
    if (a > scan.area) { scan.area = a; scan.best = o; }
}

const dummyShadow = new WeakMap();
/** 1x1 depth texture with compare mode (shadow samplers must never see a colour texture). */
function dummyShadowTexture(gl) {
    let t = dummyShadow.get(gl);
    if (!t) {
        t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, 1, 1, 0, gl.DEPTH_COMPONENT, gl.FLOAT, new Float32Array([1]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        dummyShadow.set(gl, t);
    }
    return t;
}

export class Render3DNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isRender3DNode = true;
        this.isDynamicInput = true;
        this.width = 236;
        this.fixedWidth = true;
        this.targets = null;
        this.shadowMap = null;
        this.compiled = null;
        this.compileErrors = [];
        this.guard = null;
        this.wants = { depth: false, normal: false };
        this.stats = { draws: 0, instances: 0, triangles: 0, points: 0, ms: 0, frame: -1, w: 0, h: 0, msaa: 0, shadow: false, renders: 0 };
        this._stampFrame = -1;
        this._stampTime = NaN;
        this._stampBeat = NaN;
        this._stampEpoch = -1;
        this._stampOv = null;
        this._rendering = false;
        this._clear = new Float32Array(4);
        this._clearDepth = new Float32Array([200, 0, 0, 1]);
        this._zero4 = new Float32Array(4);
        this._one = new Float32Array([1]);
        this._camPos = new Float32Array(3);
        this._fog = new Float32Array(4);
        this.normalizeData();
        this.syncPorts();
    }

    // ------------------------------------------------------------------ data / ports

    normalizeData() {
        const d = this.data;
        const n = Math.round(Number(d.items));
        d.items = Number.isFinite(n) && n >= 1 ? Math.min(n, 64) : 1;
        const o = d.orbit && typeof d.orbit === 'object' ? d.orbit : {};
        d.orbit = {
            yaw: Number.isFinite(o.yaw) ? o.yaw : 0.6,
            pitch: Number.isFinite(o.pitch) ? o.pitch : 0.35,
            distance: Number.isFinite(o.distance) && o.distance > 0 ? o.distance : 5,
            target: Array.isArray(o.target) && o.target.length === 3 ? o.target.map(Number) : [0, 0, 0],
            fov: Number.isFinite(o.fov) ? o.fov : 45,
        };
        if (!Array.isArray(d.clearColor) || d.clearColor.length < 3) d.clearColor = [0.035, 0.04, 0.055, 1];
        if (d.clearColor.length === 3) d.clearColor = [...d.clearColor, 1];
        for (const [k, def] of [['near', 0.05], ['far', 200], ['msaa', 4], ['maxSize', 1920], ['width', 1280], ['height', 800], ['fog', 0], ['exposure', 1], ['shadowRes', 2048]]) {
            const v = Number(d[k]);
            d[k] = Number.isFinite(v) ? v : def;
        }
        if (d.size !== 'fixed') d.size = 'auto';
        if (d.tonemap !== 'linear' && d.tonemap !== 'aces') d.tonemap = 'gamma';
    }

    syncPorts() {
        const n = this.data.items;
        const want = this.definition.inputs.slice(0, STATIC_INPUTS).map(p => ({ ...p }));
        for (let k = 1; k <= n; k++) want.push(itemInput(k));
        const same = want.length === this.inputs.length && want.every((p, i) => this.inputs[i] && this.inputs[i].name === p.name);
        if (!same) this.inputs = want;
        const g = this.graph;
        if (g && Array.isArray(g.connections)) g.connections = g.connections.filter(c => c.toNode !== this || c.toInput < this.inputs.length);
        this.updateDimensions();
    }

    /** Data replaced (load, paste, undo, set_node_data). */
    rebuildTextInputs() {
        this.normalizeData();
        this.syncPorts();
    }

    isItemConnected(k) {
        const g = this.graph;
        const idx = STATIC_INPUTS + k - 1;
        return !!g && g.connections.some(c => c.toNode === this && c.toInput === idx);
    }

    shouldAddNewInput() {
        return this.isItemConnected(this.data.items);
    }

    addDynamicInput() {
        if (this.data.items >= 64) return false;
        this.data.items++;
        this.syncPorts();
        return true;
    }

    removeDynamicInput() {
        return false;
    }

    getInputPortLabel(i) {
        if (i < STATIC_INPUTS) return this.inputs[i].name === 'bgDepth' ? 'bg depth' : this.inputs[i].name;
        const g = this.graph;
        const c = g && g.connections.find(x => x.toNode === this && x.toInput === i);
        if (!c) return i === this.inputs.length - 1 ? '+ object / light' : 'item';
        const src = c.fromNode;
        return (src.definition && src.definition.displayTitle) || src.type.replace(/([a-z])([A-Z])/g, '$1 $2');
    }

    // ------------------------------------------------------------------ layout / drawing

    previewAspect() {
        const t = this.targets;
        if (t && t.w && t.h) return t.h / t.w;
        return 0.625;
    }

    getPreviewRect() {
        const rows = Math.max(this.inputs.length, this.outputs.length, 1);
        const top = this.getRowCenterY(rows - 1) + 15;
        const w = this.width - 16;
        return { x: this.x + 8, y: top, w, h: Math.round(w * 0.625) };
    }

    updateDimensions() {
        const rows = Math.max(this.inputs.length, this.outputs.length, 1);
        if (this.heightForRows) this.height = this.heightForRows(rows, Math.round((this.width - 16) * 0.625) + 10 + STATUS_H);
    }

    cameraConnected() {
        const g = this.graph;
        return !!g && g.connections.some(c => c.toNode === this && c.toInput === 0);
    }

    isInErrorState() {
        return !!(this.hasError || (this.compileErrors && this.compileErrors.length));
    }

    getHeaderIcon() {
        return 'feedback';
    }

    needsContinuousRender() {
        return !!(this.compiled && this.compiled.draws.length) && renderLoop.nodeVisible(this);
    }

    drawBody(ctx, options = {}) {
        super.drawBody(ctx, options);
        const r = this.getPreviewRect();
        ctx.save();
        ctx.fillStyle = '#05060a';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        let canvas = null;
        try { canvas = this.previewCanvas(r.w, r.h); } catch (e) { this._warn('preview failed', e); }
        if (canvas) {
            // letterbox the render's aspect into the preview box
            const a = this.previewAspect();
            let w = r.w, h = r.w * a;
            if (h > r.h) { h = r.h; w = r.h / a; }
            ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
        }
        ctx.strokeStyle = COLORS.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        const s = this.stats;
        const y = r.y + r.h + 12;
        let text;
        if (this.compileErrors.length) text = this.compileErrors[0];
        else if (!this.compiled || !this.compiled.draws.length) text = 'connect a Mesh or Model to + object';
        else text = `${s.w}×${s.h}${s.msaa ? ` ${s.msaa}x` : ''} · ${s.draws} draw${s.draws === 1 ? '' : 's'} · ${fmtCount(s.instances)} inst · ${s.ms.toFixed(1)} ms`;
        ctx.font = FONTS.value;
        ctx.fillStyle = this.compileErrors.length ? COLORS.error : COLORS.textFaint;
        ctx.fillText(fitText(ctx, FONTS.value, text, r.w), r.x, y);
        if (options.isHovered && !this.cameraConnected() && this.isInPreview(options.mouseX, options.mouseY)) {
            drawLabel(ctx, 'drag: orbit · shift: pan · scroll: zoom', r.x + 4, r.y + r.h - 8, 'rgba(255,255,255,0.7)');
        }
        ctx.restore();
    }

    isInPreview(x, y) {
        if (x === undefined) return false;
        const r = this.getPreviewRect();
        return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }

    getControlCursor(x, y) {
        if (!this.cameraConnected() && this.isInPreview(x, y)) return this._orbiting ? 'grabbing' : 'grab';
        return super.getControlCursor(x, y);
    }

    handleMouseDown(x, y, event) {
        if (!this.cameraConnected() && this.isInPreview(x, y) && event) {
            this._orbiting = true;
            let lx = event.clientX, ly = event.clientY;
            const pan = !!event.shiftKey;
            const move = (e) => {
                const dx = e.clientX - lx, dy = e.clientY - ly;
                lx = e.clientX; ly = e.clientY;
                const o = this.data.orbit;
                if (pan || e.shiftKey) {
                    const k = o.distance * 0.0025;
                    const cy = Math.cos(o.yaw), sy = Math.sin(o.yaw);
                    // right = (cos yaw, 0, -sin yaw), up ~ world y
                    o.target[0] -= (cy * dx) * k;
                    o.target[2] -= (-sy * dx) * k;
                    o.target[1] += dy * k;
                } else {
                    o.yaw -= dx * 0.008;
                    o.pitch = Math.max(-1.5, Math.min(1.5, o.pitch + dy * 0.008));
                }
                if (this.graph) this.graph.render();
            };
            const up = () => {
                this._orbiting = false;
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
                if (this.graph && this.graph.onUniformValueChanged) this.graph.onUniformValueChanged(this);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
            return { handled: true, needsRender: true };
        }
        return super.handleMouseDown(x, y, event);
    }

    /** Scroll over the preview: zoom the orbit camera. Returns true when handled. */
    handleWheel(x, y, e) {
        if (this.cameraConnected() || !this.isInPreview(x, y)) return false;
        const o = this.data.orbit;
        const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1);
        const d = Math.max(-200, Math.min(200, e.deltaY * unit));
        o.distance = Math.max(0.05, Math.min(1e4, o.distance * Math.exp(d * 0.0015)));
        if (this.graph) {
            this.graph.render();
            clearTimeout(this._wheelSave);
            this._wheelSave = setTimeout(() => this.graph && this.graph.onUniformValueChanged && this.graph.onUniformValueChanged(this), 300);
        }
        return true;
    }

    _warn(msg, e) {
        if (this._warned) return;
        this._warned = true;
        console.warn(`[render3d] Render 3D #${this.id}: ${msg}`, e);
    }

    // ------------------------------------------------------------------ compile

    /** Generate + link this node's programs (CompilationManager.compile, or on first use). */
    compile() {
        const app = R3D.app;
        if (!app || !this.graph) return null;
        const gl = app.sharedGL;
        this.releasePrograms();
        const res = compileRender3D(this, this.graph, app.shaderCompiler);
        this.compiled = res;
        this.compileErrors = res.errors.slice();
        this.wants.depth = res.outputs.depth;
        this.wants.normal = res.outputs.normal;
        const fr = app.feedbackRenderer;
        // Textures of the compiled uniforms (Feedback, JS, image Params, other Render 3D nodes)
        for (const d of res.draws) {
            for (const list of [d.uniforms, d.shadowUniforms]) {
                if (!list) continue;
                if (fr) fr.injectFeedbackTextures({ uniformValues: list }, gl);
                for (const u of list) {
                    if (u.jsTextureNodeId === this.id) {
                        this.compileErrors.push(`${d.node.type} #${d.node.id} samples this Render 3D's own output: route it through a Feedback node (previous frame)`);
                        u.textureOwner = null; u.texture = null;
                    }
                }
            }
            // Mesh variants are known now: link (errors show up with the compile)
            if (d.kind === 'mesh') {
                d.defines = d.points ? ['R3_POINTS'] : [];
                d.defKey = d.defines.join(',');
                const v = this.variant(d, 'main', d.defines, d.defKey);
                if (v.error) this.compileErrors.push(`${d.node.type} #${d.node.id}: ${v.error}`);
                if (d.shadowVs) {
                    const sv = this.variant(d, 'shadow', [], '');
                    if (sv.error) { res.warnings.push(`${d.node.type} #${d.node.id} shadow: ${sv.error}`); d.shadowVs = null; }
                }
            }
        }
        if (res.background) {
            if (fr) fr.injectFeedbackTextures({ uniformValues: res.background.uniforms }, gl);
            const v = this.variant(res.background, 'bg', [], '');
            if (v.error) this.compileErrors.push(`Render 3D #${this.id} background: ${v.error}`);
        }
        this.registerUniforms();
        this._stampEpoch = -1;
        return res;
    }

    /** Link (cached) one program variant of a draw ('main' | 'shadow' | 'bg'). */
    variant(d, pass, defines, key) {
        const map = pass === 'shadow' ? d.shadowVariants : d.variants;
        let v = map.get(key);
        if (v) return v;
        const gl = R3D.app.sharedGL;
        let vs, fs;
        if (pass === 'shadow') { vs = withDefines(d.shadowVs, defines); fs = SHADOW_FS; }
        else if (pass === 'bg') { vs = d.vs; fs = d.fs; }
        else { vs = withDefines(d.vs, defines); fs = withDefines(d.fs, defines); }
        const cache = programCache(gl);
        const entry = cache.acquire(vs, fs);
        if (entry.status !== 'ready') {
            const err = entry.error || { stage: 'link', log: 'program failed to link' };
            const log = String(err.log || '').split('\n').filter(Boolean).slice(0, 3).join(' | ');
            v = { entry: null, error: `${err.stage} shader: ${log}`, vs, fs };
            cache.release(entry);
            console.warn(`[render3d] ${pass} program failed (${err.stage}):\n${err.log}`);
        } else {
            v = { entry, error: null };
        }
        map.set(key, v);
        return v;
    }

    releasePrograms() {
        const c = this.compiled;
        if (!c || !R3D.app) return;
        const cache = programCache(R3D.app.sharedGL);
        const free = (map) => { if (!map) return; for (const v of map.values()) if (v.entry) cache.release(v.entry); map.clear(); };
        for (const d of c.draws) { free(d.variants); free(d.shadowVariants); }
        if (c.background) free(c.background.variants);
        this.compiled = null;
    }

    /** Live values of the uniforms only these programs use (Params, constants in uniform mode). */
    registerUniforms() {
        const app = R3D.app;
        const reg = this.graph && this.graph.uniformRegistry;
        const cm = app && app.compilationManager;
        if (!reg || !cm || !this.compiled || typeof cm.findNodeByRemappedName !== 'function') return;
        const lists = [];
        for (const d of this.compiled.draws) { lists.push(d.uniforms); if (d.shadowUniforms) lists.push(d.shadowUniforms); }
        if (this.compiled.background) lists.push(this.compiled.background.uniforms);
        for (const list of lists) {
            for (const u of list) {
                if (u.feedbackNodeId !== undefined || u.microphoneNodeId !== undefined || u.midiCCNodeId !== undefined || u.type === 'sampler2D') continue;
                if (reg.hasUniform(u.name)) continue;
                const src = cm.findNodeByRemappedName(u.name);
                if (src) reg.registerUniform(u.name, u.type, u.value, src);
            }
        }
    }

    // ------------------------------------------------------------------ textures (consumers)

    /** Texture of an output (created at the current size; consumers re-resolve with liveTexture). */
    getTexture(gl, key) {
        if (key === 'depth') this.wants.depth = true;
        if (key === 'normal') this.wants.normal = true;
        this.ensureTargets(gl);
        return this.targets ? this.targets.tex[key] || this.targets.tex.color : null;
    }

    /** This frame's texture of an output: renders first when needed. */
    liveTexture(key) {
        if (!this.targets) return null;
        this.renderIfNeeded();
        return this.targets.tex[key] || null;
    }

    ensureTargets(gl, size = null) {
        if (!this.targets) this.targets = new R3Targets(gl);
        const s = size || this.targetSize(gl);
        this.targets.ensure(s[0], s[1], { msaa: this.data.msaa, depth: this.wants.depth, normal: this.wants.normal });
    }

    /** Render size: the output being shown (auto) or data.width x height (fixed). */
    targetSize(gl) {
        const d = this.data;
        const caps = glCaps(gl);
        let w, h;
        const ov = R3D.sizeOverride;
        if (ov && d.size !== 'fixed') { w = ov.w; h = ov.h; }
        else if (d.size === 'fixed') { w = d.width; h = d.height; }
        else {
            scan.now = performance.now();
            let best = null, area = 0, prev = null;
            quality.outputs.forEach(scanOutput);
            best = scan.best; prev = scan.prev;
            scan.best = scan.prev = null; scan.area = 0;
            void area;
            if (!best) best = prev;
            if (best) { w = best.w * (best.scale || 1); h = best.h * (best.scale || 1); }
            else { w = 640; h = 400; }
        }
        const max = Math.min(Math.max(64, d.maxSize || 1920), caps.maxTexture);
        const long = Math.max(w, h);
        if (long > max && !(ov && d.size !== 'fixed')) { w = w * max / long; h = h * max / long; }
        w = Math.max(16, Math.min(caps.maxTexture, Math.round(w)));
        h = Math.max(16, Math.min(caps.maxTexture, Math.round(h)));
        // Hysteresis: keep the current size for tiny changes (no realloc churn)
        const t = this.targets;
        if (t && t.w && !(ov && d.size !== 'fixed') && Math.abs(t.w - w) <= Math.max(2, t.w * 0.02) && Math.abs(t.h - h) <= Math.max(2, t.h * 0.02) && Math.abs(t.w / t.h - w / h) < 0.01) {
            return this._size || (this._size = [t.w, t.h]);
        }
        const out = this._size || (this._size = [0, 0]);
        out[0] = w; out[1] = h;
        return out;
    }

    isFresh() {
        return this._stampFrame === clock.frame && this._stampTime === clock.u.time && this._stampBeat === clock.u.beatTime &&
            this._stampEpoch === R3D.epoch && this._stampOv === R3D.sizeOverride;
    }

    renderIfNeeded() {
        if (this._rendering || this.isFresh()) return;
        this._stampFrame = clock.frame;
        this._stampTime = clock.u.time;
        this._stampBeat = clock.u.beatTime;
        this._stampEpoch = R3D.epoch;
        this._stampOv = R3D.sizeOverride;
        try {
            this.render();
        } catch (e) {
            this._warn('render failed', e);
        }
    }

    // ------------------------------------------------------------------ render

    render() {
        const app = R3D.app;
        if (!app || !app.sharedGL || !this.graph) return;
        const gl = app.sharedGL;
        if (!this.compiled) this.compile();
        const c = this.compiled;
        if (!c) return;
        const t0 = performance.now();
        this._rendering = true;
        if (!this.guard) this.guard = new GLStateGuard(gl);
        const guard = this.guard;
        guard.begin();
        try {
            this.ensureTargets(gl);
            const T = this.targets;
            const W = T.w, H = T.h;
            const d = this.data;
            const graph = this.graph;
            const registry = graph.uniformRegistry;
            const st = this.stats;
            st.draws = 0; st.instances = 0; st.triangles = 0; st.points = 0;
            st.w = W; st.h = H; st.msaa = T.samples;

            // Default orbit camera
            const o = d.orbit;
            const cp = Math.cos(o.pitch);
            this._camPos[0] = o.target[0] + o.distance * cp * Math.sin(o.yaw);
            this._camPos[1] = o.target[1] + o.distance * Math.sin(o.pitch);
            this._camPos[2] = o.target[2] + o.distance * cp * Math.cos(o.yaw);
            const cc = d.clearColor;
            this._fog[0] = cc[0]; this._fog[1] = cc[1]; this._fog[2] = cc[2]; this._fog[3] = Math.max(0, d.fog || 0);

            // Per-draw CPU state: meshes, instance counts
            for (let i = 0; i < c.draws.length; i++) this.prepareDraw(gl, c.draws[i]);

            // ---------------- shadow pass
            let shadowOn = false;
            const sl = c.shadowLight;
            if (sl) {
                let casters = 0;
                for (let i = 0; i < c.draws.length; i++) if (c.draws[i].castShadow && c.draws[i].shadowVs && c.draws[i]._count > 0) casters++;
                if (casters) {
                    if (!this.shadowMap) this.shadowMap = new R3ShadowMap(gl);
                    const res = Math.max(256, Math.min(4096, Math.round(d.shadowRes) || 2048));
                    this.shadowMap.ensure(res);
                    if (this.shadowMap.ok) {
                        shadowOn = true;
                        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.shadowMap.fbo);
                        gl.viewport(0, 0, res, res);
                        gl.depthMask(true);
                        gl.clearBufferfv(gl.DEPTH, 0, this._one);
                        gl.enable(gl.DEPTH_TEST);
                        gl.depthFunc(gl.LEQUAL);
                        gl.disable(gl.BLEND);
                        gl.disable(gl.CULL_FACE);
                        gl.enable(gl.POLYGON_OFFSET_FILL);
                        gl.polygonOffset(1.2, 2.0);
                        for (let i = 0; i < c.draws.length; i++) {
                            const dr = c.draws[i];
                            if (!dr.castShadow || !dr.shadowVs || dr._count <= 0) continue;
                            this.drawObject(gl, dr, 'shadow', res, res, registry, guard, false, null);
                        }
                        gl.disable(gl.POLYGON_OFFSET_FILL);
                    }
                }
            }
            st.shadow = shadowOn;

            // ---------------- main pass
            const fb = T.drawTarget();
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
            gl.drawBuffers(T.drawBuffers);
            gl.viewport(0, 0, W, H);
            gl.depthMask(true);
            gl.disable(gl.SCISSOR_TEST);
            const a = cc[3] === undefined ? 1 : cc[3];
            this._clear[0] = cc[0] * a; this._clear[1] = cc[1] * a; this._clear[2] = cc[2] * a; this._clear[3] = a;
            gl.clearBufferfv(gl.COLOR, 0, this._clear);
            this._clearDepth[0] = d.far;
            if (T.has.depth) gl.clearBufferfv(gl.COLOR, 1, this._clearDepth);
            if (T.has.normal) gl.clearBufferfv(gl.COLOR, 2, this._zero4);
            gl.clearBufferfv(gl.DEPTH, 0, this._one);
            gl.enable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);

            if (c.background) this.drawBackground(gl, c.background, W, H, registry, guard);

            gl.depthFunc(gl.LEQUAL);
            for (let pass = 0; pass < 2; pass++) {
                for (let i = 0; i < c.draws.length; i++) {
                    const dr = c.draws[i];
                    if (dr._count <= 0) continue;
                    if (dr.kind === 'model') {
                        // models sort their primitives themselves (opaque / blended materials)
                        if (dr.node.drawModel) dr.node.drawModel(gl, this, dr, 'main', W, H, registry, guard, shadowOn, pass);
                        gl.drawBuffers(T.drawBuffers);
                        continue;
                    }
                    const blended = dr.blend !== 'opaque';
                    if ((pass === 0) === blended) continue;
                    if (blended) {
                        gl.drawBuffers(BLEND_BUFFERS);
                        gl.enable(gl.BLEND);
                        gl.depthMask(false);
                        if (dr.blend === 'add') gl.blendFunc(gl.ONE, gl.ONE);
                        else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                    }
                    this.drawObject(gl, dr, 'main', W, H, registry, guard, shadowOn, fb);
                    if (blended) {
                        gl.disable(gl.BLEND);
                        gl.depthMask(true);
                        gl.drawBuffers(T.drawBuffers);
                    }
                }
            }
            gl.disable(gl.CULL_FACE);
            gl.disable(gl.DEPTH_TEST);
            T.resolve();
            st.renders++;
        } finally {
            guard.end();
            this._rendering = false;
        }
        const ms = performance.now() - t0;
        this.stats.ms = this.stats.ms ? this.stats.ms * 0.9 + ms * 0.1 : ms;
        this.stats.frame = clock.frame;
        R3D.stats.renders++;
    }

    /** CPU side of one draw before rendering: its mesh and instance count. */
    prepareDraw(gl, dr) {
        dr._mesh = null;
        dr._count = 0;
        if (dr.kind === 'model') {
            const m = dr.node;
            if (typeof m.prepareModel === 'function') m.prepareModel(gl, this);
            dr._count = m.modelReady ? this.instanceCount(dr) : 0;
            return;
        }
        if (dr.geometryNode && typeof dr.geometryNode.gpuMesh === 'function') dr._mesh = dr.geometryNode.gpuMesh(gl);
        else dr._mesh = defaultBoxMesh(gl);
        dr._count = this.instanceCount(dr);
    }

    instanceCount(dr) {
        const n = dr.node;
        const ci = dr._countIdx !== undefined ? dr._countIdx : (dr._countIdx = inputIndex(n, 'count'));
        let count = ci >= 0 ? cpuInput(n, ci, Number(n.data.count) || 0) : 0;
        if (!(count > 0)) {
            const spec = dr.countSpec;
            count = 1;
            if (spec && spec.fixed) count = spec.fixed;
            else if (spec && spec.tex) {
                const sz = textureSizeOf(spec.tex.node, spec.tex.output);
                if (sz) count = sz[0] * Math.max(1, Math.floor(sz[1] / spec.blocks));
            }
        }
        return Math.max(0, Math.min(16777216, Math.floor(count)));
    }

    /** Set the Render 3D uniforms of a program. */
    setR3Uniforms(gl, L, dr, W, H, shadowOn, unit, guard, model, normalMat) {
        const d = this.data;
        if (L.r3_model) gl.uniformMatrix4fv(L.r3_model, false, model || IDENTITY4);
        if (L.r3_normalMat) gl.uniformMatrix3fv(L.r3_normalMat, false, normalMat || IDENTITY3);
        if (L.r3_count) gl.uniform1f(L.r3_count, dr ? dr._count : 1);
        if (L.r3_size) gl.uniform2f(L.r3_size, W, H);
        if (L.r3_near) gl.uniform1f(L.r3_near, d.near);
        if (L.r3_far) gl.uniform1f(L.r3_far, d.far);
        if (L.r3_pointSize) gl.uniform1f(L.r3_pointSize, dr ? Number(dr.node.data.pointSize) || 0.05 : 0.05);
        if (L.r3_camPos) gl.uniform3f(L.r3_camPos, this._camPos[0], this._camPos[1], this._camPos[2]);
        if (L.r3_camTarget) { const t = d.orbit.target; gl.uniform3f(L.r3_camTarget, t[0], t[1], t[2]); }
        if (L.r3_camFov) gl.uniform1f(L.r3_camFov, d.orbit.fov);
        if (L.r3_fog) gl.uniform4fv(L.r3_fog, this._fog);
        if (L.r3_exposure) gl.uniform1f(L.r3_exposure, d.exposure);
        if (L.r3_tonemap) gl.uniform1f(L.r3_tonemap, d.tonemap === 'linear' ? 0 : d.tonemap === 'aces' ? 2 : 1);
        if (L.r3_receiveShadow) gl.uniform1f(L.r3_receiveShadow, dr && dr.receiveShadow ? 1 : 0);
        if (L.r3_additive) gl.uniform1f(L.r3_additive, dr && dr.blend === 'add' ? 1 : 0);
        if (L.r3_shadowOn !== undefined) {
            gl.uniform1f(L.r3_shadowOn, shadowOn ? 1 : 0);
            if (L.r3_shadowTexel) gl.uniform1f(L.r3_shadowTexel, shadowOn ? 1 / this.shadowMap.size : 0);
            if (L.r3_shadowSoft) {
                const sl = this.compiled.shadowLight;
                gl.uniform1f(L.r3_shadowSoft, sl ? (Number(sl.node.data.softness) || 1) : 1);
            }
        }
        if (L.r3_shadowMap) {
            guard.bindTexture(unit, shadowOn ? this.shadowMap.tex : dummyShadowTexture(gl));
            gl.uniform1i(L.r3_shadowMap, unit);
            unit++;
        }
        return unit;
    }

    drawObject(gl, dr, pass, W, H, registry, guard, shadowOn, fb) {
        if (dr.kind === 'model') {
            if (typeof dr.node.drawModel === 'function') dr.node.drawModel(gl, this, dr, pass, W, H, registry, guard, shadowOn);
            return;
        }
        const mesh = dr._mesh;
        if (!mesh) return;
        const v = pass === 'shadow' ? this.variant(dr, 'shadow', [], '') : this.variant(dr, 'main', dr.defines || [], dr.defKey || '');
        if (!v.entry) return;
        const L = v.entry.uniforms;
        gl.useProgram(v.entry.program);
        let unit = bindProgramUniforms(gl, L, pass === 'shadow' ? dr.shadowUniforms : dr.uniforms, registry, guard, W, H, this.graph, 1);
        unit = this.setR3Uniforms(gl, L, dr, W, H, shadowOn, unit, guard, null, null);
        // a texture this draw sampled may have rendered another Render 3D in between
        if (fb && pass === 'main') this.rebindTarget(gl, fb, W, H, dr);
        this.cullFor(gl, dr, pass);
        this.issue(gl, mesh, dr._count, dr);
    }

    /** Back to our framebuffer / viewport (a nested lazy render may have changed them). */
    rebindTarget(gl, fb, W, H, dr) {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
        gl.viewport(0, 0, W, H);
        if (dr && dr.blend !== 'opaque') gl.drawBuffers(BLEND_BUFFERS);
        else gl.drawBuffers(this.targets.drawBuffers);
    }

    cullFor(gl, dr, pass) {
        if (pass === 'shadow' || dr.points || dr.lines || dr.cull === 'none') { gl.disable(gl.CULL_FACE); return; }
        gl.enable(gl.CULL_FACE);
        gl.cullFace(dr.cull === 'front' ? gl.FRONT : gl.BACK);
    }

    /** Issue the draw call of a mesh (instanced, or points with gl_VertexID as the id). */
    issue(gl, mesh, count, dr) {
        const st = this.stats;
        if (count <= 0) return;
        if (mesh.points) {
            gl.bindVertexArray(mesh.vao);
            setDefaultAttribs(gl, mesh.has);
            gl.drawArrays(gl.POINTS, 0, count);
            st.points += count;
        } else {
            gl.bindVertexArray(mesh.vao);
            setDefaultAttribs(gl, mesh.has);
            if (mesh.indexType) gl.drawElementsInstanced(mesh.mode, mesh.count, mesh.indexType, 0, count);
            else gl.drawArraysInstanced(mesh.mode, 0, mesh.count, count);
            st.triangles += mesh.triangles * count;
        }
        gl.bindVertexArray(null);
        st.draws++;
        st.instances += count;
    }

    drawBackground(gl, bg, W, H, registry, guard) {
        const v = this.variant(bg, 'bg', [], '');
        if (!v.entry) return;
        const L = v.entry.uniforms;
        gl.useProgram(v.entry.program);
        let unit = bindProgramUniforms(gl, L, bg.uniforms, registry, guard, W, H, this.graph, 1);
        this.setR3Uniforms(gl, L, null, W, H, false, unit, guard, null, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.targets.drawTarget());
        gl.viewport(0, 0, W, H);
        gl.drawBuffers(this.targets.drawBuffers);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.ALWAYS);
        gl.depthMask(true);
        gl.disable(gl.CULL_FACE);
        const loc = v.entry.aPosition >= 0 ? v.entry.aPosition : 0;
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer(gl));
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.depthFunc(gl.LEQUAL);
    }

    // ------------------------------------------------------------------ thumbnail

    previewCanvas(cssW, cssH) {
        const app = R3D.app;
        if (!app || !app.sharedGL || !this.graph) return null;
        const gl = app.sharedGL;
        if (!this.compiled) this.compile();
        if (!this.compiled || !this.compiled.draws.length) {
            if (!this.compiled || !this.compiled.background) return null;
        }
        if (!this.targets) this.ensureTargets(gl);
        this.renderIfNeeded();
        const T = this.targets;
        if (!T || !T.tex.color) return null;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const zoom = (this.graph.zoom || 1);
        let w = Math.max(8, Math.min(640, Math.round(cssW * dpr * Math.min(zoom, 2))));
        let h = Math.max(8, Math.round(w * T.h / T.w));
        if (this._thumbFrame === this.stats.renders && this._thumbW === w && this._thumbH === h && this._displayCanvas) return this._displayCanvas;
        const p = thumbProgram(gl);
        if (!p) return null;
        if (!this._thumb || this._thumb.w !== w || this._thumb.h !== h) {
            if (this._thumb) { gl.deleteTexture(this._thumb.tex); gl.deleteFramebuffer(this._thumb.fbo); }
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            this._thumb = { tex, fbo, w, h };
        }
        if (!this.guard) this.guard = new GLStateGuard(gl);
        const guard = this.guard;
        guard.begin();
        try {
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._thumb.fbo);
            gl.viewport(0, 0, w, h);
            gl.useProgram(p.program);
            guard.bindTexture(0, T.tex.color);
            gl.uniform1i(p.u_tex, 0);
            gl.uniform4f(p.u_bg, 0.02, 0.022, 0.03, 1);
            gl.disable(gl.BLEND);
            gl.disable(gl.DEPTH_TEST);
            gl.bindVertexArray(null);
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer(gl));
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            if (!this._displayCanvas) {
                this._displayCanvas = document.createElement('canvas');
                this._displayCtx = this._displayCanvas.getContext('2d');
            }
            if (this._displayCanvas.width !== w || this._displayCanvas.height !== h) {
                this._displayCanvas.width = w;
                this._displayCanvas.height = h;
            }
            presentTexture(gl, this._thumb.tex, w, h, this._displayCtx, { flipY: false });
        } finally {
            guard.end();
        }
        this._thumbFrame = this.stats.renders;
        this._thumbW = w;
        this._thumbH = h;
        return this._displayCanvas;
    }

    // ------------------------------------------------------------------ lifecycle

    describe() {
        const s = this.stats;
        const c = this.compiled;
        return {
            size: [s.w, s.h], msaa: s.msaa, draws: s.draws, instances: s.instances, triangles: s.triangles, points: s.points,
            shadow: s.shadow, cpu_ms: +s.ms.toFixed(2), renders: s.renders,
            objects: c ? c.draws.map(d => ({ node: d.node.id, type: d.node.type, kind: d.geometryKind || d.kind, blend: d.blend, casts_shadow: d.castShadow, count: d._count ?? null })) : [],
            lights: c ? c.lights.map(l => ({ node: l.node.id, type: l.node.type, shadow: c.shadowLight === l })) : [],
            outputs: c ? c.outputs : null,
            camera: this.cameraConnected() ? 'connected' : { orbit: this.data.orbit },
            errors: this.compileErrors.length ? this.compileErrors.slice() : undefined,
            warnings: c && c.warnings.length ? c.warnings.slice() : undefined,
        };
    }

    cleanup() {
        const app = R3D.app;
        this.releasePrograms();
        if (this.targets) this.targets.release();
        if (this.shadowMap) this.shadowMap.release();
        if (this._thumb && app && app.sharedGL) {
            app.sharedGL.deleteTexture(this._thumb.tex);
            app.sharedGL.deleteFramebuffer(this._thumb.fbo);
        }
        this._thumb = null;
        this.targets = null;
        this.shadowMap = null;
    }
}

const SHADOW_FS = `#version 300 es
precision highp float;
void main() {
}`;

function fmtCount(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return String(n);
}
