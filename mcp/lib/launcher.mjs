/**
 * Auto-launch helpers: make sure a PatchToy dev server is reachable (spawning
 * Vite if needed) and open the app in a headless Chrome via playwright-core.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log, warn } from './log.mjs';

export async function probeApp(url, timeoutMs = 2000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        const text = await res.text();
        return { reachable: true, ok: res.ok, isPatchToy: /PatchToy/i.test(text) };
    } catch {
        return { reachable: false };
    } finally {
        clearTimeout(t);
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Ensure `url` serves PatchToy. If nothing is listening and the URL points at
 * localhost, spawn `vite --port <port> --strictPort` from the repo root.
 * Returns { url, child } (child is null when an existing server is reused).
 */
export async function ensureApp({ url, repoRoot, timeoutMs = 45000 }) {
    const probe = await probeApp(url);
    if (probe.reachable) {
        if (!probe.isPatchToy) {
            throw new Error(`${url} is reachable but does not look like PatchToy. Set PATCHTOY_URL to the PatchToy dev server.`);
        }
        return { url, child: null };
    }

    const u = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) {
        throw new Error(`PatchToy is not reachable at ${url} (and it is not a local URL, so it can't be auto-started).`);
    }
    const port = u.port || '5173';

    const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
    let cmd, args;
    if (fs.existsSync(viteBin)) {
        cmd = process.execPath;
        args = [viteBin, '--port', port, '--strictPort', '--host', u.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost'];
    } else {
        cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        args = ['vite', '--port', port, '--strictPort'];
    }
    log(`starting Vite dev server: ${path.basename(cmd)} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' },
    });
    const forward = (chunk) => {
        // eslint-disable-next-line no-control-regex
        for (const line of String(chunk).replace(/\x1b\[[0-9;]*m/g, '').split('\n')) if (line.trim()) process.stderr.write(`[vite] ${line}\n`);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    let exited = null;
    child.on('exit', (code) => { exited = code; });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (exited !== null) throw new Error(`Vite exited with code ${exited} before serving ${url} (port busy?)`);
        const p = await probeApp(url, 1500);
        if (p.reachable && p.isPatchToy) {
            log(`Vite dev server ready at ${url}`);
            return { url, child };
        }
        await sleep(300);
    }
    try { child.kill(); } catch { /* ignore */ }
    throw new Error(`Timed out waiting for Vite to serve ${url}`);
}

const CHROME_ARGS = [
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', // allow software WebGL if no GPU is available
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
];

/**
 * Launch Chrome (system Chrome by default) and return { browser, context }.
 */
export async function launchBrowser({ headed = false } = {}) {
    let chromium;
    try {
        ({ chromium } = await import('playwright-core'));
    } catch {
        throw new Error('playwright-core is not installed. Run `npm install` in the PatchToy repo.');
    }

    const attempts = [];
    if (process.env.PATCHTOY_CHROME_PATH) attempts.push({ executablePath: process.env.PATCHTOY_CHROME_PATH });
    attempts.push({ channel: 'chrome' }, { channel: 'msedge' }, {});

    let lastErr;
    for (const extra of attempts) {
        try {
            // PATCHTOY_CHROME_ARGS: extra space-separated flags (CI: --use-angle=swiftshader)
            const extraArgs = (process.env.PATCHTOY_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
            const browser = await chromium.launch({ headless: !headed, args: [...CHROME_ARGS, ...extraArgs], ...extra });
            log(`launched ${headed ? 'headed' : 'headless'} browser ${browser.version()} (${extra.executablePath || extra.channel || 'playwright chromium'})`);
            return browser;
        } catch (err) {
            lastErr = err;
        }
    }
    throw new Error(`Could not launch Chrome via playwright-core. Install Google Chrome or set PATCHTOY_CHROME_PATH. Last error: ${lastErr?.message?.split('\n')[0]}`);
}
