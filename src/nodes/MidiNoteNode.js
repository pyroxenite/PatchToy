import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';
import { COLORS } from '../ui/theme.js';
import { drawLabel } from '../rendering/NodePainter.js';
import { midiService } from '../services/MIDIService.js';
import { pushLiveUniform } from './liveUniform.js';

/**
 * MIDI note source: gate (1 while a matching note is held), velocity of the
 * last note-on (0..1), note number (0..127) and pitch (note / 127).
 * data.channel: 0 = any, 1-16; data.note: -1 = any, 0-127.
 */
export class MidiNoteNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);
        this.isMidiNoteNode = true;
        this.data.channel = Number.isFinite(this.data.channel) ? this.data.channel : 0;
        this.data.note = Number.isFinite(this.data.note) ? this.data.note : -1;
        this.held = new Set();
        this.velocity = 0;
        this.lastNote = 0;
        this.width = 160;
        this.rebuildTextInputs();

        midiService.subscribeNotes(this.id, (event) => this.handleNote(event));
    }

    getUniformValue() {
        return [this.held.size > 0 ? 1 : 0, this.velocity, this.lastNote];
    }

    accepts(channel, note) {
        const ch = Math.round(this.data.channel || 0);
        const n = Math.round(this.data.note !== undefined ? this.data.note : -1);
        return (ch <= 0 || ch === channel) && (n < 0 || n === note);
    }

    handleNote({ channel, note, velocity, on, allOff }) {
        if (allOff) {
            if (this.held.size === 0) return;
            this.held.clear();
            pushLiveUniform(this);
            return;
        }
        if (!this.accepts(channel, note)) return;
        const key = `${channel}:${note}`;
        if (on) {
            this.held.add(key);
            this.velocity = velocity;
            this.lastNote = note;
        } else {
            this.held.delete(key);
        }
        pushLiveUniform(this);
    }

    rebuildTextInputs() {
        this.textInputs = {};
        for (const field of ['channel', 'note']) {
            const value = this.data[field];
            if (typeof value !== 'number') continue;
            const input = new CanvasTextInput(0, 0, 40, 16, String(value), 'int');
            input.onChange = (v) => {
                const num = parseInt(v, 10);
                if (isNaN(num)) return;
                this.data[field] = field === 'channel' ? Math.max(0, Math.min(16, num)) : Math.max(-1, Math.min(127, num));
                input.setValue(String(this.data[field]));
                this.held.clear();
                pushLiveUniform(this);
                if (this.graph && this.graph.onUniformValueChanged) this.graph.onUniformValueChanged(this);
            };
            this.textInputs[field] = input;
        }
        this.hasInputFields = true;
    }

    updateTextInputPositions() {
        if (!this.textInputs) return;
        const fields = ['channel', 'note'];
        fields.forEach((field, row) => {
            const input = this.textInputs[field];
            if (!input) return;
            input.x = this.x + 44;
            input.y = this.getRowCenterY(row) - 8;
            input.width = 40;
            input.height = 16;
        });
    }

    drawBody(ctx, options = {}) {
        this.updateTextInputPositions();
        drawLabel(ctx, 'ch', this.x + 10, this.getRowCenterY(0), COLORS.textFaint);
        drawLabel(ctx, 'note', this.x + 10, this.getRowCenterY(1), COLORS.textFaint);
        drawLabel(ctx, this.data.channel > 0 ? '' : 'any', this.x + 88, this.getRowCenterY(0), COLORS.textFaint);
        drawLabel(ctx, this.data.note >= 0 ? '' : 'any', this.x + 88, this.getRowCenterY(1), COLORS.textFaint);
        for (const field of ['channel', 'note']) {
            if (this.textInputs[field]) this.textInputs[field].draw(ctx, options);
        }
        if (this.held.size > 0) {
            ctx.save();
            ctx.fillStyle = COLORS.success;
            ctx.beginPath();
            ctx.arc(this.x + 14, this.getRowCenterY(2), 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    handleMouseDown(x, y, event) {
        // Use the click as the user gesture that MIDI access requires
        if (!midiService.isEnabled) {
            midiService.enable().then(ok => {
                const btn = typeof document !== 'undefined' && document.getElementById('midiBtn');
                if (ok && btn) btn.classList.add('is-on');
            });
        }
        return super.handleMouseDown(x, y, event);
    }

    cleanup() {
        midiService.unsubscribeNotes(this.id);
    }
}
