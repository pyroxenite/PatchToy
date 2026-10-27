import { injectIconSprite } from './icons.js';
import { UIHelpers } from './UIHelpers.js';
import { LibraryPanel } from './LibraryPanel.js';
import { midiService } from '../services/MIDIService.js';
import { midiMapper } from '../services/MidiMapper.js';
import { AudioPanel } from './AudioPanel.js';
import { ParamsPanel } from './ParamsPanel.js';
import { audioEngine } from '../services/AudioEngine.js';
import { OutputPanel } from '../output/OutputPanel.js';
import { HelpCenter } from './help/HelpCenter.js';

const LIBRARY_OPEN_KEY = 'patchtoy_ui_library_open';

function isTypingTarget(app) {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return true;
    if (a && a.closest && a.closest('.monaco-editor')) return true;
    if (app && app.nodeGraph && app.nodeGraph.focusedTextInput) return true;
    return false;
}

/**
 * Wires the DOM shell (top bar, library sidebar, status bar) to the app.
 *
 * Window events consumed:
 *   'patchtoy:bridge-status' { connected, clientName? }  -> MCP pill
 *   'patchtoy:activity'      { message }                 -> status bar activity
 *   'patchtoy:compile'       { ok, errors, ms, previews } -> compile pill (from CompilationManager)
 */
export class AppShell {
    constructor(app) {
        this.app = app;
        this.appEl = document.getElementById('app');
        this.container = document.getElementById('container');

        injectIconSprite();
        UIHelpers.initTooltips();

        this.compileState = { ok: true, errors: [], ms: null, previews: 0, seen: false };
        this.bridge = { connected: false, clientName: null };
        this.fps = 0;

        this.library = new LibraryPanel(app);
        this.audioPanel = new AudioPanel(app);
        this.params = new ParamsPanel(app);
        // Record / offline export / output window (app.output)
        this.output = new OutputPanel(app);
        // Tour, node help (F1 / right-click → Help), shortcut sheet (?), Help menu (app.help)
        this.help = new HelpCenter(app);

        this.setupSidebar();
        this.setupTopBar();
        this.setupStatusBar();
        this.setupBridgeEvents();
        this.setupShortcuts();
        this.setupResize();
        this.startSync();
    }

    /* ---------------- Sidebar ---------------- */

    setupSidebar() {
        const btn = document.getElementById('sidebarToggleBtn');
        let open = true;
        try {
            const saved = localStorage.getItem(LIBRARY_OPEN_KEY);
            if (saved !== null) open = saved === '1';
        } catch (e) { /* ignore */ }
        this.setLibraryOpen(open, { persist: false });
        btn.addEventListener('click', () => this.toggleLibrary());
    }

    isLibraryOpen() {
        return !this.appEl.classList.contains('is-library-collapsed');
    }

    setLibraryOpen(open, { persist = true } = {}) {
        this.appEl.classList.toggle('is-library-collapsed', !open);
        const btn = document.getElementById('sidebarToggleBtn');
        btn.classList.toggle('is-active', open);
        btn.setAttribute('aria-pressed', String(open));
        btn.setAttribute('data-tip', open ? 'Hide library' : 'Show library');
        UIHelpers.refreshTooltip(btn);
        if (!open) this.library.hideCard();
        if (persist) {
            try { localStorage.setItem(LIBRARY_OPEN_KEY, open ? '1' : '0'); } catch (e) { /* ignore */ }
        }
    }

    toggleLibrary() {
        this.setLibraryOpen(!this.isLibraryOpen());
    }

    /* ---------------- Top bar ---------------- */

    setupTopBar() {
        document.getElementById('compileStatusBtn').addEventListener('click', () => {
            this.app.compilationManager.toggleConsole?.();
        });
        this.renderCompileState();
    }

    setCompileState(detail) {
        this.compileState = { ...this.compileState, ...detail, seen: true };
        this.renderCompileState();
    }

    renderCompileState() {
        const pill = document.getElementById('compileStatusBtn');
        const label = pill.querySelector('.tb-pill-label');
        const sb = document.getElementById('sbCompile');
        const sbText = sb.querySelector('.sb-compile-text');
        const s = this.compileState;
        const paused = this.app.compilationManager && this.app.compilationManager.autoCompile === false;
        const errorCount = s.ok ? 0 : Math.max(1, s.errorCount || (s.errors ? s.errors.length : 1));

        pill.classList.remove('is-ok', 'is-error', 'is-paused', 'is-idle');
        sb.classList.remove('is-ok', 'is-error');

        let pillText;
        let sbLabel;
        if (!s.ok) {
            pill.classList.add('is-error');
            sb.classList.add('is-error');
            pillText = `${errorCount} error${errorCount === 1 ? '' : 's'}`;
            sbLabel = `Shader error${errorCount === 1 ? '' : 's'}`;
        } else if (paused) {
            pill.classList.add('is-paused');
            pillText = 'Paused';
            sbLabel = 'Auto-compile paused';
        } else if (s.compiling) {
            // Async compile: new programs link in parallel, the previews keep the previous ones
            pill.classList.add('is-ok');
            sb.classList.add('is-ok');
            pillText = 'Compiling…';
            sbLabel = 'Compiling…';
        } else if (!s.previews) {
            pill.classList.add('is-idle');
            pillText = 'No output';
            sbLabel = 'Connect a Preview node';
        } else {
            pill.classList.add('is-ok');
            sb.classList.add('is-ok');
            pillText = 'Compiled';
            sbLabel = s.ms != null ? `Compiled in ${s.ms < 10 ? s.ms.toFixed(1) : Math.round(s.ms)} ms` : 'Compiled';
        }
        if (label.textContent !== pillText) label.textContent = pillText;
        if (sbText.textContent !== sbLabel) sbText.textContent = sbLabel;
        const tip = s.ok ? 'Show shader console' : 'Show shader errors';
        if (pill.getAttribute('data-tip') !== tip) pill.setAttribute('data-tip', tip);
    }

    /* ---------------- Status bar ---------------- */

    setupStatusBar() {
        document.getElementById('sbZoom').addEventListener('click', () => this.resetZoom());
        document.getElementById('sbCompile').addEventListener('click', () => {
            this.app.compilationManager.toggleConsole?.();
        });

        // FPS meter
        let frames = 0;
        let last = performance.now();
        const tick = (now) => {
            frames++;
            if (now - last >= 1000) {
                this.fps = Math.round((frames * 1000) / (now - last));
                frames = 0;
                last = now;
                const el = document.getElementById('sbFps');
                if (el) el.textContent = `${this.fps} fps`;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    resetZoom() {
        const g = this.app.nodeGraph;
        const rect = g.canvas.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const wx = (cx - g.panX) / g.zoom;
        const wy = (cy - g.panY) / g.zoom;
        g.zoom = 1;
        g.panX = cx - wx;
        g.panY = cy - wy;
        g.render();
    }

    /** Show a short message in the status bar (also used for MCP activity). */
    activity(message, { local = false } = {}) {
        const el = document.getElementById('sbActivity');
        if (!el || !message) return;
        el.querySelector('.sb-activity-text').textContent = message;
        el.classList.toggle('is-local', local);
        el.classList.add('is-visible');
        clearTimeout(this._activityTimer);
        this._activityTimer = setTimeout(() => el.classList.remove('is-visible'), local ? 2200 : 4500);
    }

    /* ---------------- MCP bridge ---------------- */

    setupBridgeEvents() {
        window.addEventListener('patchtoy:bridge-status', (e) => {
            const d = e.detail || {};
            const was = this.bridge.connected;
            this.bridge = { connected: !!d.connected, clientName: d.clientName || null };
            this.renderBridge();
            if (this.bridge.connected && !was) {
                this.activity(`${this.bridge.clientName || 'MCP client'} connected`);
            } else if (!this.bridge.connected && was) {
                this.activity('MCP bridge disconnected', { local: true });
            }
        });

        window.addEventListener('patchtoy:activity', (e) => {
            const msg = e.detail && e.detail.message;
            if (!msg) return;
            this.activity(msg);
            const pill = document.getElementById('mcpStatus');
            pill.classList.remove('is-pulse');
            void pill.offsetWidth;
            pill.classList.add('is-pulse');
        });

        window.addEventListener('patchtoy:compile', (e) => {
            this.setCompileState({ compiling: false, ...(e.detail || {}) });
        });
        window.addEventListener('patchtoy:compiling', () => {
            this.setCompileState({ compiling: true });
        });

        this.renderBridge();
    }

    renderBridge() {
        const pill = document.getElementById('mcpStatus');
        if (!pill) return;
        pill.classList.toggle('is-connected', this.bridge.connected);
        const tip = this.bridge.connected
            ? `MCP bridge connected${this.bridge.clientName ? ` · ${this.bridge.clientName}` : ''}`
            : 'MCP bridge: not connected';
        pill.setAttribute('data-tip', tip);
        UIHelpers.refreshTooltip(pill);
    }

    /* ---------------- Keyboard shortcuts ---------------- */

    setupShortcuts() {
        // Cmd/Ctrl+O: the Open panel on My projects; Shift+Cmd/Ctrl+O: import a project file.
        // Capture phase, so it also works with the project browser focused (its dialog keeps
        // keys from bubbling). The browser's own "open file" never runs; while typing, or with
        // another dialog open, nothing else happens either.
        window.addEventListener('keydown', (e) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'o') return;
            e.preventDefault();
            if (e.repeat || isTypingTarget(this.app)) return;
            const browser = this.app.projectBrowser;
            const host = browser?.isOpen() ? browser.modal.backdrop : null;
            if ([...document.querySelectorAll('.pt-modal-backdrop')].some(el => el !== host)) return;
            if (e.shiftKey) {
                if (browser?.isOpen()) browser.close({ reason: 'opened' });
                document.getElementById('loadFileInput')?.click();
            } else if (browser) {
                browser.open({ view: 'mine', presentation: browser.isOpen() ? null : 'popover' });
            }
        }, true);

        window.addEventListener('keydown', (e) => {
            // Cmd/Ctrl+S: save (works even while typing)
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
                e.preventDefault();
                this.app.saveProject?.();
                return;
            }
            if (e.metaKey) return;
            if (isTypingTarget(this.app)) return;
            if (this.app.nodeGraph && this.app.nodeGraph.connectingFrom) return;

            // Backslash may need AltGr / Option on some layouts, so don't reject modifiers here
            if (e.key === '\\') {
                e.preventDefault();
                this.toggleLibrary();
            } else if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                e.preventDefault();
                this.params.toggle();
            } else if (e.key === '/' && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                if (!this.isLibraryOpen()) this.setLibraryOpen(true);
                // wait for the width transition to start so focus scrolls correctly
                requestAnimationFrame(() => this.library.focusSearch());
            }
        });
    }

    /* ---------------- Canvas sizing ---------------- */

    setupResize() {
        if (!('ResizeObserver' in window)) return;
        let raf = null;
        let lastLeft = this.container.getBoundingClientRect().left;
        const ro = new ResizeObserver(() => {
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = null;
                // Keep nodes visually anchored when the canvas origin moves (sidebar toggle)
                const left = this.container.getBoundingClientRect().left;
                const g = this.app.nodeGraph;
                if (g && left !== lastLeft) g.panX -= (left - lastLeft);
                lastLeft = left;
                this.app.resize();
            });
        });
        ro.observe(this.container);
    }

    /* ---------------- Periodic state sync ---------------- */

    startSync() {
        this.syncNow();
        this._syncTimer = setInterval(() => this.syncNow(), 250);
        this._libTimer = setInterval(() => this.library.refresh(), 1000);
    }

    syncNow() {
        const app = this.app;
        const g = app.nodeGraph;
        if (!g) return;

        // Counts + zoom
        const nodes = g.nodes.length;
        const links = g.connections.length;
        this.setText('sbNodes', `<strong>${nodes}</strong> node${nodes === 1 ? '' : 's'}`, `${nodes}/${links}`);
        this.setText('sbLinks', `<strong>${links}</strong> link${links === 1 ? '' : 's'}`, `${links}`);
        const zoomEl = document.getElementById('sbZoom');
        const zoomText = `${Math.round((g.zoom || 1) * 100)}%`;
        if (zoomEl.textContent !== zoomText) zoomEl.textContent = zoomText;

        // Empty state
        const empty = document.getElementById('emptyState');
        if (empty) empty.classList.toggle('is-visible', nodes === 0 && !g.quickNodeSearch?.ghostNode);

        // Window title follows the project name
        const pm = app.projectManager;
        // Routes with their own title (project browser, user pages, shared projects): CommunityManager
        const title = app.community?.documentTitle?.() || (pm && pm.projectTitle && pm.projectTitle !== 'Untitled Project'
            ? `${pm.projectTitle} · PatchToy`
            : 'PatchToy — Node-based GLSL shader playground');
        if (document.title !== title) document.title = title;

        // Dirty indicator
        const dirty = !!(pm && pm.projectState && pm.projectState.isDirty && nodes > 0);
        document.getElementById('projectDirtyDot').classList.toggle('is-dirty', dirty);
        const saveBtn = document.getElementById('saveCloudBtn');
        if (saveBtn) saveBtn.classList.toggle('is-dirty', dirty);
        const projBtn = document.getElementById('projectMenuBtn');
        const projTip = dirty ? 'Project · unsaved changes' : 'Project';
        if (projBtn.getAttribute('data-tip') !== projTip) projBtn.setAttribute('data-tip', projTip);

        // Play state
        const playBtn = document.getElementById('playStopBtn');
        const playing = app.isPlaying !== false;
        playBtn.classList.toggle('is-active', playing);
        playBtn.classList.toggle('is-paused', !playing);
        playBtn.setAttribute('aria-pressed', String(playing));
        const playTip = playing ? 'Live — time running, auto-compile on' : 'Paused — time frozen, changes are not compiled';
        if (playBtn.getAttribute('data-tip') !== playTip) {
            playBtn.setAttribute('data-tip', playTip);
            UIHelpers.refreshTooltip(playBtn);
        }
        playBtn.removeAttribute('title');

        // Devices
        this.syncDevice('cameraBtn', g.nodes.filter(n => n.isCameraNode), 'Camera');
        this.syncMic(g.nodes.filter(n => n.isMicrophoneNode));
        const midiNodes = g.nodes.filter(n => n.isMidiCCNode);
        const midiBtn = document.getElementById('midiBtn');
        const midiOn = !!midiService.isEnabled;
        let midiState = midiOn ? 'on' : (midiBtn.classList.contains('is-error') ? 'error' : 'off');
        UIHelpers.setDeviceButtonState(midiBtn, {
            state: midiState,
            available: midiNodes.length > 0 || midiOn || midiMapper.mappedNodes().length > 0, // + MIDI-mapped params
            tip: midiOn ? 'MIDI on' : (midiState === 'error' ? (midiBtn.getAttribute('data-tip') || 'MIDI error') : 'Enable MIDI')
        });

        // Compile pill (paused state depends on autoCompile)
        this.renderCompileState();
    }

    /** The mic feeds the global audio uniforms (AudioEngine) and any Microphone nodes. */
    syncMic(nodes) {
        const btn = document.getElementById('micBtn');
        if (!btn) return;
        const on = !!audioEngine.mic.stream || nodes.some(n => n.isActive);
        const error = !on && btn.classList.contains('is-error');
        const tip = on
            ? (audioEngine.source === 'mic' ? 'Microphone live — drives audio & beat uniforms (click to stop)' : 'Microphone live (click to stop)')
            : error ? (btn.getAttribute('data-tip') || 'Microphone error') : 'Listen with the microphone (audio & beat uniforms)';
        UIHelpers.setDeviceButtonState(btn, { state: on ? 'on' : error ? 'error' : 'off', available: true, tip });
    }

    syncDevice(id, nodes, label) {
        const btn = document.getElementById(id);
        if (!btn) return;
        const on = nodes.some(n => n.isActive);
        let state = on ? 'on' : (btn.classList.contains('is-error') && nodes.length ? 'error' : 'off');
        let tip;
        if (on) tip = `${label} live`;
        else if (state === 'error') tip = btn.getAttribute('data-tip') || `${label} error`;
        else if (!nodes.length) tip = `${label} — add a ${label} node to use`;
        else tip = `Enable ${label.toLowerCase()}`;
        UIHelpers.setDeviceButtonState(btn, { state, available: nodes.length > 0, tip });
    }

    setText(id, html, key) {
        const el = document.getElementById(id);
        if (!el || el.dataset.key === key) return;
        el.dataset.key = key;
        el.innerHTML = html;
    }
}
