import { Node } from './Node.js';
import { COLORS, FONTS } from '../ui/theme.js';
import { getFontEpoch } from '../rendering/NodePainter.js';

/**
 * Comment - a sticky note for documenting a patch on the canvas.
 * It has no ports and never takes part in compilation.
 *
 * data: { text, width, height, color }
 * Text supports a tiny bit of markdown: "# " / "## " headings and "- " bullets.
 * Double-click to edit (DOM textarea overlay), drag the bottom-right corner to resize.
 */

export const NOTE_COLORS = {
    yellow: '#f5c84b',
    orange: '#ff5c2b',
    pink: '#f472b6',
    violet: '#a78bfa',
    blue: '#8ecbff',
    green: '#4ade80',
    gray: '#a0a6b6'
};

const PAD = 12;
const LABEL_H = 22;
const MIN_W = 140;
const MIN_H = 64;
const FONT_BODY = '12px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif';
const FONT_H1 = '600 15px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif';
const FONT_H2 = '600 13px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif';
const LINE_BODY = 17;
const LINE_H1 = 22;
const LINE_H2 = 19;

function hexToRgba(hex, a) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export class CommentNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isCommentNode = true;
        this.fixedWidth = true;
        this.syncSize();
    }

    get noteColor() {
        return NOTE_COLORS[this.data.color] || NOTE_COLORS.yellow;
    }

    syncSize() {
        this.width = Math.max(MIN_W, Number(this.data.width) || 260);
        this.height = Math.max(MIN_H, Number(this.data.height) || 140);
    }

    // No ports, no inline fields
    updateDimensions() { this.syncSize(); }

    // ---- Resizing (handled by NodeGraph through resizeFree) ----

    getResizeEdge(x, y) {
        const t = 8;
        const right = this.x + this.width;
        const bottom = this.y + this.height;
        const nearRight = Math.abs(x - right) < t && y >= this.y && y <= bottom + t;
        const nearBottom = Math.abs(y - bottom) < t && x >= this.x && x <= right + t;
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
        if (edge.includes('e')) this.data.width = Math.round(Math.max(MIN_W, pos.x - this.x));
        if (edge.includes('s')) this.data.height = Math.round(Math.max(MIN_H, pos.y - this.y));
        this.syncSize();
    }

    // ---- Text layout (cached) ----

    layoutText(ctx) {
        const text = typeof this.data.text === 'string' ? this.data.text : '';
        const maxW = this.width - PAD * 2;
        const epoch = getFontEpoch();
        if (this._layout && this._layoutText === text && this._layoutW === maxW && this._layoutEpoch === epoch) {
            return this._layout;
        }

        const lines = [];
        for (const raw of text.split('\n')) {
            let font = FONT_BODY;
            let lineH = LINE_BODY;
            let content = raw;
            let indent = 0;
            let bullet = false;
            if (raw.startsWith('## ')) { font = FONT_H2; lineH = LINE_H2; content = raw.slice(3); }
            else if (raw.startsWith('# ')) { font = FONT_H1; lineH = LINE_H1; content = raw.slice(2); }
            else if (/^\s*[-*] /.test(raw)) { bullet = true; indent = 14; content = raw.replace(/^\s*[-*] /, ''); }

            if (!content.trim()) {
                lines.push({ text: '', font, lineH: lineH * 0.6, indent: 0 });
                continue;
            }

            ctx.font = font;
            const words = content.split(/(\s+)/);
            let cur = '';
            let first = true;
            for (const w of words) {
                const next = cur + w;
                if (cur && ctx.measureText(next).width > maxW - indent) {
                    lines.push({ text: cur.trimEnd(), font, lineH, indent, bullet: bullet && first });
                    first = false;
                    cur = w.trimStart();
                } else {
                    cur = next;
                }
            }
            if (cur) lines.push({ text: cur.trimEnd(), font, lineH, indent, bullet: bullet && first });
        }

        this._layout = lines;
        this._layoutText = text;
        this._layoutW = maxW;
        this._layoutEpoch = epoch;
        return lines;
    }

    // ---- Drawing ----

    draw(ctx, options = {}) {
        this.syncSize();
        const { x, y, width: w, height: h } = this;
        const color = this.noteColor;
        const selected = !!options.isSelected;
        const hovered = !!options.isHovered;

        ctx.save();

        // Paper: translucent tint so the grid and cables read through it
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 6);
        ctx.fillStyle = hexToRgba(color, 0.09);
        ctx.fill();
        ctx.fillStyle = 'rgba(20, 22, 28, 0.72)';
        ctx.fill();
        ctx.fillStyle = hexToRgba(color, 0.08);
        ctx.fill();

        // Accent spine
        ctx.save();
        ctx.clip();
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 3, h);
        ctx.restore();

        // Border
        ctx.lineWidth = selected ? 1.5 : 1;
        ctx.strokeStyle = selected ? COLORS.selection : hexToRgba(color, hovered ? 0.6 : 0.35);
        if (!selected) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label
        ctx.font = FONTS.title;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = hexToRgba(color, 0.85);
        ctx.fillText('NOTE', x + PAD, y + LABEL_H / 2 + 2);

        // Color dot (click to cycle)
        const dot = this.getColorDotRect();
        ctx.beginPath();
        ctx.arc(dot.x + dot.w / 2, dot.y + dot.h / 2, this.isHoveringRect(options, dot, 2) ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Text, clipped to the body
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 4, y + LABEL_H, w - 8, h - LABEL_H - 4);
        ctx.clip();
        const lines = this._editing ? [] : this.layoutText(ctx);
        let ty = y + LABEL_H + 4;
        ctx.textBaseline = 'top';
        let overflow = false;
        for (const line of lines) {
            if (ty > y + h) { overflow = true; break; }
            ctx.font = line.font;
            const isHeading = line.font !== FONT_BODY;
            ctx.fillStyle = isHeading ? COLORS.text : 'rgba(236, 238, 244, 0.86)';
            if (line.bullet) {
                ctx.fillStyle = color;
                ctx.fillRect(x + PAD + 2, ty + 6, 4, 4);
                ctx.fillStyle = 'rgba(236, 238, 244, 0.86)';
            }
            if (line.text) ctx.fillText(line.text, x + PAD + line.indent, ty);
            ty += line.lineH;
        }
        ctx.restore();

        // Fade out text that doesn't fit
        if (overflow || ty > y + h - 4) {
            const g = ctx.createLinearGradient(0, y + h - 22, 0, y + h - 2);
            g.addColorStop(0, 'rgba(20, 22, 28, 0)');
            g.addColorStop(1, 'rgba(20, 22, 28, 0.95)');
            ctx.fillStyle = g;
            ctx.fillRect(x + 4, y + h - 22, w - 8, 20);
        }

        // Resize grip
        if (hovered || selected) {
            ctx.strokeStyle = hexToRgba(color, 0.7);
            ctx.lineWidth = 1;
            for (let i = 0; i < 3; i++) {
                const o = 4 + i * 4;
                ctx.beginPath();
                ctx.moveTo(x + w - o, y + h - 3);
                ctx.lineTo(x + w - 3, y + h - o);
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    getColorDotRect() {
        return { x: this.x + this.width - 20, y: this.y + 6, w: 12, h: 12 };
    }

    getControlCursor(x, y) {
        const d = this.getColorDotRect();
        if (x >= d.x - 3 && x <= d.x + d.w + 3 && y >= d.y - 3 && y <= d.y + d.h + 3) return 'pointer';
        return null;
    }

    handleMouseDown(x, y, event) {
        const d = this.getColorDotRect();
        if (x >= d.x - 3 && x <= d.x + d.w + 3 && y >= d.y - 3 && y <= d.y + d.h + 3) {
            const keys = Object.keys(NOTE_COLORS);
            const i = keys.indexOf(this.data.color);
            this.data.color = keys[(i + 1) % keys.length];
            if (this.graph && this.graph.onGraphChanged) this.graph.onGraphChanged();
            return { handled: true, needsRender: true };
        }
        return super.handleMouseDown(x, y, event);
    }

    // ---- Editing (double-click) ----

    beginEdit(canvas, onCommit) {
        if (this._editor) return;
        const graph = this.graph;
        if (!graph || !canvas) return;

        const ta = document.createElement('textarea');
        ta.className = 'pt-comment-editor';
        ta.spellcheck = true;
        ta.value = typeof this.data.text === 'string' ? this.data.text : '';
        this._placeEditor(ta, canvas);
        ta.style.setProperty('--note-color', this.noteColor);
        document.body.appendChild(ta);
        this._editor = ta;
        this._editing = true;
        // Re-placed after every canvas render: wheel pan / zoom while typing (review E-m8)
        const unfollow = typeof graph.addOverlay === 'function' ? graph.addOverlay(() => this._placeEditor(ta, canvas)) : () => {};
        graph.render();

        const finish = (commit) => {
            if (!this._editor) return;
            const value = ta.value;
            this._editor = null;
            this._editing = false;
            this._finishEdit = null;
            unfollow();
            ta.remove();
            if (commit && value !== this.data.text) {
                this.data.text = value;
                this._layout = null;
                if (onCommit) onCommit();
            }
            graph.render();
        };

        ta.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
        });
        ta.addEventListener('blur', () => finish(true));
        this._finishEdit = finish;
        requestAnimationFrame(() => {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        });
    }

    /** Note text editor position over the canvas (viewport px), for the current pan / zoom. */
    _placeEditor(ta, canvas) {
        const graph = this.graph;
        if (!graph || !canvas) return;
        const rect = canvas.getBoundingClientRect();
        const zoom = graph.zoom || 1;
        const ctl = graph.groupCtl;
        const shown = graph.nodes.includes(this) && !(ctl && ctl.isVisible && !ctl.isVisible(this));
        ta.style.display = shown ? '' : 'none';
        ta.style.left = `${rect.left + graph.panX + (this.x + 4) * zoom}px`;
        ta.style.top = `${rect.top + graph.panY + (this.y + LABEL_H) * zoom}px`;
        ta.style.width = `${(this.width - 8) * zoom}px`;
        ta.style.height = `${Math.max(this.height - LABEL_H - 4, 40) * zoom}px`;
        ta.style.fontSize = `${12 * zoom}px`;
    }

    // Size from the restored data (NodeFactory replaces data after the constructor)
    rebuildTextInputs() { this.syncSize(); }

    /** Deleted / project replaced while editing: drop the editor without writing into this node. */
    cleanup() {
        if (this._finishEdit) this._finishEdit(false);
        if (super.cleanup) super.cleanup();
    }

    serialize() {
        return { ...super.serialize() };
    }
}
