import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';
import { COLORS } from '../ui/theme.js';
import { drawLabel } from '../rendering/NodePainter.js';

/**
 * Node class for built-in library definitions (definition.isLibraryNode).
 * Same look as Node; adds:
 *  - int-typed inline fields for int inputs (float fields otherwise)
 *  - string text fields declared by definition.textFields ([{ key, label }]),
 *    drawn on extra rows below the ports (e.g. Swizzle's mask)
 */
export class LibraryNode extends Node {
    getTextFields() {
        return (this.definition && this.definition.textFields) || [];
    }

    getPortRowCount() {
        return Math.max(this.inputs.length, this.outputs.length, 1);
    }

    rebuildTextInputs() {
        if (!this.hasInputFields) return;
        this.textInputs = {};

        const inputTypes = {};
        for (const input of this.inputs) inputTypes[input.name] = input.type;
        // Inputs with an inline field by definition (numeric defaults). Other inputs may
        // also hold inline values (set through the automation API, e.g. a vec3 color
        // or a number broadcast to a vec2); they're compiled in but get no new field.
        const fieldDefaults = (this.definition && this.definition.data) || {};

        for (const field in this.data) {
            const value = this.data[field];
            if (typeof value !== 'number' || inputTypes[field] === undefined) continue;
            if (typeof fieldDefaults[field] !== 'number') continue;
            const type = inputTypes[field] === 'int' ? 'int' : 'float';
            const textInput = new CanvasTextInput(0, 0, 52, 16, type === 'int' ? String(Math.round(value)) : String(value), type);
            textInput.onChange = (newValue) => {
                const num = type === 'int' ? parseInt(newValue, 10) : parseFloat(newValue);
                if (!isNaN(num)) {
                    this.data[field] = num;
                    if (this.graph && this.graph.onGraphChanged) this.graph.onGraphChanged();
                }
            };
            this.textInputs[field] = textInput;
        }

        for (const f of this.getTextFields()) {
            const current = this.data[f.key] !== undefined ? this.data[f.key] : (f.default || '');
            const textInput = new CanvasTextInput(0, 0, 80, 16, String(current), 'text');
            textInput.onChange = (newValue) => {
                this.data[f.key] = String(newValue).trim();
                if (this.graph && this.graph.onGraphChanged) this.graph.onGraphChanged();
            };
            this.textInputs[f.key] = textInput;
        }
    }

    updateDimensions() {
        super.updateDimensions();
        const extra = this.getTextFields().length;
        if (extra && this.heightForRows) {
            this.height = this.heightForRows(this.getPortRowCount() + extra);
        }
    }

    updateTextInputPositions() {
        super.updateTextInputPositions();
        const fields = this.getTextFields();
        if (!fields.length || !this.textInputs) return;
        const base = this.getPortRowCount();
        fields.forEach((f, k) => {
            const textInput = this.textInputs[f.key];
            if (!textInput) return;
            const cy = this.getRowCenterY(base + k);
            textInput.x = this.x + 46;
            textInput.y = cy - 8;
            textInput.width = Math.max(40, this.width - 56);
            textInput.height = 16;
        });
    }

    drawBody(ctx, options = {}) {
        super.drawBody(ctx, options);
        const fields = this.getTextFields();
        if (!fields.length || !this.textInputs) return;
        this.updateTextInputPositions();
        const base = this.getPortRowCount();
        fields.forEach((f, k) => {
            const textInput = this.textInputs[f.key];
            if (!textInput) return;
            drawLabel(ctx, f.label || f.key, this.x + 10, this.getRowCenterY(base + k), COLORS.textFaint);
            textInput.draw(ctx, options);
        });
    }
}
