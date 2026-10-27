#!/usr/bin/env node
/**
 * Performance harness: frame time, per-phase CPU / GPU time, compile time, GPU memory
 * and graph-canvas redraws for every projects/*.patchtoy.json, in headless Chrome
 * (ANGLE Metal on macOS: real GPU numbers).
 *
 *   node scripts/perf.mjs                       # all projects -> perf-results/<label>.{json,md}
 *   node scripts/perf.mjs --label before        # name of the result files
 *   node scripts/perf.mjs --only scene-medley,liquid-chrome --seconds 4
 *   node scripts/perf.mjs --out <dir>           # where results go (default: <tmp>/patchtoy-perf)
 *   node scripts/perf.mjs --no-fullscreen       # editor scenario only
 *   node scripts/perf.mjs --leaks               # also: load every demo twice in one page, count live GL objects
 *   node scripts/perf.mjs --leaks-only          # only that
 *   node scripts/perf.mjs --url http://127.0.0.1:5278/   # reuse a running (HMR-off) dev server
 *   node scripts/perf.mjs --quality high        # app render quality (localStorage patchtoy_render_quality)
 *   node scripts/perf.mjs --autoscale on        # Feedback auto-scale (data.autoScale) forced on / off on every
 *                                               # Feedback node after load (default: as saved), to evaluate it
 *
 * A private Vite (HMR / watch off, never :5200) is started unless --url is given.
 * One fresh browser per project (cold GPU program cache, so compile times are comparable).
 * Viewport 1512x945 at devicePixelRatio 2 (MacBook Pro 16" default), Parameters panel open.
 *
 * Scenarios per project:
 *   editor      the project as saved (its view, background preview if it has one)
 *   fullscreen  the background preview (else the first Preview) fullscreen
 *
 * Measured (everything is wrapped from outside the app, through the dev server's ES
 * modules, so the same harness measures any version of the code):
 *   fps / frame ms        rAF deltas (p50 / p95)
 *   cpu.<phase>           main-thread ms per frame: control (Param / control / JS / scene ticks),
 *                         feedback, previews (node previews), thumbs (preview -> node canvas copy),
 *                         background (background / fullscreen preview), graph (canvas draw), probes
 *   gpu.<phase>           GPU ms per frame for the same phases, sync-timed (1x1 readPixels around each
 *                         phase, separate 1.5 s window); timer-query numbers kept as gpu_timer
 *   busy                  main-thread busy % (CDP TaskDuration)
 *   redraws/s             graph canvas draws (GraphRenderer.render) per second
 *   readPixels/s          synchronous readbacks per second
 *   compile               ms blocking in CompilationManager.compile (first load, then an unchanged recompile)
 *   ready                 load -> first 'patchtoy:compile' event
 *   gl                    live textures / framebuffers / renderbuffers / programs / shaders, texture + renderbuffer MB
 *   scale                 render scale reported by the app's quality governor (if any)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT, startTestVite } from '../tests/lib/vite-server.mjs';

process.env.VITE_CJS_IGNORE_WARNING = 'true';

const argv = process.argv.slice(2);
const opt = { label: 'run', only: null, seconds: 5, out: path.join(os.tmpdir(), 'patchtoy-perf'), fullscreen: true, leaks: false, url: null, quality: null, settle: 2500, autoscale: null };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--label') opt.label = val();
    else if (a === '--only') opt.only = val().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--seconds') opt.seconds = Number(val());
    else if (a === '--settle') opt.settle = Number(val());
    else if (a === '--out') opt.out = path.resolve(val());
    else if (a === '--no-fullscreen') opt.fullscreen = false;
    else if (a === '--leaks') opt.leaks = true;
    else if (a === '--leaks-only') { opt.leaks = true; opt.leaksOnly = true; }
    else if (a === '--url') opt.url = val();
    else if (a === '--quality') opt.quality = val();
    else if (a === '--autoscale') opt.autoscale = val();
    else if (a === '-h' || a === '--help') {
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 40).join('\n'));
        process.exit(0);
    } else { console.error(`Unknown option ${a}`); process.exit(2); }
}

const require = createRequire(path.join(REPO_ROOT, 'package.json'));
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = await import('playwright-core')); }

const slugs = fs.readdirSync(path.join(REPO_ROOT, 'projects'))
    .filter(f => f.endsWith('.patchtoy.json') && !/^e2e-/.test(f))
    .map(f => f.slice(0, -'.patchtoy.json'.length))
    .filter(s => !opt.only || opt.only.includes(s))
    .sort();

const LAUNCH_ARGS = [
    ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info',
    '--autoplay-policy=no-user-gesture-required',
];

/* ------------------------------------------------------------------ in-page instrumentation */

// Runs before the app: GL object / byte accounting, readPixels count.
function initScript(quality) {
    localStorage.setItem('patchtoy_ui_params_open', '1');
    localStorage.setItem('patchtoy_tour_done', '1');
    if (quality) localStorage.setItem('patchtoy_render_quality', quality);
    const C = { tex: 0, fbo: 0, rb: 0, prog: 0, sh: 0, buf: 0, vao: 0, texBytes: 0, rbBytes: 0, readPixels: 0, texUploads: 0 };
    window.__perfGL = C;
    const bytesOf = new WeakMap();
    const bpp = (gl, internal, type) => {
        const T = { [gl.FLOAT]: 4, [gl.HALF_FLOAT]: 2, [gl.UNSIGNED_BYTE]: 1 };
        const fmt = {
            [gl.RGBA]: 4 * (T[type] || 1), [gl.RGB]: 3 * (T[type] || 1), [gl.LUMINANCE]: 1, [gl.ALPHA]: 1,
            [gl.RGBA8]: 4, [gl.RGBA16F]: 8, [gl.RGBA32F]: 16, [gl.R8]: 1, [gl.RG8]: 2, [gl.R16F]: 2, [gl.R32F]: 4,
            [gl.RG16F]: 4, [gl.RG32F]: 8, [gl.RGB8]: 3, [gl.RGB16F]: 6, [gl.RGB32F]: 12, [gl.DEPTH_COMPONENT16]: 2,
            [gl.DEPTH_COMPONENT24]: 4, [gl.DEPTH24_STENCIL8]: 4, [gl.DEPTH_STENCIL]: 4, [gl.RED]: T[type] || 1,
        };
        return fmt[internal] || 4;
    };
    const setBytes = (obj, key, n) => {
        if (!obj) return;
        const old = bytesOf.get(obj) || 0;
        bytesOf.set(obj, n);
        C[key] += n - old;
    };
    const proto = WebGL2RenderingContext.prototype;
    const pairs = [['createTexture', 'deleteTexture', 'tex'], ['createFramebuffer', 'deleteFramebuffer', 'fbo'], ['createRenderbuffer', 'deleteRenderbuffer', 'rb'],
        ['createProgram', 'deleteProgram', 'prog'], ['createShader', 'deleteShader', 'sh'], ['createBuffer', 'deleteBuffer', 'buf'], ['createVertexArray', 'deleteVertexArray', 'vao']];
    for (const [c, d, k] of pairs) {
        const oc = proto[c], od = proto[d];
        proto[c] = function (...a) { const r = oc.apply(this, a); if (r) C[k]++; return r; };
        proto[d] = function (o) {
            if (o && !o.__ptDel) {
                o.__ptDel = 1; C[k]--;
                if (k === 'tex') setBytes(o, 'texBytes', 0);
                if (k === 'rb') setBytes(o, 'rbBytes', 0);
            }
            return od.call(this, o);
        };
    }
    const oti = proto.texImage2D;
    proto.texImage2D = function (...a) {
        try {
            if (a[0] === this.TEXTURE_2D && a[1] === 0) {
                let w, h, internal, type;
                if (a.length >= 8) { [, , internal, w, h, , , type] = a; }
                else { internal = a[2]; type = a[4]; const s = a[5]; w = s && (s.videoWidth || s.naturalWidth || s.width); h = s && (s.videoHeight || s.naturalHeight || s.height); }
                const tex = this.getParameter(this.TEXTURE_BINDING_2D);
                setBytes(tex, 'texBytes', (w | 0) * (h | 0) * bpp(this, internal, type));
                C.texUploads++;
            }
        } catch (e) { /* ignore */ }
        return oti.apply(this, a);
    };
    const ots = proto.texStorage2D;
    proto.texStorage2D = function (target, levels, internal, w, h) {
        try { setBytes(this.getParameter(this.TEXTURE_BINDING_2D), 'texBytes', w * h * bpp(this, internal) * (levels > 1 ? 1.334 : 1)); } catch (e) { /* ignore */ }
        return ots.call(this, target, levels, internal, w, h);
    };
    const orb = proto.renderbufferStorage, orbm = proto.renderbufferStorageMultisample;
    proto.renderbufferStorage = function (t, internal, w, h) {
        try { setBytes(this.getParameter(this.RENDERBUFFER_BINDING), 'rbBytes', w * h * bpp(this, internal)); } catch (e) { /* ignore */ }
        return orb.call(this, t, internal, w, h);
    };
    proto.renderbufferStorageMultisample = function (t, s, internal, w, h) {
        try { setBytes(this.getParameter(this.RENDERBUFFER_BINDING), 'rbBytes', w * h * bpp(this, internal) * Math.max(1, s)); } catch (e) { /* ignore */ }
        return orbm.call(this, t, s, internal, w, h);
    };
    const orp = proto.readPixels;
    proto.readPixels = function (...a) { C.readPixels++; return orp.apply(this, a); };
    window.__perfRaw = { readPixels: orp, createTexture: proto.createTexture, createFramebuffer: proto.createFramebuffer };
}

// Runs in the app page once window.toy exists: phase timers (CPU + GPU timer queries).
async function installProbes() {
    if (window.__perf) return true;
    const toy = window.toy;
    const gl = toy.sharedGL;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const P = {
        frames: 0, deltas: [], cpu: {}, gpu: {}, gpuF: {}, gpuN: {}, redraws: 0, lastT: 0, running: false, finishMode: false,
        pending: [], pool: [], gpuOk: !!ext, nested: 0, compile: [], events: [],
    };
    window.__perf = P;
    const getQuery = () => P.pool.pop() || gl.createQuery();
    // GPU sync point: a 1x1 readPixels waits for all queued work (gl.finish() does not, in Chrome)
    const syncTex = gl.createTexture();
    const syncFbo = gl.createFramebuffer();
    window.__perfGL.tex--; window.__perfGL.fbo--;
    gl.bindTexture(gl.TEXTURE_2D, syncTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    window.__perfGL.texBytes -= 4; window.__perfGL.texUploads--;
    gl.bindFramebuffer(gl.FRAMEBUFFER, syncFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, syncTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const px = new Uint8Array(4);
    const gpuSync = () => {
        const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, syncFbo);
        // a draw into the sync target puts it at the end of the queued work (ANGLE only waits
        // for the passes that touch the texture being read)
        const sc = gl.getParameter(gl.COLOR_CLEAR_VALUE);
        const vp = gl.getParameter(gl.VIEWPORT);
        const scissor = gl.isEnabled(gl.SCISSOR_TEST);
        if (scissor) gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, 1, 1);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.clearColor(sc[0], sc[1], sc[2], sc[3]);
        gl.viewport(vp[0], vp[1], vp[2], vp[3]);
        if (scissor) gl.enable(gl.SCISSOR_TEST);
        window.__perfRaw.readPixels.call(gl, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    };
    const pollQueries = () => {
        if (!ext) return;
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        while (P.pending.length) {
            const [q, phase, live] = P.pending[0];
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
            P.pending.shift();
            const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
            if (!disjoint && live) { P.gpu[phase] = (P.gpu[phase] || 0) + ns / 1e6; }
            P.pool.push(q);
        }
    };
    // Wrap obj[name]: outermost call of a frame phase gets CPU (performance.now) + GPU (timer query) time
    const wrap = (obj, name, phase, gpu = true, classify = null) => {
        const orig = obj[name];
        if (typeof orig !== 'function' || orig.__perfWrapped) return;
        const w = function (...args) {
            if (P.nested > 0) return orig.apply(this, args);
            const ph = classify ? classify(this, args) : phase;
            if (!ph) return orig.apply(this, args);
            P.nested++;
            let q = null;
            if (P.finishMode) { gpuSync(); }
            else if (gpu && ext && P.running) { q = getQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
            const t0 = performance.now();
            try { return orig.apply(this, args); } finally {
                if (P.finishMode) gpuSync();
                const dt = performance.now() - t0;
                if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); P.pending.push([q, ph, P.running]); }
                if (P.running) (P.finishMode ? P.gpuF : P.cpu)[ph] = ((P.finishMode ? P.gpuF : P.cpu)[ph] || 0) + dt;
                P.nested--;
            }
        };
        w.__perfWrapped = true;
        obj[name] = w;
    };
    const imp = (p) => import(/* @vite-ignore */ p);
    const [{ ShaderPreview }, { PreviewNode }, { GraphRenderer }, { FeedbackRenderer }, { CompilationManager }, { controlRuntime }] = await Promise.all([
        imp('/src/rendering/ShaderPreview.js'), imp('/src/nodes/PreviewNode.js'), imp('/src/graph/GraphRenderer.js'),
        imp('/src/rendering/FeedbackRenderer.js'), imp('/src/managers/CompilationManager.js'), imp('/src/core/control/ControlRuntime.js'),
    ]);
    P.isBg = (sp) => {
        const br = toy.backgroundRenderer;
        if (br && br.shaderPreview === sp) return 'background';
        const fs = document.querySelector('.pt-fullscreen');
        if (fs && fs._fullscreenPreview === sp) return 'background';
        return null;
    };
    wrap(controlRuntime, 'tick', 'control', false);
    wrap(FeedbackRenderer.prototype, 'renderFeedbackNodes', 'feedback');
    wrap(CompilationManager.prototype, 'renderProbes', 'probes');
    wrap(ShaderPreview.prototype, 'render', 'previews', true, (sp) => P.isBg(sp) || 'previews');
    // Shared-canvas previews (background / fullscreen) override render per instance: wrap those too
    P.wrapInstances = () => {
        const br = toy.backgroundRenderer;
        if (br && br.shaderPreview && Object.prototype.hasOwnProperty.call(br.shaderPreview, 'render')) wrap(br.shaderPreview, 'render', 'background');
        const fs = document.querySelector('.pt-fullscreen');
        if (fs && fs._fullscreenPreview && Object.prototype.hasOwnProperty.call(fs._fullscreenPreview, 'render')) wrap(fs._fullscreenPreview, 'render', 'background');
    };
    // Preview -> node canvas copy (readPixels path or GPU copy) happens inside the canvas draw
    const thumbOrig = PreviewNode.prototype.getDisplayCanvas;
    if (thumbOrig) {
        PreviewNode.prototype.getDisplayCanvas = function (...a) {
            let q = null;
            const outer = P.nested === 0;
            if (P.finishMode && outer) gpuSync();
            else if (ext && P.running && outer) { q = getQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
            const t0 = performance.now();
            P.nested++;
            try { return thumbOrig.apply(this, a); } finally {
                P.nested--;
                if (P.finishMode && outer) gpuSync();
                const dt = performance.now() - t0;
                if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); P.pending.push([q, 'thumbs', P.running]); }
                if (P.running) {
                    if (P.finishMode) P.gpuF.thumbs = (P.gpuF.thumbs || 0) + dt;
                    else P.cpu.thumbs = (P.cpu.thumbs || 0) + dt;
                    P.cpu._thumbsInGraph = (P.cpu._thumbsInGraph || 0) + dt;
                }
            }
        };
    }
    const grOrig = GraphRenderer.prototype.render;
    GraphRenderer.prototype.render = function (...a) {
        const t0 = performance.now();
        const before = P.cpu._thumbsInGraph || 0;
        try { return grOrig.apply(this, a); } finally {
            if (P.running) {
                P.redraws++;
                const inner = (P.cpu._thumbsInGraph || 0) - before;
                P.cpu.graph = (P.cpu.graph || 0) + (performance.now() - t0) - inner;
            }
        }
    };
    const cOrig = CompilationManager.prototype.compile;
    CompilationManager.prototype.compile = function (...a) {
        const t0 = performance.now();
        try { return cOrig.apply(this, a); } finally { P.compile.push({ at: t0, ms: performance.now() - t0 }); }
    };
    window.addEventListener('patchtoy:compile', (e) => P.events.push({ at: performance.now(), detail: { ok: e.detail.ok, ms: e.detail.ms, errorCount: e.detail.errorCount } }));
    // Frame counter + query polling (own rAF)
    const tick = (t) => {
        requestAnimationFrame(tick);
        pollQueries();
        if (!P.running) { P.lastT = t; return; }
        if (P.lastT) P.deltas.push(t - P.lastT);
        P.lastT = t;
        P.frames++;
    };
    requestAnimationFrame(tick);
    P.start = (finishMode = false) => {
        P.wrapInstances();
        P.finishMode = finishMode;
        P.frames = 0; P.deltas = []; P.cpu = {}; P.gpu = {}; P.gpuF = {}; P.redraws = 0; P.lastT = 0;
        P.gl0 = { ...window.__perfGL };
        P.t0 = performance.now();
        P.running = true;
    };
    P.stop = async () => {
        P.running = false;
        const finishMode = P.finishMode;
        P.finishMode = false;
        const wall = performance.now() - P.t0;
        // let outstanding queries resolve
        for (let i = 0; i < 20 && P.pending.some(p => p[2]); i++) { await new Promise(r => requestAnimationFrame(r)); pollQueries(); }
        const n = Math.max(1, P.frames);
        const sorted = P.deltas.slice().sort((a, b) => a - b);
        const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
        const per = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, +(v / n).toFixed(3)]));
        const G = window.__perfGL;
        const gov = toy.quality || toy.renderQuality || null;
        if (finishMode) return { gpu_finish: per(P.gpuF), frames: P.frames };
        return {
            wall_ms: Math.round(wall),
            frames: P.frames,
            fps: +(P.frames * 1000 / wall).toFixed(1),
            frame_p50: +pct(0.5).toFixed(2),
            frame_p95: +pct(0.95).toFixed(2),
            cpu: per(P.cpu),
            gpu: ext ? per(P.gpu) : null,
            redraws_per_s: +(P.redraws * 1000 / wall).toFixed(1),
            readpixels_per_s: +((G.readPixels - P.gl0.readPixels) * 1000 / wall).toFixed(1),
            tex_uploads_per_s: +((G.texUploads - P.gl0.texUploads) * 1000 / wall).toFixed(1),
            scale: gov && typeof gov.status === 'function' ? gov.status() : null,
        };
    };
    P.glStats = () => {
        const G = window.__perfGL;
        const c = toy.sharedGL.canvas;
        return {
            textures: G.tex, framebuffers: G.fbo, renderbuffers: G.rb, programs: G.prog, shaders: G.sh, buffers: G.buf,
            tex_mb: +(G.texBytes / 1048576).toFixed(1), rb_mb: +(G.rbBytes / 1048576).toFixed(1),
            shared_canvas: `${c.width}x${c.height}`,
            feedback: toy.nodeGraph.nodes.filter(n => n.isFeedbackNode).map(n => `${n.bufferWidth || n.data.width}x${n.bufferHeight || n.data.height}${n.data.autoScale ? '*' : ''}`).join(' '),
            heap_mb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
        };
    };
    return true;
}

/* ------------------------------------------------------------------ run */

async function loadProject(page, slug) {
    return page.evaluate(async (slug) => {
        const P = window.__perf;
        P.compile = []; P.events = [];
        const txt = await (await fetch(`/projects/${slug}.patchtoy.json`)).text();
        const f = new File([txt], `${slug}.patchtoy.json`, { type: 'application/json' });
        const t0 = performance.now();
        let last = t0, hitch = 0, watching = true;
        const watch = (t) => { if (!watching) return; hitch = Math.max(hitch, t - last); last = t; requestAnimationFrame(watch); };
        requestAnimationFrame(watch);
        const res = await window.toy.openProjectFile(f, { title: slug });
        // Wait for the (debounced) compile + its event
        const deadline = performance.now() + 30000;
        while (!P.events.length && performance.now() < deadline) await new Promise(r => setTimeout(r, 20));
        // and one frame after it
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise(r => setTimeout(r, 1500));
        watching = false;
        const ev = P.events[0];
        return {
            ok: !!(res && res.success),
            ready_ms: ev ? Math.round(ev.at - t0) : null,
            compile_ok: ev ? ev.detail.ok : null,
            errors: ev ? ev.detail.errorCount : null,
            compile_block_ms: +P.compile.reduce((s, c) => s + c.ms, 0).toFixed(1),
            compile_calls: P.compile.length,
            hitch_ms: Math.round(hitch),
        };
    }, slug);
}

async function trustJS(page) {
    await page.evaluate(async () => {
        const { jsRuntime } = await import('/src/nodes/jsRuntime.js');
        for (const n of window.toy.nodeGraph.nodes) if (n.isJSNode) jsRuntime.trustNode(n);
        for (const m of document.querySelectorAll('.pt-modal-backdrop, .pt-modal, [role=dialog]')) {
            const btn = [...m.querySelectorAll('button')].find(b => /run|allow|trust/i.test(b.textContent));
            if (btn) btn.click();
        }
    });
}

async function measure(page, cdp, seconds) {
    // GPU time per phase, sync-timed (a 1x1 readPixels before and after each phase: serialises CPU and GPU,
    // so this short window is not used for the frame rate). Timer queries on ANGLE Metal
    // include queueing time, so they are only reported as a cross-check.
    await page.evaluate(() => window.__perf.start(true));
    await page.waitForTimeout(1500);
    const fin = await page.evaluate(() => window.__perf.stop());
    await page.waitForTimeout(500);
    const m0 = await cdp.send('Performance.getMetrics');
    await page.evaluate(() => window.__perf.start());
    await page.waitForTimeout(seconds * 1000);
    const r = await page.evaluate(() => window.__perf.stop());
    const m1 = await cdp.send('Performance.getMetrics');
    const get = (m, k) => (m.metrics.find(x => x.name === k) || {}).value || 0;
    r.busy = +(100 * (get(m1, 'TaskDuration') - get(m0, 'TaskDuration')) / (r.wall_ms / 1000)).toFixed(1);
    r.gpu_timer = r.gpu;
    r.gpu = fin.gpu_finish;
    // JS allocation rate (sampling heap profiler incl. objects already collected): KB per frame + top sites
    try {
        await cdp.send('HeapProfiler.enable');
        await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        const f0 = await page.evaluate(() => { window.__perf.start(); return 0; });
        await page.waitForTimeout(2000);
        const st = await page.evaluate(() => window.__perf.stop());
        const { profile } = await cdp.send('HeapProfiler.stopSampling');
        const sites = new Map();
        let total = 0;
        const walk = (n) => {
            // App code only (the harness's own wrappers allocate too)
            const self = /\/src\/|\/main\.js/.test(n.callFrame.url || '') ? (n.selfSize || 0) : 0;
            total += self;
            if (self) {
                const cf = n.callFrame;
                const key = `${cf.functionName || '(anon)'} ${String(cf.url).split('/').slice(-1)[0]}:${cf.lineNumber + 1}`;
                sites.set(key, (sites.get(key) || 0) + self);
            }
            for (const c of n.children || []) walk(c);
        };
        walk(profile.head);
        const frames = Math.max(1, st.frames);
        r.alloc_kb_per_frame = +(total / 1024 / frames).toFixed(1);
        r.alloc_top = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / 1024 / frames).toFixed(1)}KB`);
        void f0;
    } catch (e) {
        r.alloc_kb_per_frame = null;
        r.alloc_error = e.message;
    }
    return r;
}

async function runProject(slug, appUrl) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: LAUNCH_ARGS });
    const errors = [];
    try {
        const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });
        await context.addInitScript(initScript, opt.quality);
        const page = await context.newPage();
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
        page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`.slice(0, 300)));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
        await page.goto(`${appUrl}?bridge=off`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.toy && window.toy.sharedGL, null, { timeout: 30000 });
        await page.waitForTimeout(1500);
        await page.evaluate(installProbes);
        const load = await loadProject(page, slug);
        await trustJS(page);
        if (opt.autoscale === 'on' || opt.autoscale === 'off') {
            await page.evaluate((on) => {
                for (const n of window.toy.nodeGraph.nodes) {
                    if (!n.isFeedbackNode) continue;
                    if (on) n.data.autoScale = true; else delete n.data.autoScale;
                }
                window.toy.nodeGraph.onGraphChanged?.();
            }, opt.autoscale === 'on');
        }
        await page.waitForTimeout(opt.settle);
        // Unchanged recompile (no graph change): what an edit that doesn't touch this shader costs
        const recompile = await page.evaluate(() => {
            const t0 = performance.now();
            window.toy.compilationManager.compile();
            return +(performance.now() - t0).toFixed(1);
        });
        await page.waitForTimeout(800);
        const editor = await measure(page, cdp, opt.seconds);
        const gl = await page.evaluate(() => window.__perf.glStats());
        let fullscreen = null;
        if (opt.fullscreen) {
            const ok = await page.evaluate(() => {
                const g = window.toy.nodeGraph;
                const node = window.toy.backgroundRenderer.activePreviewNode || g.nodes.find(n => n.isPreviewNode);
                if (!node) return false;
                g.onPreviewFullscreen(node);
                return true;
            });
            if (ok) {
                await page.waitForTimeout(Math.max(3000, opt.settle));
                fullscreen = await measure(page, cdp, opt.seconds);
                fullscreen.gl = await page.evaluate(() => window.__perf.glStats());
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
            }
        }
        await context.close();
        return { slug, load: { ...load, recompile_ms: recompile }, editor, gl, fullscreen, errors };
    } finally {
        await browser.close();
    }
}

async function runLeaks(appUrl) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: LAUNCH_ARGS });
    try {
        const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });
        await context.addInitScript(initScript, opt.quality);
        const page = await context.newPage();
        await page.goto(`${appUrl}?bridge=off`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.toy && window.toy.sharedGL, null, { timeout: 30000 });
        await page.waitForTimeout(1000);
        await page.evaluate(installProbes);
        const rows = [];
        const all = slugs.filter(s => s !== 'audio-textures');
        for (let pass = 0; pass < 2; pass++) {
            for (const slug of all) {
                await loadProject(page, slug);
                await trustJS(page);
                await page.waitForTimeout(400);
            }
            await page.waitForTimeout(1000);
            rows.push({ after: `${(pass + 1) * all.length} loads`, ...(await page.evaluate(() => window.__perf.glStats())) });
        }
        await page.evaluate(() => window.toy.createNewProject());
        await page.waitForTimeout(800);
        rows.push({ after: 'New project', ...(await page.evaluate(() => window.__perf.glStats())) });
        return rows;
    } finally {
        await browser.close();
    }
}

const fmt = (v, d = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
const sumObj = (o) => (o ? Object.values(o).reduce((s, v) => s + v, 0) : null);

function table(results) {
    const lines = [];
    lines.push('| project | editor fps | p50 / p95 ms | CPU ms/frame | GPU ms/frame | busy % | redraws/s | readPixels/s | alloc KB/frame | fullscreen fps | fs GPU ms | fs scale | compile ms (load) | load hitch ms | recompile ms | ready ms | textures / FBOs | tex MB |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of results) {
        if (r.error) { lines.push(`| ${r.slug} | error: ${r.error} |`); continue; }
        const e = r.editor, f = r.fullscreen;
        const scale = f && f.scale ? (f.scale.background ?? f.scale.scale ?? '-') : '-';
        lines.push(`| ${r.slug} | ${fmt(e.fps)} | ${fmt(e.frame_p50)} / ${fmt(e.frame_p95)} | ${fmt(sumObj(e.cpu), 2)} | ${fmt(sumObj(e.gpu), 2)} | ${fmt(e.busy, 0)} | ${fmt(e.redraws_per_s, 0)} | ${fmt(e.readpixels_per_s, 0)} | ${fmt(e.alloc_kb_per_frame)} | ${f ? fmt(f.fps) : '-'} | ${f ? fmt(sumObj(f.gpu), 2) : '-'} | ${typeof scale === 'number' ? scale.toFixed(2) : scale} | ${fmt(r.load.compile_block_ms, 0)} | ${fmt(r.load.hitch_ms, 0)} | ${fmt(r.load.recompile_ms, 0)} | ${fmt(r.load.ready_ms, 0)} | ${r.gl.textures} / ${r.gl.framebuffers} | ${fmt(r.gl.tex_mb)} |`);
    }
    lines.push('');
    lines.push('Per-phase CPU / GPU ms per frame (editor):');
    lines.push('');
    const phases = ['control', 'feedback', 'previews', 'thumbs', 'background', 'graph', 'probes'];
    lines.push(`| project | ${phases.map(p => `${p} cpu/gpu`).join(' | ')} |`);
    lines.push(`|---|${phases.map(() => '---').join('|')}|`);
    for (const r of results) {
        if (r.error) continue;
        const e = r.editor;
        lines.push(`| ${r.slug} | ${phases.map(p => `${fmt(e.cpu[p] || 0, 2)} / ${e.gpu ? fmt(e.gpu[p] || 0, 2) : '-'}`).join(' | ')} |`);
    }
    lines.push('');
    lines.push('Per-phase CPU / GPU ms per frame (fullscreen):');
    lines.push('');
    lines.push(`| project | ${phases.map(p => `${p} cpu/gpu`).join(' | ')} |`);
    lines.push(`|---|${phases.map(() => '---').join('|')}|`);
    for (const r of results) {
        if (r.error || !r.fullscreen) continue;
        const e = r.fullscreen;
        lines.push(`| ${r.slug} | ${phases.map(p => `${fmt(e.cpu[p] || 0, 2)} / ${e.gpu ? fmt(e.gpu[p] || 0, 2) : '-'}`).join(' | ')} |`);
    }
    return lines.join('\n');
}

let vite = null;
try {
    if (!opt.url) {
        vite = await startTestVite();
        console.log(`[perf] private Vite (HMR off) at ${vite.url}`);
    }
    const appUrl = opt.url || vite.url;
    fs.mkdirSync(opt.out, { recursive: true });
    const results = [];
    for (const slug of opt.leaksOnly ? [] : slugs) {
        const t = Date.now();
        try {
            const r = await runProject(slug, appUrl);
            results.push(r);
            const e = r.editor, f = r.fullscreen;
            console.log(`[perf] ${slug.padEnd(20)} editor ${fmt(e.fps).padStart(5)} fps  cpu ${fmt(sumObj(e.cpu), 2)}  gpu ${fmt(sumObj(e.gpu), 2)}  redraws ${fmt(e.redraws_per_s, 0)}/s  rp ${fmt(e.readpixels_per_s, 0)}/s | fs ${f ? fmt(f.fps) : '-'} fps gpu ${f ? fmt(sumObj(f.gpu), 2) : '-'} | compile ${fmt(r.load.compile_block_ms, 0)} ms hitch ${fmt(r.load.hitch_ms, 0)} ms recompile ${fmt(r.load.recompile_ms, 0)} ms | tex ${r.gl.textures} ${fmt(r.gl.tex_mb)} MB${r.errors.length ? ` | ${r.errors.length} console errors` : ''} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
            for (const err of r.errors.slice(0, 3)) console.log(`         ${err}`);
        } catch (err) {
            console.log(`[perf] ${slug}: FAILED ${err.message}`);
            results.push({ slug, error: err.message.split('\n')[0] });
        }
    }
    let leaks = null;
    if (opt.leaks) {
        leaks = await runLeaks(appUrl);
        console.log('[perf] project switching (live GL objects):');
        for (const r of leaks) console.log(`         ${r.after.padEnd(12)} textures ${r.textures}  FBOs ${r.framebuffers}  programs ${r.programs}  shaders ${r.shaders}  buffers ${r.buffers}  tex ${r.tex_mb} MB  heap ${r.heap_mb} MB`);
    }
    const md = `# PatchToy perf: ${opt.label}\n\n${new Date().toISOString()}\n\n${table(results)}\n${leaks ? `\nProject switching (live GL objects):\n\n| after | textures | FBOs | programs | shaders | buffers | tex MB | heap MB |\n|---|---|---|---|---|---|---|---|\n${leaks.map(r => `| ${r.after} | ${r.textures} | ${r.framebuffers} | ${r.programs} | ${r.shaders} | ${r.buffers} | ${r.tex_mb} | ${r.heap_mb} |`).join('\n')}\n` : ''}`;
    fs.writeFileSync(path.join(opt.out, `${opt.label}.json`), JSON.stringify({ label: opt.label, date: new Date().toISOString(), results, leaks }, null, 1));
    fs.writeFileSync(path.join(opt.out, `${opt.label}.md`), md);
    console.log(`[perf] wrote ${path.join(opt.out, `${opt.label}.md`)}`);
} finally {
    try { await vite?.close(); } catch { /* ignore */ }
}
