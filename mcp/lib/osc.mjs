/**
 * Minimal OSC 1.0 codec (Node Buffers, no dependencies). Used by the I/O bridge
 * (mcp/lib/io-bridge.mjs), scripts/osc-send-demo.mjs and the e2e tests.
 *
 *   encodeMessage(address, args, types?)  -> Buffer
 *   encodeBundle(elements, timetag?)      -> Buffer   elements: [{address, args, types} | {bundle: [...]}]
 *   decodePacket(buf)                     -> { address, types, args } | { bundle: true, timetag, elements: [...] }
 *   flattenPacket(packet)                 -> [{ address, types, args }]   (bundles unrolled in order)
 *
 * Type tags: i int32, f float32, s string, b blob (OSC 1.0) plus the common
 * extensions h int64, d float64, t timetag, c char, r rgba, m midi, T true,
 * F false, N nil, I impulse, S symbol. Without explicit types, numbers are sent
 * as f, strings as s, booleans as T / F, null as N, Buffers / Uint8Arrays as b.
 * Decoded int64 values are Numbers (precision loss above 2^53), blobs are
 * arrays of bytes, timetags are seconds since 1900 (Number).
 */

const pad4 = (n) => (n + 3) & ~3;

function oscString(s) {
    const b = Buffer.from(String(s), 'utf8');
    const out = Buffer.alloc(pad4(b.length + 1)); // NUL terminated, padded to 4
    b.copy(out);
    return out;
}

function int32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32BE((Number(v) | 0), 0);
    return b;
}

function float32(v) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(Number(v) || 0, 0);
    return b;
}

function timetagBuf(t) {
    const b = Buffer.alloc(8);
    if (t === undefined || t === null || t === 1) { b.writeUInt32BE(0, 0); b.writeUInt32BE(1, 4); return b; } // immediately
    const secs = Math.floor(t);
    b.writeUInt32BE(secs >>> 0, 0);
    b.writeUInt32BE(Math.floor((t - secs) * 4294967296) >>> 0, 4);
    return b;
}

/** Infer an OSC type tag for a JS value. */
export function inferType(v) {
    if (typeof v === 'number') return 'f';
    if (typeof v === 'string') return 's';
    if (typeof v === 'boolean') return v ? 'T' : 'F';
    if (v === null || v === undefined) return 'N';
    if (v instanceof Uint8Array || Buffer.isBuffer(v)) return 'b';
    if (typeof v === 'bigint') return 'h';
    return 's';
}

function encodeArg(t, v) {
    switch (t) {
        case 'i': return int32(v);
        case 'f': return float32(v);
        case 's': case 'S': return oscString(v ?? '');
        case 'c': return int32(String(v ?? '').codePointAt(0) || 0);
        case 'b': {
            const data = Buffer.from(v instanceof Uint8Array || Array.isArray(v) ? v : []);
            const out = Buffer.alloc(4 + pad4(data.length));
            out.writeInt32BE(data.length, 0);
            data.copy(out, 4);
            return out;
        }
        case 'h': { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(Math.trunc(Number(v) || 0)), 0); return b; }
        case 'd': { const b = Buffer.alloc(8); b.writeDoubleBE(Number(v) || 0, 0); return b; }
        case 't': return timetagBuf(Number(v));
        case 'r': case 'm': {
            const a = Array.isArray(v) ? v : [0, 0, 0, 0];
            return Buffer.from([a[0] & 255, a[1] & 255, a[2] & 255, a[3] & 255]);
        }
        case 'T': case 'F': case 'N': case 'I': return Buffer.alloc(0);
        default: throw new Error(`unsupported OSC type tag '${t}'`);
    }
}

/** Encode one OSC message. types: optional tag string without the comma ("ffs"). */
export function encodeMessage(address, args = [], types = null) {
    const addr = String(address || '');
    if (!addr.startsWith('/')) throw new Error(`OSC address must start with '/': ${JSON.stringify(addr)}`);
    const list = Array.isArray(args) ? args : [args];
    let tags = '';
    const parts = [];
    for (let i = 0; i < list.length; i++) {
        let v = list[i];
        let t = types && types[i] ? types[i] : inferType(v);
        if (t === 'T' || t === 'F') {
            if (!types || !types[i]) t = v ? 'T' : 'F';
        }
        tags += t;
        parts.push(encodeArg(t, v));
    }
    return Buffer.concat([oscString(addr), oscString(',' + tags), ...parts]);
}

/** Encode a bundle. elements: [{address, args, types}] or nested {bundle: [...], timetag}. */
export function encodeBundle(elements = [], timetag = 1) {
    const parts = [oscString('#bundle'), timetagBuf(timetag)];
    for (const el of elements) {
        const b = el && Array.isArray(el.bundle) ? encodeBundle(el.bundle, el.timetag) : encodeMessage(el.address, el.args, el.types);
        parts.push(int32(b.length), b);
    }
    return Buffer.concat(parts);
}

function readString(buf, o) {
    let end = o;
    while (end < buf.length && buf[end] !== 0) end++;
    if (end >= buf.length) throw new Error('unterminated OSC string');
    return { value: buf.toString('utf8', o, end), next: pad4(end + 1) };
}

function readTimetag(buf, o) {
    if (o + 8 > buf.length) throw new Error('truncated timetag');
    const secs = buf.readUInt32BE(o);
    const frac = buf.readUInt32BE(o + 4);
    if (secs === 0 && frac === 1) return 1; // "immediately"
    return secs + frac / 4294967296;
}

function decodeMessage(buf) {
    const a = readString(buf, 0);
    const address = a.value;
    if (!address.startsWith('/')) throw new Error('OSC address must start with /');
    let o = a.next;
    let types = '';
    const args = [];
    if (o < buf.length) {
        const t = readString(buf, o);
        o = t.next;
        if (!t.value.startsWith(',')) throw new Error('missing OSC type tag string');
        types = t.value.slice(1);
    }
    const need = (n) => { if (o + n > buf.length) throw new Error('truncated OSC argument'); };
    for (const t of types) {
        switch (t) {
            case 'i': need(4); args.push(buf.readInt32BE(o)); o += 4; break;
            case 'f': need(4); args.push(buf.readFloatBE(o)); o += 4; break;
            case 's': case 'S': { const s = readString(buf, o); args.push(s.value); o = s.next; break; }
            case 'c': need(4); args.push(String.fromCodePoint(buf.readInt32BE(o) || 0)); o += 4; break;
            case 'b': {
                need(4);
                const n = buf.readInt32BE(o);
                o += 4;
                if (n < 0) throw new Error('negative blob size');
                need(n);
                args.push(Array.from(buf.subarray(o, o + n)));
                o += pad4(n);
                break;
            }
            case 'h': need(8); args.push(Number(buf.readBigInt64BE(o))); o += 8; break;
            case 'd': need(8); args.push(buf.readDoubleBE(o)); o += 8; break;
            case 't': args.push(readTimetag(buf, o)); o += 8; break;
            case 'r': case 'm': need(4); args.push([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]); o += 4; break;
            case 'T': args.push(true); break;
            case 'F': args.push(false); break;
            case 'N': args.push(null); break;
            case 'I': args.push(1); break;
            case '[': case ']': break; // arrays: flattened
            default: throw new Error(`unsupported OSC type tag '${t}'`);
        }
    }
    return { address, types: types.replace(/[[\]]/g, ''), args };
}

/** Decode an OSC packet (message or bundle). Throws on malformed input. */
export function decodePacket(buf, depth = 0) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length < 4) throw new Error('OSC packet too short');
    if (buf[0] === 0x23 /* # */) {
        const head = readString(buf, 0);
        if (head.value !== '#bundle') throw new Error('bad OSC bundle header');
        if (depth > 8) throw new Error('OSC bundles nested too deeply');
        const timetag = readTimetag(buf, head.next);
        let o = head.next + 8;
        const elements = [];
        while (o + 4 <= buf.length) {
            const n = buf.readInt32BE(o);
            o += 4;
            if (n <= 0 || o + n > buf.length) throw new Error('bad OSC bundle element size');
            elements.push(decodePacket(buf.subarray(o, o + n), depth + 1));
            o += n;
        }
        return { bundle: true, timetag, elements };
    }
    return decodeMessage(buf);
}

/** Messages of a decoded packet in order (bundle time tags are not scheduled). */
export function flattenPacket(p, out = []) {
    if (!p) return out;
    if (p.bundle) for (const e of p.elements) flattenPacket(e, out);
    else out.push(p);
    return out;
}
