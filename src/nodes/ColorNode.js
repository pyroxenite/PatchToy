import { Node } from './Node.js';

export class ColorNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.width = 100;
        this.height = 80;
    }

    draw(ctx, options = {}) {
        const { isSelected = false } = options;

        // Save context state
        ctx.save();

        // Draw shadow
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 4;

        // Node body
        ctx.fillStyle = 'rgba(45, 45, 45, 0.95)';
        ctx.beginPath();
        ctx.roundRect(this.x, this.y, this.width, this.height, 8);
        ctx.fill();

        // Restore to remove shadow
        ctx.restore();

        // Border
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
        ctx.beginPath();
        ctx.roundRect(this.x, this.y, this.width, this.height, 8);
        ctx.stroke();

        // Title
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px bold "Pixeloid Sans"';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('Color', this.x + 10, this.y + 18);

        // Color fill - entire node below title
        const titleBarHeight = 30;
        const colorX = this.x;
        const colorY = this.y + titleBarHeight;
        const colorWidth = this.width;
        const colorHeight = this.height - titleBarHeight;

        const r = Math.floor(this.data.r * 255);
        const g = Math.floor(this.data.g * 255);
        const b = Math.floor(this.data.b * 255);

        // Draw color fill with rounded bottom corners
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.beginPath();
        // Start at top-left (no rounding)
        ctx.moveTo(colorX, colorY);
        // Top-right (no rounding)
        ctx.lineTo(colorX + colorWidth, colorY);
        // Bottom-right (rounded)
        ctx.lineTo(colorX + colorWidth, colorY + colorHeight - 8);
        ctx.arcTo(colorX + colorWidth, colorY + colorHeight, colorX + colorWidth - 8, colorY + colorHeight, 8);
        // Bottom edge
        ctx.lineTo(colorX + 8, colorY + colorHeight);
        // Bottom-left (rounded)
        ctx.arcTo(colorX, colorY + colorHeight, colorX, colorY + colorHeight - 8, 8);
        // Left edge back to top
        ctx.lineTo(colorX, colorY);
        ctx.closePath();
        ctx.fill();

        // Draw output port (on title bar, right side)
        const portY = this.y + 15; // Center of title bar
        ctx.fillStyle = '#007acc';
        ctx.beginPath();
        ctx.arc(this.x + this.width, portY, 6, 0, Math.PI * 2);
        ctx.fill();
    }

    // Override to hide output port label
    getOutputPortLabel() {
        return '';
    }

    // Override port position to be on title bar
    getOutputPortPosition(index) {
        return {
            x: this.x + this.width,
            y: this.y + 15 // Center of title bar
        };
    }

    // Color picker click handler
    handleMouseDown(x, y, event) {
        // Check if clicking on color area
        const titleBarHeight = 30;
        const colorY = this.y + titleBarHeight;
        const colorHeight = this.height - titleBarHeight;

        if (x >= this.x && x <= this.x + this.width &&
            y >= colorY && y <= colorY + colorHeight) {
            this._checkAndHandleColorPicker(x, y, event);
            return { handled: true };
        }

        // Call parent to handle normal node interaction
        return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
    }
}
