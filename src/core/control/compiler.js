/**
 * ShaderCompiler extension for control-rate nodes (see rates.js).
 *
 * A node the control plan runs in JavaScript (control nodes, math whose inputs are
 * all CPU values) is not compiled into GLSL: the shader reads each of its outputs
 * from a uniform node_<id>_c<k>, which the ControlRuntime updates every frame. The
 * node's inputs are not traversed, so control sub-graphs (and their Delay loops)
 * never reach the shader. Rate violations (a pixel value wired into a control
 * input, a string into a shader) are reported as compile errors on the target node.
 */
import { getControlPlan, controlRateEnabled, CONTROL } from './rates.js';
import { zeroOf, GLSL_VALUE_TYPES } from './vmath.js';

export function installControlCompiler(ShaderCompiler) {
    const P = ShaderCompiler.prototype;

    /** The plan for this compile (rebuilt once per compile cycle = new node id mapping). */
    P._controlPlanFor = function (nodeGraph) {
        if (!controlRateEnabled() || !nodeGraph || !Array.isArray(nodeGraph.nodes)) return null;
        // One lookup per compile pass (asked for every compiled node; the graph does not change
        // during a pass): getControlPlan's fingerprint walks the whole graph
        const memo = this._planMemo;
        if (memo && memo.graph === nodeGraph && memo.remap === this.nodeIdRemap && memo.reset === this._resetCount) return memo.plan;
        const force = this._controlRemap !== this.nodeIdRemap;
        this._controlRemap = this.nodeIdRemap;
        let plan;
        try {
            plan = getControlPlan(nodeGraph, { force });
        } catch (e) {
            console.warn('[control] plan failed', e);
            return null;
        }
        this._planMemo = { graph: nodeGraph, remap: this.nodeIdRemap, reset: this._resetCount, plan };
        return plan;
    };

    /**
     * compileNodeBody hook: returns the uniform-backed result for a control-rate node,
     * an error (null) for a broken control wiring, or undefined (compile normally).
     */
    P._compileControlNode = function (node, nodeGraph) {
        // A node that was control rate in an earlier compile: its uniform outputVars are stale
        if (node.controlVarName) {
            node.controlVarName = null;
            node.outputVars = null;
        }
        const plan = this._controlPlanFor(nodeGraph);
        if (!plan) return undefined;

        // Cables into this node that break the rate rules
        for (const v of plan.violations) {
            if (v.conn.toNode === node) {
                this.addError(v.message, node.id);
                return null;
            }
        }
        if (!plan.uniformNodes.has(node)) return undefined;
        if (plan.errors.has(node)) {
            this.addError(plan.errors.get(node), node.id);
            return null;
        }

        const info = plan.info.get(node);
        const v = node.varName;
        const uniforms = [];
        const outputVars = {};
        const live = node._ctlOut || [];
        for (let k = 0; k < node.outputs.length; k++) {
            const o = node.outputs[k];
            const t = (info && info.outTypes && info.outTypes[k]) || o.type;
            if (t === 'sampler2D') {
                // Texture made on the CPU (Text / List Texture): bound like JS node textures
                const name = `${v}_c${k}`;
                uniforms.push({ name, type: 'sampler2D', value: 0, jsTextureNodeId: node.id, jsTextureOutput: o.name });
                outputVars[o.name] = name;
                continue;
            }
            if (!GLSL_VALUE_TYPES.has(t)) continue; // event / string / list: control-only
            const name = `${v}_c${k}`;
            let value = live[k];
            if (value === undefined || value === null) value = zeroOf(t);
            if (t === 'bool') value = !!value;
            uniforms.push({ name, type: t, value: Array.isArray(value) ? [...value] : value });
            outputVars[o.name] = name;
        }
        node.outputVars = outputVars;
        node.controlVarName = v;
        const first = node.outputs.findIndex(o => outputVars[o.name]);
        const result = { code: '', output: first >= 0 ? outputVars[node.outputs[first].name] : '0.0', uniforms, controlRate: true };
        for (const u of uniforms) this.addUniform(u);
        this.compiledNodes.set(node.id, result);
        return result;
    };

    /** Rate of a node in the current plan (for tools): 'pixel' | 'control' | 'free'. */
    P.controlRateOf = function (node, nodeGraph) {
        this._planMemo = null; // (outside a compile pass: the graph may have changed)
        const plan = this._controlPlanFor(nodeGraph);
        return plan ? plan.rateOf(node) : 'pixel';
    };

    void CONTROL;
}
