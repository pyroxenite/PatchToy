/**
 * Capture a small JPEG of the patch's output for gallery cards.
 *
 * Source, in order: the canvas background (a full-size render of the main
 * Preview), else the main Preview node's own canvas. The frame is cropped to
 * 16:10 (the card ratio) and encoded at THUMB_WIDTH px, lowering the quality
 * until it fits THUMB_MAX_BYTES.
 */

export const THUMB_WIDTH = 480;
export const THUMB_HEIGHT = 300;
export const THUMB_MAX_BYTES = 140 * 1024;

/** The Preview that best represents the patch: the background one, else the rightmost wired one. */
export function mainPreviewNode(graph) {
    const previews = graph.nodes.filter(n => n.isPreviewNode);
    if (!previews.length) return null;
    const background = previews.find(n => n.isBackground);
    if (background) return background;
    const wired = previews.filter(p => graph.connections.some(c => c.toNode === p));
    const pool = wired.length ? wired : previews;
    return pool.reduce((best, n) => (n.x > best.x ? n : best), pool[0]);
}

/** Draw `source` into ctx with cover-cropping; flipY for raw GL framebuffer copies. */
function drawCover(ctx, source, sw, sh, { flipY = false } = {}) {
    const W = THUMB_WIDTH;
    const H = THUMB_HEIGHT;
    const scale = Math.max(W / sw, H / sh);
    const cw = W / scale;
    const ch = H / scale;
    const sx = (sw - cw) / 2;
    const sy = (sh - ch) / 2;
    ctx.save();
    if (flipY) {
        ctx.translate(0, H);
        ctx.scale(1, -1);
    }
    ctx.drawImage(source, sx, sy, cw, ch, 0, 0, W, H);
    ctx.restore();
}

/** True when the frame has (almost) no variation: a blank or failed render. */
function isBlank(ctx) {
    const { data } = ctx.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
        const l = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
        if (l < min) min = l;
        if (l > max) max = l;
    }
    return max - min < 3 && max < 8;
}

function toBlob(canvas, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * @param {object} app - PatchToy app (nodeGraph, backgroundRenderer)
 * @returns {Promise<Blob|null>} JPEG blob, or null when there is nothing to show
 */
export async function captureThumbnail(app) {
    const graph = app?.nodeGraph;
    if (!graph) return null;
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#0c0d11';
    ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);

    let drawn = false;
    const bg = app.backgroundRenderer;
    try {
        if (bg?.canvas && bg.canvas.style.display !== 'none' && bg.activePreviewNode && bg.canvas.width > 0) {
            // Render a fresh frame synchronously, then copy it (the 2D target keeps its pixels)
            bg.shaderPreview?.render?.();
            drawCover(ctx, bg.canvas, bg.canvas.width, bg.canvas.height);
            drawn = true;
        }
    } catch (e) {
        drawn = false;
    }

    if (!drawn) {
        const preview = mainPreviewNode(graph);
        if (!preview || !graph.connections.some(c => c.toNode === preview)) return null;
        try {
            preview.renderer?.render?.();
            const source = preview.getDisplayCanvas?.();
            if (source && source.width > 0) {
                // Shared-context previews copy the GL framebuffer bottom-up
                drawCover(ctx, source, source.width, source.height, { flipY: source === preview.displayCanvas });
                drawn = true;
            }
        } catch (e) {
            drawn = false;
        }
    }
    if (!drawn || isBlank(ctx)) return null;

    for (const quality of [0.82, 0.7, 0.55, 0.4]) {
        const blob = await toBlob(canvas, quality);
        if (blob && blob.size <= THUMB_MAX_BYTES) return blob;
    }
    return null;
}
