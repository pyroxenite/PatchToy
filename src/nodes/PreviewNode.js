import { Node } from './Node.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';

/**
 * PreviewNode - A node that displays a live shader preview
 * Extends Node with preview-specific functionality
 */
export class PreviewNode extends Node {
    constructor(id, type, x, y, canvas, videoElement) {
        super(id, type, x, y);

        this.bottomBarHeight = 32;

        // Initialize dimensions with correct aspect ratio
        this.recalculateDimensions();

        // Create renderer instance using ShaderPreview in offscreen mode
        this.renderer = new ShaderPreview(canvas, videoElement, {
            offscreen: true,
            nodeId: id,
            width: 128,
            height: 128
        });
        this.previewInstance = this.renderer; // For backwards compatibility

        // Resize canvas to match initial node dimensions
        this.resizeCanvas();
    }

    recalculateDimensions() {
        // Set aspect ratio based on fullscreen dimensions (screen area only, not including bottom bar)
        const aspectRatio = screen.width / screen.height;
        const previewWidth = 300;
        const previewHeight = previewWidth / aspectRatio; // Height of preview screen only
        this.width = previewWidth;
        this.height = previewHeight + this.bottomBarHeight; // Total node height
    }

    resizeCanvas() {
        // Resize the preview canvas to match node dimensions with device pixel ratio
        if (this.previewInstance) {
            const dpr = window.devicePixelRatio || 1;
            const previewHeight = this.height - this.bottomBarHeight;
            this.previewInstance.canvas.width = this.width * dpr;
            this.previewInstance.canvas.height = previewHeight * dpr;
        }
    }

    // Override: Only preview nodes can be resized
    getResizeEdge(x, y) {
        const threshold = 8;
        const nearLeft = Math.abs(x - this.x) < threshold;
        const nearRight = Math.abs(x - (this.x + this.width)) < threshold;
        const nearTop = Math.abs(y - this.y) < threshold;
        const nearBottom = Math.abs(y - (this.y + this.height)) < threshold;

        const inHorizontalRange = x >= this.x - threshold && x <= this.x + this.width + threshold;
        const inVerticalRange = y >= this.y - threshold && y <= this.y + this.height + threshold;

        // Only allow corner resizing to maintain aspect ratio
        if (nearTop && nearLeft && inHorizontalRange && inVerticalRange) return 'nw';
        if (nearTop && nearRight && inHorizontalRange && inVerticalRange) return 'ne';
        if (nearBottom && nearLeft && inHorizontalRange && inVerticalRange) return 'sw';
        if (nearBottom && nearRight && inHorizontalRange && inVerticalRange) return 'se';

        return null;
    }

    getCursorForEdge(edge) {
        const cursors = {
            'ne': 'nesw-resize',
            'sw': 'nesw-resize',
            'nw': 'nwse-resize',
            'se': 'nwse-resize'
        };
        return cursors[edge] || 'default';
    }

    // Override: Special input port position for preview nodes
    getInputPortPosition(index) {
        const bottomBarHeight = 32;
        const bottomBarY = this.y + this.height - bottomBarHeight;
        return {
            x: this.x,
            y: bottomBarY + bottomBarHeight / 2
        };
    }

    // Override: Custom drawing for preview nodes
    draw(ctx, options = {}) {
        const { isSelected = false } = options;

        // Save context state before drawing
        ctx.save();

        // Draw shadow first (behind the node)
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 4;

        // Node body - matching floating toolbar style
        ctx.fillStyle = 'rgba(45, 45, 45, 0.95)';

        // Draw node background with shadow
        ctx.beginPath();
        ctx.roundRect(this.x, this.y, this.width, this.height, 8);
        ctx.fill();

        // Restore context to clean state
        ctx.restore();

        // Draw preview content
        if (this.renderer && this.renderer.canvas) {
            const previewHeight = this.height - this.bottomBarHeight;
            const borderRadius = 8;

            // Save context and create clipping region for preview area (top rounded corners only)
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(this.x, this.y + previewHeight);
            ctx.lineTo(this.x, this.y + borderRadius);
            ctx.arcTo(this.x, this.y, this.x + borderRadius, this.y, borderRadius);
            ctx.lineTo(this.x + this.width - borderRadius, this.y);
            ctx.arcTo(this.x + this.width, this.y, this.x + this.width, this.y + borderRadius, borderRadius);
            ctx.lineTo(this.x + this.width, this.y + previewHeight);
            ctx.closePath();
            ctx.clip();

            // Draw preview canvas filling clipped area
            ctx.drawImage(this.renderer.canvas, this.x, this.y, this.width, previewHeight);

            ctx.restore();

            // Draw bottom bar (with bottom rounded corners)
            ctx.fillStyle = '#1e1e1e';
            ctx.beginPath();
            ctx.moveTo(this.x, this.y + previewHeight);
            ctx.lineTo(this.x, this.y + this.height - borderRadius);
            ctx.arcTo(this.x, this.y + this.height, this.x + borderRadius, this.y + this.height, borderRadius);
            ctx.lineTo(this.x + this.width - borderRadius, this.y + this.height);
            ctx.arcTo(this.x + this.width, this.y + this.height, this.x + this.width, this.y + this.height - borderRadius, borderRadius);
            ctx.lineTo(this.x + this.width, this.y + previewHeight);
            ctx.closePath();
            ctx.fill();

            // Draw separator line
            ctx.strokeStyle = '#444';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(this.x, this.y + previewHeight);
            ctx.lineTo(this.x + this.width, this.y + previewHeight);
            ctx.stroke();

            // Store bottom bar position for later use
            const bottomBarY = this.y + previewHeight;
            const portX = this.x;
            const portY = bottomBarY + this.bottomBarHeight / 2;

            // Draw buttons in bottom bar (right side, vertically centered)
            const buttonCenterY = bottomBarY + this.bottomBarHeight / 2;
            const buttonSize = 12;
            const buttonSpacing = 10;

            // Code inspect button (</>) - leftmost (24px wide)
            const codeButtonX = this.x + this.width - 24 - 16 - buttonSize - buttonSpacing * 3;
            ctx.fillStyle = '#888';
            ctx.font = '12px monospace';
            ctx.textBaseline = 'middle';
            ctx.fillText('</>', codeButtonX, buttonCenterY);

            // Background button (⬚) - (16px wide)
            const bgButtonX = this.x + this.width - 16 - buttonSize - buttonSpacing * 2;
            ctx.fillStyle = this.isBackground ? '#007acc' : '#888';
            ctx.font = '20px monospace';
            ctx.textBaseline = 'middle';
            ctx.fillText('⬚', bgButtonX, buttonCenterY - 2);

            // Fullscreen button - minimalist four corners
            const fullscreenButtonX = this.x + this.width - buttonSize - buttonSpacing;
            const fullscreenButtonY = buttonCenterY - buttonSize / 2;
            const cornerLen = 4;

            ctx.strokeStyle = '#888';
            ctx.lineWidth = 1.3;

            // Top-left corner
            ctx.beginPath();
            ctx.moveTo(fullscreenButtonX + cornerLen, fullscreenButtonY);
            ctx.lineTo(fullscreenButtonX, fullscreenButtonY);
            ctx.lineTo(fullscreenButtonX, fullscreenButtonY + cornerLen);
            ctx.stroke();

            // Top-right corner
            ctx.beginPath();
            ctx.moveTo(fullscreenButtonX + buttonSize - cornerLen, fullscreenButtonY);
            ctx.lineTo(fullscreenButtonX + buttonSize, fullscreenButtonY);
            ctx.lineTo(fullscreenButtonX + buttonSize, fullscreenButtonY + cornerLen);
            ctx.stroke();

            // Bottom-left corner
            ctx.beginPath();
            ctx.moveTo(fullscreenButtonX, fullscreenButtonY + buttonSize - cornerLen);
            ctx.lineTo(fullscreenButtonX, fullscreenButtonY + buttonSize);
            ctx.lineTo(fullscreenButtonX + cornerLen, fullscreenButtonY + buttonSize);
            ctx.stroke();

            // Bottom-right corner
            ctx.beginPath();
            ctx.moveTo(fullscreenButtonX + buttonSize, fullscreenButtonY + buttonSize - cornerLen);
            ctx.lineTo(fullscreenButtonX + buttonSize, fullscreenButtonY + buttonSize);
            ctx.lineTo(fullscreenButtonX + buttonSize - cornerLen, fullscreenButtonY + buttonSize);
            ctx.stroke();

            // Store button positions for click detection
            if (!this.previewButtons) this.previewButtons = {};
            this.previewButtons.code = { x: codeButtonX, y: buttonCenterY - 8, width: 24, height: 16 };
            this.previewButtons.background = { x: bgButtonX, y: buttonCenterY - 8, width: 16, height: 16 };
            this.previewButtons.fullscreen = { x: fullscreenButtonX, y: fullscreenButtonY, width: buttonSize, height: buttonSize };

            // Draw border on top of content (matching new style)
            // Determine border color and width
            let borderColor, borderWidth;
            if (this.hasError) {
                borderColor = '#f44336';
                borderWidth = 2;
            } else if (isSelected) {
                borderColor = '#007acc';
                borderWidth = 2;
            } else {
                borderColor = 'rgba(68, 68, 68, 0.5)';
                borderWidth = 1;
            }

            ctx.strokeStyle = borderColor;
            ctx.lineWidth = borderWidth;
            ctx.beginPath();
            ctx.roundRect(this.x, this.y, this.width, this.height, borderRadius);
            ctx.stroke();

            // Draw input port on top of border (left side) - protruding outside
            ctx.fillStyle = '#007acc';
            ctx.beginPath();
            ctx.arc(portX, portY, 6, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    serialize() {
        const baseData = super.serialize();
        return {
            ...baseData,
            isBackground: this.isBackground || false
        };
    }

    destroy() {
        if (this.renderer) {
            this.renderer.destroy();
        }
        super.destroy && super.destroy();
    }

    /**
     * Override event handling to check preview buttons first
     * PreviewNode handles its own button clicks
     */
    handleMouseDown(x, y, event) {
        // Check preview buttons if they exist
        if (this.previewButtons) {
            // Background button
            const bgBtn = this.previewButtons.background;
            if (x >= bgBtn.x && x <= bgBtn.x + bgBtn.width &&
                y >= bgBtn.y && y <= bgBtn.y + bgBtn.height) {
                this.toggleBackground();
                return { handled: true, needsRender: true };
            }

            // Code inspect button
            const codeBtn = this.previewButtons.code;
            if (x >= codeBtn.x && x <= codeBtn.x + codeBtn.width &&
                y >= codeBtn.y && y <= codeBtn.y + codeBtn.height) {
                this.showCodeInspect();
                return { handled: true };
            }

            // Fullscreen button
            const fullscreenBtn = this.previewButtons.fullscreen;
            if (x >= fullscreenBtn.x && x <= fullscreenBtn.x + fullscreenBtn.width &&
                y >= fullscreenBtn.y && y <= fullscreenBtn.y + fullscreenBtn.height) {
                this.showFullscreen();
                return { handled: true };
            }
        }

        // Fall back to default Node behavior
        return super.handleMouseDown(x, y, event);
    }

    toggleBackground() {
        if (!this.graph) {
            console.warn('PreviewNode.toggleBackground: no graph reference');
            return;
        }

        // Call the graph's callback which has access to backgroundRenderer
        if (this.graph.onPreviewBackground) {
            this.graph.onPreviewBackground(this);
        }
    }

    showCodeInspect() {
        if (!this.graph) {
            console.warn('PreviewNode.showCodeInspect: no graph reference');
            return;
        }

        // Call the graph's callback which has access to NodeDialogs
        if (this.graph.onPreviewCodeInspect) {
            this.graph.onPreviewCodeInspect(this);
        }
    }

    showFullscreen() {
        if (!this.graph) {
            console.warn('PreviewNode.showFullscreen: no graph reference');
            return;
        }

        // Call the graph's callback which has access to UIHelpers
        if (this.graph.onPreviewFullscreen) {
            this.graph.onPreviewFullscreen(this);
        }
    }
}
