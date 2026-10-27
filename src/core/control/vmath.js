/**
 * Control-rate value math with GLSL semantics, for the JS side of nodes that can
 * run once per frame on the CPU (see src/core/control/rates.js).
 *
 * Values: float/int = number, bool = boolean, vecN = array of N numbers,
 * event = number (pulses this frame, usually 0 or 1), string = string,
 * list = array of numbers (any length). Types travel separately (the rate plan
 * resolves them like the ShaderCompiler does), so a vec2 and a 2-item list are
 * told apart by their declared type, not by their shape.
 */

export const SIZES = { float: 1, int: 1, bool: 1, event: 1, vec2: 2, vec3: 3, vec4: 4 };
export const BY_SIZE = { 1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4' };
export const GLSL_VALUE_TYPES = new Set(['float', 'int', 'bool', 'vec2', 'vec3', 'vec4']);
/** Types that only exist at control rate (never reach a shader). */
export const CONTROL_ONLY_TYPES = new Set(['event', 'string', 'list']);

const num = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (Array.isArray(v)) return num(v[0]);
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
};

/** First component as a number (vec -> x, bool -> 0/1, event -> pulses). */
export const scalar = num;

/** Zero value of a type. */
export function zeroOf(type) {
    if (type === 'bool') return false;
    if (type === 'string') return '';
    if (type === 'list') return [];
    const n = SIZES[type];
    if (n > 1) return new Array(n).fill(0);
    return 0;
}

/** Cast between float/int/bool/event/vecN like define.js cast() (scalar broadcast, padding: 0, w = 1). */
export function cast(value, from, to) {
    if (!to || from === to) return value;
    if (to === 'string') return value === undefined || value === null ? '' : (Array.isArray(value) ? value.join(', ') : String(value));
    if (to === 'list') {
        if (Array.isArray(value)) return value.map(num);
        if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
        return [num(value)];
    }
    if (from === 'string') value = Number(value) || 0;
    if (from === 'list') value = Array.isArray(value) ? value : [];
    if (to === 'float' || to === 'event') return num(value);
    if (to === 'int') return Math.trunc(num(value));
    if (to === 'bool') return typeof value === 'boolean' ? value : num(value) > 0.5;
    const ts = SIZES[to];
    if (!(ts > 1)) return value;
    if (!Array.isArray(value)) return new Array(ts).fill(num(value));
    if (value.length === ts) return value;
    if (value.length > ts) return value.slice(0, ts).map(num);
    const out = value.map(num);
    for (let k = out.length; k < ts; k++) out.push(k === 3 ? 1 : 0);
    return out;
}

// ---------------------------------------------------------------------------
// Component-wise application with broadcasting (a float applies to every component)
// ---------------------------------------------------------------------------

export function map1(a, f) {
    if (Array.isArray(a)) {
        const out = new Array(a.length);
        for (let i = 0; i < a.length; i++) out[i] = f(a[i]);
        return out;
    }
    return f(num(a));
}

export function map2(a, b, f) {
    const aa = Array.isArray(a), ba = Array.isArray(b);
    if (!aa && !ba) return f(num(a), num(b));
    const n = Math.max(aa ? a.length : 1, ba ? b.length : 1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = f(aa ? (a[i] ?? 0) : num(a), ba ? (b[i] ?? 0) : num(b));
    return out;
}

export function map3(a, b, c, f) {
    const aa = Array.isArray(a), ba = Array.isArray(b), ca = Array.isArray(c);
    if (!aa && !ba && !ca) return f(num(a), num(b), num(c));
    const n = Math.max(aa ? a.length : 1, ba ? b.length : 1, ca ? c.length : 1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = f(aa ? (a[i] ?? 0) : num(a), ba ? (b[i] ?? 0) : num(b), ca ? (c[i] ?? 0) : num(c));
    }
    return out;
}

// ---------------------------------------------------------------------------
// GLSL built-ins (scalar versions; use map1/map2/map3 for vectors)
// ---------------------------------------------------------------------------

export const fract = x => x - Math.floor(x);
export const mod = (x, y) => x - y * Math.floor(x / y);          // GLSL mod: sign of y
export const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
export const mix = (a, b, t) => a * (1 - t) + b * t;
export const step = (edge, x) => (x < edge ? 0 : 1);
export const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
};
export const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const roundHalfAway = x => (x < 0 ? -Math.round(-x) : Math.round(x)); // GPUs round 0.5 away from zero

export function dot(a, b) {
    if (!Array.isArray(a) && !Array.isArray(b)) return num(a) * num(b);
    const n = Math.max(Array.isArray(a) ? a.length : 1, Array.isArray(b) ? b.length : 1);
    let s = 0;
    for (let i = 0; i < n; i++) s += (Array.isArray(a) ? (a[i] ?? 0) : num(a)) * (Array.isArray(b) ? (b[i] ?? 0) : num(b));
    return s;
}

export const length = v => (Array.isArray(v) ? Math.sqrt(dot(v, v)) : Math.abs(num(v)));
export const distance = (a, b) => length(map2(a, b, (x, y) => x - y));

export function cross(a, b) {
    const [ax, ay, az] = cast(a, 'vec3', 'vec3');
    const [bx, by, bz] = cast(b, 'vec3', 'vec3');
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

export function reflect(i, n) {
    const d = 2 * dot(n, i);
    return map2(i, n, (x, y) => x - d * y);
}

export function refract(i, n, eta) {
    const d = dot(n, i);
    const k = 1 - eta * eta * (1 - d * d);
    if (k < 0) return map1(i, () => 0);
    return map2(i, n, (x, y) => eta * x - (eta * d + Math.sqrt(k)) * y);
}

/** Parse a GLSL literal default ('0.5', 'vec3(1.0, 0.5, 0.0)', 'vec2(0.0)', 'true') into a JS value, or undefined. */
export function parseLiteral(s) {
    if (typeof s === 'number') return s;
    if (typeof s === 'boolean') return s;
    if (typeof s !== 'string') return undefined;
    const v = s.trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(\.\d*)?([eE][-+]?\d+)?$/.test(v) || /^-?\.\d+([eE][-+]?\d+)?$/.test(v)) return parseFloat(v);
    const m = v.match(/^(vec[234]|float|int)\s*\(([^()]*)\)$/);
    if (m) {
        const parts = m[2].split(',').map(p => p.trim()).filter(Boolean);
        if (!parts.length || !parts.every(p => /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(p))) return undefined;
        const nums = parts.map(Number);
        if (m[1] === 'float' || m[1] === 'int') return nums[0];
        const size = +m[1][3];
        if (nums.length === 1) return new Array(size).fill(nums[0]);
        if (nums.length === size) return nums;
        return undefined;
    }
    return undefined;
}

/** Compact display of a control value (node labels, get_project). */
export function formatValue(v, type, digits = 3) {
    const f = (x) => {
        if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : (x > 0 ? 'inf' : '-inf');
        if (Number.isInteger(x)) return String(x);
        const a = Math.abs(x);
        return a >= 1000 ? x.toFixed(0) : a >= 100 ? x.toFixed(1) : x.toFixed(digits);
    };
    if (v === undefined || v === null) return '–';
    if (type === 'string') return JSON.stringify(String(v));
    if (type === 'bool' || typeof v === 'boolean') return v ? 'true' : 'false';
    if (type === 'list') {
        const a = Array.isArray(v) ? v : [];
        const head = a.slice(0, 4).map(f).join(' ');
        return `[${a.length}] ${head}${a.length > 4 ? ' …' : ''}`;
    }
    if (Array.isArray(v)) return v.map(f).join(' ');
    return f(num(v));
}

/** JSON-friendly rounding for automation reports. */
export function roundValue(v, digits = 5) {
    if (typeof v === 'number') return Number.isFinite(v) ? +v.toFixed(digits) : String(v);
    if (Array.isArray(v)) return v.map(x => roundValue(x, digits));
    return v;
}
