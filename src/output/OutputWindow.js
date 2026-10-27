import { clock } from '../core/Clock.js';
import { quality } from '../rendering/QualityGovernor.js';
import {
    defaultCalibration, normalizeCalibration, setGridSize, squareToQuad, invert3, project, warpPoint,
    loadLocalCalibrations, saveLocalCalibration, GRID_SIZES, PATTERNS
} from './Calibration.js';

/**
 * Pop-out output window (second display / projector).
 *
 * A same-origin popup (about:blank, built from here) shows one Preview at full
 * window size: every frame of the popup the Preview renders in the main page's
 * shared GL context, through the projection-mapping warp, and is drawn onto the
 * popup's 2D canvas (drawImage from the shared canvas: GPU copy).
 *
 * Keys in the window: F / double-click fullscreen, W calibration overlay,
 * T test pattern, G grid warp (off / 3x3 / 5x5), M mask, B blend, Tab select,
 * arrows nudge (Shift fine 0.1 px, Alt coarse 10 px), R reset point, Shift+R reset all,
 * Backspace delete mask point, H help, Esc leave calibration.
 *
 * Displays: with the Window Management API (Chrome, permission
 * 'window-management') the window can be placed on a chosen screen; else the
 * user drags it there. Calibrations are kept per display (project + localStorage).
 */

const WINDOW_NAME = 'patchtoy-output';
const MODES = ['keystone', 'grid', 'mask', 'blend'];
const MODE_LABELS = { keystone: 'Keystone', grid: 'Grid', mask: 'Mask', blend: 'Blend' };
const PATTERN_LABELS = { off: 'Off', grid: 'Grid', bars: 'Bars', white: 'White' };

let cachedDetails = null;

function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);
}

async function permissionState() {
    for (const name of ['window-management', 'window-placement']) {
        try {
            const p = await navigator.permissions.query({ name });
            return p.state;
        } catch (e) { /* unknown name */ }
    }
    return 'prompt';
}

function describeScreen(s, i, details) {
    return {
        index: i,
        label: s.label || `Display ${i + 1}`,
        left: s.left, top: s.top, width: s.width, height: s.height,
        availLeft: s.availLeft, availTop: s.availTop, availWidth: s.availWidth, availHeight: s.availHeight,
        primary: !!s.isPrimary, internal: !!s.isInternal,
        dpr: s.devicePixelRatio || 1,
        current: details ? s === details.currentScreen : false
    };
}

/**
 * Screens via the Window Management API. request = true may show the permission
 * prompt (call from a user gesture). Never throws.
 */
export async function getScreens({ request = false } = {}) {
    if (typeof window.getScreenDetails !== 'function') return { supported: false, granted: false, state: 'unsupported', screens: [] };
    const state = await permissionState();
    if (state === 'denied') return { supported: true, granted: false, state, screens: [] };
    if (state !== 'granted' && !request) return { supported: true, granted: false, state, screens: [] };
    try {
        const details = cachedDetails || await withTimeout(window.getScreenDetails(), 8000);
        cachedDetails = details;
        return { supported: true, granted: true, state: 'granted', details, screens: details.screens.map((s, i) => describeScreen(s, i, details)) };
    } catch (e) {
        return { supported: true, granted: false, state: 'denied', error: e.message, screens: [] };
    }
}

function screenKey(s) {
    return `${s.label || 'Display'}|${s.width}x${s.height}`;
}

const POPUP_CSS = `
:root { color-scheme: dark; }
html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
body { font: 12px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #eceef4; user-select: none; -webkit-user-select: none; }
body.is-idle { cursor: none; }
canvas { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; display: block; }
#ov { pointer-events: none; }
body.is-cal #ov { pointer-events: auto; cursor: crosshair; }
#hint { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 8px 14px; border-radius: 8px;
  background: rgba(20,22,28,.88); border: 1px solid #3a4050; color: #a0a6b6; white-space: nowrap; transition: opacity .4s; pointer-events: none; }
#hint kbd, #hud kbd { font: inherit; color: #eceef4; padding: 0 4px; border-radius: 3px; background: #252935; border: 1px solid #3a4050; }
body.is-idle #hint { opacity: 0; }
#hud { position: fixed; left: 16px; top: 16px; width: 300px; max-height: calc(100vh - 32px); overflow: auto; display: none;
  padding: 12px; border-radius: 10px; background: rgba(20,22,28,.94); border: 1px solid #3a4050; box-shadow: 0 12px 40px rgba(0,0,0,.6); }
body.is-cal #hud { display: block; }
body.hud-right #hud { left: auto; right: 16px; }
body.is-cal.hud-hidden #hud { display: none; }
.h-title { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.h-title b { letter-spacing: .08em; font-size: 10px; text-transform: uppercase; color: #ff5c2b; }
.h-meta { color: #626a7c; font-size: 11px; }
.h-seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 3px; margin: 6px 0 10px; }
.h-seg button { height: 24px; border-radius: 5px; border: 1px solid #2a2e3a; background: #0f1116; color: #a0a6b6; font: inherit; font-size: 11px; cursor: pointer; }
.h-seg button:hover { color: #eceef4; background: #252935; }
.h-seg button.on { border-color: #ff5c2b; color: #eceef4; background: rgba(255,92,43,.16); }
.h-row { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
.h-row > span:first-child { width: 58px; flex: none; color: #a0a6b6; font-size: 11px; }
.h-row input[type=range] { flex: 1; min-width: 0; accent-color: #ff5c2b; }
.h-row output { width: 44px; text-align: right; color: #eceef4; font-size: 11px; }
.h-sec { display: none; }
.h-sec.on { display: block; }
.h-help { margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2e3a; color: #626a7c; font-size: 11px; }
.h-help div { margin: 2px 0; }
.h-btns { display: flex; gap: 6px; margin-top: 10px; }
.h-btns button { flex: 1; height: 26px; border-radius: 6px; border: 1px solid #3a4050; background: #252935; color: #eceef4; font: inherit; font-size: 11px; cursor: pointer; }
.h-btns button:hover { background: #2c3140; }
.h-note { color: #626a7c; font-size: 11px; margin: 4px 0; }
#fsPrompt { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.35); cursor: pointer; }
#fsPrompt.on { display: flex; }
#fsPrompt div { padding: 14px 20px; border-radius: 10px; background: rgba(20,22,28,.94); border: 1px solid #ff5c2b; color: #eceef4; }
`;

export class OutputWindow {
    constructor(manager, node) {
        this.manager = manager;
        this.node = node;
        this.sourceRef = manager.settings.source;
        this.win = null;
        this.closedFlag = false;
        this.calibrating = false;
        this.mode = 'keystone';
        this.selected = 0;
        this.cal = defaultCalibration();
        this.displayKey = null;
        this.displayLabel = '';
        this.fps = 0;
        this._frames = 0;
        this._fpsAt = 0;
        this.overlayDirty = true;
        this._frame = this._frame.bind(this);
        this._saveTimer = null;
    }

    get closed() { return this.closedFlag || !this.win || this.win.closed; }

    // ------------------------------------------------------------------
    // Open / close
    // ------------------------------------------------------------------

    async open({ display, fullscreen = false } = {}) {
        let rect = { width: 960, height: 540, left: (window.screenX || 0) + 80, top: (window.screenY || 0) + 80 };
        let target = null;
        if (display !== undefined && display !== null && display !== 'current') {
            const scr = await getScreens({ request: true });
            target = this._pickScreen(scr, display);
            if (target) {
                rect = { width: target.availWidth || target.width, height: target.availHeight || target.height, left: target.availLeft ?? target.left, top: target.availTop ?? target.top };
                this.screens = scr;
            }
        }
        const features = `popup=yes,width=${Math.round(rect.width)},height=${Math.round(rect.height)},left=${Math.round(rect.left)},top=${Math.round(rect.top)}`;
        const win = window.open('', WINDOW_NAME, features);
        if (!win) throw new Error('The output window was blocked: allow pop-ups for this site, or click "Open output window" in the app');
        this.win = win;
        this._build();
        this._detectDisplay();
        this.reloadCalibration();
        this.raf = win.requestAnimationFrame(this._frame);
        // Closing: either side
        win.addEventListener('pagehide', () => this._onClosed());
        win.document.addEventListener('visibilitychange', () => this._syncDriving());
        this._poll = setInterval(() => {
            if (this.closed) { this._onClosed(); return; }
            this._detectDisplay();
            // the window's frames stalled (hidden, throttled): hand the frame clock back to the editor
            if (this.driving && performance.now() - this.lastFrameAt > 400) this._drive(false);
        }, 500);
        if (target && rect) {
            try { win.moveTo(rect.left, rect.top); win.resizeTo(rect.width, rect.height); } catch (e) { /* not allowed */ }
        }
        if (fullscreen) await this.requestFullscreen(target ? this._screenObject(target) : null);
        return this;
    }

    _pickScreen(scr, display) {
        if (!scr || !scr.granted || !scr.screens.length) return null;
        const list = scr.screens;
        if (typeof display === 'number' || /^\d+$/.test(String(display))) return list[Number(display)] || null;
        const d = String(display).toLowerCase();
        if (d === 'secondary' || d === 'external') return list.find(s => !s.primary) || null;
        if (d === 'primary') return list.find(s => s.primary) || null;
        return list.find(s => s.label.toLowerCase().includes(d)) || null;
    }

    _screenObject(desc) {
        const det = (this.screens && this.screens.details) || cachedDetails;
        return det && desc ? det.screens[desc.index] || null : null;
    }

    async moveToDisplay(display, { fullscreen = false } = {}) {
        if (this.closed) return;
        const scr = await getScreens({ request: true });
        const t = this._pickScreen(scr, display);
        if (!t) throw new Error(scr.supported ? (scr.granted ? `No display "${display}"` : 'Window management permission not granted') : 'This browser cannot place windows on other displays (Window Management API): drag the window there');
        this.screens = scr;
        try {
            if (this.win.document.fullscreenElement) await this.win.document.exitFullscreen();
        } catch (e) { /* ignore */ }
        try {
            this.win.moveTo(t.availLeft ?? t.left, t.availTop ?? t.top);
            this.win.resizeTo(t.availWidth || t.width, t.availHeight || t.height);
        } catch (e) { /* ignore */ }
        this._detectDisplay();
        if (fullscreen) await this.requestFullscreen(this._screenObject(t));
    }

    async requestFullscreen(screen = null) {
        const d = this.win && this.win.document;
        if (!d) return false;
        try {
            await d.documentElement.requestFullscreen(screen ? { screen, navigationUI: 'hide' } : { navigationUI: 'hide' });
            this._fsPrompt(false);
            return true;
        } catch (e) {
            // needs a user gesture in the output window itself
            this.pendingScreen = screen;
            this._fsPrompt(true);
            return false;
        }
    }

    toggleFullscreen() {
        const d = this.win.document;
        if (d.fullscreenElement) d.exitFullscreen().catch(() => {});
        else this.requestFullscreen();
    }

    focus() { try { this.win.focus(); } catch (e) { /* ignore */ } }

    close() {
        if (this.win && !this.win.closed) {
            try { this.win.close(); } catch (e) { /* ignore */ }
        }
        this._onClosed();
    }

    _onClosed() {
        if (this.closedFlag) return;
        this.closedFlag = true;
        this._drive(false);
        clearInterval(this._poll);
        clearTimeout(this._idleTimer);
        this._flushSave();
        try { if (this.win && !this.win.closed) this.win.cancelAnimationFrame(this.raf); } catch (e) { /* ignore */ }
        try { if (this.win && !this.win.closed) this.win.close(); } catch (e) { /* ignore */ }
        this.manager._windowClosed(this);
    }

    /**
     * While this window is visible it drives the app's frames (clock + per-frame
     * work, see OutputManager.driveFrame): one simulation step per output frame,
     * at the output display's refresh rate. Hidden: the editor's frames take over.
     */
    _drive(on) {
        on = !!on;
        if (on === !!this.driving) return;
        this.driving = on;
        clock.setManual(on, { owner: this });
    }

    _syncDriving() {
        const visible = !this.closed && this.win.document.visibilityState === 'visible';
        if (!visible) this._drive(false);
    }

    setSource(node) {
        this.node = node;
        this.sourceRef = this.manager.settings.source;
        this._updateHud();
    }

    _currentNode() {
        const nodes = this.manager.app.nodeGraph?.nodes || [];
        if (!this.node || !nodes.includes(this.node)) this.node = this.manager.resolveSource(this.sourceRef);
        return this.node;
    }

    status() {
        const w = this.win;
        return {
            open: !this.closed,
            source: this.node ? this.node.id : null,
            width: this.canvas ? this.canvas.width : 0,
            height: this.canvas ? this.canvas.height : 0,
            fps: this.fps,
            fullscreen: !!(w && !w.closed && w.document.fullscreenElement),
            display: this.displayLabel,
            display_key: this.displayKey,
            calibrating: this.calibrating,
            test_pattern: this.cal.pattern,
            warp: {
                corners: this.cal.corners.map(p => p.map(v => +v.toFixed(4))),
                grid: this.cal.gridSize,
                blend: this.cal.blend,
                mask_points: this.cal.mask.points.length
            }
        };
    }

    // ------------------------------------------------------------------
    // Popup document
    // ------------------------------------------------------------------

    _build() {
        const win = this.win;
        const d = win.document;
        d.title = 'PatchToy Output';
        d.head.innerHTML = `<meta charset="utf-8"><style>${POPUP_CSS}</style>`;
        d.body.className = '';
        d.body.innerHTML = `
            <canvas id="out"></canvas>
            <canvas id="ov"></canvas>
            <div id="hint">Double-click or <kbd>F</kbd> fullscreen · <kbd>W</kbd> calibrate · <kbd>T</kbd> test pattern</div>
            <div id="fsPrompt"><div>Click here to go fullscreen on this display</div></div>
            <div id="hud"></div>`;
        this.canvas = d.getElementById('out');
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.ov = d.getElementById('ov');
        this.octx = this.ov.getContext('2d');
        this.hud = d.getElementById('hud');
        this._buildHud();

        d.getElementById('fsPrompt').addEventListener('click', () => this.requestFullscreen(this.pendingScreen || null));
        win.addEventListener('keydown', (e) => this._onKey(e));
        win.addEventListener('resize', () => { this.overlayDirty = true; });
        d.addEventListener('fullscreenchange', () => { this.overlayDirty = true; this.manager.emit('window'); });
        d.addEventListener('dblclick', (e) => {
            if (this.calibrating && this.mode === 'mask') return;
            if (e.target.closest && e.target.closest('#hud')) return;
            this.toggleFullscreen();
        });
        const poke = () => {
            d.body.classList.remove('is-idle');
            clearTimeout(this._idleTimer);
            this._idleTimer = setTimeout(() => { if (!this.closed) d.body.classList.add('is-idle'); }, 2500);
        };
        win.addEventListener('mousemove', poke);
        poke();
        this.ov.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this.ov.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this.ov.addEventListener('pointerup', (e) => this._onPointerUp(e));
        this.ov.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    _fsPrompt(on) {
        const el = this.win && !this.win.closed && this.win.document.getElementById('fsPrompt');
        if (el) el.classList.toggle('on', !!on);
    }

    _buildHud() {
        const d = this.win.document;
        const hud = this.hud;
        const seg = (items, labels, cls) => `<div class="h-seg ${cls}">${items.map(m => `<button data-v="${m}">${labels[m] ?? m}</button>`).join('')}</div>`;
        const range = (key, label, min, max, step) => `<label class="h-row"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}"><output data-o="${key}"></output></label>`;
        hud.innerHTML = `
            <div class="h-title"><b>Output calibration</b><span class="h-meta" id="hMeta"></span></div>
            <div class="h-meta" id="hDisplay"></div>
            ${seg(MODES, MODE_LABELS, 'h-modes')}
            <div class="h-sec" data-sec="keystone"><div class="h-note">Drag the 4 corners, or select one (<kbd>Tab</kbd> / <kbd>1</kbd>-<kbd>4</kbd>) and nudge with the arrows.</div></div>
            <div class="h-sec" data-sec="grid">${seg(GRID_SIZES.map(String), { 0: 'Off', 3: '3×3', 5: '5×5' }, 'h-grid')}<div class="h-note">Drag control points for a smooth warp on curved or uneven surfaces.</div></div>
            <div class="h-sec" data-sec="mask">
                <div class="h-note">Click to add points, drag to move, <kbd>⌫</kbd> deletes the selected point.</div>
                ${range('mask.feather', 'Feather', 0, 120, 1)}
                <label class="h-row"><span>Invert</span><input type="checkbox" data-k="mask.invert"></label>
                <div class="h-btns"><button data-act="clearMask">Clear mask</button></div>
            </div>
            <div class="h-sec" data-sec="blend">
                ${range('blend.left', 'Left', 0, 0.5, 0.005)}
                ${range('blend.right', 'Right', 0, 0.5, 0.005)}
                ${range('blend.top', 'Top', 0, 0.5, 0.005)}
                ${range('blend.bottom', 'Bottom', 0, 0.5, 0.005)}
                ${range('blend.curve', 'Curve', 0.5, 6, 0.05)}
                ${range('blend.gamma', 'Gamma', 0.5, 4, 0.05)}
                <div class="h-note">Feathered edges for projector overlap: width (share of the image), curve steepness and the projector gamma.</div>
            </div>
            <div class="h-row"><span>Pattern</span></div>
            ${seg(PATTERNS, PATTERN_LABELS, 'h-pattern')}
            <div class="h-btns"><button data-act="resetMode">Reset this</button><button data-act="resetAll">Reset all</button><button data-act="hide">Hide <kbd>H</kbd></button></div>
            <div class="h-help">
                <div><kbd>W</kbd> calibrate · <kbd>T</kbd> pattern · <kbd>G</kbd> grid · <kbd>M</kbd> mask · <kbd>B</kbd> blend</div>
                <div><kbd>←↑→↓</kbd> nudge 1 px · <kbd>⇧</kbd> 0.1 px · <kbd>⌥</kbd> 10 px</div>
                <div><kbd>R</kbd> reset point · <kbd>⇧R</kbd> reset all · <kbd>F</kbd> fullscreen · <kbd>Esc</kbd> done</div>
                <div>Saved per display, in the project and on this machine.</div>
            </div>`;
        hud.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            const segEl = b.closest('.h-seg');
            if (segEl && segEl.classList.contains('h-modes')) this.setMode(b.dataset.v);
            else if (segEl && segEl.classList.contains('h-grid')) { setGridSize(this.cal, Number(b.dataset.v)); this.mode = 'grid'; this.selected = 0; this._changed(); }
            else if (segEl && segEl.classList.contains('h-pattern')) this.setPattern(b.dataset.v);
            else if (b.dataset.act === 'clearMask') { this.cal.mask.points = []; this.selected = -1; this._changed(); }
            else if (b.dataset.act === 'resetMode') this.resetMode();
            else if (b.dataset.act === 'resetAll') this.resetAll();
            else if (b.dataset.act === 'hide') this._toggleHud();
            b.blur();
        });
        hud.addEventListener('input', (e) => {
            const k = e.target.dataset.k;
            if (!k) return;
            const [group, field] = k.split('.');
            this.cal[group][field] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
            this._changed({ hud: false });
            this._updateHudValues();
        });
        hud.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.hudEls = {
            meta: d.getElementById('hMeta'),
            display: d.getElementById('hDisplay')
        };
        this._updateHud();
    }

    _toggleHud() {
        this.win.document.body.classList.toggle('hud-hidden');
    }

    _updateHud() {
        if (!this.hud || this.closed) return;
        const q = (s) => this.hud.querySelectorAll(s);
        q('.h-modes button').forEach(b => b.classList.toggle('on', b.dataset.v === this.mode));
        q('.h-grid button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === this.cal.gridSize));
        q('.h-pattern button').forEach(b => b.classList.toggle('on', b.dataset.v === this.cal.pattern));
        q('.h-sec').forEach(s => s.classList.toggle('on', s.dataset.sec === this.mode));
        if (this.hudEls) this.hudEls.display.textContent = this.displayLabel ? `Display: ${this.displayLabel}` : '';
        this._updateHudValues();
    }

    _updateHudValues() {
        if (!this.hud) return;
        for (const input of this.hud.querySelectorAll('[data-k]')) {
            const [group, field] = input.dataset.k.split('.');
            const v = this.cal[group][field];
            if (input.type === 'checkbox') input.checked = !!v;
            else if (this.win.document.activeElement !== input) input.value = String(v);
            const out = this.hud.querySelector(`[data-o="${input.dataset.k}"]`);
            if (out) out.textContent = group === 'blend' && ['left', 'right', 'top', 'bottom'].includes(field) ? `${Math.round(v * 100)}%` : field === 'feather' ? `${Math.round(v)}px` : Number(v).toFixed(2);
        }
    }

    // ------------------------------------------------------------------
    // Calibration state
    // ------------------------------------------------------------------

    _detectDisplay() {
        const w = this.win;
        if (!w || w.closed) return;
        let key, label;
        const det = cachedDetails;
        if (det && det.screens && det.screens.length) {
            const cx = w.screenX + w.outerWidth / 2, cy = w.screenY + w.outerHeight / 2;
            const s = det.screens.find(sc => cx >= sc.left && cx < sc.left + sc.width && cy >= sc.top && cy < sc.top + sc.height) || det.currentScreen;
            const i = det.screens.indexOf(s);
            key = screenKey(s);
            label = `${s.label || `Display ${i + 1}`} (${s.width}×${s.height})`;
        } else {
            const s = w.screen;
            key = `screen|${s.width}x${s.height}@${s.availLeft ?? 0},${s.availTop ?? 0}`;
            label = `${s.width}×${s.height}${s.isExtended ? ' · extended desktop' : ''}`;
        }
        if (key === this.displayKey) return;
        const first = this.displayKey === null;
        this.displayKey = key;
        this.displayLabel = label;
        if (!first) {
            // Moved to another display: its own calibration, else keep the current one
            const stored = this.manager.projectCalibration(key) || loadLocalCalibrations()[key];
            if (stored) this._setCal(normalizeCalibration(stored));
            else this._save();
        }
        this._updateHud();
        this.manager.emit('window');
    }

    reloadCalibration() {
        if (!this.displayKey) return;
        const stored = this.manager.projectCalibration(this.displayKey) || loadLocalCalibrations()[this.displayKey];
        this._setCal(stored ? normalizeCalibration(stored) : defaultCalibration());
    }

    _setCal(cal) {
        const pattern = this.cal ? this.cal.pattern : 'off';
        this.cal = cal;
        this.cal.pattern = pattern; // the test pattern is a live toggle, not saved
        this.selected = 0;
        this.overlayDirty = true;
        this._updateHud();
    }

    /** Replace parts of the calibration (automation): { corners, gridSize, grid, blend, mask } */
    applyCalibration(patch = {}) {
        const merged = normalizeCalibration({ ...this.cal, ...patch, blend: { ...this.cal.blend, ...(patch.blend || {}) }, mask: { ...this.cal.mask, ...(patch.mask || {}) } });
        if (patch.gridSize !== undefined && patch.grid === undefined) {
            const g = this.cal;
            merged.gridSize = g.gridSize; merged.grid = g.grid;
            setGridSize(merged, Number(patch.gridSize));
        }
        merged.pattern = patch.pattern !== undefined && PATTERNS.includes(patch.pattern) ? patch.pattern : this.cal.pattern;
        this.cal = merged;
        this._changed();
    }

    _changed({ hud = true } = {}) {
        this.overlayDirty = true;
        if (hud) this._updateHud();
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._save(), 300);
        this.manager.emit('window');
    }

    _persistable() {
        const c = JSON.parse(JSON.stringify(this.cal));
        delete c.pattern;
        return c;
    }

    _save() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        if (!this.displayKey) return;
        const c = this._persistable();
        saveLocalCalibration(this.displayKey, c);
        this.manager.storeProjectCalibration(this.displayKey, c);
    }

    _flushSave() {
        if (this._saveTimer) this._save();
    }

    setCalibrating(on) {
        this.calibrating = !!on;
        if (!this.closed) this.win.document.body.classList.toggle('is-cal', this.calibrating);
        this.overlayDirty = true;
        if (!this.calibrating) this.octx.clearRect(0, 0, this.ov.width, this.ov.height);
        this.manager.emit('window');
    }

    setMode(mode) {
        if (!MODES.includes(mode)) return;
        this.mode = mode;
        if (mode === 'grid' && !this.cal.gridSize) setGridSize(this.cal, 3);
        this.selected = mode === 'mask' ? this.cal.mask.points.length - 1 : 0;
        this._changed();
    }

    setPattern(p) {
        if (!PATTERNS.includes(p)) return;
        this.cal.pattern = p;
        this.overlayDirty = true;
        this._updateHud();
        this.manager.emit('window');
    }

    cyclePattern() {
        const i = PATTERNS.indexOf(this.cal.pattern);
        this.setPattern(PATTERNS[(i + 1) % PATTERNS.length]);
    }

    resetMode() {
        const d = defaultCalibration();
        if (this.mode === 'keystone') this.cal.corners = d.corners;
        else if (this.mode === 'grid') this.cal.grid = this.cal.grid.map(() => [0, 0]);
        else if (this.mode === 'mask') this.cal.mask = d.mask;
        else if (this.mode === 'blend') this.cal.blend = d.blend;
        this._changed();
    }

    resetAll() {
        const pattern = this.cal.pattern;
        this.cal = defaultCalibration();
        this.cal.pattern = pattern;
        this.selected = 0;
        this._changed();
    }

    // ------------------------------------------------------------------
    // Points (output space, 0..1)
    // ------------------------------------------------------------------

    _points() {
        const c = this.cal;
        if (this.mode === 'grid' && c.gridSize) {
            const H = squareToQuad(c.corners);
            const n = c.gridSize, pts = [];
            for (let j = 0; j < n; j++) {
                for (let i = 0; i < n; i++) {
                    const o = c.grid[j * n + i];
                    pts.push(project(H, i / (n - 1) + o[0], j / (n - 1) + o[1]));
                }
            }
            return pts;
        }
        if (this.mode === 'mask') return c.mask.points;
        return c.corners;
    }

    _setPoint(index, x, y) {
        const c = this.cal;
        if (this.mode === 'grid' && c.gridSize) {
            const inv = invert3(squareToQuad(c.corners));
            if (!inv) return;
            const n = c.gridSize;
            const [u, v] = project(inv, x, y);
            const i = index % n, j = Math.floor(index / n);
            c.grid[index] = [u - i / (n - 1), v - j / (n - 1)];
        } else if (this.mode === 'mask') {
            if (c.mask.points[index]) c.mask.points[index] = [x, y];
        } else if (c.corners[index]) {
            c.corners[index] = [x, y];
        }
    }

    _resetPoint(index) {
        const c = this.cal;
        if (this.mode === 'grid' && c.gridSize) { if (c.grid[index]) c.grid[index] = [0, 0]; }
        else if (this.mode === 'keystone' && c.corners[index]) c.corners[index] = defaultCalibration().corners[index];
        this._changed();
    }

    _toNorm(e) {
        const w = this.win;
        return [e.clientX / w.innerWidth, e.clientY / w.innerHeight];
    }

    _hit(e) {
        const w = this.win;
        const pts = this._points();
        let best = -1, bestD = 16;
        pts.forEach((p, i) => {
            const d = Math.hypot(p[0] * w.innerWidth - e.clientX, p[1] * w.innerHeight - e.clientY);
            if (d < bestD) { bestD = d; best = i; }
        });
        return best;
    }

    _onPointerDown(e) {
        if (!this.calibrating || e.button !== 0) return;
        if (this.mode === 'blend') return;
        const hit = this._hit(e);
        const [x, y] = this._toNorm(e);
        if (hit >= 0) {
            this.selected = hit;
            const p = this._points()[hit];
            this.drag = { index: hit, dx: p[0] - x, dy: p[1] - y };
            this.ov.setPointerCapture(e.pointerId);
        } else if (this.mode === 'mask') {
            if (this.cal.mask.points.length >= 32) return;
            this.cal.mask.points.push([x, y]);
            this.selected = this.cal.mask.points.length - 1;
            this.drag = { index: this.selected, dx: 0, dy: 0 };
            this.ov.setPointerCapture(e.pointerId);
            this._changed();
        }
        this.overlayDirty = true;
    }

    _onPointerMove(e) {
        if (!this.drag) return;
        const [x, y] = this._toNorm(e);
        this._setPoint(this.drag.index, x + this.drag.dx, y + this.drag.dy);
        this._changed({ hud: false });
    }

    _onPointerUp() {
        if (!this.drag) return;
        this.drag = null;
        this._changed();
    }

    _nudge(dxPx, dyPx) {
        const pts = this._points();
        const p = pts[this.selected];
        if (!p) return;
        const W = this.canvas.width || 1, H = this.canvas.height || 1;
        this._setPoint(this.selected, p[0] + dxPx / W, p[1] + dyPx / H);
        this._changed({ hud: false });
    }

    _onKey(e) {
        const k = e.key;
        const target = e.target;
        if (target && (target.tagName === 'INPUT' && target.type !== 'range' && target.type !== 'checkbox')) return;
        const lower = k.length === 1 ? k.toLowerCase() : k;
        if (lower === 'f') { this.toggleFullscreen(); e.preventDefault(); return; }
        if (lower === 'w') { this.setCalibrating(!this.calibrating); e.preventDefault(); return; }
        if (lower === 't') { this.cyclePattern(); e.preventDefault(); return; }
        if (!this.calibrating) return;
        if (k === 'Escape') { this.setCalibrating(false); e.preventDefault(); return; }
        if (lower === 'g') {
            const i = GRID_SIZES.indexOf(this.cal.gridSize);
            const next = this.mode === 'grid' ? GRID_SIZES[(i + 1) % GRID_SIZES.length] : (this.cal.gridSize || 3);
            setGridSize(this.cal, next);
            this.mode = next ? 'grid' : 'keystone';
            this.selected = 0;
            this._changed();
            e.preventDefault();
            return;
        }
        if (lower === 'm') { this.setMode(this.mode === 'mask' ? 'keystone' : 'mask'); e.preventDefault(); return; }
        if (lower === 'b') { this.setMode(this.mode === 'blend' ? 'keystone' : 'blend'); e.preventDefault(); return; }
        if (lower === 'h' || k === '?') { this._toggleHud(); e.preventDefault(); return; }
        if (lower === 'r') {
            if (e.shiftKey) this.resetAll(); else this._resetPoint(this.selected);
            e.preventDefault();
            return;
        }
        const pts = this._points();
        if (k === 'Tab') {
            if (pts.length) this.selected = (this.selected + (e.shiftKey ? pts.length - 1 : 1)) % pts.length;
            this.overlayDirty = true;
            e.preventDefault();
            return;
        }
        if (this.mode === 'keystone' && /^[1-4]$/.test(k)) { this.selected = Number(k) - 1; this.overlayDirty = true; e.preventDefault(); return; }
        if ((k === 'Backspace' || k === 'Delete') && this.mode === 'mask' && this.cal.mask.points[this.selected]) {
            this.cal.mask.points.splice(this.selected, 1);
            this.selected = Math.min(this.selected, this.cal.mask.points.length - 1);
            this._changed();
            e.preventDefault();
            return;
        }
        const step = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
        const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (arrows[k]) { this._nudge(...arrows[k]); e.preventDefault(); }
    }

    // ------------------------------------------------------------------
    // Frame
    // ------------------------------------------------------------------

    _frame(now) {
        if (this.closed) { this._onClosed(); return; }
        const win = this.win;
        this.raf = win.requestAnimationFrame(this._frame);
        try {
            this.lastFrameAt = performance.now();
            if (!this.driving && this.win.document.visibilityState === 'visible') this._drive(true);
            if (this.driving) this.manager.driveFrame();
            const dpr = win.devicePixelRatio || 1;
            const W = Math.max(2, Math.round(win.innerWidth * dpr));
            const H = Math.max(2, Math.round(win.innerHeight * dpr));
            if (this.canvas.width !== W || this.canvas.height !== H) {
                this.canvas.width = W; this.canvas.height = H;
                this.ov.width = W; this.ov.height = H;
                this.overlayDirty = true;
            }
            // Dynamic resolution: the output window's own governor (its frame rate, its display)
            const gov = quality.governors.output;
            gov.sample(this._lastNow ? now - this._lastNow : 0, now, win);
            this._lastNow = now;
            const scale = gov.scale;
            this.manager.renderInto(this._currentNode(), W, H, this.ctx, this.cal, { scale });
            quality.noteOutput('output-window', W, H, this.manager.isBusy() ? 1 : scale, now);
            if (this.calibrating && this.overlayDirty) this._drawOverlay();
        } catch (e) {
            if (!this._warned) { this._warned = true; console.warn('[output] window frame failed', e); }
        }
        this._frames++;
        if (now - this._fpsAt >= 1000) {
            this.fps = Math.round(this._frames * 1000 / (now - this._fpsAt || 1));
            this._frames = 0;
            this._fpsAt = now;
            const sc = quality.governors.output.scale;
            if (this.hudEls && this.calibrating) this.hudEls.meta.textContent = `${this.canvas.width}×${this.canvas.height}${sc < 1 ? ` · render ${Math.round(sc * 100)}%` : ''} · ${this.fps} fps`;
        }
    }

    /** Keep the panel away from the handle being edited (it moves to the other side). */
    _placeHud(p) {
        if (!p || !this.hud || this.drag) return;
        const body = this.win.document.body;
        const r = this.hud.getBoundingClientRect();
        const x = p[0] * this.win.innerWidth, y = p[1] * this.win.innerHeight;
        const pad = 24;
        if (x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad) body.classList.toggle('hud-right');
    }

    _drawOverlay() {
        this.overlayDirty = false;
        const ctx = this.octx;
        const W = this.ov.width, H = this.ov.height;
        const dpr = this.win.devicePixelRatio || 1;
        ctx.clearRect(0, 0, W, H);
        const c = this.cal;
        const Hm = squareToQuad(c.corners);
        const P = (u, v) => { const p = warpPoint(c, Hm, u, v); return [p[0] * W, p[1] * H]; };

        // Warped grid lines (content space)
        ctx.lineWidth = 1 * dpr;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
        const lines = c.gridSize ? (c.gridSize - 1) * 2 : 4;
        for (let k = 1; k < lines; k++) {
            const t = k / lines;
            for (const horiz of [false, true]) {
                ctx.beginPath();
                for (let s = 0; s <= 48; s++) {
                    const q = s / 48;
                    const [x, y] = horiz ? P(q, t) : P(t, q);
                    if (s) ctx.lineTo(x, y); else ctx.moveTo(x, y);
                }
                ctx.stroke();
            }
        }
        // Outline of the warped image
        ctx.strokeStyle = '#ff5c2b';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        const edge = [];
        for (let s = 0; s <= 48; s++) edge.push([s / 48, 0]);
        for (let s = 0; s <= 48; s++) edge.push([1, s / 48]);
        for (let s = 48; s >= 0; s--) edge.push([s / 48, 1]);
        for (let s = 48; s >= 0; s--) edge.push([0, s / 48]);
        edge.forEach(([u, v], i) => { const [x, y] = P(u, v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.closePath();
        ctx.stroke();

        // Mask polygon
        const mp = c.mask.points;
        if (mp.length) {
            ctx.setLineDash([6 * dpr, 4 * dpr]);
            ctx.strokeStyle = this.mode === 'mask' ? '#f5c84b' : 'rgba(245, 200, 75, 0.5)';
            ctx.lineWidth = 1.5 * dpr;
            ctx.beginPath();
            mp.forEach((p, i) => { if (i) ctx.lineTo(p[0] * W, p[1] * H); else ctx.moveTo(p[0] * W, p[1] * H); });
            if (mp.length >= 3) ctx.closePath();
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Handles of the current mode
        if (this.mode === 'blend') return;
        const pts = this._points();
        this._placeHud(pts[this.selected] || (this.drag ? null : pts[0]));
        ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        pts.forEach((p, i) => {
            const x = p[0] * W, y = p[1] * H;
            const sel = i === this.selected;
            ctx.beginPath();
            if (this.mode === 'keystone') ctx.arc(x, y, (sel ? 11 : 9) * dpr, 0, Math.PI * 2);
            else ctx.rect(x - (sel ? 6 : 4.5) * dpr, y - (sel ? 6 : 4.5) * dpr, (sel ? 12 : 9) * dpr, (sel ? 12 : 9) * dpr);
            ctx.fillStyle = sel ? '#ff5c2b' : 'rgba(20, 22, 28, 0.9)';
            ctx.fill();
            ctx.lineWidth = 2 * dpr;
            ctx.strokeStyle = sel ? '#ffffff' : (this.mode === 'mask' ? '#f5c84b' : '#ff5c2b');
            ctx.stroke();
            if (this.mode === 'keystone') {
                ctx.fillStyle = sel ? '#1a0b05' : '#eceef4';
                ctx.fillText(String(i + 1), x, y + 0.5 * dpr);
            }
        });
        if (this.mode === 'keystone' && pts[this.selected]) {
            const p = pts[this.selected];
            const label = `${Math.round(p[0] * this.canvas.width * 10) / 10}, ${Math.round(p[1] * this.canvas.height * 10) / 10} px`;
            const x = Math.min(Math.max(p[0] * W, 70 * dpr), W - 70 * dpr);
            const y = p[1] * H + (p[1] > 0.5 ? -26 : 26) * dpr;
            ctx.fillStyle = 'rgba(20, 22, 28, 0.85)';
            const tw = ctx.measureText(label).width + 12 * dpr;
            ctx.fillRect(x - tw / 2, y - 9 * dpr, tw, 18 * dpr);
            ctx.fillStyle = '#eceef4';
            ctx.fillText(label, x, y);
        }
    }
}
