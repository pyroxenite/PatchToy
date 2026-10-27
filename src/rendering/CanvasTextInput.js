import { COLORS, FONTS, CANVAS } from '../ui/theme.js';
import { withAlpha, measure } from './NodePainter.js';

/**
 * Canvas-based text input field
 * Handles text editing, cursor, selection, and number parsing
 */

export class CanvasTextInput {
    constructor(x, y, width, height, initialValue = "0.0", type = 'float') {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.value = String(initialValue);
        this.type = type;  // 'float', 'int', or 'text'
        this.focused = false;
        this.cursorPos = this.value.length;
        this.cursorVisible = true;
        this.cursorBlinkTime = 0;
        this.selectionStart = -1;
        this.selectionEnd = -1;
        this.onChange = null;
        this.onDragEnd = null; // a scrub ended (mouse up)

        // Drag-to-scrub (only for numeric types)
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartValue = 0;
    }

    containsPoint(px, py) {
        return px >= this.x && px <= this.x + this.width &&
               py >= this.y && py <= this.y + this.height;
    }

    focus() {
        this.focused = true;
        // Blur only commits when the text was edited: a focus + Enter on "0.0035" must not
        // write back a rounded display value (review E-m6)
        this._focusValue = this.value;
        this.cursorPos = this.value.length;
        this.cursorBlinkTime = 0;
        this.cursorVisible = true;
    }

    blur() {
        this.focused = false;
        this.selectionStart = -1;
        this.selectionEnd = -1;

        const edited = this._focusValue === undefined || this.value !== this._focusValue;
        this._focusValue = undefined;
        if (!edited) return;

        // Validate and format based on type
        if (this.type === 'text') {
            // No validation for text, just trigger onChange
            if (this.onChange) {
                this.onChange(this.value);
            }
        } else if (this.type === 'int') {
            const num = parseInt(this.value);
            if (!isNaN(num)) {
                this.value = String(num);
                if (this.onChange) {
                    this.onChange(num);
                }
            }
        } else {
            const num = parseFloat(this.value);
            if (!isNaN(num)) {
                this.value = CanvasTextInput.formatFloat(num);
                if (this.onChange) {
                    this.onChange(num);
                }
            }
        }
    }

    /** Display text of a float: 2 decimals when that is exact, else every digit it needs. */
    static formatFloat(num) {
        const fixed = num.toFixed(2);
        return parseFloat(fixed) === num ? fixed : String(num);
    }

    startDrag(mouseX) {
        if (this.focused) return false;  // Don't drag when editing
        if (this.type === 'text') return false;  // No dragging for text fields
        this.isDragging = true;
        this.dragStartX = mouseX;
        const num = this.type === 'int' ? parseInt(this.value) : parseFloat(this.value);
        this.dragStartValue = isNaN(num) ? 0 : num;
        return true;
    }

    updateDrag(mouseX) {
        if (!this.isDragging) return;

        const delta = mouseX - this.dragStartX;
        const sensitivity = this.type === 'int' ? 0.1 : 0.01;
        const newValue = this.dragStartValue + delta * sensitivity;

        if (this.type === 'int') {
            const intValue = Math.round(newValue);
            this.value = String(intValue);
            if (this.onChange) {
                this.onChange(intValue);
            }
        } else {
            this.value = newValue.toFixed(2);
            if (this.onChange) {
                this.onChange(newValue);
            }
        }
    }

    endDrag() {
        const was = this.isDragging;
        this.isDragging = false;
        if (was && this.onDragEnd) this.onDragEnd();
    }

    handleKeyDown(e) {
        if (!this.focused) return false;

        const key = e.key;

        // Handle special keys
        if (key === 'Enter' || key === 'Tab') {
            this.blur();
            return true;
        }

        if (key === 'Escape') {
            this.blur();
            return true;
        }

        if (key === 'Backspace') {
            e.preventDefault();
            if (this.selectionStart >= 0) {
                // Delete selection
                const start = Math.min(this.selectionStart, this.selectionEnd);
                const end = Math.max(this.selectionStart, this.selectionEnd);
                this.value = this.value.slice(0, start) + this.value.slice(end);
                this.cursorPos = start;
                this.selectionStart = -1;
                this.selectionEnd = -1;
            } else if (this.cursorPos > 0) {
                this.value = this.value.slice(0, this.cursorPos - 1) + this.value.slice(this.cursorPos);
                this.cursorPos--;
            }
            return true;
        }

        if (key === 'Delete') {
            e.preventDefault();
            if (this.selectionStart >= 0) {
                // Delete selection
                const start = Math.min(this.selectionStart, this.selectionEnd);
                const end = Math.max(this.selectionStart, this.selectionEnd);
                this.value = this.value.slice(0, start) + this.value.slice(end);
                this.cursorPos = start;
                this.selectionStart = -1;
                this.selectionEnd = -1;
            } else if (this.cursorPos < this.value.length) {
                this.value = this.value.slice(0, this.cursorPos) + this.value.slice(this.cursorPos + 1);
            }
            return true;
        }

        if (key === 'ArrowLeft') {
            e.preventDefault();
            if (this.cursorPos > 0) this.cursorPos--;
            this.selectionStart = -1;
            this.selectionEnd = -1;
            return true;
        }

        if (key === 'ArrowRight') {
            e.preventDefault();
            if (this.cursorPos < this.value.length) this.cursorPos++;
            this.selectionStart = -1;
            this.selectionEnd = -1;
            return true;
        }

        if (key === 'Home') {
            e.preventDefault();
            this.cursorPos = 0;
            this.selectionStart = -1;
            this.selectionEnd = -1;
            return true;
        }

        if (key === 'End') {
            e.preventDefault();
            this.cursorPos = this.value.length;
            this.selectionStart = -1;
            this.selectionEnd = -1;
            return true;
        }

        // Select all
        if ((e.ctrlKey || e.metaKey) && key === 'a') {
            e.preventDefault();
            this.selectionStart = 0;
            this.selectionEnd = this.value.length;
            this.cursorPos = this.value.length;
            return true;
        }

        // Paste - don't handle here, let paste event handle it
        if ((e.ctrlKey || e.metaKey) && key === 'v') {
            // Don't prevent default - let paste event fire
            return false;
        }

        // Handle character input
        if (key.length === 1) {
            e.preventDefault();

            // Validate input based on type
            if (this.type === 'text') {
                // Allow all characters for text type
            } else if (this.type === 'int') {
                // For int type: only allow numbers and minus sign (no decimal point)
                if (!/^[0-9\-]$/.test(key)) {
                    return true;
                }
            } else {
                // For float type: allow numbers, decimal point, minus sign
                if (!/^[0-9.\-]$/.test(key)) {
                    return true;
                }
            }

            // Delete selection if exists
            if (this.selectionStart >= 0) {
                const start = Math.min(this.selectionStart, this.selectionEnd);
                const end = Math.max(this.selectionStart, this.selectionEnd);
                this.value = this.value.slice(0, start) + key + this.value.slice(end);
                this.cursorPos = start + 1;
                this.selectionStart = -1;
                this.selectionEnd = -1;
            } else {
                // Insert character
                this.value = this.value.slice(0, this.cursorPos) + key + this.value.slice(this.cursorPos);
                this.cursorPos++;
            }

            this.cursorVisible = true;
            this.cursorBlinkTime = 0;
            return true;
        }

        return false;
    }

    async handlePaste(e) {
        if (!this.focused) return false;

        e.preventDefault();

        // Get pasted text from clipboard
        let pastedText = '';
        if (e.clipboardData) {
            pastedText = e.clipboardData.getData('text');
        } else {
            // Fallback for older browsers
            try {
                pastedText = await navigator.clipboard.readText();
            } catch (err) {
                console.warn('Failed to read clipboard:', err);
                return true;
            }
        }

        if (!pastedText) return true;

        // For numeric types, validate the pasted text
        if (this.type === 'int') {
            // Only keep valid characters for int
            pastedText = pastedText.replace(/[^0-9\-]/g, '');
        } else if (this.type === 'float') {
            // Only keep valid characters for float
            pastedText = pastedText.replace(/[^0-9.\-]/g, '');
        }
        // For 'text' type, allow all characters

        // Delete selection if exists
        if (this.selectionStart >= 0) {
            const start = Math.min(this.selectionStart, this.selectionEnd);
            const end = Math.max(this.selectionStart, this.selectionEnd);
            this.value = this.value.slice(0, start) + pastedText + this.value.slice(end);
            this.cursorPos = start + pastedText.length;
            this.selectionStart = -1;
            this.selectionEnd = -1;
        } else {
            // Insert at cursor
            this.value = this.value.slice(0, this.cursorPos) + pastedText + this.value.slice(this.cursorPos);
            this.cursorPos += pastedText.length;
        }

        this.cursorVisible = true;
        this.cursorBlinkTime = 0;
        return true;
    }

    update(dt) {
        if (!this.focused) return;

        // Blink cursor
        this.cursorBlinkTime += dt;
        if (this.cursorBlinkTime > 530) { // 530ms blink rate
            this.cursorVisible = !this.cursorVisible;
            this.cursorBlinkTime = 0;
        }
    }

    /**
     * Draw as a dark inset field. Numeric fields are centered with pixel
     * chevrons hinting drag-to-scrub; text fields are left-aligned.
     * opts (optional): { mouseX, mouseY } world-space mouse for hover styling.
     * Per-field style hooks: this.valueColor, this.placeholder.
     */
    draw(ctx, opts) {
        const x = this.x, y = this.y, w = this.width, h = this.height;
        const numeric = this.type !== 'text';
        const hovered = !!(opts && opts.mouseX !== undefined && this.containsPoint(opts.mouseX, opts.mouseY));
        const active = this.focused || this.isDragging;

        // Focus ring (outside the field)
        if (this.focused) {
            ctx.beginPath();
            ctx.roundRect(x - 2, y - 2, w + 4, h + 4, 5);
            ctx.fillStyle = COLORS.accentSoft;
            ctx.fill();
        }

        // Well
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 3);
        ctx.fillStyle = this.focused ? '#08090c' : CANVAS.inset;
        ctx.fill();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(x + 3, y, w - 6, 1);
        ctx.beginPath();
        ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 2.5);
        ctx.strokeStyle = active ? COLORS.accent : (hovered ? CANVAS.insetHover : CANVAS.insetBorder);
        ctx.lineWidth = 1;
        ctx.stroke();

        // Scrub chevrons (pixel arrows) for numeric fields
        const cy = Math.round(y + h / 2);
        if (numeric && !this.focused && w >= 34) {
            ctx.fillStyle = this.isDragging ? COLORS.accent : (hovered ? COLORS.textDim : COLORS.textFaint);
            const lx = Math.round(x) + 4;
            ctx.fillRect(lx, cy - 1, 1, 1);
            ctx.fillRect(lx + 1, cy - 2, 1, 3);
            const rx = Math.round(x + w) - 5;
            ctx.fillRect(rx, cy - 1, 1, 1);
            ctx.fillRect(rx - 1, cy - 2, 1, 3);
        }

        // Clip text to the field
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 1, y + 1, w - 2, h - 2);
        ctx.clip();

        ctx.font = FONTS.value;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        const baseY = Math.round(y + h / 2 + 3);

        const showPlaceholder = !this.value && !this.focused && this.placeholder;
        const text = showPlaceholder ? this.placeholder : this.value;

        // Left edge of the text run (numeric: centered)
        let textX;
        if (numeric) {
            textX = Math.round(x + w / 2 - measure(ctx, FONTS.value, text) / 2);
        } else {
            textX = Math.round(x + 5);
            // Keep the caret visible when editing long text
            if (this.focused) {
                const caretW = ctx.measureText(this.value.slice(0, this.cursorPos)).width;
                const overflow = caretW - (w - 12);
                if (overflow > 0) textX -= Math.ceil(overflow);
            }
        }

        // Selection
        if (this.focused && this.selectionStart >= 0) {
            const start = Math.min(this.selectionStart, this.selectionEnd);
            const end = Math.max(this.selectionStart, this.selectionEnd);
            const beforeWidth = ctx.measureText(this.value.slice(0, start)).width;
            const selWidth = ctx.measureText(this.value.slice(start, end)).width;
            ctx.fillStyle = withAlpha(COLORS.accent, 0.35);
            ctx.fillRect(textX + beforeWidth, y + 3, selWidth, h - 6);
        }

        // Value
        ctx.fillStyle = showPlaceholder ? COLORS.textFaint : (this.valueColor || COLORS.text);
        ctx.fillText(text, textX, baseY);

        // Caret (accent, 1px)
        if (this.focused && this.cursorVisible) {
            const cursorX = Math.round(textX + ctx.measureText(this.value.slice(0, this.cursorPos)).width);
            ctx.fillStyle = COLORS.accent;
            ctx.fillRect(cursorX, y + 3, 1, h - 6);
        }

        ctx.restore();
    }

    getValue() {
        const num = parseFloat(this.value);
        return isNaN(num) ? 0 : num;
    }

    setValue(value) {
        this.value = String(value);
        this.cursorPos = this.value.length;
    }
}
