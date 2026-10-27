import { COLORS, LAYOUT, FONTS, CANVAS, NODE_LAYOUT } from '../ui/theme.js';
import { TypeRegistry } from '../core/TypeRegistry.js';
import {
    portColor, withAlpha, lighten, traceCable, cableHandle, measure, pixelCablePoints, tracePixelCable, GROUP_LAYOUT,
    typesCompatible, nodeAccent, TAU, drawGroupMinimapContent
} from '../rendering/NodePainter.js';
import { getControlPlan, isControlInput, CONTROL, PIXEL } from '../core/control/rates.js';

/**
 * With 'destination-out': remove a rectangle fully and fade the removal out over `f`
 * around it (linear bands on the sides, radial quarter-discs at the corners).
 * `m` = [a, d, e, f]: g's current (scale + translate) transform. The gradients are made
 * once per context in unit space and mapped onto each band / corner by the transform.
 */
function eraseFeathered(g, m, x, y, w, h, f) {
    let grads = FEATHER.get(g);
    if (!grads) {
        const lin = g.createLinearGradient(0, 0, 1, 0);   // along x: opaque at 0, clear at 1
        lin.addColorStop(0, 'rgba(0,0,0,1)');
        lin.addColorStop(1, 'rgba(0,0,0,0)');
        const rad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
        rad.addColorStop(0, 'rgba(0,0,0,1)');
        rad.addColorStop(1, 'rgba(0,0,0,0)');
        FEATHER.set(g, grads = { lin, rad });
    }
    const [a, d, e, t] = m;
    // Unit square (0,0)-(1,1) -> origin (ox, oy), axes (ux, 0) / (0, vy) in graph units;
    // swap: the gradient runs along y (top / bottom bands)
    const unit = (ox, oy, ux, vy, style, swap = false) => {
        if (swap) g.setTransform(0, d * vy, a * ux, 0, a * ox + e, d * oy + t);
        else g.setTransform(a * ux, 0, 0, d * vy, a * ox + e, d * oy + t);
        g.fillStyle = style;
        g.fillRect(0, 0, 1, 1);
    };
    g.fillStyle = '#000';
    g.fillRect(x, y, w, h);
    unit(x, y, w, -f, grads.lin, true);         // top
    unit(x, y + h, w, f, grads.lin, true);      // bottom
    unit(x, y, -f, h, grads.lin);               // left
    unit(x + w, y, f, h, grads.lin);            // right
    unit(x, y, -f, -f, grads.rad);              // corners
    unit(x + w, y, f, -f, grads.rad);
    unit(x, y + h, -f, f, grads.rad);
    unit(x + w, y + h, f, f, grads.rad);
    g.setTransform(a, 0, 0, d, e, t);
}
const FEATHER = new WeakMap(); // 2D context -> unit gradients

// Node groups: draw / hit-test only the current scope (its nodes, group boxes and
// boundary panels, and the cables between them). Without groups these are the
// graph's own arrays.
// Dash patterns (shared: no array allocation per draw call)
const DASH_LOOP = [3, 4];
const DASH_DRAG = [6, 5];
const NO_DASH = [];

// Grid tiles: period steps and how many tiles stay cached (GraphRenderer.drawBackground)
const GRID_STEP = Math.log(1.015);
const GRID_PATTERNS_KEPT = 48;
/** Device-pixel tile period, snapped to a geometric ladder above 32 px (exact below). */
function quantizePeriod(p) {
    if (p <= 32) return Math.round(p);
    return Math.round(32 * Math.exp(Math.round(Math.log(p / 32) / GRID_STEP) * GRID_STEP));
}

const viewNodesOf = (graph) => (graph.getViewNodes ? graph.getViewNodes() : graph.nodes);
const viewLinksOf = (graph) => (graph.getViewLinks ? graph.getViewLinks() : graph.connections);

/**
 * GraphRenderer - draws the whole node canvas for a NodeGraph:
 * dot-grid background, patch cables (+ accessor pills), the in-progress
 * drag cable, nodes, loop-pair brackets, rubber-band selection and
 * screen-space overlays (port type tooltip, accessor hint).
 *
 * Also owns lightweight hover state (port / node / cable midpoint under
 * the mouse) that NodeGraph feeds via updateHover().
 */
export class GraphRenderer {
    constructor(canvas, ctx) {
        this.canvas = canvas;
        this.ctx = ctx;

        this.stamp = 0;

        // Hover state (world-space hit tests mirror NodeGraph's)
        this.hoverPort = null;   // { node, kind: 'in'|'out', index }
        this.hoverNode = null;
        this.hoverConn = null;

        // Grid pattern cache
        this.gridPattern = null;
        this.gridKey = '';
        this.gridMatrix = typeof DOMMatrix !== 'undefined' ? new DOMMatrix() : null;

        // Reused per-frame objects (avoid allocations in the render loop)
        this.drawOpts = {};
        const drag = {
            node: null, reverse: false, index: 0, type: null,
            accepts: (kind, type) => {
                if (drag.reverse) return kind === 'out' && typesCompatible(type, drag.type);
                return kind === 'in' && typesCompatible(drag.type, type);
            },
            // Rate rules (src/core/control/rates.js): pixel values cannot drive control inputs
            acceptsPort: (node, kind, index) => {
                const plan = drag.plan;
                if (!plan || node.isViewOnly || !drag.realNode) return true;
                if (drag.reverse) {
                    if (kind !== 'out' || !isControlInput(drag.realNode, drag.realIndex)) return true;
                    return plan.outRate(node, index) !== PIXEL;
                }
                if (kind !== 'in' || !isControlInput(node, index)) return true;
                return plan.outRate(drag.realNode, drag.realIndex) !== PIXEL;
            }
        };
        this.drag = drag;
    }

    // ------------------------------------------------------------------
    // Hover
    // ------------------------------------------------------------------

    /** Port under (x, y) on a node — mirrors NodeGraph.checkNodePorts. */
    portAt(node, x, y) {
        const r = NODE_LAYOUT.portHitRadius;
        for (let i = 0; i < node.outputs.length; i++) {
            const p = node.getOutputPortPosition(i);
            if (p && Math.hypot(x - p.x, y - p.y) < r) return { node, kind: 'out', index: i };
        }
        for (let i = 0; i < node.inputs.length; i++) {
            const p = node.getInputPortPosition(i);
            if (p && Math.hypot(x - p.x, y - p.y) < r) return { node, kind: 'in', index: i };
        }
        return null;
    }

    /**
     * Update hover state from a world-space mouse position.
     * Returns true when a re-render is needed.
     */
    updateHover(graph, x, y) {
        let port = null;
        let node = null;
        const items = viewNodesOf(graph);
        for (let i = items.length - 1; i >= 0; i--) {
            const n = items[i];
            port = this.portAt(n, x, y);
            if (port) { node = n; break; }
            if (n.containsPoint(x, y)) { node = n; break; }
        }
        let conn = null;
        if (!node) {
            for (const c of viewLinksOf(graph)) {
                if (c.fromNode && c.toNode && c.containsPoint(x, y)) { conn = c; break; }
            }
        }

        const prev = this.hoverPort;
        const portChanged = (!!prev !== !!port) ||
            (prev && port && (prev.node !== port.node || prev.kind !== port.kind || prev.index !== port.index));
        const changed = portChanged || node !== this.hoverNode || conn !== this.hoverConn;

        this.hoverPort = port;
        this.hoverNode = node;
        this.hoverConn = conn;

        // Inside a node, inner controls (buttons, fields) have hover styles too
        return changed || node !== null;
    }

    clearHover() {
        const had = this.hoverPort || this.hoverNode || this.hoverConn;
        this.hoverPort = null;
        this.hoverNode = null;
        this.hoverConn = null;
        return !!had;
    }

    /**
     * Does the canvas need to redraw this frame? Previews only when they rendered a frame
     * the canvas has not shown yet (off-screen / closed-group previews don't render, see
     * RenderLoop), plus animated nodes (meters...), cable drags and group transitions.
     */
    needsAnimation(graph) {
        if (graph.connectingFrom) return true;
        if (graph.groupCtl && graph.groupCtl.isTransitioning()) return true;
        const nodes = graph.nodes;
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            if (n.isPreviewNode) {
                if (n.hasNewFrame ? n.hasNewFrame() : true) return true;
                continue;
            }
            if (n.needsContinuousRender && n.needsContinuousRender()) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Frame
    // ------------------------------------------------------------------

    render(graph) {
        // A node threw half-way through its draw (unbalanced save()s): start from a clean state
        if (this.ctxNeedsReset) {
            this.ctxNeedsReset = false;
            const ctx = this.ctx;
            const dpr = window.devicePixelRatio || 1;
            if (typeof ctx.reset === 'function') ctx.reset();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.font = '12px "Pixeloid Sans"';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
        }
        const layers = graph.groupCtl ? graph.groupCtl.transitionFrame() : null;
        if (layers) {
            this.renderTransition(graph, layers);
            return;
        }
        this.renderFrame(graph, this.ctx, true);
    }

    /**
     * Entering / leaving a group: draw the parent and the child scope, each with its own
     * camera, into offscreen layers and cross-fade them (see GroupController.transitionFrame).
     */
    renderTransition(graph, layers) {
        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.clearRect(0, 0, w / dpr, h / dpr);
        if (graph.backgroundRenderer) graph.backgroundRenderer.render(ctx);
        const bgActive = !!(graph.backgroundRenderer && graph.backgroundRenderer.activePreviewNode);
        if (!bgActive) {
            ctx.fillStyle = COLORS.canvas;
            ctx.fillRect(0, 0, w / dpr, h / dpr);
        }

        if (!this.layerCanvases) this.layerCanvases = [document.createElement('canvas'), document.createElement('canvas')];
        const cam = { panX: graph.panX, panY: graph.panY, zoom: graph.zoom };
        const hover = { port: this.hoverPort, node: this.hoverNode, conn: this.hoverConn };
        this.hoverPort = this.hoverNode = this.hoverConn = null;
        try {
            layers.forEach((layer, i) => {
                const alpha = layer.alpha;
                const mmAlpha = layer.minimap ? layer.minimap.alpha : 0;
                if (Math.max(alpha, mmAlpha) <= 0.003) return;
                const lc = this.layerCanvases[i];
                if (lc.width !== w || lc.height !== h) {
                    lc.width = w;
                    lc.height = h;
                }
                const lctx = lc.getContext('2d');
                lctx.setTransform(1, 0, 0, 1, 0, 0);
                lctx.clearRect(0, 0, w, h);
                lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                graph.panX = layer.panX;
                graph.panY = layer.panY;
                graph.zoom = layer.zoom;
                graph.groupCtl.withScope(layer.scope, () => this.renderFrame(graph, lctx, false, !!layer.transparent));

                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = alpha;
                ctx.drawImage(lc, 0, 0);
                ctx.restore();
                // The group's minimap blocks outlast the box they sit in: draw them again
                // on top, bringing them up to their own opacity
                const m = layer.minimap;
                if (m && mmAlpha > alpha && alpha < 1) {
                    ctx.save();
                    ctx.setTransform(dpr * layer.zoom, 0, 0, dpr * layer.zoom, dpr * layer.panX, dpr * layer.panY);
                    ctx.globalAlpha = 1 - (1 - mmAlpha) / (1 - alpha);
                    const r = m.rect;
                    drawGroupMinimapContent(ctx, r.x, r.y, r.w, r.h, r.data, r.accent);
                    ctx.restore();
                }
            });
        } finally {
            graph.panX = cam.panX;
            graph.panY = cam.panY;
            graph.zoom = cam.zoom;
            this.hoverPort = hover.port;
            this.hoverNode = hover.node;
            this.hoverConn = hover.conn;
        }
    }

    renderFrame(graph, ctx, withLiveBackground, transparent = false) {
        const dpr = window.devicePixelRatio || 1;
        const cssW = this.canvas.width / dpr;
        const cssH = this.canvas.height / dpr;

        ctx.clearRect(0, 0, cssW, cssH);

        if (withLiveBackground && graph.backgroundRenderer) {
            graph.backgroundRenderer.render(ctx);
        }
        const bgActive = !!(graph.backgroundRenderer && graph.backgroundRenderer.activePreviewNode);
        this.drawBackground(ctx, graph, cssW, cssH, dpr, bgActive, transparent);

        const zoom = graph.zoom;
        // Snap the pan to device pixels so pixel fonts and 1px lines stay crisp
        const panX = Math.round(graph.panX * dpr) / dpr;
        const panY = Math.round(graph.panY * dpr) / dpr;

        // World-space viewport (for culling)
        const vx0 = -panX / zoom;
        const vy0 = -panY / zoom;
        const vx1 = vx0 + cssW / zoom;
        const vy1 = vy0 + cssH / zoom;

        ctx.save();
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);

        const now = performance.now();

        // Stamp connected ports once per frame (Node.isPortConnected reads this)
        const stamp = ++this.stamp;
        for (const n of graph.nodes) n._renderStamp = stamp;
        for (const c of graph.connections) {
            if (!c.fromNode || !c.toNode) continue;
            (c.toNode._inLinks || (c.toNode._inLinks = []))[c.toInput] = stamp;
            (c.toNode._inLinkTypes || (c.toNode._inLinkTypes = []))[c.toInput] = this.connectionType(c);
            (c.fromNode._outLinks || (c.fromNode._outLinks = []))[c.fromOutput] = stamp;
        }

        // (also places a group's boundary panels before cables are routed to them)
        viewNodesOf(graph);
        // Outputs patched to a virtual group input (no real connection) show as connected too
        if (graph.groupCtl && graph.groupCtl.stampVirtualSources) graph.groupCtl.stampVirtualSources(stamp);

        // Signal rates (port shapes, control cables); cached, rebuilt when the graph changes
        let plan = null;
        try { plan = getControlPlan(graph); } catch (e) { plan = null; }
        this.plan = plan;

        const drag = graph.connectingFrom ? this.prepareDrag(graph) : null;
        if (drag) {
            this.hoverPort = this.findDropPort(graph, drag);
        }

        const selected = graph.selectionManager.selectedNodes;

        this.drawLoopLinks(ctx, graph);
        this.drawConnections(ctx, graph, selected, zoom, vx0, vy0, vx1, vy1);
        if (graph.groupCtl) graph.groupCtl.drawGhostLinks(ctx, zoom);
        if (drag) this.drawDragCable(ctx, graph, drag, now, zoom);

        // Nodes
        const o = this.drawOpts;
        o.mouseX = graph.mouseX;
        o.mouseY = graph.mouseY;
        o.drag = drag;
        o.hoverPort = this.hoverPort;
        o.time = now;
        o.zoom = zoom;
        o.connections = graph.connections;
        const margin = 24;
        // Notes sit underneath everything: keep Comment nodes at the front of the list,
        // so they are drawn first and hit-tested last.
        if (graph._noteOrderLen !== graph.nodes.length) {
            graph._noteOrderLen = graph.nodes.length;
            const firstPlain = graph.nodes.findIndex(n => !n.isCommentNode);
            if (firstPlain >= 0 && graph.nodes.some((n, i) => n.isCommentNode && i > firstPlain)) {
                const notes = graph.nodes.filter(n => n.isCommentNode);
                const rest = graph.nodes.filter(n => !n.isCommentNode);
                graph.nodes.splice(0, graph.nodes.length, ...notes, ...rest);
            }
        }
        for (const node of viewNodesOf(graph)) {
            if (node.x > vx1 + margin || node.y > vy1 + margin ||
                node.x + node.width < vx0 - margin || node.y + node.height < vy0 - margin) {
                continue;
            }
            o.isSelected = selected.has(node);
            o.isHovered = !drag && node === this.hoverNode;
            ctx.save();
            try {
                ctx.font = FONTS.title;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                node.draw(ctx, o);
            } catch (e) {
                // One broken node must not corrupt the canvas state for everything after it
                if (ctx === this.ctx) this.ctxNeedsReset = true;
                if (!this.drawErrors) this.drawErrors = new WeakSet();
                if (!this.drawErrors.has(node)) {
                    this.drawErrors.add(node);
                    console.warn(`[canvas] ${node.type} #${node.id} failed to draw:`, e);
                }
            } finally {
                ctx.restore();
            }
        }

        // Ghost node (being placed from quick search)
        if (graph.quickNodeSearch) {
            graph.quickNodeSearch.drawGhostNode(ctx);
        }

        if (graph.selectionBox) {
            this.drawSelectionBox(ctx, graph.selectionBox, zoom);
        }

        ctx.restore();

        // Screen-space overlays
        if (this.hoverPort && !graph.draggedNode && !graph.selectionBox) {
            this.drawPortTooltip(ctx, this.hoverPort, panX, panY, zoom);
        }
        if (graph.connectingFrom && graph.swizzleHint) {
            this.drawAccessorHint(ctx, graph, panX, panY, zoom, drag);
        }
    }

    // ------------------------------------------------------------------
    // Background: flat graphite + dot grid that pans/zooms with the graph
    // ------------------------------------------------------------------

    drawBackground(ctx, graph, cssW, cssH, dpr, bgActive, gridOnly = false) {
        if (bgActive) return; // let the live shader background show through cleanly
        if (!gridOnly) {
            ctx.fillStyle = COLORS.canvas;
            ctx.fillRect(0, 0, cssW, cssH);
        }
        // Group transitions zoom far past maxZoom: skip the (huge) grid tile there
        if (graph.zoom > (graph.maxZoom || 3) * 1.01) return;

        // Level of detail: hide minor dots (and thin majors) when zoomed out
        let step = LAYOUT.gridSize * graph.zoom;
        let every = LAYOUT.gridMajorEvery;
        let minor = true;
        if (step < 11) {
            step *= every;
            every = 1;
            minor = false;
        }
        while (step < 14) step *= 2;

        // Tile period snapped to ~1.5 % steps: a zoom gesture reuses a few cached tiles instead
        // of creating a canvas (+ GPU texture) for every 1 px of period
        const periodDev = Math.max(4, quantizePeriod(step * every * dpr));
        const key = periodDev + '|' + every + '|' + dpr + '|' + minor;
        if (key !== this.gridKey || !this.gridPattern) {
            this.gridKey = key;
            const cache = this.gridPatterns || (this.gridPatterns = new Map());
            let pattern = cache.get(key);
            if (pattern) cache.delete(key); // (re-inserted below: most recently used last)
            else pattern = this.buildGridPattern(ctx, periodDev, every, dpr, minor);
            if (pattern) {
                cache.set(key, pattern);
                if (cache.size > GRID_PATTERNS_KEPT) cache.delete(cache.keys().next().value);
            }
            this.gridPattern = pattern;
        }
        if (!this.gridPattern) return;

        const periodCss = periodDev / dpr;
        let ox = graph.panX % periodCss;
        if (ox < 0) ox += periodCss;
        let oy = graph.panY % periodCss;
        if (oy < 0) oy += periodCss;
        ox = Math.round(ox * dpr) / dpr;
        oy = Math.round(oy * dpr) / dpr;

        if (this.gridMatrix && this.gridPattern.setTransform) {
            const m = this.gridMatrix;
            m.a = 1 / dpr; m.b = 0; m.c = 0; m.d = 1 / dpr; m.e = ox; m.f = oy;
            this.gridPattern.setTransform(m);
        }
        ctx.fillStyle = this.gridPattern;
        ctx.fillRect(0, 0, cssW, cssH);
    }

    buildGridPattern(ctx, periodDev, every, dpr, minor) {
        const tile = document.createElement('canvas');
        tile.width = periodDev;
        tile.height = periodDev;
        const t = tile.getContext('2d');
        const dot = Math.max(1, Math.round(dpr));          // 1 css px
        const major = Math.max(2, Math.round(dpr * 2));    // 2 css px
        if (minor && every > 1) {
            t.fillStyle = COLORS.gridDot;
            for (let i = 0; i < every; i++) {
                for (let j = 0; j < every; j++) {
                    if (i === 0 && j === 0) continue;
                    const px = Math.round(i * periodDev / every);
                    const py = Math.round(j * periodDev / every);
                    t.fillRect(px, py, dot, dot);
                }
            }
        }
        t.fillStyle = COLORS.gridDotMajor;
        t.fillRect(0, 0, major, major);
        return ctx.createPattern(tile, 'repeat');
    }

    // ------------------------------------------------------------------
    // Cables
    // ------------------------------------------------------------------

    /** Effective type carried by a cable (accessor-aware, cached, never logs). */
    connectionType(conn) {
        const from = conn.fromNode;
        const base = from.getOutputPortType ? from.getOutputPortType(conn.fromOutput)
            : (from.outputs[conn.fromOutput] && from.outputs[conn.fromOutput].type);
        if (!conn.accessor) return base;
        if (conn._typeBase === base && conn._typeAcc === conn.accessor) return conn._typeRes;
        let res = null;
        try {
            res = TypeRegistry.resolveAccessorType(base, conn.accessor);
        } catch (e) {
            res = null;
        }
        conn._typeBase = base;
        conn._typeAcc = conn.accessor;
        conn._typeRes = res || base;
        return conn._typeRes;
    }

    drawConnections(ctx, graph, selected, zoom, vx0, vy0, vx1, vy1) {
        const w = Math.max(LAYOUT.cableWidth, 1.25 / zoom);
        const plan = this.plan;
        const stamp = this.stamp;
        ctx.lineCap = 'round';

        const links = viewLinksOf(graph);
        const blockers = this.cableBlockers(graph);
        // Canvas transform (graph units -> device pixels) for the faded-cable layer
        const m = ctx.getTransform();
        const xf = this._xf || (this._xf = [1, 1, 0, 0]);
        xf[0] = m.a; xf[1] = m.d; xf[2] = m.e; xf[3] = m.f;
        // Faded cables waiting to be composited together (see compositeFadedCable)
        const fade = this._fade || (this._fade = { n: 0, items: [] });
        fade.n = 0;
        const W = ctx.canvas.width, H = ctx.canvas.height;
        for (const conn of links) {
            const from = conn.fromNode;
            const to = conn.toNode;
            if (!from || !to) continue;
            const a = from.getOutputPortPosition(conn.fromOutput);
            const b = to.getInputPortPosition(conn.toInput);
            if (!a || !b) continue;

            // Cull by the curve's bounding box
            const c = cableHandle(a.x, a.y, b.x, b.y);
            const minX = Math.min(a.x, b.x) - c;
            const maxX = Math.max(a.x, b.x) + c;
            const minY = Math.min(a.y, b.y) - 4;
            const maxY = Math.max(a.y, b.y) + 4;
            if (maxX < vx0 || minX > vx1 || maxY < vy0 || minY > vy1) continue;

            const srcType = from.getOutputPortType ? from.getOutputPortType(conn.fromOutput) : null;
            const outType = this.connectionType(conn);
            const srcColor = portColor(srcType || outType);
            const outColor = portColor(outType);
            const hot = selected.has(from) || selected.has(to);

            // Rate decides the look: pixel-rate (GPU) cables are pixelated staircases,
            // control-rate (CPU) cables smooth curves (events dotted). Dashes are reserved
            // for the cable being dragged.
            const real = conn.conns ? conn.conns[0] : conn;
            const ctl = plan && real && real.fromNode && plan.outRate(real.fromNode, real.fromOutput) === CONTROL;
            const cw = ctl ? Math.max(w * 0.8, 1.2 / zoom) : w;
            const cell = w; // one "pixel" = the cable width, so steps stay fine
            const pts = ctl ? null : this.cablePoints(conn, a, b, cell);

            // A cable that passes *under* another node fades out as it enters that node and
            // back in as it leaves, so it can't be mistaken for a connection to it. Such
            // cables are drawn on a scratch layer, feather-erased around those nodes, then
            // composited; all others draw straight onto the canvas.
            const under = this.nodesUnderCable(conn, blockers, from, to, a, b, c);
            // Device-pixel box of the cable (the area a faded cable is copied from)
            const bx0 = xf[0] * (minX - 12) + xf[2], bx1 = xf[0] * (maxX + 12) + xf[2];
            const by0 = xf[1] * (minY - 12) + xf[3], by1 = xf[1] * (maxY + 12) + xf[3];
            const sx = Math.max(0, Math.floor(Math.min(bx0, bx1))), sy = Math.max(0, Math.floor(Math.min(by0, by1)));
            const ex = Math.min(W, Math.ceil(Math.max(bx0, bx1))), ey = Math.min(H, Math.ceil(Math.max(by0, by1)));
            // Waiting faded cables this one overlaps go first (drawing order is kept)
            if (fade.n && this.fadeOverlaps(fade, sx, sy, ex, ey)) this.compositeFadedCable(ctx, fade, xf);
            const g = under ? this.cableLayerFor(ctx, xf) : ctx;
            g.lineCap = 'round';
            const trace = () => (pts ? tracePixelCable(g, pts) : traceCable(g, a.x, a.y, b.x, b.y));
            if (pts) { g.lineCap = 'square'; g.lineJoin = 'miter'; }

            // Dark underlay separates crossing cables
            trace();
            g.strokeStyle = CANVAS.cableShadow;
            g.lineWidth = (pts ? cell : w) + 2.5;
            g.stroke();

            if (hot) {
                g.strokeStyle = withAlpha(srcColor, 0.22);
                g.lineWidth = (pts ? cell : w) + 6;
                g.stroke();
            }

            if (ctl && srcType === 'event') {
                g.setLineDash([0.1, 4 * Math.max(1, 1 / zoom)]);
                g.lineWidth = cw * 1.6;
            }
            if (pts) {
                if (conn.accessor && outColor !== srcColor) {
                    // Two-tone: source color up to the adapter pill, accessor type after
                    const mid = Math.floor(pts.length / 4);
                    tracePixelCable(g, pts, 0, mid);
                    g.strokeStyle = hot ? lighten(srcColor, 0.3) : srcColor;
                    g.lineWidth = cell;
                    g.stroke();
                    tracePixelCable(g, pts, mid);
                    g.strokeStyle = hot ? lighten(outColor, 0.3) : outColor;
                    g.stroke();
                } else {
                    g.strokeStyle = hot ? lighten(srcColor, 0.3) : srcColor;
                    g.lineWidth = cell;
                    g.stroke();
                }
                g.lineCap = 'round';
                g.lineJoin = 'round';
            } else if (conn.accessor && outColor !== srcColor) {
                // Two-tone: source color up to the adapter pill, accessor type after
                this.strokeHalves(g, a.x, a.y, b.x, b.y, c,
                    hot ? lighten(srcColor, 0.3) : srcColor,
                    hot ? lighten(outColor, 0.3) : outColor, cw);
            } else {
                g.strokeStyle = hot ? lighten(srcColor, 0.3) : srcColor;
                g.lineWidth = ctl && srcType === 'event' ? cw * 1.6 : cw;
                g.stroke();
            }
            if (ctl) g.setLineDash(NO_DASH);
            if (under && ex > sx && ey > sy) {
                const it = fade.items[fade.n] || (fade.items[fade.n] = { under: null, sx: 0, sy: 0, ex: 0, ey: 0 });
                fade.n++;
                it.under = under; it.sx = sx; it.sy = sy; it.ex = ex; it.ey = ey;
            }

            conn._drawStamp = stamp;
            conn._midX = (a.x + b.x) / 2;
            conn._midY = (a.y + b.y) / 2;
            conn._color = hot ? lighten(outColor, 0.3) : outColor;
        }

        if (fade.n) this.compositeFadedCable(ctx, fade, xf);

        // Midpoint handles and accessor pills on top of all cables
        for (const conn of links) {
            if (conn._drawStamp !== stamp) continue;
            const mx = conn._midX;
            const my = conn._midY;
            const hovered = conn === this.hoverConn;
            if (conn.accessor) {
                const text = conn.accessor.startsWith('.') ? conn.accessor : '.' + conn.accessor;
                const font = FONTS.value;
                const pw = Math.ceil(measure(ctx, font, text) + 12);
                const ph = 14;
                const px = Math.round(mx - pw / 2);
                const py = Math.round(my - ph / 2);
                ctx.beginPath();
                ctx.roundRect(px, py, pw, ph, 7);
                ctx.fillStyle = hovered ? COLORS.raised : COLORS.nodeBody;
                ctx.fill();
                ctx.beginPath();
                ctx.roundRect(px + 0.5, py + 0.5, pw - 1, ph - 1, 6.5);
                ctx.strokeStyle = conn._color;
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.font = font;
                ctx.fillStyle = hovered ? COLORS.text : lighten(conn._color, 0.35);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText(text, px + 6, py + 10);
                // Hit-test size for Connection.containsPoint
                conn._pillW = pw + 4;
                conn._pillH = ph + 4;
            } else {
                ctx.beginPath();
                ctx.arc(mx, my, hovered ? 4.5 : 3, 0, TAU);
                ctx.fillStyle = hovered ? conn._color : COLORS.canvas;
                ctx.fill();
                ctx.lineWidth = 1.25;
                ctx.strokeStyle = conn._color;
                ctx.stroke();
                conn._pillW = 14;
                conn._pillH = 14;
            }
        }
        ctx.lineCap = 'butt';
    }

    /** Stroke a cable as two halves (split at t=0.5) in different colors. */
    // ------------------------------------------------------------------
    // Cables passing under nodes fade out / in at the node's edges
    // ------------------------------------------------------------------

    /**
     * Staircase vertices of a pixel-rate cable (pixelCablePoints), cached on the connection
     * until its ends or the cell size (zoom) change.
     */
    cablePoints(conn, a, b, cell) {
        const k = conn._px;
        if (k && k.ax === a.x && k.ay === a.y && k.bx === b.x && k.by === b.y && k.cell === cell) return k.pts;
        const pts = pixelCablePoints(a.x, a.y, b.x, b.y, cell);
        conn._px = { ax: a.x, ay: a.y, bx: b.x, by: b.y, cell, pts };
        return pts;
    }

    /**
     * Opaque view items that a cable could pass under (notes are see-through), rebuilt
     * only when one of them moved, resized, appeared or went away (`version` changes then).
     */
    cableBlockers(graph) {
        const items = viewNodesOf(graph);
        let h = items.length;
        for (const n of items) {
            if (n.isCommentNode) continue;
            h = (h * 31 + (typeof n.id === 'number' ? n.id : 7)) | 0;
            h = (h * 31 + Math.round(n.x * 8)) | 0;
            h = (h * 31 + Math.round(n.y * 8)) | 0;
            h = (h * 31 + Math.round(n.width * 8)) | 0;
            h = (h * 31 + Math.round(n.height * 8)) | 0;
            if (n.isGroupProxy) h = (h * 31 + 1) | 0;
        }
        const B = this._blockers;
        if (B && B.items === items && B.hash === h) return B;
        const list = [];
        for (const n of items) {
            if (n.isCommentNode) continue;
            let x0 = n.x, y0 = n.y, x1 = n.x + n.width, y1 = n.y + n.height;
            if (n.isGroupProxy) {
                y0 -= GROUP_LAYOUT.tabH;
                x1 += GROUP_LAYOUT.stack * 2;
                y1 += GROUP_LAYOUT.stack * 2;
            }
            list.push({ n, x0, y0, x1, y1 });
        }
        this._blockerVersion = (this._blockerVersion || 0) + 1;
        return (this._blockers = { items, hash: h, list, version: this._blockerVersion });
    }

    /**
     * Blockers (other than the cable's own ends) the curve actually runs under, or null.
     * Cached on the connection until its ends move or the blockers change.
     */
    nodesUnderCable(conn, blockers, from, to, a, b, c) {
        const k = conn._under;
        if (k && k.version === blockers.version && k.ax === a.x && k.ay === a.y && k.bx === b.x && k.by === b.y) return k.found;
        let found = null;
        const minX = Math.min(a.x, b.x) - c, maxX = Math.max(a.x, b.x) + c;
        const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
        for (const r of blockers.list) {
            if (r.n === from || r.n === to) continue;
            if (r.x1 < minX || r.x0 > maxX || r.y1 < minY || r.y0 > maxY) continue;
            const p1x = a.x + c, p2x = b.x - c;
            for (let i = 1; i < 32; i++) {
                const t = i / 32, u = 1 - t;
                const x = u * u * u * a.x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * b.x;
                const y = u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y;
                if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) {
                    (found || (found = [])).push(r);
                    break;
                }
            }
        }
        conn._under = { version: blockers.version, ax: a.x, ay: a.y, bx: b.x, by: b.y, found };
        return found;
    }

    /** Scratch canvas the size of the main one (sized by resizeLayers), with the transform `xf`. */
    cableLayerFor(ctx, xf) {
        const main = ctx.canvas;
        let L = this._cableLayer;
        if (!L) L = this._cableLayer = document.createElement('canvas');
        if (L.width !== main.width || L.height !== main.height) {
            L.width = main.width;
            L.height = main.height;
        }
        const g = this._cableCtx || (this._cableCtx = L.getContext('2d'));
        g.setTransform(xf[0], 0, 0, xf[1], xf[2], xf[3]);
        return g;
    }

    /**
     * The canvas changed size: size the scratch layers now (not on the first faded cable /
     * group transition, mid-gesture). Called by the app's resize().
     */
    resizeLayers() {
        const w = this.canvas.width, h = this.canvas.height;
        if (!this._cableLayer) this._cableLayer = document.createElement('canvas');
        if (!this.layerCanvases) this.layerCanvases = [document.createElement('canvas'), document.createElement('canvas')];
        for (const c of [this._cableLayer, ...this.layerCanvases]) {
            if (c.width !== w || c.height !== h) {
                c.width = w;
                c.height = h;
            }
        }
    }

    /** Does the device rect overlap a faded cable waiting on the scratch layer? */
    fadeOverlaps(fade, sx, sy, ex, ey) {
        for (let i = 0; i < fade.n; i++) {
            const it = fade.items[i];
            if (sx < it.ex && ex > it.sx && sy < it.ey && ey > it.sy) return true;
        }
        return false;
    }

    /**
     * Composite the faded cables waiting on the scratch layer: feather-erase each one's
     * covering nodes (clipped to its own box), copy each box onto the canvas, clear them.
     * Their boxes never overlap (drawConnections flushes first), so each box holds only its
     * own cable and the result equals compositing them one at a time, with one layer
     * snapshot per batch instead of one per cable.
     */
    compositeFadedCable(ctx, fade, xf) {
        const F = 26; // fade distance outside the node edge (graph units)
        const g = this._cableCtx;
        const n = fade.n;
        fade.n = 0;
        if (!g) return;
        g.save();
        g.globalCompositeOperation = 'destination-out';
        g.setLineDash(NO_DASH);
        for (let i = 0; i < n; i++) {
            const it = fade.items[i];
            g.save();
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.beginPath();
            g.rect(it.sx, it.sy, it.ex - it.sx, it.ey - it.sy);
            g.clip();
            g.setTransform(xf[0], 0, 0, xf[1], xf[2], xf[3]);
            for (const r of it.under) eraseFeathered(g, xf, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, F);
            g.restore();
            it.under = null;
        }
        g.restore();

        // Copy each cable's box (device pixels) onto the canvas, then clear it
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (let i = 0; i < n; i++) {
            const it = fade.items[i];
            ctx.drawImage(g.canvas, it.sx, it.sy, it.ex - it.sx, it.ey - it.sy, it.sx, it.sy, it.ex - it.sx, it.ey - it.sy);
        }
        ctx.restore();
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        for (let i = 0; i < n; i++) {
            const it = fade.items[i];
            g.clearRect(it.sx, it.sy, it.ex - it.sx, it.ey - it.sy);
        }
        g.restore();
    }

    strokeHalves(ctx, ax, ay, bx, by, c, colorA, colorB, w) {
        const p1x = ax + c, p1y = ay, p2x = bx - c, p2y = by;
        const m01x = (ax + p1x) / 2, m01y = (ay + p1y) / 2;
        const m12x = (p1x + p2x) / 2, m12y = (p1y + p2y) / 2;
        const m23x = (p2x + bx) / 2, m23y = (p2y + by) / 2;
        const m012x = (m01x + m12x) / 2, m012y = (m01y + m12y) / 2;
        const m123x = (m12x + m23x) / 2, m123y = (m12y + m23y) / 2;
        const mx = (m012x + m123x) / 2, my = (m012y + m123y) / 2;

        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.bezierCurveTo(m01x, m01y, m012x, m012y, mx, my);
        ctx.strokeStyle = colorA;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.bezierCurveTo(m123x, m123y, m23x, m23y, bx, by);
        ctx.strokeStyle = colorB;
        ctx.stroke();
    }

    // ------------------------------------------------------------------
    // Drag cable
    // ------------------------------------------------------------------

    prepareDrag(graph) {
        const cf = graph.connectingFrom;
        const d = this.drag;
        // Drags from a group box port / boundary row: highlight that view port, type from the real one
        d.node = cf.viewNode || cf.node;
        d.reverse = !!cf.isReverse;
        d.realNode = cf.node;
        d.realIndex = cf.isReverse ? cf.inputIndex : cf.outputIndex;
        d.plan = this.plan;
        d.index = cf.viewNode ? cf.viewIndex : (cf.isReverse ? cf.inputIndex : cf.outputIndex);
        let type;
        if (cf.isReverse) {
            const inp = cf.node.inputs[cf.inputIndex];
            type = inp ? inp.type : null;
        } else {
            type = cf.node.getOutputPortType ? cf.node.getOutputPortType(cf.outputIndex)
                : (cf.node.outputs[cf.outputIndex] && cf.node.outputs[cf.outputIndex].type);
            // A typed accessor hint changes what the cable will carry
            const hint = graph.swizzleHintSuggestion || graph.swizzleHint;
            if (hint && type) {
                if (d._hintBase === type && d._hint === hint) {
                    type = d._hintRes;
                } else {
                    let res = null;
                    try { res = TypeRegistry.resolveAccessorType(type, '.' + hint); } catch (e) { res = null; }
                    d._hintBase = type;
                    d._hint = hint;
                    d._hintRes = res || type;
                    type = d._hintRes;
                }
            }
        }
        d.type = type;
        return d;
    }

    /** Port the cable would connect to on mouseup — mirrors NodeGraph.onMouseUp. */
    findDropPort(graph, drag) {
        const x = graph.mouseX, y = graph.mouseY;
        const r = NODE_LAYOUT.portHitRadius;
        for (const node of viewNodesOf(graph)) {
            if (node === drag.node) continue;
            if (drag.reverse) {
                for (let i = 0; i < node.outputs.length; i++) {
                    const p = node.getOutputPortPosition(i);
                    if (p && Math.hypot(x - p.x, y - p.y) < r) return { node, kind: 'out', index: i };
                }
            } else {
                for (let i = 0; i < node.inputs.length; i++) {
                    const p = node.getInputPortPosition(i);
                    if (p && Math.hypot(x - p.x, y - p.y) < r) return { node, kind: 'in', index: i };
                }
            }
        }
        return null;
    }

    drawDragCable(ctx, graph, drag, now, zoom) {
        const cf = graph.connectingFrom;
        const origin = cf.originPos || (drag.reverse ? cf.node.getInputPortPosition(cf.inputIndex)
            : cf.node.getOutputPortPosition(cf.outputIndex));
        if (!origin) return;

        let tx = graph.mouseX;
        let ty = graph.mouseY;
        const hp = this.hoverPort;
        let snapped = false;
        if (hp) {
            const p = hp.kind === 'in' ? hp.node.getInputPortPosition(hp.index) : hp.node.getOutputPortPosition(hp.index);
            if (p) { tx = p.x; ty = p.y; snapped = true; }
        }

        const ax = drag.reverse ? tx : origin.x;
        const ay = drag.reverse ? ty : origin.y;
        const bx = drag.reverse ? origin.x : tx;
        const by = drag.reverse ? origin.y : ty;
        const color = portColor(drag.type);
        const w = Math.max(LAYOUT.cableWidth, 1.25 / zoom);

        ctx.lineCap = 'round';
        traceCable(ctx, ax, ay, bx, by);
        ctx.strokeStyle = CANVAS.cableShadow;
        ctx.lineWidth = w + 2.5;
        ctx.stroke();

        ctx.setLineDash(DASH_DRAG);
        ctx.lineDashOffset = -((now / 28) % 11);
        ctx.strokeStyle = snapped ? lighten(color, 0.25) : color;
        ctx.lineWidth = w;
        ctx.stroke();
        ctx.setLineDash(NO_DASH);
        ctx.lineDashOffset = 0;
        ctx.lineCap = 'butt';

        if (!snapped) {
            // Plug at the free end
            ctx.beginPath();
            ctx.arc(tx, ty, 4, 0, TAU);
            ctx.fillStyle = COLORS.canvas;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(tx, ty, 3, 0, TAU);
            ctx.fillStyle = color;
            ctx.fill();
        }
    }

    // ------------------------------------------------------------------
    // Loop pairs: a dashed bracket over ForLoopStart → ForLoopEnd
    // ------------------------------------------------------------------

    drawLoopLinks(ctx, graph) {
        const scoped = graph.groupCtl && (graph.groupCtl.scope !== null || graph.groupCtl.hasGroups());
        for (const start of graph.nodes) {
            if (!start.isForLoopStartNode || start.data.pairNodeId === null || start.data.pairNodeId === undefined) continue;
            if (scoped && !graph.groupCtl.isVisible(start)) continue;
            let end = start._pairRef;
            if (!end || end.id !== start.data.pairNodeId || graph.nodes.indexOf(end) === -1) {
                end = graph.nodes.find(n => n.id === start.data.pairNodeId) || null;
                start._pairRef = end;
            }
            if (!end) continue;
            if (scoped && !graph.groupCtl.isVisible(end)) continue;

            const color = nodeAccent(start);
            const ax = start.x + Math.min(24, start.width / 2);
            const bx = end.x + end.width - Math.min(24, end.width / 2);
            const top = Math.min(start.y, end.y) - 14;

            ctx.beginPath();
            ctx.moveTo(ax, start.y);
            ctx.lineTo(ax, top + 4);
            ctx.quadraticCurveTo(ax, top, ax + 4, top);
            ctx.lineTo(bx - 4, top);
            ctx.quadraticCurveTo(bx, top, bx, top + 4);
            ctx.lineTo(bx, end.y);
            ctx.setLineDash(DASH_LOOP);
            ctx.strokeStyle = withAlpha(color, 0.45);
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.setLineDash(NO_DASH);

            // "loop" tag in the middle of the bracket
            const label = 'loop';
            const lw = measure(ctx, FONTS.title, label);
            const cx = Math.round((ax + bx) / 2);
            ctx.fillStyle = COLORS.canvas;
            ctx.fillRect(Math.round(cx - lw / 2 - 4), top - 6, Math.ceil(lw + 8), 12);
            ctx.font = FONTS.title;
            ctx.fillStyle = withAlpha(color, 0.8);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(label, cx, Math.round(top + 3));
            ctx.textAlign = 'left';
        }
    }

    // ------------------------------------------------------------------
    // Overlays
    // ------------------------------------------------------------------

    drawSelectionBox(ctx, box, zoom) {
        ctx.fillStyle = withAlpha(COLORS.selection, 0.07);
        ctx.fillRect(box.x, box.y, box.width, box.height);
        ctx.setLineDash([4 / zoom, 3 / zoom]);
        ctx.strokeStyle = withAlpha(COLORS.selection, 0.85);
        ctx.lineWidth = 1 / zoom;
        ctx.strokeRect(box.x, box.y, box.width, box.height);
        ctx.setLineDash(NO_DASH);
    }

    /** Type tooltip next to the hovered port: "name  vec3". Screen space. */
    drawPortTooltip(ctx, hp, panX, panY, zoom) {
        const node = hp.node;
        const isIn = hp.kind === 'in';
        const p = isIn ? node.getInputPortPosition(hp.index) : node.getOutputPortPosition(hp.index);
        if (!p) return;
        const def = isIn ? node.inputs[hp.index] : node.outputs[hp.index];
        if (!def) return;
        const type = isIn ? def.type : (node.getOutputPortType ? node.getOutputPortType(hp.index) : def.type);
        const name = def.name || '';
        const typeText = type || '?';
        const color = portColor(type);

        const font = FONTS.value;
        const nameW = name ? measure(ctx, FONTS.title, name) : 0;
        const typeW = measure(ctx, font, typeText);
        const gap = name ? 6 : 0;
        const w = Math.ceil(nameW + gap + typeW + 14);
        const h = 18;
        const sx = Math.round(p.x * zoom + panX);
        const sy = Math.round(p.y * zoom + panY);
        const offset = 12 + LAYOUT.portRadius * zoom;
        const x = isIn ? sx - offset - w : sx + offset;
        const y = sy - h / 2;

        ctx.save();
        ctx.fillStyle = CANVAS.shadow;
        ctx.beginPath();
        ctx.roundRect(x, y + 2, w, h, 4);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 4);
        ctx.fillStyle = COLORS.panel;
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3.5);
        ctx.strokeStyle = withAlpha(color, 0.6);
        ctx.lineWidth = 1;
        ctx.stroke();
        // Type swatch
        ctx.fillStyle = color;
        ctx.fillRect(x + 1, y + 4, 2, h - 8);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        if (name) {
            ctx.font = FONTS.title;
            ctx.fillStyle = COLORS.textDim;
            ctx.fillText(name, x + 8, y + 12);
        }
        ctx.font = font;
        ctx.fillStyle = color;
        ctx.fillText(typeText, x + 8 + nameW + gap, y + 12);
        ctx.restore();
    }

    /** Typed accessor (".xy", ".position") next to the cursor while dragging. */
    drawAccessorHint(ctx, graph, panX, panY, zoom, drag) {
        const typed = '.' + graph.swizzleHint;
        const rest = graph.swizzleHintSuggestion
            ? graph.swizzleHintSuggestion.substring(graph.swizzleHint.length)
            : '';
        const color = portColor(drag ? drag.type : null);
        const font = FONTS.value;
        const tw = measure(ctx, font, typed);
        const rw = rest ? measure(ctx, font, rest) : 0;
        const w = Math.ceil(tw + rw + 14);
        const h = 18;
        const x = Math.round(graph.mouseX * zoom + panX + 14);
        const y = Math.round(graph.mouseY * zoom + panY + 12);

        ctx.save();
        ctx.fillStyle = CANVAS.shadow;
        ctx.beginPath();
        ctx.roundRect(x, y + 2, w, h, 9);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 9);
        ctx.fillStyle = COLORS.panel;
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 8.5);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = font;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = lighten(color, 0.4);
        ctx.fillText(typed, x + 7, y + 12);
        if (rest) {
            ctx.fillStyle = COLORS.textFaint;
            ctx.fillText(rest, x + 7 + tw, y + 12);
        }
        ctx.restore();
    }
}
