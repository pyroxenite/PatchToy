/**
 * Param node kinds: one table shared by the node definition (GLSL), the canvas
 * node, the Parameters panel and automation. Pure data + helpers (no DOM).
 *
 * A Param node stores everything in node.data, so it is saved with the project:
 *   label        pretty name shown in the panel and on the node (any text)
 *   kind         float | int | bool | vec2 | vec3 | vec4 | color | enum | trigger | image
 *   value        current value (number, boolean, array, option index, press count or image src)
 *   default      value restored by "reset" (double-click a slider)
 *   min/max/step numeric range (float, int, vecN); scale 'linear' | 'log' (float, int)
 *   options      enum choices (array of strings); value is the selected index (outputs int)
 *   alpha        color: true = rgba (vec4), false = rgb (vec3)
 *   section      panel heading ('' = General)
 *   order        sort key inside the section
 *   description  tooltip in the panel
 *
 * Values are live uniforms named after the node (node_N): changing a value never
 * recompiles, changing kind (or color alpha) changes the GLSL and recompiles.
 */

export const PARAM_KINDS = ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'color', 'enum', 'trigger', 'image', 'text'];

const NUM_RANGE = { min: 0, max: 1, step: 0.01, scale: 'linear' };

/** Per-kind defaults and outputs. `uniform` is the GLSL type of the node's uniform. */
export const KIND_INFO = {
    float: { label: 'Float', uniform: 'float', value: 0.5, range: NUM_RANGE, outputs: [{ name: 'value', type: 'float' }] },
    int: { label: 'Int', uniform: 'int', value: 1, range: { min: 0, max: 10, step: 1, scale: 'linear' }, outputs: [{ name: 'value', type: 'int' }] },
    bool: { label: 'Bool', uniform: 'float', value: false, outputs: [{ name: 'value', type: 'float' }, { name: 'on', type: 'bool' }] },
    vec2: { label: 'Vec2', uniform: 'vec2', value: [0.5, 0.5], range: NUM_RANGE, outputs: [{ name: 'value', type: 'vec2' }] },
    vec3: { label: 'Vec3', uniform: 'vec3', value: [0.5, 0.5, 0.5], range: NUM_RANGE, outputs: [{ name: 'value', type: 'vec3' }] },
    vec4: { label: 'Vec4', uniform: 'vec4', value: [0.5, 0.5, 0.5, 1], range: NUM_RANGE, outputs: [{ name: 'value', type: 'vec4' }] },
    color: { label: 'Color', uniform: 'vec3', value: [1, 0.36, 0.17], outputs: [{ name: 'color', type: 'vec3' }] },
    enum: { label: 'Select', uniform: 'int', value: 0, outputs: [{ name: 'index', type: 'int' }] },
    trigger: {
        label: 'Trigger', uniform: 'vec3', value: 0,
        outputs: [{ name: 'pulse', type: 'float' }, { name: 'count', type: 'float' }, { name: 'since', type: 'float' }]
    },
    image: { label: 'Image', uniform: 'sampler2D', value: '', outputs: [{ name: 'tex', type: 'sampler2D' }] },
    // A string: control-rate only (no uniform). Feed Text Texture, JS inputs, Text Pick...
    text: { label: 'Text', uniform: null, value: 'HELLO', outputs: [{ name: 'text', type: 'string' }] },
};

export const VEC_SIZE = { vec2: 2, vec3: 3, vec4: 4 };

export function normalizeKind(kind) {
    const k = String(kind || '').toLowerCase().trim();
    if (PARAM_KINDS.includes(k)) return k;
    const alias = { number: 'float', integer: 'int', boolean: 'bool', toggle: 'bool', checkbox: 'bool', select: 'enum', button: 'trigger', bang: 'trigger', texture: 'image', sampler2d: 'image', xy: 'vec2', rgb: 'color', rgba: 'color', string: 'text', label: 'text', word: 'text' };
    return alias[k] || null;
}

/** Output ports for a param's data. */
export function paramOutputs(data) {
    const kind = normalizeKind(data && data.kind) || 'float';
    if (kind === 'color') return [{ name: 'color', type: data.alpha ? 'vec4' : 'vec3' }];
    return KIND_INFO[kind].outputs.map(o => ({ ...o }));
}

/** GLSL type of the param's uniform. */
export function paramUniformType(data) {
    const kind = normalizeKind(data && data.kind) || 'float';
    if (kind === 'color') return data.alpha ? 'vec4' : 'vec3';
    return KIND_INFO[kind].uniform;
}

const num = (v, fb) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fb));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Numeric range of a param, with kind defaults (min < max guaranteed). */
export function paramRange(data) {
    const kind = normalizeKind(data.kind) || 'float';
    const r = KIND_INFO[kind].range || NUM_RANGE;
    let min = num(data.min, r.min);
    let max = num(data.max, r.max);
    if (!(max > min)) max = min + (kind === 'int' ? 1 : 1);
    let step = num(data.step, kind === 'int' ? 1 : r.step);
    if (!(step > 0)) step = kind === 'int' ? 1 : 0;
    if (kind === 'int') step = Math.max(1, Math.round(step));
    const scale = data.scale === 'log' && min > 0 ? 'log' : 'linear';
    return { min, max, step, scale };
}

/** Round to the param's step (no step = 4 significant decimals). */
export function snap(v, range, kind) {
    if (kind === 'int') return Math.round(v);
    if (range.step > 0) {
        const s = range.step;
        const decimals = Math.min(8, Math.max(0, -Math.floor(Math.log10(s)) + 1));
        return +((Math.round(v / s) * s).toFixed(decimals));
    }
    return +v.toFixed(4);
}

/** Map a value to 0..1 along the slider (honours log scale). */
export function valueToUnit(v, range) {
    const { min, max, scale } = range;
    if (scale === 'log') return clamp(Math.log(clamp(v, min, max) / min) / Math.log(max / min), 0, 1);
    return clamp((v - min) / (max - min), 0, 1);
}

export function unitToValue(t, range) {
    const { min, max, scale } = range;
    t = clamp(t, 0, 1);
    if (scale === 'log') return min * Math.pow(max / min, t);
    return min + (max - min) * t;
}

/** Default value for a kind (a fresh copy). */
export function kindDefault(kind, data = {}) {
    const k = normalizeKind(kind) || 'float';
    if (k === 'color') return data.alpha ? [1, 0.36, 0.17, 1] : [1, 0.36, 0.17];
    const v = KIND_INFO[k].value;
    return Array.isArray(v) ? [...v] : v;
}

/** Parse "#rrggbb" / "#rrggbbaa" into 0..1 components. */
export function hexToRgba(hex) {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const c = m[1];
    const out = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
    out.push(m[2] ? parseInt(m[2], 16) / 255 : 1);
    return out;
}

export function rgbToHex(rgb) {
    const h = (x) => Math.round(clamp(num(x, 0), 0, 1) * 255).toString(16).padStart(2, '0');
    return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
}

/**
 * Coerce any input into a valid value for the param (used by the panel, the canvas,
 * set_param and set_node_data). Throws on values that cannot be interpreted.
 */
export function coerceParamValue(data, raw) {
    const kind = normalizeKind(data.kind) || 'float';
    const range = paramRange(data);
    switch (kind) {
        case 'float':
        case 'int': {
            let v = typeof raw === 'boolean' ? (raw ? 1 : 0) : num(Array.isArray(raw) ? raw[0] : raw, NaN);
            if (!Number.isFinite(v)) throw new Error(`a ${kind} param needs a number (got ${JSON.stringify(raw)})`);
            if (kind === 'int') v = Math.round(v);
            return v;
        }
        case 'bool':
            if (typeof raw === 'string') return raw === 'true' || raw === '1' || raw === 'on';
            return !!(Array.isArray(raw) ? raw[0] : raw);
        case 'vec2':
        case 'vec3':
        case 'vec4': {
            const n = VEC_SIZE[kind];
            let arr;
            if (Array.isArray(raw)) arr = raw;
            else if (raw && typeof raw === 'object') arr = ['x', 'y', 'z', 'w'].slice(0, n).map(k => raw[k]);
            else if (typeof raw === 'number') arr = new Array(n).fill(raw);
            else throw new Error(`a ${kind} param needs an array of ${n} numbers (got ${JSON.stringify(raw)})`);
            const prev = Array.isArray(data.value) ? data.value : kindDefault(kind);
            return Array.from({ length: n }, (_, i) => num(arr[i], num(prev[i], 0)));
        }
        case 'color': {
            const n = data.alpha ? 4 : 3;
            let arr = null;
            if (typeof raw === 'string') arr = hexToRgba(raw);
            else if (Array.isArray(raw)) arr = raw;
            else if (raw && typeof raw === 'object') arr = [raw.r, raw.g, raw.b, raw.a];
            if (!arr) throw new Error(`a color param needs "#rrggbb" or [r, g, b${data.alpha ? ', a' : ''}] in 0..1 (got ${JSON.stringify(raw)})`);
            return Array.from({ length: n }, (_, i) => clamp(num(arr[i], i === 3 ? 1 : 0), 0, 1));
        }
        case 'enum': {
            const options = Array.isArray(data.options) ? data.options : [];
            let v = typeof raw === 'string' && options.includes(raw) ? options.indexOf(raw) : num(raw, NaN);
            if (!Number.isFinite(v)) throw new Error(`a select param needs an option index or one of ${JSON.stringify(options)} (got ${JSON.stringify(raw)})`);
            return clamp(Math.round(v), 0, Math.max(0, options.length - 1));
        }
        case 'trigger':
            return Math.max(0, Math.round(num(raw, 0)));
        case 'image':
            return raw == null ? '' : String(raw);
        case 'text':
            return raw == null ? '' : (Array.isArray(raw) ? raw.join(' ') : String(raw));
    }
    return raw;
}

/**
 * Make node.data consistent (missing fields, a value of the wrong shape after a
 * kind change). Mutates and returns data. Unknown kinds fall back to float.
 */
export function normalizeParamData(data) {
    const kind = normalizeKind(data.kind) || 'float';
    data.kind = kind;
    if (typeof data.label !== 'string') data.label = '';
    if (typeof data.section !== 'string') data.section = data.section == null ? '' : String(data.section);
    if (!Number.isFinite(data.order)) data.order = num(data.order, 0);
    if (typeof data.description !== 'string') data.description = data.description == null ? '' : String(data.description);
    if (kind === 'color') data.alpha = !!data.alpha;
    if (kind === 'enum') {
        if (!Array.isArray(data.options) || !data.options.length) data.options = ['One', 'Two', 'Three'];
        data.options = data.options.map(String);
    }
    if (KIND_INFO[kind].range) {
        const r = paramRange(data);
        data.min = r.min; data.max = r.max; data.step = r.step;
        if (kind === 'float' || kind === 'int') data.scale = r.scale;
    }
    const fix = (v) => {
        try { return coerceParamValue(data, v); } catch (e) { return kindDefault(kind, data); }
    };
    data.value = data.value === undefined ? kindDefault(kind, data) : fix(data.value);
    if (kind === 'trigger' || kind === 'image') delete data.default;
    else data.default = data.default === undefined ? (Array.isArray(data.value) ? [...data.value] : data.value) : fix(data.default);
    return data;
}

/** The uniform value pushed to the GPU (trigger: [pulse, count, pressTime]). */
export function paramUniformValue(data, runtime = {}) {
    const kind = normalizeKind(data.kind) || 'float';
    const v = data.value;
    switch (kind) {
        case 'float': return num(v, 0);
        case 'int': case 'enum': return Math.round(num(v, 0));
        case 'bool': return v ? 1 : 0;
        case 'vec2': case 'vec3': case 'vec4': case 'color':
            return Array.isArray(v) ? v.map(x => num(x, 0)) : kindDefault(kind, data);
        case 'trigger': return [runtime.pulse ? 1 : 0, num(v, 0), num(runtime.pressTime, -1e4)];
        case 'image': return 0;
        case 'text': return 0; // control-only (no uniform)
    }
    return 0;
}

/** Short human readout of the current value (canvas + panel). */
export function formatParamValue(data) {
    const kind = normalizeKind(data.kind) || 'float';
    const v = data.value;
    const f = (x) => {
        const n = num(x, 0);
        const a = Math.abs(n);
        if (Number.isInteger(n)) return String(n);
        return a >= 100 ? n.toFixed(1) : a >= 10 ? n.toFixed(2) : n.toFixed(3);
    };
    switch (kind) {
        case 'float': case 'int': return f(v);
        case 'bool': return v ? 'on' : 'off';
        case 'vec2': case 'vec3': case 'vec4': return (Array.isArray(v) ? v : []).map(f).join(', ');
        case 'color': {
            const hex = rgbToHex(v || [0, 0, 0]).toUpperCase();
            return data.alpha && Array.isArray(v) ? `${hex} · ${Math.round(num(v[3], 1) * 100)}%` : hex;
        }
        case 'enum': {
            const opts = Array.isArray(data.options) ? data.options : [];
            return opts[Math.round(num(v, 0))] ?? '—';
        }
        case 'trigger': return `× ${num(v, 0)}`;
        case 'text': return JSON.stringify(String(v ?? ''));
        case 'image': return v ? (data.imageName || (String(v).startsWith('data:') ? 'image' : String(v).split('/').pop())) : 'no image';
    }
    return String(v);
}

/** Label shown for a param (falls back to "Param N"). */
export function paramLabel(node) {
    const l = node && node.data && typeof node.data.label === 'string' ? node.data.label.trim() : '';
    return l || `Param ${node ? node.id : ''}`.trim();
}

/** Param nodes of a graph in panel order: section (first appearance by order), then order, then id. */
export function sortedParams(nodes) {
    const params = nodes.filter(n => n && n.isParamNode);
    params.sort((a, b) => (num(a.data.order, 0) - num(b.data.order, 0)) || (a.id - b.id));
    const sections = [];
    const bySection = new Map();
    for (const p of params) {
        const s = (p.data.section || '').trim();
        if (!bySection.has(s)) { bySection.set(s, []); sections.push(s); }
        bySection.get(s).push(p);
    }
    return sections.map(name => ({ name, params: bySection.get(name) }));
}

/**
 * After a kind change: when the range is still the old kind's default (or missing),
 * use the new kind's default range (float 0..1 -> int 0..10). Mutates data.
 */
export function adoptKindRange(data, oldKind, newKind) {
    const to = KIND_INFO[newKind] && KIND_INFO[newKind].range;
    if (!to) return data;
    const from = KIND_INFO[oldKind] && KIND_INFO[oldKind].range;
    const untouched = !from || (data.min === undefined && data.max === undefined) ||
        (Number(data.min) === from.min && Number(data.max) === from.max && (data.step === undefined || Number(data.step) === from.step));
    if (untouched) Object.assign(data, { min: to.min, max: to.max, step: to.step });
    if (newKind === 'int') data.step = Math.max(1, Math.round(Number(data.step) || 1));
    return data;
}
