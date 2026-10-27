#!/usr/bin/env node
/**
 * Visual regression suite + shader compile check for every projects/*.patchtoy.json.
 *
 *   node tests/visual/run.mjs                    # compare against tests/visual/golden/
 *   node tests/visual/run.mjs --update           # regenerate the goldens (all, or --only)
 *   node tests/visual/run.mjs --only beat-lab,vection
 *   node tests/visual/run.mjs --tolerance 3      # tolerance mode, thresholds x3 (CI / other GPUs)
 *   node tests/visual/run.mjs --set linux        # goldens in tests/visual/golden-linux/
 *   node tests/visual/run.mjs --url http://127.0.0.1:5301/   # reuse a running dev server
 *   node tests/visual/run.mjs --no-compile-check | --save-all | --verbose
 *   node tests/visual/run.mjs --shared-page      # one page for all projects (finds state leaking between loads)
 *   node tests/visual/run.mjs --max-warmup 10    # cap the warm-up frames (software GL / CI; the cap is stored
 *                                                # in the manifest, images warmed up differently use tolerance)
 *
 * Renders go through the MCP tool handlers (mcp/lib/tools.mjs render_preview, in-process,
 * headless Chrome only) with time / beat pinned and a deterministic warm-up (see config.mjs).
 * Goldens are JPEG (small); the raw render's SHA-256 is kept in manifest.json for exact checks.
 * On failure, golden / actual / diff heatmap images are written to tests/visual/out/ (gitignored).
 * Exit code 1 if anything failed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT, startTestVite } from '../lib/vite-server.mjs';
import { decodePNG, encodePNG } from '../lib/png.mjs';
import { compareImages, sha256, imageStats, sideBySide } from '../lib/compare.mjs';
import { projectConfig, EXCLUDE } from './config.mjs';

process.env.VITE_CJS_IGNORE_WARNING = 'true';

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const opt = { update: false, only: null, url: null, tolerance: null, set: null, out: null, compile: true, saveAll: false, verbose: false, sharedPage: false, maxWarmup: null };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) { console.error(`${a} needs a value`); process.exit(2); } return v; };
    if (a === '--update' || a === '-u') opt.update = true;
    else if (a === '--only') opt.only = val().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--url') opt.url = val();
    else if (a === '--tolerance') opt.tolerance = Number(val());
    else if (a === '--set') opt.set = val();
    else if (a === '--out') opt.out = path.resolve(val());
    else if (a === '--no-compile-check') opt.compile = false;
    else if (a === '--save-all') opt.saveAll = true;
    else if (a === '--shared-page') opt.sharedPage = true;
    else if (a === '--max-warmup') opt.maxWarmup = Math.max(0, parseInt(val(), 10));
    else if (a === '--verbose' || a === '-v') opt.verbose = true;
    else if (a === '-h' || a === '--help') {
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n'));
        process.exit(0);
    } else { console.error(`Unknown option ${a}`); process.exit(2); }
}
if (opt.tolerance !== null && !(opt.tolerance > 0)) { console.error('--tolerance needs a positive scale'); process.exit(2); }
if (!opt.url && process.env.PATCHTOY_TEST_URL) opt.url = process.env.PATCHTOY_TEST_URL;
if (!opt.set && process.env.PATCHTOY_GOLDEN_SET) opt.set = process.env.PATCHTOY_GOLDEN_SET;
if (opt.tolerance === null && process.env.PATCHTOY_VISUAL_TOLERANCE) opt.tolerance = Number(process.env.PATCHTOY_VISUAL_TOLERANCE);
if (opt.maxWarmup === null && process.env.PATCHTOY_VISUAL_MAX_WARMUP) opt.maxWarmup = Math.max(0, parseInt(process.env.PATCHTOY_VISUAL_MAX_WARMUP, 10));

const HERE = path.join(REPO_ROOT, 'tests', 'visual');
const DEFAULT_GOLDEN = path.join(HERE, 'golden');
let goldenDir = opt.set ? path.join(HERE, `golden-${opt.set}`) : DEFAULT_GOLDEN;
const outDir = opt.out || path.join(HERE, 'out');
if (!opt.update && opt.set && !fs.existsSync(path.join(goldenDir, 'manifest.json'))) {
    console.log(`[visual] no goldens for set "${opt.set}" (${path.relative(REPO_ROOT, goldenDir)}); falling back to the default set in tolerance mode`);
    goldenDir = DEFAULT_GOLDEN;
    if (opt.tolerance === null) opt.tolerance = 1;
}
const manifestPath = path.join(goldenDir, 'manifest.json');
const oldManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { images: {} };

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------ projects (snapshot: the folder may change while we run)
const srcProjects = path.join(REPO_ROOT, 'projects');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-visual-'));
const slugs = [];
for (const f of fs.readdirSync(srcProjects).sort()) {
    if (!f.endsWith('.patchtoy.json')) continue;
    const slug = f.slice(0, -'.patchtoy.json'.length);
    if (EXCLUDE.some(re => re.test(slug))) continue;
    if (opt.only && !opt.only.includes(slug)) continue;
    fs.copyFileSync(path.join(srcProjects, f), path.join(scratch, f));
    slugs.push(slug);
}
if (opt.only) for (const s of opt.only) if (!slugs.includes(s)) console.log(`[visual] warning: no project "${s}"`);

// ------------------------------------------------------------------ app + session
const require = createRequire(path.join(REPO_ROOT, 'package.json'));
const z = await import(require.resolve('zod'));
if (!opt.verbose) process.env.PATCHTOY_MCP_QUIET = '1';
const { PatchToySession } = await import('../../mcp/lib/session.mjs');
const { createTools } = await import('../../mcp/lib/tools.mjs');

let vite = null;
let session = null;
let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await session?.shutdown(); } catch { /* ignore */ }
    try { await vite?.close(); } catch { /* ignore */ }
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown().finally(() => process.exit(130)); });

const t0 = Date.now();
const results = [];      // per image
const compiles = [];     // per project
let fatal = null;
let platform = null;

const fmtMs = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
const savePng = (file, img) => fs.writeFileSync(path.join(outDir, file), encodePNG(img, { channels: 3 }));

try {
    if (!opt.url) {
        vite = await startTestVite();
        console.log(`[visual] private Vite (HMR off) at ${vite.url}`);
    }
    const appUrl = opt.url || vite.url;
    session = new PatchToySession({ appUrl, bridgePort: 0, clientMode: 'headless', projectsDir: scratch, persistActive: false, allowPortFallback: true });
    const tools = Object.fromEntries(createTools(session).map(t => [t.name, t]));
    const run = async (name, args = {}) => tools[name].handler(z.object(tools[name].inputSchema).parse(args));
    await session.start();

    // Fresh browser context + page per project (clean app, empty localStorage: results never
    // depend on the order projects were opened in), metronome audio, UTC (JS nodes reading
    // the time of day), web fonts loaded (canvas text in JS nodes)
    let pages = 0;
    const freshPage = async () => {
        if (pages++ > 0) {
            try { await session.headlessPage?.page?.close(); } catch { /* ignore */ }
            try { await session.context?.close(); } catch { /* ignore */ }
            session.context = null;
            await session.launchHeadless();
        }
        await run('set_audio', { mode: 'metronome', bpm: 120 });
        const appPage = session.headlessPage.page;
        try {
            const cdp = await appPage.context().newCDPSession(appPage);
            await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
        } catch (e) { console.log(`[visual] warning: could not set the timezone (${e.message})`); }
        await appPage.evaluate(() => document.fonts && document.fonts.ready.then(() => true)).catch(() => { });
    };
    await freshPage();

    // Helper page (about:blank) for JPEG encode / decode, so the app page is never touched
    const helperContext = await session.browser.newContext();
    const helper = await helperContext.newPage();
    platform = await helper.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return { gpu: gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'none' };
    });
    platform.os = `${process.platform}-${process.arch}`;
    platform.chrome = session.browser.version();
    const platformKey = `${platform.os} | Chrome ${String(platform.chrome).split('.')[0]} | ${platform.gpu}`;
    console.log(`[visual] platform: ${platformKey}`);

    const toJpeg = (pngB64, quality) => helper.evaluate(async ({ b64, q }) => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        const url = c.toDataURL('image/jpeg', q);
        return url.slice(url.indexOf(',') + 1);
    }, { b64: pngB64, q: quality });
    const decodeImage = async (buf, mime) => {
        const b64 = await helper.evaluate(async ({ b64, mime }) => {
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const bmp = await createImageBitmap(new Blob([bytes], { type: mime }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
            const c = document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(bmp, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height).data;
            let s = '';
            for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
            return { w: c.width, h: c.height, data: btoa(s) };
        }, { b64: buf.toString('base64'), mime });
        return { width: b64.w, height: b64.h, data: new Uint8Array(Buffer.from(b64.data, 'base64')) };
    };

    const exactPlatform = !opt.update && opt.tolerance === null && oldManifest.platform_key === platformKey;
    if (!opt.update && oldManifest.platform_key && oldManifest.platform_key !== platformKey) {
        console.log(`[visual] goldens were made on "${oldManifest.platform_key}": exact checks off, tolerance mode`);
    }
    const scale = opt.tolerance || 1;
    const newManifest = opt.update
        ? { generated: new Date().toISOString(), platform_key: platformKey, platform, settings: null, max_warmup: opt.maxWarmup, images: { ...(opt.only ? oldManifest.images : {}) } }
        : null;

    for (const slug of slugs) {
        const cfg = projectConfig(slug);
        if (opt.maxWarmup !== null) cfg.warmup = Math.min(cfg.warmup, opt.maxWarmup);
        if (newManifest && !newManifest.settings) newManifest.settings = { width: cfg.width, height: cfg.height, bpm: cfg.bpm, jpeg_quality: cfg.jpegQuality };
        if (cfg.skip) {
            results.push({ slug, key: slug, status: 'SKIP', note: cfg.skip });
            continue;
        }
        const pStart = Date.now();
        // ---- open + compile check
        try {
            if (!opt.sharedPage && slug !== slugs[0]) await freshPage();
            await run('open_project', { name: slug });
            await run('set_audio', { mode: 'metronome', bpm: cfg.bpm });
        } catch (e) {
            results.push({ slug, key: `${slug}-*`, status: 'FAIL', note: `open failed: ${e.message}` });
            continue;
        }
        if (opt.compile) {
            const c0 = Date.now();
            try {
                const { data } = await run('compile', {});
                compiles.push(summarizeCompile(slug, data, Date.now() - c0));
            } catch (e) {
                compiles.push({ slug, ok: false, ms: Date.now() - c0, errors: [e.message], warnings: [] });
            }
        }

        // ---- frames
        for (let i = 0; i < cfg.frames.length; i++) {
            const key = `${slug}-${i + 1}`;
            const frame = cfg.frames[i];
            const args = { width: cfg.width, height: cfg.height, bpm: cfg.bpm, mouse: cfg.mouse, warmup: cfg.warmup, warmup_fps: cfg.fps, seed: cfg.seed, ...frame };
            if (args.warmup === 0) delete args.warmup;
            if (cfg.date) args.date = cfg.date;
            const r0 = Date.now();
            const row = { slug, key, args: frame, status: 'FAIL' };
            results.push(row);
            try {
                const { data, images } = await run('render_preview', args);
                row.ms = Date.now() - r0;
                const pngB64 = images[0].base64;
                const actual = decodePNG(Buffer.from(pngB64, 'base64'));
                const hash = sha256(actual);
                row.blank = data.stats?.blank;
                const w = data.warmup || {};
                if (w.js_untrusted && w.js_untrusted.length) throw new Error(`JS nodes not trusted: ${w.js_untrusted.join(', ')}`);
                if (w.js_pending && w.js_pending.length) throw new Error(`JS setup did not finish: ${w.js_pending.join(', ')}`);
                if (data.compiler_errors && data.compiler_errors.length) row.compiler_errors = data.compiler_errors;

                if (opt.update) {
                    const jpgB64 = await toJpeg(pngB64, cfg.jpegQuality);
                    const jpg = Buffer.from(jpgB64, 'base64');
                    fs.mkdirSync(goldenDir, { recursive: true });
                    fs.writeFileSync(path.join(goldenDir, `${key}.jpg`), jpg);
                    const golden = await decodeImage(jpg, 'image/jpeg');
                    const self = compareImages(actual, golden);
                    newManifest.images[key] = {
                        project: slug, args: frame, warmup: cfg.warmup, sha256: hash, bytes: jpg.length,
                        jpeg_error: { mae: self.mae, bad_frac: self.bad_frac, mean_delta: self.mean_delta, hist_dist: self.hist_dist },
                        stats: imageStats(actual), blank: !!data.stats?.blank,
                    };
                    row.status = 'UPDATED';
                    row.note = `${(jpg.length / 1024).toFixed(0)} KB${data.stats?.blank ? ' (blank!)' : ''}`;
                    if (opt.saveAll) savePng(`${key}.actual.png`, actual);
                    continue;
                }

                const entry = oldManifest.images?.[key];
                const goldenFile = path.join(goldenDir, `${key}.jpg`);
                if (!entry || !fs.existsSync(goldenFile)) {
                    row.status = 'NEW';
                    row.note = 'no golden (run with --update)';
                    savePng(`${key}.actual.png`, actual);
                    continue;
                }
                const golden = await decodeImage(fs.readFileSync(goldenFile), 'image/jpeg');
                const m = compareImages(actual, golden, { heatmap: true });
                const base = entry.jpeg_error || { mae: 0, bad_frac: 0, mean_delta: 0, hist_dist: 0 };
                const excess = {
                    mae: +(m.mae - base.mae).toFixed(3),
                    bad_frac: +(m.bad_frac - base.bad_frac).toFixed(5),
                    mean_delta: +(m.mean_delta - base.mean_delta).toFixed(2),
                    hist_dist: +(m.hist_dist - base.hist_dist).toFixed(4),
                };
                row.metrics = { ...excess, max_err: m.max_err };
                const goldenWarmup = entry.warmup ?? cfg.warmup;
                const exact = cfg.exact && exactPlatform && goldenWarmup === cfg.warmup;
                if (goldenWarmup !== cfg.warmup) row.warmup_note = `warm-up ${cfg.warmup} frames, golden ${goldenWarmup}`;
                row.mode = exact ? 'exact' : `${cfg.profile}${scale !== 1 ? ` x${scale}` : ''}`;
                const over = m.size_mismatch ? ['size'] : Object.keys(cfg.tolerance).filter(k => excess[k] > cfg.tolerance[k] * scale);
                if (exact) {
                    row.status = hash === entry.sha256 ? 'PASS' : 'FAIL';
                    if (row.status === 'FAIL') row.note = `pixels changed (${over.length ? 'over tolerance: ' + over.join(', ') : 'within tolerance'})`;
                } else {
                    row.status = over.length ? 'FAIL' : 'PASS';
                    if (over.length) row.note = `over tolerance: ${over.join(', ')}`;
                    else if (hash === entry.sha256) row.note = 'bit-exact';
                }
                if (row.warmup_note) row.note = [row.note, row.warmup_note].filter(Boolean).join('; ');
                if (row.status === 'FAIL' || opt.saveAll) {
                    savePng(`${key}.actual.png`, actual);
                    savePng(`${key}.golden.png`, golden);
                    savePng(`${key}.diff.png`, m.heatmap);
                    savePng(`${key}.strip.png`, sideBySide([golden, actual, m.heatmap]));
                }
            } catch (e) {
                row.ms = row.ms ?? Date.now() - r0;
                row.status = 'FAIL';
                row.note = (e.message || String(e)).split('\n')[0].slice(0, 160);
            }
        }
        if (opt.verbose) console.log(`[visual] ${slug} done in ${fmtMs(Date.now() - pStart)}`);
        else process.stdout.write('.');
    }
    if (!opt.verbose) process.stdout.write('\n');

    if (newManifest) {
        // Drop goldens of projects that no longer exist (full update only)
        if (!opt.only) {
            for (const f of fs.readdirSync(goldenDir)) {
                if (f.endsWith('.jpg') && !newManifest.images[f.slice(0, -4)]) fs.unlinkSync(path.join(goldenDir, f));
            }
        }
        fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 1) + '\n');
    } else {
        const live = new Set(results.map(r => r.key));
        const stale = Object.keys(oldManifest.images || {}).filter(k => !live.has(k) && (!opt.only || opt.only.includes(oldManifest.images[k].project)));
        if (stale.length && !opt.only) console.log(`[visual] stale goldens (project or frame removed): ${stale.join(', ')}  -> npm run test:visual:update`);
    }
} catch (e) {
    fatal = e;
} finally {
    await shutdown();
}

// ------------------------------------------------------------------ report
function summarizeCompile(slug, data, ms) {
    const errors = [], warnings = [];
    const previews = data.previews || data.results || [];
    for (const p of Array.isArray(previews) ? previews : []) {
        for (const e of p.errors || []) errors.push(`Preview ${p.id}: ${typeof e === 'string' ? e : JSON.stringify(e)}`);
        for (const e of p.glsl_errors || p.webgl_errors || []) errors.push(`Preview ${p.id} GLSL: ${typeof e === 'string' ? e : (e.message || JSON.stringify(e))}${e.line ? ` (line ${e.line})` : ''}`);
        for (const w of p.warnings || []) warnings.push(`Preview ${p.id}: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
    }
    for (const f of data.feedback || []) {
        for (const e of f.errors || []) errors.push(`Feedback ${f.id}: ${typeof e === 'string' ? e : JSON.stringify(e)}`);
        for (const w of f.warnings || []) warnings.push(`Feedback ${f.id}: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
    }
    for (const w of data.warnings || []) warnings.push(typeof w === 'string' ? w : JSON.stringify(w));
    const ok = data.ok !== false && errors.length === 0;
    if (data.ok === false && !errors.length) errors.push('compile reported ok: false');
    return { slug, ok, ms, previews: Array.isArray(previews) ? previews.length : 0, feedback_passes: (data.feedback || []).length, errors, warnings, error_nodes: data.error_nodes };
}

const elapsed = Date.now() - t0;
const pad = (s, n) => String(s ?? '').padEnd(n);
if (compiles.length) {
    console.log('\nShader compile check');
    console.log(`  ${pad('project', 22)} ${pad('ok', 4)} ${pad('time', 8)} ${pad('passes', 7)} warnings / errors`);
    for (const c of compiles) {
        const issues = [...c.errors.map(e => 'E ' + e), ...c.warnings.map(w => 'W ' + w)];
        console.log(`  ${pad(c.slug, 22)} ${pad(c.ok ? 'ok' : 'FAIL', 4)} ${pad(fmtMs(c.ms), 8)} ${pad(`${c.previews}+${c.feedback_passes}fb`, 7)} ${issues.length ? issues[0].slice(0, 110) : '-'}`);
        for (const extra of issues.slice(1, 6)) console.log(`  ${pad('', 22)} ${pad('', 4)} ${pad('', 8)} ${pad('', 7)} ${extra.slice(0, 110)}`);
    }
}
console.log(`\nVisual regression (${opt.update ? 'update' : 'compare'}; goldens: ${path.relative(REPO_ROOT, goldenDir)})`);
console.log(`  ${pad('image', 26)} ${pad('status', 8)} ${pad('mode', 13)} ${pad('time', 7)} ${pad('mae', 6)} ${pad('bad%', 7)} ${pad('dMean', 6)} ${pad('hist', 6)} note`);
for (const r of results) {
    const m = r.metrics || {};
    const num = (v, d = 2) => (v === undefined ? '' : (+v).toFixed(d));
    console.log(`  ${pad(r.key, 26)} ${pad(r.status, 8)} ${pad(r.mode || '', 13)} ${pad(r.ms !== undefined ? fmtMs(r.ms) : '', 7)} ${pad(num(m.mae), 6)} ${pad(m.bad_frac !== undefined ? (m.bad_frac * 100).toFixed(2) : '', 7)} ${pad(num(m.mean_delta), 6)} ${pad(num(m.hist_dist, 3), 6)} ${r.note || ''}${r.blank ? ' [blank render]' : ''}`);
}
const count = s => results.filter(r => r.status === s).length;
const failedCompiles = compiles.filter(c => !c.ok).length;
let goldenBytes = 0;
try { for (const f of fs.readdirSync(goldenDir)) goldenBytes += fs.statSync(path.join(goldenDir, f)).size; } catch { /* none */ }
const report = { elapsed_ms: elapsed, platform, mode: opt.update ? 'update' : 'compare', tolerance_scale: opt.tolerance, golden_dir: path.relative(REPO_ROOT, goldenDir), golden_bytes: goldenBytes, results, compiles, fatal: fatal ? String(fatal.stack || fatal) : null };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));

if (fatal) console.log(`\n[visual] FATAL: ${fatal.stack || fatal.message}`);
const failed = count('FAIL') + count('NEW') + failedCompiles + (fatal ? 1 : 0);
console.log(`\n[visual] ${slugs.length} projects, ${results.length} images: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('NEW')} new, ${count('UPDATED')} updated, ${count('SKIP')} skipped; compile: ${compiles.length - failedCompiles}/${compiles.length} ok; goldens ${(goldenBytes / 1024).toFixed(0)} KB; ${fmtMs(elapsed)}`);
if (count('FAIL') || count('NEW')) console.log(`[visual] diff images: ${path.relative(REPO_ROOT, outDir)}/  (<image>.strip.png = golden | actual | diff)`);
process.exit(opt.update ? (fatal || failedCompiles || count('FAIL') ? 1 : 0) : (failed ? 1 : 0));
