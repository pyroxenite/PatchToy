/**
 * Push a source node's current uniform value into the UniformRegistry.
 * The compiled uniform is named after the node's remapped variable (node_N);
 * CompilationManager registers it with sourceNodeId = node.id, so we update
 * every registry entry owned by this node. Renderers read the registry every
 * frame, so no recompilation is needed.
 */
export function pushLiveUniform(node) {
    const registry = node.graph && node.graph.uniformRegistry;
    if (!registry || typeof node.getUniformValue !== 'function') return;
    const value = node.getUniformValue();
    for (const uniform of registry.getAllUniforms()) {
        if (uniform.sourceNodeId === node.id) {
            registry.registerUniform(uniform.name, uniform.type, Array.isArray(value) ? [...value] : value, node);
        }
    }
    if (node.graph.render) node.graph.render();
}

/** True when keyboard events are aimed at a text field (DOM or canvas). */
export function isTypingTarget(e, graph) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return true;
    return !!(graph && graph.focusedTextInput && graph.focusedTextInput.focused);
}
