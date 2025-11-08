import { Node } from './Node.js';
import { CanvasTextInput } from '../rendering/CanvasTextInput.js';

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
        this.height = 80;

        // Auto-load video if URL is already set (e.g., when deserializing)
        if (this.data.url && this.data.url.trim()) {
            // Delay slightly to ensure DOM is ready
            setTimeout(() => {
                this.loadVideo(this.data.url.trim());
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

    updateTextInputPositions() {
        if (!this.textInputs) return;

        let yOffset = 30;

        if (this.textInputs.url) {
            this.textInputs.url.x = this.x + 10;
            this.textInputs.url.y = this.y + yOffset;
            this.textInputs.url.width = this.width - 20;
        }
    }

    draw(ctx, options = {}) {
        this.updateTextInputPositions();
        super.draw(ctx, options);

        // Draw label
        ctx.fillStyle = '#888';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('URL', this.x + 10, this.y + 36);

        // Draw control buttons if video is loaded
        if (this.videoElement && this.data.url) {
            this.drawControlButtons(ctx);
        }

        ctx.textAlign = 'left';
    }

    drawControlButtons(ctx) {
        const buttonWidth = 24;
        const buttonHeight = 16;
        const buttonY = this.y + this.height - buttonHeight - 6;
        const spacing = 4;

        // Play/Pause button
        const playPauseX = this.x + 6;
        ctx.fillStyle = this.videoElement && !this.videoElement.paused ? '#4caf50' : '#444';
        ctx.beginPath();
        ctx.roundRect(playPauseX, buttonY, buttonWidth, buttonHeight, 3);
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.videoElement && !this.videoElement.paused ? '❚❚' : '▶', playPauseX + buttonWidth / 2, buttonY + buttonHeight / 2);

        // Stop button
        const stopX = playPauseX + buttonWidth + spacing;
        ctx.fillStyle = '#444';
        ctx.beginPath();
        ctx.roundRect(stopX, buttonY, buttonWidth, buttonHeight, 3);
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.fillText('⏹', stopX + buttonWidth / 2, buttonY + buttonHeight / 2);

        ctx.textAlign = 'left';
    }

    // Override handleMouseDown to handle control buttons
    handleMouseDown(x, y, event) {
        // Check if clicking on control buttons
        if (this.videoElement && this.data.url) {
            const buttonWidth = 24;
            const buttonHeight = 16;
            const buttonY = this.y + this.height - buttonHeight - 6;
            const spacing = 4;

            // Play/Pause button
            const playPauseX = this.x + 6;
            if (x >= playPauseX && x <= playPauseX + buttonWidth &&
                y >= buttonY && y <= buttonY + buttonHeight) {
                this.togglePlayPause();
                return { type: 'VIDEO_CONTROL', node: this };
            }

            // Stop button
            const stopX = playPauseX + buttonWidth + spacing;
            if (x >= stopX && x <= stopX + buttonWidth &&
                y >= buttonY && y <= buttonY + buttonHeight) {
                this.stopVideo();
                return { type: 'VIDEO_CONTROL', node: this };
            }
        }

        // Auto-load video if not already active and URL is set
        if (!this.isActive && this.data.url && this.data.url.trim()) {
            console.log('[Video URL Node] Auto-loading video from user gesture...');
            this.loadVideo(this.data.url.trim());
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

            // Set up event listeners
            const onLoaded = () => {
                this.isLoading = false;
                this.isActive = true;
                console.log('[Video URL Node] Video loaded successfully');

                if (this.data.autoplay) {
                    this.videoElement.play().catch(err => {
                        console.warn('[Video URL Node] Autoplay failed:', err);
                        this.error = 'Autoplay blocked - click to play';
                    });
                }
            };

            const onError = (e) => {
                this.isLoading = false;
                this.isActive = false;
                this.error = 'Failed to load';
                console.error('[Video URL Node] Failed to load video:', e);
            };

            this.videoElement.addEventListener('loadeddata', onLoaded, { once: true });
            this.videoElement.addEventListener('error', onError, { once: true });

            // Set source
            this.videoElement.src = url;

            return true;

        } catch (error) {
            console.error('[Video URL Node] Error loading video:', error);
            this.error = error.message;
            this.isLoading = false;
            this.isActive = false;
            return false;
        }
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
        if (this.videoElement) {
            this.videoElement.pause();
            this.videoElement.src = '';
            this.videoElement = null;
        }
        this.isActive = false;
    }
}
