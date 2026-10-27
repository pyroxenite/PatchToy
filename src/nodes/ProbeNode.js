import { Node } from './Node.js';
import { COLORS, FONTS, CANVAS, TYPE_COLORS, typeColor } from '../ui/theme.js';
import { drawInset, drawLabel, drawTag, drawIcon, withAlpha, measure, fitText } from '../rendering/NodePainter.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';
import { PROBE_SAMPLE_MODES } from '../core/library/debug.js';

/**
 * Debug / probe nodes (definitions: src/core/library/debug.js, GPU side:
 * src/rendering/ProbeRenderer.js). Output-style sinks: one input, no outputs,
 * never compiled into other shaders.
 *
 * The ProbeRenderer calls setProbeStatus() after each compile, then
 * onProbeSample(rgba, meta) (point probes) or onProbeGrid(grid, meta) (grid
 * probes) whenever a readback arrives. A node only asks the canvas to redraw
 * (needsContinuousRender) when a new value arrived while it is visible.
 */

const MONO = '11px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';
const MONO_SM = '10px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';
const MONO_LG = '13px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';
const LINE_H = 17;
const COMP_COLORS = ['#ff7a7a', '#4ade80', '#60a5fa', '#c4c9d6'];
const SINGLE_COLOR = TYPE_COLORS.float;
const COMP_NAMES = ['x', 'y', 'z', 'w'];
const RGBA_NAMES = ['r', 'g', 'b', 'a'];
const SECONDS_STEPS = [1, 2, 5, 10, 30, 60];
const HISTORY_CAP = 8192;

const SAMPLE_ALIASES = {
    origin: 'origin', uv00: 'origin', '0,0': 'origin', corner: 'origin', zero: 'origin', bottomleft: 'origin',
    center: 'center', centre: 'center', middle: 'center',
    mouse: 'mouse', cursor: 'mouse',
    custom: 'custom', uv: 'custom'
};

export function normalizeSampleMode(v) {
    const k = String(v === undefined || v === null ? '' : v).toLowerCase().replace(/[\s_()-]/g, '');
    return SAMPLE_ALIASES[k] || 'origin';
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d));
const clampInt = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(num(v, d))));

/** Number -> display text. NaN / Inf are spelled out (the nodes paint them red). */
export function formatProbeNumber(v, precision = 3) {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return '+Inf';
    if (v === -Infinity) return '-Inf';
    const a = Math.abs(v);
    if (a >= 1e6 || (a > 0 && a < Math.pow(10, -precision) && precision > 0 && a < 1e-4)) return v.toExponential(Math.min(Math.max(precision, 1), 3));
    let s = v.toFixed(precision);
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
    return s;
}

const badNumber = (v) => !Number.isFinite(v);

/** Components shown for a source type. */
export function probeComponents(type) {
    if (type === 'vec2' || type === 'ivec2' || type === 'bvec2') return 2;
    if (type === 'vec3' || type === 'ivec3' || type === 'bvec3') return 3;
    if (type === 'vec4' || type === 'ivec4' || type === 'bvec4' || type === 'sampler2D') return 4;
    return 1;
}

function compColor(i, n) {
    return n === 1 ? SINGLE_COLOR : COMP_COLORS[i];
}

function niceRange(lo, hi) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
    if (hi - lo < 1e-6) {
        const c = (lo + hi) / 2;
        const pad = Math.max(Math.abs(c) * 0.1, 0.5);
        return [c - pad, c + pad];
    }
    const pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
}

/** Ring buffer of samples {t, v[4], beat} (Plot / XY Scope history). */
class SampleHistory {
    constructor(cap = HISTORY_CAP) {
        this.cap = cap;
        this.t = new Float64Array(cap);
        this.b = new Float64Array(cap);
        this.v = new Float32Array(cap * 4);
        this.start = 0;
        this.count = 0;
    }
    clear() { this.start = 0; this.count = 0; }
    get lastT() { return this.count ? this.t[(this.start + this.count - 1) % this.cap] : -Infinity; }
    push(t, v, beat) {
        if (this.count && t <= this.lastT) {
            if (t < this.lastT - 0.5) this.clear(); // clock restarted
            else return false;                     // paused / duplicate frame
        }
        let i;
        if (this.count < this.cap) {
            i = (this.start + this.count) % this.cap;
            this.count++;
        } else {
            i = this.start;
            this.start = (this.start + 1) % this.cap;
        }
        this.t[i] = t;
        this.b[i] = beat;
        this.v[i * 4] = v[0]; this.v[i * 4 + 1] = v[1]; this.v[i * 4 + 2] = v[2]; this.v[i * 4 + 3] = v[3];
        return true;
    }
    /** Drop samples older than `seconds` before the newest one. */
    trim(seconds) {
        const last = this.lastT;
        while (this.count > 2 && this.t[this.start] < last - seconds - 0.25) {
            this.start = (this.start + 1) % this.cap;
            this.count--;
        }
    }
    /** Index (into the arrays) of the k-th oldest sample. */
    idx(k) { return (this.start + k) % this.cap; }
}

// ======================================================================
// Base class
// ======================================================================

export class ProbeNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isProbeNode = true;
        this.fixedWidth = true;
        this.hasInputFields = true; // custom uv / range / threshold fields (CanvasTextInput)
        this.probe = { status: 'none', error: null, type: null, value: null, meta: null, updatedAt: 0 };
        this.probeReaderUntil = 0;
        this._probeDirty = false;
        this.rebuildTextInputs();
    }

    get view() { return this.definition ? this.definition.probeView : 'value'; }
    get isGridProbe() { return !!(this.definition && this.definition.probeKind === 'grid'); }
    get comps() { return probeComponents(this.probe ? this.probe.type : null); }
    get sampleMode() { return normalizeSampleMode(this.data.sample); }

    getAccentColor() {
        return '#2dd4bf';
    }

    // ------------------------------------------------------------------
    // Data / settings
    // ------------------------------------------------------------------

    /** Normalize data (also called after project load / set_node_data). */
    normalizeData() {
        const d = this.data;
        if (!this.isGridProbe) {
            d.sample = normalizeSampleMode(d.sample);
            d.u = num(d.u, 0.5);
            d.v = num(d.v, 0.5);
        }
        if (d.precision !== undefined) d.precision = clampInt(d.precision, 0, 6, 3);
    }

    /** Inline field rows: [[{ key, label }]] (custom uv, fixed range, threshold...). */
    fieldRows() {
        const rows = [];
        if (!this.isGridProbe && this.sampleMode === 'custom') rows.push([{ key: 'u', label: 'u' }, { key: 'v', label: 'v' }]);
        return rows;
    }

    rebuildTextInputs() {
        if (!this.probe) return; // during Node construction
        this.normalizeData();
        const old = this.textInputs || {};
        this.textInputs = {};
        this._fieldLayout = this.fieldRows();
        for (const row of this._fieldLayout) {
            for (const f of row) {
                const prev = old[f.key];
                const input = prev && !prev.focused ? prev : (prev || new CanvasTextInput(0, 0, 46, 16, '0'));
                if (!input.focused) input.setValue(formatProbeNumber(num(this.data[f.key], 0), 3).replace(/\.?0+$/, '') || '0');
                input.onChange = (value) => {
                    const n = parseFloat(value);
                    if (!Number.isFinite(n)) return;
                    this.data[f.key] = n;
                    this.onFieldChanged(f.key);
                    this._settingsChanged({ fields: false });
                };
                this.textInputs[f.key] = input;
            }
        }
        this.updateDimensions();
    }

    onFieldChanged() {}

    /** A setting changed: save (no recompile needed, the sample point is a uniform). */
    _settingsChanged({ fields = true, history = false } = {}) {
        if (fields) this.rebuildTextInputs();
        if (history && this.history) this.history.clear();
        this._probeDirty = true;
        const g = this.graph;
        if (g) {
            if (g.onUniformValueChanged) g.onUniformValueChanged(this);
            g.render();
        }
    }

    setData(patch) {
        Object.assign(this.data, patch);
        this._settingsChanged({ history: 'seconds' in patch || 'sample' in patch });
    }

    // ------------------------------------------------------------------
    // Probe results (from ProbeRenderer)
    // ------------------------------------------------------------------

    setProbeStatus(status, error = null, type = null) {
        const p = this.probe;
        const typeChanged = !!type && type !== p.type;
        if (status !== 'ok') {
            p.value = null;
            p.meta = null;
        }
        if (typeChanged) {
            p.type = type;
            if (this.history) this.history.clear();
        }
        if (status === 'none') p.type = null;
        p.status = status;
        p.error = error;
        this.updateDimensions();
        this._probeDirty = true;
    }

    onProbeSample(rgba, meta) {
        const p = this.probe;
        p.value = rgba;
        p.meta = meta;
        p.updatedAt = performance.now();
        this.onSample(rgba, meta);
        if (meta.visible !== false) this._probeDirty = true;
    }

    onSample() {}
    onProbeGrid() {}

    getSampleUV() {
        const d = this.data;
        switch (this.sampleMode) {
            case 'center': return [0.5, 0.5];
            case 'mouse': return [Math.min(1, Math.max(0, ShaderPreview.mouseX || 0)), Math.min(1, Math.max(0, ShaderPreview.mouseY || 0))];
            case 'custom': return [num(d.u, 0.5), num(d.v, 0.5)];
            default: return [0, 0];
        }
    }

    sampleLabel() {
        const d = this.data;
        switch (this.sampleMode) {
            case 'center': return 'center';
            case 'mouse': return 'mouse';
            case 'custom': {
                const f = (v) => formatProbeNumber(num(v, 0), 2).replace(/^(-?)0\./, '$1.').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
                return `uv ${f(d.u)},${f(d.v)}`;
            }
            default: return 'uv 0,0';
        }
    }

    /** Redraw only when a fresh value arrived for a visible probe. */
    needsContinuousRender() {
        if (!this._probeDirty) return false;
        this._probeDirty = false;
        return true;
    }

    /** Values as numbers per component (null when there is no value). */
    currentValues() {
        const v = this.probe.value;
        if (!v || this.probe.status !== 'ok') return null;
        return Array.prototype.slice.call(v, 0, this.comps);
    }

    // ------------------------------------------------------------------
    // Geometry
    // ------------------------------------------------------------------

    /** Body rows above the custom content: row 0 = input, then the field rows. */
    get topRows() {
        return 1 + (this._fieldLayout ? this._fieldLayout.length : 0);
    }

    get contentTop() {
        return this.getRowCenterY(this.topRows - 1) + 11 + 2;
    }

    getInputPortLabel() {
        return '';
    }

    updateTextInputPositions() {
        if (!this._fieldLayout) return;
        this._fieldLayout.forEach((row, r) => {
            const cy = this.getRowCenterY(r + 1);
            let x = this.x + 12;
            for (const f of row) {
                const input = this.textInputs[f.key];
                if (!input) continue;
                f.labelX = x;
                f.cy = cy;
                x += Math.ceil(measureLabel(f.label)) + 5;
                input.x = x;
                input.y = cy - 8;
                input.width = f.width || 46;
                input.height = 16;
                x += input.width + 10;
            }
        });
    }

    /** Header tags (right to left): [{ key, text, active, onClick, tip }] */
    headerTags() {
        const tags = [];
        if (this.probe.status === 'ok' && this.probe.meta && this.probe.meta.float === false) {
            tags.push({ key: '8bit', text: '8-bit', active: true, color: COLORS.warning });
        }
        return tags;
    }

    _tagRects() {
        const tags = this.headerTags();
        let right = this.x + this.width - 7;
        const out = [];
        for (const t of tags) {
            const w = Math.ceil(measureTitle(t.text)) + 10;
            const r = { x: right - w, y: this.y + 7, w, h: 13 };
            out.push({ tag: t, rect: r });
            right = r.x - 4;
        }
        return out;
    }

    drawHeaderTags(ctx, options = {}) {
        let left = this.x + this.width - 4;
        for (const { tag, rect } of this._tagRects()) {
            drawTag(ctx, rect, tag.text, !!tag.active, tag.color || '#2dd4bf', { hovered: tag.onClick && this.isHoveringRect(options, rect, 2) });
            left = rect.x;
        }
        return left;
    }

    getSampleTagRect() {
        if (this.isGridProbe) return null;
        const text = this.sampleLabel();
        const w = Math.ceil(measureTitle(text)) + 12;
        return { x: this.x + this.width - 8 - w, y: this.getRowCenterY(0) - 7, w, h: 14 };
    }

    // ------------------------------------------------------------------
    // Drawing
    // ------------------------------------------------------------------

    draw(ctx, options = {}) {
        this._probeDirty = false;
        super.draw(ctx, options);
    }

    drawBody(ctx, options = {}) {
        const cy = this.getRowCenterY(0);
        const p = this.probe;
        const connected = this.isPortConnected('in', 0);
        // Row 0: detected type (or status) + sample point tag
        const sampleRect = this.getSampleTagRect();
        const right = sampleRect ? sampleRect.x - 6 : this.x + this.width - 10;
        let text, color;
        if (!connected || p.status === 'none') { text = 'no input'; color = COLORS.textFaint; }
        else if (p.status === 'error') { text = 'error'; color = COLORS.error; }
        else { text = p.type || '…'; color = typeColor(p.type); }
        drawLabel(ctx, fitText(ctx, FONTS.title, text, right - this.x - 12), this.x + 12, cy, color);
        if (sampleRect) {
            drawTag(ctx, sampleRect, this.sampleLabel(), false, '#2dd4bf', { hovered: this.isHoveringRect(options, sampleRect, 2) });
        } else {
            this.drawRow0Right(ctx, cy);
        }

        // Field rows
        if (this._fieldLayout && this._fieldLayout.length) {
            this.updateTextInputPositions();
            for (const row of this._fieldLayout) {
                for (const f of row) {
                    drawLabel(ctx, f.label, f.labelX, f.cy, COLORS.textDim);
                    const input = this.textInputs[f.key];
                    if (input) input.draw(ctx, options);
                }
            }
        }

        const top = this.contentTop;
        const box = { x: this.x + 8, y: top, w: this.width - 16, h: this.y + this.height - 7 - top };
        if (!connected || p.status === 'none') {
            this.drawEmpty(ctx, box, 'no input');
        } else if (p.status === 'error') {
            this.drawEmpty(ctx, box, p.error || 'error', COLORS.error);
        } else {
            this.drawContent(ctx, box, options);
        }

        if (this.resizable && (options.isHovered || options.isSelected)) {
            drawIcon(ctx, 'grip', this.x + this.width - 9, this.y + this.height - 8, COLORS.textFaint);
        }
    }

    drawRow0Right() {}

    drawEmpty(ctx, box, message, color = COLORS.textFaint) {
        if (box.h < 10) return;
        drawInset(ctx, box.x, box.y, box.w, box.h);
        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x + 2, box.y + 1, box.w - 4, box.h - 2);
        ctx.clip();
        drawLabel(ctx, fitText(ctx, FONTS.title, message, box.w - 12), box.x + box.w / 2, box.y + box.h / 2, color, 'center');
        ctx.restore();
    }

    drawContent() {}

    // ------------------------------------------------------------------
    // Interaction
    // ------------------------------------------------------------------

    _hit(r, x, y, pad = 2) {
        return r && x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
    }

    cycleSampleMode() {
        const i = PROBE_SAMPLE_MODES.indexOf(this.sampleMode);
        this.setData({ sample: PROBE_SAMPLE_MODES[(i + 1) % PROBE_SAMPLE_MODES.length] });
    }

    getControlCursor(x, y) {
        for (const { tag, rect } of this._tagRects()) if (tag.onClick && this._hit(rect, x, y)) return 'pointer';
        if (this._hit(this.getSampleTagRect(), x, y)) return 'pointer';
        return super.getControlCursor(x, y);
    }

    handleMouseDown(x, y, event) {
        for (const { tag, rect } of this._tagRects()) {
            if (tag.onClick && this._hit(rect, x, y)) {
                tag.onClick();
                return { handled: true, needsRender: true };
            }
        }
        if (this._hit(this.getSampleTagRect(), x, y)) {
            this.cycleSampleMode();
            return { handled: true, needsRender: true };
        }
        return super.handleMouseDown(x, y, event);
    }

    /** Extra context-menu entries (GroupUI.showContextMenu). */
    getContextMenuItems() {
        const items = [];
        if (!this.isGridProbe) {
            const labels = { origin: 'Sample at uv (0, 0)', center: 'Sample at the center', mouse: 'Sample at the mouse', custom: 'Sample at a custom uv' };
            items.push({ header: 'Sample point' });
            for (const m of PROBE_SAMPLE_MODES) {
                items.push({ label: labels[m], hint: this.sampleMode === m ? '✓' : '', onClick: () => this.setData({ sample: m }) });
            }
        }
        return items;
    }

    // ------------------------------------------------------------------
    // Resizing (Plot / XY Scope / Histogram)
    // ------------------------------------------------------------------

    get resizable() { return false; }
    get minWidth() { return 160; }
    get minHeight() { return this.heightForRows(this.topRows, 48); }

    syncSize() {
        if (!this.resizable) return;
        this.width = Math.max(this.minWidth, num(this.data.width, 260));
        this.height = Math.max(this.minHeight, num(this.data.height, 160));
    }

    getResizeEdge(x, y) {
        if (!this.resizable) return null;
        const t = 8;
        const right = this.x + this.width;
        const bottom = this.y + this.height;
        const nearRight = Math.abs(x - right) < t && y >= this.y + 24 && y <= bottom + t;
        const nearBottom = Math.abs(y - bottom) < t && x >= this.x + 12 && x <= right + t;
        if (nearRight && nearBottom) return 'se';
        if (nearRight) return 'e';
        if (nearBottom) return 's';
        return null;
    }

    getCursorForEdge(edge) {
        if (edge === 'se') return 'nwse-resize';
        if (edge === 'e') return 'ew-resize';
        if (edge === 's') return 'ns-resize';
        return 'default';
    }

    resizeFree(edge, pos) {
        if (edge.includes('e')) this.data.width = Math.round(Math.max(this.minWidth, pos.x - this.x));
        if (edge.includes('s')) this.data.height = Math.round(Math.max(this.minHeight, pos.y - this.y));
        this.syncSize();
    }

    // ------------------------------------------------------------------
    // MCP
    // ------------------------------------------------------------------

    /** Plain JSON description of the probe's current reading (read_probes / get_project). */
    describeProbe() {
        const p = this.probe;
        const d = { id: this.id, type: this.type, status: p.status === 'ok' && !p.meta ? 'pending' : p.status };
        if (p.error) d.error = p.error;
        if (p.type) d.value_type = p.type;
        if (!this.isGridProbe) d.sample = { mode: this.sampleMode, uv: this.getSampleUV().map(v => +v.toFixed(4)) };
        if (p.meta) {
            d.format = p.meta.float ? 'rgba32f' : 'rgba8 (clamped 0..1, no NaN/Inf detection)';
            d.resolution = p.meta.res;
            d.clock_time = +Number(p.meta.time).toFixed(4);
            d.age_ms = Math.round(performance.now() - p.updatedAt);
        }
        const vals = this.currentValues();
        if (vals && !this.isGridProbe) {
            const t = p.type;
            if (t === 'bool') d.value = vals[0] > 0.5;
            else if (t === 'int') d.value = Math.round(vals[0]);
            else d.value = vals.length === 1 ? jsonNumber(vals[0]) : vals.map(jsonNumber);
            d.text = vals.map(v => formatProbeNumber(v, t === 'int' ? 0 : 6));
            d.nan = vals.some(v => Number.isNaN(v));
            d.inf = vals.some(v => v === Infinity || v === -Infinity);
        }
        return d;
    }
}

function jsonNumber(v) {
    return Number.isFinite(v) ? +v.toPrecision(7) : null;
}

let measureCtx = null;
function mctx() {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    return measureCtx;
}
function measureTitle(text) { return measure(mctx(), FONTS.title, text); }
function measureLabel(text) { return measure(mctx(), FONTS.title, text); }

/** Draw one "name  value" line; NaN / Inf lines get a red strip. Returns nothing. */
function drawValueLine(ctx, x, y, w, name, nameColor, text, bad, font = MONO) {
    if (bad) {
        ctx.fillStyle = COLORS.errorSoft;
        ctx.fillRect(x + 2, y - LINE_H / 2 + 1, w - 4, LINE_H - 2);
    }
    drawLabel(ctx, name, x + 8, y, nameColor);
    ctx.font = font;
    ctx.fillStyle = bad ? COLORS.error : COLORS.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, Math.round(x + w - 8), Math.round(y + 1));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
}

// ======================================================================
// Value Display
// ======================================================================

export class ValueDisplayNode extends ProbeNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.width = 184;
    }

    headerTags() {
        const tags = super.headerTags();
        const prec = clampInt(this.data.precision, 0, 6, 3);
        tags.unshift({ key: 'precision', text: `.${prec}`, onClick: () => this.setData({ precision: (prec + 1) % 7 }) });
        return tags;
    }

    updateDimensions() {
        const lines = this.probe && this.probe.status === 'ok' ? this.comps : 1;
        this.height = this.heightForRows(this.topRows || 1, 2 + lines * LINE_H + 6);
    }

    drawContent(ctx, box) {
        drawInset(ctx, box.x, box.y, box.w, box.h);
        const vals = this.currentValues();
        const n = this.comps;
        const t = this.probe.type;
        const prec = t === 'int' ? 0 : clampInt(this.data.precision, 0, 6, 3);
        for (let i = 0; i < n; i++) {
            const cy = box.y + 4 + LINE_H * i + LINE_H / 2;
            const name = n === 1 ? 'value' : COMP_NAMES[i];
            let text = '…';
            let bad = false;
            if (vals) {
                const v = vals[i];
                bad = badNumber(v);
                text = t === 'bool' && !bad ? (v > 0.5 ? 'true' : 'false') : formatProbeNumber(v, prec);
            }
            drawValueLine(ctx, box.x, cy, box.w, name, compColor(i, n), text, bad, n === 1 ? MONO_LG : MONO);
        }
    }

    getContextMenuItems() {
        const items = super.getContextMenuItems();
        items.push({ header: 'Precision' });
        for (const p of [0, 2, 3, 4, 6]) items.push({ label: `${p} decimals`, hint: this.data.precision === p ? '✓' : '', onClick: () => this.setData({ precision: p }) });
        return items;
    }
}

// ======================================================================
// Color Display
// ======================================================================

const SWATCH_H = 54;

export class ColorDisplayNode extends ProbeNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.width = 184;
    }

    updateDimensions() {
        const alpha = this.probe && this.comps === 4;
        this.height = this.heightForRows(this.topRows || 1, SWATCH_H + 6 + (alpha ? 2 : 1) * 15 + 6);
    }

    rgba() {
        const vals = this.currentValues();
        if (!vals) return null;
        const n = vals.length;
        if (n === 1) return [vals[0], vals[0], vals[0], 1];
        if (n === 2) return [vals[0], vals[1], 0, 1];
        if (n === 3) return [vals[0], vals[1], vals[2], 1];
        return vals;
    }

    hex(c) {
        const h = (v) => Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 255).toString(16).padStart(2, '0');
        return `#${h(c[0])}${h(c[1])}${h(c[2])}`.toUpperCase();
    }

    clipState(c) {
        let hi = false, lo = false, bad = false;
        for (let i = 0; i < 3; i++) {
            if (badNumber(c[i])) bad = true;
            else if (c[i] > 1) hi = true;
            else if (c[i] < 0) lo = true;
        }
        return { hi, lo, bad, any: hi || lo || bad };
    }

    drawContent(ctx, box) {
        const c = this.rgba();
        const sw = { x: box.x, y: box.y, w: box.w, h: SWATCH_H };
        drawInset(ctx, sw.x, sw.y, sw.w, sw.h);
        if (!c) return;
        const alpha = this.comps === 4;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(sw.x + 2, sw.y + 2, sw.w - 4, sw.h - 4, 2);
        ctx.clip();
        if (alpha) {
            // Checkerboard behind translucent colours
            const s = 6;
            for (let yy = 0; yy < sw.h; yy += s) {
                for (let xx = 0; xx < sw.w; xx += s) {
                    ctx.fillStyle = ((xx / s + yy / s) % 2) ? '#3a4050' : '#252935';
                    ctx.fillRect(sw.x + xx, sw.y + yy, s, s);
                }
            }
        }
        const cl = (v) => Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 255);
        const a = alpha ? Math.min(1, Math.max(0, Number.isFinite(c[3]) ? c[3] : 1)) : 1;
        ctx.fillStyle = `rgba(${cl(c[0])}, ${cl(c[1])}, ${cl(c[2])}, ${a})`;
        ctx.fillRect(sw.x, sw.y, sw.w, sw.h);
        ctx.restore();

        // Hex label on the swatch, contrasting
        const luma = 0.2126 * cl(c[0]) + 0.7152 * cl(c[1]) + 0.0722 * cl(c[2]);
        const ink = luma * a + 30 * (1 - a) > 140 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.92)';
        ctx.font = MONO_LG;
        ctx.fillStyle = ink;
        ctx.textBaseline = 'middle';
        ctx.fillText(this.hex(c), Math.round(sw.x + 9), Math.round(sw.y + sw.h - 13));
        ctx.textBaseline = 'alphabetic';

        const clip = this.clipState(c);
        if (clip.any) {
            const label = clip.bad ? 'NaN' : clip.hi && clip.lo ? 'CLIP' : clip.hi ? 'HDR >1' : 'CLIP <0';
            const w = Math.ceil(measureTitle(label)) + 10;
            drawTag(ctx, { x: sw.x + sw.w - w - 5, y: sw.y + 5, w, h: 13 }, label, true, clip.bad ? COLORS.error : COLORS.warning);
        }

        // Channel values
        const prec = clampInt(this.data.precision, 0, 6, 3);
        let ly = sw.y + sw.h + 6 + 7;
        const colW = (box.w - 4) / 3;
        const drawChan = (i, x) => {
            const v = c[i];
            const out = badNumber(v) || v > 1 || v < 0;
            drawLabel(ctx, RGBA_NAMES[i], x + 2, ly, COMP_COLORS[i]);
            ctx.font = MONO_SM;
            ctx.fillStyle = badNumber(v) ? COLORS.error : out ? COLORS.warning : COLORS.text;
            ctx.textBaseline = 'middle';
            ctx.fillText(formatProbeNumber(v, prec), Math.round(x + 11), Math.round(ly + 1));
            ctx.textBaseline = 'alphabetic';
        };
        for (let i = 0; i < 3; i++) drawChan(i, box.x + 2 + colW * i);
        if (alpha) {
            ly += 15;
            drawChan(3, box.x + 2);
        }
    }

    describeProbe() {
        const d = super.describeProbe();
        const c = this.rgba();
        if (c) {
            d.hex = this.hex(c);
            const cs = this.clipState(c);
            d.clipped = cs.any;
            if (cs.hi) d.hdr = true;
        }
        return d;
    }
}

// ======================================================================
// Plot (time series)
// ======================================================================

export class PlotNode extends ProbeNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.history = new SampleHistory();
    }

    get resizable() { return true; }
    get minWidth() { return 180; }

    normalizeData() {
        super.normalizeData();
        const d = this.data;
        d.seconds = Math.max(0.5, Math.min(60, num(d.seconds, 5)));
        d.range = d.range === 'fixed' ? 'fixed' : 'auto';
        d.min = num(d.min, -1);
        d.max = num(d.max, 1);
        if (this.type === 'Plot') d.beats = !!d.beats;
        if (this.type === 'XYScope') d.aspectLock = d.aspectLock !== false;
    }

    fieldRows() {
        const rows = super.fieldRows();
        if (this.data.range === 'fixed') rows.push([{ key: 'min', label: 'min' }, { key: 'max', label: 'max' }]);
        return rows;
    }

    updateDimensions() {
        this.syncSize();
    }

    nextSeconds() {
        const s = this.data.seconds;
        const i = SECONDS_STEPS.findIndex(x => x > s + 1e-6);
        return SECONDS_STEPS[i === -1 ? 0 : i];
    }

    headerTags() {
        const tags = super.headerTags();
        const d = this.data;
        const own = [
            { key: 'seconds', text: `${+d.seconds.toFixed(1)}s`, onClick: () => this.setData({ seconds: this.nextSeconds() }) },
            { key: 'range', text: d.range === 'fixed' ? 'fix' : 'auto', active: d.range === 'fixed', onClick: () => this.setData({ range: d.range === 'fixed' ? 'auto' : 'fixed' }) }
        ];
        if (this.type === 'Plot') own.push({ key: 'beats', text: 'beat', active: !!d.beats, onClick: () => this.setData({ beats: !d.beats }) });
        return [...own.reverse(), ...tags];
    }

    onSample(rgba, meta) {
        this.history.push(meta.time, rgba, meta.beatCount);
        this.history.trim(this.data.seconds);
    }

    /** Visible window: [k0, count) sample offsets and the newest time. */
    window() {
        const h = this.history;
        const last = h.lastT;
        const from = last - this.data.seconds;
        let k0 = 0;
        while (k0 < h.count - 1 && h.t[h.idx(k0)] < from) k0++;
        return { k0, last, from };
    }

    range(win, comps) {
        if (this.data.range === 'fixed') {
            const lo = Math.min(this.data.min, this.data.max), hi = Math.max(this.data.min, this.data.max);
            return hi - lo > 1e-9 ? [lo, hi] : [lo - 0.5, hi + 0.5];
        }
        const h = this.history;
        let lo = Infinity, hi = -Infinity;
        for (let k = Math.max(0, win.k0 - 1); k < h.count; k++) {
            const i = h.idx(k) * 4;
            for (let c = 0; c < comps; c++) {
                const v = h.v[i + c];
                if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
            }
        }
        return niceRange(lo, hi);
    }

    drawContent(ctx, box) {
        drawInset(ctx, box.x, box.y, box.w, box.h);
        const h = this.history;
        const n = this.comps;
        const pad = 3;
        const area = { x: box.x + pad, y: box.y + pad + 2, w: box.w - pad * 2, h: box.h - pad * 2 - 4 };
        if (area.h < 8 || area.w < 20) return;
        if (!h.count) {
            drawLabel(ctx, 'waiting for samples…', box.x + box.w / 2, box.y + box.h / 2, COLORS.textFaint, 'center');
            return;
        }
        const win = this.window();
        const [lo, hi] = this.range(win, n);
        const secs = this.data.seconds;
        const X = (t) => area.x + area.w - (win.last - t) / secs * area.w;
        const Y = (v) => area.y + area.h - (v - lo) / (hi - lo) * area.h;

        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
        ctx.clip();

        // Grid: quarter lines + zero line
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        for (let q = 1; q < 4; q++) ctx.fillRect(area.x, Math.round(area.y + area.h * q / 4), area.w, 1);
        if (lo < 0 && hi > 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.16)';
            ctx.fillRect(area.x, Math.round(Y(0)), area.w, 1);
        }

        // Beat ticks
        if (this.data.beats) {
            for (let k = Math.max(1, win.k0); k < h.count; k++) {
                const b0 = Math.floor(h.b[h.idx(k - 1)]);
                const b1 = Math.floor(h.b[h.idx(k)]);
                if (b1 === b0 || !Number.isFinite(b1)) continue;
                const x = Math.round(X(h.t[h.idx(k)]));
                const bar = ((b1 % 4) + 4) % 4 === 0;
                ctx.fillStyle = bar ? withAlpha(COLORS.accent2, 0.55) : withAlpha(COLORS.accent2, 0.22);
                ctx.fillRect(x, bar ? area.y - 2 : area.y + area.h * 0.55, 1, bar ? area.h + 4 : area.h * 0.45 + 2);
            }
        }

        // Lines (break at NaN / Inf)
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        for (let c = n - 1; c >= 0; c--) {
            ctx.beginPath();
            let pen = false;
            let badAt = null;
            for (let k = Math.max(0, win.k0 - 1); k < h.count; k++) {
                const i = h.idx(k);
                const v = h.v[i * 4 + c];
                if (!Number.isFinite(v)) { pen = false; badAt = badAt || X(h.t[i]); continue; }
                const px = X(h.t[i]);
                const py = Y(v);
                if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
                pen = true;
            }
            ctx.strokeStyle = compColor(c, n);
            ctx.stroke();
            if (badAt !== null) {
                ctx.fillStyle = COLORS.error;
                ctx.fillRect(Math.round(badAt) - 1, area.y, 2, 4);
            }
        }

        // Range labels
        const prec = clampInt(this.data.precision, 0, 6, 3);
        const rl = (v) => formatProbeNumber(v, Math.min(prec, Math.abs(hi - lo) >= 10 ? 1 : prec));
        drawLabel(ctx, rl(hi), area.x + 2, area.y + 4, COLORS.textFaint);
        drawLabel(ctx, rl(lo), area.x + 2, area.y + area.h - 3, COLORS.textFaint);

        // Current values (top right, per component)
        const last = h.idx(h.count - 1);
        let ty = area.y + 7;
        for (let c = 0; c < n; c++) {
            const v = h.v[last * 4 + c];
            const text = (n > 1 ? COMP_NAMES[c] + ' ' : '') + formatProbeNumber(v, prec);
            ctx.font = MONO_SM;
            const tw = ctx.measureText(text).width;
            ctx.fillStyle = 'rgba(15,17,22,0.78)';
            ctx.fillRect(Math.round(area.x + area.w - tw - 6), Math.round(ty - 6), Math.ceil(tw + 5), 12);
            ctx.fillStyle = badNumber(v) ? COLORS.error : compColor(c, n);
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, Math.round(area.x + area.w - 3), Math.round(ty));
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ty += 12;
        }
        ctx.restore();
    }

    getContextMenuItems() {
        const items = super.getContextMenuItems();
        items.push({ header: 'History' });
        for (const s of SECONDS_STEPS) items.push({ label: `${s} s`, hint: this.data.seconds === s ? '✓' : '', onClick: () => this.setData({ seconds: s }) });
        items.push({ label: this.data.range === 'fixed' ? 'Auto range' : 'Fixed range (min / max)', onClick: () => this.setData({ range: this.data.range === 'fixed' ? 'auto' : 'fixed' }) });
        if (this.type === 'Plot') items.push({ label: 'Beat ticks', hint: this.data.beats ? '✓' : '', onClick: () => this.setData({ beats: !this.data.beats }) });
        if (this.type === 'XYScope') items.push({ label: 'Lock aspect (1:1)', hint: this.data.aspectLock ? '✓' : '', onClick: () => this.setData({ aspectLock: !this.data.aspectLock }) });
        items.push({ label: 'Clear history', onClick: () => { this.history.clear(); this.graph && this.graph.render(); } });
        return items;
    }

    describeProbe({ history = true, maxPoints = 120 } = {}) {
        const d = super.describeProbe();
        const h = this.history;
        const n = this.comps;
        if (h.count) {
            const win = this.window();
            const [lo, hi] = this.range(win, n);
            d.range = { mode: this.data.range, min: jsonNumber(lo), max: jsonNumber(hi) };
            d.seconds = this.data.seconds;
            const count = h.count - win.k0;
            d.samples = count;
            // Per-component min / max / mean over the window (finite samples)
            const agg = [];
            for (let c = 0; c < n; c++) {
                let mn = Infinity, mx = -Infinity, sum = 0, m = 0, bad = 0;
                for (let k = win.k0; k < h.count; k++) {
                    const v = h.v[h.idx(k) * 4 + c];
                    if (!Number.isFinite(v)) { bad++; continue; }
                    if (v < mn) mn = v; if (v > mx) mx = v; sum += v; m++;
                }
                agg.push({ min: m ? jsonNumber(mn) : null, max: m ? jsonNumber(mx) : null, mean: m ? jsonNumber(sum / m) : null, non_finite: bad });
            }
            d.window = n === 1 ? agg[0] : agg;
            if (history) {
                const step = Math.max(1, Math.ceil(count / maxPoints));
                const t = [];
                const v = [];
                for (let k = win.k0; k < h.count; k += step) {
                    const i = h.idx(k);
                    t.push(+(h.t[i] - win.last).toFixed(3));
                    const row = [];
                    for (let c = 0; c < n; c++) row.push(jsonNumber(h.v[i * 4 + c]));
                    v.push(n === 1 ? row[0] : row);
                }
                d.history = { t_rel: t, values: v, step };
                if (this.type === 'Plot' && this.data.beats) {
                    const beats = [];
                    for (let k = Math.max(1, win.k0); k < h.count; k++) {
                        if (Math.floor(h.b[h.idx(k)]) !== Math.floor(h.b[h.idx(k - 1)])) beats.push(+(h.t[h.idx(k)] - win.last).toFixed(3));
                    }
                    d.history.beat_ticks = beats;
                }
            }
        }
        return d;
    }
}

// ======================================================================
// XY Scope
// ======================================================================

export class XYScopeNode extends PlotNode {
    get minWidth() { return 160; }

    headerTags() {
        const tags = super.headerTags();
        const lock = { key: 'aspect', text: '1:1', active: !!this.data.aspectLock, onClick: () => this.setData({ aspectLock: !this.data.aspectLock }) };
        // after the seconds / range tags
        const i = tags.findIndex(t => t.key === 'seconds');
        tags.splice(i < 0 ? 0 : i, 0, lock);
        return tags;
    }

    ranges(win) {
        const h = this.history;
        if (this.data.range === 'fixed') {
            const lo = Math.min(this.data.min, this.data.max), hi = Math.max(this.data.min, this.data.max);
            const r = hi - lo > 1e-9 ? [lo, hi] : [lo - 0.5, hi + 0.5];
            return [r, r];
        }
        const two = this.comps >= 2;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let k = win.k0; k < h.count; k++) {
            const i = h.idx(k) * 4;
            const x = h.v[i], y = two ? h.v[i + 1] : 0;
            if (Number.isFinite(x)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
            if (Number.isFinite(y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        return [niceRange(x0, x1), niceRange(y0, y1)];
    }

    drawContent(ctx, box) {
        drawInset(ctx, box.x, box.y, box.w, box.h);
        const h = this.history;
        const labelH = 15;
        let area = { x: box.x + 6, y: box.y + 6, w: box.w - 12, h: box.h - 12 - labelH };
        if (area.h < 12 || area.w < 12) return;
        if (!h.count) {
            drawLabel(ctx, 'waiting for samples…', box.x + box.w / 2, box.y + box.h / 2, COLORS.textFaint, 'center');
            return;
        }
        const win = this.window();
        let [[x0, x1], [y0, y1]] = this.ranges(win);
        if (this.data.aspectLock) {
            // Same units per pixel on both axes, centred
            const sx = (x1 - x0) / area.w, sy = (y1 - y0) / area.h;
            const s = Math.max(sx, sy);
            const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
            x0 = cx - s * area.w / 2; x1 = cx + s * area.w / 2;
            y0 = cy - s * area.h / 2; y1 = cy + s * area.h / 2;
        }
        const X = (v) => area.x + (v - x0) / (x1 - x0) * area.w;
        const Y = (v) => area.y + area.h - (v - y0) / (y1 - y0) * area.h;
        const two = this.comps >= 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
        ctx.clip();
        // Axes through 0
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        if (y0 < 0 && y1 > 0) ctx.fillRect(area.x, Math.round(Y(0)), area.w, 1);
        if (x0 < 0 && x1 > 0) ctx.fillRect(Math.round(X(0)), area.y, 1, area.h);

        // Trail: oldest -> newest in 8 alpha steps
        const color = '#2dd4bf';
        const count = h.count - win.k0;
        const buckets = 8;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = color;
        for (let b = 0; b < buckets; b++) {
            const ka = win.k0 + Math.floor(count * b / buckets);
            const kb = win.k0 + Math.floor(count * (b + 1) / buckets);
            if (kb - ka < 1) continue;
            ctx.globalAlpha = 0.08 + 0.92 * Math.pow((b + 1) / buckets, 1.6);
            ctx.beginPath();
            let pen = false;
            for (let k = Math.max(win.k0, ka - 1); k < kb; k++) {
                const i = h.idx(k) * 4;
                const x = h.v[i], y = two ? h.v[i + 1] : 0;
                if (!Number.isFinite(x) || !Number.isFinite(y)) { pen = false; continue; }
                if (pen) ctx.lineTo(X(x), Y(y)); else ctx.moveTo(X(x), Y(y));
                pen = true;
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // Current point
        const li = h.idx(h.count - 1) * 4;
        const cx = h.v[li], cy = two ? h.v[li + 1] : 0;
        const bad = badNumber(cx) || badNumber(cy);
        if (!bad) {
            ctx.fillStyle = withAlpha(color, 0.25);
            ctx.beginPath(); ctx.arc(X(cx), Y(cy), 6, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#e6fffb';
            ctx.beginPath(); ctx.arc(X(cx), Y(cy), 2.5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();

        // Labels: current x / y and the x range
        const prec = clampInt(this.data.precision, 0, 6, 3);
        const ly = box.y + box.h - 9;
        ctx.font = MONO_SM;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = badNumber(cx) ? COLORS.error : COMP_COLORS[0];
        const xt = `x ${formatProbeNumber(cx, prec)}`;
        ctx.fillText(xt, Math.round(box.x + 7), Math.round(ly));
        ctx.fillStyle = badNumber(cy) ? COLORS.error : COMP_COLORS[1];
        ctx.fillText(`y ${formatProbeNumber(cy, prec)}`, Math.round(box.x + 14 + ctx.measureText(xt).width), Math.round(ly));
        ctx.textBaseline = 'alphabetic';
        const rt = `±${formatProbeNumber(Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1)), 1)}`;
        drawLabel(ctx, rt, box.x + box.w - 7, ly, COLORS.textFaint, 'right');
    }
}

// ======================================================================
// Grid probes: Frame Stats, Histogram
// ======================================================================

/** Per-channel min / max / mean + NaN / Inf counts over a readback grid. */
function gridStats(grid, comps) {
    const { data, stride, x0, y0, w, h, scale } = grid;
    const min = [Infinity, Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity, -Infinity];
    const sum = [0, 0, 0, 0];
    const finite = [0, 0, 0, 0];
    let nan = 0, inf = 0;
    for (let y = 0; y < h; y++) {
        let i = ((y0 + y) * stride + x0) * 4;
        for (let x = 0; x < w; x++, i += 4) {
            let isNan = false, isInf = false;
            for (let c = 0; c < comps; c++) {
                const v = data[i + c] * scale;
                if (v !== v) { isNan = true; continue; }
                if (v === Infinity || v === -Infinity) { isInf = true; continue; }
                if (v < min[c]) min[c] = v;
                if (v > max[c]) max[c] = v;
                sum[c] += v;
                finite[c]++;
            }
            if (isNan) nan++;
            else if (isInf) inf++;
        }
    }
    const out = [];
    for (let c = 0; c < comps; c++) {
        out.push(finite[c] ? { min: min[c], max: max[c], mean: sum[c] / finite[c] } : { min: NaN, max: NaN, mean: NaN });
    }
    return { channels: out, nan, inf, samples: w * h, w, h };
}

export class FrameStatsNode extends ProbeNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.width = 252;
        this.stats = null;
    }

    headerTags() {
        const tags = super.headerTags();
        const prec = clampInt(this.data.precision, 0, 6, 3);
        tags.unshift({ key: 'precision', text: `.${prec}`, onClick: () => this.setData({ precision: (prec + 1) % 7 }) });
        return tags;
    }

    updateDimensions() {
        const n = this.probe && this.probe.status === 'ok' ? this.comps : 1;
        this.height = this.heightForRows(this.topRows || 1, 4 + 14 + n * 15 + 6 + 16 + 4);
    }

    drawRow0Right(ctx, cy) {
        const s = this.stats;
        drawLabel(ctx, s ? `grid ${s.w}×${s.h}` : 'grid 64×…', this.x + this.width - 10, cy, COLORS.textFaint, 'right');
    }

    onProbeGrid(grid, meta) {
        this.probe.value = null;
        this.probe.meta = meta;
        this.probe.updatedAt = performance.now();
        this.stats = gridStats(grid, this.comps);
        if (meta.visible !== false) this._probeDirty = true;
    }

    currentValues() { return null; }

    drawContent(ctx, box) {
        drawInset(ctx, box.x, box.y, box.w, box.h);
        const s = this.stats;
        const n = this.comps;
        const prec = clampInt(this.data.precision, 0, 6, 3);
        const cols = [box.x + 22, box.x + box.w * 0.42, box.x + box.w * 0.68, box.x + box.w - 8];
        let y = box.y + 11;
        ['min', 'max', 'mean'].forEach((h, k) => drawLabel(ctx, h, cols[k + 1], y, COLORS.textFaint, 'right'));
        y += 15;
        for (let c = 0; c < n; c++) {
            drawLabel(ctx, n === 1 ? 'v' : RGBA_NAMES[c], box.x + 9, y, compColor(c, n));
            const ch = s && s.channels[c];
            ['min', 'max', 'mean'].forEach((k, j) => {
                const v = ch ? ch[k] : NaN;
                ctx.font = MONO_SM;
                ctx.fillStyle = !ch ? COLORS.textFaint : badNumber(v) ? COLORS.textFaint : COLORS.text;
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(ch ? (badNumber(v) ? '—' : formatProbeNumber(v, prec)) : '…', Math.round(cols[j + 1]), Math.round(y));
            });
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            y += 15;
        }
        // NaN / Inf counts
        y += 4;
        ctx.fillStyle = CANVAS.insetBorder;
        ctx.fillRect(box.x + 6, Math.round(y - 9), box.w - 12, 1);
        if (s) {
            const bad = s.nan + s.inf > 0;
            if (bad) {
                ctx.fillStyle = COLORS.errorSoft;
                ctx.fillRect(box.x + 2, y - 7, box.w - 4, 14);
            }
            const fl = this.probe.meta && this.probe.meta.float === false;
            const text = fl ? 'NaN/Inf: n/a (8-bit)' : `NaN ${s.nan} · Inf ${s.inf}  of ${s.samples}`;
            drawLabel(ctx, text, box.x + 9, y, bad ? COLORS.error : COLORS.textDim);
        }
    }

    describeProbe() {
        const d = super.describeProbe();
        const s = this.stats;
        if (s) {
            const ch = s.channels.map(c => ({ min: jsonNumber(c.min), max: jsonNumber(c.max), mean: jsonNumber(c.mean) }));
            d.stats = { grid: [s.w, s.h], samples: s.samples, nan_samples: s.nan, inf_samples: s.inf, channels: ch.length === 1 ? ch[0] : ch };
            d.note = `coarse: ${s.w}x${s.h} samples over the frame`;
        }
        return d;
    }

    getContextMenuItems() {
        const items = super.getContextMenuItems();
        items.push({ header: 'Precision' });
        for (const p of [0, 2, 3, 4, 6]) items.push({ label: `${p} decimals`, hint: this.data.precision === p ? '✓' : '', onClick: () => this.setData({ precision: p }) });
        return items;
    }
}

export class HistogramNode extends ProbeNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.hist = null;
    }

    get resizable() { return true; }
    get minWidth() { return 170; }

    normalizeData() {
        super.normalizeData();
        const d = this.data;
        d.channel = d.channel === 'rgb' ? 'rgb' : 'luma';
        d.bins = clampInt(d.bins, 8, 64, 32);
        d.range = d.range === 'auto' ? 'auto' : 'fixed';
        d.min = num(d.min, 0);
        d.max = num(d.max, 1);
    }

    fieldRows() {
        return this.data.range === 'fixed' ? [[{ key: 'min', label: 'min' }, { key: 'max', label: 'max' }]] : [];
    }

    updateDimensions() { this.syncSize(); }

    headerTags() {
        const tags = super.headerTags();
        const d = this.data;
        return [
            { key: 'range', text: d.range === 'fixed' ? 'fix' : 'auto', active: d.range === 'fixed', onClick: () => this.setData({ range: d.range === 'fixed' ? 'auto' : 'fixed' }) },
            { key: 'channel', text: d.channel, onClick: () => this.setData({ channel: d.channel === 'rgb' ? 'luma' : 'rgb' }) },
            ...tags
        ];
    }

    drawRow0Right(ctx, cy) {
        const h = this.hist;
        drawLabel(ctx, h ? `grid ${h.w}×${h.h}` : 'grid 64×…', this.x + this.width - 10, cy, COLORS.textFaint, 'right');
    }

    onProbeGrid(grid, meta) {
        this.probe.meta = meta;
        this.probe.updatedAt = performance.now();
        const n = this.comps;
        const rgb = this.data.channel === 'rgb' && n >= 3;
        const series = rgb ? 3 : 1;
        const { data, stride, x0, y0, w, h, scale } = grid;
        const vals = new Float32Array(w * h * series);
        let lo = Infinity, hi = -Infinity, bad = 0, k = 0;
        for (let y = 0; y < h; y++) {
            let i = ((y0 + y) * stride + x0) * 4;
            for (let x = 0; x < w; x++, i += 4) {
                for (let s = 0; s < series; s++) {
                    let v;
                    if (rgb) v = data[i + s] * scale;
                    else if (n >= 3) v = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * scale;
                    else v = data[i] * scale;
                    vals[k++] = v;
                    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } else bad++;
                }
            }
        }
        let [rmin, rmax] = this.data.range === 'fixed'
            ? [Math.min(this.data.min, this.data.max), Math.max(this.data.min, this.data.max)]
            : (Number.isFinite(lo) ? [lo, hi] : [0, 1]);
        if (rmax - rmin < 1e-9) { rmin -= 0.5; rmax += 0.5; }
        const bins = this.data.bins;
        const counts = Array.from({ length: series }, () => new Uint32Array(bins));
        k = 0;
        for (let j = 0; j < w * h; j++) {
            for (let s = 0; s < series; s++) {
                const v = vals[k++];
                if (!Number.isFinite(v)) continue;
                const b = Math.min(bins - 1, Math.max(0, Math.floor((v - rmin) / (rmax - rmin) * bins)));
                counts[s][b]++;
            }
        }
        this.hist = { counts, min: rmin, max: rmax, w, h, nonFinite: bad, series, dataMin: lo, dataMax: hi };
        if (meta.visible !== false) this._probeDirty = true;
    }

    currentValues() { return null; }

    drawContent(ctx, box) {
        drawInset(ctx, box.x, box.y, box.w, box.h);
        const H = this.hist;
        const area = { x: box.x + 6, y: box.y + 6, w: box.w - 12, h: box.h - 12 - 14 };
        if (!H || area.h < 8) return;
        let peak = 1;
        for (const c of H.counts) for (const v of c) if (v > peak) peak = v;
        const bins = H.counts[0].length;
        const bw = area.w / bins;
        const colors = H.series === 3 ? COMP_COLORS : ['#d6dae4'];
        ctx.save();
        if (H.series === 3) ctx.globalCompositeOperation = 'lighter';
        for (let s = 0; s < H.series; s++) {
            ctx.fillStyle = withAlpha(colors[s], H.series === 3 ? 0.55 : 0.8);
            for (let b = 0; b < bins; b++) {
                const v = H.counts[s][b];
                if (!v) continue;
                const bh = Math.max(1, Math.sqrt(v / peak) * area.h); // sqrt scale: small counts stay visible
                ctx.fillRect(area.x + b * bw + 0.5, area.y + area.h - bh, Math.max(1, bw - 1), bh);
            }
        }
        ctx.restore();
        const ly = box.y + box.h - 9;
        drawLabel(ctx, formatProbeNumber(H.min, 2), area.x, ly, COLORS.textFaint);
        drawLabel(ctx, formatProbeNumber(H.max, 2), area.x + area.w, ly, COLORS.textFaint, 'right');
        if (H.nonFinite) drawLabel(ctx, `${H.nonFinite} NaN/Inf`, area.x + area.w / 2, ly, COLORS.error, 'center');
    }

    describeProbe() {
        const d = super.describeProbe();
        const H = this.hist;
        if (H) {
            d.histogram = {
                channel: H.series === 3 ? 'rgb' : 'luma',
                range: [jsonNumber(H.min), jsonNumber(H.max)],
                data_range: [jsonNumber(H.dataMin), jsonNumber(H.dataMax)],
                grid: [H.w, H.h],
                non_finite: H.nonFinite,
                counts: H.series === 3 ? H.counts.map(c => Array.from(c)) : Array.from(H.counts[0])
            };
        }
        return d;
    }

    getContextMenuItems() {
        const items = super.getContextMenuItems();
        items.push({ header: 'Histogram' });
        items.push({ label: 'Luma', hint: this.data.channel === 'luma' ? '✓' : '', onClick: () => this.setData({ channel: 'luma' }) });
        items.push({ label: 'RGB channels', hint: this.data.channel === 'rgb' ? '✓' : '', onClick: () => this.setData({ channel: 'rgb' }) });
        for (const b of [16, 32, 64]) items.push({ label: `${b} bins`, hint: this.data.bins === b ? '✓' : '', onClick: () => this.setData({ bins: b }) });
        items.push({ label: this.data.range === 'fixed' ? 'Auto range' : 'Fixed range (min / max)', onClick: () => this.setData({ range: this.data.range === 'fixed' ? 'auto' : 'fixed' }) });
        return items;
    }
}

// ======================================================================
// LED
// ======================================================================

export class LEDNode extends ProbeNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.width = 164;
    }

    normalizeData() {
        super.normalizeData();
        this.data.threshold = num(this.data.threshold, 0.5);
    }

    fieldRows() {
        const rows = super.fieldRows();
        if (this.probe && this.probe.type !== 'bool') rows.push([{ key: 'threshold', label: 'lit when >' }]);
        return rows;
    }

    setProbeStatus(status, error, type) {
        const before = this.probe.type;
        super.setProbeStatus(status, error, type);
        if (this.probe.type !== before) this.rebuildTextInputs();
    }

    updateDimensions() {
        this.height = this.heightForRows(this.topRows || 1, 30);
    }

    state() {
        const vals = this.currentValues();
        if (!vals) return null;
        const v = vals[0];
        if (badNumber(v)) return { v, bad: true, on: false };
        const on = this.probe.type === 'bool' ? v > 0.5 : v > this.data.threshold;
        return { v, bad: false, on };
    }

    drawContent(ctx, box) {
        const s = this.state();
        const cx = box.x + 18, cy = box.y + box.h / 2;
        const color = s && s.bad ? COLORS.error : COLORS.success;
        const on = s && (s.on || s.bad);
        if (on) {
            ctx.fillStyle = withAlpha(color, 0.18);
            ctx.fillRect(cx - 11, cy - 11, 22, 22);
            ctx.fillStyle = withAlpha(color, 0.35);
            ctx.fillRect(cx - 8, cy - 8, 16, 16);
        }
        ctx.fillStyle = on ? color : CANVAS.ledOff;
        ctx.fillRect(cx - 6, cy - 6, 12, 12);
        if (on) {
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.fillRect(cx - 4, cy - 4, 3, 3);
        }
        const label = !s ? '…' : s.bad ? formatProbeNumber(s.v, 2) : s.on ? 'ON' : 'off';
        drawLabel(ctx, label, cx + 18, cy, s && s.bad ? COLORS.error : s && s.on ? COLORS.text : COLORS.textDim, 'left', FONTS.titleBold);
        if (s && !s.bad && this.probe.type !== 'bool') {
            ctx.font = MONO_SM;
            ctx.fillStyle = COLORS.textDim;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(formatProbeNumber(s.v, 3), Math.round(box.x + box.w - 6), Math.round(cy + 1));
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
        }
    }

    describeProbe() {
        const d = super.describeProbe();
        const s = this.state();
        if (s) d.on = s.on;
        d.threshold = this.data.threshold;
        return d;
    }
}

/** Node class for a probe definition (NodeFactory). */
export function probeNodeClass(def) {
    switch (def && def.probeView) {
        case 'color': return ColorDisplayNode;
        case 'plot': return PlotNode;
        case 'xy': return XYScopeNode;
        case 'stats': return FrameStatsNode;
        case 'histogram': return HistogramNode;
        case 'led': return LEDNode;
        default: return ValueDisplayNode;
    }
}
