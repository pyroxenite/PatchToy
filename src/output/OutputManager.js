import { clock } from '../core/Clock.js';
import { SourceRenderer, WarpPass, copyToCanvas } from './OutputRenderer.js';
import { RealtimeRecorder } from './Recorder.js';
import { OfflineExporter } from './OfflineExporter.js';
import { OutputWindow } from './OutputWindow.js';
import { RESOLUTIONS, evenSize } from './codecs.js';
import { normalizeCalibration } from './Calibration.js';
import { quality } from '../rendering/QualityGovernor.js';

const SETTINGS_KEY = 'patchtoy_output_settings';
const NOOP_RENDER = function () { /* editor paused (output performance mode) */ };

/**
 * Output toolkit hub (app.output): what to output (a Preview node), the frame
 * loop for recording, the output window, the editor suspension used by
 * performance mode and offline export, and per-project output data.
 *
 * Events (manager.on(fn)): fn(reason) with reason 'recording' | 'export' |
 * 'window' | 'settings' | 'source'.
 */
export class OutputManager {
    constructor(app) {
        this.app = app;
        this.listeners = new Set();
        this.recorder = null;
        this.exporter = null;
        this.window = null;
        this.lastResult = null;
        this.suspendReasons = new Set();
        this.suspended = null;
        this.projectOutput = { calibrations: {} };
        this.settings = {
            source: 'main', resolution: '1080p', width: 1920, height: 1080, fps: 30, bitrate: 0,
            format: 'webm', offlineFormat: 'mp4', mode: 'realtime', duration: 10, fromStart: true,
            audio: false, performanceMode: false, display: 'current'
        };
        this.loadSettings();
        this._loop = this._loop.bind(this);
        this.raf = null;
        this._installProjectHooks();
        window.addEventListener('pagehide', () => this.closeWindow());
        // Pick up Preview nodes created while the editor is suspended
        setInterval(() => { if (this.suspended) this._suspendRenderers(); }, 500);
    }

    // ------------------------------------------------------------------
    // Events / settings
    // ------------------------------------------------------------------

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    emit(reason) {
        for (const fn of this.listeners) {
            try { fn(reason, this); } catch (e) { console.warn('[output] listener failed', e); }
        }
    }

    loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
            if (s && typeof s === 'object') Object.assign(this.settings, s);
        } catch (e) { /* ignore */ }
    }

    setSettings(patch) {
        Object.assign(this.settings, patch);
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
        if ('performanceMode' in patch) this._syncPerformanceMode();
        this.emit('settings');
    }

    // ------------------------------------------------------------------
    // GPU resources (lazy: nothing is created until something is output)
    // ------------------------------------------------------------------

    get gl() { return this.app.sharedGL; }

    _gpu() {
        if (!this.gl) throw new Error('WebGL2 shared context unavailable');
        if (!this.sources) {
            this.sources = new Map();   // node id -> SourceRenderer
            this.warp = new WarpPass(this.gl);
        }
        return this;
    }

    _source(node) {
        this._gpu();
        const key = node ? node.id : 'none';
        let s = this.sources.get(key);
        if (!s) {
            s = new SourceRenderer(this.app);
            this.sources.set(key, s);
        }
        s.lastUsed = performance.now();
        return s;
    }

    _gcSources() {
        if (!this.sources) return;
        const now = performance.now();
        for (const [key, s] of this.sources) {
            if (now - s.lastUsed > 5000) { s.destroy(); this.sources.delete(key); } else s.gc();
        }
    }

    /**
     * Render `node` at w x h and copy it onto ctx2d (canvas of the same size),
     * through the warp when cal is given. Once per clock frame per size.
     * scale < 1 (output window, quality governor): the shader renders at scale x the
     * size and the warp pass upscales it (linear filtering). Recordings and exports
     * always render at scale 1, with Feedback auto-scale held at full size.
     */
    renderInto(node, w, h, ctx2d, cal = null, { stamp = clock.frame, scale = 1 } = {}) {
        const src = this._source(node);
        const busy = this.isBusy();
        if (busy) scale = 1;
        quality.holdFullQuality(this, busy);
        const sw = scale < 1 ? Math.max(2, Math.round(w * scale)) : w;
        const sh = scale < 1 ? Math.max(2, Math.round(h * scale)) : h;
        const tex = src.render(node, sw, sh, stamp);
        this.warp.draw(tex, w, h, w, h, cal);
        copyToCanvas(this.gl, ctx2d, w, h);
        // Render targets of sizes no longer used (window resized, scale changed, source switched)
        const now = performance.now();
        if (!this.recorder && now - (this._lastGc || 0) > 2000) { this._lastGc = now; this._gcSources(); }
    }

    // ------------------------------------------------------------------
    // Sources
    // ------------------------------------------------------------------

    previewNodes() {
        return (this.app.nodeGraph?.nodes || []).filter(n => n.isPreviewNode);
    }

    /** 'main' = the background preview, else the first Preview; or a node id. */
    resolveSource(ref = this.settings.source) {
        const nodes = this.previewNodes();
        if (ref !== undefined && ref !== null && ref !== 'main' && ref !== '') {
            const n = nodes.find(p => String(p.id) === String(ref));
            if (n) return n;
        }
        const bg = this.app.backgroundRenderer?.activePreviewNode;
        if (bg && nodes.includes(bg)) return bg;
        return nodes[0] || null;
    }

    sourceLabel(node) {
        if (!node) return 'No Preview node';
        const bg = this.app.backgroundRenderer?.activePreviewNode === node;
        return `Preview #${node.id}${bg ? ' (background)' : ''}`;
    }

    /** The source preview's own pixel size (background canvas for the background preview). */
    previewSize(node) {
        const br = this.app.backgroundRenderer;
        if (node && br && br.activePreviewNode === node && br.canvas.width > 16) return evenSize(br.canvas.width, br.canvas.height);
        const r = node && node.renderer;
        if (r && r.width) return evenSize(r.width, r.height);
        return [1280, 720];
    }

    resolveSize({ resolution = this.settings.resolution, width, height } = {}, node = null) {
        if (Number(width) > 0 && Number(height) > 0) return evenSize(width, height);
        if (resolution === 'preview') return this.previewSize(node);
        if (resolution === 'custom') return evenSize(this.settings.width, this.settings.height);
        const r = RESOLUTIONS.find(x => x.id === resolution);
        return r && r.w ? [r.w, r.h] : [1920, 1080];
    }

    // ------------------------------------------------------------------
    // Frame loop (recording; the output window has its own loop in its window)
    // ------------------------------------------------------------------

    _ensureLoop() {
        if (this.raf === null && this.recorder) this.raf = requestAnimationFrame(this._loop);
    }

    _loop(now) {
        this.raf = null;
        if (!this.recorder) return;
        this.raf = requestAnimationFrame(this._loop);
        try {
            this.recorder.tick(now);
        } catch (e) {
            console.warn('[output] recording frame failed', e);
        }
        if (now - (this._lastGc || 0) > 2000) { this._lastGc = now; this._gcSources(); }
    }

    /**
     * One app frame driven by the output window (it holds clock.setManual while
     * visible): the clock advances in real time and the app's per-frame work
     * (Param / JS / scene ticks, Feedback passes) runs once per output frame, in
     * sync with the projector's refresh. Also keeps the recorder fed while this
     * page is hidden (its own animation frames stop). Not during an offline export.
     */
    driveFrame() {
        if (this.exporter) return;
        const now = performance.now();
        clock.update(now);
        try { this.app.tickFrame?.(); } catch (e) { console.warn('[output] frame tick failed', e); }
        if (this.recorder && document.hidden) this.recorder.tick(now);
    }

    // ------------------------------------------------------------------
    // Recording
    // ------------------------------------------------------------------

    isBusy() { return !!(this.recorder || this.exporter); }

    filename(ext) {
        const pm = this.app.projectManager;
        const title = (pm && pm.projectTitle) || 'patchtoy';
        const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'patchtoy';
        const d = new Date();
        const p = (v) => String(v).padStart(2, '0');
        return `${slug}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
    }

    _options(opts = {}) {
        const s = this.settings;
        const node = this.resolveSource(opts.preview_id ?? opts.source ?? s.source);
        if (!node) throw new Error('No Preview node to record: add a Preview node first');
        const [width, height] = this.resolveSize({ resolution: opts.resolution ?? s.resolution, width: opts.width, height: opts.height }, node);
        const fps = Math.max(1, Math.min(120, Number(opts.fps) || s.fps || 30));
        return { node, width, height, fps, bitrate: Number(opts.bitrate) || s.bitrate || 0 };
    }

    /** Real-time recording. Returns status. */
    startRecording(opts = {}) {
        if (this.isBusy()) throw new Error(this.recorder ? 'Already recording' : 'An offline export is running');
        const o = this._options(opts);
        this._gpu();
        const rec = new RealtimeRecorder(this, { ...o, format: opts.format || this.settings.format, audio: opts.audio ?? this.settings.audio });
        rec.start();
        this.recorder = rec;
        this._ensureLoop();
        this.emit('recording');
        if (opts.duration > 0) {
            this._autoStop = setTimeout(() => {
                if (this.recorder === rec) this.stopRecording({ download: opts.download !== false }).catch(e => console.warn('[output] auto-stop failed', e));
            }, opts.duration * 1000);
        }
        return this.status();
    }

    /** Stop the real-time recording: resolves the result (blob + metadata) and downloads it by default. */
    async stopRecording({ download = true } = {}) {
        const rec = this.recorder;
        if (!rec) throw new Error('Not recording');
        clearTimeout(this._autoStop);
        let result;
        try {
            result = await rec.stop();
        } finally {
            this.recorder = null;
            this.emit('recording');
        }
        result.filename = this.filename(result.ext);
        result.mode = 'realtime';
        this.lastResult = result;
        if (download) this.download(result);
        this.emit('recording');
        if (this._waiters) { this._waiters.forEach(fn => fn(result)); this._waiters = null; }
        return result;
    }

    /** Resolves with the next finished real-time recording (auto-stop). */
    nextRecording() {
        return new Promise(resolve => { (this._waiters || (this._waiters = [])).push(resolve); });
    }

    /** Offline frame-by-frame export. Resolves the result (blob + metadata). */
    async exportOffline(opts = {}) {
        if (this.isBusy()) throw new Error(this.recorder ? 'Stop the recording first' : 'An export is already running');
        const o = this._options(opts);
        const format = opts.format || this.settings.offlineFormat || 'mp4';
        this._gpu();
        const ex = new OfflineExporter(this, {
            ...o, format,
            duration: Number(opts.duration) || this.settings.duration || 5,
            fromStart: opts.fromStart ?? opts.from_start ?? this.settings.fromStart,
            dirHandle: opts.dirHandle || null,
            seed: opts.seed ?? 1
        });
        this.exporter = ex;
        this.emit('export');
        let result;
        try {
            result = await ex.run(() => this.emit('export'));
        } finally {
            this.exporter = null;
            this.emit('export');
        }
        result.filename = result.ext ? this.filename(result.ext) : null;
        result.mode = 'offline';
        this.lastResult = result;
        if (opts.download !== false && result.blob) this.download(result);
        this.emit('export');
        return result;
    }

    cancelExport() {
        if (this.exporter) this.exporter.cancel();
    }

    download(result) {
        if (!result || !result.blob) return;
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    // ------------------------------------------------------------------
    // Output window
    // ------------------------------------------------------------------

    async openWindow(opts = {}) {
        const node = this.resolveSource(opts.preview_id ?? opts.source ?? this.settings.source);
        if (this.window && !this.window.closed) {
            this.window.setSource(node);
            if (opts.display !== undefined) await this.window.moveToDisplay(opts.display, opts);
            this.window.focus();
            return this.status();
        }
        this._gpu();
        const w = new OutputWindow(this, node);
        await w.open(opts);
        this.window = w;
        this._syncPerformanceMode();
        this.emit('window');
        return this.status();
    }

    closeWindow() {
        if (this.window) this.window.close();
    }

    /** Called by OutputWindow when its window closed (either side). */
    _windowClosed(w) {
        if (this.window !== w) return;
        this.window = null;
        this._syncPerformanceMode();
        this.emit('window');
    }

    setWindowSource(ref) {
        const node = this.resolveSource(ref);
        if (this.window) this.window.setSource(node);
        this.emit('source');
    }

    // ------------------------------------------------------------------
    // Performance mode / editor suspension
    // ------------------------------------------------------------------

    _syncPerformanceMode() {
        if (this.settings.performanceMode && this.window && !this.window.closed) this.suspendEditor('performance');
        else this.resumeEditor('performance');
    }

    get performanceActive() { return this.suspendReasons.has('performance'); }

    suspendEditor(reason) {
        this.suspendReasons.add(reason);
        this._applySuspension();
    }

    resumeEditor(reason) {
        this.suspendReasons.delete(reason);
        this._applySuspension();
    }

    _suspendRenderer(r) {
        if (!r || r.__ptOutputSaved) return;
        r.__ptOutputSaved = { own: Object.prototype.hasOwnProperty.call(r, 'render'), fn: r.render };
        r.render = NOOP_RENDER;
        this.suspended.renderers.add(r);
    }

    _suspendRenderers() {
        for (const n of this.previewNodes()) this._suspendRenderer(n.renderer);
        this._suspendRenderer(this.app.backgroundRenderer?.shaderPreview);
    }

    _applySuspension() {
        const want = this.suspendReasons.size > 0;
        const g = this.app.nodeGraph;
        if (want && !this.suspended) {
            this.suspended = { renderers: new Set(), graphRender: null };
            this._suspendRenderers();
            if (g) {
                this.suspended.graphRender = { own: Object.prototype.hasOwnProperty.call(g, 'render'), fn: g.render };
                g.render = NOOP_RENDER;
            }
            this._banner(true);
            this.emit('settings');
        } else if (!want && this.suspended) {
            for (const r of this.suspended.renderers) {
                const s = r.__ptOutputSaved;
                if (!s) continue;
                if (r.render === NOOP_RENDER) {
                    if (s.own) r.render = s.fn; else delete r.render;
                }
                delete r.__ptOutputSaved;
            }
            const gr = this.suspended.graphRender;
            if (g && gr) {
                if (g.render === NOOP_RENDER) {
                    if (gr.own) g.render = gr.fn; else delete g.render;
                } else if (g._originalRender === NOOP_RENDER) {
                    // the fullscreen preview swapped render meanwhile: restore through it
                    g._originalRender = gr.own ? gr.fn : Object.getPrototypeOf(g).render;
                }
            }
            this.suspended = null;
            this._banner(false);
            try { g?.render(); } catch (e) { /* ignore */ }
            this.emit('settings');
        } else if (want) {
            this._banner(true);
        }
    }

    _banner(show) {
        const container = document.getElementById('container');
        if (!container) return;
        let el = document.getElementById('outputPerfBanner');
        if (!show) { if (el) el.remove(); return; }
        const exporting = this.suspendReasons.has('export');
        const text = exporting
            ? 'Exporting frame by frame — the editor is paused until the export finishes'
            : 'Performance mode — the editor and other previews are paused while the output window is open';
        if (!el) {
            el = document.createElement('div');
            el.id = 'outputPerfBanner';
            el.className = 'op-banner';
            el.innerHTML = '<span class="op-banner-led"></span><span class="op-banner-text"></span><button class="pt-btn pt-btn--sm op-banner-btn" type="button">Resume editor</button>';
            el.querySelector('button').addEventListener('click', () => {
                if (this.suspendReasons.has('export')) this.cancelExport();
                else this.setSettings({ performanceMode: false });
            });
            container.appendChild(el);
        }
        el.querySelector('.op-banner-text').textContent = text;
        el.querySelector('button').textContent = exporting ? 'Cancel export' : 'Resume editor';
    }

    // ------------------------------------------------------------------
    // Project data: calibrations per display (graph data .output)
    // ------------------------------------------------------------------

    _installProjectHooks() {
        const g = this.app.nodeGraph;
        if (!g || g.__ptOutputHooks) return;
        g.__ptOutputHooks = true;
        const self = this;
        const ser = g.serialize;
        const des = g.deserialize;
        g.serialize = function (...args) {
            const data = ser.apply(this, args);
            const out = self.serializeProject();
            if (out && data && typeof data === 'object') data.output = out;
            return data;
        };
        g.deserialize = function (data, ...args) {
            self.loadProject(data && data.output);
            return des.call(this, data, ...args);
        };
    }

    serializeProject() {
        const cals = this.projectOutput.calibrations;
        if (!cals || !Object.keys(cals).length) return null;
        return { calibrations: cals };
    }

    loadProject(out) {
        const cals = {};
        if (out && out.calibrations && typeof out.calibrations === 'object') {
            for (const [k, v] of Object.entries(out.calibrations)) cals[k] = normalizeCalibration(v);
        }
        this.projectOutput = { calibrations: cals };
        if (this.window && !this.window.closed) this.window.reloadCalibration();
    }

    projectCalibration(key) {
        return this.projectOutput.calibrations[key] || null;
    }

    storeProjectCalibration(key, cal) {
        this.projectOutput.calibrations[key] = cal;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            // Project data, not the shader: mark dirty + save (and let undo / automation sync
            // see it) without the full recompile onGraphChanged would schedule
            const pm = this.app.projectManager;
            if (pm && pm.markDirty) pm.markDirty();
            const g = this.app.nodeGraph;
            if (g && g.onUniformValueChanged) g.onUniformValueChanged(null);
        }, 400);
    }

    // ------------------------------------------------------------------
    // Status
    // ------------------------------------------------------------------

    status() {
        const r = this.recorder;
        const w = this.window && !this.window.closed ? this.window : null;
        return {
            recording: r ? {
                mode: 'realtime', elapsed_s: +(r.elapsedMs / 1000).toFixed(2), bytes: r.bytes, frames: r.frames,
                width: r.width, height: r.height, fps: r.fps, mime: r.type?.mime, audio: r.audioInfo?.kind || null,
                source: r.node?.id ?? null
            } : null,
            export: this.exporter ? this.exporter.status() : null,
            window: w ? w.status() : null,
            performance_mode: { enabled: !!this.settings.performanceMode, active: this.performanceActive },
            editor_suspended: !!this.suspended,
            source: this.resolveSource()?.id ?? null
        };
    }
}
