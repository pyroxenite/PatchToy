import { LibraryNode } from './LibraryNode.js';
import { COLORS, FONTS, CANVAS } from '../ui/theme.js';
import { drawLabel, drawInset, fitText, withAlpha } from '../rendering/NodePainter.js';
import { audioTextures } from '../services/AudioTextures.js';
import { audioEngine } from '../services/AudioEngine.js';
import { normalizeAudioTexture, audioTextureKey, SPECTROGRAM_ROWS } from '../core/audioTextureConfig.js';
import { audioTextureOptionValues } from '../core/library/audio.js';

const STRIP_H = 34;

/**
 * Audio Texture node (src/core/library/audio.js): option pills (kind, bins,
 * scale, smoothing, history) that cycle on click (shift-click goes back) and a
 * live thumbnail of the texture's CPU copy. Changing an option recompiles
 * (it selects another shared texture).
 */
export class AudioTextureNode extends LibraryNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        if (this.width < 176) this.width = 176;
    }

    getOptions() {
        return (this.definition && this.definition.options) || [];
    }

    updateDimensions() {
        super.updateDimensions();
        if (this.width < 176) this.width = 176;
        this.height = this.heightForRows(this.getPortRowCount() + this.getOptions().length, STRIP_H + 6);
    }

    getOptionRect(k) {
        const cy = this.getRowCenterY(this.getPortRowCount() + k);
        return { x: this.x + 64, y: cy - 8, w: Math.max(54, this.width - 74), h: 16 };
    }

    getStripRect() {
        const top = this.getRowCenterY(this.getPortRowCount() + this.getOptions().length - 1) + 11 + 4;
        return { x: this.x + 8, y: top, w: this.width - 16, h: STRIP_H };
    }

    needsContinuousRender() {
        return audioEngine.source !== 'off';
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
            if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
            const o = opts[k];
            const values = audioTextureOptionValues(o, this.data);
            const cur = normalizeAudioTexture(this.data)[o.key];
            const i = Math.max(0, values.findIndex(v => String(v) === String(cur)));
            this.data[o.key] = values[(i + (event && event.shiftKey ? values.length - 1 : 1)) % values.length];
            if (o.key === 'kind') {
                // keep the other options valid for the new kind
                const c = normalizeAudioTexture({ kind: this.data.kind });
                if (!audioTextureOptionValues({ key: 'bins' }, this.data).includes(Number(this.data.bins))) this.data.bins = c.bins;
                if (this.data.kind === 'spectrum' && Number(this.data.smoothing) < 0.3) this.data.smoothing = c.smoothing;
            }
            // Another option set = another shared texture: recompile
            if (this.graph && this.graph.onGraphChanged) this.graph.onGraphChanged();
            return { handled: true, needsRender: true };
        }
        return super.handleMouseDown(x, y, event);
    }

    drawBody(ctx, options = {}) {
        super.drawBody(ctx, options);
        const cfg = normalizeAudioTexture(this.data);
        const opts = this.getOptions();
        for (let k = 0; k < opts.length; k++) {
            const o = opts[k];
            const r = this.getOptionRect(k);
            const cy = r.y + r.h / 2;
            const unused = (o.key === 'history' && cfg.kind !== 'spectrogram') ||
                ((o.key === 'scale' || o.key === 'smoothing') && cfg.kind === 'waveform');
            drawLabel(ctx, o.label || o.key, this.x + 10, cy, unused ? withAlpha(COLORS.textFaint, 0.5) : COLORS.textFaint);
            const hovered = this.isHoveringRect(options, r);
            drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered ? CANVAS.insetHover : undefined });
            ctx.font = FONTS.value;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = unused ? COLORS.textFaint : hovered ? COLORS.text : COLORS.textDim;
            const val = `${cfg[o.key]}${o.unit || ''}`;
            ctx.fillText(fitText(ctx, FONTS.value, `‹ ${val} ›`, r.w - 6), Math.round(r.x + r.w / 2), Math.round(cy + 3));
            ctx.textAlign = 'left';
        }
        this.drawStrip(ctx, cfg);
    }

    /** Thumbnail of the texture (bars / line / scrolling history). */
    drawStrip(ctx, cfg) {
        const r = this.getStripRect();
        drawInset(ctx, r.x, r.y, r.w, r.h);
        const t = audioTextures.peek(this.audioTextureKey || audioTextureKey(cfg));
        if (!t || t.mode === 'zero' || t.mode === null) {
            ctx.font = FONTS.value;
            ctx.fillStyle = COLORS.textFaint;
            ctx.fillText(audioEngine.source === 'off' ? 'audio off (zeros)' : 'waiting…', r.x + 5, r.y + 20);
            return;
        }
        const x0 = r.x + 3, y0 = r.y + 3, w = r.w - 6, h = r.h - 6;
        const d = t.data;
        ctx.save();
        if (cfg.kind === 'waveform') {
            ctx.beginPath();
            const n = 96;
            for (let i = 0; i < n; i++) {
                const v = d[Math.floor(i / (n - 1) * (t.w - 1))];
                const px = x0 + (i / (n - 1)) * w;
                const py = y0 + h / 2 - v * h / 2;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.strokeStyle = COLORS.accent2;
            ctx.lineWidth = 1;
            ctx.stroke();
        } else if (cfg.kind === 'spectrum') {
            const n = 48;
            const bw = w / n;
            ctx.fillStyle = withAlpha(COLORS.accent, 0.85);
            for (let i = 0; i < n; i++) {
                let m = 0;
                const a = Math.floor(i / n * t.w), b = Math.max(a + 1, Math.floor((i + 1) / n * t.w));
                for (let k = a; k < b; k++) m = Math.max(m, d[2 * k]);
                const bh = m * h;
                ctx.fillRect(x0 + i * bw + 0.5, y0 + h - bh, Math.max(1, bw - 1), bh);
            }
        } else {
            // spectrogram: the last ~history, oldest left, columns of 2 px
            const cols = Math.floor(w / 2);
            const rows = 12;
            const newest = t.row === null ? 0 : t.row;
            for (let c = 0; c < cols; c++) {
                const rr = ((newest - Math.round((cols - 1 - c) / (cols - 1) * (SPECTROGRAM_ROWS - 3))) % SPECTROGRAM_ROWS + SPECTROGRAM_ROWS) % SPECTROGRAM_ROWS;
                for (let k = 0; k < rows; k++) {
                    const bin = Math.floor((k + 0.5) / rows * t.w);
                    const v = d[rr * t.w + bin];
                    if (v < 0.05) continue;
                    ctx.fillStyle = withAlpha(COLORS.accent, Math.min(1, v));
                    ctx.fillRect(x0 + c * 2, y0 + h - (k + 1) * h / rows, 2, h / rows);
                }
            }
        }
        ctx.restore();
    }
}
