import { NodeDefinitions } from '../core/NodeDefinitions.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';

export class Node {
    constructor(id, type, x, y) {
        this.id = id;
        this.type = type;
        this.x = x;
        this.y = y;
        this.width = 150;
        this.height = 80;
        this.inputs = [];
        this.outputs = [];
        this.selected = false;
        this.hasError = false;
        this.data = {};
        this.textInputs = {};
        this.previewInstance = null;
        this.varName = `node_${id}`; // Unique variable name for shader compilation

        this.applyDefinition();
    }

    serialize() {
        return {
            id: this.id,
            type: this.type,
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
            data: { ...this.data }
        };
    }

    // Note: deserialize is handled in NodeGraph.js to avoid circular dependencies

    draw(ctx, options = {}) {
        const { isSelected = false } = options;

        // Save context state before drawing
        ctx.save();

        // Draw shadow first (behind the node)
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 4;

        // Node body - matching floating toolbar style
        ctx.fillStyle = 'rgba(45, 45, 45, 0.95)';

        // Draw node background with shadow
        ctx.beginPath();
        ctx.roundRect(this.x, this.y, this.width, this.height, 8);
        ctx.fill();

        // Restore context to clean state (removes all shadows and transformations)
        ctx.restore();

        // Now draw border without shadow (after restore to ensure clean state)
        // Determine border color and width
        let borderColor, borderWidth;
        if (this.hasError) {
            borderColor = '#f44336';
            borderWidth = 2;
        } else if (isSelected) {
            borderColor = '#007acc';
            borderWidth = 2;
        } else {
            borderColor = 'rgba(68, 68, 68, 0.5)';
            borderWidth = 1;
        }

        ctx.strokeStyle = borderColor;
        ctx.lineWidth = borderWidth;

        // Draw border (clean state, no shadow)
        ctx.beginPath();
        ctx.roundRect(this.x, this.y, this.width, this.height, 8);
        ctx.stroke();

        // Normal node header (textBaseline inherited from context - should be 'alphabetic' from main.js)
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px bold "Pixeloid Sans"';;
        ctx.fillText(this.type, this.x + 10, this.y + 18);

        // Color picker content
        if (this.hasColorPicker && this.data.r !== undefined) {
            const colorX = this.x + 10;
            const colorY = this.y + 35;
            const colorWidth = this.width - 20;
            const colorHeight = 40;

            const r = Math.floor(this.data.r * 255);
            const g = Math.floor(this.data.g * 255);
            const b = Math.floor(this.data.b * 255);

            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.fillRect(colorX, colorY, colorWidth, colorHeight);

            ctx.strokeStyle = '#444';
            ctx.lineWidth = 1;
            ctx.strokeRect(colorX, colorY, colorWidth, colorHeight);
        }

        // Inputs
        ctx.textBaseline = 'middle'; // Center text vertically on ports
        for (let i = 0; i < this.inputs.length; i++) {
            const pos = this.getInputPortPosition(i);
            if (!pos) continue; // Skip if port is hidden (e.g., in uniform mode)

            ctx.fillStyle = '#007acc';
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#aaa';
            ctx.font = '11px "Pixeloid Mono"';
            ctx.fillText(this.inputs[i].name, pos.x + 10, pos.y);
        }

        // Outputs
        for (let i = 0; i < this.outputs.length; i++) {
            const pos = this.getOutputPortPosition(i);
            ctx.fillStyle = '#007acc';
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#aaa';
            ctx.font = '11px "Pixeloid Mono"';
            const label = this.outputs[i].name;
            const labelWidth = ctx.measureText(label).width;
            ctx.fillText(label, pos.x - labelWidth - 10, pos.y);
        }

        // Draw text inputs
        if (this.hasInputFields && this.textInputs) {
            for (const field of Object.keys(this.data)) {
                const input = this.textInputs[field];
                if (input) {
                    input.draw(ctx);
                }
            }
        }

        // Draw uniform toggle button
        if (this.hasUniformToggle) {
            const toggleSize = 16;
            const toggleX = this.x + this.width - toggleSize - 6;
            const toggleY = this.y + 6;

            // Button background
            ctx.fillStyle = this.data.useUniform ? '#007acc' : '#444';
            ctx.beginPath();
            ctx.roundRect(toggleX, toggleY, toggleSize, toggleSize, 3);
            ctx.fill();

            // "U" label
            ctx.fillStyle = '#fff';
            ctx.font = '11px "Pixeloid Mono"';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('U', toggleX + toggleSize / 2, toggleY + toggleSize / 2);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
        }
    }

    applyDefinition() {
        const def = NodeDefinitions[this.type];
        if (!def) {
            console.warn(`Unknown node type: ${this.type}`);
            return;
        }

        this.definition = def;
        this.inputs = def.inputs ? [...def.inputs] : [];
        this.outputs = def.outputs ? [...def.outputs] : [];
        this.isOutputNode = def.isOutputNode || false;
        this.isPreviewNode = def.isPreviewNode || false;
        this.hasInputFields = def.hasInputFields || false;
        this.hasColorPicker = def.hasColorPicker || false;
        this.hasUniformToggle = def.hasUniformToggle || false;

        // Initialize data from definition.data (for Vec2/Vec3/Vec4/etc nodes)
        if (def.data) {
            for (const key in def.data) {
                if (this.data[key] === undefined) {
                    this.data[key] = def.data[key];
                }
            }
        }

        // Initialize data from input defaults
        if (this.hasInputFields) {
            for (const input of this.inputs) {
                if (input.default !== undefined && this.data[input.name] === undefined) {
                    this.data[input.name] = input.default;
                }
            }
            this.rebuildTextInputs();
        }

        // Initialize color picker data
        if (this.hasColorPicker && !this.data.r) {
            this.data.r = 1.0;
            this.data.g = 0.5;
            this.data.b = 0.0;
        }

        this.updateDimensions();
    }

    rebuildTextInputs() {
        if (!this.hasInputFields) return;

        this.textInputs = {};

        // Create text inputs for all data fields (Float, Vec nodes)
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
                        this.data[field] = numValue;
                        if (this.graph && this.graph.onGraphChanged) {
                            this.graph.onGraphChanged();
                        }
                    }
                };
            }
        }
    }

    updateDimensions() {
        const baseHeight = 30;
        const inputHeight = Math.max(this.inputs.length, this.outputs.length) * 25;
        const colorPickerHeight = this.hasColorPicker ? 50 : 0;

        // Count text input fields from data object
        let textInputCount = 0;
        if (this.hasInputFields) {
            for (const field in this.data) {
                if (typeof this.data[field] === 'number') {
                    textInputCount++;
                }
            }
        }
        const textInputHeight = textInputCount * 25;

        this.height = Math.max(60, baseHeight + inputHeight + colorPickerHeight + textInputHeight);
    }

    updateTextInputPositions() {
        if (!this.hasInputFields) return;

        let yOffset = this.y + 35;
        if (this.hasColorPicker) yOffset += 50;

        for (const input of this.inputs) {
            const textInput = this.textInputs[input.name];
            if (textInput) {
                // Position text input to the right of the input port
                const portPos = this.getInputPortPosition(this.inputs.indexOf(input));
                textInput.x = portPos.x + 15;
                textInput.y = portPos.y - 10;
            }
        }
    }

    containsPoint(x, y) {
        return x >= this.x && x <= this.x + this.width &&
            y >= this.y && y <= this.y + this.height;
    }

    getResizeEdge(x, y) {
        // Base nodes are not resizable (override in subclasses)
        return null;
    }

    getCursorForEdge(edge) {
        return 'default';
    }

    getInputPortPosition(index) {
        const portSpacing = (this.height - 20) / (this.inputs.length + 1);
        return {
            x: this.x,
            y: this.y + 20 + portSpacing * (index + 1)
        };
    }

    getOutputPortPosition(index) {
        const portSpacing = (this.height - 20) / (this.outputs.length + 1);
        return {
            x: this.x + this.width,
            y: this.y + 20 + portSpacing * (index + 1)
        };
    }

    /**
     * Event handling methods - each returns an action object or null
     * This allows components to handle their own hit testing and logic
     */

    handleMouseDown(x, y, event) {
        // Check uniform toggle button first
        if (this.hasUniformToggle) {
            if (this._checkAndHandleUniformToggle(x, y)) {
                return { handled: true, needsRender: true, needsGraphChange: true };
            }
        }

        // Check color picker swatch
        if (this.hasColorPicker && this.data.r !== undefined) {
            if (this._checkAndHandleColorPicker(x, y, event)) {
                return { handled: true };
            }
        }

        // Check text inputs
        if (this.hasInputFields && this.textInputs) {
            const action = this._checkTextInputs(x, y);
            if (action) return action;
        }

        // Check resize edges
        const resizeEdge = this.getResizeEdge(x, y);
        if (resizeEdge) {
            return {
                type: 'START_RESIZE',
                node: this,
                edge: resizeEdge,
                cursor: this.getCursorForEdge(resizeEdge)
            };
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

        // Check input ports
        for (let i = 0; i < this.inputs.length; i++) {
            const portPos = this.getInputPortPosition(i);
            if (!portPos) continue;

            const dist = Math.hypot(x - portPos.x, y - portPos.y);
            if (dist < 8) {
                return {
                    type: 'CLICKED_INPUT_PORT',
                    node: this,
                    inputIndex: i
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

    handleMouseMove(x, y, activeAction) {
        // Update cursor for resize edges even when not actively resizing
        if (!activeAction) {
            const resizeEdge = this.getResizeEdge(x, y);
            if (resizeEdge) {
                return {
                    type: 'UPDATE_CURSOR',
                    cursor: this.getCursorForEdge(resizeEdge)
                };
            }
        }

        return null;
    }

    handleMouseUp(x, y) {
        // Override in subclasses if needed
        return null;
    }

    _checkAndHandleUniformToggle(x, y) {
        const toggleSize = 16;
        const toggleX = this.x + this.width - toggleSize - 6;
        const toggleY = this.y + 6;

        if (x >= toggleX && x <= toggleX + toggleSize &&
            y >= toggleY && y <= toggleY + toggleSize) {
            // Handle toggle internally
            const wasUniform = this.data.useUniform;
            this.data.useUniform = !this.data.useUniform;

            // If switching TO uniform mode, disconnect all inputs
            if (!wasUniform && this.data.useUniform && this.graph) {
                this.graph.connections = this.graph.connections.filter(conn => conn.toNode !== this);
                console.log('Disconnected inputs when switching to uniform mode');
            }

            return true;
        }
        return false;
    }

    _checkAndHandleColorPicker(x, y, event) {
        const colorX = this.x + 10;
        const colorY = this.y + 35;
        const colorWidth = this.width - 20;
        const colorHeight = 40;

        if (x >= colorX && x <= colorX + colorWidth &&
            y >= colorY && y <= colorY + colorHeight) {
            // Call graph's callback which has access to color picker UI
            if (this.graph && this.graph.onNodeRightClick) {
                this.graph.onNodeRightClick(this, event);
            }
            return true;
        }
        return false;
    }

    _checkTextInputs(x, y) {
        for (const [field, input] of Object.entries(this.textInputs)) {
            if (input.containsPoint(x, y)) {
                return {
                    type: 'INTERACT_TEXT_INPUT',
                    node: this,
                    input: input,
                    field: field,
                    x: x,
                    y: y
                };
            }
        }
        return null;
    }
}
