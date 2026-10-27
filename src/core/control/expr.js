/**
 * A small, safe expression language for the Math Expression control node.
 * Nothing is eval'd: the text is tokenized and parsed (recursive descent) into a
 * closure tree that can only read the given variables and call the whitelisted
 * functions below.
 *
 *   numbers     1, 0.5, .25, 1e-3
 *   variables   a b c d (inputs), t (seconds), dt, beat (beat position), phase
 *               (beat phase), bpm, pi, tau, e
 *   operators   + - * / % (GLSL mod) ^ (power), comparisons < <= > >= == != (1 or 0),
 *               && || ! (truthy = non-zero), ternary c ? x : y, parentheses
 *   functions   sin cos tan asin acos atan atan2 abs sign floor ceil round fract sqrt
 *               exp log log2 pow min max clamp mix step smoothstep mod hypot
 *               noise(x) (smooth 1D value noise 0..1), hash(x) (0..1)
 */
import { fract, mod, clamp, mix, step, smoothstep, sign, roundHalfAway } from './vmath.js';

const hash = (x) => fract(Math.sin(x * 127.1 + 311.7) * 43758.5453123);
const noise1 = (x) => {
    const i = Math.floor(x), f = x - i;
    const u = f * f * (3 - 2 * f);
    return mix(hash(i), hash(i + 1), u);
};

export const EXPR_FUNCTIONS = {
    sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
    asin: [1, x => Math.asin(clamp(x, -1, 1))], acos: [1, x => Math.acos(clamp(x, -1, 1))],
    atan: [1, Math.atan], atan2: [2, Math.atan2],
    abs: [1, Math.abs], sign: [1, sign], floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, roundHalfAway],
    fract: [1, fract], sqrt: [1, x => Math.sqrt(Math.max(x, 0))], exp: [1, Math.exp],
    log: [1, x => Math.log(Math.max(x, 1e-12))], log2: [1, x => Math.log2(Math.max(x, 1e-12))],
    pow: [2, Math.pow], min: [2, Math.min], max: [2, Math.max], clamp: [3, clamp], mix: [3, mix],
    step: [2, step], smoothstep: [3, smoothstep], mod: [2, mod], hypot: [2, Math.hypot],
    noise: [1, noise1], hash: [1, hash]
};

export const EXPR_CONSTANTS = { pi: Math.PI, tau: Math.PI * 2, e: Math.E };

function tokenize(src) {
    const tokens = [];
    const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_]\w*)|(<=|>=|==|!=|&&|\|\||[-+*/%^()<>!?:,]))/y;
    let i = 0;
    const s = String(src);
    while (i < s.length) {
        if (/^\s*$/.test(s.slice(i))) break;
        re.lastIndex = i;
        const m = re.exec(s);
        if (!m) throw new Error(`unexpected "${s.slice(i).trim()[0]}" at ${i + 1}`);
        if (m[1] !== undefined) tokens.push({ t: 'num', v: parseFloat(m[1]) });
        else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2] });
        else tokens.push({ t: 'op', v: m[3] });
        i = re.lastIndex;
    }
    return tokens;
}

/**
 * Compile an expression. Returns { fn(vars) -> number, vars: Set of used names }.
 * Throws Error with a readable message on syntax errors / unknown names.
 */
export function compileExpression(src, allowedVars) {
    const tokens = tokenize(src);
    if (!tokens.length) throw new Error('empty expression');
    let pos = 0;
    const used = new Set();
    const peek = () => tokens[pos];
    const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
    const expect = (v) => {
        if (!isOp(v)) throw new Error(`expected "${v}"${peek() ? ` before "${peek().v}"` : ' at the end'}`);
        pos++;
    };
    const truth = x => (x !== 0 && !Number.isNaN(x) ? 1 : 0);

    const parseTernary = () => {
        const c = parseOr();
        if (isOp('?')) {
            pos++;
            const a = parseTernary();
            expect(':');
            const b = parseTernary();
            return v => (truth(c(v)) ? a(v) : b(v));
        }
        return c;
    };
    const parseOr = () => {
        let l = parseAnd();
        while (isOp('||')) { pos++; const a = l, b = parseAnd(); l = v => (truth(a(v)) || truth(b(v)) ? 1 : 0); }
        return l;
    };
    const parseAnd = () => {
        let l = parseCmp();
        while (isOp('&&')) { pos++; const a = l, b = parseCmp(); l = v => (truth(a(v)) && truth(b(v)) ? 1 : 0); }
        return l;
    };
    const CMP = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
    const parseCmp = () => {
        let l = parseAdd();
        while (peek() && peek().t === 'op' && CMP[peek().v]) {
            const f = CMP[tokens[pos++].v];
            const a = l, b = parseAdd();
            l = v => (f(a(v), b(v)) ? 1 : 0);
        }
        return l;
    };
    const parseAdd = () => {
        let l = parseMul();
        while (isOp('+') || isOp('-')) {
            const op = tokens[pos++].v;
            const a = l, b = parseMul();
            l = op === '+' ? v => a(v) + b(v) : v => a(v) - b(v);
        }
        return l;
    };
    const parseMul = () => {
        let l = parseUnary();
        while (isOp('*') || isOp('/') || isOp('%')) {
            const op = tokens[pos++].v;
            const a = l, b = parseUnary();
            l = op === '*' ? v => a(v) * b(v) : op === '/' ? v => a(v) / b(v) : v => mod(a(v), b(v));
        }
        return l;
    };
    const parseUnary = () => {
        if (isOp('-')) { pos++; const a = parseUnary(); return v => -a(v); }
        if (isOp('+')) { pos++; return parseUnary(); }
        if (isOp('!')) { pos++; const a = parseUnary(); return v => (truth(a(v)) ? 0 : 1); }
        return parsePow();
    };
    const parsePow = () => {
        const base = parsePrimary();
        if (isOp('^')) {
            pos++;
            const ex = parseUnary(); // right-associative
            return v => Math.pow(base(v), ex(v));
        }
        return base;
    };
    const parsePrimary = () => {
        const tk = peek();
        if (!tk) throw new Error('unexpected end of expression');
        if (tk.t === 'num') { pos++; const n = tk.v; return () => n; }
        if (tk.t === 'op' && tk.v === '(') {
            pos++;
            const e = parseTernary();
            expect(')');
            return e;
        }
        if (tk.t === 'id') {
            pos++;
            const name = tk.v;
            if (isOp('(')) {
                const fn = EXPR_FUNCTIONS[name];
                if (!fn) throw new Error(`unknown function ${name}() (use ${Object.keys(EXPR_FUNCTIONS).join(', ')})`);
                pos++;
                const args = [];
                if (!isOp(')')) {
                    args.push(parseTernary());
                    while (isOp(',')) { pos++; args.push(parseTernary()); }
                }
                expect(')');
                if (args.length !== fn[0]) throw new Error(`${name}() takes ${fn[0]} argument${fn[0] > 1 ? 's' : ''} (got ${args.length})`);
                const f = fn[1];
                if (args.length === 1) { const [a] = args; return v => f(a(v)); }
                if (args.length === 2) { const [a, b] = args; return v => f(a(v), b(v)); }
                const [a, b, c] = args;
                return v => f(a(v), b(v), c(v));
            }
            if (Object.prototype.hasOwnProperty.call(EXPR_CONSTANTS, name)) { const k = EXPR_CONSTANTS[name]; return () => k; }
            if (allowedVars && !allowedVars.includes(name)) throw new Error(`unknown name "${name}" (variables: ${allowedVars.join(', ')}, pi, tau, e)`);
            used.add(name);
            return v => {
                const x = v[name];
                return typeof x === 'number' ? x : (typeof x === 'boolean' ? (x ? 1 : 0) : (Number(x) || 0));
            };
        }
        throw new Error(`unexpected "${tk.v}"`);
    };

    const fn = parseTernary();
    if (pos < tokens.length) throw new Error(`unexpected "${tokens[pos].v}"`);
    return { fn, vars: used };
}
