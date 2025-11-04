import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';

export class ConstantNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.width = 75; // Half the default width
    }

    rebuildTextInputs() {
        if (!this.hasInputFields) return;

        this.textInputs = {};

        // Create text inputs for numeric data fields (not 'useUniform' or 'value' if bool)
        for (const field in this.data) {
            const value = this.data[field];

            // Skip boolean fields - they'll be handled as toggles
            if (typeof value === 'boolean') {
                continue;
            }

            if (typeof value === 'number') {
                // Pass the field type to CanvasTextInput for proper validation
                const inputType = this.fieldType || 'float';
                this.textInputs[field] = new CanvasTextInput(
                    0, 0, 50, 20,
                    String(value),
                    inputType
                );
                this.textInputs[field].onChange = (newValue) => {
                    let numValue;

                    // Use parseInt for int fields, parseFloat for others
                    if (this.fieldType === 'int') {
                        numValue = parseInt(newValue);
                    } else {
                        numValue = parseFloat(newValue);
                    }

                    if (!isNaN(numValue)) {
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
        const margin = 8; // 8px margin on each side = 16px total horizontal spacing

        for (const field of fields) {
            const input = this.textInputs[field];
            input.x = this.x + margin;
            input.y = this.y + yOffset;
            input.width = this.width - (margin * 2); // Full width minus margins
            yOffset += 25;
        }
    }

    // Override draw to position text inputs correctly
    draw(ctx, options = {}) {
        // Update text input positions before drawing
        this.updateTextInputPositions();

        // Call parent draw
        super.draw(ctx, options);

        // Draw boolean toggle buttons
        if (this.hasInputFields && this.fieldType === 'bool') {
            this.drawBooleanToggles(ctx);
        }
    }

    drawBooleanToggles(ctx) {
        let yOffset = 30;

        for (const field in this.data) {
            // Skip 'useUniform' field - that's handled by the [U] button
            if (field === 'useUniform') continue;

            if (typeof this.data[field] === 'boolean') {
                const value = this.data[field];
                const toggleWidth = this.width - 20;
                const toggleHeight = 24;
                const toggleX = this.x + 10;
                const toggleY = this.y + yOffset;

                // Button background
                ctx.fillStyle = value ? '#007acc' : '#444';
                ctx.beginPath();
                ctx.roundRect(toggleX, toggleY, toggleWidth, toggleHeight, 4);
                ctx.fill();

                // Border
                ctx.strokeStyle = value ? '#0098ff' : '#666';
                ctx.lineWidth = 1;
                ctx.stroke();

                // Label
                ctx.fillStyle = '#fff';
                ctx.font = '12px -apple-system, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(value ? 'true' : 'false', toggleX + toggleWidth / 2, toggleY + toggleHeight / 2);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';

                yOffset += 30;
            }
        }
    }

    // Override to handle boolean toggle clicks
    _checkTextInputs(x, y) {
        // Check boolean toggles first
        if (this.fieldType === 'bool') {
            let yOffset = 30;

            for (const field in this.data) {
                // Skip 'useUniform' field - that's handled by the [U] button
                if (field === 'useUniform') continue;

                if (typeof this.data[field] === 'boolean') {
                    const toggleWidth = this.width - 20;
                    const toggleHeight = 24;
                    const toggleX = this.x + 10;
                    const toggleY = this.y + yOffset;

                    // Check if click is within toggle bounds
                    if (x >= toggleX && x <= toggleX + toggleWidth &&
                        y >= toggleY && y <= toggleY + toggleHeight) {
                        // Toggle the value
                        this.data[field] = !this.data[field];

                        // Trigger graph update
                        if (this.data.useUniform && this.graph && this.graph.onUniformValueChanged) {
                            this.graph.onUniformValueChanged(this);
                        } else if (this.graph && this.graph.onGraphChanged) {
                            this.graph.onGraphChanged();
                        }

                        return { type: 'TOGGLE_BOOL', node: this, field: field };
                    }

                    yOffset += 30;
                }
            }
        }

        // Fall back to parent implementation for text inputs
        return super._checkTextInputs ? super._checkTextInputs(x, y) : null;
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

        // Count text input fields (numeric only, not booleans)
        let textInputCount = 0;
        for (const field in this.data) {
            if (typeof this.data[field] === 'number') {
                textInputCount++;
            }
        }

        // Count boolean fields for toggle buttons (excluding 'useUniform')
        let boolInputCount = 0;
        for (const field in this.data) {
            if (field !== 'useUniform' && typeof this.data[field] === 'boolean') {
                boolInputCount++;
            }
        }

        const textInputHeight = textInputCount * 25;
        const boolInputHeight = boolInputCount * 30; // Toggles need more space

        // Small bottom padding to avoid cutting off the last element
        const bottomPadding = 3;

        this.height = baseHeight + textInputHeight + boolInputHeight + bottomPadding;
    }

    // Override to hide output port labels
    getOutputPortLabel() {
        return ''; // Hide output port labels for constant nodes
    }
}
