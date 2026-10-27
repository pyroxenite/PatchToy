import { Node } from './Node.js';
import { COLORS, LAYOUT } from '../ui/theme.js';
import { drawVideoWell } from '../rendering/NodePainter.js';

export class ScreenCaptureNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isScreenCaptureNode = true;

        // Video element and stream
        this.videoElement = null;
        this.captureStream = null;

        // State
        this.isActive = false;
        this.error = null;
    }

    // ---- Drawing: header LED + live thumbnail well ----

    getHeaderIcon() {
        return 'screen';
    }

    drawHeaderTags(ctx) {
        return this.drawHeaderLed(ctx, this.isActive || !!this.error, this.error ? COLORS.error : undefined);
    }

    getThumbRect() {
        const w = this.width - 20;
        return {
            x: this.x + 10,
            y: this.getRowCenterY(0) + LAYOUT.portSpacing / 2 + 2,
            w,
            h: Math.round(w * 9 / 16)
        };
    }

    updateDimensions() {
        const thumbH = Math.round((this.width - 20) * 9 / 16);
        this.height = this.heightForRows(Math.max(this.inputs.length, this.outputs.length, 1), thumbH + 4);
    }

    drawBody(ctx) {
        const r = this.getThumbRect();
        drawVideoWell(ctx, r.x, r.y, r.w, r.h, this.isActive ? this.videoElement : null, {
            icon: 'screen',
            message: this.error ? 'capture cancelled' : 'click to share',
            messageColor: this.error ? COLORS.error : undefined
        });
    }

    needsContinuousRender() {
        return this.isActive;
    }

    // Override handleMouseDown to auto-enable screen capture on any click
    handleMouseDown(x, y, event) {
        // Auto-enable screen capture if not already enabled (uses user gesture from this click);
        // clicks while the screen picker is open join the pending request
        if (!this.isActive && !this._enabling) {
            this.enable().then(success => {
                if (success) {
                    const btn = document.getElementById('screenCaptureBtn');
                    if (btn) {
                        btn.classList.add('is-on');
                        btn.classList.remove('is-error');
                        btn.setAttribute('data-tip', 'Screen capture live');
                    }
                }
            });
        }

        // Call parent to handle normal node interaction
        return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
    }

    /**
     * Initialize screen capture access. Idempotent: while a request is pending, every call
     * gets the same promise (one getDisplayMedia). A disable() / cleanup() during the request
     * wins: the stream that arrives late is stopped.
     */
    enable() {
        if (this.isActive) return Promise.resolve(true);
        if (this._enabling) return this._enabling;
        if (this._disposed) return Promise.resolve(false);
        const gen = this._streamGen = (this._streamGen || 0) + 1;
        const p = this._acquire(gen);
        this._enabling = p;
        p.finally(() => { if (this._enabling === p) this._enabling = null; });
        return p;
    }

    async _acquire(gen) {
        const stale = () => gen !== this._streamGen || this._disposed;
        let stream = null;
        try {
            // Request screen capture - this will show browser's screen picker
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always' // Include cursor in capture
                },
                audio: false
            });
            if (stale()) { stopStream(stream); return false; }

            // Create video element if it doesn't exist
            if (!this.videoElement) {
                this.videoElement = document.createElement('video');
                this.videoElement.setAttribute('playsinline', '');
                this.videoElement.muted = true;
            }

            this.captureStream = stream;
            this.videoElement.srcObject = stream;
            await this.videoElement.play();
            if (stale()) { this._release(stream); return false; }

            this.isActive = true;
            this.error = null;

            // Listen for when user stops sharing (via browser UI)
            const track = stream.getVideoTracks()[0];
            if (track) {
                track.addEventListener('ended', () => {
                    if (this.captureStream === stream) this.disable();
                });
            }
            return true;
        } catch (error) {
            // play() rejected or the picker was cancelled: never keep a live stream
            if (stream) this._release(stream);
            if (!stale()) {
                console.error('Failed to enable screen capture:', error);
                this.error = error.message;
            }
            this.isActive = false;
            return false;
        }
    }

    /** Stop a stream and detach it if it is the current one. */
    _release(stream) {
        stopStream(stream);
        if (this.captureStream === stream) {
            this.captureStream = null;
            if (this.videoElement) this.videoElement.srcObject = null;
        }
    }

    /**
     * Disable screen capture (also cancels a pending enable). Idempotent.
     */
    disable() {
        this._streamGen = (this._streamGen || 0) + 1;
        this._enabling = null;
        if (this.captureStream) {
            stopStream(this.captureStream);
            this.captureStream = null;
        }
        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }
        this.isActive = false;
    }

    /**
     * Get video element for texture binding
     */
    getVideoElement() {
        return this.videoElement;
    }

    /**
     * Cleanup
     */
    cleanup() {
        this._disposed = true;
        this.disable();
    }
}

function stopStream(stream) {
    try { stream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
}
