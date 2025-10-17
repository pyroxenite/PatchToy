import { Node } from "../nodes/Node.js";
import { NodeDefinitions } from './NodeDefinitions.js';
import { PreviewNode as PreviewNodeClass } from '../nodes/PreviewNode.js';
import { QuickNodeSearch } from '../ui/QuickNodeSearch.js';
import { SelectionManager } from '../graph/SelectionManager.js';
import { NodeFactory } from '../graph/NodeFactory.js';

// Re-export Node for backwards compatibility
export { Node };

// Static deserialize helper for nodes - now uses NodeFactory
function deserializeNode(json, canvas, videoElement) {
    return NodeFactory.deserializeNode(json, canvas, videoElement);
}

export class Connection {
    constructor(fromNode, fromOutput, toNode, toInput, swizzle = null) {
        this.fromNode = fromNode;
        this.fromOutput = fromOutput;
        this.toNode = toNode;
        this.toInput = toInput;
        this.swizzle = swizzle;  // e.g., null (full value), ".x", ".xy", ".rgb", etc.
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
        if (this.swizzle) {
            // Remove the dot from swizzle display
            return this.swizzle.replace('.', '');
        }
        // Don't show type label if no swizzle
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
        this.mouseX = 0;
        this.mouseY = 0;

        // Pan offset for scrolling the canvas
        this.panX = 0;
        this.panY = 0;

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
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

        // Keyboard events
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
    }

    onWheel(e) {
        e.preventDefault();

        // Update pan offset based on scroll
        this.panX -= e.deltaX;
        this.panY -= e.deltaY;

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
        // Remove connections to/from selected nodes
        this.connections = this.connections.filter(conn =>
            !this.selectionManager.selectedNodes.has(conn.fromNode) && !this.selectionManager.selectedNodes.has(conn.toNode)
        );

        // Clean up preview nodes
        for (const node of this.selectionManager.selectedNodes) {
            if (node.isPreviewNode && this.previewNodes.has(node.id)) {
                this.previewNodes.get(node.id).destroy();
                this.previewNodes.delete(node.id);
            }
        }

        // Remove nodes
        this.nodes = this.nodes.filter(node => !this.selectionManager.selectedNodes.has(node));

        this.selectionManager.selectedNodes.clear();
        if (this.onGraphChanged) this.onGraphChanged();
        this.render();
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
            }, this.canvas, this.videoElement);
            newNode.graph = this;  // Set graph reference

            // Register preview renderer if it's a preview node
            if (newNode instanceof PreviewNodeClass) {
                this.previewNodes.set(newNode.id, newNode.renderer);
            }

            idMap.set(nodeData.id, newNode);
            newNodes.push(newNode);
            this.nodes.push(newNode);
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
            x: e.clientX - rect.left - this.panX,
            y: e.clientY - rect.top - this.panY
        };
    }

    onMouseDown(e) {
        const pos = this.getMousePos(e);

        // If ghost node exists, place it
        if (this.quickNodeSearch.placeGhostNode()) {
            return;
        }

        // Check for connection clicks first
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

        // Check nodes (in reverse order for z-index)
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const node = this.nodes[i];
            if (node.containsPoint(pos.x, pos.y)) {
                const result = node.handleMouseDown(pos.x, pos.y, e);
                if (result) {
                    this.handleAction(result, e);
                    return;
                }
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

                            // Create new connection
                            this.connections.push(new Connection(
                                node,
                                i,
                                this.connectingFrom.node,
                                this.connectingFrom.inputIndex
                            ));

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
                    if (inputDef && this.canCreateConstantFor(inputDef.type)) {
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

                            // Create new connection
                            this.connections.push(new Connection(
                                this.connectingFrom.node,
                                this.connectingFrom.outputIndex,
                                node,
                                i
                            ));

                            connected = true;
                            if (this.onGraphChanged) this.onGraphChanged();
                            break;
                        }
                    }
                    if (connected) break;
                }
            }

            this.connectingFrom = null;
        }

        this.draggedNode = null;
        this.selectionBox = null;
        this.selectionStart = null;
        this.render();
    }

    addNode(type, x, y) {
        const node = NodeFactory.createNode(type, this.nextNodeId++, x, y, this.canvas, this.videoElement);

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

        // Apply pan transform
        ctx.translate(this.panX, this.panY);

        // Draw connections
        ctx.strokeStyle = '#007acc';
        ctx.lineWidth = 2;
        for (const conn of this.connections) {
            const fromPos = conn.fromNode.getOutputPortPosition(conn.fromOutput);
            const toPos = conn.toNode.getInputPortPosition(conn.toInput);

            if (!fromPos || !toPos) continue; // Skip if ports not available

            ctx.beginPath();
            ctx.moveTo(fromPos.x, fromPos.y);

            // Bezier curve for nice connection lines
            const xOverShoot = Math.abs(fromPos.x - toPos.x) / 3 + Math.abs(fromPos.y - toPos.y) / 4;
            ctx.bezierCurveTo(
                fromPos.x + xOverShoot, fromPos.y,
                toPos.x - xOverShoot, toPos.y,
                toPos.x, toPos.y
            );
            ctx.stroke();

            const mid = conn.getMidpoint();

            // Draw connection label (only if swizzled)
            if (conn.swizzle) {
                const label = conn.getLabel();
                ctx.font = '10px -apple-system, sans-serif';
                const textWidth = ctx.measureText(label).width;
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
            } else {
                // Draw subtle clickable dot indicator at midpoint
                ctx.fillStyle = 'rgba(0, 122, 204, 0.4)';
                ctx.beginPath();
                ctx.arc(mid.x, mid.y, 4, 0, Math.PI * 2);
                ctx.fill();
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

        // Draw nodes
        for (const node of this.nodes) {
            node.draw(this.ctx, {
                isSelected: this.selectionManager.selectedNodes.has(node),
                connections: this.connections
            });
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
                        // Show custom swizzle input
                        const customSwizzle = prompt('Enter custom swizzle (e.g., xy, xz, yzw):', '');
                        if (customSwizzle !== null && customSwizzle.trim()) {
                            // Add dot prefix if not present
                            conn.swizzle = customSwizzle.startsWith('.') ? customSwizzle : '.' + customSwizzle;
                        }
                    } else {
                        conn.swizzle = opt.value;
                    }
                    menu.remove();
                    this.render();
                    if (this.onGraphChanged) this.onGraphChanged();
                });
            }

            grid.appendChild(item);
        });

        document.body.appendChild(menu);

        // Close on click outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
    }

    getSwizzleOptions(type, currentSwizzle) {
        const options = [];

        if (type === 'vec2') {
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
            'vec4': 'Vec4'
        };
        return constantTypes[type] !== undefined;
    }

    // Create a constant node and connect it to the input
    createConstantNodeForInput(targetNode, inputIndex, inputType, dropX, dropY) {
        const constantTypes = {
            'float': 'Float',
            'vec2': 'Vec2',
            'vec3': 'Vec3',
            'vec4': 'Vec4'
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

        console.log(`Auto-created ${nodeType} node for ${inputType} input`);
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
            panY: this.panY
        };
    }

    deserialize(data) {
        // Clear existing
        this.nodes = [];
        this.connections = [];
        this.selectionManager.selectedNodes.clear();
        this.nextNodeId = data.nextNodeId || 0;

        // Clear background renderer when loading a new project
        if (this.onPreviewBackground) {
            this.onPreviewBackground(null);
        }

        // Restore pan offset
        this.panX = data.panX || 0;
        this.panY = data.panY || 0;

        // Recreate nodes
        const idMap = new Map();
        for (const nodeData of data.nodes) {
            const node = deserializeNode(nodeData, this.canvas, this.videoElement);
            node.graph = this;
            this.nodes.push(node);
            idMap.set(nodeData.id, node);

            // Register preview renderer if it's a preview node
            if (node instanceof PreviewNodeClass) {
                this.previewNodes.set(node.id, node.renderer);
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
        const node = NodeFactory.createNode(nodeType, this.nextNodeId++, this.mouseX, this.mouseY, this.canvas, this.videoElement);

        if (!node) {
            console.error(`Failed to create ghost node of type: ${nodeType}`);
            return;
        }

        node.graph = this;
        this.quickNodeSearch.setGhostNode(node);
        this.render();
    }
}
