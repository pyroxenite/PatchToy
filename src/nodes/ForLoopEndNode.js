import { Node } from './Node.js';

export class ForLoopEndNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isForLoopEndNode = true;
        // Note: We don't set isDynamicInput = true here to allow compiler caching
        // The shouldAddNewInput() and addDynamicInput() methods still work
        this.minInputs = 1; // At least one iteration variable

        // Pair relationship
        if (!this.data.pairNodeId) {
            this.data.pairNodeId = null; // Will be set when paired
        }

        // Track iteration variable types (should match ForLoopStart)
        if (!this.data.varTypes) {
            this.data.varTypes = ['float'];
        }

        this.width = 180;
        this.updatePorts();
    }

    updatePorts() {
        // Get varTypes from paired ForLoopStart node (it's the authoritative source)
        let varTypes = ['float']; // Default

        if (this.data.pairNodeId && this.graph) {
            const pairNode = this.graph.nodes.find(n => n.id === this.data.pairNodeId);
            if (pairNode && pairNode.isForLoopStartNode) {
                varTypes = pairNode.data.varTypes || ['float'];
            }
        } else if (this.data.varTypes) {
            // Fallback to own varTypes (used during initial creation before graph is set)
            varTypes = this.data.varTypes;
        }

        // Clear and rebuild inputs/outputs
        this.inputs = [];
        this.outputs = [];

        // Top input: break condition
        this.inputs.push({ name: 'break', type: 'bool', default: 'false' });

        // Left side inputs: modified intermediate values from loop body
        for (let i = 0; i < varTypes.length; i++) {
            const varType = varTypes[i] || 'float';
            this.inputs.push({ name: `inter${i}`, type: varType });
        }

        // Right side outputs: final values after loop completes
        for (let i = 0; i < varTypes.length; i++) {
            const varType = varTypes[i] || 'float';
            this.outputs.push({ name: `end${i}`, type: varType });
        }

        // Calculate height based on number of variables
        const baseHeight = 80;
        const portSpacing = 25;
        const totalPorts = Math.max(this.inputs.length, this.outputs.length);
        this.height = baseHeight + Math.max(0, totalPorts - 2) * portSpacing;
    }

    // Override port positioning to align outputs with inputs
    getInputPortPosition(index) {
        // Always show break (index 0)
        if (index === 0) {
            return super.getInputPortPosition(index);
        }

        // For inter inputs (index 1+), show if paired ForLoopStart's corresponding input is connected
        if (this.data.pairNodeId && this.graph) {
            const pairNode = this.graph.nodes.find(n => n.id === this.data.pairNodeId);
            if (pairNode && pairNode.isForLoopStartNode) {
                // Check if the corresponding start input on the paired node is connected
                const startInputIndex = index; // inter0 corresponds to start0, which is at index 1
                const isStartConnected = this.graph.connections.some(conn =>
                    conn.toNode === pairNode && conn.toInput === startInputIndex
                );
                if (!isStartConnected) return null; // Hide if paired start input not connected
            }
        }

        return super.getInputPortPosition(index);
    }

    getOutputPortPosition(index) {
        // Align end outputs with their corresponding inter inputs (same y value)
        const inputIndex = index + 1; // +1 because break is at index 0
        const inputPos = this.getInputPortPosition(inputIndex);

        // If input is hidden, hide output too
        if (!inputPos) return null;

        // Use input's y but output's x (right side)
        return { x: this.x + this.width, y: inputPos.y };
    }

    // Override to hide iteration variable port labels
    getInputPortLabel(index) {
        if (index === 0) return this.inputs[0].name; // Show 'break'
        return null; // Hide inter0, inter1, etc.
    }

    getOutputPortLabel(index) {
        return null; // Hide end0, end1, etc.
    }

    // Dynamic input management (following Blend node pattern)
    addDynamicInput() {
        if (!this.isDynamicInput) return false;

        const currentVarCount = this.data.varTypes.length;

        // Add new iteration variable with same type as last one
        const lastType = this.data.varTypes[currentVarCount - 1] || 'float';
        this.data.varTypes.push(lastType);

        this.updatePorts();

        // Sync with paired node if it exists
        this.syncWithPair();

        return true;
    }

    removeDynamicInput(inputName) {
        if (!this.isDynamicInput) return false;

        // Don't allow removing below minimum inputs
        if (this.data.varTypes.length <= this.minInputs) return false;

        // Extract index from input name (e.g., "inter2" -> 2)
        const match = inputName.match(/^inter(\d+)$/);
        if (!match) return false;

        const index = parseInt(match[1]);
        if (index >= this.data.varTypes.length) return false;

        // Remove the variable type
        this.data.varTypes.splice(index, 1);
        this.updatePorts();

        // Sync with paired node
        this.syncWithPair();

        return true;
    }

    shouldAddNewInput() {
        if (!this.isDynamicInput) return false;

        // Inter inputs are all inputs except 'break' (index 0)
        const interInputs = this.inputs.filter(i => i.name.startsWith('inter'));

        // Check if all inter inputs are connected
        for (let i = 0; i < interInputs.length; i++) {
            const inputName = interInputs[i].name;
            const inputIndex = this.inputs.findIndex(input => input.name === inputName);

            if (this.graph) {
                const isConnected = this.graph.connections.some(conn =>
                    conn.toNode === this && conn.toInput === inputIndex
                );

                // If any inter input is not connected, don't add new one
                if (!isConnected) {
                    return false;
                }
            }
        }

        // All inter inputs are connected, add a new one
        return true;
    }

    // Sync configuration with paired ForLoopStart node
    syncWithPair() {
        // ForLoopEnd is read-only - it reads from ForLoopStart
        // If ForLoopEnd tries to add inputs, forward the sync to ForLoopStart
        if (!this.data.pairNodeId || !this.graph) return;

        const pairNode = this.graph.nodes.find(n => n.id === this.data.pairNodeId);
        if (!pairNode || !pairNode.isForLoopStartNode) return;

        // Just update our own ports (which read from the pair)
        this.updatePorts();
    }

    // Serialize with pair relationship
    serialize() {
        const data = super.serialize();
        data.pairNodeId = this.data.pairNodeId;
        data.varTypes = this.data.varTypes;
        return data;
    }
}
