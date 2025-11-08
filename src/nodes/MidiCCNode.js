import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';
import { midiService } from '../services/MIDIService.js';

export class MidiCCNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isMidiCCNode = true;

        // MIDI configuration
        this.data.channel = this.data.channel ?? 1; // MIDI channel 1-16
        this.data.ccNumber = this.data.ccNumber ?? 1; // CC number 0-127
        this.data.smoothing = this.data.smoothing ?? 0.0; // Smoothing factor 0.0-1.0

        // Current values
        this.rawValue = 0.0; // Direct from MIDI (0.0-1.0)
        this.smoothedValue = 0.0; // After first-order filter

        // Frame tracking for smoothing (ensure smoothing only happens once per frame)
        this.lastFrameTime = 0;
        this.currentFrameTime = 0;

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

    updateTextInputPositions() {
        if (!this.textInputs) return;

        let yOffset = 30; // Start below title and labels
        const inputWidth = (this.width - 30) / 2 - 20; // Two inputs side by side

        // Channel and CC on the same line
        if (this.textInputs.channel) {
            this.textInputs.channel.x = this.x + 10 + 20;
            this.textInputs.channel.y = this.y + yOffset;
            this.textInputs.channel.width = inputWidth;
        }
        if (this.textInputs.ccNumber) {
            this.textInputs.ccNumber.x = this.x + this.width / 2 + 5 + 20;
            this.textInputs.ccNumber.y = this.y + yOffset;
            this.textInputs.ccNumber.width = inputWidth;
        }

        yOffset += 25;

        // Smoothing on its own line
        if (this.textInputs.smoothing) {
            this.textInputs.smoothing.x = this.x + this.width / 2 + 5 + 20;
            this.textInputs.smoothing.y = this.y + yOffset;
            this.textInputs.smoothing.width = inputWidth;
        }
    }

    draw(ctx, options = {}) {
        // Update text input positions before drawing
        this.updateTextInputPositions();

        // Call parent draw
        super.draw(ctx, options);

        // Draw field labels
        if (this.hasInputFields && this.textInputs) {
            ctx.fillStyle = '#888';
            ctx.font = '10px -apple-system, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            ctx.fillText('CH', this.x + 10, this.y + 36);
            ctx.fillText('CC', this.x + this.width/2 + 5, this.y + 36);

            // Smoothing label (left aligned above the input)
            if (this.textInputs.smoothing) {
                ctx.textAlign = 'left';
                ctx.fillText('SMOOTHING', this.x + 10, this.y + 60);
            }

            ctx.textAlign = 'left';
        }

        // Draw MIDI learn button
        this.drawLearnButton(ctx);
    }

    drawLearnButton(ctx) {
        const buttonWidth = 40;
        const buttonHeight = 16;
        const buttonX = this.x + this.width - buttonWidth - 6;
        const buttonY = this.y + 6;

        // Button background
        ctx.fillStyle = this.isLearning ? '#f0a000' : '#444';
        ctx.beginPath();
        ctx.roundRect(buttonX, buttonY, buttonWidth, buttonHeight, 3);
        ctx.fill();

        // Button text
        ctx.fillStyle = this.isLearning ? '#000' : '#fff';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('learn', buttonX + buttonWidth / 2, buttonY + buttonHeight / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    _checkTextInputs(x, y) {
        // Check learn button (top right)
        const buttonWidth = 40;
        const buttonHeight = 16;
        const buttonX = this.x + this.width - buttonWidth - 6;
        const buttonY = this.y + 6;

        if (x >= buttonX && x <= buttonX + buttonWidth &&
            y >= buttonY && y <= buttonY + buttonHeight) {
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
            console.log('[MIDI CC Node] Auto-enabling MIDI from user gesture...');
            midiService.enable().then(success => {
                if (success) {
                    const btn = document.getElementById('midiBtn');
                    if (btn) {
                        btn.style.background = '#007acc';
                        btn.style.borderColor = '#007acc';
                        btn.title = 'MIDI Active';
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
            console.log('[MIDI Learn] Auto-enabling MIDI from user gesture...');
            const success = await midiService.enable();
            if (!success) {
                console.error('[MIDI Learn] Failed to enable MIDI');
                return;
            }
            // Update button state
            const btn = document.getElementById('midiBtn');
            if (btn) {
                btn.style.background = '#007acc';
                btn.style.borderColor = '#007acc';
                btn.title = 'MIDI Active';
            }
        }

        this.isLearning = !this.isLearning;

        if (this.isLearning) {
            console.log('[MIDI Learn] Waiting for MIDI CC input...');
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

                    console.log(`[MIDI Learn] Learned: Channel ${channel}, CC ${ccNumber}`);

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
            console.log('[MIDI Learn] Cancelled');
        }
    }

    updateDimensions() {
        const baseHeight = 30;
        // Headers (15) + 2 rows of text inputs (50) + bottom padding (5)
        const controlsHeight = 56;
        this.height = baseHeight + controlsHeight;
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
        console.log(`[MidiCCNode ${this.id}] Serializing: rawValue=${this.rawValue}, smoothedValue=${this.smoothedValue}`);
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
     * Get current value (smoothed if enabled)
     * Called every frame by the renderer
     */
    getValue() {
        // Get current timestamp
        this.currentFrameTime = performance.now();

        // Only update smoothing once per frame (multiple renderers might call this)
        if (this.currentFrameTime !== this.lastFrameTime) {
            this.lastFrameTime = this.currentFrameTime;

            // Apply first-order smoothing (exponential moving average)
            // This happens every frame, so smoothing is time-based
            // smoothing = 0.0 → no smoothing (instant response)
            // smoothing = 0.99 → heavy smoothing (slow response)
            if (this.data.smoothing > 0.0) {
                this.smoothedValue = this.smoothedValue * this.data.smoothing +
                                     this.rawValue * (1.0 - this.data.smoothing);
            } else {
                this.smoothedValue = this.rawValue;
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
