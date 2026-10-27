/**
 * Image comparison for the visual regression suite.
 *
 * All images are { width, height, data: RGBA Uint8Array }. Metrics:
 *   mae         mean absolute channel error (0..255) after a 3x3 box blur of both images
 *               (film grain / dithering and JPEG noise mostly cancel out)
 *   bad_frac    fraction of pixels whose max channel error, after a 3x3 box blur of
 *               both images (absorbs JPEG ringing and 1-px jitter), exceeds `badLevel`
 *   mean_delta  largest per-channel difference of the mean colours (0..255)
 *   hist_dist   luma histogram distance (32 soft bins: linear interpolation between bin
 *               centres, so a 1-level shift never flips a whole bin; half L1, 0..1)
 *   max_err     largest blurred max-channel error
 */
import crypto from 'node:crypto';

export const BAD_LEVEL = 32;

export function sha256(img) {
    return crypto.createHash('sha256').update(img.data).digest('hex');
}

function blur3(img) {
    const { width: w, height: h, data } = img;
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= w) continue;
                    const i = (yy * w + xx) * 4;
                    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
                }
            }
            const o = (y * w + x) * 3;
            out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
        }
    }
    return out;
}

export function imageStats(img) {
    const n = img.width * img.height;
    const sum = [0, 0, 0];
    const hist = new Array(32).fill(0);
    for (let i = 0; i < n; i++) {
        const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
        sum[0] += r; sum[1] += g; sum[2] += b;
        const f = Math.max(0, Math.min(31, (0.2126 * r + 0.7152 * g + 0.0722 * b) / 8 - 0.5));
        const k = Math.floor(f), w = f - k;
        hist[k] += 1 - w;
        if (w > 0) hist[k + 1] += w;
    }
    return { mean_rgb: sum.map(s => +(s / n).toFixed(2)), hist: hist.map(c => +(c / n).toFixed(5)) };
}

export function compareImages(a, b, { badLevel = BAD_LEVEL, heatmap = false } = {}) {
    if (a.width !== b.width || a.height !== b.height) {
        return { size_mismatch: true, mae: 255, bad_frac: 1, mean_delta: 255, hist_dist: 1, max_err: 255 };
    }
    const n = a.width * a.height;
    const ba = blur3(a), bb = blur3(b);
    let abs = 0, bad = 0, maxErr = 0;
    const err = heatmap ? new Float32Array(n) : null;
    for (let i = 0; i < n; i++) {
        const o = i * 3;
        const dr = Math.abs(ba[o] - bb[o]), dg = Math.abs(ba[o + 1] - bb[o + 1]), db = Math.abs(ba[o + 2] - bb[o + 2]);
        abs += dr + dg + db;
        const e = Math.max(dr, dg, db);
        if (e > badLevel) bad++;
        if (e > maxErr) maxErr = e;
        if (err) err[i] = e;
    }
    const sa = imageStats(a), sb = imageStats(b);
    const meanDelta = Math.max(...sa.mean_rgb.map((m, i) => Math.abs(m - sb.mean_rgb[i])));
    const hist = sa.hist.reduce((s, h, i) => s + Math.abs(h - sb.hist[i]), 0) / 2;
    const out = {
        mae: +(abs / (n * 3)).toFixed(3),
        bad_frac: +(bad / n).toFixed(5),
        mean_delta: +meanDelta.toFixed(2),
        hist_dist: +hist.toFixed(4),
        max_err: Math.round(maxErr),
    };
    if (heatmap) out.heatmap = makeHeatmap(a, err);
    return out;
}

/** Diff heatmap: the image in dim grey, errors from dark red (small) to yellow / white (large). */
function makeHeatmap(base, err) {
    const { width, height } = base;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const k = i * 4;
        const l = (0.2126 * base.data[k] + 0.7152 * base.data[k + 1] + 0.0722 * base.data[k + 2]) * 0.25;
        const e = Math.min(1, err[i] / 64);
        if (err[i] < 2) {
            data[k] = data[k + 1] = data[k + 2] = l;
        } else {
            data[k] = Math.max(l, 90 + 165 * Math.min(1, e * 2));
            data[k + 1] = Math.max(l, 255 * Math.max(0, e * 2 - 1));
            data[k + 2] = Math.max(l, 255 * Math.max(0, e * 4 - 3));
        }
        data[k + 3] = 255;
    }
    return { width, height, data };
}

/** Side-by-side strip: golden | actual | diff (for quick review). */
export function sideBySide(images, gap = 4) {
    const h = Math.max(...images.map(i => i.height));
    const w = images.reduce((s, i) => s + i.width, 0) + gap * (images.length - 1);
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 40; data[i * 4 + 3] = 255; }
    let x0 = 0;
    for (const img of images) {
        for (let y = 0; y < img.height; y++) {
            data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * w + x0) * 4);
        }
        x0 += img.width + gap;
    }
    return { width: w, height: h, data };
}
