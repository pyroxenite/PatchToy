import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';

export class ConstantNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
    }

    rebuildTextInputs() {
        if (!this.hasInputFields) return;

        this.textInputs = {};

        // Only create text inputs for numeric data fields (not 'useUniform')
        for (const field in this.data) {
            const value = this.data[field];
            if (typeof value === 'number') {
                this.textInputs[field] = new CanvasTextInput(
                    0, 0, 50, 20,
                    String(value)
                );
                this.textInputs[field].onChange = (newValue) => {
                    const numValue = parseFloat(newValue);
                    if (!isNaN(numValue)) {
                        const oldValue = this.data[field];
                        this.data[field] = numValue;

                        // If in uniform mode, just update uniforms without recompiling
                        if (this.data.useUniform && this.graph && this.graph.onUniformValueChanged) {
                            this.graph.onUniformValueChanged(this);
                        } else if (this.graph && this.graph.onGraphChanged) {
                            // Otherwise recompile (constant mode with inline values)
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

        const fields = Object.keys(this.textInputs);
        let yOffset = 30;

        for (const field of fields) {
            const input = this.textInputs[field];
            input.x = this.x + 10;
            input.y = this.y + yOffset;
            input.width = (this.width - 20) * 0.4; // 2/5th width visually
            yOffset += 25;
        }
    }

    // Override draw to position text inputs correctly
    draw(ctx, options = {}) {
        // Update text input positions before drawing
        this.updateTextInputPositions();

        // Call parent draw
        super.draw(ctx, options);
    }

    // Override to return only visible inputs (hide when in uniform mode)
    getVisibleInputs() {
        if (this.data.useUniform) {
            // In uniform mode, no inputs are visible
            return [];
        }
        return this.inputs;
    }

    // Override input port drawing logic
    getInputPortPosition(index) {
        // If in uniform mode, don't show input ports
        if (this.data.useUniform) {
            return null;
        }
        return super.getInputPortPosition(index);
    }

    updateDimensions() {
        const baseHeight = 30;

        // Count visible inputs (not in uniform mode)
        const visibleInputCount = this.data.useUniform ? 0 : this.inputs.length;
        const outputCount = this.outputs.length;
        const portHeight = Math.max(visibleInputCount, outputCount) * 25;

        // Count text input fields
        let textInputCount = 0;
        for (const field in this.data) {
            if (typeof this.data[field] === 'number') {
                textInputCount++;
            }
        }
        const textInputHeight = textInputCount * 25;

        this.height = Math.max(60, baseHeight + portHeight + textInputHeight);
    }
}
