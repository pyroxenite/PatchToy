import { Node } from "../nodes/Node.js";
import { NodeDefinitions } from './NodeDefinitions.js';
import { PreviewNode as PreviewNodeClass } from '../nodes/PreviewNode.js';
import { QuickNodeSearch } from '../ui/QuickNodeSearch.js';
import { SelectionManager } from '../graph/SelectionManager.js';
import { NodeFactory } from '../graph/NodeFactory.js';
import { TypeRegistry } from './TypeRegistry.js';

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
            console.warn('Connection has null node reference');
            return { x: 0, y: 0 };
        }

        const from = this.fromNode.getOutputPortPosition(this.fromOutput);
        const to = this.toNode.getInputPortPosition(this.toInput);

        // Safety check: if port positions are invalid
        if (!from || !to) {
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
        const width = label.length * 7 + 10;
        const height = 18;

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

        this.setupEventListeners();
        this.startUpdateLoop();
    }

    setupEventListeners() {
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
        this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

        // Keyboard events
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('paste', (e) => this.onPaste(e));
    }

    onWheel(e) {
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

            // Apply zoom
            const zoomDelta = -e.deltaY * 0.001;
            const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * (1 + zoomDelta)));

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

        // Find clicked node
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            if (this.nodes[i].containsPoint(pos.x, pos.y)) {
                if (this.onNodeRightClick) {
                    this.onNodeRightClick(this.nodes[i], e);
                }
                return;
            }
        }
    }

    onDoubleClick(e) {
        const pos = this.getMousePos(e);

        // Find double-clicked node
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            if (this.nodes[i].containsPoint(pos.x, pos.y)) {
                if (this.onNodeRightClick) {
                    this.onNodeRightClick(this.nodes[i], e);
                }
                return;
            }
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

            // Check if we need to render
            const needsRender = this.focusedTextInput || this.nodes.some(n => n.isPreviewNode);

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

        // Delete/Backspace - delete selected nodes
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectionManager.selectedNodes.size > 0) {
            e.preventDefault();
            this.deleteSelectedNodes();
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

        // Escape - clear selection or cancel ghost node
        if (e.key === 'Escape') {
            if (this.quickNodeSearch.hasGhostNode()) {
                this.quickNodeSearch.cancelGhostNode();
            } else {
                this.clearSelection();
            }
        }

        // Tab - open quick node search
        if (e.key === 'Tab') {
            e.preventDefault();
            this.quickNodeSearch.show(this.addNodeButton);
        }
    }

    deleteSelectedNodes() {
        // Add paired ForLoop nodes to selection if one is selected
        const nodesToDelete = new Set(this.selectionManager.selectedNodes);
        for (const node of this.selectionManager.selectedNodes) {
            if ((node.isForLoopStartNode || node.isForLoopEndNode) && node.data.pairNodeId) {
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

        // Check if we need to disable buttons after deletion
        this.updateDeviceButtonStates();

        this.selectionManager.selectedNodes.clear();
        if (this.onGraphChanged) this.onGraphChanged();
        this.render();
    }

    updateDeviceButtonStates() {
        // Check if any camera nodes remain
        const hasCameraNodes = this.nodes.some(n => n.isCameraNode);
        if (!hasCameraNodes) {
            const cameraBtn = document.getElementById('cameraBtn');
            if (cameraBtn) {
                cameraBtn.style.background = 'transparent';
                cameraBtn.style.borderColor = '#444';
                cameraBtn.title = 'Camera';
            }
        }

        // Check if any microphone nodes remain
        const hasMicNodes = this.nodes.some(n => n.isMicrophoneNode);
        if (!hasMicNodes) {
            const micBtn = document.getElementById('micBtn');
            if (micBtn) {
                micBtn.style.background = 'transparent';
                micBtn.style.borderColor = '#444';
                micBtn.title = 'Microphone';
            }
        }

        // Check if any MIDI CC nodes remain
        const hasMidiNodes = this.nodes.some(n => n.isMidiCCNode);
        if (!hasMidiNodes) {
            const midiBtn = document.getElementById('midiBtn');
            if (midiBtn) {
                midiBtn.style.background = 'transparent';
                midiBtn.style.borderColor = '#444';
                midiBtn.title = 'MIDI';
            }
        }

        // Check if any screen capture nodes remain
        const hasScreenCaptureNodes = this.nodes.some(n => n.isScreenCaptureNode);
        if (!hasScreenCaptureNodes) {
            const screenCaptureBtn = document.getElementById('screenCaptureBtn');
            if (screenCaptureBtn) {
                screenCaptureBtn.style.background = 'transparent';
                screenCaptureBtn.style.borderColor = '#444';
                screenCaptureBtn.title = 'Screen Capture';
            }
        }
    }

    copySelectedNodes() {
        const nodesToCopy = Array.from(this.selectionManager.selectedNodes);
        const connectionsToCopy = this.connections.filter(conn =>
            this.selectionManager.selectedNodes.has(conn.fromNode) && this.selectionManager.selectedNodes.has(conn.toNode)
        );

        this.clipboard = {
            nodes: nodesToCopy.map(n => n.serialize()),
            connections: connectionsToCopy.map(c => ({
                fromId: c.fromNode.id,
                fromOutput: c.fromOutput,
                toId: c.toNode.id,
                toInput: c.toInput,
                swizzle: c.swizzle
            }))
        };

        console.log('Copied', nodesToCopy.length, 'nodes');
    }

    cutSelectedNodes() {
        this.copySelectedNodes();
        this.deleteSelectedNodes();
    }

    pasteNodes() {
        if (!this.clipboard) return;

        const idMap = new Map();
        const newNodes = [];

        // Create new nodes with new IDs, offset by 20px
        for (const nodeData of this.clipboard.nodes) {
            const newNode = deserializeNode({
                ...nodeData,
                id: this.nextNodeId++,
                x: nodeData.x + 20,
                y: nodeData.y + 20
            }, this.canvas, this.videoElement, this.sharedGL);
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

        if (this.onGraphChanged) this.onGraphChanged();
        this.render();
    }

    selectAll() {
        this.selectionManager.selectedNodes.clear();
        this.nodes.forEach(node => this.selectionManager.selectedNodes.add(node));
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
        // Ignore right-clicks (they're handled by onContextMenu)
        if (e.button === 2) {
            return;
        }

        const pos = this.getMousePos(e);

        // If ghost node exists, place it
        if (this.quickNodeSearch.placeGhostNode()) {
            return;
        }

        // Check nodes first (in reverse order for z-index) since they render on top
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const node = this.nodes[i];

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
        for (const conn of this.connections) {
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
                this.connectingFrom = {
                    node: result.node,
                    outputIndex: result.outputIndex
                };
                break;

            case 'CLICKED_INPUT_PORT':
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
                outputIndex: existingConnection.fromOutput
            };

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

        // Move to front
        const index = this.nodes.indexOf(node);
        this.nodes.splice(index, 1);
        this.nodes.push(node);

        this.render();
    }

    onMouseMove(e) {
        const pos = this.getMousePos(e);

        // Skip render if mouse hasn't moved significantly
        const dx = Math.abs(pos.x - (this.mouseX || 0));
        const dy = Math.abs(pos.y - (this.mouseY || 0));
        if (dx < 1 && dy < 1 && !this.connectingFrom && !this.draggingNode && !this.isPanning && !this.resizingNode) {
            return;
        }

        this.mouseX = pos.x;
        this.mouseY = pos.y;

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
                deltaX = node.width - newWidth;
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

            // Select nodes within the box
            for (const node of this.nodes) {
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
            // Update cursor based on hover (use event bubbling)
            let cursorSet = false;
            for (let i = this.nodes.length - 1; i >= 0; i--) {
                const node = this.nodes[i];
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

    onMouseUp(e) {
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
                for (const node of this.nodes) {
                    for (let i = 0; i < node.outputs.length; i++) {
                        const portPos = node.getOutputPortPosition(i);
                        if (!portPos) continue;

                        const dist = Math.hypot(pos.x - portPos.x, pos.y - portPos.y);
                        if (dist < 8 && node !== this.connectingFrom.node) {
                            // Remove any existing connection to this input
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
                // Normal connection: dragging from output, looking for input
                for (const node of this.nodes) {
                    for (let i = 0; i < node.inputs.length; i++) {
                        const portPos = node.getInputPortPosition(i);
                        if (!portPos) continue;

                        const dist = Math.hypot(pos.x - portPos.x, pos.y - portPos.y);
                        if (dist < 8 && node !== this.connectingFrom.node) {
                            // Remove any existing connection to this input
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

                // If dragging from output to void, create a preview node for float/vec types
                if (!connected) {
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
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Render background shader if active
        if (this.backgroundRenderer) {
            this.backgroundRenderer.render(ctx);
        }

        // Force consistent text rendering (Safari fix)
        ctx.save();
        ctx.textBaseline = 'middle';  // Use middle instead of alphabetic for more consistent results
        ctx.textAlign = 'left';

        // Apply pan and zoom transforms
        ctx.translate(this.panX, this.panY);
        ctx.scale(this.zoom, this.zoom);

        // Draw all connections in a single batch
        ctx.strokeStyle = '#007acc';
        ctx.lineWidth = 2;

        // Begin a single path for all non-labeled connections
        ctx.beginPath();
        for (const conn of this.connections) {
            if (conn.swizzle) continue; // Draw these separately with labels

            const fromPos = conn.fromNode.getOutputPortPosition(conn.fromOutput);
            const toPos = conn.toNode.getInputPortPosition(conn.toInput);

            if (!fromPos || !toPos) continue;

            ctx.moveTo(fromPos.x, fromPos.y);

            // Simplified bezier calculation
            const xDiff = toPos.x - fromPos.x;
            const ctrl = Math.min(Math.abs(xDiff) * 0.5, 100);
            ctx.bezierCurveTo(
                fromPos.x + ctrl, fromPos.y,
                toPos.x - ctrl, toPos.y,
                toPos.x, toPos.y
            );
        }
        ctx.stroke();

        // Draw clickable dots for non-swizzled connections
        ctx.fillStyle = 'rgba(0, 122, 204, 0.4)';
        for (const conn of this.connections) {
            if (conn.swizzle) continue;
            const mid = conn.getMidpoint();
            ctx.beginPath();
            ctx.arc(mid.x, mid.y, 4, 0, Math.PI * 2);
            ctx.fill();
        }

        // Draw labeled connections separately
        for (const conn of this.connections) {
            if (!conn.swizzle) continue;

            const fromPos = conn.fromNode.getOutputPortPosition(conn.fromOutput);
            const toPos = conn.toNode.getInputPortPosition(conn.toInput);

            if (!fromPos || !toPos) continue;

            ctx.beginPath();
            ctx.moveTo(fromPos.x, fromPos.y);

            const xDiff = toPos.x - fromPos.x;
            const ctrl = Math.min(Math.abs(xDiff) * 0.5, 100);
            ctx.bezierCurveTo(
                fromPos.x + ctrl, fromPos.y,
                toPos.x - ctrl, toPos.y,
                toPos.x, toPos.y
            );
            ctx.stroke();

            const mid = conn.getMidpoint();

            // Draw connection label (only if swizzled)
            if (conn.swizzle) {
                const label = conn.getLabel();

                // Cache text measurements
                const cacheKey = `swizzle_${label}`;
                let textWidth = this.textMeasureCache?.get(cacheKey);
                if (!textWidth) {
                    ctx.font = '10px -apple-system, sans-serif';
                    textWidth = ctx.measureText(label).width;
                    if (!this.textMeasureCache) this.textMeasureCache = new Map();
                    this.textMeasureCache.set(cacheKey, textWidth);
                } else {
                    ctx.font = '10px -apple-system, sans-serif';
                }

                const padding = 4;
                const labelHeight = 14;

                // Background - semi-transparent with rounded corners
                ctx.fillStyle = 'rgba(45, 45, 45, 0.85)';
                ctx.beginPath();
                ctx.roundRect(mid.x - textWidth / 2 - padding, mid.y - labelHeight / 2, textWidth + padding * 2, labelHeight, 3);
                ctx.fill();

                // Border - more subtle with rounded corners
                ctx.strokeStyle = 'rgba(0, 122, 204, 0.5)';
                ctx.lineWidth = 1;
                ctx.stroke();

                // Text - slightly dimmed
                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.fillText(label, mid.x - textWidth / 2, mid.y);

                // Restore state for next connection
                ctx.strokeStyle = '#007acc';
                ctx.lineWidth = 2;
            }
        }

        // Draw temporary connection line
        if (this.connectingFrom) {
            let fromPos;
            if (this.connectingFrom.isReverse) {
                // Dragging from input port
                fromPos = this.connectingFrom.node.getInputPortPosition(
                    this.connectingFrom.inputIndex
                );
            } else {
                // Dragging from output port
                fromPos = this.connectingFrom.node.getOutputPortPosition(
                    this.connectingFrom.outputIndex
                );
            }

            if (fromPos) {
                ctx.strokeStyle = '#0098ff';
                ctx.setLineDash([5, 5]);
                ctx.beginPath();
                ctx.moveTo(fromPos.x, fromPos.y);
                ctx.lineTo(this.mouseX, this.mouseY);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Draw nodes - wrap each in save/restore to prevent state leakage
        for (const node of this.nodes) {
            ctx.save();
            // Reset text properties to defaults for each node
            ctx.font = '12px "Pixeloid Sans"';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';

            node.draw(this.ctx, {
                isSelected: this.selectionManager.selectedNodes.has(node),
                connections: this.connections
            });

            ctx.restore();
        }

        // Draw ghost node if exists (semi-transparent)
        this.quickNodeSearch.drawGhostNode(ctx);

        // Draw rubberband selection box
        if (this.selectionBox) {
            ctx.strokeStyle = '#007acc';
            ctx.fillStyle = 'rgba(0, 122, 204, 0.1)';
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 5]);
            ctx.fillRect(this.selectionBox.x, this.selectionBox.y,
                this.selectionBox.width, this.selectionBox.height);
            ctx.strokeRect(this.selectionBox.x, this.selectionBox.y,
                this.selectionBox.width, this.selectionBox.height);
            ctx.setLineDash([]);
        }

        // Draw swizzle hint on top of everything when dragging connection
        if (this.connectingFrom && this.swizzleHint) {
            // Format text with chevrons instead of dots for multi-level access
            const typedText = this.swizzleHint.replace(/\./g, ' › ');
            const remainingSuggestion = this.swizzleHintSuggestion ?
                this.swizzleHintSuggestion.substring(this.swizzleHint.length).replace(/\./g, ' › ') : null;

            ctx.font = 'bold 14px -apple-system, sans-serif';

            // Calculate widths for typed text and suggestion
            const typedWidth = ctx.measureText(typedText).width;
            const suggestionWidth = remainingSuggestion ? ctx.measureText(remainingSuggestion).width : 0;
            const totalWidth = typedWidth + suggestionWidth;

            const padding = 6;
            const labelHeight = 20;
            const offsetX = 15;
            const offsetY = 15;

            // Background with stronger visibility
            ctx.fillStyle = 'rgba(0, 122, 204, 0.95)';
            ctx.beginPath();
            ctx.roundRect(
                this.mouseX + offsetX,
                this.mouseY + offsetY,
                totalWidth + padding * 2,
                labelHeight,
                4
            );
            ctx.fill();

            // Border
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Draw typed text - white and bold for visibility
            ctx.fillStyle = '#ffffff';
            ctx.fillText(
                typedText,
                this.mouseX + offsetX + padding,
                this.mouseY + offsetY + labelHeight / 2
            );

            // Draw autocomplete suggestion - grayed out
            if (remainingSuggestion) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
                ctx.fillText(
                    remainingSuggestion,
                    this.mouseX + offsetX + padding + typedWidth,
                    this.mouseY + offsetY + labelHeight / 2
                );
            }
        }

        ctx.restore();
    }

    showConnectionMenu(conn, e) {
        const outputType = conn.fromNode.outputs[conn.fromOutput].type;

        // Get available swizzle options based on type
        const options = this.getSwizzleOptions(outputType, conn.swizzle);

        // Even if no swizzle options, still show menu for type inspection
        // if (options.length === 0) return;

        // Create menu
        const menu = document.createElement('div');
        menu.style.position = 'fixed';
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.style.background = '#2d2d2d';
        menu.style.border = '1px solid #007acc';
        menu.style.borderRadius = '4px';
        menu.style.padding = '8px';
        menu.style.zIndex = '10000';
        menu.style.display = 'flex';
        menu.style.flexDirection = 'column';
        menu.style.gap = '4px';

        // Add type header
        const header = document.createElement('div');
        header.textContent = outputType;
        header.style.fontSize = '11px';
        header.style.color = '#888';
        header.style.textAlign = 'center';
        header.style.paddingBottom = '4px';
        header.style.borderBottom = '1px solid #444';
        header.style.marginBottom = '4px';
        header.style.userSelect = 'none';
        menu.appendChild(header);

        // Create grid for options
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gap = '4px';

        // Configure grid based on type
        if (outputType === 'vec2') {
            grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
        } else if (outputType === 'vec3' || outputType === 'vec4') {
            grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
        }

        menu.appendChild(grid);

        // Add options
        options.forEach(opt => {
            const item = document.createElement('div');
            item.textContent = opt.label;
            item.style.padding = '6px 10px';
            item.style.color = '#fff';
            item.style.fontSize = '12px';
            item.style.textAlign = 'center';
            item.style.borderRadius = '3px';
            item.style.userSelect = 'none';

            // Handle column spanning
            if (opt.span) {
                item.style.gridColumn = `span ${opt.span}`;
            }

            // Handle spacer items
            if (opt.spacer) {
                item.style.cursor = 'default';
                item.style.visibility = 'hidden';
                item.dataset.spacer = 'true';
            } else {
                item.style.cursor = 'pointer';

                if (conn.swizzle === opt.value) {
                    item.style.background = '#007acc';
                }

                item.addEventListener('mouseenter', () => {
                    item.style.background = '#007acc';
                });
                item.addEventListener('mouseleave', () => {
                    if (conn.swizzle !== opt.value) {
                        item.style.background = 'transparent';
                    }
                });
                item.addEventListener('click', () => {
                    if (opt.custom) {
                        // Show custom input field instead of prompt
                        showCustomInput();
                    } else {
                        conn.accessor = opt.value;
                        conn.swizzle = opt.value; // Keep backwards compatibility
                        menu.remove();
                        this.render();
                        if (this.onGraphChanged) this.onGraphChanged();
                    }
                });
            }

            grid.appendChild(item);
        });

        document.body.appendChild(menu);

        // Track typed swizzle string
        let typedSwizzle = '';
        let typedTimer = null;
        let customInputActive = false;

        const selectOption = (swizzleValue) => {
            const items = Array.from(grid.children).filter(item => !item.dataset.spacer);
            items.forEach((item, i) => {
                const opt = options[i];
                if (opt && opt.value === swizzleValue) {
                    item.style.background = '#007acc';
                } else if (opt && conn.swizzle !== opt.value) {
                    item.style.background = 'transparent';
                }
            });
        };

        const showCustomInput = () => {
            customInputActive = true;

            // Replace grid with text input
            grid.style.display = 'none';

            // Create input field
            const inputContainer = document.createElement('div');
            inputContainer.style.padding = '4px';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'e.g., xy, xz, rgb, position.xy';
            input.value = typedSwizzle || '';
            input.style.width = '100%';
            input.style.padding = '6px';
            input.style.background = '#1e1e1e';
            input.style.border = '1px solid #007acc';
            input.style.borderRadius = '3px';
            input.style.color = '#fff';
            input.style.fontSize = '12px';
            input.style.fontFamily = 'monospace';
            input.style.outline = 'none';

            inputContainer.appendChild(input);
            menu.appendChild(inputContainer);

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
        return type === 'float' || type === 'vec2' || type === 'vec3' || type === 'vec4';
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
        return {
            nodes: this.nodes.map(n => n.serialize()),
            connections: this.connections.map(c => ({
                fromId: c.fromNode.id,
                fromOutput: c.fromOutput,
                toId: c.toNode.id,
                toInput: c.toInput,
                swizzle: c.swizzle
            })),
            nextNodeId: this.nextNodeId,
            panX: this.panX,
            panY: this.panY,
            zoom: this.zoom
        };
    }

    deserialize(data) {
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

        // Recreate nodes
        const idMap = new Map();
        for (const nodeData of data.nodes) {
            const node = deserializeNode(nodeData, this.canvas, this.videoElement, this.sharedGL);
            node.graph = this;
            this.nodes.push(node);
            idMap.set(nodeData.id, node);

            // Register preview renderer if it's a preview node
            if (node instanceof PreviewNodeClass) {
                this.previewNodes.set(node.id, node.renderer);
            }
        }

        // Restore nextNodeId
        this.nextNodeId = data.nextNodeId || 0;

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
            if (node.isForLoopEndNode && node.data.pairNodeId) {
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
            } else {
                console.warn('Skipping orphaned connection:', connData);
            }
        }

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
