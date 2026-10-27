import { normalizeKind, paramUniformType, paramUniformValue, PARAM_KINDS } from '../paramKinds.js';

/**
 * Param: a UI parameter. Every Param node of the patch (in any group) is listed in
 * the Parameters panel (top bar, P) with a pretty label, grouped by section.
 * The node class is src/nodes/ParamNode.js, the kinds live in src/core/paramKinds.js.
 *
 * The value is a live uniform named exactly like the node's compiled variable
 * (node_N), so CompilationManager registers it in the UniformRegistry and value
 * changes never recompile; the output ports follow data.kind.
 */
export const ParamNodes = {
    'Param': {
        category: 'constant',
        displayTitle: 'Param',
        description: 'A UI parameter shown in the Parameters panel (top bar, P), independent of zoom and of the group being viewed. data.label is its pretty name; data.kind picks the type: float | int | bool | vec2 | vec3 | vec4 | color | enum | trigger | image | text (a string, control-rate only: Text Texture, Text Pick, JS inputs). Values are live uniforms (tweaking never recompiles); the outputs follow the kind.',
        inputs: [],
        outputs: [{ name: 'value', type: 'float' }],
        data: {
            label: '',
            kind: 'float',
            value: 0.5,
            default: 0.5,
            min: 0,
            max: 1,
            step: 0.01,
            scale: 'linear',
            section: '',
            order: 0,
            description: ''
        },
        isParamNode: true,
        paramKinds: PARAM_KINDS,
        glsl: (node) => {
            const data = node.data || {};
            const kind = normalizeKind(data.kind) || 'float';
            const v = node.varName;
            if (kind === 'text') {
                // Strings are control-rate only: read by the ControlRuntime, never a uniform
                node.compiledVarName = v;
                node.outputVars = null;
                return { code: '', output: '0.0', uniforms: [] };
            }
            // Remember the compiled name (the compiler renames node_<id> to compact ids)
            node.compiledVarName = v;
            const type = paramUniformType(data);
            const raw = typeof node.getUniformValue === 'function' ? node.getUniformValue() : paramUniformValue(data);
            const uniform = { name: v, type, value: Array.isArray(raw) ? [...raw] : raw };
            const uniforms = [uniform];
            if (kind === 'image') {
                // Texture bound by FeedbackRenderer.injectFeedbackTextures (shared GL context)
                uniform.value = 0;
                uniform.imageParamNodeId = node.id;
            }
            if (kind === 'bool') {
                node.outputVars = { value: v, on: `(${v} > 0.5)` };
            } else if (kind === 'trigger') {
                // x = 1 for one frame after a press, y = press count, z = u_time of the last press
                node.outputVars = { pulse: `${v}.x`, count: `${v}.y`, since: `max(u_time - ${v}.z, 0.0)` };
                uniforms.push('u_time');
            } else {
                node.outputVars = null;
            }
            return { code: '', output: kind === 'trigger' ? `${v}.x` : v, uniforms };
        }
    }
};
