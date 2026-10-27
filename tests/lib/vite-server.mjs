/**
 * Private Vite dev server for the test suites: free port (never 5200 / 5173,
 * which developers keep open), HMR and the file watcher off, so source edits made
 * while the tests run (other people / agents) never reload the page under test.
 *
 *   const vite = await startTestVite();   // { url, port, close() }
 *
 * Its pages pair with a running MCP server only as "automation" clients (vite.config.js
 * role 'private'), never as the user's live tab. role: 'dev' makes it act like a
 * regular `npm run dev` server instead (tests of the live-tab selection).
 */
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESERVED = new Set([5173, 5200, 7878]);

export function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => (RESERVED.has(port) ? freePort().then(resolve, reject) : resolve(port)));
        });
    });
}

export async function startTestVite({ port, quiet = true, role = null } = {}) {
    const { createServer } = await import('vite');
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
        const p = port || await freePort();
        let server;
        const savedRole = process.env.PATCHTOY_DEV_ROLE;
        if (role) process.env.PATCHTOY_DEV_ROLE = role; // read once by vite.config.js configureServer
        try {
            server = await createServer({
                root: REPO_ROOT,
                configFile: path.join(REPO_ROOT, 'vite.config.js'),
                clearScreen: false,
                logLevel: quiet ? 'error' : 'info',
                server: { host: '127.0.0.1', port: p, strictPort: true, hmr: false, watch: null, open: false },
                optimizeDeps: { force: false },
            });
            await server.listen();
            if (role) { if (savedRole === undefined) delete process.env.PATCHTOY_DEV_ROLE; else process.env.PATCHTOY_DEV_ROLE = savedRole; }
            const url = `http://127.0.0.1:${p}/`;
            // Warm-up request: the first page load transforms index.html / main.js
            await fetch(url).then(r => r.text()).catch(() => { });
            let closed = false;
            return {
                url,
                port: p,
                server,
                async close() {
                    if (closed) return;
                    closed = true;
                    try { await server.close(); } catch { /* ignore */ }
                },
            };
        } catch (err) {
            if (role) { if (savedRole === undefined) delete process.env.PATCHTOY_DEV_ROLE; else process.env.PATCHTOY_DEV_ROLE = savedRole; }
            lastErr = err;
            try { await server?.close(); } catch { /* ignore */ }
            if (port) break;
        }
    }
    throw new Error(`Could not start the test Vite server: ${lastErr?.message}`);
}
