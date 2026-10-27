/**
 * Shared security helpers for PatchToy's local bridges (the MCP bridge in
 * bridge.mjs, and reusable by the OSC/serial I/O bridge):
 *
 *   - per-run secret tokens and a constant-time compare;
 *   - a server proof (HMAC of a client nonce) so a page can tell the real
 *     server from whatever else listens on the port;
 *   - a strict browser Origin allowlist (exact origins, plus the loopback
 *     aliases localhost / 127.0.0.1 / [::1] of the same scheme and port);
 *   - the dev-server pairing files (the MCP server writes its live-tab token,
 *     vite.config.js serves it to same-origin dev pages only, and registers
 *     the dev server's own origins);
 *   - safe output paths for files whose names come from a page or a tool
 *     argument (basename, character allowlist, forced extension, realpath
 *     confinement, no symlink following).
 *
 * Node only. Keep the exports stable: other modules import them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- tokens

/** A strong random token (URL-safe). */
export function makeToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Constant-time token comparison. Empty or non-string values never match. */
export function tokenEquals(given, expected) {
    if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
    return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

/** Prefix of the HMAC message; BridgeClient.js computes the same value. */
export const PROOF_CONTEXT = 'patchtoy-bridge-v1:';

/** Proof that the server knows `token`: hex HMAC-SHA256(token, PROOF_CONTEXT + nonce). */
export function serverProof(token, nonce) {
    return crypto.createHmac('sha256', String(token)).update(PROOF_CONTEXT + String(nonce)).digest('hex');
}

// ---------------------------------------------------------------- origins

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

export function isLoopbackHostname(hostname) {
    const h = String(hostname || '').toLowerCase();
    return LOOPBACK.includes(h) || h === '::1';
}

/**
 * Normalise a configured origin ("http://localhost:5200/", "localhost:5200",
 * "https://patchtoy.example") to URL.origin form, or null.
 */
export function normalizeOrigin(value) {
    if (!value || typeof value !== 'string') return null;
    let v = value.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `http://${v}`;
    try {
        const u = new URL(v);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.origin;
    } catch {
        return null;
    }
}

/** The origin itself, plus its localhost / 127.0.0.1 / [::1] aliases when it is a loopback origin. */
export function loopbackAliases(origin) {
    const o = normalizeOrigin(origin);
    if (!o) return [];
    const u = new URL(o);
    if (!isLoopbackHostname(u.hostname)) return [o];
    const port = u.port ? `:${u.port}` : '';
    return LOOPBACK.map(h => `${u.protocol}//${h}${port}`);
}

/**
 * Build an Origin check for WebSocket handshakes.
 *   origins:  configured origins (exact; loopback ones also match their aliases)
 *   dynamic:  optional () => string[] of extra origins, read at check time
 *   allowNoOrigin: accept handshakes without an Origin header (non-browser
 *             clients; browsers always send one). Such clients still need the token.
 * Returns (origin) => { ok: boolean, reason?: string }.
 */
export function createOriginPolicy({ origins = [], dynamic = null, allowNoOrigin = true } = {}) {
    const fixed = new Set();
    for (const o of origins) for (const a of loopbackAliases(o)) fixed.add(a);
    const check = (origin) => {
        if (origin === undefined || origin === null || origin === '') {
            return allowNoOrigin ? { ok: true } : { ok: false, reason: 'no Origin header' };
        }
        let u;
        try { u = new URL(origin); } catch { return { ok: false, reason: `invalid Origin ${JSON.stringify(String(origin).slice(0, 100))}` }; }
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== origin) {
            return { ok: false, reason: `Origin ${String(origin).slice(0, 100)} is not an http(s) origin` };
        }
        if (fixed.has(origin)) return { ok: true };
        if (dynamic) {
            try {
                for (const o of dynamic() || []) for (const a of loopbackAliases(o)) if (a === origin) return { ok: true };
            } catch { /* ignore */ }
        }
        return { ok: false, reason: `Origin ${origin} is not allowed` };
    };
    check.allowed = () => {
        const all = new Set(fixed);
        if (dynamic) { try { for (const o of dynamic() || []) for (const a of loopbackAliases(o)) all.add(a); } catch { /* ignore */ } }
        return [...all];
    };
    return check;
}

/**
 * Change the largest frame one accepted `ws` connection takes. Servers listen with a
 * small maxPayload (unauthenticated peers can't make them buffer much) and raise it
 * per connection once the hello authenticated. `ws` keeps the limit on the
 * connection's receiver; returns false if that internal ever changes.
 */
export function setConnectionMaxPayload(ws, bytes) {
    const r = ws && ws._receiver;
    if (r && typeof r._maxPayload === 'number') { r._maxPayload = bytes; return true; }
    return false;
}

// ---------------------------------------------------------------- dev-server pairing files
//
// <repo>/node_modules/.cache/patchtoy-mcp/
//   bridge-<port>.json      written by the MCP server (live pairing enabled): {port, token, pid}
//   devserver-<pid>-<port>.json  written by vite.config.js: {pid, port, origins, role}
// vite.config.js reads/writes the same layout (kept self-contained there so the
// dev server never depends on this module).

export function pairingDir(repoRoot) {
    return path.join(repoRoot, 'node_modules', '.cache', 'patchtoy-mcp');
}

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Write the live-tab pairing token for a bridge port (0600). Returns the file path. */
export function writePairingFile(repoRoot, port, token) {
    const dir = pairingDir(repoRoot);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `bridge-${port}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ port, token, pid: process.pid, started: new Date().toISOString() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
}

/** Remove the pairing file, only if it still holds our token. */
export function removePairingFile(repoRoot, port, token) {
    const file = path.join(pairingDir(repoRoot), `bridge-${port}.json`);
    try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cur && cur.token === token) fs.unlinkSync(file);
    } catch { /* gone or unreadable */ }
}

/**
 * The PatchToy Vite dev servers running from this repo (registered by vite.config.js):
 * [{pid, port, origins, role}], role 'dev' (a regular `npm run dev`) or 'private'
 * (HMR off / PATCHTOY_DEV_ROLE=private: test suites and agents' private servers).
 * Files from before roles existed count as 'dev'.
 */
export function registeredDevServers(repoRoot) {
    const dir = pairingDir(repoRoot);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const f of entries) {
        if (!/^devserver-\d+-\d+\.json$/.test(f)) continue;
        try {
            const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (!pidAlive(d.pid)) continue;
            const origins = (d.origins || []).filter(o => typeof o === 'string');
            out.push({ pid: d.pid, port: d.port, origins, role: d.role === 'private' ? 'private' : 'dev' });
        } catch { /* ignore */ }
    }
    return out;
}

/** Origins of the PatchToy Vite dev servers running from this repo (registered by vite.config.js). */
export function registeredDevOrigins(repoRoot) {
    return registeredDevServers(repoRoot).flatMap(d => d.origins);
}

/**
 * Role of the registered dev server serving `origin` ('dev' | 'private'), or null when
 * it is not one of this repo's dev servers. Loopback aliases match.
 */
export function devServerRole(repoRoot, origin) {
    if (!origin) return null;
    let role = null;
    for (const d of registeredDevServers(repoRoot)) {
        if (d.origins.some(o => loopbackAliases(o).includes(origin))) {
            if (d.role === 'private') return 'private';
            role = 'dev';
        }
    }
    return role;
}

// ---------------------------------------------------------------- safe file names and paths

export class UnsafePathError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnsafePathError';
    }
}

/**
 * A safe file name from untrusted input: the basename only (both / and \ count
 * as separators), characters outside [A-Za-z0-9._-] replaced with '_', no
 * leading dot/dash, at most maxLength chars. `ext` (without dot) forces the
 * extension: an existing extension is replaced.
 */
export function sanitizeFilename(name, { ext = null, fallback = 'file', maxLength = 120 } = {}) {
    let base = String(name ?? '').split(/[/\\]/).pop() || '';
    base = base.normalize('NFKC')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/\.{2,}/g, '.')
        .replace(/_{2,}/g, '_')
        .replace(/^[._-]+/, '')
        .replace(/[._-]+$/, '');
    const e = ext ? String(ext).replace(/^\.+/, '').toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    if (e) base = base.replace(/\.[A-Za-z0-9]{1,10}$/, '');
    if (!base) base = fallback;
    const room = Math.max(1, maxLength - (e ? e.length + 1 : 0));
    base = base.slice(0, room).replace(/[._-]+$/, '') || fallback;
    return e ? `${base}.${e}` : base;
}

/** Resolve symlinks in the longest existing prefix of `p` (the rest is appended as is). */
function realpathOfPrefix(p) {
    const rest = [];
    let cur = p;
    for (;;) {
        try {
            const real = fs.realpathSync(cur);
            return rest.length ? path.join(real, ...rest.reverse()) : real;
        } catch {
            const parent = path.dirname(cur);
            if (parent === cur) return p;
            rest.push(path.basename(cur));
            cur = parent;
        }
    }
}

function within(root, p) {
    const rel = path.relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `target` (absolute, or relative to roots[0]) to a writable file
 * path that stays inside one of `roots` after resolving symlinks. Rejects
 * hidden path segments (.git, .ssh, ...) and node_modules below the root, and
 * an existing target that is a symlink or not a regular file. The basename is
 * sanitised and, with `ext`, given that extension. Creates missing parent
 * directories (mkdir) and re-checks them. Throws UnsafePathError.
 */
export function confinedFilePath(roots, target, { ext = null, fallback = 'file', mkdir = true } = {}) {
    const rootList = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
    if (!rootList.length) throw new UnsafePathError('no output folder configured');
    if (typeof target !== 'string' || !target.trim()) throw new UnsafePathError('empty path');
    if (target.includes('\0')) throw new UnsafePathError('invalid path');
    const raw = path.resolve(rootList[0], target.trim());
    const name = sanitizeFilename(path.basename(raw), { ext, fallback });
    const dirCanon = realpathOfPrefix(path.dirname(raw));

    let root = null;
    for (const r of rootList) {
        const rr = realpathOfPrefix(path.resolve(r));
        if (within(rr, dirCanon)) { root = rr; break; }
    }
    if (!root) {
        throw new UnsafePathError(`${target} is outside the allowed folders (${rootList.join(', ')})`);
    }
    const segs = path.relative(root, dirCanon).split(path.sep).filter(Boolean);
    const bad = segs.find(s => s.startsWith('.') || s === 'node_modules');
    if (bad) throw new UnsafePathError(`${target}: writing into "${bad}" is not allowed`);

    if (mkdir) {
        fs.mkdirSync(dirCanon, { recursive: true });
        const again = fs.realpathSync(dirCanon);
        if (!within(root, again)) throw new UnsafePathError(`${target} resolves outside the allowed folders`);
    }
    const file = path.join(dirCanon, name);
    let st = null;
    try { st = fs.lstatSync(file); } catch { /* new file */ }
    if (st && (st.isSymbolicLink() || !st.isFile())) throw new UnsafePathError(`${displayable(file)} exists and is not a regular file`);
    return file;
}

function displayable(p) { return p.length > 200 ? `...${p.slice(-200)}` : p; }

/** Write a file without following a symlink at the final path component (where supported). */
export function writeFileNoFollow(file, data, mode = 0o644) {
    const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW, mode);
    try {
        fs.writeFileSync(fd, data);
    } finally {
        fs.closeSync(fd);
    }
}
