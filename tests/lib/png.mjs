/**
 * Minimal PNG codec for the test suites (no dependencies, node:zlib only).
 *
 *   decodePNG(buffer)                  -> { width, height, data: Uint8Array RGBA }
 *   encodePNG({ width, height, data }, { channels = 4 | 3 }) -> Buffer
 *
 * Decodes 8-bit non-interlaced PNGs of colour type 0 (grey), 2 (RGB), 3 (palette),
 * 4 (grey + alpha) and 6 (RGBA): what Chrome's canvas.toDataURL and the encoder
 * below produce. Encodes RGB or RGBA with per-row adaptive filtering (smaller goldens).
 */
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

export function decodePNG(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG file');
    let o = 8;
    let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
    let palette = null, trns = null;
    const idat = [];
    while (o + 8 <= buf.length) {
        const len = buf.readUInt32BE(o);
        const type = buf.toString('latin1', o + 4, o + 8);
        const body = buf.subarray(o + 8, o + 8 + len);
        o += 12 + len;
        if (type === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            depth = body[8];
            ctype = body[9];
            interlace = body[12];
        } else if (type === 'PLTE') palette = body;
        else if (type === 'tRNS') trns = body;
        else if (type === 'IDAT') idat.push(body);
        else if (type === 'IEND') break;
    }
    if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
    if (interlace) throw new Error('interlaced PNGs are not supported');
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
    if (!channels) throw new Error(`unsupported PNG colour type ${ctype}`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const px = new Uint8Array(stride * height);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = px.subarray(y * stride, (y + 1) * stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? cur[i - channels] : 0;
            const b = prev[i];
            const c = i >= channels ? prev[i - channels] : 0;
            let v = line[i];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) v += paeth(a, b, c);
            cur[i] = v & 0xff;
        }
        prev = cur;
    }
    const data = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += channels) {
        const d = i * 4;
        if (ctype === 6) { data[d] = px[j]; data[d + 1] = px[j + 1]; data[d + 2] = px[j + 2]; data[d + 3] = px[j + 3]; }
        else if (ctype === 2) { data[d] = px[j]; data[d + 1] = px[j + 1]; data[d + 2] = px[j + 2]; data[d + 3] = 255; }
        else if (ctype === 0) { data[d] = data[d + 1] = data[d + 2] = px[j]; data[d + 3] = 255; }
        else if (ctype === 4) { data[d] = data[d + 1] = data[d + 2] = px[j]; data[d + 3] = px[j + 1]; }
        else {
            const k = px[j];
            data[d] = palette[k * 3]; data[d + 1] = palette[k * 3 + 1]; data[d + 2] = palette[k * 3 + 2];
            data[d + 3] = trns && k < trns.length ? trns[k] : 255;
        }
    }
    return { width, height, data };
}

function chunk(type, body) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
}

/** Encode RGBA pixels. channels 3 drops alpha (opaque renders: 25% smaller). */
export function encodePNG({ width, height, data }, { channels = 4, level = 9 } = {}) {
    const stride = width * channels;
    const src = new Uint8Array(stride * height);
    for (let i = 0, j = 0; i < width * height; i++, j += channels) {
        src[j] = data[i * 4]; src[j + 1] = data[i * 4 + 1]; src[j + 2] = data[i * 4 + 2];
        if (channels === 4) src[j + 3] = data[i * 4 + 3];
    }
    const out = Buffer.alloc((stride + 1) * height);
    const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const cur = src.subarray(y * stride, (y + 1) * stride);
        let best = 0, bestScore = Infinity;
        for (let f = 0; f < 5; f++) {
            const line = cand[f];
            let score = 0;
            for (let i = 0; i < stride; i++) {
                const a = i >= channels ? cur[i - channels] : 0;
                const b = prev[i];
                const c = i >= channels ? prev[i - channels] : 0;
                const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
                const v = (cur[i] - p) & 0xff;
                line[i] = v;
                score += v < 128 ? v : 256 - v;
            }
            if (score < bestScore) { bestScore = score; best = f; }
        }
        out[y * (stride + 1)] = best;
        out.set(cand[best], y * (stride + 1) + 1);
        prev = cur;
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = channels === 4 ? 6 : 2;
    return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level })), chunk('IEND', Buffer.alloc(0))]);
}
