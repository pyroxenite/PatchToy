export class SelectionManager {
    constructor() {
        this.selectedNodes = new Set();
        this.selectionBox = null;
    }

    selectNode(node, multiSelect = false) {
        if (!multiSelect) {
            this.selectedNodes.clear();
        }
        this.selectedNodes.add(node);
    }

    deselectNode(node) {
        this.selectedNodes.delete(node);
    }

    toggleSelection(node) {
        if (this.selectedNodes.has(node)) {
            this.selectedNodes.delete(node);
        } else {
            this.selectedNodes.add(node);
        }
    }

    selectAll(nodes) {
        this.selectedNodes.clear();
        for (const node of nodes) {
            this.selectedNodes.add(node);
        }
    }

    clearSelection() {
        this.selectedNodes.clear();
    }

    hasSelection() {
        return this.selectedNodes.size > 0;
    }

    getSelectedNodes() {
        return Array.from(this.selectedNodes);
    }

    isSelected(node) {
        return this.selectedNodes.has(node);
    }

    // Rubberband selection
    startRubberbandSelection(startX, startY) {
        this.selectionBox = {
            startX,
            startY,
            x: startX,
            y: startY,
            width: 0,
            height: 0
        };
    }

    updateRubberbandSelection(currentX, currentY, nodes) {
        if (!this.selectionBox) return;

        const box = this.selectionBox;
        box.width = currentX - box.startX;
        box.height = currentY - box.startY;

        // Normalize box coordinates
        box.x = box.width >= 0 ? box.startX : currentX;
        box.y = box.height >= 0 ? box.startY : currentY;
        box.width = Math.abs(box.width);
        box.height = Math.abs(box.height);

        // Select nodes within box
        this.selectedNodes.clear();
        for (const node of nodes) {
            if (this.isNodeInBox(node, box)) {
                this.selectedNodes.add(node);
            }
        }
    }

    endRubberbandSelection() {
        this.selectionBox = null;
    }

    isNodeInBox(node, box) {
        return (
            node.x < box.x + box.width &&
            node.x + node.width > box.x &&
            node.y < box.y + box.height &&
            node.y + node.height > box.y
        );
    }

    // Clipboard operations
    copy(nodes, connections) {
        const selectedNodes = this.getSelectedNodes();
        if (selectedNodes.length === 0) return null;

        const nodeIds = new Set(selectedNodes.map(n => n.id));

        // Copy node data
        const copiedNodes = selectedNodes.map(node => node.serialize());

        // Copy connections between selected nodes
        const copiedConnections = connections
            .filter(conn => nodeIds.has(conn.fromNode.id) && nodeIds.has(conn.toNode.id))
            .map(conn => ({
                fromNode: conn.fromNode.id,
                fromOutput: conn.fromOutput,
                toNode: conn.toNode.id,
                toInput: conn.toInput,
                swizzle: conn.swizzle
            }));

        return {
            nodes: copiedNodes,
            connections: copiedConnections
        };
    }

    cut(nodes, connections) {
        const clipboardData = this.copy(nodes, connections);
        if (!clipboardData) return null;

        // Store nodes to delete
        const nodesToDelete = this.getSelectedNodes();

        return {
            clipboardData,
            nodesToDelete
        };
    }
}
