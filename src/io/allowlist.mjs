/**
 * Destination allowlist (pure, shared by the app and the I/O bridge).
 *
 * Entries are "host:port", "host:port-port" (range) or "host:*" (any port).
 * host is an IPv4 / IPv6 literal ([::1]:9000) or a hostname, compared
 * case-insensitively; "localhost" and "127.0.0.1" are the same host. There is
 * no wildcard host: every destination machine is listed explicitly.
 *
 * The user edits the list in the app (Output > I/O); it lives in the browser's
 * localStorage, never in project files, so a shared patch cannot add
 * destinations. The bridge enforces the same list again for each connection.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

function normHost(h) {
    let s = String(h || '').trim().toLowerCase();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    if (s.endsWith('.')) s = s.slice(0, -1);
    return LOOPBACK.has(s) ? '127.0.0.1' : s;
}

/** Parse one allowlist entry -> { host, lo, hi, text } or null (invalid). */
export function parseAllowEntry(entry) {
    const s = String(entry || '').trim();
    if (!s) return null;
    let m = s.match(/^\[([0-9a-f:.]+)\]:(\*|\d{1,5}(?:-\d{1,5})?)$/i);
    if (!m) m = s.match(/^([a-z0-9][a-z0-9.-]*):(\*|\d{1,5}(?:-\d{1,5})?)$/i);
    if (!m) return null;
    const host = normHost(m[1]);
    if (!host || host === '0.0.0.0' || host === '*') return null;
    let lo, hi;
    if (m[2] === '*') { lo = 1; hi = 65535; }
    else {
        const [a, b] = m[2].split('-').map(Number);
        lo = a; hi = b === undefined ? a : b;
    }
    if (!(lo >= 1 && hi <= 65535 && lo <= hi)) return null;
    const portText = m[2] === '*' ? '*' : (lo === hi ? String(lo) : `${lo}-${hi}`);
    const text = host.includes(':') ? `[${host}]:${portText}` : `${host}:${portText}`;
    return { host, lo, hi, text };
}

/** Normalize a list of entries (strings): valid, de-duplicated. Returns { entries, invalid }. */
export function normalizeAllowlist(list) {
    const entries = [];
    const invalid = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)) {
        if (!String(raw || '').trim()) continue;
        const e = parseAllowEntry(raw);
        if (!e) { invalid.push(String(raw)); continue; }
        if (seen.has(e.text)) continue;
        seen.add(e.text);
        entries.push(e);
    }
    return { entries, invalid };
}

/** Is host:port allowed by parsed entries? */
export function isAllowed(entries, host, port) {
    const h = normHost(host);
    const p = Number(port);
    if (!h || !(p >= 1 && p <= 65535)) return false;
    return (entries || []).some(e => e.host === h && p >= e.lo && p <= e.hi);
}

/** Display form of a destination ("127.0.0.1:9000"). */
export function destKey(host, port) {
    const h = normHost(host);
    return h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
}

/**
 * Is this a plausible serial device name? Rejects anything that is not a device
 * node (no traversal, no regular files): /dev/<name> on macOS / Linux (one path
 * component, [A-Za-z0-9._-]), /dev/serial/by-id/<name>, or COM<n> on Windows.
 */
export function isSerialPath(p) {
    const s = String(p || '');
    if (s.length > 128) return false;
    if (/^COM\d{1,3}$/i.test(s)) return true;
    if (/^\/dev\/serial\/by-(id|path)\/[A-Za-z0-9._:+-]+$/.test(s)) return !s.includes('..');
    return /^\/dev\/[A-Za-z0-9._-]+$/.test(s) && !s.includes('..');
}

/** Is this a well-formed OSC address (pattern)? */
export function isOscAddress(a) {
    const s = String(a || '');
    return s.length >= 1 && s.length <= 512 && s.startsWith('/') && !/[\u0000-\u001f\s#]/.test(s);
}
