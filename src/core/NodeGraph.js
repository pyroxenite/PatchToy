import { Node } from "../nodes/Node.js";
import { NodeDefinitions } from './NodeDefinitions.js';
import { PreviewNode as PreviewNodeClass } from '../nodes/PreviewNode.js';
import { QuickNodeSearch } from '../ui/QuickNodeSearch.js';
import { SelectionManager } from '../graph/SelectionManager.js';
import { NodeFactory } from '../graph/NodeFactory.js';
import { GraphRenderer } from '../graph/GraphRenderer.js';
import { TypeRegistry } from './TypeRegistry.js';
import { NodeGroups } from '../graph/NodeGroups.js'; // node groups (subgraphs): view/organization metadata
import { connectionRateError } from './control/rates.js'; // control vs pixel rate rules
import { typesCompatible } from '../rendering/NodePainter.js';
import { UIHelpers } from '../ui/UIHelpers.js';
import { TYPE_COLORS, typeColor } from '../ui/theme.js';
import { programCache } from '../rendering/glResources.js'; // shared GL programs (freed on project switch)
import { resetProjectRuntime } from './simulation.js'; // per-project runtime state (registry, control plan, ...)

const CONTROL_ONLY = new Set(['event', 'string', 'list']);

// Re-export Node for backwards compatibility
export { Node };

// Static deserialize helper for nodes - now uses NodeFactory
function deserializeNode(json, canvas, videoElement, sharedGL = null) {
    return NodeFactory.deserializeNode(json, canvas, videoElement, sharedGL);
}

export class Connection {
    constructor(fromNode, fromOutput, toNode, toInput, accessor = null) {
        this.fromNode = fromNode;
        this.fromOutput = fromOutput;
        this.toNode = toNode;
        this.toInput = toInput;
        // Accessor can be:
        // - null (full value)
        // - ".x", ".xy", ".rgb" (swizzle only)
        // - ".position" (struct member)
        // - ".position.xy" (struct member + swizzle)
        this.accessor = accessor;

        // For backwards compatibility
        this.swizzle = accessor;
    }

    /**
     * Get the output type after applying accessor
     */
    getOutputType() {
        if (!this.fromNode || !this.fromNode.outputs || !this.fromNode.outputs[this.fromOutput]) {
            return null;
        }

        // Use resolvedOutputType if available (for dynamic nodes like Blend)
        const baseType = this.fromNode.resolvedOutputType || this.fromNode.outputs[this.fromOutput].type;

        if (!this.accessor) {
            return baseType;
        }

        try {
            return TypeRegistry.resolveAccessorType(baseType, this.accessor);
        } catch (e) {
            console.error('Error resolving accessor type:', e);
            return null;
        }
    }

    /**
     * Validate that this connection's types are compatible
     */
    isValid() {
        const outputType = this.getOutputType();
        if (!outputType) return false;

        if (!this.toNode || !this.toNode.inputs || !this.toNode.inputs[this.toInput]) {
            return false;
        }

        const inputType = this.toNode.inputs[this.toInput].type;
        this.rateError = null;

        // Control-only values (event / string / list) and signal rates (src/core/control/rates.js)
        if ((CONTROL_ONLY.has(outputType) || CONTROL_ONLY.has(inputType)) && !typesCompatible(outputType, inputType)) {
            this.rateError = `A ${outputType} output cannot connect to a ${inputType} input`;
            return false;
        }
        const rateError = connectionRateError(this.toNode.graph, this.fromNode, this.fromOutput, this.toNode, this.toInput, this.accessor);
        if (rateError) {
            this.rateError = rateError.message;
            return false;
        }

        // If input is 'any' type, defer validation to the node itself
        if (TypeRegistry.isAny(inputType)) {
            // For now, accept the connection - actual validation happens during compilation
            return true;
        }

        // TODO: Add proper type compatibility checking
        // For now, exact match only for structs
        if (TypeRegistry.isStruct(outputType) || TypeRegistry.isStruct(inputType)) {
            return outputType === inputType;
        }

        // For primitives, allow any connection (existing behavior - has auto-conversion)
        return true;
    }

    getMidpoint() {
        // Safety check: if either node is null, return a default position
        if (!this.fromNode || !this.toNode) {
            // Runs per connection per mousemove: warn once per connection
            if (!this._warnedMid) { this._warnedMid = true; console.warn('Connection has null node reference'); }
            return { x: 0, y: 0 };
        }

        const from = this.fromNode.getOutputPortPosition(this.fromOutput);
        const to = this.toNode.getInputPortPosition(this.toInput);

        // Safety check: if port positions are invalid
        if (!from || !to) {
            if (this._warnedMid) return { x: 0, y: 0 };
            this._warnedMid = true;
            console.warn('Connection has invalid port position', {
                fromNode: this.fromNode.id,
                toNode: this.toNode.id,
                fromOutput: this.fromOutput,
                toInput: this.toInput
            });
            return { x: 0, y: 0 };
        }

        return {
            x: (from.x + to.x) / 2,
            y: (from.y + to.y) / 2
        };
    }

    getLabel() {
        if (this.accessor) {
            // Remove leading dot and replace internal dots with chevrons for multi-level access
            let label = this.accessor.startsWith('.') ? this.accessor.slice(1) : this.accessor;
            // Replace dots with chevrons (›) for better visual hierarchy
            label = label.replace(/\./g, ' › ');
            return label;
        }
        // Don't show label if no accessor
        return '';
    }

    containsPoint(px, py, threshold = 15) {
        const mid = this.getMidpoint();
        const label = this.getLabel();
        // Size of the drawn accessor pill / midpoint handle (set by GraphRenderer)
        const width = this._pillW || (label.length * 7 + 10);
        const height = this._pillH || 18;

        return px >= mid.x - width / 2 && px <= mid.x + width / 2 &&
            py >= mid.y - height / 2 && py <= mid.y + height / 2;
    }

    /**
     * Event handling for connections
     * Connection needs graph reference to show menu properly
     */
    handleMouseDown(x, y, event, graph) {
        if (this.containsPoint(x, y)) {
            // Handle menu display internally
            if (graph) {
                graph.showConnectionMenu(this, event);
            }
            return { handled: true };
        }
        return null;
    }
}

/** Deep copy of plain serialized data (structuredClone, JSON fallback). */
function cloneData(v) {
    try { return structuredClone(v); } catch (e) { return JSON.parse(JSON.stringify(v)); }
}

export class NodeGraph {
    constructor(canvas, videoElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.videoElement = videoElement;
        this.nodes = [];
        this.connections = [];
        this.nextNodeId = 0;
        this.previewNodes = new Map(); // nodeId -> PreviewNode instance

        this.draggedNode = null;
        this.dragOffsetX = 0;
        this.dragOffsetY = 0;

        this.connectingFrom = null;
        this.swizzleHint = ''; // Accumulated swizzle/accessor string during connection drag
        this.swizzleHintSuggestion = null; // Autocomplete suggestion for swizzle hint
        this.swizzleHintTimer = null; // Timer for swizzle hint input timeout
        this.mouseX = 0;
        this.mouseY = 0;

        // Pan offset for scrolling the canvas
        this.panX = 0;
        this.panY = 0;

        // Zoom level
        this.zoom = 1.0;
        this.minZoom = 0.1;
        this.maxZoom = 3.0;

        // Selection - now managed by SelectionManager
        this.selectionManager = new SelectionManager();
        this.selectionStart = null;

        // Clipboard
        this.clipboard = null;

        // Text input focus
        this.focusedTextInput = null;
        this.focusedNode = null;

        // Text input dragging
        this.draggingTextInput = null;

        // Animation for text input cursor blink
        this.lastUpdateTime = Date.now();

        // Callbacks
        this.onGraphChanged = null;
        this.onNodeRightClick = null;  // Callback for right-clicking nodes

        // Quick node search - extracted to separate class
        this.quickNodeSearch = new QuickNodeSearch(this);

        // Canvas drawing (background, cables, nodes, overlays) + hover state
        this.graphRenderer = new GraphRenderer(canvas, this.ctx);

        // Node groups: graph.groups metadata + the scope (root or a group) being viewed.
        // The compiled graph (nodes/connections) stays flat.
        this.groups = [];
        this.groupCtl = new NodeGroups(this, { Connection });

        this.setupEventListeners();
        this.startUpdateLoop();
    }

    /** Items drawn / hit-tested in the current scope (nodes, group boxes, boundary panels). */
    getViewNodes() {
        return this.groupCtl ? this.groupCtl.viewNodes() : this.nodes;
    }

    /** Cables drawn / hit-tested in the current scope (real connections + group-box links). */
    getViewLinks() {
        return this.groupCtl ? this.groupCtl.viewLinks() : this.connections;
    }

    setupEventListeners() {
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
        this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        this.canvas.addEventListener('mouseleave', () => {
            if (this.graphRenderer.clearHover()) this.render();
        });

        // Keyboard events
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('paste', (e) => this.onPaste(e));
    }

    onWheel(e) {
        const gc = this.groupCtl;
        const isZoom = e.ctrlKey || e.metaKey;
        // Scrolling during a timed group enter/exit animation jumps to its end; a
        // zoom-driven one keeps following zoom gestures and settles on a plain scroll
        if (gc && gc.isTransitioning() && !(isZoom && gc.isScrubbing())) gc.cancelTransition();

        e.preventDefault();

        // Check if zoom gesture (Cmd/Ctrl + scroll, or pinch)
        if (e.ctrlKey || e.metaKey) {
            // Zoom toward mouse cursor
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // Get world position before zoom
            const worldX = (mouseX - this.panX) / this.zoom;
            const worldY = (mouseY - this.panY) / this.zoom;

            // Apply zoom (exponential so it feels the same at every zoom level).
            // Trackpad pinches arrive as ctrl+wheel with small pixel deltas, so they get a
            // stronger factor than Cmd + mouse-wheel notches (~100px each).
            const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1);
            const delta = Math.max(-120, Math.min(120, e.deltaY * unit));
            const isPinch = e.ctrlKey && !e.metaKey;
            const factor = Math.exp(-delta * (isPinch ? 0.01 : 0.002));

            // Zooming into a group box's preview (or out of a group) walks through the group
            if (gc && gc.zoomGesture(factor, mouseX, mouseY)) {
                this.render();
                return;
            }

            const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));

            // Adjust pan to keep world position under cursor
            this.panX = mouseX - worldX * newZoom;
            this.panY = mouseY - worldY * newZoom;

            this.zoom = newZoom;
        } else {
            // Pan
            this.panX -= e.deltaX;
            this.panY -= e.deltaY;
        }

        this.render();
    }

    onContextMenu(e) {
        e.preventDefault();
        const pos = this.getMousePos(e);

        // Context menu (node action such as "Edit GLSL…", group / ungroup / rename, delete...)
        const items = this.getViewNodes();
        let hit = null;
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].containsPoint(pos.x, pos.y)) { hit = items[i]; break; }
        }
        this.groupCtl.ui.showContextMenu(e, hit, pos);
    }

    onDoubleClick(e) {
        const pos = this.getMousePos(e);

        // Find double-clicked node (group boxes open; their title renames)
        const items = this.getViewNodes();
        for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            if (item.containsPoint(pos.x, pos.y)) {
                if (item.isViewOnly) {
                    this.groupCtl.onDoubleClick(item, pos, e);
                } else if (this.onNodeRightClick) {
                    this.onNodeRightClick(item, e);
                }
                return;
            }
        }

        // Empty space inside a group (not on a cable): go back up a level
        const overCable = this.graphRenderer && this.graphRenderer.hoverConn;
        if (this.groupCtl && this.groupCtl.scope !== null && !overCable && !this.connectingFrom) {
            this.selectionBox = null;
            this.selectionStart = null;
            this.groupCtl.exitUp();
        }
    }

    startUpdateLoop() {
        const update = () => {
            const now = Date.now();
            const dt = now - this.lastUpdateTime;
            this.lastUpdateTime = now;

            // Update all text inputs for cursor blink
            for (const node of this.nodes) {
                if (node.hasInputFields && node.textInputs) {
                    for (const input of Object.values(node.textInputs)) {
                        input.update(dt);
                    }
                }
            }

            // Check if we need to render (previews, live meters, animated drag cable)
            const needsRender = this.focusedTextInput || this.graphRenderer.needsAnimation(this);

            if (needsRender) {
                this.render();
            }

            requestAnimationFrame(update);
        };
        requestAnimationFrame(update);
    }

    onPaste(e) {
        // If a canvas text input is focused, let it handle the paste
        if (this.focusedTextInput) {
            this.focusedTextInput.handlePaste(e);
            if (this.onGraphChanged) this.onGraphChanged();
            this.render();
        }
    }

    onKeyDown(e) {
        // Don't capture keyboard events if any input, textarea, or contenteditable is focused
        const activeElement = document.activeElement;
        const isEditingText = activeElement && (
            activeElement.tagName === 'INPUT' ||
            activeElement.tagName === 'TEXTAREA' ||
            activeElement.isContentEditable ||
            activeElement.closest('.monaco-editor') // Monaco editor
        );

        if (isEditingText && e.key !== 'Escape') {
            // Allow Escape to always work (to close dialogs)
            return;
        }
        // A modal dialog is open: canvas shortcuts (Delete, paste, group, Tab...) must not act
        // on the graph behind it (Escape is handled by the dialog itself)
        if (document.querySelector('.pt-modal-backdrop')) return;

        // If a canvas text input is focused, let it handle the key
        if (this.focusedTextInput) {
            const handled = this.focusedTextInput.handleKeyDown(e);
            if (handled) {
                if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
                    // Blur the input
                    this.focusedTextInput = null;
                    this.focusedNode = null;
                }
                if (this.onGraphChanged) this.onGraphChanged();
                this.render();
                return;
            }
        }

        // Groups: Cmd/Ctrl+G group, Cmd/Ctrl+Shift+G ungroup, Enter opens the selected group box
        if (!isEditingText && this.groupCtl.handleKey(e)) return;

        // Delete/Backspace - delete selected nodes (never during a cable drag: there Backspace
        // edits the accessor hint, and Delete / Backspace with no hint cancel the drag below)
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectionManager.selectedNodes.size > 0 && !this.connectingFrom) {
            e.preventDefault();
            this.deleteSelectedNodes();
        } else if (e.key === 'Backspace' && !this.connectingFrom && !isEditingText && this.groupCtl.scope !== null) {
            // Backspace with nothing selected: up one group level
            e.preventDefault();
            this.groupCtl.exitUp();
        }

        // Ctrl/Cmd+C - copy
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && this.selectionManager.selectedNodes.size > 0) {
            e.preventDefault();
            this.copySelectedNodes();
        }

        // Ctrl/Cmd+X - cut
        if ((e.ctrlKey || e.metaKey) && e.key === 'x' && this.selectionManager.selectedNodes.size > 0) {
            e.preventDefault();
            this.cutSelectedNodes();
        }

        // Ctrl/Cmd+V - paste
        if ((e.ctrlKey || e.metaKey) && e.key === 'v' && this.clipboard) {
            e.preventDefault();
            this.pasteNodes();
        }

        // Ctrl/Cmd+A - select all
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            this.selectAll();
        }

        // Accessor input during connection dragging (struct members and swizzle)
        if (this.connectingFrom) {
            const key = e.key;

            // Accept alphanumeric, underscore, and dot for struct member access
            // Also accept traditional swizzle chars: xyzwrgba
            if (/^[a-zA-Z0-9_.]$/.test(key)) {
                e.preventDefault();
                this.handleSwizzleInput(key);
                this.render();
            } else if (e.key === 'Delete' || (e.key === 'Backspace' && !this.swizzleHint)) {
                // Delete (or Backspace with no hint to edit): cancel the drag
                e.preventDefault();
                this.cancelConnectionDrag();
            } else if (e.key === 'Backspace') {
                e.preventDefault();
                // Remove last character from swizzle hint
                if (this.swizzleHint.length > 0) {
                    this.swizzleHint = this.swizzleHint.slice(0, -1);
                    this.swizzleHintSuggestion = null; // Clear swizzle hint suggestion on backspace
                    this.render();
                }
            } else if (e.key === 'Tab' || e.key === 'Enter') {
                // Accept swizzle hint autocomplete suggestion
                if (this.swizzleHintSuggestion && this.swizzleHint) {
                    e.preventDefault();
                    this.swizzleHint = this.swizzleHintSuggestion;
                    this.swizzleHintSuggestion = null;
                    this.render();
                }
            } else if (e.key === 'Escape') {
                // Clear swizzle hint
                this.swizzleHint = '';
                this.swizzleHintSuggestion = null;
                if (this.swizzleHintTimer) {
                    clearTimeout(this.swizzleHintTimer);
                    this.swizzleHintTimer = null;
                }
                this.render();
            }
        }

        // Escape - clear selection or cancel ghost node (with nothing selected: up one group level)
        if (e.key === 'Escape') {
            if (this.quickNodeSearch.hasGhostNode()) {
                this.quickNodeSearch.cancelGhostNode();
            } else if (this.selectionManager.selectedNodes.size === 0 && this.groupCtl.scope !== null &&
                !this.connectingFrom && !isEditingText && !document.querySelector('.pt-modal-backdrop, .pt-menu')) {
                this.groupCtl.exitUp();
            } else {
                this.clearSelection();
            }
        }

        // Tab - open quick node search (not while dragging a cable: there Tab accepts the swizzle suggestion)
        if (e.key === 'Tab') {
            e.preventDefault();
            if (!this.connectingFrom) this.quickNodeSearch.show(this.addNodeButton);
        }
    }

    /**
     * Abort the cable being dragged: nothing is connected or created, and a cable that was
     * pulled out of an input to start the drag goes back where it was.
     */
    cancelConnectionDrag() {
        const cf = this.connectingFrom;
        if (!cf) return false;
        this.connectingFrom = null;
        this.swizzleHint = '';
        this.swizzleHintSuggestion = null;
        if (this.swizzleHintTimer) {
            clearTimeout(this.swizzleHintTimer);
            this.swizzleHintTimer = null;
        }
        const restore = cf.restore || (cf.reattach && cf.reattach.conns) || null;
        if (restore && restore.length) {
            const live = new Set(this.nodes);
            for (const c of restore) {
                if (live.has(c.fromNode) && live.has(c.toNode) && !this.connections.includes(c)) this.connections.push(c);
            }
            if (this.onGraphChanged) this.onGraphChanged();
        }
        this.render();
        return true;
    }

    deleteSelectedNodes(opts = {}) {
        // Group boxes in the selection: ask "delete contents or just ungroup?" first
        if (this.groupCtl.interceptDelete(opts)) return;

        // Add paired ForLoop nodes to selection if one is selected
        const nodesToDelete = new Set([...this.selectionManager.selectedNodes].filter(n => !n.isViewOnly));
        for (const node of nodesToDelete) {
            if ((node.isForLoopStartNode || node.isForLoopEndNode) && node.data.pairNodeId != null) {
                const pairNode = this.nodes.find(n => n.id === node.data.pairNodeId);
                if (pairNode) {
                    nodesToDelete.add(pairNode);
                }
            }
        }

        // Remove connections to/from nodes being deleted
        this.connections = this.connections.filter(conn =>
            !nodesToDelete.has(conn.fromNode) && !nodesToDelete.has(conn.toNode)
        );

        // Clean up preview nodes
        for (const node of nodesToDelete) {
            if (node.isPreviewNode && this.previewNodes.has(node.id)) {
                this.previewNodes.get(node.id).destroy();
                this.previewNodes.delete(node.id);
            }
            // Clean up node-specific resources
            if (node.cleanup) {
                node.cleanup();
            }
        }

        // Remove nodes
        this.nodes = this.nodes.filter(node => !nodesToDelete.has(node));
        this.groupCtl.onNodesDeleted(nodesToDelete);

        // Check if we need to disable buttons after deletion
        this.updateDeviceButtonStates();

        this.selectionManager.selectedNodes.clear();
        if (this.onGraphChanged) this.onGraphChanged();
        this.render();
    }

    updateDeviceButtonStates() {
        // Reset top-bar device toggles whose node types are gone from the graph.
        // (Visual state lives in CSS classes; AppShell keeps them in sync.)
        const reset = (id, stillUsed) => {
            if (stillUsed) return;
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.classList.remove('is-on', 'is-error', 'is-available');
            btn.style.removeProperty('background');
            btn.style.removeProperty('border-color');
            btn.removeAttribute('title');
        };
        reset('cameraBtn', this.nodes.some(n => n.isCameraNode));
        reset('midiBtn', this.nodes.some(n => n.isMidiCCNode));
        reset('screenCaptureBtn', this.nodes.some(n => n.isScreenCaptureNode));
    }

    copySelectedNodes() {
        // Group boxes copy their whole subtree (nodes + group records)
        const expanded = this.groupCtl.expandForCopy(this.selectionManager.selectedNodes);
        const nodesToCopy = expanded.nodes;
        const copySet = new Set(nodesToCopy);
        const connectionsToCopy = this.connections.filter(conn =>
            copySet.has(conn.fromNode) && copySet.has(conn.toNode)
        );

        this.clipboard = {
            groups: expanded.groups,
            // Deep copies: the clipboard (and every paste) must not share nested data
            // (ForLoop varTypes, scene lists...) with the original nodes
            nodes: nodesToCopy.map(n => cloneData(n.serialize())),
            connections: connectionsToCopy.map(c => ({
                fromId: c.fromNode.id,
                fromOutput: c.fromOutput,
                toId: c.toNode.id,
                toInput: c.toInput,
                swizzle: c.swizzle
            }))
        };

    }

    cutSelectedNodes() {
        this.copySelectedNodes();
        this.deleteSelectedNodes({ groupContents: true });
        this.history?.hint(`Cut ${this.clipboard.nodes.length} node${this.clipboard.nodes.length === 1 ? '' : 's'}`);
    }

    pasteNodes() {
        if (!this.clipboard) return;

        const idMap = new Map();
        const newNodes = [];
        // New ids up front, so paired nodes (ForLoop Start / End) point at their pasted partner
        const newIds = new Map();
        for (const nodeData of this.clipboard.nodes) newIds.set(nodeData.id, this.nextNodeId++);

        // Create new nodes with new IDs, offset by 20px
        for (const raw of this.clipboard.nodes) {
            const nodeData = cloneData(raw);
            if (nodeData.data && nodeData.data.pairNodeId != null) {
                // A pair copied without its partner must not grab the original's partner
                nodeData.data.pairNodeId = newIds.has(nodeData.data.pairNodeId) ? newIds.get(nodeData.data.pairNodeId) : null;
            }
            let newNode = null;
            try {
                newNode = deserializeNode({
                    ...nodeData,
                    id: newIds.get(raw.id),
                    x: nodeData.x + 20,
                    y: nodeData.y + 20
                }, this.canvas, this.videoElement, this.sharedGL);
            } catch (e) {
                console.warn(`[graph] could not paste ${raw.type}:`, e);
                newNode = null;
            }
            // Unknown type (e.g. a custom node deleted since the copy): skip it and its cables
            if (!newNode) continue;
            newNode.graph = this;  // Set graph reference

            // Register preview renderer if it's a preview node
            if (newNode instanceof PreviewNodeClass) {
                this.previewNodes.set(newNode.id, newNode.renderer);
            }

            idMap.set(nodeData.id, newNode);
            newNodes.push(newNode);
            this.nodes.push(newNode);
        }

        // First pass: Check blend nodes in pasted nodes and add necessary inputs
        for (const newNode of newNodes) {
            if (newNode.isDynamicInput && newNode.type === 'Blend') {
                // Find the highest input index that will be connected to this blend node
                let maxInputIndex = -1; // Start with -1

                for (const connData of this.clipboard.connections) {
                    // Map old ID to new node
                    const mappedToNode = idMap.get(connData.toId);
                    if (mappedToNode === newNode) {
                        // Check if this is a blend input connection (not the index input)
                        if (connData.toInput > 0) { // Skip index input at position 0
                            const inputNum = connData.toInput - 1;
                            if (inputNum > maxInputIndex) {
                                maxInputIndex = inputNum;
                            }
                        }
                    }
                }

                // If no connections found, default to having 0 and 1
                if (maxInputIndex === -1) {
                    maxInputIndex = 1;
                }

                // Add inputs up to maxInputIndex + 1 (to have one free input)
                while (newNode.inputs.filter(i => i.name !== 'index' && /^\d+$/.test(i.name)).length <= maxInputIndex + 1) {
                    newNode.addDynamicInput();
                }
            }
        }

        // Recreate connections with new node references
        for (const connData of this.clipboard.connections) {
            const fromNode = idMap.get(connData.fromId);
            const toNode = idMap.get(connData.toId);
            if (fromNode && toNode) {
                this.connections.push(new Connection(
                    fromNode,
                    connData.fromOutput,
                    toNode,
                    connData.toInput,
                    connData.swizzle  // Preserve swizzle
                ));
            }
        }

        // Select pasted nodes
        this.clearSelection();
        newNodes.forEach(node => this.selectionManager.selectedNodes.add(node));

        // Recreate pasted groups; loose nodes land in the current group scope
        this.groupCtl.afterPaste(this.clipboard, idMap, newNodes);
        this.history?.hint(`Paste ${newNodes.length} node${newNodes.length === 1 ? '' : 's'}`); // undo label (src/core/History.js)

        if (this.onGraphChanged) this.onGraphChanged();
        this.render();
    }

    selectAll() {
        this.selectionManager.selectedNodes.clear();
        this.getViewNodes().forEach(node => {
            if (!node.isBoundaryPanel) this.selectionManager.selectedNodes.add(node);
        });
        this.render();
    }

    clearSelection() {
        this.selectionManager.selectedNodes.clear();
        this.render();
    }

    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left - this.panX) / this.zoom,
            y: (e.clientY - rect.top - this.panY) / this.zoom
        };
    }

    /**
     * Check if a click hit any of this node's ports
     * Returns an action object or null
     */
    checkNodePorts(node, x, y) {
        // Check output ports first
        for (let i = 0; i < node.outputs.length; i++) {
            const portPos = node.getOutputPortPosition(i);
            if (!portPos) continue;

            const dist = Math.hypot(x - portPos.x, y - portPos.y);
            if (dist < 8) {
                return {
                    type: 'START_CONNECTION_FROM_OUTPUT',
                    node: node,
                    outputIndex: i
                };
            }
        }

        // Check input ports
        for (let i = 0; i < node.inputs.length; i++) {
            const portPos = node.getInputPortPosition(i);
            if (!portPos) continue;

            const dist = Math.hypot(x - portPos.x, y - portPos.y);
            if (dist < 8) {
                return {
                    type: 'CLICKED_INPUT_PORT',
                    node: node,
                    inputIndex: i
                };
            }
        }

        return null;
    }

    onMouseDown(e) {
        // Interacting during a group enter/exit animation jumps to its end
        if (this.groupCtl && this.groupCtl.isTransitioning()) this.groupCtl.cancelTransition();

        // Ignore right-clicks (they're handled by onContextMenu)
        if (e.button === 2) {
            return;
        }

        // Middle button drags the view; thumb buttons zoom (click steps, drag scrubs)
        if (e.button === 1 || e.button === 3 || e.button === 4) {
            e.preventDefault(); // no autoscroll, no browser back/forward
            this.beginButtonNav(e);
            return;
        }

        const pos = this.getMousePos(e);

        // If ghost node exists, place it
        if (this.quickNodeSearch.placeGhostNode()) {
            return;
        }

        // Check nodes first (in reverse order for z-index) since they render on top
        // (in a group scope: that scope's nodes, group boxes and boundary panels)
        const viewNodes = this.getViewNodes();
        for (let i = viewNodes.length - 1; i >= 0; i--) {
            const node = viewNodes[i];

            // First check ports (they extend beyond node bounds)
            const portAction = this.checkNodePorts(node, pos.x, pos.y);
            if (portAction) {
                this.handleAction(portAction, e);
                return;
            }

            // Then check if click is within node body
            if (node.containsPoint(pos.x, pos.y)) {
                const result = node.handleMouseDown(pos.x, pos.y, e);
                if (result) {
                    this.handleAction(result, e);
                    return;
                }
            }
        }

        // Check connections/swizzles last since they render under nodes
        for (const conn of this.getViewLinks()) {
            // If we find an orphaned connection, clean them all up immediately
            if (!conn.fromNode || !conn.toNode) {
                console.warn('Found orphaned connection, cleaning up...');
                this.cleanupOrphanedConnections();
                break;
            }

            const result = conn.handleMouseDown(pos.x, pos.y, e, this);
            if (result && result.handled) {
                return;
            }
        }

        // Nothing was clicked - start rubberband selection
        if (!e.shiftKey) {
            this.clearSelection();
        }

        // Blur any focused text input when clicking on empty space
        if (this.focusedTextInput) {
            this.focusedTextInput.blur();
            this.focusedTextInput = null;
            this.focusedNode = null;
        }

        this.selectionStart = { x: pos.x, y: pos.y };
        this.selectionBox = { x: pos.x, y: pos.y, width: 0, height: 0 };
    }

    /**
     * Simplified action handler - only handles actions that require graph coordination
     * Most actions are now handled directly by components
     */
    handleAction(result, event) {
        // Check if component already handled it
        if (result.handled) {
            // Component handled the action, just coordinate side effects
            if (result.needsRender) {
                this.render();
            }
            if (result.needsGraphChange && this.onGraphChanged) {
                this.onGraphChanged();
            }
            return;
        }

        // Otherwise handle graph-level actions (connections, dragging, etc.)
        switch (result.type) {
            case 'START_CONNECTION_FROM_OUTPUT':
                if (result.node.isViewOnly) { this.groupCtl.beginPortDrag(result); break; } // group box / boundary panel
                this.connectingFrom = {
                    node: result.node,
                    outputIndex: result.outputIndex
                };
                break;

            case 'CLICKED_INPUT_PORT':
                if (result.node.isViewOnly) { this.groupCtl.beginPortDrag(result); break; }
                this.handleInputPortClick(result.node, result.inputIndex);
                break;

            case 'INTERACT_TEXT_INPUT':
                this.handleTextInputInteraction(result);
                break;

            case 'START_RESIZE':
                this.resizingNode = { node: result.node, edge: result.edge };
                this.canvas.style.cursor = result.cursor;
                break;

            case 'START_NODE_DRAG':
                this.handleNodeDragStart(result.node, result.offsetX, result.offsetY, event);
                break;

            case 'UPDATE_CURSOR':
                this.canvas.style.cursor = result.cursor;
                break;

            // Node-internal controls that already applied their change
            case 'TOGGLE_BOOL':
            case 'TOGGLE_CLIP':
            case 'TOGGLE_LEARN':
            case 'VIDEO_CONTROL':
                this.render();
                break;

            default:
                console.warn('Unknown action type:', result.type);
        }
    }

    handleInputPortClick(node, inputIndex) {
        // Find if there's an existing connection to this input
        const existingConnection = this.connections.find(
            conn => conn.toNode === node && conn.toInput === inputIndex
        );

        if (existingConnection) {
            // Start a new connection from the source output
            this.connectingFrom = {
                node: existingConnection.fromNode,
                outputIndex: existingConnection.fromOutput,
                wasDisconnected: true, // Track that this came from a disconnection
                restore: [existingConnection] // put back if the drag is cancelled
            };
            // The source may sit outside the open group / inside a box: start the cable at its visible port
            this.groupCtl.decorateDrag(this.connectingFrom);

            // Remove the old connection
            this.connections = this.connections.filter(
                conn => !(conn.toNode === node && conn.toInput === inputIndex)
            );

            if (this.onGraphChanged) this.onGraphChanged();
            this.render();
        } else {
            // Start dragging from an empty input (reverse connection)
            this.connectingFrom = {
                node: node,
                inputIndex: inputIndex,
                isReverse: true
            };
        }
    }

    handleSwizzleInput(char) {
        const ACCESSOR_TIMEOUT = 800; // ms - time window to type swizzle hint

        // If timer expired (null) AND we have pending text, clear it to start fresh
        if (this.swizzleHintTimer === null && this.swizzleHint.length > 0) {
            this.swizzleHint = '';
            this.swizzleHintSuggestion = null;
        } else if (this.swizzleHintTimer !== null) {
            // Clear existing timer to extend the typing window
            clearTimeout(this.swizzleHintTimer);
        }

        // Add character to swizzle hint
        this.swizzleHint += char;

        // Try autocomplete for swizzle hint (struct members)
        if (this.connectingFrom) {
            let outputType;

            // Get output type based on connection direction
            if (this.connectingFrom.isReverse) {
                // Connecting from input (reverse), no autocomplete needed
                outputType = null;
            } else {
                // Connecting from output (normal direction)
                outputType = this.connectingFrom.node.outputs[this.connectingFrom.outputIndex]?.type;
            }

            if (outputType && TypeRegistry && TypeRegistry.isStruct && TypeRegistry.isStruct(outputType)) {
                const suggestion = this.getStructAutocomplete(outputType, this.swizzleHint);
                if (suggestion) {
                    this.swizzleHintSuggestion = suggestion;
                } else {
                    this.swizzleHintSuggestion = null;
                }
            } else {
                this.swizzleHintSuggestion = null;
            }
        }

        // Don't enforce length limit - struct member names can be longer than 4 chars
        // Validation will happen when connection is created

        // Set new timer to clear after timeout
        this.swizzleHintTimer = setTimeout(() => {
            // After timeout, allow starting a new accessor on next keypress
            // but keep current one for the connection
            this.swizzleHintTimer = null;
        }, ACCESSOR_TIMEOUT);

        this.render();
    }

    getStructAutocomplete(structType, partial) {
        if (!TypeRegistry || !partial) return null;

        const typeDef = TypeRegistry.getType(structType);
        if (!typeDef || !typeDef.members) return null;

        // Find members that start with the partial string
        for (const member of typeDef.members) {
            if (member.name.startsWith(partial)) {
                return member.name;
            }
        }

        return null;
    }

    handleTextInputInteraction(action) {
        const { node, input, x, y } = action;

        // Store potential click for focus (will focus on mouseup if no drag occurred)
        this.potentialTextInputFocus = {
            input: input,
            node: node,
            startX: x,
            startY: y
        };

        // Start potential drag
        if (!input.focused) {
            const started = input.startDrag(x);
            if (started) {
                this.draggingTextInput = input;
                this.canvas.style.cursor = 'ew-resize';
            }
        }
    }

    handleNodeDragStart(node, offsetX, offsetY, event) {
        // Handle selection
        if (!event.shiftKey && !this.selectionManager.selectedNodes.has(node)) {
            this.clearSelection();
        }

        if (event.shiftKey) {
            // Toggle selection
            if (this.selectionManager.selectedNodes.has(node)) {
                this.selectionManager.selectedNodes.delete(node);
            } else {
                this.selectionManager.selectedNodes.add(node);
            }
        } else {
            this.selectionManager.selectedNodes.add(node);
        }

        // Start dragging
        this.draggedNode = node;
        this.dragOffsetX = offsetX;
        this.dragOffsetY = offsetY;

        // Move to front (group boxes reorder among their sibling boxes)
        if (node.isViewOnly) {
            this.groupCtl.bringToFront(node);
        } else {
            const index = this.nodes.indexOf(node);
            if (index >= 0) {
                this.nodes.splice(index, 1);
                this.nodes.push(node);
            }
        }

        this.render();
    }

    onMouseMove(e) {
        const pos = this.getMousePos(e);

        // Skip render if mouse hasn't moved significantly
        const dx = Math.abs(pos.x - (this.mouseX || 0));
        const dy = Math.abs(pos.y - (this.mouseY || 0));
        if (dx < 1 && dy < 1 && !this.connectingFrom && !this.draggingNode && !this.isPanning && !this.resizingNode && !this.buttonNav) {
            return;
        }

        this.mouseX = pos.x;
        this.mouseY = pos.y;

        if (this.buttonNav) return; // handled by the window listener

        // Update ghost node position
        if (this.quickNodeSearch.updateGhostNodePosition(pos.x, pos.y)) {
            this.render();
            return;
        }

        if (this.draggingTextInput) {
            this.draggingTextInput.updateDrag(pos.x);
            this.render();
            return;
        }

        // Free-form resizing for nodes that handle it themselves (e.g. Comment notes)
        if (this.resizingNode && this.resizingNode.node.resizeFree) {
            this.resizingNode.node.resizeFree(this.resizingNode.edge, pos);
            this.render();
            return;
        }

        // Handle node resizing (only for preview nodes with aspect ratio preservation)
        if (this.resizingNode) {
            const node = this.resizingNode.node;
            const edge = this.resizingNode.edge;
            const minWidth = 150;
            const bottomBarHeight = 32;

            // Get the target aspect ratio (screen aspect ratio)
            const aspectRatio = screen.width / screen.height;

            // Calculate new dimensions maintaining aspect ratio
            let newWidth = node.width;

            // Determine width change based on which corner is being dragged
            if (edge.includes('e')) {
                newWidth = pos.x - node.x;
            } else if (edge.includes('w')) {
                newWidth = node.x + node.width - pos.x;
            }

            // Apply minimum width constraint
            newWidth = Math.max(minWidth, newWidth);

            // Calculate height maintaining aspect ratio (excluding bottom bar)
            const previewHeight = newWidth / aspectRatio;
            const newHeight = previewHeight + bottomBarHeight;

            // Update node dimensions
            if (edge.includes('w')) {
                node.x = node.x + node.width - newWidth;
            }
            if (edge.includes('n')) {
                node.y = node.y + node.height - newHeight;
            }

            node.width = newWidth;
            node.height = newHeight;

            // Update preview canvas size to match node dimensions
            if (node.resizeCanvas) {
                node.resizeCanvas();
            }

            this.render();
            return;
        }

        if (this.draggedNode) {
            // Drag all selected nodes
            const dx = pos.x - this.dragOffsetX - this.draggedNode.x;
            const dy = pos.y - this.dragOffsetY - this.draggedNode.y;

            for (const node of this.selectionManager.selectedNodes) {
                node.x += dx;
                node.y += dy;
            }

            this.render();
        } else if (this.connectingFrom) {
            this.render();
        } else if (this.selectionBox) {
            // Update rubberband selection box
            this.selectionBox.x = Math.min(this.selectionStart.x, pos.x);
            this.selectionBox.y = Math.min(this.selectionStart.y, pos.y);
            this.selectionBox.width = Math.abs(pos.x - this.selectionStart.x);
            this.selectionBox.height = Math.abs(pos.y - this.selectionStart.y);

            // Select nodes (and group boxes) within the box
            for (const node of this.getViewNodes()) {
                if (node.isBoundaryPanel) continue;
                const nodeRight = node.x + node.width;
                const nodeBottom = node.y + node.height;
                const boxRight = this.selectionBox.x + this.selectionBox.width;
                const boxBottom = this.selectionBox.y + this.selectionBox.height;

                const intersects = !(nodeRight < this.selectionBox.x ||
                    node.x > boxRight ||
                    nodeBottom < this.selectionBox.y ||
                    node.y > boxBottom);

                if (intersects) {
                    this.selectionManager.selectedNodes.add(node);
                }
            }

            this.render();
        } else {
            // Hover feedback (ports, nodes, cable midpoints, inner controls)
            if (this.graphRenderer.updateHover(this, pos.x, pos.y)) {
                this.render();
            }

            // Update cursor based on hover (use event bubbling)
            let cursorSet = false;
            if (this.graphRenderer.hoverPort) {
                this.canvas.style.cursor = 'crosshair';
                cursorSet = true;
            }
            const hoverItems = this.getViewNodes();
            for (let i = hoverItems.length - 1; i >= 0 && !cursorSet; i--) {
                const node = hoverItems[i];
                if (node.containsPoint(pos.x, pos.y)) {
                    const action = node.handleMouseMove(pos.x, pos.y, null);
                    if (action && action.type === 'UPDATE_CURSOR') {
                        this.canvas.style.cursor = action.cursor;
                        cursorSet = true;
                        break;
                    }
                }
            }
            if (!cursorSet) {
                this.canvas.style.cursor = 'default';
            }
        }
    }

    // ------------------------------------------------------------------
    // Mouse-button navigation: middle = pan, thumb buttons = zoom
    // (forward zooms in, back zooms out; hold and drag up/down to zoom smoothly)
    // ------------------------------------------------------------------

    beginButtonNav(e) {
        const rect = this.canvas.getBoundingClientRect();
        this.buttonNav = {
            button: e.button,
            mask: e.button === 1 ? 4 : (e.button === 3 ? 8 : 16),
            x: e.clientX,
            y: e.clientY,
            sx: e.clientX - rect.left,
            sy: e.clientY - rect.top,
            panX: this.panX,
            panY: this.panY,
            zoom: this.zoom,
            moved: false
        };
        if (e.button === 1) this.canvas.style.cursor = 'grabbing';
        // Track on the window: the drag may pass over overlays or leave the canvas
        this._navMove = (ev) => this.updateButtonNav(ev);
        this._navUp = (ev) => { if (this.buttonNav && ev.button === this.buttonNav.button) this.endButtonNav(ev); };
        window.addEventListener('mousemove', this._navMove, true);
        window.addEventListener('mouseup', this._navUp, true);
    }

    updateButtonNav(e) {
        const nav = this.buttonNav;
        if (!nav) return;
        // Released where no mouseup reached us: the move arrives without the button held
        if (!(e.buttons & nav.mask)) {
            this.endButtonNav(e, false);
            return;
        }
        this.applyButtonNav(e);
        this.render();
    }

    applyButtonNav(e) {
        const nav = this.buttonNav;
        const dx = e.clientX - nav.x;
        const dy = e.clientY - nav.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) nav.moved = true;
        if (nav.button === 1) {
            this.panX = nav.panX + dx;
            this.panY = nav.panY + dy;
        } else if (nav.moved) {
            this.canvas.style.cursor = 'ns-resize';
            this.zoomAround(nav, nav.zoom * Math.exp(-dy * 0.008));
        }
    }

    endButtonNav(e, released = true) {
        const nav = this.buttonNav;
        // Moves can be coalesced: settle on the release position
        if (released && e && Number.isFinite(e.clientX)) this.applyButtonNav(e);
        this.buttonNav = null;
        window.removeEventListener('mousemove', this._navMove, true);
        window.removeEventListener('mouseup', this._navUp, true);
        if (e && e.preventDefault) e.preventDefault();
        if (released && nav.button !== 1 && !nav.moved) {
            this.zoomAround(nav, nav.zoom * (nav.button === 4 ? 1.25 : 0.8));
        }
        this.canvas.style.cursor = 'default';
        this.render();
    }

    /** Zoom to `zoom`, keeping the graph point that was under nav.sx/sy (at press time) there. */
    zoomAround(nav, zoom) {
        const z = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
        const wx = (nav.sx - nav.panX) / nav.zoom;
        const wy = (nav.sy - nav.panY) / nav.zoom;
        this.zoom = z;
        this.panX = nav.sx - wx * z;
        this.panY = nav.sy - wy * z;
    }

    onMouseUp(e) {
        // Middle / thumb releases are handled by the button navigation (window listener);
        // thumb buttons would otherwise also navigate the browser back / forward
        if (e.button === 1 || e.button === 3 || e.button === 4) {
            e.preventDefault();
            return;
        }
        const pos = this.getMousePos(e);

        // Check if this was a click (not drag) on a text input
        if (this.potentialTextInputFocus) {
            const dragThreshold = 3; // pixels
            const dx = Math.abs(pos.x - this.potentialTextInputFocus.startX);
            const dy = Math.abs(pos.y - this.potentialTextInputFocus.startY);

            if (dx < dragThreshold && dy < dragThreshold) {
                // It was a click, not a drag - focus the input
                const input = this.potentialTextInputFocus.input;
                const node = this.potentialTextInputFocus.node;

                if (this.focusedTextInput && this.focusedTextInput !== input) {
                    this.focusedTextInput.blur();
                }
                if (!input.focused) {
                    input.focus();
                    this.focusedTextInput = input;
                    this.focusedNode = node;
                }

                // Cancel the drag if it was started
                if (this.draggingTextInput) {
                    this.draggingTextInput.endDrag();
                    this.draggingTextInput = null;
                    this.canvas.style.cursor = 'default';
                }

                this.render();
            }

            this.potentialTextInputFocus = null;
        }

        if (this.draggingTextInput) {
            this.draggingTextInput.endDrag();
            this.draggingTextInput = null;
            this.canvas.style.cursor = 'default';
            this.render();
            return;
        }

        if (this.resizingNode) {
            this.resizingNode = null;
            this.canvas.style.cursor = 'default';
            if (this.onGraphChanged) this.onGraphChanged();
            return;
        }

        if (this.connectingFrom) {
            let connected = false;

            if (this.connectingFrom.isReverse) {
                // Reverse connection: dragging from input, looking for output
                for (const node of this.getViewNodes()) {
                    for (let i = 0; i < node.outputs.length; i++) {
                        const portPos = node.getOutputPortPosition(i);
                        if (!portPos) continue;

                        const dist = Math.hypot(pos.x - portPos.x, pos.y - portPos.y);
                        if (dist < 8 && node !== (this.connectingFrom.viewNode || this.connectingFrom.node)) {
                            // Group box port / boundary panel row: connects the underlying inner port
                            if (node.isViewOnly) {
                                connected = true;
                                this.groupCtl.dropOnPort(node, 'out', i);
                                break;
                            }
                            // Remove any existing connection to this input (restored if the new one is rejected)
                            const replacedConns = this.connections.filter(
                                conn => conn.toNode === this.connectingFrom.node && conn.toInput === this.connectingFrom.inputIndex
                            );
                            this.connections = this.connections.filter(
                                conn => !(conn.toNode === this.connectingFrom.node &&
                                         conn.toInput === this.connectingFrom.inputIndex)
                            );

                            // Create new connection with swizzle hint if present
                            // Use autocomplete suggestion if available, otherwise use what was typed
                            const finalAccessor = this.swizzleHintSuggestion || this.swizzleHint;
                            const accessor = finalAccessor ? `.${finalAccessor}` : null;
                            const newConnection = new Connection(
                                node,
                                i,
                                this.connectingFrom.node,
                                this.connectingFrom.inputIndex,
                                accessor
                            );

                            // Resolve dynamic node output types before validation
                            if (node.isDynamicInput) {
                                this.resolveDynamicNodeOutputType(node);
                            }

                            // Validate the connection
                            if (!newConnection.isValid()) {
                                if (newConnection.rateError) {
                                    UIHelpers.toast(newConnection.rateError, 'warning', { title: 'Cannot connect' });
                                    this.connections.push(...replacedConns);
                                }
                                console.warn('Invalid connection: type mismatch', {
                                    from: newConnection.getOutputType(),
                                    to: this.connectingFrom.node.inputs[this.connectingFrom.inputIndex]?.type,
                                    accessor
                                });
                                // Clear the invalid swizzle hint and allow connection without it
                                this.swizzleHint = '';
                                if (this.swizzleHintTimer) {
                                    clearTimeout(this.swizzleHintTimer);
                                    this.swizzleHintTimer = null;
                                }
                                // Don't create connection for now - let user try again
                                break;
                            }

                            this.connections.push(newConnection);

                            // Check if we should auto-add a new input for dynamic nodes (like Blend)
                            if (this.connectingFrom.node.shouldAddNewInput && this.connectingFrom.node.shouldAddNewInput()) {
                                this.connectingFrom.node.addDynamicInput();
                            }

                            // Also check the target node (for nodes like ForLoopStart)
                            if (node.shouldAddNewInput && node.shouldAddNewInput()) {
                                node.addDynamicInput();
                            }

                            connected = true;
                            if (this.onGraphChanged) this.onGraphChanged();
                            break;
                        }
                    }
                    if (connected) break;
                }

                // Dropped on a group box body (port picker), a boundary panel (expose) or back where it came from
                if (!connected) connected = this.groupCtl.dropOnBody(pos, e);

                // If not connected to anything, check if we should create a constant node
                if (!connected) {
                    const inputDef = this.connectingFrom.node.inputs[this.connectingFrom.inputIndex];
                    if (inputDef) {
                        // Check if input has a specific defaultNode to create
                        if (inputDef.defaultNode) {
                            this.createDefaultNodeForInput(
                                this.connectingFrom.node,
                                this.connectingFrom.inputIndex,
                                inputDef.defaultNode,
                                pos.x,
                                pos.y
                            );
                            if (this.onGraphChanged) this.onGraphChanged();
                        } else if (this.canCreateConstantFor(inputDef.type)) {
                            // Otherwise create a constant node for the type
                            this.createConstantNodeForInput(
                                this.connectingFrom.node,
                                this.connectingFrom.inputIndex,
                                inputDef.type,
                                pos.x,
                                pos.y
                            );
                            if (this.onGraphChanged) this.onGraphChanged();
                        }
                    }
                }
            } else {
                // Released back on the group-box port / panel row the cable was pulled from:
                // restore it before hit-testing ports (they were re-indexed when it was removed,
                // so the next port now sits under the cursor)
                if (this.groupCtl.reattachIfBack(pos)) connected = true;

                // Normal connection: dragging from output, looking for input
                if (!connected) for (const node of this.getViewNodes()) {
                    for (let i = 0; i < node.inputs.length; i++) {
                        const portPos = node.getInputPortPosition(i);
                        if (!portPos) continue;

                        const dist = Math.hypot(pos.x - portPos.x, pos.y - portPos.y);
                        if (dist < 8 && node !== (this.connectingFrom.viewNode || this.connectingFrom.node)) {
                            // Group box port / boundary panel row: connects the underlying inner port
                            if (node.isViewOnly) {
                                connected = true;
                                this.groupCtl.dropOnPort(node, 'in', i);
                                break;
                            }
                            // Remove any existing connection to this input (restored if the new one is rejected)
                            const replacedConns = this.connections.filter(conn => conn.toNode === node && conn.toInput === i);
                            this.connections = this.connections.filter(
                                conn => !(conn.toNode === node && conn.toInput === i)
                            );

                            // Create new connection with swizzle hint if present
                            // Use autocomplete suggestion if available, otherwise use what was typed
                            const finalAccessor = this.swizzleHintSuggestion || this.swizzleHint;
                            const accessor = finalAccessor ? `.${finalAccessor}` : null;
                            const newConnection = new Connection(
                                this.connectingFrom.node,
                                this.connectingFrom.outputIndex,
                                node,
                                i,
                                accessor
                            );

                            // Resolve dynamic node output types before validation
                            if (this.connectingFrom.node.isDynamicInput) {
                                this.resolveDynamicNodeOutputType(this.connectingFrom.node);
                            }

                            // Validate the connection
                            if (!newConnection.isValid()) {
                                if (newConnection.rateError) {
                                    UIHelpers.toast(newConnection.rateError, 'warning', { title: 'Cannot connect' });
                                    this.connections.push(...replacedConns);
                                }
                                console.warn('Invalid connection: type mismatch', {
                                    from: newConnection.getOutputType(),
                                    to: node.inputs[i]?.type,
                                    accessor
                                });
                                // Clear the invalid swizzle hint and allow connection without it
                                this.swizzleHint = '';
                                if (this.swizzleHintTimer) {
                                    clearTimeout(this.swizzleHintTimer);
                                    this.swizzleHintTimer = null;
                                }
                                // Don't create connection for now - let user try again
                                break;
                            }

                            this.connections.push(newConnection);

                            // Check if we should auto-add a new input for dynamic nodes (like Blend)
                            // Here the target node (node) is the one receiving the connection
                            if (node.shouldAddNewInput && node.shouldAddNewInput()) {
                                node.addDynamicInput();
                            }

                            connected = true;
                            if (this.onGraphChanged) this.onGraphChanged();
                            break;
                        }
                    }
                    if (connected) break;
                }

                // Dropped on a group box body (port picker), a boundary panel (expose) or back where it came from
                if (!connected) connected = this.groupCtl.dropOnBody(pos, e);

                // If dragging from output to void, create a preview node for float/vec types
                // BUT NOT if this was a disconnection (user just wanted to disconnect)
                if (!connected && !this.connectingFrom.wasDisconnected) {
                    const outputDef = this.connectingFrom.node.outputs[this.connectingFrom.outputIndex];
                    if (outputDef && this.canCreatePreviewFor(outputDef.type)) {
                        this.createPreviewNodeForOutput(
                            this.connectingFrom.node,
                            this.connectingFrom.outputIndex,
                            outputDef.type,
                            pos.x,
                            pos.y
                        );
                        if (this.onGraphChanged) this.onGraphChanged();
                    }
                }
            }

            // Clear connection state and swizzle
            this.connectingFrom = null;
            this.swizzleHint = '';
            this.swizzleHintSuggestion = null;
            if (this.swizzleHintTimer) {
                clearTimeout(this.swizzleHintTimer);
                this.swizzleHintTimer = null;
            }
        }

        this.draggedNode = null;
        this.selectionBox = null;
        this.selectionStart = null;
        this.render();
    }

    /**
     * Resolve the output type for a dynamic node (like Blend) based on its current inputs
     * This is called before connection validation to ensure the output type is up-to-date
     */
    resolveDynamicNodeOutputType(node) {
        if (!node.isDynamicInput || !node.definition?.validateTypes) {
            return;
        }

        // Collect input types from connections
        const inputTypes = {};
        for (const input of node.inputs) {
            const connection = this.connections.find(
                conn => conn.toNode === node && conn.toInput === node.inputs.indexOf(input)
            );
            if (connection) {
                inputTypes[input.name] = connection.getOutputType();
            } else {
                inputTypes[input.name] = null;
            }
        }

        // Run validation to get output type
        const validation = node.definition.validateTypes(node, inputTypes, null);
        if (validation.valid && validation.outputType) {
            node.resolvedOutputType = validation.outputType;
            if (node.outputs.length > 0) {
                node.outputs[0].type = validation.outputType;
            }
        }
    }

    addNode(type, x, y) {
        const node = NodeFactory.createNode(type, this.nextNodeId++, x, y, this.canvas, this.videoElement, this.sharedGL);

        if (!node) {
            console.error(`Failed to create node of type: ${type}`);
            return null;
        }

        // Track preview nodes
        if (node.isPreviewNode) {
            this.previewNodes.set(node.id, node.renderer);
        }

        node.graph = this;  // Give node reference to graph for callbacks
        this.nodes.push(node);

        // Auto-pair ForLoopStart with ForLoopEnd
        if (node.isForLoopStartNode) {
            // Create paired ForLoopEnd node to the right
            const pairX = x + 300; // Position to the right
            const pairY = y;
            const pairNode = NodeFactory.createNode('ForLoopEnd', this.nextNodeId++, pairX, pairY, this.canvas, this.videoElement, this.sharedGL);

            if (pairNode) {
                // Copy varTypes for initial creation
                pairNode.data.varTypes = [...node.data.varTypes];

                // Link them together
                node.data.pairNodeId = pairNode.id;
                pairNode.data.pairNodeId = node.id;

                // Add pair to graph
                pairNode.graph = this;
                this.nodes.push(pairNode);

                // Update ports to match
                pairNode.updatePorts();
            }
        }

        // Nodes created from the UI land in the open group (MCP commands keep adding to the root)
        this.groupCtl.adoptNew(node);
        if (node.isForLoopStartNode && node.data.pairNodeId != null) {
            this.groupCtl.adoptNew(this.nodes.find(n => n.id === node.data.pairNodeId));
        }

        this.render();
        return node;
    }

    refreshNodesOfType(type, options = {}) {
        const definition = NodeDefinitions[type];
        if (!definition) return;

        const { preserveData = true } = options;
        let updated = false;

        for (const node of this.nodes) {
            if (node.type === type) {
                node.applyDefinition(definition, { preserveData });
                updated = true;
            }
        }

        if (!updated) return;

        const originalLength = this.connections.length;
        this.connections = this.connections.filter(conn => {
            const fromValid = conn.fromOutput < conn.fromNode.outputs.length;
            const toValid = conn.toInput < conn.toNode.inputs.length;
            return fromValid && toValid;
        });

        if (originalLength !== this.connections.length && this.onGraphChanged) {
            this.onGraphChanged();
        }

        this.render();
    }

    render() {
        // Use requestAnimationFrame to batch renders
        if (!this.renderRequested) {
            this.renderRequested = true;
            requestAnimationFrame(() => {
                this.renderRequested = false;
                this.performRender();
            });
        }
    }

    performRender() {
        // All canvas drawing lives in GraphRenderer (src/graph/GraphRenderer.js)
        this.graphRenderer.render(this);
        // DOM editors over the canvas (note text, group rename) follow pan / zoom
        if (this.overlays && this.overlays.size) {
            for (const sync of this.overlays) {
                try { sync(); } catch (e) { /* ignore */ }
            }
        }
    }

    /** Keep a DOM overlay placed over the canvas: sync() runs after every render. Returns remove(). */
    addOverlay(sync) {
        const set = this.overlays || (this.overlays = new Set());
        set.add(sync);
        return () => set.delete(sync);
    }

    showConnectionMenu(conn, e) {
        const outputType = conn.fromNode.outputs[conn.fromOutput].type;

        // Get available swizzle options based on type
        const options = this.getSwizzleOptions(outputType, conn.swizzle);

        // Even if no swizzle options, still show menu for type inspection
        // if (options.length === 0) return;

        // Create menu (styled by .pt-swizzle-menu in style.css)
        const menu = document.createElement('div');
        menu.className = 'pt-swizzle-menu';
        menu.setAttribute('role', 'menu');

        // Type header, tinted with the cable's signal color
        const header = document.createElement('div');
        header.className = 'pt-swizzle-type';
        header.textContent = outputType;
        header.style.setProperty('--tc', outputType ? typeColor(outputType) : TYPE_COLORS.struct);
        menu.appendChild(header);

        // Create grid for options
        const grid = document.createElement('div');
        grid.className = 'pt-swizzle-grid';

        // Configure grid based on type
        if (outputType === 'vec2' || outputType === 'vec3' || outputType === 'vec4') {
            grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
        }

        menu.appendChild(grid);

        // Add options
        options.forEach(opt => {
            const item = document.createElement('div');
            item.className = 'pt-swizzle-item';
            item.textContent = opt.label;
            item._opt = opt;

            // Handle column spanning
            if (opt.span) {
                item.style.gridColumn = `span ${opt.span}`;
            }

            // Handle spacer items
            if (opt.spacer) {
                item.classList.add('is-spacer');
                item.dataset.spacer = 'true';
            } else {
                item.setAttribute('role', 'menuitem');
                if (conn.swizzle === opt.value) {
                    item.classList.add('is-current');
                }

                item.addEventListener('click', () => {
                    if (opt.custom) {
                        // Show custom input field instead of prompt
                        showCustomInput();
                    } else {
                        conn.accessor = opt.value;
                        conn.swizzle = opt.value; // Keep backwards compatibility
                        menu.remove();
                        document.removeEventListener('keydown', handleKeyDown);
                        document.removeEventListener('mousedown', closeMenu);
                        this.render();
                        if (this.onGraphChanged) this.onGraphChanged();
                    }
                });
            }

            grid.appendChild(item);
        });

        document.body.appendChild(menu);

        // Position at the cursor, clamped to the viewport
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        menu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - mw - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - mh - 8)) + 'px';

        // Track typed swizzle string
        let typedSwizzle = '';
        let typedTimer = null;
        let customInputActive = false;

        const selectOption = (swizzleValue) => {
            Array.from(grid.children).forEach(item => {
                const opt = item._opt;
                item.classList.toggle('is-selected', !!opt && !opt.spacer && opt.value === swizzleValue);
            });
        };

        const showCustomInput = () => {
            customInputActive = true;

            // Replace grid with text input
            grid.style.display = 'none';

            const inputContainer = document.createElement('div');
            inputContainer.className = 'pt-swizzle-custom';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'pt-input';
            input.spellcheck = false;
            input.placeholder = 'xy, rgb, position.xy';
            input.value = typedSwizzle || '';

            inputContainer.appendChild(input);
            menu.appendChild(inputContainer);
            menu.style.minWidth = '200px';

            // Focus input
            setTimeout(() => input.focus(), 0);

            // Handle input submission
            const applyCustom = () => {
                const customAccessor = input.value.trim();
                if (customAccessor) {
                    conn.accessor = customAccessor.startsWith('.') ? customAccessor : '.' + customAccessor;
                    conn.swizzle = conn.accessor;
                    menu.remove();
                    document.removeEventListener('keydown', handleKeyDown);
                    document.removeEventListener('mousedown', closeMenu);
                    this.render();
                    if (this.onGraphChanged) this.onGraphChanged();
                }
            };

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    applyCustom();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    menu.remove();
                    document.removeEventListener('keydown', handleKeyDown);
                    document.removeEventListener('mousedown', closeMenu);
                }
                e.stopPropagation(); // Prevent bubbling to main handler
            });
        };

        // Keyboard input for typing swizzle
        const handleKeyDown = (e) => {
            if (customInputActive) return; // Input field handles its own keys

            // Check if it's a valid swizzle character or period (for struct access like position.xy)
            if (/^[xyzwrgba.]$/.test(e.key)) {
                e.preventDefault();

                // Clear existing timer
                if (typedTimer) {
                    clearTimeout(typedTimer);
                }

                // Add character to typed swizzle
                typedSwizzle += e.key;

                // Try to find matching option
                const matchingOpt = options.find(opt => !opt.spacer && !opt.custom && opt.value === `.${typedSwizzle}`);

                if (matchingOpt) {
                    // Highlight the matching option
                    selectOption(matchingOpt.value);

                    // Set timer to apply selection after short delay (allows typing multi-char swizzles)
                    typedTimer = setTimeout(() => {
                        conn.accessor = matchingOpt.value;
                        conn.swizzle = matchingOpt.value;
                        menu.remove();
                        document.removeEventListener('keydown', handleKeyDown);
                        document.removeEventListener('mousedown', closeMenu);
                        this.render();
                        if (this.onGraphChanged) this.onGraphChanged();
                    }, 400);
                } else if (typedSwizzle.length >= 2 || e.key === '.') {
                    // If no match and we've typed 2+ chars or a period, show custom input
                    clearTimeout(typedTimer);
                    showCustomInput();
                }
            } else if (e.key === 'Backspace') {
                e.preventDefault();
                if (typedTimer) {
                    clearTimeout(typedTimer);
                    typedTimer = null;
                }
                typedSwizzle = typedSwizzle.slice(0, -1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (typedTimer) {
                    clearTimeout(typedTimer);
                }
                // Find the currently highlighted option
                const matchingOpt = options.find(opt => !opt.spacer && !opt.custom && opt.value === `.${typedSwizzle}`);
                if (matchingOpt) {
                    conn.accessor = matchingOpt.value;
                    conn.swizzle = matchingOpt.value;
                } else if (typedSwizzle) {
                    // Apply custom typed swizzle
                    conn.accessor = `.${typedSwizzle}`;
                    conn.swizzle = `.${typedSwizzle}`;
                }
                menu.remove();
                document.removeEventListener('keydown', handleKeyDown);
                document.removeEventListener('mousedown', closeMenu);
                this.render();
                if (this.onGraphChanged) this.onGraphChanged();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                if (typedTimer) {
                    clearTimeout(typedTimer);
                }
                menu.remove();
                document.removeEventListener('keydown', handleKeyDown);
                document.removeEventListener('mousedown', closeMenu);
            }
        };

        document.addEventListener('keydown', handleKeyDown);

        // Close on click outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu);
                document.removeEventListener('keydown', handleKeyDown);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
    }

    getSwizzleOptions(type, currentSwizzle) {
        const options = [];

        // Check if this is a struct type
        if (TypeRegistry && TypeRegistry.isStruct && TypeRegistry.isStruct(type)) {
            const typeDef = TypeRegistry.getType(type);
            if (typeDef && typeDef.members) {
                // Add struct members
                for (const member of typeDef.members) {
                    options.push({
                        label: member.name,
                        value: `.${member.name}`,
                        type: member.type
                    });

                    // If the member is a vector type, add common swizzles
                    if (member.type === 'vec2' || member.type === 'vec3' || member.type === 'vec4') {
                        options.push({
                            label: `${member.name} › x`,
                            value: `.${member.name}.x`,
                            type: 'float'
                        });
                        options.push({
                            label: `${member.name} › y`,
                            value: `.${member.name}.y`,
                            type: 'float'
                        });
                        if (member.type === 'vec3' || member.type === 'vec4') {
                            options.push({
                                label: `${member.name} › z`,
                                value: `.${member.name}.z`,
                                type: 'float'
                            });
                        }
                        if (member.type === 'vec4') {
                            options.push({
                                label: `${member.name} › w`,
                                value: `.${member.name}.w`,
                                type: 'float'
                            });
                        }
                    }
                }

                // Add custom option
                options.push({ label: 'other...', value: 'custom', span: 2, custom: true });
            }
        } else if (type === 'vec2') {
            // Layout:
            // xy (spanning 2 cols)
            // x  | y
            // other (spanning 2 cols)
            options.push(
                { label: 'xy', value: '.xy', span: 2 },
                { label: 'x', value: '.x' },
                { label: 'y', value: '.y' },
                { label: 'other...', value: 'custom', span: 2, custom: true }
            );
        } else if (type === 'vec3') {
            // Layout:
            // xyz | rgb
            // x   | r
            // y   | g
            // z   | b
            // other (spanning 2 cols)
            options.push(
                { label: 'xyz', value: '.xyz' },
                { label: 'rgb', value: '.rgb' },
                { label: 'x', value: '.x' },
                { label: 'r', value: '.r' },
                { label: 'y', value: '.y' },
                { label: 'g', value: '.g' },
                { label: 'z', value: '.z' },
                { label: 'b', value: '.b' },
                { label: 'other...', value: 'custom', span: 2, custom: true }
            );
        } else if (type === 'vec4') {
            // Layout:
            // xyz | rgb
            // x   | r
            // y   | g
            // z   | b
            // w   | a
            // other (spanning 2 cols)
            options.push(
                { label: 'xyz', value: '.xyz' },
                { label: 'rgb', value: '.rgb' },
                { label: 'x', value: '.x' },
                { label: 'r', value: '.r' },
                { label: 'y', value: '.y' },
                { label: 'g', value: '.g' },
                { label: 'z', value: '.z' },
                { label: 'b', value: '.b' },
                { label: 'w', value: '.w' },
                { label: 'a', value: '.a' },
                { label: 'other...', value: 'custom', span: 2, custom: true }
            );
        }

        // Add clear option if there's a current swizzle
        if (currentSwizzle) {
            options.push({ label: 'clear', value: null, span: 2 });
        }

        return options;
    }

    // Check if we can create a constant node for this type
    canCreateConstantFor(type) {
        const constantTypes = {
            'float': 'Float',
            'vec2': 'Vec2',
            'vec3': 'Vec3',
            'vec4': 'Vec4',
            'int': 'Int',
            'bool': 'Bool'
        };
        return constantTypes[type] !== undefined;
    }

    // Check if we can create a preview node for this type (float/vec outputs)
    canCreatePreviewFor(type) {
        // 'any' = generic library output not resolved yet; samplers preview as images
        return ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'any', 'sampler2D'].includes(type);
    }

    // Create a constant node and connect it to the input
    createConstantNodeForInput(targetNode, inputIndex, inputType, dropX, dropY) {
        const constantTypes = {
            'float': 'Float',
            'vec2': 'Vec2',
            'vec3': 'Vec3',
            'vec4': 'Vec4',
            'int': 'Int',
            'bool': 'Bool'
        };

        const nodeType = constantTypes[inputType];
        if (!nodeType) return;

        // Position the constant node to the left of where we dropped
        const nodeX = dropX - 100;
        const nodeY = dropY - 40;

        // Create the constant node
        const constantNode = this.addNode(nodeType, nodeX, nodeY);

        // Connect it to the target input
        this.connections.push(new Connection(
            constantNode,
            0, // Constant nodes have output at index 0
            targetNode,
            inputIndex
        ));

    }

    // Create a specific node type (from defaultNode attribute) and connect it to the input
    createDefaultNodeForInput(targetNode, inputIndex, nodeType, dropX, dropY) {
        // Position the node to the left of where we dropped
        const nodeX = dropX - 100;
        const nodeY = dropY - 40;

        // Create the specified node
        const newNode = this.addNode(nodeType, nodeX, nodeY);
        if (!newNode) {
            console.warn(`Failed to create default node of type: ${nodeType}`);
            return;
        }

        // Connect it to the target input (assuming output at index 0)
        this.connections.push(new Connection(
            newNode,
            0,
            targetNode,
            inputIndex
        ));
    }

    // Create a preview node and connect the output to it
    createPreviewNodeForOutput(sourceNode, outputIndex, outputType, dropX, dropY) {
        // Position the preview node to the right of where we dropped
        const nodeX = dropX + 20;
        const nodeY = dropY - 100;

        // Create the preview node
        const previewNode = this.addNode('Preview', nodeX, nodeY);
        if (!previewNode) {
            console.warn('Failed to create preview node');
            return;
        }

        // Convert the output to vec4 if needed using a conversion strategy
        // For now, just connect directly and let the type system handle it
        this.connections.push(new Connection(
            sourceNode,
            outputIndex,
            previewNode,
            0  // Preview node's color input
        ));
    }

    // Export a minimal, readable representation of the graph for debugging
    exportMinimal() {
        return {
            nodes: this.nodes.map(n => ({
                id: n.id,
                type: n.type,
                data: n.data, // Include data for uniforms/values
                inputs: n.inputs.map(i => i.name),
                outputs: n.outputs.map(o => o.name)
            })),
            connections: this.connections.map(c => ({
                from: `${c.fromNode.type}[${c.fromNode.id}].${c.fromNode.outputs[c.fromOutput]?.name || c.fromOutput}`,
                to: `${c.toNode.type}[${c.toNode.id}].${c.toNode.inputs[c.toInput]?.name || c.toInput}`,
                accessor: c.accessor || null
            }))
        };
    }

    serialize() {
        // Always save the root view, whichever group is open (the open scope is not saved)
        const view = this.groupCtl ? this.groupCtl.rootView() : { panX: this.panX, panY: this.panY, zoom: this.zoom };
        // Nodes that couldn't be restored (unknown type) are written back unchanged
        const live = new Set(this.nodes.map(n => n.id));
        const missing = (this.missingNodes || []).filter(n => !live.has(n.id));
        const missingIds = new Set(missing.map(n => n.id));
        const known = (id) => live.has(id) || missingIds.has(id);
        const data = {
            nodes: [...this.nodes.map(n => n.serialize()), ...missing],
            connections: [
                ...this.connections.map(c => ({
                    fromId: c.fromNode.id,
                    fromOutput: c.fromOutput,
                    toId: c.toNode.id,
                    toInput: c.toInput,
                    swizzle: c.swizzle
                })),
                ...(this.missingConnections || []).filter(c => known(c.fromId) && known(c.toId))
            ],
            nextNodeId: this.nextNodeId,
            panX: view.panX,
            panY: view.panY,
            zoom: view.zoom
        };
        // Node groups (view/organization metadata; omitted when there are none)
        const groups = this.groupCtl ? this.groupCtl.serializeGroups() : [];
        if (groups.length) data.groups = groups;
        return data;
    }

    /**
     * Free what the given nodes hold - Preview renderers (render target, program reference),
     * Feedback buffers, image / JS textures, camera / screen / video streams, MIDI and key
     * listeners - before they are dropped without a delete (project load, New project).
     */
    disposeNodes(list) {
        for (const node of list) {
            if (node.isPreviewNode) {
                try { node.renderer && node.renderer.destroy(); } catch (e) { /* ignore */ }
                this.previewNodes.delete(node.id);
            }
            try {
                if (node.cleanup) node.cleanup();
            } catch (e) {
                console.warn(`[graph] cleanup of ${node.type} #${node.id} failed:`, e);
            }
        }
    }

    deserialize(data) {
        // Free the replaced nodes' GPU objects, streams and listeners (the renderers stop drawing)
        this.disposeNodes(this.nodes);
        if (this.sharedGL) { try { programCache(this.sharedGL).newEpoch(); } catch (e) { /* ignore */ } }
        // Live uniform values, control plan, JS runtime and audio-texture history of the old project
        resetProjectRuntime(this);
        // Gestures in progress refer to the old nodes
        this.connectingFrom = null;
        this.swizzleHint = '';
        this.swizzleHintSuggestion = null;
        this.draggedNode = null;
        this.resizingNode = null;
        this.focusedTextInput = null;
        this.focusedNode = null;
        try { if (this.quickNodeSearch?.hasGhostNode?.()) this.quickNodeSearch.cancelGhostNode(); } catch (e) { /* ignore */ }

        // Clear existing
        this.nodes = [];
        this.connections = [];
        this.selectionManager.selectedNodes.clear();

        // Clear background renderer when loading a new project
        if (this.onPreviewBackground) {
            this.onPreviewBackground(null);
        }

        // Restore pan offset and zoom
        this.panX = data.panX || 0;
        this.panY = data.panY || 0;
        this.zoom = data.zoom || 1.0;

        // Recreate nodes. A node whose type is unknown (e.g. a custom node that isn't
        // registered) or that fails to build is kept as raw data (missingNodes) and
        // written back by serialize(), so a partial load never loses it.
        const idMap = new Map();
        this.missingNodes = [];
        this.missingConnections = [];
        const missingIds = new Set();
        for (const nodeData of (Array.isArray(data.nodes) ? data.nodes : [])) {
            let node = null;
            try {
                node = deserializeNode(nodeData, this.canvas, this.videoElement, this.sharedGL);
            } catch (e) {
                console.warn(`[graph] node ${nodeData && nodeData.id} (${nodeData && nodeData.type}) could not be restored:`, e);
                node = null;
            }
            if (!node) {
                if (nodeData && typeof nodeData === 'object') {
                    this.missingNodes.push(JSON.parse(JSON.stringify(nodeData)));
                    missingIds.add(nodeData.id);
                }
                continue;
            }
            node.graph = this;
            this.nodes.push(node);
            idMap.set(nodeData.id, node);

            // Register preview renderer if it's a preview node
            if (node instanceof PreviewNodeClass) {
                this.previewNodes.set(node.id, node.renderer);
            }
        }

        // Restore nextNodeId (never reuse the id of a node kept as raw data)
        this.nextNodeId = data.nextNodeId || 0;
        for (const raw of this.missingNodes) {
            if (Number.isFinite(Number(raw.id)) && Number(raw.id) >= this.nextNodeId) this.nextNodeId = Number(raw.id) + 1;
        }
        if (!Array.isArray(data.connections)) data = { ...data, connections: [] };

        // First pass: Check blend nodes and add necessary inputs based on connections
        for (const node of this.nodes) {
            if (node.isDynamicInput && node.type === 'Blend') {
                // Find the highest input index that will be connected to this blend node
                let maxInputIndex = -1; // Start with -1, will find actual max from connections

                for (const connData of data.connections) {
                    if (connData.toId === node.id) {
                        // Check if this is a blend input connection (not the index input)
                        // We need to check the toInput index corresponds to an input that starts with 'input'
                        // The connection stores the input index, not the name
                        if (connData.toInput > 0) { // Skip index input at position 0
                            // Calculate which input this would be
                            // toInput 1 = input0, toInput 2 = input1, etc.
                            const inputNum = connData.toInput - 1;
                            if (inputNum > maxInputIndex) {
                                maxInputIndex = inputNum;
                            }
                        }
                    }
                }

                // If no connections found, default to having 0 and 1 (minInputs = 2)
                if (maxInputIndex === -1) {
                    maxInputIndex = 1; // We want 0 and 1 at minimum
                }

                // Add inputs up to maxInputIndex + 1 (to have one free input)
                // We need to add inputs until we have enough
                // Current inputs: index (0), 0 (1), 1 (2)...
                while (node.inputs.filter(i => i.name !== 'index' && /^\d+$/.test(i.name)).length <= maxInputIndex + 1) {
                    node.addDynamicInput();
                }
            }

            // Handle ForLoopStart and ForLoopEnd nodes - restore varTypes and update ports
            if (node.isForLoopStartNode || node.isForLoopEndNode) {
                // The varTypes should already be in node.data from deserialization
                // Just need to trigger port rebuild
                node.updatePorts();
            }
        }

        // Second pass: Update ForLoopEnd nodes to read from their paired ForLoopStart
        // ForLoopStart is the authoritative source, ForLoopEnd just reads from it
        for (const node of this.nodes) {
            if (node.isForLoopEndNode && node.data.pairNodeId != null) {
                // Trigger port rebuild which will read from the paired ForLoopStart
                node.updatePorts();
            }
        }

        // Recreate connections
        for (const connData of data.connections) {
            const fromNode = idMap.get(connData.fromId);
            const toNode = idMap.get(connData.toId);
            if (fromNode && toNode) {
                this.connections.push(new Connection(
                    fromNode,
                    connData.fromOutput,
                    toNode,
                    connData.toInput,
                    connData.swizzle || null
                ));
            } else if (missingIds.has(connData.fromId) || missingIds.has(connData.toId)) {
                // Wire of a node kept as raw data: keep it too
                this.missingConnections.push({ ...connData });
            } else {
                console.warn('Skipping orphaned connection:', connData);
            }
        }

        // Node groups (older projects have none); always reopens at the root
        this.groupCtl.load(data.groups || []);

        // Restore background renderer state if a preview node was marked as background
        const backgroundNode = this.nodes.find(n => n instanceof PreviewNodeClass && n.isBackground);
        if (backgroundNode && this.onPreviewBackground) {
            this.onPreviewBackground(backgroundNode);
        }

        this.render();
        if (this.onGraphChanged) this.onGraphChanged();
    }

    // Clean up any orphaned connections (connections with null nodes)
    cleanupOrphanedConnections() {
        const before = this.connections.length;
        this.connections = this.connections.filter(conn => conn.fromNode && conn.toNode);
        const after = this.connections.length;
        if (before !== after) {
            console.warn(`Cleaned up ${before - after} orphaned connection(s)`);
            if (this.onGraphChanged) this.onGraphChanged();
            this.render();
        }
    }

    /**
     * Helper method called by QuickNodeSearch to create ghost nodes
     */
    createGhostNode(nodeType) {
        const node = NodeFactory.createNode(nodeType, this.nextNodeId++, this.mouseX, this.mouseY, this.canvas, this.videoElement, this.sharedGL);

        if (!node) {
            console.error(`Failed to create ghost node of type: ${nodeType}`);
            return;
        }

        node.graph = this;
        this.quickNodeSearch.setGhostNode(node);
        this.render();
    }
}
