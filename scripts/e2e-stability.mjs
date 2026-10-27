#!/usr/bin/env node
/**
 * Stability regression checks in headless Chrome (private Vite, HMR off, Parameters panel open).
 *
 *   node scripts/e2e-stability.mjs
 *   node scripts/e2e-stability.mjs --app http://127.0.0.1:5281/
 *
 * Covers:
 *   - Delete / Backspace during a cable drag cancel the drag (never delete the source node);
 *     a cable pulled out of an input comes back
 *   - clicking a group-box input port (press + release in place) keeps both cables
 *   - New project goes through the reset path: output calibrations, undo history, uniform
 *     registry, MIDI mapping runtime state, control runtime
 *   - project switch: molten-orbit then prism-drift in one page (prism-drift's Feedback pass
 *     rendered black from molten-orbit's stale live uniforms)
 *   - Camera / ScreenCapture / Microphone enable(): one request for overlapping calls,
 *     disable / delete during the permission prompt stops the late stream, play() failure
 *     stops the stream
 *   - re-selecting the File audio source after Metronome resumes the suspended context
 *   - offline export "from start" twice gives identical frames (stateful Lag in the graph),
 *     a throw during export setup leaves the clock out of manual mode
 *   - no console.log noise (MIDI restore / serialize, uniform updates, copy, project load)
 *   - deferred review fixes: MIDI CC smoothing once per frame (D-A5), NaN / Infinity held and
 *     flagged on control paths and JS outputs (D-B1), main-loop errors with phase + node,
 *     throttled (D-B2), reproducible exports of JS patches (seeded Math.random, pinned
 *     mouse) and Sample probes (C-S1), float field precision (E-m6), Monaco dispose race
 *     (E-m7), overlay editors follow pan / zoom (E-m8), note size on load (E-m9), Video URL
 *     listeners (C-S7), Microphone meter in Metronome mode on a fresh page (D-A4)
 */
import { chromium } from 'playwright-core';
import { startTestVite } from '../tests/lib/vite-server.mjs';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
let APP = argOf('app');
let vite = null;
if (!APP) {
    vite = await startTestVite();
    APP = vite.url;
}

let passes = 0, failures = 0;
function check(cond, label, extra) {
    if (cond) { passes++; console.log(`  ok   ${label}`); }
    else { failures++; console.log(`  FAIL ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 600) : ''}`); }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
    try {
        if (!sessionStorage.getItem('__stab_init')) {
            sessionStorage.setItem('__stab_init', '1');
            localStorage.clear();
            localStorage.setItem('patchtoy_ui_params_open', '1');
        }
    } catch (e) { /* ignore */ }
});
const page = await ctx.newPage();
const errors = [];
const logs = [];
page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'log' && !/^\[vite\]/.test(m.text())) logs.push(m.text());
});
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

const sleep = (ms) => page.waitForTimeout(ms);
const ev = (fn, arg) => page.evaluate(fn, arg);

async function fresh() {
    await ev(() => {
        document.querySelectorAll('.pt-modal-backdrop').forEach(e => e.remove());
        window.toy.createNewProject();
    });
    await sleep(150);
}
async function screenOf(x, y) {
    return ev(([x, y]) => {
        const g = window.toy.nodeGraph;
        const r = g.canvas.getBoundingClientRect();
        return { x: r.left + x * g.zoom + g.panX, y: r.top + y * g.zoom + g.panY };
    }, [x, y]);
}

try {
    await page.goto(APP, { waitUntil: 'load' });
    await page.waitForFunction(() => window.toy && window.toy.nodeGraph && window.toy.history, null, { timeout: 30000 });
    await sleep(800);

    // ------------------------------------------------------------ 1. Delete during a cable drag
    console.log('- Delete / Backspace during a cable drag');
    await fresh();
    await ev(() => {
        const g = window.toy.nodeGraph;
        window.__a = g.addNode('UV', 200, 200);
        window.__p = g.addNode('Preview', 600, 200);
        g.selectionManager.selectedNodes.clear();
        g.selectionManager.selectedNodes.add(window.__a);
        g.render();
    });
    await sleep(200);
    let pos = await ev(() => window.__a.getOutputPortPosition(0));
    let s = await screenOf(pos.x, pos.y);
    await page.mouse.move(s.x, s.y);
    await page.mouse.down();
    await page.mouse.move(s.x + 80, s.y + 30, { steps: 4 });
    check(await ev(() => !!window.toy.nodeGraph.connectingFrom), 'a cable drag is in progress');
    await page.keyboard.press('Delete');
    await sleep(50);
    let st = await ev(() => ({ has: window.toy.nodeGraph.nodes.includes(window.__a), drag: !!window.toy.nodeGraph.connectingFrom }));
    check(st.has && !st.drag, 'Delete during the drag cancels it and keeps the (selected) source node', st);
    await page.mouse.up();
    await sleep(100);
    st = await ev(() => ({ n: window.toy.nodeGraph.nodes.length, c: window.toy.nodeGraph.connections.length }));
    check(st.n === 2 && st.c === 0, 'releasing after the cancel creates nothing', st);

    // Backspace: edits the accessor hint first, cancels once the hint is empty
    await page.mouse.move(s.x, s.y);
    await page.mouse.down();
    await page.mouse.move(s.x + 60, s.y + 20, { steps: 4 });
    await page.keyboard.press('x');
    await page.keyboard.press('Backspace');
    st = await ev(() => ({ hint: window.toy.nodeGraph.swizzleHint, drag: !!window.toy.nodeGraph.connectingFrom, has: window.toy.nodeGraph.nodes.includes(window.__a) }));
    check(st.drag && st.hint === '' && st.has, 'Backspace with an accessor hint edits the hint (drag continues)', st);
    await page.keyboard.press('Backspace');
    st = await ev(() => ({ drag: !!window.toy.nodeGraph.connectingFrom, has: window.toy.nodeGraph.nodes.includes(window.__a) }));
    check(!st.drag && st.has, 'Backspace with no hint cancels the drag, source node kept', st);
    await page.mouse.up();

    // A cable pulled out of an input comes back when the drag is cancelled
    await ev(() => {
        const g = window.toy.nodeGraph;
        g.connections.push(new g.groupCtl.Connection(window.__a, 0, window.__p, 0));
        g.onGraphChanged();
        g.selectionManager.selectedNodes.clear();
        g.render();
    });
    await sleep(200);
    pos = await ev(() => window.__p.getInputPortPosition(0));
    s = await screenOf(pos.x, pos.y);
    await page.mouse.move(s.x, s.y);
    await page.mouse.down();
    await page.mouse.move(s.x - 120, s.y + 60, { steps: 4 });
    check(await ev(() => window.toy.nodeGraph.connections.length) === 0, 'pulling the cable out of the input removes it while dragging');
    await page.keyboard.press('Delete');
    await page.mouse.up();
    await sleep(100);
    st = await ev(() => window.toy.nodeGraph.connections.map(c => `${c.fromNode.id}>${c.toNode.id}.${c.toInput}`));
    check(st.length === 1, 'Delete puts the pulled-out cable back', st);

    // ------------------------------------------------------------ 2. Group box input port click
    console.log('- group box input port: press + release in place');
    await fresh();
    await ev(() => {
        const g = window.toy.nodeGraph;
        const C = g.groupCtl.Connection;
        window.__f1 = g.addNode('Float', 100, 100);
        window.__f2 = g.addNode('Float', 100, 260);
        window.__add = g.addNode('Add', 420, 180);
        window.__pv = g.addNode('Preview', 760, 180);
        g.connections.push(new C(window.__f1, 0, window.__add, 0), new C(window.__f2, 0, window.__add, 1), new C(window.__add, 0, window.__pv, 0));
        g.groupCtl.createGroup({ name: 'Box', nodes: [window.__add], x: 420, y: 180 });
        g.groupCtl.changed?.();
        g.onGraphChanged();
        g.selectionManager.selectedNodes.clear();
        g.render();
    });
    await sleep(400);
    const before = await ev(() => window.toy.nodeGraph.connections.map(c => `${c.fromNode.id}.${c.fromOutput}>${c.toNode.id}.${c.toInput}`).sort());
    const port0 = await ev(() => {
        const g = window.toy.nodeGraph;
        const proxy = g.groupCtl.proxyFor(g.groups[0].id);
        if (!proxy) return null;
        g.groupCtl.viewNodes?.();
        return proxy.getInputPortPosition(0);
    });
    check(!!port0, 'the group box shows input ports', port0);
    if (port0) {
        s = await screenOf(port0.x, port0.y);
        await page.mouse.move(s.x, s.y);
        await page.mouse.down();
        await sleep(60);
        await page.mouse.move(s.x + 2, s.y + 1);
        await page.mouse.up();
        await sleep(200);
        const after = await ev(() => window.toy.nodeGraph.connections.map(c => `${c.fromNode.id}.${c.fromOutput}>${c.toNode.id}.${c.toInput}`).sort());
        check(JSON.stringify(after) === JSON.stringify(before), 'clicking box input port 0 restores its own cable, the other port is untouched', { before, after });
    }

    // ------------------------------------------------------------ 3. New project reset path
    console.log('- New project resets per-project state');
    await fresh();
    await ev(() => {
        const t = window.toy;
        const g = t.nodeGraph;
        window.__u = g.addNode('UV', 100, 100);
        g.onGraphChanged();
        t.output.storeProjectCalibration('test-display', { corners: [[0.1, 0.1], [0.9, 0], [1, 1], [0, 0.9]] });
        g.uniformRegistry.registerUniform('node_999', 'float', 1, window.__u);
    });
    await sleep(700);
    const pre = await ev(() => ({
        cal: Object.keys(window.toy.output.projectOutput.calibrations).length,
        out: !!window.toy.nodeGraph.serialize().output,
    }));
    check(pre.cal === 1 && pre.out, 'calibration stored with the project', pre);
    await ev(async () => {
        const { midiMapper } = await import('/src/services/MidiMapper.js');
        midiMapper.state.set('0:m1', { pickup: true });
        window.toy.createNewProject();
    });
    await sleep(300);
    const post = await ev(async () => {
        const t = window.toy;
        const { midiMapper } = await import('/src/services/MidiMapper.js');
        const { controlRuntime } = await import('/src/core/control/ControlRuntime.js');
        return {
            cal: Object.keys(t.output.projectOutput.calibrations).length,
            out: !!t.nodeGraph.serialize().output,
            undo: t.history.list().undo.length,
            stale: t.nodeGraph.uniformRegistry.hasUniform('node_999'),
            midi: midiMapper.state.size,
            nodes: t.nodeGraph.nodes.length,
            plan: t.nodeGraph._controlPlan ? t.nodeGraph._controlPlan.order.length : 0,
            ctlTime: controlRuntime.lastTime === null || controlRuntime.lastTime >= 0,
            title: t.projectManager.projectTitle,
        };
    });
    check(post.cal === 0 && !post.out, 'New project drops the output calibrations (not saved with the new project)', post);
    check(post.undo === 0, 'New project clears the undo history', post);
    check(!post.stale && post.midi === 0 && post.nodes === 0 && post.plan === 0, 'New project drops live uniforms, MIDI mapping state, control plan', post);

    // Project switch: molten-orbit then prism-drift in the same page
    console.log('- project switch: molten-orbit -> prism-drift');
    const openDemo = (slug) => ev(async (slug) => {
        document.querySelectorAll('.pt-modal-backdrop').forEach(e => e.remove());
        const txt = await (await fetch(`/projects/${slug}.patchtoy.json`)).text();
        const file = new File([txt], `${slug}.patchtoy.json`, { type: 'application/json' });
        const r = await window.toy.openProjectFile(file, { title: slug });
        return !!(r && r.success);
    }, slug);
    check(await openDemo('molten-orbit'), 'molten-orbit opens');
    await sleep(1500);
    check(await openDemo('prism-drift'), 'prism-drift opens');
    await sleep(2500);
    const px = await ev(() => {
        const t = window.toy;
        const gl = t.sharedGL;
        const fb = t.nodeGraph.nodes.find(n => n.id === 65 && n.isFeedbackNode);
        if (!fb || !fb.readBuffer) return null;
        const w = fb.bufferWidth, h = fb.bufferHeight;
        let sum = 0, n = 0;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb.readBuffer.framebuffer);
        const a = new Uint8Array(4);
        for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
            gl.readPixels(Math.floor(w * i / 8), Math.floor(h * j / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
            sum += a[0] + a[1] + a[2]; n++;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const stale = t.nodeGraph.uniformRegistry.getAllUniforms().filter(u => {
            const src = t.nodeGraph.nodes.find(x => x.id === u.sourceNodeId);
            return !src;
        }).map(u => u.name);
        return { mean: sum / (n * 3), stale };
    });
    check(px && px.mean > 20, 'prism-drift Feedback 65 renders (not black) after molten-orbit in the same page', px);
    check(px && px.stale.length === 0, 'no live uniform of the previous project remains', px?.stale);

    // ------------------------------------------------------------ 4. Media enable races
    console.log('- Camera / ScreenCapture / Microphone enable races');
    await fresh();
    const media = await ev(async () => {
        const g = window.toy.nodeGraph;
        const made = [];
        const calls = { user: 0, display: 0 };
        let failPlay = false;
        const fakeStream = () => {
            const c = document.createElement('canvas');
            c.width = c.height = 8;
            c.getContext('2d').fillRect(0, 0, 8, 8);
            const s = c.captureStream(5);
            made.push(s);
            return s;
        };
        const md = navigator.mediaDevices;
        md.getUserMedia = () => { calls.user++; return new Promise(r => setTimeout(() => r(fakeStream()), 250)); };
        md.getDisplayMedia = () => { calls.display++; return new Promise(r => setTimeout(() => r(fakeStream()), 250)); };
        const origPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () { return failPlay ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : Promise.resolve(); };
        const live = () => made.filter(s => s.getTracks().some(t => t.readyState === 'live')).length;
        const out = {};
        try {
            for (const type of ['Camera', 'ScreenCapture']) {
                const key = type === 'Camera' ? 'user' : 'display';
                made.length = 0; calls.user = calls.display = 0;
                const n = g.addNode(type, 100, 100);
                // double enable: one request, same promise
                const p1 = n.enable(), p2 = n.enable();
                const both = await Promise.all([p1, p2]);
                const r = { same: p1 === p2, calls: calls[key], ok: both, liveAfterEnable: live() };
                n.disable(); n.disable(); // idempotent
                r.liveAfterDisable = live();
                // disable during the pending request
                made.length = 0;
                const p3 = n.enable();
                n.disable();
                r.p3 = await p3;
                await new Promise(res => setTimeout(res, 50));
                r.liveAfterCancel = live();
                r.activeAfterCancel = n.isActive;
                // delete (cleanup) during the pending request
                made.length = 0;
                const n2 = g.addNode(type, 300, 100);
                const p4 = n2.enable();
                n2.cleanup();
                r.p4 = await p4;
                r.liveAfterCleanup = live();
                // play() rejects: the stream is stopped
                made.length = 0;
                failPlay = true;
                const n3 = g.addNode(type, 500, 100);
                r.p5 = await n3.enable();
                failPlay = false;
                r.liveAfterPlayFail = live();
                r.streamKept = !!(n3.cameraStream || n3.captureStream);
                out[type] = r;
            }
            // Microphone: the engine's meter is released when the node goes away during the prompt
            const { audioEngine } = await import('/src/services/AudioEngine.js');
            const acq = audioEngine.acquireMicMeter.bind(audioEngine);
            const rel = audioEngine.releaseMicMeter.bind(audioEngine);
            const users = new Set();
            let acquires = 0;
            audioEngine.acquireMicMeter = (u) => { acquires++; return new Promise(r => setTimeout(() => { users.add(u); r(); }, 250)); };
            audioEngine.releaseMicMeter = (u) => { users.delete(u); };
            try {
                const m = g.addNode('Microphone', 100, 300);
                const q1 = m.enable(), q2 = m.enable();
                m.cleanup();
                const res = await Promise.all([q1, q2]);
                out.Microphone = { same: q1 === q2, acquires, res, users: users.size, active: m.isActive };
            } finally {
                audioEngine.acquireMicMeter = acq;
                audioEngine.releaseMicMeter = rel;
            }
        } finally {
            HTMLMediaElement.prototype.play = origPlay;
        }
        return out;
    });
    for (const type of ['Camera', 'ScreenCapture']) {
        const r = media[type];
        check(r && r.same && r.calls === 1 && r.ok.every(Boolean) && r.liveAfterEnable === 1, `${type}: overlapping enable() calls share one request`, r);
        check(r && r.liveAfterDisable === 0, `${type}: disable() stops the tracks (idempotent)`, r);
        check(r && r.p3 === false && r.liveAfterCancel === 0 && !r.activeAfterCancel, `${type}: disable during the pending request stops the late stream`, r);
        check(r && r.p4 === false && r.liveAfterCleanup === 0, `${type}: deleting the node during the prompt stops the late stream`, r);
        check(r && r.p5 === false && r.liveAfterPlayFail === 0 && !r.streamKept, `${type}: a play() failure stops the stream`, r);
    }
    check(media.Microphone && media.Microphone.same && media.Microphone.acquires === 1 && media.Microphone.users === 0 && !media.Microphone.active,
        'Microphone: one meter request, released when the node is deleted during the prompt', media.Microphone);

    // ------------------------------------------------------------ 5. File audio source re-select
    console.log('- File audio source after Metronome');
    const audio = await ev(async () => {
        const { audioEngine } = await import('/src/services/AudioEngine.js');
        // 1 s 440 Hz mono WAV
        const sr = 22050, n = sr;
        const buf = new ArrayBuffer(44 + n * 2);
        const v = new DataView(buf);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        w(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / sr * 2 * Math.PI * 440) * 8000, true);
        const file = new File([buf], 'tone.wav', { type: 'audio/wav' });
        await audioEngine.loadFile(file, { play: true });
        if (audioEngine.file.el) audioEngine.file.el.loop = true;
        await audioEngine.setSource('metronome', { bpm: 120 });
        await new Promise(r => setTimeout(r, 400));
        const suspended = audioEngine.ctx.state;
        await audioEngine.setSource('file', { play: true });
        await new Promise(r => setTimeout(r, 300));
        const out = { suspended, state: audioEngine.ctx.state, playing: !audioEngine.file.el.paused, source: audioEngine.source };
        await audioEngine.setSource('metronome', { bpm: 120 });
        return out;
    });
    check(audio.suspended === 'suspended', 'Metronome suspends the idle audio context', audio);
    check(audio.state === 'running' && audio.playing && audio.source === 'file', 're-selecting File resumes the context and plays (not silent)', audio);

    const micAuto = await ev(async () => {
        const { audioEngine } = await import('/src/services/AudioEngine.js');
        await audioEngine.setSource('off');
        const ac = new AudioContext();
        const osc = ac.createOscillator();
        const dest = ac.createMediaStreamDestination();
        osc.connect(dest); osc.start();
        const md = navigator.mediaDevices;
        const orig = md.getUserMedia;
        md.getUserMedia = async () => dest.stream.clone();
        try {
            const g = window.toy.nodeGraph;
            const m = g.addNode('Microphone', 100, 500);
            const ok = await m.enable();
            const during = audioEngine.source;
            const stream = audioEngine.mic.stream;
            m.cleanup();
            await new Promise(r => setTimeout(r, 200));
            const out = { ok, during, after: audioEngine.source, ended: stream ? stream.getTracks().every(t => t.readyState === 'ended') : null };
            g.nodes = g.nodes.filter(n => n !== m);
            return out;
        } finally {
            md.getUserMedia = orig;
            osc.stop(); ac.close();
        }
    });
    check(micAuto.ok && micAuto.during === 'mic' && micAuto.after === 'off' && micAuto.ended === true,
        'deleting the last Microphone node turns the automatically picked mic source off (tracks stopped)', micAuto);
    await ev(async () => { const { audioEngine } = await import('/src/services/AudioEngine.js'); await audioEngine.setSource('metronome', { bpm: 120 }); });

    // ------------------------------------------------------------ 6. Offline export reproducible
    console.log('- offline export "from start" is reproducible');
    await fresh();
    const pvId = await ev(() => {
        const g = window.toy.nodeGraph;
        const C = g.groupCtl.Connection;
        const time = g.addNode('Time', 100, 100);
        const lag = g.addNode('Lag', 300, 100);
        const fr = g.addNode('Fract', 500, 100);
        const mk = g.addNode('MakeVec3', 650, 100);
        const pv = g.addNode('Preview', 850, 100);
        lag.data.up = 3; lag.data.down = 3;
        g.connections.push(new C(time, 0, lag, 0), new C(lag, 0, fr, 0), new C(fr, 0, mk, 0), new C(mk, 0, pv, 0));
        g.onGraphChanged();
        return pv.id;
    });
    await sleep(1200);
    const exportOnce = () => ev(async (id) => {
        const r = await window.toy.output.exportOffline({ preview_id: id, width: 32, height: 24, fps: 30, duration: 0.5, format: 'png', fromStart: true, download: false });
        const bytes = new Uint8Array(await r.blob.arrayBuffer());
        const d = await crypto.subtle.digest('SHA-256', bytes);
        return { hash: Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join(''), frames: r.frames, manual: (await import('/src/core/Clock.js')).clock.manual };
    }, pvId);
    const e1 = await exportOnce();
    await sleep(1500); // the live show runs on: the Lag's live state moves
    const e2 = await exportOnce();
    check(e1.frames === 15 && e2.frames === 15 && !e1.manual && !e2.manual, 'two offline exports ran (15 frames each), clock back to real time', { e1, e2 });
    check(e1.hash === e2.hash, 'exporting the same project twice gives identical frames', { e1: e1.hash, e2: e2.hash });
    const thrown = await ev(async (id) => {
        const m = window.toy.output;
        const orig = m.suspendEditor;
        m.suspendEditor = () => { throw new Error('boom'); };
        let msg = null;
        try { await m.exportOffline({ preview_id: id, width: 16, height: 16, fps: 10, duration: 0.2, format: 'png', download: false }); } catch (e) { msg = e.message; } finally { m.suspendEditor = orig; }
        const { clock } = await import('/src/core/Clock.js');
        const t0 = clock.time;
        await new Promise(r => setTimeout(r, 300));
        return { msg, manual: clock.manual, advances: clock.time > t0 };
    }, pvId);
    check(thrown.msg === 'boom' && !thrown.manual && thrown.advances, 'a throw in the export setup leaves the clock running (not stuck in manual mode)', thrown);

    // ------------------------------------------------------------ cleanup items
    console.log('- copy / paste, ghost nodes, colour cache, editor listeners');
    await fresh();
    const paste = await ev(() => {
        const g = window.toy.nodeGraph;
        const a = g.addNode('ForLoopStart', 100, 100);
        const b = g.addNode('ForLoopEnd', 400, 100);
        a.data.pairNodeId = b.id; b.data.pairNodeId = a.id;
        g.selectionManager.selectedNodes.clear();
        g.selectionManager.selectedNodes.add(a); g.selectionManager.selectedNodes.add(b);
        g.copySelectedNodes();
        g.pasteNodes();
        const [pa, pb] = [...g.selectionManager.selectedNodes];
        const ps = pa.isForLoopStartNode ? pa : pb, pe = pa.isForLoopStartNode ? pb : pa;
        ps.data.varTypes.push('vec2');
        // a lone Start copied without its End must not point at the original End
        g.selectionManager.selectedNodes.clear(); g.selectionManager.selectedNodes.add(a);
        g.copySelectedNodes(); g.pasteNodes();
        const lone = [...g.selectionManager.selectedNodes][0];
        // a clipboard node whose type no longer exists is skipped
        g.clipboard = { groups: [], nodes: [{ id: 999, type: 'NoSuchType', x: 0, y: 0, data: {} }], connections: [] };
        let threw = null;
        const n0 = g.nodes.length;
        try { g.pasteNodes(); } catch (e) { threw = e.message; }
        return {
            pairs: ps.data.pairNodeId === pe.id && pe.data.pairNodeId === ps.id,
            shared: a.data.varTypes === ps.data.varTypes, origTypes: a.data.varTypes.slice(),
            lonePair: lone.data.pairNodeId, threw, added: g.nodes.length - n0,
        };
    });
    check(paste.pairs && paste.lonePair === null, 'pasted ForLoop pair points at its pasted partner (a lone copy at none)', paste);
    check(!paste.shared && paste.origTypes.length === 1, 'pasted nodes do not share nested data with the original', paste);
    check(paste.threw === null && paste.added === 0, 'pasting an unknown node type skips it (no TypeError)', paste);
    const misc = await ev(async () => {
        const { withAlpha } = await import('/src/rendering/NodePainter.js');
        const t0 = performance.now();
        for (let i = 0; i < 5000; i++) withAlpha('#336699', 0.1 + 0.2 * Math.sin(i / 7) + i * 1e-7);
        const distinct = new Set();
        for (let i = 0; i < 5000; i++) distinct.add(withAlpha('#336699', 0.1 + 0.2 * Math.sin(i / 7) + i * 1e-7));
        // FloatingCodeEditor: open / close leaves no document listeners
        const { FloatingCodeEditor } = await import('/src/ui/FloatingCodeEditor.js');
        let added = 0;
        const add = document.addEventListener, rem = document.removeEventListener;
        document.addEventListener = function (...a) { added++; return add.apply(this, a); };
        document.removeEventListener = function (...a) { added--; return rem.apply(this, a); };
        try {
            for (let i = 0; i < 3; i++) new FloatingCodeEditor({ title: 't', value: 'x', readOnly: true }).close();
        } finally {
            document.addEventListener = add;
            document.removeEventListener = rem;
        }
        // Ghost node replaced by another ghost: the first one is released
        const q = window.toy.nodeGraph.quickNodeSearch;
        let released = false;
        window.toy.nodeGraph.createGhostNode('UV');
        const first = q.ghostNode;
        const orig = first.cleanup;
        first.cleanup = function () { released = true; return orig && orig.apply(this, arguments); };
        window.toy.nodeGraph.createGhostNode('Float');
        q.cancelGhostNode();
        return { distinct: distinct.size, ms: performance.now() - t0, listeners: added, released };
    });
    const rec = await ev(async () => {
        const g = window.toy.nodeGraph;
        const pv = g.addNode('Preview', 900, 500);
        const streams = [];
        const cap = HTMLCanvasElement.prototype.captureStream;
        HTMLCanvasElement.prototype.captureStream = function (...a) { const st = cap.apply(this, a); streams.push(st); return st; };
        const MR = window.MediaRecorder;
        window.MediaRecorder = class extends MR { constructor() { throw new DOMException('nope', 'NotSupportedError'); } };
        window.MediaRecorder.isTypeSupported = MR.isTypeSupported.bind(MR);
        let msg = null;
        try { window.toy.output.startRecording({ preview_id: pv.id, width: 64, height: 36, format: 'webm' }); } catch (e) { msg = e.name; }
        finally { window.MediaRecorder = MR; HTMLCanvasElement.prototype.captureStream = cap; }
        return { msg, streams: streams.length, live: streams.filter(st => st.getTracks().some(t => t.readyState === 'live')).length, busy: window.toy.output.isBusy() };
    });
    check(rec.msg === 'NotSupportedError' && rec.streams > 0 && rec.live === 0 && !rec.busy, 'a recorder start failure stops its streams and leaves the output idle', rec);
    check(misc.distinct <= 1001, 'animated alphas share a bounded colour cache', misc);
    check(misc.listeners === 0, 'code editor windows leave no document listeners after close', misc);
    check(misc.released, 'a replaced ghost node is cleaned up', misc);

    // ------------------------------------------------------------ 8. deferred review fixes
    console.log('- MIDI CC smoothing once per frame (D-A5)');
    await fresh();
    const midi = await ev(async () => {
        const g = window.toy.nodeGraph;
        const { clock } = await import('/src/core/Clock.js');
        const one = g.addNode('MIDI CC', 100, 100), five = g.addNode('MIDI CC', 100, 250);
        for (const n of [one, five]) { n.data.smoothing = 0.9; n.getValue(); n.rawValue = 1; }
        const t0 = clock.elapsedMs;
        await new Promise(res => {
            const step = () => {
                one.getValue();
                for (let i = 0; i < 5; i++) five.getValue(); // preview + background + feedback + control...
                if (clock.elapsedMs - t0 < 400) requestAnimationFrame(step); else res();
            };
            requestAnimationFrame(step);
        });
        const ms = clock.elapsedMs - t0;
        return { one: one.getValue(), five: five.getValue(), expected: 1 - Math.pow(0.9, ms / (1000 / 60)), ms };
    });
    check(Math.abs(midi.one - midi.five) < 1e-9, 'MIDI CC smoothing is the same with 1 or 5 readers per frame', midi);
    check(Math.abs(midi.one - midi.expected) < 1e-6, 'MIDI CC smoothing follows the frame time (smoothing ^ (dt / 16.7 ms))', midi);

    console.log('- NaN / Infinity on control paths (D-B1)');
    await fresh();
    const nan = await ev(async () => {
        const g = window.toy.nodeGraph;
        const C = g.groupCtl.Connection;
        const a = g.addNode('Float', 100, 100), b = g.addNode('Float', 100, 250);
        a.data.value = 1; b.data.value = 0;
        const div = g.addNode('Divide', 300, 150), lag = g.addNode('Lag', 500, 150);
        const mk = g.addNode('MakeVec3', 700, 150), pv = g.addNode('Preview', 900, 150);
        g.connections.push(new C(a, 0, div, 0), new C(b, 0, div, 1), new C(div, 0, lag, 0), new C(lag, 0, mk, 0), new C(mk, 0, pv, 0));
        g.onGraphChanged();
        await new Promise(r => setTimeout(r, 1200));
        const finite = (v) => (Array.isArray(v) ? v.every(Number.isFinite) : typeof v !== 'number' || Number.isFinite(v));
        const uniforms = g.uniformRegistry.getAllUniforms().filter(u => /_c\d+$/.test(u.name));
        const during = {
            kind: g._controlPlan && g._controlPlan.kindOf(div), err: div._ctlError, red: div.isInErrorState(),
            lag: JSON.stringify(lag._ctlOut), lagFinite: finite(lag._ctlOut && lag._ctlOut[0]), lagErr: lag._ctlError,
            uniformsFinite: uniforms.length > 0 && uniforms.every(u => finite(u.value))
        };
        b.data.value = 2;
        g.onGraphChanged();
        await new Promise(r => setTimeout(r, 2200));
        // A JS node returning NaN: sent as 0, the node shows it
        const { jsRuntime } = await import('/src/nodes/jsRuntime.js');
        const js = g.addNode('JS', 100, 450);
        js.data.setupCode = '';
        js.data.code = 'return { out: Math.log(-1) };';
        jsRuntime.trustNode(js, { persist: false });
        await new Promise(r => setTimeout(r, 600));
        const jv = js.values && js.values.get('out');
        return { during, after: { err: div._ctlError, red: div.isInErrorState(), lag: lag._ctlOut && lag._ctlOut[0] }, js: { err: js.jsError, value: jv && jv.value, red: js.isInErrorState() } };
    });
    check(nan.during.kind === 'infer' && /NaN \/ Infinity/.test(nan.during.err || '') && nan.during.red, 'a control-rate division by zero flags the Divide node (error + red outline)', nan.during);
    check(nan.during.lagFinite && !nan.during.lagErr && nan.during.uniformsFinite, 'the Infinity never reaches the Lag downstream or a uniform', nan.during);
    check(nan.after.err === null && !nan.after.red && Math.abs(nan.after.lag - 0.5) < 0.05, 'fixing the input clears the error and the Lag follows again (state not stuck at NaN)', nan.after);
    check(/NaN \/ Infinity/.test(nan.js.err || '') && nan.js.value === 0 && nan.js.red, 'a JS node returning NaN sends 0 and shows the error', nan.js);

    console.log('- main loop errors name the phase and the node (D-B2)');
    await fresh();
    const loopErr = await ev(async () => {
        const g = window.toy.nodeGraph;
        const fb = g.addNode('Feedback', 100, 100);
        g.onGraphChanged();
        await new Promise(r => setTimeout(r, 400));
        const orig = fb.initBuffers;
        fb.initBuffers = () => { throw new Error('stab-boom-fb'); };
        const warns = [];
        const w = console.warn;
        console.warn = (...a) => { warns.push(String(a[0])); };
        try { await new Promise(r => setTimeout(r, 1000)); } finally { console.warn = w; fb.initBuffers = orig; }
        const e = window.toy.loopErrors.list().find(x => x.message === 'stab-boom-fb');
        return { e, id: fb.id, warns: warns.filter(x => /stab-boom-fb/.test(x)) };
    });
    check(loopErr.e && loopErr.e.phase === 'feedback' && loopErr.e.node_id === loopErr.id && loopErr.e.node_type === 'Feedback' && loopErr.e.count > 10,
        'a throwing Feedback pass is reported with its phase and node', loopErr.e);
    check(loopErr.warns.length === 1 && /feedback failed at node #\d+ \(Feedback\)/.test(loopErr.warns[0]), 'the report is throttled (one warning for ~60 failing frames)', loopErr.warns);

    console.log('- offline export: JS random + mouse pinned, Sample probes read synchronously (C-S1)');
    await fresh();
    const jsPv = await ev(async () => {
        const g = window.toy.nodeGraph;
        const C = g.groupCtl.Connection;
        const { jsRuntime } = await import('/src/nodes/jsRuntime.js');
        const js = g.addNode('JS', 100, 100);
        js.data.code = 'return { out: vec3(Math.random(), mouse[0], time % 1) };'; // (default setup code kept: async)
        jsRuntime.trustNode(js, { persist: false });
        const pv = g.addNode('Preview', 500, 100);
        g.onGraphChanged();
        await new Promise(r => setTimeout(r, 1200));
        g.connections.push(new C(js, 0, pv, 0));
        g.onGraphChanged();
        await new Promise(r => setTimeout(r, 800));
        return { id: pv.id, out: js.outputs.map(o => o.type).join(',') };
    });
    const exportJiggled = (id, extra = {}) => ev(async ([id, extra]) => {
        const { ShaderPreview: SP } = await import('/src/rendering/ShaderPreview.js');
        SP.mouseX = 0.3; SP.mouseY = 0.6;
        // the mouse moves and other page code draws random numbers while the export runs
        const jiggle = setInterval(() => { SP.mouseX = Math.random(); SP.mouseY = Math.random(); }, 3);
        let r;
        try { r = await window.toy.output.exportOffline({ preview_id: id, width: 32, height: 24, fps: 30, duration: 0.5, format: 'png', fromStart: true, download: false, ...extra }); } finally { clearInterval(jiggle); }
        const d = await crypto.subtle.digest('SHA-256', new Uint8Array(await r.blob.arrayBuffer()));
        const probes = window.toy.compilationManager.probes;
        return { hash: Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join(''), seed: r.seed, live: r.live_inputs || null, sync: probes ? probes.stats.sync_reads : 0, randomRestored: !/0x6D2B79F5|mulberry/i.test(String(Math.random)) };
    }, [id, extra]);
    const j1 = await exportJiggled(jsPv.id);
    const j2 = await exportJiggled(jsPv.id);
    const j3 = await exportJiggled(jsPv.id, { seed: 7 });
    check(jsPv.out === 'vec3' && j1.hash === j2.hash, 'two exports of a JS patch (Math.random, mouse) give identical frames', { jsPv, j1: j1.hash, j2: j2.hash });
    check(j3.hash !== j1.hash && j3.seed === 7 && j1.seed === 1, 'the export seed changes the random sequence', { j1: j1.seed, j3: j3.seed });
    check(j1.randomRestored, 'Math.random is the page\'s own again after the export');
    await fresh();
    const samplePv = await ev(async () => {
        const g = window.toy.nodeGraph;
        const C = g.groupCtl.Connection;
        const uv = g.addNode('UV', 100, 100), time = g.addNode('Time', 100, 250);
        const mul = g.addNode('Multiply', 300, 150), fr = g.addNode('Fract', 450, 150), s = g.addNode('Sample', 600, 150);
        const lag = g.addNode('Lag', 800, 150), mk = g.addNode('MakeVec3', 950, 150), pv = g.addNode('Preview', 1100, 150);
        lag.data.up = 0.05; lag.data.down = 0.05;
        g.connections.push(new C(uv, 0, mul, 0), new C(time, 0, mul, 1), new C(mul, 0, fr, 0), new C(fr, 0, s, 0), new C(s, 1, lag, 0), new C(lag, 0, mk, 0), new C(mk, 0, pv, 0));
        g.onGraphChanged();
        await new Promise(r => setTimeout(r, 1500));
        return pv.id;
    });
    const s1 = await exportJiggled(samplePv);
    await sleep(700); // the live Sample value moves on
    const s2 = await exportJiggled(samplePv);
    check(s1.hash === s2.hash, 'two exports of a Sample-driven patch give identical frames', { s1: s1.hash, s2: s2.hash });
    check(s2.sync - s1.sync >= 15, 'during the export Sample probes are read back synchronously (one per frame)', { s1: s1.sync, s2: s2.sync });

    console.log('- canvas fields, code editor, overlays, notes, Video URL (E-m6..m9, C-S7)');
    await fresh();
    const ui = await ev(async () => {
        const out = {};
        const { CanvasTextInput } = await import('/src/rendering/CanvasTextInput.js');
        const t = new CanvasTextInput(0, 0, 50, 20, String(0.0035), 'float');
        const calls = [];
        t.onChange = (v) => calls.push(v);
        t.focus(); t.handleKeyDown({ key: 'Enter', preventDefault() { } });
        t.focus(); t.handleKeyDown({ key: 'Enter', preventDefault() { } });
        out.text = { value: t.value, calls: calls.slice() };
        t.focus(); t.value = '0.00125'; t.blur();
        out.text.edited = { value: t.value, calls: calls.slice() };

        // Code editor closed before Monaco arrived: no editor is created afterwards
        const { CodeEditor } = await import('/src/ui/CodeEditor.js');
        const real = window.monaco;
        delete window.monaco;
        let created = 0;
        const fake = { editor: { create: () => ({ onDidChangeModelContent() { }, dispose() { }, getModel: () => null }), defineTheme() { } }, languages: { getLanguages: () => [{ id: 'glsl' }], register() { }, setMonarchTokensProvider() { } } };
        const ed = new CodeEditor({ language: 'glsl', value: 'x' });
        const host = document.createElement('div');
        document.body.appendChild(host);
        ed.mount(host);
        ed.dispose();
        host.remove();
        window.monaco = real || fake;
        const m = window.monaco;
        const create = m.editor.create;
        m.editor.create = (...a) => { created++; return create.apply(m.editor, a); };
        try {
            ed.onMonacoReady(); // the loader promise resolving late
            await new Promise(r => setTimeout(r, 1200)); // the mount's upgrade timer
        } finally {
            m.editor.create = create;
            if (!real) delete window.monaco;
        }
        out.monaco = { created, container: ed.container };

        // Note size restored on load; its editor follows pan; deleting while editing drops it
        const g = window.toy.nodeGraph;
        const c = g.addNode('Comment', 100, 100);
        c.data.width = 420; c.data.height = 300; c.data.text = 'hello';
        g.deserialize(g.serialize());
        const c2 = g.nodes.find(n => n.isCommentNode);
        out.note = { size: [c2.width, c2.height] };
        c2.beginEdit(g.canvas, () => { });
        const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await frames();
        const ta = document.querySelector('.pt-comment-editor');
        const x0 = ta.getBoundingClientRect().left;
        g.panX += 120; g.render();
        await frames();
        out.note.moved = Math.round(ta.getBoundingClientRect().left - x0);
        ta.value = 'typed into a deleted note';
        g.selectionManager.selectedNodes.clear(); g.selectionManager.selectedNodes.add(c2);
        g.deleteSelectedNodes();
        await new Promise(r => setTimeout(r, 50));
        out.note.gone = !document.querySelector('.pt-comment-editor');
        out.note.text = c2.data.text;

        // Group rename input follows pan / zoom
        const uvn = g.addNode('UV', 200, 200);
        const grp = g.groupCtl.createGroup({ name: 'Box', nodes: [uvn], x: 420, y: 180 });
        g.render();
        await frames();
        g.groupCtl.ui.beginRename(grp && grp.id !== undefined ? grp.id : grp);
        const ren = document.querySelector('.pt-group-rename');
        const r0 = ren && ren.getBoundingClientRect();
        g.zoom = 1.5; g.panX -= 50; g.render();
        await frames();
        const r1 = ren && ren.getBoundingClientRect();
        if (ren) ren.blur();
        g.zoom = 1; g.panX = 0; g.panY = 0;
        out.rename = { has: !!ren, dx: r0 && r1 ? Math.round(r1.left - r0.left) : 0, dw: r0 && r1 ? Math.round(r1.width - r0.width) : 0, gone: !document.querySelector('.pt-group-rename'), overlays: g.overlays ? g.overlays.size : 0 };

        // Video URL: listeners of every load removed, no 'Failed to load' after cleanup
        const cv = document.createElement('canvas');
        cv.width = 64; cv.height = 48;
        const cx = cv.getContext('2d');
        const rec = new MediaRecorder(cv.captureStream(30), { mimeType: 'video/webm' });
        const chunks = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.start(100);
        for (let i = 0; i < 15; i++) { cx.fillStyle = `hsl(${i * 24},80%,50%)`; cx.fillRect(0, 0, 64, 48); await new Promise(r => setTimeout(r, 30)); }
        await new Promise(r => { rec.onstop = r; rec.stop(); });
        const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
        const v = g.addNode('VideoURL', 100, 500);
        const counts = {};
        const P = HTMLMediaElement.prototype, add = P.addEventListener, rem = P.removeEventListener;
        P.addEventListener = function (type, ...a) { counts[type] = (counts[type] || 0) + 1; return add.call(this, type, ...a); };
        P.removeEventListener = function (type, ...a) { counts[type] = (counts[type] || 0) - 1; return rem.call(this, type, ...a); };
        try {
            await v.loadVideo(url + '#first');
            await v.loadVideo(url); // a second load before the first finished
            for (let i = 0; i < 60 && !v.isActive; i++) await new Promise(r => setTimeout(r, 50));
            out.video = { active: v.isActive };
            v.cleanup();
            await new Promise(r => setTimeout(r, 300));
            out.video.error = v.error;
            out.video.listeners = counts;
        } finally {
            P.addEventListener = add; P.removeEventListener = rem;
            g.nodes = g.nodes.filter(n => n !== v);
            URL.revokeObjectURL(url);
        }
        return out;
    });
    check(ui.text.value === '0.0035' && ui.text.calls.length === 0, 'focus + Enter on a float field keeps 0.0035 (no rounded write-back)', ui.text);
    check(ui.text.edited.value === '0.00125' && ui.text.edited.calls[0] === 0.00125, 'an edited float keeps its digits', ui.text.edited);
    check(ui.monaco.created === 0 && ui.monaco.container === null, 'a code editor closed before Monaco loaded never creates a Monaco editor', ui.monaco);
    check(ui.note.size[0] === 420 && ui.note.size[1] === 300, 'a loaded note has its saved size right away', ui.note);
    check(ui.note.moved === 120 && ui.note.gone && ui.note.text === 'hello', 'the note editor follows a pan; deleting the note while editing removes it without writing into it', ui.note);
    check(ui.rename.has && ui.rename.dx !== 0 && ui.rename.dw !== 0 && ui.rename.gone && ui.rename.overlays === 0, 'the group rename input follows pan / zoom and is released after', ui.rename);
    check(ui.video.active && ui.video.error === null && ui.video.listeners.loadeddata === 0 && ui.video.listeners.error === 0,
        'Video URL: two loads + cleanup leave no listeners and no "Failed to load"', ui.video);

    // ------------------------------------------------------------ 7. console.log noise
    console.log('- no console.log noise');
    logs.length = 0;
    await fresh();
    await ev(() => {
        const g = window.toy.nodeGraph;
        const cc = g.addNode('MIDI CC', 100, 100);
        const c = g.addNode('Float', 300, 100);
        g.onGraphChanged();
        const data = g.serialize();
        g.deserialize(data);
        g.serialize();
        g.selectionManager.selectedNodes.clear();
        for (const n of g.nodes) g.selectionManager.selectedNodes.add(n);
        g.copySelectedNodes();
        window.toy.projectManager.saveGraph();
        return !!cc && !!c;
    });
    await sleep(500);
    check(logs.length === 0, 'MIDI CC restore / serialize, copy, save and load log nothing', logs.slice(0, 5));

    // ------------------------------------------------------------ 9. mic meter, fresh session
    console.log('- Microphone meter in Metronome mode, fresh session (D-A4)');
    {
        // A new page: its AudioContext never had an analysed source (tracker clock not started)
        const p2 = await ctx.newPage();
        p2.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        p2.on('pageerror', e => errors.push('pageerror: ' + e.message));
        try {
            await p2.goto(APP, { waitUntil: 'load' });
            await p2.waitForFunction(() => window.toy && window.toy.nodeGraph, null, { timeout: 30000 });
            const mic = await p2.evaluate(async () => {
                const { audioEngine } = await import('/src/services/AudioEngine.js');
                await audioEngine.setSource('metronome', { bpm: 120 });
                const ac = new AudioContext();
                const osc = ac.createOscillator();
                const dest = ac.createMediaStreamDestination();
                osc.connect(dest); osc.start();
                navigator.mediaDevices.getUserMedia = async () => dest.stream.clone();
                const m = window.toy.nodeGraph.addNode('Microphone', 100, 500);
                try {
                    const ok = await m.enable();
                    await new Promise(r => setTimeout(r, 800));
                    return { ok, source: audioEngine.source, rms: m.getRMS() };
                } finally { m.cleanup(); osc.stop(); ac.close(); }
            });
            check(mic.ok && mic.source === 'metronome' && mic.rms > 0.05, 'the Microphone meter moves in Metronome mode (no analysed source yet)', mic);
        } finally {
            await p2.close();
        }
    }

    // ------------------------------------------------------------ 10. quality governor: display refresh
    console.log('- quality governor: display refresh from idle probes, Auto scales a vsync-bound patch');
    {
        // Own context: empty localStorage (no cached display rate), Auto mode
        const qctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const p3 = await qctx.newPage();
        p3.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        p3.on('pageerror', e => errors.push('pageerror: ' + e.message));
        try {
            await p3.goto(APP, { waitUntil: 'load' });
            await p3.waitForFunction(() => window.toy && window.toy.nodeGraph, null, { timeout: 30000 });
            await p3.waitForFunction(() => !!window.toy.quality?.governors.background.refresh.lastProbe?.stable, null, { timeout: 20000, polling: 250 }).catch(() => { });
            const est = await p3.evaluate(async () => {
                const { quality } = await import('/src/rendering/QualityGovernor.js');
                return quality.governors.background.refresh.status();
            });
            check(est.hz >= 50 && est.last_probe?.stable && est.source === 'probe', 'the startup probe measures the display refresh (headless Chrome: 60 Hz)', est);
            const hz = est.hz;

            // Synthetic frame times: every frame takes 2 vsyncs whatever the scale (CPU-bound) vs. light
            const synth = await p3.evaluate(async (hz) => {
                const { ScaleGovernor } = await import('/src/rendering/QualityGovernor.js');
                const vs = 1000 / hz;
                const run = (work) => {
                    const g = new ScaleGovernor('synthetic', { mode: 'auto', targetFps: 0, emit() { } });
                    let now = 1000, min = 1;
                    g.sample(0, now);
                    while (now < 30000) {
                        const dt = Math.max(1, Math.ceil(work(g.scale) / vs - 1e-9)) * vs;
                        now += dt;
                        g.sample(dt, now);
                        min = Math.min(min, g.scale);
                    }
                    return { final: g.scale, min, what: g.history.map(h => h.what), display_hz: g.status().display_hz };
                };
                return { stuck: run(() => 1.5 * vs), fill: run(s => 1.45 * vs * s * s), light: run(() => 0.3 * vs) };
            }, hz);
            check(synth.stuck.what.includes('down') && synth.stuck.min <= 0.5 && synth.stuck.display_hz >= 59, 'synthetic 2-vsync frames: Auto steps the scale down (the 30 fps frames are not read as a 30 Hz display)', synth.stuck);
            check(synth.fill.final < 1 && synth.fill.min >= 0.5, 'synthetic fill-bound patch at 2 vsyncs: Auto settles below 100 %', synth.fill);
            check(synth.light.final === 1 && synth.light.min === 1 && !synth.light.what.length, 'synthetic light patch: stays at 100 %', synth.light);

            // Real frames: background preview on, a frame hook that costs 1.45 vsyncs x scale^2 (fill-bound)
            const setup = await p3.evaluate(async () => {
                const { quality } = await import('/src/rendering/QualityGovernor.js');
                quality.setMode('auto');
                const g = window.toy.nodeGraph;
                let pv = g.nodes.find(n => n.isPreviewNode);
                if (!pv) pv = g.addNode('Preview', 400, 200);
                if (!(window.toy.backgroundRenderer?.isActive?.(pv))) g.onPreviewBackground(pv);
                return { preview: pv.id };
            });
            await sleep(3500);
            const light = await p3.evaluate(async () => {
                const { quality } = await import('/src/rendering/QualityGovernor.js');
                const b = quality.governors.background;
                return { active: b.active, scale: b.scale, what: b.history.map(h => h.what), display_hz: b.status().display_hz, avg_ms: b.avgMs };
            });
            check(light.active && light.scale === 1 && !light.what.includes('down'), 'real frames, light patch: the background renders at 100 %', { setup, light });
            await p3.evaluate(async (hz) => {
                const { quality } = await import('/src/rendering/QualityGovernor.js');
                const { renderLoop } = await import('/src/rendering/RenderLoop.js');
                const vs = 1000 / hz;
                window.__heavyMin = 1;
                window.__heavyOff = renderLoop.onFrame(() => {
                    const s = quality.scaleOf('background');
                    window.__heavyMin = Math.min(window.__heavyMin, s);
                    const until = performance.now() + 1.45 * vs * s * s;
                    while (performance.now() < until) { /* synthetic fill cost */ }
                });
            }, hz);
            await p3.waitForFunction(() => window.__heavyMin < 1, null, { timeout: 20000, polling: 200 }).catch(() => { });
            await sleep(500);
            const heavy = await p3.evaluate(async () => {
                const { quality } = await import('/src/rendering/QualityGovernor.js');
                const b = quality.governors.background;
                const probe = await b.refresh.probe('test'); // focus-like probe while the heavy patch renders
                return { min: window.__heavyMin, scale: b.scale, what: b.history.map(h => h.what), display_hz: b.status().display_hz, probe, avg_ms: b.avgMs };
            });
            check(heavy.min < 1 && heavy.what.some(w => /^down/.test(w)), 'real frames, heavy patch at 2 vsyncs: Auto steps the background scale down', heavy);
            check(heavy.display_hz >= 50 && heavy.probe && (heavy.probe.busy || heavy.probe.hz >= 50), 'a probe while the heavy patch renders does not lower the display estimate', heavy);
            await p3.evaluate(() => window.__heavyOff && window.__heavyOff());
        } finally {
            await qctx.close();
        }
    }

    // (the deliberate play() failures above log "Failed to enable ...")
    // (and the deliberate unknown-type paste "Unknown node type: NoSuchType")
    const unexpected = errors.filter(e => !/^Failed to enable (camera|screen capture): NotAllowedError: blocked/.test(e) && !/Unknown node type: NoSuchType/.test(e));
    check(unexpected.length === 0, 'no console errors', unexpected.slice(0, 5));
} catch (e) {
    failures++;
    console.log(`  FAIL unexpected error: ${e && e.stack || e}`);
} finally {
    await browser.close();
    if (vite) await vite.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
