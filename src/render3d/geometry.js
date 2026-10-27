/**
 * CPU geometry for Render 3D (no DOM / GL): primitive generators.
 *
 * A mesh is { positions: Float32Array (xyz), normals (xyz), uvs (uv), colors? (rgba),
 * indices: Uint16Array | Uint32Array | null, mode: 'triangles' | 'lines' | 'points',
 * count (vertices or indices drawn), bounds: { min, max } }.
 * Conventions: Y up, right-handed, counter-clockwise front faces, uv (0,0) bottom-left.
 */

const TAU = Math.PI * 2;

class Builder {
    constructor() {
        this.p = [];
        this.n = [];
        this.uv = [];
        this.c = null;
        this.idx = [];
    }

    vertex(x, y, z, nx, ny, nz, u, v, color = null) {
        this.p.push(x, y, z);
        this.n.push(nx, ny, nz);
        this.uv.push(u, v);
        if (color) {
            if (!this.c) this.c = new Array((this.p.length / 3 - 1) * 4).fill(1);
            this.c.push(color[0], color[1], color[2], color[3]);
        } else if (this.c) {
            this.c.push(1, 1, 1, 1);
        }
        return this.p.length / 3 - 1;
    }

    tri(a, b, c) {
        this.idx.push(a, b, c);
    }

    quad(a, b, c, d) {
        // a b c d counter-clockwise
        this.idx.push(a, b, c, a, c, d);
    }

    build(mode = 'triangles') {
        return finishMesh({
            positions: new Float32Array(this.p),
            normals: new Float32Array(this.n),
            uvs: new Float32Array(this.uv),
            colors: this.c ? new Float32Array(this.c) : null,
            indices: this.idx.length ? this.idx : null,
            mode
        });
    }
}

/** Typed indices, bounds and draw count. */
export function finishMesh(m) {
    const vcount = m.positions.length / 3;
    if (m.indices && !(m.indices instanceof Uint16Array || m.indices instanceof Uint32Array)) {
        m.indices = vcount > 65535 ? new Uint32Array(m.indices) : new Uint16Array(m.indices);
    }
    m.count = m.indices ? m.indices.length : vcount;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            if (p[i + k] < min[k]) min[k] = p[i + k];
            if (p[i + k] > max[k]) max[k] = p[i + k];
        }
    }
    if (!vcount) { min.fill(0); max.fill(0); }
    m.bounds = { min, max };
    return m;
}

const clampInt = (v, lo, hi, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function box({ width = 1, height = 1, depth = 1, segments = 1 } = {}) {
    const b = new Builder();
    const s = clampInt(segments, 1, 64, 1);
    const w = num(width, 1) / 2, h = num(height, 1) / 2, d = num(depth, 1) / 2;
    // face: origin corner, u axis, v axis, normal (u x v = normal)
    const faces = [
        [[w, -h, d], [0, 0, -2 * d], [0, 2 * h, 0], [1, 0, 0]],     // +X
        [[-w, -h, -d], [0, 0, 2 * d], [0, 2 * h, 0], [-1, 0, 0]],   // -X
        [[-w, h, d], [2 * w, 0, 0], [0, 0, -2 * d], [0, 1, 0]],     // +Y
        [[-w, -h, -d], [2 * w, 0, 0], [0, 0, 2 * d], [0, -1, 0]],   // -Y
        [[-w, -h, d], [2 * w, 0, 0], [0, 2 * h, 0], [0, 0, 1]],     // +Z
        [[w, -h, -d], [-2 * w, 0, 0], [0, 2 * h, 0], [0, 0, -1]],   // -Z
    ];
    for (const [o, u, v, n] of faces) {
        const base = b.p.length / 3;
        for (let j = 0; j <= s; j++) {
            for (let i = 0; i <= s; i++) {
                const a = i / s, c = j / s;
                b.vertex(o[0] + u[0] * a + v[0] * c, o[1] + u[1] * a + v[1] * c, o[2] + u[2] * a + v[2] * c, n[0], n[1], n[2], a, c);
            }
        }
        for (let j = 0; j < s; j++) {
            for (let i = 0; i < s; i++) {
                const k = base + j * (s + 1) + i;
                b.quad(k, k + 1, k + s + 2, k + s + 1);
            }
        }
    }
    return b.build();
}

export function sphere({ radius = 0.75, segments = 48, rings = 24 } = {}) {
    const b = new Builder();
    const r = num(radius, 0.75);
    const ws = clampInt(segments, 3, 512, 48), hs = clampInt(rings, 2, 256, 24);
    for (let j = 0; j <= hs; j++) {
        const v = j / hs;
        const th = v * Math.PI; // 0 = top
        const st = Math.sin(th), ct = Math.cos(th);
        for (let i = 0; i <= ws; i++) {
            const u = i / ws;
            const ph = u * TAU;
            const x = -Math.cos(ph) * st, z = Math.sin(ph) * st, y = ct;
            b.vertex(x * r, y * r, z * r, x, y, z, u, 1 - v);
        }
    }
    for (let j = 0; j < hs; j++) {
        for (let i = 0; i < ws; i++) {
            const a = j * (ws + 1) + i, c = a + ws + 1;
            if (j !== 0) b.tri(a, c, a + 1);
            if (j !== hs - 1) b.tri(a + 1, c, c + 1);
        }
    }
    return b.build();
}

export function torus({ radius = 0.7, tube = 0.25, segments = 64, sides = 24 } = {}) {
    const b = new Builder();
    const R = num(radius, 0.7), r = num(tube, 0.25);
    const ns = clampInt(segments, 3, 1024, 64), nt = clampInt(sides, 3, 256, 24);
    for (let j = 0; j <= nt; j++) {
        const v = j / nt * TAU;
        for (let i = 0; i <= ns; i++) {
            const u = i / ns * TAU;
            const cx = Math.cos(u), cz = Math.sin(u);
            const nx = Math.cos(v) * cx, ny = Math.sin(v), nz = Math.cos(v) * cz;
            b.vertex(cx * R + nx * r, ny * r, cz * R + nz * r, nx, ny, nz, i / ns, j / nt);
        }
    }
    for (let j = 0; j < nt; j++) {
        for (let i = 0; i < ns; i++) {
            const a = j * (ns + 1) + i, c = a + ns + 1;
            b.quad(a, c, c + 1, a + 1);
        }
    }
    return b.build();
}

export function plane({ width = 10, depth = 10, segments = 1 } = {}) {
    const b = new Builder();
    const s = clampInt(segments, 1, 1024, 1);
    const w = num(width, 10), d = num(depth, 10);
    for (let j = 0; j <= s; j++) {
        for (let i = 0; i <= s; i++) {
            const u = i / s, v = j / s;
            b.vertex((u - 0.5) * w, 0, (0.5 - v) * d, 0, 1, 0, u, v);
        }
    }
    for (let j = 0; j < s; j++) {
        for (let i = 0; i < s; i++) {
            const k = j * (s + 1) + i;
            b.quad(k, k + 1, k + s + 2, k + s + 1);
        }
    }
    return b.build();
}

export function grid({ width = 10, depth = 10, divisions = 20 } = {}) {
    const b = new Builder();
    const n = clampInt(divisions, 1, 1000, 20);
    const w = num(width, 10), d = num(depth, 10);
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = (t - 0.5) * w, z = (t - 0.5) * d;
        const a = b.vertex(x, 0, -d / 2, 0, 1, 0, t, 0);
        const c = b.vertex(x, 0, d / 2, 0, 1, 0, t, 1);
        b.idx.push(a, c);
        const e = b.vertex(-w / 2, 0, z, 0, 1, 0, 0, t);
        const f = b.vertex(w / 2, 0, z, 0, 1, 0, 1, t);
        b.idx.push(e, f);
    }
    return b.build('lines');
}

export function cylinder({ radius = 0.5, topRadius = 0.5, height = 1.5, segments = 40 } = {}) {
    const b = new Builder();
    const r0 = Math.max(0, num(radius, 0.5)), r1 = Math.max(0, num(topRadius, 0.5)), h = num(height, 1.5);
    const ns = clampInt(segments, 3, 512, 40);
    const slope = (r0 - r1) / Math.max(h, 1e-6);
    const nl = Math.hypot(1, slope);
    // side (duplicate seam)
    for (let j = 0; j <= 1; j++) {
        const y = (j - 0.5) * h, r = j ? r1 : r0;
        for (let i = 0; i <= ns; i++) {
            const u = i / ns, a = u * TAU;
            const cx = Math.sin(a), cz = Math.cos(a);
            b.vertex(cx * r, y, cz * r, cx / nl, slope / nl, cz / nl, u, j);
        }
    }
    for (let i = 0; i < ns; i++) b.quad(i, i + 1, i + ns + 2, i + ns + 1);
    // caps
    for (const [y, r, ny] of [[-h / 2, r0, -1], [h / 2, r1, 1]]) {
        if (r <= 0) continue;
        const c = b.vertex(0, y, 0, 0, ny, 0, 0.5, 0.5);
        const first = b.p.length / 3;
        for (let i = 0; i <= ns; i++) {
            const a = i / ns * TAU;
            b.vertex(Math.sin(a) * r, y, Math.cos(a) * r, 0, ny, 0, 0.5 + Math.sin(a) * 0.5, 0.5 + Math.cos(a) * 0.5);
        }
        for (let i = 0; i < ns; i++) {
            if (ny > 0) b.tri(c, first + i, first + i + 1);
            else b.tri(c, first + i + 1, first + i);
        }
    }
    return b.build();
}

export function torusKnot({ radius = 0.8, tube = 0.22, p = 2, q = 3, segments = 256, sides = 20 } = {}) {
    const b = new Builder();
    const R = num(radius, 0.8), r = num(tube, 0.22);
    const P = clampInt(p, 1, 20, 2), Q = clampInt(q, 1, 20, 3);
    const ns = clampInt(segments, 8, 4096, 256), nt = clampInt(sides, 3, 128, 20);
    const curve = (u, out) => {
        const cu = Math.cos(u), su = Math.sin(u), quOverP = Q / P * u, cs = Math.cos(quOverP);
        out[0] = R * (2 + cs) * 0.5 * cu;
        out[1] = R * Math.sin(quOverP) * 0.5;
        out[2] = R * (2 + cs) * 0.5 * su;
    };
    const P1 = [0, 0, 0], P2 = [0, 0, 0];
    for (let i = 0; i <= ns; i++) {
        const u = i / ns * P * TAU;
        curve(u, P1);
        curve(u + 0.01, P2);
        const T = [P2[0] - P1[0], P2[1] - P1[1], P2[2] - P1[2]];
        const Nn = [P2[0] + P1[0], P2[1] + P1[1], P2[2] + P1[2]];
        const B = cross(T, Nn);
        const N = cross(B, T);
        norm(B); norm(N);
        for (let j = 0; j <= nt; j++) {
            const v = j / nt * TAU;
            const cx = -r * Math.cos(v), cy = r * Math.sin(v);
            const x = P1[0] + (cx * N[0] + cy * B[0]);
            const y = P1[1] + (cx * N[1] + cy * B[1]);
            const z = P1[2] + (cx * N[2] + cy * B[2]);
            const n = [x - P1[0], y - P1[1], z - P1[2]];
            norm(n);
            b.vertex(x, y, z, n[0], n[1], n[2], i / ns, j / nt);
        }
    }
    for (let i = 0; i < ns; i++) {
        for (let j = 0; j < nt; j++) {
            const a = (nt + 1) * i + j, bb = (nt + 1) * (i + 1) + j;
            b.quad(a, bb, bb + 1, a + 1);
        }
    }
    return b.build();
}

/**
 * A low-poly bird, body along +Z (head at +Z), wings along X. Vertex colour a = signed
 * wing weight (0 on the body, -1 / +1 at the left / right wing tips), rgb = 1 (body) or
 * a slightly darker tone on the wing tips. Flat shaded (faces don't share vertices).
 */
export function bird({ size = 1, span = 1 } = {}) {
    const S = num(size, 1), W = num(span, 1);
    const b = new Builder();
    const tris = [];
    const P = (x, y, z) => [x * S, y * S, z * S];
    // body: a stretched octahedron-ish fuselage
    const nose = P(0, 0.02, 0.55), tail = P(0, 0.03, -0.45), top = P(0, 0.12, 0.05), bot = P(0, -0.08, 0.05);
    const l = P(-0.09, 0.0, 0.08), r = P(0.09, 0.0, 0.08);
    const bodyCol = [1, 1, 1, 0];
    tris.push([nose, top, l, bodyCol], [nose, r, top, bodyCol], [nose, l, bot, bodyCol], [nose, bot, r, bodyCol]);
    tris.push([tail, l, top, bodyCol], [tail, top, r, bodyCol], [tail, bot, l, bodyCol], [tail, r, bot, bodyCol]);
    // tail fan
    const tl = P(-0.12, 0.03, -0.6), tr = P(0.12, 0.03, -0.6);
    tris.push([tail, tl, tr, bodyCol], [tail, tr, tl, bodyCol]);
    // wings: root at the body, mid joint, tip (weights 0 -> 0.5 -> 1)
    for (const s of [-1, 1]) {
        const root0 = P(0.06 * s, 0.02, 0.18), root1 = P(0.06 * s, 0.02, -0.12);
        const mid0 = P(0.42 * s * W, 0.03, 0.12), mid1 = P(0.42 * s * W, 0.03, -0.14);
        const tip = P(0.85 * s * W, 0.04, -0.12);
        const c0 = [1, 1, 1, 0], cm = [0.92, 0.92, 0.95, 0.5 * s], ct = [0.8, 0.8, 0.88, s];
        const wt = (a, ca, bb, cb, c, cc) => {
            tris.push([a, bb, c, null, [ca, cb, cc]]);
            tris.push([a, c, bb, null, [ca, cc, cb]]); // both sides (thin)
        };
        wt(root0, c0, mid0, cm, mid1, cm);
        wt(root0, c0, mid1, cm, root1, c0);
        wt(mid0, cm, tip, ct, mid1, cm);
    }
    for (const t of tris) {
        const [a, bb, c] = t;
        const cols = t[4] || [t[3], t[3], t[3]];
        const e1 = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = cross(e1, e2);
        norm(n);
        const i0 = b.vertex(a[0], a[1], a[2], n[0], n[1], n[2], 0, 0, cols[0]);
        const i1 = b.vertex(bb[0], bb[1], bb[2], n[0], n[1], n[2], 1, 0, cols[1]);
        const i2 = b.vertex(c[0], c[1], c[2], n[0], n[1], n[2], 0, 1, cols[2]);
        b.tri(i0, i1, i2);
    }
    return b.build();
}

/**
 * Extruded text: the string is rasterized (canvas) at `resolution` pixels per line, every
 * horizontal run of filled pixels becomes a box `depth` deep (front / back faces, top /
 * bottom / end caps). Centered on the origin, facing +Z, `size` = line height. Lines split
 * on \n. Needs a canvas (browser).
 */
export function text({ text: str = 'PatchToy', size = 1, depth = 0.25, resolution = 48, bold = 1 } = {}) {
    const b = new Builder();
    const res = clampInt(resolution, 8, 160, 48);
    const lines = String(str ?? '').slice(0, 200).split('\n');
    const font = `${bold ? 'bold ' : ''}${res}px "Pixeloid Sans", ui-sans-serif, sans-serif`;
    const mk = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null));
    const probe = mk(8, 8);
    if (!probe) return b.build();
    let ctx = probe.getContext('2d');
    ctx.font = font;
    const width = Math.max(1, Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width))) + 4);
    const lineH = Math.ceil(res * 1.2);
    const height = lineH * lines.length + 4;
    const cv = mk(width, height);
    ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    lines.forEach((l, i) => ctx.fillText(l, 2, 2 + lineH * (i + 0.5)));
    const img = ctx.getImageData(0, 0, width, height).data;
    const px = num(size, 1) / lineH;
    const d = Math.max(0, num(depth, 0.25)) / 2;
    const ox = -width / 2, oy = height / 2;
    const filled = (x, y) => x >= 0 && y >= 0 && x < width && y < height && img[(y * width + x) * 4 + 3] > 110;
    const quad = (p0, p1, p2, p3, n) => {
        const i0 = b.vertex(...p0, ...n, 0, 0), i1 = b.vertex(...p1, ...n, 1, 0), i2 = b.vertex(...p2, ...n, 1, 1), i3 = b.vertex(...p3, ...n, 0, 1);
        b.quad(i0, i1, i2, i3);
    };
    for (let y = 0; y < height; y++) {
        let x = 0;
        while (x < width) {
            if (!filled(x, y)) { x++; continue; }
            const x0 = x;
            while (x < width && filled(x, y)) x++;
            const X0 = (x0 + ox) * px, X1 = (x + ox) * px, Y0 = (oy - y - 1) * px, Y1 = (oy - y) * px;
            quad([X0, Y0, d], [X1, Y0, d], [X1, Y1, d], [X0, Y1, d], [0, 0, 1]);
            quad([X1, Y0, -d], [X0, Y0, -d], [X0, Y1, -d], [X1, Y1, -d], [0, 0, -1]);
            quad([X0, Y0, -d], [X0, Y0, d], [X0, Y1, d], [X0, Y1, -d], [-1, 0, 0]);
            quad([X1, Y0, d], [X1, Y0, -d], [X1, Y1, -d], [X1, Y1, d], [1, 0, 0]);
            // top / bottom faces only where the neighbour row is empty (per pixel)
            for (let k = x0; k < x; k++) {
                const a = (k + ox) * px, c = (k + 1 + ox) * px;
                if (!filled(k, y - 1)) quad([a, Y1, d], [c, Y1, d], [c, Y1, -d], [a, Y1, -d], [0, 1, 0]);
                if (!filled(k, y + 1)) quad([a, Y0, -d], [c, Y0, -d], [c, Y0, d], [a, Y0, d], [0, -1, 0]);
            }
        }
    }
    return b.build();
}

/** Point sprites: no vertices; the renderer draws `count` points (gl_VertexID = instance id). */
export function points() {
    return { positions: new Float32Array(0), normals: null, uvs: null, colors: null, indices: null, mode: 'points', count: 0, bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
}

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    v[0] /= l; v[1] /= l; v[2] /= l;
    return v;
}

export const GENERATORS = {
    box, sphere, torus, plane, grid, cylinder, torusknot: torusKnot, bird, points, text,
};

/** Build the mesh of a geometry kind from its params ({ name: value }). */
export function buildGeometry(kind, params) {
    const gen = GENERATORS[kind] || box;
    return gen(params || {});
}
