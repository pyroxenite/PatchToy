import { Node } from './Node.js';
import { COLORS, FONTS } from '../ui/theme.js';
import { drawLedMeter, drawInset } from '../rendering/NodePainter.js';
import { audioEngine } from '../services/AudioEngine.js';

export class MicrophoneNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isMicrophoneNode = true;

        // Level envelope, read from the AudioEngine's mic meter (see getRMS)
        this.rmsValue = 0.0;

        // State
        this.isActive = false;
        this.error = null;
    }

    // ---- Drawing: header LED + LED level meter on its own row ----

    getHeaderIcon() {
        return 'mic';
    }

    drawHeaderTags(ctx) {
        return this.drawHeaderLed(ctx, this.isActive || !!this.error, this.error ? COLORS.error : undefined);
    }

    getMeterRow() {
        return Math.max(this.inputs.length, this.outputs.length, 1);
    }

    updateDimensions() {
        this.height = this.heightForRows(this.getMeterRow() + 1);
    }

    drawBody(ctx) {
        const cy = this.getRowCenterY(this.getMeterRow());
        const x = this.x + 10;
        const w = this.width - 20;
        if (this.isActive) {
            // Perceptual-ish scaling of RMS into 0..1
            const level = Math.min(1, Math.sqrt(Math.max(0, this.getRMS() || 0)) * 1.6);
            drawLedMeter(ctx, x, cy - 6, w, 12, level);
        } else {
            drawInset(ctx, x, cy - 7, w, 14);
            ctx.font = FONTS.title;
            ctx.fillStyle = this.error ? COLORS.error : COLORS.textFaint;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(this.error ? 'mic unavailable' : 'click to enable', Math.round(x + w / 2), Math.round(cy + 3));
            ctx.textAlign = 'left';
        }
    }

    needsContinuousRender() {
        return this.isActive;
    }

    // Override handleMouseDown to auto-enable microphone on any click
    handleMouseDown(x, y, event) {
        // Auto-enable microphone if not already enabled (uses user gesture from this click);
        // clicks while the permission prompt is open join the pending request
        if (!this.isActive && !this._enabling) {
            this.enable().then(success => {
                if (success) {
                    const btn = document.getElementById('micBtn');
                    if (btn) {
                        btn.classList.add('is-on');
                        btn.classList.remove('is-error');
                        btn.setAttribute('data-tip', 'Microphone live');
                    }
                }
            });
        }

        // Call parent to handle normal node interaction
        return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
    }

    /**
     * Start metering the microphone. The mic stream and AudioContext are owned by the
     * AudioEngine (one context for the whole app); this node only reads its meter.
     * If no other audio source is active, the mic also drives the global audio uniforms.
     * Idempotent: while the permission prompt is open every call gets the same promise;
     * a disable() / cleanup() meanwhile wins (the meter is released when access arrives).
     */
    enable() {
        if (this.isActive) return Promise.resolve(true);
        if (this._enabling) return this._enabling;
        if (this._disposed) return Promise.resolve(false);
        const gen = this._meterGen = (this._meterGen || 0) + 1;
        const p = this._acquire(gen);
        this._enabling = p;
        p.finally(() => { if (this._enabling === p) this._enabling = null; });
        return p;
    }

    async _acquire(gen) {
        const stale = () => gen !== this._meterGen || this._disposed;
        try {
            await audioEngine.acquireMicMeter(this);
            if (stale()) {
                // Disabled / deleted while the prompt was open: don't keep the mic open for it
                audioEngine.releaseMicMeter(this);
                return false;
            }
            this.isActive = true;
            this.error = null;
            return true;
        } catch (error) {
            if (stale()) return false;
            console.error('Failed to enable microphone:', error);
            this.error = audioEngine.error || error.message;
            this.isActive = false;
            return false;
        }
    }

    /** Stop metering (the engine closes the mic when nothing else uses it). Idempotent. */
    disable() {
        this._meterGen = (this._meterGen || 0) + 1;
        this._enabling = null;
        const wasActive = this.isActive;
        this.isActive = false;
        this.rmsValue = 0;
        if (wasActive || audioEngine.mic?.users?.has?.(this)) audioEngine.releaseMicMeter(this);
    }

    /** Called by the engine when the mic track ends (device unplugged, permission revoked). */
    onMicLost() {
        this.isActive = false;
        this.rmsValue = 0;
    }

    /**
     * Current level: instant attack, smooth decay envelope of the mic input (roughly 0..1).
     */
    getRMS() {
        if (!this.isActive) return 0;
        this.rmsValue = audioEngine.micRms;
        return this.rmsValue;
    }

    /**
     * Cleanup
     */
    cleanup() {
        this._disposed = true;
        this.disable();
    }
}
