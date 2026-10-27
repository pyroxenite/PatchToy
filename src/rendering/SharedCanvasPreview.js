import { ShaderPreview } from './ShaderPreview.js';
import { ensureCanvasSize } from './glResources.js';
import { quality } from './QualityGovernor.js';

/**
 * A ShaderPreview that renders in the shared GL context - so it can sample Feedback
 * render targets, which only exist there - straight into the shared GL canvas, then
 * copies the result onto a 2D target canvas (GPU-side copy, no readPixels).
 *
 * Used for large outputs (canvas background, fullscreen) where a separate WebGL context
 * would not be able to bind the shared context's textures.
 *
 * governor: name of a quality governor (QualityGovernor.js, e.g. 'background'). The
 * shader then renders at the governor's scale (u_resolution = the scaled size) and is
 * upscaled onto the target with linear filtering. At scale 1 the path is the plain copy.
 */
export function createSharedCanvasPreview({ sharedGL, targetCanvas, videoElement, uniformRegistry = null, isVisible = () => true, governor = null }) {
    const ctx2d = targetCanvas.getContext('2d');
    const preview = new ShaderPreview(null, videoElement, {
        sharedGL,
        offscreen: true,
        width: Math.max(1, targetCanvas.width),
        height: Math.max(1, targetCanvas.height),
        uniformRegistry
    });
    preview.governor = governor;
    preview.lastRenderShown = false;

    // Draw to the shared canvas itself instead of an offscreen framebuffer
    if (preview.framebuffer) {
        sharedGL.deleteTexture(preview.framebuffer.texture);
        sharedGL.deleteFramebuffer(preview.framebuffer.framebuffer);
        preview.framebuffer = null;
    }

    const renderToSharedCanvas = preview.render.bind(preview);
    preview.render = () => {
        preview.lastRenderShown = false;
        if (!isVisible()) return;
        const W = Math.max(1, targetCanvas.width);
        const H = Math.max(1, targetCanvas.height);
        const scale = governor ? quality.scaleOf(governor) : 1;
        const w = scale < 1 ? Math.max(1, Math.round(W * scale)) : W;
        const h = scale < 1 ? Math.max(1, Math.round(H * scale)) : H;
        preview.width = w;
        preview.height = h;
        preview.renderScale = w / W;

        // The shared canvas only needs to be large enough to hold this frame
        ensureCanvasSize(sharedGL, w, h);
        const glCanvas = sharedGL.canvas;
        sharedGL.bindFramebuffer(sharedGL.FRAMEBUFFER, null);
        renderToSharedCanvas();

        // GL draws from the bottom-left corner; canvas pixels are addressed from the top-left
        if (w === W && h === H) {
            ctx2d.drawImage(glCanvas, 0, glCanvas.height - h, w, h, 0, 0, w, h);
        } else {
            // Upscale with linear filtering
            ctx2d.imageSmoothingEnabled = true;
            ctx2d.imageSmoothingQuality = 'low';
            ctx2d.drawImage(glCanvas, 0, glCanvas.height - h, w, h, 0, 0, W, H);
        }
        preview.lastRenderShown = true;
        if (governor) quality.noteOutput(governor, W, H, w / W);
    };

    return preview;
}
