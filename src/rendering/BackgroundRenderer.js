import { ShaderPreview } from './ShaderPreview.js';

/**
 * BackgroundRenderer - Manages rendering a preview node's shader as the canvas background
 * Uses a separate canvas positioned behind the node canvas with CSS layering
 */
export class BackgroundRenderer {
    constructor(nodeCanvas, videoElement) {
        this.nodeCanvas = nodeCanvas;
        this.videoElement = videoElement;
        this.activePreviewNode = null;
        this.shaderPreview = null;

        // Create background canvas and position it behind the node canvas
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'backgroundCanvas';
        this.canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: -1;
            display: none;
        `;

        // Insert before the node canvas so it's behind
        this.nodeCanvas.parentElement.insertBefore(this.canvas, this.nodeCanvas);

        // Make node canvas transparent so background shows through
        this.nodeCanvas.style.background = 'transparent';

        this.updateCanvasSize();
    }

    /**
     * Update background canvas size to match main canvas
     */
    updateCanvasSize() {
        const rect = this.nodeCanvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
    }

    /**
     * Set which preview node should render to the background
     * Pass null to disable background rendering
     */
    setActivePreviewNode(previewNode) {
        // If disabling or switching nodes
        if (this.activePreviewNode !== previewNode) {
            this.activePreviewNode = previewNode;

            if (previewNode) {
                // Show background canvas
                this.canvas.style.display = 'block';

                // Create or reinitialize the background shader preview
                if (!this.shaderPreview) {
                    this.updateCanvasSize(); // Ensure size is correct
                    this.shaderPreview = new ShaderPreview(this.canvas, this.videoElement, {
                        offscreen: false
                    });
                }

                // Load the current shader from the preview node if it has one
                if (previewNode.renderer && previewNode.renderer.currentShaderSource) {
                    this.shaderPreview.loadShader(previewNode.renderer.currentShaderSource);
                }

                console.log('Background rendering enabled for preview node:', previewNode.id);
            } else {
                // Hide background canvas when disabled
                this.canvas.style.display = 'none';
                console.log('Background rendering disabled');
            }
        }
    }

    /**
     * Update the background shader (called when the active preview node recompiles)
     */
    updateShader(previewNode, shader) {
        if (this.activePreviewNode === previewNode && this.shaderPreview) {
            this.shaderPreview.loadShader(shader);
        }
    }

    /**
     * No rendering needed - the background canvas is positioned with CSS
     * This method is kept for compatibility but does nothing
     */
    render(ctx) {
        // Background canvas renders itself via ShaderPreview animation loop
        // No need to copy pixels here - CSS layering handles the compositing
    }

    /**
     * Check if a specific preview node is currently the background
     */
    isActive(previewNode) {
        return this.activePreviewNode === previewNode;
    }

    /**
     * Clean up resources
     */
    destroy() {
        if (this.shaderPreview) {
            this.shaderPreview.destroy();
            this.shaderPreview = null;
        }
        if (this.canvas && this.canvas.parentElement) {
            this.canvas.parentElement.removeChild(this.canvas);
        }
        // Restore node canvas background
        this.nodeCanvas.style.background = '#252525';
        this.activePreviewNode = null;
    }
}
