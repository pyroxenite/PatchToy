/**
 * Render quality: dynamic resolution for the large outputs.
 *
 * Modes (persisted in localStorage 'patchtoy_render_quality', default 'auto'):
 *   high         every output at full resolution (scale 1)
 *   auto         the governor lowers the render scale of the background / fullscreen
 *                preview and of the output window to hold the target frame rate, never
 *                below 0.5
 *   balanced     scale 0.75 at most, 0.5 at least
 *   performance  scale 0.5 at most, down to 0.25
 *
 * Governed outputs render at scale x their size and are upscaled with linear filtering.
 * Node preview thumbnails are never scaled; recordings and offline exports always render
 * at full quality. Feedback nodes with data.autoScale = true size their buffers relative
 * to the largest output being shown, times that output's render scale (so the governor
 * scales them too), never above data.width / height. They follow a governor step only once
 * it is kept (not while it is being judged), with hysteresis (QualitySettings.feedbackScale).
 *
 * Governor (one per output window: 'background' for the editor page's background and
 * fullscreen previews, 'output' for the output window):
 *   - frame interval = rAF delta of the window it governs, averaged over the last
 *     20 - 60 frames;
 *     target = 60 fps, or the display refresh when that is lower;
 *   - display refresh (RefreshEstimator) is NOT inferred from the frames being governed
 *     (a patch where every frame misses vsync runs at 30 fps on a 60 Hz display and would
 *     read as a 30 Hz display, so Auto never scaled down exactly when it should):
 *       - idle probes: a short rAF burst at startup, when the tab regains focus / becomes
 *         visible and when the window moves to another screen. Snapped to common rates
 *         (60 / 75 / 90 / 120 / 144 ... and 24 / 30 / 50 for slow displays);
 *       - a probe can always raise the estimate, but lowers it only when no governed output
 *         was rendering during it (and is cached only once two such probes agree);
 *       - while governing, the minimum stable interval over a long window (240 frames)
 *         can raise the estimate too (never lower it);
 *       - cached per screen (window.screen size and devicePixelRatio) in localStorage
 *         'patchtoy_display_hz'; unknown = 60 Hz;
 *   - frame intervals at whole multiples (>= 2) of the vsync with no gain from one step
 *     down: the step may simply not fit the frame into fewer vsyncs yet, so the governor
 *     keeps stepping down to the mode's floor before judging (and undoing) the descent;
 *   - over budget (avg > 1.2 x target interval over >= 45 frames): one level down;
 *     if a step down did not shorten the frame by >= 6 % the bottleneck is elsewhere
 *     (CPU, Feedback passes...): the step is undone and the governor waits 8 s before
 *     trying again (doubling each time it is still no use, up to 2 min);
 *   - comfortably on target for `upHold` (1.5 s): one level up; if that level is over
 *     budget again it steps back and that level's upHold doubles (up to 30 s), so a
 *     scene on the edge settles instead of oscillating. A level that held for 10 s
 *     resets its upHold.
 */

export const QUALITY_MODES = {
    auto: { label: 'Auto', max: 1, min: 0.5, governed: true, hint: 'Lowers the background, fullscreen and output-window resolution to hold the frame rate (down to 50 %)' },
    high: { label: 'High', max: 1, min: 1, governed: false, hint: 'Always full resolution' },
    balanced: { label: 'Balanced', max: 0.75, min: 0.5, governed: true, hint: '75 % resolution, lower when needed (down to 50 %)' },
    performance: { label: 'Performance', max: 0.5, min: 0.25, governed: true, hint: '50 % resolution, lower when needed (down to 25 %)' },
};
export const QUALITY_KEYS = ['auto', 'high', 'balanced', 'performance'];

// Discrete render scales (fewer render-target sizes, no churn)
export const SCALE_LEVELS = [1, 0.85, 0.75, 0.67, 0.5, 0.4, 0.33, 0.25];
// Feedback auto-scale steps (rounded up: never below what the output needs)
const FEEDBACK_LEVELS = [0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

const STORAGE_KEY = 'patchtoy_render_quality';
const WINDOW = 60;            // samples kept (~1 s at 60 fps)
const MIN_SAMPLES = 20;       // enough to see "over budget" / "on target"
const JUDGE_SAMPLES = 45;     // a step down is taken / judged on this many (frame times are noisy)
const OVER = 1.2;             // over budget: avg interval > 1.2 x target
const COMFORT = 1.08;         // on target: avg interval < 1.08 x target
const COOLDOWN_MS = 600;
const UP_HOLD_MS = 1500;
const UP_HOLD_MAX_MS = 30000;
const STABLE_MS = 10000;
const INEFFECTIVE_GAIN = 0.94; // a step down must reach < 94 % of the previous interval
const INEFFECTIVE_WAIT_MS = 8000;

// ---------------------------------------------------------------- display refresh

/** Refresh rates displays actually run at; estimates snap to the nearest within 5 %. */
export const COMMON_HZ = [24, 25, 30, 48, 50, 60, 72, 75, 85, 90, 100, 120, 144, 165, 170, 180, 200, 240];
const HZ_STORAGE_KEY = 'patchtoy_display_hz';
const PROBE_FRAMES = 40;
const PROBE_MAX_MS = 1500;
const OBSERVE_WINDOW = 240;
const BUSY_MS = 300;             // a governed output rendered this recently: the probe is not idle
const STARTUP_PROBES_MS = [400, 2000, 5000, 12000]; // retried until one is stable

/** Nearest common refresh rate (within 5 %), else the rounded rate; null for nonsense. */
export function snapHz(hz) {
    if (!(hz > 0) || !isFinite(hz)) return null;
    let best = null, err = Infinity;
    for (const c of COMMON_HZ) {
        const e = Math.abs(hz - c) / c;
        if (e < err) { err = e; best = c; }
    }
    return err <= 0.05 ? best : Math.round(hz);
}

/**
 * The cluster of intervals within +-7 % of `ref` (the median, or a low percentile):
 * {hz, share} where share = fraction of the intervals in it. null without data.
 */
export function intervalCluster(intervals, ref = 'median') {
    const v = Array.from(intervals).filter(x => x > 2 && x < 250).sort((a, b) => a - b);
    if (v.length < 10) return null;
    const pivot = ref === 'median' ? v[Math.floor(v.length / 2)] : v[Math.floor(v.length * 0.1)];
    let sum = 0, n = 0;
    for (const x of v) if (Math.abs(x - pivot) <= pivot * 0.07) { sum += x; n++; }
    if (!n) return null;
    return { hz: snapHz(1000 / (sum / n)), share: n / v.length, n: v.length };
}

function screenKeyOf(win) {
    try {
        const s = win.screen;
        return `${s.width}x${s.height}@${+(win.devicePixelRatio || 1).toFixed(2)}`;
    } catch (e) { return 'unknown'; }
}

function readHzCache() {
    try { return JSON.parse(localStorage.getItem(HZ_STORAGE_KEY) || '{}') || {}; } catch (e) { return {}; }
}

function writeHzCache(key, hz) {
    try {
        const c = readHzCache();
        c[key] = { hz, at: Date.now() };
        // Keep the 8 most recent screens
        const keys = Object.keys(c).sort((a, b) => (c[b].at || 0) - (c[a].at || 0));
        for (const k of keys.slice(8)) delete c[k];
        localStorage.setItem(HZ_STORAGE_KEY, JSON.stringify(c));
    } catch (e) { /* ignore */ }
}

/**
 * Display refresh of one window (see the file comment). hz null = unknown (60 assumed).
 * isBusy(): whether a governed output rendered in the last BUSY_MS (main-window clock).
 */
export class RefreshEstimator {
    constructor(isBusy = () => false) {
        this.isBusy = isBusy;
        this.hz = null;
        this.source = 'assumed';
        this.key = null;
        this.win = null;
        this.buf = new Float32Array(OBSERVE_WINDOW);
        this.n = 0;
        this.head = 0;
        this.pendingLow = null;   // a lower idle reading waiting for a second one before it is cached
        this.probing = null;
        this.lastProbe = null;    // diagnostics
        this._lastScreenCheck = 0;
        this._startupTimers = [];
    }

    /** Frame interval (ms) of the display: 1000 / 60 while unknown. */
    get ms() { return 1000 / (this.hz || 60); }

    /** Probe and follow this window (startup, focus, visibility, screen changes). */
    attach(win) {
        if (!win || win === this.win) return;
        this.win = win;
        this._useScreen(screenKeyOf(win));
        const again = () => { if (this.win === win && !win.closed && !win.document.hidden) this.probe('focus'); };
        try {
            win.addEventListener('focus', again);
            win.document.addEventListener('visibilitychange', again);
        } catch (e) { /* ignore */ }
        for (const t of this._startupTimers) clearTimeout(t);
        this._startupTimers = [];
        let done = false;
        for (const ms of STARTUP_PROBES_MS) {
            this._startupTimers.push(setTimeout(() => {
                if (done || this.win !== win) return;
                this.probe('startup').then(r => { if (r && r.stable) done = true; });
            }, ms));
        }
    }

    _useScreen(key) {
        if (key === this.key) return;
        this.key = key;
        this.pendingLow = null;
        this.n = 0; this.head = 0;
        const c = readHzCache()[key];
        if (c && c.hz > 0) { this.hz = c.hz; this.source = 'cache'; } else { this.hz = null; this.source = 'assumed'; }
    }

    _set(hz, source, cache) {
        this.hz = hz;
        this.source = source;
        if (cache && this.key) writeHzCache(this.key, hz);
    }

    /** One interval of a governed frame: can only raise the estimate (minimum stable interval). */
    observe(dt) {
        const t = performance.now();
        if (this.win && t - this._lastScreenCheck > 1000) {
            this._lastScreenCheck = t;
            const key = screenKeyOf(this.win);
            if (key !== this.key) { this._useScreen(key); this.probe('screen'); }
        }
        if (!(dt > 2) || dt > 250) return;
        this.buf[this.head] = dt;
        this.head = (this.head + 1) % OBSERVE_WINDOW;
        if (this.n < OBSERVE_WINDOW) this.n++;
        if (this.head !== 0 || this.n < OBSERVE_WINDOW) return;
        // A real rate at least 15 % of the frames reached: the display is at least that fast
        const c = intervalCluster(this.buf, 'low');
        if (c && c.hz && c.share >= 0.15 && c.hz > (this.hz || 60) * 1.04) this._set(c.hz, 'observed', true);
    }

    /** Short rAF burst in the window. Resolves {stable, hz, busy, applied} (or null). */
    probe(reason = 'manual') {
        const win = this.win;
        if (!win || win.closed) return Promise.resolve(null);
        try { if (win.document.hidden) return Promise.resolve(null); } catch (e) { return Promise.resolve(null); }
        if (this.probing) return this.probing;
        this.probing = new Promise((resolve) => {
            const stamps = [];
            let busy = this.isBusy();
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                clearTimeout(guard);
                this.probing = null;
                resolve(this._onProbe(stamps, busy || this.isBusy(), reason));
            };
            const guard = setTimeout(finish, PROBE_MAX_MS + 500); // hidden mid-probe: rAF stops
            const step = (now) => {
                stamps.push(now);
                if (this.isBusy()) busy = true;
                if (stamps.length < PROBE_FRAMES + 3 && now - stamps[0] < PROBE_MAX_MS && !win.closed) win.requestAnimationFrame(step);
                else finish();
            };
            try { win.requestAnimationFrame(step); } catch (e) { finish(); }
        });
        return this.probing;
    }

    _onProbe(stamps, busy, reason) {
        const d = [];
        for (let i = 3; i < stamps.length; i++) d.push(stamps[i] - stamps[i - 1]); // first frames: still settling
        const c = intervalCluster(d, 'median');
        const stable = !!(c && c.hz && c.share >= 0.6);
        const res = { reason, stable, hz: c ? c.hz : null, share: c ? +c.share.toFixed(2) : 0, busy, applied: false };
        if (stable) {
            const cur = this.hz;
            if (cur === null || c.hz > cur) {
                // Faster than we thought: always believable. Slower than the assumed 60 only when idle.
                if (cur !== null || !busy || c.hz >= 60) { this._set(c.hz, 'probe', !busy || c.hz >= 60); res.applied = true; }
            } else if (c.hz < cur && !busy) {
                // Slower, measured with nothing heavy rendering: use it; cache once confirmed
                const confirmed = this.pendingLow === c.hz;
                this.pendingLow = c.hz;
                this._set(c.hz, 'probe', confirmed);
                res.applied = true;
            } else if (c.hz === cur && !busy && this.source !== 'cache') {
                this._set(c.hz, 'probe', true);
            }
        }
        this.lastProbe = res;
        return res;
    }

    status() {
        return { hz: this.hz || 60, source: this.source, screen: this.key, last_probe: this.lastProbe };
    }
}

function levelIndex(scale) {
    let best = 0;
    for (let i = 0; i < SCALE_LEVELS.length; i++) {
        if (Math.abs(SCALE_LEVELS[i] - scale) < Math.abs(SCALE_LEVELS[best] - scale)) best = i;
    }
    return best;
}

export class ScaleGovernor {
    constructor(name, settings) {
        this.name = name;
        this.settings = settings;
        this.samples = new Float32Array(WINDOW);
        this.count = 0;
        this.head = 0;
        // Display refresh of the governed window (busy = any governed output rendering)
        this.refresh = new RefreshEstimator(() => settings.anyGovernorBusy ? settings.anyGovernorBusy() : this._busy());
        this.level = 0;           // index into SCALE_LEVELS
        this.lastChange = 0;
        this.comfortSince = 0;
        this.levelSince = 0;
        this.upHold = new Float64Array(SCALE_LEVELS.length).fill(UP_HOLD_MS);
        this.pendingUp = -1;      // level we just probed up from
        this.pendingDown = null;  // { from, avg } of the last step down (effectiveness check)
        this.blockDownUntil = 0;
        this.ineffectiveWait = INEFFECTIVE_WAIT_MS;
        this.active = false;
        this.holdUntil = 0;       // no decisions before this (shaders just changed: first frames are slow)
        this.lastSampleAt = 0;
        this.lastSampleWall = -1e9; // performance.now() of this module's window (sample() times may be another window's clock)
        this.avgMs = 0;
        this.history = [];        // recent decisions (diagnostics)
        this.applyMode();
    }

    get scale() {
        return SCALE_LEVELS[this.level];
    }

    /** Display frame interval (ms) of the governed window. */
    get refreshMs() {
        return this.refresh.ms;
    }

    _busy() {
        return performance.now() - this.lastSampleWall < BUSY_MS;
    }

    /** Frame intervals are a whole number (>= 2) of vsyncs: one more step may not show yet. */
    _vsyncBound(avg) {
        const k = avg / this.refreshMs;
        return k >= 1.7 && Math.abs(k - Math.round(k)) < 0.15;
    }

    get bounds() {
        const m = QUALITY_MODES[this.settings.mode] || QUALITY_MODES.auto;
        return { hi: levelIndex(m.max), lo: levelIndex(m.min), governed: m.governed };
    }

    /** Mode changed: start from the mode's top level. */
    applyMode() {
        const { hi } = this.bounds;
        this.level = hi;
        this.resetWindow();
        this.upHold.fill(UP_HOLD_MS);
        this.blockDownUntil = 0;
        this.ineffectiveWait = INEFFECTIVE_WAIT_MS;
        this.pendingUp = -1;
        this.pendingDown = null;
    }

    resetWindow() {
        this.count = 0;
        this.head = 0;
        this.comfortSince = 0;
    }

    targetMs() {
        const t = this.settings.targetFps;
        if (t > 0) return 1000 / t;
        // 60 fps, or the display refresh when it is slower (50 Hz projector, 30 Hz capture)
        return Math.max(1000 / 60, this.refreshMs);
    }

    _log(what, now) {
        this.history.push({ t: Math.round(now), what, scale: this.scale, avg_ms: +this.avgMs.toFixed(1) });
        if (this.history.length > 20) this.history.shift();
        this.settings.emit('scale', this);
    }

    _setLevel(i, now, why) {
        if (i === this.level) return;
        this.level = i;
        this.lastChange = now;
        this.levelSince = now;
        this.resetWindow();
        this._log(why, now);
    }

    /**
     * One frame of the governed window. dt = interval since its previous frame (ms).
     * Only call while the governed output is being shown. win: the window it renders in
     * (default: this page), whose display refresh is estimated by idle probes.
     */
    sample(dt, now, win) {
        this.active = true;
        this.lastSampleAt = now;
        this.lastSampleWall = performance.now();
        if (win && win !== this.refresh.win) this.refresh.attach(win);
        if (!(dt > 0) || dt > 250) { this.resetWindow(); return; } // first frame, hidden tab, breakpoint
        // Display refresh: may only rise from governed frames (idle probes set it otherwise)
        this.refresh.observe(dt);

        // Just (re)shown or recompiled: pipelines are being created, frame times mean nothing yet
        if (!this.wasActive || now < this.holdUntil) {
            if (!this.wasActive) this.holdUntil = Math.max(this.holdUntil, now + 1000);
            this.wasActive = true;
            this.resetWindow();
            if (now < this.holdUntil) return;
        }
        const { hi, lo, governed } = this.bounds;
        if (!governed) { if (this.level !== hi) this._setLevel(hi, now, 'mode'); return; }
        if (this.level < hi) { this._setLevel(hi, now, 'mode'); return; }
        if (this.level > lo) { this._setLevel(lo, now, 'mode'); return; }

        this.samples[this.head] = dt;
        this.head = (this.head + 1) % WINDOW;
        if (this.count < WINDOW) this.count++;
        if (this.count < MIN_SAMPLES) return;
        let sum = 0;
        for (let i = 0; i < this.count; i++) sum += this.samples[i];
        const avg = sum / this.count;
        this.avgMs = avg;
        const target = this.targetMs();
        const over = avg > target * OVER;
        const comfortable = avg < target * COMFORT;

        // Did the last step down help? (judged on a long window)
        if (this.pendingDown && this.count >= JUDGE_SAMPLES) {
            const pd = this.pendingDown;
            this.pendingDown = null;
            if (over && avg > pd.avg * INEFFECTIVE_GAIN) {
                // Whole vsyncs per frame: the smaller frame may still miss the same vsync, so
                // keep descending (judged against where the descent started) down to the floor
                if (this.level < lo && this._vsyncBound(avg)) {
                    this.pendingDown = pd;
                    this._setLevel(this.level + 1, now, 'down (vsync-bound)');
                    return;
                }
                // Scaling this output is not what limits the frame rate: undo, wait
                this.blockDownUntil = now + this.ineffectiveWait;
                this.ineffectiveWait = Math.min(120000, this.ineffectiveWait * 2);
                this._setLevel(pd.from, now, 'undo (no gain)');
                return;
            }
        }
        // Did the last step up hold?
        if (this.pendingUp >= 0) {
            const from = this.pendingUp;
            if (over) {
                this.pendingUp = -1;
                this.ineffectiveWait = INEFFECTIVE_WAIT_MS;
                this.upHold[from] = Math.min(UP_HOLD_MAX_MS, this.upHold[from] * 2);
                this._setLevel(from, now, 'back down');
                return;
            }
            if (now - this.levelSince > 2000) this.pendingUp = -1;
        }
        if (now - this.levelSince > STABLE_MS) this.upHold[this.level] = UP_HOLD_MS;

        if (over) {
            this.comfortSince = 0;
            if (this.level < lo && this.count >= JUDGE_SAMPLES && !this.pendingDown && now - this.lastChange > COOLDOWN_MS && now >= this.blockDownUntil) {
                this.pendingDown = { from: this.level, avg };
                this._setLevel(this.level + 1, now, 'down');
            }
            return;
        }
        if (comfortable && this.level > hi) {
            if (!this.comfortSince) this.comfortSince = now;
            const hold = this.upHold[this.level - 1];
            if (now - this.comfortSince > hold && now - this.lastChange > COOLDOWN_MS) {
                this.pendingUp = this.level;
                this._setLevel(this.level - 1, now, 'up');
            }
        } else {
            this.comfortSince = 0;
        }
    }

    /** The governed output is not shown this frame. */
    idle() {
        this.active = false;
        this.wasActive = false;
        if (this.count) this.resetWindow();
    }

    status() {
        return {
            scale: this.scale,
            active: this.active,
            avg_ms: +this.avgMs.toFixed(2),
            target_fps: +(1000 / this.targetMs()).toFixed(1),
            display_hz: +(1000 / this.refreshMs).toFixed(1),
            display_hz_source: this.refresh.source,
            history: this.history.slice(-6),
        };
    }
}

class QualitySettings {
    constructor() {
        this.mode = 'auto';
        this.targetFps = 0; // 0 = 60, or the display refresh when slower
        this.listeners = new Set();
        try {
            const m = localStorage.getItem(STORAGE_KEY);
            if (m && QUALITY_MODES[m]) this.mode = m;
        } catch (e) { /* ignore */ }
        this.governors = {
            background: new ScaleGovernor('background', this),
            output: new ScaleGovernor('output', this),
        };
        // The editor page's display: probed from startup (the output window attaches its own
        // window on its first sample)
        if (typeof window !== 'undefined') this.governors.background.refresh.attach(window);
        // Largest output size shown recently (device pixels, after scaling), for Feedback auto-scale
        this.outputs = new Map(); // kind -> { w, h, at }
        this.fullQualityHolds = new Set(); // recording / export: Feedback at full size
        // A compile swaps programs: the next frames create pipelines (slow), don't judge them
        if (typeof window !== 'undefined') {
            window.addEventListener('patchtoy:compile', () => this.hold(1500));
        }
    }

    /** Any governed output rendered in the last BUSY_MS (a refresh probe would not be idle). */
    anyGovernorBusy() {
        return Object.values(this.governors).some(g => g._busy());
    }

    /** Make no scale decisions for the next `ms` (e.g. after a compile). */
    hold(ms) {
        const until = performance.now() + ms;
        for (const g of Object.values(this.governors)) {
            g.holdUntil = Math.max(g.holdUntil, until);
            g.resetWindow();
        }
    }

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    emit(reason, detail) {
        for (const fn of this.listeners) {
            try { fn(reason, detail, this); } catch (e) { console.warn('[quality] listener failed', e); }
        }
    }

    setMode(mode) {
        if (!QUALITY_MODES[mode] || mode === this.mode) return;
        this.mode = mode;
        try { localStorage.setItem(STORAGE_KEY, mode); } catch (e) { /* ignore */ }
        for (const g of Object.values(this.governors)) g.applyMode();
        this.emit('mode');
    }

    get governed() { return QUALITY_MODES[this.mode].governed; }

    scaleOf(name) {
        const g = this.governors[name];
        return g ? g.scale : 1;
    }

    /** An output showed a frame: w x h device pixels at full quality, rendered at `scale`. */
    noteOutput(kind, w, h, scale = 1, now = performance.now()) {
        let o = this.outputs.get(kind);
        if (!o) { o = { w: 0, h: 0, scale: 1, at: 0 }; this.outputs.set(kind, o); }
        o.w = w; o.h = h; o.scale = scale; o.at = now;
    }

    holdFullQuality(owner, on) {
        if (on) this.fullQualityHolds.add(owner); else this.fullQualityHolds.delete(owner);
    }

    /** Outputs shown in the last 0.5 s ([{kind, w, h, scale}]). */
    recentOutputs(now = performance.now()) {
        const out = [];
        for (const [kind, o] of this.outputs) if (now - o.at <= 500) out.push({ kind, w: o.w, h: o.h, scale: o.scale });
        return out;
    }

    /**
     * Buffer scale a W x H Feedback target needs: for each output shown, its size relative
     * to the buffer (capped at 1: the buffer is never larger than data.width / height) times
     * that output's render scale; the largest wins. null when nothing was shown yet.
     */
    feedbackNeed(W, H, now = performance.now()) {
        let f = -1;
        for (const o of this.outputs.values()) {
            if (now - o.at > 500) continue;
            const rel = Math.min(1, Math.max(o.w / W, o.h / H)) * (o.scale || 1);
            if (rel > f) f = rel;
        }
        return f < 0 ? null : f;
    }

    /** A governor is judging a step it just took (it may undo it): see feedbackScale. */
    governorJudging() {
        for (const g of Object.values(this.governors)) {
            if (g._busy() && (g.pendingDown || g.pendingUp >= 0)) return true;
        }
        return false;
    }

    /**
     * Buffer scale for a Feedback node (1 unless data.autoScale is set). Rounded up to
     * a few steps, changed after it has been wanted for a while (no realloc churn):
     *   - a smaller level has to be wanted for 1 s, a larger one for 0.2 s (a need that
     *     flickers across a level edge does not reallocate);
     *   - with no output shown the size stays as it is;
     *   - nothing changes while a governor judges a step it just took: a step it undoes
     *     ("no gain", "back down") never reallocates the buffers twice.
     */
    feedbackScale(node, now = performance.now()) {
        const d = node.data || {};
        if (!d.autoScale) return 1;
        const cur = node._autoScale || 1;
        // Nothing shown right now (preview scrolled off screen...): keep the current size
        // rather than growing to full size until something is shown again
        let want = this.fullQualityHolds.size ? 1 : cur;
        if (!this.fullQualityHolds.size) {
            const W = Math.max(1, Number(d.width) || 512), H = Math.max(1, Number(d.height) || 512);
            const f = this.feedbackNeed(W, H, now);
            if (f !== null) want = FEEDBACK_LEVELS.find(l => l >= f - 1e-6) || 1;
        }
        if (want === cur || (!this.fullQualityHolds.size && this.governorJudging())) { node._autoScaleWant = null; return cur; }
        if (node._autoScaleWant !== want) { node._autoScaleWant = want; node._autoScaleSince = now; }
        const wait = want > cur ? 200 : 1000;
        if (now - node._autoScaleSince >= wait || this.fullQualityHolds.size) {
            node._autoScale = want;
            node._autoScaleWant = null;
            this.emit('feedback', node);
        }
        return node._autoScale || 1;
    }

    status() {
        return {
            mode: this.mode,
            background: this.governors.background.scale,
            output: this.governors.output.scale,
            governors: Object.fromEntries(Object.entries(this.governors).map(([k, g]) => [k, g.status()])),
            outputs: this.recentOutputs(),
            full_quality_holds: [...this.fullQualityHolds].map(String),
        };
    }
}

export const quality = new QualitySettings();
