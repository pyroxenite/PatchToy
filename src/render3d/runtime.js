/**
 * Render 3D runtime state shared by the node classes: the app (set by installRender3D),
 * a compile epoch, the render_preview size override, CPU reads of control-rate inputs.
 */
import { controlValueOf, readSourceOutput } from '../core/control/ControlRuntime.js';
import { cpuDefault, getControlPlan } from '../core/control/rates.js';
import { clock } from '../core/Clock.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';

export const R3D = {
    app: null,
    epoch: 0,               // bumped on every compile (data edits recompile)
    sizeOverride: null,     // { w, h } while render_preview renders (output size = render size)
    stats: { renders: 0, ms: 0 },
};

const ENV = { u: clock.u, mouse: [0.5, 0.5] };

/** Connection into input `index` of node (plain loop, no allocation). */
export function connAt(node, index) {
    const g = node.graph;
    if (!g) return null;
    const cs = g.connections;
    for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c.toNode === node && c.toInput === index) return c;
    }
    return null;
}

/**
 * CPU value of input `index`: a control-rate / CPU source cable, else the inline value or
 * the input default (u_time etc.). Numbers only (vectors: first component).
 */
export function cpuInput(node, index, fallback = 0) {
    const input = node.inputs[index];
    if (!input) return fallback;
    const c = connAt(node, index);
    let v;
    if (c) {
        v = controlValueOf(c);
        if (v === undefined) {
            const src = c.fromNode;
            const g = src.graph;
            const plan = g && (g._controlPlan || getControlPlan(g));
            const kind = plan ? plan.kindOf(src) : 'pixel';
            if (kind === 'source' || src.isJSNode) v = readSourceOutput(src, c.fromOutput, ENV);
            else if (src.definition && src.definition.isConstantNode) v = src.data.value;
            else if (src.type === 'Time') v = clock.u.time;
            else v = undefined;
        }
    } else {
        ENV.u = clock.u;
        ENV.mouse[0] = ShaderPreview.mouseX;
        ENV.mouse[1] = ShaderPreview.mouseY;
        v = cpuDefault(node, input, ENV);
    }
    if (Array.isArray(v)) v = v[0];
    if (typeof v === 'boolean') v = v ? 1 : 0;
    v = Number(v);
    return Number.isFinite(v) ? v : fallback;
}

/** Index of an input by name (cached per definition). */
export function inputIndex(node, name) {
    const ins = node.inputs;
    for (let i = 0; i < ins.length; i++) if (ins[i].name === name) return i;
    return -1;
}

/** Size of a texture made by a node output (Feedback, JS / control textures, Render 3D), or null. */
export function textureSizeOf(node, outputIndex) {
    if (!node) return null;
    if (node.isFeedbackNode) {
        const w = node.bufferWidth || node.data.width, h = node.bufferHeight || node.data.height;
        return w && h ? [w, h] : null;
    }
    if (node.isRender3DNode && node.targets) return [node.targets.w, node.targets.h];
    if (node.textures && node.outputs[outputIndex]) {
        const t = node.textures.get(node.outputs[outputIndex].name);
        if (t && t.w) return [t.w, t.h];
    }
    return null;
}
