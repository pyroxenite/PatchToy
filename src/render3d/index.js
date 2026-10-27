/**
 * Render 3D entry point: node classes for the NodeFactory, the app hooks (compile with
 * the previews, live uniform registration, compile errors), scroll-to-zoom over a node
 * preview and .glb / .gltf drops on the canvas.
 *
 *   installRender3D(app)       once, from main.js
 *   render3dNodeClass(def)     NodeFactory: class for a Render 3D definition (or null)
 */
import { R3D } from './runtime.js';
import { Render3DNode } from './Render3DNode.js';
import { GeometryNode, MeshNode, GroupNode } from './objectNodes.js';
import { ModelNode, loadModelFile } from './ModelNode.js';
import { registerNodeClassResolver } from './registry.js';

export { R3D };

export function render3dNodeClass(def) {
    if (!def) return null;
    if (def.isRender3D) return Render3DNode;
    if (def.isGeometryNode) return GeometryNode;
    if (def.isModelNode) return ModelNode;
    if (def.isRender3DObject) return MeshNode;
    if (def.isRender3DGroup) return GroupNode;
    return null;
}

registerNodeClassResolver(render3dNodeClass);

class Render3DManager {
    constructor(app) {
        this.app = app;
        this.lastErrors = [];
    }

    nodes() {
        const g = this.app.nodeGraph;
        return g ? g.nodes.filter(n => n.isRender3DNode) : [];
    }

    /** Compile every Render 3D node (CompilationManager.compile, after the Feedback passes). */
    compileAll() {
        R3D.epoch++;
        const fr = this.app.feedbackRenderer;
        try { fr && fr.ensureNodeIdMapping && fr.ensureNodeIdMapping(); } catch (e) { /* ignore */ }
        const list = this.nodes();
        for (const n of list) {
            try { n.compile(); } catch (e) {
                console.error('[render3d] compile failed', e);
                n.compileErrors = [String(e.message || e)];
            }
        }
        return list.length;
    }

    /** After the registry was rebuilt from the previews: add the uniforms only Render 3D programs use. */
    registerUniforms() {
        for (const n of this.nodes()) { try { n.registerUniforms(); } catch (e) { /* ignore */ } }
    }

    /** Console lines for the failing Render 3D nodes; marks the nodes named in the errors. */
    collectErrors() {
        const lines = [];
        const graph = this.app.nodeGraph;
        for (const n of this.nodes()) {
            if (!n.compileErrors || !n.compileErrors.length) continue;
            n.hasError = true;
            for (const e of n.compileErrors) lines.push(`ERROR: Render 3D #${n.id}: ${e}`);
            const ids = (n.compiled && n.compiled.errorNodeIds) || [];
            for (const id of ids) {
                const node = graph.nodes.find(x => x.id === id);
                if (node) node.hasError = true;
            }
        }
        this.lastErrors = lines;
        return lines;
    }
}

function installWheel(app) {
    const g = app.nodeGraph;
    const canvas = g && g.canvas;
    if (!canvas) return;
    canvas.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) return; // canvas zoom
        let pos;
        try { pos = g.getMousePos(e); } catch (err) { return; }
        const nodes = typeof g.getViewNodes === 'function' ? g.getViewNodes() : g.nodes;
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            if (!n || !n.isRender3DNode || !n.containsPoint(pos.x, pos.y)) continue;
            if (n.handleWheel(pos.x, pos.y, e)) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
            return;
        }
    }, { capture: true, passive: false });
}

function installDrop(app) {
    const isModelFile = f => /\.(glb|gltf)$/i.test(f.name || '');
    window.addEventListener('dragover', (e) => {
        const items = [...(e.dataTransfer?.items || [])];
        if (items.some(i => i.kind === 'file')) e.preventDefault();
    }, { capture: true });
    window.addEventListener('drop', async (e) => {
        const files = [...(e.dataTransfer?.files || [])];
        const file = files.find(isModelFile);
        if (!file) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const g = app.nodeGraph;
        let pos = { x: 100, y: 100 };
        try { pos = g.getMousePos(e); } catch (err) { /* centre */ }
        try {
            await loadModelFile(app, file, pos);
        } catch (err) {
            console.error('[render3d] model drop failed', err);
        }
    }, { capture: true });
}

/** Wire Render 3D into the app (main.js, once the managers exist). */
export function installRender3D(app) {
    R3D.app = app;
    const mgr = new Render3DManager(app);
    app.render3d = mgr;
    if (app.compilationManager) app.compilationManager.render3d = mgr;
    try { installWheel(app); } catch (e) { console.warn('[render3d] wheel zoom unavailable', e); }
    try { installDrop(app); } catch (e) { console.warn('[render3d] model drop unavailable', e); }
    // Double-click a Model node: pick a file (main.js sets the double-click handler later)
    setTimeout(() => {
        const g = app.nodeGraph;
        const base = g && g.onNodeRightClick;
        if (!g || g._r3DoubleClick) return;
        g._r3DoubleClick = true;
        g.onNodeRightClick = function (node, e) {
            if (node && node.isModelNode && typeof node.openFilePicker === 'function') { node.openFilePicker(); return; }
            if (base) return base.call(this, node, e);
        };
    }, 0);
    return mgr;
}
