/**
 * Logic nodes: comparisons and branching. Bools convert to floats (0 / 1)
 * automatically when connected to numeric inputs, and floats convert to
 * bools (x > 0.5) when connected to bool inputs such as ForLoopEnd.break.
 */
import { libNode } from './define.js';

const C = 'logic';

export const LogicNodes = {
    'Compare': libNode({
        category: C,
        description: 'Compares two floats: less (a < b), greater (a > b), equal (|a - b| < epsilon).',
        inputs: [
            { name: 'a', type: 'float', default: '0.0' },
            { name: 'b', type: 'float', default: '0.5' },
            { name: 'epsilon', type: 'float', default: '0.0001' }
        ],
        outputs: [
            { name: 'less', type: 'bool' },
            { name: 'greater', type: 'bool' },
            { name: 'equal', type: 'bool' }
        ],
        body: I => ({
            out: {
                less: `${I.a} < ${I.b}`,
                greater: `${I.a} > ${I.b}`,
                equal: `abs(${I.a} - ${I.b}) < ${I.epsilon}`
            }
        }),
        js: I => ({ less: I.a < I.b, greater: I.a > I.b, equal: Math.abs(I.a - I.b) < I.epsilon })
    }),

    'Select': libNode({
        category: C,
        description: 'Chooses a when cond is true, otherwise b (works for floats, vectors and colors).',
        inputs: [
            { name: 'cond', type: 'bool', default: 'true' },
            { name: 'a', type: 'T', default: '1.0' },
            { name: 'b', type: 'T', default: '0.0' }
        ],
        outputs: [{ name: 'out', type: 'T' }],
        expr: I => `(${I.cond}) ? ${I.a} : ${I.b}`,
        js: I => (I.cond ? I.a : I.b)
    }),

    'And': libNode({
        category: C,
        description: 'True when both a and b are true.',
        inputs: [{ name: 'a', type: 'bool', default: 'true' }, { name: 'b', type: 'bool', default: 'true' }],
        outputs: [{ name: 'out', type: 'bool' }],
        expr: I => `(${I.a}) && (${I.b})`,
        js: I => !!(I.a && I.b)
    }),

    'Or': libNode({
        category: C,
        description: 'True when a or b (or both) is true.',
        inputs: [{ name: 'a', type: 'bool', default: 'false' }, { name: 'b', type: 'bool', default: 'false' }],
        outputs: [{ name: 'out', type: 'bool' }],
        expr: I => `(${I.a}) || (${I.b})`,
        js: I => !!(I.a || I.b)
    }),

    'Not': libNode({
        category: C,
        description: 'Inverts a bool.',
        inputs: [{ name: 'a', type: 'bool', default: 'false' }],
        outputs: [{ name: 'out', type: 'bool' }],
        expr: I => `!(${I.a})`,
        js: I => !I.a
    })
};
