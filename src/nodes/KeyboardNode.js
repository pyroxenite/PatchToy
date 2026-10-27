import { Node } from './Node.js';
import { COLORS, FONTS } from '../ui/theme.js';
import { drawInset, drawLabel } from '../rendering/NodePainter.js';
import { pushLiveUniform, isTypingTarget } from './liveUniform.js';

/** Normalize a KeyboardEvent to the name stored in data.key. */
function keyName(e) {
    if (e.code === 'Space' || e.key === ' ') return 'Space';
    if (e.key && e.key.length === 1) return e.key.toLowerCase();
    return e.key || e.code;
}

/**
 * Keyboard source: outputs down (1 while data.key is held) and toggle
 * (flips on each press). Click the key chip, then press a key to rebind.
 */
export class KeyboardNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isKeyboardNode = true;
        if (!this.data.key) this.data.key = 'Space';
        this.isDown = false;
        this.toggleState = 0;
        this.isLearning = false;
        this.width = 150;

        this._onKeyDown = (e) => this.handleKey(e, true);
        this._onKeyUp = (e) => this.handleKey(e, false);
        this._onBlur = () => {
            if (this.isDown) {
                this.isDown = false;
                pushLiveUniform(this);
            }
        };
        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', this._onKeyDown, true);
            window.addEventListener('keyup', this._onKeyUp, true);
            window.addEventListener('blur', this._onBlur);
        }
    }

    getUniformValue() {
        return [this.isDown ? 1 : 0, this.toggleState];
    }

    matches(e) {
        const want = String(this.data.key || '').toLowerCase();
        if (!want) return false;
        return keyName(e).toLowerCase() === want || String(e.code || '').toLowerCase() === want ||
            String(e.key || '').toLowerCase() === want;
    }

    handleKey(e, down) {
        if (this.isLearning && down) {
            if (e.key === 'Escape') {
                this.isLearning = false;
            } else {
                this.data.key = keyName(e);
                this.isLearning = false;
                if (this.graph && this.graph.onUniformValueChanged) this.graph.onUniformValueChanged(this);
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            if (this.graph && this.graph.render) this.graph.render();
            return;
        }
        if (isTypingTarget(e, this.graph) || !this.matches(e)) return;
        if (down) {
            if (e.repeat || this.isDown) return;
            this.isDown = true;
            this.toggleState = this.toggleState ? 0 : 1;
        } else {
            if (!this.isDown) return;
            this.isDown = false;
        }
        pushLiveUniform(this);
    }

    updateDimensions() {
        super.updateDimensions();
        if (this.heightForRows) this.height = this.heightForRows(Math.max(this.outputs.length, 1));
    }

    getKeyChipRect() {
        const top = this.getRowCenterY(0) - 9;
        const bottom = this.getRowCenterY(Math.max(this.outputs.length, 1) - 1) + 9;
        return { x: this.x + 8, y: top, w: Math.max(40, this.width - 78), h: bottom - top };
    }

    drawBody(ctx, options = {}) {
        super.drawBody(ctx, options);
        const r = this.getKeyChipRect();
        drawInset(ctx, r.x, r.y, r.w, r.h, {
            fill: this.isDown ? 'rgba(255, 92, 43, 0.25)' : undefined
        });
        const blink = this.isLearning && Math.floor((options.time || Date.now()) / 350) % 2 === 0;
        const label = this.isLearning ? (blink ? 'press a key' : '') : String(this.data.key || '?');
        ctx.save();
        ctx.font = FONTS.value;
        ctx.fillStyle = this.isDown ? COLORS.text : COLORS.textDim;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2));
        ctx.restore();
        if (!this.isLearning) {
            drawLabel(ctx, 'key', r.x + 4, r.y + 7, COLORS.textFaint);
        }
    }

    needsContinuousRender() {
        return this.isLearning;
    }

    handleMouseDown(x, y, event) {
        const r = this.getKeyChipRect();
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
            this.isLearning = !this.isLearning;
            return { handled: true, needsRender: true };
        }
        return super.handleMouseDown(x, y, event);
    }

    cleanup() {
        if (typeof window !== 'undefined') {
            window.removeEventListener('keydown', this._onKeyDown, true);
            window.removeEventListener('keyup', this._onKeyUp, true);
            window.removeEventListener('blur', this._onBlur);
        }
    }
}
