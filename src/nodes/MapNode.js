import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';

export class MapNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
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

    updateTextInputPositions() {
        if (!this.textInputs) return;

        const leftFields = ['inMin', 'inMax'];
        const rightFields = ['outMin', 'outMax'];
        let yOffset = 40; // Start below the IN/OUT labels
        const inputWidth = (this.width - 30) / 2;

        // Left side (input range)
        for (const field of leftFields) {
            if (this.textInputs[field]) {
                this.textInputs[field].x = this.x + 10;
                this.textInputs[field].y = this.y + yOffset;
                this.textInputs[field].width = inputWidth;
                yOffset += 25;
            }
        }

        // Right side (output range)
        yOffset = 40; // Start below the IN/OUT labels
        for (const field of rightFields) {
            if (this.textInputs[field]) {
                this.textInputs[field].x = this.x + this.width / 2 + 5;
                this.textInputs[field].y = this.y + yOffset;
                this.textInputs[field].width = inputWidth;
                yOffset += 25;
            }
        }
    }

    draw(ctx, options = {}) {
        // Update text input positions before drawing
        this.updateTextInputPositions();

        // Call parent draw
        super.draw(ctx, options);

        // Draw labels for the input/output columns
        if (this.hasInputFields) {
            ctx.fillStyle = '#888';
            ctx.font = '10px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            // Column headers with spacing from title
            const leftCenter = this.x + this.width / 4;
            const rightCenter = this.x + (this.width * 3) / 4;

            ctx.fillText('IN', leftCenter, this.y + 25);
            ctx.fillText('OUT', rightCenter, this.y + 25);

            ctx.textAlign = 'left';
        }

        // Draw clip toggle
        this.drawClipToggle(ctx);
    }

    drawClipToggle(ctx) {
        const toggleSize = 16;
        const toggleX = this.x + 10;
        const toggleY = this.y + 95; // Fixed position right after text inputs
        const isChecked = this.data.clip || false;

        // Checkbox background
        ctx.fillStyle = isChecked ? '#007acc' : '#2a2a2a';
        ctx.strokeStyle = isChecked ? '#0098ff' : '#555';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(toggleX, toggleY, toggleSize, toggleSize, 3);
        ctx.fill();
        ctx.stroke();

        // Checkmark
        if (isChecked) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(toggleX + 3, toggleY + 8);
            ctx.lineTo(toggleX + 6, toggleY + 11);
            ctx.lineTo(toggleX + 13, toggleY + 4);
            ctx.stroke();
        }

        // Label
        ctx.fillStyle = '#ddd';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('clip', toggleX + toggleSize + 6, toggleY + toggleSize / 2);
    }

    _checkTextInputs(x, y) {
        // Check clip toggle
        const toggleSize = 16;
        const toggleX = this.x + 10;
        const toggleY = this.y + 95; // Fixed position right after text inputs

        if (x >= toggleX && x <= toggleX + toggleSize + 30 &&
            y >= toggleY && y <= toggleY + toggleSize) {
            this.data.clip = !this.data.clip;

            if (this.graph && this.graph.onGraphChanged) {
                this.graph.onGraphChanged();
            }

            return { type: 'TOGGLE_CLIP', node: this };
        }

        // Fall back to parent implementation for text inputs
        return super._checkTextInputs ? super._checkTextInputs(x, y) : null;
    }

    updateDimensions() {
        const baseHeight = 30;
        // Headers (15) + 2 rows of text inputs (50) + small gap (5) + toggle (20) + bottom padding (5)
        const controlsHeight = 15 + 50 + 5 + 20 + 5;
        this.height = baseHeight + controlsHeight;
    }

    // Override to hide port labels
    getInputPortLabel() {
        return ''; // Hide input port labels
    }

    getOutputPortLabel() {
        return ''; // Hide output port labels
    }
}
