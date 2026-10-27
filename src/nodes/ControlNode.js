import { LibraryNode } from './LibraryNode.js';
import { JSNode } from './JSNode.js';
import { COLORS, FONTS, CANVAS } from '../ui/theme.js';
import { drawLabel, drawInset, fitText, withAlpha, portColor } from '../rendering/NodePainter.js';
import { formatValue } from '../core/control/vmath.js';

const STRIP_H = 24;     // live value + sparkline
const OPTION_W_MIN = 54;

/**
 * Canvas node for control-rate definitions (def.rate === 'control', library group
 * "Control"). Same ports / inline fields as LibraryNode, plus:
 *  - option pills (def.options) that cycle through their values on click
 *    (shift-click goes back);
 *  - a live strip at the bottom: the current value of the main output, a
 *    sparkline of the last ~1.6 s, a flash when an event output fires, or the
 *    runtime error.
 * Text / List Texture nodes own GL textures (same plumbing as JS node textures).
 */
export class ControlNode extends LibraryNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isControlNode = true;
        if (this.width < 168) this.width = 168;
    }

    getOptions() {
        return (this.definition && this.definition.options) || [];
    }

    getHeaderIcon() {
        return null;
    }

    updateDimensions() {
        const rows = this.getPortRowCount() + this.getTextFields().length + this.getOptions().length;
        this.height = this.heightForRows(rows, STRIP_H + 4);
    }

    _optionRow(k) {
        return this.getPortRowCount() + this.getTextFields().length + k;
    }

    getOptionRect(k) {
        const cy = this.getRowCenterY(this._optionRow(k));
        const x0 = this.x + 58;
        return { x: x0, y: cy - 8, w: Math.max(OPTION_W_MIN, this.width - 68), h: 16 };
    }

    getStripRect() {
        const rows = this.getPortRowCount() + this.getTextFields().length + this.getOptions().length;
        const top = this.getRowCenterY(rows - 1) + 11 + 3;
        return { x: this.x + 8, y: top, w: this.width - 16, h: STRIP_H };
    }

    isInErrorState() {
        return !!(this.hasError || this._ctlError);
    }

    needsContinuousRender() {
        return true;
    }

    getControlCursor(x, y) {
        for (let k = 0; k < this.getOptions().length; k++) {
            const r = this.getOptionRect(k);
            if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'pointer';
        }
        return super.getControlCursor(x, y);
    }

    handleMouseDown(x, y, event) {
        const opts = this.getOptions();
        for (let k = 0; k < opts.length; k++) {
            const r = this.getOptionRect(k);
            if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                const o = opts[k];
                const cur = Math.max(0, o.values.indexOf(String(this.data[o.key] ?? o.default)));
                const next = (cur + (event && event.shiftKey ? o.values.length - 1 : 1)) % o.values.length;
                this.data[o.key] = o.values[next];
                // Options are read every frame by the runtime: no recompile needed
                if (this.graph && this.graph.onUniformValueChanged) this.graph.onUniformValueChanged(this);
                return { handled: true, needsRender: true };
            }
        }
        return super.handleMouseDown(x, y, event);
    }

    drawBody(ctx, options = {}) {
        super.drawBody(ctx, options);
        const opts = this.getOptions();
        for (let k = 0; k < opts.length; k++) {
            const o = opts[k];
            const r = this.getOptionRect(k);
            const cy = r.y + r.h / 2;
            drawLabel(ctx, o.label || o.key, this.x + 10, cy, COLORS.textFaint);
            const hovered = this.isHoveringRect(options, r);
            drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered ? CANVAS.insetHover : undefined });
            const v = String(this.data[o.key] ?? o.default);
            ctx.font = FONTS.value;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = hovered ? COLORS.text : COLORS.textDim;
            ctx.fillText(fitText(ctx, FONTS.value, `‹ ${v} ›`, r.w - 6), Math.round(r.x + r.w / 2), Math.round(cy + 3));
            ctx.textAlign = 'left';
        }
        this.drawStrip(ctx);
    }

    /** Live value strip: value text + sparkline / event flash / error. */
    drawStrip(ctx) {
        const r = this.getStripRect();
        drawInset(ctx, r.x, r.y, r.w, r.h);
        ctx.font = FONTS.value;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        if (this._ctlError) {
            ctx.fillStyle = COLORS.error;
            ctx.fillText(fitText(ctx, FONTS.value, this._ctlError, r.w - 8), r.x + 4, r.y + 15);
            return;
        }
        const out = this._ctlOut;
        const h = this._ctlHist;
        const plan = this.graph && this.graph._controlPlan;
        const info = plan && plan.info.get(this);
        const types = info && info.outTypes ? info.outTypes : this.outputs.map(o => o.type);
        if (!out) {
            ctx.fillStyle = COLORS.textFaint;
            ctx.fillText('waiting…', r.x + 4, r.y + 15);
            return;
        }
        // Main value: the first plotted output (else the first output)
        const k = h && h.plotIndex >= 0 ? h.plotIndex : 0;
        const t = types[k];
        const color = portColor(t);
        let label = t === 'sampler2D' ? (this.liveTexture && this.liveTexture(this.outputs[k].name) ? 'texture' : '–') : formatValue(out[k], t);
        const flashing = h && h.fired && performance.now() - h.fired < 160;
        // Sparkline (numbers)
        if (h && h.n > 1 && (t === 'float' || t === 'int' || t === 'bool' || /^vec/.test(t))) {
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < h.n; i++) { const v = h.buf[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
            if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
            const x0 = r.x + r.w * 0.42, w = r.w * 0.58 - 4, y0 = r.y + 3, hh = r.h - 6;
            ctx.beginPath();
            const N = h.buf.length;
            for (let i = 0; i < h.n; i++) {
                const idx = (h.i - h.n + i + N) % N;
                const px = x0 + (i / (N - 1)) * w;
                const py = y0 + hh - ((h.buf[idx] - lo) / (hi - lo)) * hh;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.strokeStyle = withAlpha(color, 0.85);
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        if (flashing) {
            ctx.fillStyle = withAlpha(portColor('event'), 0.22);
            ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        }
        ctx.fillStyle = COLORS.text;
        const maxW = h && h.n > 1 && t !== 'string' && t !== 'list' ? r.w * 0.42 - 6 : r.w - 8;
        ctx.fillText(fitText(ctx, FONTS.value, label, maxW), r.x + 4, r.y + 15);
        if (h && h.count) {
            // Events: total fires, bottom-right
            ctx.fillStyle = flashing ? portColor('event') : COLORS.textFaint;
            ctx.textAlign = 'right';
            ctx.fillText(`⚡${h.count}`, r.x + r.w - 4, r.y + r.h - 4);
            ctx.textAlign = 'left';
        }
    }
}

// Text / List Texture outputs: reuse the JS node texture plumbing (getTexture,
// uploadTexture, liveTexture, freeTexture), bound through jsTextureNodeId uniforms.
for (const m of ['getTexture', 'uploadTexture', '_toBytes', 'liveTexture', 'freeTexture', 'freeTextures']) {
    ControlNode.prototype[m] = JSNode.prototype[m];
}
ControlNode.prototype.cleanup = function () {
    this.freeTextures();
};

/**
 * Sample (GPU -> control): a control node that is also a point probe. The
 * ProbeRenderer compiles input 0 like a Preview, evaluates it at getSampleUV()
 * and reads it back asynchronously every frame (probeAlways); the ControlRuntime
 * turns the last readback into the node's outputs (one frame late).
 */
export class SampleNode extends ControlNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isProbeNode = true;
        this.probeAlways = true;
        this._probeStatus = 'none';
        this._sampleUV = [0.5, 0.5];
        this._sampleRGBA = null;
    }

    setProbeStatus(status, error = null, type = null) {
        this._probeStatus = status;
        this._probeError = error;
        this._probeType = type;
        if (status !== 'ok') this._sampleRGBA = null;
    }

    getSampleUV() {
        return this._sampleUV || [0.5, 0.5];
    }

    onProbeSample(rgba, meta) {
        this._sampleRGBA = [rgba[0], rgba[1], rgba[2], rgba[3]];
        this._sampleMeta = meta;
    }

    onProbeGrid() {}

    describeProbe() {
        return {
            status: this._probeStatus,
            error: this._probeError || undefined,
            type: this._probeType || undefined,
            uv: this.getSampleUV(),
            value: this._sampleRGBA ? this._sampleRGBA.map(v => +v.toFixed(5)) : null,
            frame: this._sampleMeta ? this._sampleMeta.frame : undefined
        };
    }
}
