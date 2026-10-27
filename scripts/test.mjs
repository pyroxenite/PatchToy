#!/usr/bin/env node
/**
 * npm test: every automated check, in sequence, against one private dev server.
 *
 *   1. definitions  node scripts/check-definitions.mjs     (node library, no browser)
 *   2. e2e          node mcp/test-e2e.mjs                  (MCP server end to end, scratch projects dir)
 *      history      node scripts/e2e-history.mjs           (undo / redo)
 *      stability    node scripts/e2e-stability.mjs         (review regressions: project reset, races, export)
 *   3. visual       node tests/visual/run.mjs              (visual regression + shader compile check)
 *   4. build        vite build into a temp dir             (production bundle builds)
 *
 * A private Vite dev server (free port, never 5173 / 5200, HMR and file watching off) is
 * started first and shared by the browser stages; it, and every child process, is shut
 * down at the end, on failure and on Ctrl-C. Exit code 1 if any stage failed.
 *
 *   npm test
 *   npm test -- --only visual,e2e      # or --skip build
 *   npm test -- --bail                 # stop at the first failing stage
 *   npm test -- --tolerance 3 --set linux --max-warmup 10   # forwarded to the visual suite (CI)
 *   npm test -- --update-goldens       # visual stage regenerates the goldens instead of comparing
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, startTestVite } from '../tests/lib/vite-server.mjs';

process.env.VITE_CJS_IGNORE_WARNING = 'true';

const ALL = ['definitions', 'e2e', 'history', 'stability', 'visual', 'build'];
const APP_STAGES = new Set(['e2e', 'history', 'stability', 'visual']);
const argv = process.argv.slice(2);
const opt = { only: null, skip: new Set(), bail: false, visualArgs: [] };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) { console.error(`${a} needs a value`); process.exit(2); } return v; };
    if (a === '--only') opt.only = val().split(',').map(s => s.trim());
    else if (a === '--skip') val().split(',').forEach(s => opt.skip.add(s.trim()));
    else if (a === '--no-build') opt.skip.add('build');
    else if (a === '--bail') opt.bail = true;
    else if (a === '--tolerance' || a === '--set' || a === '--max-warmup') opt.visualArgs.push(a, val());
    else if (a === '--update-goldens') opt.visualArgs.push('--update');
    else if (a === '--shared-page' || a === '--save-all') opt.visualArgs.push(a);
    else if (a === '-h' || a === '--help') {
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 21).join('\n'));
        process.exit(0);
    } else { console.error(`Unknown option ${a}`); process.exit(2); }
}
const stages = ALL.filter(s => (!opt.only || opt.only.includes(s)) && !opt.skip.has(s));
for (const s of [...(opt.only || []), ...opt.skip]) if (!ALL.includes(s)) { console.error(`Unknown stage ${s} (${ALL.join(', ')})`); process.exit(2); }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-test-'));
const children = new Set();
let vite = null;
let cleaning = false;

async function cleanup() {
    if (cleaning) return;
    cleaning = true;
    for (const child of children) killTree(child, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while ([...children].some(c => c.exitCode === null && c.signalCode === null) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    for (const child of children) killTree(child, 'SIGKILL');
    try { await vite?.close(); } catch { /* ignore */ }
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
}
function killTree(child, sig) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
        console.log(`\n[test] ${sig}: stopping...`);
        cleanup().finally(() => process.exit(130));
    });
}

/** Run a command, streaming its output; resolves { code, tail } (last output lines). */
function runStage(cmd, args, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, {
            cwd: REPO_ROOT,
            env: { ...process.env, FORCE_COLOR: '0', ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32', // own process group: the whole tree can be killed
        });
        children.add(child);
        const lines = [];
        const keep = (chunk, stream) => {
            stream.write(chunk);
            for (const l of String(chunk).split('\n')) if (l.trim()) lines.push(l);
            if (lines.length > 400) lines.splice(0, lines.length - 400);
        };
        child.stdout.on('data', c => keep(c, process.stdout));
        child.stderr.on('data', c => keep(c, process.stderr));
        child.on('error', (e) => { lines.push(String(e.message)); });
        child.on('close', (code, signal) => {
            children.delete(child);
            resolve({ code: code ?? (signal ? 1 : 0), lines });
        });
    });
}

const fmt = ms => (ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : `${(ms / 1000).toFixed(1)}s`);
const node = process.execPath;
const summary = [];
const t0 = Date.now();

try {
    const needsApp = stages.some(s => APP_STAGES.has(s));
    for (const stage of stages) {
        if (needsApp && !vite && APP_STAGES.has(stage)) {
            vite = await startTestVite();
            console.log(`[test] private Vite dev server (HMR off) at ${vite.url}`);
        }
        console.log(`\n========== ${stage} ==========`);
        const s0 = Date.now();
        let res, detail = '';
        if (stage === 'definitions') {
            res = await runStage(node, ['scripts/check-definitions.mjs']);
            detail = res.lines.slice(-1)[0] || '';
        } else if (stage === 'e2e') {
            const dir = path.join(scratch, 'e2e-projects');
            fs.mkdirSync(dir, { recursive: true });
            res = await runStage(node, ['mcp/test-e2e.mjs'], {
                PATCHTOY_URL: vite.url,
                PATCHTOY_PROJECTS_DIR: dir,
                PATCHTOY_CLIENT_MODE: 'headless',
                E2E_OUT: path.join(scratch, 'e2e-preview.png'),
            });
            detail = res.lines.filter(l => /\d+ passed, \d+ failed/.test(l)).pop() || '';
            const fails = res.lines.filter(l => /^\s*FAIL /.test(l));
            if (fails.length) detail += ` | ${fails.slice(0, 3).map(l => l.trim().slice(0, 90)).join(' | ')}`;
        } else if (stage === 'history' || stage === 'stability') {
            res = await runStage(node, [`scripts/e2e-${stage}.mjs`, '--app', vite.url]);
            detail = res.lines.filter(l => /\d+ passed, \d+ failed/.test(l)).pop() || '';
        } else if (stage === 'visual') {
            res = await runStage(node, ['tests/visual/run.mjs', '--url', vite.url, ...opt.visualArgs]);
            detail = (res.lines.filter(l => /^\[visual\] \d+ projects/.test(l)).pop() || '').replace('[visual] ', '');
        } else if (stage === 'build') {
            const viteBin = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
            res = await runStage(node, [viteBin, 'build', '--outDir', path.join(scratch, 'dist'), '--emptyOutDir', '--logLevel', 'warn']);
            detail = res.code === 0 ? `bundle OK (${dirSize(path.join(scratch, 'dist'))} KB)` : (res.lines.slice(-1)[0] || '');
        }
        const ok = res.code === 0;
        summary.push({ stage, ok, ms: Date.now() - s0, detail });
        if (!ok && opt.bail) break;
    }
} catch (e) {
    summary.push({ stage: 'runner', ok: false, ms: 0, detail: e.message });
} finally {
    await cleanup();
}

function dirSize(dir) {
    let n = 0;
    const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else n += fs.statSync(p).size; } };
    try { walk(dir); } catch { /* ignore */ }
    return Math.round(n / 1024);
}

console.log('\n========== summary ==========');
for (const s of summary) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.stage.padEnd(12)} ${fmt(s.ms).padStart(7)}  ${s.detail}`);
const skipped = ALL.filter(s => !stages.includes(s));
if (skipped.length) console.log(`  skipped: ${skipped.join(', ')}`);
const failed = summary.filter(s => !s.ok).length;
console.log(`\n[test] ${failed ? `${failed} stage(s) failed` : 'all stages passed'} in ${fmt(Date.now() - t0)}`);
process.exit(failed ? 1 : 0);
