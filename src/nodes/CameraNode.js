import { Node } from './Node.js';

export class CameraNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isCameraNode = true;

        // Video element and stream
        this.videoElement = null;
        this.cameraStream = null;

        // State
        this.isActive = false;
        this.error = null;
    }

    // Override handleMouseDown to auto-enable camera on any click
    handleMouseDown(x, y, event) {
        // Auto-enable camera if not already enabled (uses user gesture from this click)
        if (!this.isActive) {
            console.log('[Camera Node] Auto-enabling camera from user gesture...');
            this.enable().then(success => {
                if (success) {
                    const btn = document.getElementById('cameraBtn');
                    if (btn) {
                        btn.style.background = '#007acc';
                        btn.style.borderColor = '#007acc';
                        btn.title = 'Camera Active';
                    }
                }
            });
        }

        // Call parent to handle normal node interaction
        return super.handleMouseDown ? super.handleMouseDown(x, y, event) : null;
    }

    /**
     * Initialize camera access
     */
    async enable() {
        if (this.isActive) return true;

        try {
            // Request camera access
            this.cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user' },
                audio: false
            });

            // Create video element if it doesn't exist
            if (!this.videoElement) {
                this.videoElement = document.createElement('video');
                this.videoElement.setAttribute('playsinline', '');
                this.videoElement.muted = true;
            }

            this.videoElement.srcObject = this.cameraStream;
            await this.videoElement.play();

            this.isActive = true;
            this.error = null;

            console.log('Camera enabled');
            return true;

        } catch (error) {
            console.error('Failed to enable camera:', error);
            this.error = error.message;
            this.isActive = false;
            return false;
        }
    }

    /**
     * Disable camera
     */
    disable() {
        if (!this.isActive) return;

        if (this.cameraStream) {
            this.cameraStream.getTracks().forEach(track => track.stop());
            this.cameraStream = null;
        }

        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }

        this.isActive = false;

        console.log('Camera disabled');
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
