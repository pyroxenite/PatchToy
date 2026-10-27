import { icon } from './icons.js';
import { UIHelpers, escapeHtml } from './UIHelpers.js';
import { ScenesSection } from './ScenesSection.js';
import { MidiLearnUI } from './MidiLearnUI.js';
import {
    sortedParams, paramLabel, paramRange, valueToUnit, unitToValue, snap, formatParamValue,
    normalizeKind, PARAM_KINDS, KIND_INFO, rgbToHex, hexToRgba, VEC_SIZE
} from '../core/paramKinds.js';

const OPEN_KEY = 'patchtoy_ui_params_open';
const COLLAPSED_KEY = 'patchtoy_ui_params_collapsed';
const DRAG_MIME = 'application/x-patchtoy-param';
const KIND_LABEL = {
    float: 'Float', int: 'Int', bool: 'Toggle', vec2: 'Vec2 / XY pad', vec3: 'Vec3', vec4: 'Vec4',
    color: 'Color', enum: 'Select', trigger: 'Button', image: 'Image', text: 'Text'
};
const COMP = ['x', 'y', 'z', 'w'];

const fmt = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0';
    if (Number.isInteger(n)) return String(n);
    return String(+n.toFixed(4));
};
const el = (tag, cls, props = {}) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k in e && typeof v !== 'string') e[k] = v;
        else e.setAttribute(k, v);
    }
    return e;
};

/**
 * Parameters panel: a DOM form docked right of the canvas listing every Param node of
 * the patch (all groups), grouped by data.section and sorted by data.order. It does
 * not depend on the canvas view (zoom, pan, open group) and follows a fullscreen
 * preview as a floating panel.
 */
export class ParamsPanel {
    constructor(app) {
        this.app = app;
        this.appEl = document.getElementById('app');
        this.root = document.getElementById('paramsPanel');
        this.listEl = document.getElementById('paramsList');
        this.countEl = document.getElementById('paramsCount');
        this.addBtn = document.getElementById('paramsAddBtn');
        this.toggleBtn = document.getElementById('paramsToggleBtn');
        this.home = this.root.parentElement;

        this.signature = null;
        this.rows = new Map();          // node id -> { el, update }
        this.editing = new Set();       // ids with the settings form open
        this.busy = null;               // control being dragged (skip its sync)
        this.pendingRename = null;
        this.valueRaf = 0;
        try {
            this.collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
        } catch (e) {
            this.collapsed = new Set();
        }

        // Before setOpen(): opening refreshes the list, which reads the scenes section
        this.scenes = new ScenesSection(this); // SceneSwitcher controls (top of the list)
        this.midi = new MidiLearnUI(this);     // MIDI learn: row badges, learn mode, mapping menu

        let open = false;
        try { open = localStorage.getItem(OPEN_KEY) === '1'; } catch (e) { /* ignore */ }
        this.setOpen(open, { persist: false });

        this.bindEvents();
        this.refresh(true);
        setInterval(() => this.refresh(), 300);
    }

    get graph() {
        return this.app.nodeGraph;
    }

    params() {
        return this.graph ? this.graph.nodes.filter(n => n.isParamNode) : [];
    }

    // ------------------------------------------------------------------
    // Open / close (+ fullscreen preview)
    // ------------------------------------------------------------------

    isOpen() {
        return this.appEl.classList.contains('is-params-open');
    }

    setOpen(open, { persist = true } = {}) {
        this.appEl.classList.toggle('is-params-open', open);
        this.root.setAttribute('aria-hidden', String(!open));
        if (this.toggleBtn) {
            this.toggleBtn.classList.toggle('is-active', open);
            this.toggleBtn.setAttribute('aria-pressed', String(open));
            this.toggleBtn.setAttribute('data-tip', open ? 'Hide parameters' : 'Show parameters');
            UIHelpers.refreshTooltip(this.toggleBtn);
        }
        this.syncFullscreen();
        if (persist) {
            try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) { /* ignore */ }
        }
        if (open) this.refresh(true);
    }

    toggle() {
        this.setOpen(!this.isOpen());
    }

    /** In a fullscreen preview the panel floats over it (reparented into the overlay). */
    syncFullscreen() {
        const fs = document.fullscreenElement;
        const overlay = fs && fs.classList && fs.classList.contains('pt-fullscreen') ? fs : document.querySelector('.pt-fullscreen');
        if (overlay && this.isOpen()) {
            if (this.root.parentElement !== overlay) overlay.appendChild(this.root);
            this.root.classList.add('is-floating');
        } else if (this.root.parentElement !== this.home) {
            this.root.classList.remove('is-floating');
            this.home.appendChild(this.root);
        } else {
            this.root.classList.remove('is-floating');
        }
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    bindEvents() {
        this.toggleBtn?.addEventListener('click', () => this.toggle());
        this.addBtn?.addEventListener('click', () => this.addParam());

        // Clicks / keys inside the panel must not reach the canvas or a fullscreen overlay
        for (const type of ['click', 'mousedown', 'dblclick', 'wheel', 'contextmenu']) {
            this.root.addEventListener(type, (e) => e.stopPropagation());
        }
        // Keys typed in the panel never edit the canvas (Delete would remove selected nodes);
        // app shortcuts (P, \\, Cmd/Ctrl+...) still work outside text fields.
        this.root.addEventListener('keydown', (e) => {
            if (e.metaKey || e.ctrlKey) return;
            const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
            if (!typing && (e.key === 'p' || e.key === 'P' || e.key === '\\' || e.key === 'Escape')) return;
            e.stopPropagation();
        });

        window.addEventListener('patchtoy:param', (e) => {
            const what = e.detail && e.detail.what;
            if (what === 'meta') this.refresh();
            else this.scheduleValues();
        });
        window.addEventListener('patchtoy:scope', () => this.scheduleValues());
        document.addEventListener('fullscreenchange', () => this.syncFullscreen());
        // The fullscreen overlay exists before the browser enters fullscreen
        new MutationObserver(() => this.syncFullscreen()).observe(document.body, { childList: true });

        // Drop an image file onto an image Param on the canvas
        const container = document.getElementById('container');
        container?.addEventListener('drop', (e) => {
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file || !/^image\//.test(file.type) || !this.graph) return;
            const pos = this.graph.getMousePos(e);
            const items = this.graph.getViewNodes();
            for (let i = items.length - 1; i >= 0; i--) {
                const n = items[i];
                if (n.isParamNode && n.kind === 'image' && n.containsPoint(pos.x, pos.y)) {
                    e.preventDefault();
                    e.stopPropagation();
                    n.loadImageFile(file).catch(err => UIHelpers.toast(err.message, 'error'));
                    return;
                }
            }
        }, true);

        // Section headers + reordering (delegated)
        this.listEl.addEventListener('click', (e) => {
            const head = e.target.closest('.pp-section-head');
            if (!head) return;
            const name = head.parentElement.dataset.section;
            if (this.collapsed.has(name)) this.collapsed.delete(name);
            else this.collapsed.add(name);
            try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed])); } catch (err) { /* ignore */ }
            this.refresh(true);
        });
        this.listEl.addEventListener('dragover', (e) => this.onDragOver(e));
        this.listEl.addEventListener('dragleave', (e) => {
            if (!this.listEl.contains(e.relatedTarget)) this.clearDropMarks();
        });
        this.listEl.addEventListener('drop', (e) => this.onDrop(e));
    }

    scheduleValues() {
        if (this.valueRaf) return;
        this.valueRaf = requestAnimationFrame(() => {
            this.valueRaf = 0;
            for (const row of this.rows.values()) {
                try { row.update(); } catch (e) { /* node gone */ }
            }
        });
    }

    // ------------------------------------------------------------------
    // Structure
    // ------------------------------------------------------------------

    structureSignature(sections) {
        const parts = [this.isOpen() ? 'o' : 'c', [...this.editing].join(','), [...this.collapsed].join('|'), this.scenes ? this.scenes.signature() : ''];
        for (const s of sections) {
            parts.push(`#${s.name}`);
            for (const n of s.params) {
                const d = n.data;
                parts.push([n.id, d.label, d.kind, d.order, d.alpha ? 1 : 0, (d.options || []).join('\u0001'),
                    d.min, d.max, d.step, d.scale, d.description, d.wrap, d.filter].join('\u0002'));
            }
        }
        return parts.join('\n');
    }

    refresh(force = false) {
        if (!this.graph) return;
        const sections = sortedParams(this.graph.nodes);
        const count = sections.reduce((a, s) => a + s.params.length, 0);
        if (this.countEl) this.countEl.textContent = count ? String(count) : '';
        if (this.toggleBtn) {
            if (count) this.toggleBtn.dataset.count = String(count);
            else delete this.toggleBtn.dataset.count;
        }
        for (const id of [...this.editing]) {
            if (!this.graph.nodes.some(n => n.id === id && n.isParamNode)) this.editing.delete(id);
        }
        if (!this.isOpen() && !force) return;
        const sig = this.structureSignature(sections);
        if (!force && sig === this.signature) {
            this.scheduleValues();
            return;
        }
        // Never rebuild under the user's hands (typing in a field or dragging a control)
        const active = document.activeElement;
        if (!force && (this.busy || (active && this.root.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName)))) return;
        this.signature = sig;
        this.render(sections, count);
    }

    render(sections, count) {
        const scroll = this.listEl.scrollTop;
        this.listEl.innerHTML = '';
        this.rows.clear();
        const scenesEl = this.scenes ? this.scenes.build() : null;
        if (scenesEl) this.listEl.appendChild(scenesEl);
        if (!count) {
            if (!scenesEl) this.listEl.appendChild(this.emptyState());
            return;
        }
        for (const s of sections) {
            const sec = el('div', 'pp-section' + (this.collapsed.has(s.name) ? ' is-collapsed' : ''));
            sec.dataset.section = s.name;
            const head = el('button', 'pp-section-head', { type: 'button' });
            head.innerHTML = `${icon('chevronRight')}<span class="pp-section-title">${escapeHtml(s.name || 'General')}</span><span class="pp-section-count">${s.params.length}</span>`;
            sec.appendChild(head);
            const body = el('div', 'pp-section-body');
            for (const node of s.params) {
                const row = this.buildRow(node);
                body.appendChild(row.el);
                this.rows.set(node.id, row);
            }
            sec.appendChild(body);
            this.listEl.appendChild(sec);
        }
        this.listEl.scrollTop = scroll;
        if (this.pendingRename !== null) {
            const id = this.pendingRename;
            this.pendingRename = null;
            const row = this.rows.get(id);
            if (row) {
                row.el.scrollIntoView({ block: 'nearest' });
                row.startRename();
            }
        }
    }

    emptyState() {
        const box = el('div', 'pp-empty');
        box.innerHTML = `
            <div class="pp-empty-icon">${icon('sliders')}</div>
            <div class="pp-empty-title">No parameters yet</div>
            <div class="pp-empty-sub">Add a <strong>Param</strong> node (<kbd>Tab</kbd> → “Param”) and give it a name. Every Param in the patch shows up here, in any group, at any zoom.</div>`;
        const btn = el('button', 'pt-btn pt-btn--sm pt-btn--outline', { type: 'button' });
        btn.innerHTML = `${icon('plus')}<span>Add a parameter</span>`;
        btn.addEventListener('click', () => this.addParam());
        box.appendChild(btn);
        return box;
    }

    // ------------------------------------------------------------------
    // Rows
    // ------------------------------------------------------------------

    buildRow(node) {
        const d = node.data;
        const kind = normalizeKind(d.kind) || 'float';
        const row = el('div', `pp-row pp-row--${kind}` + (this.editing.has(node.id) ? ' is-editing' : ''));
        row.dataset.id = String(node.id);

        // Head: grip, label (double-click to rename), kind badge, actions
        const head = el('div', 'pp-row-head');
        const grip = el('span', 'pp-grip', { 'data-tip': 'Drag to reorder', 'aria-hidden': 'true' });
        grip.innerHTML = icon('grip');
        const label = el('span', 'pp-label', { text: paramLabel(node) });
        label.setAttribute('data-tip', d.description ? d.description : 'Double-click to rename');
        const badge = el('span', 'pp-kind', { text: kind === 'color' && d.alpha ? 'rgba' : kind });
        const edit = el('button', 'pt-icon-btn pt-icon-btn--sm pp-act' + (this.editing.has(node.id) ? ' is-active' : ''), { type: 'button', 'data-tip': 'Parameter settings', 'aria-label': 'Parameter settings' });
        edit.innerHTML = icon('gear');
        const locate = el('button', 'pt-icon-btn pt-icon-btn--sm pp-act', { type: 'button', 'data-tip': 'Locate on canvas', 'aria-label': 'Locate node' });
        locate.innerHTML = icon('target');
        head.append(grip, label, badge, edit, locate);
        row.appendChild(head);
        const midiUpdate = this.midi ? this.midi.decorateRow(node, row, head, edit) : null;

        const startRename = () => {
            const input = el('input', 'pt-input pp-rename', { type: 'text', value: d.label || '', placeholder: paramLabel(node), spellcheck: false });
            label.replaceWith(input);
            input.focus();
            input.select();
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                if (ok) {
                    const v = input.value.trim();
                    if (v !== (d.label || '')) {
                        d.label = v;
                        this.metaChanged(node);
                    }
                }
                input.replaceWith(label);
                label.textContent = paramLabel(node);
                this.refresh(true);
            };
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); finish(true); }
                else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            });
            input.addEventListener('blur', () => finish(true));
        };
        label.addEventListener('dblclick', startRename);
        edit.addEventListener('click', () => {
            if (this.editing.has(node.id)) this.editing.delete(node.id);
            else this.editing.add(node.id);
            this.refresh(true);
        });
        locate.addEventListener('click', () => this.locate(node));

        // Reorder: the grip arms HTML5 drag on the row
        grip.addEventListener('pointerdown', () => {
            row.draggable = true;
            window.addEventListener('pointerup', () => { if (!row.classList.contains('is-dragging')) row.draggable = false; }, { once: true });
        });
        row.addEventListener('dragstart', (e) => {
            if (!row.draggable) { e.preventDefault(); return; }
            e.dataTransfer.setData(DRAG_MIME, String(node.id));
            e.dataTransfer.effectAllowed = 'move';
            row.classList.add('is-dragging');
            this.dragId = node.id;
        });
        row.addEventListener('dragend', () => {
            row.draggable = false;
            row.classList.remove('is-dragging');
            this.dragId = null;
            this.clearDropMarks();
        });
        // Widget
        const widget = el('div', 'pp-widget');
        const updaters = [];
        this.buildWidget(node, kind, widget, updaters);
        row.appendChild(widget);

        if (this.editing.has(node.id)) row.appendChild(this.buildSettings(node, kind));

        const update = () => {
            if (!this.graph.nodes.includes(node)) return;
            for (const u of updaters) u();
            if (midiUpdate) midiUpdate();
            const inScope = !this.graph.groupCtl || this.graph.groupCtl.isVisible?.(node) !== false;
            row.classList.toggle('is-offscope', !inScope);
        };
        update();
        return { el: row, update, startRename };
    }

    /** Set a value from the panel (coerced by the node); errors become a toast. */
    set(node, value, commit = true) {
        try {
            node.setValue(value, { commit });
        } catch (e) {
            UIHelpers.toast(e.message, 'error');
        }
    }

    buildWidget(node, kind, w, updaters) {
        const d = node.data;
        switch (kind) {
            case 'float':
            case 'int': {
                const line = el('div', 'pp-line');
                const slider = this.slider(node, () => Number(d.value) || 0, (v, commit) => this.set(node, v, commit), kind);
                const field = this.numField(node, () => d.value, (v, commit) => this.set(node, v, commit), kind);
                line.append(slider.el, field.el);
                w.appendChild(line);
                updaters.push(slider.update, field.update);
                break;
            }
            case 'bool': {
                const sw = el('button', 'pp-switch', { type: 'button', role: 'switch' });
                sw.innerHTML = '<span class="pp-switch-track"><span class="pp-switch-knob"></span></span><span class="pp-switch-text"></span>';
                sw.addEventListener('click', () => this.set(node, !d.value));
                w.appendChild(sw);
                updaters.push(() => {
                    sw.classList.toggle('is-on', !!d.value);
                    sw.setAttribute('aria-checked', String(!!d.value));
                    sw.lastChild.textContent = d.value ? 'On' : 'Off';
                });
                break;
            }
            case 'vec2':
            case 'vec3':
            case 'vec4': {
                const n = VEC_SIZE[kind];
                if (kind === 'vec2') {
                    const pad = this.xyPad(node);
                    w.appendChild(pad.el);
                    updaters.push(pad.update);
                }
                const line = el('div', 'pp-vec');
                for (let i = 0; i < n; i++) {
                    const f = this.numField(node, () => (Array.isArray(d.value) ? d.value[i] : 0), (v, commit) => {
                        const arr = Array.isArray(d.value) ? [...d.value] : [];
                        arr[i] = v;
                        this.set(node, arr, commit);
                    }, 'float', COMP[i], () => (Array.isArray(d.default) ? d.default[i] : 0));
                    line.appendChild(f.el);
                    updaters.push(f.update);
                }
                w.appendChild(line);
                break;
            }
            case 'color': {
                const line = el('div', 'pp-line');
                const swatch = el('label', 'pp-swatch', { 'data-tip': 'Pick a color' });
                const chip = el('span', 'pp-swatch-chip');
                const picker = el('input', '', { type: 'color' });
                swatch.append(chip, picker);
                const hex = el('input', 'pt-input pp-hex', { type: 'text', spellcheck: false, maxlength: 9 });
                picker.addEventListener('input', () => {
                    const rgb = hexToRgba(picker.value);
                    if (!rgb) return;
                    const a = Array.isArray(d.value) && d.value.length > 3 ? d.value[3] : 1;
                    this.set(node, d.alpha ? [rgb[0], rgb[1], rgb[2], a] : rgb.slice(0, 3), false);
                });
                picker.addEventListener('change', () => this.set(node, d.value, true));
                hex.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') hex.blur();
                    if (e.key === 'Escape') { hex.value = rgbToHex(d.value || [0, 0, 0]).toUpperCase(); hex.blur(); }
                });
                hex.addEventListener('change', () => {
                    const rgba = hexToRgba(hex.value);
                    if (!rgba) { UIHelpers.toast('Use #rrggbb or #rrggbbaa', 'error'); return; }
                    const keepA = hex.value.replace('#', '').length <= 6 && Array.isArray(d.value) && d.value.length > 3;
                    if (keepA) rgba[3] = d.value[3];
                    this.set(node, d.alpha ? rgba : rgba.slice(0, 3));
                });
                line.append(swatch, hex);
                w.appendChild(line);
                let alpha = null;
                if (d.alpha) {
                    const aline = el('div', 'pp-line pp-alpha');
                    aline.appendChild(el('span', 'pp-comp', { text: 'a' }));
                    alpha = this.slider(node, () => (Array.isArray(d.value) ? d.value[3] : 1), (v, commit) => {
                        const arr = Array.isArray(d.value) ? [...d.value] : [0, 0, 0, 1];
                        arr[3] = v;
                        this.set(node, arr, commit);
                    }, 'float', { min: 0, max: 1, step: 0.01, scale: 'linear' }, () => (Array.isArray(d.default) ? d.default[3] : 1));
                    aline.appendChild(alpha.el);
                    w.appendChild(aline);
                    updaters.push(alpha.update);
                }
                updaters.push(() => {
                    const v = Array.isArray(d.value) ? d.value : [0, 0, 0];
                    const h = rgbToHex(v).toUpperCase();
                    chip.style.background = `rgba(${v.slice(0, 3).map(c => Math.round(c * 255)).join(',')},${d.alpha ? (v[3] ?? 1) : 1})`;
                    if (document.activeElement !== picker) picker.value = h.toLowerCase();
                    if (document.activeElement !== hex) hex.value = d.alpha ? h + Math.round((v[3] ?? 1) * 255).toString(16).padStart(2, '0').toUpperCase() : h;
                });
                break;
            }
            case 'text': {
                // A string (control rate): Text Texture, Text Pick, JS inputs
                const input = el('input', 'pt-input pp-text', { type: 'text', spellcheck: 'false' });
                input.addEventListener('input', () => this.set(node, input.value, false));
                input.addEventListener('change', () => this.set(node, input.value, true));
                input.addEventListener('keydown', (e) => e.stopPropagation());
                w.appendChild(input);
                updaters.push(() => { if (document.activeElement !== input) input.value = String(d.value ?? ''); });
                break;
            }
            case 'enum': {
                const sel = el('select', 'pt-input pp-select');
                (d.options || []).forEach((o, i) => sel.appendChild(el('option', '', { value: String(i), text: o })));
                sel.addEventListener('change', () => this.set(node, Number(sel.value)));
                sel.addEventListener('keydown', (e) => e.stopPropagation());
                w.appendChild(sel);
                updaters.push(() => { if (document.activeElement !== sel) sel.value = String(Math.round(d.value) || 0); });
                break;
            }
            case 'trigger': {
                const line = el('div', 'pp-line');
                const btn = el('button', 'pt-btn pt-btn--sm pp-trigger', { type: 'button' });
                btn.innerHTML = `${icon('spark')}<span>${escapeHtml(paramLabel(node))}</span>`;
                btn.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0) return;
                    node.press();
                    btn.classList.add('is-fired');
                    clearTimeout(btn._t);
                    btn._t = setTimeout(() => btn.classList.remove('is-fired'), 160);
                });
                const count = el('span', 'pp-count', { 'data-tip': 'Press count (double-click to reset)' });
                count.addEventListener('dblclick', () => this.set(node, 0));
                line.append(btn, count);
                w.appendChild(line);
                updaters.push(() => { count.textContent = `× ${Number(d.value) || 0}`; });
                break;
            }
            case 'image': {
                const drop = el('div', 'pp-image', { tabindex: '0', role: 'button', 'aria-label': 'Choose an image' });
                const img = el('img', 'pp-image-thumb', { alt: '' });
                const hint = el('span', 'pp-image-hint');
                const clear = el('button', 'pt-icon-btn pt-icon-btn--sm pp-image-clear', { type: 'button', 'data-tip': 'Remove image', 'aria-label': 'Remove image' });
                clear.innerHTML = icon('close');
                drop.append(img, hint, clear);
                const pick = () => node.pickImageFile();
                drop.addEventListener('click', (e) => { if (!e.target.closest('.pp-image-clear')) pick(); });
                drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
                clear.addEventListener('click', () => { delete d.imageName; this.set(node, ''); });
                drop.addEventListener('dragover', (e) => {
                    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    drop.classList.add('is-drop');
                });
                drop.addEventListener('dragleave', () => drop.classList.remove('is-drop'));
                drop.addEventListener('drop', (e) => {
                    drop.classList.remove('is-drop');
                    const file = e.dataTransfer.files && e.dataTransfer.files[0];
                    if (!file) return;
                    e.preventDefault();
                    e.stopPropagation();
                    node.loadImageFile(file).catch(err => UIHelpers.toast(err.message, 'error'));
                });
                w.appendChild(drop);
                updaters.push(() => {
                    const src = String(d.value || '');
                    if (img.getAttribute('src') !== src) {
                        if (src) img.setAttribute('src', src);
                        else img.removeAttribute('src');
                    }
                    drop.classList.toggle('has-image', !!src);
                    hint.textContent = node.imageError ? node.imageError : (src ? formatParamValue(d) : 'Drop an image or click to choose');
                    drop.classList.toggle('is-error', !!node.imageError);
                });
                break;
            }
        }
    }

    /** Horizontal slider: drag / click, arrows when focused, double-click resets. */
    slider(node, get, set, kind, rangeOverride = null, getDefault = null) {
        const s = el('div', 'pp-slider', { tabindex: '0', role: 'slider' });
        const fill = el('div', 'pp-slider-fill');
        const thumb = el('div', 'pp-slider-thumb');
        s.append(fill, thumb);
        const range = () => rangeOverride || paramRange(node.data);
        const fromX = (clientX) => {
            const r = s.getBoundingClientRect();
            const rg = range();
            return snap(unitToValue((clientX - r.left) / Math.max(1, r.width), rg), rg, kind);
        };
        s.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            s.focus();
            s.setPointerCapture(e.pointerId);
            this.busy = s;
            s.classList.add('is-dragging');
            set(fromX(e.clientX), false);
            const move = (ev) => set(fromX(ev.clientX), false);
            const up = (ev) => {
                s.removeEventListener('pointermove', move);
                s.removeEventListener('pointerup', up);
                s.removeEventListener('pointercancel', up);
                s.classList.remove('is-dragging');
                this.busy = null;
                set(get(), true);
            };
            s.addEventListener('pointermove', move);
            s.addEventListener('pointerup', up);
            s.addEventListener('pointercancel', up);
        });
        s.addEventListener('dblclick', () => {
            if (getDefault) set(getDefault(), true);
            else node.resetValue();
        });
        s.addEventListener('keydown', (e) => {
            const rg = range();
            const step = rg.step > 0 ? rg.step : (rg.max - rg.min) / 100;
            const k = e.shiftKey ? 10 : 1;
            let v = null;
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = get() + step * k;
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = get() - step * k;
            else if (e.key === 'Home') v = rg.min;
            else if (e.key === 'End') v = rg.max;
            if (v === null) return;
            e.preventDefault();
            e.stopPropagation();
            set(snap(Math.min(rg.max, Math.max(rg.min, v)), rg, kind), true);
        });
        const update = () => {
            const t = valueToUnit(Number(get()) || 0, range());
            fill.style.width = `${(t * 100).toFixed(2)}%`;
            thumb.style.left = `${(t * 100).toFixed(2)}%`;
            s.setAttribute('aria-valuenow', fmt(get()));
        };
        return { el: s, update };
    }

    /**
     * Number field: drag horizontally to scrub (Shift = fine), click to type,
     * Enter / blur commits, Escape reverts. With a component letter (x, y...) the
     * letter is the scrub handle and double-clicking it resets the component.
     */
    numField(node, get, set, kind, comp = null, getDefault = null) {
        const wrap = el('label', 'pp-num' + (comp ? ' has-comp' : ''));
        let handle = null;
        if (comp) {
            handle = el('span', 'pp-comp', { text: comp, 'data-tip': 'Drag to scrub · double-click to reset' });
            wrap.appendChild(handle);
        }
        const input = el('input', 'pt-input pp-num-input', { type: 'text', inputmode: 'decimal', spellcheck: false, autocomplete: 'off' });
        wrap.appendChild(input);
        let editing = false;
        const commitText = () => {
            const n = Number(String(input.value).replace(',', '.'));
            if (input.value.trim() !== '' && Number.isFinite(n)) set(kind === 'int' ? Math.round(n) : n, true);
            input.value = fmt(get());
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            else if (e.key === 'Escape') { e.preventDefault(); input.value = fmt(get()); editing = false; input.blur(); }
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const rg = paramRange(node.data);
                const step = kind === 'int' ? 1 : (rg.step > 0 ? rg.step : 0.01);
                set(Number(get()) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), true);
                input.value = fmt(get());
            }
        });
        input.addEventListener('focus', () => { editing = true; });
        input.addEventListener('blur', () => {
            if (editing) commitText();
            editing = false;
        });

        const scrubFrom = (target) => {
            target.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || document.activeElement === input) return;
                const x0 = e.clientX;
                const v0 = Number(get()) || 0;
                const rg = paramRange(node.data);
                let moved = false;
                const move = (ev) => {
                    const dx = ev.clientX - x0;
                    if (!moved && Math.abs(dx) < 3) return;
                    if (!moved) {
                        moved = true;
                        this.busy = wrap;
                        wrap.classList.add('is-scrubbing');
                        try { target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                    }
                    const span = Number.isFinite(rg.max - rg.min) && rg.max > rg.min ? rg.max - rg.min : 1;
                    const per = (kind === 'int' ? Math.max(span / 150, 0.125) : span / 200) * (ev.shiftKey ? 0.1 : 1);
                    let v = v0 + dx * per;
                    v = kind === 'int' ? Math.round(v) : snap(v, ev.shiftKey ? { step: 0 } : rg, 'float');
                    set(v, false);
                    input.value = fmt(get());
                };
                const up = () => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                    if (moved) {
                        wrap.classList.remove('is-scrubbing');
                        this.busy = null;
                        set(get(), true);
                    } else if (target === input) {
                        input.focus();
                        input.select();
                    }
                };
                if (target === input) e.preventDefault(); // focus only on a click, not on scrub
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
            });
        };
        scrubFrom(input);
        if (handle) {
            scrubFrom(handle);
            handle.addEventListener('dblclick', () => {
                if (getDefault) set(getDefault(), true);
            });
        }
        const update = () => {
            if (document.activeElement !== input && this.busy !== wrap) input.value = fmt(get());
        };
        return { el: wrap, update };
    }

    xyPad(node) {
        const pad = el('div', 'pp-pad', { tabindex: '0', 'data-tip': 'Drag · double-click to reset' });
        const cx = el('div', 'pp-pad-x');
        const cy = el('div', 'pp-pad-y');
        const dot = el('div', 'pp-pad-dot');
        pad.append(cx, cy, dot);
        const d = node.data;
        const set = (e, commit) => {
            const r = pad.getBoundingClientRect();
            const rg = paramRange(d);
            const x = snap(unitToValue((e.clientX - r.left) / r.width, rg), rg);
            const y = snap(unitToValue(1 - (e.clientY - r.top) / r.height, rg), rg);
            this.set(node, [x, y], commit);
        };
        pad.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            pad.setPointerCapture(e.pointerId);
            this.busy = pad;
            pad.classList.add('is-dragging');
            set(e, false);
            const move = (ev) => set(ev, false);
            const up = (ev) => {
                pad.removeEventListener('pointermove', move);
                pad.removeEventListener('pointerup', up);
                pad.classList.remove('is-dragging');
                this.busy = null;
                set(ev, true);
            };
            pad.addEventListener('pointermove', move);
            pad.addEventListener('pointerup', up);
        });
        pad.addEventListener('dblclick', () => node.resetValue());
        const update = () => {
            const rg = paramRange(d);
            const v = Array.isArray(d.value) ? d.value : [0.5, 0.5];
            const tx = valueToUnit(v[0], rg) * 100;
            const ty = (1 - valueToUnit(v[1], rg)) * 100;
            dot.style.left = cx.style.left = `${tx.toFixed(2)}%`;
            dot.style.top = cy.style.top = `${ty.toFixed(2)}%`;
        };
        return { el: pad, update };
    }

    // ------------------------------------------------------------------
    // Settings form (kind, section, range, options...)
    // ------------------------------------------------------------------

    buildSettings(node, kind) {
        const d = node.data;
        const form = el('div', 'pp-settings');
        const field = (labelText, control, cls = '') => {
            const f = el('label', 'pp-field' + (cls ? ' ' + cls : ''));
            f.appendChild(el('span', 'pp-field-label', { text: labelText }));
            f.appendChild(control);
            form.appendChild(f);
            return f;
        };
        const textInput = (value, onChange, placeholder = '') => {
            const i = el('input', 'pt-input pp-set-input', { type: 'text', value: value ?? '', placeholder, spellcheck: false });
            i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
            i.addEventListener('change', () => onChange(i.value));
            return i;
        };
        const select = (options, value, onChange) => {
            const s = el('select', 'pt-input pp-select pp-set-input');
            for (const [v, t] of options) s.appendChild(el('option', '', { value: v, text: t }));
            s.value = value;
            s.addEventListener('change', () => onChange(s.value));
            return s;
        };

        field('Kind', select(PARAM_KINDS.map(k => [k, KIND_LABEL[k] || k]), kind, (k) => {
            this.editing.add(node.id);
            node.setKind(k);
            this.metaChanged(node);
        }));

        const sections = [...new Set(this.params().map(p => (p.data.section || '').trim()).filter(Boolean))];
        const listId = `pp-sections-${node.id}`;
        const sec = textInput(d.section, (v) => { d.section = v.trim(); this.metaChanged(node); }, 'General');
        sec.setAttribute('list', listId);
        const dl = el('datalist', '', { id: listId });
        for (const s of sections) dl.appendChild(el('option', '', { value: s }));
        form.appendChild(dl);
        field('Section', sec);

        if (KIND_INFO[kind].range) {
            const grid = el('div', 'pp-field-grid');
            for (const key of ['min', 'max', 'step']) {
                const i = el('input', 'pt-input pp-set-input', { type: 'text', inputmode: 'decimal', value: fmt(d[key]) });
                i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
                i.addEventListener('change', () => {
                    const n = Number(i.value);
                    if (!Number.isFinite(n)) { i.value = fmt(d[key]); return; }
                    d[key] = n;
                    this.metaChanged(node);
                });
                const f = el('label', 'pp-field pp-field--mini');
                f.append(el('span', 'pp-field-label', { text: key }), i);
                grid.appendChild(f);
            }
            form.appendChild(grid);
            if (kind === 'float' || kind === 'int') {
                field('Scale', select([['linear', 'Linear'], ['log', 'Logarithmic (min > 0)']], d.scale || 'linear', (v) => { d.scale = v; this.metaChanged(node); }));
            }
        }
        if (kind === 'enum') {
            const ta = el('textarea', 'pt-input pp-set-input pp-options', { rows: 3, spellcheck: false });
            ta.value = (d.options || []).join('\n');
            ta.addEventListener('keydown', (e) => e.stopPropagation());
            ta.addEventListener('change', () => {
                const opts = ta.value.split(/\n|,/).map(s => s.trim()).filter(Boolean);
                if (!opts.length) { ta.value = (d.options || []).join('\n'); return; }
                d.options = opts;
                this.metaChanged(node);
                node.setValue(Math.min(Math.round(d.value) || 0, opts.length - 1));
            });
            field('Options (one per line)', ta);
        }
        if (kind === 'color') {
            const cb = el('input', 'pp-check', { type: 'checkbox' });
            cb.checked = !!d.alpha;
            cb.addEventListener('change', () => { node.setKind('color', { alpha: cb.checked }); this.metaChanged(node); });
            const f = field('Alpha (outputs vec4)', cb, 'pp-field--inline');
            f.prepend(cb);
        }
        if (kind === 'image') {
            field('Wrap', select([['clamp', 'Clamp'], ['repeat', 'Repeat'], ['mirror', 'Mirror']], d.wrap || 'clamp', (v) => { d.wrap = v; node._uploaded = false; node.getTexture(node._gl); this.metaChanged(node); }));
            field('Filter', select([['linear', 'Linear'], ['nearest', 'Nearest']], d.filter || 'linear', (v) => { d.filter = v; node._uploaded = false; node.getTexture(node._gl); this.metaChanged(node); }));
        }
        field('Description (tooltip)', textInput(d.description, (v) => { d.description = v; this.metaChanged(node); }, 'Shown when hovering the name'));

        if (kind !== 'trigger' && kind !== 'image') {
            const actions = el('div', 'pp-settings-actions');
            const setDef = el('button', 'pt-btn pt-btn--sm pt-btn--ghost', { type: 'button', text: 'Use current as default' });
            setDef.addEventListener('click', () => {
                d.default = Array.isArray(d.value) ? [...d.value] : d.value;
                this.metaChanged(node);
                UIHelpers.toast(`Default for “${paramLabel(node)}” set to ${formatParamValue(d)}`, 'success');
            });
            const reset = el('button', 'pt-btn pt-btn--sm pt-btn--ghost', { type: 'button', text: 'Reset value' });
            reset.addEventListener('click', () => node.resetValue());
            actions.append(setDef, reset);
            form.appendChild(actions);
        }
        return form;
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    /** Label / section / range edits: no recompile, but the project changed. */
    metaChanged(node) {
        try { node.syncFromData(); } catch (e) { /* ignore */ }
        this.app.projectManager?.markDirty();
        if (this.graph) this.graph.render();
        this.refresh(true);
    }

    /** Open the node's group and centre it on the canvas. */
    locate(node) {
        const g = this.graph;
        const ctl = g.groupCtl;
        if (ctl) {
            const gid = ctl.groupOf(node.id);
            if (gid !== ctl.scope) ctl.setScope(gid, { select: false });
            ctl.cancelTransition?.();
        }
        const rect = g.canvas.getBoundingClientRect();
        g.zoom = Math.min(Math.max(g.zoom, 0.75), 1.5);
        g.panX = rect.width / 2 - (node.x + node.width / 2) * g.zoom;
        g.panY = rect.height / 2 - (node.y + node.height / 2) * g.zoom;
        g.selectionManager.selectedNodes.clear();
        g.selectionManager.selectedNodes.add(node);
        g.render();
        this.app.shell?.activity(`Located “${paramLabel(node)}”`, { local: true });
    }

    /** Show a param in the panel (double-click on the canvas node). */
    reveal(node, { rename = false } = {}) {
        if (!this.isOpen()) this.setOpen(true);
        const sec = (node.data.section || '').trim();
        if (this.collapsed.has(sec)) {
            this.collapsed.delete(sec);
            this.refresh(true);
        }
        const row = this.rows.get(node.id);
        if (!row) return;
        row.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        row.el.classList.remove('is-flash');
        void row.el.offsetWidth;
        row.el.classList.add('is-flash');
        if (rename) row.startRename();
    }

    addParam() {
        const g = this.graph;
        if (!g) return;
        const rect = g.canvas.getBoundingClientRect();
        const wx = ((rect.width || 800) / 2 - g.panX) / g.zoom - 84;
        const wy = ((rect.height || 600) / 2 - g.panY) / g.zoom - 30;
        const node = g.addNode('Param', Math.round(wx), Math.round(wy));
        if (!node) return;
        const params = this.params();
        const labels = new Set(params.map(p => paramLabel(p)));
        let i = params.length;
        while (labels.has(`Param ${i}`)) i++;
        node.data.label = `Param ${i}`;
        node.data.order = params.reduce((m, p) => (p === node ? m : Math.max(m, Number(p.data.order) || 0)), -1) + 1;
        node.syncFromData();
        g.onGraphChanged?.();
        if (!this.isOpen()) this.setOpen(true);
        this.pendingRename = node.id;
        this.refresh(true);
    }

    // ------------------------------------------------------------------
    // Drag to reorder (rows between rows, or onto a section header)
    // ------------------------------------------------------------------

    clearDropMarks() {
        this.listEl.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-into').forEach(e => e.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-into'));
    }

    onDragOver(e) {
        if (!this.dragId && ![...(e.dataTransfer?.types || [])].includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this.clearDropMarks();
        const row = e.target.closest('.pp-row');
        if (row) {
            const r = row.getBoundingClientRect();
            row.classList.add(e.clientY < r.top + r.height / 2 ? 'is-drop-before' : 'is-drop-after');
            return;
        }
        const sec = e.target.closest('.pp-section');
        if (sec) sec.classList.add('is-drop-into');
    }

    onDrop(e) {
        const id = Number(e.dataTransfer.getData(DRAG_MIME) || this.dragId);
        this.clearDropMarks();
        if (!Number.isFinite(id)) return;
        e.preventDefault();
        const dragged = this.graph.nodes.find(n => n.id === id && n.isParamNode);
        if (!dragged) return;
        const order = sortedParams(this.graph.nodes).flatMap(s => s.params).filter(n => n !== dragged);
        const row = e.target.closest('.pp-row');
        let index = order.length;
        let section = (dragged.data.section || '').trim();
        if (row) {
            const target = order.find(n => String(n.id) === row.dataset.id);
            if (target) {
                const r = row.getBoundingClientRect();
                index = order.indexOf(target) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
                section = (target.data.section || '').trim();
            }
        } else {
            const sec = e.target.closest('.pp-section');
            if (sec) {
                section = sec.dataset.section;
                const last = order.filter(n => (n.data.section || '').trim() === section).pop();
                index = last ? order.indexOf(last) + 1 : order.length;
            }
        }
        order.splice(index, 0, dragged);
        dragged.data.section = section;
        order.forEach((n, i) => { n.data.order = i; });
        this.metaChanged(dragged);
    }
}
