import { defineConfig } from 'vite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/*
 * Dev-only helpers for the MCP bridge (mcp/, src/automation/BridgeClient.js).
 *
 * GET /__patchtoy/bridge-probe?port=N -> {up, token?}
 *   Whether something listens on 127.0.0.1:N. A refused WebSocket always logs a
 *   console error in the browser; a same-origin fetch that answers {up:false}
 *   does not, so dev tabs stay quiet when the MCP server isn't running.
 *   When the PatchToy MCP server on that port accepts live tabs it also returns
 *   its pairing token, read from node_modules/.cache/patchtoy-mcp/bridge-N.json
 *   (written by mcp/lib/session.mjs). The token is only given to same-origin
 *   requests on a loopback Host: other localhost sites (other dev servers,
 *   local tools) are refused, even though Vite's CORS default would let them
 *   read the response.
 *
 * Dev-server registration: node_modules/.cache/patchtoy-mcp/devserver-<pid>-<port>.json
 *   lists this server's loopback origins so the MCP bridge accepts tabs from it
 *   (its Origin allowlist is strict otherwise), and its role. Removed when the
 *   server closes.
 *
 * Role: 'private' for the dev servers tests and agents start (HMR off, or
 *   PATCHTOY_DEV_ROLE=private), 'dev' otherwise (PATCHTOY_DEV_ROLE=dev forces it).
 *   The probe answers it as {role}; pages of a private server pair as
 *   "automation" clients, which the MCP server never picks as the user's live tab.
 *
 * The file layout matches mcp/lib/auth.mjs; kept self-contained here so the dev
 * server never depends on the MCP code.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const pairingDir = (root) => path.join(root, 'node_modules', '.cache', 'patchtoy-mcp');

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readPairingToken(root, port) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(pairingDir(root), `bridge-${port}.json`), 'utf8'));
        if (d && d.port === port && typeof d.token === 'string' && pidAlive(d.pid)) return d.token;
    } catch { /* no MCP server with live pairing on this port */ }
    return null;
}

/** 'same' (same-origin request on a loopback host), 'lan' (same-origin, other host), or 'foreign'. */
function requestSite(req) {
    const host = req.headers.host;
    if (!host) return 'foreign';
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return 'foreign';
    const origin = req.headers.origin;
    if (origin) {
        try { if (new URL(origin).host !== host) return 'foreign'; } catch { return 'foreign'; }
    }
    let hostname;
    try { hostname = new URL(`http://${host}`).hostname; } catch { return 'foreign'; }
    return LOOPBACK_HOSTS.has(hostname) ? 'same' : 'lan';
}

/** Read once per server (configureServer): later env changes don't affect a running server. */
function devRole(server) {
    const env = String(process.env.PATCHTOY_DEV_ROLE || '').toLowerCase();
    if (env === 'private' || env === 'dev') return env;
    return server.config.server.hmr === false ? 'private' : 'dev';
}

function sendJson(res, status, body) {
    if (res.writableEnded) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

function registerDevServer(server, role) {
    const httpServer = server.httpServer;
    if (!httpServer) return;
    const root = server.config.root;
    const id = crypto.randomBytes(8).toString('hex');
    let file = null;
    const unregister = () => {
        if (!file) return;
        try {
            const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (cur.id === id) fs.unlinkSync(file);
        } catch { /* gone */ }
        file = null;
    };
    httpServer.once('listening', () => {
        try {
            const addr = httpServer.address();
            if (!addr || typeof addr !== 'object') return;
            const scheme = server.config.server.https ? 'https' : 'http';
            const origins = [...LOOPBACK_HOSTS].map(h => `${scheme}://${h}:${addr.port}`);
            const dir = pairingDir(root);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            file = path.join(dir, `devserver-${process.pid}-${addr.port}.json`);
            fs.writeFileSync(file, JSON.stringify({ id, pid: process.pid, port: addr.port, origins, role }) + '\n', { mode: 0o600 });
        } catch { /* best effort: the MCP server then only accepts PATCHTOY_URL's origin */ }
    });
    httpServer.once('close', unregister);
    // One process 'exit' hook for all registrations (config restarts re-run this)
    const regs = (globalThis.__patchtoyDevServerRegs ||= new Set());
    if (!regs.hooked) {
        regs.hooked = true;
        process.once('exit', () => { for (const fn of regs) fn(); });
    }
    regs.add(unregister);
    httpServer.once('close', () => regs.delete(unregister));
}

function bridgeProbe() {
    return {
        name: 'patchtoy-bridge-probe',
        apply: 'serve',
        configureServer(server) {
            const role = devRole(server);
            registerDevServer(server, role);
            server.middlewares.use('/__patchtoy/bridge-probe', (req, res) => {
                const site = requestSite(req);
                if (site === 'foreign') return sendJson(res, 403, { error: 'same-origin requests only' });
                const url = new URL(req.url, 'http://localhost');
                const raw = url.searchParams.get('port');
                const port = raw === null || raw === '' ? 7878 : Number(raw);
                if (!Number.isInteger(port) || port < 1024 || port > 65535) return sendJson(res, 400, { error: 'port must be an integer 1024-65535' });
                const socket = net.connect({ host: '127.0.0.1', port });
                let done = false;
                const reply = (up) => {
                    if (done) return;
                    done = true;
                    socket.destroy();
                    const body = { up, role };
                    if (up && site === 'same') {
                        const token = readPairingToken(server.config.root, port);
                        if (token) body.token = token;
                    }
                    sendJson(res, 200, body);
                };
                socket.setTimeout(300, () => reply(false));
                socket.once('connect', () => reply(true));
                socket.once('error', () => reply(false));
            });
        },
    };
}

export default defineConfig({
    plugins: [bridgeProbe()],
});
