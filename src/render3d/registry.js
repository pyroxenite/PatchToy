/**
 * Node classes contributed by feature modules (Render 3D), looked up by NodeFactory.
 * Dependency-free on purpose: NodeFactory imports it without pulling the feature in
 * (src/render3d/index.js registers its classes when main.js imports it).
 */
const resolvers = [];

export function registerNodeClassResolver(fn) {
    resolvers.push(fn);
}

/** Class for a definition, or null when no feature module claims it. */
export function featureNodeClass(def) {
    for (const fn of resolvers) {
        const C = fn(def);
        if (C) return C;
    }
    return null;
}
