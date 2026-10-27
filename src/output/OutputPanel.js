import { h, UIHelpers } from '../ui/UIHelpers.js';
import { OutputManager } from './OutputManager.js';
import { RealtimeRecorder } from './Recorder.js';
import { getScreens } from './OutputWindow.js';
import { RESOLUTIONS, FPS_OPTIONS, recorderFormats, offlineFormats, autoBitrate } from './codecs.js';
import { IOPanel } from '../io/IOPanel.js';
import { liveInputs } from './OfflineExporter.js';
import { ioClient } from '../io/IOClient.js';

/**
 * Top-bar "Output" button + popover (record, offline export, output window,
 * performance mode) and the status-bar output indicator (#sbOutput).
 * Creates the OutputManager (app.output).
 */

const ICONS = {
    output: [
        '................',
        '................',
        '.##############.',
        '.#............#.',
        '.#....#.......#.',
        '.#....##......#.',
        '.#....###.....#.',
        '.#....####....#.',
        '.#....###.....#.',
        '.#....##......#.',
        '.#....#.......#.',
        '.##############.',
        '.......##.......',
        '.....######.....',
        '................',
        '................',
    ],
    record: [
        '................',
        '................',
        '................',
        '......####......',
        '....########....',
        '....########....',
        '...##########...',
        '...##########...',
        '...##########...',
        '...##########...',
        '....########....',
        '....########....',
        '......####......',
        '................',
        '................',
        '................',
    ],
    stop: [
        '................',
        '................',
        '................',
        '................',
        '....########....',
        '....########....',
        '....########....',
        '....########....',
        '....########....',
        '....########....',
        '....########....',
        '....########....',
        '................',
        '................',
        '................',
        '................',
    ],
    popout: [
        '................',
        '................',
        '.......#######..',
        '..........####..',
        '.........#####..',
        '........###.##..',
        '.######.##..##..',
        '.#.....##.......',
        '.#......#.......',
        '.#............#.',
        '.#............#.',
        '.#............#.',
        '.#............#.',
        '.##############.',
        '................',
        '................',
    ],
};

function bitmapPath(rows) {
    let d = '';
    rows.forEach((row, y) => {
        let x = 0;
        while (x < row.length) {
            if (row[x] === '#') {
                let w = 1;
                while (row[x + w] === '#') w++;
                d += `M${x} ${y}h${w}v1h-${w}z`;
                x += w;
            } else x++;
        }
    });
    return d;
}

function injectOutputIcons() {
    if (document.getElementById('pt-output-icons')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<svg id="pt-output-icons" xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">${
        Object.entries(ICONS).map(([n, rows]) => `<symbol id="i-${n}" viewBox="0 0 16 16"><path d="${bitmapPath(rows)}"/></symbol>`).join('')}</svg>`;
    document.body.insertBefore(wrap.firstChild, document.body.firstChild);
}

function svgIcon(name) {
    const t = document.createElement('template');
    t.innerHTML = `<svg class="pt-i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    return t.content.firstChild;
}

export function fmtDuration(s) {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtBytes(n) {
    if (!(n > 0)) return '0 KB';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function select(options, value, onChange, attrs = {}) {
    const el = h('select', { className: 'op-select', ...attrs });
    for (const o of options) {
        const opt = h('option', { value: String(o.value), text: o.label });
        if (o.disabled) opt.disabled = true;
        el.appendChild(opt);
    }
    el.value = String(value);
    el.addEventListener('change', () => onChange(el.value));
    return el;
}

function row(label, ...children) {
    return h('div', { className: 'op-row' }, [h('span', { className: 'op-row-label', text: label }), ...children]);
}

export class OutputPanel {
    constructor(app) {
        this.app = app;
        this.manager = app.output || new OutputManager(app);
        app.output = this.manager;
        this.btn = document.getElementById('outputBtn');
        this.sb = document.getElementById('sbOutput');
        injectOutputIcons();
        this.pop = null;
        this.formats = { realtime: recorderFormats(), offline: null };
        offlineFormats().then(f => { this.formats.offline = f; this.renderPopover(true); }).catch(() => { this.formats.offline = { mp4: false, webm: false, png: true, folder: false }; });
        this.screens = null;
        getScreens({ request: false }).then(s => { this.screens = s; this.renderPopover(true); });

        if (this.btn) this.btn.addEventListener('click', () => this.toggle());
        if (this.sb) this.sb.addEventListener('click', () => this.toggle(this.btn || this.sb));
        this.manager.on((reason) => this.onChange(reason));
        // I/O bridge popover (OSC / serial / MIDI out / Art-Net), opened from the I/O section
        this.io = new IOPanel(app);
        app.ioPanel = this.io;
        this._timer = setInterval(() => this.tick(), 250);
        this.tick();
    }

    // ------------------------------------------------------------------
    // Top bar / status bar
    // ------------------------------------------------------------------

    onChange(reason) {
        this.tick();
        this.renderPopover(reason === 'settings' || reason === 'window' || reason === 'export' || reason === 'recording');
    }

    tick() {
        const m = this.manager;
        const rec = m.recorder;
        const ex = m.exporter;
        const win = m.window && !m.window.closed ? m.window : null;
        if (this.btn) {
            const label = this.btn.querySelector('.tb-btn-label');
            let text = 'Output';
            if (rec) text = `REC ${fmtDuration(rec.elapsedMs / 1000)}`;
            else if (ex) text = `Export ${Math.round(ex.progress * 100)}%`;
            if (label && label.textContent !== text) label.textContent = text;
            this.btn.classList.toggle('is-recording', !!rec);
            this.btn.classList.toggle('is-exporting', !!ex);
            this.btn.classList.toggle('is-live', !!win);
            const tip = rec ? 'Recording — click to stop or change settings' : ex ? 'Offline export running' : win ? 'Output window open' : 'Record, export and output window';
            if (this.btn.getAttribute('data-tip') !== tip) {
                this.btn.setAttribute('data-tip', tip);
                UIHelpers.refreshTooltip(this.btn);
            }
        }
        if (this.sb) {
            const parts = [];
            if (rec) parts.push(`<span class="sb-rec-dot"></span>REC <strong>${fmtDuration(rec.elapsedMs / 1000)}</strong> · ${fmtBytes(rec.bytes)}`);
            if (ex) parts.push(`Exporting <strong>${Math.round(ex.progress * 100)}%</strong> · ${ex.frame}/${ex.totalFrames}`);
            if (win) parts.push(`<span class="sb-out-dot"></span>Output <strong>${win.fps || '--'}</strong> fps${m.performanceActive ? ' · perf' : ''}`);
            const html = parts.join('<span class="sb-sep"></span>');
            if (this.sb.dataset.html !== html) {
                this.sb.dataset.html = html;
                this.sb.innerHTML = html;
            }
            this.sb.hidden = !parts.length;
            this.sb.classList.toggle('is-recording', !!rec);
        }
        if (this.pop && !this.pop.closed) this.renderPopover(false);
    }

    // ------------------------------------------------------------------
    // Popover
    // ------------------------------------------------------------------

    toggle(anchor = this.btn) {
        if (this.pop && !this.pop.closed) { this.pop.close(); return; }
        this.formats.realtime = recorderFormats();
        this.els = {};
        const content = h('div', { className: 'op' });
        this.root = content;
        this.pop = UIHelpers.openMenu({
            anchor,
            content,
            align: 'end',
            className: 'pt-output-pop',
            onClose: () => { this.pop = null; this.root = null; }
        });
        this.renderPopover(true);
    }

    renderPopover(full = false) {
        if (!this.pop || this.pop.closed || !this.root) return;
        const active = this.root.ownerDocument.activeElement;
        // don't rebuild under the user's typing (number fields)
        const typing = active && this.root.contains(active) && active.tagName === 'INPUT' && (active.type === 'number' || active.type === 'text');
        if (full && !typing) this.build();
        this.update();
    }

    build() {
        const m = this.manager;
        const s = m.settings;
        const root = this.root;
        root.innerHTML = '';
        const els = this.els = {};

        els.status = h('span', { className: 'op-status' });
        root.appendChild(h('div', { className: 'op-head' }, [h('span', { className: 'pt-label', text: 'Output' }), els.status]));

        // Source
        const nodes = m.previewNodes();
        const main = m.resolveSource('main');
        const srcOptions = [{ value: 'main', label: main ? `Main · ${m.sourceLabel(main)}` : 'Main (no Preview yet)' }]
            .concat(nodes.map(n => ({ value: n.id, label: m.sourceLabel(n) })));
        root.appendChild(row('Source', select(srcOptions, nodes.some(n => String(n.id) === String(s.source)) ? s.source : 'main', (v) => {
            m.setSettings({ source: v });
            m.setWindowSource(v);
        })));

        // ---------------- Record
        root.appendChild(h('div', { className: 'op-sec' }, [h('span', { className: 'pt-label', text: 'Record' })]));
        const seg = h('div', { className: 'op-seg', role: 'radiogroup' });
        for (const [id, label, tip] of [['realtime', 'Real-time', 'MediaRecorder: records what plays, with audio'], ['offline', 'Offline · perfect', 'Frame by frame at a fixed timestep: smooth even for heavy patches']]) {
            const b = h('button', { className: `op-seg-btn${s.mode === id ? ' is-active' : ''}`, role: 'radio', 'data-tip': tip, text: label, onClick: () => m.setSettings({ mode: id }) });
            seg.appendChild(b);
        }
        root.appendChild(seg);

        const node = m.resolveSource();
        const [pw, ph] = m.previewSize(node);
        const resOptions = RESOLUTIONS.map(r => ({ value: r.id, label: r.id === 'preview' ? `Preview size (${pw}×${ph})` : r.w ? `${r.label} · ${r.w}×${r.h}` : r.label }));
        const resRow = row('Size', select(resOptions, s.resolution, (v) => m.setSettings({ resolution: v })));
        if (s.resolution === 'custom') {
            const wIn = h('input', { className: 'pt-input pt-input--mono op-num', type: 'number', min: '16', max: '8192', step: '2', value: String(s.width), 'aria-label': 'Width' });
            const hIn = h('input', { className: 'pt-input pt-input--mono op-num', type: 'number', min: '16', max: '8192', step: '2', value: String(s.height), 'aria-label': 'Height' });
            const apply = () => m.setSettings({ width: Number(wIn.value) || 1920, height: Number(hIn.value) || 1080 });
            wIn.addEventListener('change', apply);
            hIn.addEventListener('change', apply);
            resRow.appendChild(h('span', { className: 'op-custom' }, [wIn, h('span', { className: 'op-x', text: '×' }), hIn]));
        }
        root.appendChild(resRow);

        const [w, hgt] = m.resolveSize({}, node);
        const auto = autoBitrate(w, hgt, s.fps, s.mode === 'offline');
        const brOptions = [{ value: 0, label: `Auto · ${(auto / 1e6).toFixed(auto < 1e7 ? 1 : 0)} Mbps` }]
            .concat([4, 8, 16, 32, 64, 100].map(v => ({ value: v * 1e6, label: `${v} Mbps` })));
        root.appendChild(h('div', { className: 'op-row op-row--split' }, [
            h('span', { className: 'op-row-label', text: 'FPS' }),
            select(FPS_OPTIONS.map(v => ({ value: v, label: `${v}` })), s.fps, (v) => m.setSettings({ fps: Number(v) }), { className: 'op-select op-select--sm' }),
            h('span', { className: 'op-row-label op-row-label--inline', text: 'Bitrate' }),
            select(brOptions, s.bitrate || 0, (v) => m.setSettings({ bitrate: Number(v) }))
        ]));

        if (s.mode === 'realtime') {
            const rf = this.formats.realtime;
            root.appendChild(row('Format', select([
                { value: 'webm', label: `WebM · VP9/VP8${rf.webm ? '' : ' (unsupported)'}`, disabled: !rf.webm },
                { value: 'mp4', label: `MP4 · H.264${rf.mp4 ? '' : ' (unsupported)'}`, disabled: !rf.mp4 }
            ], s.format === 'mp4' && rf.mp4 ? 'mp4' : 'webm', (v) => m.setSettings({ format: v }))));
            const src = RealtimeRecorder.audioSource();
            const cb = h('input', { type: 'checkbox', className: 'op-check', checked: !!s.audio, disabled: !src });
            cb.addEventListener('change', () => m.setSettings({ audio: cb.checked }));
            root.appendChild(row('Audio', h('label', { className: 'op-check-label' }, [cb, h('span', { text: src ? `Include ${src.label}` : 'No audio source playing (file, tab or mic)' })])));
        } else {
            const of = this.formats.offline;
            const fmt = of ? [
                { value: 'mp4', label: `MP4 · H.264${of.mp4 ? '' : ' (unsupported)'}`, disabled: !of.mp4 },
                { value: 'webm', label: `WebM · VP9${of.webm ? '' : ' (unsupported)'}`, disabled: !of.webm },
                { value: 'png', label: 'PNG sequence (.zip)' },
                { value: 'folder', label: `PNG sequence → folder${of.folder ? '' : ' (unsupported)'}`, disabled: !of.folder }
            ] : [{ value: s.offlineFormat, label: 'Checking encoders…' }];
            root.appendChild(row('Format', select(fmt, s.offlineFormat, (v) => m.setSettings({ offlineFormat: v }))));
            const dur = h('input', { className: 'pt-input pt-input--mono op-num', type: 'number', min: '0.1', max: '3600', step: '0.5', value: String(s.duration), 'aria-label': 'Duration (seconds)' });
            dur.addEventListener('change', () => m.setSettings({ duration: Math.max(0.1, Number(dur.value) || 10) }));
            const cb = h('input', { type: 'checkbox', className: 'op-check', checked: !!s.fromStart });
            cb.addEventListener('change', () => m.setSettings({ fromStart: cb.checked }));
            root.appendChild(h('div', { className: 'op-row' }, [
                h('span', { className: 'op-row-label', text: 'Length' }), dur, h('span', { className: 'op-unit', text: 'sec' }),
                h('label', { className: 'op-check-label', 'data-tip': 'Start at u_time = 0 with cleared Feedback buffers (reproducible)' }, [cb, h('span', { text: 'From 0:00' })])
            ]));
            root.appendChild(h('div', { className: 'op-note', text: 'Rendered frame by frame, slower than real time. Live audio is not analysed offline: use the metronome (Audio › Metro) for beat-driven patches, otherwise audio uniforms are 0.' }));
            // JS randomness and the mouse are pinned (reproducible); live inputs are not
            const live = liveInputs(this.app && this.app.nodeGraph);
            if (live.length) {
                root.appendChild(h('div', { className: 'op-note op-note--live', text: `Live inputs stay live: ${live.join(', ')} follow${live.length === 1 ? 's' : ''} what happens while the frames render, so two exports can differ. Math.random in JS nodes is seeded and the mouse is held where it is when the export starts.` }));
            }
        }

        els.recBtn = h('button', { className: 'pt-btn op-rec-btn', onClick: () => this.onRecordClick() });
        els.progress = h('div', { className: 'op-progress', hidden: true }, [h('span', { className: 'op-progress-fill' })]);
        root.appendChild(els.recBtn);
        root.appendChild(els.progress);
        els.last = h('div', { className: 'op-last', hidden: true });
        root.appendChild(els.last);

        // ---------------- Output window
        root.appendChild(h('div', { className: 'op-sec' }, [h('span', { className: 'pt-label', text: 'Output window' })]));
        els.winBtn = h('button', { className: 'pt-btn op-win-btn', onClick: () => this.onWindowClick() });
        const scr = this.screens;
        const dispOptions = [{ value: 'current', label: 'Next to this window' }];
        if (scr && scr.granted) scr.screens.forEach(sc => dispOptions.push({ value: String(sc.index), label: `${sc.label} · ${sc.width}×${sc.height}${sc.primary ? ' (main)' : ''}` }));
        const dispSel = select(dispOptions, dispOptions.some(o => o.value === String(s.display)) ? s.display : 'current', async (v) => {
            m.setSettings({ display: v });
            if (m.window && !m.window.closed && v !== 'current') {
                try { await m.window.moveToDisplay(Number(v), { fullscreen: true }); } catch (e) { UIHelpers.toast(e.message, 'error', { title: 'Could not move the window' }); }
            }
        });
        const dispRow = row('Display', dispSel);
        if (scr && scr.supported && !scr.granted) {
            dispRow.appendChild(h('button', {
                className: 'pt-btn pt-btn--sm', text: scr.state === 'denied' ? 'Blocked' : 'Detect',
                disabled: scr.state === 'denied',
                'data-tip': scr.state === 'denied' ? 'Window management is blocked for this site (site settings)' : 'Allow window management to place the output on another display',
                onClick: async () => {
                    this.screens = await getScreens({ request: true });
                    if (!this.screens.granted) UIHelpers.toast('Permission not granted: drag the output window to the display instead.', 'info', { title: 'Displays' });
                    this.renderPopover(true);
                }
            }));
        }
        root.appendChild(els.winBtn);
        root.appendChild(dispRow);
        if (scr && !scr.supported) root.appendChild(h('div', { className: 'op-note', text: 'This browser cannot place windows on other displays: drag the output window to the projector, then double-click it (or press F) for fullscreen.' }));

        const perf = h('input', { type: 'checkbox', className: 'op-check', checked: !!s.performanceMode });
        perf.addEventListener('change', () => m.setSettings({ performanceMode: perf.checked }));
        root.appendChild(h('label', { className: 'op-check-label op-check-row', 'data-tip': 'All the GPU goes to the output: the node editor, its previews and the background stop drawing' }, [perf, h('span', { text: 'Performance mode — pause the editor while the output window is open' })]));

        els.winTools = h('div', { className: 'op-tools' }, [
            h('button', { className: 'pt-btn pt-btn--sm', 'data-tip': 'Keystone, grid warp, edge blend and mask (W in the output window)', onClick: () => { const w = m.window; if (w && !w.closed) { w.setCalibrating(!w.calibrating); w.focus(); } } }, [h('span', { text: 'Calibrate' }), h('kbd', { text: 'W' })]),
            h('button', { className: 'pt-btn pt-btn--sm', 'data-tip': 'Cycle the test pattern: grid, colour bars, white, off (T)', onClick: () => { const w = m.window; if (w && !w.closed) w.cyclePattern(); } }, [h('span', { text: 'Test pattern' }), h('kbd', { text: 'T' })]),
            h('button', { className: 'pt-btn pt-btn--sm', 'data-tip': 'Fullscreen needs a click or F in the output window itself', onClick: () => { const w = m.window; if (w && !w.closed) { w.requestFullscreen(); w.focus(); } } }, [h('span', { text: 'Fullscreen' }), h('kbd', { text: 'F' })])
        ]);
        root.appendChild(els.winTools);
        // ---------------- I/O (src/io/IOPanel.js)
        root.appendChild(h('div', { className: 'op-sec' }, [h('span', { className: 'pt-label', text: 'I/O' }), h('span', { className: 'io-sec-note', text: 'OSC · Serial · MIDI · DMX' })]));
        els.ioDot = h('span', { className: 'io-dot' });
        els.ioText = h('span', { className: 'io-line-text' });
        root.appendChild(h('div', { className: 'op-row io-out-row' }, [els.ioDot, els.ioText, h('button', {
            className: 'pt-btn pt-btn--sm io-open-btn', text: 'I/O settings…', 'data-tip': 'Bridge pairing, permission, allowed destinations, serial ports, MIDI outputs',
            onClick: () => { const a = this.btn || this.sb; if (this.pop) this.pop.close(); this.io.open(a); }
        })]));

        root.appendChild(h('div', { className: 'op-foot', text: 'In the output window: double-click / F fullscreen · W calibration overlay (drag corners, arrows nudge, Shift fine) · T test pattern. Calibration is saved per display with the project.' }));
    }

    update() {
        const m = this.manager;
        const els = this.els;
        if (!els || !els.recBtn) return;
        const rec = m.recorder, ex = m.exporter;
        const win = m.window && !m.window.closed ? m.window : null;
        const s = m.settings;

        let status = 'Idle';
        if (rec) status = `● REC ${fmtDuration(rec.elapsedMs / 1000)} · ${fmtBytes(rec.bytes)}`;
        else if (ex) status = `Exporting ${ex.frame}/${ex.totalFrames}`;
        else if (win) status = `Window · ${win.fps || '--'} fps`;
        if (els.status.textContent !== status) els.status.textContent = status;
        els.status.classList.toggle('is-rec', !!rec);

        // Record button
        const btn = els.recBtn;
        let key, label, icon;
        if (rec) { key = 'stop'; label = `Stop · ${fmtDuration(rec.elapsedMs / 1000)} · ${fmtBytes(rec.bytes)}`; icon = 'stop'; }
        else if (ex) { key = 'cancel'; label = ex.state === 'finishing' ? 'Finishing…' : `Cancel export · ${Math.round(ex.progress * 100)}%`; icon = 'stop'; }
        else if (s.mode === 'offline') { key = 'export'; label = `Export ${s.duration} s frame by frame`; icon = 'record'; }
        else { key = 'record'; label = 'Start recording'; icon = 'record'; }
        if (btn.dataset.key !== key || btn.dataset.label !== label) {
            btn.dataset.key = key;
            btn.dataset.label = label;
            btn.innerHTML = '';
            btn.appendChild(svgIcon(icon));
            btn.appendChild(h('span', { text: label }));
            btn.classList.toggle('is-recording', key === 'stop');
            btn.classList.toggle('is-armed', key === 'record' || key === 'export');
        }
        btn.disabled = !m.resolveSource() && !rec && !ex;

        els.progress.hidden = !ex;
        if (ex) {
            els.progress.firstChild.style.transform = `scaleX(${ex.progress})`;
            const st = ex.status();
            els.progress.dataset.tip = `${st.render_fps} frames/s${st.eta_s !== null ? ` · ${Math.ceil(st.eta_s)} s left` : ''}`;
        }

        const last = m.lastResult;
        els.last.hidden = !last || !!rec || !!ex;
        if (last && els.last.dataset.name !== String(last.filename)) {
            els.last.dataset.name = String(last.filename);
            els.last.innerHTML = '';
            const info = last.blob ? `${last.filename} · ${fmtBytes(last.blob.size)} · ${(last.durationMs / 1000).toFixed(1)} s` : `${last.frames} PNG frames → ${last.folder}`;
            els.last.appendChild(h('span', { className: 'op-last-name', text: info }));
            if (last.blob) els.last.appendChild(h('button', { className: 'pt-btn pt-btn--sm', text: 'Download', onClick: () => m.download(last) }));
        }

        // Window button
        const wkey = win ? 'close' : 'open';
        if (els.winBtn.dataset.key !== wkey) {
            els.winBtn.dataset.key = wkey;
            els.winBtn.innerHTML = '';
            els.winBtn.appendChild(svgIcon('popout'));
            els.winBtn.appendChild(h('span', { text: win ? 'Close output window' : 'Open output window' }));
            els.winBtn.classList.toggle('is-active', !!win);
        }
        els.winTools.classList.toggle('is-disabled', !win);
        if (els.ioDot) {
            const link = ioClient.linkState();
            const t = link.state === 'ok' ? `Active · ${ioClient.stats.oscOut + ioClient.stats.artnetOut + ioClient.stats.serialOut} out · ${ioClient.stats.oscIn + ioClient.stats.serialIn} in` : link.text;
            if (els.ioText.textContent !== t) els.ioText.textContent = t;
            els.ioDot.dataset.state = link.state;
        }
        for (const b of els.winTools.querySelectorAll('button')) b.disabled = !win;
    }

    async onRecordClick() {
        const m = this.manager;
        try {
            if (m.recorder) {
                const r = await m.stopRecording();
                this.app.shell?.activity(`Saved ${r.filename} (${fmtBytes(r.blob.size)})`, { local: true });
            } else if (m.exporter) {
                m.cancelExport();
            } else if (m.settings.mode === 'offline') {
                let dirHandle = null;
                if (m.settings.offlineFormat === 'folder') {
                    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                }
                const r = await m.exportOffline({ dirHandle });
                this.app.shell?.activity(r.blob ? `Exported ${r.filename} · ${r.frames} frames at ${r.render_fps} fps` : `Exported ${r.frames} PNG frames to ${r.folder}`, { local: true });
            } else {
                m.startRecording();
                this.app.shell?.activity('Recording…', { local: true });
            }
        } catch (e) {
            if (e && (e.cancelled || e.name === 'AbortError')) {
                this.app.shell?.activity('Export cancelled', { local: true });
                return;
            }
            console.warn('[output]', e);
            UIHelpers.toast(e.message || String(e), 'error', { title: 'Output' });
        } finally {
            this.renderPopover(true);
        }
    }

    async onWindowClick() {
        const m = this.manager;
        try {
            if (m.window && !m.window.closed) m.closeWindow();
            else {
                const d = m.settings.display;
                await m.openWindow({ display: d !== 'current' ? Number(d) : undefined, fullscreen: d !== 'current' });
            }
        } catch (e) {
            UIHelpers.toast(e.message || String(e), 'error', { title: 'Output window' });
        } finally {
            this.renderPopover(true);
        }
    }
}
