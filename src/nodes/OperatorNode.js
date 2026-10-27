import { Node } from './Node.js';
import { COLORS, FONTS } from '../ui/theme.js';
import { drawNodeBase, drawNodeBorder, drawIconCentered } from '../rendering/NodePainter.js';

// Pixel glyphs for the arithmetic operators (see NodePainter ICONS)
const OPERATOR_GLYPHS = {
    '+': 'opAdd',
    '-': 'opSub',
    '−': 'opSub',
    '×': 'opMul',
    '*': 'opMul',
    '÷': 'opDiv',
    '/': 'opDiv',
};

/**
 * Compact, header-less "knob" module for + − × ÷.
 */
export class OperatorNode extends Node {
    constructor(id, type, x, y, operator) {
        super(id, type, x, y);
        this.operator = operator;
        this.width = 48;
        this.height = 48;
        this.fixedWidth = true;
    }

    updateDimensions() {
        this.height = 48;
    }

    draw(ctx, options = {}) {
        const selected = !!options.isSelected;
        const radius = 14;
        const x = this.x, y = this.y, w = this.width, h = this.height;

        drawNodeBase(ctx, x, y, w, h, {
            selected,
            accent: this.getAccentColor(),
            header: false,
            radius
        });

        // Operator symbol in chunky pixels
        const glyph = OPERATOR_GLYPHS[this.operator];
        const cx = x + w / 2;
        const cy = y + h / 2 + 1;
        if (glyph) {
            drawIconCentered(ctx, glyph, cx, cy, options.isHovered || selected ? '#ffffff' : COLORS.text, 3);
        } else {
            ctx.font = FONTS.titleBold;
            ctx.fillStyle = COLORS.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(this.operator, Math.round(cx), Math.round(cy + 3));
            ctx.textAlign = 'left';
        }

        drawNodeBorder(ctx, x, y, w, h, {
            selected,
            error: this.isInErrorState(),
            hovered: options.isHovered,
            radius
        });

        this.drawPorts(ctx, options);
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
