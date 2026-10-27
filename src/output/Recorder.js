import { audioEngine } from '../services/AudioEngine.js';
import { pickRecorderType, autoBitrate } from './codecs.js';
import { fixWebmDuration } from './muxers.js';

/**
 * Real-time recording: a Preview's shader is rendered (shared GL context) at the
 * recording resolution into a 2D canvas whose captureStream feeds a MediaRecorder.
 * Frames are pushed at the requested fps from the output loop (requestFrame when
 * available). Optional audio: the AudioEngine's current source, tapped without
 * changing the engine - a file is connected to an extra MediaStreamDestination,
 * tab / mic capture tracks are cloned.
 */
export class RealtimeRecorder {
    constructor(manager, { node, width, height, fps = 30, bitrate = 0, format = 'auto', audio = false }) {
        this.manager = manager;
        this.node = node;
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.bitrate = bitrate || autoBitrate(width, height, fps);
        this.format = format;
        this.wantAudio = !!audio;
        this.chunks = [];
        this.bytes = 0;
        this.frames = 0;
        this.startedAt = 0;
        this.lastFrameAt = -Infinity;
        this.audioInfo = null;
        this.cleanups = [];
        this.state = 'idle';
    }

    /** What audio the engine can give us right now: { kind, label } or null. */
    static audioSource() {
        const ae = audioEngine;
        if (ae.source === 'file' && ae.file && ae.file.node && ae.ctx) return { kind: 'file', label: ae.file.name || 'Audio file' };
        if (ae.source === 'tab' && ae.tab && ae.tab.stream && ae.tab.stream.getAudioTracks().length) return { kind: 'tab', label: ae.tab.label || 'Tab audio' };
        if (ae.source === 'mic' && ae.mic && ae.mic.stream && ae.mic.stream.getAudioTracks().length) return { kind: 'mic', label: 'Microphone' };
        return null;
    }

    _audioTracks() {
        const src = RealtimeRecorder.audioSource();
        if (!src) return [];
        const ae = audioEngine;
        try {
            if (src.kind === 'file') {
                const dest = ae.ctx.createMediaStreamDestination();
                ae.file.node.connect(dest);
                this.cleanups.push(() => { try { ae.file.node.disconnect(dest); } catch (e) { /* already gone */ } });
                this.audioInfo = src;
                return dest.stream.getAudioTracks();
            }
            const stream = src.kind === 'tab' ? ae.tab.stream : ae.mic.stream;
            const tracks = stream.getAudioTracks().map(t => t.clone());
            this.cleanups.push(() => tracks.forEach(t => t.stop()));
            this.audioInfo = src;
            return tracks;
        } catch (e) {
            console.warn('[output] could not tap the audio source', e);
            return [];
        }
    }

    start() {
        try {
            this._start();
        } catch (e) {
            // Unsupported mime / bitrate, NotSupportedError: release the audio taps and the
            // canvas stream (a cloned mic track would keep the recording indicator on)
            this.cleanups.forEach(fn => { try { fn(); } catch (err) { /* ignore */ } });
            this.cleanups = [];
            try { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); } catch (err) { /* ignore */ }
            this.state = 'idle';
            throw e;
        }
    }

    _start() {
        const audioTracks = this.wantAudio ? this._audioTracks() : [];
        const type = pickRecorderType(this.format, audioTracks.length > 0);
        if (!type) throw new Error(this.format === 'mp4' ? 'This browser cannot record MP4 (try WebM)' : 'This browser cannot record video (MediaRecorder unsupported)');
        this.type = type;

        this.canvas = document.createElement('canvas');
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.width, this.height);

        // captureStream(0) + requestFrame: exactly the frames we draw; else let the browser sample
        this.stream = this.canvas.captureStream(0);
        this.track = this.stream.getVideoTracks()[0];
        if (!this.track || typeof this.track.requestFrame !== 'function') {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = this.canvas.captureStream(this.fps);
            this.track = this.stream.getVideoTracks()[0];
            this.manual = false;
        } else {
            this.manual = true;
        }
        for (const t of audioTracks) this.stream.addTrack(t);

        this.recorder = new MediaRecorder(this.stream, {
            mimeType: type.mime,
            videoBitsPerSecond: this.bitrate,
            audioBitsPerSecond: audioTracks.length ? 192000 : undefined
        });
        this.recorder.ondataavailable = (e) => {
            if (e.data && e.data.size) {
                this.chunks.push(e.data);
                this.bytes += e.data.size;
                this.manager.emit('recording');
            }
        };
        this.done = new Promise((resolve, reject) => {
            this.recorder.onstop = () => resolve();
            this.recorder.onerror = (e) => reject(e.error || new Error('MediaRecorder error'));
        });
        // stop() awaits it; until then a mid-recording error must not be an unhandled rejection
        this.done.catch(() => { });
        // First frame before start so the stream has content
        this.drawFrame();
        this.recorder.start(1000);
        this.startedAt = performance.now();
        this.state = 'recording';
    }

    get elapsedMs() {
        return this.state === 'idle' ? 0 : (this.stoppedAt || performance.now()) - this.startedAt;
    }

    drawFrame() {
        const m = this.manager;
        m.renderInto(this.node, this.width, this.height, this.ctx, null);
        this.frames++;
        if (this.manual) this.track.requestFrame();
    }

    /** Called from the output loop every animation frame: draw at the recording fps. */
    tick(now) {
        if (this.state !== 'recording') return;
        const interval = 1000 / this.fps;
        if (now - this.lastFrameAt < interval - 2) return;
        // keep the cadence (no drift), but don't try to catch up after a stall
        this.lastFrameAt = now - this.lastFrameAt > interval * 3 ? now : this.lastFrameAt + interval;
        this.drawFrame();
    }

    async stop() {
        if (this.state !== 'recording') throw new Error('Not recording');
        this.state = 'stopping';
        this.stoppedAt = performance.now();
        try { this.recorder.requestData(); } catch (e) { /* ignore */ }
        this.recorder.stop();
        try {
            await this.done;
        } finally {
            this.stream.getTracks().forEach(t => t.stop());
            this.cleanups.forEach(fn => fn());
            this.cleanups = [];
            this.state = 'idle';
        }
        const durationMs = this.stoppedAt - this.startedAt;
        let blob = new Blob(this.chunks, { type: this.type.mime.split(';')[0] });
        if (this.type.format === 'webm') {
            const fixed = fixWebmDuration(new Uint8Array(await blob.arrayBuffer()), durationMs);
            blob = new Blob([fixed], { type: 'video/webm' });
        }
        this.chunks = [];
        return {
            blob,
            ext: this.type.ext,
            mime: this.type.mime,
            durationMs,
            frames: this.frames,
            width: this.width,
            height: this.height,
            fps: this.fps,
            bitrate: this.bitrate,
            audio: this.audioInfo ? this.audioInfo.kind : null
        };
    }
}
