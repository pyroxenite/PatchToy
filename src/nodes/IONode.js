import { ControlNode } from './ControlNode.js';
import { COLORS, FONTS } from '../ui/theme.js';
import { fitText } from '../rendering/NodePainter.js';

const STATUS_H = 16;
const STATE_COLORS = { ok: COLORS.success, wait: COLORS.warning, error: COLORS.error, off: COLORS.textFaint };

/**
 * Canvas node for the I/O definitions (def.isIONode, library group "I/O":
 * OSC In / Out, Serial In / Out, MIDI Out, Art-Net Out; src/core/library/io.js).
 * A ControlNode (ports, inline fields, option pills, live value strip) plus a
 * status line under the strip: a coloured dot (green ok, amber waiting / not
 * enabled, red error, grey not paired) and the connection state or the last
 * message (node._io, written by the node's evaluator every frame).
 */
export class IONode extends ControlNode {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isIONode = true;
        if (this.width < 196) this.width = 196;
    }

    updateDimensions() {
        super.updateDimensions();
        this.height += STATUS_H + 2;
    }

    /** { state, text } shown on the status line. */
    ioStatus() {
        return this._io || { state: 'off', text: 'waiting…' };
    }

    drawBody(ctx, options = {}) {
        super.drawBody(ctx, options);
        const strip = this.getStripRect();
        const y = strip.y + strip.h + 4;
        const st = this.ioStatus();
        const color = STATE_COLORS[st.state] || COLORS.textFaint;
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(strip.x + 2), Math.round(y + 5), 6, 6);
        ctx.font = FONTS.value;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = st.state === 'error' ? COLORS.error : st.state === 'ok' ? COLORS.textDim : COLORS.textFaint;
        ctx.fillText(fitText(ctx, FONTS.value, st.text || '', strip.w - 14), Math.round(strip.x + 12), Math.round(y + 11));
    }

    cleanup() {
        const def = this.definition;
        if (def && typeof def.ioCleanup === 'function') {
            try { def.ioCleanup(this); } catch (e) { /* ignore */ }
        }
        super.cleanup();
    }
}
