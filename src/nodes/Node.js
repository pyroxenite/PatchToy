import { NodeDefinitions } from '../core/NodeDefinitions.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';
import { COLORS, FONTS, LAYOUT, CANVAS, NODE_LAYOUT } from '../ui/theme.js';
import {
    drawNodeBase, drawNodeBorder, drawTitle, drawTag, drawLabel, drawPort, drawIcon, iconSize, drawLed,
    portColor, nodeAccent, prettyTitle, measure, getFontEpoch,
    PORT_NORMAL, PORT_HOT, PORT_DIM
} from '../rendering/NodePainter.js';

import { portShape } from '../core/control/rates.js';
import { formatValue } from '../core/control/vmath.js';

const HEADER_H = LAYOUT.headerHeight;
const ROW_H = LAYOUT.portSpacing;

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
            data: { ...this.data }
        };
    }

    // Note: deserialize is handled in NodeGraph.js to avoid circular dependencies

    // ------------------------------------------------------------------
    // Geometry — single source of truth for drawing AND hit-testing.
    // Header is LAYOUT.headerHeight tall; body rows are LAYOUT.portSpacing
    // tall and start NODE_LAYOUT.bodyPadTop below the header. Input i and
    // output i sit on row i (left / right edge).
    // ------------------------------------------------------------------

    /** Y of the vertical center of body row `row`. */
    getRowCenterY(row) {
        return this.y + HEADER_H + NODE_LAYOUT.bodyPadTop + ROW_H * row + ROW_H / 2;
    }

    /** Node height for a body of `rows` rows plus `extra` px of custom content. */
    heightForRows(rows, extra = 0) {
        return HEADER_H + NODE_LAYOUT.bodyPadTop + ROW_H * Math.max(0, rows) + extra + NODE_LAYOUT.bodyPadBottom;
    }

    /** Right-aligned header tag rect (offset shifts it left for a second tag). */
    getHeaderTagRect(width = 14, offset = 0) {
        return { x: this.x + this.width - 7 - width - offset, y: this.y + 7, w: width, h: 13 };
    }

    getUniformToggleRect() {
        return this.getHeaderTagRect(14);
    }

    /** Legacy swatch area for definitions with hasColorPicker (ColorNode overrides). */
    getColorSwatchRect() {
        return {
            x: this.x + 8,
            y: this.y + this.height - NODE_LAYOUT.bodyPadBottom - 42,
            w: this.width - 16,
            h: 42
        };
    }

    getDisplayTitle() {
        return (this.definition && this.definition.displayTitle) || prettyTitle(this.type);
    }

    getAccentColor() {
        return nodeAccent(this);
    }

    /** Output type with dynamic ('any') outputs resolved after compilation. */
    getOutputPortType(index) {
        const out = this.outputs[index];
        const t = out ? out.type : null;
        if ((!t || t === 'any') && this.resolvedOutputType) return this.resolvedOutputType;
        return t;
    }

    /**
     * Whether a port has a cable. The graph renderer stamps ports once per
     * frame (O(connections)); outside of it we fall back to a scan.
     */
    isPortConnected(kind, index) {
        if (this._renderStamp !== undefined) {
            const arr = kind === 'in' ? this._inLinks : this._outLinks;
            return !!arr && arr[index] === this._renderStamp;
        }
        const conns = this.graph && this.graph.connections;
        if (!conns) return false;
        for (const c of conns) {
            if (kind === 'in' ? (c.toNode === this && c.toInput === index)
                : (c.fromNode === this && c.fromOutput === index)) return true;
        }
        return false;
    }

    /** Is the (world-space) mouse inside rect? Used for hover styling only. */
    isHoveringRect(options, rect, pad = 0) {
        if (!options || options.mouseX === undefined || !rect) return false;
        const mx = options.mouseX, my = options.mouseY;
        return mx >= rect.x - pad && mx <= rect.x + rect.w + pad && my >= rect.y - pad && my <= rect.y + rect.h + pad;
    }

    /**
     * Grow (never shrink below the class default) so title and port labels fit.
     * Subclasses with bespoke layouts set this.fixedWidth = true.
     */
    fitWidthToContent(ctx) {
        if (this.fixedWidth) return;
        const epoch = getFontEpoch();
        if (this._fitEpoch === epoch && this._fitIns === this.inputs && this._fitInLen === this.inputs.length &&
            this._fitOuts === this.outputs && this._fitOutLen === this.outputs.length && this._fitType === this.type) {
            return;
        }
        if (this._baseWidth === undefined) this._baseWidth = this.width;

        let need = measure(ctx, FONTS.titleBold, this.getDisplayTitle()) + 20 + (this.hasUniformToggle ? 22 : 0) +
            (this.definition && this.definition.isCustomNode ? 38 : 0);
        const rows = Math.max(this.inputs.length, this.outputs.length);
        for (let r = 0; r < rows; r++) {
            const inL = r < this.inputs.length ? (this.getInputPortLabel ? this.getInputPortLabel(r) : this.inputs[r].name) : null;
            const outL = r < this.outputs.length ? (this.getOutputPortLabel ? this.getOutputPortLabel(r) : this.outputs[r].name) : null;
            let w = 24;
            if (inL) w += measure(ctx, FONTS.title, inL);
            if (outL) w += measure(ctx, FONTS.title, outL);
            if (inL && outL) w += 16;
            if (this.hasInputFields && r < this.inputs.length && this.textInputs && this.textInputs[this.inputs[r].name]) w += 60;
            if (w > need) need = w;
        }
        this.width = Math.max(this._baseWidth, Math.ceil(need / 2) * 2);

        this._fitEpoch = epoch;
        this._fitIns = this.inputs;
        this._fitInLen = this.inputs.length;
        this._fitOuts = this.outputs;
        this._fitOutLen = this.outputs.length;
        this._fitType = this.type;
    }

    // ------------------------------------------------------------------
    // Drawing
    // options: { isSelected, isHovered, mouseX, mouseY (world), drag, hoverPort, time, zoom }
    // ------------------------------------------------------------------

    draw(ctx, options = {}) {
        const selected = !!options.isSelected;
        this.fitWidthToContent(ctx);
        drawNodeBase(ctx, this.x, this.y, this.width, this.height, {
            selected,
            accent: this.getAccentColor()
        });
        this.drawHeader(ctx, options);
        this.drawBody(ctx, options);
        drawNodeBorder(ctx, this.x, this.y, this.width, this.height, {
            selected,
            error: this.isInErrorState(),
            hovered: options.isHovered
        });
        this.drawPorts(ctx, options);
    }

    /**
     * Error styling (red outline + badge). Subclasses may add their own error sources.
     * _ctlError: the node runs at control rate (src/core/control) and failed this frame,
     * e.g. a division by zero gave Infinity.
     */
    isInErrorState() {
        return !!this.hasError || !!this._ctlError;
    }

    /** Optional pixel icon shown before the title (name from NodePainter ICONS). */
    getHeaderIcon() {
        return null;
    }

    /** Title (with optional icon) + right-aligned header tags. */
    drawHeader(ctx, options = {}) {
        const tagsLeft = this.drawHeaderTags(ctx, options);
        let tx = this.x + 9;
        const icon = this.getHeaderIcon();
        if (icon) {
            const s = iconSize(icon);
            drawIcon(ctx, icon, tx, this.y + 14 - Math.ceil(s.h / 2), this.getAccentColor());
            tx += s.w + 5;
        }
        drawTitle(ctx, this.getDisplayTitle(), tx, this.y, tagsLeft - tx - 6);
    }

    /** Status LED at the right of the header; returns its left x. */
    drawHeaderLed(ctx, on, color, offset = 0) {
        const cx = this.x + this.width - 12 - offset;
        drawLed(ctx, cx, this.y + 13.5, on, color);
        return cx - 4;
    }

    /**
     * Cursor for interactive controls under (x, y), or null.
     * Base: header uniform tag and inline fields.
     */
    getControlCursor(x, y) {
        if (this.hasUniformToggle) {
            const t = this.getUniformToggleRect();
            if (x >= t.x - 3 && x <= t.x + t.w + 3 && y >= t.y - 3 && y <= t.y + t.h + 3) return 'pointer';
        }
        if (this.hasInputFields && this.textInputs) {
            for (const key in this.textInputs) {
                const input = this.textInputs[key];
                if (input && input.containsPoint(x, y)) {
                    return input.focused ? 'text' : (input.type === 'text' ? 'text' : 'ew-resize');
                }
            }
        }
        return null;
    }

    /** Draw header tags; returns the left-most x used (title must stop before it). */
    drawHeaderTags(ctx, options = {}) {
        if (this.hasUniformToggle) {
            const r = this.getUniformToggleRect();
            drawTag(ctx, r, 'U', !!this.data.useUniform, CANVAS.uniform, {
                hovered: this.isHoveringRect(options, r, 2)
            });
            return r.x;
        }
        // Custom GLSL nodes get a "glsl" tag, like a Param's kind tag
        if (this.definition && this.definition.isCustomNode) {
            const r = { x: this.x + this.width - 7 - 32, y: this.y + 7, w: 32, h: 13 };
            drawTag(ctx, r, 'glsl', false, CANVAS.uniform, { hovered: this.isHoveringRect(options, r, 2) });
            return r.x;
        }
        return this.x + this.width - 4;
    }

    /** Body content between header and border. Base: inline fields / legacy swatch. */
    drawBody(ctx, options = {}) {
        if (this.hasColorPicker && this.data.r !== undefined) {
            const s = this.getColorSwatchRect();
            const r = Math.floor(this.data.r * 255);
            const g = Math.floor(this.data.g * 255);
            const b = Math.floor(this.data.b * 255);
            ctx.beginPath();
            ctx.roundRect(s.x, s.y, s.w, s.h, 3);
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.fill();
        }

        if (this.hasInputFields && this.textInputs && !this.skipParentTextInputDraw) {
            this.updateTextInputPositions();
            for (let i = 0; i < this.inputs.length; i++) {
                const input = this.textInputs[this.inputs[i].name];
                if (input && !this.isPortConnected('in', i)) {
                    input.draw(ctx, options);
                }
            }
        }
    }

    /** Port state for styling: hovered / drag-compatible / dimmed. */
    getPortDrawState(kind, index, type, options) {
        const drag = options.drag;
        const hp = options.hoverPort;
        if (drag) {
            if (drag.node === this) {
                const isOrigin = drag.reverse ? (kind === 'in' && index === drag.index)
                    : (kind === 'out' && index === drag.index);
                return isOrigin ? PORT_HOT : PORT_DIM;
            }
            if (!drag.accepts(kind, type)) return PORT_DIM;
            if (drag.acceptsPort && !drag.acceptsPort(this, kind, index)) return PORT_DIM; // rate rules
        }
        if (hp && hp.node === this && hp.kind === kind && hp.index === index) return PORT_HOT;
        return PORT_NORMAL;
    }

    /** Port shape from the control plan: circle (pixel), diamond (control), event. */
    getPortShape(kind, index) {
        const plan = this.graph && this.graph._controlPlan;
        return plan ? portShape(plan, this, kind, index) : 'circle';
    }

    drawPorts(ctx, options = {}) {
        for (let i = 0; i < this.inputs.length; i++) {
            const pos = this.getInputPortPosition(i);
            if (!pos) continue; // hidden (e.g. uniform mode)
            const type = this.inputs[i].type;
            const connected = this.isPortConnected('in', i);
            const state = this.getPortDrawState('in', i, type, options);
            const label = this.getInputPortLabel ? this.getInputPortLabel(i) : this.inputs[i].name;
            if (label) {
                drawLabel(ctx, label, pos.x + 10, pos.y, state === PORT_DIM ? COLORS.textFaint : COLORS.textDim);
            }
            // 'any' inputs take the color of whatever is patched into them
            const shownType = (type === 'any' && connected && this._inLinkTypes) ? this._inLinkTypes[i] : type;
            drawPort(ctx, pos.x, pos.y, portColor(shownType), connected, state, this.getPortShape('in', i));
        }

        for (let i = 0; i < this.outputs.length; i++) {
            const pos = this.getOutputPortPosition(i);
            if (!pos) continue;
            const type = this.getOutputPortType(i);
            const state = this.getPortDrawState('out', i, type, options);
            const label = this.getOutputPortLabel ? this.getOutputPortLabel(i) : this.outputs[i].name;
            if (label) {
                drawLabel(ctx, label, pos.x - 10, pos.y, state === PORT_DIM ? COLORS.textFaint : COLORS.textDim, 'right');
            }
            drawPort(ctx, pos.x, pos.y, portColor(type), this.isPortConnected('out', i), state, this.getPortShape('out', i));
        }
        this.drawControlValues(ctx);
    }

    /**
     * Math / vector nodes running at control rate show their live output values
     * (left of the output labels; below the node when it has no labels).
     */
    drawControlValues(ctx) {
        const plan = this.graph && this.graph._controlPlan;
        const out = this._ctlOut;
        if (!plan || !out || this.isControlNode || plan.kindOf(this) !== 'infer' || plan.rateOf(this) !== 'control') return;
        const info = plan.info.get(this);
        ctx.font = FONTS.value;
        ctx.textBaseline = 'alphabetic';
        for (let i = 0; i < this.outputs.length; i++) {
            const pos = this.getOutputPortPosition(i);
            if (!pos) continue;
            const t = info && info.outTypes ? info.outTypes[i] : this.outputs[i].type;
            const text = formatValue(out[i], t, 2);
            const label = this.getOutputPortLabel ? this.getOutputPortLabel(i) : this.outputs[i].name;
            if (!label) {
                // Compact nodes (operators): one value under the node
                if (i > 0) break;
                ctx.textAlign = 'center';
                ctx.fillStyle = COLORS.textDim;
                ctx.fillText(text.length > 18 ? text.slice(0, 17) + '…' : text, Math.round(this.x + this.width / 2), Math.round(this.y + this.height + 11));
                ctx.textAlign = 'left';
                continue;
            }
            if (this.textInputs && this.inputs[i] && this.textInputs[this.inputs[i].name] && !this.isPortConnected('in', i)) continue; // inline field on this row
            const labelW = measure(ctx, FONTS.title, label);
            const inLabel = this.inputs[i] ? (this.getInputPortLabel ? this.getInputPortLabel(i) : this.inputs[i].name) : '';
            const inW = inLabel ? measure(ctx, FONTS.title, inLabel) + 16 : 0;
            const maxW = this.width - 26 - labelW - inW;
            if (maxW < 22) continue;
            ctx.font = FONTS.value;
            const shown = measure(ctx, FONTS.value, text) > maxW ? text.slice(0, Math.max(1, Math.floor(maxW / 6) - 1)) + '…' : text;
            ctx.textAlign = 'right';
            ctx.fillStyle = COLORS.textFaint;
            ctx.fillText(shown, Math.round(pos.x - 14 - labelW), Math.round(pos.y + 3));
            ctx.textAlign = 'left';
        }
    }

    applyDefinition() {
        const def = NodeDefinitions[this.type];
        if (!def) {
            console.warn(`Unknown node type: ${this.type}`);
            return;
        }

        this.definition = def;
        // Clone port objects: the compiler resolves 'any' output types per node
        // instance, which must never leak back into the shared definition.
        this.inputs = def.inputs ? def.inputs.map(p => ({ ...p })) : [];
        this.outputs = def.outputs ? def.outputs.map(p => ({ ...p })) : [];
        this.isOutputNode = def.isOutputNode || false;
        this.isPreviewNode = def.isPreviewNode || false;
        this.hasInputFields = def.hasInputFields || false;
        this.hasColorPicker = def.hasColorPicker || false;
        this.hasUniformToggle = def.hasUniformToggle || false;
        this.fieldType = def.fieldType || 'float';
        this.isDynamicInput = def.isDynamicInput || false;
        this.minInputs = def.minInputs || 0;
        this.resolvedOutputType = null; // Will be set during type validation

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
        // One row per port pair; inline fields share their input's row
        const rows = Math.max(this.inputs.length, this.outputs.length, 1);
        const colorPickerHeight = this.hasColorPicker ? 48 : 0;
        this.height = this.heightForRows(rows, colorPickerHeight);
    }

    updateTextInputPositions() {
        if (!this.hasInputFields || !this.textInputs) return;

        // Inline field sits on its input's row, right-aligned in the body
        const fieldW = 52;
        const fieldH = NODE_LAYOUT.fieldHeight;
        for (let i = 0; i < this.inputs.length; i++) {
            const textInput = this.textInputs[this.inputs[i].name];
            if (!textInput) continue;
            const portPos = this.getInputPortPosition(i);
            if (!portPos) continue;
            const rightPad = i < this.outputs.length ? 40 : 10;
            textInput.width = fieldW;
            textInput.height = fieldH;
            textInput.x = this.x + this.width - rightPad - fieldW;
            textInput.y = portPos.y - fieldH / 2;
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
        return {
            x: this.x,
            y: this.getRowCenterY(index)
        };
    }

    getOutputPortPosition(index) {
        return {
            x: this.x + this.width,
            y: this.getRowCenterY(index)
        };
    }

    /**
     * Event handling methods - each returns an action object or null
     * This allows components to handle their own hit testing and logic
     */

    handleMouseDown(x, y, event) {
        // Make sure inline field rects match the current node position
        if (this.hasInputFields && this.updateTextInputPositions) {
            this.updateTextInputPositions();
        }

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

        // Note: Port checking is now handled by NodeGraph before this method is called
        // This ensures ports work even when they extend beyond node bounds

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
            if (this.hasInputFields && this.updateTextInputPositions) {
                this.updateTextInputPositions();
            }
            const cursor = this.getControlCursor(x, y);
            if (cursor) {
                return { type: 'UPDATE_CURSOR', cursor };
            }
        }

        return null;
    }

    handleMouseUp(x, y) {
        // Override in subclasses if needed
        return null;
    }

    _checkAndHandleUniformToggle(x, y) {
        const t = this.getUniformToggleRect();
        const pad = 3; // slightly generous hit area around the small header tag

        if (x >= t.x - pad && x <= t.x + t.w + pad &&
            y >= t.y - pad && y <= t.y + t.h + pad) {
            // Handle toggle internally
            const wasUniform = this.data.useUniform;
            this.data.useUniform = !this.data.useUniform;

            // If switching TO uniform mode, disconnect all inputs and register uniforms
            if (!wasUniform && this.data.useUniform && this.graph) {
                this.graph.connections = this.graph.connections.filter(conn => conn.toNode !== this);

                // Register uniforms if this is a constant node
                if (this.updateUniformRegistry) {
                    this.updateUniformRegistry();
                }

                // Trigger recompilation to add uniform to shader
                if (this.graph.onGraphChanged) {
                    this.graph.onGraphChanged();
                }
            }

            // If switching FROM uniform mode, unregister uniforms
            if (wasUniform && !this.data.useUniform && this.graph) {
                if (this.unregisterUniforms) {
                    this.unregisterUniforms();
                }

                // Trigger recompilation to remove uniform from shader
                if (this.graph.onGraphChanged) {
                    this.graph.onGraphChanged();
                }
            }

            return true;
        }
        return false;
    }

    _checkAndHandleColorPicker(x, y, event) {
        const s = this.getColorSwatchRect();

        if (x >= s.x && x <= s.x + s.w &&
            y >= s.y && y <= s.y + s.h) {
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

    // Dynamic input management for nodes like Blend
    addDynamicInput() {
        if (!this.isDynamicInput) return false;

        // Find the next available input index
        // For Blend node, inputs are named with just numbers: '0', '1', '2', etc.
        let nextIndex = 0;
        while (this.inputs.some(input => input.name === `${nextIndex}`)) {
            nextIndex++;
        }

        // Add new input
        const newInput = {
            name: `${nextIndex}`,
            type: 'any',
            default: null,
            optional: true
        };

        this.inputs.push(newInput);
        this.updateDimensions();

        return true;
    }

    removeDynamicInput(inputName) {
        if (!this.isDynamicInput) return false;

        // Don't allow removing below minimum inputs
        // Blend inputs are numeric (excluding 'index')
        const blendInputCount = this.inputs.filter(i => i.name !== 'index' && /^\d+$/.test(i.name)).length;
        if (blendInputCount <= this.minInputs) return false;

        const inputIndex = this.inputs.findIndex(i => i.name === inputName);
        if (inputIndex === -1) return false;

        // Check if it's a removable blend input (not the first two)
        const inputNumber = parseInt(inputName);
        if (isNaN(inputNumber) || inputNumber < 2) return false; // Can't remove 0 or 1

        this.inputs.splice(inputIndex, 1);
        this.updateDimensions();

        return true;
    }

    // Check if all current blend inputs are connected (for auto-adding)
    shouldAddNewInput() {
        if (!this.isDynamicInput) return false;

        // Blend inputs are numeric (excluding 'index')
        const blendInputs = this.inputs.filter(i => i.name !== 'index' && /^\d+$/.test(i.name));

        // Check if all blend inputs are connected
        for (let i = 0; i < blendInputs.length; i++) {
            const inputName = blendInputs[i].name;
            const inputIndex = this.inputs.findIndex(input => input.name === inputName);

            if (this.graph) {
                const isConnected = this.graph.connections.some(conn =>
                    conn.toNode === this && conn.toInput === inputIndex
                );

                // If any blend input is not connected, don't add new one
                if (!isConnected) {
                    return false;
                }
            }
        }

        // All blend inputs are connected, add a new one
        return true;
    }
}
