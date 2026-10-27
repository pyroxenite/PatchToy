import { Node } from './Node.js';
import { NODE_LAYOUT } from '../ui/theme.js';
import { drawSegmented } from '../rendering/NodePainter.js';

const UV_MODES = ['stretch', 'contain', 'cover'];

export class UVNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        // UV node specific defaults
        this.width = 180;
        this.fixedWidth = true;

        // Initialize mode if not set
        if (!this.data.mode) {
            this.data.mode = 'stretch';
        }
    }

    /** Segmented mode selector on body row 0 (leaves room for the output jack). */
    getModeSelectorRect() {
        const h = NODE_LAYOUT.fieldHeight + 2;
        return {
            x: this.x + 8,
            y: this.getRowCenterY(0) - h / 2,
            w: this.width - 22,
            h
        };
    }

    getModeIndexAt(x, y) {
        const r = this.getModeSelectorRect();
        if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return -1;
        const segW = (r.w - 2) / UV_MODES.length;
        return Math.max(0, Math.min(UV_MODES.length - 1, Math.floor((x - r.x - 1) / segW)));
    }

    drawBody(ctx, options = {}) {
        const r = this.getModeSelectorRect();
        const current = Math.max(0, UV_MODES.indexOf(this.data.mode || 'stretch'));
        const hover = options.mouseX !== undefined ? this.getModeIndexAt(options.mouseX, options.mouseY) : -1;
        drawSegmented(ctx, r.x, r.y, r.w, r.h, UV_MODES, current, this.getAccentColor(), hover);
    }

    // The selector already explains the output
    getOutputPortLabel() {
        return '';
    }

    getControlCursor(x, y) {
        if (this.getModeIndexAt(x, y) !== -1) return 'pointer';
        return super.getControlCursor(x, y);
    }

    handleMouseDown(x, y) {
        // Check mode selector first
        if (this._checkAndHandleModeSelector(x, y)) {
            return { handled: true, needsRender: true, needsGraphChange: true };
        }

        // Check output ports
        for (let i = 0; i < this.outputs.length; i++) {
            const portPos = this.getOutputPortPosition(i);
            if (!portPos) continue;

            const dist = Math.hypot(x - portPos.x, y - portPos.y);
            if (dist < 8) {
                return {
                    type: 'START_CONNECTION_FROM_OUTPUT',
                    node: this,
                    outputIndex: i
                };
            }
        }

        // Default: start dragging the node
        return {
            type: 'START_NODE_DRAG',
            node: this,
            offsetX: x - this.x,
            offsetY: y - this.y
        };
    }

    _checkAndHandleModeSelector(x, y) {
        const index = this.getModeIndexAt(x, y);
        if (index === -1) return false;
        this.data.mode = UV_MODES[index];
        return true;
    }

    updateDimensions() {
        this.height = this.heightForRows(1);
    }
}
