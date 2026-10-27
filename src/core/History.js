/**
 * History - undo / redo for the node graph (⌘Z / ⇧⌘Z, Ctrl+Z / Ctrl+Y, MCP undo / redo / history).
 *
 * Snapshot based, so it works whatever code path changed the graph (NodeGraph, NodeGroups,
 * ParamsPanel, Scenes section, control-rate nodes, custom GLSL nodes in main.js, MCP...):
 *
 *   - The document state is a snapshot of per-entity JSON strings: one string per node
 *     (node.serialize(), minus live values such as MIDI CC readings), a set of connection
 *     keys, one string per group record (NodeGroups.serializeGroups) and one per custom
 *     GLSL node definition. Order (z-order, click-to-front) and the view (pan / zoom /
 *     open group) are not part of it. Unchanged entities share the previous snapshot's
 *     strings, so a snapshot of a 700-node project costs about one serialize (~0.5 ms).
 *   - `base` is the last committed snapshot. A capture diffs the live graph against it
 *     and pushes a step holding only the changed entities ({before, after} strings), so
 *     a "move 3 nodes" step stores 3 small strings. Steps are capped by count and bytes.
 *   - Undo / redo restore a target state *in place*: nodes whose JSON differs get their
 *     position / size / data applied to the existing instance (keeping Feedback buffers,
 *     JS runtime state, preview renderers, device streams), missing nodes are recreated
 *     with their original ids, extra nodes removed, cables / groups / custom definitions
 *     reconciled. Shaders are recompiled only when compile-relevant state changed (not
 *     for moves, resizes, notes, groups, Param values or uniform-mode constant values).
 *
 * When to capture: user gestures (pointer up, typing, input / change events, blur, drop)
 * schedule a capture; a pointer gesture is one step (drag, slider scrub), typing into the
 * same node coalesces within a short window, onGraphChanged right after a gesture
 * schedules one too, and beginBatch / endBatch make multi-part operations (MCP commands,
 * build_graph) one step. Changes nobody gestured for (MIDI-driven values, JS outputs,
 * scene auto mode) are absorbed into the base without a step. Loading a project or
 * starting a new one clears the history. See also docs in ARCHITECTURE.md (Undo).
 */
import { NodeDefinitions } from './NodeDefinitions.js';
import { NodeFactory } from '../graph/NodeFactory.js';
import { UIHelpers } from '../ui/UIHelpers.js';

const MAX_STEPS = 100;
const MAX_BYTES = 24 * 1024 * 1024;  // strings held by the undo + redo stacks (approx.)
const DEBOUNCE_MS = 500;             // typing / input events -> capture
const POINTER_UP_MS = 40;            // after pointer up: let mouseup / click handlers run
const MERGE_MS = 1000;               // same-field edits closer than this coalesce
const GESTURE_MS = 2000;             // onGraphChanged this soon after a gesture is the user's
const ENTRY_OVERHEAD = 48;

const TEXT_INPUT_TYPES = /^(text|search|number|email|url|password|tel)$/i;

function isTypingElement(el) {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return TEXT_INPUT_TYPES.test(el.type || 'text');
    return !!(el.closest && el.closest('.monaco-editor, .cm-editor, .CodeMirror'));
}

const connKey = (c) => JSON.stringify([c.fromNode.id, c.fromOutput, c.toNode.id, c.toInput, c.accessor || c.swizzle || null]);

/** Live values that are not part of the document (kept on restore, never a step). */
function stripVolatile(json, node) {
    delete json.rawValue;        // MIDI CC readings
    delete json.smoothedValue;
    const d = json.data;
    if (d && typeof d === 'object') {
        if (node.isSceneSwitcher) delete d.current;                      // performance state (auto mode, inputs)
        if (node.isParamNode && d.kind === 'trigger') delete d.value;    // press counter
    }
    return json;
}
const VOLATILE_DATA = (node) => {
    const keys = [];
    if (node.isSceneSwitcher) keys.push('current');
    if (node.isParamNode && node.data && node.data.kind === 'trigger') keys.push('value');
    return keys;
};

/** JSON without fields that change on their own (JS outputs follow the running code). */
function withoutPassive(s) {
    if (!s || s.indexOf('"outputs"') < 0) return s;
    try {
        const j = JSON.parse(s);
        if (j.data && Array.isArray(j.data.outputs) && NodeDefinitions[j.type]?.isJSNode) delete j.data.outputs;
        return JSON.stringify(j);
    } catch (e) { return s; }
}

function sameJSON(a, b) {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function bytesOfPair(p) {
    return (p[0] ? p[0].length : 0) + (p[1] ? p[1].length : 0) + ENTRY_OVERHEAD;
}

export class History {
    constructor(app) {
        this.app = app;
        this.graph = app.nodeGraph;
        this.graph.history = this;
        this.undoStack = [];
        this.redoStack = [];
        this.base = null;
        this.batchDepth = 0;
        this._batch = null;
        this._restoring = false;
        this._timer = null;
        this._pendingOpts = null;
        this._hint = null;
        this._toast = null;
        this.pointerDown = false;
        this._pointerDownAt = 0;
        this.lastGesture = 0;
        this.maxSteps = MAX_STEPS;
        this.maxBytes = MAX_BYTES;
        this.stats = { captures: 0, lastSnapshotMs: 0, lastDiffMs: 0, lastRestoreMs: 0, lastCompile: null };
        this._customScopes = new Map(); // custom node name -> 'library' | 'project' (last seen)
        this.base = this.snapshot();
        this._install();
    }

    // ------------------------------------------------------------------
    // Snapshot / diff
    // ------------------------------------------------------------------

    _nodeJSON(node) {
        return JSON.stringify(stripVolatile(node.serialize(), node));
    }

    snapshot() {
        const t0 = performance.now();
        const g = this.graph;
        const prev = this.base;
        const nodes = new Map();
        for (const n of g.nodes) {
            let s;
            try { s = this._nodeJSON(n); } catch (e) { continue; }
            const old = prev && prev.nodes.get(n.id);
            nodes.set(n.id, old === s ? old : s);
        }
        const conns = new Set();
        for (const c of g.connections) {
            if (c && c.fromNode && c.toNode && nodes.has(c.fromNode.id) && nodes.has(c.toNode.id)) conns.add(connKey(c));
        }
        const groups = new Map();
        try {
            for (const rec of (g.groupCtl ? g.groupCtl.serializeGroups() : [])) {
                const s = JSON.stringify(rec);
                const id = String(rec.id);
                const old = prev && prev.groups.get(id);
                groups.set(id, old === s ? old : s);
            }
        } catch (e) { /* ignore */ }
        const custom = new Map();
        for (const [name, def] of Object.entries(NodeDefinitions)) {
            if (!def || !def.isCustomNode || typeof def.customGLSL !== 'string') continue;
            // Library vs project scope (src/core/customNodes.js) is remembered, not diffed:
            // "keep in my library" isn't an edit of the node
            this._customScopes.set(name, def.customScope || 'library');
            const s = JSON.stringify({ glsl: def.customGLSL });
            const old = prev && prev.custom.get(name);
            custom.set(name, old === s ? old : s);
        }
        this.stats.lastSnapshotMs = performance.now() - t0;
        return { nodes, conns, groups, custom, nextNodeId: g.nextNodeId };
    }

    diff(a, b) {
        const t0 = performance.now();
        const mapDiff = (ma, mb) => {
            const out = new Map();
            for (const [k, s] of mb) { const o = ma.get(k); if (o !== s) out.set(k, [o === undefined ? null : o, s]); }
            for (const [k, s] of ma) if (!mb.has(k)) out.set(k, [s, null]);
            return out;
        };
        const d = {
            nodes: mapDiff(a.nodes, b.nodes),
            groups: mapDiff(a.groups, b.groups),
            custom: mapDiff(a.custom, b.custom),
            connsAdded: new Set(),
            connsRemoved: new Set(),
        };
        for (const k of b.conns) if (!a.conns.has(k)) d.connsAdded.add(k);
        for (const k of a.conns) if (!b.conns.has(k)) d.connsRemoved.add(k);
        this.stats.lastDiffMs = performance.now() - t0;
        return d;
    }

    _isEmpty(d) {
        return !d.nodes.size && !d.groups.size && !d.custom.size && !d.connsAdded.size && !d.connsRemoved.size;
    }

    /** Only JS outputs (set by the running code) changed: not a user edit. */
    _isPassive(d) {
        if (d.groups.size || d.custom.size || d.connsAdded.size || d.connsRemoved.size) return false;
        for (const [, [b, a]] of d.nodes) {
            if (!b || !a || withoutPassive(b) !== withoutPassive(a)) return false;
        }
        return true;
    }

    _bytes(step) {
        let n = 200;
        for (const p of step.nodes.values()) n += bytesOfPair(p);
        for (const p of step.groups.values()) n += bytesOfPair(p);
        for (const p of step.custom.values()) n += bytesOfPair(p);
        for (const k of step.connsAdded) n += k.length + ENTRY_OVERHEAD;
        for (const k of step.connsRemoved) n += k.length + ENTRY_OVERHEAD;
        return n;
    }

    memoryBytes() {
        let n = 0;
        for (const s of this.undoStack) n += s.bytes;
        for (const s of this.redoStack) n += s.bytes;
        return n;
    }

    // ------------------------------------------------------------------
    // Capture
    // ------------------------------------------------------------------

    /** Label for the next capture (paste, cut, duplicate...): later hints win. */
    hint(label) {
        this._hint = { label, time: Date.now() };
    }

    /**
     * A user-visible change happened (or may have): capture after `delay` ms.
     * debounce: typing / input events push the capture back; otherwise an earlier
     * pending capture (pointer up) is kept.
     */
    schedule(delay = DEBOUNCE_MS, opts = {}) {
        if (this._restoring || this.batchDepth > 0) return;
        this._pendingOpts = { sealed: !!(opts.sealed || (this._pendingOpts && this._pendingOpts.sealed)) };
        const due = performance.now() + delay;
        if (this._timer && !opts.debounce && this._due <= due) return;
        clearTimeout(this._timer);
        this._due = due;
        this._timer = setTimeout(() => this._timerFired(), delay);
    }

    _timerFired() {
        this._timer = null;
        // Mid-drag: the step is taken when the pointer is released
        if (this.pointerDown && performance.now() - this._pointerDownAt < 60000) return;
        const opts = this._pendingOpts || {};
        this._pendingOpts = null;
        this.capture(opts);
    }

    /** Commit pending changes now (before an undo, a batch, a new gesture). */
    flush(opts = {}) {
        if (this._restoring || this.batchDepth > 0) return null;
        if (this._timer || this._pendingOpts) {
            clearTimeout(this._timer);
            this._timer = null;
            const o = { ...(this._pendingOpts || {}), ...opts };
            this._pendingOpts = null;
            return this.capture(o);
        }
        // Nothing gestured since the last capture: whatever changed meanwhile happened on its
        // own (MIDI, auto mode, a load) and is absorbed without a step
        return this.capture({ ...opts, silent: !opts.force });
    }

    /**
     * Diff the live graph against the base and record a step.
     * opts: label, sealed (no later merge), mergeable (default true), silent (absorb).
     */
    capture({ label = null, sealed = false, mergeable = true, silent = false } = {}) {
        if (this._restoring) return null;
        this._reconcileGroups(!silent);
        const snap = this.snapshot();
        const d = this.diff(this.base, snap);
        this.base = snap;
        if (this._isEmpty(d)) return null;
        if (silent || this._isPassive(d)) return null;
        this.stats.captures++;
        const now = Date.now();
        const hint = this._hint && now - this._hint.time < GESTURE_MS + DEBOUNCE_MS ? this._hint.label : null;
        this._hint = null;

        const key = mergeable && !label ? this._mergeKey(d) : null;
        const top = this.undoStack[this.undoStack.length - 1];
        if (key && top && !top.sealed && !this.redoStack.length && top.mergeKey === key && now - top.time < MERGE_MS) {
            this._mergeInto(top, d);
            top.time = now;
            if (sealed) top.sealed = true;
            top.bytes = this._bytes(top);
            if (this._isEmpty(top)) this.undoStack.pop();
            this._changed();
            return top;
        }

        const step = {
            ...d,
            label: label || hint || this._label(d),
            time: now,
            created: now,
            sealed: !!sealed || !mergeable,
            mergeKey: key,
            nextNodeId: snap.nextNodeId,
        };
        step.bytes = this._bytes(step);
        this.undoStack.push(step);
        this.redoStack = [];
        this._enforceCaps();
        this._changed();
        return step;
    }

    /**
     * Before a step is taken: let NodeGroups react to the cables removed since the last one
     * (an input unplugged inside an open group stays patched from outside), so the reaction is
     * part of the same step. convert false (absorbed changes): only its clean-up runs.
     */
    _reconcileGroups(convert) {
        const ctl = this.graph.groupCtl;
        if (!ctl || typeof ctl.reconcileInputs !== 'function' || !this.base) return;
        try {
            const now = new Set();
            for (const c of this.graph.connections) if (c && c.fromNode && c.toNode) now.add(connKey(c));
            const removed = [];
            for (const k of this.base.conns) {
                if (now.has(k)) continue;
                const j = JSON.parse(k);
                removed.push([j[0], j[1], j[2], j[3]]);
            }
            ctl.reconcileInputs(removed, { convert });
        } catch (e) { /* ignore */ }
    }

    /** Edits of the same node(s) data (typing, arrow keys on a slider) coalesce. */
    _mergeKey(d) {
        if (d.groups.size || d.custom.size || d.connsAdded.size || d.connsRemoved.size || !d.nodes.size) return null;
        const ids = [];
        for (const [id, [b, a]] of d.nodes) {
            if (!b || !a) return null;
            ids.push(id);
        }
        return 'd:' + ids.sort((x, y) => (x > y ? 1 : -1)).join(',');
    }

    _mergeInto(top, d) {
        const mergeMap = (into, from) => {
            for (const [k, [b, a]] of from) {
                const cur = into.get(k);
                if (cur) cur[1] = a;
                else into.set(k, [b, a]);
                const e = into.get(k);
                if (e[0] === e[1]) into.delete(k);
            }
        };
        mergeMap(top.nodes, d.nodes);
        mergeMap(top.groups, d.groups);
        mergeMap(top.custom, d.custom);
        for (const k of d.connsAdded) { if (top.connsRemoved.has(k)) top.connsRemoved.delete(k); else top.connsAdded.add(k); }
        for (const k of d.connsRemoved) { if (top.connsAdded.has(k)) top.connsAdded.delete(k); else top.connsRemoved.add(k); }
    }

    _enforceCaps() {
        while (this.undoStack.length > this.maxSteps) this.undoStack.shift();
        let total = this.memoryBytes();
        while (total > this.maxBytes && this.redoStack.length) total -= this.redoStack.shift().bytes;
        while (total > this.maxBytes && this.undoStack.length > 1) total -= this.undoStack.shift().bytes;
    }

    // ------------------------------------------------------------------
    // Batches, loads
    // ------------------------------------------------------------------

    /**
     * Make everything until endBatch() one step. label: step label (string), or
     * { label, prefix, load } - prefix is prepended to the derived label ("Claude: Add Noise"),
     * load: a project load is expected (it clears the history instead of being a step).
     */
    beginBatch(spec = null) {
        if (this.batchDepth === 0) {
            this.flush();
            const o = typeof spec === 'string' ? { label: spec } : (spec || {});
            this._batch = { label: o.label || null, prefix: o.prefix || null, load: !!o.load };
        }
        this.batchDepth++;
    }

    endBatch() {
        if (this.batchDepth === 0) return null;
        if (--this.batchDepth > 0) return null;
        const b = this._batch;
        this._batch = null;
        if (this._restoring) return null;
        const snap = this.snapshot();
        const d = this.diff(this.base, snap);
        if (this._isEmpty(d) || this._isPassive(d)) { this.base = snap; return null; }
        const derived = this._label(d);
        const label = b && b.label ? (b.prefix ? `${b.prefix}: ${b.label}` : b.label)
            : (b && b.prefix ? `${b.prefix}: ${derived}` : derived);
        return this.capture({ label, sealed: true, mergeable: false });
    }

    /**
     * A step made by code rather than a gesture (e.g. NodeGroups pruning unused group ports when
     * a group is closed). Pending edits are committed first, then fn() runs and its changes
     * become one sealed step. meta.undo / meta.redo restore what the snapshot does not hold
     * (transient UI state); with them the step is kept even when the document diff is empty.
     * Inside a batch or a restore, fn just runs.
     */
    record(label, fn, meta = null) {
        if (this._restoring || this.batchDepth > 0) return fn();
        this.flush({ sealed: true });
        const out = fn();
        const snap = this.snapshot();
        const d = this.diff(this.base, snap);
        this.base = snap;
        const hasMeta = !!(meta && (meta.undo || meta.redo));
        if (this._isEmpty(d) && !hasMeta) return out;
        const now = Date.now();
        const step = { ...d, label, time: now, created: now, sealed: true, mergeKey: null, nextNodeId: snap.nextNodeId };
        if (hasMeta) step.meta = meta;
        step.bytes = this._bytes(step);
        this.undoStack.push(step);
        this.redoStack = [];
        this._enforceCaps();
        this._changed();
        return out;
    }

    /** Run fn as one step. */
    batch(spec, fn) {
        this.beginBatch(spec);
        try { return fn(); } finally { this.endBatch(); }
    }

    /** Clear the history; the current graph becomes the base (project load / new project). */
    reset() {
        clearTimeout(this._timer);
        this._timer = null;
        this._pendingOpts = null;
        this._hint = null;
        this.undoStack = [];
        this.redoStack = [];
        this.base = null;
        this.base = this.snapshot();
        this._changed();
    }

    _afterLoad() {
        if (this._restoring) return;
        // Inside a batch that isn't a load (MCP build_graph clear=true): an ordinary edit
        if (this.batchDepth > 0 && !(this._batch && this._batch.load)) return;
        this.reset();
    }

    // ------------------------------------------------------------------
    // Hooks
    // ------------------------------------------------------------------

    _install() {
        const g = this.graph;
        const app = this.app;
        const self = this;

        // Programmatic changes right after a gesture (async dialogs, file readers...)
        const afterChange = () => {
            if (self._restoring || self.batchDepth > 0) return;
            if (self.pointerDown || Date.now() - self.lastGesture < GESTURE_MS) self.schedule(DEBOUNCE_MS);
        };
        for (const key of ['onGraphChanged', 'onUniformValueChanged']) {
            const orig = g[key];
            if (typeof orig !== 'function') continue;
            g[key] = function (...args) {
                const r = orig.apply(this, args);
                try { afterChange(); } catch (e) { /* ignore */ }
                return r;
            };
        }

        // Loads replace the document: clear the history
        const des = g.deserialize;
        g.deserialize = function (...args) {
            const r = des.apply(this, args);
            try { self._afterLoad(); } catch (e) { /* ignore */ }
            return r;
        };
        const origNew = app.createNewProject;
        if (typeof origNew === 'function') {
            app.createNewProject = function (...args) {
                const r = origNew.apply(this, args);
                try { self.reset(); } catch (e) { /* ignore */ }
                return r;
            };
        }

        // Gestures
        const gestureStart = () => {
            this.lastGesture = Date.now();
            if (this.batchDepth > 0 || this._restoring) return;
            this.flush();
        };
        window.addEventListener('pointerdown', (e) => {
            gestureStart();
            this.pointerDown = true;
            this._pointerDownAt = performance.now();
        }, true);
        const pointerEnd = () => {
            if (!this.pointerDown) return;
            this.pointerDown = false;
            this.lastGesture = Date.now();
            this.schedule(POINTER_UP_MS, { sealed: true });
        };
        window.addEventListener('pointerup', pointerEnd, true);
        window.addEventListener('pointercancel', pointerEnd, true);
        window.addEventListener('mouseup', pointerEnd, true);
        window.addEventListener('blur', pointerEnd);
        for (const type of ['drop', 'dragend']) {
            window.addEventListener(type, () => {
                this.lastGesture = Date.now();
                this.schedule(POINTER_UP_MS, { sealed: true });
            }, true);
        }
        window.addEventListener('keydown', (e) => this._onKeyDown(e, gestureStart), true);
        for (const type of ['input', 'change']) {
            window.addEventListener(type, () => {
                this.lastGesture = Date.now();
                this.schedule(DEBOUNCE_MS, { debounce: true });
            }, true);
        }
        window.addEventListener('focusout', (e) => {
            if (!isTypingElement(e.target) && !(e.target && e.target.tagName === 'INPUT')) return;
            this.lastGesture = Date.now();
            this.schedule(POINTER_UP_MS, { sealed: true });
        }, true);
    }

    _onKeyDown(e, gestureStart) {
        const k = (e.key || '').toLowerCase();
        const mod = e.metaKey || e.ctrlKey;
        const isUndo = mod && !e.altKey && !e.shiftKey && k === 'z';
        const isRedo = mod && !e.altKey && ((e.shiftKey && k === 'z') || (e.ctrlKey && !e.metaKey && !e.shiftKey && k === 'y'));
        if ((isUndo || isRedo) && !isTypingElement(e.target) && !isTypingElement(document.activeElement)) {
            const g = this.graph;
            if (document.querySelector('.pt-modal-backdrop')) return;
            e.preventDefault();
            e.stopPropagation();
            if (g.connectingFrom || g.draggedNode || g.resizingNode || this.pointerDown) return;
            // A focused canvas field: commit it first
            if (g.focusedTextInput) {
                try { g.focusedTextInput.blur(); } catch (err) { /* ignore */ }
                g.focusedTextInput = null;
                g.focusedNode = null;
            }
            if (isUndo) this.undo(); else this.redo();
            return;
        }
        if (e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') return;
        gestureStart();
        this.schedule(DEBOUNCE_MS, { debounce: true });
    }

    // ------------------------------------------------------------------
    // Undo / redo
    // ------------------------------------------------------------------

    canUndo() { this._flushIfPending(); return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
    peekUndo() { const s = this.undoStack[this.undoStack.length - 1]; return s ? s.label : null; }
    peekRedo() { const s = this.redoStack[this.redoStack.length - 1]; return s ? s.label : null; }

    _flushIfPending() {
        if ((this._timer || this._pendingOpts) && !this.pointerDown) this.flush();
    }

    undo({ toast = true } = {}) {
        if (this.batchDepth > 0 || this._restoring) return null;
        this.flush({ sealed: true, force: false });
        const step = this.undoStack.pop();
        if (!step) {
            if (toast) this._showToast('Nothing to undo');
            return null;
        }
        this._applyStep(step, 'undo');
        this.redoStack.push(step);
        // The step below can't absorb later edits while there is something to redo
        const below = this.undoStack[this.undoStack.length - 1];
        if (below) below.sealed = true;
        if (toast) this._showToast(`Undo: ${step.label}`);
        this._emit('undo', step.label);
        return step.label;
    }

    redo({ toast = true } = {}) {
        if (this.batchDepth > 0 || this._restoring) return null;
        this.flush({ sealed: true });
        // A new edit since the last undo dropped the redo steps (capture clears them)
        const step = this.redoStack.pop();
        if (!step) {
            if (toast) this._showToast('Nothing to redo');
            return null;
        }
        this._applyStep(step, 'redo');
        step.sealed = true;
        this.undoStack.push(step);
        if (toast) this._showToast(`Redo: ${step.label}`);
        this._emit('redo', step.label);
        return step.label;
    }

    /** Summary for MCP / UI: labels newest first. */
    list() {
        return {
            undo: this.undoStack.map(s => s.label).reverse(),
            redo: this.redoStack.map(s => s.label).reverse(),
            steps: this.undoStack.length + this.redoStack.length,
            memory_bytes: this.memoryBytes(),
            max_steps: this.maxSteps,
            max_bytes: this.maxBytes,
        };
    }

    _target(step, dir) {
        const pick = (p) => (dir === 'undo' ? p[0] : p[1]);
        const base = this.base;
        const t = {
            nodes: new Map(base.nodes),
            groups: new Map(base.groups),
            custom: new Map(base.custom),
            conns: new Set(base.conns),
            nextNodeId: base.nextNodeId,
        };
        const setAll = (map, entries) => {
            for (const [k, p] of entries) {
                const v = pick(p);
                if (v === null) map.delete(k); else map.set(k, v);
            }
        };
        // Nodes that exist on both sides: only the fields the step changed are restored,
        // so later changes to other fields (a MIDI-driven Param value under an undone
        // mapping edit, control-rate state...) survive
        for (const [id, p] of step.nodes) {
            const v = pick(p);
            const from = dir === 'undo' ? p[1] : p[0];
            if (v === null) { t.nodes.delete(id); continue; }
            const cur = t.nodes.get(id);
            t.nodes.set(id, cur !== undefined && from !== null ? this._patchNode(cur, from, v) : v);
        }
        setAll(t.groups, step.groups);
        setAll(t.custom, step.custom);
        const add = dir === 'undo' ? step.connsRemoved : step.connsAdded;
        const rem = dir === 'undo' ? step.connsAdded : step.connsRemoved;
        for (const k of rem) t.conns.delete(k);
        for (const k of add) t.conns.add(k);
        return t;
    }

    /**
     * cur (live JSON) with the top-level fields and data keys that differ between
     * `from` and `to` taken from `to`. Key order of cur is kept.
     */
    _patchNode(cur, from, to) {
        if (cur === from) return to;
        let c, f, t;
        try { c = JSON.parse(cur); f = JSON.parse(from); t = JSON.parse(to); } catch (e) { return to; }
        if (c.type !== t.type) return to;
        const apply = (into, a, b) => {
            for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
                if (k === 'data' || sameJSON(a[k], b[k])) continue;
                if (b[k] === undefined) delete into[k]; else into[k] = b[k];
            }
        };
        apply(c, f, t);
        const fd = f.data || {}, td = t.data || {};
        if (!c.data || typeof c.data !== 'object') c.data = {};
        apply(c.data, fd, td);
        // apply() skips the 'data' key itself: data keys are patched one by one above
        for (const k of new Set([...Object.keys(fd), ...Object.keys(td)])) {
            if (k !== 'data' || sameJSON(fd[k], td[k])) continue;
            if (td[k] === undefined) delete c.data[k]; else c.data[k] = td[k];
        }
        const out = JSON.stringify(c);
        return out === cur ? cur : out;
    }

    _applyStep(step, dir) {
        const t0 = performance.now();
        step.sealed = true;
        const target = this._target(step, dir);
        const d = this.diff(this.base, target);
        const res = this._restore(target, d);
        this.base = this.snapshot();
        // Transient state the step carries (History.record)
        if (step.meta && typeof step.meta[dir] === 'function') {
            try { step.meta[dir](); } catch (e) { console.warn('History: step hook failed', e); }
        }
        this._afterRestore(res, step, dir);
        this.stats.lastRestoreMs = performance.now() - t0;
        this._changed();
    }

    // ------------------------------------------------------------------
    // Restore (in place)
    // ------------------------------------------------------------------

    _restore(target, d) {
        const g = this.graph;
        const app = this.app;
        const ctl = g.groupCtl;
        const res = { compile: false, uniforms: false, params: false, scenes: false, structural: false, affected: new Set(), groups: new Set(), created: [] };
        this._restoring = true;
        try {
            // End interactions that hold references to nodes / text inputs
            if (g.focusedTextInput) {
                try { g.focusedTextInput.blur(); } catch (e) { /* ignore */ }
                g.focusedTextInput = null;
                g.focusedNode = null;
            }
            g.draggingTextInput = null;
            g.potentialTextInputFocus = null;
            try { ctl && ctl.ui && ctl.ui.cancelRename && ctl.ui.cancelRename(); } catch (e) { /* ignore */ }
            const scopeChain = ctl && ctl.scope !== null ? ctl.chainOf(ctl.scope).slice() : [];

            // 1. Custom node definitions that (re)appear first, so their nodes can be created
            for (const [name, [, a]] of d.custom) {
                if (a === null) continue;
                try {
                    const def = JSON.parse(a);
                    // Same scope as before: a project's node never lands in the user's library
                    const scope = (NodeDefinitions[name] && NodeDefinitions[name].customScope) || this._customScopes.get(name) || 'library';
                    const r = app.createCustomNode ? app.createCustomNode(name, def.glsl, scope === 'project', { scope, silent: true }) : null;
                    if (!r || !r.success) console.warn(`[history] could not restore custom node ${name}`);
                } catch (e) { console.warn('[history] custom node restore failed', e); }
                res.compile = true;
            }

            // 2. Nodes
            const byId = new Map(g.nodes.map(n => [n.id, n]));
            const toRemove = [];
            const toCreate = [];
            const forLoops = new Set();
            for (const [id, [b, a]] of d.nodes) {
                const live = byId.get(id);
                if (a === null) {
                    if (live) toRemove.push(live);
                    continue;
                }
                let t;
                try { t = JSON.parse(a); } catch (e) { continue; }
                if (!live) { toCreate.push(t); continue; }
                if (live.type !== t.type) { toRemove.push(live); toCreate.push(t); continue; }
                let l;
                try { l = b ? JSON.parse(b) : stripVolatile(live.serialize(), live); } catch (e) { l = stripVolatile(live.serialize(), live); }
                this._applyInPlace(live, t, l, res);
                if (live.isForLoopStartNode || live.isForLoopEndNode) forLoops.add(live);
                res.affected.add(id);
            }
            if (toRemove.length) {
                this._removeNodes(toRemove);
                res.compile = true;
                res.structural = true;
            }
            for (const t of toCreate) {
                const n = this._createNode(t);
                if (!n) continue;
                res.created.push(n);
                res.structural = true;
                res.affected.add(n.id);
                if (n.isForLoopStartNode || n.isForLoopEndNode) forLoops.add(n);
                if (n.isParamNode) res.params = true;
                if (n.isSceneSwitcher) res.scenes = true;
                res.compile = true;
            }
            // ForLoop pairs: Start is authoritative, End reads it
            for (const n of forLoops) if (n.isForLoopStartNode) { try { n.updatePorts && n.updatePorts(); } catch (e) { /* ignore */ } }
            for (const n of forLoops) if (n.isForLoopEndNode) { try { n.updatePorts && n.updatePorts(); } catch (e) { /* ignore */ } }

            // 3. Connections: reconcile the whole set (node updates may have dropped cables)
            if (this._restoreConnections(target, d, res)) res.compile = true;

            // 4. Groups (view metadata: no recompile)
            if (d.groups.size) this._restoreGroups(target, d, res, scopeChain);

            // 5. Custom definitions that disappear (after their nodes are gone)
            for (const [name, [, a]] of d.custom) {
                if (a !== null) continue;
                if (g.nodes.some(n => n.type === name)) continue;
                const def = NodeDefinitions[name];
                const scope = (def && def.customScope) || this._customScopes.get(name) || 'library';
                if (scope === 'library' && typeof app.deleteCustomNode === 'function') app.deleteCustomNode(name);
                else delete NodeDefinitions[name];
                res.compile = true;
            }
            if (d.custom.size) {
                try { app.saveCustomNodes && app.saveCustomNodes(); } catch (e) { /* ignore */ }
                try { app.shell && app.shell.library && app.shell.library.refresh(); } catch (e) { /* ignore */ }
            }

            // Never hand out an id twice (MCP agents keep ids)
            let maxId = -1;
            for (const n of g.nodes) if (typeof n.id === 'number' && n.id > maxId) maxId = n.id;
            g.nextNodeId = Math.max(g.nextNodeId || 0, target.nextNodeId || 0, maxId + 1);

            g.updateDeviceButtonStates && g.updateDeviceButtonStates();
            if (ctl) { ctl.invalidate(); ctl.touch(); }
        } finally {
            this._restoring = false;
        }
        return res;
    }

    _applyInPlace(node, t, l, res) {
        const g = this.graph;
        if (node.x !== t.x || node.y !== t.y) { node.x = t.x; node.y = t.y; }
        if (node.isPreviewNode) {
            if (t.width !== undefined && (node.width !== t.width || node.height !== t.height)) {
                node.width = t.width;
                node.height = t.height;
                try { node.resizeCanvas && node.resizeCanvas(); } catch (e) { /* ignore */ }
            }
            const wantBg = !!t.isBackground;
            const isBg = !!(g.backgroundRenderer && g.backgroundRenderer.isActive && g.backgroundRenderer.isActive(node));
            if (wantBg !== isBg && g.onPreviewBackground) g.onPreviewBackground(node);
        }
        const td = t.data || {};
        const ld = l.data || {};
        if (sameJSON(td, ld)) {
            if (node.textInputs && node.updateTextInputPositions) { try { node.updateTextInputPositions(); } catch (e) { /* ignore */ } }
            return;
        }
        const changed = [...new Set([...Object.keys(td), ...Object.keys(ld)])].filter(k => !sameJSON(td[k], ld[k]));
        const data = JSON.parse(JSON.stringify(td));
        for (const k of VOLATILE_DATA(node)) if (node.data && k in node.data) data[k] = node.data[k];

        // Param value only: push the uniform (no recompile), like dragging the control
        if (node.isParamNode && changed.every(k => k === 'value') && typeof node.setValue === 'function') {
            node.setValue(data.value, { commit: false });
            res.params = true;
            res.uniforms = true;
            return;
        }
        // Uniform-mode constants: new value straight into the uniform registry
        if (node.hasUniformToggle && ld.useUniform && td.useUniform && changed.every(k => typeof td[k] === 'number' && k !== 'useUniform')) {
            node.data = data;
            try { node.rebuildTextInputs && node.rebuildTextInputs(); } catch (e) { /* ignore */ }
            try { node.updateUniformRegistry && node.updateUniformRegistry(); } catch (e) { /* ignore */ }
            res.uniforms = true;
            return;
        }

        const portSig = () => node.inputs.map(p => `${p.name}:${p.type}`).join(',') + '|' + node.outputs.map(p => `${p.name}:${p.type}`).join(',');
        const before = portSig();
        const wasUniform = !!(node.data && node.data.useUniform);
        if (node.isJSNode) {
            const codeChanged = td.code !== ld.code || td.setupCode !== ld.setupCode;
            node.data = data;
            // New code is re-checked against the trust list (never trusted by undo itself)
            if (codeChanged) node.rebuildTextInputs();
            else {
                try { node.syncOutputsFromData && node.syncOutputsFromData(); } catch (e) { /* ignore */ }
                try { node.syncInputsFromCode && node.syncInputsFromCode({ silent: true }); } catch (e) { /* ignore */ }
            }
            if (!codeChanged && portSig() === before) return;
            res.compile = true;
            return;
        }
        node.data = data;
        try { node.rebuildTextInputs && node.rebuildTextInputs(); } catch (e) { console.warn('[history] rebuildTextInputs', e); }
        try { node.updateDimensions && node.updateDimensions(); } catch (e) { /* ignore */ }
        if (node.hasUniformToggle) {
            try {
                if (node.data.useUniform) node.updateUniformRegistry && node.updateUniformRegistry();
                else if (wasUniform) node.unregisterUniforms && node.unregisterUniforms();
            } catch (e) { /* ignore */ }
        }
        if (node.isCommentNode) {
            node._layout = null;
            return; // notes never compile
        }
        if (node.isParamNode) res.params = true;
        if (node.isSceneSwitcher) {
            res.scenes = true;
            // Runtime options (transition, timing, names...): no recompile unless the ports changed
            if (portSig() === before) {
                try { node.pushUniforms && node.pushUniforms(true); } catch (e) { /* ignore */ }
                return;
            }
        }
        res.compile = true;
    }

    _removeNodes(list) {
        const g = this.graph;
        const set = new Set(list);
        for (const n of list) {
            if (n.isPreviewNode) {
                if (g.backgroundRenderer && g.backgroundRenderer.isActive && g.backgroundRenderer.isActive(n) && g.onPreviewBackground) {
                    g.onPreviewBackground(n); // toggles it off
                }
                const r = g.previewNodes.get(n.id);
                if (r) { try { r.destroy(); } catch (e) { /* ignore */ } }
                g.previewNodes.delete(n.id);
            }
            try { n.cleanup && n.cleanup(); } catch (e) { /* ignore */ }
            g.selectionManager.selectedNodes.delete(n);
        }
        g.connections = g.connections.filter(c => !set.has(c.fromNode) && !set.has(c.toNode));
        g.nodes = g.nodes.filter(n => !set.has(n));
        if (g.groupCtl) g.groupCtl.onNodesDeleted(set);
    }

    _createNode(t) {
        const g = this.graph;
        let node;
        try {
            node = NodeFactory.deserializeNode(t, g.canvas, g.videoElement, g.sharedGL);
        } catch (e) {
            console.warn('[history] could not recreate node', t && t.type, e);
            return null;
        }
        if (!node) return null;
        node.graph = g;
        g.nodes.push(node);
        if (node.isPreviewNode) {
            g.previewNodes.set(node.id, node.renderer);
            if (t.isBackground) {
                node.isBackground = false;
                if (g.onPreviewBackground) g.onPreviewBackground(node);
            }
        }
        // Param ports follow the kind, Scene switcher ports the scenes (silent: no events)
        try { node.rebuildTextInputs && node.rebuildTextInputs(); } catch (e) { /* ignore */ }
        return node;
    }

    _restoreConnections(target, d, res) {
        const g = this.graph;
        const Conn = g.groupCtl && g.groupCtl.Connection;
        const byId = new Map(g.nodes.map(n => [n.id, n]));
        const live = new Map();
        const keep = [];
        let changed = false;
        for (const c of g.connections) {
            if (!c || !c.fromNode || !c.toNode || !byId.has(c.fromNode.id) || !byId.has(c.toNode.id)) { changed = true; continue; }
            const k = connKey(c);
            if (!target.conns.has(k) || live.has(k)) {
                changed = true;
                res.affected.add(c.toNode.id);
                continue;
            }
            live.set(k, c);
            keep.push(c);
        }
        const toAdd = [];
        for (const k of target.conns) if (!live.has(k)) toAdd.push(JSON.parse(k));
        // Blend: enough dynamic inputs for the restored cables (like NodeGraph.deserialize)
        for (const [, , toId, toInput] of toAdd) {
            const n = byId.get(toId);
            if (n && n.isDynamicInput && n.type === 'Blend' && typeof n.addDynamicInput === 'function') {
                let guard = 64;
                while (n.inputs.filter(i => i.name !== 'index' && /^\d+$/.test(i.name)).length <= toInput && guard-- > 0) n.addDynamicInput();
            }
        }
        for (const [fromId, fromOutput, toId, toInput, acc] of toAdd) {
            const from = byId.get(fromId);
            const to = byId.get(toId);
            if (!from || !to || !Conn) continue;
            keep.push(new Conn(from, fromOutput, to, toInput, acc || null));
            res.affected.add(toId);
            changed = true;
        }
        if (changed || keep.length !== g.connections.length) g.connections = keep;
        // Cable sets that changed for reasons other than this step (side effects) still count
        return changed || d.connsAdded.size > 0 || d.connsRemoved.size > 0;
    }

    _restoreGroups(target, d, res, scopeChain) {
        const g = this.graph;
        const ctl = g.groupCtl;
        if (!ctl) return;
        const fromRec = (s) => {
            const r = JSON.parse(s);
            const grp = {
                id: r.id,
                name: r.name || 'Group',
                parentId: r.parentId === undefined || r.parentId === null ? null : r.parentId,
                nodeIds: Array.isArray(r.nodeIds) ? r.nodeIds.slice() : [],
                x: Number(r.x) || 0,
                y: Number(r.y) || 0,
            };
            if (r.color) grp.color = r.color;
            if (r.collapsed) grp.collapsed = true;
            if (r.exposed) {
                grp.exposed = {
                    inputs: (r.exposed.inputs || []).map(e => ({ node: e.node, port: e.port })),
                    outputs: (r.exposed.outputs || []).map(e => ({ node: e.node, port: e.port })),
                };
            }
            // Box port names (NodeGroups portLabels)
            if (r.portLabels && typeof r.portLabels === 'object') grp.portLabels = { ...r.portLabels };
            // Inputs patched from outside that feed nothing inside (NodeGroups virtualInputs)
            if (Array.isArray(r.virtualInputs)) grp.virtualInputs = r.virtualInputs.map(v => ({ node: v.node, port: v.port }));
            return grp;
        };
        const out = [];
        const seen = new Set();
        for (const grp of g.groups) {
            const id = String(grp.id);
            const s = target.groups.get(id);
            if (s === undefined) continue;
            seen.add(id);
            out.push(d.groups.has(id) ? fromRec(s) : grp);
        }
        for (const [id, s] of target.groups) if (!seen.has(id)) out.push(fromRec(s));
        for (const id of d.groups.keys()) if (target.groups.has(id)) res.groups.add(id);
        g.groups = out;
        ctl.invalidate();
        ctl.touch();
        // Keep the open group if it still exists, else its closest surviving ancestor
        if (ctl.scope !== null && !ctl.getGroup(ctl.scope)) {
            const keepScope = scopeChain.find(gid => ctl.getGroup(gid)) ?? null;
            ctl.setScope(keepScope, { select: false, animate: false });
        }
        try { ctl.ui && ctl.ui.update && ctl.ui.update(); } catch (e) { /* ignore */ }
    }

    _afterRestore(res, step, dir) {
        const g = this.graph;
        const app = this.app;
        this._restoring = true;
        try {
            if (res.compile) {
                // The app's own graph-change path: dirty flag, autosave, feedback + preview compile
                if (g.onGraphChanged) g.onGraphChanged();
            } else {
                try { app.projectManager && app.projectManager.markDirty(); } catch (e) { /* ignore */ }
            }
        } finally {
            this._restoring = false;
        }
        this.stats.lastCompile = !!res.compile;
        const fire = (type) => { try { window.dispatchEvent(new CustomEvent(type, { detail: { id: null, what: 'meta' } })); } catch (e) { /* ignore */ } };
        if (res.params || res.structural) fire('patchtoy:param');
        if (res.scenes) fire('patchtoy:scene');

        this._selectAffected(res, step);
        g.render();
        try { app.shell && app.shell.syncNow && app.shell.syncNow(); } catch (e) { /* ignore */ }
    }

    /** Select what the step touched (visible in the open group) and bring it into view if needed. */
    _selectAffected(res, step) {
        const g = this.graph;
        const ctl = g.groupCtl;
        const sel = g.selectionManager.selectedNodes;
        sel.clear();
        const byId = new Map(g.nodes.map(n => [n.id, n]));
        const items = new Set();
        const visibleItem = (node) => {
            if (!ctl || ctl.isVisible(node)) return node;
            let gid = ctl.groupOf(node.id);
            let guard = 64;
            while (gid != null && guard-- > 0) {
                if (ctl.parentOf(gid) === ctl.scope) return ctl.proxyFor(gid);
                gid = ctl.parentOf(gid);
            }
            return null;
        };
        for (const id of res.affected) {
            const n = byId.get(id);
            if (!n) continue;
            const it = visibleItem(n);
            if (it) items.add(it);
        }
        if (ctl) {
            for (const gid of res.groups) {
                if (!ctl.getGroup(gid)) continue;
                if (ctl.parentOf(gid) === ctl.scope) { const p = ctl.proxyFor(gid); if (p) items.add(p); }
            }
        }
        for (const it of items) sel.add(it);
        if (!items.size) return;

        // Only move the camera when none of it is on screen
        const rect = g.canvas.getBoundingClientRect();
        const W = rect.width || g.canvas.clientWidth || 800;
        const H = rect.height || g.canvas.clientHeight || 600;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        let anyVisible = false;
        for (const it of items) {
            const w = it.width || 120, h = it.height || 60;
            const sx0 = it.x * g.zoom + g.panX, sy0 = it.y * g.zoom + g.panY;
            const sx1 = (it.x + w) * g.zoom + g.panX, sy1 = (it.y + h) * g.zoom + g.panY;
            if (sx1 > 0 && sy1 > 0 && sx0 < W && sy0 < H) anyVisible = true;
            x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y);
            x1 = Math.max(x1, it.x + w); y1 = Math.max(y1, it.y + h);
        }
        if (anyVisible || !Number.isFinite(x0)) return;
        g.panX = W / 2 - ((x0 + x1) / 2) * g.zoom;
        g.panY = H / 2 - ((y0 + y1) / 2) * g.zoom;
    }

    // ------------------------------------------------------------------
    // Labels
    // ------------------------------------------------------------------

    _title(id, json) {
        const n = this.graph.nodes.find(x => x.id === id);
        try {
            if (n) {
                if (n.isCommentNode) return 'note';
                return n.getDisplayTitle ? n.getDisplayTitle() : n.type;
            }
            const j = json ? JSON.parse(json) : null;
            if (j) {
                const def = NodeDefinitions[j.type];
                if (def && def.isCommentNode) return 'note';
                if (j.type === 'Param' || (def && def.isParamNode)) return (j.data && j.data.label) || 'Param';
                return (def && def.displayTitle) || j.type;
            }
        } catch (e) { /* ignore */ }
        return `node ${id}`;
    }

    _label(d) {
        const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
        // Custom GLSL nodes
        if (d.custom.size) {
            const [name, [b, a]] = d.custom.entries().next().value;
            const many = d.custom.size > 1 ? ` (+${d.custom.size - 1})` : '';
            if (!b) return `Create custom node ${name}${many}`;
            if (!a) return `Delete custom node ${name}${many}`;
            return `Update custom node ${name}${many}`;
        }
        const added = [], removed = [], moved = [], resized = [], edited = [];
        for (const [id, [b, a]] of d.nodes) {
            if (!b) { added.push([id, a]); continue; }
            if (!a) { removed.push([id, b]); continue; }
            let jb, ja;
            try { jb = JSON.parse(b); ja = JSON.parse(a); } catch (e) { edited.push([id, a]); continue; }
            const posOnly = sameJSON(jb.data, ja.data) && jb.type === ja.type;
            if (posOnly && (jb.width !== ja.width || jb.height !== ja.height)) resized.push([id, a]);
            else if (posOnly) moved.push([id, a]);
            else {
                const ks = [...new Set([...Object.keys(jb.data || {}), ...Object.keys(ja.data || {})])].filter(k => !sameJSON((jb.data || {})[k], (ja.data || {})[k]));
                if (ks.length && ks.every(k => k === 'width' || k === 'height') && jb.x === ja.x && jb.y === ja.y) resized.push([id, a]);
                else edited.push([id, a, ks, jb, ja]);
            }
        }
        // Groups
        if (d.groups.size) {
            let gAdd = 0, gDel = 0, gName = null, gMove = 0, gExp = 0, gVirt = 0, gPorts = 0, gOther = 0;
            for (const [, [b, a]] of d.groups) {
                if (!b) { gAdd++; continue; }
                if (!a) { gDel++; continue; }
                const jb = JSON.parse(b), ja = JSON.parse(a);
                if (jb.name !== ja.name) gName = ja.name;
                else if (jb.x !== ja.x || jb.y !== ja.y) gMove++;
                else if (!sameJSON(jb.exposed, ja.exposed)) gExp++;
                else if (!sameJSON(jb.virtualInputs, ja.virtualInputs)) gVirt++;
                else if (!sameJSON(jb.portLabels, ja.portLabels)) gPorts++;
                else gOther++;
            }
            if (gAdd && !gDel) return gAdd === 1 ? 'Group' : `Group (${gAdd} groups)`;
            if (gDel && !gAdd) return removed.length ? `Delete ${plural(gDel, 'group')}` : (gDel === 1 ? 'Ungroup' : `Ungroup ${gDel} groups`);
            if (gName !== null && !added.length && !removed.length) return `Rename group “${gName}”`;
            if (gExp && !added.length && !removed.length) return 'Change exposed ports';
            if (gVirt && !added.length && !removed.length && !d.connsAdded.size && !d.connsRemoved.size) return 'Change group inputs';
            if (gPorts && !added.length && !removed.length && !edited.length) return gPorts === 1 ? 'Rename group ports' : `Rename ports of ${gPorts} groups`;
            if (gMove && !added.length && !removed.length && !edited.length) {
                return gMove + moved.length === 1 ? 'Move group' : `Move ${plural(gMove + moved.length, 'item')}`;
            }
            if (!added.length && !removed.length && !edited.length && !d.connsAdded.size && !d.connsRemoved.size) {
                return moved.length ? `Move ${plural(moved.length, 'node')} between groups` : 'Edit groups';
            }
        }
        if (added.length && !removed.length) {
            return added.length === 1 ? `Add ${this._title(added[0][0], added[0][1])}` : `Add ${plural(added.length, 'node')}`;
        }
        if (removed.length && !added.length) {
            return removed.length === 1 ? `Delete ${this._title(removed[0][0], removed[0][1])}` : `Delete ${plural(removed.length, 'node')}`;
        }
        if (removed.length && added.length) return `Replace ${plural(removed.length, 'node')}`;
        if (edited.length) {
            if (edited.length > 1) return `Edit ${plural(edited.length, 'node')}`;
            const [id, a, ks, jb, ja] = edited[0];
            const t = this._title(id, a);
            const def = NodeDefinitions[ja.type] || {};
            if (def.isCommentNode) return ks.every(k => k === 'width' || k === 'height') ? 'Resize note' : 'Edit note';
            if (def.isParamNode) {
                if (ks.length === 1 && ks[0] === 'value') return `Change ${t}`;
                if (ks.length === 1 && ks[0] === 'midi') return `MIDI mapping (${t})`;
                if (ks.includes('kind')) return `Change ${t} kind`;
                if (ks.includes('label')) return `Rename param “${t}”`;
                return `Edit param ${t}`;
            }
            if (def.isSceneSwitcher) return ks.includes('scenes') ? 'Edit scenes' : 'Edit scene switcher';
            if (def.isJSNode && (ks.includes('code') || ks.includes('setupCode'))) return `Edit JS code (${t})`;
            if (def.hasColorPicker || (ks.length && ks.every(k => k === 'r' || k === 'g' || k === 'b'))) return `Pick color (${t})`;
            if (ks.length === 1 && ks[0] === 'useUniform') return `Toggle uniform (${t})`;
            if (ks.length === 1) return `Edit ${t} ${ks[0]}`;
            return `Edit ${t}`;
        }
        const ca = d.connsAdded.size, cr = d.connsRemoved.size;
        if (ca || cr) {
            const parse = (k) => JSON.parse(k);
            const desc = (c) => {
                const [fromId, fo, toId, ti] = c;
                const to = this.graph.nodes.find(n => n.id === toId);
                const from = this.graph.nodes.find(n => n.id === fromId);
                const inName = to && to.inputs[ti] ? to.inputs[ti].name : ti;
                return `${from ? this._title(fromId) : fromId} → ${to ? this._title(toId) : toId}${inName !== '' ? '.' + inName : ''}`;
            };
            if (ca === 1 && cr === 1) {
                const A = parse([...d.connsAdded][0]), R = parse([...d.connsRemoved][0]);
                if (A[0] === R[0] && A[1] === R[1] && A[2] === R[2] && A[3] === R[3]) return A[4] ? `Accessor ${A[4]} (${desc(A)})` : `Remove accessor (${desc(A)})`;
                if (A[2] === R[2] && A[3] === R[3]) return `Reconnect ${desc(A)}`;
                return 'Move cable';
            }
            if (ca === 1 && !cr) return `Connect ${desc(parse([...d.connsAdded][0]))}`;
            if (cr === 1 && !ca) return `Disconnect ${desc(parse([...d.connsRemoved][0]))}`;
            return `Change ${plural(ca + cr, 'connection')}`;
        }
        if (resized.length) return resized.length === 1 ? `Resize ${this._title(resized[0][0], resized[0][1])}` : `Resize ${plural(resized.length, 'node')}`;
        if (moved.length) return moved.length === 1 ? `Move ${this._title(moved[0][0], moved[0][1])}` : `Move ${plural(moved.length, 'node')}`;
        return 'Edit';
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------

    _showToast(text) {
        try {
            if (this._toast) this._toast.dismiss();
            this._toast = UIHelpers.toast(text, 'info', { duration: 1800 });
        } catch (e) { /* ignore */ }
    }

    _emit(action, label) {
        try {
            window.dispatchEvent(new CustomEvent('patchtoy:history', {
                detail: { action, label, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 }
            }));
        } catch (e) { /* ignore */ }
    }

    _changed() {
        this._emit('change', null);
    }
}
