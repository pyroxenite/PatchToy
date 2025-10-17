import { Node } from './Node.js';

export class UVNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        // UV node specific defaults
        this.width = 180;

        // Initialize mode if not set
        if (!this.data.mode) {
            this.data.mode = 'stretch';
        }
    }

    draw(ctx, options = {}) {
        const { isSelected = false } = options;

        // Save context state before drawing
        ctx.save();

        // Draw shadow first (behind the node)
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 4;

        // Node body
        ctx.fillStyle = 'rgba(45, 45, 45, 0.95)';

        // Draw node background with shadow
        ctx.beginPath();
        ctx.roundRect(this.x, this.y, this.width, this.height, 8);
        ctx.fill();

        // Restore context to clean state
        ctx.restore();

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

        // Draw border
        ctx.beginPath();
        ctx.roundRect(this.x, this.y, this.width, this.height, 8);
        ctx.stroke();

        // Node header
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px bold "Pixeloid Sans"';
        ctx.fillText(this.type, this.x + 10, this.y + 18);

        // Draw mode selector buttons
        this.drawModeSelector(ctx);

        // Output port (no label)
        ctx.textBaseline = 'middle';
        for (let i = 0; i < this.outputs.length; i++) {
            const pos = this.getOutputPortPosition(i);
            ctx.fillStyle = '#007acc';
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    drawModeSelector(ctx) {
        const modeY = this.y + 30;
        const modeX = this.x + 8;
        const currentMode = this.data.mode || 'stretch';

        const modes = ['stretch', 'contain', 'cover'];
        const buttonWidth = (this.width - 16 - (modes.length - 1) * 2) / modes.length;
        const buttonHeight = 20;
        const buttonSpacing = 2;
        let buttonX = modeX;
        const buttonY = modeY;

        for (const mode of modes) {
            const isActive = mode === currentMode;

            // Button background
            ctx.fillStyle = isActive ? '#007acc' : '#444';
            ctx.beginPath();
            ctx.roundRect(buttonX, buttonY, buttonWidth, buttonHeight, 3);
            ctx.fill();

            // Border
            ctx.strokeStyle = isActive ? '#0096ff' : '#555';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Mode label
            ctx.fillStyle = '#fff';
            ctx.font = '10px "Pixeloid Sans"';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(mode, buttonX + buttonWidth / 2, buttonY + buttonHeight / 2);

            buttonX += buttonWidth + buttonSpacing;
        }

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
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
        const modeY = this.y + 30;
        const modeX = this.x + 8;
        const modes = ['stretch', 'contain', 'cover'];
        const buttonWidth = (this.width - 16 - (modes.length - 1) * 2) / modes.length;
        const buttonHeight = 20;
        const buttonSpacing = 2;
        const buttonY = modeY;

        let buttonX = modeX;
        for (const mode of modes) {
            if (x >= buttonX && x <= buttonX + buttonWidth &&
                y >= buttonY && y <= buttonY + buttonHeight) {
                this.data.mode = mode;
                return true;
            }
            buttonX += buttonWidth + buttonSpacing;
        }

        return false;
    }

    getOutputPortPosition(index) {
        const modeSelectorHeight = 30;
        const topOffset = 20 + modeSelectorHeight;
        const portSpacing = (this.height - topOffset) / (this.outputs.length + 1);
        return {
            x: this.x + this.width,
            y: this.y + topOffset + portSpacing * (index + 1)
        };
    }

    updateDimensions() {
        const baseHeight = 30;
        const modeSelectorHeight = 30;
        const inputHeight = Math.max(this.inputs.length, this.outputs.length) * 25;

        this.height = Math.max(60, baseHeight + modeSelectorHeight + inputHeight);
    }
}
