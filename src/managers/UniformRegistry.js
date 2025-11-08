/**
 * UniformRegistry - Centralized uniform value management
 *
 * Single source of truth for all uniform values from constant nodes.
 * Renderers (ShaderPreview instances) fetch uniform values from here
 * instead of maintaining their own copies.
 *
 * Benefits:
 * - No syncing needed between multiple renderer instances
 * - Single update point for uniform values
 * - Easy to add new consumers (preview nodes, background, feedback, etc)
 * - Clear separation: uniform nodes → registry → renderers
 */
export class UniformRegistry {
    constructor() {
        // Map of uniform name -> { type, value, sourceNode, sourceNodeId }
        this.uniforms = new Map();

        // Listeners that get notified when uniforms change
        this.listeners = [];
    }

    /**
     * Register or update a uniform value
     * Called by constant nodes when they're in uniform mode
     */
    registerUniform(name, type, value, sourceNode) {
        const existing = this.uniforms.get(name);

        this.uniforms.set(name, {
            name,
            type,
            value,
            sourceNode,
            sourceNodeId: sourceNode.id
        });

        // Notify listeners if this is a new uniform or value changed
        if (!existing || existing.value !== value) {
            this.notifyListeners(name);
        }
    }

    /**
     * Unregister a uniform (called when node is deleted or switches to constant mode)
     */
    unregisterUniform(name) {
        if (this.uniforms.has(name)) {
            this.uniforms.delete(name);
            this.notifyListeners(name);
        }
    }

    /**
     * Get a specific uniform value
     */
    getUniform(name) {
        return this.uniforms.get(name);
    }

    /**
     * Get all uniforms as an array (for ShaderPreview.customUniformValues format)
     */
    getAllUniforms() {
        const result = [];
        for (const uniform of this.uniforms.values()) {
            result.push({
                name: uniform.name,
                type: uniform.type,
                value: uniform.value,
                sourceNodeId: uniform.sourceNodeId
            });
        }
        return result;
    }

    /**
     * Check if a uniform exists
     */
    hasUniform(name) {
        return this.uniforms.has(name);
    }

    /**
     * Get all uniform names
     */
    getUniformNames() {
        return Array.from(this.uniforms.keys());
    }

    /**
     * Clear all uniforms (useful for project reset)
     */
    clear() {
        this.uniforms.clear();
        this.notifyListeners(null); // null means all uniforms cleared
    }

    /**
     * Add a listener for uniform changes
     * Callback signature: (uniformName) => void
     */
    addListener(callback) {
        this.listeners.push(callback);
    }

    /**
     * Remove a listener
     */
    removeListener(callback) {
        const index = this.listeners.indexOf(callback);
        if (index !== -1) {
            this.listeners.splice(index, 1);
        }
    }

    /**
     * Notify all listeners that a uniform changed
     */
    notifyListeners(uniformName) {
        for (const listener of this.listeners) {
            listener(uniformName);
        }
    }

    /**
     * Rebuild the entire uniform registry from the node graph
     * Used during project load or when recreating the registry
     */
    rebuildFromNodeGraph(nodeGraph) {
        this.clear();

        for (const node of nodeGraph.nodes) {
            if (node.data && node.data.useUniform && node.definition) {
                // Get the glsl result to extract uniforms
                const glslResult = node.definition.glsl(node, {});
                if (glslResult && glslResult.uniforms && glslResult.uniforms.length > 0) {
                    for (const uniform of glslResult.uniforms) {
                        this.registerUniform(uniform.name, uniform.type, uniform.value, node);
                    }
                }
            }
        }
    }
}
