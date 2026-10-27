/**
 * Node help: a floating panel over the right edge of the canvas describing one node
 * type (content from nodeHelpContent.js), with a live mini render or the node's
 * snapshot, and "Add to canvas". Also a small node reference: the search field at
 * the top lists every node type.
 *
 * Opened by HelpCenter: right-click → Help, F1, the "?" on library items, the Help menu.
 * Never modal: the canvas stays usable; Esc or the close button dismisses it.
 * Styles: .pt-help / .ph-* in style.css.
 */
import { NodeDefinitions } from '../../core/NodeDefinitions.js';
import { h, escapeHtml } from '../UIHelpers.js';
import { icon } from '../icons.js';
import { typeColor, listNodes, scoreNode, highlight, categoryColorFor } from '../nodeCatalog.js';
import { renderNodeSnapshot } from '../nodeSnapshot.js';
import { helpFor } from './nodeHelpContent.js';
import { createLivePreview } from './livePreview.js';

const PREVIEW_W = 316;
const PREVIEW_H = 150;

/** Light markup for definition prose: data.x / u_x / 'tokens' as code. */
function prose(text) {
    let s = escapeHtml(text || '');
    s = s.replace(/\b(data\.[A-Za-z_][\w.]*|u_[A-Za-z]\w*|pt_[A-Za-z]\w*\(\))/g, '<code>$1</code>');
    s = s.replace(/&#39;([^&\s][^&]{0,24}?)&#39;|'([^'\s][^']{0,24}?)'/g, (m, a, b) => `<code>${a || b}</code>`);
    return s;
}

function typeChip(type, typeName) {
    if (!type) return '';
    return `<span class="ph-type" style="--tc:${typeColor(type)}" title="${escapeHtml(typeName || type)}">${escapeHtml(type)}</span>`;
}

function badgeHtml(b) {
    return `<span class="ph-badge ph-badge--${escapeHtml(b.kind)}">${escapeHtml(b.label)}</span>`;
}

export class NodeHelpPanel {
    constructor(app) {
        this.app = app;
        this.el = null;
        this.type = null;
        this.live = null;
        this.query = '';
        this._onKey = (e) => {
            if (e.key !== 'Escape' || !this.isOpen()) return;
            // Let open menus / dialogs close first (they handle Escape in the capture phase)
            if (document.querySelector('.pt-modal-backdrop, .pt-menu')) return;
            if (this.el.contains(document.activeElement) && this.searchEl.value && document.activeElement === this.searchEl) {
                this.searchEl.value = '';
                this.query = '';
                this.renderBody();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            this.close();
        };
    }

    get graph() { return this.app.nodeGraph; }

    isOpen() { return !!(this.el && this.el.classList.contains('is-open')); }

    build() {
        if (this.el) return;
        this.el = h('aside', { className: 'pt-help', role: 'dialog', 'aria-label': 'Node help' });
        this.head = h('div', { className: 'ph-head' });
        const searchWrap = h('div', { className: 'ph-search pt-input-group' });
        searchWrap.innerHTML = icon('search');
        this.searchEl = h('input', { className: 'pt-input', type: 'search', placeholder: 'Search the node reference', spellcheck: false, autocomplete: 'off' });
        searchWrap.appendChild(this.searchEl);
        this.body = h('div', { className: 'ph-body' });
        this.foot = h('div', { className: 'ph-foot' });
        this.el.append(this.head, searchWrap, this.body, this.foot);
        document.body.appendChild(this.el);

        this.searchEl.addEventListener('input', () => {
            this.query = this.searchEl.value;
            this.renderBody();
        });
        this.searchEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const first = this.body.querySelector('.ph-result');
                if (first) { e.preventDefault(); this.show(first.dataset.type); }
            } else if (e.key === 'ArrowDown') {
                const first = this.body.querySelector('.ph-result');
                if (first) { e.preventDefault(); first.focus(); }
            }
        });
        this.body.addEventListener('click', (e) => {
            const r = e.target.closest('.ph-result, .ph-link');
            if (r && r.dataset.type) this.show(r.dataset.type);
        });
        this.body.addEventListener('keydown', (e) => {
            const r = e.target.closest('.ph-result');
            if (!r) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.show(r.dataset.type); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); r.nextElementSibling?.focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); (r.previousElementSibling || this.searchEl).focus(); }
        });
        // Keys typed in the panel never reach canvas shortcuts (Delete, Tab, P...)
        this.el.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's')) return;
            e.stopPropagation();
        });
        this.el.addEventListener('mousedown', (e) => e.stopPropagation());
        window.addEventListener('keydown', this._onKey, true);
        window.addEventListener('resize', () => this.place());
    }

    /** Keep clear of the Parameters panel when it is open. */
    place() {
        if (!this.el) return;
        const pp = document.getElementById('paramsPanel');
        const app = document.getElementById('app');
        let right = 12;
        if (pp && app && app.classList.contains('is-params-open')) {
            const r = pp.getBoundingClientRect();
            if (r.width > 0) right = Math.max(12, window.innerWidth - r.left + 10);
        }
        this.el.style.right = `${Math.round(right)}px`;
    }

    /** Open on a node type (or the reference list with type = null). */
    show(type = null, { focusSearch = false } = {}) {
        this.build();
        if (type && !NodeDefinitions[type]) type = null;
        this.type = type;
        this.query = type ? '' : this.query;
        this.searchEl.value = this.query;
        this.place();
        this.el.classList.add('is-open');
        this.renderBody();
        if (focusSearch || !type) requestAnimationFrame(() => this.searchEl.focus());
        return this;
    }

    close() {
        if (!this.el) return;
        this.el.classList.remove('is-open');
        this.stopLive();
        this.type = null;
    }

    toggle(type) {
        if (this.isOpen() && this.type === type) this.close();
        else this.show(type);
    }

    stopLive() {
        if (this.live) {
            this.live.destroy();
            this.live = null;
        }
    }

    renderBody() {
        this.stopLive();
        this.body.scrollTop = 0;
        if (this.query.trim() || !this.type) {
            this.renderSearch();
            return;
        }
        const info = helpFor(this.type);
        if (!info) { this.renderSearch(); return; }
        this.renderHead(info);
        this.renderNode(info);
        this.renderFoot(info);
    }

    renderHead(info) {
        this.el.style.setProperty('--dot', info ? info.color : 'var(--accent)');
        this.head.innerHTML = '';
        const title = h('div', { className: 'ph-title-wrap' });
        if (info) {
            title.innerHTML = `<span class="ph-kicker">${escapeHtml(info.categoryLabel)}${info.isCustom ? ' · custom GLSL' : ''}</span>
                <span class="ph-title">${escapeHtml(info.title)}</span>`;
        } else {
            title.innerHTML = `<span class="ph-kicker">Help</span><span class="ph-title">Node reference</span>`;
        }
        const close = h('button', { className: 'pt-icon-btn pt-icon-btn--sm', type: 'button', 'aria-label': 'Close help', 'data-tip': 'Close', 'data-kbd': 'Esc', onClick: () => this.close() });
        close.innerHTML = icon('close');
        this.head.append(h('span', { className: 'ph-dot', 'aria-hidden': 'true' }), title, close);
    }

    renderFoot(info) {
        this.foot.innerHTML = '';
        if (!info) { this.foot.hidden = true; return; }
        this.foot.hidden = false;
        const add = h('button', { className: 'pt-btn pt-btn--primary ph-add', type: 'button', onClick: () => this.addToCanvas(info.type) });
        add.innerHTML = `${icon('plus')}<span>Add to canvas</span>`;
        const all = h('button', { className: 'pt-btn pt-btn--ghost', type: 'button', onClick: () => { this.type = null; this.renderBody(); this.searchEl.focus(); } });
        all.innerHTML = `${icon('search')}<span>All nodes</span>`;
        this.foot.append(all, add);
    }

    addToCanvas(type) {
        const lib = this.app.shell && this.app.shell.library;
        const node = lib ? lib.addNodeAtCenter(type) : this.graph.addNode(type, 200, 200);
        if (node) this.graph.render();
    }

    renderNode(info) {
        const b = this.body;
        b.innerHTML = '';
        if (info.description) b.appendChild(h('p', { className: 'ph-desc', html: prose(info.description) }));

        // Live mini render, else the node as drawn on the canvas
        const stage = h('div', { className: 'ph-stage' });
        const def = NodeDefinitions[info.type];
        this.live = createLivePreview(info.type, def, this.graph, { width: PREVIEW_W, height: PREVIEW_H });
        if (this.live) {
            stage.classList.add('is-live');
            stage.appendChild(this.live.canvas);
            stage.appendChild(h('span', { className: 'ph-stage-tag', text: 'Live · default inputs' }));
        } else {
            const snap = renderNodeSnapshot(info.type, this.graph, { scale: 1 });
            if (snap) {
                const scale = Math.min(1, PREVIEW_W / snap.width, 220 / snap.height);
                snap.canvas.style.width = `${snap.width * scale}px`;
                snap.canvas.style.height = `${snap.height * scale}px`;
                stage.appendChild(snap.canvas);
            } else {
                stage.hidden = true;
            }
        }
        b.appendChild(stage);

        for (const n of info.notes) {
            const note = h('div', { className: 'ph-note' });
            note.innerHTML = `<div class="ph-note-title">${icon('spark', { size: 12 })}<span>${escapeHtml(n.title)}</span></div>
                <p>${prose(n.body)}</p>${n.tip ? `<p class="ph-tip"><strong>Try</strong> ${prose(n.tip)}</p>` : ''}`;
            b.appendChild(note);
        }

        b.appendChild(this.portSection('Inputs', info.inputs, true, info.dynamicPorts && !info.inputs.length ? info.dynamicPorts : (info.inputs.length ? '' : 'No inputs.')));
        b.appendChild(this.portSection('Outputs', info.outputs, false, info.dynamicPorts && !info.outputs.length ? info.dynamicPorts : (info.outputs.length ? '' : 'No outputs: it shows or does something on its own.')));

        if (info.amount) {
            const sec = h('section', { className: 'ph-sec' });
            sec.innerHTML = `<div class="ph-sec-title"><span>Amount</span><span class="ph-badge ph-badge--amount">${escapeHtml(info.amount.input)}</span></div>
                <p class="ph-text">${prose(info.amount.summary)}</p>
                ${info.amount.bypass.length ? `<p class="ph-text ph-faint">At 0: ${info.amount.bypass.map(x => `<code>${escapeHtml(x)}</code>`).join(' · ')}</p>` : ''}`;
            b.appendChild(sec);
        }
        if (info.rate) {
            const sec = h('section', { className: 'ph-sec' });
            const label = { control: 'control rate', source: 'CPU source', infer: 'adaptive', pixel: 'pixel rate' }[info.rate.kind] || info.rate.kind;
            sec.innerHTML = `<div class="ph-sec-title"><span>Rate</span><span class="ph-badge ph-badge--${info.rate.kind === 'pixel' ? 'pixel' : 'control'}">${escapeHtml(label)}</span></div>
                <p class="ph-text">${prose(info.rate.summary)}</p>
                ${info.rate.details.map(d => `<p class="ph-text ph-faint">${prose(d)}</p>`).join('')}`;
            b.appendChild(sec);
        }
    }

    portSection(title, ports, isInput, emptyText) {
        const sec = h('section', { className: 'ph-sec' });
        sec.appendChild(h('div', { className: 'ph-sec-title', html: `<span>${title}</span><span class="ph-count">${ports.length || ''}</span>` }));
        if (!ports.length) {
            sec.appendChild(h('p', { className: 'ph-text ph-faint', text: emptyText || '' }));
            return sec;
        }
        const list = h('div', { className: 'ph-ports' });
        for (const p of ports) {
            const row = h('div', { className: 'ph-port' });
            const def = isInput && p.default ? `<span class="ph-default" title="Default when unconnected">= ${escapeHtml(p.default)}</span>` : '';
            row.innerHTML = `<div class="ph-port-head"><span class="ph-port-dot" style="--tc:${typeColor(p.type)}"></span>
                    <span class="ph-port-name">${escapeHtml(p.name)}</span>${typeChip(p.type, p.typeName)}${p.badges.map(badgeHtml).join('')}${def}</div>
                ${p.description ? `<div class="ph-port-desc">${prose(p.description)}</div>` : ''}`;
            list.appendChild(row);
        }
        sec.appendChild(list);
        return sec;
    }

    renderSearch() {
        this.renderHead(null);
        this.foot.hidden = true;
        const q = this.query.trim();
        let nodes = listNodes();
        if (q) {
            nodes = nodes.map(n => ({ n, s: scoreNode(n, q) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.n);
        }
        const b = this.body;
        b.innerHTML = '';
        if (!q) b.appendChild(h('p', { className: 'ph-text ph-faint ph-search-hint', text: `${nodes.length} node types. Type to filter, Enter opens the first.` }));
        if (!nodes.length) {
            b.appendChild(h('p', { className: 'ph-text ph-faint', html: `No nodes match <strong>${escapeHtml(q)}</strong>.` }));
            return;
        }
        const list = h('div', { className: 'ph-results' });
        for (const n of nodes.slice(0, 80)) {
            const desc = (n.def.description || '').split(/(?<=\.)\s/)[0];
            const row = h('div', { className: 'ph-result', tabIndex: 0, role: 'button', 'data-type': n.name });
            row.style.setProperty('--dot', categoryColorFor(n.category));
            row.innerHTML = `<span class="ph-result-dot"></span><span class="ph-result-text"><span class="ph-result-name">${highlight(n.title, q)}</span>
                <span class="ph-result-desc">${escapeHtml(desc.length > 90 ? desc.slice(0, 88) + '…' : desc)}</span></span>`;
            list.appendChild(row);
        }
        b.appendChild(list);
    }
}
