import { Node } from './Node.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';
import { presentTexture } from '../rendering/glResources.js';
import { renderLoop } from '../rendering/RenderLoop.js';
import { COLORS, FONTS, LAYOUT, CANVAS } from '../ui/theme.js';
import {
    drawNodeBase, drawNodeBorder, drawLed, drawLabel, drawTag, drawIconButton, drawIcon,
    withAlpha, measure
} from '../rendering/NodePainter.js';

/**
 * PreviewNode - A node that displays a live shader preview
 * Extends Node with preview-specific functionality
 */
export class PreviewNode extends Node {
    constructor(id, type, x, y, canvas, videoElement, sharedGL = null) {
        super(id, type, x, y);

        this.bottomBarHeight = 32;

        // Initialize dimensions with correct aspect ratio
        this.recalculateDimensions();

        // Calculate preview area size (excluding bottom bar)
        const previewHeight = this.height - this.bottomBarHeight;
        const dpr = window.devicePixelRatio || 1;

        // Store references for later initialization
        this.canvas = canvas;
        this.videoElement = videoElement;
        this.sharedGL = sharedGL;

        // Create renderer instance using ShaderPreview in offscreen mode
        const options = {
            offscreen: true,
            nodeId: id,
            width: Math.floor(this.width * dpr),
            height: Math.floor(previewHeight * dpr)
        };

        // Use shared GL context if provided
        if (sharedGL) {
            options.sharedGL = sharedGL;
        }

        // UniformRegistry will be set when node is added to graph
        // via setGraph() override below

        this.renderer = new ShaderPreview(canvas, videoElement, options);
        this.renderer.ownerNode = this; // RenderLoop: skip frames while the node is not visible
        this.previewInstance = this.renderer; // For backwards compatibility

        // Create display canvas for shared context rendering
        if (sharedGL) {
            this.displayCanvas = document.createElement('canvas');
            this.displayCanvas.width = Math.floor(this.width * dpr);
            this.displayCanvas.height = Math.floor(previewHeight * dpr);
            this.displayCtx = this.displayCanvas.getContext('2d');
        }

        // Resize canvas to match initial node dimensions (only if not using shared context)
        if (!sharedGL) {
            this.resizeCanvas();
        }
    }

    /**
     * Get canvas to display - either direct canvas or copy from framebuffer
     */
    getDisplayCanvas() {
        // Legacy path: direct canvas
        if (this.renderer && this.renderer.canvas) {
            return this.renderer.canvas;
        }

        // Shared context path: copy the framebuffer to the display canvas on the GPU
        // (render target -> GL canvas -> drawImage; no readPixels stall). Only when the
        // renderer drew a new frame since the last copy. Rows stay bottom-up (the order
        // readPixels returned), so draw() / thumbnails flip as before.
        if (this.renderer && this.renderer.framebuffer && this.displayCanvas) {
            const r = this.renderer;
            const width = r.width;
            const height = r.height;
            if (this.displayCanvas.width !== width || this.displayCanvas.height !== height) {
                this.displayCanvas.width = width;
                this.displayCanvas.height = height;
                this._copiedFrame = -1;
            }
            if (this._copiedFrame !== r.frameCount || this._copiedFb !== r.framebuffer) {
                if (!presentTexture(r.gl, r.framebuffer.texture, width, height, this.displayCtx, { flipY: true })) {
                    this.readPixelsInto(width, height);
                }
                this._copiedFrame = r.frameCount;
                this._copiedFb = r.framebuffer;
            }
            return this.displayCanvas;
        }

        return null;
    }

    /** Fallback copy through the CPU (only if the GPU copy program is unavailable). */
    readPixelsInto(width, height) {
        const gl = this.renderer.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderer.framebuffer.framebuffer);
        if (!this._readPixels || this._readW !== width || this._readH !== height) {
            this._readPixels = new Uint8Array(width * height * 4);
            this._readImage = new ImageData(new Uint8ClampedArray(this._readPixels.buffer), width, height);
            this._readW = width;
            this._readH = height;
        }
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this._readPixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.displayCtx.putImageData(this._readImage, 0, 0);
    }

    /**
     * Has the renderer drawn a frame the node canvas has not shown yet? (GraphRenderer.needsAnimation)
     * Never while the node is off screen / in a closed group: the canvas would not show it
     * (and a frame rendered just before it left the view would redraw the canvas forever).
     */
    hasNewFrame() {
        const r = this.renderer;
        return !!r && r.frameCount !== this._drawnFrame && renderLoop.nodeVisible(this);
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
        // Resize the preview canvas/framebuffer to match node dimensions with device pixel ratio
        if (this.previewInstance) {
            const dpr = window.devicePixelRatio || 1;
            const previewHeight = this.height - this.bottomBarHeight;
            const newWidth = Math.floor(this.width * dpr);
            const newHeight = Math.floor(previewHeight * dpr);

            if (this.previewInstance.canvas) {
                // Legacy path: resize canvas
                this.previewInstance.canvas.width = newWidth;
                this.previewInstance.canvas.height = newHeight;
            } else if (this.previewInstance.framebuffer) {
                // Shared context path: recreate framebuffer with new size
                const gl = this.previewInstance.gl;

                // Delete old framebuffer
                gl.deleteTexture(this.previewInstance.framebuffer.texture);
                gl.deleteFramebuffer(this.previewInstance.framebuffer.framebuffer);

                // Create new framebuffer with updated size
                this.previewInstance.framebuffer = this.previewInstance.createFramebuffer(gl, newWidth, newHeight);
                this.previewInstance.width = newWidth;
                this.previewInstance.height = newHeight;

                // Resize display canvas too
                if (this.displayCanvas) {
                    this.displayCanvas.width = newWidth;
                    this.displayCanvas.height = newHeight;
                }
            }
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

    /**
     * Toolbar button rects in the bottom strip (right-aligned, clear of the
     * 8px resize corner). Reuses one object to avoid per-frame allocations.
     */
    getPreviewButtonRects() {
        if (!this.previewButtons) {
            this.previewButtons = {
                code: { x: 0, y: 0, width: 0, height: 0 },
                background: { x: 0, y: 0, width: 0, height: 0 },
                fullscreen: { x: 0, y: 0, width: 0, height: 0 }
            };
        }
        const size = 20;
        const gap = 2;
        const cy = this.y + this.height - this.bottomBarHeight / 2;
        let bx = this.x + this.width - 12 - size;
        for (const key of ['fullscreen', 'background', 'code']) {
            const r = this.previewButtons[key];
            r.x = bx;
            r.y = cy - size / 2;
            r.width = size;
            r.height = size;
            // Painter-friendly aliases
            r.w = size;
            r.h = size;
            bx -= size + gap;
        }
        return this.previewButtons;
    }

    _hitButton(r, x, y) {
        return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    }

    // Override: "monitor" module - live screen on top, control strip below
    draw(ctx, options = {}) {
        const selected = !!options.isSelected;
        const x = this.x, y = this.y, w = this.width, h = this.height;
        const bar = this.bottomBarHeight;
        const screenH = h - bar;
        const r = LAYOUT.nodeRadius;
        const accent = this.getAccentColor();

        drawNodeBase(ctx, x, y, w, h, { selected, accent, header: false });

        // --- Screen ---
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, w, screenH, [r, r, 0, 0]);
        ctx.clip();
        const canvasToDraw = this.getDisplayCanvas();
        if (this.renderer) this._drawnFrame = this.renderer.frameCount;
        if (canvasToDraw) {
            if (this.displayCanvas && canvasToDraw === this.displayCanvas) {
                // Flip vertically for WebGL framebuffer
                ctx.translate(x, y + screenH);
                ctx.scale(1, -1);
                ctx.drawImage(canvasToDraw, 0, 0, w, screenH);
            } else {
                ctx.drawImage(canvasToDraw, x, y, w, screenH);
            }
        } else {
            ctx.fillStyle = CANVAS.inset;
            ctx.fillRect(x, y, w, screenH);
        }
        ctx.restore();

        // --- Control strip ---
        const stripY = y + screenH;
        ctx.beginPath();
        ctx.roundRect(x, stripY, w, bar, [0, 0, r, r]);
        ctx.fillStyle = COLORS.nodeHeader;
        ctx.fill();
        // Screen bezel line + thin accent
        ctx.fillStyle = COLORS.canvas;
        ctx.fillRect(x, stripY, w, 1);
        ctx.fillStyle = withAlpha(accent, 0.55);
        ctx.fillRect(x, stripY + 1, w, 1);

        const cy = stripY + bar / 2;
        const connected = this.isPortConnected('in', 0);
        // Status LED: green = live shader, red = error, off = no signal
        const ledColor = this.hasError ? COLORS.error : COLORS.success;
        drawLed(ctx, x + 17, cy, connected || this.hasError, ledColor);

        const btn = this.getPreviewButtonRects();
        let titleRight = btn.code.x - 6;
        let tx = x + 25;
        if (this.isBackground) {
            // "BG" tag when this preview drives the canvas background
            const tag = { x: tx, y: cy - 6.5, w: 18, h: 13 };
            drawTag(ctx, tag, 'BG', true, accent);
            tx += tag.w + 6;
        }
        const compiling = !this.hasError && connected && this.renderer && this.renderer.isPending && this.renderer.isPending();
        const label = this.hasError ? 'Error' : (compiling ? 'Compiling…' : (connected ? 'Preview' : 'No signal'));
        // Drop the label entirely (rather than "Previ…") when the node is narrow
        if (measure(ctx, FONTS.titleBold, label) <= titleRight - tx) {
            drawLabel(ctx, label, tx, cy,
                this.hasError ? COLORS.error : (connected ? COLORS.text : COLORS.textFaint), 'left', FONTS.titleBold);
        }

        drawIconButton(ctx, btn.code, 'code', { hovered: this.isHoveringRect(options, btn.code) });
        drawIconButton(ctx, btn.background, 'picture', {
            hovered: this.isHoveringRect(options, btn.background),
            active: !!this.isBackground,
            activeColor: accent
        });
        drawIconButton(ctx, btn.fullscreen, 'fullscreen', { hovered: this.isHoveringRect(options, btn.fullscreen) });

        // Resize grip (pixel dots) in the bottom-right corner
        drawIcon(ctx, 'grip', x + w - 9, y + h - 8, COLORS.textFaint);

        drawNodeBorder(ctx, x, y, w, h, {
            selected,
            error: this.isInErrorState(),
            hovered: options.isHovered
        });

        this.drawPorts(ctx, options);
    }

    // The strip already says what the input is
    getInputPortLabel() {
        return '';
    }

    getControlCursor(x, y) {
        const btn = this.getPreviewButtonRects();
        if (this._hitButton(btn.code, x, y) || this._hitButton(btn.background, x, y) ||
            this._hitButton(btn.fullscreen, x, y)) {
            return 'pointer';
        }
        return super.getControlCursor(x, y);
    }

    serialize() {
        const baseData = super.serialize();
        return {
            ...baseData,
            width: this.width,
            height: this.height,
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
        // Check preview buttons (rects follow the current node geometry)
        this.getPreviewButtonRects();
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
            // isBackground is saved with the project (serialize): report the change so it
            // is autosaved / marked unsaved / synced like any other edit
            if (this.graph.onGraphChanged) this.graph.onGraphChanged();
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

    // Override to set uniformRegistry on renderer when graph is assigned
    set graph(g) {
        this._graph = g;
        // Update renderer's uniformRegistry and graph reference when graph is set
        if (this.renderer && g) {
            if (g.uniformRegistry) {
                this.renderer.uniformRegistry = g.uniformRegistry;
            }
            this.renderer.graph = g;
        }
    }

    get graph() {
        return this._graph;
    }
}
