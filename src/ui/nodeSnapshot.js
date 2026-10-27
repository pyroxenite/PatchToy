import { NodeFactory } from '../graph/NodeFactory.js';
import { FONTS } from './theme.js';

/**
 * Renders a node type exactly as the canvas draws it, into a standalone <canvas>.
 * Used by the library hover card and the library drag ghost.
 *
 * A throwaway node instance is created, drawn, then disposed right away, so nodes
 * with side effects (key listeners, MIDI subscriptions, preview renderers) don't linger.
 */

// Room around the node (graph units) for ports sticking out and the drop shadow
export const SNAPSHOT_MARGIN = 14;

let nextTempId = -1000;

function makeTempNode(type, graph) {
    // Negative ids never collide with real nodes (MIDI subscriptions are keyed by id)
    const node = NodeFactory.createNode(type, nextTempId--, 0, 0,
        graph?.canvas || null, graph?.videoElement || null, graph?.sharedGL || null);
    if (!node) return null;
    // An unlabelled Param titles itself "Param <id>": don't show the throwaway id
    if (node.isParamNode && node.data && !node.data.label) node.data.label = 'Param';
    node.graph = {
        connections: [],
        nodes: [],
        zoom: 1,
        panX: 0,
        panY: 0,
        uniformRegistry: graph?.uniformRegistry || null,
        render() {}
    };
    return node;
}

function disposeTempNode(node, graph) {
    try {
        if (node.isPreviewNode && node.renderer) {
            const gl = graph?.sharedGL;
            const fb = node.renderer.framebuffer;
            if (gl && fb) {
                gl.deleteTexture(fb.texture);
                gl.deleteFramebuffer(fb.framebuffer);
                node.renderer.framebuffer = null;
            }
            node.renderer.destroy();
        }
        if (node.cleanup) node.cleanup();
    } catch (e) {
        /* best effort */
    }
}

function drawNode(ctx, node, zoom) {
    ctx.save();
    ctx.font = FONTS.title;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    node.draw(ctx, {
        isSelected: false,
        isHovered: false,
        mouseX: -1e9,
        mouseY: -1e9,
        drag: null,
        hoverPort: null,
        time: performance.now(),
        zoom,
        connections: []
    });
    ctx.restore();
}

/**
 * @param {string} type      node type name
 * @param {object} graph     the NodeGraph (for GL / video handles)
 * @param {object} [opts]
 * @param {number} [opts.scale=1]  CSS pixels per graph unit
 * @returns {{canvas: HTMLCanvasElement, width: number, height: number, margin: number,
 *            nodeWidth: number, nodeHeight: number} | null}  sizes in graph units
 */
export function renderNodeSnapshot(type, graph, { scale = 1 } = {}) {
    const node = makeTempNode(type, graph);
    if (!node) return null;
    try {
        // First pass settles content-fitted widths (titles, inline fields)
        const scratch = document.createElement('canvas');
        scratch.width = scratch.height = 1;
        drawNode(scratch.getContext('2d'), node, scale);

        const m = SNAPSHOT_MARGIN;
        const width = node.width + m * 2;
        const height = node.height + m * 2;
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(width * scale * dpr));
        canvas.height = Math.max(1, Math.ceil(height * scale * dpr));
        canvas.style.width = `${width * scale}px`;
        canvas.style.height = `${height * scale}px`;

        const ctx = canvas.getContext('2d');
        ctx.scale(scale * dpr, scale * dpr);
        ctx.translate(m, m);
        drawNode(ctx, node, scale);

        return { canvas, width, height, margin: m, nodeWidth: node.width, nodeHeight: node.height };
    } catch (e) {
        console.warn(`[nodeSnapshot] Could not draw ${type}`, e);
        return null;
    } finally {
        disposeTempNode(node, graph);
    }
}
