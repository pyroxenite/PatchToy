import { LibraryNode } from './LibraryNode.js';
import { COLORS, FONTS, CANVAS } from '../ui/theme.js';
import { drawLabel, drawInset, fitText } from '../rendering/NodePainter.js';

/**
 * Library node with option pills (definition.optionPills = [{ key, label, values, default }]):
 * enumerated node.data fields drawn below the ports and text fields, cycling through their
 * values on click (shift-click goes back). Changing one recompiles (the GLSL can differ).
 * Used by Beat (clock, gate) and BeatEnvelope (gate).
 */
export class OptionNode extends LibraryNode {
    getOptions() {
        return (this.definition && this.definition.optionPills) || [];
    }

    _optionRow(k) {
        return this.getPortRowCount() + this.getTextFields().length + k;
    }

    updateDimensions() {
        super.updateDimensions();
        const rows = this.getPortRowCount() + this.getTextFields().length + this.getOptions().length;
        if (this.heightForRows) this.height = this.heightForRows(rows);
    }

    getOptionRect(k) {
        const cy = this.getRowCenterY(this._optionRow(k));
        return { x: this.x + 46, y: cy - 8, w: Math.max(40, this.width - 56), h: 16 };
    }

    optionValue(o) {
        const v = String(this.data[o.key] ?? o.default);
        return o.values.includes(v) ? v : o.default;
    }

    getControlCursor(x, y) {
        for (let k = 0; k < this.getOptions().length; k++) {
            const r = this.getOptionRect(k);
            if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'pointer';
        }
        return super.getControlCursor ? super.getControlCursor(x, y) : null;
    }

    handleMouseDown(x, y, event) {
        const opts = this.getOptions();
        for (let k = 0; k < opts.length; k++) {
            const r = this.getOptionRect(k);
            if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
            const o = opts[k];
            const i = Math.max(0, o.values.indexOf(this.optionValue(o)));
            this.data[o.key] = o.values[(i + (event && event.shiftKey ? o.values.length - 1 : 1)) % o.values.length];
            if (this.graph && this.graph.onGraphChanged) this.graph.onGraphChanged();
            return { handled: true, needsRender: true };
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
            ctx.font = FONTS.value;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = hovered ? COLORS.text : COLORS.textDim;
            ctx.fillText(fitText(ctx, FONTS.value, `‹ ${this.optionValue(o)} ›`, r.w - 6), Math.round(r.x + r.w / 2), Math.round(cy + 3));
            ctx.textAlign = 'left';
        }
    }
}
