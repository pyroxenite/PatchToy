/**
 * PatchToy I/O bridge: lets the browser app talk to OSC (UDP), serial devices
 * and Art-Net / DMX through a small local Node process, since pages cannot
 * open UDP sockets or (portably) serial ports. Run it with `npm run io-bridge`
 * (scripts/io-bridge.mjs); the app side is src/io/IOClient.js.
 *
 * Security model (see README "Connecting hardware & other apps"):
 *   - the WebSocket listens on 127.0.0.1 only (never on the network); the Host
 *     header must name the loopback interface (DNS-rebinding guard) and browser
 *     Origins must pass the same policy as the MCP bridge (mcp/lib/auth.mjs
 *     createOriginPolicy): the app URL (PATCHTOY_URL / --app), the PatchToy Vite
 *     dev servers running from this repo, and origins given with --origin;
 *     not "any localhost page";
 *   - every connection must authenticate first with the per-run token printed
 *     at start (constant-time compare, 5 s deadline, lock-out after repeated
 *     failures);
 *   - nothing is sent, listened to or opened until the app reports the user's
 *     explicit opt-in for this session (config.optIn);
 *   - outbound UDP (OSC Out, Art-Net) only goes to destinations in the
 *     allowlist the user configured in the app (config.allow, "host:port"),
 *     serial ports only open when the user picked them (config.serial);
 *   - OSC In listens on 127.0.0.1 unless the user enabled LAN input (config.lan);
 *   - payload (64 KB until the hello authenticated, then 1 MB), rate, socket and
 *     port limits per connection.
 *
 * Protocol (JSON text frames):
 *   app -> bridge  {type:'hello', token, client, protocol}            (first frame)
 *   bridge -> app  {type:'welcome', bridge, protocol, session, features} | {type:'error', code:'auth'} + close 4401
 *   app -> bridge  {type:'config', optIn, allow:[...], serial:[...], lan}
 *   bridge -> app  {type:'config', optIn, allow, invalid, serial, lan}
 *   app -> bridge  {id?, op, ...}   ops: status, osc.listen {port}, osc.unlisten {port},
 *                  osc.send {host, port, address, args, types} | {host, port, bundle:[...]},
 *                  serial.list, serial.open {path, baudRate, mode 'lines'|'bytes'},
 *                  serial.close {path}, serial.write {path, text | bytes},
 *                  artnet.send {host, port?, universe, data:[0..255]}
 *   bridge -> app  {id, ok:true, result} | {id, ok:false, code, error}   (requests with an id)
 *   bridge -> app  {type:'osc', port, from, messages:[{address, types, args}]}
 *                  {type:'serial', path, line} | {type:'serial', path, bytes}
 *                  {type:'listen-status', port, listening, bind, error?}
 *                  {type:'serial-status', path, open, error?}
 *                  {type:'error', op, code, error, dest?}               (fire-and-forget failures, throttled)
 */
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOriginPolicy, registeredDevOrigins, setConnectionMaxPayload } from './auth.mjs';
import { encodeMessage, encodeBundle, decodePacket, flattenPacket } from './osc.mjs';
import { normalizeAllowlist, isAllowed, destKey, isSerialPath, isOscAddress } from '../../src/io/allowlist.mjs';

export const IO_BRIDGE_DEFAULT_PORT = 7879;
export const IO_PROTOCOL = 1;
const HOST = '127.0.0.1';
const MAX_PAYLOAD = 1024 * 1024;
const PREAUTH_MAX_PAYLOAD = 64 * 1024;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_APP_URL = 'http://localhost:5173/';
const HELLO_TIMEOUT_MS = 5000;
const MAX_CLIENTS = 8;
const MAX_LISTENS = 16;
const MAX_SERIAL = 8;
const SEND_RATE = 4000;          // outbound messages / s per connection
const RECV_RATE = 5000;          // inbound OSC messages / s per listening port
const ARTNET_PORT = 6454;
const MOCK_LOOPBACK = '/dev/mock-loopback';
const MOCK_SENSOR = '/dev/mock-sensor';

export class IOBridgeError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function isLoopbackHostHeader(host, port) {
    if (!host) return false;
    const h = String(host).toLowerCase();
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function makeToken() {
    return crypto.randomBytes(18).toString('base64url'); // 144 bits
}

class Bucket {
    constructor(rate) { this.rate = rate; this.tokens = rate; this.t = Date.now(); }
    take(n = 1) {
        const now = Date.now();
        this.tokens = Math.min(this.rate, this.tokens + (now - this.t) * this.rate / 1000);
        this.t = now;
        if (this.tokens < n) return false;
        this.tokens -= n;
        return true;
    }
}

export class IOBridge extends EventEmitter {
    /**
     * opts: port (default 7879, 0 = random), token (default random),
     * appUrl (the PatchToy URL whose origin may connect; default PATCHTOY_URL or http://localhost:5173/),
     * allowedOrigins [] (extra exact origins, --origin), repoRoot (whose registered Vite dev servers
     * may connect; default this repo), originCheck (replaces the policy, for tests),
     * serial 'auto' | 'off', mockSerial (adds /dev/mock-loopback + /dev/mock-sensor),
     * logger ({ log, warn }), verbose (log every message)
     */
    constructor({ port = IO_BRIDGE_DEFAULT_PORT, token = null, appUrl = null, allowedOrigins = [], repoRoot = REPO_ROOT, originCheck = null, serial = 'auto', mockSerial = false, logger = null, verbose = false } = {}) {
        super();
        this.requestedPort = port;
        this.port = null;
        this.token = token || makeToken();
        this.sessionId = crypto.randomBytes(6).toString('hex');
        this.allowedOrigins = allowedOrigins;
        this.appUrl = appUrl || process.env.PATCHTOY_URL || DEFAULT_APP_URL;
        // Same Origin policy as the MCP bridge: exact origins (loopback ones also under their
        // localhost / 127.0.0.1 / [::1] aliases) and this repo's running dev servers. Clients
        // without an Origin header are not browsers (scripts, tests): they still need the token.
        this.originCheck = originCheck || createOriginPolicy({
            origins: [this.appUrl, ...allowedOrigins],
            dynamic: () => registeredDevOrigins(repoRoot),
        });
        this.serialMode = serial;
        this.mockSerial = !!mockSerial;
        this.verbose = !!verbose;
        this.logger = logger || { log: (...a) => console.log(...a), warn: (...a) => console.warn(...a) };
        this.wss = null;
        this.conns = new Set();
        this.listens = new Map();   // port -> { socket, bind, subs:Set(conn), listening, error, bucket, dropped }
        this.serials = new Map();   // path -> { port, subs:Set(conn), baudRate, mode, open, error, mock, timer }
        this.out4 = null;
        this.out6 = null;
        this.dnsCache = new Map();
        this.artSeq = new Map();
        this.authFailures = [];
        this.lockedUntil = 0;
        this.serialLib = null;
        this.serialError = null;
        this.stats = { connections: 0, authFailures: 0, oscOut: 0, oscIn: 0, serialOut: 0, serialIn: 0, artnetOut: 0, dropped: 0 };
    }

    log(msg) { this.logger.log(`[io-bridge] ${msg}`); }
    warn(msg) { this.logger.warn(`[io-bridge] ${msg}`); }

    // ------------------------------------------------------------------ lifecycle

    async start() {
        await this._loadSerial();
        await new Promise((resolve, reject) => {
            const wss = new WebSocketServer({
                host: HOST,
                port: this.requestedPort,
                // Until the hello authenticated (raised to MAX_PAYLOAD in _hello)
                maxPayload: PREAUTH_MAX_PAYLOAD,
                verifyClient: (info) => {
                    const origin = info.origin || info.req.headers.origin;
                    const res = this.originCheck(origin);
                    if (!res.ok) {
                        this.warn(`rejected connection: ${res.reason || `origin ${origin} not allowed`} (use --app or --origin to allow a PatchToy origin)`);
                        return false;
                    }
                    if (!isLoopbackHostHeader(info.req.headers.host, this.port)) {
                        this.warn(`rejected connection with Host header ${info.req.headers.host}`);
                        return false;
                    }
                    if (this.conns.size >= MAX_CLIENTS) {
                        this.warn('rejected connection: too many clients');
                        return false;
                    }
                    return true;
                },
            });
            const onError = (err) => { wss.close(); reject(err); };
            wss.once('error', onError);
            wss.once('listening', () => {
                wss.off('error', onError);
                wss.on('error', (e) => this.warn(`server error: ${e.message}`));
                this.wss = wss;
                this.port = wss.address().port;
                wss.on('connection', (ws, req) => this._onConnection(ws, req));
                resolve();
            });
        });
        return this.port;
    }

    async close() {
        for (const c of this.conns) { try { c.ws.terminate(); } catch { /* ignore */ } }
        this.conns.clear();
        for (const [port] of this.listens) this._closeListen(port);
        for (const [path] of this.serials) this._closeSerial(path);
        for (const s of [this.out4, this.out6]) if (s) try { s.close(); } catch { /* ignore */ }
        this.out4 = this.out6 = null;
        if (this.wss) await new Promise(r => this.wss.close(() => r()));
        this.wss = null;
    }

    /** App URL that pairs automatically (?ioToken=...). */
    pairingUrl(appUrl = 'http://localhost:5173/') {
        const u = new URL(appUrl);
        u.searchParams.set('ioToken', this.token);
        if (this.port !== IO_BRIDGE_DEFAULT_PORT) u.searchParams.set('ioPort', String(this.port));
        return u.toString();
    }

    features() {
        return {
            osc: true,
            artnet: true,
            serial: !!this.serialLib,
            serialMock: !!(this.serialLib && this.mockSerial),
            serialError: this.serialLib ? undefined : (this.serialError || undefined),
        };
    }

    async _loadSerial() {
        if (this.serialMode === 'off') { this.serialError = 'serial disabled (--no-serial)'; return; }
        try {
            const mod = await import('serialport');
            this.serialLib = mod;
            if (this.mockSerial) {
                mod.SerialPortMock.binding.reset();
                mod.SerialPortMock.binding.createPort(MOCK_LOOPBACK, { echo: true, record: false, manufacturer: 'PatchToy mock (echo)' });
                mod.SerialPortMock.binding.createPort(MOCK_SENSOR, { echo: false, record: false, manufacturer: 'PatchToy mock (sensor)' });
            }
        } catch (e) {
            this.serialLib = null;
            this.serialError = `serialport package not available (${e.code || e.message}): npm install serialport`;
        }
    }

    // ------------------------------------------------------------------ connections

    _onConnection(ws, req) {
        const conn = {
            ws,
            id: crypto.randomBytes(3).toString('hex'),
            origin: req.headers.origin || '(no origin)',
            authed: false,
            optIn: false,
            allow: [],
            serialAllow: new Set(),
            lan: false,
            listens: new Set(),
            serials: new Set(),
            bucket: new Bucket(SEND_RATE),
            errorsAt: new Map(),
            sent: 0,
            dropped: 0,
        };
        this.conns.add(conn);
        conn.helloTimer = setTimeout(() => {
            if (!conn.authed) {
                this._send(conn, { type: 'error', code: 'auth', error: 'no hello with a token within 5 s' });
                try { ws.close(4401, 'auth timeout'); } catch { /* ignore */ }
            }
        }, HELLO_TIMEOUT_MS);
        conn.helloTimer.unref?.();

        ws.on('message', (data, isBinary) => {
            if (isBinary) { try { ws.close(4400, 'binary frames not supported'); } catch { /* ignore */ } return; }
            let msg;
            try { msg = JSON.parse(String(data)); } catch { return; }
            if (!msg || typeof msg !== 'object') return;
            if (!conn.authed) { this._hello(conn, msg); return; }
            this._onMessage(conn, msg).catch(e => this.warn(`handler failed: ${e.message}`));
        });
        ws.on('close', () => this._onClose(conn));
        ws.on('error', () => { /* close follows */ });
    }

    _hello(conn, msg) {
        const now = Date.now();
        const reject = (why) => {
            this.stats.authFailures++;
            this.authFailures.push(now);
            this.authFailures = this.authFailures.filter(t => now - t < 10000);
            if (this.authFailures.length >= 5) {
                this.lockedUntil = now + 10000;
                this.warn('5 failed pairing attempts in 10 s: refusing connections for 10 s');
            }
            this.warn(`rejected connection ${conn.id} from ${conn.origin}: ${why}`);
            this._send(conn, { type: 'error', code: 'auth', error: why });
            try { conn.ws.close(4401, 'unauthorized'); } catch { /* ignore */ }
        };
        if (now < this.lockedUntil) return reject('too many failed attempts, try again in a few seconds');
        if (msg.type !== 'hello' || typeof msg.token !== 'string') return reject('the first message must be a hello with the pairing token');
        if (!crypto.timingSafeEqual(sha(msg.token), sha(this.token))) return reject('wrong pairing token (it changes every time the bridge starts)');
        clearTimeout(conn.helloTimer);
        conn.authed = true;
        if (!setConnectionMaxPayload(conn.ws, MAX_PAYLOAD)) this.warn('could not raise the frame limit after pairing (ws internals changed?)');
        this.stats.connections++;
        this.log(`app paired: connection ${conn.id} from ${conn.origin}`);
        this._send(conn, { type: 'welcome', bridge: 'patchtoy-io', protocol: IO_PROTOCOL, session: this.sessionId, features: this.features() });
        this.emit('connection', conn);
    }

    _onClose(conn) {
        clearTimeout(conn.helloTimer);
        this.conns.delete(conn);
        for (const port of [...conn.listens]) this._unsubscribeListen(conn, port);
        for (const path of [...conn.serials]) this._unsubscribeSerial(conn, path);
        if (conn.authed) this.log(`app disconnected: connection ${conn.id}`);
    }

    _send(conn, msg) {
        if (conn.ws.readyState !== conn.ws.OPEN) return false;
        try { conn.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
    }

    _reportError(conn, op, err, dest) {
        // Throttled: one report per op / destination per second
        const key = `${op}|${dest || ''}|${err.code}`;
        const now = Date.now();
        if (now - (conn.errorsAt.get(key) || 0) < 1000) return;
        conn.errorsAt.set(key, now);
        this._send(conn, { type: 'error', op, code: err.code || 'io', error: err.message, dest });
    }

    _applyConfig(conn, msg) {
        const before = { optIn: conn.optIn, allow: conn.allow.map(e => e.text).join(', '), serial: [...conn.serialAllow].join(', '), lan: conn.lan };
        if (msg.optIn !== undefined) conn.optIn = msg.optIn === true;
        let invalid = [];
        if (msg.allow !== undefined) {
            const n = normalizeAllowlist(Array.isArray(msg.allow) ? msg.allow.slice(0, 256) : []);
            conn.allow = n.entries;
            invalid = n.invalid;
        }
        if (msg.serial !== undefined) conn.serialAllow = new Set((Array.isArray(msg.serial) ? msg.serial : []).slice(0, 64).map(String).filter(p => isSerialPath(p) || this._isMock(p)));
        if (msg.lan !== undefined) conn.lan = msg.lan === true;
        const after = { optIn: conn.optIn, allow: conn.allow.map(e => e.text).join(', '), serial: [...conn.serialAllow].join(', '), lan: conn.lan };
        if (before.optIn !== after.optIn) this.log(`connection ${conn.id}: I/O ${conn.optIn ? 'ENABLED by the user' : 'disabled'}`);
        if (before.allow !== after.allow) this.log(`connection ${conn.id}: allowed destinations: ${after.allow || '(none)'}`);
        if (before.serial !== after.serial) this.log(`connection ${conn.id}: allowed serial ports: ${after.serial || '(none)'}`);
        if (before.lan !== after.lan) this.log(`connection ${conn.id}: OSC input from the LAN ${conn.lan ? 'allowed (listens on 0.0.0.0)' : 'off (127.0.0.1 only)'}`);
        if (!conn.optIn) {
            for (const port of [...conn.listens]) this._unsubscribeListen(conn, port);
            for (const path of [...conn.serials]) this._unsubscribeSerial(conn, path);
        } else {
            for (const path of [...conn.serials]) if (!conn.serialAllow.has(path)) this._unsubscribeSerial(conn, path);
            if (before.lan !== after.lan) {
                // Rebind this connection's listening sockets on the new interface
                for (const port of [...conn.listens]) {
                    this._unsubscribeListen(conn, port);
                    this._listen(conn, port);
                }
            }
        }
        this._send(conn, { type: 'config', optIn: conn.optIn, allow: conn.allow.map(e => e.text), invalid, serial: [...conn.serialAllow], lan: conn.lan });
    }

    async _onMessage(conn, msg) {
        if (msg.type === 'config') return this._applyConfig(conn, msg);
        if (msg.type === 'ping') return this._send(conn, { type: 'pong', t: msg.t });
        if (typeof msg.op !== 'string') return;
        const reply = msg.id !== undefined && msg.id !== null;
        try {
            const result = await this._op(conn, msg);
            if (reply) this._send(conn, { id: msg.id, ok: true, result: result === undefined ? null : result });
        } catch (e) {
            const err = e instanceof IOBridgeError ? e : new IOBridgeError('io', e.message || String(e));
            if (reply) this._send(conn, { id: msg.id, ok: false, code: err.code, error: err.message });
            else this._reportError(conn, msg.op, err, msg.host ? destKey(msg.host, msg.port || ARTNET_PORT) : msg.path);
            if (this.verbose) this.warn(`${msg.op} failed: ${err.message}`);
        }
    }

    _needOptIn(conn) {
        if (!conn.optIn) throw new IOBridgeError('opt-in', 'I/O is not enabled in the app for this session (Output > I/O > Enable)');
    }

    _checkDest(conn, host, port) {
        if (typeof host !== 'string' || !host.trim()) throw new IOBridgeError('bad-request', 'host missing');
        const p = Number(port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw new IOBridgeError('bad-request', `bad port ${port}`);
        if (!isAllowed(conn.allow, host, p)) throw new IOBridgeError('not-allowed', `${destKey(host, p)} is not in the allowed destinations (Output > I/O)`);
        return p;
    }

    async _op(conn, msg) {
        switch (msg.op) {
            case 'status': return this.status(conn);
            case 'osc.listen': this._needOptIn(conn); return this._listen(conn, msg.port);
            case 'osc.unlisten': this._unsubscribeListen(conn, Number(msg.port)); return { port: Number(msg.port), listening: false };
            case 'osc.send': return this._oscSend(conn, msg);
            case 'artnet.send': return this._artnetSend(conn, msg);
            case 'serial.list': return this._serialList();
            case 'serial.open': this._needOptIn(conn); return this._serialOpen(conn, msg);
            case 'serial.close': this._unsubscribeSerial(conn, String(msg.path)); return { path: String(msg.path), open: false };
            case 'serial.write': return this._serialWrite(conn, msg);
            default: throw new IOBridgeError('bad-request', `unknown op ${msg.op}`);
        }
    }

    status(conn = null) {
        const out = {
            bridge: 'patchtoy-io',
            protocol: IO_PROTOCOL,
            session: this.sessionId,
            port: this.port,
            features: this.features(),
            clients: [...this.conns].filter(c => c.authed).length,
            listening: [...this.listens.entries()].map(([port, l]) => ({ port, bind: l.bind, listening: l.listening, error: l.error || undefined, subscribers: l.subs.size })),
            serial: [...this.serials.entries()].map(([path, s]) => ({ path, open: s.open, baudRate: s.baudRate, mode: s.mode, error: s.error || undefined })),
            stats: { ...this.stats },
        };
        if (conn) out.connection = { id: conn.id, optIn: conn.optIn, allow: conn.allow.map(e => e.text), serial: [...conn.serialAllow], lan: conn.lan, sent: conn.sent, dropped: conn.dropped };
        return out;
    }

    // ------------------------------------------------------------------ UDP out

    _outSocket(family) {
        const key = family === 6 ? 'out6' : 'out4';
        if (this[key]) return this[key];
        const s = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
        s.on('error', (e) => this.warn(`udp send socket: ${e.message}`));
        s.on('message', () => { /* replies are ignored */ });
        s.bind(0, () => { try { s.setBroadcast(true); } catch { /* ignore */ } });
        this[key] = s;
        return s;
    }

    async _resolve(host) {
        const h = String(host).trim().replace(/^\[|\]$/g, '');
        if (h.toLowerCase() === 'localhost') return { address: '127.0.0.1', family: 4 };
        const fam = net.isIP(h);
        if (fam) return { address: h, family: fam };
        const hit = this.dnsCache.get(h);
        if (hit && Date.now() - hit.t < 60000) return hit.r;
        const r = await dns.lookup(h);
        this.dnsCache.set(h, { t: Date.now(), r });
        return r;
    }

    async _udpSend(conn, host, port, buf) {
        if (!conn.bucket.take()) {
            conn.dropped++;
            this.stats.dropped++;
            throw new IOBridgeError('rate', `more than ${SEND_RATE} messages / s: dropped`);
        }
        const r = await this._resolve(host);
        const sock = this._outSocket(r.family);
        await new Promise((resolve, reject) => sock.send(buf, port, r.address, (err) => (err ? reject(new IOBridgeError('io', err.message)) : resolve())));
        conn.sent++;
    }

    async _oscSend(conn, msg) {
        this._needOptIn(conn);
        const port = this._checkDest(conn, msg.host, msg.port);
        let buf;
        try {
            const addrs = Array.isArray(msg.bundle) ? msg.bundle.map(e => e && e.address) : [msg.address];
            if (!addrs.length || !addrs.every(isOscAddress)) throw new Error('OSC addresses must start with / and contain no spaces or control characters');
            if (Array.isArray(msg.bundle)) buf = encodeBundle(msg.bundle.slice(0, 256).map(e => ({ address: e.address, args: e.args, types: e.types })), msg.timetag);
            else buf = encodeMessage(msg.address, Array.isArray(msg.args) ? msg.args.slice(0, 512) : [], typeof msg.types === 'string' ? msg.types : null);
        } catch (e) {
            throw new IOBridgeError('bad-request', e.message);
        }
        if (buf.length > 65000) throw new IOBridgeError('bad-request', 'OSC packet too large for UDP');
        await this._udpSend(conn, msg.host, port, buf);
        this.stats.oscOut++;
        if (this.verbose) this.log(`osc -> ${destKey(msg.host, port)} ${msg.address || '#bundle'} ${JSON.stringify(msg.args || '')}`);
        return { bytes: buf.length };
    }

    async _artnetSend(conn, msg) {
        this._needOptIn(conn);
        const port = this._checkDest(conn, msg.host, msg.port === undefined ? ARTNET_PORT : msg.port);
        const universe = Number(msg.universe) | 0;
        if (universe < 0 || universe > 32767) throw new IOBridgeError('bad-request', 'universe must be 0..32767');
        const data = Array.isArray(msg.data) ? msg.data.slice(0, 512) : [];
        let len = Math.max(2, data.length);
        if (len % 2) len++;
        const buf = Buffer.alloc(18 + len);
        buf.write('Art-Net\0', 0, 'latin1');
        buf.writeUInt16LE(0x5000, 8);          // OpDmx
        buf.writeUInt16BE(14, 10);             // protocol version
        const key = `${destKey(msg.host, port)}/${universe}`;
        const seq = ((this.artSeq.get(key) || 0) % 255) + 1;
        this.artSeq.set(key, seq);
        buf[12] = seq;
        buf[13] = 0;                           // physical
        buf[14] = universe & 0xff;             // SubUni
        buf[15] = (universe >> 8) & 0x7f;      // Net
        buf.writeUInt16BE(len, 16);
        for (let i = 0; i < data.length; i++) buf[18 + i] = Math.max(0, Math.min(255, Math.round(Number(data[i]) || 0)));
        await this._udpSend(conn, msg.host, port, buf);
        this.stats.artnetOut++;
        return { bytes: buf.length, sequence: seq };
    }

    // ------------------------------------------------------------------ UDP in (OSC)

    _listen(conn, rawPort) {
        const port = Number(rawPort);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new IOBridgeError('bad-request', `OSC In port must be 1024..65535 (got ${rawPort})`);
        if (!conn.listens.has(port) && conn.listens.size >= MAX_LISTENS) throw new IOBridgeError('limit', `at most ${MAX_LISTENS} OSC In ports per app`);
        const bind = conn.lan ? '0.0.0.0' : HOST;
        let l = this.listens.get(port);
        if (l && l.bind !== bind && bind === '0.0.0.0') {
            // LAN requested: rebind the shared socket on all interfaces
            const subs = l.subs;
            this._closeListen(port, false);
            l = null;
            this._openListen(port, bind, subs);
            l = this.listens.get(port);
        }
        if (!l) {
            this._openListen(port, bind, new Set());
            l = this.listens.get(port);
        }
        l.subs.add(conn);
        conn.listens.add(port);
        if (l.listening || l.error) this._send(conn, { type: 'listen-status', port, listening: l.listening, bind: l.bind, error: l.error || undefined });
        return { port, bind: l.bind, listening: l.listening, error: l.error || undefined };
    }

    _openListen(port, bind, subs) {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
        const l = { socket, bind, subs, listening: false, error: null, bucket: new Bucket(RECV_RATE), dropped: 0 };
        this.listens.set(port, l);
        const notify = () => { for (const c of l.subs) this._send(c, { type: 'listen-status', port, listening: l.listening, bind: l.bind, error: l.error || undefined }); };
        socket.on('error', (e) => {
            l.error = e.code === 'EADDRINUSE' ? `port ${port} is already in use (another app listening?)` : e.message;
            l.listening = false;
            this.warn(`OSC In :${port}: ${l.error}`);
            notify();
            try { socket.close(); } catch { /* ignore */ }
        });
        socket.on('listening', () => {
            l.listening = true;
            l.error = null;
            this.log(`OSC In listening on udp ${bind}:${port}`);
            notify();
        });
        socket.on('message', (buf, rinfo) => this._onOsc(port, l, buf, rinfo));
        socket.bind(port, bind);
    }

    _onOsc(port, l, buf, rinfo) {
        let messages;
        try {
            messages = flattenPacket(decodePacket(buf));
        } catch (e) {
            if (this.verbose) this.warn(`bad OSC packet on :${port} from ${rinfo.address}: ${e.message}`);
            return;
        }
        if (!messages.length) return;
        if (!l.bucket.take(messages.length)) { l.dropped += messages.length; this.stats.dropped += messages.length; return; }
        this.stats.oscIn += messages.length;
        const from = `${rinfo.address}:${rinfo.port}`;
        if (this.verbose) this.log(`osc <- ${from} :${port} ${messages.map(m => `${m.address} ${JSON.stringify(m.args)}`).join(' | ')}`);
        for (const c of l.subs) if (c.optIn) this._send(c, { type: 'osc', port, from, messages });
    }

    _unsubscribeListen(conn, port) {
        conn.listens.delete(port);
        const l = this.listens.get(port);
        if (!l) return;
        l.subs.delete(conn);
        if (!l.subs.size) this._closeListen(port);
    }

    _closeListen(port, log = true) {
        const l = this.listens.get(port);
        if (!l) return;
        this.listens.delete(port);
        try { l.socket.close(); } catch { /* already closed */ }
        if (log && l.listening) this.log(`OSC In :${port} closed`);
    }

    // ------------------------------------------------------------------ serial

    _needSerial() {
        if (!this.serialLib) throw new IOBridgeError('unavailable', this.serialError || 'serial is not available');
    }

    _isMock(path) {
        return this.mockSerial && (path === MOCK_LOOPBACK || path === MOCK_SENSOR);
    }

    async _serialList() {
        this._needSerial();
        const { SerialPort, SerialPortMock } = this.serialLib;
        let ports = [];
        try { ports = await SerialPort.list(); } catch (e) { this.warn(`serial list failed: ${e.message}`); }
        const out = ports.map(p => ({ path: p.path, manufacturer: p.manufacturer || undefined, serialNumber: p.serialNumber || undefined, vendorId: p.vendorId || undefined, productId: p.productId || undefined }));
        if (this.mockSerial) {
            for (const p of await SerialPortMock.list()) out.push({ path: p.path, manufacturer: p.manufacturer, mock: true });
        }
        return { ports: out };
    }

    _serialOpen(conn, msg) {
        this._needSerial();
        const path = String(msg.path || '');
        if (!path) throw new IOBridgeError('bad-request', 'serial port path missing');
        if (!isSerialPath(path) && !this._isMock(path)) throw new IOBridgeError('bad-request', `not a serial device name: ${path.slice(0, 80)}`);
        if (!conn.serialAllow.has(path)) throw new IOBridgeError('not-allowed', `serial port ${path} was not picked in Output > I/O`);
        const baudRate = Number(msg.baudRate) || 115200;
        if (![300, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 31250, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000].includes(baudRate)) {
            throw new IOBridgeError('bad-request', `unsupported baud rate ${baudRate}`);
        }
        const mode = msg.mode === 'bytes' ? 'bytes' : 'lines';
        let s = this.serials.get(path);
        if (s && (s.baudRate !== baudRate || s.mode !== mode) && s.subs.size <= (s.subs.has(conn) ? 1 : 0)) {
            this._closeSerial(path);
            s = null;
        }
        if (!s) {
            if (conn.serials.size >= MAX_SERIAL) throw new IOBridgeError('limit', `at most ${MAX_SERIAL} serial ports`);
            s = this._openSerial(path, baudRate, mode);
        }
        s.subs.add(conn);
        conn.serials.add(path);
        if (s.open || s.error) this._send(conn, { type: 'serial-status', path, open: s.open, error: s.error || undefined, baudRate: s.baudRate });
        return { path, open: s.open, baudRate: s.baudRate, mode: s.mode, error: s.error || undefined };
    }

    _openSerial(path, baudRate, mode) {
        const { SerialPort, SerialPortMock, ReadlineParser } = this.serialLib;
        const mock = this._isMock(path);
        const Ctor = mock ? SerialPortMock : SerialPort;
        const s = { port: null, subs: new Set(), baudRate, mode, open: false, error: null, mock, timer: null };
        this.serials.set(path, s);
        const notify = () => { for (const c of s.subs) this._send(c, { type: 'serial-status', path, open: s.open, error: s.error || undefined, baudRate }); };
        const port = new Ctor({ path, baudRate, autoOpen: false });
        s.port = port;
        const emit = (msg) => { for (const c of s.subs) if (c.optIn) this._send(c, msg); };
        if (mode === 'lines') {
            const parser = port.pipe(new ReadlineParser({ delimiter: '\n', includeDelimiter: false }));
            parser.on('data', (line) => {
                this.stats.serialIn++;
                emit({ type: 'serial', path, line: String(line).replace(/\r$/, '').slice(0, 4096) });
            });
        } else {
            port.on('data', (chunk) => {
                this.stats.serialIn++;
                emit({ type: 'serial', path, bytes: Array.from(chunk.subarray(0, 4096)) });
            });
        }
        port.on('error', (e) => { s.error = e.message; notify(); });
        port.on('close', () => { s.open = false; if (s.timer) clearInterval(s.timer); notify(); });
        port.open((err) => {
            if (err) {
                s.error = err.message;
                this.warn(`serial ${path}: ${err.message}`);
            } else {
                s.open = true;
                s.error = null;
                this.log(`serial ${path} open at ${baudRate} baud (${mode})`);
                if (mock && path === MOCK_SENSOR) {
                    // A pretend Arduino: "a,b,c" lines at 20 Hz (two sines and a counter)
                    let n = 0;
                    s.timer = setInterval(() => {
                        n++;
                        const t = n / 20;
                        const a = Math.round(512 + 511 * Math.sin(t * 2));
                        const b = Math.round(512 + 511 * Math.cos(t * 0.7));
                        try { port.port.emitData(Buffer.from(`${a},${b},${n}\r\n`)); } catch { /* closed */ }
                    }, 50);
                    s.timer.unref?.();
                }
            }
            notify();
        });
        return s;
    }

    async _serialWrite(conn, msg) {
        this._needOptIn(conn);
        this._needSerial();
        const path = String(msg.path || '');
        const s = this.serials.get(path);
        if (!s || !conn.serials.has(path)) throw new IOBridgeError('bad-request', `serial port ${path} is not open (it opens when a Serial node uses it)`);
        if (!s.open) throw new IOBridgeError('io', s.error || `serial port ${path} is not open yet`);
        if (!conn.bucket.take()) { conn.dropped++; throw new IOBridgeError('rate', 'serial write rate limit'); }
        let data;
        if (Array.isArray(msg.bytes)) data = Buffer.from(msg.bytes.slice(0, 4096).map(v => Math.max(0, Math.min(255, Number(v) | 0))));
        else data = Buffer.from(String(msg.text ?? '').slice(0, 4096), 'utf8');
        await new Promise((resolve, reject) => s.port.write(data, (err) => (err ? reject(new IOBridgeError('io', err.message)) : resolve())));
        conn.sent++;
        this.stats.serialOut++;
        return { bytes: data.length };
    }

    _unsubscribeSerial(conn, path) {
        conn.serials.delete(path);
        const s = this.serials.get(path);
        if (!s) return;
        s.subs.delete(conn);
        if (!s.subs.size) this._closeSerial(path);
    }

    _closeSerial(path) {
        const s = this.serials.get(path);
        if (!s) return;
        this.serials.delete(path);
        if (s.timer) clearInterval(s.timer);
        try { if (s.port && s.port.isOpen) s.port.close(); } catch { /* ignore */ }
        this.log(`serial ${path} closed`);
    }
}
