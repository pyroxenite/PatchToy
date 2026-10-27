/**
 * AudioEngine - the single owner of PatchToy's AudioContext.
 *
 * Sources (one analysed at a time):
 *   'mic'       microphone (getUserMedia, no echo cancellation / noise suppression / AGC)
 *   'file'      an audio file or URL played through the speakers (<audio> element)
 *   'tab'       tab / system audio via getDisplayMedia (the video track is dropped)
 *   'metronome' no audio: the beat clock runs at a fixed BPM (src/core/Clock.js)
 *   'off'
 *
 * Analysis runs in an AudioWorklet (services/audio/beat-worklet.js): FFT bands,
 * kick onsets, tempo and a phase-locked beat. The worklet posts a small state
 * array ~94 times a second; once per frame the Clock calls update(), which turns
 * it into the values the shaders see (u_level, u_kick, beat target ...).
 *
 * Delay compensation: the worklet reports times on the signal timeline (its own
 * analysis delay removed). Here they are mapped to the moment the sound is
 * *heard*: AudioContext time -> performance time via getOutputTimestamp(), minus
 * the output path for sources we don't play ourselves (mic: also minus the input
 * latency, tab: minus a capture delay), plus the user's offset. The Clock adds
 * the display latency, so beats are drawn slightly ahead of time and land on
 * the audible beat. For files, band levels and kicks are also delayed to their
 * audible time (we see the samples before the speakers play them).
 *
 * The Microphone node meter uses the worklet's second input, so it works
 * whatever the analysed source is.
 *
 * Audio textures (services/AudioTextures.js): while a shader binds one,
 * wantTextures() asks the worklet to also post its FFT power spectrum and a
 * trigger-aligned waveform (a Float32Array right after each state message);
 * they are kept in a ring parallel to the state ring, so textureFrame() returns
 * the frame matching the band levels (the audible one for files). Posting stops
 * ~1.5 s after the last request.
 */
import { clock } from '../core/Clock.js';

// Message layout from the worklet (mirror of MSG in audio/beat-worklet.js)
const M = {
    TIME: 0, LEVEL: 1, BASS: 2, LOWMID: 3, MID: 4, HIGH: 5, KICK_TIME: 6, KICK_COUNT: 7,
    BPM: 8, CONFIDENCE: 9, BEAT_TIME: 10, PERIOD: 11, MIC_RMS: 12, INPUT_DB: 13, LOCKED: 14, ODF: 15,
    SIZE: 16
};
const RING = 48;                      // ~0.5 s of worklet messages (for delayed, audible-time reads)
const KICK_TAU_MS = 110;              // kick envelope decay
const TAB_CAPTURE_MS = 20;            // assumed tab-capture delay
const DEFAULT_INPUT_LATENCY_MS = 12;  // when the mic track doesn't report one
const STORAGE_KEY = 'patchtoy_audio_settings';
const TEXTURES_IDLE_MS = 1500;        // stop posting texture frames this long after the last use
const WORKLET_URL = new URL('./audio/beat-worklet.js', import.meta.url);

export const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba|webm|aif|aiff)$/i;

/** True if a dropped/picked File looks like audio. */
export function isAudioFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith('audio/')) return true;
    return AUDIO_EXTENSIONS.test(file.name || '');
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.node = null;
        this.sink = null;
        this._ctxPromise = null;
        this.inputNode = null;        // node connected to the analysis input

        this.source = 'off';
        this.error = null;

        this.mic = { stream: null, node: null, users: new Set(), latencyMs: DEFAULT_INPUT_LATENCY_MS, pending: null };
        this.file = { el: null, node: null, name: '', url: '', objectUrl: null, error: null };
        this.tab = { stream: null, node: null, label: '' };

        this.settings = { offsetMs: 0, metronomeBpm: 120, locked: false };
        this.loadSettings();

        // Per-frame outputs (read by the Clock)
        this.level = 0; this.bass = 0; this.lowMid = 0; this.mid = 0; this.high = 0; this.kick = 0;
        this.micRms = 0;
        this.inputDb = -120;
        this.bpm = 0;
        this.beatValid = false;
        this.beatRefMs = 0;
        this.beatPeriodMs = 500;
        this.beatConfidence = 0;
        this.trackerLocked = false;

        // Worklet message history
        this.ring = new Float64Array(RING * M.SIZE);
        this.ringHead = -1;
        this.ringCount = 0;
        this.lastMsgAt = 0;
        this.frameIdx = -1;               // ring entry the current band levels come from

        // Audio texture frames (parallel to the ring; posted only while wanted)
        this.texFrames = new Array(RING).fill(null);
        this.texOn = false;
        this.texWantedAt = -1e9;

        // Kick placement
        this.kickCount = 0;
        this.kickPending = false;
        this.kickSignalTime = 0;
        this.kickStartMs = -1e9;
        this.prevKickStartMs = -1e9;

        // AudioContext time -> performance time (when a context sample is heard)
        this.ctxToPerfMs = 0;
        this.mapValid = false;
        this.outLatMs = 0;
        this.nextMapAt = 0;

        this.listeners = new Set();
        clock.audio = this;
        clock.offsetMs = this.settings.offsetMs;
        clock.metroBpm = this.settings.metronomeBpm;
    }

    // ------------------------------------------------------------------
    // Settings / events
    // ------------------------------------------------------------------

    loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (s && typeof s === 'object') {
                if (Number.isFinite(s.offsetMs)) this.settings.offsetMs = clamp(s.offsetMs, -200, 200);
                if (s.metronomeBpm > 0) this.settings.metronomeBpm = clamp(s.metronomeBpm, 20, 400);
            }
        } catch (e) { /* ignore */ }
    }

    saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                offsetMs: this.settings.offsetMs,
                metronomeBpm: this.settings.metronomeBpm
            }));
        } catch (e) { /* ignore */ }
    }

    /** Subscribe to state changes ('source', 'file', 'state', 'error', 'tempo'...). */
    onChange(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit(reason) {
        for (const fn of this.listeners) {
            try { fn(reason, this); } catch (e) { console.warn('[audio] listener failed', e); }
        }
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('patchtoy:audio', { detail: { reason, source: this.source } }));
        }
    }

    // ------------------------------------------------------------------
    // AudioContext + worklet
    // ------------------------------------------------------------------

    /**
     * Resume a suspended context (no-op when there is none yet or it runs). Never hangs:
     * without user activation resume() may stay pending, so wait at most timeoutMs.
     */
    async resumeContext(timeoutMs = 1500) {
        const ctx = this.ctx;
        if (!ctx || ctx.state !== 'suspended') return;
        let timer = null;
        await Promise.race([
            ctx.resume().catch(() => { /* needs a user gesture */ }),
            new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
        ]);
        clearTimeout(timer);
    }

    async ensureContext() {
        if (this.ctx && this.node) {
            if (this.ctx.state === 'suspended') {
                try { await this.ctx.resume(); } catch (e) { /* needs a user gesture */ }
            }
            return this.ctx;
        }
        if (!this._ctxPromise) {
            this._ctxPromise = (async () => {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) throw new Error('Web Audio is not supported in this browser');
                const ctx = new Ctx({ latencyHint: 'interactive' });
                let node;
                try {
                    if (!ctx.audioWorklet) throw new Error('AudioWorklet is not supported in this browser');
                    await ctx.audioWorklet.addModule(WORKLET_URL);
                    node = new AudioWorkletNode(ctx, 'patchtoy-analysis', {
                        numberOfInputs: 2,
                        numberOfOutputs: 1,
                        outputChannelCount: [1]
                    });
                } catch (e) {
                    // The next attempt creates a new context: don't leave this one open
                    // (browsers limit how many can exist)
                    try { ctx.close().catch(() => { }); } catch (err) { /* ignore */ }
                    throw e;
                }
                const sink = ctx.createGain();
                sink.gain.value = 0;
                node.connect(sink).connect(ctx.destination); // keeps the worklet pulled
                node.port.onmessage = (e) => this.onMessage(e.data);
                ctx.onstatechange = () => this.emit('state');
                this.ctx = ctx;
                this.node = node;
                this.sink = sink;
                if (ctx.state === 'suspended') {
                    try { await ctx.resume(); } catch (e) { /* resumed on the next gesture */ }
                }
                return ctx;
            })();
        }
        try {
            return await this._ctxPromise;
        } catch (e) {
            this._ctxPromise = null;
            throw e;
        }
    }

    /** Analysis is running on a real audio source. */
    isLive() {
        return (this.source === 'mic' || this.source === 'file' || this.source === 'tab') &&
            !!this.node && this.ctx && this.ctx.state === 'running';
    }

    onMessage(data) {
        if (data instanceof Float32Array) {
            // audio texture frame of the state message just received
            if (this.texOn && this.ringHead >= 0) this.texFrames[this.ringHead] = data;
            return;
        }
        if (data && data.length === 1) {
            // mic meter level alone: the analysis has no source yet (beat-worklet.js)
            this.micRms = data[0];
            return;
        }
        if (!data || data.length < M.SIZE) return;
        this.ringHead = (this.ringHead + 1) % RING;
        this.ring.set(data, this.ringHead * M.SIZE);
        this.texFrames[this.ringHead] = null;
        if (this.ringCount < RING) this.ringCount++;
        this.lastMsgAt = performance.now();
        this.micRms = data[M.MIC_RMS];
        const kc = data[M.KICK_COUNT];
        if (kc !== this.kickCount) {
            this.kickCount = kc;
            this.kickSignalTime = data[M.KICK_TIME];
            this.kickPending = true;
        }
    }

    send(cmd) {
        if (this.node) this.node.port.postMessage(cmd);
    }

    // ------------------------------------------------------------------
    // Latency mapping
    // ------------------------------------------------------------------

    refreshMapping(now) {
        const ctx = this.ctx;
        if (!ctx) return;
        this.outLatMs = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
        let map;
        const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
        if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
            map = ts.performanceTime - ts.contextTime * 1000;
        } else {
            map = now - ctx.currentTime * 1000 + this.outLatMs;
        }
        if (!this.mapValid || Math.abs(map - this.ctxToPerfMs) > 200) {
            this.ctxToPerfMs = map;
            this.mapValid = true;
        } else {
            this.ctxToPerfMs += (map - this.ctxToPerfMs) * 0.2;
        }
    }

    /** Source-specific shift (ms) from "our output plays it" to "the listener hears it". */
    sourceShiftMs() {
        if (this.source === 'mic') return -(this.outLatMs + this.mic.latencyMs);
        if (this.source === 'tab') return -TAB_CAPTURE_MS;
        return 0;
    }

    /** Performance time (ms) at which a signal time (s) of the analysed source is heard. */
    audibleMs(signalTime) {
        return signalTime * 1000 + this.ctxToPerfMs + this.sourceShiftMs();
    }

    /** Inverse of audibleMs (no user offset). */
    signalTime(audibleMs) {
        return (audibleMs - this.ctxToPerfMs - this.sourceShiftMs()) / 1000;
    }

    // ------------------------------------------------------------------
    // Per-frame update (called by the Clock while isLive())
    // ------------------------------------------------------------------

    update(now, clk) {
        if (now >= this.nextMapAt) {
            this.nextMapAt = now + 250;
            this.refreshMapping(now);
        }
        if (this.ringCount === 0) return;

        const offset = this.settings.offsetMs;
        const display = now + 1.5 * clk.frameMs - offset;
        const R = this.ring;

        // Levels: for files the analysis runs ahead of the speakers, so read the
        // message that is audible at display time; live inputs use the newest one.
        let idx = this.ringHead;
        if (this.source === 'file') {
            for (let k = 0; k < this.ringCount; k++) {
                const i = (this.ringHead - k + RING) % RING;
                idx = i;
                if (this.audibleMs(R[i * M.SIZE + M.TIME]) <= display) break;
            }
        }
        const o = idx * M.SIZE;
        this.frameIdx = idx;
        if (this.texOn && now - this.texWantedAt > TEXTURES_IDLE_MS) this.setTexturePosting(false);
        this.level = R[o + M.LEVEL];
        this.bass = R[o + M.BASS];
        this.lowMid = R[o + M.LOWMID];
        this.mid = R[o + M.MID];
        this.high = R[o + M.HIGH];

        // Kick: jumps to 1 when detected (or when audible, for files), then decays
        if (this.kickPending) {
            this.kickPending = false;
            const audible = this.audibleMs(this.kickSignalTime) + offset;
            this.prevKickStartMs = this.kickStartMs;
            this.kickStartMs = Math.max(now, audible - 1.5 * clk.frameMs);
        }
        const start = now >= this.kickStartMs ? this.kickStartMs : this.prevKickStartMs;
        this.kick = Math.exp(-Math.max(0, now - start) / KICK_TAU_MS);

        // Beat: newest tracker state
        const n = this.ringHead * M.SIZE;
        this.inputDb = R[n + M.INPUT_DB];
        this.bpm = R[n + M.BPM];
        this.trackerLocked = R[n + M.LOCKED] > 0;
        const beatTime = R[n + M.BEAT_TIME];
        this.beatValid = this.bpm > 0 && beatTime >= 0 && now - this.lastMsgAt < 500;
        if (this.beatValid) {
            this.beatRefMs = this.audibleMs(beatTime) + offset;
            this.beatPeriodMs = R[n + M.PERIOD] * 1000;
            this.beatConfidence = R[n + M.CONFIDENCE];
        } else {
            this.beatConfidence = 0;
        }
    }

    // ------------------------------------------------------------------
    // Inputs
    // ------------------------------------------------------------------

    attachInput(src) {
        if (this.inputNode === src) return;
        this.detachInput();
        if (src && this.node) {
            src.connect(this.node, 0, 0);
            this.inputNode = src;
        }
        this.send({ type: 'reset' });
        if (this.settings.locked) this.send({ type: 'tempo', bpm: clock.u.bpm, beatTime: null, lock: true });
        this.resetOutputs();
    }

    detachInput() {
        if (this.inputNode && this.node) {
            try { this.inputNode.disconnect(this.node, 0, 0); } catch (e) { /* not connected */ }
        }
        this.inputNode = null;
    }

    async openMic() {
        if (this.mic.stream && this.mic.stream.active && this.mic.node) return;
        if (this.mic.pending) return this.mic.pending;
        this.mic.pending = (async () => {
            await this.ensureContext();
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Microphone access is not available (needs https or localhost)');
            }
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
            });
            const track = stream.getAudioTracks()[0];
            const s = track && track.getSettings ? track.getSettings() : {};
            this.mic.latencyMs = Number.isFinite(s.latency) && s.latency > 0 ? s.latency * 1000 : DEFAULT_INPUT_LATENCY_MS;
            if (track) track.addEventListener('ended', () => this.onMicEnded());
            this.mic.stream = stream;
            this.mic.node = this.ctx.createMediaStreamSource(stream);
            this.mic.node.connect(this.node, 0, 1); // Microphone node meter input
        })();
        try {
            await this.mic.pending;
        } finally {
            this.mic.pending = null;
        }
    }

    closeMicIfUnused() {
        if (this.source === 'mic' || this.mic.users.size > 0 || !this.mic.stream) return;
        if (this.inputNode === this.mic.node) this.detachInput();
        try { this.mic.node.disconnect(); } catch (e) { /* ignore */ }
        this.mic.stream.getTracks().forEach(t => t.stop());
        this.mic.stream = null;
        this.mic.node = null;
        this.micRms = 0;
    }

    onMicEnded() {
        this.mic.stream = null;
        this.mic.node = null;
        this.micRms = 0;
        for (const user of this.mic.users) {
            if (user && typeof user.onMicLost === 'function') user.onMicLost();
        }
        this.mic.users.clear();
        if (this.source === 'mic') this.setSource('off');
        this.emit('source');
    }

    /** Microphone node meters: keeps the mic open while any node uses it. */
    async acquireMicMeter(user) {
        await this.openMic();
        this.mic.users.add(user);
        // With nothing else analysed, the mic also drives the global audio uniforms
        if (this.source === 'off') {
            await this.setSource('mic');
            this.mic.autoSource = true; // picked for the meter, not by the user (undone on release)
        }
        this.emit('source');
    }

    releaseMicMeter(user) {
        this.mic.users.delete(user);
        // The last meter went away and the mic only became the source for it: back to Off,
        // so the stream (and the browser's recording indicator) can close
        if (this.mic.users.size === 0 && this.mic.autoSource && this.source === 'mic') {
            this.mic.autoSource = false;
            this.setSource('off').catch(() => { });
            return;
        }
        this.closeMicIfUnused();
        this.maybeSuspend();
        this.emit('source');
    }

    /** Suspend the AudioContext when nothing needs it (no analysis CPU while idle). */
    maybeSuspend() {
        const ctx = this.ctx;
        if (!ctx || ctx.state !== 'running') return;
        if (this.isLive() || this.mic.users.size > 0 || this.isPlaying()) return;
        ctx.suspend().catch(() => {});
    }

    async openTab() {
        if (this.tab.stream && this.tab.stream.active && this.tab.node) return;
        await this.ensureContext();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            throw new Error('Tab audio capture is not supported in this browser (use Chrome)');
        }
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            systemAudio: 'include',
            selfBrowserSurface: 'exclude'
        });
        const audioTracks = stream.getAudioTracks();
        stream.getVideoTracks().forEach(t => t.stop()); // keep only the audio
        if (!audioTracks.length) {
            throw new Error('No audio was shared. Pick a tab and turn on "Share tab audio".');
        }
        const audioStream = new MediaStream(audioTracks);
        audioTracks[0].addEventListener('ended', () => {
            this.tab.stream = null;
            this.tab.node = null;
            if (this.source === 'tab') this.setSource('off');
        });
        this.tab.stream = audioStream;
        this.tab.label = audioTracks[0].label || 'Tab audio';
        this.tab.node = this.ctx.createMediaStreamSource(audioStream);
    }

    closeTab() {
        if (!this.tab.stream) return;
        if (this.inputNode === this.tab.node) this.detachInput();
        this.tab.stream.getTracks().forEach(t => t.stop());
        this.tab.stream = null;
        this.tab.node = null;
    }

    ensureFileElement() {
        const f = this.file;
        if (f.el) return f;
        const el = new Audio();
        el.crossOrigin = 'anonymous';
        el.preload = 'auto';
        el.loop = true;
        for (const ev of ['play', 'pause', 'ended', 'loadedmetadata', 'seeked']) {
            el.addEventListener(ev, () => this.emit('file'));
        }
        el.addEventListener('error', () => {
            const code = el.error && el.error.code;
            f.error = code === 4 ? 'Unsupported audio or blocked by CORS' : 'Could not load the audio';
            this.emit('error');
        });
        f.el = el;
        f.node = this.ctx.createMediaElementSource(el);
        f.node.connect(this.ctx.destination);
        return f;
    }

    /**
     * Load an audio File/Blob or URL and (by default) play it as the analysed source.
     */
    async loadFile(fileOrUrl, { play = true, name = null, loop = null } = {}) {
        await this.ensureContext();
        const f = this.ensureFileElement();
        f.error = null;
        if (f.objectUrl) {
            URL.revokeObjectURL(f.objectUrl);
            f.objectUrl = null;
        }
        if (typeof Blob !== 'undefined' && fileOrUrl instanceof Blob) {
            f.objectUrl = URL.createObjectURL(fileOrUrl);
            f.url = '';
            f.name = name || fileOrUrl.name || 'Audio file';
            f.el.src = f.objectUrl;
        } else {
            const url = String(fileOrUrl || '').trim();
            if (!url) throw new Error('No audio file or URL given');
            f.url = url;
            f.name = name || decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || 'Audio');
            f.el.src = url;
        }
        if (loop !== null) f.el.loop = !!loop;
        await this.setSource('file', { play: false });
        if (play) await this.play();
        this.emit('file');
    }

    hasFile() {
        return !!(this.file.el && (this.file.objectUrl || this.file.url));
    }

    async play() {
        if (!this.hasFile()) return false;
        await this.ensureContext();
        if (this.source !== 'file') await this.setSource('file', { play: false });
        try {
            await this.file.el.play();
            return true;
        } catch (e) {
            this.file.error = e && e.name === 'NotAllowedError' ? 'Click play to start audio' : (e.message || 'Playback failed');
            this.emit('error');
            return false;
        }
    }

    pause() {
        if (this.file.el && !this.file.el.paused) this.file.el.pause();
        if (this.source !== 'file') this.maybeSuspend();
    }

    async togglePlay() {
        if (this.isPlaying()) this.pause();
        else await this.play();
    }

    isPlaying() {
        return !!(this.file.el && !this.file.el.paused && !this.file.el.ended);
    }

    seek(seconds) {
        const el = this.file.el;
        if (!el || !Number.isFinite(el.duration)) return;
        el.currentTime = clamp(Number(seconds) || 0, 0, el.duration);
    }

    setLoop(loop) {
        if (this.file.el) this.file.el.loop = !!loop;
        this.emit('file');
    }

    // ------------------------------------------------------------------
    // Source selection
    // ------------------------------------------------------------------

    /**
     * Switch the analysed source: 'off' | 'mic' | 'file' | 'tab' | 'metronome'.
     * opts: { bpm } for the metronome, { play } for files.
     */
    async setSource(kind, opts = {}) {
        this.error = null;
        this.mic.autoSource = false; // an explicit choice (acquireMicMeter sets it again after its own call)
        try {
            if (kind === 'metronome' || kind === 'off') {
                this.detachInput();
                this.pause();
                this.closeTab();
                this.source = kind;
                if (kind === 'metronome') {
                    const bpm = opts.bpm > 0 ? clamp(Number(opts.bpm), 20, 400) : this.settings.metronomeBpm;
                    this.settings.metronomeBpm = bpm;
                    this.saveSettings();
                    clock.setMode('metronome', { bpm });
                } else {
                    clock.setMode('free');
                }
                this.closeMicIfUnused();
                this.resetOutputs();
                this.maybeSuspend();
                this.emit('source');
                return;
            }
            // Live sources need a running context: after Metro / Off the context was suspended
            // (maybeSuspend), and an input attached to a suspended context is silent.
            // resume() is called synchronously here, inside the click that picked the source.
            await this.resumeContext();
            if (kind === 'mic') {
                await this.openMic();
                if (this.source === 'file') this.pause();
                this.closeTab();
                this.attachInput(this.mic.node);
            } else if (kind === 'file') {
                if (!this.hasFile()) throw new Error('Load an audio file first');
                this.closeTab();
                this.attachInput(this.file.node);
                if (opts.play) {
                    try {
                        await this.file.el.play();
                        this.file.error = null;
                    } catch (e) {
                        this.file.error = e && e.name === 'NotAllowedError' ? 'Click play to start audio' : (e && e.message) || 'Playback failed';
                    }
                }
            } else if (kind === 'tab') {
                await this.openTab();
                if (this.source === 'file') this.pause();
                this.attachInput(this.tab.node);
            } else {
                throw new Error(`Unknown audio source "${kind}"`);
            }
            this.source = kind;
            clock.setMode('free');
            this.closeMicIfUnused();
            this.emit('source');
        } catch (e) {
            this.error = e && e.name === 'NotAllowedError' ? 'Permission denied' : (e && e.message) || String(e);
            this.emit('error');
            throw e;
        }
    }

    resetOutputs() {
        this.level = this.bass = this.lowMid = this.mid = this.high = this.kick = 0;
        if (this.texOn) this.setTexturePosting(false); // re-requested by the next frame that binds a texture
        this.texFrames.fill(null);
        this.frameIdx = -1;
        this.beatValid = false;
        this.beatConfidence = 0;
        this.bpm = 0;
        this.ringCount = 0;
    }

    // ------------------------------------------------------------------
    // Audio texture frames
    // ------------------------------------------------------------------

    /** A shader uses an audio texture this frame: keep the worklet posting spectra. */
    wantTextures(now = performance.now()) {
        this.texWantedAt = now;
        if (!this.texOn) this.setTexturePosting(true);
    }

    setTexturePosting(on) {
        this.texOn = !!on;
        if (!on) this.texFrames.fill(null);
        this.send({ type: 'textures', on: this.texOn });
    }

    /**
     * Latest texture frame (Float32Array: [bins, waveLength, power[bins], wave[waveLength]])
     * matching the current band levels, or the newest one; null if none yet.
     */
    textureFrame() {
        if (this.ringCount === 0) return null;
        if (this.frameIdx >= 0 && this.texFrames[this.frameIdx]) return this.texFrames[this.frameIdx];
        for (let k = 0; k < this.ringCount; k++) {
            const f = this.texFrames[(this.ringHead - k + RING) % RING];
            if (f) return f;
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Tempo controls
    // ------------------------------------------------------------------

    /** Tap tempo (also sets the downbeat on the first tap of a sequence). */
    tap() {
        const now = performance.now();
        const r = clock.tap(now);
        if (r.bpm) {
            if (this.source === 'metronome') {
                this.settings.metronomeBpm = r.bpm;
                this.saveSettings();
            }
            if (this.isLive()) {
                // The tap marks an audible beat: give the tracker this tempo and phase
                const beatTime = this.signalTime(now - this.settings.offsetMs);
                this.send({ type: 'tempo', bpm: r.bpm, beatTime, lock: this.settings.locked });
            }
        }
        this.emit('tempo');
        return r;
    }

    /** Manual BPM. With an audio source this also locks the tempo (the phase keeps tracking). */
    setBpm(bpm) {
        bpm = Number(bpm);
        if (!(bpm > 0)) return;
        bpm = clamp(bpm, 20, 400);
        clock.setBpm(bpm);
        if (this.source === 'metronome' || !this.isLive()) {
            this.settings.metronomeBpm = bpm;
            this.saveSettings();
        }
        if (this.isLive()) {
            this.settings.locked = true;
            this.send({ type: 'tempo', bpm, beatTime: null, lock: true });
        }
        this.emit('tempo');
    }

    /** Lock / unlock the detected tempo (phase still follows the music). */
    setLocked(locked) {
        this.settings.locked = !!locked;
        if (locked && this.bpm > 0) this.send({ type: 'tempo', bpm: this.bpm, beatTime: null, lock: true });
        else this.send({ type: 'lock', lock: !!locked });
        this.emit('tempo');
    }

    /** User audio/visual offset in ms (-200..200, positive = visuals later). Saved. */
    setOffset(ms) {
        this.settings.offsetMs = clamp(Math.round(Number(ms) || 0), -200, 200);
        clock.offsetMs = this.settings.offsetMs;
        this.saveSettings();
        this.emit('offset');
    }

    // ------------------------------------------------------------------
    // Status
    // ------------------------------------------------------------------

    sourceLabel() {
        switch (this.source) {
            case 'mic': return 'Mic';
            case 'tab': return 'Tab audio';
            case 'file': return this.file.name || 'Audio file';
            case 'metronome': return 'Metronome';
            default: return 'No audio';
        }
    }

    status() {
        const el = this.file.el;
        const u = clock.u;
        const r3 = v => +(+v || 0).toFixed(3);
        return {
            source: this.source,
            label: this.sourceLabel(),
            context: this.ctx ? this.ctx.state : 'none',
            error: this.error || this.file.error || null,
            bpm: r3(u.bpm),
            detected_bpm: this.bpm > 0 ? r3(this.bpm) : null,
            confidence: r3(u.confidence),
            following_audio: clock.following,
            locked: this.settings.locked,
            metronome_bpm: this.settings.metronomeBpm,
            offset_ms: this.settings.offsetMs,
            paused: clock.paused,
            beat: { count: u.beatCount, phase: Math.floor(u.beatPhase * 1000) / 1000, bar_phase: Math.floor(u.barPhase * 1000) / 1000, pulse: r3(u.beat), beat_time: r3(u.beatTime) },
            levels: { level: r3(u.level), bass: r3(u.bass), low_mid: r3(u.lowMid), mid: r3(u.mid), high: r3(u.high), kick: r3(u.kick) },
            input_db: this.isLive() ? +this.inputDb.toFixed(1) : null,
            mic_meter_users: this.mic.users.size,
            latency_ms: this.ctx ? { output: +this.outLatMs.toFixed(1), input: this.source === 'mic' ? +this.mic.latencyMs.toFixed(1) : 0 } : null,
            file: el && this.hasFile() ? {
                name: this.file.name,
                url: this.file.url || null,
                playing: this.isPlaying(),
                loop: el.loop,
                position: r3(el.currentTime),
                duration: Number.isFinite(el.duration) ? r3(el.duration) : null
            } : null
        };
    }
}

export const audioEngine = new AudioEngine();
if (typeof window !== 'undefined') window.__patchtoyAudio = audioEngine;
