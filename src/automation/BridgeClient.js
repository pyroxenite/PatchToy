/**
 * BridgeClient - connects a running PatchToy page to the PatchToy MCP server
 * (mcp/server.mjs) over a local WebSocket so an AI agent can drive the editor.
 *
 * When it runs:
 *   - Vite dev server (import.meta.env.DEV): on by default. The page asks the
 *     dev server (same-origin /__patchtoy/bridge-probe) whether the MCP server
 *     is listening and for its live-pairing token, so dev tabs pair by
 *     themselves. ?bridge=PORT picks another port, ?bridgeToken=T a token.
 *   - Production builds: off, unless you opt in from the devtools console with
 *     localStorage.patchtoyBridge = 'on' AND open a pairing URL with
 *     ?bridge=PORT&bridgeToken=T (from the MCP server's get_status pair_url).
 *     A link alone can't turn it on.
 *   - Disable with ?bridge=off or localStorage.patchtoyBridge = 'off'.
 *
 * Security: the page sends its token and a random nonce in hello; the server
 * must answer with HMAC-SHA256(token, 'patchtoy-bridge-v1:' + nonce), so
 * commands from anything else listening on the port are never run. Failed
 * connections back off exponentially and stop after MAX_FAILURES (focusing
 * the tab retries).
 *
 * Protocol (JSON text frames):
 *   client -> server  {type:'hello', clientId, headless, automated, devRole, token, nonce, visible, href, loaded}
 *                     automated: navigator.webdriver (Playwright / WebDriver page); devRole: the
 *                     dev server's role from the probe ('dev' | 'private'). Either marks a paired
 *                     page as an "automation" client the MCP server never picks as the user's tab.
 *   server -> client  {type:'welcome', agentName, server, proof}
 *   server -> client  {type:'error', code:'auth', error}             (then close 4401)
 *   server -> client  {id, method, params}           (request)
 *   client -> server  {id, result} | {id, error:{message, data}}
 *   client -> server  {type:'chunk', id, seq, last, data}   (a response over CHUNK_CHARS, split;
 *                     data = consecutive slices of its JSON text)
 *
 * Commands run one at a time, in arrival order (AutomationAPI.handle swaps the
 * page's dialogs per call, and commands assume they own the graph), except the
 * CONCURRENT ones (stopRecording must be able to cancel a running export).
 * The browser answers the server's heartbeat pings by itself.
 *   client -> server  {type:'visibility', visible}
 *   client -> server  {type:'project-changed', slug, project}   (user edited in live mode)
 *   client -> server  {type:'project-detached', slug, reason}
 *
 * Window events:
 *   'patchtoy:bridge-status' detail {connected, clientName, port, headless, gaveUp?, error?}
 *   'patchtoy:activity'      detail {message}   (emitted by AutomationAPI)
 */
import { AutomationAPI } from './AutomationAPI.js';

const DEFAULT_PORT = 7878;
const MAX_FAILURES = 8;
const MAX_BACKOFF_MS = 30000;
const PROOF_CONTEXT = 'patchtoy-bridge-v1:'; // mcp/lib/auth.mjs serverProof()
/** Responses longer than this (JSON characters) go out as chunk frames (mcp/lib/bridge.mjs). */
const CHUNK_CHARS = 1024 * 1024;
/** Methods that never wait for the command queue. */
const CONCURRENT = new Set(['stopRecording', 'ping', 'getInfo', 'detachProject']);

// One id per page load: a duplicated tab (which copies sessionStorage) gets its own
function newClientId() {
    return 'tab-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key, message) {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
    return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

/** A browser driven by WebDriver / Playwright / Puppeteer (tests, agents), not the user. */
function isAutomated() {
    try { return navigator.webdriver === true; } catch (e) { return false; }
}

function isDevBuild() {
    try { return !!(import.meta.env && import.meta.env.DEV); } catch (e) { return false; }
}

export class BridgeClient {
    constructor(toy, { port = DEFAULT_PORT, headless = false, token = null, explicit = false } = {}) {
        this.toy = toy;
        this.port = port;
        this.headless = headless;
        this.token = token;           // from ?bridgeToken (headless launch / pairing URL)
        this.devToken = null;         // from the dev server's pairing endpoint
        this.devRole = null;          // 'dev' | 'private' (from the same endpoint)
        this.explicit = explicit;
        this.clientId = newClientId();
        this.ws = null;
        this.connected = false;
        this.agentName = null;
        this.failures = 0;
        this.gaveUp = false;
        this.authFailed = false;
        this.lastConnectedAt = 0;
        this.reconnectTimer = null;
        this.stopped = false;
        this._welcome = null;
        this._cmdQueue = Promise.resolve();

        this.api = new AutomationAPI(toy, { headless });
        this.api.onProjectChanged = (payload) => this.send({ type: 'project-changed', ...payload });
        this.api.onProjectDetached = (payload) => this.send({ type: 'project-detached', ...payload });
    }

    start() {
        if (this.headless) this._installHeadlessDialogStubs();
        // The page's own dialogs: put back whenever no command runs (AutomationAPI.handle swaps
        // them per call; a CONCURRENT call finishing out of order must not leave its swap behind)
        this._dialogs = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };

        const retryOnUser = () => {
            if (this.connected || this.stopped) return;
            if (this.authFailed && !this._canRefreshToken()) return; // stale pairing URL: needs a new one
            if (this.gaveUp) { this.gaveUp = false; this.failures = 0; }
            this._reconnectSoon(0);
        };
        document.addEventListener('visibilitychange', () => {
            this.send({ type: 'visibility', visible: !document.hidden });
            // Coming back to the tab is a good moment to retry quickly
            if (!document.hidden) retryOnUser();
        });
        window.addEventListener('focus', retryOnUser);
        window.addEventListener('pagehide', () => this._pause());
        window.addEventListener('pageshow', (e) => { if (e.persisted) { this.stopped = false; retryOnUser(); } });

        this._connect();
        return this;
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        if (this.ws) try { this.ws.close(); } catch (e) { /* ignore */ }
    }

    _pause() {
        // bfcache-friendly: close now, pageshow (persisted) restarts
        this.stop();
    }

    _installHeadlessDialogStubs() {
        // A launched headless browser has no user: never let a dialog block it.
        window.alert = (m) => console.warn('[headless alert]', m);
        window.confirm = (m) => { console.warn('[headless confirm -> false]', m); return false; };
        window.prompt = (m) => { console.warn('[headless prompt -> null]', m); return null; };
    }

    _emitStatus(extra = {}) {
        try {
            window.dispatchEvent(new CustomEvent('patchtoy:bridge-status', {
                detail: { connected: this.connected, clientName: this.agentName, port: this.port, headless: this.headless, ...extra }
            }));
        } catch (e) { /* ignore */ }
    }

    _reconnectSoon(delay) {
        if (this.stopped) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this._connect(), delay);
    }

    _canRefreshToken() {
        return !this.token && isDevBuild();
    }

    // Dev server: ask Vite whether the MCP server is listening (a refused WebSocket
    // always logs a console error; this same-origin fetch doesn't) and for its
    // live-pairing token. -> {up, token} | null when the probe is unavailable.
    async _probe() {
        if (!isDevBuild()) return null;
        try {
            const res = await fetch(`/__patchtoy/bridge-probe?port=${this.port}`, { cache: 'no-store', credentials: 'same-origin' });
            if (!res.ok) return null;
            this._probeWorks = true;
            const d = await res.json();
            if (d.role === 'dev' || d.role === 'private') this.devRole = d.role;
            return { up: d.up === true, token: typeof d.token === 'string' ? d.token : null };
        } catch (e) {
            return null;
        }
    }

    async _connect() {
        if (this.stopped || this._probing || this.gaveUp) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

        let token = this.token;
        if (!token || !this.explicit) {
            this._probing = true;
            const probe = await this._probe();
            this._probing = false;
            if (this.stopped) return;
            if (probe && !probe.up) { this._scheduleReconnect(false); return; }
            if (!token) {
                token = probe && probe.token;
                this.devToken = token || null;
                if (!token) {
                    // Something listens but offers no pairing (an older MCP server, live
                    // pairing off, or not PatchToy): stay quiet and look again later.
                    this._scheduleReconnect(false);
                    return;
                }
            }
        }
        if (!token) { this._giveUp('no bridge token (open the pairing URL from get_status)'); return; }
        if (!(window.crypto && crypto.subtle)) { this._giveUp('this page is not a secure context (use http://localhost), so the server cannot be verified'); return; }

        let ws;
        try {
            ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
        } catch (e) {
            this._scheduleReconnect(true);
            return;
        }
        this.ws = ws;
        const nonce = randomHex(16);
        const conn = { ws, token, nonce, authError: null };
        this._conn = conn;

        ws.onopen = () => {
            const loaded = this.api.activeProject
                ? { slug: this.api.activeProject.slug, timestamp: this.api.activeProject.timestamp }
                : null;
            this._sendOn(ws, {
                type: 'hello',
                clientId: this.clientId,
                headless: this.headless,
                automated: isAutomated(),
                devRole: this.devRole || null,
                token,
                nonce,
                visible: !document.hidden,
                href: location.href,
                loaded,
            });
        };

        ws.onmessage = (ev) => this._onMessage(ev.data, conn);

        ws.onclose = (ev) => {
            const was = this.connected;
            this.connected = false;
            if (this.ws === ws) this.ws = null;
            if (was) {
                this.lastConnectedAt = Date.now();
                console.info('[bridge] disconnected from MCP server');
                this._emitStatus();
            }
            if (conn.authError || ev.code === 4401) {
                this._onAuthFailure(conn.authError || ev.reason || 'unauthorized');
                return;
            }
            this._scheduleReconnect(!was);
        };

        ws.onerror = () => { /* onclose follows */ };
    }

    _onAuthFailure(message) {
        console.warn(`[bridge] the MCP server refused this tab: ${message}`);
        this.failures++;
        if (this._canRefreshToken() && this.failures < MAX_FAILURES) {
            // Dev tab: the MCP server probably restarted with a new token; fetch it again
            this.devToken = null;
            this._scheduleReconnect(false, true);
            return;
        }
        this.authFailed = true;
        this._giveUp('pairing token rejected: open a new pairing URL (get_status pair_url) or reload');
    }

    _giveUp(why) {
        this.gaveUp = true;
        clearTimeout(this.reconnectTimer);
        console.warn(`[bridge] not connecting to the MCP server on port ${this.port}: ${why}. Focus the tab or reload to retry.`);
        this._emitStatus({ gaveUp: true, error: why });
    }

    /**
     * failed: the WebSocket closed before a verified welcome (refused, wrong server, auth).
     * Failures back off exponentially (0.5 s, 1 s, 2 s ... 30 s) and stop after MAX_FAILURES.
     * Probe answers "nothing listening" are not failures: dev tabs keep polling quietly.
     */
    _scheduleReconnect(failed, counted = false) {
        if (this.stopped) return;
        if (failed && !counted) this.failures++;
        if (this.failures >= MAX_FAILURES) {
            this._giveUp(`${this.failures} failed connection attempts`);
            return;
        }
        let delay;
        if (failed || counted) {
            delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.max(0, this.failures - 1));
            delay = Math.round(delay * (0.8 + Math.random() * 0.4));
        } else if (this.lastConnectedAt && Date.now() - this.lastConnectedAt < 60000) {
            delay = 1000; // server just went away (restart): look again soon
        } else {
            // The silent dev probe is cheap, so poll often; otherwise back off hard.
            delay = this._probeWorks ? 2500 : MAX_BACKOFF_MS;
        }
        this._reconnectSoon(delay);
    }

    _sendOn(ws, msg) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify(msg));
            return true;
        } catch (e) {
            console.warn('[bridge] send failed', e);
            return false;
        }
    }

    send(msg) {
        // Nothing leaves the page before the server proved it holds the token
        if (!this.connected) return false;
        return this._sendOn(this.ws, msg);
    }

    /** Send a command's response; split it when large; report a result that can't be serialized. */
    _sendResponse(msg) {
        if (!this.connected || !this.ws) return false;
        const ws = this.ws;
        let text;
        try {
            text = JSON.stringify(msg);
        } catch (e) {
            // Circular / BigInt / larger than the engine's string limit: fail the call now
            // instead of letting the server wait for its timeout.
            console.warn('[bridge] result not serializable', e);
            return this._sendOn(ws, { id: msg.id, error: { message: `The app's result could not be sent (${e && e.name === 'RangeError' ? 'too large' : 'not serializable'}: ${e && e.message})`, data: e && e.name === 'RangeError' ? { too_large: true } : undefined } });
        }
        try {
            if (text.length <= CHUNK_CHARS) { ws.send(text); return true; }
            const n = Math.ceil(text.length / CHUNK_CHARS);
            for (let i = 0; i < n; i++) {
                if (ws.readyState !== WebSocket.OPEN) return false;
                ws.send(JSON.stringify({ type: 'chunk', id: msg.id, seq: i, last: i === n - 1, data: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) }));
            }
            return true;
        } catch (e) {
            console.warn('[bridge] send failed', e);
            return false;
        }
    }

    /** Run a command; one at a time unless it is CONCURRENT. */
    _runCommand(msg) {
        const run = async () => {
            this._running = (this._running || 0) + 1;
            try {
                const result = await this.api.handle(msg.method, msg.params || {});
                return { id: msg.id, result: result === undefined ? null : result };
            } catch (err) {
                const error = { message: err?.message || String(err) };
                if (err && err.data !== undefined) error.data = err.data;
                if (!(err && err.name === 'AutomationError')) {
                    console.error('[bridge] command failed:', msg.method, err);
                    if (err?.stack) error.stack = String(err.stack).split('\n').slice(0, 6).join('\n');
                }
                return { id: msg.id, error };
            } finally {
                if (--this._running === 0 && this._dialogs) Object.assign(window, this._dialogs);
            }
        };
        if (CONCURRENT.has(msg.method)) return run();
        const p = this._cmdQueue.then(run);
        this._cmdQueue = p.catch(() => { });
        return p;
    }

    async _onWelcome(msg, conn) {
        let ok = false;
        try {
            ok = typeof msg.proof === 'string' && msg.proof === await hmacHex(conn.token, PROOF_CONTEXT + conn.nonce);
        } catch (e) { ok = false; }
        if (conn.ws !== this.ws) return false;
        if (!ok) {
            conn.authError = 'the server on this port could not prove it holds the bridge token (not the PatchToy MCP server, or an older version)';
            try { conn.ws.close(); } catch (e) { /* ignore */ }
            return false;
        }
        this.failures = 0;
        this.gaveUp = false;
        this.authFailed = false;
        this.lastConnectedAt = Date.now();
        this.agentName = String(msg.agentName || 'Claude').slice(0, 60);
        this.api.agentName = this.agentName;
        this.connected = true;
        console.info(`[bridge] connected to ${msg.server || 'MCP server'} on port ${this.port} (${this.headless ? 'headless' : 'live'} mode)`);
        this._emitStatus();
        return true;
    }

    async _onMessage(raw, conn) {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }

        if (msg.type === 'welcome') {
            conn.welcome = this._onWelcome(msg, conn);
            return;
        }
        if (msg.type === 'error' && msg.code === 'auth') {
            conn.authError = String(msg.error || 'unauthorized').slice(0, 300);
            return;
        }

        if (msg.id === undefined || !msg.method) return;
        // Never run a command before (or without) a verified welcome
        if (!conn.welcome || !(await conn.welcome) || conn.ws !== this.ws || !this.connected) return;

        const response = await this._runCommand(msg);
        // The connection may have been replaced while the command ran: the old server
        // connection's request ids mean nothing to the new one
        if (conn.ws !== this.ws) return;
        this._sendResponse(response);
    }
}

/**
 * Bridge port from ?bridge: a bare ?bridge, 1/true/on mean the default port;
 * otherwise an integer 1024..65535. -> port, or null when invalid.
 */
export function parseBridgePort(raw) {
    if (raw === undefined || raw === null) return DEFAULT_PORT;
    const s = String(raw).trim().toLowerCase();
    if (s === '' || s === '1' || s === 'true' || s === 'on' || s === 'yes') return DEFAULT_PORT;
    if (!/^\d{1,5}$/.test(s)) return null;
    const n = Number(s);
    return n >= 1024 && n <= 65535 ? n : null;
}

/**
 * Initialise the bridge for a PatchToy instance. Returns the client or null
 * when the bridge is disabled.
 */
export function initAutomationBridge(toy) {
    if (!toy) return null;
    const urlParams = new URLSearchParams(window.location.search);

    // The app strips the query string when it loads a project file, so a
    // reload (e.g. Vite HMR) would forget ?bridge/headless/bridgeToken.
    // Remember them for the lifetime of this tab.
    const STORE_KEY = 'patchtoy_bridge_params';
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch (e) { /* ignore */ }
    const fromUrl = urlParams.has('bridge') || urlParams.has('bridgeToken');
    const params = fromUrl
        ? { bridge: urlParams.get('bridge'), headless: urlParams.get('headless'), bridgeToken: urlParams.get('bridgeToken') }
        : (stored || {});

    const raw = params.bridge;
    if (raw === 'off' || raw === '0' || raw === 'false') return null;

    const isDev = isDevBuild();
    let storageFlag = null;
    try { storageFlag = localStorage.getItem('patchtoyBridge'); } catch (e) { /* ignore */ }
    if (storageFlag === 'off') return null;
    const explicit = raw !== undefined && raw !== null;

    if (!isDev) {
        // Production: never because of a link alone
        if (storageFlag !== 'on') {
            if (explicit) console.warn('[bridge] ignoring ?bridge in this build. To pair with a local MCP server, run localStorage.patchtoyBridge = "on" in the console and open the pairing URL again.');
            return null;
        }
        if (!params.bridgeToken) {
            console.warn('[bridge] opt-in is on but the URL has no bridgeToken: open the pairing URL (get_status pair_url).');
            return null;
        }
    }

    const port = parseBridgePort(raw);
    if (port === null) {
        console.warn(`[bridge] invalid ?bridge port ${JSON.stringify(raw)} (use 1024-65535, or a bare ?bridge for ${DEFAULT_PORT}); bridge disabled`);
        return null;
    }
    const headless = params.headless === '1';
    const token = typeof params.bridgeToken === 'string' && params.bridgeToken ? params.bridgeToken : null;

    if (fromUrl) {
        try { sessionStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch (e) { /* ignore */ }
        // Keep the secret out of the address bar / history (sessionStorage keeps it for reloads)
        if (token) {
            try {
                const u = new URL(window.location.href);
                u.searchParams.delete('bridgeToken');
                history.replaceState(history.state, '', u.pathname + u.search + u.hash);
            } catch (e) { /* ignore */ }
        }
    }

    const client = new BridgeClient(toy, { port, headless, token, explicit }).start();
    window.__patchtoyBridge = client;
    return client;
}
