import { icon } from './icons.js';
import { UIHelpers } from './UIHelpers.js';
import { midiService } from '../services/MIDIService.js';
import {
    midiMapper, isMappableParam, mappingsLabel, sourceLabel, noteName, isContinuousTarget,
    CC_MODES, CC_MODE_LABEL, COLOR_TARGETS, COLOR_TARGET_LABEL
} from '../services/MidiMapper.js';
import { normalizeKind, paramLabel, paramRange } from '../core/paramKinds.js';

const COMP_LABEL = { x: 'x', y: 'y', z: 'z', w: 'w' };

const el = (tag, cls, props = {}) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else e.setAttribute(k, v === true ? '' : v);
    }
    return e;
};

const fmt = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return Number.isInteger(n) ? String(n) : String(+n.toFixed(4));
};

/**
 * MIDI learn in the Parameters panel (src/ui/ParamsPanel.js, ScenesSection.js):
 *   - a learn button + mapping badge on every mappable Param row
 *   - right-click / badge on scene buttons, previous / next
 *   - a global learn mode (header button): click a row, touch a control, repeat
 *   - the mapping menu (encoder mode, soft takeover, invert, range, smoothing...)
 *   - a row flash when MIDI moves it, and an activity LED on the top-bar MIDI button
 * The logic lives in src/services/MidiMapper.js.
 */
export class MidiLearnUI {
    constructor(panel) {
        this.panel = panel;
        this.mapper = midiMapper.attach(panel.app);
        this.decor = new Set();        // { el, update } of scene decorations
        this.menu = null;
        this.warnedNoMidi = false;
        this.injectHeader();
        this.injectTopbarLed();
        this.bindEvents();
        // A project with mappings: turn MIDI on by itself when the browser already allows it
        this.autoTried = false;
        setInterval(() => this.autoEnable(), 2000);
    }

    async autoEnable() {
        if (this.autoTried || midiService.isEnabled || !this.mapper.mappedNodes().length) return;
        this.autoTried = true;
        try {
            if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess || !navigator.permissions) return;
            const status = await navigator.permissions.query({ name: 'midi' });
            if (status.state === 'granted' && await midiService.enable()) this.panel.app.shell?.syncNow?.();
        } catch (e) { /* permission API without 'midi': wait for the MIDI button */ }
    }

    get graph() {
        return this.panel.graph;
    }

    // ------------------------------------------------------------------
    // Shell: header toggle, hint, top-bar LED
    // ------------------------------------------------------------------

    injectHeader() {
        const header = this.panel.root.querySelector('.pp-header');
        if (!header) return;
        const btn = el('button', 'pt-icon-btn pt-icon-btn--sm pp-midi-mode', {
            type: 'button', 'aria-pressed': 'false', 'aria-label': 'MIDI learn mode',
            'data-tip': 'MIDI learn mode: click a parameter or scene, move a control, repeat · Esc when done'
        });
        btn.innerHTML = icon('midi');
        btn.addEventListener('click', () => {
            const on = !this.mapper.learnMode;
            if (on) this.ensureMidi();
            this.mapper.setLearnMode(on);
        });
        header.insertBefore(btn, this.panel.addBtn && this.panel.addBtn.parentElement === header ? this.panel.addBtn : null);
        this.modeBtn = btn;
        this.hintEl = el('div', 'pp-midi-hint', { role: 'status', 'aria-live': 'polite' });
        this.hintEl.hidden = true;
        header.after(this.hintEl);
    }

    injectTopbarLed() {
        const btn = document.getElementById('midiBtn');
        if (!btn || btn.querySelector('.tb-midi-act')) return;
        this.led = el('span', 'tb-midi-act', { 'aria-hidden': 'true' });
        btn.appendChild(this.led);
    }

    flashLed() {
        if (!this.led) return;
        this.led.classList.add('is-hit');
        clearTimeout(this._ledTimer);
        this._ledTimer = setTimeout(() => this.led.classList.remove('is-hit'), 90);
    }

    refreshShell() {
        const m = this.mapper;
        const active = !!m.learn || m.learnMode;
        if (this.modeBtn) {
            this.modeBtn.classList.toggle('is-active', m.learnMode);
            this.modeBtn.setAttribute('aria-pressed', String(m.learnMode));
        }
        this.panel.root.classList.toggle('is-midi-learn', m.learnMode);
        if (this.hintEl) {
            this.hintEl.hidden = !active;
            const hint = m.learnHint();
            this.hintEl.innerHTML = '';
            this.hintEl.appendChild(el('span', 'pp-midi-hint-dot'));
            this.hintEl.appendChild(el('span', 'pp-midi-hint-text', {
                text: hint ? `${hint}…` : 'Learn mode: click a parameter or a scene, then move a knob or press a key'
            }));
            const done = el('button', 'pt-btn pt-btn--sm pt-btn--ghost pp-midi-hint-btn', { type: 'button', text: m.learnMode ? 'Done' : 'Cancel' });
            done.addEventListener('click', () => {
                if (m.learnMode) m.setLearnMode(false);
                else m.cancelLearn();
            });
            this.hintEl.appendChild(done);
        }
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    bindEvents() {
        window.addEventListener('patchtoy:midi', (e) => {
            const d = e.detail || {};
            switch (d.what) {
                case 'activity':
                    this.flashLed();
                    for (const id of d.ids || []) this.flashTarget(id);
                    break;
                case 'learned':
                    this.announce(`Mapped ${sourceLabel(d.mapping)} → ${this.targetName(d.id, d.mapping)}`);
                    this.updateAll();
                    break;
                case 'detected':
                    this.announce(d.mode && d.mode !== 'absolute'
                        ? `Detected an endless encoder: ${CC_MODE_LABEL[d.mode]}`
                        : d.hires ? 'Detected a 14-bit control (MSB + LSB)' : 'MIDI mapping updated');
                    this.updateAll();
                    break;
                case 'learn':
                case 'learn-mode':
                case 'mappings':
                case 'pickup':
                    this.updateAll();
                    break;
            }
        });
        // Undo / redo / loads restore data.midi: refresh the scene badges too
        window.addEventListener('patchtoy:scene', (e) => { if (e.detail && e.detail.what === 'meta') this.updateAll(); });
        window.addEventListener('patchtoy:param', (e) => { if (e.detail && e.detail.what === 'meta') this.updateAll(); });
        // Esc ends learning; Delete / Backspace clears the armed target's mapping
        window.addEventListener('keydown', (e) => {
            const m = this.mapper;
            if (!m.learn && !m.learnMode) return;
            if (/INPUT|TEXTAREA|SELECT/.test(e.target && e.target.tagName)) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (m.learn) m.cancelLearn();
                else m.setLearnMode(false);
            } else if ((e.key === 'Delete' || e.key === 'Backspace') && m.learn) {
                e.preventDefault();
                e.stopPropagation();
                this.clearTarget(m.learn.target);
                m.cancelLearn();
            }
        }, true);

        // Learn mode: clicks on rows / scene buttons pick the target instead of acting
        const list = this.panel.listEl;
        const pick = (e) => {
            if (!this.mapper.learnMode) return null;
            if (e.target.closest('.pp-midi-badge, .psc-midi')) return null;
            const t = e.target.closest('[data-midi-target]');
            return t && list.contains(t) ? t : null;
        };
        list.addEventListener('pointerdown', (e) => {
            const t = pick(e);
            if (!t || e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const target = this.targetOfElement(t);
            if (!target) return;
            if (this.mapper.isLearning(target)) this.mapper.cancelLearn();
            else this.mapper.startLearn(target);
        }, true);
        for (const type of ['click', 'dblclick']) {
            list.addEventListener(type, (e) => {
                if (!pick(e)) return;
                e.preventDefault();
                e.stopPropagation();
            }, true);
        }
    }

    targetOfElement(t) {
        if (t.dataset.midiTarget === 'param') return { kind: 'param', nodeId: Number(t.dataset.id) };
        if (t.dataset.midiTarget === 'scene') {
            const target = { kind: 'scene', nodeId: Number(t.dataset.midiNode), target: t.dataset.midiAct };
            if (t.dataset.midiOpt !== '' && t.dataset.midiOpt !== undefined) target.option = Number(t.dataset.midiOpt);
            return target;
        }
        return null;
    }

    targetName(id, m) {
        const node = this.graph && this.graph.nodes.find(n => n.id === id);
        if (!node) return `#${id}`;
        if (node.isSceneSwitcher) {
            if (m.target === 'scene') return `scene “${node.sceneName(m.option)}”`;
            return m.target === 'next' ? 'next scene' : m.target === 'prev' ? 'previous scene' : 'scene select';
        }
        const kind = normalizeKind(node.data.kind);
        const part = COMP_LABEL[m.target] ? ` ${m.target}` : kind === 'color' ? ` (${COLOR_TARGET_LABEL[m.target]})`
            : m.target === 'option' ? ` = ${node.data.options[m.option]}` : '';
        return `“${paramLabel(node)}”${part}`;
    }

    announce(msg) {
        this.panel.app.shell?.activity?.(msg, { local: true });
    }

    /** Ask for Web MIDI on a user gesture (learning works with simulated input either way). */
    ensureMidi() {
        if (midiService.isEnabled) return;
        if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
            if (!this.warnedNoMidi) {
                this.warnedNoMidi = true;
                UIHelpers.toast('Web MIDI isn’t available in this browser (Chrome, Edge and Opera support it).', 'info');
            }
            return;
        }
        UIHelpers.enableMIDI().finally(() => this.panel.app.shell?.syncNow?.());
    }

    updateAll() {
        this.refreshShell();
        this.panel.scheduleValues();
        for (const d of [...this.decor]) {
            if (!d.el.isConnected) { this.decor.delete(d); continue; }
            try { d.update(); } catch (e) { /* node gone */ }
        }
    }

    flashTarget(id) {
        const row = this.panel.rows.get(id);
        const els = row ? [row.el] : [];
        if (!row) {
            for (const d of this.decor) if (d.nodeId === id && d.el.isConnected && d.hit) els.push(d.el);
        }
        for (const e of els) {
            e.classList.remove('is-midi-hit');
            void e.offsetWidth;
            e.classList.add('is-midi-hit');
        }
    }

    clearTarget(target) {
        const node = this.graph && this.graph.nodes.find(n => n.id === target.nodeId);
        if (!node) return;
        if (target.kind === 'param') this.mapper.clearMappings(node);
        else {
            const list = this.mapper.mappingsOf(node).filter(m => !(m.target === target.target && (m.option ?? null) === (target.option ?? null)));
            this.mapper.setMappings(node, list, { label: 'Clear MIDI mapping' });
        }
    }

    toggleLearn(target) {
        if (this.mapper.isLearning(target)) {
            this.mapper.cancelLearn();
            return;
        }
        this.ensureMidi();
        this.mapper.startLearn(target);
    }

    // ------------------------------------------------------------------
    // Param rows
    // ------------------------------------------------------------------

    /** Add the learn button + badge to a Param row head. Returns the row updater. */
    decorateRow(node, row, head, before) {
        if (!isMappableParam(node)) return () => { };
        row.dataset.midiTarget = 'param';
        const target = { kind: 'param', nodeId: node.id };
        const badge = el('button', 'pp-midi-badge', { type: 'button', 'aria-label': 'MIDI mapping options' });
        badge.hidden = true;
        const learn = el('button', 'pt-icon-btn pt-icon-btn--sm pp-act pp-midi-learn', {
            type: 'button', 'aria-label': 'MIDI learn', 'data-tip': 'MIDI learn: click, then move a knob or press a key (Esc cancels)'
        });
        learn.innerHTML = icon('midi');
        const ref = before && before.parentElement === head ? before : null;
        head.insertBefore(badge, ref);
        head.insertBefore(learn, ref);
        learn.addEventListener('click', () => this.toggleLearn(target));
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openParamMenu(node, badge);
        });
        let lastTip = '';
        return () => {
            const list = this.mapper.mappingsOf(node);
            const learning = this.mapper.isLearning(target);
            badge.hidden = !list.length;
            const text = mappingsLabel(list);
            if (badge.textContent !== text) badge.textContent = text;
            const waiting = list.length ? this.mapper.pickupWaiting(node) : null;
            badge.classList.toggle('is-waiting', !!waiting);
            badge.dataset.waiting = waiting || '';
            const tip = waiting
                ? `Soft takeover: turn the control ${waiting} past the current value to pick it up · click for options`
                : `${list.map(m => `${sourceLabel(m)}${m.device ? ` (${m.device})` : ''}`).join(', ')} · click for options`;
            if (tip !== lastTip) {
                lastTip = tip;
                badge.setAttribute('data-tip', tip);
                UIHelpers.refreshTooltip?.(badge);
            }
            row.classList.toggle('has-midi', !!list.length);
            row.classList.toggle('is-midi-learning', learning);
            learn.classList.toggle('is-active', learning);
        };
    }

    // ------------------------------------------------------------------
    // Scene controls
    // ------------------------------------------------------------------

    /**
     * Make a scene button / previous / next learnable: badge + right-click menu.
     * spec: { target: 'scene' | 'next' | 'prev' | 'select', option }
     */
    decorateScene(sw, host, spec, { learnable = true } = {}) {
        const target = { kind: 'scene', nodeId: sw.id, target: spec.target };
        if (spec.option !== undefined) target.option = spec.option;
        if (learnable) {
            host.dataset.midiTarget = 'scene';
            host.dataset.midiNode = String(sw.id);
            host.dataset.midiAct = spec.target;
            host.dataset.midiOpt = spec.option === undefined ? '' : String(spec.option);
        }
        const badge = el('span', 'psc-midi', { role: 'button', tabindex: '0', 'aria-label': 'MIDI mapping' });
        badge.hidden = true;
        host.appendChild(badge);
        const open = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openSceneMenu(sw, target, badge.hidden ? host : badge, { learnable });
        };
        badge.addEventListener('click', open);
        badge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
        if (learnable) host.addEventListener('contextmenu', open);
        const mine = () => this.mapper.mappingsOf(sw).filter(m => m.target === spec.target && (spec.target !== 'scene' || m.option === spec.option));
        const update = () => {
            const list = mine();
            badge.hidden = !list.length;
            const text = list.map(m => (m.type === 'note' ? noteName(m.number) : sourceLabel(m, { channel: false, short: true }))).join(' ');
            if (badge.textContent !== text) badge.textContent = text;
            badge.setAttribute('data-tip', list.length ? `${list.map(m => sourceLabel(m)).join(', ')} · click for options` : '');
            const learning = this.mapper.isLearning(target);
            host.classList.toggle('is-midi-learning', learning);
            host.classList.toggle('has-midi', !!list.length);
        };
        const d = { el: host, update, nodeId: sw.id, hit: learnable };
        this.decor.add(d);
        update();
        return update;
    }

    openSceneMenu(sw, target, anchor, { learnable = true } = {}) {
        const list = () => this.mapper.mappingsOf(sw).filter(m => m.target === target.target && (target.target !== 'scene' || m.option === target.option));
        const name = this.targetName(sw.id, target);
        const items = [{ header: `MIDI · ${name}` }];
        for (const m of list()) {
            items.push({
                icon: 'midi', label: sourceLabel(m), hint: m.device || '', keepOpen: false,
                onClick: () => this.openMappingEditor(sw, m, anchor)
            });
        }
        if (learnable) {
            items.push({ separator: true });
            items.push({
                icon: 'midi', label: list().length ? 'Learn again' : 'MIDI learn', hint: 'then press a pad / key',
                onClick: () => this.toggleLearn(target)
            });
        }
        if (list().length) {
            items.push({
                icon: 'trash', label: 'Clear mapping', danger: true,
                onClick: () => this.clearTarget(target)
            });
        }
        this.closeMenu();
        this.menu = UIHelpers.openMenu({ anchor, items, align: 'end', className: 'pp-midi-menu' });
    }

    // ------------------------------------------------------------------
    // Mapping menu
    // ------------------------------------------------------------------

    closeMenu() {
        if (this.menu && !this.menu.closed) this.menu.close();
        this.menu = null;
    }

    openParamMenu(node, anchor) {
        this.closeMenu();
        const content = el('div', 'pmm');
        // Keys typed in the menu never reach the canvas shortcuts
        content.addEventListener('keydown', (e) => e.stopPropagation());
        this.menu = UIHelpers.openMenu({ anchor, content, align: 'end', className: 'pp-midi-menu' });
        const render = () => {
            content.innerHTML = '';
            const list = this.mapper.mappingsOf(node);
            const head = el('div', 'pmm-title');
            head.appendChild(el('span', 'pmm-title-text', { text: `MIDI · ${paramLabel(node)}` }));
            content.appendChild(head);
            if (!list.length) content.appendChild(el('div', 'pmm-empty', { text: 'No mapping.' }));
            for (const m of list) content.appendChild(this.mappingBlock(node, m, render));
            const actions = el('div', 'pmm-actions');
            const learn = el('button', 'pt-btn pt-btn--sm pt-btn--outline', { type: 'button' });
            learn.innerHTML = `${icon('midi')}<span>Learn again</span>`;
            learn.addEventListener('click', () => {
                this.closeMenu();
                this.toggleLearn({ kind: 'param', nodeId: node.id });
            });
            const clear = el('button', 'pt-btn pt-btn--sm pt-btn--ghost pmm-danger', { type: 'button' });
            clear.innerHTML = `${icon('trash')}<span>Clear</span>`;
            clear.addEventListener('click', () => {
                this.mapper.clearMappings(node);
                this.closeMenu();
            });
            actions.append(learn, clear);
            content.appendChild(actions);
            this.menu?.reposition?.();
        };
        render();
    }

    /** Editor for a single scene mapping (from the scene menu). */
    openMappingEditor(node, m, anchor) {
        this.closeMenu();
        const content = el('div', 'pmm');
        content.addEventListener('keydown', (e) => e.stopPropagation());
        this.menu = UIHelpers.openMenu({ anchor, content, align: 'end', className: 'pp-midi-menu' });
        const render = () => {
            content.innerHTML = '';
            const cur = this.mapper.mappingsOf(node).find(x => x.id === m.id);
            if (!cur) { this.closeMenu(); return; }
            content.appendChild(this.mappingBlock(node, cur, render));
            this.menu?.reposition?.();
        };
        render();
    }

    /** One mapping: source line + the options that apply to it. */
    mappingBlock(node, m, rerender) {
        const box = el('div', 'pmm-map');
        const kind = node.isParamNode ? normalizeKind(node.data.kind) : null;
        const update = (patch) => {
            try {
                this.mapper.updateMapping(node, m.id, patch);
            } catch (e) {
                UIHelpers.toast(e.message, 'error');
            }
            rerender();
        };

        const head = el('div', 'pmm-head');
        head.appendChild(el('span', 'pmm-src', { text: sourceLabel(m) }));
        const what = this.targetName(node.id, m).replace(/^“[^”]*”\s*/, '').trim();
        if (what) head.appendChild(el('span', 'pmm-target', { text: `→ ${what.replace(/^[(=]\s*|\)$/g, '')}` }));
        head.appendChild(el('span', 'pp-spacer'));
        const rm = el('button', 'pt-icon-btn pt-icon-btn--sm', { type: 'button', 'aria-label': 'Remove this mapping', 'data-tip': 'Remove this mapping' });
        rm.innerHTML = icon('close');
        rm.addEventListener('click', () => {
            this.mapper.removeMapping(node, m.id);
            if (!this.mapper.mappingsOf(node).length) this.closeMenu();
            else rerender();
        });
        head.appendChild(rm);
        box.appendChild(head);
        if (m.device) box.appendChild(el('div', 'pmm-dev', { text: m.device }));

        const grid = el('div', 'pmm-grid');
        box.appendChild(grid);
        const row = (label, control) => {
            const r = el('label', 'pmm-row');
            r.appendChild(el('span', 'pmm-label', { text: label }));
            r.appendChild(control);
            grid.appendChild(r);
            return r;
        };
        const select = (opts, value, onChange) => {
            const s = el('select', 'pt-input pp-select pmm-select');
            for (const [v, t] of opts) s.appendChild(el('option', '', { value: v, text: t }));
            s.value = value;
            s.addEventListener('change', () => onChange(s.value));
            return s;
        };
        const check = (label, value, onChange, tip) => {
            const r = el('label', 'pmm-check', { 'data-tip': tip });
            const cb = el('input', 'pp-check', { type: 'checkbox' });
            cb.checked = !!value;
            cb.addEventListener('change', () => onChange(cb.checked));
            r.append(cb, el('span', '', { text: label }));
            grid.appendChild(r);
            return r;
        };
        const num = (value, placeholder, onChange, { width = 64 } = {}) => {
            const i = el('input', 'pt-input pmm-num', { type: 'text', inputmode: 'decimal', value: fmt(value), placeholder: fmt(placeholder) });
            i.style.width = `${width}px`;
            i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
            i.addEventListener('change', () => {
                const s = i.value.trim();
                if (s === '') return onChange(null);
                const n = Number(s.replace(',', '.'));
                if (Number.isFinite(n)) onChange(n);
                else i.value = fmt(value);
            });
            return i;
        };

        const continuous = isContinuousTarget(node, m);
        const relative = m.type === 'cc' && m.mode && m.mode !== 'absolute';
        const absolute = continuous && !relative && m.type !== 'note';

        // Channel
        const chans = [['0', 'Any channel'], ...Array.from({ length: 16 }, (_, i) => [String(i + 1), `Channel ${i + 1}`])];
        row('Channel', select(chans, String(m.channel || 0), (v) => update({ channel: Number(v) })));

        if (m.type === 'cc') {
            row('Encoder', select(CC_MODES.map(k => [k, CC_MODE_LABEL[k]]), m.mode || 'absolute', (v) => update({ mode: v, hires: v === 'absolute' ? m.hires : false })));
        }
        if (kind === 'color') {
            const targets = COLOR_TARGETS.filter(t => t !== 'a' || node.data.alpha);
            row('Controls', select(targets.map(t => [t, COLOR_TARGET_LABEL[t]]), m.target, (v) => update({ target: v })));
        }
        if (kind === 'enum' && m.type === 'note') {
            const opts = [...node.data.options.map((o, i) => [`option:${i}`, `Selects “${o}”`]), ['step', 'Next option']];
            row('Press', select(opts, m.target === 'step' ? 'step' : `option:${m.option}`, (v) => update(v === 'step' ? { target: 'step', option: null } : { target: 'option', option: Number(v.split(':')[1]) })));
        }
        if (kind === 'bool') {
            row('Press', select([['toggle', 'Toggle on press'], ['momentary', 'Momentary (on while held)']], m.press || 'toggle', (v) => update({ press: v })));
        } else if (continuous && m.type === 'note') {
            row('Note', select([['velocity', 'Velocity sets the value'], ['toggle', 'Toggle min / max'], ['momentary', 'Max while held']], m.press || 'velocity', (v) => update({ press: v })));
        }
        if (continuous && kind !== 'enum' && !node.isSceneSwitcher) {
            const r = node.isParamNode ? (kind === 'color' ? { min: 0, max: 1 } : paramRange(node.data)) : { min: 0, max: 1 };
            const range = el('span', 'pmm-range');
            range.append(num(m.min, r.min, (v) => update({ min: v })), el('span', 'pmm-to', { text: 'to' }), num(m.max, r.max, (v) => update({ max: v })));
            row('Range', range).setAttribute('data-tip', 'Trim the control to part of the parameter range (empty = the parameter’s min / max)');
            const slew = el('span', 'pmm-range');
            slew.append(num(m.slew || 0, 0, (v) => update({ slew: v === null ? 0 : v }), { width: 52 }), el('span', 'pmm-to', { text: 's' }));
            row('Smoothing', slew).setAttribute('data-tip', 'Slew time: the value glides to the control over this long (0 = immediate)');
        }
        if (relative) {
            row('Sensitivity', num(m.sens || 1, 1, (v) => update({ sens: v === null ? 1 : v }), { width: 52 })).setAttribute('data-tip', '1 = 1/128 of the range per encoder tick');
        }
        if (absolute) check('Soft takeover', m.pickup, (v) => update({ pickup: v }), 'The value doesn’t jump: it waits until the control passes the current value');
        if (continuous) check('Invert', m.invert, (v) => update({ invert: v }), 'Reverse the control direction');
        if (m.type === 'cc' && m.number < 32 && !relative) check(`14-bit (CC ${m.number} + ${m.number + 32})`, m.hires, (v) => update({ hires: v }), 'High-resolution CC: MSB on CC n, LSB on CC n + 32');
        if (m.device) check(`Only from this device`, true, (v) => { if (!v) update({ device: null }); }, 'Unchecked: any MIDI input can drive this mapping');
        check('Send value back', m.feedback, (v) => update({ feedback: v }), 'MIDI out: echo the value to the controller (LED rings, motorized faders, pad lights)');
        return box;
    }
}
