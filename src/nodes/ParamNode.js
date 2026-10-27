import { Node } from './Node.js';
import { COLORS, FONTS, CANVAS, LAYOUT } from '../ui/theme.js';
import { drawInset, drawLabel, drawTag, drawValueBar, drawIconCentered, fitText, measure, withAlpha } from '../rendering/NodePainter.js';
import { pushLiveUniform } from './liveUniform.js';
import { clock } from '../core/Clock.js';
import { loopTrace } from '../core/loopTrace.js';
import { contentGate } from '../core/contentGate.js';
import {
    normalizeKind, normalizeParamData, paramOutputs, paramUniformValue, paramUniformType, coerceParamValue,
    paramRange, valueToUnit, unitToValue, snap, formatParamValue, paramLabel, kindDefault, KIND_INFO, rgbToHex, adoptKindRange
} from '../core/paramKinds.js';
import { TypeSystem } from '../core/NodeDefinitions.js';

const ROW_H = LAYOUT.portSpacing;
const CONTROL_H = { float: 16, int: 16, bool: 16, enum: 16, trigger: 18, color: 22, vec2: 58, image: 58, vec3: 0, vec4: 0, text: 18 };
const KIND_TAG = { float: 'float', int: 'int', bool: 'bool', vec2: 'vec2', vec3: 'vec3', vec4: 'vec4', color: 'rgb', enum: 'enum', trigger: 'trigger', image: 'image', text: 'text' };
const MAX_IMAGE_PX = 1024;

/** Notify the Parameters panel (and anyone else) that a param changed. */
export function emitParamChange(node, what = 'value') {
    try {
        window.dispatchEvent(new CustomEvent('patchtoy:param', { detail: { id: node.id, what } }));
    } catch (e) { /* ignore */ }
}

let colorInput = null;
function sharedColorInput() {
    if (colorInput) return colorInput;
    colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'pt-color-input';
    colorInput.tabIndex = -1;
    colorInput.setAttribute('aria-hidden', 'true');
    document.body.appendChild(colorInput);
    return colorInput;
}

/**
 * Param node: a named UI parameter (see src/core/paramKinds.js). Compact on the
 * canvas (label, kind, value + a small control); the full form lives in the
 * Parameters panel (src/ui/ParamsPanel.js).
 */
export class ParamNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isParamNode = true;
        this.width = 168;
        this.fixedWidth = true;
        this.pulse = false;
        this.pressTime = -1e4;
        this._pulseFrame = -10;
        this._dragging = null;
        this._image = null;
        this._imageSrc = null;
        this._texture = null;
        this._paramFresh = true; // until data is first applied by automation (value -> default)
        this.syncFromData({ silent: true });
    }

    /**
     * Data was replaced (project load, paste, set_node_data): normalize it and make
     * the output ports follow the kind. NodeFactory / automation call this hook after
     * restoring node.data.
     */
    rebuildTextInputs() {
        this.syncFromData({ silent: true });
    }

    get kind() {
        return normalizeKind(this.data.kind) || 'float';
    }

    /** Normalize data and rebuild ports. Returns true when the output signature changed. */
    syncFromData({ silent = false } = {}) {
        normalizeParamData(this.data);
        const outs = paramOutputs(this.data);
        const sig = outs.map(o => `${o.name}:${o.type}`).join(',');
        const prev = this.outputs.map(o => `${o.name}:${o.type}`).join(',');
        let changed = false;
        if (sig !== prev) {
            this.outputs = outs;
            changed = true;
            // Drop cables that no longer fit (output removed or not convertible)
            const g = this.graph;
            if (g && Array.isArray(g.connections)) {
                g.connections = g.connections.filter(c => {
                    if (c.fromNode !== this) return true;
                    const o = this.outputs[c.fromOutput];
                    if (!o) return false;
                    const inT = c.toNode.inputs[c.toInput] && c.toNode.inputs[c.toInput].type;
                    return !inT || inT === 'any' || inT === 'T' || o.type === inT || TypeSystem.canConvert(o.type, inT);
                });
            }
        }
        if (this.kind === 'image') this._ensureImage();
        this.updateDimensions();
        if (!silent) emitParamChange(this, 'meta');
        return changed;
    }

    getDisplayTitle() {
        return paramLabel(this);
    }

    getAccentColor() {
        return CANVAS.uniform;
    }

    getUniformValue() {
        return paramUniformValue(this.data, { pulse: this.pulse, pressTime: this.pressTime });
    }

    // ------------------------------------------------------------------
    // Value API (canvas, panel, automation all go through here)
    // ------------------------------------------------------------------

    /** Set the value (coerced to the kind). commit = save the project (debounced). */
    setValue(raw, { commit = true } = {}) {
        const v = coerceParamValue(this.data, raw);
        this.data.value = v;
        if (this.kind === 'image') this._ensureImage();
        pushLiveUniform(this);
        if (commit && this.graph && this.graph.onUniformValueChanged) this.graph.onUniformValueChanged(this);
        emitParamChange(this, 'value');
        return v;
    }

    resetValue() {
        if (this.kind === 'trigger') return this.setValue(0);
        if (this.kind === 'image') return this.setValue('');
        const d = this.data.default;
        return this.setValue(Array.isArray(d) ? [...d] : (d === undefined ? kindDefault(this.kind, this.data) : d));
    }

    /** Trigger: one-frame pulse + press counter + press time. */
    press() {
        this.data.value = (Number(this.data.value) || 0) + 1;
        this.pulse = true;
        this.pressTime = clock.u.time;
        this._pulseFrame = clock.frame;
        pushLiveUniform(this);
        if (this.graph && this.graph.onUniformValueChanged) this.graph.onUniformValueChanged(this);
        emitParamChange(this, 'value');
    }

    /** Called once per frame before rendering (main animation loop). */
    tick() {
        if (this.pulse && clock.frame >= this._pulseFrame + 2) {
            this.pulse = false;
            pushLiveUniform(this);
        }
    }

    /**
     * Change the kind (recompiles). The value is carried over when it can be
     * interpreted for the new kind, otherwise it becomes the kind's default.
     */
    setKind(kind, extra = {}) {
        const k = normalizeKind(kind);
        if (!k) throw new Error(`Unknown param kind "${kind}"`);
        const old = { ...this.data };
        Object.assign(this.data, extra);
        if (k !== old.kind || extra.alpha !== undefined) {
            this.data.kind = k;
            let v;
            try {
                v = (k === 'trigger' || k === 'image' || old.kind === 'image' || old.kind === 'trigger')
                    ? kindDefault(k, this.data) : coerceParamValue(this.data, old.value);
            } catch (e) { v = kindDefault(k, this.data); }
            this.data.value = v;
            this.data.default = Array.isArray(v) ? [...v] : v;
            adoptKindRange(this.data, old.kind, k);
        }
        const changed = this.syncFromData();
        if (this.graph && this.graph.onGraphChanged) this.graph.onGraphChanged();
        if (this.graph) this.graph.render();
        return changed;
    }

    // ------------------------------------------------------------------
    // Image kind: texture in the shared GL context
    // ------------------------------------------------------------------

    _ensureImage() {
        const src = this.kind === 'image' ? String(this.data.value || '') : '';
        if (src === this._imageSrc) return;
        this._imageSrc = src;
        this._image = null;
        this._imageReady = false;
        this._uploaded = false;
        if (!src) {
            this._clearTexture();
            return;
        }
        // In someone else's project a remote image waits for consent (src/core/contentGate.js)
        const loaded = contentGate.request(this, src, () => {
            if (this._imageSrc !== src) return;
            this.imageError = null;
            this._loadImageNow(src);
        });
        if (!loaded) {
            this.imageError = 'image from another site blocked';
            if (this.graph) this.graph.render();
        }
    }

    _loadImageNow(src) {
        const img = new Image();
        if (!src.startsWith('data:') && !src.startsWith('blob:')) img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (this._imageSrc !== src) return;
            this._image = img;
            this._imageReady = true;
            this.imageError = null;
            this._upload();
            if (this.graph) this.graph.render();
            emitParamChange(this, 'value');
        };
        img.onerror = () => {
            if (this._imageSrc !== src) return;
            this.imageError = 'could not load image';
            if (this.graph) this.graph.render();
            emitParamChange(this, 'value');
        };
        img.src = src;
    }

    /** The sampler2D texture (created on first use; image uploaded when loaded). */
    getTexture(gl) {
        if (!gl) return null;
        if (this._gl !== gl || !this._texture) {
            this._gl = gl;
            this._texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this._texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
            this._applySampling(gl, false);
            this._uploaded = false;
        }
        this._ensureImage();
        if (this._imageReady && !this._uploaded) this._upload();
        return this._texture;
    }

    /** Current GL texture, or null once freed (renderers call this every frame). */
    liveTexture() {
        return this._texture;
    }

    _applySampling(gl, mip) {
        const wrap = this.data.wrap === 'repeat' ? gl.REPEAT : this.data.wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
        const nearest = this.data.filter === 'nearest';
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : (mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    }

    _upload() {
        const gl = this._gl;
        if (!gl || !this._texture || !this._image) return;
        try {
            gl.bindTexture(gl.TEXTURE_2D, this._texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // uv (0,0) = bottom-left, like the camera
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._image);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            const mip = this.data.filter !== 'nearest';
            if (mip) gl.generateMipmap(gl.TEXTURE_2D);
            this._applySampling(gl, mip);
            gl.bindTexture(gl.TEXTURE_2D, null);
            this._uploaded = true;
        } catch (e) {
            this.imageError = 'image could not be used as a texture (cross-origin?)';
            console.warn('[Param] texture upload failed:', e);
        }
    }

    _clearTexture() {
        if (this._gl && this._texture) {
            const gl = this._gl;
            gl.bindTexture(gl.TEXTURE_2D, this._texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
    }

    /** Read an image File (picked or dropped), downscale it and store it as a data URL. */
    async loadImageFile(file) {
        if (!file || !/^image\//.test(file.type)) throw new Error('Not an image file');
        const url = URL.createObjectURL(file);
        try {
            const img = await new Promise((resolve, reject) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.onerror = () => reject(new Error('Could not decode the image'));
                i.src = url;
            });
            const scale = Math.min(1, MAX_IMAGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
            const w = Math.max(1, Math.round(img.naturalWidth * scale));
            const h = Math.max(1, Math.round(img.naturalHeight * scale));
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            const opaque = /jpe?g/i.test(file.type);
            const dataUrl = opaque ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png');
            this.data.imageName = file.name;
            this.setValue(dataUrl);
            return dataUrl;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    pickImageFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', () => {
            const f = input.files && input.files[0];
            if (f) this.loadImageFile(f).catch(err => console.warn('[Param] image:', err.message));
        });
        input.click();
    }

    // ------------------------------------------------------------------
    // Geometry
    // ------------------------------------------------------------------

    controlHeight() {
        return CONTROL_H[this.kind] || 0;
    }

    updateDimensions() {
        const rows = Math.max(1, this.outputs.length);
        const ch = this.controlHeight();
        this.height = this.heightForRows(rows, ch ? ch + 4 : 0);
    }

    getControlRect() {
        const ch = this.controlHeight();
        if (!ch) return null;
        const rows = Math.max(1, this.outputs.length);
        return { x: this.x + 9, y: this.getRowCenterY(rows - 1) + ROW_H / 2 + 1, w: this.width - 18, h: ch };
    }

    getOutputPortLabel(i) {
        return this.outputs.length > 1 ? this.outputs[i].name : '';
    }

    getHeaderTagRect() {
        const text = KIND_TAG[this.kind] || this.kind;
        const w = Math.max(18, Math.ceil(text.length * 5.5) + 8);
        return { x: this.x + this.width - 7 - w, y: this.y + 7, w, h: 13 };
    }

    drawHeaderTags(ctx, options = {}) {
        const r = this.getHeaderTagRect();
        let text = KIND_TAG[this.kind] || this.kind;
        if (this.kind === 'color' && this.data.alpha) text = 'rgba';
        drawTag(ctx, r, text, false, CANVAS.uniform, { hovered: this.isHoveringRect(options, r, 2) });
        return r.x;
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    drawBody(ctx, options = {}) {
        const kind = this.kind;
        // Value readout on the first row (left), unless the control shows it
        if (kind !== 'color') {
            const maxW = this.width - 22 - (this.outputs.length > 1 ? measure(ctx, FONTS.title, this.outputs[0].name) + 18 : 12);
            ctx.font = FONTS.value;
            ctx.fillStyle = CANVAS.uniform;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(fitText(ctx, FONTS.value, formatParamValue(this.data), maxW), Math.round(this.x + 10), Math.round(this.getRowCenterY(0) + 3));
        }
        const r = this.getControlRect();
        if (!r) return;
        const hovered = this.isHoveringRect(options, r);
        switch (kind) {
            case 'float':
            case 'int': {
                const range = paramRange(this.data);
                drawValueBar(ctx, r.x, r.y, r.w, r.h, valueToUnit(Number(this.data.value) || 0, range), CANVAS.uniform);
                if (hovered || this._dragging) {
                    ctx.strokeStyle = CANVAS.insetHover;
                    ctx.lineWidth = 1;
                    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
                }
                break;
            }
            case 'bool': {
                const on = !!this.data.value;
                drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered ? CANVAS.insetHover : undefined });
                const tx = r.x + 3, ty = r.y + 3, tw = 20, th = r.h - 6;
                ctx.fillStyle = on ? withAlpha(CANVAS.uniform, 0.3) : COLORS.raised;
                ctx.fillRect(tx, ty, tw, th);
                ctx.fillStyle = on ? CANVAS.uniform : COLORS.textFaint;
                ctx.fillRect(on ? tx + tw - th : tx, ty, th, th);
                drawLabel(ctx, on ? 'on' : 'off', tx + tw + 7, r.y + r.h / 2, on ? COLORS.text : COLORS.textDim, 'left', FONTS.value);
                break;
            }
            case 'enum': {
                drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered ? CANVAS.insetHover : undefined });
                const cy = r.y + r.h / 2;
                drawLabel(ctx, '<', r.x + 6, cy, COLORS.textDim, 'left', FONTS.value);
                drawLabel(ctx, '>', r.x + r.w - 6, cy, COLORS.textDim, 'right', FONTS.value);
                const opts = this.data.options || [];
                drawLabel(ctx, `${Math.round(this.data.value) + 1}/${opts.length}`, r.x + r.w / 2, cy, COLORS.textFaint, 'center', FONTS.value);
                break;
            }
            case 'trigger': {
                const lit = this.pulse || (clock.u.time - this.pressTime >= 0 && clock.u.time - this.pressTime < 0.15);
                ctx.beginPath();
                ctx.roundRect(r.x, r.y, r.w, r.h, 3);
                ctx.fillStyle = lit ? CANVAS.uniform : (hovered ? COLORS.hover : COLORS.raised);
                ctx.fill();
                ctx.strokeStyle = lit ? CANVAS.uniform : COLORS.borderStrong;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 2.5);
                ctx.stroke();
                drawIconCentered(ctx, 'bang', r.x + r.w / 2 - 22, r.y + r.h / 2, lit ? COLORS.canvas : COLORS.textDim);
                drawLabel(ctx, 'trigger', r.x + r.w / 2 + 4, r.y + r.h / 2, lit ? COLORS.canvas : COLORS.text, 'center');
                break;
            }
            case 'color': {
                const v = Array.isArray(this.data.value) ? this.data.value : [0, 0, 0];
                drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered ? CANVAS.insetHover : undefined });
                if (this.data.alpha) {
                    // checkerboard under translucent colors
                    ctx.fillStyle = '#2a2e3a';
                    for (let i = 0; i < Math.ceil((r.w - 4) / 6); i++) {
                        for (let j = 0; j < Math.ceil((r.h - 4) / 6); j++) {
                            if ((i + j) % 2) ctx.fillRect(r.x + 2 + i * 6, r.y + 2 + j * 6, Math.min(6, r.w - 4 - i * 6), Math.min(6, r.h - 4 - j * 6));
                        }
                    }
                }
                const a = this.data.alpha ? Math.max(0, Math.min(1, Number(v[3]) || 0)) : 1;
                ctx.fillStyle = `rgba(${v.slice(0, 3).map(c => Math.round(Math.max(0, Math.min(1, c)) * 255)).join(',')},${a})`;
                ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
                const luma = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
                drawLabel(ctx, formatParamValue(this.data), r.x + 7, r.y + r.h / 2, luma > 0.55 && a > 0.5 ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.85)', 'left', FONTS.value);
                break;
            }
            case 'vec2': {
                drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered || this._dragging ? CANVAS.insetHover : undefined });
                const range = paramRange(this.data);
                const v = Array.isArray(this.data.value) ? this.data.value : [0.5, 0.5];
                const px = r.x + 2 + valueToUnit(v[0], range) * (r.w - 4);
                const py = r.y + r.h - 2 - valueToUnit(v[1], range) * (r.h - 4);
                ctx.strokeStyle = COLORS.border;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(Math.round(px) + 0.5, r.y + 2);
                ctx.lineTo(Math.round(px) + 0.5, r.y + r.h - 2);
                ctx.moveTo(r.x + 2, Math.round(py) + 0.5);
                ctx.lineTo(r.x + r.w - 2, Math.round(py) + 0.5);
                ctx.stroke();
                ctx.fillStyle = CANVAS.uniform;
                ctx.fillRect(Math.round(px) - 3, Math.round(py) - 3, 6, 6);
                break;
            }
            case 'text': {
                drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered ? CANVAS.insetHover : undefined });
                drawLabel(ctx, fitText(ctx, FONTS.value, String(this.data.value ?? '') || 'click to edit', r.w - 10), r.x + 5, r.y + r.h / 2,
                    this.data.value ? COLORS.text : COLORS.textFaint, 'left', FONTS.value);
                break;
            }
            case 'image': {
                drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered ? CANVAS.insetHover : undefined });
                if (this._image && this._imageReady) {
                    const img = this._image;
                    const s = Math.min((r.w - 4) / img.naturalWidth, (r.h - 4) / img.naturalHeight);
                    const w = img.naturalWidth * s, h = img.naturalHeight * s;
                    try { ctx.drawImage(img, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h); } catch (e) { /* tainted */ }
                } else {
                    drawLabel(ctx, this.imageError ? 'load failed' : (this.data.value ? 'loading…' : 'click or drop an image'), r.x + r.w / 2, r.y + r.h / 2,
                        this.imageError ? COLORS.error : COLORS.textFaint, 'center');
                }
                break;
            }
        }
    }

    // ------------------------------------------------------------------
    // Interaction
    // ------------------------------------------------------------------

    getControlCursor(x, y) {
        const r = this.getControlRect();
        if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
            return this.kind === 'vec2' ? 'crosshair' : (this.kind === 'float' || this.kind === 'int') ? 'ew-resize' : 'pointer';
        }
        return super.getControlCursor(x, y);
    }

    _dragWith(event, apply) {
        if (!this.graph || !this.graph.getMousePos) return;
        this._dragging = true;
        const move = (e) => {
            const pos = this.graph.getMousePos(e);
            apply(pos.x, pos.y, e, false);
        };
        const up = (e) => {
            this._dragging = false;
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            const pos = this.graph.getMousePos(e);
            apply(pos.x, pos.y, e, true);
            this.graph.render();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    handleMouseDown(x, y, event) {
        const r = this.getControlRect();
        if (!r || x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return super.handleMouseDown(x, y, event);
        const kind = this.kind;
        const done = { handled: true, needsRender: true };
        if (kind === 'float' || kind === 'int') {
            const range = paramRange(this.data);
            // Double-click resets to the default
            const now = performance.now();
            if (now - (this._lastClick || 0) < 300) {
                this._lastClick = 0;
                this.resetValue();
                return done;
            }
            this._lastClick = now;
            const set = (wx, wy, e, commit) => {
                const t = (wx - r.x - 2) / (r.w - 4);
                this.setValue(snap(unitToValue(t, range), range, kind), { commit });
            };
            set(x, y, event, false);
            this._dragWith(event, set);
            return done;
        }
        if (kind === 'vec2') {
            const range = paramRange(this.data);
            const set = (wx, wy, e, commit) => {
                const tx = (wx - r.x - 2) / (r.w - 4);
                const ty = 1 - (wy - r.y - 2) / (r.h - 4);
                this.setValue([snap(unitToValue(tx, range), range), snap(unitToValue(ty, range), range)], { commit });
            };
            set(x, y, event, false);
            this._dragWith(event, set);
            return done;
        }
        if (kind === 'bool') {
            this.setValue(!this.data.value);
            return done;
        }
        if (kind === 'enum') {
            const n = (this.data.options || []).length;
            const dir = x < r.x + r.w / 2 ? -1 : 1;
            this.setValue(((Math.round(this.data.value) + dir) % n + n) % n);
            return done;
        }
        if (kind === 'trigger') {
            this.press();
            return done;
        }
        if (kind === 'color') {
            const input = sharedColorInput();
            input.value = rgbToHex(this.data.value || [0, 0, 0]);
            input.oninput = () => {
                const hex = input.value;
                const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
                const v = Array.isArray(this.data.value) ? [...this.data.value] : [];
                this.setValue(this.data.alpha ? [...rgb, v[3] ?? 1] : rgb, { commit: false });
            };
            input.onchange = () => {
                if (this.graph && this.graph.onUniformValueChanged) this.graph.onUniformValueChanged(this);
            };
            // Open the native picker near the cursor
            input.style.left = `${event.clientX}px`;
            input.style.top = `${event.clientY}px`;
            input.click();
            return done;
        }
        if (kind === 'image') {
            this.pickImageFile();
            return done;
        }
        if (kind === 'text') {
            this.editText(r);
            return done;
        }
        return super.handleMouseDown(x, y, event);
    }

    /** Text kind: a DOM input over the control (Enter / blur commits, Escape cancels). */
    editText(r) {
        const g = this.graph;
        const canvas = g && g.canvas;
        if (!canvas || typeof document === 'undefined') return;
        const rect = canvas.getBoundingClientRect();
        const z = g.zoom || 1;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = String(this.data.value ?? '');
        input.className = 'pt-param-text-edit';
        Object.assign(input.style, {
            position: 'fixed', zIndex: 1000, left: `${rect.left + g.panX + r.x * z}px`, top: `${rect.top + g.panY + r.y * z}px`,
            width: `${Math.max(80, r.w * z)}px`, height: `${Math.max(18, r.h * z)}px`, font: '12px ui-monospace, Menlo, monospace',
            background: '#0f1116', color: '#eceef4', border: '1px solid #f5c84b', borderRadius: '3px', padding: '0 5px', outline: 'none'
        });
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            if (commit) this.setValue(input.value);
            input.remove();
            if (g.render) g.render();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        document.body.appendChild(input);
        input.focus();
        input.select();
    }

    serialize() {
        // Image data URLs are part of data (saved with the project)
        return super.serialize();
    }

    cleanup() {
        if (this._gl && this._texture) {
            try { this._gl.deleteTexture(this._texture); } catch (e) { /* ignore */ }
        }
        this._texture = null;
    }
}

/** Advance per-frame param state (trigger pulses). Call before rendering each frame. */
export function tickParams(graph) {
    if (!graph) return;
    for (const n of graph.nodes) if (n.isParamNode) { loopTrace.node = n; n.tick(); }
}

export { paramUniformType };
