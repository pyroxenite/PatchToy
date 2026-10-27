import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';
import { midiService } from '../services/MIDIService.js';
import { clock } from '../core/Clock.js';
import { COLORS, FONTS, CANVAS, NODE_LAYOUT } from '../ui/theme.js';
import { drawLabel, drawTag, drawValueBar } from '../rendering/NodePainter.js';

export class MidiCCNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isMidiCCNode = true;
        this.fixedWidth = true;

        // MIDI configuration
        this.data.channel = this.data.channel ?? 1; // MIDI channel 1-16
        this.data.ccNumber = this.data.ccNumber ?? 1; // CC number 0-127
        this.data.smoothing = this.data.smoothing ?? 0.0; // Smoothing factor 0.0-1.0

        // Current values
        this.rawValue = 0.0; // Direct from MIDI (0.0-1.0)
        this.smoothedValue = 0.0; // After first-order filter

        // Smoothing advances once per clock frame (see getValue)
        this._smoothFrame = -1;
        this._smoothAt = 0;

        // MIDI learn state
        this.isLearning = false;
        this.learnCallback = null;

        // Subscribe to MIDI updates
        midiService.subscribe(this.id, (channel, ccNumber, value) => {
            this.handleMIDIUpdate(channel, ccNumber, value);
        });
    }

    rebuildTextInputs() {
        if (!this.hasInputFields) return;

        this.textInputs = {};

        // Create text inputs for numeric data fields
        const fields = ['channel', 'ccNumber', 'smoothing'];
        for (const field of fields) {
            const value = this.data[field];

            if (typeof value === 'number') {
                // Use 'int' type for channel and ccNumber, 'float' for smoothing
                const inputType = (field === 'channel' || field === 'ccNumber') ? 'int' : 'float';

                this.textInputs[field] = new CanvasTextInput(
                    0, 0, 50, 20,
                    String(value),
                    inputType
                );
                this.textInputs[field].onChange = (newValue) => {
                    let numValue;
                    if (inputType === 'int') {
                        numValue = parseInt(newValue);
                    } else {
                        numValue = parseFloat(newValue);
                    }

                    if (!isNaN(numValue)) {
                        // Clamp values to valid ranges
                        if (field === 'channel') {
                            numValue = Math.max(1, Math.min(16, numValue));
                        } else if (field === 'ccNumber') {
                            numValue = Math.max(0, Math.min(127, numValue));
                        } else if (field === 'smoothing') {
                            numValue = Math.max(0.0, Math.min(1.0, numValue));
                        }

                        this.data[field] = numValue;

                        if (this.graph && this.graph.onGraphChanged) {
                            this.graph.onGraphChanged();
                        }
                    }
                };
            }
        }

        this.updateTextInputPositions();
    }

    // Layout: row 0 = ch/cc (+ output jack), row 1 = smoothing, row 2 = live value bar
    updateTextInputPositions() {
        if (!this.textInputs) return;

        const fieldH = NODE_LAYOUT.fieldHeight;
        const y0 = this.getRowCenterY(0) - fieldH / 2;
        const y1 = this.getRowCenterY(1) - fieldH / 2;
        const right = this.x + this.width - 14;

        if (this.textInputs.channel) {
            this.textInputs.channel.x = this.x + 26;
            this.textInputs.channel.y = y0;
            this.textInputs.channel.width = 40;
            this.textInputs.channel.height = fieldH;
        }
        if (this.textInputs.ccNumber) {
            const cx = this.x + 26 + 40 + 24;
            this.textInputs.ccNumber.x = cx;
            this.textInputs.ccNumber.y = y0;
            this.textInputs.ccNumber.width = right - cx;
            this.textInputs.ccNumber.height = fieldH;
        }
        if (this.textInputs.smoothing) {
            const sx = this.x + 54;
            this.textInputs.smoothing.x = sx;
            this.textInputs.smoothing.y = y1;
            this.textInputs.smoothing.width = right - sx;
            this.textInputs.smoothing.height = fieldH;
        }
    }

    getLearnButtonRect() {
        return this.getHeaderTagRect(34);
    }

    getHeaderIcon() {
        return 'midi';
    }

    drawHeaderTags(ctx, options = {}) {
        const r = this.getLearnButtonRect();
        // Blink while waiting for a CC message
        const blinkOn = this.isLearning && Math.floor((options.time || 0) / 350) % 2 === 0;
        drawTag(ctx, r, this.isLearning ? 'learn' : 'learn', this.isLearning && blinkOn, CANVAS.uniform, {
            hovered: this.isHoveringRect(options, r, 2) || (this.isLearning && !blinkOn)
        });
        return r.x;
    }

    drawBody(ctx, options = {}) {
        this.updateTextInputPositions();

        const cy0 = this.getRowCenterY(0);
        drawLabel(ctx, 'ch', this.x + 11, cy0, COLORS.textFaint);
        drawLabel(ctx, 'cc', this.x + 26 + 40 + 7, cy0, COLORS.textFaint);
        drawLabel(ctx, 'smooth', this.x + 11, this.getRowCenterY(1), COLORS.textFaint);

        for (const field of ['channel', 'ccNumber', 'smoothing']) {
            const input = this.textInputs && this.textInputs[field];
            if (input) input.draw(ctx, options);
        }

        // Live value meter
        const cy2 = this.getRowCenterY(2);
        const value = Math.max(0, Math.min(1, this.smoothedValue || 0));
        const barX = this.x + 11;
        const barW = this.width - 22 - 34;
        drawValueBar(ctx, barX, cy2 - 5, barW, 10, value, this.getAccentColor());
        ctx.font = FONTS.value;
        ctx.fillStyle = value > 0 ? COLORS.text : COLORS.textFaint;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(value.toFixed(2), Math.round(this.x + this.width - 11), Math.round(cy2 + 3));
        ctx.textAlign = 'left';
    }

    needsContinuousRender() {
        return this.isLearning || midiService.isEnabled;
    }

    getControlCursor(x, y) {
        const r = this.getLearnButtonRect();
        if (x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2) return 'pointer';
        return super.getControlCursor(x, y);
    }

    _checkTextInputs(x, y) {
        // Check learn button (header, right)
        const r = this.getLearnButtonRect();

        if (x >= r.x - 2 && x <= r.x + r.w + 2 &&
            y >= r.y - 2 && y <= r.y + r.h + 2) {
            this.toggleLearn();
            return { type: 'TOGGLE_LEARN', node: this };
        }

        // Fall back to parent implementation for text inputs
        return super._checkTextInputs ? super._checkTextInputs(x, y) : null;
    }

    // Override handleMouseDown to auto-enable MIDI on any click
    handleMouseDown(x, y, event) {
        // Auto-enable MIDI if not already enabled (uses user gesture from this click)
        if (!midiService.isEnabled) {
            midiService.enable().then(success => {
                if (success) {
                    const btn = document.getElementById('midiBtn');
                    if (btn) {
                        btn.classList.add('is-on');
                        btn.classList.remove('is-error');
                        btn.setAttribute('data-tip', 'MIDI on');
                    }
                }
            });
        }

        // Call parent to handle normal node interaction
        return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
    }

    async toggleLearn() {
        // Auto-enable MIDI if not already enabled (uses user gesture from this click)
        if (!midiService.isEnabled) {
            const success = await midiService.enable();
            if (!success) {
                console.error('[MIDI Learn] Failed to enable MIDI');
                return;
            }
            // Update button state
            const btn = document.getElementById('midiBtn');
            if (btn) {
                btn.classList.add('is-on');
                btn.classList.remove('is-error');
                btn.setAttribute('data-tip', 'MIDI on');
            }
        }

        this.isLearning = !this.isLearning;

        if (this.isLearning) {
            // Set up one-time learn listener
            this.learnCallback = (channel, ccNumber, value) => {
                if (this.isLearning) {
                    // Detected MIDI input - set it!
                    this.data.channel = channel;
                    this.data.ccNumber = ccNumber;
                    this.isLearning = false;

                    // Update text inputs
                    if (this.textInputs.channel) {
                        this.textInputs.channel.setValue(String(channel));
                    }
                    if (this.textInputs.ccNumber) {
                        this.textInputs.ccNumber.setValue(String(ccNumber));
                    }

                    // One-shot: stop listening once learned
                    midiService.unsubscribe(`${this.id}_learn`);
                    this.learnCallback = null;

                    if (this.graph && this.graph.onGraphChanged) {
                        this.graph.onGraphChanged();
                    }
                }
            };
            // Subscribe with a temporary ID for learning
            midiService.subscribe(`${this.id}_learn`, this.learnCallback);
        } else {
            // Cancel learning
            if (this.learnCallback) {
                midiService.unsubscribe(`${this.id}_learn`);
                this.learnCallback = null;
            }
        }
    }

    updateDimensions() {
        this.height = this.heightForRows(3);
    }

    // Override to hide output port label
    getOutputPortLabel() {
        return ''; // Hide output port label
    }

    // Override serialize to save current values
    serialize() {
        const serialized = {
            ...super.serialize(),
            rawValue: this.rawValue,
            smoothedValue: this.smoothedValue
        };
        return serialized;
    }

    /**
     * Handle MIDI CC update from service
     */
    handleMIDIUpdate(channel, ccNumber, value) {
        // Only respond to our configured channel and CC
        if (channel === this.data.channel && ccNumber === this.data.ccNumber) {
            // Just update the raw value - smoothing happens in getValue() per frame
            this.rawValue = value;
        }
    }

    /**
     * Current value (smoothed if enabled). Read by every renderer and the control runtime,
     * several times per frame: the filter advances once per clock frame (clock.frame), by the
     * time since its previous step, so it smooths the same with 1 or 5 readers, at 60 or 120 Hz,
     * and in offline export (fixed steps). data.smoothing is the factor per 60 Hz frame:
     * k = smoothing ^ (dt / 16.67 ms); 0 = instant.
     */
    getValue() {
        const f = clock.frame;
        if (f !== this._smoothFrame) {
            const now = clock.elapsedMs;
            const first = this._smoothFrame < 0;
            const dtMs = first ? 0 : Math.min(250, Math.max(0, now - this._smoothAt));
            this._smoothFrame = f;
            this._smoothAt = now;
            const raw = Number.isFinite(this.rawValue) ? this.rawValue : 0;
            const s = Number(this.data.smoothing);
            if (!(s > 0) || first || !Number.isFinite(this.smoothedValue)) {
                this.smoothedValue = raw;
            } else {
                const k = s >= 1 ? 1 : Math.pow(s, dtMs / (1000 / 60));
                this.smoothedValue = this.smoothedValue * k + raw * (1 - k);
            }
        }
        return this.smoothedValue;
    }

    /**
     * Set MIDI channel (1-16)
     */
    setChannel(channel) {
        this.data.channel = Math.max(1, Math.min(16, channel));
    }

    /**
     * Set CC number (0-127)
     */
    setCCNumber(ccNumber) {
        this.data.ccNumber = Math.max(0, Math.min(127, ccNumber));
    }

    /**
     * Set smoothing factor (0.0-1.0)
     */
    setSmoothing(smoothing) {
        this.data.smoothing = Math.max(0.0, Math.min(1.0, smoothing));
    }

    /**
     * Cleanup
     */
    cleanup() {
        midiService.unsubscribe(this.id);
        // Clean up learn callback if active
        if (this.learnCallback) {
            midiService.unsubscribe(`${this.id}_learn`);
            this.learnCallback = null;
        }
    }
}
