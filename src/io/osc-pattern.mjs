/**
 * OSC 1.0 address pattern matching (pure, shared by the app and the I/O bridge).
 *
 *   ?        any single character except '/'
 *   *        any sequence of characters except '/'
 *   [abc]    one of the characters (ranges a-z, negation [!abc])
 *   {a,b}    one of the comma-separated strings
 *
 * Extensions for convenience: an empty pattern or a lone '*' matches every
 * address, and a trailing '/**' matches the prefix and everything below it
 * (e.g. /track/** matches /track/1/volume).
 */
const cache = new Map();

function escapeRe(c) {
    return /[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c;
}

/** Compile an OSC address pattern to a RegExp (cached). Never throws: bad syntax matches literally. */
export function compileOscPattern(pattern) {
    const key = String(pattern ?? '');
    let re = cache.get(key);
    if (re) return re;
    const p = key.trim();
    if (p === '' || p === '*') {
        re = /^\/.*$/;
    } else {
        let src = '';
        let body = p;
        let tail = '';
        if (body.endsWith('/**')) { body = body.slice(0, -3); tail = '(?:/.*)?'; }
        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (c === '?') src += '[^/]';
            else if (c === '*') src += '[^/]*';
            else if (c === '[') {
                const end = body.indexOf(']', i + 1);
                if (end < 0) { src += '\\['; continue; }
                let set = body.slice(i + 1, end);
                let neg = false;
                if (set.startsWith('!')) { neg = true; set = set.slice(1); }
                const cls = set.replace(/[\\\]^]/g, m => `\\${m}`);
                src += neg ? `[^/${cls}]` : `[${cls}]`;
                i = end;
            } else if (c === '{') {
                const end = body.indexOf('}', i + 1);
                if (end < 0) { src += '\\{'; continue; }
                const alts = body.slice(i + 1, end).split(',').map(a => a.split('').map(escapeRe).join(''));
                src += `(?:${alts.join('|')})`;
                i = end;
            } else src += escapeRe(c);
        }
        try { re = new RegExp(`^${src}${tail}$`); } catch (e) { re = new RegExp(`^${p.split('').map(escapeRe).join('')}$`); }
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, re);
    return re;
}

/** Does an incoming OSC address match a pattern? */
export function oscMatch(pattern, address) {
    return compileOscPattern(pattern).test(String(address ?? ''));
}
