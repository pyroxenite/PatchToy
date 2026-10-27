/**
 * Projection-mapping calibration for the output window (src/output/OutputWindow.js).
 *
 * Coordinates
 *   content space  (u, v) in 0..1, origin top-left: the rendered Preview frame.
 *   output space   (x, y) in 0..1, origin top-left: the output window / projector.
 *
 * The warp maps content -> output in two stages:
 *   1. grid warp: g(u, v) = (u, v) + bicubic (Catmull-Rom) interpolation of the
 *      N x N control point offsets (content space; N = 3 or 5, 0 = off)
 *   2. keystone: a homography H from the unit square to the 4 corners
 *      (TL, TR, BR, BL) in output space.
 * Edge blend (feathered edges with curve + gamma) is applied in content space,
 * so it follows the warped image; the polygon mask is in output space.
 *
 * Calibrations are stored per display (see displayKey in OutputWindow.js):
 * in the project (graph data .output.calibrations, see OutputManager) and in
 * localStorage as a per-machine fallback.
 */

export const GRID_SIZES = [0, 3, 5];
export const PATTERNS = ['off', 'grid', 'bars', 'white'];
const LS_KEY = 'patchtoy_output_calibrations';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function defaultCalibration() {
    return {
        corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
        gridSize: 0,
        grid: [],                 // gridSize^2 offsets [du, dv], row-major (v rows)
        blend: { left: 0, right: 0, top: 0, bottom: 0, curve: 2, gamma: 2.2 },
        mask: { points: [], invert: false, feather: 4 },
        pattern: 'off'
    };
}

/** Sanitize stored / user data into a complete calibration object. */
export function normalizeCalibration(c) {
    const d = defaultCalibration();
    if (!c || typeof c !== 'object') return d;
    if (Array.isArray(c.corners) && c.corners.length === 4) {
        d.corners = c.corners.map((p, i) => [num(p && p[0], d.corners[i][0]), num(p && p[1], d.corners[i][1])]);
    }
    const n = GRID_SIZES.includes(Number(c.gridSize)) ? Number(c.gridSize) : 0;
    d.gridSize = n;
    d.grid = gridOffsets(n, c.grid);
    if (c.blend && typeof c.blend === 'object') {
        for (const k of ['left', 'right', 'top', 'bottom']) d.blend[k] = clamp(num(c.blend[k], 0), 0, 0.5);
        d.blend.curve = clamp(num(c.blend.curve, 2), 0.5, 6);
        d.blend.gamma = clamp(num(c.blend.gamma, 2.2), 0.5, 4);
    }
    if (c.mask && typeof c.mask === 'object') {
        d.mask.points = Array.isArray(c.mask.points)
            ? c.mask.points.slice(0, 32).map(p => [clamp(num(p && p[0], 0), -1, 2), clamp(num(p && p[1], 0), -1, 2)])
            : [];
        d.mask.invert = !!c.mask.invert;
        d.mask.feather = clamp(num(c.mask.feather, 4), 0, 200);
    }
    d.pattern = PATTERNS.includes(c.pattern) ? c.pattern : 'off';
    return d;
}

function gridOffsets(n, prev) {
    const out = [];
    for (let i = 0; i < n * n; i++) {
        const p = Array.isArray(prev) && prev.length === n * n ? prev[i] : null;
        out.push([num(p && p[0], 0), num(p && p[1], 0)]);
    }
    return out;
}

/** Change the grid resolution (offsets are resampled from the old grid). */
export function setGridSize(cal, n) {
    if (!GRID_SIZES.includes(n)) n = 0;
    if (n === cal.gridSize) return;
    const next = [];
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const u = i / (n - 1), v = j / (n - 1);
            next.push(cal.gridSize ? gridDisplacement(cal, u, v) : [0, 0]);
        }
    }
    cal.gridSize = n;
    cal.grid = next;
}

export function isIdentity(cal) {
    const c = cal.corners;
    const id = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) if (Math.abs(c[i][0] - id[i][0]) > 1e-6 || Math.abs(c[i][1] - id[i][1]) > 1e-6) return false;
    if (cal.gridSize && cal.grid.some(p => Math.abs(p[0]) > 1e-6 || Math.abs(p[1]) > 1e-6)) return false;
    return true;
}

// ----------------------------------------------------------------------
// Homography (Heckbert, square -> quad)
// ----------------------------------------------------------------------

/** 3x3 row-major matrix mapping (u, v, 1) in the unit square onto the quad TL, TR, BR, BL. */
export function squareToQuad(corners) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners;
    const dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
    if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
        return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
    }
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const det = dx1 * dy2 - dx2 * dy1 || 1e-12;
    const g = (dx3 * dy2 - dx2 * dy3) / det;
    const h = (dx1 * dy3 - dx3 * dy1) / det;
    return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-14) return null;
    const k = 1 / det;
    return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
        B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
        C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/** Apply a 3x3 matrix to (x, y, 1): returns homogeneous [X, Y, W]. */
export function applyH(m, x, y) {
    return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5], m[6] * x + m[7] * y + m[8]];
}

export function project(m, x, y) {
    const [X, Y, W] = applyH(m, x, y);
    return [X / W, Y / W];
}

// ----------------------------------------------------------------------
// Grid warp (Catmull-Rom across the control points, clamped at the edges)
// ----------------------------------------------------------------------

function cr(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Interpolated grid offset [du, dv] at content position (u, v). */
export function gridDisplacement(cal, u, v) {
    const n = cal.gridSize;
    if (!n) return [0, 0];
    const g = cal.grid;
    const fx = clamp(u, 0, 1) * (n - 1), fy = clamp(v, 0, 1) * (n - 1);
    const ix = Math.min(n - 2, Math.floor(fx)), iy = Math.min(n - 2, Math.floor(fy));
    const tx = fx - ix, ty = fy - iy;
    const at = (i, j, k) => g[clamp(j, 0, n - 1) * n + clamp(i, 0, n - 1)][k];
    const out = [0, 0];
    for (let k = 0; k < 2; k++) {
        const rows = [];
        for (let dj = -1; dj <= 2; dj++) {
            const j = iy + dj;
            rows.push(cr(at(ix - 1, j, k), at(ix, j, k), at(ix + 1, j, k), at(ix + 2, j, k), tx));
        }
        out[k] = cr(rows[0], rows[1], rows[2], rows[3], ty);
    }
    return out;
}

/** Content (u, v) -> output (x, y): grid warp then keystone. */
export function warpPoint(cal, H, u, v) {
    const d = gridDisplacement(cal, u, v);
    return project(H, u + d[0], v + d[1]);
}

/**
 * Warp mesh for the GPU: per vertex [clipX, clipY, 0, clipW] (homogeneous, so the
 * rasterizer interpolates the content uv perspective-correctly) and the content uv.
 */
export function buildMesh(cal, segments = 40) {
    const H = squareToQuad(cal.corners);
    const n = segments + 1;
    const pos = new Float32Array(n * n * 4);
    const uv = new Float32Array(n * n * 2);
    let p = 0, q = 0;
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const u = i / segments, v = j / segments;
            const d = gridDisplacement(cal, u, v);
            const [X, Y, W] = applyH(H, u + d[0], v + d[1]);
            // output (x, y-down) in 0..1 -> clip: (2x - 1, 1 - 2y), homogeneous
            pos[p++] = 2 * X - W;
            pos[p++] = W - 2 * Y;
            pos[p++] = 0;
            pos[p++] = W;
            uv[q++] = u;
            uv[q++] = v;
        }
    }
    const idx = new Uint16Array(segments * segments * 6);
    let k = 0;
    for (let j = 0; j < segments; j++) {
        for (let i = 0; i < segments; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            idx[k++] = a; idx[k++] = c; idx[k++] = b;
            idx[k++] = b; idx[k++] = c; idx[k++] = d;
        }
    }
    return { pos, uv, idx, H };
}

// ----------------------------------------------------------------------
// Per-display persistence (localStorage fallback; the project copy lives in OutputManager)
// ----------------------------------------------------------------------

export function loadLocalCalibrations() {
    try {
        const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        return all && typeof all === 'object' ? all : {};
    } catch (e) {
        return {};
    }
}

export function saveLocalCalibration(displayKey, cal) {
    try {
        const all = loadLocalCalibrations();
        all[displayKey] = cal;
        localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) { /* quota / private mode */ }
}
