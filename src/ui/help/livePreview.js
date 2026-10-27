/**
 * A tiny live render of one node type with its default inputs, for the help panel.
 *
 * Minimal graph: a throwaway instance of the node, nothing connected, compiled
 * "as output" with a private ShaderCompiler (the same path as Preview nodes:
 * compileFromNodeAsOutput) and drawn by a ShaderPreview in the app's shared GL
 * context (createSharedCanvasPreview), so clock / audio / mouse uniforms animate it.
 *
 * Only for nodes that render something on their own; everything else (control
 * nodes, probes, devices, Feedback, scene switching…) gets the static node
 * snapshot instead. Shader errors are checked silently before loading, so a node
 * that can't preview never logs anything.
 */
import { NodeFactory } from '../../graph/NodeFactory.js';
import { ShaderCompiler } from '../../core/ShaderCompiler.js';
import { createSharedCanvasPreview } from '../../rendering/SharedCanvasPreview.js';

const PREVIEW_TYPES = new Set(['float', 'vec2', 'vec3', 'vec4']);
const NO_PREVIEW_FLAGS = [
    'isPreviewNode', 'isCommentNode', 'isProbeNode', 'isFeedbackNode', 'isJSNode', 'isParamNode',
    'isCameraNode', 'isScreenCaptureNode', 'isVideoURLNode', 'isMicrophoneNode', 'isMidiCCNode', 'isMidiNoteNode',
    'isKeyboardNode', 'isXYPadNode', 'isSceneSwitcher', 'isForLoopStartNode', 'isForLoopEndNode', 'isMapNode',
    'isControlNode', 'isTextureControl', 'isCustomNodeBroken',
];

let tempId = -5000;

/** Index of the output worth previewing, or -1. */
export function previewOutputIndex(def) {
    if (!def || def.rate === 'control') return -1;
    for (const f of NO_PREVIEW_FLAGS) if (def[f]) return -1;
    const outs = Array.isArray(def.outputs) ? def.outputs : [];
    // A "color"-like output reads best; else the first previewable one
    let idx = outs.findIndex(o => o && /^(color|rgb|rgba|col)$/i.test(o.name) && PREVIEW_TYPES.has(o.type));
    if (idx < 0) idx = outs.findIndex(o => o && (PREVIEW_TYPES.has(o.type) || o.type === 'T'));
    return idx;
}

function fragmentCompiles(gl, src) {
    const sh = gl.createShader(gl.FRAGMENT_SHADER);
    if (!sh) return false;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    const ok = !!gl.getShaderParameter(sh, gl.COMPILE_STATUS);
    gl.deleteShader(sh);
    return ok;
}

/**
 * @returns {{ canvas: HTMLCanvasElement, destroy(): void } | null}
 */
export function createLivePreview(type, def, graph, { width = 320, height = 180 } = {}) {
    const gl = graph && graph.sharedGL;
    if (!gl || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return null;
    const outIndex = previewOutputIndex(def);
    if (outIndex < 0) return null;

    let node = null;
    let preview = null;
    try {
        const id = tempId--;
        node = NodeFactory.createNode(type, id, 0, 0, graph.canvas || null, graph.videoElement || null, null);
        if (!node) return null;
        const mini = { nodes: [node], connections: [], zoom: 1, panX: 0, panY: 0, uniformRegistry: graph.uniformRegistry || null, render() {} };
        node.graph = mini;
        const compiler = new ShaderCompiler();
        compiler.nodeIdRemap = new Map([[id, 0]]);
        const shader = compiler.compileFromNodeAsOutput(node, outIndex, mini);
        if (!shader || !shader.fragment || (shader.errors && shader.errors.length)) return cleanup();
        // Texture inputs left at their defaults would need the camera / video: keep it simple
        if ((shader.uniformValues || []).some(u => u && u.type === 'sampler2D')) return cleanup();
        if (!fragmentCompiles(gl, shader.fragment)) return cleanup();

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.className = 'ph-live-canvas';
        let alive = true;
        preview = createSharedCanvasPreview({
            sharedGL: gl,
            targetCanvas: canvas,
            videoElement: graph.videoElement || null,
            uniformRegistry: graph.uniformRegistry || null,
            isVisible: () => alive && canvas.isConnected && document.visibilityState === 'visible',
        });
        if (!preview.loadShader(shader)) return cleanup();
        const destroy = () => {
            alive = false;
            try { preview && preview.destroy(); } catch (e) { /* ignore */ }
            preview = null;
            try { node && node.cleanup && node.cleanup(); } catch (e) { /* ignore */ }
            node = null;
        };
        return { canvas, destroy };
    } catch (e) {
        return cleanup();
    }

    function cleanup() {
        try { preview && preview.destroy(); } catch (e) { /* ignore */ }
        try { node && node.cleanup && node.cleanup(); } catch (e) { /* ignore */ }
        return null;
    }
}
