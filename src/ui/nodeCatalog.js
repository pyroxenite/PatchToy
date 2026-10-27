import { NodeDefinitions } from '../core/NodeDefinitions.js';
import { CATEGORY_LABELS, CATEGORY_COLORS, COLORS, typeColor } from './theme.js';

/**
 * Shared helpers to present NodeDefinitions in the DOM (Library sidebar,
 * Quick search). Everything is computed live from NodeDefinitions so node
 * types registered later (custom GLSL nodes, new library nodes) show up
 * automatically.
 *
 * A definition can opt out of the UI listings with `hidden: true`.
 */

const KNOWN_ORDER = Object.keys(CATEGORY_LABELS);

export function categoryKey(def) {
    return (def && def.category) ? String(def.category) : 'other';
}

export function categoryLabel(category) {
    if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
    const raw = String(category || 'other').replace(/[_-]+/g, ' ');
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function categoryColorFor(category) {
    return CATEGORY_COLORS[category] || COLORS.textFaint;
}

export function nodeTitle(name, def = NodeDefinitions[name]) {
    return (def && def.displayTitle) || name;
}

export function isListed(name, def) {
    return !!def && typeof def === 'object' && !def.hidden && !def.internal;
}

/** Sort category keys: theme order first, then unknown categories alphabetically. */
export function sortCategories(keys) {
    return [...keys].sort((a, b) => {
        const ia = KNOWN_ORDER.indexOf(a);
        const ib = KNOWN_ORDER.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.localeCompare(b);
    });
}

/** All listed nodes as [{ name, title, category, def }] in definition order. */
export function listNodes() {
    const out = [];
    for (const [name, def] of Object.entries(NodeDefinitions)) {
        if (!isListed(name, def)) continue;
        out.push({ name, title: nodeTitle(name, def), category: categoryKey(def), def });
    }
    return out;
}

/** Group nodes by category: [{ category, label, color, nodes: [...] }] */
export function groupNodes(nodes = listNodes()) {
    const map = new Map();
    for (const n of nodes) {
        if (!map.has(n.category)) map.set(n.category, []);
        map.get(n.category).push(n);
    }
    return sortCategories([...map.keys()]).map(category => ({
        category,
        label: categoryLabel(category),
        color: categoryColorFor(category),
        nodes: map.get(category)
    }));
}

/** Cheap signature of the catalog, used to detect changes. */
export function catalogSignature() {
    let sig = '';
    for (const [name, def] of Object.entries(NodeDefinitions)) {
        if (!isListed(name, def)) continue;
        sig += `${name}:${categoryKey(def)}:${def.displayTitle || ''}|`;
    }
    return sig;
}

/**
 * Score a node against a search query (0 = no match). Higher is better.
 */
export function scoreNode(node, query) {
    const q = query.trim().toLowerCase();
    if (!q) return 1;
    const title = node.title.toLowerCase();
    const name = node.name.toLowerCase();
    if (title === q || name === q) return 100;
    if (title.startsWith(q) || name.startsWith(q)) return 80;
    // word / camel-case boundary match
    const words = node.title.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_\-]+/);
    if (words.some(w => w.startsWith(q))) return 65;
    if (title.includes(q) || name.includes(q)) return 50;
    const label = categoryLabel(node.category).toLowerCase();
    if (label.startsWith(q) || node.category.toLowerCase().startsWith(q)) return 30;
    const desc = (node.def.description || '').toLowerCase();
    if (q.length > 2 && desc.includes(q)) return 15;
    // type match (e.g. "vec3" finds nodes producing vec3)
    const outs = (node.def.outputs || []).map(o => (o.type || '').toLowerCase());
    if (outs.includes(q)) return 20;
    return 0;
}

/** Wrap matched substring in <mark>. Returns HTML-safe string. */
export function highlight(text, query) {
    const safe = escape(text);
    const q = query.trim();
    if (!q) return safe;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return safe;
    return escape(text.slice(0, i)) + '<mark>' + escape(text.slice(i, i + q.length)) + '</mark>' + escape(text.slice(i + q.length));
}

function escape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function portName(port, fallback) {
    const n = port && (port.name || port.label);
    return n && String(n).trim() ? n : fallback;
}

/** Short type signature HTML: "vec2 float → vec3" with type colors. */
export function signatureHtml(def, { maxInputs = 3 } = {}) {
    const ins = def.inputs || [];
    const outs = def.outputs || [];
    const t = (type) => `<span class="tc" style="--tc:${typeColor(type)}">${escape(type || '?')}</span>`;
    let left = ins.slice(0, maxInputs).map(p => t(p.type)).join(' ');
    if (ins.length > maxInputs) left += ` +${ins.length - maxInputs}`;
    const right = outs.length ? outs.map(p => t(p.type)).join(' ') : '<span>out</span>';
    if (!ins.length) return right;
    return `${left} → ${right}`;
}

/** Element listing inputs → outputs with type colors (for cards / info panes). */
export function signatureElement(def) {
    const wrap = document.createElement('div');
    wrap.className = 'pt-sig';
    const col = (ports, side) => {
        const c = document.createElement('div');
        c.className = `pt-sig-col pt-sig-col--${side}`;
        if (!ports || !ports.length) {
            const e = document.createElement('span');
            e.className = 'pt-sig-empty';
            e.textContent = side === 'in' ? 'no inputs' : 'renders preview';
            c.appendChild(e);
            return c;
        }
        ports.forEach((p, i) => {
            const row = document.createElement('span');
            row.className = 'pt-port';
            row.style.setProperty('--tc', typeColor(p.type));
            const name = portName(p, side === 'in' ? `in${i}` : 'out');
            if (side === 'in') {
                row.innerHTML = `<span class="pt-port-dot"></span><span class="pt-port-name">${escape(name)}</span><span class="pt-port-type">${escape(p.type || '?')}</span>`;
            } else {
                row.innerHTML = `<span class="pt-port-type">${escape(p.type || '?')}</span><span class="pt-port-name">${escape(name)}</span><span class="pt-port-dot"></span>`;
            }
            c.appendChild(row);
        });
        return c;
    };
    wrap.appendChild(col(def.inputs, 'in'));
    const arrow = document.createElement('span');
    arrow.className = 'pt-sig-arrow';
    arrow.textContent = '→';
    wrap.appendChild(arrow);
    wrap.appendChild(col(def.outputs, 'out'));
    return wrap;
}

export { typeColor };
