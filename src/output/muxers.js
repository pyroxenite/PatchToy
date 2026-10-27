/**
 * Minimal containers for the offline exporter (WebCodecs EncodedVideoChunks),
 * plus a store-only zip writer for PNG sequences and a duration fixer for
 * MediaRecorder WebM files. Video only, everything in memory.
 *
 *   WebMMuxer   VP8 / VP9 (or AV1) in WebM: Info (with Duration), Tracks, Cues
 *               written before the Clusters (fixed-width positions, no SeekHead
 *               needed), one Cluster per key frame.
 *   MP4Muxer    H.264 (avcC from the encoder's decoderConfig.description),
 *               "faststart" layout: ftyp, moov, mdat; ctts only when the encoder
 *               reorders frames.
 *   ZipWriter   store-only zip (no compression: PNGs are already deflated).
 */

// ----------------------------------------------------------------------
// Byte helpers
// ----------------------------------------------------------------------

function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

const te = new TextEncoder();

function u8(...bytes) { return new Uint8Array(bytes); }
function u16(v) { return u8((v >>> 8) & 255, v & 255); }
function u32(v) { return u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
function i32(v) { return u32(v >>> 0); }

// ----------------------------------------------------------------------
// EBML / WebM
// ----------------------------------------------------------------------

function ebmlId(id) {
    const out = [];
    let v = id;
    while (v > 0) { out.unshift(v & 255); v = Math.floor(v / 256); }
    return new Uint8Array(out);
}

function vint(n, width = 0) {
    let len = width;
    if (!len) {
        len = 1;
        while (len < 8 && n >= Math.pow(2, 7 * len) - 1) len++;
    }
    const out = new Uint8Array(len);
    let v = n;
    for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
    out[0] |= 1 << (8 - len);
    return out;
}

function uintBytes(v, width = 0) {
    const out = [];
    let x = Math.max(0, Math.floor(v));
    do { out.unshift(x % 256); x = Math.floor(x / 256); } while (x > 0);
    while (width && out.length < width) out.unshift(0);
    return new Uint8Array(out);
}

function el(id, payload) {
    const data = payload instanceof Uint8Array ? payload : concat(payload);
    return concat([ebmlId(id), vint(data.length), data]);
}
const elUint = (id, v, width = 0) => el(id, uintBytes(v, width));
const elStr = (id, s) => el(id, te.encode(s));
function elFloat(id, v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    return el(id, b);
}

const WEBM_CODEC_IDS = { vp8: 'V_VP8', vp09: 'V_VP9', vp9: 'V_VP9', av01: 'V_AV1' };

export class WebMMuxer {
    /** codec: the WebCodecs codec string ('vp8', 'vp09.00.40.08', 'av01...') */
    constructor({ width, height, fps, codec }) {
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.codecId = WEBM_CODEC_IDS[String(codec).split('.')[0]] || 'V_VP9';
        this.frames = []; // { data, ms, key }
        this.codecPrivate = null;
    }

    addChunk(chunk, meta) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.codecPrivate) {
            this.codecPrivate = new Uint8Array(meta.decoderConfig.description.buffer || meta.decoderConfig.description);
        }
        this.frames.push({ data, ms: Math.round(chunk.timestamp / 1000), key: chunk.type === 'key' });
    }

    finalize() {
        const frameMs = 1000 / this.fps;
        const last = this.frames[this.frames.length - 1];
        const durationMs = last ? this.frames.length * frameMs : 0;

        const header = el(0x1A45DFA3, [
            elUint(0x4286, 1), elUint(0x42F7, 1), elUint(0x42F2, 4), elUint(0x42F3, 8),
            elStr(0x4282, 'webm'), elUint(0x4287, 4), elUint(0x4285, 2)
        ]);
        const info = el(0x1549A966, [
            elUint(0x2AD7B1, 1000000),
            elStr(0x4D80, 'PatchToy'),
            elStr(0x5741, 'PatchToy offline export'),
            elFloat(0x4489, durationMs)
        ]);
        const trackParts = [
            elUint(0xD7, 1), elUint(0x73C5, 1), elUint(0x83, 1), elUint(0x9C, 0),
            elStr(0x86, this.codecId),
            elUint(0x23E383, Math.round(1e9 / this.fps))
        ];
        if (this.codecPrivate && this.codecId === 'V_AV1') trackParts.push(el(0x63A2, this.codecPrivate));
        trackParts.push(el(0xE0, [elUint(0xB0, this.width), elUint(0xBA, this.height)]));
        const tracks = el(0x1654AE6B, [el(0xAE, trackParts)]);

        // Clusters: a new one at every key frame (and at least every 30 s: int16 block times)
        const clusters = [];
        let cur = null;
        for (const f of this.frames) {
            if (!cur || f.key || f.ms - cur.ms > 30000) {
                cur = { ms: f.ms, blocks: [] };
                clusters.push(cur);
            }
            const rel = f.ms - cur.ms;
            const head = u8(0x81, (rel >> 8) & 255, rel & 255, f.key ? 0x80 : 0x00);
            cur.blocks.push(el(0xA3, concat([head, f.data])));
        }
        const clusterBytes = clusters.map(c => el(0x1F43B675, [elUint(0xE7, c.ms), ...c.blocks]));

        // Cues before the clusters: CueClusterPosition is fixed-width, so the Cues size
        // does not depend on the positions it stores
        const buildCues = (positions) => el(0x1C53BB6B, clusters.map((c, i) => el(0xBB, [
            elUint(0xB3, c.ms),
            el(0xB7, [elUint(0xF7, 1), elUint(0xF1, positions[i] || 0, 8)])
        ])));
        const cuesSize = buildCues([]).length;
        const positions = [];
        let pos = info.length + tracks.length + cuesSize;
        for (const cb of clusterBytes) { positions.push(pos); pos += cb.length; }
        const cues = buildCues(positions);

        const segmentData = concat([info, tracks, cues, ...clusterBytes]);
        const segment = concat([ebmlId(0x18538067), vint(segmentData.length, 8), segmentData]);
        return { bytes: concat([header, segment]), durationMs, frames: this.frames.length, mime: 'video/webm' };
    }
}

// ----------------------------------------------------------------------
// MP4 (ISO BMFF), H.264
// ----------------------------------------------------------------------

function fourcc(s) { return te.encode(s); }
function box(type, ...parts) {
    const payload = concat(parts.flat());
    return concat([u32(payload.length + 8), fourcc(type), payload]);
}
function fullbox(type, version, flags, ...parts) {
    return box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
}
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

export class MP4Muxer {
    constructor({ width, height, fps }) {
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.timescale = Math.round(fps * 1000);
        this.delta = 1000;
        this.samples = []; // { data, pts (timescale units), key }
        this.avcC = null;
    }

    addChunk(chunk, meta) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (meta && meta.decoderConfig && meta.decoderConfig.description) {
            const d = meta.decoderConfig.description;
            this.avcC = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
        }
        this.samples.push({ data, pts: Math.round(chunk.timestamp * this.timescale / 1e6), key: chunk.type === 'key' });
    }

    finalize() {
        if (!this.avcC) throw new Error('MP4: the encoder gave no avcC description (H.264 "avc" format needed)');
        const n = this.samples.length;
        const ts = this.timescale;
        const t0 = n ? Math.min(...this.samples.map(s => s.pts)) : 0;
        const offsets = this.samples.map((s, i) => (s.pts - t0) - i * this.delta);
        const reordered = offsets.some(o => o !== 0);
        const duration = n * this.delta;
        const durationMs = Math.round(duration * 1000 / ts);
        const w = this.width, h = this.height;

        const avc1 = box('avc1',
            u8(0, 0, 0, 0, 0, 0), u16(1),             // reserved, data_reference_index
            u16(0), u16(0), u32(0), u32(0), u32(0),   // pre_defined, reserved
            u16(w), u16(h),
            u32(0x00480000), u32(0x00480000), u32(0), u16(1),
            new Uint8Array(32),                       // compressorname
            u16(0x0018), u16(0xFFFF),
            box('avcC', this.avcC),
            box('pasp', u32(1), u32(1))
        );
        const stsd = fullbox('stsd', 0, 0, u32(1), avc1);
        const stts = fullbox('stts', 0, 0, u32(1), u32(n), u32(this.delta));
        const keys = [];
        this.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
        const stss = fullbox('stss', 0, 0, u32(keys.length), ...keys.map(k => u32(k)));
        const stsc = fullbox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
        const stsz = fullbox('stsz', 0, 0, u32(0), u32(n), ...this.samples.map(s => u32(s.data.length)));
        const ctts = reordered ? fullbox('ctts', 1, 0, u32(n), ...offsets.flatMap(o => [u32(1), i32(o)])) : null;

        const build = (chunkOffset) => {
            const stco = fullbox('stco', 0, 0, u32(1), u32(chunkOffset));
            const stbl = box('stbl', stsd, stts, ...(ctts ? [ctts] : []), stss, stsc, stsz, stco);
            const minf = box('minf',
                fullbox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
                box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1))),
                stbl);
            const mdia = box('mdia',
                fullbox('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(duration), u16(0x55C4), u16(0)),
                fullbox('hdlr', 0, 0, u32(0), fourcc('vide'), u32(0), u32(0), u32(0), te.encode('VideoHandler\0')),
                minf);
            const tkhd = fullbox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durationMs),
                u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), ...MATRIX.map(u32), u32(w * 65536), u32(h * 65536));
            const trak = box('trak', tkhd, mdia);
            const mvhd = fullbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durationMs), u32(0x00010000), u16(0x0100), u16(0),
                u32(0), u32(0), ...MATRIX.map(u32), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(2));
            return box('moov', mvhd, trak);
        };

        const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));
        const moovSize = build(0).length;
        const mdatPayload = concat(this.samples.map(s => s.data));
        if (mdatPayload.length + 8 > 0xFFFFFFFF) throw new Error('MP4: export larger than 4 GB, use WebM or a PNG sequence');
        const moov = build(ftyp.length + moovSize + 8);
        const mdat = concat([u32(mdatPayload.length + 8), fourcc('mdat'), mdatPayload]);
        return { bytes: concat([ftyp, moov, mdat]), durationMs, frames: n, mime: 'video/mp4', reordered };
    }
}

// ----------------------------------------------------------------------
// Zip (store only)
// ----------------------------------------------------------------------

let CRC_TABLE = null;
function crc32(data) {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function le16(v) { return u8(v & 255, (v >>> 8) & 255); }
function le32(v) { return u8(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }

export class ZipWriter {
    constructor() {
        this.parts = [];
        this.central = [];
        this.offset = 0;
        this.count = 0;
    }

    add(name, data) {
        const nameBytes = te.encode(name);
        const crc = crc32(data);
        const local = concat([le32(0x04034b50), le16(20), le16(0), le16(0), le16(0), le16(0x21),
            le32(crc), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), nameBytes]);
        this.central.push(concat([le32(0x02014b50), le16(20), le16(20), le16(0), le16(0), le16(0), le16(0x21),
            le32(crc), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0),
            le32(0), le32(this.offset), nameBytes]));
        this.parts.push(local, data);
        this.offset += local.length + data.length;
        this.count++;
        if (this.offset > 0xFFFFFFFF) throw new Error('Zip larger than 4 GB: export the PNG sequence to a folder instead');
    }

    finalize() {
        const cd = concat(this.central);
        const eocd = concat([le32(0x06054b50), le16(0), le16(0), le16(this.count), le16(this.count),
            le32(cd.length), le32(this.offset), le16(0)]);
        return new Blob([...this.parts, cd, eocd], { type: 'application/zip' });
    }
}

// ----------------------------------------------------------------------
// MediaRecorder WebM: add the missing Duration (players can then seek)
// ----------------------------------------------------------------------

function readVint(b, o, isId = false) {
    const first = b[o];
    if (first === undefined) return null;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8) return null;
    let value = isId ? first : first & ((0x80 >> (len - 1)) - 1);
    let unknown = !isId && value === (0x80 >> (len - 1)) - 1;
    for (let i = 1; i < len; i++) {
        value = value * 256 + b[o + i];
        if (!isId && b[o + i] !== 255) unknown = false;
    }
    return { value, len, unknown };
}

/**
 * Insert (or overwrite) Segment > Info > Duration in a WebM file. Returns a new
 * Uint8Array, or the input unchanged when the layout is not the simple one
 * MediaRecorder writes (no SeekHead before Info).
 */
export function fixWebmDuration(bytes, durationMs) {
    try {
        const b = bytes;
        let o = 0;
        const hid = readVint(b, o, true); if (!hid || hid.value !== 0x1A45DFA3) return bytes;
        const hsz = readVint(b, o + hid.len);
        o += hid.len + hsz.len + hsz.value;
        const sid = readVint(b, o, true); if (!sid || sid.value !== 0x18538067) return bytes;
        const ssz = readVint(b, o + sid.len);
        const segSizeAt = o + sid.len;
        const segData = segSizeAt + ssz.len;
        let p = segData;
        while (p < b.length) {
            const id = readVint(b, p, true);
            const sz = readVint(b, p + id.len);
            if (!id || !sz) return bytes;
            if (id.value === 0x114D9B74) return bytes; // SeekHead: positions would shift
            if (id.value === 0x1549A966) {
                const start = p + id.len + sz.len;
                const end = start + sz.value;
                const children = [];
                let q = start;
                while (q < end) {
                    const cid = readVint(b, q, true);
                    const csz = readVint(b, q + cid.len);
                    const total = cid.len + csz.len + csz.value;
                    if (cid.value !== 0x4489) children.push(b.subarray(q, q + total));
                    q += total;
                }
                children.push(elFloat(0x4489, durationMs));
                const info = el(0x1549A966, children);
                const delta = info.length - (end - p);
                const parts = [b.subarray(0, segSizeAt)];
                if (ssz.unknown) parts.push(b.subarray(segSizeAt, segData));
                else parts.push(vint(ssz.value + delta, ssz.len));
                parts.push(b.subarray(segData, p), info, b.subarray(end));
                return concat(parts);
            }
            if (id.value === 0x1F43B675) return bytes; // reached the clusters without an Info
            p += id.len + sz.len + sz.value;
        }
    } catch (e) { /* leave the file as it is */ }
    return bytes;
}
