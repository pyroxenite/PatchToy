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
        this.type = type;  // 'float' or 'int'
        this.focused = false;
        this.cursorPos = this.value.length;
        this.cursorVisible = true;
        this.cursorBlinkTime = 0;
        this.selectionStart = -1;
        this.selectionEnd = -1;
        this.onChange = null;

        // Drag-to-scrub
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
        this.cursorPos = this.value.length;
        this.cursorBlinkTime = 0;
        this.cursorVisible = true;
    }

    blur() {
        this.focused = false;
        this.selectionStart = -1;
        this.selectionEnd = -1;

        // Validate and format number
        if (this.type === 'int') {
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
                this.value = num.toFixed(2);
                if (this.onChange) {
                    this.onChange(num);
                }
            }
        }
    }

    startDrag(mouseX) {
        if (this.focused) return false;  // Don't drag when editing
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
        this.isDragging = false;
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

        // Handle character input
        if (key.length === 1) {
            e.preventDefault();

            // For int type: only allow numbers and minus sign (no decimal point)
            if (this.type === 'int') {
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

    update(dt) {
        if (!this.focused) return;

        // Blink cursor
        this.cursorBlinkTime += dt;
        if (this.cursorBlinkTime > 530) { // 530ms blink rate
            this.cursorVisible = !this.cursorVisible;
            this.cursorBlinkTime = 0;
        }
    }

    draw(ctx) {
        // Background
        ctx.fillStyle = this.focused ? '#1e1e1e' : '#2d2d2d';
        ctx.fillRect(this.x, this.y, this.width, this.height);

        // Border
        ctx.strokeStyle = this.focused ? '#007acc' : '#444';
        ctx.lineWidth = 1;
        ctx.strokeRect(this.x, this.y, this.width, this.height);

        // Clip text to input bounds
        ctx.save();
        ctx.beginPath();
        ctx.rect(this.x, this.y, this.width, this.height);
        ctx.clip();

        // Text
        ctx.fillStyle = '#fff';
        ctx.font = '11px monospace';
        ctx.textBaseline = 'middle';

        const textY = this.y + this.height / 2;
        const textX = this.x + 4;

        // Draw selection
        if (this.focused && this.selectionStart >= 0) {
            const start = Math.min(this.selectionStart, this.selectionEnd);
            const end = Math.max(this.selectionStart, this.selectionEnd);
            const beforeSel = this.value.slice(0, start);
            const selection = this.value.slice(start, end);

            const beforeWidth = ctx.measureText(beforeSel).width;
            const selWidth = ctx.measureText(selection).width;

            ctx.fillStyle = '#007acc';
            ctx.fillRect(textX + beforeWidth, this.y + 2, selWidth, this.height - 4);
        }

        // Draw text
        ctx.fillStyle = '#fff';
        ctx.fillText(this.value, textX, textY);

        // Draw cursor
        if (this.focused && this.cursorVisible) {
            const beforeCursor = this.value.slice(0, this.cursorPos);
            const cursorX = textX + ctx.measureText(beforeCursor).width;

            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cursorX, this.y + 3);
            ctx.lineTo(cursorX, this.y + this.height - 3);
            ctx.stroke();
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
