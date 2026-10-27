import { Node } from './Node.js';
import { COLORS, FONTS, CANVAS, LAYOUT } from '../ui/theme.js';
import { drawInset, drawLabel, fitText, measure } from '../rendering/NodePainter.js';
import { FloatingCodeEditor } from '../ui/FloatingCodeEditor.js';
import { jsRuntime, remapOutputConnections, zeroOf, codeKey, DEFAULT_KEYS, parseInputDecls, jsInputDefault } from './jsRuntime.js';
import { JS_DEFAULT_CODE, JS_DEFAULT_SETUP } from '../core/jsDefaults.js';

const JS_CODE_WELL_H = 30;
const THUMB_H = 52;
const ROW_H = LAYOUT.portSpacing;

export { JS_DEFAULT_CODE, JS_DEFAULT_SETUP };

DEFAULT_KEYS.add(codeKey({ setupCode: JS_DEFAULT_SETUP, code: JS_DEFAULT_CODE }));
DEFAULT_KEYS.add(codeKey({ setupCode: '', code: JS_DEFAULT_CODE }));

const SETUP_MARK = '// @setup';
const FRAME_MARK = '// @frame';

/** Editor text: both code blocks in one document, split by marker lines. */
export function composeEditorText(setupCode, code) {
    return `${SETUP_MARK}  runs once (async: await loadScript(url) works; keep things in state)\n${setupCode || ''}\n\n` +
        `${FRAME_MARK}  runs every frame. In scope: time dt frame resolution mouse audio params state inputs\n` +
        `//   helpers: float int bool vec2 vec3 vec4 clamp mix damp(current, target, rate) canvas(w, h) texture(c) dataTexture(arr, w, h, ch) list(arr) event(fired)\n` +
        `//   return a value (one output) or { name: value, ... } (named outputs); control inputs: a line "// @input speed float = 1"\n${code || ''}\n`;
}

export function parseEditorText(text) {
    const lines = String(text).split('\n');
    const fi = lines.findIndex(l => l.trim().startsWith(FRAME_MARK));
    if (fi < 0) return { setupCode: '', code: String(text).trim() };
    const si = lines.findIndex(l => l.trim().startsWith(SETUP_MARK));
    const setup = lines.slice(si >= 0 && si < fi ? si + 1 : 0, fi).join('\n').trim();
    let body = lines.slice(fi + 1);
    // Drop the helper comment lines that follow the frame marker
    while (body.length && /^\/\/\s{3}(helpers:|return a value)/.test(body[0])) body.shift();
    return { setupCode: setup, code: body.join('\n').trim() };
}

/**
 * JSNode: runs JavaScript every frame (see jsRuntime.js) and exposes the return
 * value(s) as typed output ports backed by live uniforms.
 *
 * data: setupCode, code, outputs ([{name, type}] - the last output signature, saved
 * so cables survive a reload before the code has run).
 */
export class JSNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isJSNode = true;
        this.width = 176;
        if (typeof this.data.code !== 'string') this.data.code = JS_DEFAULT_CODE;
        if (typeof this.data.setupCode !== 'string') this.data.setupCode = '';
        this.data.outputs = Array.isArray(this.data.outputs) ? this.data.outputs.map(o => ({ ...o })) : [];
        this.trust = null;           // null (unchecked) | 'pending' | 'blocked' | 'trusted'
        this.state = {};
        this.setupState = 'idle';
        this.values = new Map();
        this.jsError = null;
        this.recompiles = 0;
        this._domElements = [];
        this.syncOutputsFromData();
        this.syncInputsFromCode({ silent: true });
    }

    /** Data replaced (load / paste / automation): ports follow data.outputs, code is re-checked. */
    rebuildTextInputs() {
        delete this.data.setupComplete; // legacy flag
        this.syncOutputsFromData();
        this.syncInputsFromCode({ silent: true });
        this.trust = null;
        this._setupFor = undefined;
    }

    syncOutputsFromData() {
        const list = Array.isArray(this.data.outputs) ? this.data.outputs : [];
        this.outputs = list
            .filter(o => o && typeof o.name === 'string' && /^(float|int|bool|vec[234]|sampler2D|event|string|list)$/.test(o.type))
            .map(o => (o.tex ? { name: o.name, type: o.type, tex: String(o.tex) } : { name: o.name, type: o.type }));
        this.updateDimensions();
    }

    /**
     * Control-rate input ports from the "// @input name type [= default]" lines of the
     * code. Cables follow inputs by name; a changed set of inputs recompiles.
     */
    syncInputsFromCode({ silent = false } = {}) {
        const decls = parseInputDecls(this.data.code);
        const sig = decls.map(d => `${d.name}:${d.type}=${d.default ?? ''}`).join(',');
        if (sig === this._inputSig && this.inputs.length === decls.length) return false;
        this._inputSig = sig;
        const old = this.inputs.map(i => ({ ...i }));
        this.inputs = decls.map(d => ({
            name: d.name,
            type: d.type,
            rate: 'control',
            cpuInput: true, // read by the ControlRuntime, never compiled into GLSL
            default: d.default,
            jsDefault: jsInputDefault(d),
            description: `control-rate input (// @input ${d.name} ${d.type}${d.default !== undefined ? ` = ${d.default}` : ''})`
        }));
        const g = this.graph;
        if (g && Array.isArray(g.connections) && old.length) {
            g.connections = g.connections.filter(c => {
                if (c.toNode !== this) return true;
                const o = old[c.toInput];
                const idx = o ? this.inputs.findIndex(i => i.name === o.name) : -1;
                if (idx < 0) return false;
                c.toInput = idx;
                return true;
            });
        }
        this.updateDimensions();
        if (!silent && g && g.onGraphChanged && sig !== (this._inputSigCompiled || '')) g.onGraphChanged();
        this._inputSigCompiled = sig;
        return true;
    }

    signature() {
        return this.outputs.map(o => `${o.name}:${o.type}${o.tex ? `[${o.tex}]` : ''}`).join(',');
    }

    setOutputs(list) {
        const old = this.outputs.map(o => ({ ...o }));
        this.outputs = list.map(o => ({ ...o }));
        this.data.outputs = list.map(o => ({ ...o }));
        remapOutputConnections(this, old);
        // Textures of outputs that disappeared (or stopped being textures) are freed
        if (this.textures) {
            for (const name of [...this.textures.keys()]) {
                if (!this.outputs.some(o => o.name === name && o.type === 'sampler2D')) this.freeTexture(name);
            }
        }
        this.updateDimensions();
    }

    // ---- Texture outputs (sampler2D) in the shared GL context ----

    /** The GL texture of a sampler2D output (created on first use, 1x1 black until uploaded). */
    getTexture(gl, name) {
        if (!gl) return null;
        if (!this.textures) this.textures = new Map();
        let t = this.textures.get(name);
        if (t && t.gl !== gl) t = null;
        if (!t) {
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindTexture(gl.TEXTURE_2D, null);
            t = { gl, tex, w: 1, h: 1, kind: null, format: null, uploads: 0 };
            this.textures.set(name, t);
        }
        return t.tex;
    }

    /**
     * Upload a texture output. Canvases are uploaded only when dirty (drawn this frame,
     * resized or c.dirty = true; canvases not made by canvas() every frame); data textures
     * every frame (texSubImage2D), RGBA32F with RGBA16F / RGBA8 fallbacks, NEAREST.
     */
    uploadTexture(gl, name, value) {
        this.getTexture(gl, name);
        const t = this.textures.get(name);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        try {
            if (value.kind === 'canvas') {
                const src = value.source;
                const w = src.videoWidth || src.naturalWidth || src.width;
                const h = src.videoHeight || src.naturalHeight || src.height;
                if (!w || !h) return;
                const isVideo = typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement;
                const isImg = typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement;
                const resized = t.kind !== 'canvas' || t.w !== w || t.h !== h || t.source !== src;
                const dirty = resized || isVideo || (isImg ? false : src.dirty !== false);
                if (isImg && !src.complete) return;
                if (!dirty) return;
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // canvas top = v 1, like images and video
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                if (resized || t.filter !== value.filter || t.wrap !== value.wrap) {
                    const f = value.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
                    const wrap = value.wrap === 'repeat' ? gl.REPEAT : value.wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
                    t.filter = value.filter;
                    t.wrap = value.wrap;
                }
                Object.assign(t, { kind: 'canvas', w, h, source: src, format: 'rgba8' });
                if (!isVideo && 'dirty' in src) src.dirty = false;
                t.uploads++;
                return;
            }
            // Data texture: always RGBA (missing channels 0, alpha 1)
            const { data, width: w, height: h, channels: c } = value;
            const len = w * h * 4;
            if (!t.buf || t.buf.length !== len) t.buf = new Float32Array(len);
            const buf = t.buf;
            const count = Math.min(data.length / c, w * h);
            for (let i = 0; i < w * h; i++) {
                const o = i * 4;
                if (i < count) {
                    const s = i * c;
                    buf[o] = +data[s] || 0;
                    buf[o + 1] = c > 1 ? (+data[s + 1] || 0) : 0;
                    buf[o + 2] = c > 2 ? (+data[s + 2] || 0) : 0;
                    buf[o + 3] = c > 3 ? (+data[s + 3] || 0) : 1;
                } else {
                    buf[o] = buf[o + 1] = buf[o + 2] = 0;
                    buf[o + 3] = c > 3 ? 0 : 1;
                }
            }
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            if (t.kind !== 'data' || t.w !== w || t.h !== h) {
                // (Re)allocate: RGBA32F, else RGBA16F, else RGBA8 (values clamped to 0..1)
                gl.getError();
                t.format = null;
                for (const [fmt, internal, type] of [['rgba32f', gl.RGBA32F, gl.FLOAT], ['rgba16f', gl.RGBA16F, gl.FLOAT]]) {
                    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, buf);
                    if (gl.getError() === gl.NO_ERROR) { t.format = fmt; break; }
                }
                if (!t.format) {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._toBytes(buf));
                    t.format = 'rgba8';
                }
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                Object.assign(t, { kind: 'data', w, h, source: null });
            } else if (t.format === 'rgba8') {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._toBytes(buf));
            } else {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
            }
            t.uploads++;
        } finally {
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
    }

    _toBytes(buf) {
        const out = new Uint8Array(buf.length);
        for (let i = 0; i < buf.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(buf[i] * 255)));
        return out;
    }

    /** Current GL texture of an output, or null (renderers call this every frame). */
    liveTexture(name) {
        const t = this.textures && this.textures.get(name);
        return t ? t.tex : null;
    }

    freeTexture(name) {
        const t = this.textures && this.textures.get(name);
        if (!t) return;
        try { t.gl.deleteTexture(t.tex); } catch (e) { /* context lost */ }
        this.textures.delete(name);
    }

    freeTextures() {
        if (!this.textures) return;
        for (const name of [...this.textures.keys()]) this.freeTexture(name);
    }

    /** First canvas-backed output (shown as a thumbnail on the node). */
    thumbSource() {
        for (const o of this.outputs) {
            if (o.type !== 'sampler2D') continue;
            const v = this.values.get(o.name);
            if (v && v.value && v.value.kind === 'canvas') return v.value.source;
        }
        return null;
    }

    hasThumb() {
        return this.outputs.some(o => o.type === 'sampler2D' && String(o.tex || '').startsWith('canvas'));
    }

    /** Value of output i for the compiled uniform (last frame, or zero). */
    getOutputValue(i) {
        const o = this.outputs[i];
        if (!o || o.type === 'sampler2D') return 0;
        const v = this.values.get(o.name);
        return v && v.type === o.type ? v.value : zeroOf(o.type);
    }

    /** Write every output into the UniformRegistry under its compiled name. */
    pushValues() {
        const reg = this.graph && this.graph.uniformRegistry;
        const base = this.compiledVarName;
        if (!reg || !base) return;
        const gl = this.graph.sharedGL;
        for (let i = 0; i < this.outputs.length; i++) {
            const o = this.outputs[i];
            const v = this.values.get(o.name);
            if (!v || v.type !== o.type) continue;
            if (o.type === 'event' || o.type === 'string' || o.type === 'list') continue; // control-only
            if (o.type === 'sampler2D') {
                if (gl) this.uploadTexture(gl, o.name, v.value);
                continue;
            }
            reg.registerUniform(`${base}_o${i}`, o.type, v.value, this);
        }
    }

    needsContinuousRender() {
        return this.trust === 'trusted' && this.outputs.length > 0;
    }

    // ---- Script loading for setup code ----

    loadScript(url) {
        return new Promise((resolve, reject) => {
            const src = String(url);
            if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(script);
            this._domElements.push(script);
        });
    }

    cleanupDom() {
        for (const el of this._domElements) el.remove();
        this._domElements = [];
    }

    cleanup() {
        this.cleanupDom();
        this.freeTextures();
        const cm = jsRuntime.app && jsRuntime.app.compilationManager;
        if (cm && cm.setRuntimeError) cm.setRuntimeError(this, null);
    }

    // ---- Editing ----

    openEditor() {
        const key = `JS #${this.id}`;
        const existing = FloatingCodeEditor.findByNodeType(key);
        if (existing) {
            existing.bringToFront();
            return existing;
        }
        const text = composeEditorText(this.data.setupCode, this.data.code);
        // The node this editor edits now: undo / redo may have replaced it (same id) or removed it
        const live = () => {
            const g = this.graph;
            if (!g || !Array.isArray(g.nodes)) return null;
            if (g.nodes.includes(this)) return this;
            return g.nodes.find(n => n.id === this.id && n.isJSNode) || null;
        };
        const editor = new FloatingCodeEditor({
            title: `JS node #${this.id}`,
            language: 'javascript',
            value: text,
            nodeType: key,
            saveButtonLabel: 'Apply',
            source: () => {
                const n = live();
                return n ? composeEditorText(n.data.setupCode, n.data.code) : null;
            },
            onSave: (value) => {
                const node = live();
                if (!node) return false;
                const { setupCode, code } = parseEditorText(value);
                const setupChanged = setupCode !== (node.data.setupCode || '');
                node.data.setupCode = setupCode;
                node.data.code = code;
                // Code typed here is authored in this browser: trust it
                jsRuntime.trustNode(node);
                node._trustKey = codeKey(node.data);
                if (setupChanged) node._setupFor = undefined;
                node.jsError = null;
                const g = node.graph;
                if (g && g.onUniformValueChanged) g.onUniformValueChanged(node);
                if (g && g.render) g.render();
                // Stay open for quick iteration: mark the editor clean
                editor.originalValue = value;
                editor.isDirty = false;
                editor.hideNotice();
                editor.updateButtonVisibility();
                return undefined;
            }
        });
        return editor;
    }

    // ---- Drawing ----

    getHeaderIcon() {
        return 'js';
    }

    isInErrorState() {
        return !!(this.hasError || this.jsError);
    }

    getOutputPortLabel(i) {
        return this.outputs[i] ? this.outputs[i].name : '';
    }

    portRows() {
        return Math.max(this.outputs.length, (this.inputs || []).length, 1);
    }

    updateDimensions() {
        const rows = this.portRows();
        this.height = this.heightForRows(rows, JS_CODE_WELL_H + 4 + (this.hasThumb() ? THUMB_H + 4 : 0));
    }

    getThumbRect() {
        const rows = this.portRows();
        return { x: this.x + 10, y: this.getRowCenterY(rows - 1) + ROW_H / 2 + 3, w: this.width - 20, h: THUMB_H };
    }

    getCodeWellRect() {
        const rows = this.portRows();
        const top = this.getRowCenterY(rows - 1) + ROW_H / 2 + 3 + (this.hasThumb() ? THUMB_H + 4 : 0);
        return { x: this.x + 10, y: top, w: this.width - 20, h: JS_CODE_WELL_H };
    }

    drawHeaderTags(ctx) {
        const status = this.statusInfo();
        return this.drawHeaderLed(ctx, status.led, status.color);
    }

    statusInfo() {
        if (this.jsError) return { led: true, color: COLORS.error, text: this.jsError, tone: 'error' };
        if (this.trust === 'pending') return { led: true, color: COLORS.warning, text: 'paused · waiting for permission', tone: 'warn' };
        if (this.trust === 'blocked') return { led: true, color: COLORS.warning, text: 'paused · click to allow', tone: 'warn' };
        if (this.trust !== 'trusted') return { led: false, color: COLORS.textFaint, text: 'paused', tone: 'warn' };
        if (this.setupState === 'running') return { led: true, color: COLORS.warning, text: 'running setup…', tone: 'dim' };
        return { led: true, color: CANVAS.ledOn, text: null, tone: 'ok' };
    }

    formatValue(v) {
        if (!v) return '–';
        const f = (x) => {
            const a = Math.abs(x);
            return Number.isInteger(x) ? String(x) : a >= 100 ? x.toFixed(1) : x.toFixed(3);
        };
        if (v.type === 'bool') return v.value ? 'true' : 'false';
        if (v.type === 'sampler2D') return v.tex || 'texture';
        if (v.type === 'string') return JSON.stringify(String(v.value));
        if (v.type === 'event') return v.value ? 'fired' : '·';
        if (v.type === 'list') return `[${v.value.length}] ${v.value.slice(0, 3).map(f).join(' ')}${v.value.length > 3 ? ' …' : ''}`;
        if (Array.isArray(v.value)) return v.value.map(f).join(' ');
        return f(v.value);
    }

    drawBody(ctx, options = {}) {
        // Current value of each output, left of its port label (right of an input label on the same row)
        for (let i = 0; i < this.outputs.length; i++) {
            const o = this.outputs[i];
            const labelW = measure(ctx, FONTS.title, o.name) + 22;
            const inp = this.inputs && this.inputs[i];
            const inW = inp ? measure(ctx, FONTS.title, inp.name) + 18 : 0;
            const text = fitText(ctx, FONTS.value, this.formatValue(this.values.get(o.name)), this.width - 22 - labelW - inW);
            drawLabel(ctx, text, this.x + 10 + inW, this.getRowCenterY(i), this.trust === 'trusted' ? COLORS.textDim : COLORS.textFaint, 'left', FONTS.value);
        }
        if (!this.outputs.length) {
            drawLabel(ctx, this.trust === 'trusted' && !this.jsError ? 'no outputs yet' : '', this.x + 10, this.getRowCenterY(0), COLORS.textFaint, 'left', FONTS.value);
        }

        if (this.hasThumb()) {
            const t = this.getThumbRect();
            drawInset(ctx, t.x, t.y, t.w, t.h);
            const src = this.thumbSource();
            const sw = src && (src.videoWidth || src.width), sh = src && (src.videoHeight || src.height);
            if (sw && sh) {
                const k = Math.min((t.w - 4) / sw, (t.h - 4) / sh);
                try { ctx.drawImage(src, t.x + (t.w - sw * k) / 2, t.y + (t.h - sh * k) / 2, sw * k, sh * k); } catch (e) { /* not drawable */ }
            }
        }

        const r = this.getCodeWellRect();
        const status = this.statusInfo();
        const hovered = this.isHoveringRect(options, r);
        drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered && status.tone === 'warn' ? CANVAS.insetHover : undefined });
        if (this._codeSrc !== this.data.code) {
            this._codeSrc = this.data.code;
            this._codeLines = String(this.data.code || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//')).slice(0, 2);
        }
        ctx.font = FONTS.value;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        if (status.text) {
            ctx.fillStyle = status.tone === 'error' ? COLORS.error : status.tone === 'warn' ? COLORS.warning : COLORS.textDim;
            const words = fitText(ctx, FONTS.value, status.text, r.w - 10);
            ctx.fillText(words, r.x + 5, r.y + 12);
            const lines = this._codeLines || [];
            if (lines[0]) {
                ctx.fillStyle = COLORS.textFaint;
                ctx.fillText(fitText(ctx, FONTS.value, lines[0], r.w - 10), r.x + 5, r.y + 23);
            }
        } else {
            const lines = this._codeLines || [];
            for (let i = 0; i < lines.length; i++) {
                ctx.fillStyle = i === 0 ? COLORS.textDim : COLORS.textFaint;
                ctx.fillText(fitText(ctx, FONTS.value, lines[i], r.w - 10), r.x + 5, r.y + 12 + i * 11);
            }
        }
    }

    getControlCursor(x, y) {
        const r = this.getCodeWellRect();
        if ((this.trust === 'blocked' || this.trust === 'pending') && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'pointer';
        return super.getControlCursor(x, y);
    }

    handleMouseDown(x, y, event) {
        const r = this.getCodeWellRect();
        if (this.trust === 'blocked' && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
            jsRuntime.askFor(this);
            return { handled: true, needsRender: true };
        }
        return super.handleMouseDown(x, y, event);
    }
}
