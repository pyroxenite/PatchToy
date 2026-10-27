import { Node } from './Node.js';
import { COLORS } from '../ui/theme.js';
import { drawInset } from '../rendering/NodePainter.js';
import { pushLiveUniform } from './liveUniform.js';

const PAD_H = 96;

/**
 * XY pad source: drag inside the pad to set data.x / data.y (0..1, origin
 * bottom-left). Outputs xy, x and y as live uniforms (no recompilation).
 */
export class XYPadNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isXYPadNode = true;
        if (!Number.isFinite(this.data.x)) this.data.x = 0.5;
        if (!Number.isFinite(this.data.y)) this.data.y = 0.5;
        this.width = 150;
        this.updateDimensions();
        this._dragging = false;
    }

    getUniformValue() {
        return [this.data.x, this.data.y];
    }

    updateDimensions() {
        super.updateDimensions();
        if (this.heightForRows) this.height = this.heightForRows(Math.max(this.outputs.length, 1), PAD_H + 6);
    }

    getPadRect() {
        const rows = Math.max(this.outputs.length, 1);
        const top = this.getRowCenterY(rows - 1) + 14;
        return { x: this.x + 8, y: top, w: this.width - 16, h: PAD_H };
    }

    setFromWorld(wx, wy) {
        const r = this.getPadRect();
        const nx = Math.max(0, Math.min(1, (wx - r.x) / r.w));
        const ny = Math.max(0, Math.min(1, 1 - (wy - r.y) / r.h));
        this.data.x = Math.round(nx * 1000) / 1000;
        this.data.y = Math.round(ny * 1000) / 1000;
        pushLiveUniform(this);
    }

    handleMouseDown(x, y, event) {
        const r = this.getPadRect();
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && this.graph && this.graph.getMousePos) {
            this._dragging = true;
            this.setFromWorld(x, y);
            const move = (e) => {
                const pos = this.graph.getMousePos(e);
                this.setFromWorld(pos.x, pos.y);
            };
            const up = () => {
                this._dragging = false;
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

    getControlCursor(x, y) {
        const r = this.getPadRect();
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'crosshair';
        return super.getControlCursor ? super.getControlCursor(x, y) : null;
    }

    drawBody(ctx, options = {}) {
        super.drawBody(ctx, options);
        const r = this.getPadRect();
        drawInset(ctx, r.x, r.y, r.w, r.h);
        const px = r.x + this.data.x * r.w;
        const py = r.y + (1 - this.data.y) * r.h;
        ctx.save();
        ctx.strokeStyle = COLORS.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, r.y + 2);
        ctx.lineTo(Math.round(px) + 0.5, r.y + r.h - 2);
        ctx.moveTo(r.x + 2, Math.round(py) + 0.5);
        ctx.lineTo(r.x + r.w - 2, Math.round(py) + 0.5);
        ctx.stroke();
        ctx.fillStyle = COLORS.accent;
        ctx.beginPath();
        ctx.arc(px, py, this._dragging ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}
