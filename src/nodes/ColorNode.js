import { Node } from './Node.js';
import { COLORS, FONTS, LAYOUT } from '../ui/theme.js';

export class ColorNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.width = 112;
        this.fixedWidth = true;
        this.height = 82;
    }

    updateDimensions() {
        // Header + full-bleed swatch
        this.height = 82;
    }

    // Override to hide output port label
    getOutputPortLabel() {
        return '';
    }

    /** The swatch fills the whole body below the header (click → color picker). */
    getColorSwatchRect() {
        const top = this.y + LAYOUT.headerHeight;
        return { x: this.x, y: top, w: this.width, h: this.y + this.height - top };
    }

    drawBody(ctx) {
        const s = this.getColorSwatchRect();
        const r = LAYOUT.nodeRadius;
        const R = Math.round(Math.max(0, Math.min(1, this.data.r ?? 0)) * 255);
        const G = Math.round(Math.max(0, Math.min(1, this.data.g ?? 0)) * 255);
        const B = Math.round(Math.max(0, Math.min(1, this.data.b ?? 0)) * 255);

        // Cache the CSS/hex strings per color so we don't rebuild them every frame
        const key = (R << 16) | (G << 8) | B;
        if (this._swatchKey !== key) {
            this._swatchKey = key;
            this._swatchCss = `rgb(${R}, ${G}, ${B})`;
            this._swatchHex = '#' + ((1 << 24) | key).toString(16).slice(1).toUpperCase();
            const luma = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
            this._swatchInk = luma > 0.55 ? 'rgba(0, 0, 0, 0.62)' : 'rgba(255, 255, 255, 0.82)';
        }

        ctx.beginPath();
        ctx.roundRect(s.x, s.y, s.w, s.h, [0, 0, r, r]);
        ctx.fillStyle = this._swatchCss;
        ctx.fill();

        // Pixel "gloss" notch + hex readout
        ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.fillRect(s.x, s.y, s.w, 1);
        ctx.font = FONTS.value;
        ctx.fillStyle = this._swatchInk;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(this._swatchHex, Math.round(s.x + 8), Math.round(s.y + s.h - 7));
    }

    getControlCursor(x, y) {
        const s = this.getColorSwatchRect();
        if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return 'pointer';
        return super.getControlCursor(x, y);
    }

    // Color picker click handler
    handleMouseDown(x, y, event) {
        // Check if clicking on color area
        const s = this.getColorSwatchRect();

        if (x >= s.x && x <= s.x + s.w &&
            y >= s.y && y <= s.y + s.h) {
            this._checkAndHandleColorPicker(x, y, event);
            return { handled: true };
        }

        // Call parent to handle normal node interaction
        return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
    }
}
