/**
 * First-run interactive tour: a spotlight + pulsing pointer on the real UI and a small
 * step card. Steps watch for the user doing the thing (polling the app state a few
 * times a second) and move on by themselves; "Next" is always there as a fallback.
 *
 * Never blocking: the spotlight and pointer ignore the mouse (pointer-events: none),
 * only the card takes clicks, and nothing grabs keyboard focus. A step whose target
 * is missing is skipped. Completion / skip is remembered (env.js TOUR_DONE_KEY).
 *
 * Steps: TOUR_STEPS below. Styles: .pt-tour-* in style.css.
 */
import { h, escapeHtml } from '../UIHelpers.js';
import { icon } from '../icons.js';
import { audioEngine } from '../../services/AudioEngine.js';
import { markTourDone } from './env.js';
import { IS_MAC } from './shortcuts.js';

const MOD = IS_MAC ? '⌘' : 'Ctrl';
const POLL_MS = 200;
const ADVANCE_MS = 1100;
const PAD = 6;

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function visibleEl(el) {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
    return el;
}

const byId = (id) => visibleEl(document.getElementById(id));

function rectOf(t) {
    if (!t) return null;
    if (t instanceof Element) {
        const r = t.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height, el: t };
    }
    return t;
}

/** Screen rect of a canvas item (graph coords → client). */
function graphRect(app, item) {
    const g = app.nodeGraph;
    const c = g.canvas.getBoundingClientRect();
    const r = {
        left: c.left + g.panX + item.x * g.zoom,
        top: c.top + g.panY + item.y * g.zoom,
        width: (item.width || 0) * g.zoom,
        height: (item.height || 0) * g.zoom,
    };
    // Must be at least partly on the canvas
    if (r.left + r.width < c.left + 10 || r.top + r.height < c.top + 10 || r.left > c.right - 10 || r.top > c.bottom - 10) return null;
    if (r.width < 8 || r.height < 8) return null;
    // Clip to the canvas
    const left = Math.max(r.left, c.left + 2);
    const top = Math.max(r.top, c.top + 2);
    return { left, top, width: Math.min(r.left + r.width, c.right - 2) - left, height: Math.min(r.top + r.height, c.bottom - 2) - top };
}

function graphPoint(app, p) {
    const g = app.nodeGraph;
    const c = g.canvas.getBoundingClientRect();
    const x = c.left + g.panX + p.x * g.zoom;
    const y = c.top + g.panY + p.y * g.zoom;
    if (x < c.left || y < c.top || x > c.right || y > c.bottom) return null;
    return { x, y };
}

function canvasCard(app) {
    // No spotlight over the whole canvas, just a card near its top
    const el = visibleEl(document.getElementById('container'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left + r.width / 2 - 1, top: r.top + 56, width: 2, height: 2, noSpot: true };
}

function largestVisibleGroup(app) {
    const g = app.nodeGraph;
    const items = (g.getViewNodes ? g.getViewNodes() : g.nodes) || [];
    let best = null;
    let bestArea = 0;
    for (const it of items) {
        if (!it || !it.isGroupProxy) continue;
        const r = graphRect(app, it);
        if (!r) continue;
        const a = r.width * r.height;
        if (a > bestArea) { best = { item: it, rect: r }; bestArea = a; }
    }
    return best;
}

function hasGroups(app) {
    const ctl = app.nodeGraph && app.nodeGraph.groupCtl;
    try { return !!(ctl && ctl.hasGroups && ctl.hasGroups()); } catch (e) { return false; }
}

function graphSignature(app) {
    const g = app.nodeGraph;
    return `${g.nodes.length}:${g.connections.length}:${g.nodes[0] ? g.nodes[0].id : ''}:${g.nodes.length ? g.nodes[g.nodes.length - 1].id : ''}`;
}

function browserModal(app) {
    const pb = app.projectBrowser;
    if (pb && pb.isOpen && pb.isOpen() && pb.modal && pb.modal.modal) return visibleEl(pb.modal.modal);
    return null;
}

/* --------------------------------------------------------------------------
 * Steps
 *   target(app, state)  -> Element | rect | null   (null = skip the step)
 *   pointer(app, state) -> {x, y} | null           (default: the target's center)
 *   start(app, state)   -> snapshot stored in state.snap
 *   done(app, state)    -> true once the user did it
 * ------------------------------------------------------------------------ */

export const TOUR_STEPS = [
    {
        id: 'explore',
        title: 'Start from a demo',
        body: (app) => (browserModal(app)
            ? (app.projectBrowser.view === 'demos'
                ? 'Every demo is a live node graph. <strong>Click any card</strong> to open it on the canvas, then take it apart.'
                : 'Pick the <strong>Demos</strong> tab, then <strong>click any card</strong> to open it on the canvas. Every demo is a live node graph you can take apart.')
            : `Click <strong>Open</strong> (<kbd>${MOD}</kbd><kbd>O</kbd>) and pick a demo from the <strong>Demos</strong> tab. Every demo is a live node graph you can take apart. Your projects and Community projects live there too.`),
        target: (app) => browserModal(app) || byId('openBtn'),
        placement: (app) => (browserModal(app) ? 'corner' : 'bottom'),
        noDim: (app) => !!browserModal(app),
        start: (app) => ({ demo: app.projectManager?.projectState?.demo || null, sig: graphSignature(app), title: app.projectManager?.projectTitle }),
        done: (app, s) => !browserModal(app) && (
            (app.projectManager?.projectState?.demo || null) !== s.snap.demo ||
            graphSignature(app) !== s.snap.sig || app.projectManager?.projectTitle !== s.snap.title),
        doneText: 'Opened. Nice pick.',
    },
    {
        id: 'navigate',
        title: 'Pan, zoom and dive in',
        body: (app) => (hasGroups(app)
            ? `Scroll to pan, <kbd>${MOD}</kbd>+scroll or pinch to zoom. Boxes like this one are <strong>groups</strong>: double-click one, or zoom into its preview, to dive inside. <kbd>Esc</kbd> or a double-click on empty space goes back up.`
            : `Scroll to pan, <kbd>${MOD}</kbd>+scroll or pinch to zoom. Select nodes and press <kbd>${MOD}</kbd><kbd>G</kbd> to make a group; double-click a group to dive in and <kbd>Esc</kbd> to come back up.`),
        target: (app) => {
            const grp = largestVisibleGroup(app);
            return grp ? grp.rect : canvasCard(app);
        },
        start: (app) => {
            const g = app.nodeGraph;
            return { panX: g.panX, panY: g.panY, zoom: g.zoom, scope: g.groupCtl ? g.groupCtl.scope : null, groups: hasGroups(app) };
        },
        done: (app, s) => {
            const g = app.nodeGraph;
            const scope = g.groupCtl ? g.groupCtl.scope : null;
            if (scope !== s.snap.scope) return true;
            if (s.snap.groups) return false;
            const moved = Math.hypot(g.panX - s.snap.panX, g.panY - s.snap.panY) > 80;
            const zoomed = Math.abs(Math.log((g.zoom || 1) / (s.snap.zoom || 1))) > 0.15;
            return moved || zoomed;
        },
        doneText: 'You’re in. Esc brings you back up.',
    },
    {
        id: 'params',
        title: 'Tweak the parameters',
        body: (app) => {
            const has = app.nodeGraph.nodes.some(n => n.isParamNode);
            const lead = app.shell?.params?.isOpen?.()
                ? 'This is the <strong>Parameters</strong> panel (<kbd>P</kbd> shows and hides it)'
                : 'Press <kbd>P</kbd> (or this button) for the <strong>Parameters</strong> panel';
            return has
                ? `${lead}: every Param of the patch is a slider, color or toggle here. Drag one and watch the output change, no recompiling.`
                : `${lead}. This patch has no Param nodes yet: add one with the + in the panel and wire it into anything.`;
        },
        target: (app) => (app.shell?.params?.isOpen?.() ? (byId('paramsList') || byId('paramsPanel')) : byId('paramsToggleBtn')),
        placement: (app) => (app.shell?.params?.isOpen?.() ? 'left' : 'bottom'),
        start: (app, s) => {
            s.paramTouched = false;
            s.listen('patchtoy:param', (e) => { if (!e.detail || e.detail.what !== 'meta') s.paramTouched = true; });
            return { has: app.nodeGraph.nodes.some(n => n.isParamNode), open: !!app.shell?.params?.isOpen?.() };
        },
        done: (app, s) => (s.snap.has ? s.paramTouched : (!!app.shell?.params?.isOpen?.() && !s.snap.open)),
        doneText: 'That’s live: values never recompile the shader.',
    },
    {
        id: 'add',
        title: 'Add a node',
        body: () => 'Drag a node from the <strong>Library</strong> onto the canvas, or press <kbd>Tab</kbd> anywhere and type its name. Hover an item to preview it; its <strong>?</strong> opens the node’s help.',
        target: (app) => (app.shell?.isLibraryOpen?.() ? byId('libraryList') || byId('librarySidebar') : byId('addNodeBtn')),
        placement: (app) => (app.shell?.isLibraryOpen?.() ? 'right' : 'bottom'),
        start: (app) => ({ ids: new Set(app.nodeGraph.nodes.map(n => n.id)) }),
        done: (app, s) => {
            const fresh = app.nodeGraph.nodes.filter(n => !s.snap.ids.has(n.id) && !n.isCommentNode);
            if (fresh.length) s.shared.newNode = fresh[fresh.length - 1];
            return fresh.length > 0;
        },
        doneText: 'Added.',
    },
    {
        id: 'connect',
        title: 'Connect a cable',
        body: () => 'Drag from an <strong>output</strong> port (right edge of a node) to an <strong>input</strong> port (left edge) of another. Drop a cable on empty canvas to get a Preview of it; drag a plugged input away to unplug it.',
        target: (app, s) => {
            const n = s.shared.newNode;
            if (n && app.nodeGraph.nodes.includes(n)) {
                const r = graphRect(app, { x: n.x - 10, y: n.y - 10, width: (n.width || 0) + 20, height: (n.height || 0) + 20 });
                if (r) return r;
            }
            return canvasCard(app);
        },
        pointer: (app, s) => {
            const n = s.shared.newNode;
            if (!n || !app.nodeGraph.nodes.includes(n) || !n.outputs || !n.outputs.length || !n.getOutputPortPosition) return null;
            const p = n.getOutputPortPosition(0);
            return p ? graphPoint(app, p) : null;
        },
        start: (app) => ({ count: app.nodeGraph.connections.length }),
        done: (app, s) => app.nodeGraph.connections.length > s.snap.count,
        doneText: 'Connected. Cables carry typed values, colored by type.',
    },
    {
        id: 'audio',
        title: 'Make it react to music',
        body: () => 'Open the <strong>audio menu</strong> and choose <strong>Mic</strong> (or a File, a browser Tab, or the Metronome). The beat tracker locks on in a few seconds; Audio and Beat nodes and the <code>u_bass</code>, <code>u_kick</code>… uniforms follow the music.',
        target: () => byId('audioSourceBtn'),
        start: () => ({ src: audioEngine.source }),
        done: (app, s) => audioEngine.source !== 'off' && audioEngine.source !== s.snap.src,
        doneText: 'Listening. Watch the beat LED lock on.',
    },
    {
        id: 'output',
        title: 'Record or go fullscreen',
        body: () => '<strong>Output</strong> records a video of your patch, renders frame-perfect offline exports, and opens an <strong>output window</strong> for a second screen or projector (press <kbd>W</kbd> in it for warp and masks).',
        target: () => byId('outputBtn'),
        placement: () => 'bottom',
        start: () => ({}),
        done: (app) => {
            const m = app.output;
            return !!(m && (m.recorder || m.exporter || (m.window && !m.window.closed)));
        },
        doneText: 'Rolling.',
    },
    {
        id: 'share',
        title: 'Share it',
        body: () => `<strong>Save</strong> (<kbd>${MOD}</kbd><kbd>S</kbd>) stores the patch in the cloud and gives you a share link; publish it to <strong>Community</strong> from <strong>Open</strong> (<kbd>${MOD}</kbd><kbd>O</kbd>). Replay this tour, see every shortcut (<kbd>?</kbd>) or get help on any node (<kbd>F1</kbd>) from the <strong>?</strong> menu.`,
        target: () => byId('saveCloudBtn') || byId('helpBtn'),
        placement: () => 'bottom',
        start: () => ({}),
        done: null,
    },
];

/* --------------------------------------------------------------------------
 * Runner
 * ------------------------------------------------------------------------ */

export class Tour {
    constructor(app, steps = TOUR_STEPS) {
        this.app = app;
        this.steps = steps;
        this.index = -1;
        this.running = false;
        this.state = null;
        this.shared = {};
        this._listeners = [];
        this._timer = null;
        this._advanceTimer = null;
    }

    isRunning() { return this.running; }

    start(from = 0) {
        if (this.running) this.teardownStep();
        this.running = true;
        this.shared = {};
        this.buildDom();
        this.go(from, 1);
        this._timer = setInterval(() => this.poll(), POLL_MS);
        this._onResize = () => this.layout();
        window.addEventListener('resize', this._onResize);
        this._onKey = (e) => {
            if (!this.card || !this.card.contains(document.activeElement)) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stop('skipped'); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); this.next(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); this.back(); }
        };
        window.addEventListener('keydown', this._onKey, true);
        try { window.dispatchEvent(new CustomEvent('patchtoy:tour', { detail: { state: 'start' } })); } catch (e) { /* ignore */ }
    }

    /** reason: 'done' | 'skipped' (both remembered) | 'interrupted' (not remembered). */
    stop(reason = 'skipped') {
        if (!this.running) return;
        this.running = false;
        this.teardownStep();
        clearInterval(this._timer);
        this._timer = null;
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('keydown', this._onKey, true);
        for (const el of [this.spot, this.pointerEl, this.card]) el && el.remove();
        this.spot = this.pointerEl = this.card = null;
        if (reason === 'done' || reason === 'skipped') markTourDone(reason);
        try { window.dispatchEvent(new CustomEvent('patchtoy:tour', { detail: { state: 'stop', reason } })); } catch (e) { /* ignore */ }
    }

    next() {
        if (!this.running) return;
        if (this.index >= this.steps.length - 1) { this.stop('done'); return; }
        this.go(this.index + 1, 1);
    }

    back() {
        if (!this.running || this.index <= 0) return;
        this.go(this.index - 1, -1);
    }

    buildDom() {
        if (this.card) return;
        this.spot = h('div', { className: 'pt-tour-spot', 'aria-hidden': 'true' });
        this.pointerEl = h('div', { className: 'pt-tour-pointer', 'aria-hidden': 'true' });
        this.card = h('div', { className: 'pt-tour-card', role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Tour' });
        document.body.append(this.spot, this.pointerEl, this.card);
    }

    teardownStep() {
        clearTimeout(this._advanceTimer);
        this._advanceTimer = null;
        for (const [type, fn] of this._listeners) window.removeEventListener(type, fn);
        this._listeners = [];
        this.state = null;
    }

    resolveTarget(step) {
        try { return rectOf(step.target(this.app, this.state)); } catch (e) { return null; }
    }

    /** Enter step i, skipping steps whose target is missing (in direction dir). */
    go(i, dir = 1) {
        this.teardownStep();
        while (i >= 0 && i < this.steps.length) {
            const step = this.steps[i];
            const state = this.makeState();
            this.state = state;
            if (this.resolveTarget(step)) {
                this.index = i;
                try { state.snap = step.start ? step.start(this.app, state) : {}; } catch (e) { state.snap = {}; }
                this.render();
                return;
            }
            this.teardownStep();
            i += dir;
        }
        // Ran out of steps (all remaining targets missing)
        if (dir > 0) this.stop('done');
        else this.go(0, 1);
    }

    makeState() {
        const s = { snap: {}, shared: this.shared, completed: false };
        s.listen = (type, fn) => { window.addEventListener(type, fn); this._listeners.push([type, fn]); };
        return s;
    }

    get step() { return this.steps[this.index]; }

    render() {
        const step = this.step;
        const app = this.app;
        const n = this.steps.length;
        const last = this.index === n - 1;
        const body = typeof step.body === 'function' ? step.body(app, this.state) : step.body;
        const dots = this.steps.map((_, i) => `<span class="pt-tour-dot${i === this.index ? ' is-current' : i < this.index ? ' is-past' : ''}"></span>`).join('');
        this.card.innerHTML = `
            <div class="pt-tour-head">
                <span class="pt-tour-count">${this.index + 1} / ${n}</span>
                <span class="pt-tour-dots">${dots}</span>
                <button class="pt-icon-btn pt-icon-btn--sm pt-tour-x" type="button" aria-label="End the tour" data-tip="End the tour">${icon('close')}</button>
            </div>
            <div class="pt-tour-title">${escapeHtml(step.title)}</div>
            <div class="pt-tour-body">${body}</div>
            <div class="pt-tour-status">${step.done ? `<span class="pt-tour-wait"></span><span>Try it, or press Next</span>` : ''}</div>
            <div class="pt-tour-foot">
                <button class="pt-tour-skip" type="button">${last ? '' : 'Skip tour'}</button>
                <span class="pt-tour-spacer"></span>
                ${this.index > 0 ? '<button class="pt-btn pt-btn--ghost pt-btn--sm pt-tour-back" type="button">Back</button>' : ''}
                <button class="pt-btn pt-btn--primary pt-btn--sm pt-tour-next" type="button">${last ? 'Finish' : 'Next'}</button>
            </div>`;
        this.card.querySelector('.pt-tour-body').dataset.raw = body;
        this.card.querySelector('.pt-tour-x').addEventListener('click', () => this.stop('skipped'));
        const skip = this.card.querySelector('.pt-tour-skip');
        if (last) skip.remove(); else skip.addEventListener('click', () => this.stop('skipped'));
        this.card.querySelector('.pt-tour-back')?.addEventListener('click', () => this.back());
        this.card.querySelector('.pt-tour-next').addEventListener('click', () => this.next());
        this.card.dataset.step = step.id;
        this.card.classList.remove('is-done');
        this.layout();
    }

    poll() {
        if (!this.running || !this.state) return;
        const step = this.step;
        // The step's body may depend on state (browser open, groups present...)
        const body = typeof step.body === 'function' ? step.body(this.app, this.state) : step.body;
        const bodyEl = this.card.querySelector('.pt-tour-body');
        if (bodyEl && bodyEl.dataset.raw !== body) { bodyEl.innerHTML = body; bodyEl.dataset.raw = body; }
        this.layout();
        if (this.state.completed || !step.done) return;
        let ok = false;
        try { ok = !!step.done(this.app, this.state); } catch (e) { ok = false; }
        if (!ok) return;
        this.state.completed = true;
        this.card.classList.add('is-done');
        const status = this.card.querySelector('.pt-tour-status');
        if (status) status.innerHTML = `${icon('check', { size: 12 })}<span>${escapeHtml(step.doneText || 'Done')}</span>`;
        const idx = this.index;
        this._advanceTimer = setTimeout(() => { if (this.running && this.index === idx) this.next(); }, ADVANCE_MS);
    }

    layout() {
        if (!this.running || !this.card) return;
        const step = this.step;
        let r = this.resolveTarget(step);
        if (!r) {
            // The target went away mid-step (menu closed, panel hidden): card in the canvas
            r = canvasCard(this.app) || { left: window.innerWidth / 2, top: 80, width: 1, height: 1, noSpot: true };
        }
        const noDim = r.noSpot || (step.noDim && step.noDim(this.app, this.state));
        // Spotlight
        const spot = this.spot;
        if (r.noSpot) {
            spot.classList.remove('is-visible');
        } else {
            spot.classList.add('is-visible');
            spot.classList.toggle('is-nodim', !!noDim);
            const inModal = r.el && r.el.closest && r.el.closest('.pt-modal-backdrop');
            spot.classList.toggle('is-over-modal', !!inModal);
            Object.assign(spot.style, {
                left: `${Math.round(r.left - PAD)}px`, top: `${Math.round(r.top - PAD)}px`,
                width: `${Math.round(r.width + PAD * 2)}px`, height: `${Math.round(r.height + PAD * 2)}px`,
            });
        }
        // Pointer
        let p = null;
        try { p = step.pointer ? step.pointer(this.app, this.state) : null; } catch (e) { p = null; }
        if (!p && !r.noSpot && !(step.noDim && step.noDim(this.app, this.state))) {
            p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            // Big targets (panels, lists): point near their top instead of the middle;
            // small ones (buttons): just under them, so the dot never hides their label
            if (r.height > 120) p.y = r.top + Math.min(60, r.height / 4);
            else if (r.width < 160 && r.height < 60) p.y = r.top + r.height + PAD + 1;
        }
        this.pointerEl.classList.toggle('is-visible', !!p);
        if (p) this.pointerEl.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
        this.placeCard(r, step.placement ? step.placement(this.app, this.state) : null);
    }

    placeCard(r, pref) {
        const card = this.card;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const cw = card.offsetWidth || 320;
        const ch = card.offsetHeight || 180;
        const m = 14;
        const gap = 14;
        const clamp = (x, y) => ({ x: Math.max(m, Math.min(vw - cw - m, x)), y: Math.max(m, Math.min(vh - ch - m, y)) });
        // Menus / popovers opened during the step (audio menu, Output...) must stay usable
        const obstacles = [...document.querySelectorAll('.pt-menu')].map(el => el.getBoundingClientRect()).filter(o => o.width > 0);
        const hits = (p) => obstacles.some(o => p.x < o.right + 6 && p.x + cw > o.left - 6 && p.y < o.bottom + 6 && p.y + ch > o.top - 6);
        let pos;
        let side = 'corner';
        if (pref === 'corner') {
            pos = clamp(vw - cw - m - 8, vh - ch - m - 30);
        } else {
            const at = {
                bottom: () => ({ x: r.left + r.width / 2 - cw / 2, y: r.top + r.height + gap }),
                top: () => ({ x: r.left + r.width / 2 - cw / 2, y: r.top - gap - ch }),
                right: () => ({ x: r.left + r.width + gap, y: r.top + Math.min(r.height / 2, 120) - ch / 2 }),
                left: () => ({ x: r.left - gap - cw, y: r.top + Math.min(r.height / 2, 120) - ch / 2 }),
            };
            const fits = {
                bottom: r.top + r.height + gap + ch <= vh - m,
                top: r.top - gap - ch >= m,
                right: r.left + r.width + gap + cw <= vw - m,
                left: r.left - gap - cw >= m,
            };
            const order = r.noSpot ? ['bottom'] : [...new Set([pref, 'bottom', 'right', 'left', 'top'].filter(Boolean))];
            for (const s of order) {
                if (!fits[s] && !r.noSpot) continue;
                const p = clamp(at[s]().x, at[s]().y);
                if (!hits(p)) { pos = p; side = s; break; }
            }
            if (!pos) {
                // Every side is taken (big popover): bottom-left corner of the window
                const p = clamp(m + 260, vh - ch - m - 30);
                pos = hits(p) ? clamp(at.bottom().x, at.bottom().y) : p;
                side = 'corner';
            }
        }
        card.dataset.side = side;
        card.style.transform = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`;
        card.classList.add('is-visible');
    }
}
