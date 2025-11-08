import { Node } from './Node.js';

export class OperatorNode extends Node {
    constructor(id, type, x, y, operator) {
        super(id, type, x, y);
        this.operator = operator;
        this.width = 60;
        this.height = 60;
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

        // Draw operator symbol (manually drawn for clean look)
        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;
        ctx.fillStyle = '#ffffff';

        if (this.operator === '+') {
            // Draw clean + symbol
            const size = 20;
            const thickness = 4;
            // Vertical bar
            ctx.fillRect(centerX - thickness / 2, centerY - size / 2, thickness, size);
            // Horizontal bar
            ctx.fillRect(centerX - size / 2, centerY - thickness / 2, size, thickness);
        } else if (this.operator === '-') {
            // Draw clean - symbol
            const size = 20;
            const thickness = 4;
            // Horizontal bar
            ctx.fillRect(centerX - size / 2, centerY - thickness / 2, size, thickness);
        } else if (this.operator === '×') {
            // Draw clean × symbol
            const size = 20;
            const thickness = 4;
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate(Math.PI / 4);
            // Vertical bar
            ctx.fillRect(-thickness / 2, -size / 2, thickness, size);
            // Horizontal bar
            ctx.fillRect(-size / 2, -thickness / 2, size, thickness);
            ctx.restore();
        } else if (this.operator === '÷') {
            // Draw clean ÷ symbol
            const lineLength = 20;
            const thickness = 4;
            const dotSize = 4;
            const spacing = 6;
            // Horizontal line
            ctx.fillRect(centerX - lineLength / 2, centerY - thickness / 2, lineLength, thickness);
            // Top dot
            ctx.beginPath();
            ctx.arc(centerX, centerY - spacing - dotSize / 2, dotSize / 2, 0, Math.PI * 2);
            ctx.fill();
            // Bottom dot
            ctx.beginPath();
            ctx.arc(centerX, centerY + spacing + dotSize / 2, dotSize / 2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Fallback to text for other operators
            ctx.font = '42px "Pixeloid Sans"';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(this.operator, centerX, centerY);
        }

        // Draw input ports (evenly distributed)
        for (let i = 0; i < this.inputs.length; i++) {
            const spacing = this.height / (this.inputs.length + 1);
            const y = this.y + spacing * (i + 1);

            ctx.fillStyle = '#007acc';
            ctx.beginPath();
            ctx.arc(this.x, y, 6, 0, Math.PI * 2);
            ctx.fill();
        }

        // Draw output ports (evenly distributed)
        for (let i = 0; i < this.outputs.length; i++) {
            const spacing = this.height / (this.outputs.length + 1);
            const y = this.y + spacing * (i + 1);

            ctx.fillStyle = '#007acc';
            ctx.beginPath();
            ctx.arc(this.x + this.width, y, 6, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Override to hide input port labels
    getInputPortLabel() {
        return '';
    }

    // Override to hide output port labels
    getOutputPortLabel() {
        return '';
    }

    // Override port positions to distribute evenly
    getInputPortPosition(index) {
        const spacing = this.height / (this.inputs.length + 1);
        return {
            x: this.x,
            y: this.y + spacing * (index + 1)
        };
    }

    getOutputPortPosition(index) {
        const spacing = this.height / (this.outputs.length + 1);
        return {
            x: this.x + this.width,
            y: this.y + spacing * (index + 1)
        };
    }
}
