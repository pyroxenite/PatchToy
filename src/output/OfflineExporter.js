import { clock } from '../core/Clock.js';
import { resetSimulation, settleSwitchers, pendingJSSetup, clearFeedbackBuffers } from '../core/simulation.js';
import { pickEncoderConfig, autoBitrate } from './codecs.js';
import { WebMMuxer, MP4Muxer, ZipWriter } from './muxers.js';
import { ShaderPreview } from '../rendering/ShaderPreview.js';

/**
 * Offline ("perfect") export: renders frame by frame at a fixed timestep,
 * independent of how long a frame takes, so heavy patches export smoothly.
 *
 * Per frame: clock.step(1 / fps) (manual mode, see Clock.setManual), the app's
 * per-frame work (app.tickFrame: Param / JS / scene ticks, Feedback passes), the
 * Preview's shader at the export size, then WebCodecs VideoEncoder -> WebM / MP4
 * muxer (src/output/muxers.js), or PNG frames -> zip / a folder (File System Access).
 *
 * Audio is not analysed offline: with the metronome the audio uniforms follow its
 * deterministic groove, otherwise they are 0 and the beat clock freewheels.
 *
 * JS nodes: Math.random is seeded per export (option seed, default 1) and the mouse
 * (u_mouse, JS `mouse`) is held at its position when the export starts, so exports of
 * JS patches are reproducible. Both are swapped in only around each frame's synchronous
 * work (tick + render), never across awaits: the rest of the page keeps the real ones.
 * Live inputs (Microphone, MIDI, camera / screen / video, keyboard, XY pad) stay live:
 * liveInputs(graph) lists them for the export UI.
 */

/** Seeded 0..1 generator (mulberry32, same as the render_preview warm-up). */
export function seededRandom(seed = 1) {
    let a = (Number(seed) >>> 0) || 1;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Inputs of the project that keep following the outside world during an offline export. */
export function liveInputs(graph) {
    const kinds = new Set();
    for (const n of (graph && graph.nodes) || []) {
        if (n.isMicrophoneNode) kinds.add('microphone');
        else if (n.isMidiCCNode || n.isMidiNoteNode) kinds.add('MIDI');
        else if (n.isCameraNode || n.isScreenCaptureNode || n.isVideoURLNode) kinds.add(n.isCameraNode ? 'camera' : n.isScreenCaptureNode ? 'screen capture' : 'video');
        else if (n.isKeyboardNode || n.isXYPadNode) kinds.add(n.isKeyboardNode ? 'keyboard' : 'XY pad');
        else if (n.isParamNode && n.data && Array.isArray(n.data.midi) && n.data.midi.length) kinds.add('MIDI');
        else if (n.isIONode) kinds.add('I/O');
    }
    return [...kinds];
}

const yieldNow = () => new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
});
const nextPaint = () => new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 50); // hidden tab: rAF does not run
});

export class OfflineExporter {
    constructor(manager, { node, width, height, fps = 30, duration = 5, format = 'mp4', bitrate = 0, fromStart = true, dirHandle = null, seed = 1 }) {
        this.manager = manager;
        this.app = manager.app;
        this.node = node;
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.duration = Math.max(1 / fps, Number(duration) || 5);
        this.totalFrames = Math.max(1, Math.round(this.duration * fps));
        this.format = format;
        this.bitrate = bitrate || autoBitrate(width, height, fps, true);
        this.fromStart = fromStart;
        this.dirHandle = dirHandle;
        this.seed = Number.isFinite(Number(seed)) ? Number(seed) : 1;
        this.random = null;
        this.mouse = null;
        this.frame = 0;
        this.cancelled = false;
        this.state = 'idle';
        this.startedAt = 0;
    }

    /** Frames in flight in the encoder: keeps GPU + encoder pipelined without unbounded memory. */
    static maxQueue = 8;

    get progress() { return this.frame / this.totalFrames; }

    cancel() { this.cancelled = true; }

    status() {
        const elapsed = this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
        const rate = elapsed > 0 ? this.frame / elapsed : 0;
        return {
            state: this.state,
            frame: this.frame,
            frames: this.totalFrames,
            progress: +this.progress.toFixed(4),
            render_fps: +rate.toFixed(2),
            eta_s: rate > 0 ? +((this.totalFrames - this.frame) / rate).toFixed(1) : null,
            width: this.width, height: this.height, fps: this.fps, format: this.format
        };
    }

    /** Run the synchronous frame work with the export's Math.random and pinned mouse. */
    _pinned(fn) {
        const SP = ShaderPreview;
        const saved = { random: Math.random, x: SP.mouseX, y: SP.mouseY };
        if (this.random) Math.random = this.random;
        if (this.mouse) { SP.mouseX = this.mouse[0]; SP.mouseY = this.mouse[1]; }
        try {
            return fn();
        } finally {
            Math.random = saved.random;
            SP.mouseX = saved.x;
            SP.mouseY = saved.y;
        }
    }

    _resetFeedback() {
        clearFeedbackBuffers(this.app.nodeGraph, this.app.sharedGL);
    }

    /**
     * "From start": the same project exports the same frames every time. Time, beat and
     * every piece of simulation state restart: Feedback buffers, control-rate nodes (Lag,
     * Counter, Spring, Random, Delay...), JS node state (setup runs again; ticked at t = 0
     * until it settled), the audio-texture history, SceneSwitchers settled on their current
     * scene (no auto switch or transition carried in). Returns the switchers' restore().
     */
    async _resetFromStart() {
        const app = this.app;
        const graph = app.nodeGraph;
        clock.setTime(0);
        clock.beatPos = 0;
        resetSimulation(graph, app.sharedGL);
        const restoreSwitchers = settleSwitchers(graph);
        if (graph.nodes.some(n => n.isJSNode)) {
            const t0 = performance.now();
            for (let i = 0; i < 1000 && pendingJSSetup(graph).length; i++) {
                if (this.cancelled || performance.now() - t0 > 15000) break;
                clock.step(0);
                this._pinned(() => app.tickFrame());
                await new Promise(r => setTimeout(r, 2));
            }
            // Fresh start after the priming frames (the state JS setup produced is kept); their
            // number depends on how fast setup settles, so the random sequence restarts too
            clock.setTime(0);
            clock.beatPos = 0;
            resetSimulation(graph, app.sharedGL, { js: false });
            this.random = seededRandom(this.seed);
        }
        return restoreSwitchers;
    }

    async _setupEncoder() {
        if (this.format === 'png' || this.format === 'folder') return;
        try {
            await this._createEncoder();
        } catch (e) {
            // configure() can throw after the encoder exists: don't leak it
            try { if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); } catch (err) { /* ignore */ }
            this.encoder = null;
            throw e;
        }
    }

    async _createEncoder() {
        const pick = await pickEncoderConfig(this.format, { width: this.width, height: this.height, fps: this.fps, bitrate: this.bitrate });
        if (!pick) throw new Error(`This browser cannot encode ${this.format === 'mp4' ? 'H.264 / MP4' : 'VP9 / WebM'} with WebCodecs at ${this.width}×${this.height}${typeof VideoEncoder === 'undefined' ? ' (no WebCodecs)' : ''} - try another format or a PNG sequence`);
        this.codec = pick.config.codec;
        this.muxer = this.format === 'mp4'
            ? new MP4Muxer({ width: this.width, height: this.height, fps: this.fps })
            : new WebMMuxer({ width: this.width, height: this.height, fps: this.fps, codec: this.codec });
        this.encodeError = null;
        this.encoder = new VideoEncoder({
            output: (chunk, meta) => this.muxer.addChunk(chunk, meta),
            error: (e) => { this.encodeError = e; }
        });
        this.encoder.configure(pick.config);
    }

    async _waitQueue() {
        while (this.encoder.encodeQueueSize > OfflineExporter.maxQueue) {
            await new Promise(resolve => {
                const t = setTimeout(resolve, 20);
                this.encoder.addEventListener?.('dequeue', () => { clearTimeout(t); resolve(); }, { once: true });
            });
            if (this.encodeError) throw this.encodeError;
        }
    }

    async run(onProgress = null) {
        const app = this.app;
        if (typeof app.tickFrame !== 'function') throw new Error('Offline export needs app.tickFrame (main.js)');
        this.state = 'preparing';
        await this._setupEncoder();

        const canvas = document.createElement('canvas');
        canvas.width = this.width;
        canvas.height = this.height;
        const ctx = canvas.getContext('2d', { alpha: false });
        const zip = this.format === 'png' ? new ZipWriter() : null;

        // Freeze real time: from here only clock.step() advances it. Everything after
        // setManual is inside the try: a throw never leaves the app in manual-clock mode.
        const saved = { time: clock.time, beatPos: clock.beatPos };
        const dt = 1 / this.fps;
        const t = { tick: 0, render: 0, encode: 0, wait: 0 }; // per-stage time (ms), reported per frame
        let restoreSwitchers = null;
        let suspended = false;
        // Reproducible JS nodes: a fresh seeded Math.random per export, the mouse of the start
        this.random = seededRandom(this.seed);
        this.mouse = [ShaderPreview.mouseX, ShaderPreview.mouseY];
        clock.setManual(true, { owner: 'export' });
        try {
            this.manager.suspendEditor('export');
            suspended = true;
            if (this.fromStart) restoreSwitchers = await this._resetFromStart();
            this.state = 'rendering';
            this.startedAt = performance.now();
            let lastPaint = performance.now();
            for (let i = 0; i < this.totalFrames; i++) {
                if (this.cancelled) throw Object.assign(new Error('Export cancelled'), { cancelled: true });
                // frame 0 at the start time, then one fixed step per frame
                let t0 = performance.now();
                clock.step(i === 0 ? 0 : dt);
                this._pinned(() => app.tickFrame());
                let t1 = performance.now();
                t.tick += t1 - t0;
                this._pinned(() => this.manager.renderInto(this.node, this.width, this.height, ctx, null));
                t0 = performance.now();
                t.render += t0 - t1;

                if (this.encoder) {
                    if (this.encodeError) throw this.encodeError;
                    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / this.fps), duration: Math.round(1e6 / this.fps) });
                    this.encoder.encode(frame, { keyFrame: i % Math.max(1, Math.round(this.fps * 2)) === 0 });
                    frame.close();
                    t1 = performance.now();
                    t.encode += t1 - t0;
                    await this._waitQueue();
                    t.wait += performance.now() - t1;
                } else {
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                    const name = `frame_${String(i).padStart(5, '0')}.png`;
                    if (this.dirHandle) {
                        const fh = await this.dirHandle.getFileHandle(name, { create: true });
                        const w = await fh.createWritable();
                        await w.write(blob);
                        await w.close();
                    } else {
                        zip.add(name, new Uint8Array(await blob.arrayBuffer()));
                    }
                }
                this.frame = i + 1;
                // Let the UI breathe (progress) without stalling the export
                const now = performance.now();
                if (now - lastPaint > 200) {
                    lastPaint = now;
                    onProgress?.(this.status());
                    await nextPaint();
                } else {
                    await yieldNow();
                }
            }
            this.state = 'finishing';
            onProgress?.(this.status());
            let result;
            if (this.encoder) {
                await this.encoder.flush();
                if (this.encodeError) throw this.encodeError;
                this.encoder.close();
                const out = this.muxer.finalize();
                result = { blob: new Blob([out.bytes], { type: out.mime }), ext: this.format, mime: out.mime, frames: out.frames, durationMs: out.durationMs, codec: this.codec };
            } else if (zip) {
                result = { blob: zip.finalize(), ext: 'zip', mime: 'application/zip', frames: this.totalFrames, durationMs: this.totalFrames * 1000 / this.fps, codec: 'png' };
            } else {
                result = { blob: null, ext: null, mime: null, frames: this.totalFrames, durationMs: this.totalFrames * 1000 / this.fps, codec: 'png', folder: this.dirHandle.name };
            }
            const renderS = (performance.now() - this.startedAt) / 1000;
            this.state = 'done';
            const per = (v) => +(v / this.totalFrames).toFixed(2);
            result.timing_ms = { tick: per(t.tick), render: per(t.render), encode: per(t.encode), wait: per(t.wait) };
            const live = liveInputs(app.nodeGraph);
            if (live.length) result.live_inputs = live;
            return { ...result, seed: this.seed, width: this.width, height: this.height, fps: this.fps, bitrate: this.encoder ? this.bitrate : null, render_seconds: +renderS.toFixed(2), render_fps: +(this.totalFrames / renderS).toFixed(2) };
        } catch (e) {
            this.state = e && e.cancelled ? 'cancelled' : 'error';
            try { if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); } catch (err) { /* ignore */ }
            throw e;
        } finally {
            // The live show continues where it was (scene switchers included)
            try { restoreSwitchers?.(); } catch (e) { /* ignore */ }
            clock.setTime(saved.time);
            clock.beatPos = saved.beatPos;
            clock.lastNow = -1; // no time jump for a driver that continues (output window)
            clock.setManual(false, { owner: 'export' });
            if (suspended) this.manager.resumeEditor('export');
        }
    }
}
