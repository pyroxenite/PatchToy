import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';
import { COLORS, FONTS, CANVAS, NODE_LAYOUT } from '../ui/theme.js';
import { drawInset, drawLabel, withAlpha } from '../rendering/NodePainter.js';

// Value changes closer than this are a scrub (see ConstantNode.inlineValueChanged)
const LIVE_EDIT_IDLE_MS = 400;

export class ConstantNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.width = 104; // Compact module
        this.fixedWidth = true;
        this.skipParentTextInputDraw = true; // We'll handle text input drawing ourselves
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

                        // If in uniform mode, update the uniform registry
                        if (this.data.useUniform) {
                            this.updateUniformRegistry();
                        } else {
                            // Otherwise recompile (constant mode with inline values)
                            this.inlineValueChanged();
                        }
                    }
                };
                // End of a scrub: compile the inline value back right away
                this.textInputs[field].onDragEnd = () => this.endLiveEdit();
            }
        }

        this.updateTextInputPositions();
    }

    /**
     * A value of an inline (non-uniform) constant changed. A single edit recompiles. Changes
     * in quick succession (scrubbing the field: one per mouse move) would relink the shaders
     * every frame, so the node compiles as a temporary uniform instead (liveUniform, one
     * relink) and every further change only updates the uniform. When the scrub ends (or
     * the changes stop for LIVE_EDIT_IDLE_MS) the inline literal is compiled back, so the
     * shader ends up exactly as an inline edit would leave it. Float / vector constants only
     * (an Int may be used where GLSL wants a constant expression).
     */
    inlineValueChanged() {
        const g = this.graph;
        if (!g || !g.onGraphChanged) return;
        const now = performance.now();
        const quick = now - (this._lastInlineChange || -1e9) < LIVE_EDIT_IDLE_MS;
        this._lastInlineChange = now;
        if (this.liveUniform) {
            this.updateUniformRegistry();
            if (g.onUniformValueChanged) g.onUniformValueChanged();
        } else if (quick && this.canCompileLive()) {
            this.liveUniform = true;
            g.onGraphChanged();
        } else {
            g.onGraphChanged();
        }
        if (this.liveUniform) this.scheduleLiveEnd();
    }

    /** Float / vector constant, components not wired, whose GLSL has the live uniform form. */
    canCompileLive() {
        const def = this.definition;
        if (this.fieldType === 'int' || this.fieldType === 'bool' || !def || !def.hasUniformToggle || typeof def.glsl !== 'function') return false;
        if (this.graph && this.graph.connections.some(c => c.toNode === this)) return false;
        this.liveUniform = true;
        try {
            const r = def.glsl(this, {});
            return !!(r && r.uniforms && r.uniforms.length);
        } catch (e) {
            return false;
        } finally {
            this.liveUniform = false;
        }
    }

    scheduleLiveEnd() {
        clearTimeout(this._liveTimer);
        this._liveTimer = setTimeout(() => {
            // Mouse held still mid-scrub: keep the uniform until the drag ends
            if (this.textInputs && Object.values(this.textInputs).some(t => t.isDragging)) this.scheduleLiveEnd();
            else this.endLiveEdit();
        }, LIVE_EDIT_IDLE_MS);
    }

    /** Back to the inline literal (recompiles once). */
    endLiveEdit() {
        clearTimeout(this._liveTimer);
        this._liveTimer = null;
        if (!this.liveUniform) return;
        this.liveUniform = false;
        const g = this.graph;
        if (g && g.onGraphChanged && g.nodes && g.nodes.includes(this)) g.onGraphChanged();
    }

    /** Numeric fields in row order (same order as the text inputs). */
    getFieldNames() {
        return this.textInputs ? Object.keys(this.textInputs) : [];
    }

    /** Vec nodes label each row with its component (x, y, z, w). */
    hasComponentLabels() {
        return this.inputs.length > 0;
    }

    updateTextInputPositions() {
        if (!this.textInputs) return;

        const fields = this.getFieldNames();
        const fieldH = NODE_LAYOUT.fieldHeight;
        const left = this.x + (this.hasComponentLabels() ? 22 : 10);
        const right = this.x + this.width - 12;

        for (let row = 0; row < fields.length; row++) {
            const input = this.textInputs[fields[row]];
            input.x = left;
            input.y = this.getRowCenterY(row) - fieldH / 2;
            input.width = right - left;
            input.height = fieldH;
        }
    }

    // Uniform-mode constants get the uniform accent (yellow) instead of the category color
    getAccentColor() {
        return this.data.useUniform ? CANVAS.uniform : super.getAccentColor();
    }

    drawBody(ctx, options = {}) {
        this.updateTextInputPositions();
        if (!this.hasInputFields) return;

        const uniform = !!this.data.useUniform;
        const fields = this.getFieldNames();
        for (let row = 0; row < fields.length; row++) {
            const field = fields[row];
            const input = this.textInputs[field];
            const cy = this.getRowCenterY(row);
            if (this.hasComponentLabels()) {
                drawLabel(ctx, field, this.x + 11, cy, uniform ? withAlpha(CANVAS.uniform, 0.7) : COLORS.textFaint);
            }
            if (this.isInputConnected(field)) {
                // Driven by a cable: show a dim placeholder instead of the value
                drawInset(ctx, input.x, input.y, input.width, input.height, { fill: COLORS.nodeBody, flat: true });
                drawLabel(ctx, 'linked', input.x + input.width / 2, cy, COLORS.textFaint, 'center');
            } else {
                input.valueColor = uniform ? CANVAS.uniform : null;
                input.draw(ctx, options);
            }
        }

        if (this.fieldType === 'bool') {
            this.drawBooleanToggles(ctx, options);
        }
    }

    // Check if a specific input field is connected
    isInputConnected(fieldName) {
        if (!this.graph || !this.inputs) return false;

        // Find the input index for this field name
        const inputIndex = this.inputs.findIndex(inp => inp.name === fieldName);
        if (inputIndex === -1) return false;

        // Check if there's a connection to this input
        return this.graph.connections.some(conn =>
            conn.toNode === this && conn.toInput === inputIndex
        );
    }

    /** Rect of the bool switch on body row `row`. */
    getBoolToggleRect(row) {
        return {
            x: this.x + 10,
            y: this.getRowCenterY(row) - NODE_LAYOUT.fieldHeight / 2,
            w: this.width - 22,
            h: NODE_LAYOUT.fieldHeight
        };
    }

    /** Boolean fields (excluding the uniform flag), in row order after numeric fields. */
    getBoolFieldNames() {
        const names = [];
        for (const field in this.data) {
            if (field !== 'useUniform' && typeof this.data[field] === 'boolean') names.push(field);
        }
        return names;
    }

    drawBooleanToggles(ctx, options = {}) {
        const bools = this.getBoolFieldNames();
        const firstRow = this.getFieldNames().length;
        const uniform = !!this.data.useUniform;
        const onColor = uniform ? CANVAS.uniform : this.getAccentColor();

        for (let i = 0; i < bools.length; i++) {
            const value = !!this.data[bools[i]];
            const r = this.getBoolToggleRect(firstRow + i);
            const hovered = this.isHoveringRect(options, r);

            // Whole row is an inset well; the switch sits on the left
            drawInset(ctx, r.x, r.y, r.w, r.h, { border: hovered ? CANVAS.insetHover : undefined });
            const trackX = r.x + 3, trackY = r.y + 3, trackW = 20, trackH = r.h - 6;
            ctx.fillStyle = value ? withAlpha(onColor, 0.3) : COLORS.raised;
            ctx.fillRect(trackX, trackY, trackW, trackH);
            const knob = trackH;
            ctx.fillStyle = value ? onColor : COLORS.textFaint;
            ctx.fillRect(value ? trackX + trackW - knob : trackX, trackY, knob, knob);

            ctx.font = FONTS.value;
            ctx.fillStyle = value ? (uniform ? CANVAS.uniform : COLORS.text) : COLORS.textDim;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(value ? 'true' : 'false', Math.round(trackX + trackW + 7), Math.round(r.y + r.h / 2 + 3));
        }
    }

    getControlCursor(x, y) {
        if (this.fieldType === 'bool') {
            const bools = this.getBoolFieldNames();
            const firstRow = this.getFieldNames().length;
            for (let i = 0; i < bools.length; i++) {
                const r = this.getBoolToggleRect(firstRow + i);
                if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'pointer';
            }
        }
        return super.getControlCursor(x, y);
    }

    // Override to handle boolean toggle clicks
    _checkTextInputs(x, y) {
        // Check boolean toggles first
        if (this.fieldType === 'bool') {
            const bools = this.getBoolFieldNames();
            const firstRow = this.getFieldNames().length;

            for (let i = 0; i < bools.length; i++) {
                const field = bools[i];
                const r = this.getBoolToggleRect(firstRow + i);

                // Check if click is within toggle bounds
                if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                    // Toggle the value
                    this.data[field] = !this.data[field];

                    // Trigger graph update
                    if (this.data.useUniform) {
                        this.updateUniformRegistry();
                    } else if (this.graph && this.graph.onGraphChanged) {
                        this.graph.onGraphChanged();
                    }

                    return { type: 'TOGGLE_BOOL', node: this, field: field };
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
        // Align each component input with its value field row
        const input = this.inputs[index];
        const row = input ? this.getFieldNames().indexOf(input.name) : -1;
        return {
            x: this.x,
            y: this.getRowCenterY(row >= 0 ? row : index)
        };
    }

    // Component names are drawn next to the fields instead
    getInputPortLabel() {
        return '';
    }

    /**
     * Update the uniform registry with this node's current values
     * Called when values change in uniform mode
     *
     * Note: This finds the uniform by looking up what name this node
     * was compiled with (using the nodeIdRemap), then updates just the value.
     */
    updateUniformRegistry() {
        if (!this.graph || !this.graph.uniformRegistry) {
            return;
        }

        // Find all uniforms that belong to this node (by sourceNodeId)
        const allUniforms = this.graph.uniformRegistry.getAllUniforms();
        for (const uniform of allUniforms) {
            if (uniform.sourceNodeId === this.id) {
                // Update the value for this uniform
                const glslResult = this.definition.glsl(this, {});
                if (glslResult && glslResult.uniforms && glslResult.uniforms.length > 0) {
                    // Get the new value
                    const newValue = glslResult.uniforms[0].value;

                    // Update in registry (using the REMAPPED name)
                    this.graph.uniformRegistry.registerUniform(
                        uniform.name,  // Use the remapped name from compilation
                        uniform.type,
                        newValue,
                        this
                    );
                }
            }
        }
    }

    /**
     * Unregister this node's uniforms (called when switching to constant mode or deleting)
     */
    unregisterUniforms() {
        if (!this.graph || !this.graph.uniformRegistry || !this.definition) {
            return;
        }

        const glslResult = this.definition.glsl(this, {});
        if (glslResult && glslResult.uniforms && glslResult.uniforms.length > 0) {
            for (const uniform of glslResult.uniforms) {
                this.graph.uniformRegistry.unregisterUniform(uniform.name);
            }
        }
    }

    updateDimensions() {
        // One row per numeric field + one per boolean switch
        let rows = 0;
        for (const field in this.data) {
            const v = this.data[field];
            if (typeof v === 'number') rows++;
            else if (field !== 'useUniform' && typeof v === 'boolean') rows++;
        }
        this.height = this.heightForRows(Math.max(1, rows));
    }

    // Override to hide output port labels
    getOutputPortLabel() {
        return ''; // Hide output port labels for constant nodes
    }
}
