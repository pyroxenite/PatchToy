/**
 * IOClient - the app side of the PatchToy I/O bridge (mcp/lib/io-bridge.mjs,
 * `npm run io-bridge`): OSC in/out, serial and Art-Net through a local Node
 * process, because pages cannot open UDP sockets. Used by the I/O nodes
 * (src/core/library/io.js) and the Output > I/O panel (src/io/IOPanel.js).
 *
 * Security (see README "Connecting hardware & other apps"):
 *   - pairing token: pasted in the panel or passed once as ?ioToken= (removed from
 *     the address bar right away); stored in localStorage, it changes every time the
 *     bridge starts;
 *   - opt-in: nothing is sent, listened to or opened before the user enables I/O for
 *     this tab session (sessionStorage, so a reload keeps it, a new tab asks again);
 *   - allowlist: outbound destinations (host:port) and serial ports are the user's,
 *     kept in localStorage and never in project files. A project asking for another
 *     destination is listed in the panel as "requested" with an Allow button.
 *     The bridge enforces opt-in and allowlist again on its side.
 *
 * Importable in Node (scripts/check-definitions.mjs): no browser access at import
 * time beyond the guarded ?ioToken capture.
 */
import { normalizeAllowlist, isAllowed, destKey, parseAllowEntry, isSerialPath } from './allowlist.mjs';

export const IO_DEFAULT_PORT = 7879;
const LS_TOKEN = 'patchtoy_io_token';
const LS_PORT = 'patchtoy_io_port';
const LS_ALLOW = 'patchtoy_io_allow';
const LS_SERIAL = 'patchtoy_io_serial';
const LS_LAN = 'patchtoy_io_lan';
const SS_OPTIN = 'patchtoy_io_optin';
const WANT_TTL_MS = 1500;      // a port no node asked for in this long is released
const BUFFER = 256;            // messages kept per port

const hasWindow = typeof window !== 'undefined' && typeof document !== 'undefined';

function lsGet(k, fallback = null) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch (e) { return fallback; }
}
function lsSet(k, v) {
    try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch (e) { /* ignore */ }
}
function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function ssSet(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }
const jsonList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch (e) { return []; } };

let pairedFromUrl = false;
/** ?ioToken= / ?ioPort= in the address: store them and remove them from the URL. */
function captureUrlToken() {
    if (!hasWindow || typeof location === 'undefined') return;
    try {
        const u = new URL(location.href);
        const t = u.searchParams.get('ioToken');
        const p = u.searchParams.get('ioPort');
        if (!t && !p) return;
        if (t) lsSet(LS_TOKEN, t.trim());
        if (p && /^\d{1,5}$/.test(p)) lsSet(LS_PORT, p);
        u.searchParams.delete('ioToken');
        u.searchParams.delete('ioPort');
        history.replaceState(history.state, '', u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '') + u.hash);
        pairedFromUrl = !!t;
    } catch (e) { /* ignore */ }
}
captureUrlToken();

export class IOClient {
    constructor() {
        this.available = hasWindow && typeof WebSocket !== 'undefined';
        this.port = Number(lsGet(LS_PORT)) || IO_DEFAULT_PORT;
        this.token = lsGet(LS_TOKEN) || null;
        this.allow = jsonList(lsGet(LS_ALLOW));
        this._allowParsed = normalizeAllowlist(this.allow).entries;
        this.serialAllow = jsonList(lsGet(LS_SERIAL)).filter(isSerialPath);
        this.lan = lsGet(LS_LAN) === '1';
        this.optIn = ssGet(SS_OPTIN) === '1';
        this.status = this.token ? 'idle' : 'unpaired'; // unpaired | idle | probing | connecting | connected | down | auth-failed
        this.error = null;
        this.session = null;
        this.features = null;
        this.bridgeConfig = null;
        this.epoch = 0;
        this.ws = null;
        this.started = false;
        this.everConnected = false;
        this.pending = new Map();
        this.nextId = 1;
        this.listeners = new Set();
        this.oscPorts = new Map();     // port -> { wanters: Map(id -> t), sub, listening, bind, error, msgs, seq, last, count }
        this.serialPorts = new Map();  // path -> { wanters: Map(id -> t), baudRate, mode, sub, open, error, msgs, seq, last, count }
        this.requested = new Map();    // "host:port" -> { host, port, t } destinations nodes asked for but not allowed
        this.requestedSerial = new Map();
        this.serialList = null;
        this.stats = { oscOut: 0, oscIn: 0, serialOut: 0, serialIn: 0, artnetOut: 0, midiOut: 0, errors: 0 };
        this.lastOut = null;
        this.lastIn = null;
        this.lastError = null;
        this.seq = 0;
        this._timer = null;
        this._reconnect = null;
        this._backoff = 1000;
        this.pairedFromUrl = pairedFromUrl;
        if (pairedFromUrl) this.start();
    }

    // ------------------------------------------------------------------ status / events

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    _emit(reason = 'status') {
        for (const fn of this.listeners) { try { fn(reason, this); } catch (e) { /* ignore */ } }
        if (hasWindow) {
            try { window.dispatchEvent(new CustomEvent('patchtoy:io-status', { detail: { reason, status: this.status, optIn: this.optIn } })); } catch (e) { /* ignore */ }
        }
    }

    _setStatus(status, error = null) {
        if (this.status === status && this.error === error) return;
        this.status = status;
        this.error = error;
        this._emit('status');
    }

    get connected() { return this.status === 'connected'; }

    /** { state: 'ok' | 'wait' | 'error' | 'off', text } for node status lines. */
    linkState() {
        if (!this.available) return { state: 'off', text: 'I/O needs the browser app' };
        if (!this.token) return { state: 'off', text: 'bridge not paired · Output › I/O' };
        switch (this.status) {
            case 'connected':
                if (!this.optIn) return { state: 'wait', text: 'I/O off · enable in Output › I/O' };
                return { state: 'ok', text: 'connected' };
            case 'down': return { state: 'error', text: 'bridge not running · npm run io-bridge' };
            case 'auth-failed': return { state: 'error', text: 'token rejected · re-pair in Output › I/O' };
            default: return { state: 'wait', text: 'connecting to the I/O bridge…' };
        }
    }

    /** True when sends may leave the app (connected + opted in). */
    ready() { return this.connected && this.optIn; }

    // ------------------------------------------------------------------ settings

    setToken(token) {
        const t = String(token || '').trim().replace(/^.*[?&]ioToken=([^&#\s]+).*$/, '$1'); // a pasted pairing URL works too
        this.token = t || null;
        lsSet(LS_TOKEN, this.token);
        this._restart();
    }

    setPort(port) {
        const p = Number(port);
        if (!(p >= 1 && p <= 65535)) return false;
        this.port = p;
        lsSet(LS_PORT, p === IO_DEFAULT_PORT ? null : p);
        this._restart();
        return true;
    }

    unpair() {
        this.token = null;
        lsSet(LS_TOKEN, null);
        this._restart();
    }

    setOptIn(on) {
        this.optIn = !!on;
        ssSet(SS_OPTIN, this.optIn ? '1' : null);
        if (!this.optIn) {
            for (const p of this.oscPorts.values()) { p.sub = 'none'; p.listening = false; }
            for (const s of this.serialPorts.values()) { s.sub = 'none'; s.open = false; }
        }
        this._sendConfig();
        this._emit('config');
        this._reconcile();
    }

    setAllow(list) {
        const n = normalizeAllowlist(list);
        this.allow = n.entries.map(e => e.text);
        this._allowParsed = n.entries;
        lsSet(LS_ALLOW, JSON.stringify(this.allow));
        for (const [k, r] of this.requested) if (isAllowed(this._allowParsed, r.host, r.port)) this.requested.delete(k);
        this._sendConfig();
        this._emit('config');
        return n.invalid;
    }

    addAllow(entry) {
        const e = parseAllowEntry(entry);
        if (!e) return false;
        this.setAllow([...this.allow, e.text]);
        return true;
    }

    removeAllow(text) {
        this.setAllow(this.allow.filter(a => a !== text));
    }

    setSerialAllow(list) {
        this.serialAllow = [...new Set((list || []).map(s => String(s).trim()).filter(isSerialPath))];
        lsSet(LS_SERIAL, JSON.stringify(this.serialAllow));
        for (const k of [...this.requestedSerial.keys()]) if (this.serialAllow.includes(k)) this.requestedSerial.delete(k);
        this._sendConfig();
        this._emit('config');
        this._reconcile();
    }

    addSerial(path) {
        if (!path) return;
        this.setSerialAllow([...this.serialAllow, path]);
    }

    removeSerial(path) {
        this.setSerialAllow(this.serialAllow.filter(p => p !== path));
    }

    setLan(on) {
        this.lan = !!on;
        lsSet(LS_LAN, this.lan ? '1' : null);
        this._sendConfig();
        this._emit('config');
    }

    /** Apply several settings at once (automation): { token, port, opt_in, allow, serial, lan }. */
    configure({ token, port, opt_in, allow, serial, lan } = {}) {
        if (port !== undefined) { this.port = Number(port) || IO_DEFAULT_PORT; lsSet(LS_PORT, this.port === IO_DEFAULT_PORT ? null : this.port); }
        if (allow !== undefined) this.setAllow(allow);
        if (serial !== undefined) this.setSerialAllow(serial);
        if (lan !== undefined) this.setLan(lan);
        if (opt_in !== undefined) this.setOptIn(opt_in);
        if (token !== undefined) this.setToken(token);
        else if (port !== undefined) this._restart();
        this.start();
    }

    isAllowedDest(host, port) { return isAllowed(this._allowParsed, host, port); }

    // ------------------------------------------------------------------ connection

    /** Called by I/O nodes and the panel: connect once there is something to do. */
    touch() {
        if (!this.started && this.available && this.token) this.start();
    }

    start() {
        if (!this.available) return this;
        if (!this.started) {
            this.started = true;
            this._timer = setInterval(() => this._reconcile(), 300);
            if (hasWindow) window.addEventListener('beforeunload', () => { try { this.ws && this.ws.close(); } catch (e) { /* ignore */ } });
        }
        if (!this.ws) this._connect();
        return this;
    }

    _restart() {
        clearTimeout(this._reconnect);
        this._reconnect = null;
        this._backoff = 1000;
        const ws = this.ws;
        this.ws = null;
        if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { /* ignore */ } }
        this._onDisconnected();
        this._setStatus(this.token ? 'idle' : 'unpaired');
        if (this.token && this.available) this.start();
    }

    async _probe() {
        // Dev server: ask Vite whether something listens on the port first, so a
        // missing bridge never logs a refused-WebSocket error in the console.
        let dev = false;
        try { dev = !!(import.meta.env && import.meta.env.DEV); } catch (e) { /* not under Vite */ }
        if (!dev) return true;
        try {
            const res = await fetch(`/__patchtoy/bridge-probe?port=${this.port}`, { cache: 'no-store' });
            if (!res.ok) return true;
            return (await res.json()).up === true;
        } catch (e) {
            return true;
        }
    }

    async _connect() {
        if (!this.token || this.ws || this._connecting) return;
        this._connecting = true;
        if (this.status !== 'connected') this._setStatus(this.status === 'down' ? 'down' : 'probing', this.error);
        const up = await this._probe();
        this._connecting = false;
        if (!this.token || this.ws) return;
        if (!up) {
            this._setStatus('down', `nothing is listening on 127.0.0.1:${this.port}`);
            this._scheduleReconnect();
            return;
        }
        if (this.status !== 'down') this._setStatus('connecting');
        let ws;
        try {
            ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
        } catch (e) {
            this._setStatus('down', e.message);
            this._scheduleReconnect();
            return;
        }
        this.ws = ws;
        let authFailed = false;
        ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'hello', token: this.token, client: 'patchtoy', protocol: 1 }));
        };
        ws.onmessage = (ev) => {
            let m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m && m.type === 'error' && m.code === 'auth') authFailed = m.error || 'token rejected';
            this._onMessage(m);
        };
        ws.onclose = (ev) => {
            if (this.ws !== ws) return;
            this.ws = null;
            const was = this.connected;
            this._onDisconnected();
            if (authFailed || ev.code === 4401) {
                this._setStatus('auth-failed', typeof authFailed === 'string' ? authFailed : 'the bridge rejected the pairing token');
                return; // wait for a new token
            }
            this._setStatus('down', was ? 'the I/O bridge stopped' : `could not reach the I/O bridge on 127.0.0.1:${this.port}`);
            this._scheduleReconnect(was);
        };
        ws.onerror = () => { /* onclose follows */ };
    }

    _scheduleReconnect(fast = false) {
        clearTimeout(this._reconnect);
        const delay = fast ? 800 : this._backoff;
        this._backoff = Math.min(15000, Math.round(this._backoff * 1.6));
        this._reconnect = setTimeout(() => { this._reconnect = null; this._connect(); }, delay);
    }

    _onDisconnected() {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('I/O bridge disconnected')); }
        this.pending.clear();
        for (const p of this.oscPorts.values()) { p.sub = 'none'; p.listening = false; }
        for (const s of this.serialPorts.values()) { s.sub = 'none'; s.open = false; }
        this.session = null;
        this.bridgeConfig = null;
    }

    _onMessage(m) {
        if (!m || typeof m !== 'object') return;
        if (m.id !== undefined && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.ok) p.resolve(m.result);
            else { const e = new Error(m.error || 'I/O bridge error'); e.code = m.code; p.reject(e); }
            return;
        }
        switch (m.type) {
            case 'welcome':
                this.session = m.session;
                this.features = m.features || {};
                this.epoch++;
                this.everConnected = true;
                this._backoff = 1000;
                this._setStatus('connected');
                this._sendConfig();
                this._reconcile();
                break;
            case 'config':
                this.bridgeConfig = m;
                this._emit('config');
                break;
            case 'osc': {
                const p = this.oscPorts.get(m.port);
                if (!p) break;
                for (const msg of m.messages || []) {
                    const rec = { seq: ++this.seq, t: performance.now(), address: String(msg.address || ''), types: String(msg.types || ''), args: Array.isArray(msg.args) ? msg.args : [], from: m.from };
                    p.msgs.push(rec);
                    p.last = rec;
                    p.count++;
                    this.stats.oscIn++;
                    this.lastIn = { kind: 'osc', port: m.port, address: rec.address, args: rec.args, t: Date.now(), from: m.from };
                }
                if (p.msgs.length > BUFFER) p.msgs.splice(0, p.msgs.length - BUFFER);
                break;
            }
            case 'serial': {
                const s = this.serialPorts.get(m.path);
                if (!s) break;
                const rec = { seq: ++this.seq, t: performance.now(), line: typeof m.line === 'string' ? m.line : null, bytes: Array.isArray(m.bytes) ? m.bytes : null };
                s.msgs.push(rec);
                s.last = rec;
                s.count++;
                this.stats.serialIn++;
                this.lastIn = { kind: 'serial', path: m.path, line: rec.line, bytes: rec.bytes ? rec.bytes.length : undefined, t: Date.now() };
                if (s.msgs.length > BUFFER) s.msgs.splice(0, s.msgs.length - BUFFER);
                break;
            }
            case 'listen-status': {
                const p = this.oscPorts.get(m.port);
                if (!p) break;
                p.listening = !!m.listening;
                p.bind = m.bind;
                p.error = m.error || null;
                if (p.error) p.sub = 'error';
                this._emit('ports');
                break;
            }
            case 'serial-status': {
                const s = this.serialPorts.get(m.path);
                if (!s) break;
                s.open = !!m.open;
                s.error = m.error || null;
                if (s.error && !s.open) s.sub = 'error';
                this._emit('ports');
                break;
            }
            case 'error':
                this.stats.errors++;
                this.lastError = { op: m.op, code: m.code, error: m.error, dest: m.dest, t: Date.now() };
                if (m.code === 'not-allowed' && m.dest) {
                    const hp = /^\[?([^\]]+?)\]?:(\d+)$/.exec(m.dest);
                    if (hp) this.requested.set(m.dest, { host: hp[1], port: Number(hp[2]), t: Date.now() });
                }
                this._emit('error');
                break;
            default:
                break;
        }
    }

    _post(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected) return false;
        try { this.ws.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
    }

    request(op, params = {}, timeoutMs = 5000) {
        if (!this.ws || !this.connected) return Promise.reject(new Error(this.linkState().text));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`I/O bridge did not answer ${op}`)); }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this._post({ id, op, ...params });
        });
    }

    _sendConfig() {
        this._post({ type: 'config', optIn: this.optIn, allow: this.allow, serial: this.serialAllow, lan: this.lan });
    }

    // ------------------------------------------------------------------ outbound

    /** Can we send to host:port right now? { ok, state, text } (records blocked destinations). */
    checkDest(host, port) {
        const link = this.linkState();
        if (link.state === 'off' && !this.available) return { ok: false, ...link };
        const p = Number(port);
        if (!host || !(p >= 1 && p <= 65535)) return { ok: false, state: 'error', text: `bad destination ${host}:${port}` };
        const allowed = this.isAllowedDest(host, p);
        const key = destKey(host, p);
        if (!allowed) this.requested.set(key, { host: String(host), port: p, t: Date.now() });
        // Fix the link first (pair / start the bridge / enable), then the allowlist
        if (link.state === 'off' || link.state === 'error') return { ok: false, ...link };
        if (!allowed) return { ok: false, state: 'error', text: `${key} not allowed · Output › I/O` };
        if (link.state !== 'ok') return { ok: false, ...link };
        return { ok: true, state: 'ok', text: 'ok' };
    }

    oscSend(host, port, address, args, types = null) {
        const c = this.checkDest(host, port);
        if (!c.ok) return c;
        if (!this._post({ op: 'osc.send', host, port: Number(port), address, args, types })) return { ok: false, state: 'error', text: 'I/O bridge not connected' };
        this.stats.oscOut++;
        this.lastOut = { kind: 'osc', dest: destKey(host, port), address, args, t: Date.now() };
        return { ok: true, state: 'ok', text: 'sent' };
    }

    artnetSend(host, universe, data, port = 6454) {
        const c = this.checkDest(host, port);
        if (!c.ok) return c;
        if (!this._post({ op: 'artnet.send', host, port: Number(port), universe, data })) return { ok: false, state: 'error', text: 'I/O bridge not connected' };
        this.stats.artnetOut++;
        this.lastOut = { kind: 'artnet', dest: destKey(host, port), universe, channels: data.length, t: Date.now() };
        return { ok: true, state: 'ok', text: 'sent' };
    }

    // ------------------------------------------------------------------ OSC in

    _oscPort(port) {
        let p = this.oscPorts.get(port);
        if (!p) {
            p = { wanters: new Map(), sub: 'none', listening: false, bind: null, error: null, msgs: [], seq: 0, last: null, count: 0 };
            this.oscPorts.set(port, p);
        }
        return p;
    }

    /** An OSC In node uses this UDP port (call every frame). Returns the port record. */
    wantOsc(port, nodeId) {
        const p = this._oscPort(port);
        p.wanters.set(nodeId, performance.now());
        if (p.sub === 'none' && this.ready()) this._reconcile();
        return p;
    }

    /** Messages on a port newer than seq. */
    oscSince(port, seq) {
        const p = this.oscPorts.get(port);
        if (!p) return [];
        const out = [];
        for (let i = p.msgs.length - 1; i >= 0 && p.msgs[i].seq > seq; i--) out.push(p.msgs[i]);
        return out.reverse();
    }

    // ------------------------------------------------------------------ serial

    _serialPort(path) {
        let s = this.serialPorts.get(path);
        if (!s) {
            s = { wanters: new Map(), baudRate: 115200, mode: 'lines', sub: 'none', open: false, error: null, msgs: [], last: null, count: 0 };
            this.serialPorts.set(path, s);
        }
        return s;
    }

    /** A Serial node uses this port (call every frame). */
    wantSerial(path, baudRate, mode, nodeId, weak = false) {
        const fresh = !this.serialPorts.has(path);
        const s = this._serialPort(path);
        const others = [...s.wanters.keys()].some(id => id !== nodeId && !(s.weak && s.weak.has(id)));
        s.wanters.set(nodeId, performance.now());
        if (weak) (s.weak || (s.weak = new Set())).add(nodeId);
        else if (s.weak) s.weak.delete(nodeId);
        // A weak user (Serial Out) never changes the settings of a port another node reads
        const baud = weak && !fresh && others ? s.baudRate : (Number(baudRate) || 115200);
        const m = weak && !fresh && others ? s.mode : (mode === 'bytes' ? 'bytes' : 'lines');
        if ((s.baudRate !== baud || s.mode !== m) && s.sub !== 'none') {
            // Settings changed: reopen
            if (this.connected) this._post({ op: 'serial.close', path });
            s.sub = 'none';
            s.open = false;
        }
        s.baudRate = baud;
        s.mode = m;
        if (!isSerialPath(path)) {
            s.error = 'not a serial device name (/dev/… or COMn)';
            return s;
        }
        if (!this.serialAllow.includes(path)) this.requestedSerial.set(path, { path, t: Date.now() });
        if (s.sub === 'none' && this.ready()) this._reconcile();
        return s;
    }

    serialSince(path, seq) {
        const s = this.serialPorts.get(path);
        if (!s) return [];
        const out = [];
        for (let i = s.msgs.length - 1; i >= 0 && s.msgs[i].seq > seq; i--) out.push(s.msgs[i]);
        return out.reverse();
    }

    serialWrite(path, payload) {
        const link = this.linkState();
        if (link.state !== 'ok') return { ok: false, ...link };
        if (!this.serialAllow.includes(path)) return { ok: false, state: 'error', text: `${path} not picked · Output › I/O` };
        const s = this.serialPorts.get(path);
        if (!s || !s.open) return { ok: false, state: 'wait', text: s && s.error ? s.error : `opening ${path}…` };
        if (!this._post({ op: 'serial.write', path, ...payload })) return { ok: false, state: 'error', text: 'I/O bridge not connected' };
        this.stats.serialOut++;
        this.lastOut = { kind: 'serial', path, text: payload.text, bytes: payload.bytes ? payload.bytes.length : undefined, t: Date.now() };
        return { ok: true, state: 'ok', text: 'sent' };
    }

    async listSerialPorts() {
        const r = await this.request('serial.list', {}, 8000);
        this.serialList = (r && r.ports) || [];
        this._emit('serial-list');
        return this.serialList;
    }

    // ------------------------------------------------------------------ reconciliation

    /** Open / close bridge listeners and serial ports to match what nodes use. */
    _reconcile() {
        const now = performance.now();
        const ready = this.ready();
        let changed = false;
        for (const [port, p] of this.oscPorts) {
            for (const [id, t] of p.wanters) if (now - t > WANT_TTL_MS) p.wanters.delete(id);
            if (!p.wanters.size) {
                if (p.sub !== 'none' && this.connected) this._post({ op: 'osc.unlisten', port });
                this.oscPorts.delete(port);
                changed = true;
                continue;
            }
            if (ready && p.sub === 'none') {
                p.sub = 'pending';
                p.error = null;
                this.request('osc.listen', { port }).then((r) => {
                    // The listen-status event may arrive before this reply: keep what it said
                    p.sub = r && r.error ? 'error' : 'on';
                    p.listening = p.listening || !!(r && r.listening);
                    p.bind = (r && r.bind) || p.bind;
                    p.error = (r && r.error) || p.error || null;
                    this._emit('ports');
                }).catch((e) => {
                    p.sub = 'error';
                    p.error = e.message;
                    this._emit('ports');
                });
                changed = true;
            }
        }
        for (const [path, s] of this.serialPorts) {
            for (const [id, t] of s.wanters) if (now - t > WANT_TTL_MS) s.wanters.delete(id);
            if (!s.wanters.size) {
                if (s.sub !== 'none' && this.connected) this._post({ op: 'serial.close', path });
                this.serialPorts.delete(path);
                changed = true;
                continue;
            }
            if (ready && s.sub === 'none' && isSerialPath(path) && this.serialAllow.includes(path)) {
                s.sub = 'pending';
                s.error = null;
                this.request('serial.open', { path, baudRate: s.baudRate, mode: s.mode }, 8000).then((r) => {
                    s.sub = r && r.error ? 'error' : 'on';
                    s.open = s.open || !!(r && r.open);
                    s.error = s.open ? null : ((r && r.error) || s.error || null);
                    this._emit('ports');
                }).catch((e) => {
                    s.sub = 'error';
                    s.error = e.message;
                    this._emit('ports');
                });
                changed = true;
            }
        }
        // Requested destinations nobody asked for in a while drop out of the panel
        for (const [k, r] of this.requested) if (Date.now() - r.t > 10000) { this.requested.delete(k); changed = true; }
        for (const [k, r] of this.requestedSerial) if (Date.now() - r.t > 10000) { this.requestedSerial.delete(k); changed = true; }
        if (changed) this._emit('ports');
    }

    // ------------------------------------------------------------------ automation

    describe() {
        return {
            status: this.status,
            error: this.error || undefined,
            paired: !!this.token,
            port: this.port,
            session: this.session || undefined,
            opt_in: this.optIn,
            allow: this.allow.slice(),
            serial_allow: this.serialAllow.slice(),
            lan: this.lan,
            features: this.features || undefined,
            requested: [...this.requested.keys()],
            requested_serial: [...this.requestedSerial.keys()],
            osc_in: [...this.oscPorts.entries()].map(([port, p]) => ({ port, listening: p.listening, bind: p.bind || undefined, error: p.error || undefined, messages: p.count, nodes: p.wanters.size })),
            serial: [...this.serialPorts.entries()].map(([path, s]) => ({ path, open: s.open, baud: s.baudRate, mode: s.mode, error: s.error || undefined, messages: s.count, allowed: this.serialAllow.includes(path) })),
            stats: { ...this.stats },
            last_out: this.lastOut || undefined,
            last_in: this.lastIn || undefined,
            last_error: this.lastError || undefined,
        };
    }
}

/** The app-wide client (lazy: connects when an I/O node or the panel needs it). */
export const ioClient = new IOClient();
if (hasWindow) window.__patchtoyIO = ioClient;
