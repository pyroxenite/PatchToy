import { Node } from './Node.js';

export class ForLoopStartNode extends Node {
    constructor(id, type, x, y) {
        super(id, type, x, y);

        this.isForLoopStartNode = true;
        // Note: We don't set isDynamicInput = true here to allow compiler caching
        // The shouldAddNewInput() and addDynamicInput() methods still work
        this.minInputs = 1; // At least one iteration variable

        // Generate or use existing pair ID
        if (!this.data.pairNodeId) {
            this.data.pairNodeId = null; // Will be set when paired
        }

        // Track iteration variable types
        if (!this.data.varTypes) {
            this.data.varTypes = ['float'];
        }

        this.width = 180;
        this.updatePorts();
    }

    updatePorts() {
        const varTypes = this.data.varTypes || ['float'];

        // Clear and rebuild inputs
        this.inputs = [];
        this.outputs = [];

        // Top input: iterations
        this.inputs.push({ name: 'iterations', type: 'int', default: '10' });

        // Left side inputs: start values (one per iteration variable)
        for (let i = 0; i < varTypes.length; i++) {
            const varType = varTypes[i] || 'float';
            this.inputs.push({ name: `start${i}`, type: varType });
        }

        // Right side outputs: intermediate values (one per iteration variable)
        for (let i = 0; i < varTypes.length; i++) {
            const varType = varTypes[i] || 'float';
            this.outputs.push({ name: `inter${i}`, type: varType });
        }

        // Calculate height based on number of variables
        const baseHeight = 80;
        const portSpacing = 25;
        const totalPorts = Math.max(this.inputs.length, this.outputs.length);
        this.height = baseHeight + Math.max(0, totalPorts - 2) * portSpacing;
    }

    // Override port positioning to align outputs with inputs
    getInputPortPosition(index) {
        // All inputs are always visible (iterations + all start inputs including free one)
        return super.getInputPortPosition(index);
    }

    getOutputPortPosition(index) {
        // Only show outputs for connected inputs
        const inputIndex = index + 1; // +1 because iterations is at index 0

        // Check if the corresponding start input is connected
        if (this.graph) {
            const isConnected = this.graph.connections.some(conn =>
                conn.toNode === this && conn.toInput === inputIndex
            );
            if (!isConnected) return null; // Hide output if input not connected
        }

        const inputPos = this.getInputPortPosition(inputIndex);
        if (!inputPos) return null;

        // Use input's y but output's x (right side)
        return { x: this.x + this.width, y: inputPos.y };
    }

    // Override to hide iteration variable port labels
    getInputPortLabel(index) {
        if (index === 0) return this.inputs[0].name; // Show 'iterations'
        return null; // Hide start0, start1, etc.
    }

    getOutputPortLabel(index) {
        return null; // Hide inter0, inter1, etc.
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

        // Extract index from input name (e.g., "start2" -> 2)
        const match = inputName.match(/^start(\d+)$/);
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

        // Start inputs are all inputs except 'iterations' (index 0)
        const startInputs = this.inputs.filter(i => i.name.startsWith('start'));

        // Check if all start inputs are connected
        for (let i = 0; i < startInputs.length; i++) {
            const inputName = startInputs[i].name;
            const inputIndex = this.inputs.findIndex(input => input.name === inputName);

            if (this.graph) {
                const isConnected = this.graph.connections.some(conn =>
                    conn.toNode === this && conn.toInput === inputIndex
                );

                // If any start input is not connected, don't add new one
                if (!isConnected) {
                    return false;
                }
            }
        }

        // All start inputs are connected, add a new one
        return true;
    }

    // Sync configuration with paired ForLoopEnd node
    syncWithPair() {
        if (!this.data.pairNodeId || !this.graph) return;

        // Find the paired node
        const pairNode = this.graph.nodes.find(n => n.id === this.data.pairNodeId);
        if (!pairNode || !pairNode.isForLoopEndNode) return;

        // ForLoopEnd reads from ForLoopStart, so just update its ports
        pairNode.updatePorts();
    }

    // Serialize with pair relationship
    serialize() {
        const data = super.serialize();
        data.pairNodeId = this.data.pairNodeId;
        data.varTypes = this.data.varTypes;
        return data;
    }
}
