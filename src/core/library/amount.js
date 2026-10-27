/**
 * The shared "effect amount" convention.
 *
 * Every effect-like node (UV distortions, post effects, colour adjustments)
 * takes a trailing float input `amount` (inline default 1.0):
 *   amount <= 0  exact bypass: each output listed in def.amountBypass equals
 *                the input it names (e.g. uv -> uv, color -> color) or the
 *                given constant (e.g. glow -> 0.0)
 *   amount  = 1  the full effect, identical to the node without the input
 *   in between   a continuous, effect-specific fade (angles / offsets /
 *                strengths scale, zoom factors and cell sizes move in log
 *                space, segment and tile counts grow continuously, ...)
 * The input is always the last one, so connections (stored by index) and
 * inline values of older projects are unaffected.
 *
 * Metadata on the definition, for the scene system and the tools:
 *   def.amountInput    = 'amount'
 *   def.identityAtZero = true
 *   def.amountBypass   = { [outputName]: GLSL in terms of input names }
 *   def.amountNote     = AMOUNT_NOTE (shown by list_node_types)
 *
 * effectNode(spec) builds such a node on top of libNode. Besides the libNode
 * fields it takes:
 *   full(I, ctx)       -> { code?, out }  the original effect; used when amount
 *                         is the literal 1, so default nodes compile exactly as
 *                         before (optional: falls back to general)
 *   general(I, ctx, a) -> { code?, out }  the effect for amount `a` (a GLSL
 *                         float variable, already clamped to >= 0; must equal
 *                         full() at a = 1 and the bypass at a = 0, and be
 *                         continuous in between)
 *   bypass(I)          -> { [output]: expr }  the outputs at amount = 0 (outputs
 *                         not listed, e.g. Grayscale.luma, ignore amount)
 *   guard              -> true: wrap the bypassed outputs in
 *                         `a <= 0.0 ? bypass : effect` (for effects whose maths
 *                         is only approximately the identity at 0)
 */
import { libNode, isNumericLiteral } from './define.js';

export const AMOUNT_INPUT = 'amount';

export const AMOUNT_NOTE = "Effect amount convention: the last input 'amount' (float, default 1.0) fades this effect in and out. " +
    '0 (or less) = exact bypass (output = the unprocessed input, or no contribution for generators such as Glow / EdgeDetect), ' +
    '1 = the full effect, unchanged from before; in between the effect fades continuously in its own way (angles, offsets and strengths scale, ' +
    'zoom factors and cell sizes move in log space, segment and tile counts grow and quantization steps coarsen continuously) rather than cross-fading. ' +
    'Values above 1 extrapolate where that is meaningful. Connect a Param / Float (or any float) to drive transitions.';

export const AMOUNT = {
    name: AMOUNT_INPUT,
    type: 'float',
    default: '1.0',
    description: 'Effect amount: 0 = bypass (output = input), 1 = full effect, continuous in between'
};

export function effectNode(spec) {
    const { inputs = [], full, general, bypass, guard = false, ...rest } = spec;
    if (typeof general !== 'function' || typeof bypass !== 'function') {
        throw new Error(`effectNode(${spec.description}): needs general() and bypass()`);
    }
    const allInputs = [...inputs, AMOUNT];

    const def = libNode({
        ...rest,
        inputs: allInputs,
        body: (I, ctx) => {
            const lit = isNumericLiteral(I.amount) ? parseFloat(I.amount) : null;
            if (lit === 1 && full) return full(I, ctx);

            const a = `${ctx.v}_amt`;
            const bp = bypass(I, ctx);
            const g = general(I, ctx, a) || {};
            const out = { ...(g.out || {}) };
            const code = [`float ${a} = max(${I.amount}, 0.0);`, g.code].filter(Boolean).join('\n');
            if (lit !== null && lit <= 0) {
                // Literal 0: the bypassed outputs are the inputs themselves
                Object.assign(out, bp);
            } else if (guard) {
                for (const k of Object.keys(bp)) {
                    if (out[k] !== undefined) out[k] = `(${a} <= 0.0 ? ${bp[k]} : ${out[k]})`;
                }
            }
            return { code, out, preamble: g.preamble };
        }
    });

    // Bypass described in terms of input names (e.g. { uv: 'uv' }, { color: 'texture(tex, uv)' })
    const names = {};
    for (const i of allInputs) names[i.name] = i.name;
    def.amountInput = AMOUNT_INPUT;
    def.identityAtZero = true;
    def.amountBypass = bypass(names, { v: 'node' });
    def.amountNote = AMOUNT_NOTE;
    return def;
}

/**
 * Saved-data migration for a node whose old `amount` input was renamed to
 * `newName` when the shared amount input was added. Old projects store
 * data.amount (the effect strength) and no data[newName]; move it over so the
 * new amount falls back to its default (1.0). Connections are by index and
 * need no change. Used by NodeFactory.deserializeNode via def.migrateData.
 */
export function renamedAmount(newName) {
    return data => {
        if (!data || typeof data !== 'object' || !(AMOUNT_INPUT in data) || newName in data) return data;
        const out = { ...data, [newName]: data[AMOUNT_INPUT] };
        delete out[AMOUNT_INPUT];
        return out;
    };
}
