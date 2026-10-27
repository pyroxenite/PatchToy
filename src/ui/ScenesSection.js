import { icon } from './icons.js';
import { escapeHtml } from './UIHelpers.js';
import { TRANSITIONS, EASING_KEYS, AUTO_MODES } from '../core/scenes.js';
import { isTypingTarget } from '../nodes/liveUniform.js';

const COLLAPSE_NAME = '\u0001scenes';
const EASING_LABEL = { linear: 'Linear', smooth: 'Smooth', 'in-out': 'In-out cubic', in: 'Ease in', out: 'Ease out', sine: 'Sine', expo: 'Expo' };
const AUTO_LABEL = { off: 'Off', bars: 'Bars', seconds: 'Seconds', music: 'Music' };

const el = (tag, cls, props = {}) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else e.setAttribute(k, v);
    }
    return e;
};

function select(options, value, onChange, tip) {
    const s = el('select', 'pt-input pp-select psc-select', { 'data-tip': tip });
    for (const [v, label] of options) {
        const o = el('option', '', { value: v, text: label });
        if (v === value) o.selected = true;
        s.appendChild(o);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
}

function number(value, { min = 0, max = 9999, step = 0.1, tip, suffix } = {}, onChange) {
    const wrap = el('label', 'psc-num', { 'data-tip': tip });
    const input = el('input', 'pt-input pp-num-input psc-num-input', { type: 'number', min, max, step, value: String(value) });
    input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    wrap.appendChild(input);
    if (suffix) wrap.appendChild(el('span', 'psc-suffix', { text: suffix }));
    return { wrap, input };
}

/**
 * "Scenes" section at the top of the Parameters panel: one block per SceneSwitcher
 * with its scene list (click = transition, double-click = rename, keys 1-9),
 * transition style / duration / easing and auto mode. Also owns the 1-9 shortcut.
 */
export class ScenesSection {
    constructor(panel) {
        this.panel = panel;
        this.blocks = new Map();   // switcher id -> { update }
        this.raf = 0;
        window.addEventListener('patchtoy:scene', (e) => {
            const what = e.detail && e.detail.what;
            if (what === 'meta') this.panel.refresh();
            else this.scheduleUpdate();
        });
        window.addEventListener('keydown', (e) => this.onKey(e));
    }

    get graph() {
        return this.panel.graph;
    }

    switchers() {
        return this.graph ? this.graph.nodes.filter(n => n.isSceneSwitcher).sort((a, b) => a.id - b.id) : [];
    }

    /** Part of the panel's structure signature (rebuild when scenes change). */
    signature() {
        return this.switchers().map(sw => [sw.id, sw.data.scenes.map(s => s.name).join('\u0002'),
            sw.data.scenes.map((_, i) => (sw.isSceneConnected(i) ? 1 : 0)).join('')].join('\u0003')).join('\n');
    }

    /** The section element (null without SceneSwitcher nodes). */
    build() {
        this.blocks.clear();
        const list = this.switchers();
        if (!list.length) return null;
        const collapsed = this.panel.collapsed.has(COLLAPSE_NAME);
        const sec = el('div', 'pp-section psc' + (collapsed ? ' is-collapsed' : ''));
        sec.dataset.section = COLLAPSE_NAME;
        // Params can't be dropped into the Scenes section
        for (const type of ['dragover', 'drop']) sec.addEventListener(type, (e) => e.stopPropagation());
        const head = el('button', 'pp-section-head', { type: 'button' });
        const count = list.reduce((a, sw) => a + sw.sceneCount, 0);
        head.innerHTML = `${icon('chevronRight')}<span class="pp-section-title">Scenes</span><span class="pp-section-count">${count}</span>`;
        sec.appendChild(head);
        const body = el('div', 'pp-section-body');
        for (const sw of list) body.appendChild(this.buildBlock(sw, list.length > 1));
        sec.appendChild(body);
        this.scheduleUpdate();
        return sec;
    }

    buildBlock(sw, showTitle) {
        const block = el('div', 'psc-block');
        if (showTitle) block.appendChild(el('div', 'psc-title', { text: `Switcher #${sw.id}` }));

        // Scene list
        const grid = el('div', 'psc-scenes', { role: 'listbox', 'aria-label': 'Scenes' });
        const items = sw.data.scenes.map((s, i) => {
            const b = el('button', 'psc-scene' + (sw.isSceneConnected(i) ? '' : ' is-empty'), {
                type: 'button', role: 'option',
                'data-tip': `${sw.isSceneConnected(i) ? 'Transition to' : 'Nothing connected to'} “${s.name}”${i < 9 ? ` (key ${i + 1})` : ''} · double-click to rename`
            });
            b.innerHTML = `<span class="psc-fill"></span><kbd class="psc-key">${i < 9 ? i + 1 : '·'}</kbd><span class="psc-name">${escapeHtml(s.name)}</span>`;
            b.addEventListener('click', () => sw.requestScene(i, { source: 'ui' }));
            b.addEventListener('dblclick', (e) => {
                e.preventDefault();
                this.rename(sw, i, b);
            });
            this.panel.midi?.decorateScene(sw, b, { target: 'scene', option: i }); // MIDI learn (pads -> scenes)
            grid.appendChild(b);
            return b;
        });
        block.appendChild(grid);

        // Transition settings
        const d = sw.data;
        const line1 = el('div', 'pp-line psc-line');
        line1.appendChild(el('span', 'psc-cap', { text: 'Transition' }));
        line1.appendChild(select(TRANSITIONS.map(t => [t.key, t.label]), d.transition, (v) => sw.setOptions({ transition: v }),
            'Default transition (a scene can override it: data.scenes[i].transition)'));
        block.appendChild(line1);

        const line2 = el('div', 'pp-line psc-line');
        line2.appendChild(el('span', 'psc-cap', { text: 'Duration' }));
        const dur = number(d.duration, { min: 0, max: 600, step: 0.1, tip: 'Transition length', suffix: d.durationUnit === 'beats' ? 'beats' : 's' }, (v) => sw.setOptions({ duration: v }));
        line2.appendChild(dur.wrap);
        line2.appendChild(select(EASING_KEYS.map(k => [k, EASING_LABEL[k] || k]), d.easing, (v) => sw.setOptions({ easing: v }), 'Easing of the transition progress'));
        block.appendChild(line2);

        const line3 = el('div', 'pp-line psc-line');
        line3.appendChild(el('span', 'psc-cap', { text: 'Auto' }));
        line3.appendChild(select(AUTO_MODES.map(k => [k, AUTO_LABEL[k]]), d.auto, (v) => { sw.setOptions({ auto: v }); this.panel.refresh(true); },
            'Advance to the next scene (playlist order): every N bars of the beat clock, every N seconds, or Music = bars while music / the metronome drives the beat, else seconds'));
        const bars = number(d.autoBars, { min: 1, max: 256, step: 1, tip: 'Bars between scene changes (beat clock, 4 beats per bar)', suffix: 'bars' }, (v) => sw.setOptions({ autoBars: v }));
        const secs = number(d.autoSeconds, { min: 0.5, max: 3600, step: 0.5, tip: d.auto === 'music' ? 'Seconds between scene changes when no music drives the beat clock' : 'Seconds between scene changes', suffix: 's' }, (v) => sw.setOptions({ autoSeconds: v }));
        block.appendChild(line3);
        if (d.auto !== 'off') {
            const line3b = el('div', 'pp-line psc-line');
            line3b.appendChild(el('span', 'psc-cap', { text: 'Every' }));
            if (d.auto === 'bars' || d.auto === 'music') line3b.appendChild(bars.wrap);
            if (d.auto === 'music') line3b.appendChild(el('span', 'psc-or', { text: 'else' }));
            if (d.auto === 'seconds' || d.auto === 'music') line3b.appendChild(secs.wrap);
            block.appendChild(line3b);
        }

        // Prev / next + status
        const line4 = el('div', 'pp-line psc-line');
        const prev = el('button', 'pt-btn pt-btn--sm pt-btn--outline psc-step', { type: 'button', 'data-tip': 'Previous scene' });
        prev.innerHTML = `<span class="psc-arrow is-back">${icon('play')}</span>`;
        prev.addEventListener('click', () => sw.nextScene(-1, { source: 'ui' }));
        const next = el('button', 'pt-btn pt-btn--sm pt-btn--outline psc-step', { type: 'button', 'data-tip': 'Next scene' });
        next.innerHTML = `<span class="psc-arrow">${icon('play')}</span>`;
        next.addEventListener('click', () => sw.nextScene(1, { source: 'ui' }));
        const status = el('span', 'psc-status');
        line4.append(prev, next, status);
        if (this.panel.midi) {
            this.panel.midi.decorateScene(sw, prev, { target: 'prev' });
            this.panel.midi.decorateScene(sw, next, { target: 'next' });
            const knob = el('span', 'psc-midi-holder');
            line4.appendChild(knob);
            this.panel.midi.decorateScene(sw, knob, { target: 'select' }, { learnable: false }); // knob -> scene (MCP midi_map)
        }
        block.appendChild(line4);

        const update = () => {
            const u = sw.computeUniforms();
            items.forEach((b, i) => {
                const level = u.active ? (i === u.b ? u.p : i === u.a ? 1 - u.p : 0) : (i === u.a ? 1 : 0);
                b.classList.toggle('is-current', i === sw.data.current);
                b.classList.toggle('is-live', level > 0);
                b.setAttribute('aria-selected', String(i === sw.data.current));
                b.querySelector('.psc-fill').style.transform = `scaleX(${level.toFixed(3)})`;
            });
            const S = sw.state;
            if (S.active) {
                const T = TRANSITIONS.find(t => t.key === S.style);
                status.textContent = `${T ? T.label : S.style} ${Math.round(Math.min(1, S.p) * 100)}%`;
            } else if (d.auto !== 'off') {
                status.textContent = d.auto === 'bars' ? `auto · ${d.autoBars} bars` : `auto · next in ${Math.max(0, d.autoSeconds - sw._sinceSwitch).toFixed(0)}s`;
            } else {
                status.textContent = sw.sceneName(sw.data.current);
            }
            return S.active || d.auto === 'seconds' || d.auto === 'music';
        };
        this.blocks.set(sw.id, { update });
        return block;
    }

    rename(sw, i, button) {
        const nameEl = button.querySelector('.psc-name');
        const input = el('input', 'pt-input psc-rename', { type: 'text', value: sw.sceneName(i), spellcheck: 'false' });
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            if (ok && input.value.trim() && input.value.trim() !== sw.sceneName(i)) sw.setOptions({ sceneName: { index: i, name: input.value } });
            else this.panel.refresh(true);
        };
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
    }

    /** Refresh the live state (current scene, progress) while the panel is open. */
    scheduleUpdate() {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => {
            this.raf = 0;
            if (!this.panel.isOpen()) return;
            let again = false;
            for (const b of this.blocks.values()) {
                try { again = b.update() || again; } catch (e) { /* node gone */ }
            }
            if (again) this.scheduleUpdate();
        });
    }

    /** Keys 1-9: go to scene N of the selected (else the first) SceneSwitcher. */
    onKey(e) {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
        if (!/^[1-9]$/.test(e.key)) return;
        const g = this.graph;
        if (!g || g.connectingFrom || isTypingTarget(e, g)) return;
        const list = this.switchers();
        if (!list.length) return;
        // A Keyboard node bound to this key owns it
        if (g.nodes.some(n => n.definition && n.definition.isKeyboardNode && String(n.data.key || '').toLowerCase() === e.key)) return;
        const sel = g.selectionManager && g.selectionManager.selectedNodes;
        const sw = (sel && [...sel].find(n => n.isSceneSwitcher)) || list[0];
        const i = parseInt(e.key, 10) - 1;
        if (i >= sw.sceneCount) return;
        e.preventDefault();
        sw.requestScene(i, { source: 'ui' });
        this.panel.app.shell?.activity?.(`Scene ${i + 1}: ${sw.sceneName(i)}`, { local: true });
    }
}
