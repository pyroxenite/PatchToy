import { NodeDefinitions } from './NodeDefinitions.js';

/**
 * Custom node policy (security review H1).
 *
 * - Names are identifiers (letter first, then letters, digits, _; at most 49) and never
 *   Object.prototype keys, so a project can't define "__proto__" / "constructor".
 * - A custom node can never replace a built-in node (UV, Preview, Noise, ...).
 * - Two scopes: the user's **library** (localStorage `patchtoy_custom_nodes`, only
 *   written by the user's own actions: create / edit / "Keep in my library" / saving a
 *   project) and **project** nodes (registered from an opened project, in memory and in
 *   that project's autosave only). Opening a community project never writes the library.
 *
 * The same name rule is enforced server-side (infra/lambda/shared/validate.ts).
 */

export const CUSTOM_NODE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,48}$/;
export const MAX_CUSTOM_NODES = 100;
export const MAX_CUSTOM_GLSL_LENGTH = 64 * 1024;
export const LIBRARY_KEY = 'patchtoy_custom_nodes';

const FORBIDDEN = new Set([...Object.getOwnPropertyNames(Object.prototype), '__proto__', 'prototype', 'constructor']);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** True when `name` is a built-in (non-custom) node type. */
export function isBuiltinNodeType(name) {
    if (typeof name !== 'string' || !own(NodeDefinitions, name)) return false;
    const def = NodeDefinitions[name];
    return !!def && !def.isCustomNode;
}

/** Why `name` can't be a custom node name, or null when it can. */
export function customNodeNameError(name) {
    const shown = String(name).slice(0, 60);
    if (typeof name !== 'string' || !CUSTOM_NODE_NAME_RE.test(name)) {
        return `“${shown}” isn’t a valid custom node name. Use letters, digits and _, starting with a letter (at most 49 characters).`;
    }
    if (FORBIDDEN.has(name)) return `“${shown}” is a reserved name.`;
    if (isBuiltinNodeType(name)) {
        return `“${shown}” is the name of a built-in node, so it can’t be redefined. Rename the function (or pick another @node name).`;
    }
    return null;
}

/** Why an embedded / stored custom node entry can't be used, or null. */
export function customNodeEntryError(name, entry) {
    const e = customNodeNameError(name);
    if (e) return e;
    if (!entry || typeof entry !== 'object' || typeof entry.customGLSL !== 'string' || !entry.customGLSL.trim()) {
        return `Custom node “${name}” has no GLSL code.`;
    }
    if (entry.customGLSL.length > MAX_CUSTOM_GLSL_LENGTH) return `Custom node “${name}” is too large.`;
    return null;
}

/**
 * Valid entries of an untrusted `customNodes` map (a project file, a cloud project,
 * an autosave), as Map(name -> GLSL). Invalid ones are reported through onDrop.
 */
export function sanitizeCustomNodeMap(map, onDrop = null) {
    const out = new Map();
    if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
    for (const name of Object.keys(map)) {
        const err = out.size >= MAX_CUSTOM_NODES ? 'too many custom nodes in one project' : customNodeEntryError(name, map[name]);
        if (err) {
            onDrop?.(name, err);
            continue;
        }
        out.set(name, map[name].customGLSL);
    }
    return out;
}

/**
 * The custom node definitions a project embeds: the ones its graph uses
 * (`all`: every registered custom node).
 */
export function collectCustomNodes(graphData, { all = false } = {}) {
    const used = new Set(((graphData && graphData.nodes) || []).map(n => n && n.type));
    const out = {};
    for (const [name, def] of Object.entries(NodeDefinitions)) {
        if (!def || !def.isCustomNode) continue;
        if (!all && !used.has(name)) continue;
        out[name] = { category: def.category, inputs: def.inputs, outputs: def.outputs, customGLSL: def.customGLSL };
    }
    return out;
}

function uniqueName(base, taken) {
    let name = base.slice(0, 42);
    let candidate = `${name}_custom`;
    for (let i = 2; isBuiltinNodeType(candidate) || taken.has(candidate) || FORBIDDEN.has(candidate); i++) candidate = `${name}_custom${i}`;
    return candidate;
}

/**
 * Read the user's library from localStorage (Map name -> GLSL), migrating entries
 * stored before 2.0: names that collide with a built-in node are renamed to
 * `<name>_custom`, invalid names are made valid, prototype keys are dropped.
 * Returns { library, changed, notes }.
 */
export function loadLibrary(storage = globalThis.localStorage) {
    const library = new Map();
    const notes = [];
    let raw = null;
    try {
        raw = JSON.parse(storage?.getItem(LIBRARY_KEY) || 'null');
    } catch (e) {
        notes.push('the stored custom node library was unreadable and was ignored');
        return { library, changed: false, notes };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { library, changed: false, notes };
    let changed = false;
    for (const name of Object.keys(raw)) {
        const entry = raw[name];
        if (!entry || typeof entry !== 'object' || typeof entry.customGLSL !== 'string' || !entry.customGLSL.trim()) {
            notes.push(`dropped “${name}” (no GLSL code)`);
            changed = true;
            continue;
        }
        if (FORBIDDEN.has(name)) {
            notes.push(`dropped “${name}” (reserved name)`);
            changed = true;
            continue;
        }
        let final = name;
        if (!CUSTOM_NODE_NAME_RE.test(final)) {
            final = final.replace(/[^A-Za-z0-9_]+/g, '_');
            if (!/^[A-Za-z]/.test(final)) final = `N${final}`;
            final = final.slice(0, 49);
        }
        if (isBuiltinNodeType(final) || library.has(final) || FORBIDDEN.has(final)) final = uniqueName(final, library);
        if (!CUSTOM_NODE_NAME_RE.test(final)) {
            notes.push(`dropped “${name}” (invalid name)`);
            changed = true;
            continue;
        }
        if (final !== name) {
            notes.push(`renamed “${name}” to “${final}”${isBuiltinNodeType(name) ? ' (it had the name of a built-in node)' : ''}`);
            changed = true;
        }
        library.set(final, entry.customGLSL);
    }
    return { library, changed, notes };
}

/** Persist the user's library (Map name -> GLSL). */
export function saveLibrary(library, defs = NodeDefinitions, storage = globalThis.localStorage) {
    const out = {};
    for (const [name, glsl] of library) {
        const def = own(defs, name) ? defs[name] : null;
        out[name] = def && def.customGLSL === glsl
            ? { category: def.category, inputs: def.inputs, outputs: def.outputs, customGLSL: glsl }
            : { customGLSL: glsl };
    }
    storage?.setItem(LIBRARY_KEY, JSON.stringify(out));
}
