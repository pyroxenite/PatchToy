#!/usr/bin/env node
/**
 * End-to-end test: spawns mcp/server.mjs over stdio with the MCP SDK client,
 * then creates a project, builds a graph (UV -> noise/sin -> Preview),
 * compiles, renders a PNG, checks it isn't blank, exercises error paths and
 * deletes the project.
 *
 *   node mcp/test-e2e.mjs                      # private Vite (free port, HMR + watcher off) + headless Chrome
 *   PATCHTOY_URL=http://localhost:5199 node mcp/test-e2e.mjs   # reuse a running dev server
 *   E2E_OUT=/tmp/out.png node mcp/test-e2e.mjs                 # where to write the rendered PNG
 *   PATCHTOY_PROJECTS_DIR=/tmp/pt node mcp/test-e2e.mjs        # use another projects dir (also for the server)
 *
 * By default the projects live in a fresh temp dir (removed afterwards), so
 * test files can never end up in projects/ (which ships as the demo gallery).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchProjects = !process.env.PATCHTOY_PROJECTS_DIR;
const projectsDir = scratchProjects
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-e2e-projects-'))
    : path.resolve(repoRoot, process.env.PATCHTOY_PROJECTS_DIR);
const projectName = `E2E Test ${Date.now()}`;
const outPng = process.env.E2E_OUT || path.join(os.tmpdir(), 'patchtoy-e2e-preview.png');

let failures = 0;
let passes = 0;
function check(cond, label, extra) {
    if (cond) { passes++; console.log(`  ok   ${label}`); }
    else { failures++; console.log(`  FAIL ${label}${extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)) : ''}`); }
}

// Minimal container readers for the output toolkit checks (no ffprobe needed)
function readMp4(buf) {
    const out = { samples: null, duration: null, width: null, height: null };
    const walk = (start, end) => {
        let o = start;
        while (o + 8 <= end) {
            const size = buf.readUInt32BE(o);
            const type = buf.toString('latin1', o + 4, o + 8);
            if (size < 8) break;
            if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(o + 8, o + size);
            else if (type === 'mvhd') out.duration = buf.readUInt32BE(o + 24) / buf.readUInt32BE(o + 20);
            else if (type === 'stsz') out.samples = buf.readUInt32BE(o + 16);
            else if (type === 'tkhd') { out.width = buf.readUInt32BE(o + 84) / 65536; out.height = buf.readUInt32BE(o + 88) / 65536; }
            o += size;
        }
    };
    walk(0, buf.length);
    return out;
}
function readWebm(buf) {
    const out = { blocks: 0, durationMs: null, codec: null };
    const vint = (o, id) => {
        const b = buf[o];
        let len = 1;
        while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
        let v = id ? b : b & ((0x80 >> (len - 1)) - 1);
        let unknown = !id && v === (0x80 >> (len - 1)) - 1;
        for (let i = 1; i < len; i++) { v = v * 256 + buf[o + i]; if (buf[o + i] !== 255) unknown = false; }
        return { v, len, unknown };
    };
    const MASTER = new Set([0x18538067, 0x1F43B675, 0x1549A966, 0x1654AE6B, 0xAE]);
    const walk = (start, end) => {
        let o = start;
        while (o < end) {
            const id = vint(o, true);
            const sz = vint(o + id.len, false);
            const data = o + id.len + sz.len;
            const stop = sz.unknown ? end : Math.min(end, data + sz.v);
            if (MASTER.has(id.v)) walk(data, stop);
            else if (id.v === 0xA3) out.blocks++;
            else if (id.v === 0x4489) out.durationMs = sz.v === 8 ? buf.readDoubleBE(data) : buf.readFloatBE(data);
            else if (id.v === 0x86) out.codec = buf.toString('latin1', data, data + sz.v);
            o = stop;
        }
    };
    walk(0, buf.length);
    return out;
}

function textOf(res) {
    const t = (res.content || []).find(c => c.type === 'text');
    return t ? t.text : '';
}
function jsonOf(res) {
    try { return JSON.parse(textOf(res)); } catch { return null; }
}

// A private Vite with HMR and the file watcher off: edits made to the repo while the test
// runs (other people / agents) must not reload the headless page under test.
let privateVite = null;
if (!process.env.PATCHTOY_URL) {
    const { startTestVite } = await import('../tests/lib/vite-server.mjs');
    privateVite = await startTestVite();
}

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'mcp', 'server.mjs')],
    cwd: repoRoot,
    env: {
        ...process.env,
        PATCHTOY_BRIDGE_PORT: '0',          // random port: never collides with a running server
        PATCHTOY_CLIENT_MODE: 'headless',   // never touch a developer's open tab
        PATCHTOY_PROJECTS_DIR: projectsDir, // scratch dir unless given
        PATCHTOY_MCP_QUIET: process.env.E2E_VERBOSE ? '' : '1',
        ...(privateVite ? { PATCHTOY_URL: privateVite.url } : {}),
    },
    stderr: process.env.E2E_VERBOSE ? 'inherit' : 'pipe',
});
const client = new Client({ name: 'patchtoy-e2e', version: '1.0.0' });

async function call(name, args = {}) {
    const t0 = Date.now();
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    console.log(`- ${name} (${Date.now() - t0}ms)${res.isError ? ' [isError]' : ''}`);
    return res;
}

// ------------------------------------------------------------------ bridge / file-name security
async function securityChecks() {
    const { default: WebSocket } = await import('ws');
    const auth = await import('./lib/auth.mjs');
    let res = await call('get_status', {});
    const st = jsonOf(res);
    const port = st?.bridge?.port;
    const appOrigin = new URL(st?.app_url || 'http://localhost:5173/').origin;
    check(Number.isInteger(port), 'get_status reports the bridge port', st);
    check(st?.clients?.length === 1 && !/bridgeToken=(?!\*)/.test(JSON.stringify(st)), 'get_status shows one client and no bridge token', st?.clients);

    // -> 'welcome' | 'auth:<msg>' | 'http:<status>' | 'closed' | 'timeout'
    const attempt = (origin, hello) => new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
        const done = (v) => { clearTimeout(t); try { ws.terminate(); } catch { /* ignore */ } resolve(v); };
        const t = setTimeout(() => done('timeout'), 8000);
        ws.on('unexpected-response', (_req, r) => done(`http:${r.statusCode}`));
        ws.on('open', () => { if (hello) ws.send(JSON.stringify(hello)); });
        ws.on('message', (d) => {
            let m; try { m = JSON.parse(String(d)); } catch { return; }
            if (m.type === 'welcome') done('welcome');
            else if (m.type === 'error') done(`auth:${m.error}`);
            else if (m.id !== undefined) done(`command:${m.method}`);
        });
        ws.on('close', () => done('closed'));
        ws.on('error', () => { /* close / unexpected-response follow */ });
    });
    let r = await attempt(null, { type: 'hello', clientId: 'rogue', visible: true });
    check(/^auth:.*token/.test(r), 'bridge: hello without a token is rejected', r);
    r = await attempt(appOrigin, { type: 'hello', clientId: 'rogue2', visible: true, headless: true, token: 'guessed-token-guessed-token' });
    check(/^auth:.*wrong/.test(r), 'bridge: wrong token from the app origin is rejected', r);
    r = await attempt('http://localhost:6006', { type: 'hello', clientId: 'rogue3', visible: true });
    check(r === 'http:403', 'bridge: foreign localhost Origin is refused at the handshake', r);
    r = await attempt('https://evil.example', { type: 'hello', clientId: 'rogue4', visible: true });
    check(r === 'http:403', 'bridge: foreign site Origin is refused at the handshake', r);
    r = await attempt(appOrigin, null);
    check(r === 'closed' || /^auth:/.test(r), 'bridge: a silent connection is closed after the auth timeout', r);
    res = await call('get_status', {});
    check(jsonOf(res)?.clients?.length === 1, 'bridge: rejected connections never become clients', jsonOf(res)?.clients);

    // save_path is confined (repo / temp / PATCHTOY_SAVE_DIRS), never into hidden folders
    res = await call('render_preview', { width: 64, save_path: '../../patchtoy-e2e-escape.png' });
    check(res.isError && /outside the allowed folders/.test(textOf(res)) && !fs.existsSync(path.resolve(repoRoot, '../../patchtoy-e2e-escape.png')), 'render_preview save_path outside the repo is rejected', textOf(res).slice(0, 300));
    res = await call('render_preview', { width: 64, save_path: '.git/hooks/pre-commit' });
    check(res.isError && /not allowed/.test(textOf(res)), 'render_preview save_path into .git is rejected', textOf(res).slice(0, 300));
    const okPath = path.join(os.tmpdir(), `patchtoy-e2e-${Date.now()}.sh`);
    res = await call('screenshot_editor', { save_path: okPath });
    const saved = jsonOf(res)?.saved;
    check(!res.isError && /\.png$/.test(saved || '') && fs.existsSync(saved) && !fs.existsSync(okPath), 'screenshot_editor save_path gets a forced .png extension', saved || textOf(res).slice(0, 300));
    if (saved) try { fs.unlinkSync(saved); } catch { /* ignore */ }
    res = await call('set_audio', { mode: 'file', url_or_path: path.join(os.homedir(), '.ssh', 'id_rsa') });
    check(res.isError && /Not an audio file|hidden/.test(textOf(res)), 'set_audio refuses non-audio / hidden files', textOf(res).slice(0, 200));

    // Page-supplied export names: run the real start_recording handler against a fake page answer
    const { createTools } = await import('./lib/tools.mjs');
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-e2e-traversal-'));
    const fakeRepo = path.join(fakeRoot, 'repo');
    fs.mkdirSync(fakeRepo);
    let answer = null;
    const fakeSession = {
        repoRoot: fakeRepo,
        withProject: (_n, fn) => fn({ headless: true }, 'x', {}),
        withClient: (fn) => fn({ headless: true }),
        call: async () => ({ ...answer }),
    };
    const rec = createTools(fakeSession).find(t => t.name === 'start_recording');
    for (const filename of ['../../escaped.txt', '/etc/evil.webm', '..\\..\\win.mp4', '.zshrc', 'sub/dir/../../x.webm']) {
        answer = { filename, ext: 'webm', data_base64: Buffer.from('x').toString('base64') };
        let out;
        try { out = (await rec.handler({ duration: 1 })).data; } catch (e) { out = { error: e.message }; }
        const abs = out.saved_abs || '';
        const inside = abs && path.dirname(abs) === fs.realpathSync(path.join(fakeRepo, 'exports'));
        check(inside && /\.webm$/.test(abs) && !path.basename(abs).startsWith('.'), `export name ${JSON.stringify(filename)} stays in exports/ (${path.basename(abs)})`, out);
    }
    answer = { filename: 'clip.sh', ext: '../../sh', data_base64: 'eA==' };
    const out = (await rec.handler({ duration: 1 })).data;
    check(/\.bin$/.test(out.saved_abs || ''), 'export with an unknown ext is saved as .bin', out);
    const stray = fs.readdirSync(fakeRoot).filter(f => f !== 'repo');
    check(stray.length === 0 && !fs.existsSync('/etc/evil.webm'), 'no file written outside exports/', stray);
    fs.rmSync(fakeRoot, { recursive: true, force: true });

    check(auth.sanitizeFilename('../../a b?.txt', { ext: 'png' }) === 'a_b.png', 'sanitizeFilename strips dirs and forces the extension', auth.sanitizeFilename('../../a b?.txt', { ext: 'png' }));
}

// ------------------------------------------------------------------ bridge robustness (review item 8)
// In-process bridges and a second headless page: payload caps, chunked results, size
// limits, heartbeat, page-side command queue, atomic create_project, honest annotations,
// fatal uncaught exceptions and the I/O bridge's origin policy.
async function bridgeRobustnessChecks(appUrl, tools) {
    const { default: WebSocket } = await import('ws');
    const { BridgeServer } = await import('./lib/bridge.mjs');
    const { PatchToySession, ToolError } = await import('./lib/session.mjs');
    const { createTools } = await import('./lib/tools.mjs');
    const { createOriginPolicy } = await import('./lib/auth.mjs');
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const TOKEN = 'e2e-robustness-token-0123456789';

    // A fake page: connects, says hello with the token, answers calls with respond(msg, ws)
    const fakePage = (port, { origin = null, autoPong = true, respond = null } = {}) => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { ...(origin ? { origin } : {}), autoPong, maxPayload: 0 });
        const t = setTimeout(() => reject(new Error('fake page: no welcome')), 5000);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', clientId: `fake-${Math.random().toString(36).slice(2, 8)}`, token: TOKEN, visible: true })));
        ws.on('message', (d) => {
            let m; try { m = JSON.parse(String(d)); } catch { return; }
            if (m.type === 'welcome') { clearTimeout(t); resolve(ws); }
            else if (m.id !== undefined && respond) respond(m, ws);
        });
        ws.on('error', () => { });
    });
    const closeCode = (ws, ms = 3000) => new Promise((resolve) => {
        const t = setTimeout(() => resolve('open'), ms);
        ws.on('close', (code) => { clearTimeout(t); resolve(code); });
    });
    const sendChunked = (ws, id, obj, size) => {
        const text = JSON.stringify(obj);
        const n = Math.ceil(text.length / size);
        for (let i = 0; i < n; i++) ws.send(JSON.stringify({ type: 'chunk', id, seq: i, last: i === n - 1, data: text.slice(i * size, (i + 1) * size) }));
    };
    const startBridge = async (opts = {}) => {
        const b = new BridgeServer({ port: 0, allowPortFallback: false, ...opts });
        await b.start();
        b.addToken(TOKEN, 'headless');
        return b;
    };

    // --- pre-auth frame cap, then the full limit once authenticated
    {
        const b = await startBridge();
        try {
            const raw = new WebSocket(`ws://127.0.0.1:${b.port}`, { maxPayload: 0 });
            await new Promise((r, j) => { raw.on('open', r); raw.on('error', j); });
            const closed = closeCode(raw);
            raw.send('x'.repeat(200 * 1024)); // 200 KB before any hello
            check(await closed === 1009, 'bridge: a 200 KB frame before authentication is refused (close 1009)', await closed);
            const big = 'y'.repeat(2 * 1024 * 1024);
            const page = await fakePage(b.port, { respond: (m, ws) => ws.send(JSON.stringify({ id: m.id, result: { big } })) });
            const c = b.readyClients()[0];
            const r = await c.call('getGraph', {}, 10000);
            check(r?.big?.length === big.length, 'bridge: an authenticated page may send a 2 MB frame', r?.big?.length);
            page.terminate();
        } finally { await b.close(); }
    }

    // --- chunked results, the reassembly size limit and the frame limit (m1)
    {
        const b = await startBridge({ maxPayload: 1024 * 1024, maxResponseChars: 3 * 1024 * 1024 });
        try {
            let mode = 'ok';
            const payload = 'z'.repeat(2 * 1024 * 1024);
            const page = await fakePage(b.port, {
                respond: (m, ws) => {
                    if (mode === 'ok') sendChunked(ws, m.id, { id: m.id, result: { data_base64: payload } }, 256 * 1024);
                    else if (mode === 'huge') sendChunked(ws, m.id, { id: m.id, result: { data_base64: payload + payload } }, 256 * 1024);
                    else ws.send(JSON.stringify({ id: m.id, result: { data_base64: payload } })); // one 2 MB frame > 1 MB limit
                },
            });
            const c = b.readyClients()[0];
            let r = await c.call('startRecording', {}, 10000);
            check(r?.data_base64?.length === payload.length, 'bridge: a chunked 2 MB result is reassembled', r?.data_base64?.length);
            mode = 'huge';
            let err = null;
            try { await c.call('startRecording', {}, 10000); } catch (e) { err = e; }
            check(err && err.data?.too_large && /larger than the bridge limit/.test(err.message), 'bridge: a result over the size limit fails that call with a size error', err?.message);
            mode = 'ok';
            r = await c.call('startRecording', {}, 10000).catch(e => ({ error: e.message }));
            check(r?.data_base64?.length === payload.length && b.readyClients().length === 1, 'bridge: the connection stays usable after an oversized result', r?.error || 'ok');
            mode = 'frame';
            err = null;
            try { await c.call('startRecording', {}, 10000); } catch (e) { err = e; }
            check(err && err.data?.too_large && /frame limit/.test(err.message) && !/disconnected/.test(err.message), 'bridge: a frame over the limit (close 1009) reports the size limit, not a disconnect', err?.message);
            // ... and the session never re-runs such a call
            let runs = 0;
            const retried = await PatchToySession.prototype._retryOnDisconnect.call({}, async () => { runs++; throw new ToolError(err?.message || 'x', err?.data); }).catch(e => e);
            let runs2 = 0;
            await PatchToySession.prototype._retryOnDisconnect.call({}, async () => { runs2++; throw new ToolError('The browser page disconnected'); }).catch(() => { });
            check(runs === 1 && retried instanceof Error && runs2 === 2, 'session: too-large results are not retried (real disconnects still are, once)', { runs, runs2 });
            page.terminate();
        } finally { await b.close(); }
    }

    // --- heartbeat (m4): a peer that stops answering pings is dropped, a healthy one stays
    {
        const b = await startBridge({ heartbeatMs: 150 });
        try {
            const healthy = await fakePage(b.port);
            const dead = await fakePage(b.port, { autoPong: false });
            const clients = b.readyClients();
            check(clients.length === 2, 'heartbeat: two fake pages connected', clients.length);
            // The non-ponging page never answers the call either: it must fail fast, not at the 60 s timeout
            const deadConn = clients.find(c => c.ws._socket?.remotePort === dead._socket?.localPort);
            const t0 = Date.now();
            const pending = deadConn ? deadConn.call('getGraph', {}, 60000).then(() => 'answered', e => e.message) : Promise.resolve('no conn');
            const closed = closeCode(dead, 3000);
            const why = await pending;
            check(/stopped responding \(no heartbeat\)/.test(why) && Date.now() - t0 < 3000, 'heartbeat: a page that stops answering pings is dropped and its call fails at once', { why, ms: Date.now() - t0 });
            check(await closed !== 'open', 'heartbeat: the dead connection is terminated', await closed);
            await wait(500);
            check(b.readyClients().length === 1 && healthy.readyState === WebSocket.OPEN, 'heartbeat: a page that answers pings stays connected', b.readyClients().length);
            healthy.terminate();
        } finally { await b.close(); }
    }

    // --- page-side command queue (m2) and chunked results from the real BridgeClient
    {
        const appOrigin = new URL(appUrl).origin;
        const b = await startBridge({ originCheck: createOriginPolicy({ origins: [appUrl] }) });
        const { chromium } = await import('playwright-core');
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try {
            const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            await ctx.addInitScript(() => { try { localStorage.setItem('patchtoy_ui_params_open', '1'); } catch { /* ignore */ } });
            const page = await ctx.newPage();
            const pageErrors = [];
            page.on('pageerror', e => pageErrors.push(e.message));
            const u = new URL(appUrl);
            u.searchParams.set('bridge', String(b.port));
            u.searchParams.set('headless', '1');
            u.searchParams.set('bridgeToken', TOKEN);
            const waitClient = b.waitForClient(() => true, 45000);
            await page.goto(u.href, { waitUntil: 'domcontentloaded' });
            const c = await waitClient;
            check(new URL(page.url()).origin === appOrigin && c.headless, 'queue: a second headless page connected to a private bridge');
            await page.evaluate(() => {
                const api = window.__patchtoyBridge.api;
                const orig = api.handle.bind(api);
                window.__cmdLog = [];
                window.__dialogs = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
                api.handle = async (method, params) => {
                    window.__cmdLog.push(`start:${method}`);
                    try {
                        if (method === 'getInfo') return { big: 'q'.repeat(3 * 1024 * 1024 + 7) }; // forces chunking
                        const r = await orig(method, params);
                        await new Promise(res => setTimeout(res, 150));
                        return r;
                    } finally { window.__cmdLog.push(`end:${method}`); }
                };
            });
            const results = await Promise.allSettled([c.call('getGraph', {}, 30000), c.call('compile', {}, 30000), c.call('exportProject', {}, 30000)]);
            const log = await page.evaluate(() => window.__cmdLog.slice());
            const serial = log.join(',') === 'start:getGraph,end:getGraph,start:compile,end:compile,start:exportProject,end:exportProject';
            check(serial && results.every(r => r.status === 'fulfilled'), 'queue: overlapping commands run one at a time, in order', { log, results: results.map(r => r.status === 'fulfilled' ? 'ok' : r.reason?.message) });
            const restored = await page.evaluate(() => window.alert === window.__dialogs.alert && window.confirm === window.__dialogs.confirm && window.prompt === window.__dialogs.prompt);
            check(restored, 'queue: the page dialogs are the originals again after overlapping commands');
            const big = await c.call('getInfo', {}, 30000).catch(e => ({ error: e.message }));
            check(big?.big?.length === 3 * 1024 * 1024 + 7, 'chunking: a 3 MB result from the real page arrives through chunk frames', big?.error || big?.big?.length);
            check(pageErrors.length === 0, 'queue: no page errors', pageErrors);
            await ctx.close();
        } finally {
            await browser.close();
            await b.close();
        }
    }

    // --- create_project is atomic (m6)
    {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-e2e-atomic-'));
        const projDir = path.join(tmp, 'projects');
        const quiet = process.env.PATCHTOY_MCP_QUIET;
        process.env.PATCHTOY_MCP_QUIET = '1';
        const savedWrite = process.stderr.write.bind(process.stderr);
        if (!process.env.E2E_VERBOSE) process.stderr.write = () => true; // the session's warnings are expected here
        const sess = new PatchToySession({ repoRoot: tmp, projectsDir: projDir, bridgePort: 0, clientMode: 'live', persistActive: false, allowPortFallback: false, livePairing: true, appUrl: 'http://localhost:5999/' });
        try {
            await sess.start();
            const create = createTools(sess).find(t => t.name === 'create_project');
            await sess.store.create('Keep Me');
            sess.setActive('keep-me');
            let err = null;
            try { await create.handler({ name: 'Atomic One' }); } catch (e) { err = e; }
            check(err && /No live browser tab/.test(err.message) && !sess.store.exists('atomic-one') && sess.activeSlug === 'keep-me', 'create_project without a browser writes no file and keeps the active project', { err: err?.message, exists: sess.store.exists('atomic-one'), active: sess.activeSlug });
            // A page that fails loadProject: the new file is removed again
            const ws = await new Promise((resolve, reject) => {
                const w = new WebSocket(`ws://127.0.0.1:${sess.bridge.port}`);
                w.on('open', () => w.send(JSON.stringify({ type: 'hello', clientId: 'fake-live', token: sess.pairingToken, visible: true })));
                w.on('message', (d) => {
                    const m = JSON.parse(String(d));
                    if (m.type === 'welcome') resolve(w);
                    else if (m.id !== undefined) w.send(JSON.stringify(m.method === 'loadProject' ? { id: m.id, error: { message: 'simulated load failure' } } : { id: m.id, result: { ok: true } }));
                });
                w.on('error', reject);
            });
            err = null;
            try { await create.handler({ name: 'Atomic Two' }); } catch (e) { err = e; }
            check(err && /simulated load failure/.test(err.message) && !sess.store.exists('atomic-two') && sess.activeSlug === 'keep-me', 'create_project that fails after writing removes the file and restores the active project', { err: err?.message, exists: sess.store.exists('atomic-two'), active: sess.activeSlug });
            err = null;
            try { await create.handler({ name: 'Atomic Two' }); } catch (e) { err = e; }
            check(err && !/already exists/.test(err.message), 'create_project can be retried with the same name after a failure', err?.message);
            ws.terminate();
        } finally {
            await sess.shutdown();
            process.stderr.write = savedWrite;
            if (quiet === undefined) delete process.env.PATCHTOY_MCP_QUIET; else process.env.PATCHTOY_MCP_QUIET = quiet;
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    // --- live mode targets the user's tab, not pages of test servers / automated browsers
    {
        const { startTestVite } = await import('../tests/lib/vite-server.mjs');
        // The "user's" dev server: role 'dev' like `npm run dev` (appUrl is a private, HMR-off server)
        const userVite = await startTestVite({ role: 'dev' });
        const agentVite = await startTestVite(); // an agent's private server (HMR off: role 'private')
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-e2e-live-'));
        const quiet = process.env.PATCHTOY_MCP_QUIET;
        process.env.PATCHTOY_MCP_QUIET = '1';
        // repoRoot = this repo: the dev servers read the pairing file from its node_modules/.cache
        const sess = new PatchToySession({ repoRoot, projectsDir: path.join(tmp, 'projects'), bridgePort: 0, clientMode: 'live', persistActive: false, allowPortFallback: false, livePairing: true, appUrl: userVite.url });
        const { chromium } = await import('playwright-core');
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try {
            await sess.start();
            const bport = sess.bridge.port;
            const notWebdriver = () => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
            const openTab = async (base, { spoofUser }) => {
                const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
                if (spoofUser) await ctx.addInitScript(notWebdriver); // looks like a person's browser
                const page = await ctx.newPage();
                const u = new URL(base);
                u.searchParams.set('bridge', String(bport));
                const before = new Set(sess.bridge.readyClients());
                const waitClient = sess.bridge.waitForClient(c => !before.has(c), 45000);
                await page.goto(u.href, { waitUntil: 'domcontentloaded' });
                const c = await waitClient;
                return { ctx, page, c, webdriver: await page.evaluate(() => navigator.webdriver) };
            };
            const user = await openTab(userVite.url, { spoofUser: true });
            await wait(300);
            const agentPrivate = await openTab(agentVite.url, { spoofUser: true }); // another agent's private (HMR-off) server
            await wait(300);
            const agentDriven = await openTab(userVite.url, { spoofUser: false }); // Playwright page on the user's own server
            check(user.webdriver === false && agentPrivate.webdriver === false && agentDriven.webdriver === true, 'live target: the test tabs report the intended navigator.webdriver', [user.webdriver, agentPrivate.webdriver, agentDriven.webdriver]);
            check(user.c.role === 'live' && agentPrivate.c.role === 'automation' && agentDriven.c.role === 'automation',
                'live target: the user-origin tab pairs as live; a private dev server\'s page and a webdriver page pair as automation',
                [user.c.role, agentPrivate.c.role, agentDriven.c.role]);
            check(sess.bridge.pickClient('live') === user.c && sess.bridge.pickClient('auto') === user.c,
                'live target: live and auto pick the user\'s tab even though the automation tabs connected later', { live: sess.bridge.pickClient('live')?.id, user: user.c.id });
            const st = sess.status();
            const row = (c) => st.clients.find(x => x.id === c.id) || {};
            check(row(user.c).origin === new URL(userVite.url).origin && row(user.c).role === 'live' && row(user.c).target === true && row(user.c).preferred_origin === true
                && row(agentPrivate.c).origin === new URL(agentVite.url).origin && row(agentPrivate.c).role === 'automation' && /private/.test(row(agentPrivate.c).role_reason || '')
                && row(agentDriven.c).role === 'automation' && /webdriver/.test(row(agentDriven.c).role_reason || ''),
                'live target: get_status shows each client\'s origin and role', st.clients);
            await user.ctx.close();
            await wait(500);
            check(sess.bridge.pickClient('live') === null && sess.bridge.pickClient('auto') === null && sess.bridge.readyClients().length === 2,
                'live target: with the user\'s tab gone, automation tabs are still never picked (live / auto)', sess.bridge.readyClients().map(c => c.role));
            check(sess.bridge.pickClient(null, agentPrivate.c.id) === agentPrivate.c, 'live target: an automation tab can still be targeted by client_id');
            // The user reloads / opens the tab again: it is the target again
            const userAgain = await openTab(userVite.url, { spoofUser: true });
            check(sess.bridge.pickClient('live') === userAgain.c, 'live target: a reloaded user tab becomes the target again');
            await agentPrivate.ctx.close();
            await agentDriven.ctx.close();
            await userAgain.ctx.close();
        } finally {
            await browser.close();
            await sess.shutdown();
            await userVite.close();
            await agentVite.close();
            if (quiet === undefined) delete process.env.PATCHTOY_MCP_QUIET; else process.env.PATCHTOY_MCP_QUIET = quiet;
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    // --- honest annotations (m8)
    const rp = tools.find(t => t.name === 'render_preview');
    check(rp && rp.annotations?.readOnlyHint !== true, 'render_preview is not annotated read-only (it steps live Feedback state)', rp?.annotations);
    const se = tools.find(t => t.name === 'screenshot_editor');
    check(se && se.annotations?.readOnlyHint !== true && se.annotations?.destructiveHint === false, 'screenshot_editor is not annotated read-only (fit_view pans / zooms the editor), and not destructive', se?.annotations);

    // --- uncaught exceptions are logged with a stack and stop the server; rejections are logged (m12)
    {
        const { spawn } = await import('node:child_process');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-e2e-crash-'));
        const preload = path.join(tmp, 'crash.mjs');
        fs.writeFileSync(preload, "setTimeout(() => { Promise.reject(new Error('e2e-stray-rejection')); }, 1200);\nsetTimeout(function e2eBoom() { throw new Error('e2e-boom'); }, 2500);\n");
        const child = spawn(process.execPath, ['--import', preload, path.join(repoRoot, 'mcp', 'server.mjs')], {
            cwd: repoRoot,
            env: { ...process.env, PATCHTOY_BRIDGE_PORT: '0', PATCHTOY_CLIENT_MODE: 'headless', PATCHTOY_PROJECTS_DIR: path.join(tmp, 'projects'), PATCHTOY_MCP_QUIET: '' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d; });
        const code = await new Promise((resolve) => {
            const t = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 20000);
            child.on('exit', (c) => { clearTimeout(t); resolve(c); });
        });
        const rej = stderr.indexOf('unhandled promise rejection: Error: e2e-stray-rejection');
        const boom = stderr.indexOf('uncaught exception');
        check(code === 1 && boom > 0 && /e2e-boom\n\s+at .*e2eBoom/.test(stderr) && /shutting down \(uncaught exception\)/.test(stderr),
            'server: an uncaught exception is logged with its stack and the server shuts down (exit 1)', { code, stderr: stderr.slice(-600) });
        check(rej > 0 && rej < boom, 'server: a stray promise rejection is logged with its stack and the server keeps running', stderr.slice(0, 600));
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    // --- I/O bridge: the shared origin policy (no "any localhost"), token still required, pre-auth cap
    {
        const { IOBridge } = await import('./lib/io-bridge.mjs');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-e2e-io-'));
        const io = new IOBridge({ port: 0, appUrl: 'http://localhost:5999/', repoRoot: tmp, serial: 'off', logger: { log: () => { }, warn: () => { } } });
        await io.start();
        const tryIo = (origin, hello, extra = null) => new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${io.port}`, { ...(origin ? { origin } : {}), maxPayload: 0 });
            const done = (v) => { clearTimeout(t); try { ws.terminate(); } catch { /* ignore */ } resolve(v); };
            const t = setTimeout(() => done('timeout'), 5000);
            ws.on('unexpected-response', (_q, r) => done(`http:${r.statusCode}`));
            ws.on('open', () => { if (extra === 'big-preauth') ws.send('x'.repeat(200 * 1024)); else if (hello) ws.send(JSON.stringify(hello)); });
            ws.on('message', (d) => {
                const m = JSON.parse(String(d));
                if (m.type === 'welcome') {
                    if (extra === 'big-after') { ws.send(JSON.stringify({ op: 'status', pad: 'p'.repeat(300 * 1024) })); setTimeout(() => done(ws.readyState === WebSocket.OPEN ? 'welcome+big-ok' : 'welcome+closed'), 500); }
                    else done('welcome');
                } else if (m.type === 'error' && m.code === 'auth') done('auth');
            });
            ws.on('close', (code) => done(`closed:${code}`));
            ws.on('error', () => { });
        });
        try {
            const hello = { type: 'hello', token: io.token, client: 'e2e', protocol: 1 };
            check(await tryIo('http://localhost:6006', hello) === 'http:401', 'io-bridge: a foreign localhost Origin is refused (shared origin policy)');
            check(await tryIo('http://127.0.0.1:5999', hello) === 'welcome', 'io-bridge: the app origin (and its loopback aliases) is accepted');
            check(await tryIo('http://127.0.0.1:5999', { ...hello, token: 'wrong-token-wrong-token' }) === 'auth', 'io-bridge: the app origin still needs the token');
            check(await tryIo(null, null, 'big-preauth') === 'closed:1009', 'io-bridge: a 200 KB frame before pairing is refused (close 1009)');
            check(await tryIo(null, hello, 'big-after') === 'welcome+big-ok', 'io-bridge: a paired connection may send frames up to 1 MB');
        } finally {
            await io.close();
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
}

let created = false;
try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    console.log(`- listTools: ${names.length} tools`);
    for (const n of ['list_projects', 'create_project', 'open_project', 'undo', 'redo', 'history', 'get_project', 'delete_project', 'duplicate_project', 'rename_project',
        'list_node_types', 'add_node', 'remove_node', 'set_node_data', 'move_node', 'connect', 'disconnect', 'create_custom_node',
        'update_custom_node', 'build_graph', 'compile', 'render_preview', 'screenshot_editor', 'auto_layout', 'set_background_preview', 'get_status',
        'set_audio', 'get_audio_status', 'io_bridge', 'load_model', 'group_nodes', 'ungroup', 'rename_group', 'list_groups', 'list_params', 'set_param', 'list_scenes', 'set_scene', 'read_probes', 'start_recording', 'stop_recording', 'output_window']) {
        check(names.includes(n), `tool ${n} registered`);
    }

    // 1. Create a project
    let res = await call('create_project', { name: projectName, description: 'created by mcp/test-e2e.mjs' });
    let data = jsonOf(res);
    check(!res.isError && data?.created, 'create_project', textOf(res));
    created = !res.isError;
    const slug = data?.created;
    const file = path.join(projectsDir, `${slug}.patchtoy.json`);
    check(fs.existsSync(file), `project file written (${path.relative(repoRoot, file)})`);

    // 1b. Bridge security: only our headless page may connect
    await securityChecks();

    // 1c. Bridge robustness: payload caps, chunking, heartbeat, command queue, atomic create, crash handling
    await bridgeRobustnessChecks(jsonOf(await call('get_status', {}))?.app_url, tools);

    // 2. Node library
    res = await call('list_node_types', { search: 'uv' });
    data = jsonOf(res);
    check(!res.isError && data?.types?.some(t => t.name === 'UV'), 'list_node_types finds UV', textOf(res));

    // 3. Custom noise node (also exercises the GLSL pre-check)
    res = await call('create_custom_node', {
        name: 'WobbleNoise',
        glsl: `float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
    float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
    float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`,
    });
    data = jsonOf(res);
    check(!res.isError && data?.type?.name === 'WobbleNoise', 'create_custom_node WobbleNoise', textOf(res));

    res = await call('create_custom_node', { name: 'Broken', glsl: 'float broken(vec2 uv) {\n  return uv.x + nope;\n}' });
    data = jsonOf(res);
    check(res.isError && data?.glsl_errors?.[0]?.line === 2, 'create_custom_node reports GLSL error with line number', textOf(res));

    // 4. Build a graph: UV * scale -> noise, Time -> Sin, combine -> Vec3 -> Preview
    res = await call('build_graph', {
        nodes: [
            { key: 'uv', type: 'UV' },
            { key: 'scale', type: 'Vec2', data: { x: 8, y: 8, useUniform: false } },
            { key: 'scaled', type: 'Multiply' },
            { key: 'noise', type: 'WobbleNoise' },
            { key: 'time', type: 'Time' },
            { key: 'sin', type: 'Sin' },
            { key: 'color', type: 'Vec3', data: { useUniform: false } },
            { key: 'out', type: 'Preview' },
        ],
        connections: [
            { from: 'uv.uv', to: 'scaled.a' },
            { from: 'scale.out', to: 'scaled.b' },
            { from: 'scaled.result', to: 'noise.p' },
            { from: 'time', to: 'sin.x' },
            { from: 'noise', to: 'color.x' },
            { from: 'uv.uv.y', to: 'color.y' },
            { from: 'sin.result', to: 'color.z' },
            { from: 'color.out', to: 'out.color' },
        ],
    });
    data = jsonOf(res);
    check(!res.isError && !data?.errors, 'build_graph without connection errors', textOf(res));
    check(data?.compile?.ok === true, 'build_graph compile ok', data?.compile);
    const ids = data?.ids || {};

    // 4b. Undo history: build_graph is one step; undo / redo restore it with the same ids
    {
        const nodesNow = data?.nodes_created ?? Object.keys(ids).length;
        let hres = await call('history', {});
        let hd = jsonOf(hres);
        check(!hres.isError && /Build graph/.test(hd?.undo?.[0] || ''), 'history: build_graph is one step', textOf(hres).slice(0, 300));
        hres = await call('undo', {});
        hd = jsonOf(hres);
        check(!hres.isError && hd?.undone?.length === 1 && /Build graph/.test(hd.undone[0]) && hd.nodes === 0, 'undo removes the whole build_graph', textOf(hres).slice(0, 300));
        hres = await call('redo', {});
        hd = jsonOf(hres);
        const gp = jsonOf(await call('get_project', {}));
        const back = (gp?.graph?.nodes || gp?.nodes || []).map(n => n.id);
        check(!hres.isError && hd?.redone?.length === 1 && hd.nodes >= nodesNow && Object.values(ids).every(id => back.includes(id)), 'redo brings it back with the same node ids', { redo: hd, back });
    }

    // 5. Single edits
    res = await call('set_node_data', { id: ids.scale, data: { x: 12, y: 12 } });
    check(!res.isError, 'set_node_data on Vec2', textOf(res));
    res = await call('connect', { from_node: ids.uv, to_node: ids.out, to_input: 'nope' });
    data = jsonOf(res);
    check(res.isError && Array.isArray(data?.inputs), 'connect to a bad port lists valid inputs', textOf(res));
    res = await call('add_node', { type: 'float', data: { value: 0.5 } });
    data = jsonOf(res);
    check(!res.isError && data?.node?.type === 'Float', 'add_node resolves type case-insensitively', textOf(res));
    const floatId = data?.node?.id;
    res = await call('remove_node', { id: floatId });
    check(!res.isError, 'remove_node');

    // 6. Compile
    res = await call('compile', { include_source: true });
    data = jsonOf(res);
    check(!res.isError && data?.ok === true, 'compile ok', textOf(res).slice(0, 600));
    check(typeof data?.previews?.[0]?.fragment === 'string' && data.previews[0].fragment.includes('valueNoise'), 'compile include_source has the custom function');

    // 7. Render
    res = await call('render_preview', { width: 256, height: 256, time: 2.0 });
    data = jsonOf(res);
    const img = (res.content || []).find(c => c.type === 'image');
    check(!res.isError && img && img.mimeType === 'image/png', 'render_preview returns a PNG image', textOf(res));
    if (img) {
        const buf = Buffer.from(img.data, 'base64');
        fs.writeFileSync(outPng, buf);
        check(buf.subarray(1, 4).toString() === 'PNG', `PNG signature (saved to ${outPng})`);
        check(buf.readUInt32BE(16) === 256 && buf.readUInt32BE(20) === 256, 'PNG is 256x256');
    }
    check(data?.stats && data.stats.blank === false && data.stats.distinct_colors_sampled > 50 && data.stats.luma_std > 5, 'rendered image is not blank', data?.stats);

    res = await call('render_preview', { node_id: ids.noise, width: 64, height: 64 });
    data = jsonOf(res);
    check(!res.isError && data?.stats?.blank === false, 'render_preview of an intermediate node (noise)', textOf(res));

    // 7b. Audio / beat sync: metronome mode + renders at two beat phases must differ
    res = await call('set_audio', { mode: 'metronome', bpm: 120 });
    data = jsonOf(res);
    check(!res.isError && data?.source === 'metronome' && Math.abs(data?.bpm - 120) < 0.01, 'set_audio metronome 120 BPM', textOf(res));
    res = await call('create_custom_node', {
        name: 'BeatFlash',
        glsl: 'vec3 beatFlash(vec2 uv) {\n    float ring = smoothstep(0.02, 0.0, abs(length(uv - 0.5) - 0.1 - 0.3 * u_beatPhase));\n    return vec3(u_beat) * vec3(1.0, 0.45, 0.2) + ring + u_kick * 0.2;\n}',
    });
    check(!res.isError, 'create_custom_node using u_beat / u_beatPhase / u_kick (no wiring)', textOf(res));
    res = await call('build_graph', {
        nodes: [{ key: 'flash', type: 'BeatFlash' }, { key: 'pf', type: 'Preview' }, { key: 'beat', type: 'Beat' }, { key: 'pb', type: 'Preview' }],
        connections: [{ from: `${ids.uv}.uv`, to: 'flash.uv' }, { from: 'flash', to: 'pf' }, { from: 'beat.pulse', to: 'pb' }],
    });
    data = jsonOf(res);
    check(!res.isError && data?.compile?.ok === true, 'build_graph with BeatFlash + Beat node compiles', textOf(res).slice(0, 600));
    const pf = data?.ids?.pf, pb = data?.ids?.pb;
    res = await call('compile', { include_source: true });
    data = jsonOf(res);
    const pfSrc = data?.previews?.find(p => p.id === pf)?.fragment || '';
    check(/uniform float u_beat;/.test(pfSrc) && /uniform float u_beatPhase;/.test(pfSrc) && !/u_bass/.test(pfSrc), 'audio uniforms declared only when used', pfSrc.split('\n').filter(l => l.startsWith('uniform')));
    const r0 = jsonOf(await call('render_preview', { preview_id: pf, width: 96, height: 96, beat_phase: 0 }));
    const r1 = jsonOf(await call('render_preview', { preview_id: pf, width: 96, height: 96, beat_phase: 0.5 }));
    check(r0?.stats && r1?.stats && Math.abs(r0.stats.mean_rgb[0] - r1.stats.mean_rgb[0]) > 30, 'render at beat_phase 0 vs 0.5 differ (u_beat)', { on: r0?.stats?.mean_rgb, off: r1?.stats?.mean_rgb });
    check(r0?.beat_phase === 0 && r1?.beat_phase === 0.5 && Math.abs(r1?.time - 0.25) < 1e-6, 'render_preview reports the beat position (u_time follows the beat)', { beat_phase: r1?.beat_phase, time: r1?.time });
    const b0 = jsonOf(await call('render_preview', { preview_id: pb, width: 32, height: 32, beat: 8 }));
    const b1 = jsonOf(await call('render_preview', { preview_id: pb, width: 32, height: 32, beat: 8.75 }));
    check(b0?.stats?.luma_min > 240 && b1?.stats?.luma_max < 40, 'Beat node pulse: bright on the beat, dark at 0.75', { on: b0?.stats, off: b1?.stats });
    res = await call('get_audio_status', {});
    data = jsonOf(res);
    check(!res.isError && data?.source === 'metronome' && data?.clock?.mode === 'metronome' && Array.isArray(data?.uniforms) && data.uniforms.includes('u_beatTime'), 'get_audio_status', textOf(res).slice(0, 400));
    // 7c. Audio textures: metronome spectrum is non-zero and deterministic, lazily bound,
    //     uploaded every frame without relinking; audio off gives a zero texture
    res = await call('create_custom_node', {
        name: 'SpectrumGlow',
        glsl: 'vec3 spectrumGlow(vec2 uv) {\n    float lvl = texture(u_spectrum, vec2(uv.x, 0.5)).r;\n    return vec3(step(uv.y, lvl));\n}',
    });
    check(!res.isError, 'create_custom_node reading u_spectrum (no wiring)', textOf(res));
    res = await call('build_graph', {
        nodes: [{ key: 'at', type: 'AudioTexture' }, { key: 'pat', type: 'Preview' }, { key: 'sg', type: 'SpectrumGlow' }, { key: 'psg', type: 'Preview' },
            { key: 'bars', type: 'SpectrumBars' }, { key: 'pbars', type: 'Preview' }],
        connections: [{ from: 'at.value', to: 'pat' }, { from: `${ids.uv}.uv`, to: 'sg.uv' }, { from: 'sg', to: 'psg' }, { from: 'bars.mask', to: 'pbars' }],
    });
    data = jsonOf(res);
    check(!res.isError && data?.compile?.ok === true, 'build_graph with Audio Texture / u_spectrum / Spectrum Bars compiles', textOf(res).slice(0, 600));
    const pat = data?.ids?.pat, psg = data?.ids?.psg, pbars = data?.ids?.pbars;
    res = await call('compile', { include_source: true });
    data = jsonOf(res);
    const srcOf = id => data?.previews?.find(p => p.id === id)?.fragment || '';
    check(/uniform sampler2D u_spectrum;/.test(srcOf(psg)) && !/u_spectrum|u_waveform|u_spectrogram/.test(srcOf(pf)),
        'u_spectrum declared only where GLSL references it', srcOf(psg).split('\n').filter(l => l.startsWith('uniform')));
    const imgOf = r => (r.content || []).find(c => c.type === 'image')?.data;
    const a0 = await call('render_preview', { preview_id: pat, width: 64, height: 32, beat: 4.25 });
    const a1 = await call('render_preview', { preview_id: pat, width: 64, height: 32, beat: 4.25 });
    const a2 = await call('render_preview', { preview_id: pat, width: 64, height: 32, beat: 4.75 });
    const t0 = jsonOf(a0);
    check(t0?.stats && t0.stats.mean_rgb[0] > 10 && t0.stats.luma_max > 60, 'metronome spectrum texture is non-zero', t0?.stats);
    check(imgOf(a0) && imgOf(a0) === imgOf(a1) && imgOf(a0) !== imgOf(a2), 'audio texture renders are deterministic per beat (and change with it)');
    const g0 = jsonOf(await call('render_preview', { preview_id: psg, width: 64, height: 64, beat: 4.25 }));
    const g1 = jsonOf(await call('render_preview', { preview_id: pbars, width: 64, height: 64, beat: 4.25 }));
    check(g0?.stats?.blank === false && g1?.stats?.blank === false, 'u_spectrum (custom GLSL) and Spectrum Bars render', { glsl: g0?.stats, bars: g1?.stats });
    let st0 = jsonOf(await call('get_audio_status', {}));
    await new Promise(r => setTimeout(r, 800));
    let st1 = jsonOf(await call('get_audio_status', {}));
    const spec0 = st0?.textures?.textures?.find(t => t.kind === 'spectrum');
    const spec1 = st1?.textures?.textures?.find(t => t.kind === 'spectrum');
    check(spec1 && spec1.mode === 'synth' && spec1.max > 0.1 && spec1.uploads > spec0.uploads, 'get_audio_status: spectrum texture live (synth), uploading every frame', { spec0, spec1 });
    check(st0?.textures?.program_links === st1?.textures?.program_links, 'no shader recompiles while audio textures update', { before: st0?.textures?.program_links, after: st1?.textures?.program_links });
    const nl = jsonOf(await call('list_node_types', { search: 'AudioTexture' }));
    check(JSON.stringify(nl || '').includes('u_spectrogram'), 'list_node_types documents the audio texture globals');

    res = await call('set_audio', { mode: 'off' });
    check(!res.isError && jsonOf(res)?.source === 'off', 'set_audio off');
    {
        const z = jsonOf(await call('render_preview', { preview_id: pat, width: 64, height: 32, beat: 4.25 }));
        const zs = jsonOf(await call('get_audio_status', {}));
        const zspec = zs?.textures?.textures?.find(t => t.kind === 'spectrum');
        check(z?.stats && z.stats.luma_max === 0 && zspec?.mode === 'zero' && zspec?.max === 0, 'audio off: zero spectrum texture', { stats: z?.stats, zspec });
    }

    // 8. Compile error reporting with node attribution
    res = await call('create_custom_node', { name: 'Typo', glsl: 'vec3 typo(vec2 uv) { return vec3(uv, 0.0); }' });
    check(!res.isError, 'create_custom_node Typo');
    res = await call('build_graph', {
        nodes: [{ key: 'typo', type: 'Typo' }, { key: 'p2', type: 'Preview' }],
        connections: [{ from: `${ids.uv}.uv`, to: 'typo.uv' }, { from: 'typo', to: 'p2' }],
    });
    data = jsonOf(res);
    check(!res.isError && data?.compile?.ok === true, 'second preview via build_graph referencing an existing node id', textOf(res));
    const p2 = data?.ids?.p2;
    res = await call('update_custom_node', { name: 'Typo', glsl: 'vec3 typo(vec2 uv) { return vec3(uv, 0.0) * missing; }', force: true });
    check(!res.isError, 'update_custom_node with force');
    res = await call('compile', {});
    data = jsonOf(res);
    const bad = data?.previews?.find(p => p.id === p2);
    check(data?.ok === false && bad?.ok === false && bad?.glsl_errors?.length > 0, 'compile reports GLSL errors', textOf(res).slice(0, 800));
    check(bad?.glsl_errors?.some(e => /missing/.test(e.message) || /missing/.test(e.code || '')), 'GLSL error mentions the identifier', bad?.glsl_errors);

    // 8b. Swizzles on generic outputs: checked against the type resolved from the node's
    // inputs, whatever the connection order (the Mix inputs are wired last here)
    res = await call('build_graph', {
        nodes: [
            { key: 'mix', type: 'Mix' },
            { key: 'mt', type: 'Float', data: { value: 0.25 } },
            { key: 'mb', type: 'Vec2', data: { x: 0.9, y: 0.1, useUniform: false } },
            { key: 'mc', type: 'Vec3', data: { useUniform: false } },
            { key: 'p3', type: 'Preview' },
        ],
        connections: [
            { from: 'mix.out.y', to: 'mc.x' },
            { from: 'mix.out.x', to: 'mc.z' },
            { from: `${ids.uv}.uv`, to: 'mix.a' },
            { from: 'mb', to: 'mix.b' },
            { from: 'mt', to: 'mix.t' },
            { from: 'mc', to: 'p3.color' },
        ],
    });
    data = jsonOf(res);
    const gen = data?.ids || {};
    // (top-level ok is false here: section 8 left the Typo preview broken on purpose)
    check(!res.isError && !data?.errors && data?.connections_made === 6, 'build_graph: swizzles on a generic (Mix) output wired before its inputs', textOf(res));
    check(data?.compile?.previews?.find(p => p.id === gen.p3)?.ok === true, 'generic-output swizzles compile', data?.compile);
    res = await call('compile', { include_source: true });
    data = jsonOf(res);
    let frag = data?.previews?.find(p => p.id === gen.p3)?.fragment || '';
    const mixVar = (/vec2 (node_\d+) = mix\(/.exec(frag) || [])[1];
    check(mixVar && new RegExp(`vec3\\(${mixVar}\\.y, [^,]+, ${mixVar}\\.x\\)`).test(frag), 'compiled GLSL applies the swizzles to the vec2 Mix result', frag.slice(frag.indexOf('void main')));
    res = await call('connect', { from_node: gen.mix, to_node: gen.mc, to_input: 'y', accessor: '.z' });
    data = jsonOf(res);
    check(res.isError && /\.z/.test(data?.error || textOf(res)) && /vec2/.test(textOf(res)), 'out-of-range swizzle on the resolved vec2 is rejected', textOf(res));
    res = await call('set_node_data', { id: gen.mt, data: { value: 0.75 } });
    data = jsonOf(res);
    check(!res.isError && data?.recompiled === false, 'set_node_data on a uniform Float only updates the uniform', textOf(res));

    // 8c. Inline values for unconnected inputs (library nodes read node.data[inputName])
    res = await call('build_graph', {
        nodes: [
            { key: 'ramp', type: 'ColorRamp', data: { c0: [1, 0, 0], c3: 'vec3(0.0, 0.0, 1.0)' } },
            { key: 'sum', type: 'Add', data: { b: 0.125 } },
            { key: 'alpha', type: 'Vec3ToVec4', data: { a: 0.5 } },
            { key: 'rot', type: 'RotateUV', data: { center: [0.25, 0.75] } },
            { key: 'p4', type: 'Preview' },
        ],
        connections: [
            { from: 'rot.uv.x', to: 'ramp.t' },
            { from: 'ramp', to: 'sum.a' },
            { from: 'sum', to: 'alpha.rgb' },
            { from: 'alpha', to: 'p4.color' },
        ],
    });
    data = jsonOf(res);
    const inl = data?.ids || {};
    check(!res.isError && !data?.errors && data?.compile?.previews?.find(p => p.id === data?.ids?.p4)?.ok === true, 'build_graph accepts inline values for unconnected inputs', textOf(res));
    res = await call('compile', { include_source: true });
    data = jsonOf(res);
    frag = data?.previews?.find(p => p.id === inl.p4)?.fragment || '';
    const want = ['vec3(1.0, 0.0, 0.0)', 'vec3(0.0, 0.0, 1.0)', 'vec3(0.125)', 'vec2(0.25, 0.75)', ', 0.5)'];
    check(want.every(w => frag.includes(w)), 'compiled GLSL uses the inline values', want.filter(w => !frag.includes(w)));
    res = await call('set_node_data', { id: inl.ramp, data: { c1: 'vec3(0.2, 0.4, 0.6)' } });
    data = jsonOf(res);
    check(!res.isError && Array.isArray(data?.changed) && data.changed.includes('c1'), 'set_node_data sets an inline vec3 literal', textOf(res));
    res = await call('set_node_data', { id: inl.ramp, data: { c1: [1, 0] } });
    check(res.isError && /vec3/.test(textOf(res)), 'set_node_data rejects a wrong-sized inline vector', textOf(res));
    res = await call('build_graph', { nodes: [{ key: 'oops', type: 'Add', data: { a: 'sin(u_time)' } }] });
    data = jsonOf(res);
    check(!res.isError && data?.ok === false && typeof data?.error === 'string' && data?.errors?.length === 1, 'build_graph top-level ok is false when node data fails', textOf(res));
    if (data?.ids?.oops !== undefined) await call('remove_node', { id: data.ids.oops });

    // 8d. Feedback passes are separate shaders: their GLSL errors must fail compile
    res = await call('create_custom_node', { name: 'BrokenPass', force: true, glsl: 'vec4 brokenPass(vec2 uv) {\n    return vec4(uv, undefinedThing, 1.0);\n}' });
    check(!res.isError, 'create_custom_node BrokenPass (force)', textOf(res));
    res = await call('build_graph', {
        nodes: [{ key: 'bp', type: 'BrokenPass' }, { key: 'fb', type: 'Feedback' }, { key: 'ts', type: 'TextureSample' }, { key: 'p5', type: 'Preview' }],
        connections: [{ from: `${ids.uv}.uv`, to: 'bp.uv' }, { from: 'bp', to: 'fb.in' }, { from: 'fb', to: 'ts.texture' }, { from: 'ts', to: 'p5.color' }],
    });
    data = jsonOf(res);
    const fbIds = data?.ids || {};
    const fbRep = data?.compile?.feedback?.find(f => f.id === fbIds.fb);
    check(!res.isError && data?.ok === false && data?.compile?.ok === false && fbRep?.ok === false, 'build_graph/compile not ok when a Feedback pass fails', textOf(res).slice(0, 800));
    check(fbRep?.errors?.some(e => /undefinedThing/.test(e)) && fbRep?.glsl_errors?.[0]?.node?.type === 'BrokenPass', 'feedback errors name the identifier and the custom node', fbRep);
    check(data?.compile?.previews?.find(p => p.id === fbIds.p5)?.ok === true, 'the Preview reading the feedback texture itself compiles', data?.compile?.previews);
    res = await call('set_node_data', { id: fbIds.fb, data: { in: [1, 0, 0, 1] } });
    check(res.isError && /connect/.test(textOf(res)), 'inputs of non-library nodes report that they take no inline value', textOf(res));
    res = await call('update_custom_node', { name: 'BrokenPass', glsl: 'vec4 brokenPass(vec2 uv) {\n    return vec4(uv, 0.5, 1.0);\n}' });
    check(!res.isError, 'update_custom_node fixes BrokenPass', textOf(res));
    res = await call('compile', {});
    data = jsonOf(res);
    check(data?.feedback?.find(f => f.id === fbIds.fb)?.ok === true, 'fixed feedback pass reports ok', data?.feedback);

    // 8e. The background preview is saved with the project
    res = await call('set_background_preview', { preview_id: gen.p3 });
    check(!res.isError, 'set_background_preview', textOf(res));
    {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        check(saved.graph.nodes.find(n => n.id === gen.p3)?.isBackground === true, 'background preview saved in the project file');
    }

    // 8g. Node groups: view/organization metadata, compilation is unaffected
    res = await call('compile', {});
    const okBeforeGroups = jsonOf(res)?.previews?.find(p => p.id === ids.out)?.ok;
    res = await call('group_nodes', { name: 'Noise Field', node_ids: [ids.uv, ids.scale, ids.scaled, ids.noise] });
    data = jsonOf(res);
    const gNoise = data?.group?.id;
    check(!res.isError && gNoise && data.group.node_count === 4 && data.group.parent === null, 'group_nodes creates a group', textOf(res));
    check(data?.group?.outputs?.some(o => o.startsWith('uv:vec2')) && data.group.outputs.some(o => /= \d+\.out/.test(o)), 'group box ports are synthesized from crossing cables', data?.group?.outputs);
    res = await call('group_nodes', { name: 'Signal', node_ids: [gNoise, ids.time, ids.sin] });
    data = jsonOf(res);
    const gSignal = data?.group?.id;
    check(!res.isError && data?.group?.children?.includes(gNoise) && data.group.node_count === 6, 'group_nodes nests an existing group (groups of groups)', textOf(res));
    res = await call('rename_group', { group_id: gNoise, name: 'Noise' });
    check(!res.isError && jsonOf(res)?.name === 'Noise', 'rename_group', textOf(res));
    res = await call('list_groups', {});
    data = jsonOf(res);
    check(data?.groups?.length === 2 && data.groups.find(gr => gr.id === gNoise)?.parent === gSignal && !data.root_nodes.includes(ids.noise), 'list_groups reports the hierarchy', textOf(res).slice(0, 600));
    res = await call('get_project', {});
    data = jsonOf(res);
    check(data?.groups?.length === 2 && data.nodes.find(n => n.id === ids.noise)?.group === gNoise, 'get_project reports groups and node membership', data?.groups);
    // Box port names (rename_group_port): stored by port key, shown by list_groups, saved, undoable
    {
        res = await call('list_groups', {});
        const gN = jsonOf(res)?.groups?.find(gr => gr.id === gNoise);
        const outKey = gN?.port_keys?.outputs?.[0];
        const autoOut = gN?.outputs?.[0]?.split(':')[0];
        check(outKey && /^o:\d+:\d+$/.test(outKey) && gN.port_keys.outputs.length === gN.outputs.length, 'list_groups gives each box port its stable key', gN);
        res = await call('rename_group_port', { group_id: 'Noise', port: outKey, label: 'Field' });
        data = jsonOf(res);
        check(!res.isError && data?.renamed?.[0]?.label === 'Field' && data.renamed[0].previous === autoOut && data.group?.outputs?.[0]?.startsWith('Field:'), 'rename_group_port renames a box port by key', textOf(res).slice(0, 500));
        res = await call('list_groups', {});
        const gN2 = jsonOf(res)?.groups?.find(gr => gr.id === gNoise);
        check(gN2?.outputs?.[0]?.startsWith('Field:') && gN2.port_labels?.[outKey] === 'Field', 'list_groups shows the custom port name', gN2);
        res = await call('get_project', {});
        check(jsonOf(res)?.groups?.find(gr => gr.id === gNoise)?.outputs?.[0]?.startsWith('Field:'), 'get_project shows the custom port name');
        {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            check(saved.graph.groups.find(gr => gr.id === gNoise)?.portLabels?.[outKey] === 'Field', 'port names are saved in the project file (portLabels)', saved.graph.groups);
        }
        res = await call('rename_group_port', { group_id: gNoise, ports: { 'out:0': 'Noise out' } });
        check(!res.isError && jsonOf(res)?.group?.outputs?.[0]?.startsWith('Noise out:'), 'rename_group_port by box index (ports map)', textOf(res).slice(0, 300));
        res = await call('undo', {});
        res = await call('list_groups', {});
        check(jsonOf(res)?.groups?.find(gr => gr.id === gNoise)?.outputs?.[0]?.startsWith('Field:'), 'undo restores the previous port name', jsonOf(res)?.groups?.find(gr => gr.id === gNoise)?.outputs);
        res = await call('redo', {});
        res = await call('rename_group_port', { group_id: gNoise, port: 'Noise out', label: '' });
        data = jsonOf(res);
        check(!res.isError && data?.renamed?.[0]?.custom === false && data.group?.outputs?.[0]?.split(':')[0] === autoOut && !data.group.port_labels, 'an empty label restores the automatic name (found by its current label)', textOf(res).slice(0, 400));
        res = await call('rename_group_port', { group_id: gNoise, port: 'nope', label: 'X' });
        check(res.isError && Array.isArray(jsonOf(res)?.ports), 'rename_group_port of an unknown port lists the ports', textOf(res));
        res = await call('rename_group_port', { group_id: gNoise, port: outKey, label: 'Field' });
        check(!res.isError, 'rename_group_port (name kept for the rest of the test)');
    }
    res = await call('compile', {});
    check(jsonOf(res)?.previews?.find(p => p.id === ids.out)?.ok === okBeforeGroups, 'grouping does not change compilation');
    res = await call('auto_layout', {});
    data = jsonOf(res);
    check(!res.isError && data?.groups?.length === 2, 'auto_layout lays out every scope (reports group boxes)', textOf(res).slice(0, 300));
    {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        const sg = saved.graph.groups || [];
        check(sg.length === 2 && sg.find(gr => gr.id === gNoise)?.nodeIds.includes(ids.noise), 'groups saved in the project file', sg);
    }
    res = await call('build_graph', {
        nodes: [{ key: 'gk', type: 'Float', data: { value: 0.3 } }, { key: 'gs', type: 'Sin' }],
        connections: [{ from: 'gk', to: 'gs.x' }],
        groups: [{ key: 'inner', name: 'Inner', nodes: ['gk'] }, { key: 'outerB', name: 'Outer B', nodes: ['inner', 'gs'] }],
    });
    data = jsonOf(res);
    const gInner = data?.group_ids?.inner, gOuterB = data?.group_ids?.outerB;
    check(!res.isError && !data?.errors && gInner && gOuterB, 'build_graph creates groups', textOf(res).slice(0, 400));
    res = await call('list_groups', {});
    data = jsonOf(res);
    check(data?.groups?.find(gr => gr.id === gInner)?.parent === gOuterB, 'build_graph nests groups via group keys', data?.groups);
    res = await call('ungroup', { group_id: gOuterB });
    data = jsonOf(res);
    check(!res.isError && data?.groups?.includes(gInner), 'ungroup moves children to the parent', textOf(res));
    res = await call('list_groups', {});
    data = jsonOf(res);
    check(data?.groups?.length === 3 && data.groups.find(gr => gr.id === gInner)?.parent === null, 'ungroup leaves the child group at the root', data?.groups?.map(gr => gr.id));
    res = await call('ungroup', { group_id: 'nope' });
    check(res.isError && Array.isArray(jsonOf(res)?.groups), 'ungroup of an unknown group lists the groups', textOf(res));

    // 9. Project state on disk
    res = await call('get_project', {});
    data = jsonOf(res);
    check(!res.isError && data?.node_count >= 10 && data.connections.length >= 10, 'get_project reflects the graph', { nodes: data?.node_count, conns: data?.connections?.length });
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(disk.name === projectName && disk.graph.nodes.length === data?.node_count, 'disk file matches app state');
    check(disk.customNodes && disk.customNodes.WobbleNoise && disk.customNodes.Typo, 'custom nodes saved with the project', Object.keys(disk.customNodes || {}));

    // 10. Layout + screenshot
    res = await call('auto_layout', {});
    check(!res.isError, 'auto_layout');
    res = await call('screenshot_editor', {});
    check(!res.isError && (res.content || []).some(c => c.type === 'image'), 'screenshot_editor returns an image', textOf(res));

    // 11. Reopen from disk (round trip through the app's loader)
    res = await call('duplicate_project', { name: slug, new_name: `${projectName} copy` });
    data = jsonOf(res);
    const copySlug = data?.created;
    check(!res.isError && copySlug, 'duplicate_project');
    res = await call('open_project', { name: copySlug });
    data = jsonOf(res);
    check(!res.isError && data?.nodes >= 10, 'open_project of the copy loads all nodes', textOf(res));
    res = await call('compile', {});
    data = jsonOf(res);
    check(data?.previews?.find(p => p.ok), 'reopened project still compiles its first preview', textOf(res).slice(0, 400));
    res = await call('get_project', {});
    data = jsonOf(res);
    check(data?.nodes?.find(n => n.id === gen.p3)?.background === true, 'reopened project restores the background preview', data?.nodes?.filter(n => n.type === 'Preview'));
    check(data?.groups?.length === 3 && data.groups.find(gr => gr.id === gNoise)?.parent === gSignal, 'reopened project restores its node groups', data?.groups);
    res = await call('delete_project', { name: copySlug });
    check(!res.isError, 'delete the copy');

    // 12. Param nodes (Parameters panel) and JS nodes (back in the main test project)
    res = await call('open_project', { name: slug });
    check(!res.isError, 'reopen the test project', textOf(res));
    res = await call('list_node_types', { search: 'Param' });
    data = jsonOf(res);
    const paramType = data?.types?.find(t => t.name === 'Param');
    check(!res.isError && paramType && paramType.notes?.some(n => /kind/.test(n)), 'list_node_types describes Param (kinds in notes)', paramType);
    res = await call('build_graph', {
        nodes: [
            { key: 'tint', type: 'Param', data: { label: 'Tint', kind: 'color', value: '#ff0000', section: 'Look', order: 1 } },
            { key: 'gain', type: 'Param', data: { label: 'Gain', kind: 'float', min: 0, max: 2, value: 1, section: 'Look', order: 0, description: 'overall gain' } },
            { key: 'mode', type: 'Param', data: { label: 'Mode', kind: 'enum', options: ['Calm', 'Wild'], value: 'Wild', section: 'Extra', order: 2 } },
            { key: 'hit', type: 'Param', data: { label: 'Hit', kind: 'trigger', section: 'Extra', order: 3 } },
            { key: 'lit', type: 'Multiply' },
            { key: 'pp', type: 'Preview' },
        ],
        connections: [{ from: 'tint.color', to: 'lit.a' }, { from: 'gain.value', to: 'lit.b' }, { from: 'lit', to: 'pp.color' }],
    });
    data = jsonOf(res);
    const pIds = data?.ids || {};
    check(!data?.errors && data?.compile?.previews?.find(x => x.id === pIds.pp)?.ok === true, 'build_graph with Param nodes compiles', textOf(res).slice(0, 500));
    res = await call('list_params', {});
    data = jsonOf(res);
    check(!res.isError && data?.count === 4 && data.sections.map(x => x.name).join(',') === 'Look,Extra' &&
        data.sections[0].params.map(x => x.label).join(',') === 'Gain,Tint', 'list_params groups by section and sorts by order', data?.sections);
    check(data?.sections?.[1]?.params?.[0]?.selected === 'Wild' && data.sections[0].params[1].hex === '#ff0000', 'list_params reports enum selection and color hex', data?.sections);
    const red0 = jsonOf(await call('render_preview', { preview_id: pIds.pp, width: 16, height: 16 }));
    res = await call('set_param', { label: 'tint', value: '#00ff00' });
    data = jsonOf(res);
    check(!res.isError && data?.recompiled === false && data?.param?.hex === '#00ff00', 'set_param by label updates a live uniform (no recompile)', textOf(res));
    const green0 = jsonOf(await call('render_preview', { preview_id: pIds.pp, width: 16, height: 16 }));
    check(red0?.stats?.mean_rgb?.[0] > 200 && green0?.stats?.mean_rgb?.[1] > 200 && green0.stats.mean_rgb[0] < 30, 'render follows set_param', { before: red0?.stats?.mean_rgb, after: green0?.stats?.mean_rgb });
    res = await call('set_param', { node_id: pIds.gain, value: 'loud' });
    check(res.isError && Array.isArray(jsonOf(res)?.param?.outputs), 'set_param rejects a value of the wrong type', textOf(res));
    res = await call('set_param', { label: 'nope', value: 1 });
    check(res.isError && jsonOf(res)?.params?.length === 4, 'set_param on an unknown label lists the params', textOf(res));
    res = await call('set_param', { label: 'Hit', value: 'press' });
    check(!res.isError && jsonOf(res)?.param?.value === 1, 'set_param fires a trigger (count + 1)', textOf(res));
    res = await call('set_node_data', { id: pIds.gain, data: { value: 0.5 } });
    data = jsonOf(res);
    check(!res.isError && data?.recompiled === false, 'set_node_data {value} on a Param is a uniform update', textOf(res));
    res = await call('set_node_data', { id: pIds.mode, data: { kind: 'vec3' } });
    data = jsonOf(res);
    check(!res.isError && data?.recompiled === true && data?.node?.outputs?.[0] === 'value:vec3', 'set_node_data {kind} recompiles and retypes the output', textOf(res));
    res = await call('set_node_data', { id: pIds.mode, data: { kind: 'sparkly' } });
    check(res.isError, 'set_node_data rejects an unknown param kind', textOf(res));
    {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        const sp = saved.graph.nodes.find(n => n.id === pIds.tint);
        check(sp?.type === 'Param' && sp.data.label === 'Tint' && sp.data.value[1] === 1, 'Param data saved in the project file', sp?.data);
    }

    // JS node: default snippet (smoothed mouse speed + hue) driving a Preview, values change every frame
    res = await call('build_graph', {
        nodes: [{ key: 'js', type: 'JS' }, { key: 'pj', type: 'Preview' }],
        connections: [{ from: 'js.hue', to: 'pj.color' }],
    });
    data = jsonOf(res);
    const jsId = data?.ids?.js;
    check(!data?.errors && data?.compile?.previews?.find(x => x.id === data?.ids?.pj)?.ok === true, 'build_graph JS node -> Preview compiles', textOf(res).slice(0, 500));
    await new Promise(r => setTimeout(r, 700));
    const js1 = jsonOf(await call('get_project', {}))?.nodes?.find(n => n.id === jsId)?.js;
    await new Promise(r => setTimeout(r, 700));
    const js2 = jsonOf(await call('get_project', {}))?.nodes?.find(n => n.id === jsId)?.js;
    check(js1?.status === 'running' && Array.isArray(js1?.values?.hue) && typeof js1.values.speed === 'number', 'JS node runs and exposes typed outputs (speed float, hue vec3)', js1);
    check(js1 && js2 && JSON.stringify(js1.values.hue) !== JSON.stringify(js2.values.hue) && js2.recompiles === js1.recompiles, 'JS outputs change frame to frame without recompiling', { js1, js2 });
    res = await call('set_node_data', { id: jsId, data: { code: 'return { wave: float(Math.sin(time)), on: time > 0, pos: [0.25, 0.5] };' } });
    check(!res.isError, 'set_node_data sets JS code', textOf(res));
    await new Promise(r => setTimeout(r, 900));
    data = jsonOf(await call('get_project', {}))?.nodes?.find(n => n.id === jsId);
    check(data?.outputs?.join(',') === 'wave:float,on:bool,pos:vec2' && data?.js?.recompiles >= 1, 'a new return signature rebuilds the ports (one recompile)', data);
    res = await call('set_node_data', { id: jsId, data: { code: 'return float(missing.value);' } });
    await new Promise(r => setTimeout(r, 600));
    data = jsonOf(await call('get_project', {}))?.nodes?.find(n => n.id === jsId)?.js;
    check(data?.status === 'error' && /missing/.test(data?.error || ''), 'JS errors are reported on the node', data);
    res = await call('compile', {});
    check(!res.isError && jsonOf(res)?.previews?.find(x => x.id === pIds.pp)?.ok === true, 'a throwing JS node does not break the other previews', textOf(res).slice(0, 300));

    // 13. JS texture outputs: data texture (random walk dots) and canvas (beat lyrics); same snippets as mcp/README.md
    const DEMO_LYRICS = {
      glslName: 'LyricWarp',
      glsl: `vec3 lyricWarp(vec2 uv, sampler2D words, float pulse) {
        vec2 p = (uv - 0.5) * (1.0 - 0.12 * pulse);
        p.x += 0.03 * sin(p.y * 18.0 + u_time * 3.0);
        p.y += 0.02 * sin(p.x * 11.0 - u_time * 2.0);
        vec2 q = p + 0.5;
        float off = 0.006 + 0.02 * pulse;
        vec3 ink = vec3(texture(words, q + vec2(off, 0.0)).r, texture(words, q).g, texture(words, q - vec2(off, 0.0)).b);
        vec3 bg = mix(vec3(0.05, 0.02, 0.1), vec3(0.25, 0.05, 0.2), uv.y);
        return bg + ink * vec3(1.0, 0.85, 0.6) * (0.8 + 0.6 * pulse);
    }`,
      setupCode: `state.c = canvas(512, 256);
    state.g = state.c.getContext('2d');
    state.words = ['FEEL', 'THE', 'BEAT', 'MOVE', 'YOUR', 'BODY'];
    state.last = -1;`,
      code: `// A new word on every beat; the canvas is only re-uploaded on the frames it is drawn
    const n = Math.floor(audio.beatCount);
    if (n !== state.last) {
      state.last = n;
      const g = state.g;
      g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256);
      g.fillStyle = '#fff'; g.font = 'bold 132px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(state.words[n % state.words.length], 256, 136);
    }
    return { words: texture(state.c), pulse: float(audio.beat) };`,
    };
    const DEMO_DOTS = {
      glslName: 'GlowDots',
      glsl: `vec3 glowDots(vec2 uv, sampler2D points) {
        vec3 col = vec3(0.0);
        for (int i = 0; i < 32; i++) {
            vec4 p = texelFetch(points, ivec2(i, 0), 0); // element i = texel (i, 0): x, y, brightness, hue
            float d = length(uv - p.xy);
            vec3 tint = 0.55 + 0.45 * cos(6.28318 * (p.w + vec3(0.0, 0.33, 0.67)));
            col += tint * p.z * 0.0006 / (d * d + 0.00025);
        }
        return col / (1.0 + col);
    }`,
      setupCode: `state.p = Array.from({ length: 32 }, (_, i) => ({ x: Math.random(), y: Math.random(), hue: i / 32 }));`,
      code: `// 32 points on a random walk -> a 32x1 RGBA32F data texture (x, y, brightness, hue)
    const d = new Float32Array(32 * 4);
    state.p.forEach((q, i) => {
      q.x = (q.x + (Math.random() - 0.5) * 0.8 * dt + 1) % 1;
      q.y = (q.y + (Math.random() - 0.5) * 0.8 * dt + 1) % 1;
      d.set([q.x, q.y, 0.6 + 0.4 * Math.sin(time * 2 + i), q.hue], i * 4);
    });
    return { points: dataTexture(d, 32, 1, 4) };`,
    };

    res = await call('create_custom_node', { name: DEMO_DOTS.glslName, glsl: DEMO_DOTS.glsl });
    check(!res.isError, 'create_custom_node GlowDots (sampler2D input + texelFetch loop)', textOf(res).slice(0, 300));
    res = await call('create_custom_node', { name: DEMO_LYRICS.glslName, glsl: DEMO_LYRICS.glsl });
    check(!res.isError, 'create_custom_node LyricWarp (sampler2D input)', textOf(res).slice(0, 300));
    res = await call('build_graph', {
        nodes: [
            { key: 'tuv', type: 'UV' },
            { key: 'walk', type: 'JS', data: { setupCode: DEMO_DOTS.setupCode, code: DEMO_DOTS.code, outputs: [{ name: 'points', type: 'sampler2D' }] } },
            { key: 'dots', type: DEMO_DOTS.glslName },
            { key: 'pdots', type: 'Preview' },
            { key: 'lyr', type: 'JS', data: { setupCode: DEMO_LYRICS.setupCode, code: DEMO_LYRICS.code, outputs: [{ name: 'words', type: 'sampler2D' }, { name: 'pulse', type: 'float' }] } },
            { key: 'warp', type: DEMO_LYRICS.glslName },
            { key: 'plyr', type: 'Preview' },
            { key: 'samp', type: 'TextureSample' },
            { key: 'fb', type: 'Feedback' },
            { key: 'pfb', type: 'Preview' },
        ],
        connections: [
            { from: 'tuv.uv', to: 'dots.uv' }, { from: 'walk.points', to: 'dots.points' }, { from: 'dots', to: 'pdots' },
            { from: 'tuv.uv', to: 'warp.uv' }, { from: 'lyr.words', to: 'warp.words' }, { from: 'lyr.pulse', to: 'warp.pulse' }, { from: 'warp', to: 'plyr' },
            { from: 'lyr.words', to: 'samp.texture' }, { from: 'samp.color', to: 'fb.in' }, { from: 'fb.out', to: 'pfb' },
        ],
    });
    data = jsonOf(res);
    const tIds = data?.ids || {};
    const okOf = (d, id) => d?.compile?.previews?.find(x => x.id === id)?.ok === true;
    check(!data?.errors && okOf(data, tIds.pdots) && okOf(data, tIds.plyr) && okOf(data, tIds.pfb), 'build_graph with JS texture outputs compiles (Preview, custom GLSL, Feedback)', textOf(res).slice(0, 600));
    await new Promise(r => setTimeout(r, 1800));
    data = jsonOf(await call('get_project', {}));
    const walkJs = data?.nodes?.find(n => n.id === tIds.walk)?.js;
    const lyrJs = data?.nodes?.find(n => n.id === tIds.lyr)?.js;
    check(walkJs?.status === 'running' && walkJs?.values?.points === 'data 32x1x4' && walkJs?.textures?.points?.format === 'rgba32f' && walkJs.textures.points.uploads > 20,
        'dataTexture -> 32x1 RGBA32F texture uploaded every frame', walkJs);
    check(lyrJs?.status === 'running' && lyrJs?.values?.words === 'canvas 512x256' && lyrJs?.textures?.words?.uploads >= 1 &&
        lyrJs.textures.words.uploads < walkJs.textures.points.uploads / 3, 'canvas texture is uploaded only when drawn (once per beat)', { lyr: lyrJs?.textures, walk: walkJs?.textures });
    const rd = jsonOf(await call('render_preview', { preview_id: tIds.pdots, width: 64, height: 64 }));
    const rl = jsonOf(await call('render_preview', { preview_id: tIds.plyr, width: 64, height: 64 }));
    const rf = jsonOf(await call('render_preview', { preview_id: tIds.pfb, width: 64, height: 64 }));
    check(rd?.stats?.blank === false && rd.stats.luma_max > 60, 'data texture demo renders glowing dots', rd?.stats);
    check(rl?.stats?.blank === false && rl.stats.luma_max > 120, 'canvas texture demo renders the lyrics', rl?.stats);
    check(rf?.stats?.blank === false && rf.stats.luma_max > 120, 'a Feedback pass samples the JS canvas texture', rf?.stats);
    res = await call('set_node_data', { id: tIds.walk, data: { code: 'return { points: dataTexture(new Float32Array(64), 16, 1) };' } });
    await new Promise(r => setTimeout(r, 900));
    data = jsonOf(await call('get_project', {}))?.nodes?.find(n => n.id === tIds.walk);
    check(data?.js?.values?.points === 'data 16x1x4' && data.js.recompiles > walkJs.recompiles && data.outputs[0] === 'points:sampler2D', 'changing the texture size recompiles (signature change)', data?.js);
    res = await call('set_node_data', { id: tIds.walk, data: { code: 'return { points: dataTexture([1, 2, 3], 0) };' } });
    await new Promise(r => setTimeout(r, 600));
    data = jsonOf(await call('get_project', {}))?.nodes?.find(n => n.id === tIds.walk)?.js;
    check(data?.status === 'error' && /dataTexture/.test(data?.error || ''), 'texture helper errors are reported like other JS errors', data);

    // 14. Scenes: SceneSwitcher (one function per scene, CPU-side selection), ScenePresence, pinned renders
    res = await call('build_graph', {
        nodes: [
            { key: 'suv', type: 'UV' },
            { key: 'sa', type: 'Color', data: { hex: '#ff0000' } },
            { key: 'sb', type: 'Voronoi' },
            { key: 'sc', type: 'Gradient' }, { key: 'spres', type: 'ScenePresence' }, { key: 'smul', type: 'Multiply' },
            { key: 'ssw', type: 'SceneSwitcher', data: { scenes: ['Red', 'Cells', 'Ramp'], current: 'Red', transition: 'wipe', duration: 0.4 } },
            { key: 'spv', type: 'Preview' },
        ],
        connections: [
            { from: 'sa', to: 'ssw.Red' }, { from: 'suv.uv', to: 'sb.p' }, { from: 'sb', to: 'ssw.1' },
            { from: 'sc', to: 'smul.a' }, { from: 'spres.presence', to: 'smul.b' }, { from: 'smul', to: 'ssw.2' },
            { from: 'ssw.color', to: 'spv' },
        ],
    });
    data = jsonOf(res);
    const sIds = data?.ids || {};
    check(!res.isError && !data?.errors && data?.compile?.previews?.find(x => x.id === sIds.spv)?.ok === true, 'build_graph with a SceneSwitcher compiles', textOf(res).slice(0, 600));
    data = jsonOf(await call('compile', { include_source: true }));
    const sFrag = data?.previews?.find(x => x.id === sIds.spv)?.fragment || '';
    check(/_eval\(int i\)/.test(sFrag) && (sFrag.match(/vec4 node_\d+_s\d\(\) \{/g) || []).length === 3 && /sc_FragCoord/.test(sFrag),
        'each scene compiles into its own function, dispatched by uniform', sFrag.slice(0, 200));
    data = jsonOf(await call('list_scenes', {}));
    const swInfo = data?.switchers?.find(x => x.id === sIds.ssw);
    check(swInfo?.scenes?.length === 3 && swInfo.current === 0 && JSON.stringify(swInfo.evaluated) === '[0]' && swInfo.presence_nodes?.[0]?.scene === 2 && data.transitions?.length >= 10,
        'list_scenes: scenes, current, evaluated scenes, presence ownership, transitions', swInfo);
    data = jsonOf(await call('list_node_types', { search: 'SceneSwitcher' }));
    check(data?.types?.some(t => t.name === 'SceneSwitcher' && t.notes?.some(n => /Transitions/.test(n))), 'list_node_types notes for SceneSwitcher', data?.types?.map(t => t.name));
    const sRender = async (args) => jsonOf(await call('render_preview', { preview_id: sIds.spv, width: 64, height: 48, ...args }));
    const rRed = await sRender({ scene: 'Red' });
    const rCells = await sRender({ scene: 1 });
    const rMid = await sRender({ scene_from: 'Red', scene: 'Ramp', progress: 0.5, transition: 'wipe' });
    check(rRed?.stats?.mean_rgb?.[0] > 200 && rRed.stats.mean_rgb[1] < 30, 'render_preview {scene} pins a scene (red)', rRed?.stats);
    check(rCells?.stats && Math.abs(rCells.stats.mean_rgb[0] - rCells.stats.mean_rgb[2]) < 8 && rCells.stats.luma_std > 5, 'render_preview pins another scene (cells)', rCells?.stats);
    check(rMid?.scene_pin?.progress === 0.5 && rMid.stats.luma_std > rRed.stats.luma_std && rMid.stats.mean_rgb[0] > 100, 'render_preview {scene_from, scene, progress, transition} renders a transition frame', rMid?.stats);
    const pIn = jsonOf(await call('render_preview', { node_id: sIds.spres, output: 'presence', width: 16, height: 16, scene: 'Ramp' }));
    const pOut = jsonOf(await call('render_preview', { node_id: sIds.spres, output: 'presence', width: 16, height: 16, scene: 'Red' }));
    check(pIn?.stats?.luma_min > 250 && pOut?.stats?.luma_max < 5, 'ScenePresence is 1 in its scene and 0 when another is shown', { in: pIn?.stats, out: pOut?.stats });
    res = await call('set_scene', { scene: 'ramp' });
    data = jsonOf(res);
    check(!res.isError && data?.switcher?.current === 2 && data.switcher.transitioning?.style === 'wipe' && data.switcher.evaluated?.length === 2, 'set_scene starts a transition (both scenes evaluated)', data?.switcher);
    await new Promise(r => setTimeout(r, 900));
    data = jsonOf(await call('list_scenes', {}))?.switchers?.find(x => x.id === sIds.ssw);
    check(data?.current === 2 && !data.transitioning && JSON.stringify(data.evaluated) === '[2]', 'the transition finishes on the new scene', data);
    data = jsonOf(await call('set_scene', { scene: 'next', instant: true }))?.switcher;
    check(data?.current === 0 && !data.transitioning, "set_scene 'next' wraps around (instant)", data);
    data = jsonOf(await call('set_node_data', { id: sIds.ssw, data: { current: 'Cells', transition: 'iris' } }));
    check(data?.recompiled === false && data?.node?.scenes_state?.current === 1, 'set_node_data current / transition: no recompile', data);
    res = await call('set_scene', { scene: 'Nope' });
    check(res.isError && /no scene/.test(textOf(res)), 'set_scene rejects unknown scenes (lists them)', textOf(res).slice(0, 200));

    // 15. Debug probes: values read back from the GPU (Value / Color display, NaN, Plot history)
    res = await call('create_custom_node', { name: 'RawSqrt', glsl: 'float rawSqrt(float x) {\n    return sqrt(x);\n}' });
    check(!res.isError, 'create_custom_node RawSqrt (unguarded sqrt for the NaN probe)', textOf(res).slice(0, 300));
    const previewsBefore = jsonOf(await call('compile', {}))?.previews || [];
    res = await call('build_graph', {
        nodes: [
            { key: 'ptime', type: 'Time' },
            { key: 'pval', type: 'ValueDisplay', data: { precision: 4 } },
            { key: 'pcol', type: 'Color', data: { hex: '#ff8000' } },
            { key: 'pcd', type: 'ColorDisplay', data: { sample: 'center' } },
            { key: 'pneg', type: 'Float', data: { value: -1, useUniform: true } },
            { key: 'psq', type: 'RawSqrt' },
            { key: 'pnan', type: 'ValueDisplay' },
            { key: 'psin', type: 'Sin' },
            { key: 'pplot', type: 'Plot', data: { seconds: 3 } },
            { key: 'puv', type: 'UV' },
            { key: 'pstats', type: 'FrameStats' },
            { key: 'pfree', type: 'ValueDisplay' },
        ],
        connections: [
            { from: 'ptime', to: 'pval' }, { from: 'pcol', to: 'pcd' }, { from: 'pneg', to: 'psq.x' }, { from: 'psq', to: 'pnan' },
            { from: 'ptime', to: 'psin.x' }, { from: 'psin', to: 'pplot' }, { from: 'puv', to: 'pstats' },
        ],
    });
    data = jsonOf(res);
    const qIds = data?.ids || {};
    check(!res.isError && !data?.errors && qIds.pval !== undefined, 'build_graph with debug probes', textOf(res).slice(0, 600));
    data = jsonOf(await call('list_node_types', { category: 'debug' }));
    check(data?.count === 7 && data.types.every(t => t.notes?.some(n => /read_probes/.test(n))), 'list_node_types: 7 debug probe types with notes', data?.types?.map(t => t.name));
    res = await call('read_probes', {});
    data = jsonOf(res);
    const probeOf = (d, id) => d?.probes?.find(x => x.id === id);
    const pv = probeOf(data, qIds.pval);
    check(!res.isError && pv?.status === 'ok' && pv.value_type === 'float' && pv.value > 0 && Math.abs(pv.value - pv.clock_time) < 1e-3 && pv.sample?.mode === 'origin',
        'Value Display on Time reads u_time back from the GPU', pv);
    const pc = probeOf(data, qIds.pcd);
    check(pc?.status === 'ok' && pc.hex === '#FF8000' && Math.abs(pc.value[0] - 1) < 1e-3 && Math.abs(pc.value[1] - 128 / 255) < 2e-3 && pc.value[2] === 0 && pc.sample?.mode === 'center' && pc.clipped === false,
        'Color Display on #ff8000 (sampled at the center)', pc);
    const pn = probeOf(data, qIds.pnan);
    check(pn?.status === 'ok' && pn.nan === true && pn.text?.[0] === 'NaN' && pn.value === null, 'sqrt(-1) is reported as NaN', pn);
    check(probeOf(data, qIds.pfree)?.status === 'none', 'an unconnected probe reports status none (no input)', probeOf(data, qIds.pfree));
    const ps = probeOf(data, qIds.pstats);
    check(ps?.status === 'ok' && ps.stats?.grid?.[0] === 64 && Math.abs(ps.stats.channels[0].mean - 0.5) < 0.01 && ps.stats.channels[0].min < 0.02 && ps.stats.channels[0].max > 0.98 && ps.stats.nan_samples === 0,
        'Frame Stats of UV: min ~0, max ~1, mean 0.5 over the coarse grid', ps?.stats);
    check(typeof data?.renderer?.format === 'string' && data.renderer.supported === true, 'read_probes reports the readback format / cost', data?.renderer);
    res = await call('read_probes', { ids: [qIds.pplot], wait_ms: 1500, max_points: 60 });
    data = jsonOf(res);
    const pp = probeOf(data, qIds.pplot);
    const hv = pp?.history?.values || [];
    check(!res.isError && data?.count === 1 && pp?.status === 'ok' && hv.length >= 20 && hv.length <= 61 && pp.window && pp.window.max - pp.window.min > 0.3 && Math.max(...hv) - Math.min(...hv) > 0.3,
        'Plot of sin(time) records a varying history', pp && { samples: pp.samples, window: pp.window, n: hv.length });
    const pv2 = probeOf(jsonOf(await call('read_probes', { ids: [qIds.pval], history: false })), qIds.pval);
    check(pv2?.value > pv.value + 1, 'Value Display on Time advances between reads', { before: pv?.value, after: pv2?.value });
    data = jsonOf(await call('get_project', {}));
    const gpNode = data?.nodes?.find(n => n.id === qIds.pnan);
    check(gpNode?.probe?.nan === true && data?.nodes?.find(n => n.id === qIds.pval)?.probe?.value > 0, 'get_project includes the latest probe values', gpNode?.probe);
    res = await call('read_probes', { ids: [qIds.ptime] });
    check(res.isError && /not a debug probe/.test(textOf(res)), 'read_probes rejects non-probe ids', textOf(res).slice(0, 200));
    data = jsonOf(await call('compile', {}));
    const okSig = (list) => list.map(x => `${x.id}:${x.ok}`).sort().join(',');
    check(previewsBefore.length > 0 && okSig(data?.previews || []) === okSig(previewsBefore), 'probes leave the previews\' compile results unchanged', { before: okSig(previewsBefore), after: okSig(data?.previews || []) });

    // 15. Output toolkit: offline export (WebCodecs + muxer), real-time recording, output window
    {
        const exported = [];
        const vid = sIds.spv;
        res = await call('start_recording', { preview_id: vid, mode: 'offline', duration: 2, fps: 30, width: 320, height: 180, format: 'mp4' });
        data = jsonOf(res);
        const mp4 = data?.saved_abs;
        if (mp4) exported.push(mp4);
        const mp4Info = mp4 && fs.existsSync(mp4) ? readMp4(fs.readFileSync(mp4)) : null;
        check(!res.isError && data?.frames === 60 && data?.duration_s === 2 && /^exports\//.test(data?.saved || ''), 'start_recording offline mp4: 60 frames, 2 s, saved under exports/', textOf(res).slice(0, 400));
        check(mp4Info && mp4Info.samples === 60 && Math.abs(mp4Info.duration - 2) < 0.01 && mp4Info.width === 320 && mp4Info.height === 180,
            'exported MP4 file: 60 samples, 2.0 s, 320x180 (parsed from the file)', mp4Info);
        res = await call('start_recording', { preview_id: vid, mode: 'offline', duration: 1, fps: 24, width: 256, height: 144, format: 'webm' });
        data = jsonOf(res);
        if (data?.saved_abs) exported.push(data.saved_abs);
        const webmInfo = data?.saved_abs && fs.existsSync(data.saved_abs) ? readWebm(fs.readFileSync(data.saved_abs)) : null;
        check(!res.isError && webmInfo && webmInfo.blocks === 24 && Math.abs(webmInfo.durationMs - 1000) < 1 && webmInfo.codec === 'V_VP9',
            'exported WebM file: 24 VP9 frames, Duration 1.0 s (parsed from the file)', webmInfo || textOf(res).slice(0, 300));
        res = await call('start_recording', { preview_id: vid, mode: 'realtime', duration: 1.2, fps: 30, width: 320, height: 180 });
        data = jsonOf(res);
        if (data?.saved_abs) exported.push(data.saved_abs);
        const rtInfo = data?.saved_abs && fs.existsSync(data.saved_abs) ? readWebm(fs.readFileSync(data.saved_abs)) : null;
        check(!res.isError && data?.mode === 'realtime' && data.duration_s > 1 && data.duration_s < 2.5 && rtInfo && rtInfo.blocks >= 20 && rtInfo.durationMs > 1000,
            'start_recording realtime (auto-stop): MediaRecorder WebM with a Duration', { data: data && { ...data, saved_abs: undefined }, rtInfo });
        res = await call('start_recording', { preview_id: vid, mode: 'realtime', width: 320, height: 180 });
        data = jsonOf(res);
        check(!res.isError && data?.recording === true, 'start_recording realtime without duration keeps recording', textOf(res).slice(0, 200));
        await new Promise(r => setTimeout(r, 700));
        res = await call('stop_recording', {});
        data = jsonOf(res);
        if (data?.saved_abs) exported.push(data.saved_abs);
        check(!res.isError && data?.bytes > 1000 && data?.saved_abs && fs.existsSync(data.saved_abs), 'stop_recording saves the file', textOf(res).slice(0, 300));
        res = await call('stop_recording', {});
        check(res.isError && /Not recording/.test(textOf(res)), 'stop_recording when idle is an error', textOf(res).slice(0, 200));

        res = await call('output_window', { action: 'open', preview_id: vid });
        data = jsonOf(res);
        check(!res.isError && data?.window?.open === true && data.window.source === vid && data.window.width > 0, 'output_window open (pop-up showing the Preview)', textOf(res).slice(0, 400));
        res = await call('output_window', { test_pattern: 'bars', calibrating: true, calibration: { corners: [[0.1, 0.1], [0.9, 0], [1, 1], [0, 0.9]], gridSize: 3, blend: { left: 0.2 } } });
        data = jsonOf(res);
        check(!res.isError && data?.window?.test_pattern === 'bars' && data.window.calibrating === true && data.window.warp.grid === 3 && data.window.warp.blend.left === 0.2 && data.window.warp.corners[1][0] === 0.9,
            'output_window: test pattern, calibration overlay, keystone / grid / blend', data?.window);
        res = await call('output_window', { action: 'close' });
        data = jsonOf(res);
        check(!res.isError && data?.window === null && data?.editor_suspended === false, 'output_window close cleans up', textOf(res).slice(0, 300));
        for (const f of exported) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    }

    // 15. Control rate: LFO / Lag / Counter / Beat Divider at control rate, rate inference, pixel -> control rejected
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const nodeOf = async (id) => jsonOf(await call('get_project', {}))?.nodes?.find(n => n.id === id);
    res = await call('list_node_types', { category: 'control' });
    data = jsonOf(res);
    check(!res.isError && ['LFO', 'Lag', 'Counter', 'BeatDivider', 'Delay', 'Sample', 'MathExpression'].every(t => data?.types?.some(x => x.name === t)) &&
        data.types.find(x => x.name === 'LFO')?.notes?.some(n => /Control rate/.test(n)), 'list_node_types: Control group with rate notes', data?.types?.map(t => t.name));
    res = await call('build_graph', {
        nodes: [
            { key: 'lfo', type: 'LFO', data: { rate: 2, shape: 'sine' } },
            { key: 'tint', type: 'MakeVec3', data: { y: 0.3, z: 0.8 } },
            { key: 'cuv', type: 'UV' },
            { key: 'shade', type: 'Multiply' },
            { key: 'cpv', type: 'Preview' },
        ],
        connections: [{ from: 'lfo.out', to: 'tint.x' }, { from: 'tint', to: 'shade.a' }, { from: 'cuv.uv', to: 'shade.b', accessor: '.y' }, { from: 'shade', to: 'cpv' }],
    });
    data = jsonOf(res);
    const cIds = data?.ids || {};
    check(!res.isError && !data?.errors && data?.compile?.previews?.find(p => p.id === cIds.cpv)?.ok === true, 'build_graph LFO -> MakeVec3 -> shader compiles', textOf(res).slice(0, 400));
    // Measure from compile idle: nothing scheduled or linking (a debounced compile from
    // build_graph / an earlier edit would otherwise land inside the window), count stable
    const compileIdle = async (timeoutMs = 8000) => {
        const t0 = Date.now();
        let prev = null, p = null;
        while (Date.now() - t0 < timeoutMs) {
            p = jsonOf(await call('get_project', {}));
            const cr = p?.control_rate;
            if (cr && !cr.compile_pending && prev !== null && cr.compile_count === prev) return p;
            prev = cr ? cr.compile_count : null;
            await sleep(250);
        }
        return p;
    };
    let cg = await compileIdle();
    check(cg?.control_rate?.compile_pending === false, 'get_project reports compile idle (control_rate.compile_pending)', cg?.control_rate);
    const compiles0 = cg?.control_rate?.compile_count;
    const lfoA = cg?.nodes?.find(n => n.id === cIds.lfo)?.control?.values?.out;
    await sleep(700);
    cg = jsonOf(await call('get_project', {}));
    const lfoB = cg?.nodes?.find(n => n.id === cIds.lfo)?.control?.values?.out;
    const tintNode = cg?.nodes?.find(n => n.id === cIds.tint);
    check(typeof lfoA === 'number' && typeof lfoB === 'number' && lfoA !== lfoB && cg.control_rate.compile_count === compiles0,
        'an LFO drives a shader uniform: values change with 0 recompiles', { lfoA, lfoB, compiles0, compiles1: cg?.control_rate?.compile_count });
    check(tintNode?.rate === 'control' && tintNode?.control?.compiled_as_uniforms === true && tintNode.port_rates?.outputs?.[0] === 'out:control' &&
        cg.nodes.find(n => n.id === cIds.shade)?.rate === 'pixel', 'get_project reports rates (MakeVec3 fed by the LFO is control rate, the UV math stays pixel)', tintNode);
    const cFrag = jsonOf(await call('compile', { include_source: true }))?.previews?.find(p => p.id === cIds.cpv)?.fragment || '';
    check(/uniform vec3 node_\d+_c0;/.test(cFrag) && !/sin\(/.test(cFrag), 'the control-rate value reaches GLSL as a uniform (the LFO is not compiled)', cFrag.split('\n').filter(l => l.startsWith('uniform')));
    const lr0 = jsonOf(await call('render_preview', { preview_id: cIds.cpv, width: 16, height: 16, time: 0.125 }));
    const lr1 = jsonOf(await call('render_preview', { preview_id: cIds.cpv, width: 16, height: 16, time: 0.375 }));
    check(lr0?.stats && lr1?.stats && lr0.stats.mean_rgb[0] > lr1.stats.mean_rgb[0] + 20, 'render_preview evaluates control nodes at the pinned time (LFO peak vs trough)', { peak: lr0?.stats?.mean_rgb, trough: lr1?.stats?.mean_rgb });

    // Lag: smooths a Param step over time
    res = await call('build_graph', {
        nodes: [{ key: 'lp', type: 'Param', data: { label: 'Lag In', value: 0 } }, { key: 'lag', type: 'Lag', data: { up: 0.4, down: 0.4 } }],
        connections: [{ from: 'lp.value', to: 'lag.in' }],
    });
    data = jsonOf(res);
    const lagIds = data?.ids || {};
    await sleep(300);
    await call('set_param', { node_id: lagIds.lp, value: 1 });
    await sleep(150);
    const lag1 = (await nodeOf(lagIds.lag))?.control?.values?.out;
    await sleep(2200);
    const lag2 = (await nodeOf(lagIds.lag))?.control?.values?.out;
    check(lag1 > 0.05 && lag1 < 0.8 && lag2 > 0.97, 'Lag glides towards a new Param value (control state across frames)', { lag1, lag2 });

    // Beat Divider -> Counter -> SceneSwitcher.scene (metronome 240 BPM: a scene change every beat)
    await call('set_audio', { mode: 'metronome', bpm: 240 });
    res = await call('build_graph', {
        nodes: [
            { key: 'bd', type: 'BeatDivider', data: { every: 1 } }, { key: 'cnt', type: 'Counter', data: { length: 3 } },
            { key: 'ca', type: 'Color', data: { hex: '#ff0000' } }, { key: 'cb', type: 'Color', data: { hex: '#00ff00' } }, { key: 'cc', type: 'Color', data: { hex: '#0000ff' } },
            { key: 'csw', type: 'SceneSwitcher', data: { scenes: ['R', 'G', 'B'], transition: 'cut' } }, { key: 'cpv2', type: 'Preview' },
        ],
        connections: [{ from: 'bd.beat', to: 'cnt.trig' }, { from: 'cnt.count', to: 'csw.scene' }, { from: 'ca', to: 'csw.R' }, { from: 'cb', to: 'csw.G' }, { from: 'cc', to: 'csw.B' }, { from: 'csw.color', to: 'cpv2' }],
    });
    data = jsonOf(res);
    const bIds = data?.ids || {};
    check(!res.isError && !data?.errors && data?.compile?.previews?.find(p => p.id === bIds.cpv2)?.ok === true, 'build_graph Beat Divider -> Counter -> SceneSwitcher compiles', textOf(res).slice(0, 400));
    // Poll (slow software-GL frames advance the beat clock slowly): up to ~10 s
    const seenScenes = new Set();
    for (let i = 0; i < 50; i++) {
        await sleep(200);
        const sw = jsonOf(await call('list_scenes', {}))?.switchers?.find(x => x.id === bIds.csw);
        if (sw) seenScenes.add(sw.current);
        if (seenScenes.size >= 3 && i >= 5) break;
    }
    const cnt = await nodeOf(bIds.cnt);
    check(seenScenes.size >= 3 && typeof cnt?.control?.values?.count === 'number',
        'a Counter on a Beat Divider drives the SceneSwitcher scene input', { scenes: [...seenScenes], counter: cnt?.control });
    const bd = await nodeOf(bIds.bd);
    check(bd?.control?.events_fired >= 2 && bd.port_rates?.outputs?.[0] === 'beat:control', 'Beat Divider fires events (counted in get_project)', bd?.control);
    await call('set_audio', { mode: 'off' });

    // pixel -> control is rejected with a hint; rate inference on Add
    res = await call('connect', { from_node: cIds.cuv, from_output: 'uv', to_node: cIds.lfo, to_input: 'rate', accessor: '.x' });
    check(res.isError && /Sample node/.test(textOf(res)) && /control-rate input/.test(textOf(res)), 'connecting a pixel value to a control input is rejected (use a Sample node)', textOf(res));
    res = await call('connect', { from_node: cIds.cuv, from_output: 'uv', to_node: bIds.csw, to_input: 'scene', accessor: '.x' });
    check(res.isError && /SceneSwitcher|Scene Switcher/.test(textOf(res)) && /Sample/.test(textOf(res)), 'SceneSwitcher.scene rejects pixel values', textOf(res));
    res = await call('build_graph', {
        nodes: [{ key: 'pa', type: 'Param', data: { label: 'Add A', value: 0.25 } }, { key: 'pb', type: 'Param', data: { label: 'Add B', value: 0.5 } }, { key: 'sum', type: 'Add' }, { key: 'spv', type: 'Preview' }],
        connections: [{ from: 'pa.value', to: 'sum.a' }, { from: 'pb.value', to: 'sum.b' }, { from: 'sum', to: 'spv' }],
    });
    data = jsonOf(res);
    const aIds = data?.ids || {};
    await sleep(250);
    let addNode = await nodeOf(aIds.sum);
    const addRender = jsonOf(await call('render_preview', { preview_id: aIds.spv, width: 8, height: 8 }));
    check(addNode?.rate === 'control' && Math.abs(addNode?.control?.values?.out - 0.75) < 1e-6 && Math.abs(addRender?.stats?.mean_rgb?.[0] - 191) <= 1,
        'rate inference: Add of two Params runs at control rate (0.25 + 0.5 = 0.75 on screen)', { addNode, render: addRender?.stats?.mean_rgb });
    res = await call('connect', { from_node: cIds.cuv, from_output: 'uv', to_node: aIds.sum, to_input: 'b', accessor: '.x' });
    addNode = await nodeOf(aIds.sum);
    check(!res.isError && addNode?.rate === 'pixel', 'rate inference: a pixel input (UV) makes the Add pixel rate again', addNode);
    res = await call('build_graph', { nodes: [{ key: 'q1', type: 'Lag' }, { key: 'q2', type: 'Multiply' }, { key: 'qd', type: 'Delay' }], connections: [{ from: 'q1.out', to: 'q2.a' }, { from: 'q2', to: 'qd.in' }, { from: 'qd.out', to: 'q1.in' }] });
    data = jsonOf(res);
    check(!res.isError && !data?.errors && data?.connections_made === 3, 'a control loop through a Delay node is accepted', textOf(res).slice(0, 300));
    res = await call('connect', { from_node: data?.ids?.q2, from_output: 'out', to_node: data?.ids?.q1, to_input: 'up' });
    check(res.isError && /Delay/.test(textOf(res)), 'a control loop without a Delay is rejected', textOf(res));

    // Sample: a pixel value read back to the CPU (debug-probe readback, one frame late)
    res = await call('build_graph', {
        nodes: [{ key: 'suv2', type: 'UV' }, { key: 'smp', type: 'Sample', data: { uv: [0.25, 0.75] } }, { key: 'sthr', type: 'Threshold', data: { high: 0.2, low: 0.1 } }],
        connections: [{ from: 'suv2.uv', to: 'smp.in' }, { from: 'smp.x', to: 'sthr.in' }],
    });
    data = jsonOf(res);
    await sleep(1200);
    const smp = await nodeOf(data?.ids?.smp);
    const v = smp?.control?.values?.value;
    check(Array.isArray(v) && Math.abs(v[0] - 0.25) < 0.02 && Math.abs(v[1] - 0.75) < 0.02 && (await nodeOf(data?.ids?.sthr))?.control?.values?.gate === 1,
        'Sample reads a pixel value (UV at 0.25, 0.75) back to control rate and drives a Threshold', smp?.control);

    // 16. MIDI learn / mappings (no Web MIDI headless: simulate_midi feeds the bytes)
    {
        const midiNames = (await client.listTools()).tools.map(t => t.name);
        check(['midi_map', 'midi_unmap', 'simulate_midi'].every(n => midiNames.includes(n)), 'MIDI tools listed (midi_map, midi_unmap, simulate_midi)');
        res = await call('build_graph', {
            nodes: [
                { key: 'mf', type: 'Param', data: { label: 'MIDI Speed', kind: 'float', min: 0, max: 2, value: 1 } },
                { key: 'ml', type: 'Param', data: { label: 'MIDI Zoom', kind: 'float', min: 0.1, max: 10, scale: 'log', value: 1 } },
                { key: 'mt', type: 'Param', data: { label: 'MIDI Hit', kind: 'trigger' } },
                { key: 'mv', type: 'Param', data: { label: 'MIDI Pos', kind: 'vec2', value: [0.5, 0.5] } },
                { key: 'mb', type: 'Param', data: { label: 'MIDI Gate', kind: 'bool', value: false } },
                { key: 'me', type: 'Param', data: { label: 'MIDI Mode', kind: 'enum', options: ['A', 'B', 'C'], value: 0 } },
                { key: 'mx', type: 'Param', data: { label: 'MIDI Learn', kind: 'float', min: 0, max: 1, value: 0.5 } },
                { key: 'msw', type: 'SceneSwitcher', data: { scenes: ['One', 'Two', 'Three'], transition: 'cut' } },
            ],
        });
        data = jsonOf(res);
        const mIds = data?.ids || {};
        check(!res.isError && mIds.mf && mIds.msw, 'build_graph MIDI test params', textOf(res).slice(0, 300));
        const paramOf = async (id) => jsonOf(await call('list_params', {}))?.sections?.flatMap(sec => sec.params)?.find(p => p.id === id);
        const sim = async (messages, extra = {}) => jsonOf(await call('simulate_midi', { messages, ...extra }));

        res = await call('midi_map', { param: 'MIDI Speed', type: 'cc', number: 21, channel: 1 });
        data = jsonOf(res);
        check(!res.isError && data?.mapping?.label === 'CC 21 · ch1' && data.mapping.pickup === true && data.param?.midi?.length === 1,
            'midi_map CC 21 -> float (soft takeover on by default)', textOf(res).slice(0, 400));
        let sm = await sim([[176, 21, 0], [176, 21, 10]]);
        check(sm?.nodes?.find(n => n.id === mIds.mf)?.value === 1 && sm.effects?.every(e => e.pickup === 'waiting'),
            'soft takeover: the knob far below the value does not move it', sm);
        sm = await sim([[176, 21, 70], [176, 21, 127]]);
        check(sm?.nodes?.find(n => n.id === mIds.mf)?.value === 2, 'soft takeover: once the knob passes the value it follows (CC 127 -> max 2)', sm);
        sm = await sim([[176, 21, 0]]);
        let mp = await paramOf(mIds.mf);
        check(mp?.value === 0 && mp.midi?.[0]?.picked_up === true && mp.midi[0].number === 21 && mp.midi[0].channel === 1,
            'the Param value follows the CC; list_params shows the mapping (picked_up)', mp);
        await call('set_param', { node_id: mIds.mf, value: 1.5 });
        sm = await sim([[176, 21, 10]]);
        check(sm?.nodes?.find(n => n.id === mIds.mf)?.value === 1.5, 'a value set elsewhere (set_param) re-arms soft takeover', sm);

        await call('midi_map', { param: 'MIDI Zoom', type: 'cc', number: 22, options: { pickup: false } });
        sm = await sim([[176, 22, 64]]);
        const zoom = sm?.nodes?.find(n => n.id === mIds.ml)?.value;
        check(Math.abs(zoom - 0.1 * Math.pow(100, 64 / 127)) < 0.01, 'CC on a log-scale param maps along the log scale', { zoom });

        res = await call('midi_map', { param: mIds.mt, type: 'note', number: 'C3', channel: 10 });
        check(!res.isError && jsonOf(res)?.mapping?.number === 60 && jsonOf(res)?.mapping?.label === 'Note C3 · ch10', 'midi_map note C3 (= 60) -> trigger', textOf(res).slice(0, 300));
        sm = await sim([[0x99, 60, 100]]);
        const hit = sm?.nodes?.find(n => n.id === mIds.mt);
        check(sm?.effects?.some(e => e.node_id === mIds.mt && e.pulse === true) && hit?.value === 1 && hit.pulse === true, 'note-on -> trigger pulse (count 1)', sm);
        sm = await sim([[0x89, 60, 0], [0x99, 61, 100]]);
        check((await paramOf(mIds.mt))?.value === 1, 'note-off / other notes do not fire the trigger');

        await call('midi_map', { param: 'MIDI Pos', type: 'cc', number: 30, options: { target: 'x', pickup: false } });
        await call('midi_map', { param: 'MIDI Pos', type: 'cc', number: 31, options: { target: 'y', pickup: false, invert: true } });
        sm = await sim([[176, 30, 127], [176, 31, 127]]);
        mp = await paramOf(mIds.mv);
        check(JSON.stringify(mp?.value) === '[1,0]' && mp.midi?.length === 2, 'vec2: two CCs (x, inverted y)', mp);

        await call('midi_map', { param: 'MIDI Gate', type: 'note', number: 40 });
        sm = await sim([[0x90, 40, 100], [0x80, 40, 0]]);
        check(sm?.nodes?.find(n => n.id === mIds.mb)?.value === true, 'note -> bool toggles on press', sm);
        await call('midi_map', { param: 'MIDI Mode', type: 'cc', number: 23 });
        sm = await sim([[176, 23, 127]]);
        check(sm?.nodes?.find(n => n.id === mIds.me)?.value === 2, 'CC -> enum buckets (127 = last option)', sm);

        // MIDI learn through the simulation hook: an endless encoder (64-centred) is detected
        res = await call('midi_map', { param: 'MIDI Learn', learn: true });
        check(!res.isError && jsonOf(res)?.learning === true, 'midi_map learn: true arms MIDI learn', textOf(res).slice(0, 300));
        sm = await sim([[176, 50, 65], [176, 50, 65], [176, 50, 65]]);
        mp = await paramOf(mIds.mx);
        check(sm?.learn?.done === true && mp?.midi?.[0]?.number === 50 && mp.midi[0].mode === 'relative-64' && mp.value > 0.5,
            'learn maps the next control and detects a relative (64-centred) encoder', { learn: sm?.learn, mp });

        res = await call('midi_map', { scene_node: mIds.msw, action: 'scene', scene: 'Three', type: 'note', number: 36, channel: 10 });
        check(!res.isError, 'midi_map pad note -> scene "Three"', textOf(res).slice(0, 300));
        await call('midi_map', { scene_node: mIds.msw, action: 'next', type: 'note', number: 37, channel: 10 });
        sm = await sim([[0x99, 36, 110]]);
        check(sm?.nodes?.find(n => n.id === mIds.msw)?.current === 2, 'pad note selects the scene', sm);
        sm = await sim([[0x99, 37, 110]]);
        const scenesNow = jsonOf(await call('list_scenes', {}))?.switchers?.find(x => x.id === mIds.msw);
        check(scenesNow?.current === 0 && scenesNow.midi?.length === 2, 'next-scene pad wraps to the first scene; list_scenes shows the mappings', scenesNow);

        // Persistence: the mappings are saved in the project file (Param data.midi, with channel + device)
        res = await call('midi_map', { param: 'MIDI Speed', type: 'cc', number: 21, channel: 1, device: 'nanoKONTROL2' });
        await sleep(300);
        let savedMidi = null;
        try {
            const proj = JSON.parse(fs.readFileSync(path.join(projectsDir, `${slug}.patchtoy.json`), 'utf8'));
            const find = (o) => {
                if (!o || typeof o !== 'object') return null;
                if (o.data && o.data.label === 'MIDI Speed' && o.data.midi) return o.data.midi;
                for (const v of Object.values(o)) { const f = find(v); if (f) return f; }
                return null;
            };
            savedMidi = find(proj);
        } catch (e) { savedMidi = String(e.message); }
        check(Array.isArray(savedMidi) && savedMidi[0]?.number === 21 && savedMidi[0].channel === 1 && savedMidi[0].device === 'nanoKONTROL2',
            'mappings are saved in the project file (number, channel, device)', savedMidi);
        sm = await sim([[176, 21, 5]], { device: 'Other Controller' });
        check(!sm?.effects?.length, 'a mapping bound to a device ignores other inputs', sm);

        res = await call('midi_unmap', { param: 'MIDI Speed' });
        mp = await paramOf(mIds.mf);
        check(!res.isError && jsonOf(res)?.removed?.length === 1 && !mp?.midi, 'midi_unmap removes the mapping', textOf(res).slice(0, 300));
        res = await call('midi_map', { param: 'MIDI Speed', type: 'cc', number: 200 });
        check(res.isError, 'midi_map rejects a CC number out of range', textOf(res).slice(0, 200));
        res = await call('simulate_midi', { status: 0xF8 });
        check(res.isError && /channel message/.test(textOf(res)), 'simulate_midi rejects non-channel messages', textOf(res).slice(0, 200));
    }

    // 17. I/O bridge loopback: OSC Out -> bridge (UDP) -> OSC In on this machine, mock serial echo, opt-in + allowlist
    {
        const { IOBridge } = await import('./lib/io-bridge.mjs');
        const dgram = await import('node:dgram');
        const freeUdp = () => new Promise((resolve) => { const u = dgram.createSocket('udp4'); u.bind(0, '127.0.0.1', () => { const p = u.address().port; u.close(() => resolve(p)); }); });
        const oscPort = await freeUdp();
        const ioBridge = new IOBridge({ port: 0, mockSerial: true, logger: { log: () => {}, warn: () => {} } });
        await ioBridge.start();
        try {
            await call('io_bridge', { action: 'unpair' }); // a reused headless profile may remember a token
            res = await call('list_node_types', { category: 'io' });
            data = jsonOf(res);
            check(!res.isError && ['OSCIn', 'OSCOut', 'SerialIn', 'SerialOut', 'MIDIOutCC', 'MIDIOutNote', 'ArtNetOut'].every(t => data?.types?.some(x => x.name === t && x.rate === 'control' && x.notes?.some(n => /I\/O node/.test(n)))),
                'list_node_types category io: the 7 I/O nodes with notes', textOf(res).slice(0, 300));

            res = await call('build_graph', {
                nodes: [
                    { key: 'ip', type: 'Param', data: { label: 'IO Send', value: 0.25 } },
                    { key: 'oo', type: 'OSCOut', data: { address: '/e2e/value', host: '127.0.0.1', port: String(oscPort) } },
                    { key: 'oi', type: 'OSCIn', data: { address: '/e2e/*', port: String(oscPort) } },
                    { key: 'ic', type: 'Counter', data: { mode: 'free', length: 1000 } },
                    { key: 'ob', type: 'OSCOut', data: { address: '/e2e/blocked', host: '127.0.0.1', port: String(oscPort + 1) } },
                    { key: 'so', type: 'SerialOut', data: { port: '/dev/mock-loopback', baud: '115200' } },
                    { key: 'si', type: 'SerialIn', data: { port: '/dev/mock-loopback', baud: '115200' } },
                ],
                connections: [{ from: 'ip.value', to: 'oo.value' }, { from: 'oi.trig', to: 'ic.trig' }, { from: 'ip.value', to: 'so.value' }, { from: 'ip.value', to: 'ob.value' }],
            });
            data = jsonOf(res);
            const io = data?.ids || {};
            check(!res.isError && !data?.errors && io.oi !== undefined, 'build_graph OSC Out / OSC In / Serial Out / Serial In', textOf(res).slice(0, 300));
            await sleep(400);
            let n = await nodeOf(io.oo);
            check(n?.io && n.io.state !== 'ok' && /not paired/.test(n.io.status), 'before pairing, I/O nodes report "not paired" (nothing sent)', n?.io);

            // Paired but not opted in: still nothing goes out
            res = await call('io_bridge', { action: 'configure', token: ioBridge.token, port: ioBridge.port, opt_in: false, allow: [`127.0.0.1:${oscPort}`], serial: ['/dev/mock-loopback'] });
            data = jsonOf(res);
            check(!res.isError && data?.status === 'connected' && data.opt_in === false, 'io_bridge configure pairs the headless page with the token', textOf(res).slice(0, 400));
            await sleep(400);
            n = await nodeOf(io.oo);
            check(n?.io?.state === 'wait' && /enable/.test(n.io.status) && ioBridge.stats.oscOut === 0, 'paired without opt-in: OSC Out waits, the bridge sent nothing', { io: n?.io, sent: ioBridge.stats.oscOut });

            res = await call('io_bridge', { action: 'configure', opt_in: true });
            check(!res.isError && jsonOf(res)?.opt_in === true, 'io_bridge configure opt_in');
            await sleep(1200);
            n = await nodeOf(io.oi);
            check(Math.abs(n?.control?.values?.value - 0.25) < 1e-6 && n?.control?.values?.addr === '/e2e/value' && n?.io?.state === 'ok', 'OSC Out -> bridge -> OSC In round-trips the value', n?.control || n);
            await call('set_param', { node_id: io.ip, value: 0.8125 });
            await sleep(600);
            n = await nodeOf(io.oi);
            const cnt = (await nodeOf(io.ic))?.control?.values?.count;
            check(Math.abs(n?.control?.values?.value - 0.8125) < 1e-6 && n?.control?.values?.count >= 2 && cnt >= 2, 'a new value round-trips and OSC In fires an event per message (Counter counts them)', { osc_in: n?.control?.values, counter: cnt });

            n = await nodeOf(io.ob);
            data = jsonOf(await call('io_bridge', {}));
            check(n?.io?.state === 'error' && /not allowed/.test(n.io.status) && data?.requested?.includes(`127.0.0.1:${oscPort + 1}`), 'a destination outside the allowlist is blocked and listed as requested', { io: n?.io, requested: data?.requested });

            n = await nodeOf(io.si);
            check(n?.control?.values?.text === '0.8125' && n.control.values.value === 0.8125, 'Serial Out -> mock serial (echo) -> Serial In line + numbers', n?.control || n);
            data = jsonOf(await call('get_project', {}));
            check(data?.io?.opt_in === true && data.io.nodes === 5 && data.nodes?.find(x => x.id === io.oi)?.io?.messages >= 2, 'get_project reports I/O node status', data?.io);

            res = await call('io_bridge', { action: 'list_serial' });
            check(!res.isError && jsonOf(res)?.serial_ports?.some(p => p.path === '/dev/mock-sensor'), 'io_bridge list_serial (mock ports)', textOf(res).slice(0, 300));

            // Opt out: the bridge closes the listener and the port
            await call('io_bridge', { action: 'configure', opt_in: false });
            await sleep(400);
            const st = ioBridge.status();
            check(st.listening.length === 0 && st.serial.length === 0, 'opting out closes the OSC listener and the serial port in the bridge', st);
            await call('io_bridge', { action: 'unpair' });
        } finally {
            await ioBridge.close();
        }
    }

    // 18. Render 3D: a box renders, instancing count, depth output (src/render3d)
    {
        res = await call('list_node_types', { category: 'render3d' });
        data = jsonOf(res);
        check(!res.isError && ['Render3D', 'Mesh', 'BoxMesh', 'PBRMaterial', 'DirectionalLight', 'InstanceGrid', 'Model'].every(t => data?.types?.some(x => x.name === t)) &&
            data.types.find(x => x.name === 'Render3D')?.notes?.some(n => /item1/.test(n)), 'list_node_types category render3d (with notes)', textOf(res).slice(0, 300));
        res = await call('build_graph', {
            clear: true,
            nodes: [
                { key: 'r3', type: 'Render3D', data: { orbit: { yaw: 0, pitch: 0, distance: 5, target: [0, 0, 0], fov: 45 } } },
                { key: 'box', type: 'BoxMesh' },
                { key: 'mesh', type: 'Mesh' },
                { key: 'grid', type: 'InstanceGrid', data: { nx: 4, ny: 2, nz: 3, spacing: 2 } },
                { key: 'mk', type: 'MakeInstance' },
                { key: 'many', type: 'Mesh', data: { position: [0, 0, -20] } },
                { key: 'sun', type: 'DirectionalLight' },
                { key: 'pv', type: 'Preview' },
                { key: 'vd', type: 'ValueDisplay', data: { sample: 'center' } },
            ],
            connections: [
                { from: 'box.geometry', to: 'mesh.geometry' }, { from: 'mesh.object', to: 'r3.item1' },
                { from: 'grid.position', to: 'mk.position' }, { from: 'mk.instance', to: 'many.instances' }, { from: 'many.object', to: 'r3.item3' },
                { from: 'sun.light', to: 'r3.item2' },
                { from: 'r3.color', to: 'pv.color' }, { from: 'r3.depth', to: 'vd.value' },
            ],
        });
        data = jsonOf(res);
        check(!res.isError && data?.ok !== false && data?.compile?.render3d?.[0]?.ok === true && data.compile.render3d[0].draws === 2, 'build_graph Render 3D scene compiles (item3 created on demand)', textOf(res).slice(0, 500));
        res = await call('render_preview', { width: 160, height: 100, time: 1 });
        data = jsonOf(res);
        check(!res.isError && data?.stats?.blank === false && data.stats.luma_max > 120, 'render_preview: the box renders', data?.stats);
        res = await call('get_project', {});
        data = jsonOf(res);
        const r3 = data?.nodes?.find(n => n.type === 'Render3D')?.render3d;
        check(r3 && r3.objects?.find(o => o.kind === 'box' && o.count === 24) && r3.shadow === true, 'get_project render3d: instance count 24 (auto from the Instance Grid), shadow map', r3);
        res = await call('read_probes', { wait_ms: 400 });
        data = jsonOf(res);
        const d = data?.probes?.[0]?.value?.[0];
        check(Math.abs(d - 4.5) < 0.01, 'depth output = distance from the camera (4.5 at the box face)', data?.probes?.[0]);

        // glTF: a generated skinned + animated model (scripts/make-test-glb.mjs), loaded from a temp file
        const { buildCreatureGLB } = await import('../scripts/make-test-glb.mjs');
        const glbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-e2e-glb-'));
        const glbFile = path.join(glbDir, 'creature.glb');
        fs.writeFileSync(glbFile, buildCreatureGLB({ tentacles: 4, bones: 4, rings: 16, sides: 8 }));
        try {
            res = await call('load_model', { path: glbFile });
            data = jsonOf(res);
            const m = data?.model;
            check(!res.isError && m?.status === 'ready' && m.joints === 17 && m.primitives === 2 && m.clips?.length === 2 && m.textures === 1 && data.render3d !== null,
                'load_model: glTF parsed (skin 17 joints, 2 clips, texture) and wired into the Render 3D node', textOf(res).slice(0, 400));
            const modelId = data?.node;
            await call('set_node_data', { id: modelId, data: { clip: 1 } });
            const a = jsonOf(await call('render_preview', { width: 160, height: 100, time: 0.1 }));
            const b = jsonOf(await call('render_preview', { width: 160, height: 100, time: 0.35 }));
            check(a?.stats && b?.stats && JSON.stringify(a.stats) !== JSON.stringify(b.stats), 'skinned animation: two clip times render differently', [a?.stats, b?.stats]);
            res = await call('load_model', { path: path.join(repoRoot, '..', 'outside.glb') });
            check(res.isError && /outside the allowed folders/.test(textOf(res)), 'load_model refuses paths outside the allowed folders', textOf(res).slice(0, 200));
            const draco = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'], extensionsUsed: ['KHR_draco_mesh_compression'] }));
            fs.writeFileSync(path.join(glbDir, 'draco.gltf'), draco);
            res = await call('load_model', { path: path.join(glbDir, 'draco.gltf') });
            check(res.isError && /Draco/.test(textOf(res)), 'Draco-compressed files are rejected with a clear message', textOf(res).slice(0, 200));
        } finally {
            fs.rmSync(glbDir, { recursive: true, force: true });
        }
    }

    res = await call('get_status', {});
    data = jsonOf(res);
    check(!res.isError && data?.clients?.length >= 1, 'get_status lists the headless client', textOf(res));
} catch (err) {
    failures++;
    console.log(`  FAIL unexpected error: ${err.stack || err.message}`);
} finally {
    if (created) {
        try {
            const res = await call('delete_project', { name: projectName });
            check(!res.isError, 'delete_project');
            const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            check(!fs.existsSync(path.join(projectsDir, `${slug}.patchtoy.json`)), 'project file removed');
        } catch (e) {
            failures++;
            console.log(`  FAIL cleanup: ${e.message}`);
        }
    }
    try { await client.close(); } catch { /* ignore */ }
    if (privateVite) try { await privateVite.close(); } catch { /* ignore */ }
    if (scratchProjects) try { fs.rmSync(projectsDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
