import { h, UIHelpers } from './UIHelpers.js';
import { iconEl } from './icons.js';
import { audioEngine, isAudioFile } from '../services/AudioEngine.js';
import { clock } from '../core/Clock.js';

const SOURCES = [
    { id: 'mic', icon: 'mic', label: 'Mic', tip: 'Listen with the microphone (music from speakers)' },
    { id: 'file', icon: 'music', label: 'File', tip: 'Play an audio file (or drop one anywhere)' },
    { id: 'tab', icon: 'tab', label: 'Tab', tip: 'Capture another tab\'s audio (Chrome)' },
    { id: 'metronome', icon: 'metronome', label: 'Metro', tip: 'Fixed-tempo clock, no audio' },
    { id: 'off', icon: 'close', label: 'Off', tip: 'No audio analysis (the beat clock free-runs)' }
];
const SOURCE_ICON = { mic: 'mic', file: 'music', tab: 'tab', metronome: 'metronome', off: 'wave' };
const BANDS = [['level', 'LVL'], ['bass', 'BASS'], ['lowMid', 'LOW'], ['mid', 'MID'], ['high', 'HIGH'], ['kick', 'KICK']];

function fmtTime(s) {
    if (!Number.isFinite(s)) return '--:--';
    s = Math.max(0, Math.floor(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Top-bar audio section (source, beat LED, BPM + confidence, tap, level meter) and
 * the audio popover (source choice, transport, band meters, tempo / lock / offset).
 * Also handles dropping audio files anywhere on the app.
 */
export class AudioPanel {
    constructor(app) {
        this.app = app;
        this.srcBtn = document.getElementById('audioSourceBtn');
        if (!this.srcBtn) return; // markup missing (embedded builds)
        this.nameEl = this.srcBtn.querySelector('.tb-audio-name');
        this.iconUse = this.srcBtn.querySelector('.tb-audio-icon use');
        this.meterFill = this.srcBtn.querySelector('.tb-audio-meter-fill');
        this.playBtn = document.getElementById('audioPlayBtn');
        this.bpmBtn = document.getElementById('bpmBtn');
        this.bpmValue = this.bpmBtn.querySelector('.tb-bpm-value');
        // the readout has one decimal: room for "128.0" so the button doesn't jump at 100
        if (this.bpmValue) this.bpmValue.style.minWidth = '5ch';
        this.confEl = this.bpmBtn.querySelector('.tb-conf');
        this.led = document.getElementById('beatLed');
        this.tapBtn = document.getElementById('tapBtn');
        this.pop = null;
        this.last = {};

        this.fileInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus', hidden: true });
        this.fileInput.addEventListener('change', () => {
            const f = this.fileInput.files && this.fileInput.files[0];
            this.fileInput.value = '';
            if (f) this.loadFile(f);
        });
        document.body.appendChild(this.fileInput);

        this.srcBtn.addEventListener('click', () => this.togglePopover(this.srcBtn));
        this.bpmBtn.addEventListener('click', () => this.togglePopover(this.srcBtn));
        this.playBtn.addEventListener('click', () => audioEngine.togglePlay());
        // pointerdown: lower latency than click for tapping along
        this.tapBtn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            this.tap();
        });
        this.tapBtn.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.tap(); }
        });

        audioEngine.onChange((reason) => this.onEngineChange(reason));
        clock.onChange(() => this.renderStatic());
        this.setupDrop();
        this.renderStatic();
        this.frame = this.frame.bind(this);
        requestAnimationFrame(this.frame);
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    async run(fn, errorTitle) {
        try {
            return await fn();
        } catch (e) {
            const msg = audioEngine.error || (e && e.message) || String(e);
            UIHelpers.toast(msg, 'error', { title: errorTitle });
            return null;
        } finally {
            this.renderStatic();
            this.renderPopover();
        }
    }

    setSource(id) {
        if (id === 'file' && !audioEngine.hasFile()) {
            this.fileInput.click();
            return;
        }
        const titles = { mic: 'Microphone unavailable', tab: 'Tab audio unavailable', file: 'Could not play the file' };
        return this.run(async () => {
            await audioEngine.setSource(id, { play: true });
            if (id === 'mic') this.app.shell?.activity('Listening to the microphone — beat lock takes a few seconds', { local: true });
            if (id === 'metronome') this.app.shell?.activity(`Metronome · ${Math.round(clock.metroBpm)} BPM`, { local: true });
        }, titles[id] || 'Audio error');
    }

    loadFile(file) {
        return this.run(async () => {
            await audioEngine.loadFile(file, { play: true });
            this.app.shell?.activity(`Playing ${audioEngine.file.name}`, { local: true });
        }, 'Could not play the file');
    }

    tap() {
        const r = audioEngine.tap();
        this.tapBtn.classList.remove('is-tapped');
        void this.tapBtn.offsetWidth;
        this.tapBtn.classList.add('is-tapped');
        if (r.first) this.app.shell?.activity('Tap: downbeat set — keep tapping for tempo', { local: true });
        this.renderPopover();
    }

    // ------------------------------------------------------------------
    // Drag and drop: audio files anywhere; .json outside the canvas
    // ------------------------------------------------------------------

    setupDrop() {
        const app = document.getElementById('app') || document.body;
        const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
        const isAudioDrag = e => [...(e.dataTransfer?.items || [])].some(i => i.kind === 'file' && /^audio\//.test(i.type));
        let timer = null;
        window.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault(); // allow dropping anywhere (never navigate to the file)
            if (isAudioDrag(e)) {
                e.dataTransfer.dropEffect = 'copy';
                app.classList.add('is-audio-drop');
                clearTimeout(timer);
                timer = setTimeout(() => app.classList.remove('is-audio-drop'), 160);
            }
        });
        window.addEventListener('drop', (e) => {
            app.classList.remove('is-audio-drop');
            const files = [...(e.dataTransfer?.files || [])];
            if (!files.length) return;
            const audio = files.find(isAudioFile);
            if (audio) {
                e.preventDefault();
                this.loadFile(audio);
                return;
            }
            const json = files.find(f => /\.json$/i.test(f.name));
            if (json && !e.defaultPrevented) {
                // The canvas handles its own drops; elsewhere route .json to the project loader
                e.preventDefault();
                const input = document.getElementById('loadFileInput');
                try {
                    const dt = new DataTransfer();
                    dt.items.add(json);
                    input.files = dt.files;
                    input.dispatchEvent(new Event('change'));
                } catch (err) {
                    console.warn('Could not load dropped file', err);
                }
            } else if (!e.defaultPrevented) {
                e.preventDefault();
            }
        });
    }

    // ------------------------------------------------------------------
    // Top bar
    // ------------------------------------------------------------------

    onEngineChange(reason) {
        if (reason === 'error') {
            const msg = audioEngine.file.error || audioEngine.error;
            if (msg && msg !== this.lastError) UIHelpers.toast(msg, 'error', { title: 'Audio' });
            this.lastError = msg;
        }
        this.renderStatic();
        this.renderPopover();
    }

    /** Things that change on events (source, file state), not every frame. */
    renderStatic() {
        if (!this.srcBtn) return;
        const src = audioEngine.source;
        const label = audioEngine.sourceLabel();
        if (this.nameEl.textContent !== label) this.nameEl.textContent = label;
        this.iconUse.setAttribute('href', `#i-${SOURCE_ICON[src] || 'wave'}`);
        this.srcBtn.classList.toggle('is-live', src !== 'off');
        const tip = src === 'off' ? 'Audio source & beat sync — drop an audio file to play it' : `${label} · audio & beat settings`;
        if (this.srcBtn.getAttribute('data-tip') !== tip) {
            this.srcBtn.setAttribute('data-tip', tip);
            UIHelpers.refreshTooltip(this.srcBtn);
        }
        const showPlay = src === 'file' || (audioEngine.hasFile() && src === 'off');
        this.playBtn.hidden = !showPlay;
        const playing = audioEngine.isPlaying();
        this.playBtn.classList.toggle('is-paused', !playing);
        const pTip = playing ? 'Pause music' : 'Play music';
        if (this.playBtn.getAttribute('data-tip') !== pTip) {
            this.playBtn.setAttribute('data-tip', pTip);
            UIHelpers.refreshTooltip(this.playBtn);
        }
        this.bpmBtn.classList.toggle('is-locked', audioEngine.settings.locked && audioEngine.isLive());
        // Audio off: no tempo to show, so hide the BPM readout / beat LED and Tap
        // (the beat clock keeps free-running for shaders; u_beatConfidence is 0)
        const off = src === 'off';
        this.bpmBtn.hidden = off;
        this.tapBtn.hidden = off;
    }

    /** Per-frame: LED, meter, BPM readout (DOM touched only when values change). */
    frame() {
        requestAnimationFrame(this.frame);
        if (!this.srcBtn) return;
        const u = clock.u;
        const last = this.last;

        if (this.bpmBtn.hidden) { // audio off: the LED / readout don't step
            if (this.pop && !this.pop.closed) this.framePopover();
            return;
        }
        const on = u.beatPhase < 0.16;
        const down = (((u.beatCount % 4) + 4) % 4) === 0;
        if (on !== last.on || down !== last.down) {
            this.led.classList.toggle('is-on', on);
            this.led.classList.toggle('is-downbeat', down);
            last.on = on;
            last.down = down;
        }
        const synced = clock.mode === 'metronome' || clock.following || clock.anchorMs !== null;
        if (synced !== last.synced) {
            this.led.classList.toggle('is-free', !synced);
            this.bpmBtn.classList.toggle('is-free', !synced);
            last.synced = synced;
        }
        // Live audio, estimate not trusted (yet): the published clock coasts at the last trusted
        // tempo (the readout shows it, dimmed) until the new beat holds still, then glides to it
        const searching = clock.mode !== 'metronome' && audioEngine.isLive() && !clock.trusted;
        if (searching !== last.searching) {
            this.bpmBtn.classList.toggle('is-searching', searching);
            this.led.classList.toggle('is-searching', searching);
            last.searching = searching;
            last.conf = undefined; // refresh the tooltip
        }

        const level = audioEngine.source === 'off' ? 0 : Math.max(u.level, u.kick * 0.9);
        const lq = Math.round(level * 40) / 40;
        if (lq !== last.level) {
            this.meterFill.style.transform = `scaleY(${lq})`;
            last.level = lq;
        }

        // Readout: the clock's 0.1-BPM value with hysteresis (u_bpm itself is smoothed), so the
        // number only moves when the tempo really does. Formatted only when it changes.
        const bpmKey = Math.round(clock.bpmShown * 10);
        if (bpmKey !== last.bpmKey) {
            last.bpmKey = bpmKey;
            last.bpm = (bpmKey / 10).toFixed(1);
            this.bpmValue.textContent = last.bpm;
            last.conf = undefined; // refresh the tooltip with the new tempo
        }
        const bpmText = last.bpm;
        const live = audioEngine.isLive();
        const conf = clock.mode === 'metronome' ? 3 : live ? (u.confidence >= 0.7 ? 3 : u.confidence >= 0.45 ? 2 : u.confidence >= 0.2 ? 1 : 0) : -1;
        if (conf !== last.conf) {
            this.confEl.dataset.level = String(Math.max(0, conf));
            this.confEl.hidden = conf < 0;
            const tip = conf < 0
                ? `${bpmText} BPM (free-running) · click for audio settings`
                : clock.mode === 'metronome' ? 'Metronome tempo · click to change'
                    : last.searching ? `Searching… holding ${bpmText} BPM until the new beat is trusted · beat effects fade (u_beatTrust)`
                        : ['Searching for the beat…', 'Beat: tentative (low confidence)', 'Beat: locked', 'Beat: locked (high confidence)'][conf] + ' · beat effects fade with u_beatTrust / u_beatConfidence';
            this.bpmBtn.setAttribute('data-tip', tip);
            UIHelpers.refreshTooltip(this.bpmBtn);
            last.conf = conf;
        }

        if (this.pop && !this.pop.closed) this.framePopover();
    }

    // ------------------------------------------------------------------
    // Popover
    // ------------------------------------------------------------------

    togglePopover(anchor) {
        if (this.pop && !this.pop.closed) {
            this.pop.close();
            return;
        }
        const content = this.buildPopover();
        this.pop = UIHelpers.openMenu({
            anchor,
            content,
            className: 'pt-audio-pop',
            onClose: () => { this.pop = null; this.els = null; }
        });
        this.renderPopover();
    }

    buildPopover() {
        const els = this.els = {};
        const root = h('div', { className: 'ap' });

        // Header
        els.status = h('span', { className: 'ap-status' });
        root.appendChild(h('div', { className: 'ap-head' }, [
            h('span', { className: 'pt-label', text: 'Audio & beat' }),
            els.status
        ]));

        // Source choice
        els.sources = {};
        const seg = h('div', { className: 'ap-sources', role: 'radiogroup', 'aria-label': 'Audio source' });
        for (const s of SOURCES) {
            const btn = h('button', { className: 'ap-src', role: 'radio', 'data-tip': s.tip, onClick: () => this.setSource(s.id) }, [
                iconEl(s.icon),
                h('span', { text: s.label })
            ]);
            els.sources[s.id] = btn;
            seg.appendChild(btn);
        }
        root.appendChild(seg);

        // Source details
        els.detail = h('div', { className: 'ap-detail' });
        root.appendChild(els.detail);

        // Band meters
        els.bands = {};
        const meters = h('div', { className: 'ap-meters' });
        for (const [key, label] of BANDS) {
            const fill = h('span', { className: 'ap-meter-fill' });
            meters.appendChild(h('div', { className: `ap-meter ap-meter--${key}` }, [
                h('span', { className: 'ap-meter-bar' }, [fill]),
                h('span', { className: 'ap-meter-label', text: label })
            ]));
            els.bands[key] = fill;
        }
        els.beatCells = [];
        const beats = h('div', { className: 'ap-beats', 'aria-hidden': 'true' });
        for (let i = 0; i < 4; i++) {
            const c = h('span', { className: 'ap-beat' });
            els.beatCells.push(c);
            beats.appendChild(c);
        }
        meters.appendChild(h('div', { className: 'ap-meter ap-meter--beat' }, [beats, h('span', { className: 'ap-meter-label', text: 'BAR' })]));
        root.appendChild(meters);

        // Tempo
        els.bpmInput = h('input', { className: 'pt-input pt-input--mono ap-bpm-input', type: 'number', min: '20', max: '400', step: '0.1', 'aria-label': 'BPM' });
        const applyBpm = () => {
            const v = parseFloat(els.bpmInput.value);
            if (v > 0) audioEngine.setBpm(v);
            els.bpmInput.dataset.editing = '';
            this.renderPopover();
        };
        els.bpmInput.addEventListener('focus', () => { els.bpmInput.dataset.editing = '1'; });
        els.bpmInput.addEventListener('change', applyBpm);
        els.bpmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { applyBpm(); els.bpmInput.blur(); } });
        els.bpmInput.addEventListener('blur', () => { els.bpmInput.dataset.editing = ''; });
        els.lockBtn = h('button', {
            className: 'pt-btn pt-btn--sm ap-lock', 'data-tip': 'Lock the tempo (the phase keeps following the music)',
            onClick: () => { audioEngine.setLocked(!audioEngine.settings.locked); this.renderPopover(); }
        }, [h('span', { text: 'Lock BPM' })]);
        els.tapBtn = h('button', { className: 'tb-tap ap-tap', 'data-tip': 'Tap along — first tap = downbeat', text: 'Tap' });
        els.tapBtn.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); this.tap(); } });
        root.appendChild(h('div', { className: 'ap-row' }, [
            h('span', { className: 'ap-row-label', text: 'Tempo' }),
            els.bpmInput,
            h('span', { className: 'ap-unit', text: 'BPM' }),
            els.lockBtn,
            els.tapBtn
        ]));

        // Offset
        els.offset = h('input', { className: 'ap-range', type: 'range', min: '-200', max: '200', step: '5', 'aria-label': 'Beat offset (ms)' });
        els.offsetVal = h('button', { className: 'ap-offset-val', 'data-tip': 'Reset to 0', onClick: () => { audioEngine.setOffset(0); this.renderPopover(); } });
        els.offset.addEventListener('input', () => {
            audioEngine.setOffset(parseInt(els.offset.value, 10));
            els.offsetVal.textContent = `${audioEngine.settings.offsetMs > 0 ? '+' : ''}${audioEngine.settings.offsetMs} ms`;
        });
        root.appendChild(h('div', { className: 'ap-row' }, [
            h('span', { className: 'ap-row-label', text: 'Offset', 'data-tip': 'Shift visual beats: negative = earlier, positive = later' }),
            els.offset,
            els.offsetVal
        ]));

        root.appendChild(h('div', { className: 'ap-foot', text: 'Shaders read u_beat, u_beatPhase, u_kick, u_bass… or use the Audio / Beat nodes; u_beatConfidence (the % above) fades beat effects when the beat is unsure. Drop an audio file anywhere to play it.' }));
        return root;
    }

    /** Event-driven parts of the popover. */
    renderPopover() {
        const els = this.els;
        if (!els || !this.pop || this.pop.closed) return;
        const src = audioEngine.source;
        for (const [id, btn] of Object.entries(els.sources)) {
            btn.classList.toggle('is-active', id === src);
            btn.setAttribute('aria-checked', String(id === src));
        }

        // Details per source
        const d = els.detail;
        d.textContent = '';
        if (src === 'file' || audioEngine.hasFile()) {
            const f = audioEngine.file;
            const playing = audioEngine.isPlaying();
            const play = h('button', { className: `pt-icon-btn pt-icon-btn--sm ap-play${playing ? '' : ' is-paused'}`, 'data-tip': playing ? 'Pause' : 'Play', onClick: () => audioEngine.togglePlay() }, [
                iconEl(playing ? 'pause' : 'play')
            ]);
            const seek = h('input', { className: 'ap-range ap-seek', type: 'range', min: '0', max: '1000', step: '1', 'aria-label': 'Position' });
            seek.addEventListener('input', () => {
                const el = f.el;
                if (el && Number.isFinite(el.duration)) audioEngine.seek(el.duration * seek.value / 1000);
            });
            const time = h('span', { className: 'ap-time' });
            const loop = h('button', {
                className: `pt-icon-btn pt-icon-btn--sm${f.el && f.el.loop ? ' is-active' : ''}`, 'data-tip': 'Loop',
                onClick: () => { audioEngine.setLoop(!(f.el && f.el.loop)); this.renderPopover(); }
            }, [iconEl('loop')]);
            els.seek = seek;
            els.time = time;
            d.appendChild(h('div', { className: 'ap-file' }, [
                h('div', { className: 'ap-file-name', text: f.name || 'Audio file', title: f.name || '' }),
                h('div', { className: 'ap-transport' }, [play, seek, time, loop])
            ]));
            d.appendChild(h('div', { className: 'ap-actions' }, [
                UIHelpers.button('Load file…', { size: 'sm', icon: 'folder', onClick: () => this.fileInput.click() }),
                src !== 'file' ? UIHelpers.button('Use file', { size: 'sm', onClick: () => this.setSource('file') }) : null
            ]));
        } else {
            els.seek = null;
            els.time = null;
        }
        if (src === 'mic') {
            els.micInfo = h('div', { className: 'ap-hint' });
            d.appendChild(els.micInfo);
        } else {
            els.micInfo = null;
        }
        if (src === 'tab') {
            d.appendChild(h('div', { className: 'ap-hint', text: `Analysing ${audioEngine.tab.label || 'tab audio'}. Stop sharing from Chrome's bar to end.` }));
        }
        if (src === 'metronome') {
            d.appendChild(h('div', { className: 'ap-hint', text: 'Fixed tempo, no audio needed: audio uniforms follow a virtual kick / snare / hat groove. Set the BPM below or tap.' }));
        }
        if (src === 'off' && !audioEngine.hasFile()) {
            d.appendChild(h('div', { className: 'ap-actions' }, [
                UIHelpers.button('Load audio file…', { size: 'sm', icon: 'folder', onClick: () => this.fileInput.click() })
            ]));
            d.appendChild(h('div', { className: 'ap-hint', text: 'The beat clock free-runs at the last tempo. Pick a source above.' }));
        }

        if (!els.bpmInput.dataset.editing) els.bpmInput.value = clock.bpmShown.toFixed(1);
        const locked = audioEngine.settings.locked;
        els.lockBtn.classList.toggle('is-active', locked);
        els.lockBtn.setAttribute('aria-pressed', String(locked));
        els.lockBtn.disabled = !audioEngine.isLive();
        els.offset.value = String(audioEngine.settings.offsetMs);
        els.offsetVal.textContent = `${audioEngine.settings.offsetMs > 0 ? '+' : ''}${audioEngine.settings.offsetMs} ms`;
        this.pop.reposition?.();
    }

    /** Per-frame parts of the popover (meters, status, transport position). */
    framePopover() {
        const els = this.els;
        if (!els) return;
        const u = clock.u;
        for (const [key] of BANDS) {
            const v = Math.round(Math.max(0, Math.min(1, u[key])) * 50) / 50;
            const fill = els.bands[key];
            if (fill._v !== v) {
                fill.style.transform = `scaleY(${v})`;
                fill._v = v;
            }
        }
        const beatInBar = ((u.beatCount % 4) + 4) % 4;
        if (els._beat !== beatInBar) {
            els.beatCells.forEach((c, i) => c.classList.toggle('is-on', i === beatInBar));
            els._beat = beatInBar;
        }

        let status;
        const src = audioEngine.source;
        const bpm = clock.bpmShown.toFixed(1);
        // the percentage is u_beatConfidence (Beat.confidence), the value shaders see
        const pct = `${Math.round(u.confidence * 100)}%`;
        if (clock.paused) status = 'Paused';
        else if (src === 'metronome') status = `Metronome · ${bpm} BPM`;
        else if (src === 'off') status = clock.anchorMs !== null ? `Tapped · ${bpm} BPM` : `Free-running · ${bpm} BPM`;
        else if (!audioEngine.isLive()) status = audioEngine.ctx && audioEngine.ctx.state === 'suspended' ? 'Click to start audio' : 'Starting…';
        else if (audioEngine.inputDb < -65) status = 'No signal';
        else if (!clock.trusted && audioEngine.bpm > 0) status = `Searching… holding ${bpm} BPM (tracker ${audioEngine.bpm.toFixed(1)}) · ${pct}`;
        else if (clock.following && clock.pubState === 'glide') status = `Gliding to ${clock.u.raw[3].toFixed(1)} BPM · ${pct}`;
        else if (clock.following) status = `Locked · ${bpm} BPM · ${pct}`;
        else if (audioEngine.bpm > 0) status = `Unsure, coasting · ${audioEngine.bpm.toFixed(1)} BPM · ${pct}`;
        else status = 'Listening for a beat…';
        if (els.status.textContent !== status) els.status.textContent = status;

        if (els.micInfo) {
            const db = audioEngine.inputDb;
            const t = db < -65 ? 'No signal from the microphone. Check the input device and permission.'
                : `Input ${db.toFixed(0)} dBFS. Point the mic at the speakers; the beat locks in ~6 s, follows tempo drift, holds through breaks and relocks ~3 s after a track change.`;
            if (els.micInfo.textContent !== t) els.micInfo.textContent = t;
        }
        const el = audioEngine.file.el;
        if (els.seek && el && Number.isFinite(el.duration) && el.duration > 0 && document.activeElement !== els.seek) {
            const v = String(Math.round(el.currentTime / el.duration * 1000));
            if (els.seek.value !== v) els.seek.value = v;
            const t = `${fmtTime(el.currentTime)} / ${fmtTime(el.duration)}`;
            if (els.time.textContent !== t) els.time.textContent = t;
        }
        if (!els.bpmInput.dataset.editing && document.activeElement !== els.bpmInput) {
            const v = clock.bpmShown.toFixed(1);
            if (els.bpmInput.value !== v) els.bpmInput.value = v;
        }
    }
}
