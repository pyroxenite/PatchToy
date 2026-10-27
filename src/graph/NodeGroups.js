/**
 * NodeGroups - node groups ("subgraphs") for NodeGraph.
 *
 * The graph that compiles stays FLAT: graph.nodes / graph.connections are never
 * restructured, so ShaderCompiler, CompilationManager, FeedbackRenderer and the
 * MCP tools see exactly what they always did. A group is view/organization
 * metadata stored next to the graph:
 *
 *   graph.groups = [{ id, name, parentId|null, nodeIds:[...], x, y,
 *                     color?, collapsed?, exposed?: { inputs:[{node,port}], outputs:[{node,port}] },
 *                     portLabels?: { [portKey]: label },
 *                     virtualInputs?: [{node, port}] }]
 *
 *  - nodeIds lists a group's DIRECT members (a node belongs to at most one innermost group);
 *    child groups point at their parent through parentId.
 *  - x, y place the group box in its parent scope. The members keep their own x, y,
 *    which are coordinates inside the group (each scope has its own layout space).
 *  - exposed lists inner ports shown on the group box even when no cable crosses
 *    the boundary yet (created by dropping a cable on the "expose" socket inside).
 *  - portLabels: names the user gave the box ports (else they are derived from the inner
 *    port names, e.g. "Add.a"). Keyed by the port's stable key, the same on the box and
 *    on the matching row of the inside "From outside" / "To outside" panel:
 *      's:<srcNode>:<output>'  input fed from outside by that source
 *      'x:<node>:<input>'      exposed (unpatched) input; also names the 's:' port that
 *                              feeds that input alone once it gets patched
 *      'o:<srcNode>:<output>'  output
 *    Double-click a port label (box or panel row) or use the box's context menu.
 *  - virtualInputs lists "virtual" inputs: an outside output ({node, port}: source node id and
 *    output index) patched to a group input that feeds nothing inside yet, a cable leading
 *    nowhere. Made by dropping a cable on a group box, or left behind when the last inner
 *    cable of an input is unplugged inside the group. Key 's:<srcNode>:<output>' like a live
 *    crossing; connecting it to an inner input inside makes it a normal port. No real
 *    connection exists, so it never reaches the compiler.
 *
 * Viewing a scope (the root or a group) shows the nodes whose innermost group is that
 * scope plus each child group as one box (GroupProxy). Box ports are synthesized from
 * the connections crossing the box boundary (deduped by source port). Inside a group,
 * BoundaryPanels on the left/right list the cables coming from / going to the outside.
 * Cables are drawn between visible representatives (ViewLink).
 */
import { COLORS, FONTS, LAYOUT, NODE_LAYOUT, CATEGORY_COLORS, CANVAS } from '../ui/theme.js';
import { TypeRegistry } from '../core/TypeRegistry.js';
import {
    measure, fitText, nodeAccent, portColor, withAlpha, traceCable, prettyTitle,
    drawGroupBox, drawBoundaryPanel, drawExposeSocket, drawLabel, drawPort, typesCompatible,
    GROUP_LAYOUT, PORT_NORMAL, PORT_HOT, PORT_DIM, groupMinimapTransform
} from '../rendering/NodePainter.js';
import { GroupUI } from '../ui/GroupUI.js';

const ROW_H = LAYOUT.portSpacing;
const OUTSIDE = Object.freeze({ outside: true });
const GENERIC_PORT_NAMES = new Set(['', 'out', 'output', 'result']);
const PANEL_GAP = 110;
// Zoom-gesture group transitions need this many times the zoom the camera covers
const SCRUB_STRETCH = 3;
// ...but never a shorter gesture than this much zoom (log units), however close the preview's scale is
const SCRUB_MIN_SPAN = 4.5;
// Start the dive when the preview is within this zoom ratio of the group's real scale
const SCRUB_ENGAGE_RATIO = 6;
const ROOT_KEY = '\u0000root';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function nodeTitle(node) {
    if (!node) return '?';
    return node.getDisplayTitle ? node.getDisplayTitle() : prettyTitle(node.type);
}
function outName(node, i) {
    const o = node.outputs && node.outputs[i];
    return o ? (o.name || '') : String(i);
}
function inName(node, i) {
    const p = node.inputs && node.inputs[i];
    return p ? (p.name || '') : String(i);
}
function shortOut(node, i) {
    const n = outName(node, i);
    return GENERIC_PORT_NAMES.has(n) ? nodeTitle(node) : n;
}
function qualifiedOut(node, i) {
    const n = outName(node, i);
    return GENERIC_PORT_NAMES.has(n) ? nodeTitle(node) : `${nodeTitle(node)}.${n}`;
}
function qualifiedIn(node, i) {
    return `${nodeTitle(node)}.${inName(node, i)}`;
}
/** The input name all of `conns` feed, when they agree (labels for unnamed / generic outputs). */
function commonDestName(conns) {
    let name = null;
    for (const c of conns) {
        const n = inName(c.toNode, c.toInput);
        if (name === null) name = n;
        else if (name !== n) return null;
    }
    return name;
}
function srcType(node, i) {
    if (!node) return null;
    return node.getOutputPortType ? node.getOutputPortType(i) : (node.outputs[i] && node.outputs[i].type);
}
function commonAccessor(conns) {
    if (!conns.length) return null;
    const a = conns[0].accessor || null;
    for (const c of conns) if ((c.accessor || null) !== a) return null;
    return a;
}
function accessorType(base, accessor) {
    if (!accessor || !base) return base;
    try {
        return TypeRegistry.resolveAccessorType(base, accessor) || base;
    } catch (e) {
        return base;
    }
}
/** True while an MCP/automation command runs (its nodes go to the root, not the user's scope). */
function automationBusy() {
    try {
        return ((typeof window !== 'undefined' && window.__patchtoyBridge && window.__patchtoyBridge.api &&
            window.__patchtoyBridge.api._inCommand) || 0) > 0;
    } catch (e) {
        return false;
    }
}
function itemBox(it) {
    if (it.isGroupProxy) {
        const s = GROUP_LAYOUT.stack * 2;
        return { x0: it.x, y0: it.y - GROUP_LAYOUT.tabH, x1: it.x + it.width + s, y1: it.y + it.height + s };
    }
    return { x0: it.x, y0: it.y, x1: it.x + it.width, y1: it.y + it.height };
}
function bboxOf(items) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
        const b = itemBox(it);
        if (b.x0 < x0) x0 = b.x0;
        if (b.y0 < y0) y0 = b.y0;
        if (b.x1 > x1) x1 = b.x1;
        if (b.y1 > y1) y1 = b.y1;
    }
    return isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

function portStateFor(item, kind, index, type, o) {
    const drag = o.drag;
    const hp = o.hoverPort;
    if (drag) {
        if (drag.node === item) {
            const isOrigin = drag.reverse ? (kind === 'in' && index === drag.index) : (kind === 'out' && index === drag.index);
            return isOrigin ? PORT_HOT : PORT_DIM;
        }
        if (!drag.accepts(kind, type)) return PORT_DIM;
    }
    if (hp && hp.node === item && hp.kind === kind && hp.index === index) return PORT_HOT;
    return PORT_NORMAL;
}

/** Port shape of a box port / panel row: the rate of the real port it stands for (src/core/control/rates.js). */
function groupPortShape(graph, p) {
    const plan = graph && graph._controlPlan;
    if (!plan || !p) return 'circle';
    if (p.source && p.source.node) {
        const t = plan.outType(p.source.node, p.source.index);
        if (t === 'event') return 'event';
        return plan.outRate(p.source.node, p.source.index) === 'control' ? 'diamond' : 'circle';
    }
    if (p.target && p.target.node) return plan.inRate(p.target.node, p.target.index) === 'control' ? 'diamond' : 'circle';
    return 'circle';
}

const PORT_KEY_RE = /^([sxo]):(\d+):(\d+)$/;
export const PORT_LABEL_MAX = 60;

/** Sanitized portLabels map (valid keys, trimmed non-empty labels), or null when empty. */
function cleanPortLabels(raw, nodeExists = null) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(raw)) {
        const m = PORT_KEY_RE.exec(k);
        if (!m || typeof v !== 'string') continue;
        if (nodeExists && !nodeExists(parseInt(m[2], 10))) continue;
        const label = v.replace(/\s+/g, ' ').trim().slice(0, PORT_LABEL_MAX);
        if (!label) continue;
        out[k] = label;
        n++;
    }
    return n ? out : null;
}

/** Port key with its node id mapped through idMap (old id -> new node); null when unmapped. */
function remapPortKey(key, idMap) {
    const m = PORT_KEY_RE.exec(key);
    if (!m) return null;
    const n = idMap.get(parseInt(m[2], 10));
    return n ? `${m[1]}:${n.id}:${m[3]}` : null;
}

/** Distinct {node, index} destinations of a set of connections. */
function targetsOf(conns) {
    const out = [];
    for (const c of conns) if (!out.some(t => t.node === c.toNode && t.index === c.toInput)) out.push({ node: c.toNode, index: c.toInput });
    return out;
}

function newPort(kind, key) {
    // kept: a boundary row of the open group that lost its last inner cable (see "Boundary port
    // sessions" in NodeGroups); entry: its session record, when the group has a session;
    // virtual: a group input patched from outside that feeds nothing inside yet (virtualInputs)
    return { kind, key, source: null, target: null, conns: [], exposed: false, expose: false, kept: false, virtual: false, entry: null, linked: false, label: '', type: null, index: -1, sortY: 0 };
}

// ---------------------------------------------------------------------------
// View link: a cable between visible representatives (box ports / panel rows)
// standing for one or more real connections. Mimics the Connection interface
// the renderer and the accessor menu use.
// ---------------------------------------------------------------------------

export class ViewLink {
    constructor(fromNode, fromOutput, toNode, toInput, conns) {
        this.fromNode = fromNode;
        this.fromOutput = fromOutput;
        this.toNode = toNode;
        this.toInput = toInput;
        this.conns = conns;
        this.isViewLink = true;
    }
    get accessor() { return commonAccessor(this.conns); }
    set accessor(v) {
        for (const c of this.conns) {
            c.accessor = v;
            c.swizzle = v;
        }
    }
    get swizzle() { return this.accessor; }
    set swizzle(v) { this.accessor = v; }

    getOutputType() {
        return accessorType(srcType(this.fromNode, this.fromOutput), this.accessor);
    }
    getMidpoint() {
        const a = this.fromNode.getOutputPortPosition(this.fromOutput);
        const b = this.toNode.getInputPortPosition(this.toInput);
        if (!a || !b) return { x: 0, y: 0 };
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    getLabel() {
        const a = this.accessor;
        if (!a) return '';
        return (a.startsWith('.') ? a.slice(1) : a).replace(/\./g, ' › ');
    }
    containsPoint(px, py) {
        const mid = this.getMidpoint();
        const w = this._pillW || (this.getLabel().length * 7 + 10);
        const h = this._pillH || 18;
        return px >= mid.x - w / 2 && px <= mid.x + w / 2 && py >= mid.y - h / 2 && py <= mid.y + h / 2;
    }
    handleMouseDown(x, y, event, graph) {
        if (!this.containsPoint(x, y)) return null;
        if (graph) graph.showConnectionMenu(this, event);
        return { handled: true };
    }
}

// ---------------------------------------------------------------------------
// Group box (a child group seen from its parent scope)
// ---------------------------------------------------------------------------

export class GroupProxy {
    constructor(ctl, group) {
        this.ctl = ctl;
        this.group = group;
        this.isViewOnly = true;
        this.isGroupProxy = true;
        this.type = 'Group';
        this.inPorts = [];
        this.outPorts = [];
        this.inputs = [];
        this.outputs = [];
        this.width = GROUP_LAYOUT.minWidth;
        this.height = 120;
        this.accent = COLORS.textDim;
        this.count = 0;
        this.subgroups = 0;
        this.countText = '';
        this.minimap = null;
        this._mmRect = { x: 0, y: 0, w: 0, h: 0 };
        this._drawOpts = {};
        this._titleW = 60;
        this._byKey = new Map();
    }

    get id() { return this.group.id; }
    get x() { return this.group.x; }
    set x(v) { this.group.x = v; }
    get y() { return this.group.y; }
    set y(v) { this.group.y = v; }
    get name() { return this.group.name || 'Group'; }
    getDisplayTitle() { return this.name; }

    beginBuild() {
        this.inPorts = [];
        this.outPorts = [];
        this._byKey.clear();
    }

    port(kind, key, srcNode, srcIndex) {
        const k = kind + '|' + key;
        let p = this._byKey.get(k);
        if (!p) {
            p = newPort(kind, key);
            if (srcNode) p.source = { node: srcNode, index: srcIndex };
            this._byKey.set(k, p);
            (kind === 'in' ? this.inPorts : this.outPorts).push(p);
        }
        return p;
    }

    portAt(kind, i) {
        return (kind === 'in' ? this.inPorts : this.outPorts)[i] || null;
    }

    indexOfKey(kind, key) {
        return (kind === 'in' ? this.inPorts : this.outPorts).findIndex(p => p.key === key);
    }

    rows() { return Math.max(this.inputs.length, this.outputs.length); }

    getRowCenterY(r) {
        return this.y + GROUP_LAYOUT.headerH + NODE_LAYOUT.bodyPadTop + ROW_H * r + ROW_H / 2;
    }
    getInputPortPosition(i) {
        if (i < 0 || i >= this.inputs.length) return null;
        return { x: this.x, y: this.getRowCenterY(i) };
    }
    getOutputPortPosition(i) {
        if (i < 0 || i >= this.outputs.length) return null;
        return { x: this.x + this.width, y: this.getRowCenterY(i) };
    }
    getOutputPortType(i) {
        return this.outputs[i] ? this.outputs[i].type : null;
    }
    isPortConnected(kind, i) {
        const p = this.portAt(kind, i);
        return !!(p && p.linked);
    }
    containsPoint(x, y) {
        return x >= this.x && x <= this.x + this.width && y >= this.y - GROUP_LAYOUT.tabH && y <= this.y + this.height;
    }
    hitTitle(x, y) {
        return y >= this.y - GROUP_LAYOUT.tabH && y <= this.y + GROUP_LAYOUT.headerH &&
            x >= this.x + 22 && x <= this.x + 27 + Math.max(40, this._titleW) + 4;
    }
    handleMouseDown(x, y) {
        return { type: 'START_NODE_DRAG', node: this, offsetX: x - this.x, offsetY: y - this.y };
    }
    handleMouseMove() { return null; }

    /** The port whose label (or socket) is at x, y: { kind, index, port } or null. */
    portLabelAt(x, y) {
        const half = ROW_H / 2;
        const colL = this._colL ?? 60, colR = this._colR ?? 60;
        if (x >= this.x - 8 && x <= this.x + colL) {
            for (let i = 0; i < this.inputs.length; i++) {
                if (Math.abs(y - this.getRowCenterY(i)) <= half) return { kind: 'in', index: i, port: this.inPorts[i] };
            }
        }
        if (x >= this.x + this.width - colR && x <= this.x + this.width + 8) {
            for (let i = 0; i < this.outputs.length; i++) {
                if (Math.abs(y - this.getRowCenterY(i)) <= half) return { kind: 'out', index: i, port: this.outPorts[i] };
            }
        }
        return null;
    }

    /** Where the "new input" socket shows while a cable from outside is dragged over the box. */
    newInputSocketPos() {
        return { x: this.x, y: Math.min(this.getRowCenterY(this.inputs.length), this.y + this.height - 2) };
    }

    /** Is (x, y) on the "new input" drop zone: the inputs column below the header, or the socket? */
    newInputZoneAt(x, y) {
        const s = this.newInputSocketPos();
        if (Math.hypot(x - s.x, y - s.y) <= ROW_H / 2 + 2) return true;
        const colL = Math.max(this._colL ?? 60, 48);
        return x >= this.x - 8 && x <= this.x + colL && y >= this.y + GROUP_LAYOUT.headerH && y <= this.y + this.height + 4;
    }

    /** A forward cable drag that could add an input to this box (from outside it). */
    _acceptsNewInput(o) {
        const d = o.drag;
        if (!d || d.reverse || d.node === this || !d.realNode || d.realNode.isViewOnly) return false;
        return !(this.ctl && this.ctl.isInSubtree(d.realNode, this.group.id));
    }

    /** Graph-space rectangle of a port's label (inline rename field). */
    portLabelRect(kind, index) {
        const cy = this.getRowCenterY(index);
        const colL = this._colL ?? 60, colR = this._colR ?? 60;
        return kind === 'in'
            ? { x: this.x + 6, y: cy - ROW_H / 2, w: Math.max(colL, 90), h: ROW_H, align: 'left' }
            : { x: this.x + this.width - Math.max(colR, 90) - 6, y: cy - ROW_H / 2, w: Math.max(colR, 90), h: ROW_H, align: 'right' };
    }

    /**
     * Layout: header on top; below it three columns - input labels, the inner-layout
     * minimap, output labels - so the preview sits beside the ports, not under them.
     */
    layout(ctx) {
        const G = GROUP_LAYOUT;
        const titleNeed = measure(ctx, G.titleFont, this.name) + 27 + 18 + measure(ctx, FONTS.value, this.countText) + 22;
        const labelCol = (list) => {
            let w = 0;
            for (const p of list) w = Math.max(w, measure(ctx, FONTS.title, p.name));
            return list.length ? Math.min(G.labelMax, Math.ceil(w)) + 16 : 6;
        };
        this._colL = labelCol(this.inputs);
        this._colR = labelCol(this.outputs);
        const need = Math.max(titleNeed, this._colL + this._colR + 2 * G.minimapGap + G.minimapMinW);
        this.width = Math.max(G.minWidth, Math.ceil(need / 2) * 2);
        const rowsH = NODE_LAYOUT.bodyPadTop + ROW_H * this.rows() + 4;
        this.height = G.headerH + Math.max(rowsH, G.minimapH + 14) + G.padBottom;
    }

    /** The minimap well, in graph coordinates (between the port label columns). */
    minimapRect() {
        const G = GROUP_LAYOUT;
        const m = this._mmRect;
        const colL = this._colL ?? 6;
        const colR = this._colR ?? 6;
        m.x = this.x + colL + G.minimapGap;
        m.w = Math.max(20, this.width - colL - colR - 2 * G.minimapGap);
        m.y = this.y + G.headerH + 7;
        m.h = Math.max(20, this.height - G.headerH - 7 - G.padBottom);
        return m;
    }

    draw(ctx, o = {}) {
        const G = GROUP_LAYOUT;
        const d = this._drawOpts;
        d.accent = this.accent;
        d.name = this.name;
        d.countText = this.countText;
        d.selected = !!o.isSelected;
        d.hovered = !!o.isHovered;
        d.minimap = this.minimap;
        d.minimapRect = this.minimapRect();
        drawGroupBox(ctx, this.x, this.y, this.width, this.height, d);
        this._titleW = d.titleWidth || this._titleW;

        for (let i = 0; i < this.inputs.length; i++) {
            const pos = this.getInputPortPosition(i);
            const p = this.inPorts[i];
            const type = this.inputs[i].type;
            const state = portStateFor(this, 'in', i, type, o);
            const label = fitText(ctx, FONTS.title, this.inputs[i].name, (this._colL ?? 60) - 14);
            drawLabel(ctx, label, pos.x + 10, pos.y, state === PORT_DIM ? COLORS.textFaint : ((p.exposed || p.kept) && !p.linked ? COLORS.textFaint : COLORS.textDim));
            drawPort(ctx, pos.x, pos.y, portColor(type), p.linked, state, groupPortShape(this.ctl && this.ctl.graph, p));
        }
        for (let i = 0; i < this.outputs.length; i++) {
            const pos = this.getOutputPortPosition(i);
            const p = this.outPorts[i];
            const type = this.outputs[i].type;
            const state = portStateFor(this, 'out', i, type, o);
            const label = fitText(ctx, FONTS.title, this.outputs[i].name, (this._colR ?? 60) - 14);
            drawLabel(ctx, label, pos.x - 10, pos.y, state === PORT_DIM ? COLORS.textFaint : ((p.exposed || p.kept) && !p.linked ? COLORS.textFaint : COLORS.textDim), 'right');
            drawPort(ctx, pos.x, pos.y, portColor(type), p.linked, state, groupPortShape(this.ctl && this.ctl.graph, p));
        }

        // Dragging a cable from outside over the box: it can become a new input (drop target)
        if (this._acceptsNewInput(o) && o.mouseX != null && this.containsPoint(o.mouseX, o.mouseY)) {
            const hp = o.hoverPort;
            const onPort = hp && hp.node === this;
            const zone = !onPort && this.newInputZoneAt(o.mouseX, o.mouseY);
            ctx.beginPath();
            ctx.roundRect(this.x - 3, this.y - G.tabH - 3, this.width + 6, this.height + G.tabH + 6, G.radius + 3);
            ctx.strokeStyle = withAlpha(this.accent, zone ? 0.75 : 0.4);
            ctx.lineWidth = zone ? 2 : 1.5;
            ctx.stroke();
            if (!onPort) {
                const s = this.newInputSocketPos();
                drawLabel(ctx, zone ? 'drop: new input' : 'new input', s.x + 12, s.y, zone ? this.accent : COLORS.textFaint);
                drawExposeSocket(ctx, s.x, s.y, this.accent, zone, o.time || 0);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Boundary panel (inside a group): what comes from / goes to the outside
// ---------------------------------------------------------------------------

export class BoundaryPanel {
    constructor(ctl, side) {
        this.ctl = ctl;
        this.side = side; // 'in' (left, ports on its right edge) | 'out' (right, ports on its left edge)
        this.isViewOnly = true;
        this.isBoundaryPanel = true;
        this.id = side === 'in' ? '__groupInputs' : '__groupOutputs';
        this.type = side === 'in' ? 'GroupInputs' : 'GroupOutputs';
        this.rows = [];
        this.inputs = [];
        this.outputs = [];
        this.width = GROUP_LAYOUT.panelWidth;
        this.height = 60;
        this.x = 0;
        this.y = 0;
        this._byKey = new Map();
    }

    beginBuild() {
        this.rows = [];
        this._byKey.clear();
    }

    port(key, srcNode, srcIndex) {
        let p = this._byKey.get(key);
        if (!p) {
            p = newPort(this.side === 'in' ? 'out' : 'in', key);
            if (srcNode) p.source = { node: srcNode, index: srcIndex };
            this._byKey.set(key, p);
            this.rows.push(p);
        }
        return p;
    }

    portAt(kind, i) {
        if ((this.side === 'in') !== (kind === 'out')) return null;
        return this.rows[i] || null;
    }
    indexOfKey(key) { return this.rows.findIndex(r => r.key === key); }

    rowY(i) { return this.y + GROUP_LAYOUT.panelHeaderH + 3 + ROW_H * i + ROW_H / 2; }
    getOutputPortPosition(i) {
        if (this.side !== 'in' || i < 0 || i >= this.rows.length) return null;
        return { x: this.x + this.width, y: this.rowY(i) };
    }
    getInputPortPosition(i) {
        if (this.side !== 'out' || i < 0 || i >= this.rows.length) return null;
        return { x: this.x, y: this.rowY(i) };
    }
    getOutputPortType(i) { return this.rows[i] ? this.rows[i].type : null; }
    isPortConnected(kind, i) { return !!(this.rows[i] && this.rows[i].linked); }
    containsPoint(x, y) {
        return x >= this.x && x <= this.x + this.width && y >= this.y && y <= this.y + this.height;
    }
    rowAt(x, y) {
        if (!this.containsPoint(x, y)) return -1;
        const i = Math.floor((y - this.y - GROUP_LAYOUT.panelHeaderH - 3) / ROW_H);
        return i >= 0 && i < this.rows.length ? i : -1;
    }
    /** Graph-space rectangle of a row's label (inline rename field). */
    portLabelRect(index) {
        const cy = this.rowY(index);
        return { x: this.x + 6, y: cy - ROW_H / 2, w: Math.max(90, this.width - 24), h: ROW_H, align: this.side === 'in' ? 'right' : 'left' };
    }
    handleMouseDown() { return null; }   // body clicks fall through to rubber-band selection
    handleMouseMove() { return null; }

    finishLayout(ctx) {
        let need = GROUP_LAYOUT.panelWidth;
        for (const r of this.rows) need = Math.max(need, measure(ctx, FONTS.title, r.label) + 36);
        this.width = Math.min(300, Math.ceil(need / 2) * 2);
        this.height = GROUP_LAYOUT.panelHeaderH + 3 + ROW_H * this.rows.length + 7;
        const list = this.rows.map(r => ({ name: r.label, type: r.type }));
        this.inputs = this.side === 'out' ? list : [];
        this.outputs = this.side === 'in' ? list : [];
    }

    draw(ctx, o = {}) {
        const accent = this.ctl.scopeAccent();
        const drag = o.drag;
        const wantsExpose = !!drag && (this.side === 'in' ? drag.reverse : !drag.reverse) && drag.node !== this;
        drawBoundaryPanel(ctx, this.x, this.y, this.width, this.height, { side: this.side, accent, hot: wantsExpose });
        for (let i = 0; i < this.rows.length; i++) {
            const r = this.rows[i];
            const pos = this.side === 'in' ? this.getOutputPortPosition(i) : this.getInputPortPosition(i);
            const kind = this.side === 'in' ? 'out' : 'in';
            if (r.expose) {
                const hot = wantsExpose;
                const text = hot ? 'drop to expose' : r.label;
                const color = hot ? accent : COLORS.textFaint;
                if (this.side === 'in') drawLabel(ctx, text, pos.x - 12, pos.y, color, 'right');
                else drawLabel(ctx, text, pos.x + 12, pos.y, color);
                drawExposeSocket(ctx, pos.x, pos.y, accent, hot, o.time || 0);
                continue;
            }
            const state = portStateFor(this, kind, i, r.type, o);
            const color = state === PORT_DIM ? COLORS.textFaint : ((r.exposed || r.kept || r.virtual) && !r.conns.length && !r.linked ? COLORS.textFaint : COLORS.textDim);
            const label = fitText(ctx, FONTS.title, r.label, this.width - 30);
            if (this.side === 'in') drawLabel(ctx, label, pos.x - 10, pos.y, color, 'right');
            else drawLabel(ctx, label, pos.x + 10, pos.y, color);
            drawPort(ctx, pos.x, pos.y, portColor(r.type), r.linked, state, groupPortShape(this.ctl && this.ctl.graph, r));
        }
    }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class NodeGroups {
    constructor(graph, { Connection = null } = {}) {
        this.graph = graph;
        this.Connection = Connection;
        if (!Array.isArray(graph.groups)) graph.groups = [];
        this.scope = null;
        this.version = 0;
        this._indexVersion = -1;
        this._indexGroups = null;
        this._view = null;
        this._viewAlt = null; // previous scope's view, kept for the enter/exit transition
        this._proxies = new Map();
        this._panels = new Map(); // scope -> { in, out } boundary panels
        this._transition = null;
        this.scopeViews = new Map();
        // Boundary port sessions: gid -> { ins: Map(key -> entry), outs: Map(key -> entry) }
        // for the open group and its ancestors (transient UI state, never saved)
        this._sessions = new Map();
        this._sessionSeq = 0;
        this.ui = new GroupUI(this);
    }

    get groups() {
        if (!Array.isArray(this.graph.groups)) this.graph.groups = [];
        return this.graph.groups;
    }

    /** Call after every change to group metadata. */
    touch() { this.version++; }

    hasGroups() { return this.groups.length > 0; }

    // ------------------------------------------------------------------
    // Index
    // ------------------------------------------------------------------

    _index() {
        const list = this.groups;
        if (this._indexVersion === this.version && this._indexGroups === list) return;
        this._indexVersion = this.version;
        this._indexGroups = list;
        const byId = new Map();
        for (const grp of list) if (grp && grp.id != null && !byId.has(grp.id)) byId.set(grp.id, grp);
        const groupOf = new Map();
        for (const grp of byId.values()) {
            for (const id of grp.nodeIds || []) if (!groupOf.has(id)) groupOf.set(id, grp.id);
        }
        const parentOf = new Map();
        for (const grp of byId.values()) {
            const p = grp.parentId;
            parentOf.set(grp.id, p != null && p !== grp.id && byId.has(p) ? p : null);
        }
        for (const grp of byId.values()) {
            const seen = new Set([grp.id]);
            let cur = parentOf.get(grp.id);
            while (cur != null) {
                if (seen.has(cur)) { parentOf.set(grp.id, null); break; }
                seen.add(cur);
                cur = parentOf.get(cur);
            }
        }
        const children = new Map();
        for (const grp of byId.values()) {
            const p = parentOf.get(grp.id);
            if (!children.has(p)) children.set(p, []);
            children.get(p).push(grp);
        }
        this._byId = byId;
        this._groupOf = groupOf;
        this._parentOf = parentOf;
        this._children = children;
        this._chains = new Map();
    }

    getGroup(gid) { this._index(); return gid == null ? null : (this._byId.get(gid) || null); }
    groupOf(nodeId) { this._index(); const g = this._groupOf.get(nodeId); return g === undefined ? null : g; }
    parentOf(gid) { this._index(); if (gid == null) return null; const p = this._parentOf.get(gid); return p === undefined ? null : p; }
    childrenOf(gid) { this._index(); return this._children.get(gid == null ? null : gid) || []; }

    /** [gid, parent, ..., top-level group]; [] for the root. */
    chainOf(gid) {
        if (gid == null) return [];
        this._index();
        let c = this._chains.get(gid);
        if (c) return c;
        c = [];
        let cur = gid;
        while (cur != null && c.length < 64) {
            c.push(cur);
            const p = this._parentOf.get(cur);
            cur = p === undefined ? null : p;
        }
        this._chains.set(gid, c);
        return c;
    }
    isInSubtree(node, gid) {
        if (gid == null) return true;
        return this.chainOf(this.groupOf(node.id)).includes(gid);
    }
    subtreeGroups(gid) {
        const out = [];
        const walk = (id) => {
            for (const ch of this.childrenOf(id)) {
                out.push(ch);
                walk(ch.id);
            }
        };
        walk(gid);
        return out;
    }
    subtreeNodes(gid) {
        const ids = new Set([gid, ...this.subtreeGroups(gid).map(g => g.id)]);
        return this.graph.nodes.filter(n => ids.has(this.groupOf(n.id)));
    }
    directNodes(gid) {
        const key = gid == null ? null : gid;
        return this.graph.nodes.filter(n => this.groupOf(n.id) === key);
    }
    /** Breadcrumb path for a scope: [{id:null, name:'Root'}, ..., {id, name}] */
    path(gid = this.scope) {
        const chain = this.chainOf(gid).slice().reverse();
        return [{ id: null, name: 'Root' }, ...chain.map(id => ({ id, name: (this.getGroup(id) || {}).name || 'Group' }))];
    }
    _nodeById(id) {
        const g = this.graph;
        if (!this._nodeMap || this._nodeMapRef !== g.nodes || this._nodeMapLen !== g.nodes.length) {
            this._nodeMap = new Map(g.nodes.map(n => [n.id, n]));
            this._nodeMapRef = g.nodes;
            this._nodeMapLen = g.nodes.length;
        }
        return this._nodeMap.get(id) || null;
    }
    _proxy(group) {
        let p = this._proxies.get(group.id);
        if (!p || p.group !== group) {
            p = new GroupProxy(this, group);
            this._proxies.set(group.id, p);
        }
        return p;
    }
    proxyFor(gid) {
        const grp = this.getGroup(gid);
        return grp ? this._proxy(grp) : null;
    }

    /** Accent for a group: explicit color (category name or hex) or its dominant node category. */
    groupAccent(gid) {
        const grp = this.getGroup(gid);
        if (!grp) return COLORS.accent;
        if (grp.color) {
            if (CATEGORY_COLORS[grp.color]) return CATEGORY_COLORS[grp.color];
            if (/^#[0-9a-f]{6}$/i.test(grp.color)) return grp.color;
        }
        const counts = new Map();
        let best = null, bestN = 0, fallback = null;
        for (const n of this.subtreeNodes(gid)) {
            if (n.isCommentNode) continue;
            const cat = n.definition && n.definition.category;
            const c = nodeAccent(n);
            if (cat === 'constant' || cat === 'output' || cat === 'input') { fallback = fallback || c; continue; }
            const k = (counts.get(c) || 0) + 1;
            counts.set(c, k);
            if (k > bestN) { best = c; bestN = k; }
        }
        return best || fallback || COLORS.textDim;
    }
    scopeAccent() {
        if (this.scope === null) return COLORS.accent;
        const p = this._proxies.get(this.scope);
        return (p && p.accent) || this.groupAccent(this.scope);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /** The (cached) view of the current scope. */
    view() {
        const g = this.graph;
        if (this.scope !== null && !this.getGroup(this.scope)) {
            this.scope = null;
            this.ui.update();
        }
        const sig = this.version + '|' + this.scope;
        const fresh = (v) => v && v.sig === sig && v.nodesRef === g.nodes && v.nodesLen === g.nodes.length &&
            v.connsRef === g.connections && v.connsLen === g.connections.length;
        if (fresh(this._view)) return this._view;
        // Two views are cached so a transition can draw the parent and the child every frame
        if (fresh(this._viewAlt)) {
            const v = this._viewAlt;
            this._viewAlt = this._view;
            this._view = v;
            return v;
        }
        const nv = this.buildView(this.scope);
        nv.sig = sig;
        nv.nodesRef = g.nodes;
        nv.nodesLen = g.nodes.length;
        nv.connsRef = g.connections;
        nv.connsLen = g.connections.length;
        this._viewAlt = this._view;
        this._view = nv;
        return nv;
    }

    invalidate() {
        this._view = null;
        this._viewAlt = null;
    }

    _panelsOf(scope) {
        let p = this._panels.get(scope);
        if (!p) {
            p = { in: new BoundaryPanel(this, 'in'), out: new BoundaryPanel(this, 'out') };
            this._panels.set(scope, p);
        }
        return p;
    }

    /** Run fn with another scope temporarily current (drawing only; no UI side effects). */
    withScope(scope, fn) {
        const prev = this.scope;
        this.scope = scope;
        try {
            return fn();
        } finally {
            this.scope = prev;
        }
    }

    /** Items to draw / hit-test in the current scope, bottom to top: notes, nodes, group boxes, panels. */
    viewNodes() {
        const g = this.graph;
        if (this.scope === null && !this.hasGroups()) return g.nodes;
        const v = this.view();
        const out = [];
        for (const n of g.nodes) if (n.isCommentNode && v.nodeSet.has(n)) out.push(n);
        for (const n of g.nodes) if (!n.isCommentNode && v.nodeSet.has(n)) out.push(n);
        for (const p of v.proxies) out.push(p);
        if (v.inPanel) {
            this._placePanels(v);
            out.push(v.inPanel, v.outPanel);
        }
        return out;
    }

    /** Cables to draw / hit-test in the current scope. */
    viewLinks() {
        if (this.scope === null && !this.hasGroups()) return this.graph.connections;
        return this.view().links;
    }

    /** Is a real node visible (directly) in the current scope? */
    isVisible(node) {
        if (this.scope === null && !this.hasGroups()) return true;
        return this.view().nodeSet.has(node);
    }

    _placePanels(v) {
        // Notes don't count: the panels hug the actual signal nodes
        const items = [...v.nodeSet, ...v.proxies].filter(n => !n.isCommentNode);
        const bb = bboxOf(items) || { x0: 0, y0: 0, x1: 320, y1: 200 };
        const cy = (bb.y0 + bb.y1) / 2;
        const a = v.inPanel, b = v.outPanel;
        a.x = Math.round(bb.x0 - PANEL_GAP - a.width);
        a.y = Math.round(cy - a.height / 2);
        b.x = Math.round(bb.x1 + PANEL_GAP);
        b.y = Math.round(cy - b.height / 2);
    }

    buildView(scope) {
        const g = this.graph;
        this._index();
        const ctx = g.ctx;
        const view = { scope, nodeSet: new Set(), proxies: [], links: [], ghosts: [], inPanel: null, outPanel: null, proxyOf: new Map() };
        for (const grp of this.childrenOf(scope)) {
            const p = this._proxy(grp);
            p.beginBuild();
            view.proxies.push(p);
            view.proxyOf.set(grp.id, p);
        }
        const inside = scope !== null;
        let inPanel = null, outPanel = null;
        if (inside) {
            const panels = this._panelsOf(scope);
            inPanel = panels.in;
            outPanel = panels.out;
            inPanel.beginBuild();
            outPanel.beginBuild();
            view.inPanel = inPanel;
            view.outPanel = outPanel;
        }

        const repCache = new Map();
        const rep = (node) => {
            let r = repCache.get(node);
            if (r !== undefined) return r;
            const gid = this.groupOf(node.id);
            if (gid === scope) {
                r = node;
            } else {
                const chain = this.chainOf(gid);
                if (scope === null) {
                    r = chain.length ? view.proxyOf.get(chain[chain.length - 1]) : node;
                } else {
                    const k = chain.indexOf(scope);
                    r = k > 0 ? view.proxyOf.get(chain[k - 1]) : OUTSIDE;
                }
                if (!r) r = OUTSIDE;
            }
            repCache.set(node, r);
            return r;
        };
        view.rep = rep;
        for (const n of g.nodes) if (rep(n) === n) view.nodeSet.add(n);

        // --- crossings -> box ports, panel rows and view links
        const linkMap = new Map();
        const vid = (v) => (v.isViewOnly ? 'v:' + v.id : 'n:' + v.id);
        const addLink = (src, sp, dst, dp, c) => {
            const key = vid(src) + '|' + (typeof sp === 'number' ? sp : sp.key) + '>' + vid(dst) + '|' + (typeof dp === 'number' ? dp : dp.key);
            let e = linkMap.get(key);
            if (!e) {
                e = { src, sp, dst, dp, conns: [] };
                linkMap.set(key, e);
            }
            e.conns.push(c);
        };
        for (const c of g.connections) {
            const a = c.fromNode, b = c.toNode;
            if (!a || !b) continue;
            const ra = rep(a), rb = rep(b);
            if (ra === OUTSIDE && rb === OUTSIDE) continue;
            if (ra === rb) continue; // inside one child box
            if (ra === a && rb === b) { view.links.push(c); continue; }
            const sKey = a.id + ':' + c.fromOutput;
            let src, sp, dst, dp;
            if (ra === OUTSIDE) { src = inPanel; sp = inPanel.port('s:' + sKey, a, c.fromOutput); sp.conns.push(c); }
            else if (ra.isGroupProxy) { src = ra; sp = ra.port('out', 'o:' + sKey, a, c.fromOutput); sp.conns.push(c); }
            else { src = ra; sp = c.fromOutput; }
            if (rb === OUTSIDE) { dst = outPanel; dp = outPanel.port('o:' + sKey, a, c.fromOutput); dp.conns.push(c); }
            else if (rb.isGroupProxy) { dst = rb; dp = rb.port('in', 's:' + sKey, a, c.fromOutput); dp.conns.push(c); }
            else { dst = rb; dp = c.toInput; }
            addLink(src, sp, dst, dp, c);
        }

        // --- virtual inputs: an outside source patched to a group input that feeds nothing inside
        // yet. Routed like a crossing cable whose inner end is the group itself; drawn as cables
        // (view.ghosts, solid) since no real connection stands behind them
        const vlinks = new Map();
        const groupRep = (gid) => {
            const chain = this.chainOf(gid);
            if (scope === null) return view.proxyOf.get(chain[chain.length - 1]) || OUTSIDE;
            const k = chain.indexOf(scope);
            if (k === 0) return null; // the open group itself
            return k > 0 ? (view.proxyOf.get(chain[k - 1]) || OUTSIDE) : OUTSIDE;
        };
        for (const grp of this.groups) {
            const list = grp && grp.virtualInputs;
            if (!list || !list.length) continue;
            const rb = groupRep(grp.id);
            for (const e of list) {
                const a = this._nodeById(e.node);
                if (!a || e.port >= a.outputs.length || this.isInSubtree(a, grp.id)) continue;
                if (this._crossing(grp.id, 'in', a.id, e.port)) continue; // a real cable: a normal port
                const ra = rep(a);
                const sKey = a.id + ':' + e.port;
                if (rb === null) {
                    if (ra === OUTSIDE) inPanel.port('s:' + sKey, a, e.port).virtual = true;
                    continue;
                }
                if (ra === rb || (ra === OUTSIDE && rb === OUTSIDE)) continue;
                let src, sp, dst, dp;
                if (ra === OUTSIDE) { src = inPanel; sp = inPanel.port('s:' + sKey, a, e.port); sp.virtual = true; }
                else if (ra.isGroupProxy) { src = ra; sp = ra.port('out', 'o:' + sKey, a, e.port); sp.virtual = true; }
                else { src = ra; sp = e.port; }
                if (rb === OUTSIDE) { dst = outPanel; dp = outPanel.port('o:' + sKey, a, e.port); }
                else { dst = rb; dp = rb.port('in', 's:' + sKey, a, e.port); }
                dp.virtual = true;
                const key = vid(src) + '|' + (typeof sp === 'number' ? sp : sp.key) + '>' + vid(dst) + '|' + dp.key;
                if (!vlinks.has(key)) vlinks.set(key, { src, sp, dst, dp, type: srcType(a, e.port) });
            }
        }

        // --- rows / box ports kept by a boundary port session (unplugged inside, still shown)
        for (const p of view.proxies) {
            const ses = this._sessions.get(p.group.id);
            if (ses) this._applySession(ses, p.group.id, rep, view, p);
        }
        const ses = inside ? this._sessions.get(scope) : null;
        if (ses) this._applySession(ses, scope, rep, view, null);

        // --- exposed ports (shown even without a crossing cable)
        const feedOf = (node, port) => g.connections.find(c => c.toNode === node && c.toInput === port) || null;
        for (const p of view.proxies) {
            const ex = p.group.exposed;
            if (!ex) continue;
            for (const e of ex.outputs || []) {
                const n = this._nodeById(e.node);
                if (!n || e.port >= n.outputs.length || !this.isInSubtree(n, p.group.id)) continue;
                p.port('out', 'o:' + n.id + ':' + e.port, n, e.port).exposed = true;
            }
            for (const e of ex.inputs || []) {
                const n = this._nodeById(e.node);
                if (!n || e.port >= n.inputs.length || !this.isInSubtree(n, p.group.id)) continue;
                if (feedOf(n, e.port)) continue; // already patched (from outside: a crossing port shows it)
                const port = p.port('in', 'x:' + n.id + ':' + e.port, null, null);
                port.exposed = true;
                port.target = { node: n, index: e.port };
            }
        }
        if (inside) {
            const grp = this.getGroup(scope);
            const ex = grp && grp.exposed;
            if (ex) {
                for (const e of ex.outputs || []) {
                    const n = this._nodeById(e.node);
                    if (!n || e.port >= n.outputs.length || !this.isInSubtree(n, scope)) continue;
                    const row = outPanel.port('o:' + n.id + ':' + e.port, n, e.port);
                    row.exposed = true;
                    if (!row.conns.length) {
                        const r = rep(n);
                        const sp = r === n ? e.port : r.port('out', 'o:' + n.id + ':' + e.port, n, e.port);
                        view.ghosts.push({ src: r, sp, dst: outPanel, dp: row, type: srcType(n, e.port) });
                    }
                }
                for (const e of ex.inputs || []) {
                    const n = this._nodeById(e.node);
                    if (!n || e.port >= n.inputs.length || !this.isInSubtree(n, scope)) continue;
                    if (feedOf(n, e.port)) continue;
                    const row = inPanel.port('x:' + n.id + ':' + e.port, null, null);
                    row.exposed = true;
                    row.target = { node: n, index: e.port };
                    const r = rep(n);
                    let dp = e.port;
                    if (r !== n) {
                        dp = r.port('in', 'x:' + n.id + ':' + e.port, null, null);
                        dp.exposed = true;
                        dp.target = { node: n, index: e.port };
                    }
                    view.ghosts.push({ src: inPanel, sp: row, dst: r, dp, type: n.inputs[e.port] && n.inputs[e.port].type });
                }
            }
        }

        // --- order, label and size ports
        const repY = (node) => {
            const r = rep(node);
            if (r === OUTSIDE) return null;
            return r.y;
        };
        for (const p of view.proxies) this._finishProxy(p, repY, ctx);
        if (inside) {
            this._finishPanel(inPanel, repY, ctx, scope);
            this._finishPanel(outPanel, repY, ctx, scope);
            if (ses) this._recordSession(ses, scope, inPanel, outPanel);
        }

        // Virtual cables (unless a real cable joins the same two view ports)
        for (const [key, e] of vlinks) {
            if (linkMap.has(key)) continue;
            if (typeof e.sp !== 'number') e.sp.linked = true;
            e.dp.linked = true;
            view.ghosts.push({ ...e, solid: true });
        }
        for (const e of linkMap.values()) {
            const fi = typeof e.sp === 'number' ? e.sp : e.sp.index;
            const ti = typeof e.dp === 'number' ? e.dp : e.dp.index;
            if (typeof e.sp !== 'number') e.sp.linked = true;
            if (typeof e.dp !== 'number') e.dp.linked = true;
            if (fi < 0 || ti < 0) continue;
            view.links.push(new ViewLink(e.src, fi, e.dst, ti, e.conns));
        }
        view.ghosts = view.ghosts.map(gl => ({
            src: gl.src, si: typeof gl.sp === 'number' ? gl.sp : gl.sp.index,
            dst: gl.dst, di: typeof gl.dp === 'number' ? gl.dp : gl.dp.index,
            type: gl.type, solid: !!gl.solid
        })).filter(gl => gl.si >= 0 && gl.di >= 0);
        return view;
    }

    _finishProxy(p, repY, ctx) {
        const gid = p.group.id;
        // In-ports: crossings sorted by where their source sits in this scope; exposed ones last
        for (const port of p.inPorts) {
            if (port.source) {
                const y = repY(port.source.node);
                port.sortY = y === null ? -1e6 : y;
                // A kept port (no inner cable left) keeps the name of what it fed
                const targets = port.conns.length ? targetsOf(port.conns) : this._keptTargets(port);
                port.targets = targets;
                port.label = targets.length === 1 ? inName(targets[0].node, targets[0].index) : shortOut(port.source.node, port.source.index);
                port.qualified = targets.length === 1 ? qualifiedIn(targets[0].node, targets[0].index) : qualifiedOut(port.source.node, port.source.index);
                const inType = targets.length === 1 && targets[0].node.inputs[targets[0].index] ? targets[0].node.inputs[targets[0].index].type : null;
                const flowing = accessorType(srcType(port.source.node, port.source.index), commonAccessor(port.conns));
                port.type = inType && inType !== 'any' ? inType : flowing;
            } else if (port.target) {
                port.sortY = 1e6 + (port.target.node.y || 0);
                port.label = inName(port.target.node, port.target.index);
                port.qualified = qualifiedIn(port.target.node, port.target.index);
                const t = port.target.node.inputs[port.target.index];
                port.type = t ? t.type : null;
            }
        }
        for (const port of p.outPorts) {
            let y = null;
            for (const c of port.conns) {
                const dy = repY(c.toNode);
                const v = dy === null ? 1e5 : dy;
                if (y === null || v < y) y = v;
            }
            port.sortY = y === null ? 1e6 + (port.source.node.y || 0) : y;
            const generic = GENERIC_PORT_NAMES.has(outName(port.source.node, port.source.index));
            const dest = generic ? commonDestName(port.conns.length ? port.conns : this._keptDestConns(port)) : null;
            port.label = dest || shortOut(port.source.node, port.source.index);
            port.qualified = dest ? `${nodeTitle(port.source.node)} → ${dest}` : qualifiedOut(port.source.node, port.source.index);
            port.type = srcType(port.source.node, port.source.index);
        }
        const finish = (list) => {
            list.sort((a, b) => a.sortY - b.sortY || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            const counts = new Map();
            for (const port of list) counts.set(port.label, (counts.get(port.label) || 0) + 1);
            list.forEach((port, i) => {
                port.index = i;
                if (counts.get(port.label) > 1 && port.qualified) port.label = port.qualified;
                // The user's name for this port wins (portLabels)
                port.autoLabel = port.label;
                const custom = this._customPortLabel(p.group, port);
                port.custom = !!custom;
                if (custom) port.label = custom;
            });
            return list.map(port => ({ name: port.label, type: port.type }));
        };
        p.inputs = finish(p.inPorts);
        p.outputs = finish(p.outPorts);

        // Counts, accent, minimap
        const nodes = this.subtreeNodes(gid).filter(n => !n.isCommentNode);
        p.count = nodes.length;
        p.subgroups = this.subtreeGroups(gid).length;
        p.countText = `${p.count} node${p.count === 1 ? '' : 's'}`;
        p.accent = this.groupAccent(gid);
        p.minimap = this._minimapFor(gid);
        p.layout(ctx);
    }

    _minimapFor(gid) {
        const items = [];
        const centers = new Map();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const add = (key, x, y, w, h, color, kind) => {
            items.push({ x, y, w, h, color, group: kind === 'group', note: kind === 'note', panel: kind === 'panel' });
            centers.set(key, [x + w / 2, y + h / 2]);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x + w > maxX) maxX = x + w;
            if (y + h > maxY) maxY = y + h;
        };
        for (const n of this.directNodes(gid)) {
            if (n.isCommentNode) add('n' + n.id, n.x, n.y, n.width, n.height, n.noteColor || COLORS.accent2, 'note');
            else add('n' + n.id, n.x, n.y, n.width, n.height, nodeAccent(n), 'node');
        }
        for (const ch of this.childrenOf(gid)) {
            const cp = this._proxies.get(ch.id);
            add('g' + ch.id, ch.x, ch.y, cp ? cp.width : GROUP_LAYOUT.minWidth, cp ? cp.height : 130,
                cp && cp.accent ? cp.accent : this.groupAccent(ch.id), 'group');
        }
        if (!items.length) return { items, links: [], minX: 0, minY: 0, maxX: 1, maxY: 1 };
        // The "from outside" / "to outside" panels, where they sit inside the group
        for (const r of this._panelGeometry(gid)) add('p' + r.side, r.x, r.y, r.w, r.h, null, 'panel');
        const innerRep = (node) => {
            const chain = this.chainOf(this.groupOf(node.id));
            const k = chain.indexOf(gid);
            if (k < 0) return null;
            return k === 0 ? 'n' + node.id : 'g' + chain[k - 1];
        };
        const links = [];
        const seen = new Set();
        for (const c of this.graph.connections) {
            if (!c.fromNode || !c.toNode) continue;
            const a = innerRep(c.fromNode);
            const b = innerRep(c.toNode);
            if (!a || !b || a === b) continue;
            const k = a + '>' + b;
            if (seen.has(k)) continue;
            seen.add(k);
            const pa = centers.get(a), pb = centers.get(b);
            if (pa && pb) links.push([pa[0], pa[1], pb[0], pb[1]]);
            if (links.length > 400) break;
        }
        return { items, links, minX, minY, maxX, maxY };
    }

    /** Boundary panel rects inside a group (built once per graph version, for minimaps). */
    _panelGeometry(gid) {
        if (!this._panelGeo || this._panelGeo.version !== this.version) {
            this._panelGeo = { version: this.version, map: new Map() };
        }
        const cache = this._panelGeo.map;
        if (cache.has(gid)) return cache.get(gid);
        cache.set(gid, []); // guards re-entry while building
        const v = this.buildView(gid);
        let rects = [];
        if (v.inPanel) {
            this._placePanels(v);
            rects = [v.inPanel, v.outPanel].map(p => ({ side: p.side, x: p.x, y: p.y, w: p.width, h: p.height }));
        }
        cache.set(gid, rects);
        return rects;
    }

    _finishPanel(panel, repY, ctx, scope = this.scope) {
        const grp = scope == null ? null : this.getGroup(scope);
        for (const r of panel.rows) {
            if (panel.side === 'in') {
                if (r.source) {
                    let y = null;
                    for (const c of r.conns) {
                        const v = repY(c.toNode);
                        if (v !== null && (y === null || v < y)) y = v;
                    }
                    // A kept / virtual row stays where it was (a new virtual one goes last)
                    r.sortY = y === null ? (r.entry && Number.isFinite(r.entry.sortY) ? r.entry.sortY : (r.virtual ? 1e5 : 0)) : y;
                    const fed = r.conns.length ? r.conns : this._keptTargets(r).map(t => ({ toNode: t.node, toInput: t.index }));
                    const dest = GENERIC_PORT_NAMES.has(outName(r.source.node, r.source.index)) ? commonDestName(fed) : null;
                    r.label = dest ? `${nodeTitle(r.source.node)} → ${dest}` : qualifiedOut(r.source.node, r.source.index);
                    r.type = srcType(r.source.node, r.source.index);
                } else if (r.target) {
                    const v = repY(r.target.node);
                    r.sortY = v === null ? 0 : v;
                    r.label = qualifiedIn(r.target.node, r.target.index);
                    const t = r.target.node.inputs[r.target.index];
                    r.type = t ? t.type : null;
                }
            } else {
                const v = repY(r.source.node);
                r.sortY = v === null ? 0 : v;
                r.type = srcType(r.source.node, r.source.index);
                const dests = [];
                for (const c of (r.conns.length ? r.conns : this._keptDestConns(r))) if (!dests.some(d => d.node === c.toNode && d.index === c.toInput)) dests.push({ node: c.toNode, index: c.toInput });
                r.dests = dests;
                if (dests.length) r.label = qualifiedIn(dests[0].node, dests[0].index) + (dests.length > 1 ? ` +${dests.length - 1}` : '');
                else r.label = qualifiedOut(r.source.node, r.source.index);
            }
            // The user's name for the box port this row stands for (portLabels)
            r.autoLabel = r.label;
            if (panel.side === 'in' && r.source) r.targets = r.conns.length ? targetsOf(r.conns) : this._keptTargets(r);
            const custom = this._customPortLabel(grp, r);
            r.custom = !!custom;
            if (custom) r.label = custom;
        }
        panel.rows.sort((a, b) => a.sortY - b.sortY || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const sock = newPort(panel.side === 'in' ? 'out' : 'in', '+expose');
        sock.expose = true;
        sock.type = 'any';
        sock.label = panel.side === 'in' ? 'expose an input' : 'expose an output';
        panel.rows.push(sock);
        panel.rows.forEach((r, i) => { r.index = i; });
        panel.finishLayout(ctx);
    }

    /** Where a real node's port shows up in the current scope: { view, index, pos } or null. */
    viewPortFor(node, kind, index) {
        const v = this.view();
        if (v.inPanel) this._placePanels(v);
        const r = v.rep(node);
        if (r === node) {
            return { view: node, index, pos: kind === 'out' ? node.getOutputPortPosition(index) : node.getInputPortPosition(index) };
        }
        const key = node.id + ':' + index;
        if (r === OUTSIDE) {
            if (!v.inPanel) return null;
            if (kind === 'out') {
                const i = v.inPanel.indexOfKey('s:' + key);
                return i >= 0 ? { view: v.inPanel, index: i, pos: v.inPanel.getOutputPortPosition(i) } : null;
            }
            const i = v.outPanel.rows.findIndex(row => row.conns.some(c => c.toNode === node && c.toInput === index));
            return i >= 0 ? { view: v.outPanel, index: i, pos: v.outPanel.getInputPortPosition(i) } : null;
        }
        if (kind === 'out') {
            const i = r.indexOfKey('out', 'o:' + key);
            return i >= 0 ? { view: r, index: i, pos: r.getOutputPortPosition(i) } : null;
        }
        const i = r.inPorts.findIndex(p => p.conns.some(c => c.toNode === node && c.toInput === index) ||
            (p.target && p.target.node === node && p.target.index === index));
        return i >= 0 ? { view: r, index: i, pos: r.getInputPortPosition(i) } : null;
    }

    // ------------------------------------------------------------------
    // Drawing hooks (called by GraphRenderer)
    // ------------------------------------------------------------------

    /**
     * Cables with no real connection behind them: dashed for exposed / kept ports that carry
     * nothing yet, solid for virtual inputs (patched from outside, feeding nothing inside).
     */
    drawGhostLinks(ctx, zoom) {
        const v = this._view;
        if (!v || !v.ghosts.length || (this.scope === null && !this.hasGroups())) return;
        const w = Math.max(1.25, 1.25 / zoom);
        ctx.save();
        ctx.lineCap = 'round';
        for (const gl of v.ghosts) {
            const a = gl.src.getOutputPortPosition(gl.si);
            const b = gl.dst.getInputPortPosition(gl.di);
            if (!a || !b) continue;
            traceCable(ctx, a.x, a.y, b.x, b.y);
            if (gl.solid) {
                const cw = Math.max(LAYOUT.cableWidth, 1.25 / zoom);
                ctx.setLineDash([]);
                ctx.strokeStyle = CANVAS.cableShadow;
                ctx.lineWidth = cw + 2.5;
                ctx.stroke();
                ctx.strokeStyle = withAlpha(portColor(gl.type), 0.85);
                ctx.lineWidth = cw;
            } else {
                ctx.setLineDash([3, 4]);
                ctx.strokeStyle = withAlpha(portColor(gl.type), 0.5);
                ctx.lineWidth = w;
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    // ------------------------------------------------------------------
    // Navigation
    // ------------------------------------------------------------------

    _scopeKey(s) { return s === null ? ROOT_KEY : s; }

    _saveView() {
        const g = this.graph;
        this.scopeViews.set(this._scopeKey(this.scope), { panX: g.panX, panY: g.panY, zoom: g.zoom });
    }

    /** Root pan/zoom (what gets saved in the project, whatever scope is open). */
    rootView() {
        const g = this.graph;
        if (this.scope === null) return { panX: g.panX, panY: g.panY, zoom: g.zoom };
        return this.scopeViews.get(ROOT_KEY) || { panX: g.panX, panY: g.panY, zoom: g.zoom };
    }

    setScope(gid, { select = true, animate = true } = {}) {
        if (gid !== null && !this.getGroup(gid)) return false;
        if (gid === this.scope) return false;
        const g = this.graph;
        g.connectingFrom = null;
        g.draggedNode = null;
        g.selectionBox = null;
        g.selectionStart = null;
        g.resizingNode = null;
        if (g.focusedTextInput) {
            try { g.focusedTextInput.blur(); } catch (e) { /* ignore */ }
            g.focusedTextInput = null;
            g.focusedNode = null;
        }
        this.ui.cancelRename();
        // Commit pending edits while the group they were made in is still open (an input
        // unplugged inside just before leaving stays patched from outside: reconcileInputs)
        const hist = g.history;
        if (hist && typeof hist.flush === 'function') hist.flush();
        this._saveView();
        this._transition = null;
        const from = this.scope;
        const fromView = { panX: g.panX, panY: g.panY, zoom: g.zoom };
        this.scope = gid;
        // Close the groups left (pruning their unused ports), open the new chain's sessions
        this._syncSessions(gid);
        if (gid !== null) {
            this.touch();
            this.view(); // records the rows the group shows as it opens
        }
        g.selectionManager.selectedNodes.clear();
        if (g.graphRenderer && g.graphRenderer.clearHover) g.graphRenderer.clearHover();
        const saved = this.scopeViews.get(this._scopeKey(gid));
        if (saved) {
            g.panX = saved.panX;
            g.panY = saved.panY;
            g.zoom = saved.zoom;
        } else {
            this.fitScope();
        }
        // Going up: select the box we came out of
        if (select && from !== null) {
            const chain = this.chainOf(from);
            const k = gid === null ? chain.length : chain.indexOf(gid);
            const child = k > 0 ? chain[k - 1] : null;
            const p = child ? this.proxyFor(child) : null;
            if (p) g.selectionManager.selectedNodes.add(p);
        }
        this.ui.update();
        if (animate) this._startTransition(from, gid, fromView);
        try {
            window.dispatchEvent(new CustomEvent('patchtoy:scope', { detail: { scope: gid, path: this.path(gid) } }));
        } catch (e) { /* ignore */ }
        g.render();
        return true;
    }

    // ------------------------------------------------------------------
    // Enter / exit transition: the camera zooms into the group box's minimap while the
    // group's contents fade in, laid exactly over the minimap (and the reverse going up).
    //
    // The minimap draws inner (x, y) at outer o + sc * (x, y). With the outer camera
    // (Z, P), the inner layer is drawn with zoom Z * sc and pan Z * o + P, so it always
    // sits on the minimap. The outer camera runs from its own view (e = 0) to the one that
    // puts the inner layer at the inner scope's view (e = 1), zooming about the fixed
    // point of that similarity so it reads as a straight zoom-in.
    // ------------------------------------------------------------------

    _startTransition(from, to, fromView) {
        if (this._reducedMotion()) return;
        let inner, outer, entering;
        if (to !== null && this.parentOf(to) === from) {
            inner = to; outer = from; entering = true;
        } else if (from !== null && this.parentOf(from) === to) {
            inner = from; outer = to; entering = false;
        } else {
            return; // jumps across several levels just cut
        }
        const g = this.graph;
        const toView = { panX: g.panX, panY: g.panY, zoom: g.zoom };
        const tr = this._buildTransition(outer, inner, entering ? fromView : toView, entering ? toView : fromView);
        if (!tr) return;
        tr.entering = entering;
        tr.start = performance.now();
        tr.duration = 640;
        this._transition = tr;
    }

    _reducedMotion() {
        return typeof window !== 'undefined' && window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /** Camera path from outerView (e = 0) to innerView (e = 1) through `inner`'s box minimap. */
    _buildTransition(outer, inner, outerView, innerView) {
        // The inner group's box (and minimap) as laid out in the outer scope
        const proxy = this.withScope(outer, () => this.view().proxyOf.get(inner));
        const mm = proxy && proxy.minimap;
        if (!mm || !mm.items || !mm.items.length) return null;
        const { x: rx, y: ry, w: rw, h: rh } = proxy.minimapRect();
        const { sc, ox, oy } = groupMinimapTransform(rx, ry, rw, rh, mm);
        if (!(sc > 0)) return null;

        const Z0 = outerView.zoom;
        const Z1 = innerView.zoom / sc;
        const P0x = outerView.panX, P0y = outerView.panY;
        const P1x = innerView.panX - Z1 * ox;
        const P1y = innerView.panY - Z1 * oy;
        const r = Z1 / Z0;
        const fixed = Math.abs(1 - r) > 1e-3
            ? { x: (P1x - r * P0x) / (1 - r), y: (P1y - r * P0y) / (1 - r) }
            : null;
        return {
            outer, inner, outerView, innerView,
            Z0, r, P0x, P0y, P1x, P1y, fixed, sc, ox, oy,
            mm: { x: rx, y: ry, w: rw, h: rh, data: mm, accent: proxy.accent }
        };
    }

    // ------------------------------------------------------------------
    // Zooming through a group: with the cursor on a group box, zooming in past the point
    // where its preview fills a good part of the canvas scrubs the enter transition by
    // hand (and zooming out of a group whose contents already look small scrubs the exit).
    // Reaching either end commits; letting go part-way settles to the nearer end.
    // ------------------------------------------------------------------

    isScrubbing() {
        return !!(this._transition && this._transition.manual);
    }

    /** A zoom step by `factor` around canvas point (sx, sy). Returns true if it drove a transition. */
    zoomGesture(factor, sx, sy) {
        const g = this.graph;
        const tr = this._transition;
        if (tr && tr.manual) {
            if (tr.settle) tr.settle = null; // grabbed again mid-settle
            // Stretched: the hand-driven dive takes several times more zooming than the
            // camera actually travels, so there's time to watch the contents take over
            const span = Math.max(Math.log(tr.r) * SCRUB_STRETCH, SCRUB_MIN_SPAN);
            tr.e = Math.min(1, Math.max(0, tr.e + Math.log(factor) / span));
            tr.lastInput = performance.now();
            if (tr.e >= 1 || tr.e <= 0) this._commitScrub(tr.e >= 1 ? 1 : 0);
            return true;
        }
        if (tr || this._reducedMotion() || !(factor > 0) || factor === 1) return false;

        const rect = g.canvas.getBoundingClientRect();
        const vw = rect.width || 800;
        const vh = rect.height || 600;
        const cam = { panX: g.panX, panY: g.panY, zoom: g.zoom };
        let next = null;

        if (factor > 1) {
            // Zooming in on a group box whose preview is already big on screen
            const wx = (sx - g.panX) / g.zoom;
            const wy = (sy - g.panY) / g.zoom;
            const box = this.view().proxies.find(p => p.containsPoint(wx, wy));
            if (!box) return false;
            const innerView = this.scopeViews.get(this._scopeKey(box.group.id)) || this._fitView(box.group.id);
            next = this._buildTransition(this.scope, box.group.id, cam, innerView);
            // Engage once the preview is within SCRUB_ENGAGE_RATIO of being blown up to the
            // group's real scale - independent of how big the preview is drawn
            if (!next || (next.r > SCRUB_ENGAGE_RATIO && g.zoom * factor <= g.maxZoom)) return false;
            next.e = 0;
        } else if (this.scope !== null) {
            // Zooming out of a group whose contents already look small
            const bb = bboxOf(this.viewNodes());
            const small = !bb || ((bb.x1 - bb.x0) * g.zoom < vw * 0.4 && (bb.y1 - bb.y0) * g.zoom < vh * 0.4);
            // Just dived in and haven't moved yet: zooming out backs straight out again
            const justEntered = this._sameView(this._scrubLanding, this.scope);
            if (!small && !justEntered && g.zoom * factor >= g.minZoom) return false;
            const parent = this.parentOf(this.scope);
            const outerView = this.scopeViews.get(this._scopeKey(parent)) || this._fitView(parent);
            next = this._buildTransition(parent, this.scope, outerView, cam);
            if (next) next.e = 1;
        }
        if (!next || !(Math.abs(Math.log(next.r)) > 1e-3)) return false;
        next.manual = true;
        next.lastInput = performance.now();
        this._transition = next;
        return this.zoomGesture(factor, sx, sy);
    }

    /** Finish a hand-driven transition now, at whichever end is nearer (e.g. on a click). */
    settleScrub() {
        const tr = this._transition;
        if (tr && tr.manual) this._commitScrub(tr.e >= 0.5 ? 1 : 0);
    }

    _commitScrub(end) {
        const tr = this._transition;
        this._transition = null;
        const g = this.graph;
        const target = end >= 1 ? tr.inner : tr.outer;
        const view = end >= 1 ? tr.innerView : tr.outerView;
        if (this.scope !== target) {
            this.scopeViews.set(this._scopeKey(target), { ...view });
            this.setScope(target, { animate: false });
        }
        g.panX = view.panX;
        g.panY = view.panY;
        g.zoom = view.zoom;
        this._scrubLanding = { scope: target, ...view };
        g.render();
    }

    /** Is the camera still exactly where `landing` left it, in that scope? */
    _sameView(landing, scope) {
        const g = this.graph;
        return !!landing && landing.scope === scope &&
            Math.abs(g.zoom - landing.zoom) < 1e-6 && Math.abs(g.panX - landing.panX) < 0.5 && Math.abs(g.panY - landing.panY) < 0.5;
    }

    /** The camera fitScope() would pick for a scope, without applying it. */
    _fitView(scope, { margin = 56, top = null } = {}) {
        const g = this.graph;
        const rect = g.canvas.getBoundingClientRect();
        const vw = rect.width || g.canvas.width || 800;
        const vh = rect.height || g.canvas.height || 600;
        const topPad = top !== null ? top : (scope !== null ? 64 : 48);
        const bb = bboxOf(this.withScope(scope, () => this.viewNodes()));
        if (!bb) return { zoom: 1, panX: Math.round(vw / 2 - 150), panY: Math.round(vh / 2 - 100) };
        const bw = Math.max(1, bb.x1 - bb.x0);
        const bh = Math.max(1, bb.y1 - bb.y0);
        let zoom = Math.min(1, (vw - 2 * margin) / bw, (vh - topPad - margin) / bh);
        zoom = Math.max(g.minZoom || 0.1, zoom);
        return {
            zoom,
            panX: (vw - bw * zoom) / 2 - bb.x0 * zoom,
            panY: topPad + (vh - topPad - margin - bh * zoom) / 2 - bb.y0 * zoom
        };
    }

    isTransitioning() {
        return !!this._transition;
    }

    cancelTransition() {
        if (!this._transition) return;
        if (this._transition.manual) {
            this.settleScrub();
            return;
        }
        this._transition = null;
        this.graph.render();
    }

    /**
     * Layers to draw this frame ({ scope, panX, panY, zoom, alpha }, back to front),
     * or null when no transition is running.
     */
    transitionFrame() {
        const tr = this._transition;
        if (!tr) return null;
        let e; // 0 = outer view, 1 = inner view
        if (tr.manual) {
            const now = performance.now();
            // Gesture paused part-way: glide to the nearer end
            // (starts right away but softly, so a hesitating gesture can always take back over)
            if (!tr.settle && now - tr.lastInput > 140) {
                const to = tr.e >= 0.5 ? 1 : 0;
                tr.settle = { from: tr.e, to, start: now, duration: 350 + 900 * Math.abs(to - tr.e) };
            }
            if (tr.settle) {
                const u = Math.min(1, (now - tr.settle.start) / tr.settle.duration);
                const k = 0.5 - 0.5 * Math.cos(Math.PI * u); // eases in: no sudden pull
                tr.e = tr.settle.from + (tr.settle.to - tr.settle.from) * k;
                if (u >= 1) {
                    this._commitScrub(tr.settle.to);
                    return null;
                }
            }
            e = tr.e;
        } else {
            const t = Math.min(1, (performance.now() - tr.start) / tr.duration);
            if (t >= 1) {
                this._transition = null;
                return null;
            }
            const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            e = tr.entering ? ease : 1 - ease;
        }

        const Z = tr.Z0 * Math.pow(tr.r, e);
        const k = Z / tr.Z0;
        let Px, Py;
        if (tr.fixed) {
            Px = tr.fixed.x - k * (tr.fixed.x - tr.P0x);
            Py = tr.fixed.y - k * (tr.fixed.y - tr.P0y);
        } else {
            Px = tr.P0x + (tr.P1x - tr.P0x) * e;
            Py = tr.P0y + (tr.P1y - tr.P0y) * e;
        }
        // Glued cross-fade: the contents start showing almost at once, drawn over the
        // minimap they grow out of; the minimap keeps its colour well into the zoom while
        // the rest of the parent scope fades early.
        const ss = (x) => { const u = Math.min(1, Math.max(0, x)); return u * u * (3 - 2 * u); };
        return [
            {
                scope: tr.outer, panX: Px, panY: Py, zoom: Z,
                alpha: 1 - ss(e / 0.4), // the box and the rest of the parent go before the minimap
                // The minimap's blocks (not its backdrop) outlast the box
                minimap: { rect: tr.mm, alpha: 1 - ss((e - 0.35) / 0.6) }
            },
            {
                scope: tr.inner, panX: Z * tr.ox + Px, panY: Z * tr.oy + Py, zoom: Z * tr.sc,
                alpha: ss((e - 0.02) / 0.5),
                transparent: true // no backdrop fill: the minimap shows through between nodes
            }
        ];
    }

    enter(gid) { return this.setScope(gid); }

    exitUp() {
        if (this.scope === null) return false;
        return this.setScope(this.parentOf(this.scope));
    }

    /** Fit the current scope (boxes, nodes and boundary panels) into the canvas. */
    fitScope({ margin = 56, top = null } = {}) {
        const g = this.graph;
        const v = this._fitView(this.scope, { margin, top });
        g.zoom = v.zoom;
        g.panX = v.panX;
        g.panY = v.panY;
        g.render();
    }

    /** Forget scope + view memory (new project / load). */
    reset() {
        this.scope = null;
        this._sessions.clear(); // a project switch / New project closes every group (nothing to prune: sessions aren't saved)
        this._deletedGroupOf = null;
        this.scopeViews.clear();
        this._proxies.clear();
        this._panels.clear();
        this._transition = null;
        this.invalidate();
        this.touch();
        this.ui.cancelRename();
        this.ui.update();
    }

    // ------------------------------------------------------------------
    // Editing
    // ------------------------------------------------------------------

    newGroupId() {
        let max = 0;
        for (const grp of this.groups) {
            const m = /^g(\d+)$/.exec(String(grp.id));
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return 'g' + (max + 1);
    }

    uniqueName(base = 'Group') {
        const names = new Set(this.groups.map(g => g.name));
        if (!names.has(base)) return base;
        let i = 2;
        while (names.has(`${base} ${i}`)) i++;
        return `${base} ${i}`;
    }

    _removeFromGroups(nodeId) {
        for (const grp of this.groups) {
            const i = grp.nodeIds.indexOf(nodeId);
            if (i >= 0) grp.nodeIds.splice(i, 1);
        }
    }

    /**
     * Create a group. nodes: real nodes to move into it (they leave their current group);
     * groups: existing group objects that become its children.
     */
    createGroup({ name, parentId = null, nodes = [], groups = [], x = 0, y = 0, color } = {}) {
        this._index();
        if (parentId != null && !this.getGroup(parentId)) throw new Error(`No group "${parentId}"`);
        for (const ch of groups) {
            if (parentId != null && this.chainOf(parentId).includes(ch.id)) {
                throw new Error(`Group "${ch.name}" can't be put inside its own descendant`);
            }
        }
        const grp = {
            id: this.newGroupId(),
            name: (name && String(name).trim()) || this.uniqueName('Group'),
            parentId: parentId == null ? null : parentId,
            nodeIds: [],
            x: Math.round(x),
            y: Math.round(y),
        };
        if (color) grp.color = color;
        for (const n of nodes) {
            this._removeFromGroups(n.id);
            if (!grp.nodeIds.includes(n.id)) grp.nodeIds.push(n.id);
        }
        for (const ch of groups) ch.parentId = grp.id;
        this.groups.push(grp);
        this.touch();
        return grp;
    }

    /** Dissolve a group: its members and child groups move to its parent, placed where the box was. */
    ungroup(gid, { place = true } = {}) {
        const grp = this.getGroup(gid);
        if (!grp) return null;
        const parent = this.parentOf(gid);
        const members = this.directNodes(gid);
        const kids = this.childrenOf(gid).slice();
        if (place && (members.length || kids.length)) {
            const proxy = this._proxies.get(gid);
            const bw = proxy ? proxy.width : GROUP_LAYOUT.minWidth;
            const bh = proxy ? proxy.height : 130;
            const boxes = [
                ...members.map(n => ({ x: n.x, y: n.y, width: n.width, height: n.height })),
                ...kids.map(k => {
                    const kp = this._proxies.get(k.id);
                    return { x: k.x, y: k.y, width: kp ? kp.width : GROUP_LAYOUT.minWidth, height: kp ? kp.height : 130 };
                }),
            ];
            const bb = bboxOf(boxes);
            const dx = Math.round(grp.x + bw / 2 - (bb.x0 + bb.x1) / 2);
            const dy = Math.round(grp.y + bh / 2 - (bb.y0 + bb.y1) / 2);
            for (const n of members) { n.x += dx; n.y += dy; }
            for (const k of kids) { k.x += dx; k.y += dy; }
        }
        const pg = parent != null ? this.getGroup(parent) : null;
        if (pg) for (const n of members) if (!pg.nodeIds.includes(n.id)) pg.nodeIds.push(n.id);
        // Its virtual inputs become the parent's (still patched from outside it, if they were)
        if (pg && grp.virtualInputs) {
            const list = pg.virtualInputs || (pg.virtualInputs = []);
            for (const v of grp.virtualInputs) if (!list.some(w => w.node === v.node && w.port === v.port)) list.push({ node: v.node, port: v.port });
        }
        for (const k of kids) k.parentId = parent;
        const i = this.groups.indexOf(grp);
        if (i >= 0) this.groups.splice(i, 1);
        this._proxies.delete(gid);
        this.scopeViews.delete(gid);
        if (this.scope === gid) this.scope = parent;
        this.touch();
        this.ui.update();
        return { nodes: members, groups: kids, parent };
    }

    renameGroup(gid, name) {
        const grp = this.getGroup(gid);
        const n = String(name == null ? '' : name).trim();
        if (!grp || !n || grp.name === n) return false;
        grp.name = n.slice(0, 80);
        this.touch();
        this.ui.update();
        return true;
    }

    /**
     * The user's label for a box port / panel row of group `grp`, or null. An input fed from
     * outside ('s:') that feeds a single inner input also takes that input's exposed name ('x:').
     */
    _customPortLabel(grp, port) {
        const k = this._portLabelKey(grp, port);
        return k ? grp.portLabels[k] : null;
    }

    /**
     * The portLabels key a port's custom name comes from, or null: its own key; for an 's:'
     * port feeding a single inner input, that input's 'x:' key; else the key a boundary port
     * session remembered for the row (its name before it was unplugged and re-plugged elsewhere).
     */
    _portLabelKey(grp, port, { pin = true } = {}) {
        const m = grp && grp.portLabels;
        if (!m || !port || !port.key) return null;
        if (m[port.key]) return port.key;
        if (port.key.startsWith('s:')) {
            const t = port.targets || (port.conns ? targetsOf(port.conns) : []);
            if (t.length === 1 && t[0].node) {
                const x = `x:${t[0].node.id}:${t[0].index}`;
                if (m[x]) return x;
            }
        }
        const k = pin && port.entry && port.entry.labelKey;
        return k && m[k] ? k : null;
    }

    /** The key a label for this port is stored under (an 's:' port named via its exposed input keeps that key). */
    _labelKeyFor(grp, port) {
        return this._portLabelKey(grp, port) || port.key;
    }

    // ------------------------------------------------------------------
    // Virtual inputs (grp.virtualInputs)
    //
    // An input patched from outside that feeds nothing inside: the outside cable stays, leading
    // nowhere, until it is connected inside. The flat graph has no connection for it, so it is
    // group metadata: saved, copied and undone with the group record. A port disappears only
    // when it has no cable on either side.
    // ------------------------------------------------------------------

    /** The virtual inputs of grp (and of its inner groups) fed by `srcId`.`out`. */
    _virtualOwners(gid, srcId, out) {
        const a = this._nodeById(srcId);
        const out2 = [];
        for (const grp of [this.getGroup(gid), ...this.subtreeGroups(gid)]) {
            if (!grp || !grp.virtualInputs || (a && this.isInSubtree(a, grp.id))) continue;
            if (grp.virtualInputs.some(v => v.node === srcId && v.port === out)) out2.push(grp);
        }
        return out2;
    }

    /**
     * Patch output `out` of `src` (outside the group) to a new input of group gid that feeds
     * nothing inside yet. Returns 'added', 'exists' (already an input of the group) or false.
     */
    addVirtualInput(gid, src, out, { label = true } = {}) {
        const grp = this.getGroup(gid);
        if (!grp || !src || src.isViewOnly || !src.outputs || out < 0 || out >= src.outputs.length) return false;
        if (this.isInSubtree(src, gid)) return false;
        if (this._hasInFeed(gid, src.id, out)) return 'exists';
        const key = `s:${src.id}:${out}`;
        if (label && !(grp.portLabels && grp.portLabels[key])) {
            // Named after its source (kept when it gets connected inside later)
            let text = shortOut(src, out);
            if (this.groupPorts(gid).some(p => p.kind === 'in' && p.label === text)) text = qualifiedOut(src, out);
            grp.portLabels = { ...(grp.portLabels || {}), [key]: text.slice(0, PORT_LABEL_MAX) };
        }
        (grp.virtualInputs || (grp.virtualInputs = [])).push({ node: src.id, port: out });
        this.touch();
        this.invalidate();
        return 'added';
    }

    /** Unpatch `srcId`.`out` from group gid's virtual inputs (and its inner groups'). Returns what was removed. */
    removeVirtualInputs(gid, srcId, out) {
        const removed = [];
        for (const grp of this._virtualOwners(gid, srcId, out)) {
            grp.virtualInputs = grp.virtualInputs.filter(v => !(v.node === srcId && v.port === out));
            if (!grp.virtualInputs.length) delete grp.virtualInputs;
            removed.push({ gid: grp.id, node: srcId, port: out });
        }
        if (removed.length) {
            this.touch();
            this.invalidate();
        }
        return removed;
    }

    /** A port that turns virtual keeps the name it showed (a session remembered its label key). */
    _keepVirtualName(grp, srcId, out) {
        const key = `s:${srcId}:${out}`;
        const m = grp.portLabels;
        if (!m || m[key]) return;
        const ses = this._sessions.get(grp.id);
        const e = ses && ses.ins.get(key);
        const from = e && e.labelKey;
        if (!from || !m[from]) return;
        const map = { ...m, [key]: m[from] };
        // An 'x:' name moves with it, unless that input is exposed (it names that row too)
        const xm = /^x:(\d+):(\d+)$/.exec(from);
        const exposed = xm && ((grp.exposed && grp.exposed.inputs) || []).some(x => x.node === +xm[1] && x.port === +xm[2]);
        if (xm && !exposed) delete map[from];
        grp.portLabels = map;
    }

    /**
     * Called by History before it records a step. removed: connections gone since the last step
     * ([srcId, output, dstId, input]). An inner cable unplugged inside an open group whose input
     * has nothing else feeding it leaves the input patched from outside (virtual), in the same
     * step. Then virtual inputs whose source is gone, or that are fed for real again (connected
     * inside), are dropped. convert false: only the clean-up. True when group metadata changed.
     */
    reconcileInputs(removed = [], { convert = true } = {}) {
        const gone = this._deletedGroupOf || null;
        this._deletedGroupOf = null;
        if (!this.hasGroups()) return false;
        let dirty = false;
        if (convert && this.scope !== null && removed.length && !automationBusy()) {
            const chain = this.chainOf(this.scope);
            for (const [srcId, out, dstId] of removed) {
                const a = this._nodeById(srcId);
                if (!a || out >= a.outputs.length) continue;
                const t = this._nodeById(dstId);
                const tg = t ? this.groupOf(t.id) : (gone && gone.has(dstId) ? gone.get(dstId) : undefined);
                if (tg === undefined || tg === null) continue;
                const tChain = this.chainOf(tg);
                // The innermost open group that held the consumer but not the source
                const gid = chain.find(id => tChain.includes(id) && !this.isInSubtree(a, id));
                if (gid === undefined || this._hasInFeed(gid, srcId, out)) continue;
                const grp = this.getGroup(gid);
                (grp.virtualInputs || (grp.virtualInputs = [])).push({ node: srcId, port: out });
                this._keepVirtualName(grp, srcId, out);
                dirty = true;
            }
        }
        for (const grp of this.groups) {
            const list = grp && grp.virtualInputs;
            if (!list) continue;
            const seen = new Set();
            const keep = list.filter(v => {
                const a = v && this._nodeById(v.node);
                const k = a ? a.id + ':' + v.port : '';
                if (!a || !Number.isInteger(v.port) || v.port < 0 || v.port >= a.outputs.length || seen.has(k) || this.isInSubtree(a, grp.id)) return false;
                seen.add(k);
                // Fed for real (a cable inside) or through an inner group's virtual input: a normal port
                if (this._crossing(grp.id, 'in', v.node, v.port)) return false;
                return !this.subtreeGroups(grp.id).some(ch => !this.isInSubtree(a, ch.id) &&
                    (ch.virtualInputs || []).some(w => w.node === v.node && w.port === v.port));
            });
            if (keep.length === list.length) continue;
            if (keep.length) grp.virtualInputs = keep; else delete grp.virtualInputs;
            dirty = true;
        }
        if (dirty) {
            this.touch();
            this.invalidate();
        }
        return dirty;
    }

    /** GraphRenderer: mark the outputs feeding a visible virtual cable as connected. */
    stampVirtualSources(stamp) {
        const v = this._view;
        if (!v || !v.ghosts.length) return;
        for (const gl of v.ghosts) {
            if (!gl.solid || gl.src.isViewOnly) continue;
            (gl.src._outLinks || (gl.src._outLinks = []))[gl.si] = stamp;
        }
    }

    // ------------------------------------------------------------------
    // Boundary port sessions
    //
    // Rows of the "From outside" / "To outside" panels (and the matching box ports) are
    // synthesized from the cables crossing the group boundary, so unplugging the last inner
    // cable of a row would make it vanish. While a group is open (it, or one of its child
    // groups, is the current scope) a session remembers every crossing row it has shown:
    // its outside source (inputs) or its outside destinations (outputs), the inner inputs it
    // fed, its place and the label key it used. An input whose last inner cable is unplugged
    // stays patched from outside (a virtual input, see above); a row with no cable on either
    // side is still shown ("kept", dimmed like an exposed unpatched port) and can be re-plugged.
    // Closing the group prunes kept rows that are still unused (one "Remove unused group ports"
    // undo step, which also drops their custom names). Sessions are not saved: projects only
    // ever hold real cables, exposed ports, virtual inputs and names.
    // ------------------------------------------------------------------

    _newSession() { return { ins: new Map(), outs: new Map() }; }

    /** Inner inputs a kept 's:' port fed ({node, index}); none for a live port. */
    _keptTargets(port) {
        const e = port && port.kept ? port.entry : null;
        if (!e || !e.targets) return [];
        const grp = this.getGroup(e.gid);
        const ex = (grp && grp.exposed && grp.exposed.inputs) || [];
        const out = [];
        for (const [id, index] of e.targets) {
            const n = this._nodeById(id);
            if (!n || index >= n.inputs.length) continue;
            // An exposed input that is unpatched again has its own row (and name)
            if (ex.some(x => x.node === id && x.port === index) &&
                !this.graph.connections.some(c => c.toNode === n && c.toInput === index)) continue;
            out.push({ node: n, index });
        }
        return out;
    }

    /** Outside inputs a kept 'o:' port fed, shaped like connections ({toNode, toInput}). */
    _keptDestConns(port) {
        const e = port && port.kept ? port.entry : null;
        if (!e || !e.dests) return [];
        const out = [];
        for (const d of e.dests) {
            const n = this._nodeById(d.node);
            if (n && d.input < n.inputs.length) out.push({ toNode: n, toInput: d.input });
        }
        return out;
    }

    /** Is any cable from node id `src` output `out` crossing group gid's boundary (in: into it, out: out of it)? */
    _crossing(gid, side, src, out) {
        for (const c of this.graph.connections) {
            if (!c.fromNode || !c.toNode || c.fromNode.id !== src || c.fromOutput !== out) continue;
            const a = this.isInSubtree(c.fromNode, gid), b = this.isInSubtree(c.toNode, gid);
            if (side === 'in' ? (!a && b) : (a && !b)) return true;
        }
        return false;
    }

    /**
     * Does output `out` of node id `src` (outside gid) feed group gid: a real cable crossing into
     * it, or a virtual input of gid or of a group inside it?
     */
    _hasInFeed(gid, src, out) {
        if (this._crossing(gid, 'in', src, out)) return true;
        const a = this._nodeById(src);
        if (!a || this.isInSubtree(a, gid)) return false;
        for (const grp of [this.getGroup(gid), ...this.subtreeGroups(gid)]) {
            if (grp && (grp.virtualInputs || []).some(v => v.node === src && v.port === out) && !this.isInSubtree(a, grp.id)) return true;
        }
        return false;
    }

    /** Outside destinations of a kept output entry: [{node, input, ...}] whose node still exists outside gid. */
    _entryDests(e, gid) {
        return (e.dests || []).filter(d => {
            const n = this._nodeById(d.node);
            return n && d.input < n.inputs.length && !this.isInSubtree(n, gid);
        });
    }

    /**
     * Session entries shown as kept rows (no cable left): { ins: [[key, e]], outs: [[key, e]] }.
     * An output whose destinations are all fed again (re-plugged from another inner source) is
     * not shown; of several unused outputs sharing a destination only the oldest is.
     */
    _keptEntries(ses, gid) {
        const ins = [], outs = [];
        for (const [key, e] of ses.ins) {
            const a = this._nodeById(e.src);
            if (!a || e.out >= a.outputs.length || this.isInSubtree(a, gid)) continue;
            if (!this._hasInFeed(gid, e.src, e.out)) ins.push([key, e]);
        }
        const g = this.graph;
        const firstFor = new Map();
        const cands = [];
        for (const [key, e] of ses.outs) {
            const n = this._nodeById(e.src);
            if (!n || e.out >= n.outputs.length || !this.isInSubtree(n, gid)) continue;
            if (this._crossing(gid, 'out', e.src, e.out)) continue;
            const dests = this._entryDests(e, gid);
            if (!dests.length) continue;
            const fed = dests.every(d => g.connections.some(c => c.toNode && c.toNode.id === d.node && c.toInput === d.input));
            if (fed) continue;
            cands.push([key, e, dests]);
            for (const d of dests) {
                const dk = d.node + ':' + d.input;
                const cur = firstFor.get(dk);
                if (!cur || e.seq < cur.seq) firstFor.set(dk, e);
            }
        }
        for (const [key, e, dests] of cands) {
            if (dests.some(d => firstFor.get(d.node + ':' + d.input) === e)) outs.push([key, e]);
        }
        return { ins, outs };
    }

    /** buildView: attach session entries to live rows / box ports and add the kept ones. */
    _applySession(ses, gid, rep, view, proxy) {
        const panelIn = view.inPanel, panelOut = view.outPanel;
        // Live crossings first: they only get their entry (for names and places)
        for (const [key, e] of ses.ins) {
            const live = proxy ? proxy._byKey.get('in|' + key) : panelIn._byKey.get(key);
            if (live) live.entry = e;
        }
        for (const [key, e] of ses.outs) {
            const live = proxy ? proxy._byKey.get('out|' + key) : panelOut._byKey.get(key);
            if (live) live.entry = e;
        }
        const kept = this._keptEntries(ses, gid);
        for (const [key, e] of kept.ins) {
            const a = this._nodeById(e.src);
            const port = proxy ? proxy.port('in', key, a, e.out) : panelIn.port(key, a, e.out);
            port.entry = e;
            port.kept = true;
            // Outside the box: the cable from its source is still drawn (dashed: it feeds nothing yet)
            if (proxy && rep(a) === a) view.ghosts.push({ src: a, sp: e.out, dst: proxy, dp: port, type: srcType(a, e.out) });
        }
        for (const [key, e] of kept.outs) {
            const n = this._nodeById(e.src);
            const port = proxy ? proxy.port('out', key, n, e.out) : panelOut.port(key, n, e.out);
            port.entry = e;
            port.kept = true;
            if (!proxy) continue;
            for (const d of this._entryDests(e, gid)) {
                const dn = this._nodeById(d.node);
                if (rep(dn) === dn) view.ghosts.push({ src: proxy, sp: port, dst: dn, dp: d.input, type: srcType(n, e.out) });
            }
        }
    }

    /** buildView of an open group: remember every live crossing row (after labels and order are known). */
    _recordSession(ses, gid, inPanel, outPanel) {
        const grp = this.getGroup(gid);
        const entryFor = (map, r) => {
            let e = map.get(r.key);
            if (!e) {
                e = { gid, seq: ++this._sessionSeq };
                map.set(r.key, e);
                r.entry = e;
            }
            e.src = r.source.node.id;
            e.out = r.source.index;
            e.sortY = r.sortY;
            e.labelKey = this._portLabelKey(grp, r);
            return e;
        };
        for (const r of inPanel.rows) {
            if (r.expose || !r.source || !r.conns.length || !r.key.startsWith('s:')) continue;
            entryFor(ses.ins, r).targets = (r.targets || targetsOf(r.conns)).map(t => [t.node.id, t.index]);
        }
        for (const r of outPanel.rows) {
            if (r.expose || !r.source || !r.conns.length || !r.key.startsWith('o:')) continue;
            const dests = [];
            for (const c of r.conns) {
                if (dests.some(d => d.node === c.toNode.id && d.input === c.toInput)) continue;
                dests.push({ node: c.toNode.id, input: c.toInput, accessor: c.accessor || null, type: srcType(c.fromNode, c.fromOutput) });
            }
            entryFor(ses.outs, r).dests = dests;
        }
    }

    /** Is group gid open (it or a group inside it is the current scope)? */
    isOpen(gid) {
        return gid != null && this.scope !== null && this.chainOf(this.scope).includes(gid);
    }

    /**
     * The current scope changed (or is about to): close the sessions of groups that are no
     * longer open, pruning their unused kept rows, and open sessions along the new scope's chain.
     */
    _syncSessions(scope) {
        const chain = new Set(this.chainOf(scope));
        const closing = [];
        for (const [gid, ses] of this._sessions) {
            if (chain.has(gid)) continue;
            this._sessions.delete(gid);
            if (this.getGroup(gid)) closing.push([gid, ses]);
        }
        if (closing.length) this._pruneClosed(closing);
        for (const gid of chain) if (!this._sessions.has(gid)) this._sessions.set(gid, this._newSession());
    }

    /** Drop the unused kept rows of closed groups (one undo step that also removes their names). */
    _pruneClosed(closing) {
        const plan = [];
        for (const [gid, ses] of closing) {
            const grp = this.getGroup(gid);
            const kept = this._keptEntries(ses, gid);
            // Re-plugged rows still named through a remembered key take that name for good
            const pins = [];
            const m = grp.portLabels || {};
            for (const [key, e] of ses.ins) {
                if (!e.labelKey || e.labelKey === key || !m[e.labelKey] || m[key]) continue;
                if (!this._crossing(gid, 'in', e.src, e.out)) continue;
                const t = [];
                for (const c of this.graph.connections) {
                    if (c.fromNode && c.toNode && c.fromNode.id === e.src && c.fromOutput === e.out && this.isInSubtree(c.toNode, gid) &&
                        !t.some(x => x.node === c.toNode.id && x.index === c.toInput)) t.push({ node: c.toNode.id, index: c.toInput });
                }
                if (t.length === 1 && m[`x:${t[0].node}:${t[0].index}`]) continue;
                pins.push([key, e.labelKey]);
            }
            if (!kept.ins.length && !kept.outs.length && !pins.length) continue;
            const drop = new Set();
            for (const [key, e] of kept.ins) {
                drop.add(key);
                if (e.labelKey) drop.add(e.labelKey);
                const t = e.targets || [];
                if (t.length === 1) drop.add(`x:${t[0][0]}:${t[0][1]}`);
            }
            for (const [key, e] of kept.outs) {
                drop.add(key);
                if (e.labelKey) drop.add(e.labelKey);
            }
            for (const [, from] of pins) drop.add(from);
            plan.push({ gid, ins: kept.ins, outs: kept.outs, pins, drop });
        }
        if (!plan.length) return;
        const apply = () => {
            for (const p of plan) {
                const grp = this.getGroup(p.gid);
                if (!grp) continue;
                const map = { ...(grp.portLabels || {}) };
                for (const [key, from] of p.pins) if (map[from] && !map[key]) map[key] = map[from];
                grp.portLabels = map;
                // Names still used by a remaining port (or an exposed input) stay
                const used = this._usedLabelKeys(grp);
                for (const k of p.drop) if (map[k] && !used.has(k)) delete map[k];
                if (Object.keys(map).length) grp.portLabels = map; else delete grp.portLabels;
            }
            this.touch();
            this.invalidate();
        };
        // Undo brings the rows back (kept) with their names; redo drops them again
        const copy = (list) => list.map(([k, e]) => [k, JSON.parse(JSON.stringify(e))]);
        const saved = plan.map(p => ({ gid: p.gid, ins: copy(p.ins), outs: copy(p.outs) }));
        const meta = {
            undo: () => {
                for (const p of saved) {
                    if (!this.getGroup(p.gid)) continue;
                    let ses = this._sessions.get(p.gid);
                    if (!ses) this._sessions.set(p.gid, ses = this._newSession());
                    for (const [k, e] of p.ins) ses.ins.set(k, { ...e });
                    for (const [k, e] of p.outs) ses.outs.set(k, { ...e });
                }
                this.touch();
                this.invalidate();
            },
            redo: () => {
                for (const p of saved) {
                    const ses = this._sessions.get(p.gid);
                    if (!ses) continue;
                    for (const [k] of p.ins) ses.ins.delete(k);
                    for (const [k] of p.outs) ses.outs.delete(k);
                    if (!ses.ins.size && !ses.outs.size && !this.isOpen(p.gid)) this._sessions.delete(p.gid);
                }
                this.touch();
                this.invalidate();
            },
        };
        const hist = this.graph.history;
        if (hist && typeof hist.record === 'function') hist.record('Remove unused group ports', apply, meta);
        else apply();
    }

    /** portLabels keys the box ports of grp use right now (and the 'x:' keys of its exposed inputs). */
    _usedLabelKeys(grp) {
        const used = new Set();
        for (const e of (grp.exposed && grp.exposed.inputs) || []) used.add(`x:${e.node}:${e.port}`);
        try { this.buildView(this.parentOf(grp.id)); } catch (e) { return used; }
        const p = this._proxy(grp);
        for (const port of [...p.inPorts, ...p.outPorts]) {
            const k = this._portLabelKey(grp, port);
            if (k) used.add(k);
        }
        this.invalidate();
        return used;
    }

    /**
     * Box ports of a group as currently shown: [{key, kind, index, label, auto, custom, type}].
     * Builds the parent scope's view.
     */
    groupPorts(gid) {
        const grp = this.getGroup(gid);
        if (!grp) return [];
        try { this.buildView(this.parentOf(gid)); } catch (e) { return []; }
        const p = this._proxy(grp);
        const row = (kind) => (port, index) => ({
            key: port.key, kind, index, label: port.label, auto: port.autoLabel || port.label, custom: !!port.custom, type: port.type || null,
        });
        return [...p.inPorts.map(row('in')), ...p.outPorts.map(row('out'))];
    }

    /**
     * Name a group box port (label '' or null = back to the automatic name). key: the port's
     * stable key ('s:12:0', 'x:7:1', 'o:15:0'). Returns true when something changed.
     */
    setPortLabel(gid, key, label) {
        const grp = this.getGroup(gid);
        if (!grp || typeof key !== 'string' || !PORT_KEY_RE.test(key)) return false;
        let target = key;
        // Renaming an 's:' port that shows its exposed input's name: keep that one entry
        if (key.startsWith('s:') && grp.portLabels && !grp.portLabels[key]) {
            this.groupPorts(gid); // builds the box ports
            const live = this._proxy(grp).inPorts.find(q => q.key === key);
            if (live) target = this._labelKeyFor(grp, live);
        }
        const text = String(label == null ? '' : label).replace(/\s+/g, ' ').trim().slice(0, PORT_LABEL_MAX);
        const cur = (grp.portLabels && grp.portLabels[target]) || '';
        if (text === cur) return false;
        const map = { ...(grp.portLabels || {}) };
        if (text) map[target] = text; else delete map[target];
        if (Object.keys(map).length) grp.portLabels = map; else delete grp.portLabels;
        this.touch();
        this.invalidate();
        this.ui.update();
        return true;
    }

    /** Draw a group box above its sibling boxes. */
    bringToFront(item) {
        if (!item || !item.isGroupProxy) return;
        const list = this.groups;
        const i = list.indexOf(item.group);
        if (i < 0 || i === list.length - 1) return;
        list.splice(i, 1);
        list.push(item.group);
        this.touch();
    }

    /** Move nodes / groups into a group (or the root with gid null). */
    moveIntoGroup(items, gid) {
        const target = gid == null ? null : this.getGroup(gid);
        if (gid != null && !target) throw new Error(`No group "${gid}"`);
        for (const it of items) {
            if (it.isGroupProxy || (it.nodeIds && it.id != null && !it.type)) {
                const grp = it.isGroupProxy ? it.group : it;
                if (gid != null && (grp.id === gid || this.chainOf(gid).includes(grp.id))) continue;
                grp.parentId = gid == null ? null : gid;
            } else if (!it.isViewOnly) {
                this._removeFromGroups(it.id);
                if (target) target.nodeIds.push(it.id);
            }
        }
        this.touch();
    }

    /** Members of a deleted subtree (and the groups themselves) are removed. Returns the nodes to delete. */
    _removeGroupsWithContents(gids) {
        const ids = new Set();
        for (const gid of gids) {
            ids.add(gid);
            for (const ch of this.subtreeGroups(gid)) ids.add(ch.id);
        }
        const nodes = this.graph.nodes.filter(n => ids.has(this.groupOf(n.id)));
        for (let i = this.groups.length - 1; i >= 0; i--) {
            if (ids.has(this.groups[i].id)) this.groups.splice(i, 1);
        }
        for (const id of ids) {
            this._proxies.delete(id);
            this.scopeViews.delete(id);
        }
        this.touch();
        return nodes;
    }

    _expose(kind, node, index) {
        const gid = this.scope;
        if (gid === null || !node || !this.isInSubtree(node, gid)) return false;
        const grp = this.getGroup(gid);
        const ex = grp.exposed || (grp.exposed = { inputs: [], outputs: [] });
        const list = kind === 'in' ? (ex.inputs || (ex.inputs = [])) : (ex.outputs || (ex.outputs = []));
        if (!list.some(e => e.node === node.id && e.port === index)) list.push({ node: node.id, port: index });
        this.touch();
        const label = kind === 'in' ? qualifiedIn(node, index) : qualifiedOut(node, index);
        this.changed(`Exposed ${label} on “${grp.name}”`);
        return true;
    }
    exposeOutput(node, index) { return this._expose('out', node, index); }
    exposeInput(node, index) { return this._expose('in', node, index); }
    unexpose(gid, kind, nodeId, port) {
        const grp = this.getGroup(gid);
        const ex = grp && grp.exposed;
        if (!ex) return false;
        const key = kind === 'in' ? 'inputs' : 'outputs';
        const before = (ex[key] || []).length;
        ex[key] = (ex[key] || []).filter(e => !(e.node === nodeId && e.port === port));
        if (ex[key].length === before) return false;
        this.touch();
        this.changed('Removed exposed port');
        return true;
    }

    // ------------------------------------------------------------------
    // Connections through boxes / panels
    // ------------------------------------------------------------------

    _dragAccessor() {
        const g = this.graph;
        const hint = g.swizzleHintSuggestion || g.swizzleHint;
        return hint ? '.' + hint : null;
    }

    connect(src, out, dst, inp, accessor = null) {
        const g = this.graph;
        const C = this.Connection;
        if (!C || !src || !dst || src === dst) return false;
        if (src.isDynamicInput && g.resolveDynamicNodeOutputType) g.resolveDynamicNodeOutputType(src);
        const conn = new C(src, out, dst, inp, accessor);
        if (!conn.isValid()) {
            // Signal-rate rules (src/core/control/rates.js): explain why
            if (conn.rateError) import('../ui/UIHelpers.js').then(m => m.UIHelpers.toast(conn.rateError, 'warning', { title: 'Cannot connect' })).catch(() => {});
            console.warn('Invalid connection: type mismatch', { from: conn.getOutputType(), to: dst.inputs[inp] && dst.inputs[inp].type, accessor });
            return false;
        }
        g.connections = g.connections.filter(c => !(c.toNode === dst && c.toInput === inp));
        g.connections.push(conn);
        if (dst.shouldAddNewInput && dst.shouldAddNewInput()) dst.addDynamicInput();
        if (g.onGraphChanged) g.onGraphChanged();
        g.render();
        return true;
    }

    /** Point every connection in `conns` at a new source (keeps accessors when the type matches). */
    rewire(conns, src, out, accessor = null) {
        const g = this.graph;
        const C = this.Connection;
        if (!C) return false;
        if (src.isDynamicInput && g.resolveDynamicNodeOutputType) g.resolveDynamicNodeOutputType(src);
        const newType = srcType(src, out);
        const made = [];
        for (const c of conns) {
            if (c.toNode === src) continue;
            const keep = !accessor && c.accessor && srcType(c.fromNode, c.fromOutput) === newType ? c.accessor : null;
            const nc = new C(src, out, c.toNode, c.toInput, accessor || keep);
            if (!nc.isValid()) continue;
            made.push([c, nc]);
        }
        if (!made.length) return false;
        const old = new Set(made.map(m => m[0]));
        g.connections = g.connections.filter(c => !old.has(c));
        for (const [, nc] of made) g.connections.push(nc);
        if (g.onGraphChanged) g.onGraphChanged();
        g.render();
        return true;
    }

    /**
     * An inner output dropped on a kept "To outside" row: feed the outside inputs it fed. From
     * another source the row's key changes; its name (and exposure) follow it.
     */
    _replugOutput(port, src, out, accessor = null) {
        const g = this.graph;
        const C = this.Connection;
        const e = port.entry;
        const gid = this.scope;
        const grp = this.getGroup(gid);
        if (!C || !e || !grp || !this.isInSubtree(src, gid)) return false;
        if (src.isDynamicInput && g.resolveDynamicNodeOutputType) g.resolveDynamicNodeOutputType(src);
        const newType = srcType(src, out);
        const made = [];
        for (const d of this._entryDests(e, gid)) {
            const dn = this._nodeById(d.node);
            if (dn === src || g.connections.some(c => c.toNode === dn && c.toInput === d.input)) continue; // fed by something else now
            const keep = !accessor && d.accessor && d.type === newType ? d.accessor : null;
            const nc = new C(src, out, dn, d.input, accessor || keep);
            if (nc.isValid()) made.push(nc);
        }
        if (!made.length) return false;
        const key = 'o:' + src.id + ':' + out;
        if (key !== port.key) {
            const labels = grp.portLabels;
            const from = this._portLabelKey(grp, port);
            if (labels && from && labels[from] && !labels[key]) {
                const map = { ...labels, [key]: labels[from] };
                delete map[from];
                grp.portLabels = map;
            }
            const ex = grp.exposed && grp.exposed.outputs;
            const old = port.source;
            if (ex && old && port.exposed) {
                grp.exposed.outputs = ex.filter(x => !(x.node === old.node.id && x.port === old.index));
                if (!grp.exposed.outputs.some(x => x.node === src.id && x.port === out)) grp.exposed.outputs.push({ node: src.id, port: out });
            }
            this.touch();
        }
        for (const nc of made) g.connections.push(nc);
        if (g.onGraphChanged) g.onGraphChanged();
        g.render();
        return true;
    }

    /** Another outside source dropped on a virtual box input: it now feeds that input (its name follows). */
    _repointVirtual(gid, port, src, out) {
        const old = port.source;
        if (!old || (old.node === src && old.index === out)) return true;
        if (this.isInSubtree(src, gid)) return false;
        if (this._hasInFeed(gid, src.id, out)) {
            this._toast('Already an input of this group');
            return true;
        }
        const owners = this._virtualOwners(gid, old.node.id, old.index);
        if (!owners.length) return false;
        const from = `s:${old.node.id}:${old.index}`, key = `s:${src.id}:${out}`;
        for (const grp of owners) {
            grp.virtualInputs = grp.virtualInputs.map(v => (v.node === old.node.id && v.port === old.index ? { node: src.id, port: out } : v));
            const m = grp.portLabels;
            if (m && m[from] && !m[key]) {
                const map = { ...m, [key]: m[from] };
                delete map[from];
                grp.portLabels = map;
            }
        }
        this.touch();
        this.invalidate();
        this.changed();
        return true;
    }

    /**
     * A cable from outside dropped on a group box: a new input of the group, patched to that
     * output and feeding nothing inside yet (virtual). True when handled.
     */
    dropNewInput(proxy, src, out) {
        const grp = proxy && proxy.group;
        if (!grp) return false;
        const r = this.addVirtualInput(grp.id, src, out);
        if (r === 'exists') {
            this._toast(`${qualifiedOut(src, out)} already feeds “${grp.name}”`);
            return true;
        }
        if (!r) return false;
        const hist = this.graph.history;
        if (hist && typeof hist.hint === 'function') hist.hint(`Add input to “${grp.name}”`);
        this.changed(`New input on “${grp.name}” from ${qualifiedOut(src, out)}`);
        return true;
    }

    _toast(text) {
        import('../ui/UIHelpers.js').then(m => m.UIHelpers.toast(text, 'info')).catch(() => {});
    }

    /** Fill in where a cable drag starts when its real port isn't visible (hidden in a box / outside). */
    decorateDrag(cf) {
        if (!cf || cf.viewNode || cf.originPos) return;
        if (this.scope === null && !this.hasGroups()) return;
        const v = this.view();
        if (v.rep(cf.node) === cf.node) return;
        const vp = this.viewPortFor(cf.node, cf.isReverse ? 'in' : 'out', cf.isReverse ? cf.inputIndex : cf.outputIndex);
        if (vp && vp.pos) {
            cf.viewNode = vp.view;
            cf.viewIndex = vp.index;
            cf.originPos = vp.pos;
        }
    }

    /** Mouse down on a box port / panel row (NodeGraph.handleAction). */
    beginPortDrag(action) {
        const g = this.graph;
        const v = action.node;
        if (action.type === 'START_CONNECTION_FROM_OUTPUT') {
            const i = action.outputIndex;
            const port = v.portAt('out', i);
            if (!port || port.expose || !port.source) return;
            g.connectingFrom = {
                node: port.source.node, outputIndex: port.source.index,
                viewNode: v, viewIndex: i, originPos: v.getOutputPortPosition(i)
            };
            return;
        }
        const i = action.inputIndex;
        const port = v.portAt('in', i);
        if (!port || port.expose) return;
        if (port.virtual && !port.conns.length && port.source && v.isGroupProxy) {
            // Pull the outside cable out of a virtual input: the port goes (nothing inside uses it)
            const src = port.source;
            const portPos = v.getInputPortPosition(i);
            const removed = this.removeVirtualInputs(v.group.id, src.node.id, src.index);
            // ...unless this box sits in an open group the source comes from outside of: that
            // group's own input stays, unplugged inside it
            const gid = this.scope;
            if (gid !== null && !this.isInSubtree(src.node, gid) && !this._hasInFeed(gid, src.node.id, src.index)) {
                const grp = this.getGroup(gid);
                (grp.virtualInputs || (grp.virtualInputs = [])).push({ node: src.node.id, port: src.index });
                this.touch();
            }
            this.invalidate();
            const origin = this.viewPortFor(src.node, 'out', src.index);
            g.connectingFrom = {
                node: src.node, outputIndex: src.index, wasDisconnected: true,
                viewNode: origin ? origin.view : null, viewIndex: origin ? origin.index : undefined,
                originPos: origin && origin.pos ? origin.pos : portPos,
                reattach: { conns: [], virtuals: removed, pos: portPos }
            };
            this.ui.update();
            g.render();
            return;
        }
        if (port.conns.length && port.source) {
            // Pull the cable(s) out and keep dragging from the source, like a patched input
            const src = port.source;
            const origin = this.viewPortFor(src.node, 'out', src.index);
            const portPos = v.getInputPortPosition(i);
            const conns = port.conns.slice();
            const set = new Set(conns);
            g.connections = g.connections.filter(c => !set.has(c));
            g.connectingFrom = {
                node: src.node, outputIndex: src.index, wasDisconnected: true,
                viewNode: origin ? origin.view : null, viewIndex: origin ? origin.index : undefined,
                originPos: origin && origin.pos ? origin.pos : portPos,
                reattach: { conns, pos: portPos }
            };
            if (g.onGraphChanged) g.onGraphChanged();
            g.render();
            return;
        }
        if (port.target) {
            g.connectingFrom = {
                node: port.target.node, inputIndex: port.target.index, isReverse: true,
                viewNode: v, viewIndex: i, originPos: v.getInputPortPosition(i)
            };
        }
    }

    /** Cable dropped on a box port / panel row (NodeGraph.onMouseUp). kind: the port's side. */
    dropOnPort(v, kind, index) {
        const g = this.graph;
        const cf = g.connectingFrom;
        if (!cf) return false;
        const accessor = this._dragAccessor();
        const port = v.portAt(kind, index);
        if (!port) return false;
        if (kind === 'in') {
            if (cf.isReverse) return false;
            const src = cf.node, out = cf.outputIndex;
            if (port.expose) return this.exposeOutput(src, out);
            if (port.conns.length) return this.rewire(port.conns, src, out, accessor);
            if (port.virtual && v.isGroupProxy && port.source) return this._repointVirtual(v.group.id, port, src, out);
            if (port.target) return this.connect(src, out, port.target.node, port.target.index, accessor);
            if (port.kept && v.isBoundaryPanel && port.source) return this._replugOutput(port, src, out, accessor);
            if (port.exposed && v.isBoundaryPanel && port.source) {
                // Re-point an exposed output at another inner source
                this.unexpose(this.scope, 'out', port.source.node.id, port.source.index);
                return this.exposeOutput(src, out);
            }
            return false;
        }
        if (!cf.isReverse) return false;
        const dst = cf.node, inp = cf.inputIndex;
        if (port.expose) return this.exposeInput(dst, inp);
        if (port.source) return this.connect(port.source.node, port.source.index, dst, inp, accessor);
        return false;
    }

    /**
     * Cable dropped elsewhere: back onto the port it was pulled from (restore), onto a
     * boundary panel (expose) or onto a group box body (pick an inner port). True = handled.
     */
    dropOnBody(pos, event) {
        const g = this.graph;
        const cf = g.connectingFrom;
        if (!cf) return false;
        if (this.reattachIfBack(pos)) return true;
        if (this.scope === null && !this.hasGroups()) return false;
        const items = this.viewNodes();
        for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            if (!it.isViewOnly || !it.containsPoint(pos.x, pos.y)) continue;
            if (it.isBoundaryPanel) {
                if (it.side === 'out' && !cf.isReverse) return this.exposeOutput(cf.node, cf.outputIndex) || true;
                if (it.side === 'in' && cf.isReverse) return this.exposeInput(cf.node, cf.inputIndex) || true;
                return true;
            }
            if (it.isGroupProxy) {
                if (it === cf.viewNode) return true;
                // On the "new input" drop zone (the inputs column): a new input, connected inside later
                if (!cf.isReverse && it.newInputZoneAt(pos.x, pos.y) && !this.isInSubtree(cf.node, it.group.id)) {
                    return this.dropNewInput(it, cf.node, cf.outputIndex);
                }
                this.ui.openPortPicker(it, {
                    node: cf.node,
                    index: cf.isReverse ? cf.inputIndex : cf.outputIndex,
                    reverse: !!cf.isReverse,
                    accessor: this._dragAccessor(),
                }, event);
                return true;
            }
        }
        return false;
    }

    /**
     * A cable pulled out of a box port / panel row and released where it came from: put
     * the original cable(s) back. True = restored (the drop is handled).
     */
    reattachIfBack(pos) {
        const g = this.graph;
        const cf = g.connectingFrom;
        if (!cf || !cf.reattach || cf.reattach.done || !pos) return false;
        if (Math.hypot(pos.x - cf.reattach.pos.x, pos.y - cf.reattach.pos.y) >= 12) return false;
        cf.reattach.done = true;
        for (const c of cf.reattach.conns) if (!g.connections.includes(c)) g.connections.push(c);
        for (const v of cf.reattach.virtuals || []) {
            const grp = this.getGroup(v.gid);
            if (!grp) continue;
            const list = grp.virtualInputs || (grp.virtualInputs = []);
            if (!list.some(w => w.node === v.node && w.port === v.port)) list.push({ node: v.node, port: v.port });
        }
        if (cf.reattach.virtuals && cf.reattach.virtuals.length) {
            // (an input left on the open group meanwhile is redundant again: reconcileInputs drops it)
            this.touch();
            this.invalidate();
        }
        if (g.onGraphChanged) g.onGraphChanged();
        return true;
    }

    /** Inner ports of a group a dragged cable could connect to (port picker). */
    pickerCandidates(gid, drag) {
        const out = [];
        const type = drag.reverse
            ? (drag.node.inputs[drag.index] && drag.node.inputs[drag.index].type)
            : accessorType(srcType(drag.node, drag.index), drag.accessor);
        for (const n of this.subtreeNodes(gid)) {
            if (n.isCommentNode || n === drag.node) continue;
            const depth = this.chainOf(this.groupOf(n.id)).indexOf(gid);
            if (drag.reverse) {
                n.outputs.forEach((o, i) => {
                    const t = srcType(n, i);
                    if (!typesCompatible(t, type)) return;
                    out.push({ node: n, index: i, label: qualifiedOut(n, i), type: t, depth, linked: false });
                });
            } else {
                n.inputs.forEach((inp, i) => {
                    if (n.getInputPortPosition && !n.getInputPortPosition(i)) return; // hidden (uniform mode)
                    if (!typesCompatible(type, inp.type)) return;
                    const linked = this.graph.connections.some(c => c.toNode === n && c.toInput === i);
                    out.push({ node: n, index: i, label: qualifiedIn(n, i), type: inp.type, depth, linked });
                });
            }
        }
        out.sort((a, b) => (a.linked - b.linked) || (a.depth - b.depth) || (a.node.y - b.node.y) || (a.index - b.index));
        return out;
    }

    // ------------------------------------------------------------------
    // Selection-level commands (keyboard / context menu)
    // ------------------------------------------------------------------

    changed(message) {
        const g = this.graph;
        if (g.onGraphChanged) g.onGraphChanged();
        g.render();
        this.ui.update();
        if (message) {
            try { window.toy && window.toy.shell && window.toy.shell.activity(message, { local: true }); } catch (e) { /* ignore */ }
        }
    }

    selectedItems() {
        return [...this.graph.selectionManager.selectedNodes].filter(n => !n.isBoundaryPanel);
    }

    groupSelection({ rename = true, name } = {}) {
        const g = this.graph;
        const sel = this.selectedItems();
        if (!sel.length) return null;
        const v = this.view();
        const nodes = sel.filter(n => !n.isViewOnly && (this.scope === null && !this.hasGroups() ? true : v.nodeSet.has(n)));
        for (const n of [...nodes]) {
            const pid = n.data && n.data.pairNodeId;
            if ((n.isForLoopStartNode || n.isForLoopEndNode) && pid !== undefined && pid !== null) {
                const pair = this._nodeById(pid);
                if (pair && !nodes.includes(pair) && (this.groupOf(pair.id) === this.scope)) nodes.push(pair);
            }
        }
        const proxies = sel.filter(n => n.isGroupProxy);
        if (!nodes.length && !proxies.length) return null;
        const bb = bboxOf([...nodes, ...proxies]);
        const grp = this.createGroup({
            name: name || this.uniqueName('Group'),
            parentId: this.scope,
            nodes,
            groups: proxies.map(p => p.group),
            x: (bb.x0 + bb.x1) / 2 - 110,
            y: (bb.y0 + bb.y1) / 2 - 60,
        });
        // Center the box where its contents were
        this.view();
        const proxy = this._proxy(grp);
        grp.x = Math.round((bb.x0 + bb.x1) / 2 - proxy.width / 2);
        grp.y = Math.round((bb.y0 + bb.y1) / 2 - proxy.height / 2);
        g.selectionManager.selectedNodes.clear();
        g.selectionManager.selectedNodes.add(proxy);
        const count = nodes.length + proxies.length;
        this.changed(`Grouped ${count} item${count === 1 ? '' : 's'} into “${grp.name}”`);
        if (rename) requestAnimationFrame(() => this.ui.beginRename(grp.id, { isNew: true }));
        return grp;
    }

    ungroupSelection() {
        const g = this.graph;
        const proxies = this.selectedItems().filter(n => n.isGroupProxy);
        if (!proxies.length) return false;
        const released = [];
        for (const p of proxies) {
            const r = this.ungroup(p.group.id);
            if (!r) continue;
            released.push(...r.nodes, ...r.groups.map(k => this._proxy(k)));
        }
        g.selectionManager.selectedNodes.clear();
        for (const it of released) g.selectionManager.selectedNodes.add(it);
        this.changed(`Ungrouped ${proxies.length} group${proxies.length === 1 ? '' : 's'}`);
        return true;
    }

    /** Move the selection one level up (out of the current group). */
    moveSelectionToParent() {
        if (this.scope === null) return false;
        const g = this.graph;
        const sel = this.selectedItems();
        if (!sel.length) return false;
        const cur = this.getGroup(this.scope);
        const parent = this.parentOf(this.scope);
        const proxy = this._proxies.get(this.scope);
        const bb = bboxOf(sel);
        // Land them to the right of the box in the parent scope
        const dx = Math.round(cur.x + (proxy ? proxy.width : 220) + 80 - bb.x0);
        const dy = Math.round(cur.y - bb.y0);
        for (const it of sel) { it.x += dx; it.y += dy; }
        this.moveIntoGroup(sel, parent);
        g.selectionManager.selectedNodes.clear();
        this.changed(`Moved ${sel.length} item${sel.length === 1 ? '' : 's'} out of “${cur.name}”`);
        return true;
    }

    handleKey(e) {
        const mod = e.metaKey || e.ctrlKey;
        const k = (e.key || '').toLowerCase();
        if (mod && !e.altKey && k === 'g') {
            e.preventDefault();
            if (e.shiftKey) this.ungroupSelection();
            else this.groupSelection();
            return true;
        }
        if (!mod && e.key === 'Enter' && !this.graph.connectingFrom) {
            const sel = this.selectedItems();
            if (sel.length === 1 && sel[0].isGroupProxy) {
                e.preventDefault();
                this.enter(sel[0].group.id);
                return true;
            }
        }
        return false;
    }

    onDoubleClick(item, pos) {
        if (item.isGroupProxy) {
            const hit = item.hitTitle(pos.x, pos.y) ? null : item.portLabelAt(pos.x, pos.y);
            if (item.hitTitle(pos.x, pos.y)) this.ui.beginRename(item.group.id);
            else if (hit && hit.port) this.ui.beginPortRename(item.group.id, hit.port.key);
            else this.enter(item.group.id);
            return true;
        }
        if (item.isBoundaryPanel) {
            const ri = item.rowAt(pos.x, pos.y);
            const row = ri >= 0 ? item.rows[ri] : null;
            if (row && !row.expose && this.scope !== null) this.ui.beginPortRename(this.scope, row.key, { inside: true });
            return true;
        }
        return false;
    }

    /** NodeGraph.deleteSelectedNodes hook: boxes in the selection ask what to do. True = taken over. */
    interceptDelete(opts = {}) {
        const g = this.graph;
        const sel = g.selectionManager.selectedNodes;
        let viewOnly = false;
        for (const n of sel) if (n.isViewOnly) { viewOnly = true; break; }
        if (!viewOnly) return false;
        for (const n of [...sel]) if (n.isBoundaryPanel) sel.delete(n);
        const proxies = [...sel].filter(n => n.isGroupProxy);
        if (!proxies.length) return false;
        const loose = [...sel].filter(n => !n.isViewOnly);
        const finish = (mode) => {
            if (!mode) return;
            sel.clear();
            if (mode === 'contents') {
                const inner = this._removeGroupsWithContents(proxies.map(p => p.group.id));
                for (const n of [...loose, ...inner]) sel.add(n);
            } else {
                for (const p of proxies) this.ungroup(p.group.id);
                for (const n of loose) sel.add(n);
            }
            if (sel.size) g.deleteSelectedNodes();
            else this.changed();
            this.ui.update();
        };
        if (opts.groupContents) {
            finish('contents');
            return true;
        }
        this.ui.confirmDeleteGroups(proxies, loose.length).then(finish);
        return true;
    }

    onNodesDeleted(nodes) {
        if (!this.hasGroups()) return;
        const ids = new Set();
        for (const n of nodes) ids.add(n.id);
        // Where the deleted nodes were (reconcileInputs: an inner consumer deleted inside an open group)
        const was = this._deletedGroupOf || (this._deletedGroupOf = new Map());
        for (const id of ids) was.set(id, this.groupOf(id));
        let dirty = false;
        for (const grp of this.groups) {
            const before = grp.nodeIds.length;
            grp.nodeIds = grp.nodeIds.filter(id => !ids.has(id));
            if (grp.nodeIds.length !== before) dirty = true;
            if (grp.exposed) {
                for (const key of ['inputs', 'outputs']) {
                    const list = grp.exposed[key] || [];
                    const kept = list.filter(e => !ids.has(e.node));
                    if (kept.length !== list.length) { grp.exposed[key] = kept; dirty = true; }
                }
            }
            if (grp.virtualInputs) {
                const kept = grp.virtualInputs.filter(v => !ids.has(v.node));
                if (kept.length !== grp.virtualInputs.length) {
                    if (kept.length) grp.virtualInputs = kept; else delete grp.virtualInputs;
                    dirty = true;
                }
            }
        }
        if (dirty) this.touch();
    }

    /** New nodes created from the UI land in the current scope. */
    adoptNew(node) {
        if (!node || this.scope === null || automationBusy()) return;
        const grp = this.getGroup(this.scope);
        if (!grp) return;
        this._removeFromGroups(node.id);
        grp.nodeIds.push(node.id);
        this.touch();
    }

    // ------------------------------------------------------------------
    // Clipboard
    // ------------------------------------------------------------------

    /** Real nodes to copy (boxes contribute their whole subtree) + the group records. */
    expandForCopy(selected) {
        const items = [...selected];
        const nodes = new Set(items.filter(n => !n.isViewOnly));
        const groups = [];
        for (const p of items.filter(n => n.isGroupProxy)) {
            const top = p.group;
            for (const grp of [top, ...this.subtreeGroups(top.id)]) {
                const rec = {
                    id: grp.id, name: grp.name, parentId: grp === top ? null : grp.parentId,
                    nodeIds: [...grp.nodeIds], x: grp.x, y: grp.y,
                };
                if (grp.color) rec.color = grp.color;
                if (grp.exposed) rec.exposed = JSON.parse(JSON.stringify(grp.exposed));
                if (grp.portLabels) rec.portLabels = { ...grp.portLabels };
                if (grp.virtualInputs) rec.virtualInputs = grp.virtualInputs.map(v => ({ node: v.node, port: v.port }));
                groups.push(rec);
            }
            for (const n of this.subtreeNodes(top.id)) nodes.add(n);
        }
        return { nodes: [...nodes], groups };
    }

    /** After NodeGraph.pasteNodes: recreate pasted groups and put loose nodes in the current scope. */
    afterPaste(clipboard, idMap, newNodes) {
        const g = this.graph;
        const recs = (clipboard && clipboard.groups) || [];
        const placed = new Set();
        const tops = [];
        if (recs.length) {
            const gidMap = new Map();
            const made = [];
            for (const rec of recs) {
                const grp = { id: this.newGroupId(), name: rec.name || 'Group', parentId: null, nodeIds: [], x: Math.round(rec.x || 0), y: Math.round(rec.y || 0) };
                this.groups.push(grp);
                gidMap.set(rec.id, grp);
                made.push([rec, grp]);
            }
            for (const [rec, grp] of made) {
                const top = rec.parentId == null || !gidMap.has(rec.parentId);
                grp.parentId = top ? this.scope : gidMap.get(rec.parentId).id;
                if (top) { grp.x += 30; grp.y += 30; tops.push(grp); }
                if (rec.color) grp.color = rec.color;
                for (const oldId of rec.nodeIds || []) {
                    const n = idMap.get(oldId);
                    if (n) { grp.nodeIds.push(n.id); placed.add(n.id); }
                }
                if (rec.exposed) {
                    const remap = (list) => (list || []).map(e => ({ node: idMap.get(e.node) ? idMap.get(e.node).id : null, port: e.port })).filter(e => e.node !== null);
                    grp.exposed = { inputs: remap(rec.exposed.inputs), outputs: remap(rec.exposed.outputs) };
                }
                if (rec.virtualInputs) {
                    // Like cables from outside, a virtual input whose source wasn't copied is not pasted
                    const list = rec.virtualInputs.filter(v => idMap.get(v.node)).map(v => ({ node: idMap.get(v.node).id, port: v.port }));
                    if (list.length) grp.virtualInputs = list;
                }
                if (rec.portLabels) {
                    const labels = {};
                    for (const [k, v] of Object.entries(rec.portLabels)) {
                        const nk = remapPortKey(k, idMap);
                        if (nk) labels[nk] = v;
                    }
                    const clean = cleanPortLabels(labels);
                    if (clean) grp.portLabels = clean;
                }
            }
        }
        if (this.scope !== null) {
            const cur = this.getGroup(this.scope);
            if (cur) for (const n of newNodes) if (!placed.has(n.id)) cur.nodeIds.push(n.id);
        }
        this.touch();
        if (tops.length || placed.size) {
            const sel = g.selectionManager.selectedNodes;
            for (const n of newNodes) if (placed.has(n.id)) sel.delete(n);
            for (const grp of tops) sel.add(this._proxy(grp));
        }
        this.ui.update();
    }

    // ------------------------------------------------------------------
    // Serialization
    // ------------------------------------------------------------------

    serializeGroups() {
        const ids = new Set(this.graph.nodes.map(n => n.id));
        this._index();
        return this.groups.filter(grp => grp && grp.id != null).map(grp => {
            const rec = {
                id: grp.id,
                name: grp.name || 'Group',
                parentId: this.parentOf(grp.id),
                nodeIds: (grp.nodeIds || []).filter(id => ids.has(id)),
                x: Math.round(grp.x || 0),
                y: Math.round(grp.y || 0),
            };
            if (grp.color) rec.color = grp.color;
            if (grp.collapsed) rec.collapsed = true;
            if (grp.exposed) {
                const clean = (list) => (list || []).filter(e => ids.has(e.node)).map(e => ({ node: e.node, port: e.port }));
                const inputs = clean(grp.exposed.inputs);
                const outputs = clean(grp.exposed.outputs);
                if (inputs.length || outputs.length) rec.exposed = { inputs, outputs };
            }
            const labels = cleanPortLabels(grp.portLabels, id => ids.has(id));
            if (labels) rec.portLabels = labels;
            if (grp.virtualInputs) {
                const list = grp.virtualInputs.filter(v => ids.has(v.node) && Number.isInteger(v.port)).map(v => ({ node: v.node, port: v.port }));
                if (list.length) rec.virtualInputs = list;
            }
            return rec;
        });
    }

    /** Load (and sanitize) group records after the nodes exist. Resets the scope to the root. */
    load(list) {
        const g = this.graph;
        const existing = new Set(g.nodes.map(n => n.id));
        const claimed = new Set();
        const out = [];
        const ids = new Set();
        for (const raw of Array.isArray(list) ? list : []) {
            if (!raw || typeof raw !== 'object' || raw.id === undefined || raw.id === null) continue;
            const id = String(raw.id);
            if (ids.has(id)) continue;
            ids.add(id);
            const nodeIds = [];
            for (const v of Array.isArray(raw.nodeIds) ? raw.nodeIds : []) {
                const n = typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : v;
                if (!Number.isInteger(n) || !existing.has(n) || claimed.has(n)) continue;
                claimed.add(n);
                nodeIds.push(n);
            }
            const grp = {
                id,
                name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Group',
                parentId: raw.parentId === undefined || raw.parentId === null ? null : String(raw.parentId),
                nodeIds,
                x: Number.isFinite(raw.x) ? raw.x : 0,
                y: Number.isFinite(raw.y) ? raw.y : 0,
            };
            if (typeof raw.color === 'string' && raw.color) grp.color = raw.color;
            if (raw.collapsed) grp.collapsed = true;
            if (raw.exposed && typeof raw.exposed === 'object') {
                const clean = (l) => (Array.isArray(l) ? l : [])
                    .filter(e => e && Number.isInteger(e.node) && existing.has(e.node) && Number.isInteger(e.port) && e.port >= 0)
                    .map(e => ({ node: e.node, port: e.port }));
                grp.exposed = { inputs: clean(raw.exposed.inputs), outputs: clean(raw.exposed.outputs) };
            }
            const labels = cleanPortLabels(raw.portLabels, id => existing.has(id));
            if (labels) grp.portLabels = labels;
            if (Array.isArray(raw.virtualInputs)) {
                const list = raw.virtualInputs
                    .filter(v => v && Number.isInteger(v.node) && existing.has(v.node) && Number.isInteger(v.port) && v.port >= 0)
                    .map(v => ({ node: v.node, port: v.port }));
                if (list.length) grp.virtualInputs = list;
            }
            out.push(grp);
        }
        for (const grp of out) if (grp.parentId !== null && !ids.has(grp.parentId)) grp.parentId = null;
        g.groups = out;
        this.scope = null;
        this._sessions.clear();
        this._deletedGroupOf = null;
        this.scopeViews.clear();
        this._proxies.clear();
        this._panels.clear();
        this._transition = null;
        this.invalidate();
        this.touch();
        this.ui.cancelRename();
        this.ui.update();
    }

    // ------------------------------------------------------------------
    // Layout (MCP auto_layout): every scope independently, boxes as nodes
    // ------------------------------------------------------------------

    /** Lay out all scopes (deepest first). Returns the number of items arranged. */
    layoutAllScopes() {
        this._index();
        const scopes = [null, ...this.groups.map(g => g.id)];
        scopes.sort((a, b) => this.chainOf(b).length - this.chainOf(a).length);
        let count = 0;
        for (const s of scopes) count += this.layoutScope(s);
        this.touch();
        this.invalidate();
        this.graph.render();
        return count;
    }

    layoutScope(scope) {
        const view = this.buildView(scope);
        const nodes = [...view.nodeSet];
        const notes = nodes.filter(n => n.isCommentNode);
        const items = [...nodes.filter(n => !n.isCommentNode), ...view.proxies];
        if (!items.length && !notes.length) return 0;
        const order = new Map(items.map((it, i) => [it, i]));
        const outgoing = new Map(items.map(n => [n, []]));
        const incoming = new Map(items.map(n => [n, []]));
        for (const l of view.links) {
            const a = l.fromNode, b = l.toNode;
            if (!outgoing.has(a) || !incoming.has(b) || a === b) continue;
            if (b.isFeedbackNode) continue; // feedback edges would create cycles
            if (!outgoing.get(a).includes(b)) outgoing.get(a).push(b);
            if (!incoming.get(b).includes(a)) incoming.get(b).push(a);
        }

        // Layer = longest distance to a sink (sinks / previews end up rightmost)
        const layer = new Map();
        const visiting = new Set();
        const depth = (n) => {
            if (layer.has(n)) return layer.get(n);
            if (visiting.has(n)) return 0;
            visiting.add(n);
            let d = 0;
            for (const t of outgoing.get(n)) d = Math.max(d, depth(t) + 1);
            visiting.delete(n);
            layer.set(n, d);
            return d;
        };
        items.forEach(depth);
        const maxLayer = items.length ? Math.max(...layer.values()) : 0;
        const columns = [];
        for (const n of items) {
            const col = maxLayer - layer.get(n);
            (columns[col] = columns[col] || []).push(n);
        }
        const pos = new Map();
        const setOrder = (col) => (columns[col] || []).forEach((n, i) => pos.set(n, i));
        const sortBy = (col, neighbours) => {
            const list = columns[col];
            if (!list) return;
            const key = (n) => {
                const ns = neighbours(n).filter(m => pos.has(m));
                if (!ns.length) return pos.get(n) ?? 0;
                return ns.reduce((s, m) => s + pos.get(m), 0) / ns.length;
            };
            list.sort((a, b) => key(a) - key(b) || order.get(a) - order.get(b));
            setOrder(col);
        };
        columns.forEach((list, col) => {
            if (!list) return;
            list.sort((a, b) => a.y - b.y || order.get(a) - order.get(b));
            setOrder(col);
        });
        for (let pass = 0; pass < 3; pass++) {
            for (let col = columns.length - 2; col >= 0; col--) sortBy(col, n => outgoing.get(n));
            for (let col = 1; col < columns.length; col++) sortBy(col, n => incoming.get(n));
        }

        const hOf = (n) => (n.isGroupProxy ? n.height + GROUP_LAYOUT.tabH + GROUP_LAYOUT.stack * 2 : n.height);
        const wOf = (n) => (n.isGroupProxy ? n.width + GROUP_LAYOUT.stack * 2 : n.width);
        const gapX = view.proxies.length ? 110 : 90;
        const gapY = view.proxies.length ? 48 : 36;
        const heights = columns.map(list => (list || []).reduce((s, n) => s + hOf(n), 0) + Math.max(0, (list || []).length - 1) * gapY);
        const tallest = Math.max(...heights, 0);
        const originX = 80, originY = 80;
        let x = originX;
        columns.forEach((list, col) => {
            if (!list) return;
            const colWidth = Math.max(...list.map(wOf));
            let y = originY + (tallest - heights[col]) / 2;
            for (const n of list) {
                n.x = Math.round(x);
                n.y = Math.round(n.isGroupProxy ? y + GROUP_LAYOUT.tabH : y);
                y += hOf(n) + gapY;
            }
            x += colWidth + gapX;
        });

        // Notes: a row above the laid-out content, in their previous left-to-right order
        if (notes.length) {
            notes.sort((a, b) => a.x - b.x || a.y - b.y);
            const tallestNote = Math.max(...notes.map(n => n.height));
            let nx = originX;
            const baseY = originY - 48;
            for (const n of notes) {
                n.x = Math.round(nx);
                n.y = Math.round(baseY - n.height);
                nx += n.width + 32;
            }
            void tallestNote;
        }
        return items.length + notes.length;
    }
}
