import { Node } from './Node.js';

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

    // Override handleMouseDown to auto-enable screen capture on any click
    handleMouseDown(x, y, event) {
        // Auto-enable screen capture if not already enabled (uses user gesture from this click)
        if (!this.isActive) {
            console.log('[Screen Capture Node] Auto-enabling screen capture from user gesture...');
            this.enable().then(success => {
                if (success) {
                    const btn = document.getElementById('screenCaptureBtn');
                    if (btn) {
                        btn.style.background = '#007acc';
                        btn.style.borderColor = '#007acc';
                        btn.title = 'Screen Capture Active';
                    }
                }
            });
        }

        // Call parent to handle normal node interaction
        return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
    }

    /**
     * Initialize screen capture access
     */
    async enable() {
        if (this.isActive) return true;

        try {
            // Request screen capture - this will show browser's screen picker
            this.captureStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always' // Include cursor in capture
                },
                audio: false
            });

            // Create video element if it doesn't exist
            if (!this.videoElement) {
                this.videoElement = document.createElement('video');
                this.videoElement.setAttribute('playsinline', '');
                this.videoElement.muted = true;
            }

            this.videoElement.srcObject = this.captureStream;
            await this.videoElement.play();

            this.isActive = true;
            this.error = null;

            // Listen for when user stops sharing (via browser UI)
            this.captureStream.getVideoTracks()[0].addEventListener('ended', () => {
                console.log('[Screen Capture Node] User stopped sharing');
                this.disable();
            });

            console.log('Screen capture enabled');
            return true;

        } catch (error) {
            console.error('Failed to enable screen capture:', error);
            this.error = error.message;
            this.isActive = false;
            return false;
        }
    }

    /**
     * Disable screen capture
     */
    disable() {
        if (!this.isActive) return;

        if (this.captureStream) {
            this.captureStream.getTracks().forEach(track => track.stop());
            this.captureStream = null;
        }

        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }

        this.isActive = false;

        console.log('Screen capture disabled');
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
        this.disable();
    }
}
