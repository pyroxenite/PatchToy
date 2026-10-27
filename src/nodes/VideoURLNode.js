import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';
import { COLORS, FONTS, LAYOUT, NODE_LAYOUT } from '../ui/theme.js';
import { drawIconButton, drawVideoWell, fitText } from '../rendering/NodePainter.js';
import { contentGate } from '../core/contentGate.js';

export class VideoURLNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isVideoURLNode = true;

        // Video element and stream
        this.videoElement = null;

        // State
        this.isActive = false;
        this.error = null;
        this.isLoading = false;

        // Data
        this.data.url = this.data.url || '';
        this.data.loop = this.data.loop !== undefined ? this.data.loop : true;
        this.data.autoplay = this.data.autoplay !== undefined ? this.data.autoplay : true;

        this.width = 200;
        this.fixedWidth = true;
        this.updateDimensions();

        // Auto-load video if URL is already set (e.g., when deserializing). In someone
        // else's project a remote URL waits for consent (src/core/contentGate.js).
        if (this.data.url && this.data.url.trim()) {
            // Delay slightly to ensure DOM is ready
            setTimeout(() => {
                const url = this.data.url.trim();
                const now = contentGate.request(this, url, () => {
                    this.error = null;
                    this.loadVideo(url);
                    this.graph?.render?.();
                });
                if (!now) {
                    this.error = 'blocked: click to load';
                    this.graph?.render?.();
                }
            }, 100);
        }
    }

    rebuildTextInputs() {
        if (!this.hasInputFields) return;

        this.textInputs = {};

        // URL text input
        this.textInputs.url = new CanvasTextInput(
            0, 0, 180, 20,
            this.data.url || '',
            'text'
        );
        this.textInputs.url.onChange = (newValue) => {
            this.data.url = newValue;
            // Auto-load when URL changes
            if (newValue && newValue.trim()) {
                this.loadVideo(newValue.trim());
            }
            if (this.graph && this.graph.onGraphChanged) {
                this.graph.onGraphChanged();
            }
        };

        this.updateTextInputPositions();
    }

    // Layout: row 0 = URL field between the jacks, row 1 = transport, then thumbnail
    updateTextInputPositions() {
        if (!this.textInputs) return;

        const url = this.textInputs.url;
        if (url) {
            const fieldH = NODE_LAYOUT.fieldHeight;
            url.x = this.x + 12;
            url.y = this.getRowCenterY(0) - fieldH / 2;
            url.width = this.width - 24;
            url.height = fieldH;
            url.placeholder = 'paste a video URL';
        }
    }

    getVideoButtonRects() {
        if (!this._videoButtons) {
            this._videoButtons = { play: { x: 0, y: 0, w: 22, h: 16 }, stop: { x: 0, y: 0, w: 22, h: 16 } };
        }
        const cy = this.getRowCenterY(1);
        const b = this._videoButtons;
        b.play.x = this.x + 10;
        b.play.y = cy - 8;
        b.stop.x = b.play.x + b.play.w + 3;
        b.stop.y = cy - 8;
        return b;
    }

    getThumbRect() {
        const w = this.width - 20;
        return { x: this.x + 10, y: this.getRowCenterY(1) + LAYOUT.portSpacing / 2 + 2, w, h: Math.round(w * 9 / 16) };
    }

    updateDimensions() {
        const thumbH = Math.round((this.width - 20) * 9 / 16);
        this.height = this.heightForRows(2, thumbH + 4);
    }

    getHeaderIcon() {
        return 'film';
    }

    drawHeaderTags(ctx) {
        const playing = !!(this.videoElement && !this.videoElement.paused && this.isActive);
        return this.drawHeaderLed(ctx, playing || !!this.error, this.error ? COLORS.error : undefined);
    }

    // URL field occupies row 0 - port names live in the hover tooltip
    getInputPortLabel() {
        return '';
    }

    getOutputPortLabel() {
        return '';
    }

    drawBody(ctx, options = {}) {
        this.updateTextInputPositions();
        if (this.textInputs && this.textInputs.url) {
            this.textInputs.url.draw(ctx, options);
        }

        // Transport
        const hasVideo = !!(this.videoElement && this.data.url);
        const playing = hasVideo && !this.videoElement.paused;
        const b = this.getVideoButtonRects();
        const color = hasVideo ? undefined : COLORS.textFaint;
        drawIconButton(ctx, b.play, playing ? 'pause' : 'play', {
            hovered: hasVideo && this.isHoveringRect(options, b.play),
            active: playing,
            activeColor: COLORS.success,
            color
        });
        drawIconButton(ctx, b.stop, 'stop', {
            hovered: hasVideo && this.isHoveringRect(options, b.stop),
            color
        });

        // Status text
        let status = 'no video';
        let statusColor = COLORS.textFaint;
        if (this.error) { status = this.error; statusColor = COLORS.error; }
        else if (this.isLoading) { status = 'loading…'; }
        else if (playing) { status = 'playing'; statusColor = COLORS.success; }
        else if (hasVideo) { status = 'paused'; statusColor = COLORS.textDim; }
        const sx = b.stop.x + b.stop.w + 8;
        ctx.font = FONTS.title;
        ctx.fillStyle = statusColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(fitText(ctx, FONTS.title, status, this.x + this.width - 10 - sx), Math.round(sx), Math.round(this.getRowCenterY(1) + 3));

        const r = this.getThumbRect();
        drawVideoWell(ctx, r.x, r.y, r.w, r.h, this.isActive ? this.videoElement : null, {
            icon: 'film',
            message: this.isLoading ? 'loading…' : (this.data.url ? 'click to load' : 'no source')
        });
    }

    needsContinuousRender() {
        return !!(this.videoElement && !this.videoElement.paused && this.isActive);
    }

    getControlCursor(x, y) {
        if (this.videoElement && this.data.url) {
            const b = this.getVideoButtonRects();
            for (const r of [b.play, b.stop]) {
                if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'pointer';
            }
        }
        return super.getControlCursor(x, y);
    }

    // Override handleMouseDown to handle control buttons
    handleMouseDown(x, y, event) {
        // Check if clicking on control buttons
        if (this.videoElement && this.data.url) {
            const b = this.getVideoButtonRects();

            // Play/Pause button
            if (x >= b.play.x && x <= b.play.x + b.play.w &&
                y >= b.play.y && y <= b.play.y + b.play.h) {
                this.togglePlayPause();
                return { type: 'VIDEO_CONTROL', node: this };
            }

            // Stop button
            if (x >= b.stop.x && x <= b.stop.x + b.stop.w &&
                y >= b.stop.y && y <= b.stop.y + b.stop.h) {
                this.stopVideo();
                return { type: 'VIDEO_CONTROL', node: this };
            }
        }

        // Blocked remote media (someone else's project): a click asks for consent
        if (contentGate.isPending(this)) {
            contentGate.prompt();
            return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
        }

        // Auto-load video if not already active and URL is set
        if (!this.isActive && !this.isLoading && this.data.url && this.data.url.trim()) {
            const url = this.data.url.trim();
            // Someone else's project: a remote URL needs consent first (prompt), see contentGate
            const now = contentGate.request(this, url, () => {
                this.error = null;
                this.loadVideo(url);
                this.graph?.render?.();
            });
            if (!now) this.error = 'blocked: allow media to load';
        }

        // Call parent to handle normal node interaction
        return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
    }

    togglePlayPause() {
        if (!this.videoElement) return;

        if (this.videoElement.paused) {
            this.videoElement.play().catch(err => {
                console.warn('[Video URL Node] Play failed:', err);
                this.error = 'Play failed';
            });
        } else {
            this.videoElement.pause();
        }
    }

    stopVideo() {
        if (!this.videoElement) return;

        this.videoElement.pause();
        this.videoElement.currentTime = 0;
    }

    /**
     * Load and play video from URL
     */
    async loadVideo(url) {
        if (this._disposed) return false; // deleted (a delayed auto-load / consent callback)
        if (this.isActive && this.videoElement && this.videoElement.src === url) {
            return true;
        }

        this.isLoading = true;
        this.error = null;

        try {
            // Create video element if it doesn't exist
            if (!this.videoElement) {
                this.videoElement = document.createElement('video');
                this.videoElement.setAttribute('playsinline', '');
                this.videoElement.setAttribute('crossorigin', 'anonymous');
                this.videoElement.muted = true;
                this.videoElement.loop = this.data.loop;
            }

            // One pair of listeners per load: whichever fires first removes both, and a newer
            // load (or cleanup) drops them, so an old 'error' can never mark a working node failed
            this._dropLoadListeners();
            const el = this.videoElement;
            const token = this._loadToken = (this._loadToken || 0) + 1;
            const onLoaded = () => {
                if (token !== this._loadToken) return;
                this._dropLoadListeners();
                this.isLoading = false;
                this.isActive = true;

                if (this.data.autoplay) {
                    this.videoElement.play().catch(err => {
                        console.warn('[Video URL Node] Autoplay failed:', err);
                        this.error = 'Autoplay blocked - click to play';
                    });
                }
            };

            const onError = (e) => {
                if (token !== this._loadToken) return;
                this._dropLoadListeners();
                this.isLoading = false;
                this.isActive = false;
                this.error = 'Failed to load';
                console.error('[Video URL Node] Failed to load video:', e);
            };

            el.addEventListener('loadeddata', onLoaded);
            el.addEventListener('error', onError);
            this._loadListeners = { el, onLoaded, onError };

            // Set source
            el.src = url;

            return true;

        } catch (error) {
            console.error('[Video URL Node] Error loading video:', error);
            this.error = error.message;
            this.isLoading = false;
            this.isActive = false;
            return false;
        }
    }

    _dropLoadListeners() {
        const l = this._loadListeners;
        if (!l) return;
        this._loadListeners = null;
        l.el.removeEventListener('loadeddata', l.onLoaded);
        l.el.removeEventListener('error', l.onError);
    }

    /**
     * Stop video (deprecated - use stopVideo)
     */
    stop() {
        this.stopVideo();
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
        this._loadToken = (this._loadToken || 0) + 1; // a load in flight is forgotten
        this._dropLoadListeners();
        if (this.videoElement) {
            const el = this.videoElement;
            this.videoElement = null;
            el.pause();
            // Release the media without an 'error' event (src = '' fires one)
            el.removeAttribute('src');
            try { el.load(); } catch (e) { /* ignore */ }
        }
        this.isActive = false;
        this.isLoading = false;
    }
}
