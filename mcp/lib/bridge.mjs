/**
 * WebSocket bridge between the MCP server and running PatchToy pages
 * (src/automation/BridgeClient.js). Each connected page is a "client".
 *
 * Security (see mcp/README.md "Security"):
 *   - listens on 127.0.0.1 only;
 *   - browser handshakes must come from an allowed Origin (the app URL, the
 *     PatchToy dev servers of this repo, PATCHTOY_ALLOWED_ORIGINS); others are
 *     refused before the upgrade;
 *   - the first frame must be a hello carrying a valid token: the per-launch
 *     token of an auto-launched headless page, or the live-pairing token
 *     (see session.mjs). Anything else is closed (4401) and logged;
 *   - the welcome carries an HMAC proof of the token over the client's nonce,
 *     so pages can tell this server from another listener on the port;
 *   - frames are capped at PREAUTH_MAX_PAYLOAD until the hello authenticated
 *     (a stranger can't make the server buffer 256 MB), then MAX_PAYLOAD.
 *
 * Large results: pages split a response over CHUNK frames
 *   {type:'chunk', id, seq, last, data}  (data = consecutive slices of the JSON text)
 * and the server reassembles them, up to maxResponseChars; a bigger result fails
 * that one call with a size error (the connection stays up, nothing is retried).
 *
 * Roles (client.role, shown by get_status):
 *   'headless'    a page this server launched (per-launch token);
 *   'live'        the user's own tab (pairing token);
 *   'automation'  a page that paired with the live token but is driven by a
 *                 test / another agent: it reports navigator.webdriver, or it is
 *                 served by a private (HMR-off / PATCHTOY_DEV_ROLE=private) dev
 *                 server. Never picked in 'auto' / 'live' / 'headless' mode;
 *                 select_client {client_id} can still target it explicitly.
 * Among live tabs, those on a preferred origin (PATCHTOY_URL, then the
 * regular dev servers of this repo) win over others.
 *
 * Heartbeat: a WebSocket ping every heartbeatMs; a peer that answered none of the
 * last two pings (sleeping laptop, crashed renderer, half-open TCP) is terminated.
 */
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { log, warn } from './log.mjs';
import { tokenEquals, serverProof, createOriginPolicy, setConnectionMaxPayload, loopbackAliases } from './auth.mjs';

const AUTH_TIMEOUT_MS = 5000;
/** Largest frame accepted before a valid hello (the hello itself is < 4 KB). */
export const PREAUTH_MAX_PAYLOAD = 64 * 1024;
/** Largest frame from an authenticated page (pages chunk anything above 1 MB). */
export const MAX_PAYLOAD = 256 * 1024 * 1024;
/** Largest reassembled result (JSON characters; base64 exports are 4/3 of the file). */
export const MAX_RESPONSE_CHARS = 512 * 1024 * 1024;
const HEARTBEAT_MS = 15000;
const HIDDEN_TAB_MS = 30000;
/** Close code `ws` uses when a frame is over maxPayload. */
export const CLOSE_TOO_BIG = 1009;

export class BridgeError extends Error {
    constructor(message, data) {
        super(message);
        this.name = 'BridgeError';
        if (data !== undefined) this.data = data;
    }
}

export class BridgeClientConn {
    constructor(ws, server) {
        this.ws = ws;
        this.server = server;
        this.id = null;
        this.headless = false;
        this.token = null;
        this.visible = true;
        this.href = null;
        this.connectedAt = Date.now();
        this.lastVisibleAt = Date.now();
        this.ready = false;
        /** 'headless' (auto-launched page token) | 'live' (pairing token) once authenticated */
        this.authKind = null;
        /** 'headless' | 'live' | 'automation' once authenticated (see the file comment) */
        this.role = null;
        /** why a paired page counts as automation (webdriver, private dev server) */
        this.roleReason = null;
        this.origin = null;
        this.superseded = false;
        /** { slug, timestamp } of the project currently loaded by the agent in this page */
        this.loaded = null;
        this.pending = new Map();
        this.nextId = 1;
        /** id -> { parts: string[], chars, seq } for chunked responses being reassembled */
        this.chunks = new Map();
        /** ids whose chunked result was dropped (too large): later chunks are ignored */
        this.droppedChunks = new Set();
        this.isAlive = true;
        this.missedPongs = 0;
    }

    get label() {
        return `${this.id || '?'} (${this.role || (this.headless ? 'headless' : 'live')})`;
    }

    call(method, params = {}, timeoutMs = 60000) {
        if (this.ws.readyState !== this.ws.OPEN) {
            return Promise.reject(new BridgeError(`Browser client ${this.label} is not connected`));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new BridgeError(`Timed out after ${timeoutMs}ms waiting for the app to run "${method}"`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, method });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    _onResponse(msg) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
            const err = new BridgeError(msg.error.message || 'App error', msg.error.data);
            if (msg.error.stack) err.appStack = msg.error.stack;
            p.reject(err);
        } else {
            p.resolve(msg.result);
        }
    }

    /** A {type:'chunk'} frame of a large response. maxChars: reassembly cap. */
    _onChunk(msg, maxChars) {
        const id = msg.id;
        if (this.droppedChunks.has(id)) {
            if (msg.last) this.droppedChunks.delete(id);
            return;
        }
        const p = this.pending.get(id);
        if (!p || typeof msg.data !== 'string') { this.chunks.delete(id); return; }
        let c = this.chunks.get(id);
        if (!c) { c = { parts: [], chars: 0, seq: 0 }; this.chunks.set(id, c); }
        if (msg.seq !== c.seq) {
            this.chunks.delete(id);
            if (!msg.last) this.droppedChunks.add(id);
            this._rejectPending(id, new BridgeError(`The app's result for "${p.method}" arrived out of order (chunk ${msg.seq}, expected ${c.seq})`));
            return;
        }
        c.seq++;
        c.chars += msg.data.length;
        if (c.chars > maxChars) {
            this.chunks.delete(id);
            if (!msg.last) this.droppedChunks.add(id);
            this._rejectPending(id, new BridgeError(
                `The app's result for "${p.method}" is larger than the bridge limit (${Math.round(maxChars / 1048576)} MB of JSON, about ${Math.round(maxChars * 0.75 / 1048576)} MB of file data). Use a shorter duration, a smaller size or a lower bitrate.`,
                { too_large: true, limit_chars: maxChars }));
            return;
        }
        c.parts.push(msg.data);
        if (!msg.last) return;
        this.chunks.delete(id);
        let full;
        try { full = JSON.parse(c.parts.join('')); } catch (e) {
            this._rejectPending(id, new BridgeError(`The app's chunked result for "${p.method}" could not be decoded: ${e.message}`));
            return;
        }
        this._onResponse({ ...full, id });
    }

    _rejectPending(id, err) {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(err);
    }

    _failAll(reason, data) {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new BridgeError(reason, data));
        }
        this.pending.clear();
        this.chunks.clear();
    }

    summary() {
        return {
            id: this.id,
            mode: this.role === 'live' ? 'live' : 'headless',
            role: this.role,
            role_reason: this.roleReason || undefined,
            origin: this.origin || (this.href ? safeOrigin(this.href) : null),
            preferred_origin: this.server ? this.server.isPreferredOrigin(this) : undefined,
            visible: this.visible,
            url: redactUrl(this.href),
            connected_for_s: Math.round((Date.now() - this.connectedAt) / 1000),
            loaded_project: this.loaded?.slug || null,
        };
    }
}

function safeOrigin(href) {
    try { return new URL(href).origin; } catch { return null; }
}

/** Drop secrets (bridgeToken) from a page URL before showing or logging it. */
export function redactUrl(href) {
    if (!href) return href;
    try {
        const u = new URL(href);
        if (u.searchParams.has('bridgeToken')) u.searchParams.set('bridgeToken', '***');
        return u.href;
    } catch {
        return String(href).replace(/(bridgeToken=)[^&#]*/g, '$1***');
    }
}

export class BridgeServer extends EventEmitter {
    /**
     * originCheck: (origin) => {ok, reason} (auth.mjs createOriginPolicy); default:
     * only the exact allowedOrigins (plus loopback aliases), no "any localhost".
     * preferredOrigins: () => string[] (or an array) of origins whose live tabs win
     *   (PATCHTOY_URL first); loopback aliases match.
     * originRole: (origin) => 'dev' | 'private' | null, the role of the dev server
     *   serving that origin (private test servers' tabs count as automation).
     */
    constructor({ port = 7878, host = '127.0.0.1', agentName = 'Claude', allowedOrigins = [], allowPortFallback = true, originCheck = null,
        preferredOrigins = null, originRole = null,
        heartbeatMs = HEARTBEAT_MS, preAuthMaxPayload = PREAUTH_MAX_PAYLOAD, maxPayload = MAX_PAYLOAD, maxResponseChars = MAX_RESPONSE_CHARS } = {}) {
        super();
        this.requestedPort = port;
        this.port = null;
        this.host = host;
        this.agentName = agentName;
        this.allowedOrigins = allowedOrigins;
        this.originCheck = originCheck || createOriginPolicy({ origins: allowedOrigins });
        this.preferredOrigins = preferredOrigins || allowedOrigins.slice(0, 1);
        this.originRole = originRole;
        /** token -> kind ('headless' | 'live') */
        this.tokens = new Map();
        this._rejections = { windowStart: 0, count: 0, suppressed: 0 };
        this.allowPortFallback = allowPortFallback;
        this.portFallback = false;
        this.clients = new Set();
        this.wss = null;
        this.pingTimer = null;
        this.heartbeatMs = heartbeatMs;
        this.preAuthMaxPayload = preAuthMaxPayload;
        this.maxPayload = maxPayload;
        this.maxResponseChars = maxResponseChars;
    }

    async start() {
        try {
            await this._listen(this.requestedPort);
        } catch (err) {
            if (err.code === 'EADDRINUSE' && this.allowPortFallback && this.requestedPort !== 0) {
                warn(`Bridge port ${this.requestedPort} is in use (another PatchToy MCP server?). Using a random port: live mode in your own browser will not reach this instance.`);
                this.portFallback = true;
                await this._listen(0);
            } else {
                throw err;
            }
        }
        this.pingTimer = setInterval(() => this._heartbeat(), this.heartbeatMs);
        this.pingTimer.unref?.();
        log(`bridge listening on ws://${this.host}:${this.port}`);
        return this.port;
    }

    /** Ping every client; terminate the ones that missed two pongs in a row (dead / half-open peers). */
    _heartbeat() {
        for (const c of [...this.clients]) {
            if (c.ws.readyState !== c.ws.OPEN) continue;
            if (!c.isAlive) {
                c.missedPongs++;
                if (c.missedPongs >= 2) {
                    warn(`browser ${c.label} stopped answering pings: dropping the connection`);
                    c.deadReason = 'The browser page stopped responding (no heartbeat) and was disconnected';
                    try { c.ws.terminate(); } catch { /* ignore */ }
                    continue;
                }
            }
            c.isAlive = false;
            try { c.ws.ping(); } catch { /* ignore */ }
        }
    }

    /** Accept `token` on hello as `kind` ('headless' = auto-launched page, 'live' = paired user tab). */
    addToken(token, kind = 'live') {
        if (token) this.tokens.set(token, kind);
    }

    removeToken(token) {
        this.tokens.delete(token);
    }

    /** -> kind of a valid token, or null. Constant-time per candidate. */
    authenticate(token) {
        let kind = null;
        for (const [t, k] of this.tokens) if (tokenEquals(token, t)) kind = k;
        return kind;
    }

    /** Log a refused connection; at most 10 lines a minute so a hostile page can't flood stderr. */
    _logRejection(text) {
        const r = this._rejections;
        const now = Date.now();
        if (now - r.windowStart > 60000) {
            if (r.suppressed) warn(`(${r.suppressed} more rejected bridge connections not logged)`);
            r.windowStart = now; r.count = 0; r.suppressed = 0;
        }
        if (++r.count <= 10) warn(`rejected bridge connection: ${text}`);
        else r.suppressed++;
    }

    _listen(port) {
        return new Promise((resolve, reject) => {
            const wss = new WebSocketServer({
                host: this.host,
                port,
                // Before the hello authenticates: tiny frames only (raised per connection in _onConnection)
                maxPayload: this.preAuthMaxPayload,
                verifyClient: (info, cb) => {
                    const origin = info.origin || info.req.headers.origin;
                    const res = this.originCheck(origin);
                    if (!res.ok) {
                        this._logRejection(`${res.reason || 'origin not allowed'} (set PATCHTOY_URL or PATCHTOY_ALLOWED_ORIGINS to allow a PatchToy origin)`);
                        cb(false, 403, 'Origin not allowed');
                        return;
                    }
                    cb(true);
                },
            });
            const onError = (err) => { wss.close(); reject(err); };
            wss.once('error', onError);
            wss.once('listening', () => {
                wss.off('error', onError);
                wss.on('error', (e) => warn('bridge server error', e));
                this.wss = wss;
                this.port = wss.address().port;
                wss.on('connection', (ws, req) => this._onConnection(ws, req));
                resolve();
            });
        });
    }

    _onConnection(ws, req) {
        const client = new BridgeClientConn(ws, this);
        client.origin = req?.headers?.origin || null;
        this.clients.add(client);
        // Unauthenticated connections get AUTH_TIMEOUT_MS to send a valid hello
        const authTimer = setTimeout(() => {
            if (!client.authKind) this._rejectClient(client, 'no hello with a valid token');
        }, AUTH_TIMEOUT_MS);
        authTimer.unref?.();
        ws.on('pong', () => { client.isAlive = true; client.missedPongs = 0; });

        ws.on('message', (data) => {
            // Whatever a page sends must never throw into the process (uncaught = server exit)
            try { this._onMessage(client, ws, data, authTimer); } catch (e) { warn(`bridge: failed to handle a message from ${client.label}`, e); }
        });
        ws.on('close', (code) => this._onClose(client, code, authTimer));
        // A frame over maxPayload: ws emits this error, then closes (the close code seen here is 1006)
        ws.on('error', (e) => { if (e && e.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') client.tooBig = true; });
    }

    _onMessage(client, ws, data, authTimer) {
        client.isAlive = true;
        let msg;
        try { msg = JSON.parse(String(data)); } catch { if (!client.authKind) this._rejectClient(client, 'invalid first frame'); return; }
        if (!client.authKind) {
            clearTimeout(authTimer);
            if (!msg || msg.type !== 'hello') return this._rejectClient(client, 'the first message must be a hello with the bridge token');
            const kind = this.authenticate(msg.token);
            if (!kind) return this._rejectClient(client, msg.token ? 'wrong bridge token' : 'missing bridge token');
            client.authKind = kind;
            if (!setConnectionMaxPayload(ws, this.maxPayload)) warn('could not raise the frame limit of an authenticated connection (ws internals changed?): large results may fail');
            this._onHello(client, msg);
            return;
        }
        if (msg.type === 'chunk') {
            client._onChunk(msg, this.maxResponseChars);
        } else if (msg.type === 'hello') {
            return; // already authenticated
        } else if (msg.type === 'visibility') {
            // lastVisibleAt = the last moment the tab was visible (also when it just got hidden)
            const was = client.visible;
            client.visible = !!msg.visible;
            if (was || client.visible) client.lastVisibleAt = Date.now();
        } else if (msg.type === 'project-changed' || msg.type === 'project-detached') {
            this.emit(msg.type, client, msg);
        } else if (msg.id !== undefined) {
            client._onResponse(msg);
        }
    }

    _onClose(client, code, authTimer) {
        clearTimeout(authTimer);
        this.clients.delete(client);
        if (client.tooBig) code = CLOSE_TOO_BIG;
        if (code === CLOSE_TOO_BIG && !client.authKind) this._logRejection(`frame over ${Math.round(this.preAuthMaxPayload / 1024)} KB before authentication (origin ${client.origin || 'none'})`);
        if (code === CLOSE_TOO_BIG && client.authKind) {
            // Not a disconnect worth retrying: the same call would send the same frame again
            warn(`browser ${client.label} sent a frame over the ${Math.round(this.maxPayload / 1048576)} MB bridge limit; connection closed`);
            client._failAll(`The app's result was larger than the bridge's ${Math.round(this.maxPayload / 1048576)} MB frame limit (close code 1009). Use a shorter duration, a smaller size or a lower bitrate; reload the tab if it runs an older PatchToy (current pages split large results).`, { too_large: true });
        } else {
            client._failAll(client.deadReason || 'The browser page disconnected');
        }
        if (client.ready) log(`browser disconnected: ${client.label}`);
        // A superseded connection's id now belongs to its replacement
        if (client.ready && !client.superseded) this.emit('client-gone', client);
    }

    _rejectClient(client, why) {
        this._logRejection(`${why} (origin ${client.origin || 'none'})`);
        try { client.ws.send(JSON.stringify({ type: 'error', code: 'auth', error: `PatchToy MCP bridge: ${why}` })); } catch { /* ignore */ }
        try { client.ws.close(4401, 'unauthorized'); } catch { /* ignore */ }
        setTimeout(() => { try { client.ws.terminate(); } catch { /* ignore */ } }, 1000).unref?.();
        this.clients.delete(client);
    }

    _onHello(client, msg) {
        const raw = String(msg.clientId || '');
        client.id = /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : `client-${Math.random().toString(36).slice(2, 8)}`;
        // Only pages we launched (per-launch token) count as headless, whatever the page claims
        client.headless = client.authKind === 'headless';
        // A live-token page can only downgrade itself (to automation), never claim more
        client.role = client.headless ? 'headless' : 'live';
        if (!client.headless) {
            let serverRole = null;
            try { serverRole = client.origin && this.originRole ? this.originRole(client.origin) : null; } catch { /* ignore */ }
            if (msg.automated === true) { client.role = 'automation'; client.roleReason = 'navigator.webdriver (a browser driven by a test or an agent)'; }
            else if (serverRole === 'private' || msg.devRole === 'private') { client.role = 'automation'; client.roleReason = 'served by a private test dev server (HMR off or PATCHTOY_DEV_ROLE=private)'; }
        }
        client.token = msg.token;
        client.visible = msg.visible !== false;
        client.href = typeof msg.href === 'string' ? msg.href.slice(0, 2000) : null;
        client.ready = true;
        if (client.visible) client.lastVisibleAt = Date.now();
        // A page reconnecting after a server restart still has its project loaded
        if (msg.loaded && typeof msg.loaded.slug === 'string') client.reportedLoaded = { slug: msg.loaded.slug, timestamp: msg.loaded.timestamp ?? null };
        // Replace stale connections from the same page (same per-page-load id, authenticated)
        for (const other of this.clients) {
            if (other !== client && other.id === client.id) {
                other.superseded = true;
                other._failAll('Superseded by a new connection from the same tab');
                try { other.ws.terminate(); } catch { /* ignore */ }
                this.clients.delete(other);
            }
        }
        const welcome = { type: 'welcome', agentName: this.agentName, server: 'patchtoy-mcp' };
        if (typeof msg.nonce === 'string' && msg.nonce.length >= 16 && msg.nonce.length <= 128) welcome.proof = serverProof(msg.token, msg.nonce);
        client.ws.send(JSON.stringify(welcome));
        log(`browser connected: ${client.label} ${redactUrl(client.href) || ''}`);
        this.emit('client', client);
    }

    readyClients() {
        return [...this.clients].filter(c => c.ready && c.ws.readyState === c.ws.OPEN);
    }

    /** 0 = no preference, 1 = a regular dev server of this repo, 2 = a preferred origin (PATCHTOY_URL). */
    originRank(client) {
        const origin = client.origin || (client.href ? safeOrigin(client.href) : null);
        if (!origin) return 0;
        let preferred = [];
        try { preferred = (typeof this.preferredOrigins === 'function' ? this.preferredOrigins() : this.preferredOrigins) || []; } catch { /* ignore */ }
        for (const o of preferred) if (loopbackAliases(o).includes(origin)) return 2;
        try { if (this.originRole && this.originRole(origin) === 'dev') return 1; } catch { /* ignore */ }
        return 0;
    }

    isPreferredOrigin(client) {
        return this.originRank(client) === 2;
    }

    /**
     * Pick the client tools should talk to. Automation pages (tests, other agents) are never
     * picked by mode, only by clientId.
     * mode 'auto': the live tab on the preferred origin that was visible most recently, else
     * any live tab, else headless. 'live': live tabs only; 'headless': our launched page only.
     */
    pickClient(mode = 'auto', clientId = null) {
        const ready = this.readyClients();
        if (clientId) return ready.find(c => c.id === clientId) || null;
        const live = ready.filter(c => c.role === 'live');
        const headless = ready.filter(c => c.role === 'headless');
        const rank = new Map(live.map(c => [c, this.originRank(c)]));
        const byRecency = (a, b) => (rank.get(b) - rank.get(a)) || (Number(b.visible) - Number(a.visible)) || (b.lastVisibleAt - a.lastVisibleAt) || (b.connectedAt - a.connectedAt);
        live.sort(byRecency);
        headless.sort((a, b) => b.connectedAt - a.connectedAt);
        if (mode === 'live') return live[0] || null;
        if (mode === 'headless') return headless[0] || null;
        // A tab hidden for a while has throttled rAF (stalled probes / recordings): use headless if there is one
        if (live[0] && !live[0].visible && Date.now() - live[0].lastVisibleAt > HIDDEN_TAB_MS && headless[0]) return headless[0];
        return live[0] || headless[0] || null;
    }

    waitForClient(predicate, timeoutMs = 30000) {
        const existing = this.readyClients().find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.off('client', onClient);
                reject(new BridgeError(`No PatchToy page connected to the bridge within ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            const onClient = (c) => {
                if (predicate(c)) {
                    clearTimeout(timer);
                    this.off('client', onClient);
                    resolve(c);
                }
            };
            this.on('client', onClient);
        });
    }

    async close() {
        clearInterval(this.pingTimer);
        for (const c of this.clients) {
            c._failAll('Bridge shutting down');
            try { c.ws.terminate(); } catch { /* ignore */ }
        }
        this.clients.clear();
        if (this.wss) await new Promise(r => this.wss.close(() => r()));
        this.wss = null;
    }
}
