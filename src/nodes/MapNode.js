import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';
import { COLORS, NODE_LAYOUT } from '../ui/theme.js';
import { drawLabel, drawCheckbox } from '../rendering/NodePainter.js';

export class MapNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.width = 160;
        this.fixedWidth = true;
    }

    rebuildTextInputs() {
        if (!this.hasInputFields) return;

        this.textInputs = {};

        // Create text inputs for numeric data fields
        for (const field in this.data) {
            const value = this.data[field];

            // Skip boolean fields - they'll be handled as toggles
            if (typeof value === 'boolean') {
                continue;
            }

            if (typeof value === 'number') {
                this.textInputs[field] = new CanvasTextInput(
                    0, 0, 50, 20,
                    String(value),
                    'float'
                );
                this.textInputs[field].onChange = (newValue) => {
                    const numValue = parseFloat(newValue);

                    if (!isNaN(numValue)) {
                        this.data[field] = numValue;

                        if (this.graph && this.graph.onGraphChanged) {
                            this.graph.onGraphChanged();
                        }
                    }
                };
            }
        }

        this.updateTextInputPositions();
    }

    // Layout: row 0 = ports, row 1 = in range, row 2 = out range, row 3 = clip
    getRangeColumns() {
        const left = this.x + 32;
        const right = this.x + this.width - 12;
        const gap = 6;
        const w = (right - left - gap) / 2;
        return { left, w, gap };
    }

    updateTextInputPositions() {
        if (!this.textInputs) return;

        const { left, w, gap } = this.getRangeColumns();
        const fieldH = NODE_LAYOUT.fieldHeight;
        const place = (field, row, col) => {
            const input = this.textInputs[field];
            if (!input) return;
            input.x = left + col * (w + gap);
            input.y = this.getRowCenterY(row) - fieldH / 2;
            input.width = w;
            input.height = fieldH;
        };
        place('inMin', 1, 0);
        place('inMax', 1, 1);
        place('outMin', 2, 0);
        place('outMax', 2, 1);
    }

    getClipRect() {
        const cy = this.getRowCenterY(3);
        return { x: this.x + 10, y: cy - 6, w: 48, h: 12 };
    }

    drawBody(ctx, options = {}) {
        this.updateTextInputPositions();

        // Range captions
        drawLabel(ctx, 'in', this.x + 11, this.getRowCenterY(1), COLORS.textFaint);
        drawLabel(ctx, 'out', this.x + 11, this.getRowCenterY(2), COLORS.textFaint);

        for (const field of ['inMin', 'inMax', 'outMin', 'outMax']) {
            const input = this.textInputs && this.textInputs[field];
            if (input) input.draw(ctx, options);
        }

        // Range arrow between in → out rows (pixel chevron)
        const { left, w } = this.getRangeColumns();
        const ax = Math.round(left + w + 1);
        const ay = Math.round((this.getRowCenterY(1) + this.getRowCenterY(2)) / 2);
        ctx.fillStyle = COLORS.textFaint;
        ctx.fillRect(ax + 1, ay - 2, 1, 3);
        ctx.fillRect(ax, ay - 1, 3, 1);
        ctx.fillRect(ax + 1, ay + 1, 1, 1);

        const c = this.getClipRect();
        drawCheckbox(ctx, c.x, c.y, !!this.data.clip, 'clip', this.getAccentColor());
    }

    _checkTextInputs(x, y) {
        // Check clip toggle (box + label)
        const c = this.getClipRect();

        if (x >= c.x && x <= c.x + c.w &&
            y >= c.y - 2 && y <= c.y + c.h + 2) {
            this.data.clip = !this.data.clip;

            if (this.graph && this.graph.onGraphChanged) {
                this.graph.onGraphChanged();
            }

            return { type: 'TOGGLE_CLIP', node: this };
        }

        // Fall back to parent implementation for text inputs
        return super._checkTextInputs ? super._checkTextInputs(x, y) : null;
    }

    getControlCursor(x, y) {
        const c = this.getClipRect();
        if (x >= c.x && x <= c.x + c.w && y >= c.y - 2 && y <= c.y + c.h + 2) return 'pointer';
        return super.getControlCursor(x, y);
    }

    updateDimensions() {
        this.height = this.heightForRows(4);
    }
}
