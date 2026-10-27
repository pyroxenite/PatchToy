/**
 * NodePainter - shared drawing primitives for the node canvas.
 *
 * "Modular synth meets pixel art": graphite bodies, 1px borders, a category
 * accent bar on every module, jack-style ports colored by GLSL type, and
 * crisp pixel icons. Everything here is stateless (aside from small caches)
 * so it can be called from any node's draw() without per-frame allocations.
 */

import {
    COLORS, TYPE_COLORS, CATEGORY_COLORS, FONTS, LAYOUT, CANVAS, NODE_LAYOUT,
    typeColor, categoryColor
} from '../ui/theme.js';
import { TypeRegistry } from '../core/TypeRegistry.js';
import { TypeSystem } from '../core/NodeDefinitions.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Text measurement cache (invalidated when web fonts finish loading)
// ---------------------------------------------------------------------------

const measureCache = new Map();
let fontEpoch = 0;

function bumpFontEpoch() {
    measureCache.clear();
    fontEpoch++;
}

if (typeof document !== 'undefined' && document.fonts) {
    if (document.fonts.addEventListener) {
        document.fonts.addEventListener('loadingdone', bumpFontEpoch);
    }
    // Make sure the pixel fonts are requested even before any DOM text uses them
    for (const f of [FONTS.title, FONTS.titleBold, FONTS.value]) {
        document.fonts.load(f).then(bumpFontEpoch).catch(() => {});
    }
}

export function getFontEpoch() {
    return fontEpoch;
}

/** Measure text width with a cache. Sets ctx.font as a side effect. */
export function measure(ctx, font, text) {
    ctx.font = font;
    const key = font + '\u0001' + text;
    let w = measureCache.get(key);
    if (w === undefined) {
        if (measureCache.size > 4000) measureCache.clear();
        w = ctx.measureText(text).width;
        measureCache.set(key, w);
    }
    return w;
}

/** Truncate text with an ellipsis so it fits maxWidth (cached measurements). */
export function fitText(ctx, font, text, maxWidth) {
    if (!text) return '';
    if (measure(ctx, font, text) <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measure(ctx, font, text.slice(0, mid) + '…') <= maxWidth) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + '…' : '';
}

// ---------------------------------------------------------------------------
// Color helpers (cached so per-frame calls don't allocate strings)
// ---------------------------------------------------------------------------

const colorCache = new Map();

function parseHex(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Nested caches (no key string built per call: these run for every node / cable drawn)
const alphaCache = new Map();  // hex -> Map(alpha -> css)
const mixCache = new Map();    // hexA -> Map(hexB -> Map(t -> hex))

export function withAlpha(hex, a) {
    if (!hex || hex[0] !== '#') return hex;
    // Animated alphas (pulses, scene transitions) would add an entry per frame: quantize
    a = Math.round(a * 1000) / 1000;
    let byA = alphaCache.get(hex);
    if (!byA) { byA = new Map(); alphaCache.set(hex, byA); }
    let c = byA.get(a);
    if (!c) {
        const [r, g, b] = parseHex(hex);
        c = `rgba(${r}, ${g}, ${b}, ${a})`;
        byA.set(a, c);
    }
    return c;
}

export function mixColor(hexA, hexB, t) {
    if (!hexA || hexA[0] !== '#' || !hexB || hexB[0] !== '#') return hexA;
    t = Math.round(t * 1000) / 1000; // bounded cache for animated mixes
    let byB = mixCache.get(hexA);
    if (!byB) { byB = new Map(); mixCache.set(hexA, byB); }
    let byT = byB.get(hexB);
    if (!byT) { byT = new Map(); byB.set(hexB, byT); }
    let c = byT.get(t);
    if (!c) {
        const a = parseHex(hexA), b = parseHex(hexB);
        const r = Math.round(a[0] + (b[0] - a[0]) * t);
        const g = Math.round(a[1] + (b[1] - a[1]) * t);
        const bl = Math.round(a[2] + (b[2] - a[2]) * t);
        c = '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
        byT.set(t, c);
    }
    return c;
}

export function lighten(hex, t) {
    return mixColor(hex, '#ffffff', t);
}

/** Port / cable color for a GLSL type ('any' and unknown types stay neutral). */
export function portColor(type) {
    if (!type || type === 'any') return TYPE_COLORS.unknown;
    return typeColor(type);
}

// Legacy category names → theme categories (until definitions are re-categorized)
const CATEGORY_ALIASES = {
    blend: 'logic',
    control: 'logic',
    utility: 'effect',
    convert: 'vector',
    struct: 'sdf3d',
};

/** Accent color for a node (header bar, operator ring, loop links). */
export function nodeAccent(node) {
    const def = node.definition;
    let cat = def && def.category;
    if (cat === 'input' && (node.isCameraNode || node.isScreenCaptureNode || node.isVideoURLNode ||
        node.isMicrophoneNode || node.isMidiCCNode)) {
        cat = 'source';
    }
    if (cat && !CATEGORY_COLORS[cat] && CATEGORY_ALIASES[cat]) cat = CATEGORY_ALIASES[cat];
    return categoryColor(cat);
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const titleCache = new Map();

/** 'Vec3ToVec4' → 'Vec3 to Vec4', 'ScreenCapture' → 'Screen Capture', 'VideoURL' → 'Video URL' */
export function prettyTitle(type) {
    if (!type) return '';
    let t = titleCache.get(type);
    if (t === undefined) {
        t = String(type)
            .replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([0-9])(?=[A-Z][a-z])/g, '$1 ')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/ (To|Of|And|Or|In) /g, (m, w) => ' ' + w.toLowerCase() + ' ');
        titleCache.set(type, t);
    }
    return t;
}

// ---------------------------------------------------------------------------
// Type compatibility (mirrors Connection.isValid + TypeSystem.canConvert)
// ---------------------------------------------------------------------------

const NUMERIC = new Set(['float', 'int', 'bool', 'vec2', 'vec3', 'vec4']);

export function typesCompatible(outType, inType) {
    if (!outType || !inType) return true;
    if (outType === 'any' || inType === 'any') return true;
    if (outType === inType) return true;
    // Control-only values: events read as pulses (numbers), numbers drive events by
    // their rising edge; strings and lists only connect to their own type
    if (outType === 'event') return NUMERIC.has(inType);
    if (inType === 'event') return outType === 'float' || outType === 'int' || outType === 'bool';
    if (outType === 'string' || inType === 'string' || outType === 'list' || inType === 'list') return false;
    const sOut = TypeRegistry.isStruct && TypeRegistry.isStruct(outType);
    const sIn = TypeRegistry.isStruct && TypeRegistry.isStruct(inType);
    if (sOut || sIn) return false;
    return TypeSystem.canConvert(outType, inType);
}

// ---------------------------------------------------------------------------
// Pixel icons — '#' = 1 pixel. Rendered as merged horizontal runs in a Path2D.
// ---------------------------------------------------------------------------

export const ICONS = {
    code: [
        '...#.#...',
        '..#...#..',
        '.#.....#.',
        '#.......#',
        '.#.....#.',
        '..#...#..',
        '...#.#...',
    ],
    picture: [
        '#########',
        '#.......#',
        '#.....#.#',
        '#...#...#',
        '#..###..#',
        '#.#####.#',
        '#########',
    ],
    fullscreen: [
        '###...###',
        '#.......#',
        '.........',
        '.........',
        '.........',
        '#.......#',
        '###...###',
    ],
    camera: [
        '..###....',
        '#########',
        '#..###..#',
        '#.#...#.#',
        '#.#...#.#',
        '#..###..#',
        '#########',
    ],
    screen: [
        '#########',
        '#.......#',
        '#.......#',
        '#.......#',
        '#########',
        '...###...',
        '.#######.',
    ],
    mic: [
        '..###..',
        '..###..',
        '#.###.#',
        '#.###.#',
        '.#...#.',
        '..###..',
        '...#...',
        '.#####.',
    ],
    midi: [
        '..#####..',
        '.#.....#.',
        '#..#.#..#',
        '#.#...#.#',
        '#.......#',
        '.#..#..#.',
        '..##.##..',
    ],
    film: [
        '#########',
        '#.#.#.#.#',
        '#########',
        '#.......#',
        '#########',
        '#.#.#.#.#',
        '#########',
    ],
    play: [
        '#....',
        '##...',
        '###..',
        '####.',
        '###..',
        '##...',
        '#....',
    ],
    pause: [
        '##.##',
        '##.##',
        '##.##',
        '##.##',
        '##.##',
        '##.##',
        '##.##',
    ],
    stop: [
        '######',
        '######',
        '######',
        '######',
        '######',
        '######',
    ],
    bang: [
        '##',
        '##',
        '##',
        '##',
        '..',
        '##',
    ],
    check: [
        '......#',
        '.....##',
        '#...##.',
        '##.##..',
        '.###...',
        '..#....',
    ],
    loop: [
        '..####...',
        '.#....#..',
        '#......#.',
        '#.....###',
        '#......#.',
        '.#.......',
        '..####...',
    ],
    feedback: [
        '...####..',
        '..#....#.',
        '.###....#',
        '..#.....#',
        '........#',
        '.#.....#.',
        '..#####..',
    ],
    js: [
        '...#.###.',
        '...#.#...',
        '...#.###.',
        '#..#...#.',
        '.##..###.',
    ],
    grip: [
        '......#',
        '.......',
        '....#.#',
        '.......',
        '..#.#.#',
    ],
    // Operator glyphs (drawn at scale 3-4 for chunky pixel symbols)
    opAdd: [
        '..#..',
        '..#..',
        '#####',
        '..#..',
        '..#..',
    ],
    opSub: [
        '.....',
        '.....',
        '#####',
        '.....',
        '.....',
    ],
    opMul: [
        '#...#',
        '.#.#.',
        '..#..',
        '.#.#.',
        '#...#',
    ],
    opDiv: [
        '..#..',
        '.....',
        '#####',
        '.....',
        '..#..',
    ],
};

const iconPathCache = new Map();

function iconPath(name, scale) {
    const key = name + '@' + scale;
    let p = iconPathCache.get(key);
    if (!p) {
        const rows = ICONS[name];
        p = new Path2D();
        if (rows) {
            for (let y = 0; y < rows.length; y++) {
                const row = rows[y];
                let x = 0;
                while (x < row.length) {
                    if (row[x] === '#') {
                        let x2 = x;
                        while (x2 < row.length && row[x2] === '#') x2++;
                        p.rect(x * scale, y * scale, (x2 - x) * scale, scale);
                        x = x2;
                    } else {
                        x++;
                    }
                }
            }
        }
        iconPathCache.set(key, p);
    }
    return p;
}

export function iconSize(name, scale = 1) {
    const rows = ICONS[name];
    if (!rows) return { w: 0, h: 0 };
    return { w: rows[0].length * scale, h: rows.length * scale };
}

/** Draw a pixel icon with its top-left at (x, y). */
export function drawIcon(ctx, name, x, y, color, scale = 1) {
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.fillStyle = color;
    ctx.fill(iconPath(name, scale));
    ctx.restore();
}

/** Draw a pixel icon centered on (cx, cy). */
export function drawIconCentered(ctx, name, cx, cy, color, scale = 1) {
    const s = iconSize(name, scale);
    drawIcon(ctx, name, cx - s.w / 2, cy - s.h / 2, color, scale);
}

// ---------------------------------------------------------------------------
// Node frame
// ---------------------------------------------------------------------------

const HEADER_H = LAYOUT.headerHeight;

/**
 * Shadow, selection glow, body, and header (with category accent bar).
 * opts: { selected, accent, header (bool, default true), radius, headerHeight }
 */
export function drawNodeBase(ctx, x, y, w, h, opts) {
    const r = opts.radius !== undefined ? opts.radius : LAYOUT.nodeRadius;
    const accent = opts.accent || COLORS.textFaint;

    // Hard pixel drop-shadow
    ctx.fillStyle = CANVAS.shadow;
    ctx.beginPath();
    ctx.roundRect(x, y + NODE_LAYOUT.shadowOffset, w, h, r);
    ctx.fill();

    // Soft selection glow (two stacked strokes - cheaper than shadowBlur)
    if (opts.selected) {
        ctx.beginPath();
        ctx.roundRect(x - 2.5, y - 2.5, w + 5, h + 5, r + 2.5);
        ctx.strokeStyle = withAlpha(COLORS.selection, 0.12);
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.beginPath();
        ctx.roundRect(x - 1.5, y - 1.5, w + 3, h + 3, r + 1.5);
        ctx.strokeStyle = withAlpha(COLORS.selection, 0.28);
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Body
    ctx.fillStyle = COLORS.nodeBody;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();

    if (opts.header === false) {
        // Accent bar only (header-less modules such as operators)
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.roundRect(x, y, w, Math.min(h, r * 2), [r, r, 0, 0]);
        ctx.fill();
        ctx.fillStyle = COLORS.nodeBody;
        ctx.beginPath();
        ctx.roundRect(x, y + 2, w, Math.min(h, r * 2), [r, r, 0, 0]);
        ctx.fill();
        return;
    }

    const hh = opts.headerHeight || HEADER_H;
    // Accent bar: fill header in accent, then cover all but the top 2px
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(x, y, w, hh, [r, r, 0, 0]);
    ctx.fill();
    ctx.fillStyle = mixColor(COLORS.nodeHeader, accent, 0.07);
    ctx.beginPath();
    ctx.roundRect(x, y + 2, w, hh - 2, [r, r, 0, 0]);
    ctx.fill();
    // Header separator
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(x, y + hh - 1, w, 1);
}

/** 1px outline (selection / error / hover aware) + error badge. */
export function drawNodeBorder(ctx, x, y, w, h, opts) {
    const r = opts.radius !== undefined ? opts.radius : LAYOUT.nodeRadius;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, Math.max(0, r - 0.5));
    if (opts.error) {
        ctx.strokeStyle = COLORS.error;
        ctx.lineWidth = 1.5;
    } else if (opts.selected) {
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = 1.5;
    } else if (opts.hovered) {
        ctx.strokeStyle = COLORS.borderStrong;
        ctx.lineWidth = 1;
    } else {
        ctx.strokeStyle = COLORS.border;
        ctx.lineWidth = 1;
    }
    ctx.stroke();

    if (opts.error) {
        drawErrorBadge(ctx, x + w - 3, y + 3);
    }
}

export function drawErrorBadge(ctx, cx, cy) {
    ctx.beginPath();
    ctx.roundRect(cx - 7, cy - 7, 14, 14, 3);
    ctx.fillStyle = COLORS.canvas;
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(cx - 6, cy - 6, 12, 12, 2.5);
    ctx.fillStyle = COLORS.error;
    ctx.fill();
    drawIconCentered(ctx, 'bang', cx, cy, '#ffffff', 1);
}

/** Node title in the header. Returns the x where the title ends. */
export function drawTitle(ctx, text, x, y, maxWidth, color = COLORS.text) {
    const font = FONTS.titleBold;
    const t = fitText(ctx, font, text, maxWidth);
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(t, Math.round(x), Math.round(y + HEADER_H / 2 + 5));
    return x + measure(ctx, font, t);
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export const PORT_NORMAL = 0;
export const PORT_HOT = 1;
export const PORT_DIM = 2;

/**
 * Jack-style port: hollow ring when free, solid when patched.
 * shape: 'circle' (pixel rate), 'diamond' (control rate), 'event' (control-rate
 * event: diamond with a small lightning bolt). See src/core/control/rates.js.
 */
export function drawPort(ctx, x, y, color, connected, state = PORT_NORMAL, shape = 'circle') {
    if (shape === 'diamond' || shape === 'event') {
        drawDiamondPort(ctx, x, y, color, connected, state, shape === 'event');
        return;
    }
    const r = LAYOUT.portRadius;
    const prevAlpha = ctx.globalAlpha;
    if (state === PORT_DIM) ctx.globalAlpha = prevAlpha * 0.22;

    if (state === PORT_HOT) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, TAU);
        ctx.fillStyle = withAlpha(color, 0.25);
        ctx.fill();
    }

    // Dark collar separates the jack from borders and cables
    ctx.beginPath();
    ctx.arc(x, y, r + 1.5, 0, TAU);
    ctx.fillStyle = COLORS.canvas;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    if (connected) {
        ctx.fillStyle = state === PORT_HOT ? lighten(color, 0.35) : color;
        ctx.fill();
    } else {
        ctx.fillStyle = state === PORT_HOT ? withAlpha(color, 0.35) : COLORS.canvas;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r - 0.75, 0, TAU);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = color;
        ctx.stroke();
    }

    ctx.globalAlpha = prevAlpha;
}

const BOLT = [
    '..#',
    '.#.',
    '###',
    '.#.',
    '#..',
];

/** Control-rate port: a diamond (same footprint as the circle so hit-testing is unchanged). */
function drawDiamondPort(ctx, x, y, color, connected, state, bolt) {
    const r = LAYOUT.portRadius + 1.2;
    const prevAlpha = ctx.globalAlpha;
    if (state === PORT_DIM) ctx.globalAlpha = prevAlpha * 0.22;
    const path = (rr) => {
        ctx.beginPath();
        ctx.moveTo(x, y - rr);
        ctx.lineTo(x + rr, y);
        ctx.lineTo(x, y + rr);
        ctx.lineTo(x - rr, y);
        ctx.closePath();
    };
    if (state === PORT_HOT) {
        path(r + 4);
        ctx.fillStyle = withAlpha(color, 0.25);
        ctx.fill();
    }
    path(r + 1.8);
    ctx.fillStyle = COLORS.canvas;
    ctx.fill();
    path(r);
    if (connected) {
        ctx.fillStyle = state === PORT_HOT ? lighten(color, 0.35) : color;
        ctx.fill();
    } else {
        ctx.fillStyle = state === PORT_HOT ? withAlpha(color, 0.35) : COLORS.canvas;
        ctx.fill();
        path(r - 0.8);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = color;
        ctx.stroke();
    }
    if (bolt) {
        // 3x5 pixel lightning bolt in the middle of the diamond
        ctx.fillStyle = connected ? COLORS.canvas : color;
        const x0 = Math.round(x) - 1.5, y0 = Math.round(y) - 2.5;
        for (let row = 0; row < BOLT.length; row++) {
            for (let col = 0; col < 3; col++) if (BOLT[row][col] === '#') ctx.fillRect(x0 + col, y0 + row, 1, 1);
        }
    }
    ctx.globalAlpha = prevAlpha;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** Dark inset well (fields, meters, segmented controls). */
export function drawInset(ctx, x, y, w, h, opts = {}) {
    const r = opts.radius !== undefined ? opts.radius : 3;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = opts.fill || CANVAS.inset;
    ctx.fill();
    // 1px top inner shadow line for depth
    if (!opts.flat) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(x + r, y, w - r * 2, 1);
    }
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, Math.max(0, r - 0.5));
    ctx.strokeStyle = opts.border || CANVAS.insetBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
}

/** Small label text (port labels, captions). */
export function drawLabel(ctx, text, x, cy, color = COLORS.textDim, align = 'left', font = FONTS.title) {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, Math.round(x), Math.round(cy + 3));
}

/** Header tag/badge (e.g. uniform "U", "learn"). */
export function drawTag(ctx, rect, text, active, activeColor, opts = {}) {
    const { x, y, w, h } = rect;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 3);
    if (active) {
        ctx.fillStyle = activeColor;
        ctx.fill();
    } else {
        ctx.fillStyle = opts.hovered ? COLORS.hover : COLORS.raised;
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 2.5);
        ctx.strokeStyle = COLORS.borderStrong;
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    ctx.font = opts.font || FONTS.title;
    ctx.fillStyle = active ? COLORS.canvas : (opts.hovered ? COLORS.text : COLORS.textDim);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, Math.round(x + w / 2), Math.round(y + h / 2 + 3));
    ctx.textAlign = 'left';
}

/** Icon button (preview toolbar, video transport). */
export function drawIconButton(ctx, rect, icon, opts = {}) {
    const { x, y, w, h } = rect;
    if (opts.active || opts.hovered) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 3);
        ctx.fillStyle = opts.active ? withAlpha(opts.activeColor || COLORS.accent, 0.18) : COLORS.hover;
        ctx.fill();
    }
    const color = opts.active ? (opts.activeColor || COLORS.accent)
        : (opts.hovered ? COLORS.text : (opts.color || COLORS.textDim));
    drawIconCentered(ctx, icon, x + w / 2, y + h / 2, color, opts.scale || 1);
}

/** Pixel checkbox with label. */
export function drawCheckbox(ctx, x, y, checked, label, accent = COLORS.accent) {
    const s = 12;
    ctx.beginPath();
    ctx.roundRect(x, y, s, s, 2);
    ctx.fillStyle = checked ? accent : CANVAS.inset;
    ctx.fill();
    if (!checked) {
        ctx.beginPath();
        ctx.roundRect(x + 0.5, y + 0.5, s - 1, s - 1, 1.5);
        ctx.strokeStyle = COLORS.borderStrong;
        ctx.lineWidth = 1;
        ctx.stroke();
    } else {
        drawIcon(ctx, 'check', x + 2.5, y + 3, COLORS.canvas, 1);
    }
    if (label) drawLabel(ctx, label, x + s + 6, y + s / 2, checked ? COLORS.text : COLORS.textDim);
}

/** Segmented control. segments: [{label, active, hovered}], rects computed by caller. */
export function drawSegmented(ctx, x, y, w, h, labels, activeIndex, accent, hoverIndex = -1) {
    drawInset(ctx, x, y, w, h, { radius: 3 });
    const n = labels.length;
    const segW = (w - 2) / n;
    for (let i = 0; i < n; i++) {
        const sx = x + 1 + segW * i;
        if (i === activeIndex) {
            ctx.beginPath();
            ctx.roundRect(sx + 1, y + 2, segW - 2, h - 4, 2);
            ctx.fillStyle = withAlpha(accent, 0.22);
            ctx.fill();
            ctx.beginPath();
            ctx.roundRect(sx + 1.5, y + 2.5, segW - 3, h - 5, 1.5);
            ctx.strokeStyle = withAlpha(accent, 0.7);
            ctx.lineWidth = 1;
            ctx.stroke();
        } else if (i === hoverIndex) {
            ctx.beginPath();
            ctx.roundRect(sx + 1, y + 2, segW - 2, h - 4, 2);
            ctx.fillStyle = COLORS.raised;
            ctx.fill();
        }
        if (i > 0 && i !== activeIndex && i - 1 !== activeIndex) {
            ctx.fillStyle = CANVAS.insetBorder;
            ctx.fillRect(Math.round(sx), y + 4, 1, h - 8);
        }
        ctx.font = FONTS.title;
        ctx.fillStyle = i === activeIndex ? lighten(accent, 0.45) : COLORS.textDim;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(labels[i], Math.round(sx + segW / 2), Math.round(y + h / 2 + 3));
    }
    ctx.textAlign = 'left';
}

/** Horizontal level meter: LED segments (pixel style). level in 0..1 */
export function drawLedMeter(ctx, x, y, w, h, level, opts = {}) {
    drawInset(ctx, x, y, w, h, { radius: 2 });
    const pad = 2;
    const segW = opts.segmentWidth || 4;
    const gap = 1;
    const innerW = w - pad * 2;
    const count = Math.max(1, Math.floor((innerW + gap) / (segW + gap)));
    const lit = Math.round(Math.max(0, Math.min(1, level)) * count);
    const lowColor = opts.color || COLORS.success;
    for (let i = 0; i < count; i++) {
        const t = i / (count - 1 || 1);
        let c = lowColor;
        if (!opts.mono) {
            if (t > 0.85) c = COLORS.error;
            else if (t > 0.65) c = COLORS.warning;
        }
        ctx.fillStyle = i < lit ? c : withAlpha(c, 0.1);
        ctx.fillRect(x + pad + i * (segW + gap), y + pad, segW, h - pad * 2);
    }
}

/** Continuous value bar (e.g. MIDI CC value). level in 0..1 */
export function drawValueBar(ctx, x, y, w, h, level, color) {
    drawInset(ctx, x, y, w, h, { radius: 2 });
    const l = Math.max(0, Math.min(1, level));
    if (l > 0) {
        ctx.fillStyle = withAlpha(color, 0.85);
        ctx.fillRect(x + 2, y + 2, Math.max(1, (w - 4) * l), h - 4);
    }
    // 1px ticks every quarter
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    for (let i = 1; i < 4; i++) {
        ctx.fillRect(Math.round(x + 2 + (w - 4) * i / 4), y + 2, 1, h - 4);
    }
}

/** Status LED (pixel square). */
export function drawLed(ctx, cx, cy, on, color = CANVAS.ledOn) {
    const s = 4;
    if (on) {
        ctx.fillStyle = withAlpha(color, 0.25);
        ctx.fillRect(Math.round(cx - s / 2) - 1, Math.round(cy - s / 2) - 1, s + 2, s + 2);
    }
    ctx.fillStyle = on ? color : CANVAS.ledOff;
    ctx.fillRect(Math.round(cx - s / 2), Math.round(cy - s / 2), s, s);
}

/**
 * Inset "screen" for live sources (camera / screen / video). Draws the video
 * frame (cover-fit) when ready, otherwise a pixel icon + status message.
 */
export function drawVideoWell(ctx, x, y, w, h, video, opts = {}) {
    drawInset(ctx, x, y, w, h, { radius: 3 });
    const ready = video && video.readyState >= 2 && video.videoWidth > 0;
    if (ready) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, w - 2, h - 2, 2);
        ctx.clip();
        const vw = video.videoWidth, vh = video.videoHeight;
        const s = Math.max((w - 2) / vw, (h - 2) / vh);
        const dw = vw * s, dh = vh * s;
        ctx.drawImage(video, x + 1 + (w - 2 - dw) / 2, y + 1 + (h - 2 - dh) / 2, dw, dh);
        ctx.restore();
        return;
    }
    const cx = x + w / 2;
    const cy = y + h / 2;
    if (opts.icon) {
        drawIconCentered(ctx, opts.icon, cx, cy - 7, opts.iconColor || COLORS.textFaint, 2);
    }
    if (opts.message) {
        const font = FONTS.title;
        const msg = fitText(ctx, font, opts.message, w - 12);
        ctx.font = font;
        ctx.fillStyle = opts.messageColor || COLORS.textFaint;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(msg, Math.round(cx), Math.round(cy + (opts.icon ? 17 : 3)));
        ctx.textAlign = 'left';
    }
}

// ---------------------------------------------------------------------------
// Cables
// ---------------------------------------------------------------------------

/** Control-point distance for a cable from a to b (symmetric → midpoint stays on curve). */
export function cableHandle(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = Math.abs(by - ay);
    let c = Math.abs(dx) * 0.5;
    if (dx < 0) c += Math.min(dy * 0.35, 80) + 30; // looping back: wider S
    return Math.max(24, Math.min(c, 160));
}

export function traceCable(ctx, ax, ay, bx, by) {
    const c = cableHandle(ax, ay, bx, by);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.bezierCurveTo(ax + c, ay, bx - c, by, bx, by);
}

/**
 * Pixel-rate (GPU) cables are drawn "pixelated": the same bezier, rasterized onto a
 * grid of `cell`-sized squares and traced as an axis-aligned staircase through the cell
 * centers. Control-rate (CPU) cables keep the smooth curve. Returns the staircase
 * vertices as a flat [x0, y0, x1, y1, ...] array (collinear runs merged).
 */
export function pixelCablePoints(ax, ay, bx, by, cell) {
    const c = cableHandle(ax, ay, bx, by);
    const p1x = ax + c, p2x = bx - c;
    const approxLen = Math.abs(bx - ax) + Math.abs(by - ay) + 2 * Math.abs(c);
    const n = Math.max(8, Math.min(1200, Math.ceil(approxLen / (cell * 0.5))));
    const cells = [];
    let lx = null, ly = null;
    const push = (gx, gy) => {
        if (gx === lx && gy === ly) return;
        // Fill gaps with unit steps, horizontal first (cables mostly run sideways)
        if (lx !== null) {
            while (Math.abs(gx - lx) + Math.abs(gy - ly) > 1) {
                if (gx !== lx) lx += Math.sign(gx - lx); else ly += Math.sign(gy - ly);
                cells.push(lx, ly);
            }
        }
        cells.push(gx, gy);
        lx = gx; ly = gy;
    };
    for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        const x = u * u * u * ax + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * bx;
        const y = u * u * u * ay + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * by;
        push(Math.round(x / cell), Math.round(y / cell));
    }
    // Merge collinear unit steps into runs
    const out = [];
    const len = cells.length / 2;
    for (let i = 0; i < len; i++) {
        const gx = cells[i * 2], gy = cells[i * 2 + 1];
        if (out.length >= 4) {
            const n2 = out.length;
            const px = out[n2 - 2], py = out[n2 - 1], qx = out[n2 - 4], qy = out[n2 - 3];
            const sameDir = (px - qx === 0) === (gx * cell - px === 0) && (py - qy === 0) === (gy * cell - py === 0);
            if (sameDir) { out[n2 - 2] = gx * cell; out[n2 - 1] = gy * cell; continue; }
        }
        out.push(gx * cell, gy * cell);
    }
    return out;
}

/** Path for pixelCablePoints() output (optionally a sub-range of vertices). */
export function tracePixelCable(ctx, pts, from = 0, to = pts.length / 2 - 1) {
    ctx.beginPath();
    ctx.moveTo(pts[from * 2], pts[from * 2 + 1]);
    for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
}

// ===========================================================================
// Node groups: group boxes ("subgraph" modules) and the boundary panels shown
// inside a group. Geometry and interaction live in src/graph/NodeGroups.js.
// ===========================================================================

ICONS.folder = [
    '####.....',
    '#...####.',
    '#########',
    '#.......#',
    '#.......#',
    '#.......#',
    '#########',
];
ICONS.arrowRight = [
    '...#...',
    '....#..',
    '#######',
    '....#..',
    '...#...',
];
ICONS.plus = [
    '..#..',
    '..#..',
    '#####',
    '..#..',
    '..#..',
];

export const GROUP_LAYOUT = {
    headerH: 34,        // title row (18px Pixeloid title + count badge)
    tabH: 7,            // folder tab above the top edge
    stack: 4,           // stacked-card offset (two cards behind the box)
    minimapH: 46,       // minimum height of the inner-layout preview well
    minimapMinW: 120,   // minimum width of the preview (between the port label columns)
    minimapGap: 8,
    labelMax: 130,      // port labels beside the preview are truncated past this
    padBottom: 9,
    radius: 7,
    minWidth: 220,
    maxWidth: 420,
    titleFont: 'bold 18px "Pixeloid Sans"',
    panelHeaderH: 26,
    panelWidth: 184,
};

/**
 * Group box frame: stacked cards behind, folder tab, tinted header with the
 * group name + node-count badge, double border and an inner-layout minimap.
 * Ports are drawn by the caller.
 * o: { accent, name, countText, selected, hovered, minimap, error }
 */
export function drawGroupBox(ctx, x, y, w, h, o) {
    const G = GROUP_LAYOUT;
    const r = G.radius;
    const accent = o.accent || COLORS.textDim;
    const s = G.stack;
    const hh = G.headerH;

    // Hard drop shadow under the whole stack
    ctx.fillStyle = CANVAS.shadow;
    ctx.beginPath();
    ctx.roundRect(x + s * 2, y + s * 2 + NODE_LAYOUT.shadowOffset, w, h, r);
    ctx.fill();

    // Two cards stacked behind the box suggest depth (deepest first)
    for (let i = 2; i >= 1; i--) {
        const ox = x + s * i, oy = y + s * i;
        ctx.beginPath();
        ctx.roundRect(ox, oy, w, h, r);
        ctx.fillStyle = mixColor(COLORS.nodeBody, COLORS.canvas, i === 2 ? 0.55 : 0.28);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(ox + 0.5, oy + 0.5, w - 1, h - 1, r - 0.5);
        ctx.strokeStyle = mixColor(COLORS.border, accent, i === 2 ? 0.14 : 0.26);
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    if (o.selected) {
        ctx.beginPath();
        ctx.roundRect(x - 3, y - G.tabH - 3, w + 6, h + G.tabH + 6, r + 3);
        ctx.strokeStyle = withAlpha(COLORS.selection, 0.12);
        ctx.lineWidth = 5;
        ctx.stroke();
    }

    // Folder tab on the top edge
    const tabW = Math.max(40, Math.min(w * 0.36, 96));
    const tx = x + 12;
    const ty = y - G.tabH;
    ctx.beginPath();
    ctx.moveTo(tx, y + 2);
    ctx.lineTo(tx, ty + 3);
    ctx.quadraticCurveTo(tx, ty, tx + 3, ty);
    ctx.lineTo(tx + tabW - 9, ty);
    ctx.quadraticCurveTo(tx + tabW - 6, ty, tx + tabW - 4, ty + 3);
    ctx.lineTo(tx + tabW, y + 2);
    ctx.closePath();
    ctx.fillStyle = mixColor(COLORS.nodeHeader, accent, 0.42);
    ctx.fill();
    ctx.fillStyle = withAlpha(lighten(accent, 0.25), 0.9);
    ctx.fillRect(tx + 3, ty, tabW - 12, 1);

    // Body
    ctx.fillStyle = COLORS.nodeBody;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();

    // Header: accent bar + tinted fill
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(x, y, w, hh, [r, r, 0, 0]);
    ctx.fill();
    ctx.fillStyle = mixColor(COLORS.nodeHeader, accent, 0.13);
    ctx.beginPath();
    ctx.roundRect(x, y + 2, w, hh - 2, [r, r, 0, 0]);
    ctx.fill();
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(x, y + hh - 1, w, 1);

    // Count badge (right) then the title (left), which stops before it
    const badgeText = o.countText || '';
    let titleRight = x + w - 12;
    if (badgeText) {
        const bw = Math.ceil(measure(ctx, FONTS.value, badgeText) + 12);
        const bx = Math.round(x + w - 10 - bw);
        const by = Math.round(y + (hh - 16) / 2 + 1);
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, 16, 3);
        ctx.fillStyle = CANVAS.inset;
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(bx + 0.5, by + 0.5, bw - 1, 15, 2.5);
        ctx.strokeStyle = withAlpha(accent, 0.35);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = FONTS.value;
        ctx.fillStyle = COLORS.textDim;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(badgeText, bx + 6, by + 11);
        titleRight = bx - 8;
    }
    drawIcon(ctx, 'folder', x + 11, y + Math.round(hh / 2) - 3, accent, 1);
    const title = fitText(ctx, G.titleFont, o.name || 'Group', titleRight - (x + 27));
    ctx.font = G.titleFont;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, x + 27, Math.round(y + hh / 2 + 6));
    o.titleWidth = measure(ctx, G.titleFont, title);

    // Minimap of the inner layout
    if (o.minimapRect) {
        const m = o.minimapRect;
        drawGroupMinimap(ctx, m.x, m.y, m.w, m.h, o.minimap, accent);
    }

    // Double border: outer line + faint inner accent line
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5);
    if (o.error) {
        ctx.strokeStyle = COLORS.error;
        ctx.lineWidth = 1.5;
    } else if (o.selected) {
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = 1.5;
    } else {
        ctx.strokeStyle = o.hovered ? mixColor(COLORS.borderStrong, accent, 0.65) : mixColor(COLORS.borderStrong, accent, 0.3);
        ctx.lineWidth = 1;
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(x + 3.5, y + 3.5, w - 7, h - 7, Math.max(0, r - 3));
    ctx.strokeStyle = withAlpha(accent, o.hovered ? 0.3 : 0.17);
    ctx.lineWidth = 1;
    ctx.stroke();
}

/** Inner-layout preview: tiny rects for nodes / outlined rects for subgroups, faint wires. */
/**
 * Where a group's inner layout lands inside its box minimap: inner (x, y) is drawn at
 * (ox + x * sc, oy + y * sc). Shared with the enter/exit zoom transition.
 */
export function groupMinimapTransform(rx, ry, rw, rh, mm) {
    const pad = 6;
    const bw = Math.max(1, mm.maxX - mm.minX);
    const bh = Math.max(1, mm.maxY - mm.minY);
    const sc = Math.min((rw - pad * 2) / bw, (rh - pad * 2) / bh);
    return {
        sc,
        ox: rx + (rw - bw * sc) / 2 - mm.minX * sc,
        oy: ry + (rh - bh * sc) / 2 - mm.minY * sc
    };
}

export function drawGroupMinimap(ctx, rx, ry, rw, rh, mm, accent) {
    // No well behind the preview: the blocks sit directly on the group box body
    if (!mm || !mm.items || !mm.items.length) {
        ctx.font = FONTS.title;
        ctx.fillStyle = COLORS.textFaint;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('empty', Math.round(rx + rw / 2), Math.round(ry + rh / 2 + 3));
        ctx.textAlign = 'left';
        return;
    }
    drawGroupMinimapContent(ctx, rx, ry, rw, rh, mm, accent);
}

/** The minimap's blocks and links only, without its inset (also used by the group zoom transition). */
export function drawGroupMinimapContent(ctx, rx, ry, rw, rh, mm, accent) {
    if (!mm || !mm.items || !mm.items.length) return;
    const { sc, ox, oy } = groupMinimapTransform(rx, ry, rw, rh, mm);

    ctx.save();
    ctx.beginPath();
    ctx.rect(rx + 1, ry + 1, rw - 2, rh - 2);
    ctx.clip();
    if (mm.links && mm.links.length) {
        ctx.beginPath();
        for (const l of mm.links) {
            ctx.moveTo(ox + l[0] * sc, oy + l[1] * sc);
            ctx.lineTo(ox + l[2] * sc, oy + l[3] * sc);
        }
        ctx.strokeStyle = withAlpha(accent, 0.22);
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    for (const it of mm.items) {
        const ix = Math.round(ox + it.x * sc);
        const iy = Math.round(oy + it.y * sc);
        const iw = Math.max(2, Math.round(it.w * sc));
        const ih = Math.max(2, Math.round(it.h * sc));
        if (it.group) {
            ctx.fillStyle = withAlpha(it.color, 0.16);
            ctx.fillRect(ix, iy, iw, ih);
            ctx.strokeStyle = withAlpha(it.color, 0.85);
            ctx.lineWidth = 1;
            ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
        } else if (it.note) {
            ctx.fillStyle = withAlpha(it.color, 0.14);
            ctx.fillRect(ix, iy, iw, ih);
        } else if (it.panel) {
            // "from outside" / "to outside" boundary panels: soft grey
            ctx.fillStyle = 'rgba(160, 166, 182, 0.2)';
            ctx.beginPath();
            ctx.roundRect(ix, iy, iw, ih, Math.min(2, iw / 2, ih / 2));
            ctx.fill();
        } else {
            ctx.fillStyle = withAlpha(it.color, 0.72);
            ctx.fillRect(ix, iy, iw, ih);
        }
    }
    ctx.restore();
}

/**
 * Boundary panel inside a group: "from outside" (left, ports on its right
 * edge) or "to outside" (right, ports on its left edge). Rows are drawn by the caller.
 * o: { side: 'in'|'out', title, accent, hot }
 */
export function drawBoundaryPanel(ctx, x, y, w, h, o) {
    const r = 6;
    const accent = o.accent || COLORS.textDim;
    ctx.fillStyle = CANVAS.shadow;
    ctx.beginPath();
    ctx.roundRect(x, y + NODE_LAYOUT.shadowOffset, w, h, r);
    ctx.fill();
    ctx.fillStyle = mixColor(COLORS.panel, accent, 0.04);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();

    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = o.hot ? withAlpha(accent, 0.9) : COLORS.borderStrong;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Solid accent edge on the side the ports sit on (facing the content)
    ctx.fillStyle = withAlpha(accent, 0.75);
    ctx.fillRect(o.side === 'in' ? x + w - 2 : x + 1, y + r, 1, h - r * 2);

    // Header
    const hh = GROUP_LAYOUT.panelHeaderH;
    const label = o.title || (o.side === 'in' ? 'FROM OUTSIDE' : 'TO OUTSIDE');
    ctx.font = FONTS.title;
    const lw = measure(ctx, FONTS.title, label);
    const iconW = 7;
    const total = lw + iconW + 6;
    const cx = x + w / 2 - total / 2;
    if (o.side === 'in') {
        ctx.fillStyle = COLORS.textFaint;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(label, Math.round(cx), Math.round(y + hh / 2 + 3));
        drawIcon(ctx, 'arrowRight', cx + lw + 6, y + hh / 2 - 2, accent, 1);
    } else {
        drawIcon(ctx, 'arrowRight', cx, y + hh / 2 - 2, accent, 1);
        ctx.fillStyle = COLORS.textFaint;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(label, Math.round(cx + iconW + 6), Math.round(y + hh / 2 + 3));
    }
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(x + 6, y + hh - 1, w - 12, 1);
}

/** Empty "drop here to expose" socket: dashed ring with a plus. */
export function drawExposeSocket(ctx, x, y, color, hot, time = 0) {
    const r = LAYOUT.portRadius + 1;
    if (hot) {
        const pulse = 0.5 + 0.5 * Math.sin(time / 180);
        ctx.beginPath();
        ctx.arc(x, y, r + 4 + pulse * 2, 0, TAU);
        ctx.fillStyle = withAlpha(color, 0.18 + pulse * 0.12);
        ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, r + 1.5, 0, TAU);
    ctx.fillStyle = COLORS.canvas;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = hot ? color : COLORS.textFaint;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.setLineDash([]);
    drawIconCentered(ctx, 'plus', x, y, hot ? color : COLORS.textFaint, 1);
}

export { HEADER_H, TAU };
